// Notifications — a background poller that watches EVERY workspace's tracked repos for new/closed issues & PRs,
// surfaces them in a per-workspace header bell (persisted in slayert.json, so they survive restarts), and fires
// native OS push notifications. Runs entirely in the renderer over the per-workspace provider connections.
// DI-seam module: initNotifications(deps).

import { state } from './state';
import { $, esc } from './dom';
import { toast } from './ui';
import type { AppNotification } from './shared/types';

const relay = (window as any).relay;

export interface NotifDeps { activeWsId: () => string; }
let deps: NotifDeps;

type ProviderId = 'github' | 'gitlab' | 'bitbucket';
const wsKey = () => deps.activeWsId() || 'ws_default';
function parseRepoId(id: string): { provider: ProviderId; repo: string } {
  const m = /^(github|gitlab|bitbucket):(.+)$/.exec(id || '');
  return m ? { provider: m[1] as ProviderId, repo: m[2] } : { provider: 'github', repo: id };
}
function relTime(ms: number): string {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

const POLL_MS = 180000;         // 3 minutes
const FIRST_POLL_MS = 15000;    // let boot + provider connections settle before the first sweep
const CAP = 60;                 // max notifications kept per workspace
const PUSH_CAP = 5;             // max individual native notifications per poll cycle (else one summary)

const KIND_ICON: Record<AppNotification['kind'], string> = { 'new-issue': '＋', 'closed-issue': '✕', 'new-pr': '⇄', 'closed-pr': '✓' };
const KIND_LABEL: Record<AppNotification['kind'], string> = { 'new-issue': 'New issue', 'closed-issue': 'Issue closed', 'new-pr': 'New PR', 'closed-pr': 'PR closed' };
const PROV_DOT: Record<ProviderId, string> = { github: 'gh', gitlab: 'gl', bitbucket: 'bb' };
const PROV_NAME: Record<ProviderId, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };

// A minimal modal (own scrim; Escape / scrim-click closes) — same shape as the Issues rail's.
function modal(html: string, onClose?: () => void): { root: HTMLElement; close: () => void } {
  const root = document.createElement('div'); root.className = 'tpl-modal';
  root.innerHTML = `<div class="tpl-sc"></div>${html}`;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  document.body.appendChild(root);
  document.addEventListener('keydown', onKey);
  root.querySelector('.tpl-sc')?.addEventListener('click', close);
  return { root, close };
}

// Per-repo open-item snapshot, IN-MEMORY only (re-seeded on boot, so a fresh run never replays past events).
interface Item { n: number; t: string; u: string; }
// iSeen/pSeen = whether that side has been fetched successfully at least once. Detection for a side starts only
// AFTER its first success (its seeding poll), so a fetch that failed on the seeding poll can't later look "all new".
interface Snap { i: Item[]; p: Item[]; iFull: boolean; pFull: boolean; iSeen: boolean; pSeen: boolean; }
const snap = new Map<string, Snap>();   // key `${wsId} ${repoId}`
let polling = false;
let menuOpen = false;

/* ----------------------------- persistence + reads ----------------------------- */
const listFor = (ws: string): AppNotification[] => (state.settings.notificationsByWs || {})[ws] || [];
const unreadFor = (ws: string): number => listFor(ws).filter((n) => !n.read).length;
async function persist(byWs: Record<string, AppNotification[]>): Promise<void> {
  state.settings.notificationsByWs = byWs;                     // reflect immediately; persist in the background
  try { state.settings = await relay.patchSettings({ notificationsByWs: byWs }); } catch { /* keep the in-memory copy */ }
}

// Which repos does a workspace watch? An explicit list once configured (even empty), else default to its
// tracked repos. Undefined vs [] is the difference between "not yet configured" and "configured to watch none".
function watchedRepos(ws: string): string[] {
  const cfg = (state.settings.notifyReposByWs || {})[ws];
  return cfg !== undefined ? cfg : ((state.settings.issueReposByWs || {})[ws] || []);
}
function watchedWorkspaces(): string[] {
  return [...new Set([...Object.keys(state.settings.notifyReposByWs || {}), ...Object.keys(state.settings.issueReposByWs || {})])];
}

/* ----------------------------- the poll (all workspaces) ----------------------------- */
async function pollAll(): Promise<void> {
  if (polling) return; polling = true;
  try {
    const fresh: { ws: string; note: AppNotification }[] = [];
    for (const ws of watchedWorkspaces()) {
      for (const repoId of watchedRepos(ws)) {
        const events = await pollRepo(ws, repoId).catch(() => [] as AppNotification[]);
        for (const note of events) fresh.push({ ws, note });
      }
    }
    if (fresh.length) commit(fresh);
  } finally { polling = false; }
}

// Diff one repo's open issues/PRs against the last snapshot. NEW = a number strictly above the previous max
// (robust to pagination shifts); CLOSED = a previously-open number now gone, but only when we have the FULL open
// set this poll AND last poll (page not full) — otherwise a paged-out item can't be told apart from a real close.
async function pollRepo(ws: string, repoId: string): Promise<AppNotification[]> {
  const { provider, repo } = parseRepoId(repoId);
  const key = `${ws} ${repoId}`;
  const [ir, pr] = await Promise.all([
    relay.providerIssues(ws, provider, repo, 'open', 1).catch(() => ({ ok: false })),
    relay.providerPrs(ws, provider, repo, 'open', 1).catch(() => ({ ok: false })),
  ]);
  if (!ir.ok && !pr.ok) return [];                            // both not connected / errored — skip, keep last snapshot
  const curI: Item[] = ir.ok ? (ir.issues || []).map((x: { number: number; title: string; url: string }) => ({ n: x.number, t: x.title, u: x.url })) : [];
  const curP: Item[] = pr.ok ? (pr.prs || []).map((x: { number: number; title?: string; url: string }) => ({ n: x.number, t: x.title || '', u: x.url })) : [];
  const prev = snap.get(key);
  // Update only the side we actually refreshed; mark it "seen" on its first success (a failed side is never seeded).
  const next: Snap = {
    i: ir.ok ? curI : (prev?.i || []), p: pr.ok ? curP : (prev?.p || []),
    iFull: ir.ok ? !ir.hasMore : (prev?.iFull ?? false), pFull: pr.ok ? !pr.hasMore : (prev?.pFull ?? false),
    iSeen: (prev?.iSeen ?? false) || ir.ok, pSeen: (prev?.pSeen ?? false) || pr.ok,
  };
  snap.set(key, next);
  const out: AppNotification[] = [];
  const mk = (kind: AppNotification['kind'], it: Item): AppNotification => ({ id: `${kind}:${provider}:${repo}#${it.n}`, kind, provider, repo, number: it.n, title: it.t, url: it.u, ts: Date.now(), read: false });
  // Detect a side ONLY if it had a prior successful snapshot (prev.<side>Seen) — so its seeding poll is silent.
  if (ir.ok && prev?.iSeen) {
    const prevMaxI = prev.i.reduce((m, x) => Math.max(m, x.n), 0);
    for (const it of curI) if (it.n > prevMaxI) out.push(mk('new-issue', it));
    if (next.iFull && prev.iFull) { const set = new Set(curI.map((x) => x.n)); for (const it of prev.i) if (!set.has(it.n)) out.push(mk('closed-issue', it)); }
  }
  if (pr.ok && prev?.pSeen) {
    const prevMaxP = prev.p.reduce((m, x) => Math.max(m, x.n), 0);
    for (const it of curP) if (it.n > prevMaxP) out.push(mk('new-pr', it));
    if (next.pFull && prev.pFull) { const set = new Set(curP.map((x) => x.n)); for (const it of prev.p) if (!set.has(it.n)) out.push(mk('closed-pr', it)); }
  }
  return out;
}

// Add fresh events to their workspace lists (deduped, capped), persist, fire push, refresh the bell.
function commit(fresh: { ws: string; note: AppNotification }[]): void {
  const byWs: Record<string, AppNotification[]> = { ...(state.settings.notificationsByWs || {}) };
  const pushable: AppNotification[] = [];
  for (const { ws, note } of fresh) {
    const list = byWs[ws] ? [...byWs[ws]] : [];
    if (list.some((n) => n.id === note.id)) continue;         // dedupe by stable id
    list.unshift(note); byWs[ws] = list.slice(0, CAP); pushable.push(note);
  }
  if (!pushable.length) return;
  void persist(byWs);
  firePush(pushable);
  renderBell();
}

function firePush(notes: AppNotification[]): void {
  if (state.settings.issuePushNotify === false) return;      // default on
  try {
    if (notes.length <= PUSH_CAP) {
      for (const n of notes) new Notification(`${KIND_LABEL[n.kind]} · ${n.repo}`, { body: `#${n.number} ${n.title}`.trim().slice(0, 140) });
    } else {
      new Notification('Slayer T · issues & PRs', { body: `${notes.length} new updates across your repos` });
    }
  } catch { /* notifications unavailable */ }
}

/* ----------------------------- bell + dropdown (active workspace) ----------------------------- */
export function renderBell(): void {
  const n = unreadFor(wsKey());
  const badge = $('#notifBadge');
  if (badge) { badge.textContent = n > 99 ? '99+' : String(n); (badge as HTMLElement).style.display = n ? '' : 'none'; }
  if (menuOpen) renderMenu();
}
function renderMenu(): void {
  const menu = $('#notifMenu'); if (!menu) return;
  const list = listFor(wsKey());
  const rows = list.length ? list.map((it) => `<button class="nt-item${it.read ? '' : ' unread'}" data-url="${esc(it.url)}" data-id="${esc(it.id)}">
      <span class="nt-ic">${KIND_ICON[it.kind]}</span>
      <span class="nt-b"><span class="nt-t">${esc(KIND_LABEL[it.kind])} #${it.number}</span><span class="nt-s">${esc(it.title || it.repo)}</span><span class="nt-m">${esc(it.repo)} · ${esc(relTime(it.ts))}</span></span>
    </button>`).join('') : '<div class="nt-empty">No notifications yet.</div>';
  menu.innerHTML = `<div class="nt-head"><span>Notifications</span><span class="nt-acts">${list.length ? '<button class="nt-a" data-act="read">Mark all read</button><button class="nt-a" data-act="clear">Clear</button>' : ''}<button class="nt-a" data-act="settings" title="Notification settings">⚙</button></span></div><div class="nt-list">${rows}</div>`;
  menu.querySelectorAll<HTMLElement>('.nt-item').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); markRead(b.dataset.id!); const u = b.dataset.url; if (u) relay.openExternal(u); toggleMenu(false); }; });
  menu.querySelector<HTMLElement>('[data-act="read"]')?.addEventListener('click', (e) => { e.stopPropagation(); markAllRead(); });
  menu.querySelector<HTMLElement>('[data-act="clear"]')?.addEventListener('click', (e) => { e.stopPropagation(); clearAll(); });
  menu.querySelector<HTMLElement>('[data-act="settings"]')?.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(false); openNotifSettings(); });
}
function markRead(id: string): void {
  const ws = wsKey(); const byWs = { ...(state.settings.notificationsByWs || {}) };
  byWs[ws] = (byWs[ws] || []).map((n) => (n.id === id ? { ...n, read: true } : n)); void persist(byWs); renderBell();
}
function markAllRead(): void {
  const ws = wsKey(); const byWs = { ...(state.settings.notificationsByWs || {}) };
  byWs[ws] = (byWs[ws] || []).map((n) => ({ ...n, read: true })); void persist(byWs); renderBell();
}
function clearAll(): void {
  const ws = wsKey(); const byWs = { ...(state.settings.notificationsByWs || {}) };
  byWs[ws] = []; void persist(byWs); renderBell(); toggleMenu(false);
}
function toggleMenu(open?: boolean): void {
  const menu = $('#notifMenu'); const bell = $('#notifBell'); if (!menu || !bell) return;
  menuOpen = open === undefined ? !menuOpen : open;
  if (menuOpen) {
    renderMenu();
    const r = bell.getBoundingClientRect();
    (menu as HTMLElement).style.top = Math.round(r.bottom + 6) + 'px';
    (menu as HTMLElement).style.right = Math.round(window.innerWidth - r.right) + 'px';
    menu.classList.add('show');
    setTimeout(() => document.addEventListener('click', closeOnOutside, { once: true }), 0);
  } else {
    menu.classList.remove('show');
  }
}
function closeOnOutside(): void { toggleMenu(false); }  // menu-internal clicks stopPropagation, so this only fires for outside clicks

/* ----------------------------- settings dialog ----------------------------- */
async function persistWatched(ws: string, repos: string[]): Promise<void> {
  const byWs = { ...(state.settings.notifyReposByWs || {}) }; byWs[ws] = repos;
  try { state.settings = await relay.patchSettings({ notifyReposByWs: byWs }); } catch { /* keep in-memory */ }
}
// Load the active workspace's repos from ONE provider (same source as Sources' "Load my repos"). Returns
// qualified ids ("provider:owner/repo"), or [] if not connected / no access.
async function loadWsRepos(ws: string, provider: ProviderId): Promise<string[]> {
  const bbWs = (state.settings.bitbucketWorkspacesByWs || {})[ws];
  const r = await relay.providerRepos(ws, provider, provider === 'bitbucket' ? bbWs : undefined).catch(() => ({ ok: false }));
  if (!r.ok || !r.repos) return [];
  return r.repos.map((rp: { repo: string }) => `${provider}:${rp.repo}`);
}
// Push on/off + which repos to watch for THIS workspace — laid out like Sources: one section per provider,
// each with its own "Load my repos" and a repo checklist. Defaults to the workspace's tracked repos until you
// change it. Ticking a repo watches it; loading a provider adds its full repo list so you can watch any of them.
const PROVS_ALL: ProviderId[] = ['github', 'gitlab', 'bitbucket'];
function openNotifSettings(): void {
  const ws = wsKey();
  const tracked = (state.settings.issueReposByWs || {})[ws] || [];
  const watched = new Set(watchedRepos(ws));
  // Available repos per provider, seeded from tracked + already-watched (so they show pre-checked without loading).
  const avail: Record<ProviderId, Set<string>> = { github: new Set(), gitlab: new Set(), bitbucket: new Set() };
  for (const id of [...tracked, ...watched]) { const { provider } = parseRepoId(id); if (avail[provider]) avail[provider].add(id); }
  const loading: Record<string, boolean> = {};

  const sectionHtml = (p: ProviderId): string => `<div class="src-prov">
      <div class="src-row"><span class="src-nm"><span class="src-dot ${PROV_DOT[p]}"></span> ${PROV_NAME[p]}</span></div>
      <div class="src-repos"><button class="tpl-btn ghost" data-load="${p}">Load my repos</button><div class="ns-plist" id="nsList-${p}"></div></div>
    </div>`;
  const { root, close } = modal(`<div class="tpl-card iss-card ns-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Notification settings<small>this workspace · new / closed issues &amp; PRs</small></span></div>
      <div class="bd">
        <label class="chk ns-push"><input type="checkbox" id="nsPush"${state.settings.issuePushNotify !== false ? ' checked' : ''}> Push notifications — native OS toasts when something changes</label>
        <div class="ns-lbl">Repositories to watch</div>
        <div class="ns-provs">${PROVS_ALL.map(sectionHtml).join('')}</div>
      </div>
      <div class="ft"><span class="hint">Polled every ~3 min. Only checked repos notify (bell + push).</span><span class="r"><button class="tpl-btn pri" data-x>Done</button></span></div>
    </div>`);

  const renderList = (p: ProviderId): void => {
    const box = root.querySelector(`#nsList-${p}`) as HTMLElement | null; if (!box) return;
    const ids = [...avail[p]].sort();
    box.innerHTML = ids.length
      ? `<div class="src-list">${ids.map((id) => `<label class="src-item"><input type="checkbox" data-repo="${esc(id)}"${watched.has(id) ? ' checked' : ''}><span class="src-r">${esc(parseRepoId(id).repo)}</span></label>`).join('')}</div>`
      : '';
    box.querySelectorAll<HTMLInputElement>('input[data-repo]').forEach((cb) => {
      cb.onchange = () => { const id = cb.dataset.repo!; if (cb.checked) watched.add(id); else watched.delete(id); void persistWatched(ws, [...watched]); };
    });
  };
  for (const p of PROVS_ALL) renderList(p);

  root.querySelector('[data-x]')?.addEventListener('click', close);
  (root.querySelector('#nsPush') as HTMLInputElement).addEventListener('change', async (e) => {
    state.settings = await relay.patchSettings({ issuePushNotify: (e.target as HTMLInputElement).checked });
    const main = document.getElementById('notifyIssuesSet') as HTMLInputElement | null; if (main) main.checked = (e.target as HTMLInputElement).checked; // keep the main Settings toggle in sync
  });
  root.querySelectorAll<HTMLElement>('[data-load]').forEach((b) => {
    b.onclick = async () => {
      const p = b.dataset.load as ProviderId; if (loading[p]) return;
      const btn = b as HTMLButtonElement; loading[p] = true; btn.textContent = 'Loading…'; btn.disabled = true;
      const loaded = await loadWsRepos(ws, p);
      loading[p] = false; btn.textContent = 'Load my repos'; btn.disabled = false;
      if (!root.isConnected) return;
      if (loaded.length) { for (const id of loaded) avail[p].add(id); renderList(p); }
      else { const box = root.querySelector(`#nsList-${p}`) as HTMLElement | null; if (box && !avail[p].size) box.innerHTML = `<div class="src-empty">Not connected — connect ${PROV_NAME[p]} in Sources.</div>`; }
    };
  });
}

/* ----------------------------- wire-up ----------------------------- */
export function initNotifications(d: NotifDeps): void {
  deps = d;
  const bell = $('#notifBell'); if (bell) bell.onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  renderBell();
  window.setTimeout(() => void pollAll(), FIRST_POLL_MS);
  window.setInterval(() => void pollAll(), POLL_MS);
}
