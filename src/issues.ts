// Issue Agent — Issues as a FIRST-CLASS sidebar section (peer of Library & Files), matching the
// App-shot / Console design: designed issue rows (# · title · labels · local #tags · run-status chip),
// a search + label/tag filter + "assigned to me", a per-repo pull, and click-to-Assign → an isolated
// git worktree + a coding agent in a tab. MULTI-PROVIDER: GitHub / GitLab / Bitbucket, each behind the
// app-owned token in main (providers.ts); the renderer only ever sees { connected, login } + normalized
// issues. Local tags are private (relay.json, keyed provider+repo+issue), never touch the provider.
// DI-seam module: what it needs from the shell is injected via initIssues(deps).

import { state } from './state';
import { $, esc } from './dom';
import { toast } from './ui';
import type { Issue } from './shared/types';

const relay = (window as any).relay;

export interface IssuesDeps {
  openAgentTab: (o: { cwd: string; name: string; runCmd?: string }) => void; // open a terminal tab in the issue worktree, launching the agent
  activeWsId: () => string;   // the active workspace id — Issues (tracked repos + active repo) are per-workspace
}
let deps: IssuesDeps;

/* ----------------------------- per-workspace repo selection ----------------------------- */
// Each workspace keeps its OWN tracked repos + active repo (keyed by workspace id in Settings). The
// provider connections/tokens stay global (you connect a provider once); only the repo picks are scoped.
const wsKey = () => deps.activeWsId() || 'ws_default';
const curRepo = (): string => (state.settings.issueRepoByWs || {})[wsKey()] || '';
const trackedRepos = (): string[] => (state.settings.issueReposByWs || {})[wsKey()] || [];
async function setActiveRepo(qid: string): Promise<void> {
  const byWs = { ...(state.settings.issueRepoByWs || {}) }; byWs[wsKey()] = qid;
  state.settings = await relay.patchSettings({ issueRepoByWs: byWs });
}
async function setTracked(list: string[], activeQid: string): Promise<void> {
  const repos = { ...(state.settings.issueReposByWs || {}) }; repos[wsKey()] = list;
  const active = { ...(state.settings.issueRepoByWs || {}) }; active[wsKey()] = activeQid;
  state.settings = await relay.patchSettings({ issueReposByWs: repos, issueRepoByWs: active });
}

/* ----------------------------- providers (renderer-side display + brief config) ----------------------------- */
type ProviderId = 'github' | 'gitlab' | 'bitbucket';
interface ProvCfg {
  id: ProviderId; name: string; dot: string;              // dot = css class suffix (gh/gl/bb) for the colored dot
  connect: 'device' | 'token';                            // GitHub = OAuth device flow; others = pasted token
  tokenLabel?: string; tokenHint?: string; tokenPh?: string; needsHost?: boolean;
  // step-4 instruction for the agent brief: how to open the PR/MR and close the issue on merge.
  closeStep: (n: number) => string;
}
const PROVS: Record<ProviderId, ProvCfg> = {
  github: {
    id: 'github', name: 'GitHub', dot: 'gh', connect: 'device',
    closeStep: (n) => `open a pull request with \`gh pr create\`, and put the exact line \`Closes #${n}\` in the PR body. That keyword-immediately-before-#number form is what makes GitHub close this issue automatically when the PR merges — do NOT wrap it in other words or markdown (e.g. \`Closes the ... of **#${n}**\` will NOT close it).`,
  },
  gitlab: {
    id: 'gitlab', name: 'GitLab', dot: 'gl', connect: 'token', needsHost: true,
    tokenLabel: 'Personal Access Token', tokenPh: 'glpat-…',
    tokenHint: 'Scope read_api (add api to open MRs). Create at GitLab → Settings → Access Tokens.',
    closeStep: (n) => `open a merge request with \`glab mr create\`, and put the exact line \`Closes #${n}\` in the MR description. That keyword-immediately-before-#number form is what makes GitLab close this issue when the MR merges — do NOT wrap it in other words or markdown.`,
  },
  bitbucket: {
    id: 'bitbucket', name: 'Bitbucket', dot: 'bb', connect: 'token',
    tokenLabel: 'Username : App Password', tokenPh: 'username:app_password',
    tokenHint: 'Format "username:app_password". Create an App Password (Account read, Issues read/write, Pull requests read/write) at Bitbucket → Personal settings → App passwords.',
    closeStep: (n) => `push the branch and open a pull request in Bitbucket. To close the issue automatically, put the exact line \`Closes #${n}\` in a COMMIT message on the branch — Bitbucket closes issues from smart-commit messages, not from the PR description.`,
  },
};
const PROVIDER_LIST = [PROVS.github, PROVS.gitlab, PROVS.bitbucket]; // Sources display order
// Qualified repo id "provider:owner/name". A bare "owner/name" (legacy) is treated as GitHub.
function parseRepoId(id: string): { provider: ProviderId; repo: string } {
  const m = /^(github|gitlab|bitbucket):(.+)$/.exec(id || '');
  return m ? { provider: m[1] as ProviderId, repo: m[2] } : { provider: 'github', repo: id };
}
const repoId = (p: ProviderId, r: string) => `${p}:${r}`;

type Phase = 'idle' | 'loading' | 'ready' | 'error' | 'noauth' | 'norepo';
type RunStatus = 'idle' | 'queued' | 'working' | 'review';
// A prepared-but-not-yet-launched assignment: its worktree + brief already exist, so auto-launch is instant.
interface QueueItem { provider: ProviderId; repo: string; number: number; title: string; cwd: string; runCmd?: string; agentName: string; }
let phase: Phase = 'idle';
let provider: ProviderId = 'github';   // which provider the active repo belongs to
let repo: string | null = null;        // native repo id (owner/name | group/project | workspace/repo)
let issues: Issue[] = [];
let errMsg = '';
let loadedFor = '';   // the key the current result was pulled for (re-pull when it changes)
let loadSeq = 0;      // supersedes an in-flight pull when a newer one starts
let query = '';       // search box text
const activeFilters = new Set<string>();        // active local-tag filter chips (AND)
const activeLabels = new Set<string>();         // active provider-label filter chips (AND)
let mineOnly = false;                            // "assigned to me" toggle
let myLogin = '';                                // the connected provider login (for "assigned to me")
// The repo we're showing: this workspace's explicit pick wins, else it's inferred from its folder's remote.
const activeKey = () => `${wsKey()}:${curRepo() || state.settings.workspace || ''}`;
const runStatus = new Map<string, RunStatus>(); // "provider:repo#number" → run state (never bleeds across repos/providers)
let prByBranch: Record<string, { url: string; draft: boolean }> = {}; // "issue-N" branch → its open PR/MR (review → ship)
let lastKey: string | null = null; // the provider:repo the current filters/search belong to — reset them when it changes
// Assign queue: at most CAP agents run at once (per repo); the rest wait here and auto-launch when a
// slot frees (a running issue reaches review → its PR/MR appears). Prepared worktrees make launch instant.
const queue: QueueItem[] = [];
const CAP = (): number => Math.max(1, Math.min(8, Number(state.settings.issueConcurrency) || 2));
let pollTimer: number | null = null; // background PR/MR poll that drives unattended draining while agents run
const rk = (n: number) => `${provider}:${repo}#${n}`; // runStatus key for the CURRENT provider+repo

/* ----------------------------- local tags (private, relay.json) ----------------------------- */
// GitHub tags keep their legacy bare "owner/name#n" key so existing tags survive; other providers namespace.
const tagKey = (n: number) => (provider === 'github' ? `${repo || ''}#${n}` : `${provider}:${repo}#${n}`);
function tagsMap(): Record<string, string[]> { return (state.settings.issueTags ||= {}); }
const getTags = (n: number): string[] => tagsMap()[tagKey(n)] || [];
function allTags(): string[] { const s = new Set<string>(); for (const i of issues) for (const t of getTags(i.number)) s.add(t); return [...s].sort(); }
// Distinct provider labels across the pulled issues (first color wins), for the label-filter chips.
function allLabels(): { name: string; color?: string }[] {
  const m = new Map<string, string | undefined>();
  for (const i of issues) for (const l of i.labels) if (!m.has(l.name)) m.set(l.name, l.color);
  return [...m].map(([name, color]) => ({ name, color })).sort((a, b) => a.name.localeCompare(b.name));
}
const mineCount = (): number => (myLogin ? issues.filter((i) => (i.assignees || []).includes(myLogin)).length : 0);
async function persist(): Promise<void> { try { state.settings = await relay.patchSettings({ issueTags: tagsMap() }); } catch { /* keep the in-memory tags; a failed write must never clobber */ } }
async function addTag(n: number, raw: string): Promise<void> {
  const t = raw.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').slice(0, 24);
  if (!t) { render(); return; }
  const m = tagsMap(); const arr = m[tagKey(n)] || [];
  if (!arr.includes(t)) m[tagKey(n)] = [...arr, t];
  await persist(); render();
}
async function removeTag(n: number, t: string): Promise<void> {
  const m = tagsMap(); m[tagKey(n)] = (m[tagKey(n)] || []).filter((x) => x !== t);
  if (!m[tagKey(n)].length) delete m[tagKey(n)];
  activeFilters.delete(t);
  await persist(); render();
}

const hexColor = (c?: string) => (c && /^[0-9a-fA-F]{6}$/.test(c) ? '#' + c : '');
function labelHtml(l: { name: string; color?: string }): string {
  const c = hexColor(l.color);
  return `<span class="isr-lab"${c ? ` style="border-color:${c}88;color:${c}"` : ''}>${esc(l.name)}</span>`;
}
// A PR/MR on the issue-N branch means the run reached review; else the in-session run state; else idle.
const statusOf = (n: number): RunStatus => (prByBranch[`issue-${n}`] ? 'review' : runStatus.get(rk(n)) || 'idle');

// Apply the search query + active tag/label filters (AND) + "assigned to me" to the pulled issues.
function visibleIssues(): Issue[] {
  const q = query.trim().toLowerCase();
  return issues.filter((i) => {
    const tags = getTags(i.number);
    for (const f of activeFilters) if (!tags.includes(f)) return false;                 // every active tag-chip must match
    for (const l of activeLabels) if (!i.labels.some((x) => x.name === l)) return false; // every active label-chip must match
    if (mineOnly && !(i.assignees || []).includes(myLogin)) return false;               // assigned-to-me toggle
    if (!q) return true;
    if (q.startsWith('#')) return tags.some((t) => t.includes(q.slice(1)));
    return `#${i.number} ${i.title}`.toLowerCase().includes(q)
      || i.labels.some((l) => l.name.toLowerCase().includes(q))
      || tags.some((t) => t.includes(q));
  });
}

/* ----------------------------- render the sidebar section ----------------------------- */
function renderFilters(): void {
  const el = $('#issFilters'); if (!el) return;
  const tags = allTags();
  const labels = allLabels();
  const mc = mineCount();
  const show = phase === 'ready' && (mc > 0 || labels.length > 0 || tags.length > 0);
  (el as HTMLElement).style.display = show ? '' : 'none';
  if (!show) { el.innerHTML = ''; return; }
  const parts: string[] = [];
  // "assigned to me" first (only when some issue actually is), then provider labels, then local #tags.
  if (mc > 0) parts.push(`<button class="iss-fchip mine ${mineOnly ? 'on' : ''}" data-mine="1" title="Only issues assigned to you">◎ mine <b>${mc}</b></button>`);
  for (const l of labels) {
    const c = hexColor(l.color);
    parts.push(`<button class="iss-fchip lab ${activeLabels.has(l.name) ? 'on' : ''}" data-label="${esc(l.name)}"${c ? ` style="--lc:${c}"` : ''}><span class="iss-fdot"${c ? ` style="background:${c}"` : ''}></span>${esc(l.name)}</button>`);
  }
  for (const t of tags) parts.push(`<button class="iss-fchip ${activeFilters.has(t) ? 'on' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`);
  el.innerHTML = parts.join('');
  el.querySelectorAll<HTMLElement>('.iss-fchip').forEach((c) => {
    c.onclick = () => {
      if ('mine' in c.dataset) { mineOnly = !mineOnly; render(); return; }
      if ('label' in c.dataset) { const l = c.dataset.label!; activeLabels.has(l) ? activeLabels.delete(l) : activeLabels.add(l); render(); return; }
      const t = c.dataset.tag!; activeFilters.has(t) ? activeFilters.delete(t) : activeFilters.add(t); render();
    };
  });
}

function render(): void {
  const qN = queue.filter((q) => q.provider === provider && q.repo === repo).length; // queued-for-this-repo count
  const count = phase === 'ready' ? `${repo} · ${issues.length} open${qN ? ` · ${qN} queued` : ''}` : repo;
  const repoEl = $('#issSideRepo'); if (repoEl) repoEl.textContent = (repo ? count : 'Select repo') + ' ▾';
  const searchEl = $('#issSearch'); if (searchEl) (searchEl as HTMLElement).style.display = (phase === 'ready' && issues.length > 0) ? '' : 'none';
  renderFilters();
  const el = $('#issSideList'); if (!el) return;
  const pc = PROVS[provider];
  const hint = (icon: string, msg: string, sub = '') =>
    `<div class="isr-empty"><div class="isr-ei">${icon}</div><div>${msg}</div>${sub ? `<div class="isr-es">${sub}</div>` : ''}</div>`;

  if (phase === 'loading') { el.innerHTML = `<div class="isr-empty"><div class="isr-spin"></div><div>Pulling issues…</div></div>`; return; }
  if (phase === 'idle')    { el.innerHTML = hint('🎫', 'No issues pulled', 'Hit ⟳ to pull this repo’s open issues.'); return; }
  if (phase === 'noauth')  {
    el.innerHTML = `<div class="isr-empty"><div class="isr-ei">🔗</div><div>Not connected to ${esc(pc.name)}</div><div class="isr-es">Authorize Slayer T to pull your issues.</div><button class="isr-connect" id="issConnect">Connect ${esc(pc.name)}</button></div>`;
    const b = document.getElementById('issConnect'); if (b) b.onclick = () => void connectProvider(provider);
    return;
  }
  if (phase === 'norepo')  { el.innerHTML = hint('🗂️', 'No repo selected', esc(errMsg) || 'Pick a repo in Sources (⚙), or open a folder with a GitHub / GitLab / Bitbucket remote.'); return; }
  if (phase === 'error')   { el.innerHTML = hint('⚠️', 'Couldn’t pull issues', esc(errMsg)); return; }
  if (!issues.length)      { el.innerHTML = hint('✓', 'No open issues', repo ? esc(repo) : ''); return; }

  const vis = visibleIssues();
  if (!vis.length) { el.innerHTML = hint('🔍', 'No matching issues', 'Clear the search or a filter.'); return; }

  el.innerHTML = vis.map((i) => {
    const st = statusOf(i.number); const tags = getTags(i.number);
    return `<div class="isr" data-num="${i.number}" title="Assign #${i.number} to a coding agent">
      <div class="isr-hash">#${i.number}</div>
      <div class="isr-body">
        <div class="isr-title">${esc(i.title)}</div>
        <div class="isr-labs">
          ${i.labels.map(labelHtml).join('')}
          ${tags.map((t) => `<span class="isr-tag" data-num="${i.number}" data-tag="${esc(t)}" title="Remove #${esc(t)}">#${esc(t)}<span class="x">×</span></span>`).join('')}
          <button class="isr-tagadd" data-num="${i.number}" title="Add a private local tag">+</button>
        </div>
      </div>
      <div class="isr-side">
        <span class="isr-st ${st}" data-num="${i.number}"${st === 'queued' ? ' title="Click to remove from the queue"' : st === 'working' ? ' title="Click to free this slot (mark the run done)"' : ''}>${st}</span>
        ${prByBranch[`issue-${i.number}`] ? `<button class="isr-pr" data-url="${esc(prByBranch[`issue-${i.number}`].url)}" title="Open pull request">PR ↗</button>` : ''}
        <button class="isr-ext" data-url="${esc(i.url)}" title="Open #${i.number} on ${esc(pc.name)}">↗</button>
      </div>
    </div>`;
  }).join('');

  // Row click → assign. The ↗ opens on the provider; tag chips remove; + adds — all stop propagation.
  el.querySelectorAll<HTMLElement>('.isr').forEach((r) => {
    r.onclick = () => { const n = Number(r.dataset.num); const iss = issues.find((x) => x.number === n); if (iss) void openAssign(iss); };
  });
  el.querySelectorAll<HTMLElement>('.isr-ext, .isr-pr').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const u = b.dataset.url; if (u) relay.openExternal(u); };
  });
  // Status chip: queued → cancel; working → free the slot (so a queue can't wedge on a no-PR run).
  el.querySelectorAll<HTMLElement>('.isr-st.queued, .isr-st.working').forEach((c) => {
    c.onclick = (e) => { e.stopPropagation(); const n = Number(c.dataset.num); c.classList.contains('queued') ? cancelQueued(n) : freeSlot(n); };
  });
  el.querySelectorAll<HTMLElement>('.isr-tag').forEach((c) => {
    c.onclick = (e) => { e.stopPropagation(); void removeTag(Number(c.dataset.num), c.dataset.tag!); };
  });
  el.querySelectorAll<HTMLElement>('.isr-tagadd').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const n = Number(b.dataset.num);
      const inp = document.createElement('input');
      inp.className = 'isr-taginput'; inp.placeholder = 'tag'; inp.spellcheck = false; inp.maxLength = 24;
      b.replaceWith(inp); inp.focus();
      inp.onclick = (ev) => ev.stopPropagation();
      inp.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); void addTag(n, inp.value); } else if (ev.key === 'Escape') { render(); } };
      inp.onblur = () => { if (inp.value.trim()) void addTag(n, inp.value); else render(); };
    };
  });
}

/* ----------------------------- pull ----------------------------- */
// Resolve the active provider+repo (an explicit Sources pick, else inferred from the open folder's remote)
// → check auth → pull its open issues. Each failure lands on a specific, actionable state.
export async function loadIssues(): Promise<void> {
  const seq = ++loadSeq;                            // a newer pull supersedes this one at each await point
  const dir = state.settings.workspace || '';
  loadedFor = activeKey(); phase = 'loading'; render();
  // Which provider + repo? This workspace's explicit pick wins; otherwise infer from the folder's git remote.
  const pick = curRepo();
  if (pick) {
    const parsed = parseRepoId(pick); provider = parsed.provider; repo = parsed.repo;
  } else {
    const inf = dir ? await relay.providerRepoFromRemote(dir).catch(() => null) : null; if (seq !== loadSeq) return;
    provider = inf?.provider || 'github'; repo = inf?.repo || null;
  }
  const auth = await relay.providerAuthState(provider); if (seq !== loadSeq) return;
  if (!auth.connected) { phase = 'noauth'; render(); return; }
  myLogin = (auth.login as string) || '';           // for the "assigned to me" filter
  if (!repo) { phase = 'norepo'; errMsg = dir ? 'This folder’s git remote isn’t on a supported provider.' : 'No project folder is open.'; render(); return; }
  // Repo/provider switched → drop filters/search that belong to the previous one (they'd otherwise hide
  // every issue with no visible chip to clear). Run-status is provider+repo-keyed, no clearing needed.
  const curKey = `${provider}:${repo}`;
  if (curKey !== lastKey) { lastKey = curKey; activeFilters.clear(); activeLabels.clear(); mineOnly = false; query = ''; const sEl = $('#issSearch') as HTMLInputElement | null; if (sEl) sEl.value = ''; }
  const r = await relay.providerIssues(provider, repo); if (seq !== loadSeq) return;
  if (!r.ok) { phase = 'error'; errMsg = r.error || 'Could not pull issues'; render(); return; }
  issues = r.issues || []; phase = 'ready'; prByBranch = {}; render(); ensurePolling();
  // review → ship: light up issues whose issue-N branch already has an open PR/MR (best-effort, non-blocking).
  const forProvider = provider, forRepo = repo;
  relay.providerPrs(forProvider, forRepo).then((pr: { ok: boolean; prs?: { branch: string; url: string; draft: boolean }[] }) => {
    if (seq !== loadSeq || !pr.ok || !pr.prs) return;
    const map: Record<string, { url: string; draft: boolean }> = {};
    for (const p of pr.prs) map[p.branch] = { url: p.url, draft: p.draft };
    prByBranch = map; drainQueue(); render(); // a pre-existing PR/MR may free a slot for a queued issue
  }).catch(() => { /* PRs/MRs are a nice-to-have; the list still renders without them */ });
}

/* ----------------------------- assign queue engine (auto-drain) ----------------------------- */
// Agents actively working for the current repo. A PR/MR flips an issue to 'review' (statusOf), freeing its
// slot; a merged+closed issue drops out of `issues` on the next pull, which also frees it.
const workingCount = (): number => issues.filter((i) => statusOf(i.number) === 'working').length;

function launchQueued(item: QueueItem, auto: boolean): void {
  runStatus.set(`${item.provider}:${item.repo}#${item.number}`, 'working');
  deps.openAgentTab({ cwd: item.cwd, name: `issue #${item.number}`, runCmd: item.runCmd });
  toast(`${auto ? 'Auto-launching' : 'Launching'} ${item.agentName} on #${item.number}`, true);
}

// Fill every free slot from the queue (FIFO, current repo). Safe to call often; it no-ops when full/empty.
function drainQueue(): void {
  let launched = false;
  while (workingCount() < CAP()) {
    const idx = queue.findIndex((q) => q.provider === provider && q.repo === repo);
    if (idx < 0) break;
    launchQueued(queue.splice(idx, 1)[0], true);
    launched = true;
  }
  if (launched) render();
  ensurePolling();
}

// Background PR/MR poll — the engine that lets the queue drain while you're away. Runs only while there's
// something to drive (a queued item or a working agent for this repo), and stops itself otherwise.
async function pollPrs(): Promise<void> {
  const forProvider = provider, forRepo = repo;
  if (!forRepo) { ensurePolling(); return; }
  const pr = await relay.providerPrs(forProvider, forRepo).catch(() => null);
  if (!pr || !pr.ok || !pr.prs || forProvider !== provider || forRepo !== repo) return; // switched mid-flight → drop
  const map: Record<string, { url: string; draft: boolean }> = {};
  for (const p of pr.prs) map[p.branch] = { url: p.url, draft: p.draft };
  prByBranch = map;
  drainQueue(); render(); // a newly-opened PR/MR may free a slot; also refreshes review chips / PR buttons
}
function ensurePolling(): void {
  const active = queue.some((q) => q.provider === provider && q.repo === repo) || issues.some((i) => statusOf(i.number) === 'working');
  if (active && pollTimer == null) pollTimer = window.setInterval(() => void pollPrs(), 30000);
  else if (!active && pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
}

// Manual escape hatches for the queue's one failure mode: a run that ends WITHOUT a PR/MR (e.g. the agent
// judged the issue invalid) never frees its slot on its own. Clicking the status chip resolves it.
function cancelQueued(n: number): void {
  const i = queue.findIndex((q) => q.provider === provider && q.repo === repo && q.number === n);
  if (i >= 0) queue.splice(i, 1);
  runStatus.delete(rk(n));
  toast(`Removed #${n} from the queue`); render(); ensurePolling();
}
function freeSlot(n: number): void {
  runStatus.delete(rk(n));   // treat the run as done → its slot frees and the queue advances
  toast(`Freed the slot held by #${n}`);
  drainQueue(); render();
}

/* ----------------------------- assign → agent ----------------------------- */
// A self-contained modal (own scrim; Escape or scrim-click closes), reusing the app's dialog styles.
function modal(html: string, onClose?: () => void): { root: HTMLElement; close: () => void } {
  const root = document.createElement('div'); root.className = 'tpl-modal';
  root.innerHTML = `<div class="tpl-sc"></div>${html}`;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); onClose?.(); }; // onClose fires on ANY close (Escape/scrim/button)
  document.body.appendChild(root);
  document.addEventListener('keydown', onKey);
  root.querySelector('.tpl-sc')?.addEventListener('click', close);
  return { root, close };
}

// The brief handed to the agent — the issue itself plus a small, explicit task. Editable before launch.
// Step 4 (open the PR/MR + close keyword) is provider-specific.
function defaultBrief(i: Issue): string {
  const body = (i.body || '').trim() || '_(no description provided)_';
  return `# Issue #${i.number}: ${i.title}

${body}

---

## Task
1. **Validate the issue first.** Before changing anything, check whether the reported problem is real, correct, and reproducible in this codebase. If it is already fixed, not reproducible, or the report is inaccurate/invalid, say so clearly with evidence and stop — do not force a change.
2. If it is valid, implement a fix:
   - Make the smallest change that correctly resolves it.
   - Run the project's checks/tests if there are any.
3. Summarize what you did — the fix and why, or (if no change was needed) why the issue isn't valid.
4. If the fix looks good, ${PROVS[provider].closeStep(i.number)}
`;
}

// Coding agents you can assign an issue to. Each is a thin adapter: a bin to detect + how to launch it in
// the worktree terminal, seeded with the brief FILE (never issue text on the command line). Only Claude
// Code is verified on this machine; the others follow their documented CLIs and are best-effort.
const AGENTS: { id: string; name: string; bin: string; launch: (rel: string) => string }[] = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', launch: (rel) => `claude "Read ${rel} and implement the fix for the issue it describes in this repository, then summarize the changes."` },
  { id: 'gemini', name: 'Gemini CLI', bin: 'gemini', launch: (rel) => `gemini "Read ${rel} and implement the fix for the issue it describes in this repository, then summarize the changes."` },
  { id: 'codex', name: 'Codex CLI', bin: 'codex', launch: (rel) => `codex "Read ${rel} and implement the fix for the issue it describes in this repository, then summarize the changes."` },
  { id: 'aider', name: 'Aider', bin: 'aider', launch: (rel) => `aider --message "Read ${rel} and implement the fix for the issue it describes in this repository, then summarize the changes."` },
  { id: 'antigravity', name: 'Antigravity', bin: 'antigravity', launch: (rel) => `antigravity "Read ${rel} and implement the fix it describes in this repository, then summarize the changes."` },
];

let assigning = false; // guard the whole create-worktree round-trip against a double submit
async function openAssign(i: Issue): Promise<void> {
  const dir = state.settings.workspace || '';
  const detected = await relay.agentsDetect().catch(() => ({} as Record<string, boolean>));
  const installed = AGENTS.filter((a) => detected[a.id]);
  const agentOk = installed.length > 0;
  // Default agent = the saved preference if still installed, else the first installed one.
  let agentId = (state.settings.issueAgent && detected[state.settings.issueAgent]) ? state.settings.issueAgent : (installed[0]?.id || '');
  const opts = AGENTS.map((a) => `<option value="${a.id}"${a.id === agentId ? ' selected' : ''}${detected[a.id] ? '' : ' disabled'}>${esc(a.name)}${detected[a.id] ? '' : ' — not installed'}</option>`).join('');
  const primary = agentOk ? '⚡ Assign & launch' : 'Create worktree & open';
  const asgProvider = provider, asgRepo = repo; // pin the target so a mid-dialog repo switch can't retarget
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Assign #${i.number}<small>${esc(i.title)}</small></span></div>
      <div class="bd">
        <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Assign to</label><select class="iss-agentsel" id="issAgentSel"${agentOk ? '' : ' disabled'}>${opts}</select></div>
        <div class="iss-agent ${agentOk ? 'ok' : 'no'}">${agentOk ? '✓ runs in its own login/session (keyless where supported), in an isolated worktree' : '⚠ No coding agent on PATH — the worktree still opens; install Claude Code (or Gemini / Codex / Aider) to auto-launch.'}</div>
        <label class="iss-lbl">Brief for the agent <span class="mut">— edit before launch</span></label>
        <textarea class="iss-brief" spellcheck="false" rows="11">${esc(defaultBrief(i))}</textarea>
        <div class="iss-wt">Creates an isolated worktree on branch <code>issue-${i.number}</code> and runs the agent there.</div>
      </div>
      <div class="ft"><span class="hint">Saved as <code>.slayer/issue-${i.number}.md</code> (git-excluded)</span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-ok>${primary}</button></span></div>
    </div>`);
  const ta = root.querySelector('.iss-brief') as HTMLTextAreaElement;
  const okBtn = root.querySelector('[data-ok]') as HTMLButtonElement;
  const sel = root.querySelector('#issAgentSel') as HTMLSelectElement | null;
  if (sel) sel.onchange = () => { agentId = sel.value; void relay.patchSettings({ issueAgent: agentId }); }; // remember the pick
  root.querySelector('[data-x]')?.addEventListener('click', close);
  setTimeout(() => ta.focus(), 30);
  okBtn.addEventListener('click', async () => {
    if (assigning) return;
    assigning = true; okBtn.disabled = true; okBtn.textContent = 'Creating worktree…';
    const res = await relay.worktreeAdd(asgProvider, asgRepo || '', dir, i.number, ta.value).catch(() => ({ ok: false, error: 'Worktree creation failed' }));
    assigning = false;
    if (!root.isConnected) return; // user backed out (Escape/scrim) while the worktree was being created — don't launch
    if (!res.ok) { okBtn.disabled = false; okBtn.textContent = primary; toast(res.error || 'Could not create worktree'); return; }
    const rel = res.briefRel || '';
    const agent = AGENTS.find((a) => a.id === agentId);
    const runCmd = (agentOk && agent) ? (rel ? agent.launch(rel) : agent.bin) : undefined;
    // At capacity → queue it. The worktree + brief are already prepared above, so it auto-launches the
    // instant a running agent reaches review (its PR/MR appears) and frees a slot.
    if (agentOk && agent && workingCount() >= CAP()) {
      if (!queue.some((q) => q.provider === asgProvider && q.repo === (asgRepo || '') && q.number === i.number)) // don't double-queue
        queue.push({ provider: asgProvider, repo: asgRepo || '', number: i.number, title: i.title, cwd: res.path!, runCmd, agentName: agent.name });
      runStatus.set(`${asgProvider}:${asgRepo}#${i.number}`, 'queued');
      render(); ensurePolling(); close();
      toast(`Queued #${i.number} — starts when a slot frees (${workingCount()}/${CAP()} running)`, true);
      return;
    }
    deps.openAgentTab({ cwd: res.path!, name: `issue #${i.number}`, runCmd });
    if (agentOk) { runStatus.set(`${asgProvider}:${asgRepo}#${i.number}`, 'working'); ensurePolling(); } // the row now shows it's being worked on
    render();
    close();
    toast(res.reused ? `Reopened worktree for #${i.number}` : (agentOk ? `Launching ${agent?.name || 'agent'} on #${i.number}` : `Worktree ready for #${i.number}`), true);
  });
}

/* ----------------------------- repo selector + Sources ----------------------------- */
// (trackedRepos / curRepo / setActiveRepo / setTracked are defined at the top — Issues are per-workspace.
//  The legacy bare-id → provider-qualified migration now runs once at boot in the renderer.)

function closeRepoMenu(): void { document.getElementById('issRepoMenu')?.remove(); }
function openRepoMenu(): void {
  const btn = $('#issSideRepo'); if (!btn) return;
  if (document.getElementById('issRepoMenu')) { closeRepoMenu(); return; }
  const active = curRepo();
  const rows = [`<button class="iss-mi ${!active ? 'on' : ''}" data-repo=""><span class="d">⌂</span> This folder’s repo</button>`];
  for (const id of trackedRepos()) {
    const { provider: p, repo: r } = parseRepoId(id);
    rows.push(`<button class="iss-mi ${active === id ? 'on' : ''}" data-repo="${esc(id)}"><span class="d src-dot ${PROVS[p].dot}"></span> ${esc(r)}</button>`);
  }
  rows.push('<div class="iss-msep"></div>');
  rows.push('<button class="iss-mi" data-sources="1"><span class="d">⚙</span> Sources — connect &amp; pick repos…</button>');
  const menu = document.createElement('div'); menu.className = 'iss-menu'; menu.id = 'issRepoMenu';
  menu.innerHTML = rows.join('');
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.round(r.left) + 'px'; menu.style.top = Math.round(r.bottom + 4) + 'px';
  menu.querySelectorAll<HTMLElement>('.iss-mi').forEach((mi) => {
    mi.onclick = (e) => {
      e.stopPropagation();
      if (mi.dataset.sources) { closeRepoMenu(); void openSources(); return; }
      void setActiveRepo(mi.dataset.repo || '');
      closeRepoMenu(); void loadIssues();
    };
  });
  setTimeout(() => document.addEventListener('click', closeRepoMenu, { once: true }), 0);
}

// Route the right connect flow for a provider: GitHub → OAuth device flow; others → pasted-token dialog.
function connectProvider(pid: ProviderId): void { if (PROVS[pid].connect === 'device') void connectGithub(); else void connectToken(pid); }

// GitHub OAuth device flow: show the one-time code, open github.com/login/device, poll until authorized.
// The token is exchanged + stored (encrypted) entirely in main — the renderer only sees connected/login.
async function connectGithub(): Promise<void> {
  const start = await relay.githubDeviceStart().catch(() => ({ ok: false, error: 'Could not start' }));
  if (!start.ok || !start.deviceCode) { toast(start.error || 'Could not start GitHub connect'); return; }
  const verify = start.verificationUri || 'https://github.com/login/device';
  const code = start.userCode || '';
  let cancelled = false;
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Connect GitHub<small>authorize Slayer T on your account</small></span></div>
      <div class="bd">
        <div class="gh-step">1 · Copy this code</div>
        <div class="gh-code" id="ghCode" title="Click to copy">${esc(code)}</div>
        <div class="gh-step">2 · <button class="tpl-btn ghost" id="ghOpen">Open github.com/login/device ↗</button> and paste it</div>
        <div class="gh-status" id="ghStatus"><span class="gh-spin"></span> Waiting for you to authorize…</div>
      </div>
      <div class="ft"><span class="hint">Token stored encrypted in your OS keychain — never in <code>slayert.json</code></span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button></span></div>
    </div>`);
  root.querySelector('[data-x]')?.addEventListener('click', () => { cancelled = true; close(); });
  root.querySelector('#ghOpen')?.addEventListener('click', () => relay.openExternal(verify));
  root.querySelector('#ghCode')?.addEventListener('click', () => { try { relay.copyText(code); toast('Code copied', true); } catch { /* clipboard unavailable */ } });
  relay.openExternal(verify); // open the authorize page right away
  const statusEl = root.querySelector('#ghStatus') as HTMLElement | null;
  let wait = Math.max(5, Number(start.interval) || 5);
  const deadline = Date.now() + (Number(start.expiresIn) || 900) * 1000; // stop when the device code expires
  while (!cancelled && root.isConnected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    if (cancelled || !root.isConnected) break;
    const p = await relay.githubDevicePoll(start.deviceCode).catch(() => ({ status: 'error', error: 'poll failed' }));
    if (p.status === 'ok') { close(); toast(`Connected to GitHub as ${p.login || 'you'}`, true); void loadIssues(); return; }
    if (p.status === 'slow_down') { wait = Number(p.interval) || wait + 5; continue; }
    if (p.status === 'pending') continue;
    if (statusEl) statusEl.textContent = p.status === 'expired' ? 'Code expired — cancel and try again.' : p.status === 'denied' ? 'Authorization was denied.' : (p.error || 'Authorization failed.');
    return;
  }
  if (!cancelled && root.isConnected && statusEl) statusEl.textContent = 'Code expired — cancel and try again.'; // hit the deadline without authorizing
}

// Token connect (GitLab PAT / Bitbucket app-password): paste it, validate in main, store encrypted.
async function connectToken(pid: ProviderId): Promise<void> {
  const pc = PROVS[pid];
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Connect ${esc(pc.name)}<small>paste a read-scoped token</small></span></div>
      <div class="bd">
        ${pc.needsHost ? `<label class="iss-lbl">Host</label><input class="iss-in" id="ctHost" value="gitlab.com" spellcheck="false" autocomplete="off">` : ''}
        <label class="iss-lbl">${esc(pc.tokenLabel || 'Token')}</label>
        <input class="iss-in" id="ctTok" type="password" placeholder="${esc(pc.tokenPh || '')}" spellcheck="false" autocomplete="off">
        <div class="gh-status" id="ctStatus"></div>
        <div class="iss-wt">${esc(pc.tokenHint || '')}</div>
      </div>
      <div class="ft"><span class="hint">Stored encrypted in your OS keychain — never in <code>slayert.json</code></span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-ok>Connect</button></span></div>
    </div>`);
  const tok = root.querySelector('#ctTok') as HTMLInputElement;
  const host = root.querySelector('#ctHost') as HTMLInputElement | null;
  const statusEl = root.querySelector('#ctStatus') as HTMLElement;
  const okBtn = root.querySelector('[data-ok]') as HTMLButtonElement;
  root.querySelector('[data-x]')?.addEventListener('click', close);
  const submit = async () => {
    const t = tok.value.trim(); if (!t) { tok.focus(); return; }
    okBtn.disabled = true; okBtn.textContent = 'Connecting…'; statusEl.textContent = '';
    const r = await relay.providerConnect(pid, t, host?.value.trim()).catch(() => ({ ok: false, error: 'Connect failed' }));
    if (!root.isConnected) return;
    if (r.ok) { close(); toast(`Connected to ${pc.name} as ${r.login || 'you'}`, true); void loadIssues(); return; }
    okBtn.disabled = false; okBtn.textContent = 'Connect'; statusEl.textContent = r.error || 'Token rejected';
  };
  okBtn.addEventListener('click', () => void submit());
  tok.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } });
  setTimeout(() => tok.focus(), 30);
}

// Sources: the app's connections (GitHub / GitLab / Bitbucket) + which repos to track.
async function openSources(): Promise<void> {
  const tracked = new Set(trackedRepos());
  const states = await Promise.all(PROVIDER_LIST.map(async (pc) => ({ pc, auth: await relay.providerAuthState(pc.id).catch(() => ({ connected: false, login: '' })) })));
  const sections = states.map(({ pc, auth }) => {
    const st = auth.connected ? `✓ connected as <b>${esc(auth.login || '')}</b>` : '⚠ not connected';
    const ctl = auth.connected
      ? `<button class="tpl-btn ghost" data-load="${pc.id}">Load my repos</button><button class="tpl-btn ghost" data-disc="${pc.id}">Disconnect</button>`
      : `<button class="tpl-btn pri" data-connect="${pc.id}">Connect ${esc(pc.name)}</button>`;
    return `<div class="src-prov">
        <div class="src-row"><span class="src-nm"><span class="src-dot ${pc.dot}"></span> ${esc(pc.name)}</span><span class="src-st">${st}</span></div>
        <div class="src-repos" id="srcRepos-${pc.id}">${ctl}<div id="srcList-${pc.id}"></div></div>
      </div>`;
  }).join('');
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Sources<small>connect a provider · pick the repos to track</small></span></div>
      <div class="bd">
        ${sections}
        <div class="src-queue"><span class="src-nm">Assign queue</span><span class="src-qctl"><span>run at most</span><button class="src-step" data-cc="-1" title="Fewer">–</button><b id="srcCC">${CAP()}</b><button class="src-step" data-cc="1" title="More">+</button><span>agents at once</span></span></div>
      </div>
      <div class="ft"><span class="hint">Tokens encrypted in your OS keychain · picks in <code>slayert.json</code></span><span class="r"><button class="tpl-btn pri" data-x>Done</button></span></div>
    </div>`, () => void loadIssues()); // reload the panel however Sources is closed (Done / Escape / scrim)
  root.querySelector('[data-x]')?.addEventListener('click', close);
  const ccEl = root.querySelector('#srcCC') as HTMLElement | null;
  root.querySelectorAll<HTMLElement>('.src-step').forEach((b) => {
    b.onclick = async () => {
      const next = Math.max(1, Math.min(8, CAP() + Number(b.dataset.cc)));
      state.settings.issueConcurrency = next;
      if (ccEl) ccEl.textContent = String(next);
      state.settings = await relay.patchSettings({ issueConcurrency: next });
      drainQueue(); // raising the cap may free enough room to launch a queued issue right away
    };
  });
  // Connect / disconnect per provider (close first; the connect flow re-pulls on success, and any close reloads).
  root.querySelectorAll<HTMLElement>('[data-connect]').forEach((b) => { b.onclick = () => { const id = b.dataset.connect as ProviderId; close(); connectProvider(id); }; });
  root.querySelectorAll<HTMLElement>('[data-disc]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.disc as ProviderId;
      await relay.providerDisconnect(id).catch(() => {}); close(); toast(`Disconnected from ${PROVS[id].name}`); void loadIssues();
    };
  });
  // Load-my-repos per provider → checkboxes that track (and activate) qualified repo ids.
  root.querySelectorAll<HTMLElement>('[data-load]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.load as ProviderId;
      const btn = b as HTMLButtonElement; btn.textContent = 'Loading…'; btn.disabled = true;
      const r = await relay.providerRepos(id).catch(() => ({ ok: false, error: 'failed' }));
      btn.textContent = 'Load my repos'; btn.disabled = false;
      const box = root.querySelector(`#srcList-${id}`) as HTMLElement;
      if (!r.ok || !r.repos || !r.repos.length) { box.innerHTML = `<div class="src-empty">${esc(r.error || 'No repos found')}</div>`; return; }
      box.innerHTML = `<div class="src-list">${r.repos.map((rp: { repo: string; desc: string; priv: boolean }) => {
        const qid = repoId(id, rp.repo);
        return `<label class="src-item"><input type="checkbox" data-repo="${esc(qid)}"${tracked.has(qid) ? ' checked' : ''}><span class="src-r">${esc(rp.repo)}</span>${rp.priv ? '<span class="src-priv">private</span>' : ''}</label>`;
      }).join('')}</div>`;
      box.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((cb) => {
        cb.onchange = async () => {
          const qid = cb.dataset.repo!;
          // Per-workspace: checking a repo tracks it in THIS workspace AND makes it the active one, so
          // closing Sources shows its issues. Unchecking the active repo falls back to the folder.
          if (cb.checked) tracked.add(qid); else tracked.delete(qid);
          const active = cb.checked ? qid : (curRepo() === qid ? '' : curRepo());
          await setTracked([...tracked], active);
        };
      });
    };
  });
}

/* ----------------------------- wire-up ----------------------------- */
// Wire the sidebar section's controls. Call once, after the template DOM exists. Pulls on boot so the
// section shows the repo's issues without a click (each failure mode still renders its own hint).
export function initIssues(d: IssuesDeps): void {
  deps = d;
  const pull = $('#issSidePull'); if (pull) pull.onclick = () => { void loadIssues().then(() => { if (phase === 'ready') toast(`Pulled ${issues.length} issue${issues.length === 1 ? '' : 's'}`, true); }); };
  const s = $('#issSearch') as HTMLInputElement | null; if (s) s.oninput = () => { query = s.value; render(); };
  const rsel = $('#issSideRepo'); if (rsel) rsel.onclick = (e) => { e.stopPropagation(); openRepoMenu(); };
  const srcBtn = $('#issSources'); if (srcBtn) srcBtn.onclick = () => void openSources();
  render();
  void loadIssues();
}

// Command-palette entry point: pull (or re-pull) the current repo's issues.
export function pullIssues(): void {
  if (phase !== 'ready' || activeKey() !== loadedFor) void loadIssues(); else render();
}
