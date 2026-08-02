import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp, appendFileSync } from 'node:fs';
import { exec, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createTerm, writeTerm, resizeTerm, detachTerm, killTerm, killAll } from './pty';
import * as store from './store';
import * as keys from './keys';
import { runAgent } from './agent/agent';
import squirrelStartup from 'electron-squirrel-startup';
import type { ApprovalRequest, ChatTurn, Issue } from './shared/types';
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
  if (!isSquirrel) { try { dialog.showErrorBox('Slayer T — unexpected error', (err as { stack?: string })?.stack || String(err)); } catch { /* ignore */ } }
});
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));

// These globals are injected by the Electron Forge Vite plugin.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let win: BrowserWindow | null = null;

// --- slayert:// deeplinks: slayert://<kind>/<name>, e.g. slayert://workspace/agent-t ---
// Scheme is "slayert" (not "slayer") to stay namespaced to this app — other Slayer projects keep their own.
const DEEPLINK_SCHEME = 'slayert';
function extractDeeplink(argv: readonly string[]): string | null {
  return argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith(DEEPLINK_SCHEME + '://')) ?? null;
}
function parseDeeplink(url: string): { kind: string; name: string } | null {
  const m = new RegExp('^' + DEEPLINK_SCHEME + '://([^/]+)/(.+)$', 'i').exec(url.trim());
  if (!m) return null;
  try { return { kind: m[1].toLowerCase(), name: decodeURIComponent(m[2].replace(/\/+$/, '')) }; } catch { return null; }
}
let bootDeeplink: string | null = null; // a slayert:// URL this instance launched with — routed once the renderer is up
function routeDeeplink(url: string | null): void {
  const intent = url ? parseDeeplink(url) : null;
  if (intent && win && !win.isDestroyed()) win.webContents.send('deeplink', intent);
}

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
    title: 'Slayer T',
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
  // A slayert:// link this instance launched with is routed once the renderer has loaded (it buffers the
  // intent until its own boot finishes). Cleared after the first delivery so a reload can't refire it.
  win.webContents.on('did-finish-load', () => { if (bootDeeplink) { routeDeeplink(bootDeeplink); bootDeeplink = null; } });
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
  // Single instance: a second launch (e.g. the OS opening a slayert:// link) must route to the already-
  // running window rather than spawn a second app. Without the lock we hand our argv over (Electron fires
  // 'second-instance' in the primary) and quit.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    // Register slayert:// so the OS routes those links here. Dev needs the exec path + main script explicitly.
    if (app.isPackaged) app.setAsDefaultProtocolClient(DEEPLINK_SCHEME);
    else app.setAsDefaultProtocolClient(DEEPLINK_SCHEME, process.execPath, [path.resolve(process.argv[1] ?? '')]);
    bootDeeplink = extractDeeplink(process.argv); // launched WITH a link? deliver it once the renderer is up

    app.on('second-instance', (_e, argv) => {
      if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
      routeDeeplink(extractDeeplink(argv));
    });
    app.on('open-url', (e, url) => { // macOS delivers links here
      e.preventDefault(); // we handle the scheme ourselves
      if (win) { win.show(); win.focus(); routeDeeplink(url); } else bootDeeplink = url;
    });

    app.whenReady().then(createWindow);
    app.on('window-all-closed', () => {
      killAll();
      if (process.platform !== 'darwin') app.quit();
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }
}

/* -------------------- PTY IPC -------------------- */
ipcMain.handle('pty:create', async (e, { id, cwd, cols, rows, restore, runCmd }) => {
  try {
    const integrate = (await store.getSettings()).shellIntegration;
    return createTerm(id, cwd, e.sender, cols, rows, restore, integrate, typeof runCmd === 'string' ? runCmd : undefined);
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

/* -------------------- Issue Agent (Phase 1: read-only GitHub via gh) -------------------- */
// Resolve an executable's absolute path once. Windows execFile won't PATHEXT-resolve a bare name,
// so look it up like claude:detect and cache. Names are hardcoded literals, never user input.
const binCache = new Map<string, string | null>();
function resolveBin(name: string): Promise<string | null> {
  if (binCache.has(name)) return Promise.resolve(binCache.get(name)!);
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? `where ${name}` : `command -v ${name}`;
    exec(cmd, { timeout: 6000, windowsHide: true }, (err, stdout) => {
      const p = (stdout || '').trim().split(/\r?\n/)[0] || '';
      const r = !err && p ? p : null;
      binCache.set(name, r);
      resolve(r);
    });
  });
}
// git@github.com:owner/name.git | https://github.com/owner/name(.git) -> owner/name
function ghRepoFromRemote(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  return m ? m[1] : null;
}
// Run a resolved binary with an ARG ARRAY (never a shell string — no injection). Resolves to the
// outcome and never rejects, so callers can compose a sequence of git steps with plain awaits.
function runBin(bin: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: opts.timeout ?? 15000, windowsHide: true, cwd: opts.cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
    });
  });
}

// Is the GitHub CLI installed, and logged in? (keyless — its own session, no token in the app.)
ipcMain.handle('github:detect', () => new Promise<{ gh: boolean; authed: boolean; account?: string }>((resolve) => {
  resolveBin('gh').then((gh) => {
    if (!gh) return resolve({ gh: false, authed: false });
    execFile(gh, ['auth', 'status'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      const txt = (stderr || '') + (stdout || ''); // gh prints status to stderr; exit 0 = logged in
      const acc = txt.match(/account\s+(\S+)/i)?.[1];
      resolve({ gh: true, authed: !err, account: acc });
    });
  });
}));

// owner/name from a folder's git origin remote.
ipcMain.handle('github:repo', (_e, dir: string) => new Promise<string | null>((resolve) => {
  if (!dir || typeof dir !== 'string') return resolve(null);
  resolveBin('git').then((git) => {
    if (!git) return resolve(null);
    execFile(git, ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 6000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : ghRepoFromRemote(stdout || ''));
    });
  });
}));

// Pull open issues for owner/name via `gh issue list` (validated repo, arg array — no shell).
ipcMain.handle('github:issues', (_e, repo: string) => new Promise<{ ok: boolean; issues?: Issue[]; error?: string }>((resolve) => {
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return resolve({ ok: false, error: 'Invalid repository' });
  resolveBin('gh').then((gh) => {
    if (!gh) return resolve({ ok: false, error: 'GitHub CLI (gh) not found' });
    execFile(gh, ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '50', '--json', 'number,title,body,labels,state,url'],
      { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: (stderr || err.message || 'gh failed').trim().split('\n')[0] });
        try {
          const raw = JSON.parse(stdout || '[]') as Array<Record<string, unknown>>;
          const issues: Issue[] = raw.map((i) => ({
            number: Number(i.number) || 0, title: String(i.title || ''), body: String(i.body || ''),
            state: String(i.state || 'OPEN'), url: String(i.url || ''),
            labels: Array.isArray(i.labels) ? (i.labels as Array<Record<string, unknown>>).map((l) => ({ name: String(l.name || ''), color: l.color ? String(l.color) : undefined })) : [],
          }));
          resolve({ ok: true, issues });
        } catch { resolve({ ok: false, error: 'Could not parse gh output' }); }
      });
  });
}));

ipcMain.handle('open:external', (_e, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

// Create (or reuse) an ISOLATED git worktree for an issue: a per-issue working dir on branch
// issue-<n>, so several issues can be worked in parallel without disturbing the main checkout.
// Also drops the (edited) issue brief as .slayer/issue-<n>.md and locally git-excludes it, so the
// agent's PR never carries the brief. Returns the worktree path + brief's repo-relative path.
ipcMain.handle('git:worktree-add', async (_e, p: { dir: string; number: number; brief?: string }) => {
  try {
    const dir = p?.dir, num = p?.number;
    if (typeof dir !== 'string' || !dir || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'Invalid request' };
    const git = await resolveBin('git');
    if (!git) return { ok: false, error: 'git not found on PATH' };
    const top = await runBin(git, ['-C', dir, 'rev-parse', '--show-toplevel']);
    if (!top.ok) return { ok: false, error: 'This folder is not a git repository' };
    const repoRoot = top.stdout.trim();
    // An unborn repo (git init, no commits) can't seed a worktree branch — say so plainly instead of
    // surfacing git's raw "invalid reference" from the add below.
    if (!(await runBin(git, ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', 'HEAD'])).ok)
      return { ok: false, error: 'This repository has no commits yet — make an initial commit first.' };
    // Base the fix branch on the repo's default branch (origin/HEAD), falling back to the current branch.
    let base = '';
    const dh = await runBin(git, ['-C', repoRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (dh.ok) base = dh.stdout.trim().replace(/^origin\//, '');
    if (!base) { const cur = await runBin(git, ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD']); base = (cur.ok && cur.stdout.trim()) || 'HEAD'; }
    const branch = `issue-${num}`;
    // Disambiguate by a short hash of the repo's absolute path, so two different repos that share a
    // basename (…/a/app and …/b/app) never collide onto the same worktree folder.
    const folder = `${path.basename(repoRoot) || 'repo'}-${createHash('sha1').update(repoRoot.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 8)}`;
    const wtPath = path.join(app.getPath('userData'), 'worktrees', folder, branch);
    const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
    // Drop registrations for worktrees whose folders were deleted by hand, so a re-assign can recreate them.
    await runBin(git, ['-C', repoRoot, 'worktree', 'prune']);
    // Already have a worktree for this issue? Reuse it (re-assigning the same issue is idempotent).
    const list = await runBin(git, ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
    const reused = list.ok && norm(list.stdout).split('\n').some((ln) => ln.startsWith('worktree ') && norm(ln.slice(9).trim()) === norm(wtPath));
    if (!reused) {
      // Branch may already exist from a prior run whose worktree was pruned — re-attach it instead of -b.
      const hasBranch = (await runBin(git, ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
      const addArgs = hasBranch
        ? ['-C', repoRoot, 'worktree', 'add', wtPath, branch]
        : ['-C', repoRoot, 'worktree', 'add', wtPath, '-b', branch, base];
      const add = await runBin(git, addArgs, { timeout: 60000 });
      if (!add.ok) {
        const msg = (add.stderr || add.stdout || 'git worktree add failed').trim().split('\n').filter(Boolean).pop() || 'git worktree add failed';
        return { ok: false, error: msg };
      }
    }
    // Drop the brief inside the worktree and locally exclude .slayer/ so it never shows up / gets committed.
    let briefRel: string | undefined;
    const brief = typeof p?.brief === 'string' ? p.brief : '';
    if (brief) {
      try {
        await fsp.mkdir(path.join(wtPath, '.slayer'), { recursive: true });
        briefRel = `.slayer/issue-${num}.md`;
        await fsp.writeFile(path.join(wtPath, briefRel), brief, 'utf8');
        const gp = await runBin(git, ['-C', wtPath, 'rev-parse', '--git-path', 'info/exclude']);
        if (gp.ok) {
          const excl = path.isAbsolute(gp.stdout.trim()) ? gp.stdout.trim() : path.join(wtPath, gp.stdout.trim());
          const curExcl = await fsp.readFile(excl, 'utf8').catch(() => '');
          // Strip CR before the presence test — on a CRLF exclude the line is ".slayer/\r", which /$/m
          // (matching just before \n) would miss, re-appending a duplicate on every re-assign.
          if (!/^\.slayer\/?$/m.test(curExcl.replace(/\r/g, ''))) await fsp.writeFile(excl, (!curExcl || curExcl.endsWith('\n') ? curExcl : curExcl + '\n') + '.slayer/\n', 'utf8');
        }
      } catch (err) { logFatal('git:worktree-add/brief', err); briefRel = undefined; } // brief is best-effort; the worktree still opens
    }
    return { ok: true, path: wtPath, branch, base, reused, briefRel };
  } catch (err) { logFatal('git:worktree-add', err); return { ok: false, error: 'Worktree creation failed' }; }
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
// Import a workspace: read a user-picked JSON file and hand the raw parsed payload back to the renderer,
// which validates the shape and builds a fresh def + snapshot. (Treated as untrusted content — the
// renderer sanitizes; imported workspaces start untrusted for the agent.)
ipcMain.handle('workspace:import', async () => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: 'Slayer T workspace', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  try { return { ok: true, data: JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8')) }; }
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
// Named workspaces: definitions + active id (rare) and per-workspace snapshots (used on switch).
ipcMain.handle('workspaces:meta', () => store.getWorkspaceMeta());
ipcMain.on('workspaces:save-meta', (_e, { workspaces, activeWorkspaceId }) => { void store.saveWorkspaceMeta(workspaces, activeWorkspaceId); });
ipcMain.handle('workspace:get-snapshot', (_e, id: string) => store.getWorkspaceSnapshot(id));
ipcMain.on('workspace:save-snapshot', (_e, { id, ws }) => { void store.saveWorkspaceSnapshot(id, ws); });
ipcMain.handle('blueprints:get', () => store.getBlueprints());
ipcMain.on('blueprints:save', (_e, blueprints) => { void store.saveBlueprints(blueprints); });

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
