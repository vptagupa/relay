// Notifications — a background poller that watches EVERY workspace's tracked repos for new/closed issues & PRs,
// surfaces them in a per-workspace header bell (persisted in slayert.json, so they survive restarts), and fires
// native OS push notifications. Runs entirely in the renderer over the per-workspace provider connections.
// DI-seam module: initNotifications(deps).

import { state } from './state';
import { $, esc } from './dom';
import { toast, addSearch } from './ui';
import type { AppNotification } from './shared/types';

const relay = (window as any).relay;

export interface NotifDeps { activeWsId: () => string; wsName: (id: string) => string; }
let deps: NotifDeps;

type ProviderId = 'github' | 'gitlab' | 'bitbucket';
const wsKey = () => deps.activeWsId() || 'ws_default';
function parseRepoId(id: string): { provider: ProviderId; repo: string } {
  const m = /^(github|gitlab|bitbucket):(.+)$/.exec(id || '');
  const norm = (r: string) => r.replace(/\/+$/, '').replace(/\.git$/i, ''); // tolerate a repo id stored with a trailing .git/ (e.g. a pasted clone URL) — the API expects "owner/repo"
  return m ? { provider: m[1] as ProviderId, repo: norm(m[2]) } : { provider: 'github', repo: norm(id) };
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

const POLL_MS = 60000;          // 1 minute
const FIRST_POLL_MS = 15000;    // let boot + provider connections settle before the first sweep
const CAP = 60;                 // max notifications kept per workspace
const PUSH_CAP = 5;             // max individual native notifications per poll cycle (else one summary)

const KIND_ICON: Record<AppNotification['kind'], string> = { 'new-issue': '＋', 'closed-issue': '✕', 'new-pr': '⇄', 'closed-pr': '✓' };
const KIND_LABEL: Record<AppNotification['kind'], string> = { 'new-issue': 'New issue', 'closed-issue': 'Issue closed', 'new-pr': 'New PR', 'closed-pr': 'PR closed' };
// The bell menu filters notifications by tab: General (all), Issues (issue events), PR (pull-request events).
type NotifTab = 'general' | 'issues' | 'pr';
let notifTab: NotifTab = 'general';
// Scope: just the active workspace (default) or EVERY workspace's notifications merged (manage them all in one place).
type NotifScope = 'ws' | 'all';
let notifScope: NotifScope = 'ws';
const isIssueKind = (k: AppNotification['kind']): boolean => k === 'new-issue' || k === 'closed-issue';
const isPrKind = (k: AppNotification['kind']): boolean => k === 'new-pr' || k === 'closed-pr';
// Does a notification belong to the ACTIVE tab? (General matches everything.) Drives the list, the counts, and
// the tab-scoped Mark-all-read / Clear actions.
const inTab = (n: AppNotification): boolean => notifTab === 'issues' ? isIssueKind(n.kind) : notifTab === 'pr' ? isPrKind(n.kind) : true;
const PROV_DOT: Record<ProviderId, string> = { github: 'gh', gitlab: 'gl', bitbucket: 'bb' };
const PROV_NAME: Record<ProviderId, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };

// A minimal modal (own scrim; closes via its button or Escape — NOT a backdrop click) — same shape as the Issues rail's.
function modal(html: string, onClose?: () => void): { root: HTMLElement; close: () => void } {
  const root = document.createElement('div'); root.className = 'tpl-modal';
  root.innerHTML = `<div class="tpl-sc"></div>${html}`;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  document.body.appendChild(root);
  document.addEventListener('keydown', onKey);
  // Overlay/scrim click does NOT close the dialog — close via its own button or Escape (the scrim is a static backdrop).
  return { root, close };
}

// Per-repo open-item snapshot, IN-MEMORY only (re-seeded on boot, so a fresh run never replays past events).
interface Item { n: number; t: string; u: string; a?: string; }   // a = author/owner (issue creator / PR author), captured for the notification actor
// iSeen/pSeen = whether that side has been fetched successfully at least once. Detection for a side starts only
// AFTER its first success (its seeding poll), so a fetch that failed on the seeding poll can't later look "all new".
interface Snap { i: Item[]; p: Item[]; iFull: boolean; pFull: boolean; iSeen: boolean; pSeen: boolean; }
const snap = new Map<string, Snap>();   // key `${wsId} ${repoId}`
let polling = false;
let menuOpen = false;

/* ----------------------------- persistence + reads ----------------------------- */
const listFor = (ws: string): AppNotification[] => (state.settings.notificationsByWs || {})[ws] || [];
const unreadFor = (ws: string): number => listFor(ws).filter((n) => !n.read).length;
// The notifications the bell/menu act on for the current scope, each tagged with its workspace, newest first.
function scopedNotes(): { ws: string; note: AppNotification }[] {
  if (notifScope === 'all') {
    const byWs = state.settings.notificationsByWs || {};
    const out: { ws: string; note: AppNotification }[] = [];
    for (const ws of Object.keys(byWs)) for (const note of byWs[ws]) out.push({ ws, note });
    return out.sort((a, b) => b.note.ts - a.note.ts);   // merge every workspace, most recent first
  }
  const ws = wsKey();
  return listFor(ws).map((note) => ({ ws, note }));
}
// Unread across EVERY workspace — the badge count when the bell is in "All workspaces" scope.
const totalUnread = (): number => Object.values(state.settings.notificationsByWs || {}).reduce((n, list) => n + list.filter((x) => !x.read).length, 0);
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
    const rl = await relay.providerRateLimit().catch(() => null);
    if (rl?.limited) return;   // API rate-limited → skip this cycle (conditional requests keep most polls free anyway)
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
  const curI: Item[] = ir.ok ? (ir.issues || []).map((x: { number: number; title: string; url: string; author?: string }) => ({ n: x.number, t: x.title, u: x.url, a: x.author })) : [];
  const curP: Item[] = pr.ok ? (pr.prs || []).map((x: { number: number; title?: string; url: string; author?: string }) => ({ n: x.number, t: x.title || '', u: x.url, a: x.author })) : [];
  const prev = snap.get(key);
  // Update only the side we actually refreshed; mark it "seen" on its first success (a failed side is never seeded).
  const next: Snap = {
    i: ir.ok ? curI : (prev?.i || []), p: pr.ok ? curP : (prev?.p || []),
    iFull: ir.ok ? !ir.hasMore : (prev?.iFull ?? false), pFull: pr.ok ? !pr.hasMore : (prev?.pFull ?? false),
    iSeen: (prev?.iSeen ?? false) || ir.ok, pSeen: (prev?.pSeen ?? false) || pr.ok,
  };
  snap.set(key, next);
  const out: AppNotification[] = [];
  const mk = (kind: AppNotification['kind'], it: Item): AppNotification => ({ id: `${kind}:${provider}:${repo}#${it.n}`, kind, provider, repo, number: it.n, title: it.t, url: it.u, actor: it.a, ts: Date.now(), read: false });
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
  playChime();
  renderBell();
}

// A short two-note chime, synthesized with Web Audio (no asset to bundle). Off if notifySound is disabled.
let audioCtx: AudioContext | null = null;
function playChime(): void {
  if (state.settings.notifySound === false) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = audioCtx; if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime;
    const master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination); // headroom for the two overlapping tails
    for (const [freq, at] of [[880, 0], [1174.66, 0.11]] as [number, number][]) {   // A5 → D6
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'triangle';   // richer/louder-perceived than a pure sine at the same peak
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.5);
      osc.connect(g).connect(master);
      osc.start(t0 + at); osc.stop(t0 + at + 0.52);
    }
  } catch { /* audio unavailable */ }
}

function firePush(notes: AppNotification[]): void {
  if (state.settings.issuePushNotify === false) return;      // default on
  try {
    if (notes.length <= PUSH_CAP) {
      for (const n of notes) new Notification(`${KIND_LABEL[n.kind]} · ${n.repo}`, { body: `#${n.number} ${n.title}${n.actor ? ` · ${n.actor}` : ''}`.trim().slice(0, 140) });
    } else {
      new Notification('Slayer T · issues & PRs', { body: `${notes.length} new updates across your repos` });
    }
  } catch { /* notifications unavailable */ }
}

/* ----------------------------- bell + dropdown (active workspace) ----------------------------- */
export function renderBell(): void {
  const n = notifScope === 'all' ? totalUnread() : unreadFor(wsKey());   // badge follows the chosen scope
  const badge = $('#notifBadge');
  if (badge) { badge.textContent = n > 99 ? '99+' : String(n); (badge as HTMLElement).style.display = n ? '' : 'none'; }
  if (menuOpen) renderMenu();
}
function renderMenu(): void {
  const menu = $('#notifMenu'); if (!menu) return;
  const scoped = scopedNotes();                          // {ws, note} for the current scope, newest first
  const shown = scoped.filter((x) => inTab(x.note));     // the active tab's notifications
  const unread = (pred: (n: AppNotification) => boolean): number => scoped.filter((x) => !x.note.read && pred(x.note)).length;
  const tab = (id: NotifTab, label: string, pred: (n: AppNotification) => boolean): string => {
    const c = unread(pred);
    return `<button class="nt-tab${notifTab === id ? ' active' : ''}" data-tab="${id}">${label}${c ? `<span class="nt-tc">${c > 99 ? '99+' : c}</span>` : ''}</button>`;
  };
  const tabs = `<div class="nt-tabs">${tab('general', 'General', () => true)}${tab('issues', 'Issues', (n) => isIssueKind(n.kind))}${tab('pr', 'PR', (n) => isPrKind(n.kind))}</div>`;
  const scopeBtn = (id: NotifScope, label: string): string => `<button class="nt-sc${notifScope === id ? ' on' : ''}" data-scope="${id}">${label}</button>`;
  const scope = `<div class="nt-scope">${scopeBtn('ws', 'This workspace')}${scopeBtn('all', 'All workspaces')}</div>`;
  const rows = shown.length ? shown.map(({ ws, note: it }) => `<button class="nt-item${it.read ? '' : ' unread'}" data-url="${esc(it.url)}" data-id="${esc(it.id)}" data-ws="${esc(ws)}">
      <span class="nt-ic">${KIND_ICON[it.kind]}</span>
      <span class="nt-b"><span class="nt-t">${esc(KIND_LABEL[it.kind])} #${it.number}</span><span class="nt-s">${esc(it.title || it.repo)}</span><span class="nt-m">${notifScope === 'all' ? `<span class="nt-ws">${esc(deps.wsName(ws))}</span> · ` : ''}${it.actor ? `<span class="nt-who">${esc(it.actor)}</span> · ` : ''}${esc(it.repo)} · ${esc(relTime(it.ts))}</span></span>
    </button>`).join('') : `<div class="nt-empty">No ${notifTab === 'general' ? '' : notifTab === 'pr' ? 'PR ' : 'issue '}notifications${notifScope === 'all' ? ' across your workspaces' : notifTab === 'general' ? ' yet' : ' in this tab'}.</div>`;
  menu.innerHTML = `<div class="nt-head"><span>Notifications</span><span class="nt-acts">${shown.length ? '<button class="nt-a" data-act="read">Mark all read</button><button class="nt-a" data-act="clear">Clear</button>' : ''}<button class="nt-a" data-act="settings" title="Notification settings">⚙</button></span></div>${scope}${tabs}<div class="nt-list">${rows}</div>`;
  menu.querySelectorAll<HTMLElement>('.nt-sc').forEach((s) => { s.onclick = (e) => { e.stopPropagation(); notifScope = s.dataset.scope as NotifScope; renderBell(); }; }); // renderBell re-renders the badge + (menu open) the list
  menu.querySelectorAll<HTMLElement>('.nt-tab').forEach((t) => { t.onclick = (e) => { e.stopPropagation(); notifTab = t.dataset.tab as NotifTab; renderMenu(); }; });
  menu.querySelectorAll<HTMLElement>('.nt-item').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); markRead(b.dataset.id!, b.dataset.ws!); const u = b.dataset.url; if (u) relay.openExternal(u); toggleMenu(false); }; });
  menu.querySelector<HTMLElement>('[data-act="read"]')?.addEventListener('click', (e) => { e.stopPropagation(); markAllRead(); });
  menu.querySelector<HTMLElement>('[data-act="clear"]')?.addEventListener('click', (e) => { e.stopPropagation(); clearAll(); });
  menu.querySelector<HTMLElement>('[data-act="settings"]')?.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(false); openNotifSettings(); });
}
function markRead(id: string, ws: string): void {   // ws carried on the row (its own workspace, even in All scope)
  const byWs = { ...(state.settings.notificationsByWs || {}) };
  byWs[ws] = (byWs[ws] || []).map((n) => (n.id === id ? { ...n, read: true } : n)); void persist(byWs); renderBell();
}
// Which workspaces the bulk actions touch: every one in "All" scope, else just the active workspace.
const scopeTargets = (byWs: Record<string, AppNotification[]>): string[] => (notifScope === 'all' ? Object.keys(byWs) : [wsKey()]);
function markAllRead(): void {   // marks read the ACTIVE tab (General = all), across the current scope
  const byWs = { ...(state.settings.notificationsByWs || {}) };
  for (const ws of scopeTargets(byWs)) byWs[ws] = (byWs[ws] || []).map((n) => (inTab(n) ? { ...n, read: true } : n));
  void persist(byWs); renderBell();
}
function clearAll(): void {       // clears the ACTIVE tab's notifications (General = all), across the current scope
  const byWs = { ...(state.settings.notificationsByWs || {}) };
  for (const ws of scopeTargets(byWs)) byWs[ws] = (byWs[ws] || []).filter((n) => !inTab(n));
  void persist(byWs); renderBell();
  if (!scopedNotes().length) toggleMenu(false); // close only when nothing is left in view at all
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

/* ----------------------------- real-time webhooks ----------------------------- */
const DEFAULT_WEBHOOK_PORT = 47824;
function genSecret(): string {
  const a = new Uint8Array(24); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// A parsed webhook event (main → renderer) → route into the bell for every workspace watching that repo. Dedup
// against the poller happens in commit() by stable id, so webhooks (instant) and the poll (fallback) can't double.
function handleWebhookEvent(ev: { kind: string; provider: string; repo: string; number: number; title: string; url: string; actor?: string }): void {
  const kind = ev.kind as AppNotification['kind'];
  if (kind !== 'new-issue' && kind !== 'closed-issue' && kind !== 'new-pr' && kind !== 'closed-pr') return;
  const repoId = `${ev.provider}:${ev.repo}`;
  const fresh: { ws: string; note: AppNotification }[] = [];
  for (const ws of watchedWorkspaces()) {
    if (watchedRepos(ws).includes(repoId)) fresh.push({ ws, note: { id: `${kind}:${ev.provider}:${ev.repo}#${ev.number}`, kind, provider: ev.provider, repo: ev.repo, number: ev.number, title: ev.title || '', url: ev.url || '', actor: ev.actor || undefined, ts: Date.now(), read: false } });
  }
  if (fresh.length) commit(fresh);
}
// Push the current webhook settings to the main-process receiver (start/stop). Returns its running state.
async function applyWebhook(): Promise<{ ok: boolean; running: boolean; error?: string }> {
  const enabled = !!state.settings.webhookEnabled;
  const port = Number(state.settings.webhookPort) || DEFAULT_WEBHOOK_PORT;
  return relay.webhookControl(enabled, port, state.settings.webhookSecret || '').catch(() => ({ ok: false, running: false, error: 'control failed' }));
}

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
        <label class="chk"><input type="checkbox" id="nsPush"${state.settings.issuePushNotify !== false ? ' checked' : ''}> Push notifications — native OS toasts when something changes</label>
        <label class="chk ns-push"><input type="checkbox" id="nsSound"${state.settings.notifySound !== false ? ' checked' : ''}> Play a sound when a notification arrives</label>
        <div class="ns-lbl">Repositories to watch</div>
        <div class="ns-provs">${PROVS_ALL.map(sectionHtml).join('')}</div>
        <div class="ns-lbl" style="margin-top:16px">Real-time (webhooks) <span class="ns-wstat" id="nsWhStat"></span></div>
        <label class="chk"><input type="checkbox" id="nsWh"${state.settings.webhookEnabled ? ' checked' : ''}> Receive webhooks for instant notifications (the 1-min poll stays as a fallback)</label>
        <div class="ns-wh" id="nsWhBody"${state.settings.webhookEnabled ? '' : ' style="display:none"'}>
          <div class="ns-wrow"><span class="ns-wl">Port</span><input class="iss-in ns-win" id="nsWhPort" value="${Number(state.settings.webhookPort) || DEFAULT_WEBHOOK_PORT}" spellcheck="false"></div>
          <div class="ns-wrow"><span class="ns-wl">URL</span><code class="ns-wu" id="nsWhUrl"></code><button class="tpl-btn ghost" data-wcopy="url">Copy</button></div>
          <div class="ns-wrow"><span class="ns-wl">Secret</span><code class="ns-wu" id="nsWhSec"></code><button class="tpl-btn ghost" data-wcopy="secret">Copy</button></div>
          <div class="iss-wt">Localhost isn't reachable by the providers — expose this port with a tunnel (cloudflared / ngrok) or a reachable host, then add a webhook per repo. GitHub: Secret = above, content-type JSON, events Issues + Pull requests. GitLab: Secret token = above, Issues + Merge request events. Bitbucket: append <code>?token=SECRET</code> to the URL, Issue + Pull request events.</div>
        </div>
      </div>
      <div class="ft"><span class="hint">Poll every ~1 min; webhooks (if set up) deliver instantly.</span><span class="r"><button class="tpl-btn pri" data-x>Done</button></span></div>
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
    addSearch(box.querySelector('.src-list'), 'Search repositories…'); // filter the watch list
  };
  for (const p of PROVS_ALL) renderList(p);

  root.querySelector('[data-x]')?.addEventListener('click', close);
  (root.querySelector('#nsPush') as HTMLInputElement).addEventListener('change', async (e) => {
    state.settings = await relay.patchSettings({ issuePushNotify: (e.target as HTMLInputElement).checked });
    const main = document.getElementById('notifyIssuesSet') as HTMLInputElement | null; if (main) main.checked = (e.target as HTMLInputElement).checked; // keep the main Settings toggle in sync
  });
  (root.querySelector('#nsSound') as HTMLInputElement).addEventListener('change', async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    state.settings = await relay.patchSettings({ notifySound: on });
    if (on) playChime();   // a quick preview when turning it on
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

  // Webhooks section
  const whBody = root.querySelector('#nsWhBody') as HTMLElement;
  const whUrl = root.querySelector('#nsWhUrl') as HTMLElement;
  const whSec = root.querySelector('#nsWhSec') as HTMLElement;
  const whStat = root.querySelector('#nsWhStat') as HTMLElement;
  const whPort = root.querySelector('#nsWhPort') as HTMLInputElement;
  const whPortNow = (): number => Number(state.settings.webhookPort) || DEFAULT_WEBHOOK_PORT;
  const renderWebhook = (): void => { whUrl.textContent = `http://localhost:${whPortNow()}/`; whSec.textContent = state.settings.webhookSecret || '(generated on enable)'; };
  const refreshStat = async (): Promise<void> => {
    if (!state.settings.webhookEnabled) { whStat.textContent = 'off'; whStat.className = 'ns-wstat'; return; }
    const r = await applyWebhook(); if (!root.isConnected) return;
    whStat.textContent = r.running ? '● listening' : `⚠ ${r.error || 'not running'}`; whStat.className = 'ns-wstat' + (r.running ? ' on' : ' err');
  };
  renderWebhook(); void refreshStat();
  (root.querySelector('#nsWh') as HTMLInputElement).addEventListener('change', async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    const patch: Record<string, unknown> = { webhookEnabled: on };
    if (on && !state.settings.webhookSecret) patch.webhookSecret = genSecret();
    if (!state.settings.webhookPort) patch.webhookPort = DEFAULT_WEBHOOK_PORT;
    state.settings = await relay.patchSettings(patch);
    whBody.style.display = on ? '' : 'none'; renderWebhook(); void refreshStat();
  });
  whPort.addEventListener('change', async () => {
    const port = Math.max(1, Math.min(65535, Number(whPort.value) || DEFAULT_WEBHOOK_PORT));
    whPort.value = String(port); state.settings = await relay.patchSettings({ webhookPort: port });
    renderWebhook(); void refreshStat();
  });
  root.querySelectorAll<HTMLElement>('[data-wcopy]').forEach((b) => {
    b.onclick = () => { const txt = b.dataset.wcopy === 'secret' ? (state.settings.webhookSecret || '') : `http://localhost:${whPortNow()}/`; try { relay.copyText(txt); toast('Copied', true); } catch { /* clipboard unavailable */ } };
  });
}

/* ----------------------------- wire-up ----------------------------- */
export function initNotifications(d: NotifDeps): void {
  deps = d;
  const bell = $('#notifBell'); if (bell) bell.onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  renderBell();
  relay.onWebhookEvent?.(handleWebhookEvent);   // real-time events → the bell (dedup with the poll by id)
  void applyWebhook();                          // start the receiver if it was left enabled
  window.setTimeout(() => void pollAll(), FIRST_POLL_MS);
  window.setInterval(() => void pollAll(), POLL_MS);
}
