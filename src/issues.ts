// Issue Agent — Issues as a FIRST-CLASS sidebar section (peer of Library & Files), matching the
// App-shot / Console design: designed issue rows (# · title · labels · local #tags · run-status chip),
// a search + label/tag filter + "assigned to me", a per-repo pull, and click-to-Assign → an isolated
// git worktree + a coding agent in a tab. MULTI-PROVIDER: GitHub / GitLab / Bitbucket, each behind the
// app-owned token in main (providers.ts); the renderer only ever sees { connected, login } + normalized
// issues. Local tags are private (relay.json, keyed provider+repo+issue), never touch the provider.
// DI-seam module: what it needs from the shell is injected via initIssues(deps).

import { state } from './state';
import { $, esc } from './dom';
import { toast, addSearch } from './ui';
import { openAuthorFilter } from './author-filter';
import type { Issue } from './shared/types';
import { allPipelines, pipelineById, isGate, nextEdge, stageIndexById, STOP, renderBrief, stageStatus, type PipelineDef, type StageDef, type BriefCtx } from './pipelines';
import { openPipelineBuilder } from './pipeline-editor';
import { AGENTS } from './agents-list';
import { dbCredOptions, dbCredNote, loadDbCreds, dbCredMetas } from './dbcreds';
import { repoDepsFor } from './repo-deps';
import { noteChecks, notesNote, defaultNoteIds } from './brief-notes';

const relay = (window as any).relay;

export interface IssuesDeps {
  openAgentTab: (o: { cwd: string; name: string; runCmd?: string; dbCredId?: string }) => void; // open a terminal tab in the issue worktree, launching the agent (dbCredId → inject a DB credential template into its env)
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
// The one-time OAuth *app* a provider's login flow needs (client id, + secret for Bitbucket). Entered once
// in-app, stored encrypted in main — never in source. Absent for providers that don't use one (GitLab).
interface OAuthAppCfg {
  needsSecret: boolean;
  title: string;                                          // dialog title
  idLabel: string; idPh: string;                          // client-id field
  secretLabel?: string; secretPh?: string;                // secret field (when needsSecret)
  help: string;                                           // trusted static HTML: where to create the app
  createUrl?: string;                                     // optional "Create one ↗" deep-link
}
interface ProvCfg {
  id: ProviderId; name: string; dot: string;              // dot = css class suffix (gh/gl/bb) for the colored dot
  connect: 'device' | 'token' | 'browser';               // GitHub = OAuth device flow; Bitbucket = OAuth in-browser; GitLab = pasted token
  tokenLabel?: string; tokenHint?: string; tokenPh?: string; needsHost?: boolean;
  oauthApp?: OAuthAppCfg;                                 // present when connect needs a configured OAuth app first
  // step-4 instruction for the agent brief: how to open the PR/MR and close the issue on merge.
  closeStep: (n: number) => string;
}
const PROVS: Record<ProviderId, ProvCfg> = {
  github: {
    id: 'github', name: 'GitHub', dot: 'gh', connect: 'device',
    oauthApp: {
      needsSecret: false,
      title: 'GitHub OAuth app',
      idLabel: 'Client ID', idPh: 'Iv1.… / Ov23li…',
      help: 'Create a GitHub OAuth App (Settings → Developer settings → OAuth Apps → New OAuth App), turn ON <b>Enable Device Flow</b>, and paste its <b>Client ID</b>. No client secret is needed.',
      createUrl: 'https://github.com/settings/developers',
    },
    closeStep: (n) => `open a pull request with \`gh pr create\`, and put the exact line \`Closes #${n}\` in the PR body. That keyword-immediately-before-#number form is what makes GitHub close this issue automatically when the PR merges — do NOT wrap it in other words or markdown (e.g. \`Closes the ... of **#${n}**\` will NOT close it).`,
  },
  gitlab: {
    id: 'gitlab', name: 'GitLab', dot: 'gl', connect: 'token', needsHost: true,
    tokenLabel: 'Personal Access Token', tokenPh: 'glpat-…',
    tokenHint: 'Scope read_api (add api to open MRs). Create at GitLab → Settings → Access Tokens.',
    closeStep: (n) => `open a merge request with \`glab mr create\`, and put the exact line \`Closes #${n}\` in the MR description. That keyword-immediately-before-#number form is what makes GitLab close this issue when the MR merges — do NOT wrap it in other words or markdown.`,
  },
  bitbucket: {
    id: 'bitbucket', name: 'Bitbucket', dot: 'bb', connect: 'browser',
    oauthApp: {
      needsSecret: true,
      title: 'Bitbucket OAuth client',
      idLabel: 'Key (Client ID)', idPh: 'consumer key',
      secretLabel: 'Secret', secretPh: 'consumer secret',
      help: 'Create an OAuth consumer/client (Bitbucket → Workspace settings → OAuth consumers). Callback URL: <code>http://localhost</code>. Permissions: Account, Repositories, Issues, Pull requests → <b>Read</b>. Paste its Key + Secret.',
    },
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
// A run moves through pipeline-stage statuses (validating/fixing) before a PR flips it to review; a closed
// gate lands it on `invalid`. `working` is kept for the no-agent / legacy path.
type RunStatus = 'idle' | 'queued' | 'working' | 'validating' | 'fixing' | 'invalid' | 'review';
// A prepared-but-not-yet-launched assignment: its worktree + stage-0 brief already exist, so the whole
// pipeline auto-launches (from stage 0) the instant a slot frees.
interface QueueItem { provider: ProviderId; repo: string; number: number; title: string; cwd: string; agentId: string; agentName: string; issue: Issue; pipeline: PipelineDef; brief0Rel: string; }
let phase: Phase = 'idle';
let provider: ProviderId = 'github';   // which provider the active repo belongs to
let repo: string | null = null;        // native repo id (owner/name | group/project | workspace/repo)
let issues: Issue[] = [];
let errMsg = '';
let loadedFor = '';   // the key the current result was pulled for (re-pull when it changes)
let loadSeq = 0;      // supersedes an in-flight pull when a newer one starts
let issuesPage = 1;   // highest provider page loaded into `issues` (infinite scroll)
let issuesHasMore = false; // the last page came back full → more issues to load on scroll
let loadingMore = false;   // a load-more fetch is in flight (guards re-entrancy)
let query = '';       // search box text
const activeFilters = new Set<string>();        // active local-tag filter chips (AND)
const activeLabels = new Set<string>();         // active provider-label filter chips (AND)
const activeAuthors = new Set<string>();        // active "created by" filter (OR — an issue has one author)
let members: string[] = [];                      // the active repo's members — the author-filter list (∪ loaded authors)
let membersFor = '';                             // the "provider:repo" the loaded members belong to — gate a re-fetch to a repo change
let wtByBranch = new Map<string, string>();      // 'issue-<N>' → existing worktree path — powers the reopen-terminal (⧉) action
let wtFor = '';                                  // the "provider:repo" the worktree map belongs to (fetched once per repo)
let authorReloadT: number | null = null;         // debounce: coalesce rapid author toggles into one server-side re-query
let mineOnly = false;                            // "assigned to me" toggle
let myLogin = '';                                // the connected provider login (for "assigned to me")
let issueState: 'open' | 'closed' = 'open';      // which issues to pull (server-side); default open
let issScope: 'repo' | 'all' = 'repo';           // 'repo' = the active repo (paged); 'all' = every tracked repo merged (first page each)
// The repo we're showing: this workspace's explicit pick wins, else it's inferred from its folder's remote.
const activeKey = () => `${wsKey()}:${curRepo() || state.settings.workspace || ''}:${issueState}`;
const runStatus = new Map<string, RunStatus>(); // "provider:repo#number" → run state (never bleeds across repos/providers)
// A running (or just-ended `invalid`) pipeline for an issue — enough to advance stages, gate on verdicts,
// draw the graph in Details, and offer a one-click override after an `invalid` verdict. Keyed like runStatus.
interface RunInfo {
  provider: ProviderId; repo: string; number: number; title: string;
  issue: Issue;         // the full issue — its title/body seed each stage's brief FILE
  pipeline: PipelineDef; // a snapshot of the chosen pipeline (survives later edits/deletes of a custom one)
  stageIdx: number;     // the currently-active stage (or the gate that failed, for `invalid`)
  wt: string;           // the issue's worktree path (where .slayer/ briefs + verdicts live)
  agentId: string;
  brief0Rel: string;    // stage 0's brief file (written by worktree-add); later stages get their own
  awaiting: boolean;    // true while a GATE stage's verdict is being polled
  reason?: string;      // an `invalid` gate's explanation (shown in Details; drives the override)
}
const runs = new Map<string, RunInfo>();                            // "provider:repo#number" → its pipeline run
const OCCUPYING: RunStatus[] = ['working', 'validating', 'fixing']; // statuses that hold a concurrency slot
// User-authored pipelines (built-ins live in code); the registry merges them. Read fresh each time so a
// pipeline created/edited in the builder is picked up on the next Assign without a reload.
const customPipelines = (): PipelineDef[] => state.settings.pipelines || [];
// Per-issue pipeline: each issue remembers its own pipeline (persisted), NOT a shared global preference.
// Keyed "provider:repo#number". Unset (or a pipeline that no longer exists) → the default (first built-in = Validate → Fix).
const pipeKeyFor = (prov: ProviderId, rpo: string, n: number) => `${prov}:${rpo || ''}#${n}`;
function issuePipelineFor(prov: ProviderId, rpo: string, n: number): string {
  const stored = (state.settings.issuePipelineByKey || {})[pipeKeyFor(prov, rpo, n)];
  const all = allPipelines(customPipelines());
  return stored && all.some((p) => p.id === stored) ? stored : all[0].id;
}
// Serialize the per-issue-pipeline writes: patchSettings replaces issuePipelineByKey wholesale, so two fast
// board drags fired concurrently could clobber each other (each reads the map before the other's write lands).
// Chaining makes each write read the freshest map (updated by the previous write's `state.settings = …`).
let pipeWriteChain: Promise<void> = Promise.resolve();
function setIssuePipeline(prov: ProviderId, rpo: string, n: number, id: string): Promise<void> {
  pipeWriteChain = pipeWriteChain.then(async () => {
    const map = { ...(state.settings.issuePipelineByKey || {}) };
    const all = allPipelines(customPipelines());
    if (id === all[0].id) delete map[pipeKeyFor(prov, rpo, n)]; else map[pipeKeyFor(prov, rpo, n)] = id; // storing the default = no entry
    try { state.settings = await relay.patchSettings({ issuePipelineByKey: map }); } catch { /* keep the in-memory pick */ }
  });
  return pipeWriteChain;
}
// Per-issue dependency repos (read-only reference), keyed like the per-issue pipeline. Stored as qualified
// "provider:repo" ids — the OTHER repos whose codebase the agent should be able to read while fixing this issue.
function issueDepsFor(prov: ProviderId, rpo: string, n: number): string[] { return (state.settings.issueDepsByKey || {})[pipeKeyFor(prov, rpo, n)] || []; }
let depsWriteChain: Promise<void> = Promise.resolve();
function setIssueDeps(prov: ProviderId, rpo: string, n: number, ids: string[]): Promise<void> {
  depsWriteChain = depsWriteChain.then(async () => {
    const map = { ...(state.settings.issueDepsByKey || {}) };
    if (ids.length) map[pipeKeyFor(prov, rpo, n)] = ids; else delete map[pipeKeyFor(prov, rpo, n)];
    try { state.settings = await relay.patchSettings({ issueDepsByKey: map }); } catch { /* keep the in-memory pick */ }
  });
  return depsWriteChain;
}
// Per-issue DB credential template id (see dbcreds.ts), keyed like the per-issue pipeline. Injected into the
// run's env at each stage launch so the agent can connect to the DB without being asked for credentials.
function issueDbCredFor(prov: ProviderId, rpo: string, n: number): string { return (state.settings.issueDbCredByKey || {})[pipeKeyFor(prov, rpo, n)] || ''; }
let dbCredWriteChain: Promise<void> = Promise.resolve();
function setIssueDbCred(prov: ProviderId, rpo: string, n: number, id: string): Promise<void> {
  dbCredWriteChain = dbCredWriteChain.then(async () => {
    const map = { ...(state.settings.issueDbCredByKey || {}) };
    if (id) map[pipeKeyFor(prov, rpo, n)] = id; else delete map[pipeKeyFor(prov, rpo, n)];
    try { state.settings = await relay.patchSettings({ issueDbCredByKey: map }); } catch { /* keep the in-memory pick */ }
  });
  return dbCredWriteChain;
}
// The brief section that points the agent at the read-only reference repos (linked under .deps/ at build time).
function depsNote(ids: string[]): string {
  if (!ids.length) return '';
  const lines = ids.map((id) => { const { repo: r } = parseRepoId(id); return `- \`.deps/${r.split('/').pop()}\` — ${id}`; }).join('\n');
  return `\n\n---\n\n## Reference repositories (read-only — do NOT modify or commit these)\nThese related repos are checked out under \`.deps/\` for context:\n${lines}\nRead them to understand interfaces/contracts; your changes belong ONLY in this repository.`;
}

// A defensive copy of a pipeline captured at assign time — so an in-flight run keeps the wiring it started
// with even if the (custom) pipeline is later edited or deleted in the builder.
const clonePipeline = (p: PipelineDef): PipelineDef => JSON.parse(JSON.stringify(p));
// The wired success path: from the entry (stages[0]), follow each stage's `valid` (else `always`) edge to a
// stage until a terminal or a repeat. This is the order the runner actually executes — the display follows it.
function wiredPath(p: PipelineDef): number[] {
  const path: number[] = []; if (!p.stages.length) return path;
  const seen = new Set<number>(); let idx = 0;
  while (idx >= 0 && idx < p.stages.length && !seen.has(idx)) {
    seen.add(idx); path.push(idx);
    const st = p.stages[idx];
    const e = (st.edges || []).find((x) => x.when === 'valid') || (st.edges || []).find((x) => x.when === 'always');
    if (!e || e.to === STOP) break;
    idx = stageIndexById(p, e.to);
  }
  return path;
}
let prByBranch: Record<string, { url: string; draft: boolean }> = {}; // "issue-N" branch → its open PR/MR (review → ship)
let lastKey: string | null = null; // the provider:repo:state the label/tag/search filters belong to — reset them when it changes
let lastRepoKey: string | null = null; // the provider:repo the author filter belongs to — cleared only on a real repo switch (survives state toggles)
// Assign queue: at most CAP agents run at once (per repo); the rest wait here and auto-launch when a
// slot frees (a running issue reaches review → its PR/MR appears). Prepared worktrees make launch instant.
const queue: QueueItem[] = [];
const CAP = (): number => Math.max(1, Math.min(8, Number(state.settings.issueConcurrency) || 2));
let pollTimer: number | null = null; // background PR/MR poll that drives unattended draining while agents run
// runStatus key. p/r default to the ACTIVE repo (single-repo mode); in "All repos" scope each issue passes its own.
const rk = (n: number, p: ProviderId = provider, r: string = repo || '') => `${p}:${r}#${n}`;
// A merged issue carries its own provider/repo in All-repos scope; fall back to the active repo otherwise.
const issP = (i: Issue): ProviderId => ((i.provider as ProviderId) || provider);
const issR = (i: Issue): string => (i.repo || repo || '');
// A per-row identity that's unique even in All-repos scope (numbers collide across repos) — used to look a row's issue back up.
const keyOf = (i: Issue): string => `${issP(i)}:${issR(i)}#${i.number}`;

/* ----------------------------- local tags (private, relay.json) ----------------------------- */
// GitHub tags keep their legacy bare "owner/name#n" key so existing tags survive; other providers namespace.
const tagKey = (n: number, p: ProviderId = provider, r: string = repo || '') => (p === 'github' ? `${r}#${n}` : `${p}:${r}#${n}`);
function tagsMap(): Record<string, string[]> { return (state.settings.issueTags ||= {}); }
const getTags = (n: number, p: ProviderId = provider, r: string = repo || ''): string[] => tagsMap()[tagKey(n, p, r)] || [];
function allTags(): string[] { const s = new Set<string>(); for (const i of issues) for (const t of getTags(i.number, issP(i), issR(i))) s.add(t); return [...s].sort(); }
// Distinct provider labels across the pulled issues (first color wins), for the label-filter chips.
function allLabels(): { name: string; color?: string }[] {
  const m = new Map<string, string | undefined>();
  for (const i of issues) for (const l of i.labels) if (!m.has(l.name)) m.set(l.name, l.color);
  return [...m].map(([name, color]) => ({ name, color })).sort((a, b) => a.name.localeCompare(b.name));
}
const mineCount = (): number => (myLogin ? issues.filter((i) => (i.assignees || []).includes(myLogin)).length : 0);
// Author-filter options = the repo's members ∪ the authors already loaded (so external / not-yet-member authors
// still show). Sorted case-insensitively. Powers the "filter by author" icon → multi-select checklist.
function authorOptions(): string[] {
  const set = new Set<string>(members);
  for (const i of issues) if (i.author) set.add(i.author);
  return [...set].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
// The active repo's members (collaborators) — fetched ONCE per repo (keyed by mkey), so author/state toggles
// don't re-request it; a repo switch (mkey changes) supersedes an in-flight fetch. Unioned with loaded authors.
async function loadMembers(mkey: string, p: ProviderId, r: string, ws: string): Promise<void> {
  const res = await relay.providerRepoMembers(ws, p, r).catch(() => ({ ok: false } as { ok: boolean; members?: string[] }));
  if (membersFor === mkey) members = res.ok && res.members ? res.members : [];
}
// Existing worktrees for this repo (branch → path) so a row whose worktree survived a closed tab / crash gets a
// ⧉ reopen-terminal icon. Fetched once per repo; a repo switch supersedes an in-flight fetch. Re-renders on arrival.
async function loadWorktrees(mkey: string, p: ProviderId, r: string, dir: string): Promise<void> {
  const res = await relay.worktreesList(p, r, dir).catch(() => ({ ok: false } as { ok: boolean; list?: { branch: string; path: string }[] }));
  if (wtFor !== mkey) return;                   // repo switched → stale
  const m = new Map<string, string>();
  if (res.ok && res.list) for (const w of res.list) m.set(w.branch, w.path);
  wtByBranch = m; render();
}
// A toggle re-queries the provider server-side, debounced so ticking several authors fires ONE fetch. render()
// first, for an instant badge + a client-filtered preview of the already-loaded issues while the fetch runs.
function onAuthorsChanged(): void {
  render();
  if (issScope === 'all') return;   // All-repos filters client-side over the merged set — no server re-query
  if (authorReloadT) clearTimeout(authorReloadT);
  authorReloadT = window.setTimeout(() => { authorReloadT = null; void loadIssues(); }, 300);
}
// Per-owner totals over the CURRENTLY LOADED issues: how many each creator filed, and how many are fixed —
// where "fixed" = the agent opened a PR/MR for it (status 'review') or the issue is closed/merged (closed view).
// Independent of the active filter chips (it summarizes everything pulled, not just what's visible).
function ownerSummary(): { login: string; created: number; fixed: number }[] {
  const closedView = issueState === 'closed';                       // in the closed view every loaded issue is resolved
  const m = new Map<string, { created: number; fixed: number }>();
  for (const i of issues) {
    const who = i.author || '(unknown)';
    const row = m.get(who) || { created: 0, fixed: 0 };
    row.created++;
    if (closedView || statusOf(i.number, issP(i), issR(i)) === 'review') row.fixed++;
    m.set(who, row);
  }
  return [...m].map(([login, v]) => ({ login, created: v.created, fixed: v.fixed }))
    .sort((a, b) => b.created - a.created || b.fixed - a.fixed || a.login.localeCompare(b.login));
}
async function persist(): Promise<void> { try { state.settings = await relay.patchSettings({ issueTags: tagsMap() }); } catch { /* keep the in-memory tags; a failed write must never clobber */ } }
async function addTag(n: number, raw: string, p: ProviderId = provider, r: string = repo || ''): Promise<void> {
  const t = raw.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').slice(0, 24);
  if (!t) { render(); return; }
  const key = tagKey(n, p, r); const m = tagsMap(); const arr = m[key] || [];
  if (!arr.includes(t)) m[key] = [...arr, t];
  await persist(); render();
}
async function removeTag(n: number, t: string, p: ProviderId = provider, r: string = repo || ''): Promise<void> {
  const key = tagKey(n, p, r); const m = tagsMap(); m[key] = (m[key] || []).filter((x) => x !== t);
  if (!m[key].length) delete m[key];
  activeFilters.delete(t);
  await persist(); render();
}

const hexColor = (c?: string) => (c && /^[0-9a-fA-F]{6}$/.test(c) ? '#' + c : '');
function labelHtml(l: { name: string; color?: string }): string {
  const c = hexColor(l.color);
  return `<span class="isr-lab"${c ? ` style="border-color:${c}88;color:${c}"` : ''}>${esc(l.name)}</span>`;
}
// A PR/MR on the issue-N branch means the run reached review; else the in-session run state; else idle.
const statusOf = (n: number, p: ProviderId = provider, r: string = repo || ''): RunStatus => (prByBranch[`issue-${n}`] ? 'review' : runStatus.get(rk(n, p, r)) || 'idle');
// Tooltip for a clickable status chip (idle/review chips aren't clickable → no tip).
const chipTitle = (st: RunStatus): string =>
  st === 'queued' ? 'Click to remove from the queue'
  : st === 'validating' ? 'Validating the issue — click to stop & free the slot'
  : st === 'fixing' || st === 'working' ? 'Click to free this slot (mark the run done)'
  : st === 'invalid' ? 'Not valid — click for the reason (and to run Fix anyway)' : '';

// Apply the search query + tag/label filters (AND) + "assigned to me" + "created by" (OR) to the issues.
function visibleIssues(): Issue[] {
  const q = query.trim().toLowerCase();
  return issues.filter((i) => {
    const tags = getTags(i.number, issP(i), issR(i));   // each issue's own repo (All-repos scope)
    for (const f of activeFilters) if (!tags.includes(f)) return false;                 // every active tag-chip must match
    for (const l of activeLabels) if (!i.labels.some((x) => x.name === l)) return false; // every active label-chip must match
    if (mineOnly && !(i.assignees || []).includes(myLogin)) return false;               // assigned-to-me toggle
    if (activeAuthors.size && !(i.author && activeAuthors.has(i.author))) return false; // created-by (OR — one author per issue)
    if (!q) return true;
    if (q.startsWith('#')) return tags.some((t) => t.includes(q.slice(1)));
    if (q.startsWith('@')) return !!i.author && i.author.toLowerCase().includes(q.slice(1)); // "@login" → search by author
    return `#${i.number} ${i.title}`.toLowerCase().includes(q)
      || (i.author ? i.author.toLowerCase().includes(q) : false)
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
  // "assigned to me" first, then provider labels, then local #tags. (Author filtering lives in the ✍ header icon.)
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
  const allMode = issScope === 'all';
  const qN = queue.filter((q) => q.provider === provider && q.repo === repo).length; // queued-for-this-repo count
  const count = allMode ? `All tracked · ${issues.length} ${issueState}`
    : (phase === 'ready' ? `${repo} · ${issues.length}${issuesHasMore ? '+' : ''} ${issueState}${qN ? ` · ${qN} queued` : ''}` : repo);
  const repoEl = $('#issSideRepo'); if (repoEl) repoEl.textContent = ((allMode || repo) ? count : 'Select repo') + ' ▾';
  // Scope toggle (This repo / All repos) always reflects state.
  const scopeEl = $('#issScope'); if (scopeEl) scopeEl.querySelectorAll<HTMLElement>('.iss-seg').forEach((b) => b.classList.toggle('on', b.dataset.sc === issScope));
  // Open/Closed state toggle — visible whenever issues are being shown (any repo, or all); reflects the active state.
  const stateEl = $('#issState'); if (stateEl) {
    const showState = (allMode || !!repo) && (phase === 'ready' || phase === 'loading' || phase === 'error');
    (stateEl as HTMLElement).style.display = showState ? '' : 'none';
    stateEl.querySelectorAll<HTMLElement>('.iss-seg').forEach((b) => b.classList.toggle('on', b.dataset.st === issueState));
  }
  const searchEl = $('#issSearch'); if (searchEl) (searchEl as HTMLElement).style.display = (phase === 'ready' && issues.length > 0) ? '' : 'none';
  const authorEl = $('#issAuthor'); // author-filter icon — shown once issues load; badge = # of selected authors
  if (authorEl) {
    // Keep it visible while a filter is active (even mid-reload, or when the filter returns 0) so it's always clearable.
    (authorEl as HTMLElement).style.display = ((phase === 'ready' && issues.length > 0) || activeAuthors.size > 0) ? '' : 'none';
    authorEl.classList.toggle('on', activeAuthors.size > 0);
    authorEl.setAttribute('data-n', activeAuthors.size ? String(activeAuthors.size) : '');
    authorEl.setAttribute('title', activeAuthors.size ? `Filtering by ${activeAuthors.size} author${activeAuthors.size > 1 ? 's' : ''}` : 'Filter by author');
  }
  renderFilters();
  const el = $('#issSideList'); if (!el) return;
  const pc = PROVS[provider];
  const hint = (icon: string, msg: string, sub = '') =>
    `<div class="isr-empty"><div class="isr-ei">${icon}</div><div>${msg}</div>${sub ? `<div class="isr-es">${sub}</div>` : ''}</div>`;

  if (phase === 'loading') { el.innerHTML = `<div class="isr-empty"><div class="isr-spin"></div><div>Pulling issues…</div></div>`; return; }
  if (phase === 'idle')    { el.innerHTML = hint('🎫', 'No issues pulled', 'Hit ⟳ to pull this repo’s issues.'); return; }
  if (phase === 'noauth')  {
    el.innerHTML = `<div class="isr-empty"><div class="isr-ei">🔗</div><div>Not connected to ${esc(pc.name)}</div><div class="isr-es">Authorize Slayer T to pull your issues.</div><button class="isr-connect" id="issConnect">Connect ${esc(pc.name)}</button></div>`;
    const b = document.getElementById('issConnect'); if (b) b.onclick = () => void connectProvider(provider);
    return;
  }
  if (phase === 'norepo')  { el.innerHTML = hint('🗂️', 'No repo selected', esc(errMsg) || 'Pick a repo in Sources (⚙), or open a folder with a GitHub / GitLab / Bitbucket remote.'); return; }
  if (phase === 'error')   { el.innerHTML = hint('⚠️', 'Couldn’t pull issues', esc(errMsg)); return; }
  if (!issues.length)      { el.innerHTML = activeAuthors.size
      ? hint('✍', `No ${issueState} issues by the selected author${activeAuthors.size > 1 ? 's' : ''}`, 'Clear the author filter (✍) to see all.')
      : hint('✓', `No ${issueState} issues`, repo ? esc(repo) : ''); return; }

  const vis = visibleIssues();
  if (!vis.length) { el.innerHTML = hint('🔍', 'No matching issues', 'Clear the search or a filter.'); return; }

  const byKey = new Map<string, Issue>(); for (const i of vis) byKey.set(keyOf(i), i);   // row identity survives cross-repo number collisions
  el.innerHTML = vis.map((i) => {
    const dp = issP(i), dr = issR(i); const key = keyOf(i);
    const st = statusOf(i.number, dp, dr); const tags = getTags(i.number, dp, dr);
    const wt = wtByBranch.get(`issue-${i.number}`);
    // Only an idle issue in the OPEN view is assignable; closed / in-progress rows open the details view.
    return `<div class="isr" data-key="${esc(key)}" title="${st === 'idle' && issueState === 'open' ? `Assign #${i.number} to a coding agent` : `View #${i.number} details`}">
      <div class="isr-hash">#${i.number}</div>
      <div class="isr-body">
        <div class="isr-title">${esc(i.title)}</div>
        ${dr ? `<div class="isr-repo" title="${esc(dr)}">${esc(dr)}</div>` : ''}
        <div class="isr-labs">
          ${i.labels.map(labelHtml).join('')}
          ${tags.map((t) => `<span class="isr-tag" data-key="${esc(key)}" data-tag="${esc(t)}" title="Remove #${esc(t)}">#${esc(t)}<span class="x">×</span></span>`).join('')}
          <button class="isr-tagadd" data-key="${esc(key)}" title="Add a private local tag">+</button>
        </div>
      </div>
      <div class="isr-side">
        <span class="isr-st ${st}" data-key="${esc(key)}" title="${chipTitle(st)}">${st}</span>
        ${prByBranch[`issue-${i.number}`] ? `<button class="isr-pr" data-url="${esc(prByBranch[`issue-${i.number}`].url)}" title="Open pull request">PR ↗</button>` : ''}
        ${wt ? `<button class="isr-term" data-wt="${esc(wt)}" data-num="${i.number}" title="Open a terminal in this issue's worktree">⧉</button>` : ''}
        <button class="isr-info" data-key="${esc(key)}" title="View issue details">ⓘ</button>
        <button class="isr-ext" data-url="${esc(i.url)}" title="Open #${i.number} ↗">↗</button>
      </div>
    </div>`;
  }).join('') + (loadingMore
    ? `<div class="isr-more"><span class="isr-mspin"></span>Loading more…</div>`
    : issuesHasMore ? `<div class="isr-more">Scroll to load more…</div>`
    : allMode ? `<div class="isr-more">first ${issueState} issues per tracked repo</div>` : '');

  // Row click: an IDLE issue → Assign; an ongoing one (queued/working/review) → view details (re-assigning
  // an in-progress issue isn't the intent). Each handler resolves the row's OWN issue (its own repo in All scope).
  el.querySelectorAll<HTMLElement>('.isr').forEach((r) => {
    r.onclick = () => { const iss = byKey.get(r.dataset.key!); if (!iss) return; if (statusOf(iss.number, issP(iss), issR(iss)) === 'idle' && issueState === 'open') void openAssign(iss); else openDetails(iss); };
  });
  el.querySelectorAll<HTMLElement>('.isr-info').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const iss = byKey.get(b.dataset.key!); if (iss) openDetails(iss); };
  });
  el.querySelectorAll<HTMLElement>('.isr-ext, .isr-pr').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const u = b.dataset.url; if (u) relay.openExternal(u); };
  });
  // ⧉ Reopen a terminal in the issue's existing worktree (after its tab was closed / the app crashed).
  el.querySelectorAll<HTMLElement>('.isr-term').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const wt = b.dataset.wt, n = b.dataset.num; if (wt) { deps.openAgentTab({ cwd: wt, name: `#${n} terminal` }); toast(`Opened a terminal in #${n}'s worktree`, true); } };
  });
  // Status chip: queued → cancel; a live stage (working/validating/fixing) → free the slot (so a run that
  // never opens a PR can't wedge the queue); invalid → open Details (to read the reason + override).
  el.querySelectorAll<HTMLElement>('.isr-st.queued, .isr-st.working, .isr-st.validating, .isr-st.fixing').forEach((c) => {
    c.onclick = (e) => { e.stopPropagation(); const iss = byKey.get(c.dataset.key!); if (!iss) return; c.classList.contains('queued') ? cancelQueued(iss.number, issP(iss), issR(iss)) : freeSlot(iss.number, issP(iss), issR(iss)); };
  });
  el.querySelectorAll<HTMLElement>('.isr-st.invalid').forEach((c) => {
    c.onclick = (e) => { e.stopPropagation(); const iss = byKey.get(c.dataset.key!); if (iss) openDetails(iss); };
  });
  el.querySelectorAll<HTMLElement>('.isr-tag').forEach((c) => {
    c.onclick = (e) => { e.stopPropagation(); const iss = byKey.get(c.dataset.key!); if (iss) void removeTag(iss.number, c.dataset.tag!, issP(iss), issR(iss)); };
  });
  el.querySelectorAll<HTMLElement>('.isr-tagadd').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const iss = byKey.get(b.dataset.key!); if (!iss) return;
      const inp = document.createElement('input');
      inp.className = 'isr-taginput'; inp.placeholder = 'tag'; inp.spellcheck = false; inp.maxLength = 24;
      b.replaceWith(inp); inp.focus();
      inp.onclick = (ev) => ev.stopPropagation();
      inp.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); void addTag(iss.number, inp.value, issP(iss), issR(iss)); } else if (ev.key === 'Escape') { render(); } };
      inp.onblur = () => { if (inp.value.trim()) void addTag(iss.number, inp.value, issP(iss), issR(iss)); else render(); };
    };
  });
}

// One-shot: before per-workspace scoping, provider secrets were global. Move them (+ the old global Bitbucket
// workspaces list) into the currently-active workspace once, so an existing connection isn't orphaned; other
// workspaces start empty. Guarded by a settings flag so it runs exactly once, for the first workspace to load.
async function maybeMigrateProviders(ws: string): Promise<void> {
  if (state.settings.providersScopedMigrated) return;              // one-shot; flag is set only AFTER a clean run
  // keys.json writes are serialized + atomic, so this single migration completes without the lost-update race
  // that partially broke an earlier attempt; if the app is killed mid-migration the flag stays unset and it re-runs.
  await relay.providerMigrateGlobal(ws).catch(() => {});           // tokens + OAuth-app creds: global → this workspace
  const patch: Record<string, unknown> = { providersScopedMigrated: true };
  const legacyBb = (state.settings as unknown as { bitbucketWorkspaces?: string[] }).bitbucketWorkspaces;
  if (Array.isArray(legacyBb) && legacyBb.length) {
    const byWs = { ...(state.settings.bitbucketWorkspacesByWs || {}) };
    if (!byWs[ws]) byWs[ws] = legacyBb;                            // carry the old global list into this workspace
    patch.bitbucketWorkspacesByWs = byWs;
  }
  try { state.settings = await relay.patchSettings(patch); } catch { /* not fatal — retried next boot */ }
}

/* ----------------------------- pull ----------------------------- */
// Resolve the active provider+repo (an explicit Sources pick, else inferred from the open folder's remote)
// → check auth → pull its open issues. Each failure lands on a specific, actionable state.
// "All repos": one request per tracked repo, tag each issue with its repo/provider, merge. Bounded to the first
// page per repo (no cross-repo infinite scroll). Per-repo concepts (members, worktrees, review chips, assigned-
// to-me) don't apply, so they're cleared. Errors surface only if nothing came back.
async function loadAllRepos(seq: number, ws: string): Promise<void> {
  const tracked = (state.settings.issueReposByWs || {})[ws] || [];
  if (!tracked.length) { phase = 'norepo'; errMsg = 'No repos tracked yet — add some in Sources (⚙).'; render(); return; }
  members = []; membersFor = ''; wtByBranch = new Map(); wtFor = ''; prByBranch = {}; myLogin = '';
  let anyErr = '';
  const perRepo = await Promise.all(tracked.map(async (id) => {
    const { provider: p, repo: r } = parseRepoId(id);
    const res: { ok: boolean; issues?: Issue[]; error?: string } = await relay.providerIssues(ws, p, r, issueState, 1).catch(() => ({ ok: false, error: 'request failed' }));
    if (!res.ok) { anyErr = res.error || anyErr; return [] as Issue[]; }
    return (res.issues || []).map((iss: Issue) => ({ ...iss, provider: p, repo: r }));   // each issue carries its own repo
  }));
  if (seq !== loadSeq) return;                                     // a newer load superseded this fan-out
  issues = perRepo.flat();
  issuesPage = 1; issuesHasMore = false; loadingMore = false;      // cross-repo view isn't paged
  if (!issues.length && anyErr) { phase = 'error'; errMsg = anyErr; render(); return; }
  phase = 'ready'; render(); ensurePolling();
}

export async function loadIssues(): Promise<void> {
  const seq = ++loadSeq;                            // a newer pull supersedes this one at each await point
  const ws = wsKey();                               // provider connections are per Slayer T workspace
  await maybeMigrateProviders(ws); if (seq !== loadSeq) return;    // one-time global→workspace secret migration
  if (issScope === 'all') { loadedFor = activeKey(); phase = 'loading'; render(); await loadAllRepos(seq, ws); return; }
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
  const auth = await relay.providerAuthState(ws, provider); if (seq !== loadSeq) return;
  if (!auth.connected) { phase = 'noauth'; render(); return; }
  myLogin = (auth.login as string) || '';           // for the "assigned to me" filter
  if (!repo) { phase = 'norepo'; errMsg = dir ? 'This folder’s git remote isn’t on a supported provider.' : 'No project folder is open.'; render(); return; }
  // Repo/provider switched → drop filters/search that belong to the previous one (they'd otherwise hide
  // every issue with no visible chip to clear). Run-status is provider+repo-keyed, no clearing needed.
  const mkey = `${provider}:${repo}`;
  const curKey = `${mkey}:${issueState}`;
  // The author filter is applied SERVER-SIDE, so it must survive an Open↔Closed toggle (show me alice's CLOSED
  // issues) — clear it only on a genuine repo/provider switch, unlike the label/tag/search chips.
  if (mkey !== lastRepoKey) { lastRepoKey = mkey; activeAuthors.clear(); }
  if (curKey !== lastKey) { lastKey = curKey; activeFilters.clear(); activeLabels.clear(); mineOnly = false; query = ''; const sEl = $('#issSearch') as HTMLInputElement | null; if (sEl) sEl.value = ''; }
  issuesPage = 1; issuesHasMore = false; loadingMore = false;      // reset infinite-scroll paging for the new pull
  if (membersFor !== mkey) { membersFor = mkey; members = []; void loadMembers(mkey, provider, repo, ws); } // members: once per repo, not per state/author reload
  if (wtFor !== mkey) { wtFor = mkey; wtByBranch = new Map(); void loadWorktrees(mkey, provider, repo, dir); } // existing worktrees (reopen-terminal), once per repo
  // Server-side author filter: when authors are picked, the provider returns only their issues (a bounded set,
  // no infinite scroll) — finding matches beyond the loaded pages, not just filtering what's already here.
  const authors = activeAuthors.size ? [...activeAuthors] : undefined;
  const r = await relay.providerIssues(ws, provider, repo, issueState, 1, authors); if (seq !== loadSeq) return;
  if (!r.ok) { phase = 'error'; errMsg = r.error || 'Could not pull issues'; render(); return; }
  issues = r.issues || []; issuesHasMore = !!r.hasMore; phase = 'ready'; prByBranch = {}; render(); ensurePolling();
  maybeAutoFill();                                                  // first page short/empty (client-side filter) → keep paging
  // review → ship: light up issues whose issue-N branch already has an open PR/MR (best-effort, non-blocking).
  const forProvider = provider, forRepo = repo;
  relay.providerPrs(ws, forProvider, forRepo).then((pr: { ok: boolean; prs?: { branch: string; url: string; draft: boolean }[] }) => {
    if (seq !== loadSeq || !pr.ok || !pr.prs) return;
    applyPrs(pr.prs); // a pre-existing PR/MR may free a slot for a queued issue
  }).catch(() => { /* PRs/MRs are a nice-to-have; the list still renders without them */ });
}

// Re-render the list but keep the scroll position (innerHTML replacement otherwise jumps to the top). Used
// when appending pages so the viewport stays put as rows are added below.
function renderKeepScroll(): void {
  const el = $('#issSideList'); const top = el ? el.scrollTop : 0;
  render();
  const el2 = $('#issSideList'); if (el2) el2.scrollTop = top;
}
// If the list doesn't fill its scroll container yet (a page that filtered down to few/zero rows, or a tall
// window), keep paging — otherwise no scroll event can fire to reach the rest and it stalls. Bounded by
// hasMore going false. Reading scrollHeight forces layout, so it reflects the just-rendered content.
function maybeAutoFill(): void {
  if (!issuesHasMore || loadingMore || phase !== 'ready') return;
  // Never let an active filter/search drive paging — a filter that hides everything would otherwise page the
  // whole repo hunting for matches. Auto-fill is only for a genuinely short *unfiltered* fetch; when filtering,
  // the user pages by scrolling the (matched) list instead.
  if (query || activeFilters.size || activeLabels.size || activeAuthors.size || mineOnly) return;
  const el = $('#issSideList');
  if (el && el.scrollHeight <= el.clientHeight + 240) void loadMoreIssues();
}

// Infinite scroll: fetch the next provider page and APPEND it (deduped). Guarded so rapid scroll events and a
// concurrent fresh pull can't double-load or append onto a stale list.
async function loadMoreIssues(): Promise<void> {
  if (loadingMore || !issuesHasMore || phase !== 'ready' || !repo) return;
  const seq = loadSeq, ws = wsKey(), fp = provider, fr = repo, fs = issueState, nextPage = issuesPage + 1;
  loadingMore = true; renderKeepScroll();                          // show the "loading more…" footer
  const r = await relay.providerIssues(ws, fp, fr, fs, nextPage).catch(() => ({ ok: false } as { ok: boolean; issues?: Issue[]; hasMore?: boolean }));
  loadingMore = false;
  if (seq !== loadSeq) return;                                     // a fresh pull replaced the list → drop this page
  if (!r.ok || !r.issues) { issuesHasMore = false; renderKeepScroll(); return; }
  const seen = new Set(issues.map((i) => i.number));
  const fresh = (r.issues as Issue[]).filter((i: Issue) => !seen.has(i.number)); // dedupe against what's already loaded
  issues.push(...fresh);
  issuesPage = nextPage; issuesHasMore = !!r.hasMore;
  renderKeepScroll(); ensurePolling();
  maybeAutoFill();                                                 // page filtered to few/zero → keep going so it can't stall
}

/* ----------------------------- assign queue engine (auto-drain) ----------------------------- */
// Slots held for the CURRENT repo — derived from the run map (the single source of truth for a held slot),
// NOT the displayed `issues` list, so an Open↔Closed toggle or a repo switch can't miscount runs whose
// issue isn't currently pulled (which would over-launch past CAP or tear down the PR poll). A running stage
// (validating/fixing) holds a slot; reaching review (applyPrs) or invalid frees it.
const rkPrefix = (): string => `${provider}:${repo || ''}#`;
const workingCount = (): number => {
  let c = 0; const pre = rkPrefix();
  for (const [k, s] of runStatus) if (k.startsWith(pre) && OCCUPYING.includes(s)) c++;
  return c;
};
// Apply a fresh PR/MR map: light up review chips, and free the slot of any occupying run whose branch now
// has a PR (it reached review) — keep the run record so Details still shows its finished graph. Then drain.
function applyPrs(prs: { branch: string; url: string; draft: boolean }[]): void {
  const map: Record<string, { url: string; draft: boolean }> = {};
  for (const p of prs) map[p.branch] = { url: p.url, draft: p.draft };
  prByBranch = map;
  const pre = rkPrefix();
  for (const [k, s] of [...runStatus]) { // a reviewed run's stale validating/fixing entry must not keep holding a slot
    if (k.startsWith(pre) && OCCUPYING.includes(s) && map[`issue-${k.slice(k.lastIndexOf('#') + 1)}`]) runStatus.delete(k);
  }
  drainQueue(); render();
}

// A queued item is a fully-prepared pipeline run — launch it from stage 0 (the worktree already exists).
function launchQueued(item: QueueItem, auto: boolean): void {
  startPipeline({ provider: item.provider, repo: item.repo, issue: item.issue, pipeline: item.pipeline, wt: item.cwd, agentId: item.agentId, brief0Rel: item.brief0Rel });
  toast(`${auto ? 'Auto-launching' : 'Launching'} ${item.agentName} on #${item.number}`, true);
}

// Fill every free slot from the queue (FIFO, current repo). Safe to call often; it no-ops when full/empty.
function drainQueue(): void {
  let launched = false;
  // workingCount()/CAP() is a GLOBAL concurrency cap; launch the next queued item regardless of repo (it runs in
  // its OWN worktree). Draining any item — not just the active repo's — is what makes All-repos assignment work.
  while (workingCount() < CAP() && queue.length) {
    launchQueued(queue.shift()!, true);
    launched = true;
  }
  if (launched) render();
  ensurePolling();
}

// Background PR/MR poll — the engine that lets the queue drain while you're away. Runs only while there's
// something to drive (a queued item or a working agent for this repo), and stops itself otherwise.
async function pollPrs(): Promise<void> {
  if (issScope === 'all') return;   // All-repos has no single active repo; PR detection (prByBranch) is per-repo, so skip it (review chips/PR buttons are single-repo only)
  const forProvider = provider, forRepo = repo, ws = wsKey();
  if (!forRepo) { ensurePolling(); return; }
  const pr = await relay.providerPrs(ws, forProvider, forRepo).catch(() => null);
  if (!pr || !pr.ok || !pr.prs || forProvider !== provider || forRepo !== repo) return; // switched mid-flight → drop
  applyPrs(pr.prs); // a newly-opened PR/MR may free a slot; also refreshes review chips / PR buttons
}
function ensurePolling(): void {
  const active = queue.some((q) => q.provider === provider && q.repo === repo) || workingCount() > 0;
  if (active && pollTimer == null) pollTimer = window.setInterval(() => void pollPrs(), 30000);
  else if (!active && pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
}

// Manual escape hatches for the queue's one failure mode: a run that ends WITHOUT a PR/MR (e.g. an agent
// that never wrote its verdict) never frees its slot on its own. Clicking the status chip resolves it.
function cancelQueued(n: number, p: ProviderId = provider, r: string = repo || ''): void {
  const i = queue.findIndex((q) => q.provider === p && q.repo === r && q.number === n);
  if (i >= 0) queue.splice(i, 1);
  runStatus.delete(rk(n, p, r)); runs.delete(rk(n, p, r));
  toast(`Removed #${n} from the queue`); render(); ensurePolling(); ensureStagePoll();
}
function freeSlot(n: number, p: ProviderId = provider, r: string = repo || ''): void {
  runStatus.delete(rk(n, p, r)); runs.delete(rk(n, p, r)); // treat the run as done → its slot frees and the queue advances
  toast(`Freed the slot held by #${n}`);
  drainQueue(); render(); ensureStagePoll();
}

/* ----------------------------- pipeline runner (staged, gated by verdict files) ----------------------------- */
// A key that's stable across a repo switch — a run outlives the view it was started from.
const runKey = (prov: ProviderId, rpo: string, n: number) => `${prov}:${rpo}#${n}`;

// Launch stage `idx` of a run: write its brief (stage 0's is already on disk from worktree-add), clear its
// stale verdict, open the agent in the worktree tab, and — if it's a GATE — start watching for its verdict.
async function launchStage(key: string, idx: number): Promise<void> {
  const run = runs.get(key); if (!run) return;
  const stage = run.pipeline.stages[idx]; if (!stage) return;
  // Any stage with outgoing edges signals completion by writing its verdict → we poll for it (a conditional
  // gate AND an `always`-only step both advance this way). No edges → terminal (Fix), completion = its PR.
  run.stageIdx = idx; run.awaiting = !!stage.edges?.length; run.reason = undefined;
  runStatus.set(key, stageStatus(stage.kind)); // set synchronously so workingCount() is correct before the async prep
  const briefRel = idx === 0 ? run.brief0Rel : `.slayer/stage-${idx}.md`;
  // A referenced DB credential template → injected into this stage's env (every stage is its own shell) and its
  // note appended to LATER-stage briefs too (stage 0 already carries the note from the Assign dialog's textarea).
  const dbCredId = issueDbCredFor(run.provider, run.repo, run.number);
  // Write the brief for later stages (stage 0's is already there) + clear this stage's stale verdict so a
  // reused worktree can't read a previous run's pass/fail. Then launch the agent on the brief FILE.
  // The .deps/ + DB-creds notes are appended to LATER stages too — the reference repos and env vars persist
  // in the worktree across every stage, so Fix/Test/Review must be told about them (stage 0's file already has
  // both, from the Assign dialog's textarea). issueDepsFor filters to nothing → depsNote returns '' (no-op).
  const brief = renderBrief(stage.brief, briefCtx(run.issue, run.provider, idx))
    + prNotes(stage, run.pipeline, run.provider)   // Fix → pipeline in the PR body; Review → verdict as a PR comment
    + depsNote(issueDepsFor(run.provider, run.repo, run.number))
    + dbCredNote(dbCredId);
  await relay.pipelinePrep(run.wt, idx === 0 ? null : briefRel, idx === 0 ? null : brief, idx).catch(() => {});
  const agent = AGENTS.find((a) => a.id === run.agentId);
  deps.openAgentTab({ cwd: run.wt, name: `#${run.number} · ${stage.name.toLowerCase()}`, runCmd: agent ? agent.launch(briefRel) : undefined, dbCredId: dbCredId || undefined });
  render(); ensurePolling(); ensureStagePoll();
}

// Record a run and kick it off from stage 0. Called from a fresh Assign and from the auto-drain queue.
function startPipeline(o: { provider: ProviderId; repo: string; issue: Issue; pipeline: PipelineDef; wt: string; agentId: string; brief0Rel: string }): void {
  const key = runKey(o.provider, o.repo, o.issue.number);
  runs.set(key, { provider: o.provider, repo: o.repo, number: o.issue.number, title: o.issue.title, issue: o.issue, pipeline: o.pipeline, stageIdx: 0, wt: o.wt, agentId: o.agentId, brief0Rel: o.brief0Rel, awaiting: false });
  runStatus.set(key, stageStatus(o.pipeline.stages[0].kind)); // synchronous, so a drain loop can't over-launch past CAP
  void launchStage(key, 0);
}

// Launch a prepared run now, or queue it if at capacity (its worktree + stage-0 brief already exist, so a
// queued run auto-launches the instant a slot frees). Shared by Assign and the mapping board.
function launchOrQueue(o: { provider: ProviderId; repo: string; issue: Issue; pipeline: PipelineDef; wt: string; agentId: string; agentName: string; brief0Rel: string }): 'queued' | 'launched' {
  if (workingCount() >= CAP()) {
    if (!queue.some((q) => q.provider === o.provider && q.repo === o.repo && q.number === o.issue.number)) // don't double-queue
      queue.push({ provider: o.provider, repo: o.repo, number: o.issue.number, title: o.issue.title, cwd: o.wt, agentId: o.agentId, agentName: o.agentName, issue: o.issue, pipeline: o.pipeline, brief0Rel: o.brief0Rel });
    runStatus.set(runKey(o.provider, o.repo, o.issue.number), 'queued'); ensurePolling();
    return 'queued';
  }
  startPipeline(o);
  return 'launched';
}

// Fast verdict poll — the engine that advances GATE stages. Runs only while some run awaits a verdict.
let stageTimer: number | null = null;
function ensureStagePoll(): void {
  const active = [...runs.values()].some((r) => r.awaiting);
  if (active && stageTimer == null) stageTimer = window.setInterval(() => void pollStages(), 4000);
  else if (!active && stageTimer != null) { clearInterval(stageTimer); stageTimer = null; }
}
let pollingStages = false; // re-entrancy guard: the 4s interval must not start a second pass while one awaits
async function pollStages(): Promise<void> {
  if (pollingStages) return;
  pollingStages = true;
  try {
    for (const [key, run] of [...runs.entries()].filter(([, r]) => r.awaiting)) {
      const v = await relay.pipelineVerdict(run.wt, run.stageIdx).catch(() => null);
      if (!runs.has(key) || !run.awaiting) continue;  // resolved/cleared while we awaited
      if (!v || !v.found) continue;                    // verdict not written yet — keep polling
      run.awaiting = false;
      // Follow the matching conditional edge out of this gate stage.
      const edge = nextEdge(run.pipeline.stages[run.stageIdx], !!v.passed);
      const target = edge && edge.to !== STOP ? stageIndexById(run.pipeline, edge.to) : -1;
      if (edge && edge.to !== STOP && target >= 0) {
        // A stage target → run it.
        toast(`#${run.number} ${v.passed ? 'validated ✓' : 'gate: ' + edge.when} — starting ${run.pipeline.stages[target].name}`, true);
        await launchStage(key, target);
      } else if (edge && edge.to === STOP && edge.when !== 'invalid') {
        // A `valid`/`always` edge wired to Stop = an intentional clean end (e.g. a validate-only pipeline),
        // NOT a failure. End the run without an `invalid` verdict.
        runStatus.delete(key); runs.delete(key);
        toast(`#${run.number} — ${run.pipeline.stages[run.stageIdx].name} passed; pipeline complete`, true);
        drainQueue(); render();
      } else if (edge && edge.to === STOP) {
        // The invalid off-ramp: stop & report. No fix, no PR. Keep the run for an override.
        run.reason = v.summary || 'The agent judged this issue not valid.';
        runStatus.set(key, 'invalid');
        toast(`#${run.number} — not valid; pipeline stopped`);
        drainQueue(); render();
      } else if (v.passed) {
        // Passed but no outgoing edge (or a dangling target) → the line ends cleanly here.
        runStatus.delete(key); runs.delete(key); drainQueue(); render();
      } else {
        // Failed with no matching edge → report it (same as the STOP off-ramp).
        run.reason = v.summary || 'The agent judged this issue not valid.';
        runStatus.set(key, 'invalid'); drainQueue(); render();
      }
    }
  } finally { pollingStages = false; ensureStagePoll(); }
}

// Override an `invalid` verdict: run the stage the gate WOULD have gone to on a valid verdict, on the same
// worktree (i.e. take the `when:'valid'` edge anyway).
function overrideInvalid(key: string): void {
  const run = runs.get(key); if (!run) return;
  const edge = nextEdge(run.pipeline.stages[run.stageIdx], true); // pretend the verdict was valid
  const target = edge && edge.to !== STOP ? stageIndexById(run.pipeline, edge.to) : -1;
  if (target < 0) { toast('Nothing to run after this stage'); return; }
  toast(`#${run.number} — running ${run.pipeline.stages[target].name} anyway`, true);
  void launchStage(key, target);
}

/* ----------------------------- assign → agent ----------------------------- */
// A self-contained modal (own scrim; closes via its button or Escape — NOT a backdrop click), reusing the app's dialog styles.
function modal(html: string, onClose?: () => void): { root: HTMLElement; close: () => void } {
  const root = document.createElement('div'); root.className = 'tpl-modal';
  root.innerHTML = `<div class="tpl-sc"></div>${html}`;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); onClose?.(); }; // onClose fires on ANY close (Escape or the button)
  document.body.appendChild(root);
  document.addEventListener('keydown', onKey);
  // Overlay/scrim click does NOT close the dialog — close via its own button or Escape (the scrim is a static backdrop).
  return { root, close };
}

// The token context a brief template is rendered against. `{issue}` = the issue head (# + title + body);
// `{closeStep}` is provider-specific; `{verdictRel}` is this stage's own verdict file. `prov` is pinned by
// the caller (no mid-dialog drift).
function briefCtx(i: Issue, prov: ProviderId, idx: number): BriefCtx {
  const body = (i.body || '').trim() || '_(no description provided)_';
  return { issue: `# Issue #${i.number}: ${i.title}\n\n${body}`, number: i.number, title: i.title, closeStep: PROVS[prov].closeStep(i.number), verdictRel: `.slayer/stage-${idx}.json` };
}
// PR-facing brief add-ons (best-effort agent instructions — the agent already has the git CLI it uses to open
// the PR): the PR-opening stage surfaces the whole pipeline in the PR description, and the review stage mirrors
// its verdict onto the PR as a comment. So the PR shows which stages produced it, and the review is visible on it.
function prNotes(stage: StageDef, pipeline: PipelineDef, prov: ProviderId): string {
  let out = '';
  if (stage.brief.includes('{closeStep}')) {   // a stage that opens the PR/MR (Fix, Fix-only, or a custom one)
    const flow = pipeline.stages.map((s) => s.name).join(' → ');
    out += `\n\n---\nWhen you open the pull request, add this exact line to its description so the pipeline that produced it is visible:\n\n> 🔧 Slayer T pipeline: ${flow}`;
  }
  // Only when the pipeline actually opens a PR (a fix stage) — GitHub/GitLab have a CLI that comments on the current branch's PR.
  if (stage.kind === 'review' && prov !== 'bitbucket' && pipeline.stages.some((s) => s.brief.includes('{closeStep}'))) {
    const cmd = prov === 'gitlab' ? '`glab mr note --message "<verdict>"`' : '`gh pr comment --body "<verdict>"`';
    out += `\n\n---\nAfter you write your verdict, ALSO post it as a comment on the pull request for the current branch — run ${cmd} with your verdict (pass/fail + the key findings). This surfaces the review on the PR itself.`;
  }
  return out;
}
// The rendered seed brief for a stage — editable in Assign before launch.
function stageBriefText(p: PipelineDef, idx: number, i: Issue, prov: ProviderId): string {
  const stage = p.stages[idx]; if (!stage) return '';
  return renderBrief(stage.brief, briefCtx(i, prov, idx)) + prNotes(stage, p, prov);
}

// The sequence graph — the issue as the head node, then the pipeline's WIRED success path (from the entry,
// following each stage's valid/always edge), with the condition on each gate edge and the invalid → Stop
// off-ramp. Following the edges (not array order) means a custom/reordered/forked pipeline shows in its true
// run order and lights up correctly. Used as a static preview in Assign (opts.preview) and a LIVE graph in
// Details. opts.stageIdx = the active stage (array index) · opts.invalid = that gate closed · opts.review = PR open.
function seqGraph(p: PipelineDef, issueNumber: number, opts: { stageIdx?: number; invalid?: boolean; review?: boolean; preview?: boolean } = {}): string {
  const preview = !!opts.preview;
  const cur = opts.stageIdx ?? -1;   // the run's current stage, as an array index into p.stages
  const invalid = !!opts.invalid;
  const review = !!opts.review;

  // The success path exactly as the runner would take it (follow valid/always edges from the entry).
  const path = wiredPath(p);
  if (cur >= 0 && !path.includes(cur)) path.push(cur); // the run took a branch off the success path → still show it

  const curPos = path.indexOf(cur);
  const failedPos = invalid ? curPos : -1;
  const stateFor = (pos: number): string => {
    if (preview) return 'idle';
    if (pos === failedPos) return 'failed';
    if (review) return 'done';
    if (curPos < 0) return 'pending';
    if (pos < curPos) return 'done';
    if (pos === curPos) return 'running';
    return 'pending';
  };
  const badge = (s: string): string =>
    s === 'done' ? '<span class="sg-b done">✓</span>' : s === 'running' ? '<span class="sg-b run">↻</span>' : s === 'failed' ? '<span class="sg-b fail">✗</span>' : '';
  const edge = (label: string, cls = ''): string =>
    `<span class="sg-edge ${cls}">${label ? `<span class="sg-lab">${esc(label)}</span>` : ''}<span class="sg-arr"></span></span>`;

  const out: string[] = [`<span class="sg-node sg-issue"><b class="sg-k">issue</b>#${issueNumber}</span>`, edge('assign')];
  for (let pos = 0; pos < path.length; pos++) {
    const s = p.stages[path[pos]]; if (!s) continue;
    const state = stateFor(pos);
    out.push(`<span class="sg-node sg-stage k-${s.kind} sg-${state}"><span class="sg-dot"></span>${esc(s.name)}${badge(state)}</span>`);
    if (pos === failedPos) { // this gate closed → its invalid edge → Stop (or the stage it routes to); the rest never ran
      const inv = (s.edges || []).find((x) => x.when === 'invalid');
      const invTo = inv && inv.to !== STOP ? p.stages[stageIndexById(p, inv.to)]?.name : null;
      out.push(edge('if invalid', 'no'), `<span class="sg-node sg-stop">${invTo ? esc(invTo) : '⛔ Stop'}</span>`);
      return `<div class="sg-wrap"><div class="sg">${out.join('')}</div></div>`;
    }
    if (pos < path.length - 1) out.push(edge(isGate(s) ? 'if valid' : '', isGate(s) ? 'ok' : ''));
  }
  // the last stage on the path has no success edge → it opens the PR
  out.push(edge(''), `<span class="sg-node sg-term ${review ? 'on' : ''}">${review ? '✅ PR → review' : 'PR'}</span>`);
  return `<div class="sg-wrap"><div class="sg">${out.join('')}</div></div>`;
}
// A compact pipeline graph (wired path → kind-colored stages + gate conditions → PR), same visual language as
// seqGraph. Used on the map board so a pipeline is shown the same way there as in Assign/Details/the builder.
function pipeMini(p: PipelineDef): string {
  const path = wiredPath(p);
  const out: string[] = [];
  for (let pos = 0; pos < path.length; pos++) {
    const s = p.stages[path[pos]]; if (!s) continue;
    out.push(`<span class="sg-node sg-stage k-${s.kind}"><span class="sg-dot"></span>${esc(s.name)}</span>`);
    if (pos < path.length - 1) out.push(`<span class="sg-edge ${isGate(s) ? 'ok' : ''}">${isGate(s) ? '<span class="sg-lab">if valid</span>' : ''}<span class="sg-arr"></span></span>`);
  }
  out.push(`<span class="sg-edge"><span class="sg-arr"></span></span><span class="sg-node sg-term">PR</span>`);
  return `<div class="sg-wrap"><div class="sg">${out.join('')}</div></div>`;
}

// Read-only issue details — usable at any time, including while the issue is being worked on (its row
// opens this instead of re-assigning). Shows the description + metadata + run status + PR/MR, and links
// out; an idle issue also gets an Assign… shortcut.
function openDetails(i: Issue): void {
  const dp = issP(i), dr = issR(i);   // the issue's OWN provider/repo (its own in All-repos scope, else the active repo)
  const st = statusOf(i.number, dp, dr);
  const canAssign = st === 'idle' && issueState === 'open'; // don't offer to assign a closed issue (or one already in progress)
  // A run can get stranded (e.g. you closed its agent tab), leaving the issue stuck on a live/queued/invalid
  // status with its slot held — and since the row is non-idle, a click only opens these details. Offer an
  // explicit stop-and-re-assign so a stranded run never wedges the issue.
  const canReassign = issueState === 'open' && (st === 'validating' || st === 'fixing' || st === 'working' || st === 'queued' || st === 'invalid');
  const pc = PROVS[dp];
  const prWord = dp === 'gitlab' ? 'MR' : 'PR';
  const pr = prByBranch[`issue-${i.number}`];
  const body = (i.body || '').trim();
  const assignees = i.assignees || [];
  const run = runs.get(rk(i.number, dp, dr)); // its pipeline run, if any (drives the graph + invalid reason + override)
  const foot = st === 'validating' ? 'Validating — checking the issue is real & reproducible (no code changes yet).'
    : st === 'fixing' ? 'Fixing — implementing the change in a terminal tab.'
    : st === 'invalid' ? 'Stopped — the agent judged this issue not valid. You can still run the fix anyway.'
    : st === 'working' ? 'Being worked on — its agent runs in a terminal tab.'
    : st === 'review' ? `A ${prWord} is open for this issue.`
    : st === 'queued' ? 'Queued — starts when a slot frees.' : '';
  // The live sequence graph: issue → stages → PR, lit by the current run state (running / done / failed).
  const graph = run ? seqGraph(run.pipeline, i.number, { stageIdx: run.stageIdx, invalid: st === 'invalid', review: st === 'review' }) : '';
  const { root, close } = modal(`<div class="tpl-card iss-card iss-det">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Issue #${i.number}<small>${esc(i.title)}</small></span></div>
      <div class="bd">
        <div class="det-row"><span class="isr-st ${st}">${st}</span><span class="det-repo"><span class="src-dot ${pc.dot}"></span> ${esc(dr)}</span>${pr ? `<span class="det-pr">${prWord} open${pr.draft ? ' · draft' : ''}</span>` : ''}</div>
        ${run ? `<div class="det-pipe"><span class="det-k">${esc(run.pipeline.name)}</span></div>${graph}` : ''}
        ${run?.reason ? `<div class="det-invalid">⛔ Not valid<div class="det-reason">${esc(run.reason)}</div></div>` : ''}
        ${i.labels.length ? `<div class="det-labs">${i.labels.map(labelHtml).join('')}</div>` : ''}
        ${i.author ? `<div class="det-meta"><span class="det-k">Created by</span>${esc(i.author)}</div>` : ''}
        ${assignees.length ? `<div class="det-meta"><span class="det-k">Assignees</span>${assignees.map((a) => esc(a)).join(', ')}</div>` : ''}
        ${i.milestone ? `<div class="det-meta"><span class="det-k">Milestone</span>${esc(i.milestone)}</div>` : ''}
        <div class="det-body">${body ? esc(body) : '<span class="mut">No description provided.</span>'}</div>
      </div>
      <div class="ft"><span class="hint">${foot}</span><span class="r">${pr ? `<button class="tpl-btn ghost" data-pr>Open ${prWord} ↗</button>` : ''}<button class="tpl-btn ghost" data-ext>Open on ${esc(pc.name)} ↗</button>${st === 'invalid' && run ? '<button class="tpl-btn pri" data-override>▶ Run Fix anyway</button>' : ''}${canReassign ? `<button class="tpl-btn ${st === 'invalid' ? 'ghost' : 'pri'}" data-reassign>${st === 'queued' ? '⟲ Cancel & re-assign' : '⟲ Stop & re-assign'}</button>` : ''}${canAssign ? '<button class="tpl-btn pri" data-assign>⚡ Assign…</button>' : ''}<button class="tpl-btn ${canAssign || canReassign ? 'ghost' : 'pri'}" data-x>${canAssign || canReassign ? 'Close' : 'Done'}</button></span></div>
    </div>`);
  root.querySelector('[data-x]')?.addEventListener('click', close);
  root.querySelector('[data-ext]')?.addEventListener('click', () => relay.openExternal(i.url));
  root.querySelector('[data-pr]')?.addEventListener('click', () => { if (pr) relay.openExternal(pr.url); });
  root.querySelector('[data-assign]')?.addEventListener('click', () => { close(); void openAssign(i); });
  // Stop the stranded run (free its slot / drop it from the queue), then open a fresh Assign for the issue.
  root.querySelector('[data-reassign]')?.addEventListener('click', () => { close(); if (st === 'queued') cancelQueued(i.number, dp, dr); else freeSlot(i.number, dp, dr); void openAssign(i); });
  root.querySelector('[data-override]')?.addEventListener('click', () => { close(); overrideInvalid(rk(i.number, dp, dr)); });
}

let assigning = false; // guard the whole create-worktree round-trip against a double submit
async function openAssign(i: Issue): Promise<void> {
  const dir = state.settings.workspace || '';
  await loadDbCreds();   // refresh the saved DB credential templates so the picker is current
  const detected = await relay.agentsDetect().catch(() => ({} as Record<string, boolean>));
  const installed = AGENTS.filter((a) => detected[a.id]);
  const agentOk = installed.length > 0;
  // Default agent = the saved preference if still installed, else the first installed one.
  let agentId = (state.settings.issueAgent && detected[state.settings.issueAgent]) ? state.settings.issueAgent : (installed[0]?.id || '');
  const opts = AGENTS.map((a) => `<option value="${a.id}"${a.id === agentId ? ' selected' : ''}${detected[a.id] ? '' : ' disabled'}>${esc(a.name)}${detected[a.id] ? '' : ' — not installed'}</option>`).join('');
  const asgProvider = issP(i), asgRepo = issR(i); // the issue's OWN repo (its own in All-repos scope) — pinned so a mid-dialog switch can't retarget
  const pipes = () => allPipelines(customPipelines());
  // Default pipeline = THIS issue's own saved pipeline (per-issue), else the first built-in (Validate → Fix).
  let pipelineId = issuePipelineFor(asgProvider, asgRepo || '', i.number);
  const pipeOpts = () => pipes().map((p) => `<option value="${p.id}"${p.id === pipelineId ? ' selected' : ''}>${esc(p.name)}${p.builtin ? '' : ' ✎'}</option>`).join('');
  let pipeline = pipelineById(pipelineId, customPipelines());
  let briefDirty = false;                    // once the user edits the brief, stop re-seeding it on pipeline change
  const primary = agentOk ? '⚡ Run pipeline' : 'Create worktree & open';
  // Dependency repos = the workspace's OTHER tracked repos (any provider) the agent may READ while fixing this
  // issue (e.g. a FE issue that needs the BE codebase). Persisted per-issue; linked read-only under .deps/.
  const depCandidates = ((state.settings.issueReposByWs || {})[wsKey()] || []).filter((id) => id !== `${asgProvider}:${asgRepo || ''}`);
  const savedDeps = issueDepsFor(asgProvider, asgRepo || '', i.number);
  const initialDeps = savedDeps.length ? savedDeps : repoDepsFor(`${asgProvider}:${asgRepo || ''}`); // no saved deps → default to this repo's dependency template
  const selectedDeps = new Set(initialDeps.filter((id) => depCandidates.includes(id)));
  let selectedDbCred = issueDbCredFor(asgProvider, asgRepo || '', i.number); // DB credential template injected into the run's env
  const selectedNotes = new Set(defaultNoteIds());   // configurable brief notes (Settings) — default-on ones pre-checked
  const seedBrief = () => stageBriefText(pipeline, 0, i, asgProvider) + depsNote([...selectedDeps]) + dbCredNote(selectedDbCred) + notesNote([...selectedNotes]); // brief + .deps/ + DB-creds + notes
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Assign #${i.number}<small>${esc(i.title)}</small></span></div>
      <div class="bd">
        <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Assign to</label><select class="iss-agentsel" id="issAgentSel"${agentOk ? '' : ' disabled'}>${opts}</select></div>
        <div class="iss-agent ${agentOk ? 'ok' : 'no'}">${agentOk ? '✓ runs in its own login/session (keyless where supported), in an isolated worktree' : '⚠ No coding agent on PATH — the worktree still opens; install Claude Code (or Gemini / Codex / Aider) to auto-launch.'}</div>
        <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Pipeline</label><select class="iss-agentsel" id="issPipeSel">${pipeOpts()}</select><button class="iss-pipebuild" id="issPipeBuild" title="Build / edit pipelines">✎ Build</button></div>
        <div class="pipe-preview" id="issGraph">${seqGraph(pipeline, i.number, { preview: true })}</div>
        <div class="iss-pipedesc" id="issPipeDesc">${esc(pipeline.desc)}</div>
        ${depCandidates.length ? `<label class="iss-lbl">Dependencies <span class="mut">— read-only repos the agent can view under <code>.deps/</code></span></label>
        <div class="iss-deps" id="issDeps">${depCandidates.map((id) => { const { repo: r } = parseRepoId(id); return `<label class="iss-dep"><input type="checkbox" value="${esc(id)}"${selectedDeps.has(id) ? ' checked' : ''}><b>${esc(r.split('/').pop() || r)}</b><span class="mut">${esc(id)}</span></label>`; }).join('')}</div>` : ''}
        ${dbCredMetas().length ? `<div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Database</label><select class="iss-agentsel" id="issDbSel">${dbCredOptions(selectedDbCred)}</select></div>` : ''}
        ${noteChecks(selectedNotes)}
        <label class="iss-lbl">Brief · <span id="issBriefStage">${esc(pipeline.stages[0].name)}</span> stage <span class="mut">— edit before launch</span></label>
        <textarea class="iss-brief" spellcheck="false" rows="10">${esc(seedBrief())}</textarea>
        <div class="iss-wt">Creates an isolated worktree on branch <code>issue-${i.number}</code> and runs the pipeline there. Later stages use their built-in briefs.</div>
      </div>
      <div class="ft"><span class="hint">Saved as <code>.slayer/issue-${i.number}.md</code> (git-excluded)</span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-ok>${primary}</button></span></div>
    </div>`);
  const ta = root.querySelector('.iss-brief') as HTMLTextAreaElement;
  const okBtn = root.querySelector('[data-ok]') as HTMLButtonElement;
  const sel = root.querySelector('#issAgentSel') as HTMLSelectElement | null;
  if (sel) sel.onchange = () => { agentId = sel.value; void relay.patchSettings({ issueAgent: agentId }); }; // remember the pick
  const psel = root.querySelector('#issPipeSel') as HTMLSelectElement | null;
  // Reflect the currently-selected `pipeline` into the preview graph, description, brief-stage label, and
  // (if unedited) the brief textarea. Reused by the dropdown onchange and after the builder saves.
  const syncPipe = () => {
    pipeline = pipelineById(pipelineId, customPipelines());
    const g = root.querySelector('#issGraph'); if (g) g.innerHTML = seqGraph(pipeline, i.number, { preview: true });
    const d = root.querySelector('#issPipeDesc'); if (d) d.textContent = pipeline.desc;
    const bs = root.querySelector('#issBriefStage'); if (bs) bs.textContent = pipeline.stages[0]?.name || '';
    if (!briefDirty) ta.value = seedBrief();
  };
  // Toggle a dependency repo → persist it for this issue and re-seed the brief's .deps/ note (unless edited).
  root.querySelector('#issDeps')?.addEventListener('change', () => {
    selectedDeps.clear();
    root.querySelectorAll<HTMLInputElement>('#issDeps input:checked').forEach((cb) => selectedDeps.add(cb.value));
    void setIssueDeps(asgProvider, asgRepo || '', i.number, [...selectedDeps]);
    if (!briefDirty) ta.value = seedBrief();
  });
  addSearch(root.querySelector('#issDeps'), 'Search dependency repos…'); // filter a long dependency-repo list
  // Pick a DB credential template → persist it for this issue and re-seed the brief's DB note (unless edited).
  const dbSel = root.querySelector('#issDbSel') as HTMLSelectElement | null;
  if (dbSel) dbSel.onchange = () => { selectedDbCred = dbSel.value; void setIssueDbCred(asgProvider, asgRepo || '', i.number, selectedDbCred); if (!briefDirty) ta.value = seedBrief(); };
  root.querySelector('#bnChecks')?.addEventListener('change', () => {   // toggle a brief note → re-seed (unless the brief was edited)
    selectedNotes.clear();
    root.querySelectorAll<HTMLInputElement>('#bnChecks input:checked').forEach((cb) => selectedNotes.add(cb.dataset.note!));
    if (!briefDirty) ta.value = seedBrief();
  });
  if (psel) psel.onchange = () => {
    pipelineId = psel.value;
    void setIssuePipeline(asgProvider, asgRepo || '', i.number, pipelineId); // remember THIS issue's pipeline
    syncPipe();
  };
  // Build / edit pipelines — opens the visual builder; on save we refresh the dropdown + preview and select
  // the (possibly new) pipeline. Built-ins open read-only with a "Duplicate to edit".
  root.querySelector('#issPipeBuild')?.addEventListener('click', () => {
    openPipelineBuilder(pipeline, (savedId) => {
      if (savedId) { pipelineId = savedId; void setIssuePipeline(asgProvider, asgRepo || '', i.number, pipelineId); } // this issue now uses the (new) pipeline
      if (psel) psel.innerHTML = pipeOpts();      // rebuild options (a new/renamed pipeline may have appeared)
      syncPipe();
    });
  });
  ta.oninput = () => { briefDirty = true; };
  root.querySelector('[data-x]')?.addEventListener('click', close);
  setTimeout(() => ta.focus(), 30);
  okBtn.addEventListener('click', async () => {
    if (assigning) return;
    assigning = true; okBtn.disabled = true; okBtn.textContent = 'Creating worktree…';
    // ta.value is stage 0's brief → worktree-add writes it as .slayer/issue-N.md (stage 0's brief file).
    const res = await relay.worktreeAdd(asgProvider, asgRepo || '', dir, i.number, ta.value).catch(() => ({ ok: false, error: 'Worktree creation failed' }));
    assigning = false;
    // Launch even if the dialog was Escaped during creation — the worktree exists and the agent/pipeline/brief/deps
    // are already captured; an accidental Escape must not silently drop the run (the launch toast still fires).
    if (!res.ok) { okBtn.disabled = false; okBtn.textContent = primary; toast(res.error || 'Could not create worktree'); return; }
    // Link the selected dependency repos read-only under .deps/ (best-effort — a dep that won't clone is skipped).
    const depIds = [...selectedDeps];
    if (depIds.length) { okBtn.textContent = 'Linking dependencies…'; await relay.linkDeps(res.path!, dir, depIds.map((id) => parseRepoId(id))).catch(() => null); }
    const brief0Rel = res.briefRel || '';
    const agent = AGENTS.find((a) => a.id === agentId);
    // No coding agent on PATH → just open the worktree; there's nothing to run the pipeline with.
    if (!(agentOk && agent)) {
      deps.openAgentTab({ cwd: res.path!, name: `issue #${i.number}`, runCmd: undefined });
      render(); close();
      toast(res.reused ? `Reopened worktree for #${i.number}` : `Worktree ready for #${i.number}`, true);
      return;
    }
    // Launch now, or queue at capacity (the worktree + stage-0 brief are prepared → instant auto-launch).
    const r = launchOrQueue({ provider: asgProvider, repo: asgRepo || '', issue: i, pipeline: clonePipeline(pipeline), wt: res.path!, agentId, agentName: agent.name, brief0Rel });
    render(); close();
    toast(r === 'queued' ? `Queued #${i.number} — starts when a slot frees (${workingCount()}/${CAP()} running)`
      : res.reused ? `Reopened worktree for #${i.number} · ${pipeline.name}` : `Launching ${pipeline.name} on #${i.number}`, true);
  });
}

/* ----------------------------- mapping board (issues → pipelines, at scale) ----------------------------- */
// A canvas: idle issues on the left, the pipeline registry on the right. Drag from an issue's port onto a
// pipeline to map it; "Run mapped" creates each worktree and launches (or queues) the run. Bulk assign.
async function openIssueMap(): Promise<void> {
  if (issScope === 'all') { toast('Switch to a single repo to map issues → pipelines'); return; } // the map board assigns per the active repo
  if (phase !== 'ready' || !repo) { toast('Pull a repo’s issues first'); return; }
  const dir = state.settings.workspace || '';
  const detected = await relay.agentsDetect().catch(() => ({} as Record<string, boolean>));
  const agentOk = AGENTS.some((a) => detected[a.id]);
  const agentId = (state.settings.issueAgent && detected[state.settings.issueAgent]) ? state.settings.issueAgent! : (AGENTS.find((a) => detected[a.id])?.id || '');
  const asgProvider = provider, asgRepo = repo || '';    // pin the target
  const mappable = issues.filter((i) => statusOf(i.number) === 'idle'); // only idle+open issues can be assigned
  const pipes = allPipelines(customPipelines());
  // issueNumber → pipelineId, seeded from each issue's own saved (non-default) pipeline so the board reflects it.
  const mapping = new Map<number, string>();
  { const stored = state.settings.issuePipelineByKey || {}; for (const it of mappable) { const pid = stored[pipeKeyFor(asgProvider, asgRepo, it.number)]; if (pid && pipes.some((p) => p.id === pid)) mapping.set(it.number, pid); } }
  let connecting: { from: number; x: number; y: number } | null = null;

  const IW = 236, IH = 58, PW = 300, PH = 72, IX = 16, PX = 520, W = 840;
  const IY = (k: number) => 22 + k * (IH + 12);
  const PY = (k: number) => 26 + k * (PH + 14);
  const H = Math.max(mappable.length ? IY(mappable.length) : 70, pipes.length ? PY(pipes.length) : 70) + 20;
  const iIndex = (n: number) => mappable.findIndex((i) => i.number === n);
  const pIndex = (pid: string) => pipes.findIndex((p) => p.id === pid);

  const root = document.createElement('div'); root.className = 'tpl-modal im-modal';
  root.innerHTML = `<div class="tpl-sc"></div><div class="tpl-card im-card">
      <div class="pb-head"><span class="dot" style="background:var(--accent)"></span><span class="im-title">Map issues → pipelines</span><span class="pb-sp"></span>
        <span class="im-count" id="imCount"></span><button class="tpl-btn ghost" id="imCancel">Close</button><button class="tpl-btn pri" id="imRun" disabled>Run mapped</button></div>
      <div class="im-body"><div class="im-canvas" id="imCanvas" style="width:${W}px;height:${H}px"></div></div>
      <div class="pb-foot">Drag from an issue’s right dot onto a pipeline to map it. Click an arrow’s × (or the mapped issue) to remove it.${agentOk ? '' : ' <span style="color:#e0a44a">⚠ no coding agent on PATH — worktrees open but won’t auto-run.</span>'}</div>
    </div>`;
  document.body.appendChild(root);
  const canvas = root.querySelector('#imCanvas') as HTMLElement;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
  document.addEventListener('keydown', onKey);
  // Overlay/scrim click does NOT close the dialog — close via its own button or Escape (the scrim is a static backdrop).
  root.querySelector('#imCancel')?.addEventListener('click', close);
  const canvasPoint = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  function renderMap(): void {
    const paths: string[] = [];
    for (const [n, pid] of mapping) {
      const ii = iIndex(n), pi = pIndex(pid); if (ii < 0 || pi < 0) continue;
      const ax = IX + IW, ay = IY(ii) + IH / 2, tx = PX, ty = PY(pi) + PH / 2;
      const mx = (ax + tx) / 2, my = (ay + ty) / 2;                   // bezier midpoint (== segment midpoint here) for the × badge
      const d = `M${ax},${ay} C${ax + 70},${ay} ${tx - 70},${ty} ${tx},${ty}`;
      // A removable edge: fat transparent hit-path + the visible line + endpoint dots + a × badge at the mid.
      // Clicking anywhere on the group deletes the mapping (issue reverts to the default pipeline). pb-svg is
      // pointer-events:none, so the interactive bits opt back in via CSS.
      paths.push(`<g class="im-edge" data-num="${n}">`
        + `<path class="im-hit" d="${d}" fill="none"/>`
        + `<path class="im-line" d="${d}" fill="none" marker-end="url(#imah)"/>`
        + `<circle class="im-dot" cx="${ax}" cy="${ay}" r="4"/><circle class="im-dot" cx="${tx}" cy="${ty}" r="4"/>`
        + `<g class="im-xg" transform="translate(${mx},${my})"><circle class="im-xbg" r="8"/><path class="im-xm" d="M-3.2,-3.2 L3.2,3.2 M3.2,-3.2 L-3.2,3.2" fill="none"/></g>`
        + `</g>`);
    }
    if (connecting) { const ii = iIndex(connecting.from); if (ii >= 0) { const ax = IX + IW, ay = IY(ii) + IH / 2; paths.push(`<path d="M${ax},${ay} L${connecting.x},${connecting.y}" fill="none" style="stroke:var(--accent-2);stroke-width:2;stroke-dasharray:5 4"/>`); } }
    const svg = `<svg class="pb-svg" width="${W}" height="${H}"><defs><marker id="imah" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="#6e7bff"/></marker></defs>${paths.join('')}</svg>`;
    const issueNodes = mappable.length ? mappable.map((i, k) => `<div class="im-issue${mapping.has(i.number) ? ' mapped' : ''}" data-num="${i.number}" style="left:${IX}px;top:${IY(k)}px;width:${IW}px">
        <div class="im-hash">#${i.number}</div><div class="im-t">${esc(i.title)}</div><span class="pb-port out" data-inum="${i.number}"></span></div>`).join('')
      : `<div class="im-none" style="left:${IX}px;top:22px">No idle open issues to map.</div>`;
    const pipeNodes = pipes.map((p, pk) => `<div class="im-pipe" data-pid="${esc(p.id)}" style="left:${PX}px;top:${PY(pk)}px;width:${PW}px">
        <span class="pb-port in"></span><div class="im-pn">${esc(p.name)}${p.builtin ? '' : ' <i class="im-cust">custom</i>'}</div><div class="im-ps">${pipeMini(p)}</div></div>`).join('');
    canvas.innerHTML = svg + issueNodes + pipeNodes;
    canvas.querySelectorAll<HTMLElement>('.im-issue').forEach((node) => node.onclick = (e) => { if ((e.target as HTMLElement).closest('.pb-port')) return; const n = Number(node.dataset.num); if (mapping.has(n)) { mapping.delete(n); void setIssuePipeline(asgProvider, asgRepo, n, pipes[0].id); renderMap(); } }); // clear → back to the default
    // Remove an arrow to undo the mapping — click anywhere on the edge (or its × badge). Reverts to the default pipeline.
    canvas.querySelectorAll<SVGGElement>('.im-edge').forEach((g) => g.addEventListener('click', () => { const n = Number(g.dataset.num); if (!mapping.has(n)) return; mapping.delete(n); void setIssuePipeline(asgProvider, asgRepo, n, pipes[0].id); renderMap(); }));
    canvas.querySelectorAll<HTMLElement>('.pb-port.out').forEach((port) => port.onpointerdown = (e) => {
      e.stopPropagation(); e.preventDefault();
      const from = Number(port.dataset.inum); connecting = { from, ...canvasPoint(e) };
      const move = (ev: PointerEvent) => { if (connecting) { const p = canvasPoint(ev); connecting.x = p.x; connecting.y = p.y; renderMap(); } };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        const tgt = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement)?.closest('.im-pipe') as HTMLElement | null;
        connecting = null; if (tgt?.dataset.pid) { mapping.set(from, tgt.dataset.pid); void setIssuePipeline(asgProvider, asgRepo, from, tgt.dataset.pid); } renderMap(); // map → persist per-issue
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    const cnt = root.querySelector('#imCount'); if (cnt) cnt.textContent = mapping.size ? `${mapping.size} mapped` : '';
    (root.querySelector('#imRun') as HTMLButtonElement).disabled = mapping.size === 0;
  }

  let running = false;
  root.querySelector('#imRun')?.addEventListener('click', async () => {
    if (running || !mapping.size) return; running = true;
    const runBtn = root.querySelector('#imRun') as HTMLButtonElement; runBtn.disabled = true; runBtn.textContent = 'Running…';
    let ok = 0;
    for (const [n, pid] of mapping) {
      const i = mappable.find((x) => x.number === n); const pipeline = pipes.find((p) => p.id === pid); if (!i || !pipeline) continue;
      const res = await relay.worktreeAdd(asgProvider, asgRepo, dir, i.number, stageBriefText(pipeline, 0, i, asgProvider)).catch(() => ({ ok: false } as { ok: boolean; path?: string; briefRel?: string }));
      if (!res.ok) { toast(`Worktree failed for #${n}`); continue; }
      const agent = AGENTS.find((a) => a.id === agentId);
      if (agentOk && agent) launchOrQueue({ provider: asgProvider, repo: asgRepo, issue: i, pipeline: clonePipeline(pipeline), wt: res.path!, agentId, agentName: agent.name, brief0Rel: res.briefRel || '' });
      else deps.openAgentTab({ cwd: res.path!, name: `issue #${i.number}`, runCmd: undefined });
      ok++;
    }
    render(); running = false; close();
    toast(`Mapped ${ok} issue${ok === 1 ? '' : 's'} to ${agentOk ? 'their pipelines' : 'worktrees'}`, true);
  });

  renderMap();
}

/* ----------------------------- summary: issues by owner ----------------------------- */
// A read-only breakdown of the loaded issues by creator: created vs fixed, with a progress bar and totals.
function openOwnerSummary(): void {
  if (phase !== 'ready') { toast('Pull a repo’s issues first'); return; }
  const rows = ownerSummary();
  const totC = rows.reduce((s, r) => s + r.created, 0);
  const totF = rows.reduce((s, r) => s + r.fixed, 0);
  const pctOf = (f: number, c: number) => (c ? Math.round((f / c) * 100) : 0);
  const bar = (f: number, c: number) => `<div class="ow-track"><div class="ow-fill" style="width:${pctOf(f, c)}%"></div></div><span class="ow-pct">${pctOf(f, c)}%</span>`;
  const stateLbl = issueState === 'closed' ? 'closed' : 'open';
  const body = rows.length ? `<table class="ow-tbl">
      <thead><tr><th>Owner</th><th class="ow-nh">Created</th><th class="ow-nh">Fixed</th><th>Fixed rate</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="ow-who"><span class="src-dot ${PROVS[provider].dot}"></span>${esc(r.login)}</td>
        <td class="ow-n">${r.created}</td>
        <td class="ow-n">${r.fixed}</td>
        <td class="ow-bar">${bar(r.fixed, r.created)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td class="ow-who"><b>Total</b> · ${rows.length} owner${rows.length === 1 ? '' : 's'}</td><td class="ow-n">${totC}</td><td class="ow-n">${totF}</td><td class="ow-bar">${bar(totF, totC)}</td></tr></tfoot>
    </table>` : `<div class="src-empty">No issues loaded to summarize.</div>`;
  const { root, close } = modal(`<div class="tpl-card iss-card ow-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Issues by owner<small>${esc(repo || '')} · ${stateLbl} issues</small></span></div>
      <div class="bd">${body}</div>
      <div class="ft"><span class="hint">Fixed = the agent opened a PR/MR${issueState === 'closed' ? ', or the issue is closed' : ''}. Totals cover all loaded issues, not the active filters.</span><span class="r"><button class="tpl-btn pri" data-x>Done</button></span></div>
    </div>`);
  root.querySelector('[data-x]')?.addEventListener('click', close);
}

/* ----------------------------- repo selector + Sources ----------------------------- */
// (trackedRepos / curRepo / setActiveRepo / setTracked are defined at the top — Issues are per-workspace.
//  The legacy bare-id → provider-qualified migration now runs once at boot in the renderer.)

function closeRepoMenu(): void { document.getElementById('issRepoMenu')?.remove(); }
function openRepoMenu(): void {
  const btn = $('#issSideRepo'); if (!btn) return;
  if (document.getElementById('issRepoMenu')) { closeRepoMenu(); return; }
  const active = curRepo();
  // "This folder's repo" and the Sources action stay pinned; the (possibly long) tracked-repo list scrolls.
  const folderRow = `<button class="iss-mi ${!active ? 'on' : ''}" data-repo=""><span class="d">⌂</span> This folder’s repo</button>`;
  const repoRows = trackedRepos().map((id) => {
    const { provider: p, repo: r } = parseRepoId(id);
    return `<button class="iss-mi ${active === id ? 'on' : ''}" data-repo="${esc(id)}"><span class="d src-dot ${PROVS[p].dot}"></span> ${esc(r)}</button>`;
  }).join('');
  const menu = document.createElement('div'); menu.className = 'iss-menu'; menu.id = 'issRepoMenu';
  menu.innerHTML = folderRow
    + (repoRows ? `<div class="iss-menu-list">${repoRows}</div>` : '')
    + '<div class="iss-msep"></div><button class="iss-mi" data-sources="1"><span class="d">⚙</span> Sources — connect &amp; pick repos…</button>';
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.round(r.left) + 'px'; menu.style.top = Math.round(r.bottom + 4) + 'px';
  menu.querySelectorAll<HTMLElement>('.iss-mi').forEach((mi) => {
    mi.onclick = async (e) => {
      e.stopPropagation();
      if (mi.dataset.sources) { closeRepoMenu(); void openSources(); return; }
      closeRepoMenu();
      await setActiveRepo(mi.dataset.repo || '');   // persist the pick FIRST — else loadIssues() reads the old curRepo()
      void loadIssues();
    };
  });
  setTimeout(() => document.addEventListener('click', closeRepoMenu, { once: true }), 0);
}

// Route the right connect flow for a provider: GitHub → OAuth device flow; Bitbucket → OAuth in-browser;
// GitLab → pasted-token dialog. The two OAuth flows first ensure their app (client id / secret) is set up.
function connectProvider(pid: ProviderId): void {
  const mode = PROVS[pid].connect;
  if (mode === 'token') { void connectToken(pid); return; }
  void ensureOAuthApp(pid).then((ok) => { if (ok) (mode === 'device' ? connectGithub() : connectBitbucket()); });
}

// Make sure the provider's OAuth app is configured before a device/browser connect. Returns false if the
// user cancels the one-time setup. Providers without an oauthApp (GitLab) pass straight through.
async function ensureOAuthApp(pid: ProviderId): Promise<boolean> {
  if (!PROVS[pid].oauthApp) return true;
  const cur = await relay.providerOAuthConfigGet(wsKey(), pid).catch(() => null);
  if (cur && cur.configured) return true;
  return configOAuthApp(pid);
}

// One-time OAuth-app setup dialog: collect the client id (+ secret for Bitbucket), store encrypted in main.
// Resolves true once saved, false if cancelled. Also used from Sources to re-enter/rotate credentials.
function configOAuthApp(pid: ProviderId): Promise<boolean> {
  const cfg = PROVS[pid].oauthApp; if (!cfg) return Promise.resolve(true);
  const ws = wsKey();                                                  // credentials are scoped to the active workspace
  return new Promise<boolean>((resolve) => {
    let done = false; const settle = (v: boolean) => { if (!done) { done = true; resolve(v); } };
    void relay.providerOAuthConfigGet(ws, pid).catch(() => ({ clientId: '', hasSecret: false })).then((cur: { clientId: string; hasSecret: boolean }) => {
      const { root, close } = modal(`<div class="tpl-card iss-card">
          <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">${esc(cfg.title)}<small>one-time setup · stored encrypted</small></span></div>
          <div class="bd">
            <label class="iss-lbl">${esc(cfg.idLabel)}</label>
            <input class="iss-in" id="oaId" value="${esc(cur.clientId || '')}" placeholder="${esc(cfg.idPh)}" spellcheck="false" autocomplete="off">
            ${cfg.needsSecret ? `<label class="iss-lbl">${esc(cfg.secretLabel || 'Secret')}</label>
            <input class="iss-in" id="oaSec" type="password" placeholder="${cur.hasSecret ? '•••••••• — leave blank to keep' : esc(cfg.secretPh || '')}" spellcheck="false" autocomplete="off">` : ''}
            <div class="gh-status" id="oaStatus"></div>
            <div class="iss-wt">${cfg.help}${cfg.createUrl ? ` <button class="tpl-btn ghost" id="oaCreate">Create one ↗</button>` : ''}</div>
          </div>
          <div class="ft"><span class="hint">Stored encrypted in your OS keychain — never in <code>slayert.json</code></span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-ok>Save</button></span></div>
        </div>`, () => settle(false)); // closing via scrim/Escape counts as cancelled (guarded, so a prior save wins)
      const idEl = root.querySelector('#oaId') as HTMLInputElement;
      const secEl = root.querySelector('#oaSec') as HTMLInputElement | null;
      const statusEl = root.querySelector('#oaStatus') as HTMLElement;
      const okBtn = root.querySelector('[data-ok]') as HTMLButtonElement;
      root.querySelector('[data-x]')?.addEventListener('click', close);
      root.querySelector('#oaCreate')?.addEventListener('click', () => cfg.createUrl && relay.openExternal(cfg.createUrl));
      const submit = async () => {
        const id = idEl.value.trim(); if (!id) { idEl.focus(); return; }
        okBtn.disabled = true; okBtn.textContent = 'Saving…'; statusEl.textContent = '';
        const r = await relay.providerOAuthConfigSet(ws, pid, id, secEl?.value.trim() || undefined).catch(() => ({ ok: false, error: 'Save failed' }));
        if (!root.isConnected) return;
        if (r.ok) { settle(true); close(); return; }        // settle before close so the onClose(false) is ignored
        okBtn.disabled = false; okBtn.textContent = 'Save'; statusEl.textContent = r.error || 'Could not save';
      };
      okBtn.addEventListener('click', () => void submit());
      idEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } });
      secEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } });
      setTimeout(() => idEl.focus(), 30);
    });
  });
}

// Bitbucket OAuth (authorization-code + loopback): main opens the browser, catches the callback, and
// exchanges the code — all in one IPC. The renderer shows a "waiting" modal and awaits the result. Tokens
// (access + refresh) are stored encrypted in main; the renderer only ever learns connected/login.
async function connectBitbucket(): Promise<void> {
  let cancelled = false;
  const ws = wsKey();                                                  // pin the workspace for the whole browser round trip
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Connect Bitbucket<small>authorize Slayer T in your browser</small></span></div>
      <div class="bd">
        <div class="gh-step">Your browser will open Bitbucket's authorization page — approve the request, then come back here.</div>
        <div class="gh-status" id="bbStatus"><span class="gh-spin"></span> Waiting for you to authorize…</div>
      </div>
      <div class="ft"><span class="hint">Tokens stored encrypted in your OS keychain — never in <code>slayert.json</code></span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button></span></div>
    </div>`);
  root.querySelector('[data-x]')?.addEventListener('click', () => { cancelled = true; close(); });
  const r = await relay.bitbucketOAuth(ws).catch(() => ({ ok: false, error: 'Connect failed' }));
  if (cancelled || !root.isConnected) return;                        // user closed the modal mid-flow
  if (r.ok) { close(); toast(`Connected to Bitbucket as ${r.login || 'you'}`, true); void loadIssues(); return; }
  const statusEl = root.querySelector('#bbStatus') as HTMLElement | null;
  if (statusEl) statusEl.textContent = r.error || 'Authorization failed.';
}

// GitHub OAuth device flow: show the one-time code, open github.com/login/device, poll until authorized.
// The token is exchanged + stored (encrypted) entirely in main — the renderer only sees connected/login.
async function connectGithub(): Promise<void> {
  const ws = wsKey();                                                  // pin the workspace for the whole device-flow poll loop
  const start = await relay.githubDeviceStart(ws).catch(() => ({ ok: false, error: 'Could not start' }));
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
    const p = await relay.githubDevicePoll(ws, start.deviceCode).catch(() => ({ status: 'error', error: 'poll failed' }));
    if (p.status === 'ok') { close(); toast(`Connected to GitHub as ${p.login || 'you'}`, true); void loadIssues(); return; }
    if (p.status === 'slow_down') { wait = Number(p.interval) || wait + 5; continue; }
    if (p.status === 'pending') continue;
    if (statusEl) statusEl.textContent = p.status === 'expired' ? 'Code expired — cancel and try again.' : p.status === 'denied' ? 'Authorization was denied.' : (p.error || 'Authorization failed.');
    return;
  }
  if (!cancelled && root.isConnected && statusEl) statusEl.textContent = 'Code expired — cancel and try again.'; // hit the deadline without authorizing
}

// Token connect (GitLab PAT): paste it, validate in main, store encrypted.
async function connectToken(pid: ProviderId): Promise<void> {
  const pc = PROVS[pid];
  const ws = wsKey();                                                  // token is stored for the active workspace only
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
    const r = await relay.providerConnect(ws, pid, t, host?.value.trim()).catch(() => ({ ok: false, error: 'Connect failed' }));
    if (!root.isConnected) return;
    if (r.ok) { close(); toast(`Connected to ${pc.name} as ${r.login || 'you'}`, true); void loadIssues(); return; }
    okBtn.disabled = false; okBtn.textContent = 'Connect'; statusEl.textContent = r.error || 'Token rejected';
  };
  okBtn.addEventListener('click', () => void submit());
  tok.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } });
  setTimeout(() => tok.focus(), 30);
}

// Bitbucket workspaces to list repos from — Atlassian removed cross-workspace discovery (CHANGE-2770), so
// the user names their workspace(s) and we list each via the surviving per-workspace endpoint.
const bbWorkspaces = (): string[] => ((state.settings.bitbucketWorkspacesByWs || {})[wsKey()] || []);
async function setBbWorkspaces(list: string[]): Promise<void> {
  const uniq = [...new Set(list.map((w) => w.trim()).filter(Boolean))];
  const byWs = { ...(state.settings.bitbucketWorkspacesByWs || {}) }; byWs[wsKey()] = uniq;
  state.settings.bitbucketWorkspacesByWs = byWs;
  try { state.settings = await relay.patchSettings({ bitbucketWorkspacesByWs: byWs }); } catch { /* keep the local copy */ }
}
// The workspace editor shown under Bitbucket in Sources (add/remove workspace ids).
function bbWsEditorHtml(): string {
  const chips = bbWorkspaces().map((w) => `<span class="src-ws-chip">${esc(w)}<button class="src-ws-x" data-ws-del="${esc(w)}" title="Remove">×</button></span>`).join('');
  return `<div class="src-ws">
      <div class="src-ws-add"><input class="iss-in" id="bbWsIn" placeholder="workspace id — the bitbucket.org/<workspace>/… part" spellcheck="false" autocomplete="off"><button class="tpl-btn ghost" data-ws-add>Add</button></div>
      ${chips ? `<div class="src-ws-chips">${chips}</div>` : ''}
      <div class="iss-wt">Atlassian removed cross-workspace repo discovery — add each workspace you want to load repos from, then “Load my repos”.</div>
    </div>`;
}

// Sources: the app's connections (GitHub / GitLab / Bitbucket) + which repos to track.
async function openSources(): Promise<void> {
  const tracked = new Set(trackedRepos());
  const states = await Promise.all(PROVIDER_LIST.map(async (pc) => ({ pc, auth: await relay.providerAuthState(wsKey(), pc.id).catch(() => ({ connected: false, login: '' })) })));
  const sections = states.map(({ pc, auth }) => {
    const st = auth.connected ? `✓ connected as <b>${esc(auth.login || '')}</b>` : '⚠ not connected';
    const appBtn = pc.oauthApp ? `<button class="tpl-btn ghost" data-oapp="${pc.id}" title="Edit the OAuth app credentials">OAuth app…</button>` : '';
    const ctl = auth.connected
      ? `<button class="tpl-btn ghost" data-load="${pc.id}">Load my repos</button>${appBtn}<button class="tpl-btn ghost" data-disc="${pc.id}">Disconnect</button>`
      : `<button class="tpl-btn pri" data-connect="${pc.id}">Connect ${esc(pc.name)}</button>${appBtn}`;
    const wsEditor = pc.id === 'bitbucket' && auth.connected ? bbWsEditorHtml() : ''; // Bitbucket needs workspaces (CHANGE-2770)
    return `<div class="src-prov">
        <div class="src-row"><span class="src-nm"><span class="src-dot ${pc.dot}"></span> ${esc(pc.name)}</span><span class="src-st">${st}</span></div>
        <div class="src-repos" id="srcRepos-${pc.id}">${ctl}${wsEditor}<div id="srcList-${pc.id}"></div></div>
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
  // Edit/rotate the OAuth-app credentials (client id / secret) without disconnecting.
  root.querySelectorAll<HTMLElement>('[data-oapp]').forEach((b) => { b.onclick = () => { const id = b.dataset.oapp as ProviderId; close(); void configOAuthApp(id); }; });
  // Bitbucket workspaces: add (tolerate a pasted repo/URL — keep the first path segment) / remove, then re-render.
  const wsIn = root.querySelector('#bbWsIn') as HTMLInputElement | null;
  const addWs = async () => {
    if (!wsIn) return;
    const v = wsIn.value.trim().replace(/^https?:\/\/bitbucket\.org\//i, '').split('/')[0].trim();
    if (!v) { wsIn.focus(); return; }
    await setBbWorkspaces([...bbWorkspaces(), v]); close(); void openSources(); // reopen to show the new chip
  };
  root.querySelector('[data-ws-add]')?.addEventListener('click', () => void addWs());
  wsIn?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void addWs(); } });
  root.querySelectorAll<HTMLElement>('[data-ws-del]').forEach((b) => {
    b.onclick = async () => { await setBbWorkspaces(bbWorkspaces().filter((w) => w !== b.dataset.wsDel)); close(); void openSources(); };
  });
  root.querySelectorAll<HTMLElement>('[data-disc]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.disc as ProviderId;
      await relay.providerDisconnect(wsKey(), id).catch(() => {}); close(); toast(`Disconnected from ${PROVS[id].name}`); void loadIssues();
    };
  });
  // Load-my-repos per provider → checkboxes that track (and activate) qualified repo ids.
  root.querySelectorAll<HTMLElement>('[data-load]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.load as ProviderId;
      const btn = b as HTMLButtonElement; btn.textContent = 'Loading…'; btn.disabled = true;
      const r = await relay.providerRepos(wsKey(), id, id === 'bitbucket' ? bbWorkspaces() : undefined).catch(() => ({ ok: false, error: 'failed' }));
      btn.textContent = 'Load my repos'; btn.disabled = false;
      const box = root.querySelector(`#srcList-${id}`) as HTMLElement;
      if (!r.ok || !r.repos || !r.repos.length) { box.innerHTML = `<div class="src-empty">${esc(r.error || 'No repos found')}</div>`; return; }
      box.innerHTML = `<div class="src-list">${r.repos.map((rp: { repo: string; desc: string; priv: boolean }) => {
        const qid = repoId(id, rp.repo);
        return `<label class="src-item"><input type="checkbox" data-repo="${esc(qid)}"${tracked.has(qid) ? ' checked' : ''}><span class="src-r">${esc(rp.repo)}</span>${rp.priv ? '<span class="src-priv">private</span>' : ''}</label>`;
      }).join('')}</div>`;
      addSearch(box.querySelector('.src-list'), 'Search repositories…'); // filter the loaded repo list
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
  const asel = $('#issAuthor'); if (asel) asel.onclick = (e) => { e.stopPropagation(); openAuthorFilter(asel as HTMLElement, authorOptions(), activeAuthors, onAuthorsChanged, 'issAuthorMenu'); };
  const srcBtn = $('#issSources'); if (srcBtn) srcBtn.onclick = () => void openSources();
  const mapBtn = $('#issMap'); if (mapBtn) mapBtn.onclick = () => void openIssueMap();
  const ownBtn = $('#issOwners'); if (ownBtn) ownBtn.onclick = () => openOwnerSummary();
  // Infinite scroll: near the bottom of the list, pull the next page (guards handle re-entrancy / no-more).
  const listEl = $('#issSideList');
  if (listEl) listEl.addEventListener('scroll', () => { if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 240) void loadMoreIssues(); });
  // Open/Closed state filter — re-pull the repo with the chosen state (default open).
  $('#issState')?.querySelectorAll<HTMLElement>('.iss-seg').forEach((b) => {
    b.onclick = () => { const s = b.dataset.st === 'closed' ? 'closed' : 'open'; if (s === issueState) return; issueState = s; void loadIssues(); }; // loadIssues re-renders immediately
  });
  // Scope toggle: this repo (paged) vs every tracked repo merged. Switching drops the per-repo filters (different repos → different chips).
  $('#issScope')?.querySelectorAll<HTMLElement>('.iss-seg').forEach((b) => {
    b.onclick = () => { const s = b.dataset.sc === 'all' ? 'all' : 'repo'; if (s === issScope) return; issScope = s; activeAuthors.clear(); activeFilters.clear(); activeLabels.clear(); mineOnly = false; query = ''; const sEl = $('#issSearch') as HTMLInputElement | null; if (sEl) sEl.value = ''; void loadIssues(); };
  });
  render();
  void loadIssues();
}

// Command-palette entry point: pull (or re-pull) the current repo's issues.
export function pullIssues(): void {
  if (phase !== 'ready' || activeKey() !== loadedFor) void loadIssues(); else render();
}
