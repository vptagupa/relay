// PR Agent — Pull Requests as a sidebar rail (a peer of Issues). Lists the ACTIVE repo's PRs/MRs by state
// (Open / Closed) with infinite scroll; each row links out to the PR on its provider. Read-only.
//
// It SHARES the Issues rail's active repo — the explicit per-workspace pick in `issueRepoByWs`, else inferred
// from the open folder's git remote — and the same per-workspace provider connections. The renderer only ever
// sees { connected, login } + normalized PRs (tokens stay in main). DI-seam module: initPrs(deps).

import { state } from './state';
import { $, esc } from './dom';
import { toast } from './ui';
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

/* ----------------------------- load ----------------------------- */
// Load PRs for the current scope: the single shared active repo, or every tracked repo merged.
export async function loadPrs(): Promise<void> {
  const seq = ++loadSeq;
  const ws = wsKey();
  phase = 'loading'; render();
  if (prScope === 'all') { await loadAllRepos(seq, ws); return; }
  const dir = state.settings.workspace || '';
  const pick = (state.settings.issueRepoByWs || {})[ws] || '';
  if (pick) { const p = parseRepoId(pick); provider = p.provider; repo = p.repo; }
  else {
    const inf = dir ? await relay.providerRepoFromRemote(dir).catch(() => null) : null; if (seq !== loadSeq) return;
    provider = inf?.provider || 'github'; repo = inf?.repo || null;
  }
  const auth = await relay.providerAuthState(ws, provider); if (seq !== loadSeq) return;
  if (!auth.connected) { phase = 'noauth'; render(); return; }
  if (!repo) { phase = 'norepo'; render(); return; }
  prsPage = 1; prsHasMore = false; loadingMore = false;
  const r = await relay.providerPrs(ws, provider, repo, prState, 1); if (seq !== loadSeq) return;
  if (!r.ok) { phase = 'error'; errMsg = r.error || `Could not list ${PR_WORD[provider]}s`; render(); return; }
  prs = r.prs || []; prsHasMore = !!r.hasMore; phase = 'ready'; render();
  maybeAutoFill();
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
interface PrDetail { number: number; title: string; body: string; state: string; draft: boolean; url: string; author?: string; sourceBranch: string; baseBranch: string; labels: string[]; reviewers: string[]; createdAt?: number; updatedAt?: number; }
const detailCache = new Map<string, PrDetail>();
const prKey = (p: PrItem) => `${p.provider || provider}:${p.repo || repo}#${p.number}`;

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
  if (d?.createdAt) meta.push(`<div class="prh-upd">opened ${esc(relTime(d.createdAt))}</div>`);
  const upd = d?.updatedAt || p.updatedAt; if (upd) meta.push(`<div class="prh-upd">updated ${esc(relTime(upd))}</div>`);
  const labels = d?.labels?.length ? `<div class="prh-labels">${d.labels.map((l) => `<span class="prh-lab">${esc(l)}</span>`).join('')}</div>` : '';
  const revs = d?.reviewers?.length ? `<div class="prh-rev">reviewers: ${esc(d.reviewers.join(', '))}</div>` : '';
  const body = d
    ? (d.body.trim() ? `<div class="prh-body">${esc(d.body)}</div>` : '<div class="prh-body empty">No description.</div>')
    : failed ? '<div class="prh-body empty">Couldn’t load the description.</div>'
    : '<div class="prh-body loading"><span class="isr-mspin"></span> loading details…</div>';
  return `<div class="prh-top"><span class="prh-num">#${p.number}</span><span class="pr-badge st ${esc(st)}">${esc(st)}</span>${(d?.draft ?? p.draft) ? '<span class="pr-badge draft">draft</span>' : ''}<button class="prh-review" data-prreview="1" title="Review this ${pp === 'gitlab' ? 'MR' : 'PR'} with a pipeline">⚡ Review</button></div>
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
  const el = $('#prList'); if (!el) return;
  const hint = (icon: string, msg: string, sub = '') =>
    `<div class="isr-empty"><div class="isr-ei">${icon}</div><div>${msg}</div>${sub ? `<div class="isr-es">${sub}</div>` : ''}</div>`;

  if (phase === 'loading') { el.innerHTML = `<div class="isr-empty"><div class="isr-spin"></div><div>Loading ${word}s…</div></div>`; return; }
  if (phase === 'idle')    { el.innerHTML = hint('🔀', `No ${word}s pulled`, 'Hit ⟳ to load pull requests.'); return; }
  if (phase === 'noauth')  { el.innerHTML = hint('🔗', `Not connected to ${esc(name)}`, 'Connect it in the Issues rail → Sources.'); return; }
  if (phase === 'norepo')  { el.innerHTML = hint('🗂️', allMode ? 'No tracked repos' : 'No repo selected', esc(errMsg) || 'Pick a repo in the Issues rail (its repo is shared here).'); return; }
  if (phase === 'error')   { el.innerHTML = hint('⚠️', `Couldn’t list ${word}s`, esc(errMsg)); return; }
  if (!prs.length)         { el.innerHTML = hint('✓', `No ${prState} ${word}s`, allMode ? 'across your tracked repos' : (repo ? esc(repo) : '')); return; }

  el.innerHTML = prs.map((p) => {
    const pp = p.provider || provider;
    const st = (p.state || prState).toLowerCase();
    const runSt = prStatusOf(pp, p.repo || repo || '', p.number);   // review-pipeline status for this PR
    return `<div class="pr-row" data-url="${esc(p.url)}">
      <div class="pr-hash">#${p.number}</div>
      <div class="pr-body">
        <div class="pr-title">${esc(p.title || '(no title)')}</div>
        <div class="pr-meta">${p.repo ? `<span class="pr-repo-lbl"><span class="src-dot ${PROV_DOT[pp]}"></span>${esc(p.repo)}</span>` : ''}<span class="pr-branch" title="source branch">⎇ ${esc(p.branch)}</span>${p.author ? `<span class="pr-author">${esc(p.author)}</span>` : ''}</div>
      </div>
      <div class="pr-side">
        ${runSt !== 'idle' ? `<span class="pr-run ${runSt}" data-prrun="1" title="Review: ${esc(PR_STATUS_LABEL[runSt] || runSt)} — click to manage">${esc(PR_STATUS_LABEL[runSt] || runSt)}</span>` : ''}
        ${p.draft ? '<span class="pr-badge draft">draft</span>' : ''}
        <span class="pr-badge st ${esc(st)}">${esc(st)}</span>
        <button class="pr-assign" data-prasg="1" title="Review this ${pp === 'gitlab' ? 'MR' : 'PR'} with a pipeline">⚡</button>
        <span class="pr-ext">↗</span>
      </div>
    </div>`;
  }).join('') + (loadingMore
      ? `<div class="isr-more"><span class="isr-mspin"></span>Loading more…</div>`
      : prsHasMore ? `<div class="isr-more">Scroll to load more…</div>`
      : allMode ? `<div class="isr-more">recent ${word}s per repo</div>` : '');

  el.querySelectorAll<HTMLElement>('.pr-row').forEach((row, i) => {
    const p = prs[i];                                              // querySelectorAll order matches the prs map order
    row.onclick = () => { const u = row.dataset.url; if (u) relay.openExternal(u); };
    row.onmouseenter = () => { if (p) showPrHover(p, row); };
    row.onmouseleave = scheduleHidePrHover;   // delayed so moving into the (scrollable) card keeps it open
    // ⚡ opens the review-pipeline assignment; the status chip manages a live run — both stop the row's open-in-provider.
    const asg = row.querySelector<HTMLElement>('[data-prasg]');
    if (asg) asg.onclick = (e) => { e.stopPropagation(); hidePrHover(); if (p) void openPrAssign(prRefOf(p), prCtxOf(p)); };
    const chip = row.querySelector<HTMLElement>('[data-prrun]');
    if (chip) chip.onclick = (e) => { e.stopPropagation(); if (p) onPrChip(prProvider(p), prRepo(p), p.number); };
  });
}

/* ----------------------------- wire-up ----------------------------- */
export function initPrs(d: PrsDeps): void {
  deps = d;
  initPrReview({ activeWsId: d.activeWsId, openAgentTab: d.openAgentTab, refresh: () => render() });
  const rsel = $('#prSideRepo'); if (rsel) rsel.onclick = (e) => { e.stopPropagation(); deps.focusIssues(); }; // repo is picked in the Issues rail
  const pull = $('#prPull'); if (pull) pull.onclick = () => void loadPrs();
  const map = $('#prMap'); if (map) map.onclick = () => {
    if (phase !== 'ready' || !prs.length) { toast('Pull some pull requests first'); return; }
    void openPrMap(prs.map(prRefOf), { provider, repo: repo || '', dir: state.settings.workspace || '' });
  };
  $('#prScope')?.querySelectorAll<HTMLElement>('.iss-seg').forEach((b) => {
    b.onclick = () => { const s = b.dataset.sc === 'all' ? 'all' : 'repo'; if (s === prScope) return; prScope = s; void loadPrs(); };
  });
  $('#prState')?.querySelectorAll<HTMLElement>('.iss-seg').forEach((b) => {
    b.onclick = () => { const s = b.dataset.st === 'closed' ? 'closed' : 'open'; if (s === prState) return; prState = s; void loadPrs(); };
  });
  const listEl = $('#prList');
  if (listEl) listEl.addEventListener('scroll', () => { if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 240) void loadMorePrs(); });
  render();
}
