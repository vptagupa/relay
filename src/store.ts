import { app } from 'electron';
import { promises as fs, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { SavedSession, Settings, Workspace } from './shared/types';
import { DEFAULT_MODEL } from './shared/models';

// Simple JSON persistence for saved sessions (the "Library"), the open-tab
// workspace, and app settings. Swap for better-sqlite3 if scrollback grows large.

const file = () => path.join(app.getPath('userData'), 'relay.json');      // sessions + settings (rarely written)
const wsFile = () => path.join(app.getPath('userData'), 'workspace.json'); // open tabs (written often during output)

interface DB {
  sessions: SavedSession[];
  workspace: Workspace;
  settings: Settings;
}

const defaults = (): DB => ({
  sessions: [],
  workspace: { active: '', tabs: [] },
  settings: { workspace: null, defaultModel: DEFAULT_MODEL, autoApprove: false, autoSave: true, theme: 'dark', template: 'graphite', sidebarCollapsed: false, toolbarShown: false, librarySort: 'recent', librarySplit: 0.4, sidebarWidth: 260, shellIntegration: true, blocksView: true, notifications: true, bookmarks: [], bookmarkGroups: [], hasKey: {} },
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
  cache = {
    sessions: Array.isArray(main?.sessions) ? (main!.sessions as SavedSession[]) : d.sessions,
    settings: { ...d.settings, ...(main && typeof main.settings === 'object' ? main.settings : {}) },
    workspace: normWs(wsRaw ?? main?.workspace), // migrate a legacy relay.json.workspace on first run
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

// relay.json — sessions + settings only (the workspace lives in its own file now).
async function flushMain(): Promise<void> {
  if (!cache || readFailed) return;
  const data = JSON.stringify({ sessions: cache.sessions, settings: cache.settings });
  if (data === lastMain) return;
  lastMain = data;
  writeChain = writeChain.then(() => atomicWrite(file(), data)).catch(() => { lastMain = null; });
  await writeChain;
}

// workspace.json — the frequently-changing open-tab snapshot, so a workspace save no longer
// re-serializes the whole Library.
async function flushWorkspace(): Promise<void> {
  if (!cache || wsFinalized) return; // once the shutdown sync flush ran, its snapshot is final
  const data = JSON.stringify(cache.workspace);
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

export async function getWorkspace(): Promise<Workspace> {
  return (await load()).workspace;
}

export async function setWorkspace(ws: Workspace): Promise<void> {
  const db = await load();
  db.workspace = ws;
  await flushWorkspace();
}

// Synchronous write for shutdown, when there's no time to await async fs. Writes only the small
// workspace file (the cache is always populated by boot; if not, there's nothing to persist).
export function setWorkspaceSync(ws: Workspace): void {
  if (!cache) return;
  cache.workspace = ws;
  wsFinalized = true; // set BEFORE writing: this is the last word on close, so any queued/in-flight async flush skips its rename
  try {
    const f = wsFile(); const tmp = `${f}.sync.tmp`;
    writeFileSync(tmp, JSON.stringify(ws), 'utf8');
    renameSync(tmp, f); // atomic replace, like the async path
  } catch { /* best-effort on shutdown */ }
}
