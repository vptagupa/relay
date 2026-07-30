import { app } from 'electron';
import { promises as fs, writeFileSync } from 'node:fs';
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
  settings: { workspace: null, defaultModel: DEFAULT_MODEL, autoApprove: false, autoSave: true, theme: 'dark', sidebarCollapsed: false, toolbarShown: false, librarySort: 'recent', librarySplit: 0.4, sidebarWidth: 260, shellIntegration: true, blocksView: true, bookmarks: [], bookmarkGroups: [], hasKey: {} },
});

let cache: DB | null = null;

async function load(): Promise<DB> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(file(), 'utf8'));
    const d = defaults();
    // Deep-merge settings so a config written by an older version (missing newer keys)
    // still comes back with all defaults filled in, rather than replacing them wholesale.
    cache = { ...d, ...parsed, settings: { ...d.settings, ...(parsed.settings || {}) } };
  } catch {
    cache = defaults();
  }
  return cache!;
}

async function flush(): Promise<void> {
  if (cache) await fs.writeFile(file(), JSON.stringify(cache, null, 2), 'utf8');
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
  if (!cache) return;
  cache.workspace = ws;
  try { writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8'); } catch { /* best-effort on shutdown */ }
}
