import { app } from 'electron';
import { promises as fs, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { SavedSession, Settings, Workspace, WorkspaceDef } from './shared/types';
import { DEFAULT_MODEL } from './shared/models';

// Simple JSON persistence for saved sessions (the "Library"), named workspaces (each a split-layout
// snapshot of open tabs), and app settings. Swap for better-sqlite3 if scrollback grows large.
//
// relay.json (rare writes) holds sessions + settings + the workspace DEFINITIONS + which one is
// active. workspace.json (frequent writes) holds the per-workspace tab SNAPSHOTS, keyed by id.

const file = () => path.join(app.getPath('userData'), 'relay.json');      // sessions + settings + workspace defs (rare)
const wsFile = () => path.join(app.getPath('userData'), 'workspace.json'); // per-workspace tab snapshots (frequent)

interface DB {
  sessions: SavedSession[];
  settings: Settings;
  workspaces: WorkspaceDef[];          // definitions (relay.json)
  activeWorkspaceId: string;           // which workspace is open (relay.json)
  wsById: Record<string, Workspace>;   // per-workspace tab snapshots (workspace.json)
}

const defaults = (): DB => ({
  sessions: [],
  settings: { workspace: null, defaultModel: DEFAULT_MODEL, autoApprove: false, autoSave: true, theme: 'dark', template: 'graphite', sidebarCollapsed: false, toolbarShown: false, librarySort: 'recent', librarySplit: 0.4, sidebarWidth: 260, shellIntegration: true, blocksView: true, notifications: true, bookmarks: [], bookmarkGroups: [], hasKey: {} },
  workspaces: [],
  activeWorkspaceId: '',
  wsById: {},
});

let cache: DB | null = null;
let loading: Promise<DB> | null = null;    // in-flight read, so concurrent boot callers share one load (no last-write-wins)
let readFailed = false;                    // relay.json existed but couldn't be read/parsed — never overwrite it
let writeChain: Promise<void> = Promise.resolve(); // serialize writes so overlapping saves can't interleave
let lastMain: string | null = null;        // last relay.json content written (skip redundant writes)
let lastWs: string | null = null;          // last workspace.json content written
let wsFinalized = false;                    // the sync shutdown flush wrote the final workspace — no async write may overwrite it

function normWs(w: unknown): Workspace {
  const wsp = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>;
  return { active: typeof wsp.active === 'string' ? wsp.active : '', tabs: Array.isArray(wsp.tabs) ? wsp.tabs : [], gv: wsp.gv as string[] | undefined, focus: wsp.focus as number | undefined, layout: wsp.layout };
}

// Read a JSON file; null on missing. `critical` marks relay.json — a non-ENOENT failure there
// blocks overwrites so a transient read error can't wipe the Library. workspace.json is disposable.
async function readJson(f: string, critical: boolean): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await fs.readFile(f, 'utf8')); }
  catch (e: unknown) { if (critical && !(e && (e as { code?: string }).code === 'ENOENT')) readFailed = true; return null; }
}

async function doLoad(): Promise<DB> {
  const d = defaults();
  const main = await readJson(file(), true);
  const wsRaw = await readJson(wsFile(), false);
  const settings = { ...d.settings, ...(main && typeof main.settings === 'object' ? main.settings : {}) } as Settings;

  // Per-workspace snapshots: the new { version, byId } shape, else migrate the pre-multi single
  // snapshot (workspace.json was one Workspace; even older, relay.json.workspace) into ws_default.
  const wsById: Record<string, Workspace> = {};
  const byId = wsRaw && typeof wsRaw.byId === 'object' ? (wsRaw.byId as Record<string, unknown>) : null;
  if (byId) { for (const [id, snap] of Object.entries(byId)) wsById[id] = normWs(snap); }
  else if (wsRaw ?? main?.workspace) { wsById['ws_default'] = normWs(wsRaw ?? main?.workspace); }

  // Workspace definitions: seed a default one on first run, named from the open folder.
  let workspaces: WorkspaceDef[] = Array.isArray(main?.workspaces) ? (main!.workspaces as WorkspaceDef[]) : [];
  let activeWorkspaceId = typeof main?.activeWorkspaceId === 'string' ? (main!.activeWorkspaceId as string) : '';
  if (!workspaces.length) {
    const root = settings.workspace ?? null;
    const name = root ? (root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Workspace') : 'Default';
    const now = Date.now();
    workspaces = [{ id: 'ws_default', name, color: '#6e7bff', root, themeId: null, createdAt: now, lastOpenedAt: now }];
  }
  if (!workspaces.some((w) => w.id === activeWorkspaceId)) activeWorkspaceId = workspaces[0].id; // active must exist
  if (!wsById[activeWorkspaceId]) wsById[activeWorkspaceId] = { active: '', tabs: [] };

  cache = {
    sessions: Array.isArray(main?.sessions) ? (main!.sessions as SavedSession[]) : d.sessions,
    settings, workspaces, activeWorkspaceId, wsById,
  };
  return cache!;
}

async function load(): Promise<DB> {
  if (cache) return cache;
  if (!loading) loading = doLoad().finally(() => { loading = null; });
  return loading;
}

// Crash-safe write: stage to a temp file then atomically rename over the real one, serialized so
// overlapping saves (debounced async + the shutdown sync flush) can't truncate each other.
async function atomicWrite(f: string, data: string): Promise<void> {
  const tmp = `${f}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, f);
}

// relay.json — sessions + settings + workspace definitions (the tab snapshots live in their own file).
async function flushMain(): Promise<void> {
  if (!cache || readFailed) return;
  const data = JSON.stringify({ sessions: cache.sessions, settings: cache.settings, workspaces: cache.workspaces, activeWorkspaceId: cache.activeWorkspaceId });
  if (data === lastMain) return;
  lastMain = data;
  writeChain = writeChain.then(() => atomicWrite(file(), data)).catch(() => { lastMain = null; });
  await writeChain;
}

// workspace.json — the frequently-changing open-tab snapshot, so a workspace save no longer
// re-serializes the whole Library.
async function flushWorkspace(): Promise<void> {
  if (!cache || wsFinalized) return; // once the shutdown sync flush ran, its snapshot is final
  const data = JSON.stringify({ version: 1, byId: cache.wsById });
  if (data === lastWs) return;
  lastWs = data;
  // Not the shared atomicWrite: re-check wsFinalized right before the rename so an async write that
  // was already in-flight when the sync shutdown flush ran can't rename its (now stale) temp over it.
  writeChain = writeChain.then(async () => {
    if (wsFinalized) return;
    const f = wsFile(); const tmp = `${f}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data, 'utf8');
    if (wsFinalized) { try { await fs.unlink(tmp); } catch { /* ignore */ } return; }
    await fs.rename(tmp, f);
  }).catch(() => { lastWs = null; });
  await writeChain;
}

export async function getSettings(): Promise<Settings> {
  return (await load()).settings;
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const db = await load();
  db.settings = { ...db.settings, ...patch };
  await flushMain();
  return db.settings;
}

export async function listSessions(): Promise<SavedSession[]> {
  return (await load()).sessions;
}

export async function upsertSession(s: SavedSession): Promise<SavedSession[]> {
  const db = await load();
  const i = db.sessions.findIndex((x) => x.id === s.id);
  if (i >= 0) db.sessions[i] = s;
  else db.sessions.unshift(s);
  await flushMain();
  return db.sessions;
}

export async function deleteSession(id: string): Promise<SavedSession[]> {
  const db = await load();
  db.sessions = db.sessions.filter((x) => x.id !== id);
  await flushMain();
  return db.sessions;
}

export async function reorderSessions(ids: string[]): Promise<SavedSession[]> {
  const db = await load();
  const map = new Map(db.sessions.map((s) => [s.id, s] as const));
  const next: SavedSession[] = [];
  for (const id of ids) { const s = map.get(id); if (s) { next.push(s); map.delete(id); } }
  for (const s of map.values()) next.push(s); // keep any not in the id list
  db.sessions = next;
  await flushMain();
  return db.sessions;
}

// --- active workspace's tab snapshot (what the renderer boots into / autosaves) ---
export async function getWorkspace(): Promise<Workspace> {
  const db = await load();
  return db.wsById[db.activeWorkspaceId] ?? { active: '', tabs: [] };
}

export async function setWorkspace(ws: Workspace): Promise<void> {
  const db = await load();
  db.wsById[db.activeWorkspaceId] = ws;
  await flushWorkspace();
}

// Synchronous write for shutdown, when there's no time to await async fs. Writes only the small
// workspace file (the cache is always populated by boot; if not, there's nothing to persist).
export function setWorkspaceSync(ws: Workspace): void {
  if (!cache) return;
  cache.wsById[cache.activeWorkspaceId] = ws;
  wsFinalized = true; // set BEFORE writing: this is the last word on close, so any queued/in-flight async flush skips its rename
  try {
    const f = wsFile(); const tmp = `${f}.sync.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, byId: cache.wsById }), 'utf8');
    renameSync(tmp, f); // atomic replace, like the async path
  } catch { /* best-effort on shutdown */ }
}

// --- multi-workspace: definitions, the active id, and per-id snapshots (used by the switcher) ---
export async function getWorkspaceMeta(): Promise<{ workspaces: WorkspaceDef[]; activeWorkspaceId: string }> {
  const db = await load();
  return { workspaces: db.workspaces, activeWorkspaceId: db.activeWorkspaceId };
}

// The active workspace's definition — used by the agent (main process) to resolve per-workspace trust.
export async function getActiveWorkspaceDef(): Promise<WorkspaceDef | undefined> {
  const db = await load();
  return db.workspaces.find((w) => w.id === db.activeWorkspaceId);
}

// Persist the definition list + active id; prune snapshots for workspaces that no longer exist.
export async function saveWorkspaceMeta(workspaces: WorkspaceDef[], activeWorkspaceId: string): Promise<void> {
  const db = await load();
  db.workspaces = workspaces;
  if (workspaces.some((w) => w.id === activeWorkspaceId)) db.activeWorkspaceId = activeWorkspaceId;
  const ids = new Set(workspaces.map((w) => w.id));
  let pruned = false;
  for (const id of Object.keys(db.wsById)) if (!ids.has(id)) { delete db.wsById[id]; pruned = true; }
  await flushMain();
  if (pruned) await flushWorkspace();
}

export async function getWorkspaceSnapshot(id: string): Promise<Workspace> {
  const db = await load();
  return db.wsById[id] ?? { active: '', tabs: [] };
}

export async function saveWorkspaceSnapshot(id: string, ws: Workspace): Promise<void> {
  const db = await load();
  db.wsById[id] = ws;
  await flushWorkspace();
}
