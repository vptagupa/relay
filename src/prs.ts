// PR Agent — Pull Requests as a sidebar rail (a peer of Issues). Lists the ACTIVE repo's PRs/MRs by state
// (Open / Closed) with infinite scroll; each row links out to the PR on its provider. Read-only.
//
// It SHARES the Issues rail's active repo — the explicit per-workspace pick in `issueRepoByWs`, else inferred
// from the open folder's git remote — and the same per-workspace provider connections. The renderer only ever
// sees { connected, login } + normalized PRs (tokens stay in main). DI-seam module: initPrs(deps).

import { state } from './state';
import { $, esc } from './dom';
import { toast } from './ui';
import { openAuthorFilter } from './author-filter';
import { initPrReview, openPrAssign, openPrMap, prStatusOf, onPrChip, PR_STATUS_LABEL, type PrRef, type PrCtx } from './pr-review';

const relay = (window as any).relay;

export interface PrsDeps {
  activeWsId: () => string;   // active workspace id — connections + the shared active repo are per-workspace
  focusIssues: () => void;    // jump to the Issues rail (where the shared repo is picked)
  openAgentTab: (o: { cwd: string; name: string; runCmd?: string; dbCredId?: string }) => void; // for PR review pipelines (agent tab in the PR worktree; dbCredId → inject a DB credential template)
}
let deps: PrsDeps;

type ProviderId = 'github' | 'gitlab' | 'bitbucket';
// `repo`/`provider` are set only in the "All repos" scope (each row then labels its source repo).
interface PrItem { number: number; branch: string; url: string; draft: boolean; title?: string; author?: string; state?: string; updatedAt?: number; repo?: string; provider?: ProviderId; }
type Phase = 'idle' | 'loading' | 'noauth' | 'norepo' | 'error' | 'ready';

const PROV_NAME: Record<ProviderId, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };
const PROV_DOT: Record<ProviderId, string> = { github: 'gh', gitlab: 'gl', bitbucket: 'bb' };
const PR_WORD: Record<ProviderId, string> = { github: 'PR', gitlab: 'MR', bitbucket: 'PR' };

const wsKey = () => deps.activeWsId() || 'ws_default';
// Qualified repo id "provider:owner/name" (a bare id is legacy GitHub) — same format the Issues rail persists.
function parseRepoId(id: string): { provider: ProviderId; repo: string } {
  const m = /^(github|gitlab|bitbucket):(.+)$/.exec(id || '');
  return m ? { provider: m[1] as ProviderId, repo: m[2] } : { provider: 'github', repo: id };
}

/* ----------------------------- state ----------------------------- */
let phase: Phase = 'idle';
let provider: ProviderId = 'github';
let repo: string | null = null;
let prs: PrItem[] = [];
let errMsg = '';
let prState: 'open' | 'closed' = 'open';
let prScope: 'repo' | 'all' = 'repo'; // 'repo' = the shared active repo (full infinite scroll); 'all' = every tracked repo (first page each, merged)
let loadSeq = 0;                 // supersedes an in-flight load when a newer one starts
let prsPage = 1;                 // highest provider page loaded
let prsHasMore = false;          // the last page came back full → more to load on scroll
let loadingMore = false;         // a load-more fetch is in flight (guards re-entrancy)
let members: string[] = [];      // the active repo's collaborators (the author-filter list); [] in All-repos scope
let membersFor = '';             // the "provider:repo" the loaded members belong to — gate a re-fetch to a repo change
const activeAuthors = new Set<string>(); // filter to these authors (OR); empty = all. Applied SERVER-SIDE in repo scope.
let authorReloadT: number | null = null; // debounce: coalesce rapid author toggles into one server-side re-query

// The PR rail's OWN active repo pick (independent of Issues), per workspace.
const prRepoFor = (): string => (state.settings.prRepoByWs || {})[wsKey()] || '';
async function setPrRepo(id: string): Promise<void> {
  const ws = wsKey(); const map = { ...(state.settings.prRepoByWs || {}) };
  if (id) map[ws] = id; else delete map[ws];
  try { state.settings = await relay.patchSettings({ prRepoByWs: map }); } catch { /* keep the in-memory pick */ }
}
// The active repo's members (collaborators) — the author-filter list. Fetched ONCE per repo (keyed by mkey), so
// author/state toggles don't re-request it; a repo switch (mkey changes) supersedes an in-flight fetch.
async function loadMembers(mkey: string, p: ProviderId, r: string): Promise<void> {
  const res = await relay.providerRepoMembers(wsKey(), p, r).catch(() => ({ ok: false } as { ok: boolean; members?: string[] }));
  if (membersFor === mkey) members = res.ok && res.members ? res.members : [];
}
// The list actually shown = loaded PRs filtered to the selected authors (OR; empty selection = all).
const visiblePrs = (): PrItem[] => activeAuthors.size ? prs.filter((p) => activeAuthors.has(p.author || '')) : prs;
// Author options = repo members ∪ the authors already in the loaded PRs (so external / not-yet-member authors show too).
function authorOptions(): string[] {
  const set = new Set<string>(members);
  for (const p of prs) if (p.author) set.add(p.author);
  return [...set].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/* ----------------------------- load ----------------------------- */
// Load PRs for the current scope: the single shared active repo, or every tracked repo merged.
export async function loadPrs(): Promise<void> {
  const seq = ++loadSeq;
  const ws = wsKey();
  phase = 'loading'; render();
  if (prScope === 'all') { members = []; membersFor = ''; await loadAllRepos(seq, ws); return; } // no single repo → no member list
  const dir = state.settings.workspace || '';
  const pick = prRepoFor();   // the PR rail's OWN pick — no longer tied to the Issues rail
  if (pick) { const p = parseRepoId(pick); provider = p.provider; repo = p.repo; }
  else {
    const inf = dir ? await relay.providerRepoFromRemote(dir).catch(() => null) : null; if (seq !== loadSeq) return;
    provider = inf?.provider || 'github'; repo = inf?.repo || null;
  }
  const auth = await relay.providerAuthState(ws, provider); if (seq !== loadSeq) return;
  if (!auth.connected) { phase = 'noauth'; render(); return; }
  if (!repo) { phase = 'norepo'; render(); return; }
  prsPage = 1; prsHasMore = false; loadingMore = false;
  const mkey = `${provider}:${repo}`;   // fetch members once per repo — not on every state/author reload
  if (membersFor !== mkey) { membersFor = mkey; members = []; void loadMembers(mkey, provider, repo); }
  // Server-side author filter: when authors are picked, the provider returns only their PRs (a bounded set, no
  // infinite scroll) — finding matches beyond the loaded pages, not just filtering what's already here.
  const authors = activeAuthors.size ? [...activeAuthors] : undefined;
  const r = await relay.providerPrs(ws, provider, repo, prState, 1, authors); if (seq !== loadSeq) return;
  if (!r.ok) { phase = 'error'; errMsg = r.error || `Could not list ${PR_WORD[provider]}s`; render(); return; }
  prs = r.prs || []; prsHasMore = !!r.hasMore; phase = 'ready'; render();
  maybeAutoFill();
  void sweepMergeStatus(seq);   // detect merge conflicts among the loaded PRs (bounded, cached) → badges/resolve
}

// "All repos": fan out one request per tracked repo (across providers), tag each PR with its repo, merge, and
// sort by most-recently-updated. Bounded to the first page per repo (no cross-repo infinite scroll) to cap the
// request count; repos that error or aren't connected are skipped. Errors only surface if nothing came back.
async function loadAllRepos(seq: number, ws: string): Promise<void> {
  const tracked = (state.settings.issueReposByWs || {})[ws] || [];
  if (!tracked.length) { phase = 'norepo'; errMsg = 'No repos tracked yet — add some in the Issues rail → Sources.'; render(); return; }
  let anyErr = '';
  const perRepo = await Promise.all(tracked.map(async (id) => {
    const { provider: p, repo: r } = parseRepoId(id);
    const res = await relay.providerPrs(ws, p, r, prState, 1).catch(() => ({ ok: false, error: 'request failed' }));
    if (!res.ok) { anyErr = res.error || anyErr; return [] as PrItem[]; }
    return (res.prs as PrItem[] || []).map((pr) => ({ ...pr, repo: r, provider: p }));
  }));
  if (seq !== loadSeq) return;                                     // a newer load superseded this fan-out
  prs = perRepo.flat().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  prsPage = 1; prsHasMore = false; loadingMore = false;           // cross-repo view isn't paged
  if (!prs.length && anyErr) { phase = 'error'; errMsg = anyErr; render(); return; }
  phase = 'ready'; render();
}

// Re-render but keep scroll position (innerHTML replacement otherwise jumps to top) — used when appending pages.
function renderKeepScroll(): void {
  const el = $('#prList'); const top = el ? el.scrollTop : 0;
  render();
  const el2 = $('#prList'); if (el2) el2.scrollTop = top;
}
// If the list doesn't fill its container yet, keep paging so no scroll event is needed to reach the rest.
function maybeAutoFill(): void {
  if (!prsHasMore || loadingMore || phase !== 'ready') return;
  const el = $('#prList');
  if (el && el.scrollHeight <= el.clientHeight + 240) void loadMorePrs();
}
// Infinite scroll: fetch the next page and APPEND it (deduped). Guarded against rapid scroll + a stale reload.
async function loadMorePrs(): Promise<void> {
  if (loadingMore || !prsHasMore || phase !== 'ready' || !repo) return;
  const seq = loadSeq, ws = wsKey(), fp = provider, fr = repo, fs = prState, nextPage = prsPage + 1;
  loadingMore = true; renderKeepScroll();
  const r = await relay.providerPrs(ws, fp, fr, fs, nextPage).catch(() => ({ ok: false } as { ok: boolean; prs?: PrItem[]; hasMore?: boolean }));
  loadingMore = false;
  if (seq !== loadSeq) return;                                     // a fresh load replaced the list → drop this page
  if (!r.ok || !r.prs) { prsHasMore = false; renderKeepScroll(); return; }
  const seen = new Set(prs.map((p) => p.number));
  prs.push(...(r.prs as PrItem[]).filter((p: PrItem) => !seen.has(p.number)));
  prsPage = nextPage; prsHasMore = !!r.hasMore;
  renderKeepScroll(); maybeAutoFill();
  void sweepMergeStatus(seq);   // sweep the newly-appended page for conflicts too
}

/* ----------------------------- hover detail card ----------------------------- */
// A compact "how long ago" from an epoch-ms timestamp (Date.now() is fine in the renderer — the ban is only
// inside Workflow scripts).
function relTime(ms?: number): string {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
// The full PR, fetched on hover and cached (keyed provider:repo#number) so re-hovering is instant.
type MergeState = 'clean' | 'conflict' | 'unknown';
interface PrDetail { number: number; title: string; body: string; state: string; draft: boolean; url: string; author?: string; sourceBranch: string; baseBranch: string; mergeState: MergeState; labels: string[]; reviewers: string[]; createdAt?: number; updatedAt?: number; }
const detailCache = new Map<string, PrDetail>();
const prKey = (p: PrItem) => `${p.provider || provider}:${p.repo || repo}#${p.number}`;
// A loaded PR's mergeability, if its detail has been fetched (by the conflict sweep or a hover). Undefined = not
// yet known. Only 'conflict' is surfaced (a ⚠ badge + the ⚔ resolve action) — 'clean'/'unknown' show nothing.
const mergeStateOf = (p: PrItem): MergeState | undefined => detailCache.get(prKey(p))?.mergeState;

// The hover card is HOVERABLE (pointer-events:auto) + scrollable so a long description can be read/scrolled.
// Moving from the row into the card keeps it open (a short hide-delay bridges the gap); leaving the card hides it.
let hoverEl: HTMLElement | null = null;
let hoverKey = '';                              // the PR currently shown (guards the async detail render)
let hoverUrl = '';                              // the shown PR's url — so the footer opens it even before the detail loads
let hoverPr: PrItem | null = null;              // the PR currently shown — so the card's ⚡ Review button can assign it
let hoverRow: HTMLElement | null = null;
let hoverHideT: number | null = null;
let hoverFetchT: number | null = null;
function ensureHoverEl(): HTMLElement {
  if (!hoverEl) {
    hoverEl = document.createElement('div'); hoverEl.className = 'pr-hover'; document.body.appendChild(hoverEl);
    hoverEl.addEventListener('mouseenter', () => { if (hoverHideT) { clearTimeout(hoverHideT); hoverHideT = null; } });
    hoverEl.addEventListener('mouseleave', scheduleHidePrHover);
    hoverEl.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      // ⚡ Review → open the pipeline-assign dialog for this PR (not the provider).
      if (t.closest('.prh-review')) { const pr = hoverPr; if (pr) { hidePrHover(); void openPrAssign(prRefOf(pr), prCtxOf(pr)); } return; }
      // ⚔ Resolve → open a terminal in a worktree with the conflict live.
      if (t.closest('.prh-resolve')) { const pr = hoverPr; if (pr) { hidePrHover(); void resolvePr(pr); } return; }
      // Only the "open on <provider>" footer opens the PR — clicking the title/body does nothing (so text stays selectable).
      if (!t.closest('.prh-hint')) return;
      const url = detailCache.get(hoverKey)?.url || hoverUrl; if (url) relay.openExternal(url);
    });
  }
  return hoverEl;
}
function positionHover(row: HTMLElement): void {
  if (!hoverEl) return;
  const r = row.getBoundingClientRect(), hw = hoverEl.offsetWidth, hh = hoverEl.offsetHeight;
  let left = r.right + 8; if (left + hw > window.innerWidth - 8) left = r.left - hw - 8; if (left < 8) left = 8;
  let top = r.top; if (top + hh > window.innerHeight - 8) top = window.innerHeight - hh - 8; if (top < 8) top = 8;
  hoverEl.style.left = Math.round(left) + 'px'; hoverEl.style.top = Math.round(top) + 'px';
}
function hoverHtml(p: PrItem, d?: PrDetail, failed = false): string {
  const pp = p.provider || provider, st = (d?.state || p.state || prState).toLowerCase();
  const meta: string[] = [];
  if (p.repo) meta.push(`<div><span class="src-dot ${PROV_DOT[pp]}"></span> ${esc(p.repo)}</div>`);
  const author = d?.author || p.author; if (author) meta.push(`<div>✍ ${esc(author)}</div>`);
  meta.push(`<div>⎇ ${esc(d?.sourceBranch || p.branch)}${d?.baseBranch ? ` → ${esc(d.baseBranch)}` : ''}</div>`);
  if (d?.mergeState === 'conflict') meta.push(`<div class="prh-conflict">⚠ merge conflict — needs resolution</div>`);
  else if (d?.mergeState === 'clean') meta.push(`<div class="prh-clean">✓ no merge conflicts</div>`);
  if (d?.createdAt) meta.push(`<div class="prh-upd">opened ${esc(relTime(d.createdAt))}</div>`);
  const upd = d?.updatedAt || p.updatedAt; if (upd) meta.push(`<div class="prh-upd">updated ${esc(relTime(upd))}</div>`);
  const labels = d?.labels?.length ? `<div class="prh-labels">${d.labels.map((l) => `<span class="prh-lab">${esc(l)}</span>`).join('')}</div>` : '';
  const revs = d?.reviewers?.length ? `<div class="prh-rev">reviewers: ${esc(d.reviewers.join(', '))}</div>` : '';
  const body = d
    ? (d.body.trim() ? `<div class="prh-body">${esc(d.body)}</div>` : '<div class="prh-body empty">No description.</div>')
    : failed ? '<div class="prh-body empty">Couldn’t load the description.</div>'
    : '<div class="prh-body loading"><span class="isr-mspin"></span> loading details…</div>';
  return `<div class="prh-top"><span class="prh-num">#${p.number}</span><span class="pr-badge st ${esc(st)}">${esc(st)}</span>${(d?.draft ?? p.draft) ? '<span class="pr-badge draft">draft</span>' : ''}<button class="prh-review" data-prreview="1" title="Review this ${pp === 'gitlab' ? 'MR' : 'PR'} with a pipeline">⚡ Review</button>${(d?.mergeState === 'conflict' && st === 'open') ? '<button class="prh-resolve" data-prresolve="1" title="Resolve the merge conflict in a terminal">⚔ Resolve</button>' : ''}</div>
    <div class="prh-title">${esc(d?.title || p.title || '(no title)')}</div>
    <div class="prh-meta">${meta.join('')}</div>
    ${labels}${revs}${body}
    <div class="prh-hint">click to open on ${esc(PROV_NAME[pp])} ↗</div>`;
}
function showPrHover(p: PrItem, row: HTMLElement): void {
  if (hoverHideT) { clearTimeout(hoverHideT); hoverHideT = null; }
  if (hoverFetchT) { clearTimeout(hoverFetchT); hoverFetchT = null; }
  const el = ensureHoverEl();
  const key = prKey(p); hoverKey = key; hoverRow = row; hoverUrl = p.url; hoverPr = p;
  el.innerHTML = hoverHtml(p, detailCache.get(key)); el.scrollTop = 0; el.style.display = 'block';
  positionHover(row);
  if (!detailCache.has(key)) hoverFetchT = window.setTimeout(() => { if (hoverKey === key) void fetchDetail(p, key); }, 180);
}
async function fetchDetail(p: PrItem, key: string): Promise<void> {
  const ws = wsKey(), pp = p.provider || provider, pr = p.repo || repo; if (!pr) return;
  const res = await relay.providerPrDetail(ws, pp, pr, p.number).catch(() => null);
  const shown = hoverKey === key && hoverEl && hoverEl.style.display === 'block' && hoverRow;
  if (!res || !res.ok || !res.detail) {
    if (shown) { const top = hoverEl!.scrollTop; hoverEl!.innerHTML = hoverHtml(p, undefined, true); hoverEl!.scrollTop = top; } // failed → drop the spinner
    return;
  }
  detailCache.set(key, res.detail as PrDetail);
  if (shown) {
    const top = hoverEl!.scrollTop; hoverEl!.innerHTML = hoverHtml(p, res.detail as PrDetail); hoverEl!.scrollTop = top; positionHover(hoverRow!);
  }
}
function scheduleHidePrHover(): void { if (hoverHideT) clearTimeout(hoverHideT); hoverHideT = window.setTimeout(hidePrHover, 220); }
function hidePrHover(): void { if (hoverHideT) { clearTimeout(hoverHideT); hoverHideT = null; } if (hoverEl) hoverEl.style.display = 'none'; hoverKey = ''; }

/* ----------------------------- review assignment (per-PR pipeline) ----------------------------- */
// A PR's provider/repo (its own in All-repos scope, else the rail's active pick) + where to review it from.
const prProvider = (p: PrItem): ProviderId => p.provider || provider;
const prRepo = (p: PrItem): string => p.repo || repo || '';
const prRefOf = (p: PrItem): PrRef => ({ number: p.number, title: p.title, branch: p.branch, url: p.url, provider: prProvider(p), repo: prRepo(p) });
const prCtxOf = (p: PrItem): PrCtx => ({ provider: prProvider(p), repo: prRepo(p), dir: state.settings.workspace || '' });

/* ----------------------------- conflict detection + resolve stage ----------------------------- */
const SWEEP_CAP = 30;          // cap the per-load detail burst; PRs past it fill in on hover
// The PR LIST endpoint carries no mergeability, so detect conflicts by fetching each loaded OPEN PR's detail —
// bounded (4 workers, ≤SWEEP_CAP per load) + cached in detailCache, then re-render so conflicted rows get a ⚠
// badge + ⚔ resolve action. Runs ONLY on an explicit load (the PR rail has no background poll), so it never
// drains the rate limit on its own; conditional requests make re-sweeps free (304). Skips All-repos, closed PRs,
// and Bitbucket (no mergeable field). Re-fetches 'unknown' entries (GitHub computes mergeability lazily).
// No overlap guard needed: it's seq-guarded (a stale sweep stops + won't render) and cache-guarded (`needs`), and
// a duplicate fetch is a free 304 — a hard "one at a time" flag would instead SKIP a rapid second load's sweep.
async function sweepMergeStatus(seq: number, retry = 0): Promise<void> {
  if (prScope === 'all' || prState !== 'open' || !repo || provider === 'bitbucket') return;
  // Re-check anything not confirmed 'clean' (missing / unknown / conflict) so a resolved conflict clears its badge
  // and a still-computing PR resolves; keep 'clean' PRs (the bulk) cached. An unchanged re-check is a free 304.
  const needs = (p: PrItem): boolean => { const d = detailCache.get(prKey(p)); return !d || d.mergeState !== 'clean'; };
  const targets = prs.filter(needs).slice(0, SWEEP_CAP);
  if (!targets.length) return;
  const rl = await relay.providerRateLimit().catch(() => null); if (rl?.limited) return;   // don't pile detail calls onto a rate-limited token
  if (seq !== loadSeq) return;                                  // state may have changed during the await
  const ws = wsKey(); let i = 0; let got = false;
  const worker = async (): Promise<void> => {
    while (i < targets.length && seq === loadSeq) {
      const p = targets[i++]; const key = prKey(p);
      const res = await relay.providerPrDetail(ws, p.provider || provider, p.repo || repo!, p.number).catch(() => null);
      if (res && res.ok && res.detail) { detailCache.set(key, res.detail as PrDetail); got = true; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()));
  if (seq !== loadSeq) return;                                  // a newer load superseded this sweep
  if (got && phase === 'ready') render();                       // reveal the freshly-detected conflict badges
  // GitHub computes mergeability lazily, so a first fetch can return 'unknown'. Retry ONCE after a beat so
  // conflicts surface without the user reloading (conditional requests keep the retry a cheap 304).
  if (retry < 1 && provider === 'github' && prs.some((p) => detailCache.get(prKey(p))?.mergeState === 'unknown'))
    window.setTimeout(() => { if (seq === loadSeq) void sweepMergeStatus(seq, retry + 1); }, 2500);
}

// Open the conflict-resolution stage for a PR: check out its source branch into a worktree with the base merged
// in (conflict live), then open a terminal there to resolve → commit → push. Needs the base branch (from the
// cached/fetched detail).
let resolving = false;   // guards the whole flow (incl. the base fetch) so a double-click can't open two terminals
async function resolvePr(p: PrItem): Promise<void> {
  if (resolving) return;
  resolving = true;
  try {
    const prov = prProvider(p), r = prRepo(p), num = p.number, word = PR_WORD[prov];
    let base = detailCache.get(prKey(p))?.baseBranch || '';
    if (!base) {   // detail not fetched yet (e.g. clicked before the sweep reached it) → fetch it now for the base branch
      const d = await relay.providerPrDetail(wsKey(), prov, r, num).catch(() => null);
      if (d && d.ok && d.detail) { detailCache.set(prKey(p), d.detail as PrDetail); base = d.detail.baseBranch || ''; }
    }
    if (!base) { toast(`Couldn't determine the base branch for ${word} #${num}`); return; }
    toast(`Preparing a conflict worktree for ${word} #${num}…`, true);
    const res = await relay.prResolveWorktree(prov, r, state.settings.workspace || '', num, p.branch, base).catch(() => ({ ok: false, error: 'Resolve failed' }));
    if (!res.ok || !res.path) { toast(res.error || `Couldn't prepare the conflict worktree for ${word} #${num}`); return; }
    deps.openAgentTab({ cwd: res.path, name: `${word} #${num} · resolve`, runCmd: 'git status' });   // surface the conflicted files on open
    const n = res.conflicts?.length || 0;
    // The worktree branch is `pr-<n>` but its upstream is origin/<source> — a bare `git push` refuses on the name
    // mismatch (push.default=simple), so hand the user the explicit refspec that actually updates the PR.
    const pushCmd = res.pushable ? `git push origin HEAD:${p.branch}` : '';
    if (res.dirty) toast(`${word} #${num}: worktree has uncommitted changes — opened as-is (didn't merge ${base})`);
    else if (res.clean) toast(res.pushable ? `${word} #${num}: ${base} merged cleanly — no conflicts. Push to update: ${pushCmd}` : `${word} #${num}: ${base} merged cleanly — no conflicts.`, true);
    else toast(res.pushable ? `${word} #${num}: ${n} conflicted file${n === 1 ? '' : 's'} — resolve & commit, then: ${pushCmd}` : `${word} #${num}: ${n} conflicted file${n === 1 ? '' : 's'} — resolve & commit (push needs the source repo/fork)`, true);
  } finally { resolving = false; }
}

/* ----------------------------- repo + author pickers ----------------------------- */
// The PR rail's OWN repo picker (mirrors the Issues rail menu) — picks from the tracked repos, sets prRepoByWs.
function closePrRepoMenu(): void { document.getElementById('prRepoMenu')?.remove(); }
function openPrRepoMenu(): void {
  const btn = $('#prSideRepo'); if (!btn) return;
  if (document.getElementById('prRepoMenu')) { closePrRepoMenu(); return; }
  const active = prRepoFor();
  const tracked = (state.settings.issueReposByWs || {})[wsKey()] || [];
  const folderRow = `<button class="iss-mi ${!active ? 'on' : ''}" data-repo=""><span class="d">⌂</span> This folder’s repo</button>`;
  const repoRows = tracked.map((id) => { const { provider: p, repo: r } = parseRepoId(id); return `<button class="iss-mi ${active === id ? 'on' : ''}" data-repo="${esc(id)}"><span class="d src-dot ${PROV_DOT[p]}"></span> ${esc(r)}</button>`; }).join('');
  const menu = document.createElement('div'); menu.className = 'iss-menu'; menu.id = 'prRepoMenu';
  menu.innerHTML = folderRow + (repoRows ? `<div class="iss-menu-list">${repoRows}</div>` : '') + '<div class="iss-msep"></div><button class="iss-mi" data-sources="1"><span class="d">⚙</span> Manage repos in Sources…</button>';
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect(); menu.style.left = Math.round(r.left) + 'px'; menu.style.top = Math.round(r.bottom + 4) + 'px';
  menu.querySelectorAll<HTMLElement>('.iss-mi').forEach((mi) => {
    mi.onclick = async (e) => {
      e.stopPropagation();
      if (mi.dataset.sources) { closePrRepoMenu(); deps.focusIssues(); return; } // Sources (connect/track) lives in the Issues rail
      closePrRepoMenu();
      activeAuthors.clear();                    // a different repo has different authors → clear the filter
      await setPrRepo(mi.dataset.repo || '');   // persist FIRST so loadPrs reads the new pick
      void loadPrs();
    };
  });
  setTimeout(() => document.addEventListener('click', closePrRepoMenu, { once: true }), 0);
}
// The author filter — a multi-select checklist of repo members ∪ loaded PR authors.
function openPrAuthorMenu(): void {
  const btn = $('#prAuthor'); if (!btn) return;
  openAuthorFilter(btn as HTMLElement, authorOptions(), activeAuthors, onAuthorsChanged, 'prAuthorMenu');
}
// A toggle re-queries the provider server-side (repo scope), debounced so ticking several authors fires ONE
// fetch. render() first, for an instant badge + a client-filtered preview of the already-loaded set.
function onAuthorsChanged(): void {
  render();
  if (prScope === 'all') return;                    // All-repos filters client-side over the merged set — no refetch
  if (authorReloadT) clearTimeout(authorReloadT);
  authorReloadT = window.setTimeout(() => { authorReloadT = null; void loadPrs(); }, 300);
}

/* ----------------------------- render ----------------------------- */
function render(): void {
  hidePrHover();  // a re-render recreates the rows, so drop any stale hover card
  const allMode = prScope === 'all';
  const word = allMode ? 'PR' : PR_WORD[provider], name = PROV_NAME[provider];
  const repoEl = $('#prSideRepo');
  if (repoEl) repoEl.textContent = (allMode ? `All tracked · ${prs.length} ${prState}` : (repo ? `${repo} · ${prs.length}${prsHasMore ? '+' : ''} ${prState}` : 'No repo')) + ' ▾';
  // Scope toggle (This repo / All repos) always reflects state; the Open/Closed toggle shows once there's something to scope.
  const scopeEl = $('#prScope');
  if (scopeEl) scopeEl.querySelectorAll<HTMLElement>('.iss-seg').forEach((b) => b.classList.toggle('on', b.dataset.sc === prScope));
  const stateEl = $('#prState');
  if (stateEl) {
    (stateEl as HTMLElement).style.display = ((allMode || repo) && phase !== 'noauth' && phase !== 'norepo') ? '' : 'none';
    stateEl.querySelectorAll<HTMLElement>('.iss-seg').forEach((b) => b.classList.toggle('on', b.dataset.st === prState));
  }
  const authorEl = $('#prAuthor'); // the author-filter icon — shown once there are PRs to filter; badge = # selected
  if (authorEl) {
    // Keep it visible while a filter is active (even mid-reload, or when the filter returns 0) so it's always clearable.
    (authorEl as HTMLElement).style.display = ((phase === 'ready' && prs.length > 0) || activeAuthors.size > 0) ? '' : 'none';
    authorEl.classList.toggle('on', activeAuthors.size > 0);
    authorEl.setAttribute('data-n', activeAuthors.size ? String(activeAuthors.size) : '');
    authorEl.setAttribute('title', activeAuthors.size ? `Filtering by ${activeAuthors.size} author${activeAuthors.size > 1 ? 's' : ''}` : 'Filter by author');
  }
  const el = $('#prList'); if (!el) return;
  const hint = (icon: string, msg: string, sub = '') =>
    `<div class="isr-empty"><div class="isr-ei">${icon}</div><div>${msg}</div>${sub ? `<div class="isr-es">${sub}</div>` : ''}</div>`;

  if (phase === 'loading') { el.innerHTML = `<div class="isr-empty"><div class="isr-spin"></div><div>Loading ${word}s…</div></div>`; return; }
  if (phase === 'idle')    { el.innerHTML = hint('🔀', `No ${word}s pulled`, 'Hit ⟳ to load pull requests.'); return; }
  if (phase === 'noauth')  { el.innerHTML = hint('🔗', `Not connected to ${esc(name)}`, 'Connect it in the Issues rail → Sources.'); return; }
  if (phase === 'norepo')  { el.innerHTML = hint('🗂️', allMode ? 'No tracked repos' : 'No repo selected', esc(errMsg) || 'Pick a repo in the Issues rail (its repo is shared here).'); return; }
  if (phase === 'error')   { el.innerHTML = hint('⚠️', `Couldn’t list ${word}s`, esc(errMsg)); return; }
  if (!prs.length)         { el.innerHTML = (activeAuthors.size && !allMode)
      ? hint('✍', `No ${prState} ${word}s by the selected author${activeAuthors.size > 1 ? 's' : ''}`, 'Clear the author filter (✍) to see all.')
      : hint('✓', `No ${prState} ${word}s`, allMode ? 'across your tracked repos' : (repo ? esc(repo) : '')); return; }
  const shown = visiblePrs();
  if (!shown.length)       { el.innerHTML = hint('✍', `No ${prState} ${word}s by the selected author${activeAuthors.size > 1 ? 's' : ''}`, 'Clear the author filter (✍) to see all.'); return; }

  el.innerHTML = shown.map((p) => {
    const pp = p.provider || provider;
    const st = (p.state || prState).toLowerCase();
    const runSt = prStatusOf(pp, p.repo || repo || '', p.number);   // review-pipeline status for this PR
    const conflict = st === 'open' && mergeStateOf(p) === 'conflict';  // only open PRs are resolvable
    const wd = pp === 'gitlab' ? 'MR' : 'PR';
    return `<div class="pr-row${conflict ? ' conflict' : ''}" data-url="${esc(p.url)}">
      <div class="pr-hash">#${p.number}</div>
      <div class="pr-body">
        <div class="pr-title">${esc(p.title || '(no title)')}</div>
        <div class="pr-meta">${p.repo ? `<span class="pr-repo-lbl"><span class="src-dot ${PROV_DOT[pp]}"></span>${esc(p.repo)}</span>` : ''}<span class="pr-branch" title="source branch">⎇ ${esc(p.branch)}</span>${p.author ? `<span class="pr-author">${esc(p.author)}</span>` : ''}</div>
      </div>
      <div class="pr-side">
        ${runSt !== 'idle' ? `<span class="pr-run ${runSt}" data-prrun="1" title="Review: ${esc(PR_STATUS_LABEL[runSt] || runSt)} — click to manage">${esc(PR_STATUS_LABEL[runSt] || runSt)}</span>` : ''}
        ${conflict ? `<span class="pr-badge conflict" title="This ${wd} has merge conflicts">⚠ conflict</span><button class="pr-resolve" data-prresolve="1" title="Resolve the merge conflict in a terminal">⚔</button>` : ''}
        ${p.draft ? '<span class="pr-badge draft">draft</span>' : ''}
        <span class="pr-badge st ${esc(st)}">${esc(st)}</span>
        <button class="pr-assign" data-prasg="1" title="Review this ${wd} with a pipeline">⚡</button>
        <span class="pr-ext">↗</span>
      </div>
    </div>`;
  }).join('') + (loadingMore
      ? `<div class="isr-more"><span class="isr-mspin"></span>Loading more…</div>`
      : prsHasMore ? `<div class="isr-more">Scroll to load more…</div>`
      : (activeAuthors.size && !allMode) ? `<div class="isr-more">recent ${word}s by the selected author${activeAuthors.size > 1 ? 's' : ''}</div>`
      : allMode ? `<div class="isr-more">recent ${word}s per repo</div>` : '');

  el.querySelectorAll<HTMLElement>('.pr-row').forEach((row, i) => {
    const p = shown[i];                                           // querySelectorAll order matches the shown map order
    row.onclick = () => { const u = row.dataset.url; if (u) relay.openExternal(u); };
    row.onmouseenter = () => { if (p) showPrHover(p, row); };
    row.onmouseleave = scheduleHidePrHover;   // delayed so moving into the (scrollable) card keeps it open
    // ⚡ opens the review-pipeline assignment; the status chip manages a live run — both stop the row's open-in-provider.
    const asg = row.querySelector<HTMLElement>('[data-prasg]');
    if (asg) asg.onclick = (e) => { e.stopPropagation(); hidePrHover(); if (p) void openPrAssign(prRefOf(p), prCtxOf(p)); };
    const chip = row.querySelector<HTMLElement>('[data-prrun]');
    if (chip) chip.onclick = (e) => { e.stopPropagation(); if (p) onPrChip(prProvider(p), prRepo(p), p.number); };
    const res = row.querySelector<HTMLElement>('[data-prresolve]');   // ⚔ open the conflict-resolution terminal
    if (res) res.onclick = (e) => { e.stopPropagation(); hidePrHover(); if (p) void resolvePr(p); };
  });
}

/* ----------------------------- wire-up ----------------------------- */
export function initPrs(d: PrsDeps): void {
  deps = d;
  initPrReview({ activeWsId: d.activeWsId, openAgentTab: d.openAgentTab, refresh: () => render() });
  const rsel = $('#prSideRepo'); if (rsel) rsel.onclick = (e) => { e.stopPropagation(); openPrRepoMenu(); }; // the PR rail's OWN repo picker (no longer jumps to Issues)
  const asel = $('#prAuthor'); if (asel) asel.onclick = (e) => { e.stopPropagation(); openPrAuthorMenu(); };
  const pull = $('#prPull'); if (pull) pull.onclick = () => void loadPrs();
  const map = $('#prMap'); if (map) map.onclick = () => {
    if (phase !== 'ready' || !prs.length) { toast('Pull some pull requests first'); return; }
    void openPrMap(prs.map(prRefOf), { provider, repo: repo || '', dir: state.settings.workspace || '' });
  };
  $('#prScope')?.querySelectorAll<HTMLElement>('.iss-seg').forEach((b) => {
    b.onclick = () => { const s = b.dataset.sc === 'all' ? 'all' : 'repo'; if (s === prScope) return; prScope = s; activeAuthors.clear(); void loadPrs(); };
  });
  $('#prState')?.querySelectorAll<HTMLElement>('.iss-seg').forEach((b) => {
    b.onclick = () => { const s = b.dataset.st === 'closed' ? 'closed' : 'open'; if (s === prState) return; prState = s; void loadPrs(); };
  });
  const listEl = $('#prList');
  if (listEl) listEl.addEventListener('scroll', () => { if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 240) void loadMorePrs(); });
  render();
}
