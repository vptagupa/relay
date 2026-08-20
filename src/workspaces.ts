// Named workspaces — the switch/restore core + keep-alive + management + the switcher menu + deeplinks.
// Owns the workspace definition list, the active id, and the LRU warm-set. Everything it needs from the
// tab engine / renderer (newTab, reconcilePanes, fitPanes, snapshotTabs, persistWorkspace, applyTheme, …)
// is INJECTED via initWorkspaces(deps) — so renderer.ts depends on this module, never the reverse. This
// module drives blueprints.ts (it owns switchWorkspace etc., so it wires initBlueprints for it).
//
// This is the init-crash-prone code CLAUDE.md warns about: switching must suspend autosave (state.booting),
// tear the current tabs down, and rebuild the target through the persistent pane DOM + E() cache.

import { state, activeTab, groupTabs, type Tab } from './state';
import { type LNode, leaves, isValidLayout } from './layout';
import { $, E, esc, uid } from './dom';
import { toast, makeEditable } from './ui';
import { renderFiles } from './files';
import { TEMPLATES } from './theme';
import { initBlueprints, loadBlueprints, openTplMenu, findBlueprint, newFromBlueprint } from './blueprints';
import type { Settings, Workspace, WorkspaceDef, OpenTab } from './shared/types';

const relay = (window as any).relay;

// --- injected dependencies: the seam to the tab engine / renderer ---
export interface WsDeps {
  newTab: (seed?: Partial<OpenTab>, activate?: boolean) => Promise<unknown>;
  snapshotTabs: () => OpenTab[];
  reconcilePanes: () => void;
  fitPanes: () => void;
  renderTabs: () => void;
  updateStatus: () => void;
  reflectModel: () => void;
  renderChat: () => void;
  updateMainView: () => void;
  reflectSettings: () => void;
  renderLibrary: () => void;                         // the Library is per-workspace — re-render it on switch
  reloadIssues: () => void;                          // Issues (tracked repos + active repo) are per-workspace — reload on switch
  persistWorkspace: (immediate?: boolean) => void;
  applyTheme: () => void;
  blocksMode: (t: Tab | undefined) => boolean;
  confirmDialog: (title: string, detail: string, okLabel?: string) => Promise<boolean>;
  shortCwd: (c: string) => string;
  sendCommand: (id: string, raw: string) => void;   // not used here; passed through to blueprints
  pcmd: string[];                                    // per-pane command-input selectors (P_CMD)
}
let deps: WsDeps;

// --- module state: the renderer's mirror of the store's workspace definitions + active id ---
let wsDefs: WorkspaceDef[] = [];
let wsActiveId = '';
let wsOpenElsewhere = new Set<string>(); // ids currently shown in OTHER windows — refreshed each time the switcher opens
const WS_COLORS = ['#6e7bff', '#f2a93b', '#4ec46a', '#ff2e97', '#22d3ee', '#a78bfa', '#f0616a'];
const nextWsColor = () => WS_COLORS[wsDefs.length % WS_COLORS.length];
const activeWsDef = (): WorkspaceDef | undefined => wsDefs.find((w) => w.id === wsActiveId);
// Resolve a workspace id → its display name (for the notifications "All workspaces" view). Falls back gracefully.
export const wsNameOf = (id: string): string => wsDefs.find((w) => w.id === id)?.name || 'Workspace';
const addWorkspaceDef = (def: WorkspaceDef): void => { wsDefs.push(def); }; // for blueprints.ts (spawn-from-template)
export const getActiveWsId = (): string => wsActiveId;

// Keep-alive is bounded: at most WARM_CAP background workspaces keep their shells alive. Beyond that the
// least-recently-used background workspace is evicted — its shells are killed (its snapshot stays, so it
// cold-restores on next open). Prevents unbounded shells from piling up across many switches.
const WARM_CAP = 4;
let warmWs: string[] = []; // background workspaces with live detached shells, oldest first
async function killWorkspaceShells(id: string): Promise<void> {
  const snap = await relay.getWorkspaceSnapshot(id);
  for (const t of snap.tabs) relay.ptyKill(t.id);
}
async function evictBeyondCap(): Promise<void> {
  const over = warmWs.length - WARM_CAP;
  if (over <= 0) return;
  const evict = warmWs.splice(0, over); // remove the oldest synchronously (before any await) so a concurrent switch can't race the list
  for (const id of evict) await killWorkspaceShells(id);
}

// Rebuild the pane layout + terminals from a saved snapshot. Shared by boot and workspace switch;
// the caller must have `state.booting` set (autosave suspended) around it. Applies the split layout FIRST
// so each tab lands in its real pane, then settles in one pass — mirrors the original boot restore.
// `alwaysRestore` forces the tab rebuild even when autoSave is off: correct for an in-session switch/delete
// (the tabs are live state the user expects preserved, and their keep-alive shells must be reattached, not
// orphaned); boot omits it so an autoSave-off relaunch still starts clean.
export async function restoreWorkspaceSnapshot(ws: Workspace, alwaysRestore = false): Promise<void> {
  if ((alwaysRestore || state.settings.autoSave) && ws.tabs.length) {
    const activeId = ws.tabs.some((t) => t.id === ws.active) ? ws.active : ws.tabs[0].id;
    const savedGroups = new Set<number>(ws.tabs.map((t) => (typeof t.group === 'number' ? t.group : 0)));
    const validLayout = ws.layout != null && isValidLayout(ws.layout, savedGroups);
    if (validLayout) {
      state.layout = ws.layout as LNode;
      for (const g of leaves(state.layout)) state.gv[g] = ws.gv?.[g] || '';
      state.focus = leaves(state.layout).includes(ws.focus ?? 0) ? (ws.focus ?? 0) : leaves(state.layout)[0];
    } else { state.layout = { g: 0 }; state.focus = 0; }
    const lvs = leaves(state.layout);
    for (const t of ws.tabs) { if (typeof t.group !== 'number' || !lvs.includes(t.group)) t.group = lvs[0]; await deps.newTab(t, false); }
    for (const g of lvs) { if (!state.tabs.some((t) => t.id === state.gv[g] && t.group === g)) state.gv[g] = groupTabs(g)[0]?.id || ''; }
    if (!validLayout) state.gv[0] = state.tabs.some((t) => t.id === activeId) ? activeId : (groupTabs(0)[0]?.id || '');
    state.active = state.gv[state.focus] || activeId;
    E('#termEmpty').style.display = 'none';
    deps.reconcilePanes(); deps.renderTabs();
    deps.fitPanes(); // fit each pane's visible tab now, so its buffered replay flushes even if the ResizeObserver doesn't fire (same-layout switch)
  } else if (state.settings.workspace) {
    deps.newTab();
  } else {
    E('#termEmpty').style.display = 'grid';
    E('#termEmpty').innerHTML = 'Open a project folder to start.<br>Press <b>Ctrl/⌘ K</b> → “Open folder”.';
  }
  // Refresh everything keyed off the active tab, consistently across every branch — otherwise a
  // workspace switch leaves the agent panel showing the previous tab's chat and Files on the old folder.
  state.browsePath = activeTab()?.cwd || state.settings.workspace || '';
  deps.updateStatus(); deps.reflectModel(); deps.renderLibrary(); // the Library is per-workspace — show this workspace's saved sessions
  deps.reloadIssues(); // Issues are per-workspace too — pull this workspace's active repo
  if ($('#agentPanel').classList.contains('show')) deps.renderChat();
  // Focus the active pane's input so typing and Ctrl+C reach the shell immediately after a switch (or boot)
  // — otherwise nothing is focused and a running command can't be interrupted until a click.
  const foc = activeTab();
  if (foc) requestAnimationFrame(() => { if (deps.blocksMode(foc)) (E(deps.pcmd[foc.group]) as HTMLElement)?.focus(); else foc.term.focus(); });
}

// Teardown for a switch. Keep-alive (Phase 2): DETACH each shell — it keeps running and buffering in the
// main process, so switching back REATTACHES via ptyCreate and replays the live output (a dev server never
// dies on a switch). Pass `kill` only when the workspace is being deleted. Either way, dispose the xterm
// renderers + drop the tab nodes (frees DOM/WebGL); pane DOM is reused so the E() cache stays valid.
function teardownAllTabs(kill = false): void {
  for (const t of state.tabs) { if (kill) relay.ptyKill(t.id); else relay.ptyDetach(t.id); t.term.dispose(); t.el.remove(); }
  state.tabs = [];
  state.layout = { g: 0 }; state.gv = ['', '', '', '']; state.focus = 0; state.active = ''; state.maxG = null;
  deps.reconcilePanes(); // collapse the grid back to one empty pane (like closeTab's last-tab reset) before the rebuild
  deps.renderTabs();     // clear the surviving pane's tab strip too: rebuilding into an EMPTY workspace takes restore's else-branch, which skips renderTabs — without this the previous workspace's tab buttons stay stranded in the strip
}

export async function switchWorkspace(id: string): Promise<void> {
  closeWsMenu();
  if (state.booting || id === wsActiveId || !wsDefs.some((w) => w.id === id)) return; // a switch/boot in flight — ignore

  // Multi-window guard: one workspace per window. If the target is already open in another window, focus THAT
  // window instead of stealing its live session in here (two windows must never drive the same snapshot). On
  // success main transfers ownership of `id` to this window (and drops this window's claim on `from`).
  const claim = await relay.claimWorkspace(id);
  if (!claim.ok) { if (claim.openElsewhere) toast('Already open in another window — focused it', true); return; }

  const from = wsActiveId;
  const def = wsDefs.find((w) => w.id === id)!;
  // Save the current workspace's snapshot so switching back restores it (scrollback serialized here).
  relay.saveWorkspaceSnapshot(from, { active: state.active, tabs: deps.snapshotTabs(), gv: state.gv, focus: state.focus, layout: state.layout });
  state.booting = true;           // suspend autosave across the teardown + rebuild (init-crash guard)
  try {
    teardownAllTabs();            // detaches `from`'s shells (keep-alive)
    warmWs = warmWs.filter((w) => w !== from && w !== id); warmWs.push(from); void evictBeyondCap(); // `from` is now warmest; `id` is going active
    wsActiveId = id;
    def.lastOpenedAt = Date.now();
    // Per-workspace root + theme: adopt the target's folder + look BEFORE the rebuild, so new terminals spawn
    // in its root and with its palette, and the chrome/Files reflect it.
    await adoptActiveWsEnv();
    relay.saveWorkspaceMeta(wsDefs, id);
    const ws = await relay.getWorkspaceSnapshot(id);
    await restoreWorkspaceSnapshot(ws, true); // in-session switch: rebuild the target's tabs even if autoSave is off (the gate is for boot/relaunch only)
    renderFiles(); deps.updateMainView(); renderWorkspaceChip(); deps.reflectSettings();
  } finally {
    state.booting = false; // always resume autosave, even if the rebuild threw — a stuck flag would deadlock every later switch/create/delete and freeze autosave
  }
  deps.persistWorkspace(true);
  toast(`Workspace: ${def.name}`, true);
  settleDeeplink(); // a link that arrived mid-switch runs now
}

export async function createWorkspace(): Promise<void> {
  if (state.booting) return; // don't add + switch while a switch/boot is in flight
  // A fresh workspace is a blank project: no folder (→ "Open a project folder to start") and no theme
  // override (→ inherits the current look until one is picked). Its identity is a distinct root + look.
  const def: WorkspaceDef = { id: 'ws_' + uid(), name: 'New workspace', color: nextWsColor(), root: null, themeId: null, trusted: false, createdAt: Date.now(), lastOpenedAt: Date.now() };
  wsDefs.push(def);
  await switchWorkspace(def.id); // saves the current snapshot, then rebuilds into the (empty) new one
}

function renderWorkspaceChip(): void {
  const def = wsDefs.find((w) => w.id === wsActiveId);
  const dot = $('#wsChip').querySelector('.ws-dot') as HTMLElement | null;
  if (dot) dot.style.background = def?.color || 'var(--accent)';
  $('#wsChipName').textContent = def?.name || 'Workspace';
}
function renderWsMenu(): void {
  $('#wsMenu').innerHTML = wsDefs.map((w) => {
    const trusted = wsTrusted(w);
    const elsewhere = wsOpenElsewhere.has(w.id); // shown in another window right now
    const sub = (w.root ? deps.shortCwd(w.root) : 'no folder') + (trusted ? '' : '  ·  🔒 untrusted') + (elsewhere ? '  ·  ⊞ in another window' : '');
    return `<div class="ws-item${w.id === wsActiveId ? ' on' : ''}${elsewhere ? ' elsewhere' : ''}" data-ws="${w.id}">
      <span class="ws-dot" data-wsrecolor="${w.id}" title="Cycle color" style="background:${esc(w.color)}"></span>
      <span class="ws-col"><span class="ws-nm" data-wsname="${w.id}">${esc(w.name)}</span><span class="ws-pth">${esc(sub)}</span></span>
      ${w.id === wsActiveId ? '<span class="ws-chk">✓</span>' : ''}
      <span class="ws-acts">${w.id === wsActiveId ? '' : `<button data-wsopenwin="${w.id}" title="${elsewhere ? 'Focus its window' : 'Open in a new window'}">⊞</button>`}<button data-wstrust="${w.id}" title="${trusted ? 'Trusted — click to require agent approvals' : 'Untrusted — click to trust'}">${trusted ? '🔓' : '🔒'}</button><button data-wsdup="${w.id}" title="Duplicate">⧉</button><button data-wsexport="${w.id}" title="Export…">⤓</button><button data-wslink="${w.id}" title="Copy slayert:// link">🔗</button><button data-wsrename="${w.id}" title="Rename">✎</button><button data-wsdel="${w.id}" title="Delete">✕</button></span>
    </div>`;
  }).join('')
    + `<div class="ws-sep"></div><div class="ws-act" data-wsnew><span class="g">＋</span> New workspace</div><div class="ws-act" data-wstpl><span class="g">▤</span> Templates…</div><div class="ws-act" data-wsimport><span class="g">⤒</span> Import workspace…</div>`;
}
export async function openWsMenu(): Promise<void> {
  try { wsOpenElsewhere = new Set(await relay.workspacesOpenElsewhere()); } catch { wsOpenElsewhere = new Set(); } // best-effort: the switch itself is still guarded server-side
  renderWsMenu();
  const r = $('#wsChip').getBoundingClientRect(); const m = $('#wsMenu');
  m.style.left = r.left + 'px'; m.style.top = (r.bottom + 6) + 'px'; m.classList.add('show');
}
export function closeWsMenu(): void { $('#wsMenu').classList.remove('show'); }
function saveWsMeta(): void { relay.saveWorkspaceMeta(wsDefs, wsActiveId); }
// Mirror the active workspace's persisted folder + theme into the live settings the rest of the UI reads.
// Boot-only (in-memory): the values already equal what was persisted on the last switch/set, so no write.
function syncEffectiveFromActiveWs(): void {
  const def = activeWsDef(); if (!def) return;
  state.settings.workspace = def.root ?? '';
  if (def.themeId) state.settings.template = def.themeId as Settings['template']; // null = inherit the global default
}
// Adopt the ACTIVE workspace's folder + theme into the live settings (persisted mirror) and re-tint the
// chrome. Call wherever wsActiveId changes to a workspace whose terminals are about to be (re)built — both a
// switch AND a delete-of-the-active — so the newly-active workspace always opens in its own folder + look.
async function adoptActiveWsEnv(): Promise<void> {
  const def = activeWsDef(); if (!def) return;
  const effTpl = (def.themeId ?? state.settings.template) as Settings['template'];
  state.settings = await relay.patchSettings({ workspace: def.root ?? '', template: effTpl });
  deps.applyTheme();
}
// Record a folder as the active workspace's root (persisted). '' collapses to null → shown as "no folder".
export function setActiveWsRoot(dir: string | null): void {
  const def = activeWsDef(); if (!def) return;
  def.root = dir || null; saveWsMeta();
}
// Record a theme as the active workspace's override (persisted). Called by the theme picker — theme is
// per-workspace; the global setting is only the seed for new ones.
export function setActiveWsTheme(themeId: string): void {
  const def = activeWsDef(); if (!def) return;
  def.themeId = themeId; saveWsMeta();
}

/* ---- management: trust, duplicate, export / import (Phase 3) ---- */
const wsTrusted = (def: WorkspaceDef | undefined): boolean => !!def && def.trusted !== false; // undefined = trusted
export { activeWsDef as activeWorkspaceDef, wsTrusted as isWorkspaceTrusted }; // public accessors for the renderer's agent-panel trust notice (declared after wsTrusted so there's no forward-ref)
// Make a name unique within the current definition list ("Foo" → "Foo 2", "Foo 3", …).
function uniqueWsName(base: string): string {
  const names = new Set(wsDefs.map((w) => w.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) { const n = `${base} ${i}`; if (!names.has(n)) return n; }
}
// Snapshot of a workspace's live tabs — from renderer state for the active one (freshest), else the store.
async function wsSnapshotOf(id: string): Promise<Workspace> {
  return id === wsActiveId
    ? { active: state.active, tabs: deps.snapshotTabs(), gv: state.gv, focus: state.focus, layout: state.layout }
    : await relay.getWorkspaceSnapshot(id);
}
// Clone a snapshot with FRESH terminal ids (so it never collides with the source's live/persisted shells),
// dropping the heavy, machine-specific per-terminal state (scrollback, blocks, chat, Library link). Tolerant
// of untrusted input (import): every field is validated/coerced, so a malformed file can't corrupt state.
function cloneSnapshot(src: any): Workspace {
  const idMap = new Map<string, string>();
  const tabs: OpenTab[] = (Array.isArray(src?.tabs) ? src.tabs : [])
    .filter((t: any) => t && typeof t === 'object')
    .map((t: any) => {
      const nid = uid();
      if (typeof t.id === 'string') idMap.set(t.id, nid);
      return {
        id: nid,
        name: typeof t.name === 'string' ? t.name : 'terminal',
        model: typeof t.model === 'string' ? t.model : state.settings.defaultModel,
        cwd: typeof t.cwd === 'string' ? t.cwd : '',
        group: typeof t.group === 'number' ? t.group : 0,
        tabBg: typeof t.tabBg === 'string' ? t.tabBg : undefined, tabFg: typeof t.tabFg === 'string' ? t.tabFg : undefined,
        bodyBg: typeof t.bodyBg === 'string' ? t.bodyBg : undefined, bodyFg: typeof t.bodyFg === 'string' ? t.bodyFg : undefined,
        bkNonce: uid(),
      } as OpenTab;
    });
  const gv = (Array.isArray(src?.gv) ? src.gv : []).map((id: any) => (typeof id === 'string' && idMap.get(id)) || '');
  const active = (typeof src?.active === 'string' && idMap.get(src.active)) || (tabs[0]?.id ?? '');
  return { active, tabs, gv, focus: typeof src?.focus === 'number' ? src.focus : 0, layout: src?.layout };
}
export function toggleTrust(id: string): void {
  const def = wsDefs.find((w) => w.id === id); if (!def) return;
  def.trusted = !wsTrusted(def); // trusted → untrusted, untrusted → trusted
  saveWsMeta(); renderWsMenu();
  if ($('#agentPanel').classList.contains('show')) deps.renderChat(); // refresh the trust notice
  toast(def.trusted ? `“${def.name}” trusted` : `“${def.name}” untrusted — the agent will ask`, true);
}
export async function duplicateWorkspace(id: string): Promise<void> {
  if (state.booting) return; // mid-switch: snapshotTabs() of the active workspace would be half-built
  const src = wsDefs.find((w) => w.id === id); if (!src) return;
  const nid = 'ws_' + uid();
  const def: WorkspaceDef = { id: nid, name: uniqueWsName(`${src.name} copy`), color: nextWsColor(), root: src.root, themeId: src.themeId, trusted: src.trusted, createdAt: Date.now(), lastOpenedAt: Date.now() };
  relay.saveWorkspaceSnapshot(nid, cloneSnapshot(await wsSnapshotOf(id)));
  wsDefs.push(def); saveWsMeta(); renderWsMenu();
  toast(`Duplicated “${src.name}”`);
}
export async function exportWorkspace(id: string): Promise<void> {
  if (state.booting) return; // mid-switch: don't capture a half-built active snapshot
  const def = wsDefs.find((w) => w.id === id); if (!def) return;
  // A portable TEMPLATE: identity + folder/theme + terminal layout, minus scrollback/blocks/chat.
  const payload = { kind: 'slayer-t.workspace', version: 1,
    workspace: { name: def.name, color: def.color, root: def.root, themeId: def.themeId },
    snapshot: cloneSnapshot(await wsSnapshotOf(id)) };
  const r = await relay.exportSession({ name: def.name, content: JSON.stringify(payload, null, 2), ext: 'json' });
  if (r.ok) toast(`Exported “${def.name}”`); else if (r.error) toast(`Export failed: ${r.error}`);
}
export async function importWorkspace(): Promise<void> {
  const r = await relay.importWorkspace();
  if (!r.ok) { if (r.error) toast(`Import failed: ${r.error}`); return; }
  const d = r.data as any;
  if (!d || d.kind !== 'slayer-t.workspace' || typeof d.workspace !== 'object' || !d.workspace) { toast('Not a Slayer T workspace file'); return; }
  const w = d.workspace;
  const nid = 'ws_' + uid();
  const base = (typeof w.name === 'string' && w.name.trim()) ? w.name.trim() : 'Imported workspace';
  const def: WorkspaceDef = {
    id: nid, name: uniqueWsName(base),
    color: (typeof w.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(w.color)) ? w.color : nextWsColor(), // must be #rrggbb — a raw string would inject CSS into the swatch's inline style
    root: typeof w.root === 'string' ? w.root : null,
    themeId: (typeof w.themeId === 'string' && TEMPLATES.some((t) => t.id === w.themeId)) ? w.themeId : null,
    trusted: false, // came from elsewhere → untrusted until the user trusts it
    createdAt: Date.now(), lastOpenedAt: Date.now(),
  };
  relay.saveWorkspaceSnapshot(nid, cloneSnapshot(d.snapshot));
  wsDefs.push(def); saveWsMeta(); renderWsMenu();
  toast(`Imported “${def.name}”`);
}
function renameWorkspace(id: string, name: string): void {
  const def = wsDefs.find((w) => w.id === id); if (!def) return;
  const nm = name.trim(); if (nm) def.name = nm;
  saveWsMeta(); renderWorkspaceChip(); renderWsMenu();
}
function startRenameWorkspace(id: string): void {
  const el = $('#wsMenu').querySelector(`[data-wsname="${id}"]`) as HTMLElement | null;
  if (el) makeEditable(el, (v) => renameWorkspace(id, v));
}
function recolorWorkspace(id: string): void {
  const def = wsDefs.find((w) => w.id === id); if (!def) return;
  def.color = WS_COLORS[(WS_COLORS.indexOf(def.color) + 1) % WS_COLORS.length];
  saveWsMeta(); renderWorkspaceChip(); renderWsMenu();
}
export async function deleteWorkspace(id: string): Promise<void> {
  if (state.booting) return; // a switch/boot in flight
  if (wsDefs.length <= 1) { toast('Can’t delete the only workspace'); return; }
  const def = wsDefs.find((w) => w.id === id); if (!def) return;
  // Multi-window: never delete a workspace another window is showing (it would yank the def + snapshot out from
  // under a live session). The switcher already marks these; guard here too in case the mark is stale.
  if (id !== wsActiveId) { const elsewhere = new Set(await relay.workspacesOpenElsewhere()); if (elsewhere.has(id)) { toast('Open in another window — close that window first', true); return; } }
  if (!(await deps.confirmDialog('Delete workspace?', `“${def.name}” and its saved terminals will be removed — this can’t be undone.`, 'Delete'))) return;
  if (id === wsActiveId) {
    // Drop the active session WITHOUT saving its snapshot (it's being deleted), then open the first remaining one.
    state.booting = true;
    try {
      teardownAllTabs(true); // kill — this workspace's shells are gone for good
      wsDefs = wsDefs.filter((w) => w.id !== id);
      wsActiveId = wsDefs[0].id;
      warmWs = warmWs.filter((w) => w !== id && w !== wsActiveId); // deleted gone; the new active is no longer background
      await adoptActiveWsEnv(); // the surviving active workspace has its OWN folder + theme — adopt them before rebuilding
      relay.saveWorkspaceMeta(wsDefs, wsActiveId); // prunes the deleted workspace's snapshot from byId
      const ws = await relay.getWorkspaceSnapshot(wsActiveId);
      await restoreWorkspaceSnapshot(ws, true); // rebuild the survivor's tabs regardless of autoSave (in-session, like a switch)
      renderFiles(); deps.updateMainView(); deps.reflectSettings();
    } finally {
      state.booting = false; // always resume autosave, even if the rebuild threw
    }
    deps.persistWorkspace(true); settleDeeplink(); // a link buffered during the delete runs now
  } else {
    if (warmWs.includes(id)) await killWorkspaceShells(id); // kill its background shells before dropping it
    warmWs = warmWs.filter((w) => w !== id);
    wsDefs = wsDefs.filter((w) => w.id !== id);
    relay.saveWorkspaceMeta(wsDefs, wsActiveId); // prunes the snapshot; current session untouched
  }
  renderWorkspaceChip(); renderWsMenu();
  toast(`Deleted “${def.name}”`);
}

/* ---- slayert:// deeplinks: switch to a workspace / spawn a template by name ---- */
const pendingDeeplinks: { kind: string; name: string }[] = []; // FIFO buffer for links that land mid-boot/switch (don't drop a second one)
export function handleDeeplink(intent: { kind: string; name: string }): void {
  if (state.booting) { pendingDeeplinks.push(intent); return; } // defer until boot / an in-flight switch settles
  const name = (intent.name || '').trim();
  if (intent.kind === 'workspace') {
    const def = wsDefs.find((w) => w.name === name);
    if (!def) { toast(`No workspace named “${name}”`); return; }
    if (def.id === wsActiveId) { toast(`Already in “${name}”`, true); return; }
    switchWorkspace(def.id);
  } else if (intent.kind === 'template') {
    const bp = findBlueprint(name);
    if (bp) newFromBlueprint(bp.id); else toast(`No template named “${name}”`);
  } else {
    toast(`Unknown link kind: ${intent.kind}`);
  }
}
// Drain links buffered while state.booting / switching — called wherever `state.booting` returns to false.
// Draining a 'workspace' link starts a switch that re-sets state.booting synchronously, so any links still
// unprocessed in this pass re-buffer (handleDeeplink pushes them back) and settle at the end of that switch —
// the queue drains one switch at a time, in order, and always terminates.
export function settleDeeplink(): void {
  if (state.booting || !pendingDeeplinks.length) return;
  const queue = pendingDeeplinks.splice(0); // take the current batch; re-entrant handlers push into the now-empty queue
  for (const d of queue) handleDeeplink(d);
}
export function copyWorkspaceLink(id: string): void {
  const def = wsDefs.find((w) => w.id === id); if (!def) return;
  closeWsMenu();
  relay.copyText('slayert://workspace/' + encodeURIComponent(def.name));
  toast('Link copied', true);
}

// Load persisted workspace definitions + blueprints on boot, and mirror the active workspace's env.
export async function loadWorkspaceMeta(): Promise<void> {
  const meta = await relay.getWorkspaceMeta();
  wsDefs = meta.workspaces; wsActiveId = meta.activeWorkspaceId;
  // Multi-window: a window launched for a specific workspace (?ws=<id>) shows THAT one, not the persisted
  // global active. Honor the query only if it names a real workspace; else fall back to the active.
  const target = new URLSearchParams(location.search).get('ws');
  if (target && wsDefs.some((w) => w.id === target)) wsActiveId = target;
  void relay.claimWorkspace(wsActiveId); // register this window as the owner of its workspace (boot can't bounce — the launcher already deduped)
  renderWorkspaceChip();
  await loadBlueprints();
  syncEffectiveFromActiveWs(); // mirror the active workspace's folder + theme into settings before first paint
}

// Wire dependencies, drive blueprints (this module owns switchWorkspace etc.), and wire the switcher menu.
let wired = false; // one-time listener + blueprint wiring; guard against a double-init re-registering handlers
export function initWorkspaces(d: WsDeps): void {
  deps = d;
  if (wired) return;
  wired = true;
  initBlueprints({ switchWorkspace, addWorkspaceDef, activeWorkspaceDef: activeWsDef, uniqueWsName, nextWsColor, sendCommand: d.sendCommand, confirmDialog: d.confirmDialog, shortCwd: d.shortCwd, isBooting: () => state.booting });
  // Multi-window live-sync: another window changed the definition list — adopt it so our next save doesn't
  // clobber their create/rename/recolor/trust/delete. We keep OUR own active id + live session untouched.
  relay.onWorkspacesMeta((meta: { workspaces: WorkspaceDef[]; activeWorkspaceId: string }) => {
    if (state.booting) return; // don't mutate defs mid-switch/boot; the menu re-fetches on next open anyway
    wsDefs = meta.workspaces;
    renderWorkspaceChip();
    if ($('#wsMenu').classList.contains('show')) renderWsMenu();
  });
  $('#wsChip').onclick = () => ($('#wsMenu').classList.contains('show') ? closeWsMenu() : void openWsMenu());
  $('#wsMenu').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const ow = t.closest('[data-wsopenwin]') as HTMLElement | null; if (ow) { closeWsMenu(); void relay.openWorkspaceWindow(ow.dataset.wsopenwin!); return; } // open (or focus) in its own window
    const rc = t.closest('[data-wsrecolor]') as HTMLElement | null; if (rc) { recolorWorkspace(rc.dataset.wsrecolor!); return; }
    const rn = t.closest('[data-wsrename]') as HTMLElement | null; if (rn) { startRenameWorkspace(rn.dataset.wsrename!); return; }
    const tr = t.closest('[data-wstrust]') as HTMLElement | null; if (tr) { toggleTrust(tr.dataset.wstrust!); return; }
    const dup = t.closest('[data-wsdup]') as HTMLElement | null; if (dup) { void duplicateWorkspace(dup.dataset.wsdup!); return; }
    const ex = t.closest('[data-wsexport]') as HTMLElement | null; if (ex) { closeWsMenu(); void exportWorkspace(ex.dataset.wsexport!); return; }
    const lk = t.closest('[data-wslink]') as HTMLElement | null; if (lk) { copyWorkspaceLink(lk.dataset.wslink!); return; }
    const del = t.closest('[data-wsdel]') as HTMLElement | null; if (del) { void deleteWorkspace(del.dataset.wsdel!); return; }
    if (t.closest('[data-wsnew]')) { void createWorkspace(); return; }
    if (t.closest('[data-wstpl]')) { closeWsMenu(); openTplMenu(); return; }
    if (t.closest('[data-wsimport]')) { closeWsMenu(); void importWorkspace(); return; }
    const it = t.closest('[data-ws]') as HTMLElement | null;
    if (it) void switchWorkspace(it.dataset.ws!);
  });
  document.addEventListener('mousedown', (e) => { const t = e.target as HTMLElement; if (!t.closest('#wsMenu') && !t.closest('#wsChip')) closeWsMenu(); });
}
