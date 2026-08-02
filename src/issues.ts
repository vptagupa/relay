// Issue Agent — Issues as a FIRST-CLASS sidebar section (peer of Library & Files), matching the
// App-shot / Console design: designed issue rows (# · title · GitHub labels · local #tags · run-status
// chip), a search + tag-filter, a per-repo pull via the keyless `gh` CLI, and click-to-Assign → an
// isolated git worktree + Claude Code in a tab. Local tags are private (relay.json, keyed repo+issue),
// never touch GitHub. DI-seam module: what it needs from the shell is injected via initIssues(deps).

import { state } from './state';
import { $, esc } from './dom';
import { toast } from './ui';
import type { Issue } from './shared/types';

const relay = (window as any).relay;

export interface IssuesDeps {
  openAgentTab: (o: { cwd: string; name: string; runCmd?: string }) => void; // open a terminal tab in the issue worktree, launching the agent
}
let deps: IssuesDeps;

type Phase = 'idle' | 'loading' | 'ready' | 'error' | 'noauth' | 'norepo';
type RunStatus = 'idle' | 'working' | 'review';
let phase: Phase = 'idle';
let repo: string | null = null;
let issues: Issue[] = [];
let errMsg = '';
let loadedFor = '';   // the workspace folder the current result was pulled for (re-pull when it changes)
let loadSeq = 0;      // supersedes an in-flight pull when a newer one starts
let query = '';       // search box text
const activeFilters = new Set<string>();        // active tag-filter chips (AND)
// The repo we're showing: an explicit Sources pick wins, else it's inferred from the open folder's remote.
const activeKey = () => state.settings.issueRepo || state.settings.workspace || '';
const runStatus = new Map<string, RunStatus>(); // "repo#number" → run state (repo-scoped so it can't bleed across repos)
let prByBranch: Record<string, { url: string; draft: boolean }> = {}; // "issue-N" branch → its open PR (review → ship)
let lastRepo: string | null = null; // the repo the current filters/search belong to — reset them when it changes

/* ----------------------------- local tags (private, relay.json) ----------------------------- */
const tagKey = (n: number) => `${repo || ''}#${n}`;
function tagsMap(): Record<string, string[]> { return (state.settings.issueTags ||= {}); }
const getTags = (n: number): string[] => tagsMap()[tagKey(n)] || [];
function allTags(): string[] { const s = new Set<string>(); for (const i of issues) for (const t of getTags(i.number)) s.add(t); return [...s].sort(); }
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
// A PR on the issue-N branch means the run reached review; else the in-session run state; else idle.
const statusOf = (n: number): RunStatus => (prByBranch[`issue-${n}`] ? 'review' : runStatus.get(`${repo}#${n}`) || 'idle');

// Apply the search query + active tag-filters (AND) to the pulled issues.
function visibleIssues(): Issue[] {
  const q = query.trim().toLowerCase();
  return issues.filter((i) => {
    const tags = getTags(i.number);
    for (const f of activeFilters) if (!tags.includes(f)) return false;   // every active tag-chip must match
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
  const show = phase === 'ready' && tags.length > 0;
  (el as HTMLElement).style.display = show ? '' : 'none';
  if (!show) { el.innerHTML = ''; return; }
  el.innerHTML = tags.map((t) => `<button class="iss-fchip ${activeFilters.has(t) ? 'on' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
  el.querySelectorAll<HTMLElement>('.iss-fchip').forEach((c) => {
    c.onclick = () => { const t = c.dataset.tag!; activeFilters.has(t) ? activeFilters.delete(t) : activeFilters.add(t); render(); };
  });
}

function render(): void {
  const repoEl = $('#issSideRepo'); if (repoEl) repoEl.textContent = (repo ? (phase === 'ready' ? `${repo} · ${issues.length} open` : repo) : 'Select repo') + ' ▾';
  const searchEl = $('#issSearch'); if (searchEl) (searchEl as HTMLElement).style.display = (phase === 'ready' && issues.length > 0) ? '' : 'none';
  renderFilters();
  const el = $('#issSideList'); if (!el) return;
  const hint = (icon: string, msg: string, sub = '') =>
    `<div class="isr-empty"><div class="isr-ei">${icon}</div><div>${msg}</div>${sub ? `<div class="isr-es">${sub}</div>` : ''}</div>`;

  if (phase === 'loading') { el.innerHTML = `<div class="isr-empty"><div class="isr-spin"></div><div>Pulling issues…</div></div>`; return; }
  if (phase === 'idle')    { el.innerHTML = hint('🎫', 'No issues pulled', 'Hit ⟳ to pull this repo’s open issues.'); return; }
  if (phase === 'noauth')  {
    el.innerHTML = `<div class="isr-empty"><div class="isr-ei">🔗</div><div>Not connected to GitHub</div><div class="isr-es">Authorize Slayer T to pull your issues.</div><button class="isr-connect" id="issConnect">Connect GitHub</button></div>`;
    const b = document.getElementById('issConnect'); if (b) b.onclick = () => void connectGithub();
    return;
  }
  if (phase === 'norepo')  { el.innerHTML = hint('🗂️', 'No GitHub repo here', esc(errMsg) || 'Open a folder whose git remote is on GitHub.'); return; }
  if (phase === 'error')   { el.innerHTML = hint('⚠️', 'Couldn’t pull issues', esc(errMsg)); return; }
  if (!issues.length)      { el.innerHTML = hint('✓', 'No open issues', repo ? esc(repo) : ''); return; }

  const vis = visibleIssues();
  if (!vis.length) { el.innerHTML = hint('🔍', 'No matching issues', 'Clear the search or a filter.'); return; }

  el.innerHTML = vis.map((i) => {
    const st = statusOf(i.number); const tags = getTags(i.number);
    return `<div class="isr" data-num="${i.number}" title="Assign #${i.number} to Claude Code">
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
        <span class="isr-st ${st}">${st}</span>
        ${prByBranch[`issue-${i.number}`] ? `<button class="isr-pr" data-url="${esc(prByBranch[`issue-${i.number}`].url)}" title="Open pull request">PR ↗</button>` : ''}
        <button class="isr-ext" data-url="${esc(i.url)}" title="Open #${i.number} on GitHub">↗</button>
      </div>
    </div>`;
  }).join('');

  // Row click → assign. The ↗ opens on GitHub; tag chips remove; + adds — all stop propagation.
  el.querySelectorAll<HTMLElement>('.isr').forEach((r) => {
    r.onclick = () => { const n = Number(r.dataset.num); const iss = issues.find((x) => x.number === n); if (iss) void openAssign(iss); };
  });
  el.querySelectorAll<HTMLElement>('.isr-ext, .isr-pr').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const u = b.dataset.url; if (u) relay.openExternal(u); };
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
// Detect gh → resolve the active workspace's repo → pull its open issues. Each failure lands on a
// specific, actionable state rather than a dead section.
export async function loadIssues(): Promise<void> {
  const seq = ++loadSeq;                            // a newer pull supersedes this one at each await point
  const dir = state.settings.workspace || '';
  loadedFor = activeKey(); phase = 'loading'; render();
  const auth = await relay.githubAuthState(); if (seq !== loadSeq) return;
  if (!auth.connected) { phase = 'noauth'; render(); return; }
  repo = state.settings.issueRepo || (dir ? await relay.githubRepo(dir) : null); if (seq !== loadSeq) return;
  if (!repo) { phase = 'norepo'; errMsg = dir ? 'This folder’s git remote isn’t on GitHub.' : 'No project folder is open.'; render(); return; }
  // Repo switched → drop filters/search that belong to the previous repo (they'd otherwise hide every
  // issue with no visible chip to clear). Run-status is repo-keyed, so it doesn't need clearing here.
  if (repo !== lastRepo) { lastRepo = repo; activeFilters.clear(); query = ''; const sEl = $('#issSearch') as HTMLInputElement | null; if (sEl) sEl.value = ''; }
  const r = await relay.githubIssues(repo); if (seq !== loadSeq) return;
  if (!r.ok) { phase = 'error'; errMsg = r.error || 'Could not pull issues'; render(); return; }
  issues = r.issues || []; phase = 'ready'; prByBranch = {}; render();
  // review → ship: light up issues whose issue-N branch already has an open PR (best-effort, non-blocking).
  const forRepo = repo;
  relay.githubPrs(forRepo).then((pr: { ok: boolean; prs?: { branch: string; url: string; draft: boolean }[] }) => {
    if (seq !== loadSeq || !pr.ok || !pr.prs) return;
    const map: Record<string, { url: string; draft: boolean }> = {};
    for (const p of pr.prs) map[p.branch] = { url: p.url, draft: p.draft };
    prByBranch = map; render();
  }).catch(() => { /* PRs are a nice-to-have; the list still renders without them */ });
}

/* ----------------------------- assign → agent ----------------------------- */
// A self-contained modal (own scrim; Escape or scrim-click closes), reusing the app's dialog styles.
function modal(html: string): { root: HTMLElement; close: () => void } {
  const root = document.createElement('div'); root.className = 'tpl-modal';
  root.innerHTML = `<div class="tpl-sc"></div>${html}`;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
  document.body.appendChild(root);
  document.addEventListener('keydown', onKey);
  root.querySelector('.tpl-sc')?.addEventListener('click', close);
  return { root, close };
}

// The brief handed to the agent — the issue itself plus a small, explicit task. Editable before launch.
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
4. If the fix looks good, open a pull request with \`gh pr create\`.
`;
}

// Coding agents you can assign an issue to. Each is a thin adapter: a bin to detect + how to launch it in
// the worktree terminal, seeded with the brief FILE (never issue text on the command line). Only Claude
// Code is verified on this machine; the others follow their documented CLIs and are best-effort.
const AGENTS: { id: string; name: string; bin: string; launch: (rel: string) => string }[] = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', launch: (rel) => `claude "Read ${rel} and implement the fix for the GitHub issue it describes in this repository, then summarize the changes."` },
  { id: 'gemini', name: 'Gemini CLI', bin: 'gemini', launch: (rel) => `gemini "Read ${rel} and implement the fix for the GitHub issue it describes in this repository, then summarize the changes."` },
  { id: 'codex', name: 'Codex CLI', bin: 'codex', launch: (rel) => `codex "Read ${rel} and implement the fix for the GitHub issue it describes in this repository, then summarize the changes."` },
  { id: 'aider', name: 'Aider', bin: 'aider', launch: (rel) => `aider --message "Read ${rel} and implement the fix for the GitHub issue it describes in this repository, then summarize the changes."` },
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
    const res = await relay.worktreeAdd(repo || '', dir, i.number, ta.value).catch(() => ({ ok: false, error: 'Worktree creation failed' }));
    assigning = false;
    if (!root.isConnected) return; // user backed out (Escape/scrim) while the worktree was being created — don't launch
    if (!res.ok) { okBtn.disabled = false; okBtn.textContent = primary; toast(res.error || 'Could not create worktree'); return; }
    const rel = res.briefRel || '';
    const agent = AGENTS.find((a) => a.id === agentId);
    const runCmd = (agentOk && agent) ? (rel ? agent.launch(rel) : agent.bin) : undefined;
    deps.openAgentTab({ cwd: res.path!, name: `issue #${i.number}`, runCmd });
    if (agentOk) { runStatus.set(`${repo}#${i.number}`, 'working'); render(); } // the row now shows it's being worked on
    close();
    toast(res.reused ? `Reopened worktree for #${i.number}` : (agentOk ? `Launching ${agent?.name || 'agent'} on #${i.number}` : `Worktree ready for #${i.number}`), true);
  });
}

/* ----------------------------- repo selector + Sources ----------------------------- */
const trackedRepos = (): string[] => state.settings.issueRepos || [];

function closeRepoMenu(): void { document.getElementById('issRepoMenu')?.remove(); }
function openRepoMenu(): void {
  const btn = $('#issSideRepo'); if (!btn) return;
  if (document.getElementById('issRepoMenu')) { closeRepoMenu(); return; }
  const active = state.settings.issueRepo || '';
  const rows = [`<button class="iss-mi ${!active ? 'on' : ''}" data-repo=""><span class="d">⌂</span> This folder’s repo</button>`];
  for (const r of trackedRepos()) rows.push(`<button class="iss-mi ${active === r ? 'on' : ''}" data-repo="${esc(r)}"><span class="d">▦</span> ${esc(r)}</button>`);
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
      state.settings.issueRepo = mi.dataset.repo || '';
      void relay.patchSettings({ issueRepo: state.settings.issueRepo });
      closeRepoMenu(); void loadIssues();
    };
  });
  setTimeout(() => document.addEventListener('click', closeRepoMenu, { once: true }), 0);
}

// OAuth device flow: show the one-time code, open github.com/login/device, poll until authorized.
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
      <div class="ft"><span class="hint">Token stored encrypted in your OS keychain — never in <code>relay.json</code></span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button></span></div>
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

// Sources: the app's own GitHub connection (OAuth) + which repos to track. GitLab/Bitbucket land later.
async function openSources(): Promise<void> {
  const auth = await relay.githubAuthState().catch(() => ({ connected: false, login: '' }));
  const tracked = new Set(trackedRepos());
  const ghStatus = auth.connected ? `✓ connected as <b>${esc(auth.login || '')}</b>` : '⚠ not connected';
  const ghCtl = auth.connected
    ? '<button class="tpl-btn ghost" id="srcLoad">Load my repos</button><button class="tpl-btn ghost" id="srcDisc">Disconnect</button>'
    : '<button class="tpl-btn pri" id="srcConnect">Connect GitHub</button>';
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Sources<small>connect a provider · pick the repos to track</small></span></div>
      <div class="bd">
        <div class="src-prov">
          <div class="src-row"><span class="src-nm"><span class="src-dot gh"></span> GitHub</span><span class="src-st">${ghStatus}</span></div>
          <div class="src-repos" id="srcRepos">${ghCtl}<div id="srcList"></div></div>
        </div>
        <div class="src-prov dim"><div class="src-row"><span class="src-nm"><span class="src-dot gl"></span> GitLab</span><span class="src-st">adapter arrives next slice</span></div></div>
        <div class="src-prov dim"><div class="src-row"><span class="src-nm"><span class="src-dot bb"></span> Bitbucket</span><span class="src-st">adapter arrives next slice</span></div></div>
      </div>
      <div class="ft"><span class="hint">Token encrypted in your OS keychain · picks in <code>relay.json</code></span><span class="r"><button class="tpl-btn pri" data-x>Done</button></span></div>
    </div>`);
  root.querySelector('[data-x]')?.addEventListener('click', () => { close(); void loadIssues(); });
  root.querySelector('#srcConnect')?.addEventListener('click', () => { close(); void connectGithub(); });
  root.querySelector('#srcDisc')?.addEventListener('click', async () => { await relay.githubDisconnect().catch(() => {}); close(); toast('Disconnected from GitHub'); void loadIssues(); });
  const load = root.querySelector('#srcLoad') as HTMLButtonElement | null;
  if (load) load.onclick = async () => {
    load.textContent = 'Loading…'; load.disabled = true;
    const r = await relay.githubRepos().catch(() => ({ ok: false, error: 'failed' }));
    const box = root.querySelector('#srcList') as HTMLElement;
    if (!r.ok || !r.repos || !r.repos.length) { box.innerHTML = `<div class="src-empty">${esc(r.error || 'No repos found')}</div>`; return; }
    box.innerHTML = `<div class="src-list">${r.repos.map((rp: { repo: string; desc: string; priv: boolean }) => `<label class="src-item"><input type="checkbox" data-repo="${esc(rp.repo)}"${tracked.has(rp.repo) ? ' checked' : ''}><span class="src-r">${esc(rp.repo)}</span>${rp.priv ? '<span class="src-priv">private</span>' : ''}</label>`).join('')}</div>`;
    box.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((cb) => {
      cb.onchange = async () => {
        const rp = cb.dataset.repo!;
        // Checking a repo tracks it AND makes it the active one, so closing Sources shows its issues —
        // no separate trip to the repo selector. Unchecking the active repo falls back to the folder.
        if (cb.checked) { tracked.add(rp); state.settings.issueRepo = rp; }
        else { tracked.delete(rp); if (state.settings.issueRepo === rp) state.settings.issueRepo = ''; }
        state.settings = await relay.patchSettings({ issueRepos: [...tracked], issueRepo: state.settings.issueRepo });
      };
    });
  };
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
