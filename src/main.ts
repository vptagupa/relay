import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp, appendFileSync } from 'node:fs';
import { exec, execFile } from 'node:child_process';
import { createTerm, writeTerm, resizeTerm, detachTerm, killTerm, killAll } from './pty';
import * as store from './store';
import * as keys from './keys';
import { runAgent } from './agent/agent';
import squirrelStartup from 'electron-squirrel-startup';
import type { ApprovalRequest, ChatTurn } from './shared/types';
import type { Provider } from './shared/models';

// On Windows, the Squirrel installer/uninstaller launches the app with a --squirrel-* arg
// to do shortcut bookkeeping. On ANY such run the app must quit immediately and NEVER boot
// (no window, no shells) — otherwise the running process keeps Relay.exe locked and the
// (un)install fails with "access denied / is the app still running?". electron-squirrel-
// startup does the shortcut work; the isSquirrel guard below makes sure nothing else runs.
// Only these maintenance events must suppress boot. NOT --squirrel-firstrun, which is the
// normal first launch right after install — the app should start normally then.
const SQUIRREL_EVENTS = ['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall', '--squirrel-obsolete'];
const isSquirrel = squirrelStartup || process.argv.some((a) => SQUIRREL_EVENTS.includes(a));
if (isSquirrel) app.quit();

// Last-resort diagnostics: record any uncaught main-process error to a log the user can
// share, instead of only flashing Electron's generic "A JavaScript error occurred" dialog.
// This is how we pin down crashes that only reproduce on a specific machine.
function logFatal(kind: string, err: unknown): void {
  try {
    const stack = (err as { stack?: string })?.stack || String(err);
    appendFileSync(path.join(app.getPath('userData'), 'relay-error.log'), `[${new Date().toISOString()}] ${kind}: ${stack}\n`);
  } catch { /* nothing more we can do */ }
}
// Async, size-capped mirror for renderer console messages — a warn-in-a-loop must never block the
// main thread on sync disk I/O or grow the log without bound.
let rendererLogBytes = 0;
let rendererLogCapped = false; // once renderer console output hits the cap we STOP appending — never
// truncate the shared log, or we'd wipe the logFatal crash records this file exists to preserve.
async function logRenderer(text: string): Promise<void> {
  if (rendererLogCapped) return;
  try {
    const f = path.join(app.getPath('userData'), 'relay-error.log');
    const line = `[${new Date().toISOString()}] renderer-console: ${text}\n`;
    rendererLogBytes += line.length;
    if (rendererLogBytes > 1_000_000) {
      rendererLogCapped = true; // append-only so crash records survive; bound growth by suppressing, not wiping
      await fsp.appendFile(f, `[${new Date().toISOString()}] renderer-console: (further renderer output suppressed — exceeded 1 MB this session)\n`);
      return;
    }
    await fsp.appendFile(f, line);
  } catch { /* diagnostics only */ }
}
process.on('uncaughtException', (err) => {
  logFatal('uncaughtException', err);
  // Never pop a modal dialog during a Squirrel maintenance run — it would keep the process
  // alive and lock files, failing the (un)install. In that case just log and move on.
  if (!isSquirrel) { try { dialog.showErrorBox('Relay — unexpected error', (err as { stack?: string })?.stack || String(err)); } catch { /* ignore */ } }
});
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));

// These globals are injected by the Electron Forge Vite plugin.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let win: BrowserWindow | null = null;

// Remove the native application menu bar (File / Edit / View / Window / Help).
// Windows/Linux: this drops the window menu bar entirely. macOS always keeps a
// minimal app menu (OS requirement), which lives in the top screen bar, not the window.
Menu.setApplicationMenu(null);

function createWindow(): void {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 780,
    minHeight: 480,
    backgroundColor: '#0e1116',
    title: 'Relay',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'), // dev taskbar icon (packaged uses the exe icon)
    // Native chrome off; our custom bar is drawn in the renderer.
    // Windows/Linux: fully frameless. macOS: keep the native traffic lights (hiddenInset).
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : { frame: false }),
    autoHideMenuBar: true,     // belt-and-suspenders: no menu bar, and Alt won't reveal one

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs Node to use ipcRenderer
    },
  });

  // TEMP DIAG: mirror renderer console errors/warnings into relay-error.log so we can
  // diagnose init crashes that leave the UI unresponsive (no main-process exception fires).
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) void logRenderer(`${message}  (${sourceId}:${line})`);
  });
  // If the renderer dies or reloads, release any in-flight approval promises so the agent loop
  // (and its provider request) can't leak and wedge the agent panel for the rest of the session.
  win.webContents.on('render-process-gone', (_e, d) => { logFatal('render-process-gone', JSON.stringify(d)); clearPendingApprovals(); });
  win.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) clearPendingApprovals(); });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => logFatal('did-fail-load', `${code} ${desc} ${url}`));
  win.on('closed', () => { win = null; }); // drop the ref so stale window handlers / late IPC can't hit a destroyed window

  const loaded = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    : win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  loaded.catch((err) => logFatal('window-load', err)); // otherwise a load failure is a blank window + unhandled rejection

  // Keep the custom maximize/restore icon in sync with the real window state.
  win.on('maximize', () => win?.webContents.send('win:state', true));
  win.on('unmaximize', () => win?.webContents.send('win:state', false));
}

/* -------------------- custom window controls -------------------- */
ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:maximize', () => { if (win) win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win:close', () => win?.close());
ipcMain.on('win:focus', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

// Only boot the real app when this isn't a Squirrel maintenance run (see isSquirrel above).
if (!isSquirrel) {
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => {
    killAll();
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

/* -------------------- PTY IPC -------------------- */
ipcMain.handle('pty:create', async (e, { id, cwd, cols, rows, restore }) => {
  try {
    const integrate = (await store.getSettings()).shellIntegration;
    return createTerm(id, cwd, e.sender, cols, rows, restore, integrate);
  } catch (err) { logFatal('pty:create', err); return false; } // a spawn failure must not reject into the renderer
});
ipcMain.on('pty:write', (_e, { id, data }) => writeTerm(id, data));
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => resizeTerm(id, cols, rows));
ipcMain.on('pty:detach', (_e, { id }) => detachTerm(id));
ipcMain.on('pty:kill', (_e, { id }) => killTerm(id));

/* -------------------- settings / workspace -------------------- */
ipcMain.handle('settings:get', async () => ({ ...(await store.getSettings()), hasKey: await keys.hasKeys() }));
ipcMain.handle('settings:patch', async (_e, patch) => ({ ...(await store.patchSettings(patch)), hasKey: await keys.hasKeys() }));
ipcMain.handle('workspace:open', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
  if (!r.canceled && r.filePaths[0]) await store.patchSettings({ workspace: r.filePaths[0] });
  return { ...(await store.getSettings()), hasKey: await keys.hasKeys() };
});
// Pick a folder and return its path (null if cancelled). No side effects — the caller
// decides what to do with it (e.g. open a terminal there).
ipcMain.handle('dialog:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
  return { path: !r.canceled && r.filePaths[0] ? r.filePaths[0] : null };
});

/* -------------------- keys -------------------- */
ipcMain.handle('keys:set', async (_e, { provider, value }: { provider: Provider; value: string }) => {
  await keys.setKey(provider, value);
  return { ...(await store.getSettings()), hasKey: await keys.hasKeys() };
});

/* -------------------- sessions -------------------- */
ipcMain.handle('sessions:list', () => store.listSessions());
ipcMain.handle('sessions:upsert', (_e, s) => store.upsertSession(s));
ipcMain.handle('sessions:delete', (_e, id) => store.deleteSession(id));
ipcMain.handle('sessions:reorder', (_e, ids) => store.reorderSessions(ids));

/* -------------------- Claude Code integration -------------------- */
// Is the Claude Code CLI on PATH? (Detection uses the app's PATH; a GUI-launched app may
// miss shells' interactive PATH, so this is a hint — the launcher runs `claude` regardless.)
ipcMain.handle('claude:detect', () =>
  new Promise<{ installed: boolean; path?: string }>((resolve) => {
    const cmd = process.platform === 'win32' ? 'where claude' : 'command -v claude';
    exec(cmd, { timeout: 6000, windowsHide: true }, (err, stdout) => {
      const out = (stdout || '').trim().split(/\r?\n/)[0];
      resolve({ installed: !err && !!out, path: out || undefined });
    });
  }));
// Anthropic auth available without a pasted key? (Relay-stored key, or ambient env creds
// the way Claude Code / the Anthropic SDK resolve them.)
ipcMain.handle('claude:auth', async () => {
  const hk = await keys.hasKeys();
  return {
    relayKey: !!hk['anthropic'],
    ambient: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  };
});

/* -------------------- session export -------------------- */
ipcMain.handle('session:export', async (_e, { name, content, ext }: { name: string; content: string; ext: string }) => {
  const safe = (name || 'session').replace(/[^\w.-]+/g, '_');
  const r = await dialog.showSaveDialog(win!, {
    defaultPath: `${safe}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  try { await fsp.writeFile(r.filePath, content, 'utf8'); return { ok: true, path: r.filePath }; }
  catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
});

/* -------------------- file browser -------------------- */
const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.jsonc', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.md', '.markdown', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.php', '.swift', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.xml', '.sql', '.vue', '.svelte', '.astro', '.txt', '.log', '.gradle', '.r', '.lua', '.dart', '.pl', '.ex', '.exs', '.clj', '.tf', '.graphql', '.proto']);
function isCodeFile(p: string): boolean {
  const base = path.basename(p).toLowerCase();
  if (['dockerfile', 'makefile', '.gitignore', '.gitattributes', '.env', '.bashrc', '.zshrc', '.npmrc', '.editorconfig'].includes(base)) return true;
  return CODE_EXTS.has(path.extname(p).toLowerCase());
}
function tryCode(p: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // `code` is code.cmd on Windows and needs a shell; reject chars that could break out of the
      // quoted argument or trigger %VAR% expansion, so a crafted filename can't inject a command.
      if (/["%\r\n]/.test(p)) return resolve(false);
      exec(`code "${p}"`, { windowsHide: true, timeout: 15000 }, (err) => resolve(!err));
    } else {
      // No shell → the path is a literal argv entry, so $(...)/backticks in a filename can't expand.
      execFile('code', [p], { timeout: 15000 }, (err) => resolve(!err));
    }
  });
}
ipcMain.handle('fs:list', async (_e, dir: string) => {
  try {
    const abs = dir ? path.resolve(dir) : os.homedir();
    const ents = await fsp.readdir(abs, { withFileTypes: true });
    const sorted = ents
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    const MAX = 5000; // don't flood IPC + the renderer when listing node_modules / C:\Windows\WinSxS
    return { path: abs, parent: path.dirname(abs), entries: sorted.slice(0, MAX), truncated: sorted.length > MAX };
  } catch (e: any) {
    return { path: dir, parent: dir, entries: [], error: e.message };
  }
});
ipcMain.handle('fs:open', async (_e, p: string) => {
  const abs = path.resolve(p);
  if (isCodeFile(abs) && (await tryCode(abs))) return { method: 'vscode' };
  const err = await shell.openPath(abs); // OS default app for the file type
  return { method: err ? 'error' : 'default', error: err || undefined };
});

/* -------------------- workspace (open tabs) -------------------- */
ipcMain.handle('workspace:get', () => store.getWorkspace());
ipcMain.on('workspace:set', (_e, ws) => { void store.setWorkspace(ws); });
// Synchronous variant for the renderer's final flush on close — write completes before we
// reply. Best-effort: a failed final flush must never throw here (that would surface as a
// main-process error dialog while the user is just closing the app).
ipcMain.on('workspace:set-sync', (e, ws) => {
  try { store.setWorkspaceSync(ws); } catch (err) { logFatal('flush', err); }
  e.returnValue = true;
});

/* -------------------- agent (with approval round-trip) -------------------- */
const pendingApprovals = new Map<string, (ok: boolean) => void>();
// Deny + drop every in-flight approval (called when the renderer crashes or reloads).
function clearPendingApprovals() { for (const resolve of pendingApprovals.values()) resolve(false); pendingApprovals.clear(); }
ipcMain.on('agent:approval-response', (_e, { id, ok }) => {
  pendingApprovals.get(id)?.(ok);
  pendingApprovals.delete(id);
});

ipcMain.handle('agent:send', async (e, { model, history, userMessage }: { model: string; history: ChatTurn[]; userMessage: string }) => {
  const wc = e.sender;
  await runAgent({
    model,
    history,
    userMessage,
    emit: (ev) => {
      if (!wc.isDestroyed()) wc.send('agent:event', ev);
    },
    approve: (req: ApprovalRequest) =>
      new Promise<boolean>((resolve) => {
        pendingApprovals.set(req.id, resolve);
        if (!wc.isDestroyed()) wc.send('agent:approval', req);
        else resolve(false);
      }),
  });
});
