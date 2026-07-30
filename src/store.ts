import { app } from 'electron';
import { promises as fs, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { SavedSession, Settings, Workspace } from './shared/types';
import { DEFAULT_MODEL } from './shared/models';

// Simple JSON persistence for saved sessions (the "Library"), the open-tab
// workspace, and app settings. Swap for better-sqlite3 if scrollback grows large.

const file = () => path.join(app.getPath('userData'), 'relay.json');

interface DB {
  sessions: SavedSession[];
  workspace: Workspace;
  settings: Settings;
}

const defaults = (): DB => ({
  sessions: [],
  workspace: { active: '', tabs: [] },
  settings: { workspace: null, defaultModel: DEFAULT_MODEL, autoApprove: false, autoSave: true, theme: 'dark', sidebarCollapsed: false, toolbarShown: false, librarySort: 'recent', librarySplit: 0.4, sidebarWidth: 260, shellIntegration: true, blocksView: true, notifications: true, bookmarks: [], bookmarkGroups: [], hasKey: {} },
});

let cache: DB | null = null;
let loading: Promise<DB> | null = null;    // in-flight read, so concurrent boot callers share one load (no last-write-wins)
let readFailed = false;                    // the file existed but couldn't be read/parsed — never overwrite it
let writeChain: Promise<void> = Promise.resolve(); // serialize writes so overlapping saves can't interleave
let lastWritten: string | null = null;     // skip redundant writes

async function doLoad(): Promise<DB> {
  const d = defaults();
  try {
    const parsed = JSON.parse(await fs.readFile(file(), 'utf8'));
    const wsp = (parsed && typeof parsed.workspace === 'object' && parsed.workspace) ? parsed.workspace : {};
    // Validate shapes so a partially-corrupt/hand-edited file can't crash the IPC handlers,
    // and deep-merge settings so an older config (missing newer keys) still gets all defaults.
    cache = {
      sessions: Array.isArray(parsed?.sessions) ? parsed.sessions : d.sessions,
      workspace: { active: typeof wsp.active === 'string' ? wsp.active : '', tabs: Array.isArray(wsp.tabs) ? wsp.tabs : [], gv: wsp.gv, focus: wsp.focus, layout: wsp.layout },
      settings: { ...d.settings, ...(parsed && typeof parsed.settings === 'object' ? parsed.settings : {}) },
    };
  } catch (e: unknown) {
    cache = d;
    if (!(e && (e as { code?: string }).code === 'ENOENT')) readFailed = true; // corrupt/locked: run on defaults but don't clobber
  }
  return cache!;
}

async function load(): Promise<DB> {
  if (cache) return cache;
  if (!loading) loading = doLoad().finally(() => { loading = null; });
  return loading;
}

// Crash-safe write: stage to a temp file then atomically rename over the real one, serialized so
// overlapping saves (debounced async + the shutdown sync flush) can't truncate each other.
async function atomicWrite(data: string): Promise<void> {
  const f = file(); const tmp = `${f}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, f);
}

async function flush(): Promise<void> {
  if (!cache || readFailed) return;
  const data = JSON.stringify(cache);
  if (data === lastWritten) return;
  lastWritten = data;
  writeChain = writeChain.then(() => atomicWrite(data)).catch(() => { lastWritten = null; });
  await writeChain;
}

export async function getSettings(): Promise<Settings> {
  return (await load()).settings;
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const db = await load();
  db.settings = { ...db.settings, ...patch };
  await flush();
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
  await flush();
  return db.sessions;
}

export async function deleteSession(id: string): Promise<SavedSession[]> {
  const db = await load();
  db.sessions = db.sessions.filter((x) => x.id !== id);
  await flush();
  return db.sessions;
}

export async function reorderSessions(ids: string[]): Promise<SavedSession[]> {
  const db = await load();
  const map = new Map(db.sessions.map((s) => [s.id, s] as const));
  const next: SavedSession[] = [];
  for (const id of ids) { const s = map.get(id); if (s) { next.push(s); map.delete(id); } }
  for (const s of map.values()) next.push(s); // keep any not in the id list
  db.sessions = next;
  await flush();
  return db.sessions;
}

export async function getWorkspace(): Promise<Workspace> {
  return (await load()).workspace;
}

export async function setWorkspace(ws: Workspace): Promise<void> {
  const db = await load();
  db.workspace = ws;
  await flush();
}

// Synchronous write for shutdown, when there's no time to await async fs. The cache is
// always populated by then (settings load on boot); if not, there's nothing to persist.
export function setWorkspaceSync(ws: Workspace): void {
  if (!cache || readFailed) return;
  cache.workspace = ws;
  try {
    const f = file(); const tmp = `${f}.sync.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    renameSync(tmp, f); // atomic replace, like the async path
    lastWritten = null; // let later async flushes re-evaluate
  } catch { /* best-effort on shutdown */ }
}
