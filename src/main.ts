import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp, appendFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { exec, execFile } from 'node:child_process';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { httpsReq, PROVIDERS, providerOf, providerFromRemote, bitbucketExchangeCode, bitbucketAuthorizeUrl, bbOAuthConfigured, BB_OAUTH_PORT, BB_REDIRECT_URI, getOAuthApp, setOAuthApp, githubClientId, migrateGlobalSecretsToWs, rateLimitStatus, type ProviderId } from './providers';
import { createTerm, writeTerm, resizeTerm, detachTerm, killTerm, killAll, isAltScreen, termStats, setReapLogger } from './pty';
import { startWebhookServer, stopWebhookServer, webhookRunning } from './webhooks';
import * as store from './store';
import * as keys from './keys';
import * as gdrive from './gdrive';
import * as cloudsync from './cloudsync';
import { runAgent } from './agent/agent';
import squirrelStartup from 'electron-squirrel-startup';
import type { ApprovalRequest, ChatTurn } from './shared/types';
import type { Provider } from './shared/models';
import { editorCmd, editorLabel } from './shared/editors';

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

// --- Rebrand: move the data directory from the legacy "Relay" name to "SlayerT" ------------------
// Older builds kept everything under %APPDATA%\Relay (the app's old productName). Point userData at
// %APPDATA%\SlayerT and, on the first run of the rebranded build, copy the important files across so
// nothing is orphaned (relay-error.log carries over as slayert-error.log). Non-destructive: the old
// dir is left in place as a backup. Only 5 small config files are copied — the worktrees/ and repos/
// caches are NOT: existing git worktrees keep working (they're registered by absolute path under the old
// Relay dir, which remains), but the managed clone cache re-populates under the new dir on next use (old
// clones become dead disk — regenerable, not a correctness issue). MUST run before any module reads
// app.getPath('userData'). Skipped on a Squirrel (un)install run — that path already called app.quit()
// and must do NOTHING else (no file I/O that could delay the quit and keep the exe locked, failing the
// install). NOTE: package.json productName stays "Relay" ON PURPOSE — safeStorage's master key is scoped
// to the app identity, so renaming it would make the migrated keys.json undecryptable (tokens lost).
if (!isSquirrel) try {
  const appData = app.getPath('appData');                 // %APPDATA% (Roaming)
  const newDir = path.join(appData, 'SlayerT');
  const oldDir = path.join(appData, 'Relay');
  const fresh = !existsSync(path.join(newDir, 'slayert.json')) && !existsSync(path.join(newDir, 'relay.json'));
  if (fresh && existsSync(oldDir)) {
    mkdirSync(newDir, { recursive: true });
    for (const f of ['slayert.json', 'relay.json', 'workspace.json', 'keys.json', 'relay-error.log']) {
      const src = path.join(oldDir, f);
      const dst = path.join(newDir, f === 'relay-error.log' ? 'slayert-error.log' : f);
      // Copy atomically (temp + rename) so an interrupted first run can't leave a TRUNCATED dst — that
      // would make `fresh` false next boot (dst exists) and permanently skip the re-copy, stranding the
      // good data in the old dir. A rename is atomic on the same volume; a leftover .migrating is ignored.
      if (existsSync(src)) { try { const tmp = dst + '.migrating'; copyFileSync(src, tmp); renameSync(tmp, dst); } catch { /* skip a locked/odd file */ } }
    }
  }
  app.setPath('userData', newDir);
} catch (err) { try { console.error('userData migration skipped:', err); } catch { /* */ } } // on any failure fall back to the default (Relay) dir — a fresh dir just starts clean

// Last-resort diagnostics: record any uncaught main-process error to a log the user can
// share, instead of only flashing Electron's generic "A JavaScript error occurred" dialog.
// This is how we pin down crashes that only reproduce on a specific machine.
function logFatal(kind: string, err: unknown): void {
  try {
    const stack = (err as { stack?: string })?.stack || String(err);
    appendFileSync(path.join(app.getPath('userData'), 'slayert-error.log'), `[${new Date().toISOString()}] ${kind}: ${stack}\n`);
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
    const f = path.join(app.getPath('userData'), 'slayert-error.log');
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
// A plain timestamped line in the shared log (heartbeat + shell-cap events). Same file as logFatal so the
// run-up sits right next to any crash record; append-only so it never wipes those records.
function logLine(text: string): void {
  try { appendFileSync(path.join(app.getPath('userData'), 'slayert-error.log'), `[${new Date().toISOString()}] ${text}\n`); } catch { /* diagnostics only */ }
}
// Memory heartbeat — a main-process V8 OOM aborts WITHOUT firing uncaughtException, so a long-run crash leaves
// no log. This records main-process memory + live-shell counts so a crash has a visible run-up. Terse when
// idle: only writes when memory/shell-count actually moves, or every 10 min as a pulse.
let lastHb = { rssMB: -1, shells: -1, at: 0 };
function heartbeatTick(): void {
  try {
    const m = process.memoryUsage(); const t = termStats();
    const mb = (n: number) => Math.round(n / 1048576);
    const rssMB = mb(m.rss); const now = Date.now();
    const moved = t.total !== lastHb.shells || Math.abs(rssMB - lastHb.rssMB) > Math.max(20, lastHb.rssMB * 0.05);
    if (!moved && now - lastHb.at < 600000) return;   // nothing notable AND logged within 10 min → skip
    lastHb = { rssMB, shells: t.total, at: now };
    const warn = rssMB > 1400 ? '  ⚠ HIGH — approaching the main-process memory ceiling' : '';
    logLine(`heartbeat: rss=${rssMB}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB ext=${mb(m.external)}MB shells=${t.total}(attached ${t.attached}/detached ${t.detached})${warn}`);
  } catch { /* diagnostics only */ }
}
function startDiagnostics(): void {
  // Surface the bounded keep-alive in the log so an over-cap eviction is visible (not a silent shell disappearing).
  setReapLogger((killed, total) => logLine(`term-cap: evicted ${killed} idle background shell(s) over the cap; ${total} live`));
  heartbeatTick();                                   // one at boot for a baseline
  const iv = setInterval(heartbeatTick, 120000);     // every 2 min
  iv.unref?.();                                       // never keep the app alive just for the heartbeat
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

  // TEMP DIAG: mirror renderer console errors/warnings into slayert-error.log so we can
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

    app.whenReady().then(() => { createWindow(); startDiagnostics(); });
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
ipcMain.handle('pty:create', async (e, { id, cwd, cols, rows, restore, runCmd, dbCredId }) => {
  try {
    const settings = await store.getSettings();
    const integrate = settings.shellIntegration;
    // Windows terminal backend: default ConPTY, but fall back to the legacy winpty when the user enables it
    // (or sets RELAY_NO_CONPTY=1). Some PCs have a broken/blocked ConPTY where terminals spawn but their I/O is
    // dead (nothing executes / no output) and full-screen TUIs crash — winpty sidesteps ConPTY entirely.
    const useConpty = !(settings.useWinpty || process.env.RELAY_NO_CONPTY === '1');
    // A pipeline run may reference a saved DB credential template — resolve it HERE (main-only) into env vars
    // for this shell, so the agent can connect without the secret ever touching the renderer or a file on disk.
    const envExtra = typeof dbCredId === 'string' && dbCredId ? await keys.resolveDbCredEnv(dbCredId).catch(() => ({})) : undefined;
    const reattached = createTerm(id, cwd, e.sender, cols, rows, restore, integrate, typeof runCmd === 'string' ? runCmd : undefined, envExtra, useConpty);
    // `alt` lets the renderer restore the live-interactive view for a reattached full-screen TUI (Claude Code).
    return { reattached, alt: isAltScreen(id) };
  } catch (err) { logFatal('pty:create', err); return { reattached: false, alt: false }; } // a spawn failure must not reject into the renderer
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

/* -------------------- database credential templates -------------------- */
// Encrypted at rest; only sanitized metadata (no password / no extra-var values) is ever returned. Every result
// is the fresh list so the renderer can re-render without a second round trip.
ipcMain.handle('dbcreds:list', async () => { try { return await keys.listDbCreds(); } catch (err) { logFatal('dbcreds:list', err); return []; } });
ipcMain.handle('dbcreds:save', async (_e, input: keys.DbCredInput) => { try { return await keys.saveDbCred(input); } catch (err) { logFatal('dbcreds:save', err); return await keys.listDbCreds().catch(() => []); } });
ipcMain.handle('dbcreds:delete', async (_e, { id }: { id: string }) => { try { return await keys.deleteDbCred(id); } catch (err) { logFatal('dbcreds:delete', err); return await keys.listDbCreds().catch(() => []); } });

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
// Run a resolved binary with an ARG ARRAY (never a shell string — no injection). Resolves to the
// outcome and never rejects, so callers can compose a sequence of git steps with plain awaits.
function runBin(bin: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: opts.timeout ?? 15000, windowsHide: true, cwd: opts.cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
    });
  });
}

// --- Git providers, app-owned auth --------------------------------------------------------------
// GitHub connects via OAuth device flow and Bitbucket via OAuth authorization-code + loopback (both below);
// GitLab via a pasted PAT. All REST + token storage lives in providers.ts — the renderer only ever sees
// { connected, login } + normalized issues/repos/PRs, never a token.
// GitHub's OAuth App client id is supplied once in-app (Sources → Connect) and stored encrypted — not
// hardcoded. It's a PUBLIC value (the device flow uses no secret), but keeping it out of source lets each
// install point at its own OAuth App. The app must have "Device Flow" enabled in its GitHub settings.

// Start the GitHub OAuth device flow: returns the one-time user code + verification URL for the renderer.
// `ws` is the active Slayer T workspace — its client id + resulting token are scoped to it.
ipcMain.handle('github:device-start', async (_e, { ws }: { ws: string }) => {
  const clientId = await githubClientId(ws);
  if (!clientId) return { ok: false, error: 'GitHub OAuth app is not configured', needsConfig: true };
  const r = await httpsReq('github.com', '/login/device/code', 'POST', { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, `client_id=${encodeURIComponent(clientId)}&scope=repo`);
  try {
    const j = JSON.parse(r.text) as Record<string, unknown>;
    if (j.device_code) return { ok: true, userCode: String(j.user_code || ''), verificationUri: String(j.verification_uri || 'https://github.com/login/device'), deviceCode: String(j.device_code), interval: Number(j.interval) || 5, expiresIn: Number(j.expires_in) || 900 };
    return { ok: false, error: String(j.error_description || j.error || 'Could not start device flow') };
  } catch { return { ok: false, error: 'Could not start device flow' }; }
});
// One poll of the token endpoint. The renderer loops this on the interval until it's no longer pending.
ipcMain.handle('github:device-poll', async (_e, { ws, deviceCode }: { ws: string; deviceCode: string }) => {
  if (typeof deviceCode !== 'string' || !deviceCode) return { status: 'error', error: 'bad request' };
  const clientId = await githubClientId(ws);
  if (!clientId) return { status: 'error', error: 'GitHub OAuth app is not configured' };
  const r = await httpsReq('github.com', '/login/oauth/access_token', 'POST', { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, `client_id=${encodeURIComponent(clientId)}&device_code=${deviceCode}&grant_type=urn:ietf:params:oauth:grant-type:device_code`);
  let j: Record<string, unknown> = {}; try { j = JSON.parse(r.text) as Record<string, unknown>; } catch { /* */ }
  if (j.access_token) {
    await keys.setSecret(`${ws}:github_oauth`, String(j.access_token));   // encrypted in the OS keychain, scoped to the workspace
    const who = await PROVIDERS.github.authState(ws);
    return { status: 'ok', login: who.login || '' };
  }
  if (r.status === 0) return { status: 'pending' }; // transient network/timeout mid-authorization — keep waiting, don't abort
  const err = String(j.error || '');
  if (err === 'authorization_pending') return { status: 'pending' };
  if (err === 'slow_down') return { status: 'slow_down', interval: Number(j.interval) || 5 };
  if (err === 'expired_token') return { status: 'expired' };
  if (err === 'access_denied') return { status: 'denied' };
  return { status: 'error', error: String(j.error_description || err || 'authorization failed') };
});

// Bitbucket connect — OAuth 2.0 authorization-code with a LOOPBACK redirect (Bitbucket Cloud has no device
// flow). One IPC does the whole round trip: spin a one-shot localhost server on the consumer's callback port,
// open the system browser to the authorize page (with a CSRF `state`), catch the `?code` callback, hand it to
// providers.bitbucketExchangeCode (which owns the secret + token storage), and resolve. The renderer only ever
// sees { ok, login } — never a token. Resolves once: on success, denial, timeout, or a port/exchange error.
ipcMain.handle('bitbucket:oauth', async (_e, { ws }: { ws: string }) => {
  if (!(await bbOAuthConfigured(ws))) return { ok: false, error: 'Bitbucket OAuth app is not configured' };
  return new Promise<{ ok: boolean; login?: string; error?: string }>((resolve) => {
  let settled = false;
  const state = randomBytes(16).toString('hex');
  const page = (title: string, sub: string) => `<!doctype html><meta charset="utf-8"><title>Slayer T</title>` +
    `<body style="font:15px/1.5 system-ui,Segoe UI,sans-serif;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0">` +
    `<div style="text-align:center;max-width:380px"><div style="font-size:34px">🔗</div><h2 style="margin:.4em 0 .2em">${title}</h2><p style="opacity:.7;margin:0">${sub}</p></div>`;
  const finish = (v: { ok: boolean; login?: string; error?: string }) => {
    if (settled) return; settled = true;
    clearTimeout(timer); try { server.close(); } catch { /* already closed */ }
    resolve(v);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', BB_REDIRECT_URI);
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');
      const err = url.searchParams.get('error_description') || url.searchParams.get('error');
      // Handle the OAuth result on ANY path (the consumer callback is a portless http://localhost, so Bitbucket
      // may land on '/' rather than '/callback'); ignore incidental hits like /favicon.ico that carry no code.
      if (!code && !err) { res.writeHead(404); res.end('Not found'); return; }
      if (err) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page('Authorization failed', 'You can close this tab and return to Slayer T.')); finish({ ok: false, error: String(err) }); return; }
      if (!code || gotState !== state) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end(page('Invalid response', 'The sign-in could not be verified. Close this tab and try again.')); finish({ ok: false, error: 'Invalid authorization response (state mismatch)' }); return; }
      // Answer the browser before the (slower) token exchange so the tab shows success promptly.
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page('Connected to Bitbucket ✓', 'You can close this tab and return to Slayer T.'));
      finish(await bitbucketExchangeCode(ws, code, BB_REDIRECT_URI));
    } catch { try { res.writeHead(500); res.end('error'); } catch { /* */ } finish({ ok: false, error: 'Callback handling error' }); }
  });
  server.on('error', (e: NodeJS.ErrnoException) => finish({ ok: false, error: e?.code === 'EADDRINUSE' ? `Port ${BB_OAUTH_PORT} is in use — close whatever is using it and try again.` : 'Could not start the local sign-in server' }));
  const timer = setTimeout(() => finish({ ok: false, error: 'Timed out waiting for authorization' }), 300000); // 5 min
  server.listen(BB_OAUTH_PORT, '127.0.0.1', async () => { void shell.openExternal(await bitbucketAuthorizeUrl(ws, state)); });
  });
});

// OAuth-app config (the provider's client id / secret used to START its login flow). Read returns the public
// client id + a hasSecret flag, never the secret. Write validates + stores encrypted in the OS keychain.
ipcMain.handle('provider:oauth-config-get', async (_e, p: { provider: ProviderId; ws: string }) => (await getOAuthApp(p?.ws, p?.provider)) || { clientId: '', hasSecret: false, needsSecret: false, configured: false });
ipcMain.handle('provider:oauth-config-set', async (_e, p: { provider: ProviderId; ws: string; clientId: string; secret?: string }) => {
  const a = providerOf(p?.provider); if (!a) return { ok: false, error: 'Unknown provider' };
  return setOAuthApp(p?.ws, p.provider, typeof p?.clientId === 'string' ? p.clientId : '', typeof p?.secret === 'string' ? p.secret : undefined);
});
// One-time migration of the pre-scoping global secrets into the active workspace (renderer guards it with a flag).
ipcMain.handle('provider:migrate-global', async (_e, { ws }: { ws: string }) => { if (typeof ws === 'string' && ws) await migrateGlobalSecretsToWs(ws); return { ok: true }; });

// --- Cloud sync (Google Drive, end-to-end encrypted) ----------------------------------------------
// Google connects via OAuth 2.0 authorization-code + LOOPBACK redirect (same shape as Bitbucket): one IPC runs
// the whole round trip, catches the ?code on a one-shot localhost server, and hands it to gdrive.exchangeCode
// (which owns the client secret + token storage). The renderer only ever sees { ok, email } — never a token.
// Set while a Drive sign-in is in flight, so the renderer can ABORT one the user backed out of (closing the
// browser tab yields no callback, so the flow would otherwise hang until the 5-min timeout).
let cancelGdriveOAuth: (() => void) | null = null;
ipcMain.handle('gdrive:oauth', async () => {
  if (!(await gdrive.isConfigured())) return { ok: false, error: 'Google OAuth client is not configured' };
  cancelGdriveOAuth?.(); // abort any prior in-flight attempt so we never leak a second loopback server
  return new Promise<{ ok: boolean; email?: string; error?: string; cancelled?: boolean }>((resolve) => {
    let settled = false;
    const state = randomBytes(16).toString('hex');
    const page = (title: string, sub: string) => `<!doctype html><meta charset="utf-8"><title>Slayer T</title>` +
      `<body style="font:15px/1.5 system-ui,Segoe UI,sans-serif;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0">` +
      `<div style="text-align:center;max-width:380px"><div style="font-size:34px">☁️</div><h2 style="margin:.4em 0 .2em">${title}</h2><p style="opacity:.7;margin:0">${sub}</p></div>`;
    const finish = (v: { ok: boolean; email?: string; error?: string; cancelled?: boolean }) => {
      if (settled) return; settled = true;
      cancelGdriveOAuth = null;
      clearTimeout(timer); try { server.close(); } catch { /* already closed */ }
      resolve(v);
    };
    cancelGdriveOAuth = () => finish({ ok: false, cancelled: true, error: 'Sign-in cancelled' }); // closes the loopback server + frees the port
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', gdrive.GD_REDIRECT_URI);
        const code = url.searchParams.get('code');
        const gotState = url.searchParams.get('state');
        const err = url.searchParams.get('error_description') || url.searchParams.get('error');
        if (!code && !err) { res.writeHead(404); res.end('Not found'); return; } // ignore /favicon.ico etc.
        if (err) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page('Authorization failed', 'You can close this tab and return to Slayer T.')); finish({ ok: false, error: String(err) }); return; }
        if (!code || gotState !== state) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end(page('Invalid response', 'The sign-in could not be verified. Close this tab and try again.')); finish({ ok: false, error: 'Invalid authorization response (state mismatch)' }); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page('Connected to Google Drive ✓', 'You can close this tab and return to Slayer T.'));
        finish(await gdrive.exchangeCode(code, gdrive.GD_REDIRECT_URI));
      } catch { try { res.writeHead(500); res.end('error'); } catch { /* */ } finish({ ok: false, error: 'Callback handling error' }); }
    });
    server.on('error', (e: NodeJS.ErrnoException) => finish({ ok: false, error: e?.code === 'EADDRINUSE' ? `Port ${gdrive.GD_OAUTH_PORT} is in use — close whatever is using it and try again.` : 'Could not start the local sign-in server' }));
    const timer = setTimeout(() => finish({ ok: false, error: 'Timed out waiting for authorization' }), 300000); // 5 min
    server.listen(gdrive.GD_OAUTH_PORT, '127.0.0.1', async () => { void shell.openExternal(await gdrive.authorizeUrl(state)); });
  });
});
// Abort an in-flight sign-in (user closed the browser tab / clicked cancel in-app).
ipcMain.handle('gdrive:oauth-cancel', () => { cancelGdriveOAuth?.(); return { ok: true }; });
ipcMain.handle('gdrive:auth-state', async () => { try { return await gdrive.authState(); } catch (err) { logFatal('gdrive:auth-state', err); return { connected: false }; } });
ipcMain.handle('gdrive:disconnect', async () => { try { await gdrive.disconnect(); } catch (err) { logFatal('gdrive:disconnect', err); } return { ok: true }; });
ipcMain.handle('gdrive:config-get', async () => { try { return await gdrive.getConfig(); } catch (err) { logFatal('gdrive:config-get', err); return { clientId: '', hasSecret: false, configured: false }; } });
ipcMain.handle('gdrive:config-set', async (_e, p: { clientId: string; secret?: string }) => { try { return await gdrive.setConfig(typeof p?.clientId === 'string' ? p.clientId : '', typeof p?.secret === 'string' ? p.secret : undefined); } catch (err) { logFatal('gdrive:config-set', err); return { ok: false, error: 'Could not save the OAuth client' }; } });

ipcMain.handle('sync:status', async () => { try { return await cloudsync.status(); } catch (err) { logFatal('sync:status', err); return { configured: false, connected: false, email: '', hasPassphrase: false, lastPush: 0, lastPull: 0, remoteExists: false, remoteModified: '' }; } });
ipcMain.handle('sync:has-passphrase', async () => { try { return { has: await cloudsync.hasPassphrase() }; } catch { return { has: false }; } });
ipcMain.handle('sync:set-passphrase', async (_e, p: { passphrase: string }) => { try { return await cloudsync.setPassphrase(typeof p?.passphrase === 'string' ? p.passphrase : ''); } catch (err) { logFatal('sync:set-passphrase', err); return { ok: false, error: 'Could not save the passphrase' }; } });
ipcMain.handle('sync:push', async () => { try { return await cloudsync.push(); } catch (err) { logFatal('sync:push', err); return { ok: false, error: 'Sync push failed' }; } });
ipcMain.handle('sync:pull', async () => { try { return await cloudsync.pull(); } catch (err) { logFatal('sync:pull', err); return { ok: false, error: 'Sync pull failed' }; } });
// Relaunch to load restored state — only meaningful right after a successful pull (renderer confirms first).
ipcMain.handle('sync:relaunch', () => { cloudsync.relaunchAfterPull(); return { ok: true }; });

// --- generic provider handlers (dispatch to the registry in providers.ts) ---
const badProvider = { ok: false, error: 'Unknown provider' } as const;
// A native repo id: owner/name (GitHub/Bitbucket) or group[/subgroup…]/project (GitLab) — 2+ segments.
const validRepo = (repo: unknown): repo is string => typeof repo === 'string' && /^[\w.-]+(\/[\w.-]+)+$/.test(repo);
// The server-side author-filter list (issues/PRs): non-empty strings, bounded in count + length. undefined = no filter.
const sanitizeAuthors = (a: unknown): string[] | undefined => {
  if (!Array.isArray(a)) return undefined;
  const out = a.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 100).slice(0, 50);
  return out.length ? out : undefined;
};

// Connection state for a provider in workspace `ws` — { connected, login } (never the token). A network blip stays connected.
ipcMain.handle('provider:auth-state', async (_e, p: { provider: ProviderId; ws: string }) => (await providerOf(p?.provider)?.authState(p?.ws)) || { connected: false });
// Connect GitLab with a pasted read-token (+ optional host). GitHub/Bitbucket connect via their OAuth flows
// above; connect() here just stores a token if the renderer ever passes one. Scoped to workspace `ws`.
ipcMain.handle('provider:connect', async (_e, p: { provider: ProviderId; ws: string; token: string; host?: string }) => {
  const a = providerOf(p?.provider); if (!a) return badProvider;
  if (typeof p?.token !== 'string' || !p.token.trim()) return { ok: false, error: 'Paste a token first' };
  return a.connect(p?.ws, p.token.trim(), typeof p?.host === 'string' ? p.host.trim() : undefined);
});
ipcMain.handle('provider:disconnect', async (_e, p: { provider: ProviderId; ws: string }) => { await providerOf(p?.provider)?.disconnect(p?.ws); return { ok: true }; });
// Infer { provider, repo } from a folder's git origin remote (null if not a recognized provider remote).
ipcMain.handle('provider:repo-from-remote', (_e, dir: string) => new Promise<{ provider: ProviderId; repo: string } | null>((resolve) => {
  if (!dir || typeof dir !== 'string') return resolve(null);
  resolveBin('git').then((git) => {
    if (!git) return resolve(null);
    execFile(git, ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 6000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : providerFromRemote(stdout || ''));
    });
  });
}));
ipcMain.handle('provider:issues', async (_e, p: { provider: ProviderId; ws: string; repo: string; state?: 'open' | 'closed'; page?: number; authors?: unknown }) => {
  const a = providerOf(p?.provider); if (!a) return badProvider;
  if (!validRepo(p?.repo)) return { ok: false, error: 'Invalid repository' };
  return a.issues(p?.ws, p.repo, p?.state === 'closed' ? 'closed' : 'open', Math.max(1, Number(p?.page) || 1), sanitizeAuthors(p?.authors));
});
ipcMain.handle('provider:repos', async (_e, p: { provider: ProviderId; ws: string; workspaces?: string[] }) => (await providerOf(p?.provider)?.repos(p?.ws, { workspaces: Array.isArray(p?.workspaces) ? p.workspaces : undefined })) || badProvider);
ipcMain.handle('provider:prs', async (_e, p: { provider: ProviderId; ws: string; repo: string; state?: 'open' | 'closed'; page?: number; authors?: unknown }) => {
  const a = providerOf(p?.provider); if (!a) return badProvider;
  if (!validRepo(p?.repo)) return { ok: false, error: 'Invalid repository' };
  return a.prs(p?.ws, p.repo, p?.state === 'closed' ? 'closed' : 'open', Math.max(1, Number(p?.page) || 1), sanitizeAuthors(p?.authors));
});
ipcMain.handle('provider:pr-detail', async (_e, p: { provider: ProviderId; ws: string; repo: string; number: number }) => {
  const a = providerOf(p?.provider); if (!a) return badProvider;
  if (!validRepo(p?.repo) || !Number.isInteger(p?.number) || p.number <= 0) return { ok: false, error: 'Invalid request' };
  return a.prDetail(p?.ws, p.repo, p.number);
});
// Repo members (collaborators) — the PR author-filter list.
ipcMain.handle('provider:repo-members', async (_e, p: { provider: ProviderId; ws: string; repo: string }) => {
  const a = providerOf(p?.provider); if (!a) return badProvider;
  if (!validRepo(p?.repo)) return { ok: false, error: 'Invalid repository' };
  return a.repoMembers(p?.ws, p.repo);
});
// API rate-limit state (from the conditional-request layer) — the pollers back off when limited.
ipcMain.handle('provider:rate-limit', () => rateLimitStatus());
// Create an issue on the provider (Tasks: file a validated task as a real issue).
ipcMain.handle('provider:create-issue', async (_e, p: { provider: ProviderId; ws: string; repo: string; title: string; body: string }) => {
  const a = providerOf(p?.provider); if (!a) return badProvider;
  if (!validRepo(p?.repo)) return { ok: false, error: 'Invalid repository' };
  const title = typeof p?.title === 'string' ? p.title.trim() : '';
  if (!title) return { ok: false, error: 'Title is required' };
  return a.createIssue(p?.ws, p.repo, title, typeof p?.body === 'string' ? p.body : '');
});
// Current open/closed state of a filed issue (Tasks sync their status from it).
ipcMain.handle('provider:issue-state', async (_e, p: { provider: ProviderId; ws: string; repo: string; number: number }) => {
  const a = providerOf(p?.provider); if (!a) return badProvider;
  if (!validRepo(p?.repo) || !Number.isInteger(p?.number) || p.number <= 0) return { ok: false, error: 'Invalid request' };
  return a.issueState(p?.ws, p.repo, p.number);
});

// Real-time notifications: a local webhook receiver (see webhooks.ts). The renderer toggles it on/off; parsed
// issue/PR events are pushed back to the renderer, which routes them into the per-workspace notification bell.
ipcMain.handle('webhook:control', async (_e, p: { enabled: boolean; port?: number; secret?: string }) => {
  if (!p?.enabled) { stopWebhookServer(); return { ok: true, running: false }; }
  const res = await startWebhookServer(Math.max(1, Math.min(65535, Number(p?.port) || 47824)), String(p?.secret || ''), (ev) => { if (win && !win.isDestroyed()) win.webContents.send('webhook:event', ev); });
  return { ok: res.ok, running: webhookRunning(), error: res.error };
});
ipcMain.handle('webhook:status', () => ({ running: webhookRunning() }));

// Diagnostics for the in-app "Report a bug" flow — app/OS versions + a scrubbed tail of the crash log. Tokens
// never reach the log (they live in the keychain), but scrub defensively before this leaves for the clipboard.
function scrubSecrets(s: string): string {
  return s
    .replace(/\bgh[posru]_[A-Za-z0-9]{20,}\b/g, '[redacted-token]')                 // GitHub tokens
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted-token]')               // GitHub fine-grained PAT
    .replace(/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '[redacted-token]')                   // GitLab PAT
    .replace(/\bATO[A-Z0-9-]{16,}\b/gi, '[redacted-token]')                         // Atlassian / Bitbucket
    .replace(/\benc:[A-Za-z0-9+/=]{16,}/g, 'enc:[redacted]')                        // safeStorage blobs
    .replace(/\b(Bearer|token=|access_token=|secret=)\s*[A-Za-z0-9._-]{12,}/gi, '$1 [redacted]')
    .replace(/([?&]token=)[^\s&"']+/gi, '$1[redacted]');
}
ipcMain.handle('diag:collect', async () => {
  const v = process.versions;
  let logTail = '';
  try { const raw = await fsp.readFile(path.join(app.getPath('userData'), 'slayert-error.log'), 'utf8'); logTail = scrubSecrets(raw.slice(-16000)); } catch { /* no log yet */ }
  return { version: app.getVersion(), os: `${os.type()} ${os.release()}`, arch: process.arch, electron: v.electron, chrome: v.chrome, node: v.node, logTail };
});
ipcMain.handle('diag:reveal', () => {
  const p = path.join(app.getPath('userData'), 'slayert-error.log');
  if (existsSync(p)) shell.showItemInFolder(p); else void shell.openPath(app.getPath('userData'));
  return { ok: true };
});

// Which coding agents are installed on PATH (for the Assign-to picker). Names are hardcoded literals.
ipcMain.handle('agents:detect', async () => {
  const bins = ['claude', 'gemini', 'codex', 'aider', 'antigravity'];
  const out: Record<string, boolean> = {};
  await Promise.all(bins.map(async (b) => { out[b] = !!(await resolveBin(b)); }));
  return out;
});

ipcMain.handle('open:external', (_e, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

/* -------------------- worktree helpers (shared by issue + PR worktrees) -------------------- */
// Resolve a LOCAL clone of the SELECTED repo: prefer the open folder when its remote IS this repo,
// else use — or create — a managed clone under %APPDATA%\Relay\repos\<provider>__<owner>__<repo>. The
// provider CLI (gh/glab) carries your login so private/org repos clone without a token in .git/config;
// Bitbucket (no CLI) falls back to `git clone`, using the OS git credential helper.
// `preferManaged` (deps only): NEVER use the open folder — always the isolated managed clone. Dep-linking
// hard-resets the resolved clone to the latest default, which must never touch the user's working directory.
async function resolveRepoRoot(git: string, provider: ProviderId, repo: string, dir?: string, preferManaged = false): Promise<{ ok: true; repoRoot: string } | { ok: false; error: string }> {
  const adapter = providerOf(provider);
  if (!adapter) return { ok: false, error: 'Unknown provider' };
  let repoRoot = '';
  if (!preferManaged && typeof dir === 'string' && dir) {
    const top = await runBin(git, ['-C', dir, 'rev-parse', '--show-toplevel']);
    if (top.ok) {
      const root = top.stdout.trim();
      const rem = await runBin(git, ['-C', root, 'remote', 'get-url', 'origin']);
      const fromRemote = rem.ok ? providerFromRemote(rem.stdout) : null;
      if (fromRemote && fromRemote.provider === provider && fromRemote.repo === repo) repoRoot = root;
    }
  }
  if (!repoRoot) {
    const cacheRoot = path.join(app.getPath('userData'), 'repos', `${provider}__${repo.replace(/\//g, '__')}`);
    if (existsSync(path.join(cacheRoot, '.git'))) {
      repoRoot = cacheRoot;
      await runBin(git, ['-C', cacheRoot, 'fetch', 'origin', '--prune'], { timeout: 120000 }); // freshen (best-effort)
    } else {
      await fsp.mkdir(path.dirname(cacheRoot), { recursive: true });
      const cliBin = adapter.cli ? await resolveBin(adapter.cli) : null;
      const clone = cliBin && adapter.cliCloneArgs
        ? await runBin(cliBin, adapter.cliCloneArgs(repo, cacheRoot), { timeout: 300000 })
        : await runBin(git, ['clone', await adapter.cloneUrl(repo), cacheRoot], { timeout: 300000 });
      if (!clone.ok || !existsSync(path.join(cacheRoot, '.git'))) {
        const msg = (clone.stderr || clone.stdout || 'clone failed').trim().split('\n').filter(Boolean).pop() || 'clone failed';
        return { ok: false, error: `Couldn't clone ${repo}: ${msg}` };
      }
      repoRoot = cacheRoot;
    }
  }
  return { ok: true, repoRoot };
}

// A worktree folder name disambiguated by a short hash of the repo's absolute path, so two different
// repos that share a basename (…/a/app and …/b/app) never collide onto the same worktree folder.
function worktreeFolder(repoRoot: string): string {
  return `${path.basename(repoRoot) || 'repo'}-${createHash('sha1').update(repoRoot.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 8)}`;
}
// Resolve the repo root for an EXISTING checkout WITHOUT any side effects (no fetch, no clone) — used to
// locate already-created worktrees so the rail can reopen a terminal into them. Returns null if neither the
// open folder is this repo nor a managed clone exists (⇒ no worktrees could exist).
async function locateRepoRoot(git: string, provider: ProviderId, repo: string, dir?: string): Promise<string | null> {
  if (typeof dir === 'string' && dir) {
    const top = await runBin(git, ['-C', dir, 'rev-parse', '--show-toplevel']);
    if (top.ok) {
      const root = top.stdout.trim();
      const rem = await runBin(git, ['-C', root, 'remote', 'get-url', 'origin']);
      const fromRemote = rem.ok ? providerFromRemote(rem.stdout) : null;
      if (fromRemote && fromRemote.provider === provider && fromRemote.repo === repo) return root;
    }
  }
  const cacheRoot = path.join(app.getPath('userData'), 'repos', `${provider}__${repo.replace(/\//g, '__')}`);
  return existsSync(path.join(cacheRoot, '.git')) ? cacheRoot : null;
}
// Recursively sum file bytes under a dir. Skips `.deps` (junctions into the shared managed clones — not this
// worktree's own bytes) and symlinks, so a worktree's size isn't inflated by (or looped through) linked repos.
async function dirSize(p: string, deadline = Infinity): Promise<number> {
  if (Date.now() > deadline) return 0;
  let total = 0;
  const ents = await fsp.readdir(p, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[]);
  for (const e of ents) {
    if (Date.now() > deadline) break;   // time-budget: bail out; the returned size becomes a lower bound
    if (e.isSymbolicLink() || e.name === '.deps') continue;
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += await dirSize(full, deadline);
    else if (e.isFile()) { const st = await fsp.stat(full).catch(() => null); if (st) total += st.size; }
  }
  return total;
}

// Drop stale worktree registrations, then sweep the empty <folder>/<branch> and <folder> dirs a
// hand-deleted worktree leaves behind, so the tree doesn't accumulate orphans and a stale-empty path
// can't make `worktree add` fail with "already exists". Only ever removes genuinely-empty dirs.
async function pruneAndSweepWorktrees(git: string, repoRoot: string): Promise<void> {
  await runBin(git, ['-C', repoRoot, 'worktree', 'prune']);
  try {
    const wtBase = path.join(app.getPath('userData'), 'worktrees');
    for (const fld of await fsp.readdir(wtBase).catch(() => [] as string[])) {
      const fldPath = path.join(wtBase, fld);
      if (!(await fsp.stat(fldPath).catch(() => null))?.isDirectory()) continue;
      for (const leaf of await fsp.readdir(fldPath).catch(() => [] as string[])) {
        const leafPath = path.join(fldPath, leaf);
        const st = await fsp.stat(leafPath).catch(() => null);
        if (st?.isDirectory() && (await fsp.readdir(leafPath).catch(() => ['x'])).length === 0) await fsp.rmdir(leafPath).catch(() => {});
      }
      if ((await fsp.readdir(fldPath).catch(() => ['x'])).length === 0) await fsp.rmdir(fldPath).catch(() => {});
    }
  } catch (err) { logFatal('worktree/sweep', err); } // sweep is best-effort; the worktree still opens
}

// Drop the (edited) brief inside the worktree's .slayer/ and locally git-exclude .slayer/ so it never
// shows up / gets committed. Returns the repo-relative brief path (or undefined on any failure).
async function dropSlayerBrief(git: string, wtPath: string, briefRel: string, brief: string): Promise<string | undefined> {
  if (!brief) return undefined;
  try {
    await fsp.mkdir(path.join(wtPath, '.slayer'), { recursive: true });
    await fsp.writeFile(path.join(wtPath, briefRel), brief, 'utf8');
    const gp = await runBin(git, ['-C', wtPath, 'rev-parse', '--git-path', 'info/exclude']);
    if (gp.ok) {
      const excl = path.isAbsolute(gp.stdout.trim()) ? gp.stdout.trim() : path.join(wtPath, gp.stdout.trim());
      const curExcl = await fsp.readFile(excl, 'utf8').catch(() => '');
      // Strip CR before the presence test — on a CRLF exclude the line is ".slayer/\r", which /$/m
      // (matching just before \n) would miss, re-appending a duplicate on every re-assign.
      if (!/^\.slayer\/?$/m.test(curExcl.replace(/\r/g, ''))) await fsp.writeFile(excl, (!curExcl || curExcl.endsWith('\n') ? curExcl : curExcl + '\n') + '.slayer/\n', 'utf8');
    }
    return briefRel;
  } catch (err) { logFatal('worktree/brief', err); return undefined; } // brief is best-effort; the worktree still opens
}

// Create (or reuse) an ISOLATED git worktree for an issue: a per-issue working dir on branch
// issue-<n>, so several issues can be worked in parallel without disturbing the main checkout.
// Also drops the (edited) issue brief as .slayer/issue-<n>.md and locally git-excludes it, so the
// agent's PR never carries the brief. Returns the worktree path + brief's repo-relative path.
ipcMain.handle('git:worktree-add', async (_e, p: { provider?: ProviderId; repo: string; dir: string; number: number; brief?: string }) => {
  try {
    const repo = p?.repo, dir = p?.dir, num = p?.number;
    const provider = (p?.provider || 'github') as ProviderId;   // default github (back-compat for older callers)
    if (!providerOf(provider) || typeof repo !== 'string' || !/^[\w.-]+(\/[\w.-]+)+$/.test(repo) || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'Invalid request' };
    const git = await resolveBin('git');
    if (!git) return { ok: false, error: 'git not found on PATH' };
    const rr = await resolveRepoRoot(git, provider, repo, dir);
    if (!rr.ok) return { ok: false, error: rr.error };
    const repoRoot = rr.repoRoot;
    // An unborn repo (git init, no commits) can't seed a worktree branch — say so plainly.
    if (!(await runBin(git, ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', 'HEAD'])).ok)
      return { ok: false, error: 'This repository has no commits yet — make an initial commit first.' };
    // Always fetch so a NEW branch starts from the LATEST remote default — a stale base is the top cause of
    // merge conflicts. fetch only advances remote-tracking refs (origin/*); it never touches your local
    // branches or working tree. Best-effort: an offline/auth failure just falls back to what's already fetched.
    await runBin(git, ['-C', repoRoot, 'fetch', 'origin', '--prune'], { timeout: 120000 });
    // The remote default branch name (main / master / whatever origin points at). Prefer origin/HEAD; if it
    // isn't recorded locally, ask the remote to set it, then re-read; else probe origin/main then origin/master.
    let dh = await runBin(git, ['-C', repoRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (!dh.ok) { await runBin(git, ['-C', repoRoot, 'remote', 'set-head', 'origin', '-a']); dh = await runBin(git, ['-C', repoRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']); }
    let base = dh.ok ? dh.stdout.trim().replace(/^origin\//, '') : '';
    if (!base) { for (const b of ['main', 'master']) { if ((await runBin(git, ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`])).ok) { base = b; break; } } }
    // Start point = the COMMIT at the freshly-fetched origin/<base> (NOT the local branch, which fetch never
    // fast-forwards, so it can lag). Branching from the SHA sets NO upstream — issue-N still pushes to its own
    // remote branch exactly as before; only the base gets fresher. Fall back to local HEAD if there's no remote default.
    let startPoint = '';
    if (base) { const rp = await runBin(git, ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]); if (rp.ok) startPoint = rp.stdout.trim(); }
    if (!startPoint) { const cur = await runBin(git, ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD']); base = (cur.ok && cur.stdout.trim()) || 'HEAD'; startPoint = base; }
    const branch = `issue-${num}`;
    const folder = worktreeFolder(repoRoot);
    const wtPath = path.join(app.getPath('userData'), 'worktrees', folder, branch);
    const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
    await pruneAndSweepWorktrees(git, repoRoot);
    // Already have a worktree for this issue? Reuse it (re-assigning the same issue is idempotent).
    const list = await runBin(git, ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
    const reused = list.ok && norm(list.stdout).split('\n').some((ln) => ln.startsWith('worktree ') && norm(ln.slice(9).trim()) === norm(wtPath));
    if (!reused) {
      // Branch may already exist from a prior run whose worktree was pruned — re-attach it instead of -b.
      const hasBranch = (await runBin(git, ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
      const addArgs = hasBranch
        ? ['-C', repoRoot, 'worktree', 'add', wtPath, branch]
        : ['-C', repoRoot, 'worktree', 'add', wtPath, '-b', branch, startPoint];
      const add = await runBin(git, addArgs, { timeout: 60000 });
      if (!add.ok) {
        const msg = (add.stderr || add.stdout || 'git worktree add failed').trim().split('\n').filter(Boolean).pop() || 'git worktree add failed';
        return { ok: false, error: msg };
      }
    }
    const briefRel = await dropSlayerBrief(git, wtPath, `.slayer/issue-${num}.md`, typeof p?.brief === 'string' ? p.brief : '');
    return { ok: true, path: wtPath, branch, base, reused, briefRel };
  } catch (err) { logFatal('git:worktree-add', err); return { ok: false, error: 'Worktree creation failed' }; }
});

// List EXISTING worktree dirs for a repo (branch → path), NO fetch/clone. The Issues/Tasks rails use it to
// offer "reopen a terminal" on an issue/task whose worktree survived a closed tab / crash / accidental quit.
ipcMain.handle('git:worktrees', async (_e, p: { provider?: ProviderId; repo: string; dir?: string }) => {
  try {
    const provider = (p?.provider || 'github') as ProviderId;
    if (!providerOf(provider) || !validRepo(p?.repo)) return { ok: false, list: [] };
    const git = await resolveBin('git'); if (!git) return { ok: false, list: [] };
    const repoRoot = await locateRepoRoot(git, provider, p.repo, typeof p?.dir === 'string' ? p.dir : undefined);
    if (!repoRoot) return { ok: true, list: [] };   // never checked out here ⇒ no worktrees
    const base = path.join(app.getPath('userData'), 'worktrees', worktreeFolder(repoRoot));
    const branches = await fsp.readdir(base).catch(() => [] as string[]);   // the sweep removes empties, so what's left is real
    return { ok: true, list: branches.map((branch) => ({ branch, path: path.join(base, branch) })) };
  } catch (err) { logFatal('git:worktrees', err); return { ok: false, list: [] }; }
});

// Live app resource usage for the About dialog. getAppMetrics() covers EVERY app process (main + renderer +
// GPU + utility); RAM = summed working sets, CPU = summed per-process %. Cheap → safe to poll while open.
ipcMain.handle('app:stats', () => {
  try {
    const metrics = app.getAppMetrics();
    const ramKB = metrics.reduce((s, m) => s + (m.memory?.workingSetSize || 0), 0);   // workingSetSize is KB
    const cpu = metrics.reduce((s, m) => s + (m.cpu?.percentCPUUsage || 0), 0);
    return { ramMB: Math.round(ramKB / 1024), cpuPct: Math.round(cpu) };
  } catch { return { ramMB: 0, cpuPct: 0 }; }
});
// Every worktree on disk (branch + age only) — FAST (no size walk; summing bytes over full checkouts +
// .git + node_modules is far too slow, even native `du` times out). Sizes come lazily via worktrees:size.
ipcMain.handle('worktrees:list', async () => {
  try {
    const wtBase = path.join(app.getPath('userData'), 'worktrees');
    const list: { folder: string; branch: string; path: string; mtimeMs: number }[] = [];
    for (const folder of await fsp.readdir(wtBase).catch(() => [] as string[])) {
      const fpath = path.join(wtBase, folder);
      if (!(await fsp.stat(fpath).catch(() => null))?.isDirectory()) continue;
      for (const branch of await fsp.readdir(fpath).catch(() => [] as string[])) {
        const wp = path.join(fpath, branch);
        const st = await fsp.stat(wp).catch(() => null); if (!st?.isDirectory()) continue;
        list.push({ folder, branch, path: wp, mtimeMs: st.mtimeMs });
      }
    }
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);   // most-recently-used first
    return { ok: true, list };
  } catch (err) { logFatal('worktrees:list', err); return { ok: false, list: [] }; }
});
// Size of ONE worktree, time-budgeted (~2.5s) so a giant node_modules can't hang the UI. `partial` ⇒ the walk
// was cut short and sizeMB is a lower bound. Path must be under the worktrees dir.
ipcMain.handle('worktrees:size', async (_e, p: { path: string }) => {
  try {
    const wtBase = path.resolve(path.join(app.getPath('userData'), 'worktrees'));
    const target = path.resolve(typeof p?.path === 'string' ? p.path : '');
    if (target === wtBase || !target.startsWith(wtBase + path.sep)) return { ok: false };
    const deadline = Date.now() + 2500;
    const bytes = await dirSize(target, deadline);
    return { ok: true, sizeMB: Math.round(bytes / 1048576), partial: Date.now() > deadline };
  } catch { return { ok: false }; }
});
// Budgeted total disk of worktrees + the clone cache (a lower bound when it hits the ~5s budget) — for the
// About "Storage" line, so it stays responsive instead of walking millions of files to completion.
ipcMain.handle('worktrees:total', async () => {
  try {
    const ud = app.getPath('userData');
    const deadline = Date.now() + 5000;
    const wt = await dirSize(path.join(ud, 'worktrees'), deadline);
    const repos = await dirSize(path.join(ud, 'repos'), deadline);
    return { ok: true, totalMB: Math.round((wt + repos) / 1048576), partial: Date.now() > deadline };
  } catch { return { ok: false, totalMB: 0, partial: false }; }
});
// Delete a worktree dir to reclaim disk. Path MUST be strictly under the worktrees dir (never delete elsewhere).
// git's registration for it becomes stale and is pruned on the next worktree-add (pruneAndSweepWorktrees).
ipcMain.handle('worktrees:remove', async (_e, p: { path: string }) => {
  try {
    const wtBase = path.resolve(path.join(app.getPath('userData'), 'worktrees'));
    const target = path.resolve(typeof p?.path === 'string' ? p.path : '');
    if (target === wtBase || !target.startsWith(wtBase + path.sep)) return { ok: false, error: 'Invalid path' };
    await fsp.rm(target, { recursive: true, force: true });
    return { ok: true };
  } catch (err) { logFatal('worktrees:remove', err); return { ok: false, error: 'Could not remove worktree' }; }
});

// Create (or reuse) an isolated worktree with a PR/MR's SOURCE branch checked out, so a review pipeline
// inspects the ACTUAL diff (not a fresh branch). Fetches the PR head — GitHub `refs/pull/<n>/head`, GitLab
// `refs/merge-requests/<n>/head` (both exposed on origin, so even fork PRs work), Bitbucket the source
// branch by name (no numbered PR ref → same-repo PRs only). Branch `pr-<n>`; brief at .slayer/pr-<n>.md.
ipcMain.handle('git:pr-worktree-add', async (_e, p: { provider?: ProviderId; repo: string; dir: string; number: number; branch?: string; brief?: string }) => {
  try {
    const repo = p?.repo, dir = p?.dir, num = p?.number;
    const provider = (p?.provider || 'github') as ProviderId;
    if (!providerOf(provider) || typeof repo !== 'string' || !/^[\w.-]+(\/[\w.-]+)+$/.test(repo) || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'Invalid request' };
    const git = await resolveBin('git');
    if (!git) return { ok: false, error: 'git not found on PATH' };
    const rr = await resolveRepoRoot(git, provider, repo, dir);
    if (!rr.ok) return { ok: false, error: rr.error };
    const repoRoot = rr.repoRoot;
    if (!(await runBin(git, ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', 'HEAD'])).ok)
      return { ok: false, error: 'This repository has no commits yet.' };
    const branch = `pr-${num}`;
    const folder = worktreeFolder(repoRoot);
    const wtPath = path.join(app.getPath('userData'), 'worktrees', folder, branch);
    const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
    await pruneAndSweepWorktrees(git, repoRoot);
    const list = await runBin(git, ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
    const reused = list.ok && norm(list.stdout).split('\n').some((ln) => ln.startsWith('worktree ') && norm(ln.slice(9).trim()) === norm(wtPath));
    if (!reused) {
      // Fetch the PR head into FETCH_HEAD, then point local branch pr-<n> at it and check it out.
      const srcBranch = typeof p?.branch === 'string' ? p.branch.trim() : '';
      const ref = provider === 'github' ? `refs/pull/${num}/head`
        : provider === 'gitlab' ? `refs/merge-requests/${num}/head`
        : srcBranch;
      if (!ref) return { ok: false, error: 'No source branch for this pull request.' };
      const fetched = await runBin(git, ['-C', repoRoot, 'fetch', 'origin', ref], { timeout: 120000 });
      if (!fetched.ok) {
        const msg = (fetched.stderr || fetched.stdout || 'fetch failed').trim().split('\n').filter(Boolean).pop() || 'fetch failed';
        return { ok: false, error: `Couldn't fetch ${provider === 'gitlab' ? 'MR' : 'PR'} #${num}: ${msg}` };
      }
      // -f creates or moves pr-<n> to the fetched head (safe: no live worktree holds it when !reused).
      const bf = await runBin(git, ['-C', repoRoot, 'branch', '-f', branch, 'FETCH_HEAD']);
      if (!bf.ok) { const msg = (bf.stderr || bf.stdout || 'branch failed').trim().split('\n').filter(Boolean).pop() || 'branch failed'; return { ok: false, error: msg }; }
      const add = await runBin(git, ['-C', repoRoot, 'worktree', 'add', wtPath, branch], { timeout: 60000 });
      if (!add.ok) { const msg = (add.stderr || add.stdout || 'git worktree add failed').trim().split('\n').filter(Boolean).pop() || 'git worktree add failed'; return { ok: false, error: msg }; }
    }
    const briefRel = await dropSlayerBrief(git, wtPath, `.slayer/pr-${num}.md`, typeof p?.brief === 'string' ? p.brief : '');
    return { ok: true, path: wtPath, branch, reused, briefRel };
  } catch (err) { logFatal('git:pr-worktree-add', err); return { ok: false, error: 'Worktree creation failed' }; }
});

// Link one or more DEPENDENCY repos into an issue worktree as READ-ONLY reference (e.g. a FE issue that needs
// to read the BE codebase). Each dep is resolved/cloned like an issue repo, updated to its LATEST default
// branch, then junction/symlinked into `<wt>/.deps/<name>` (git-excluded, so it never enters the issue's PR).
// The agent reads `.deps/<name>/…` for context; the "read-only" contract is by instruction (in the brief).
ipcMain.handle('git:link-deps', async (_e, p: { wt: string; dir?: string; deps: { provider?: ProviderId; repo: string }[] }) => {
  try {
    const wt = p?.wt;
    if (!wt || !existsSync(wt)) return { ok: false, error: 'worktree missing' };
    const git = await resolveBin('git');
    if (!git) return { ok: false, error: 'git not found on PATH' };
    const depsDir = path.join(wt, '.deps');
    await fsp.mkdir(depsDir, { recursive: true });
    // Locally git-exclude .deps/ (same as .slayer/) so the linked repos never show up in the issue's diff.
    try {
      const gp = await runBin(git, ['-C', wt, 'rev-parse', '--git-path', 'info/exclude']);
      if (gp.ok) {
        const excl = path.isAbsolute(gp.stdout.trim()) ? gp.stdout.trim() : path.join(wt, gp.stdout.trim());
        const cur = await fsp.readFile(excl, 'utf8').catch(() => '');
        if (!/^\.deps\/?$/m.test(cur.replace(/\r/g, ''))) await fsp.writeFile(excl, (!cur || cur.endsWith('\n') ? cur : cur + '\n') + '.deps/\n', 'utf8');
      }
    } catch (err) { logFatal('git:link-deps/exclude', err); }
    const linked: { name: string; repo: string }[] = [];
    for (const d of (p?.deps || [])) {
      const provider = (d?.provider || 'github') as ProviderId;
      if (!d?.repo || !/^[\w.-]+(\/[\w.-]+)+$/.test(d.repo)) continue;
      const rr = await resolveRepoRoot(git, provider, d.repo, p?.dir, true); // preferManaged: never reset the open folder
      if (!rr.ok) continue;                                     // a dep that won't resolve/clone is skipped (best-effort)
      const clone = rr.repoRoot;
      // Update the (shared cache) clone to the latest default branch — reset is safe: it's a read-only reference.
      await runBin(git, ['-C', clone, 'fetch', 'origin', '--prune'], { timeout: 120000 });
      let dh = await runBin(git, ['-C', clone, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      if (!dh.ok) { await runBin(git, ['-C', clone, 'remote', 'set-head', 'origin', '-a']); dh = await runBin(git, ['-C', clone, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']); }
      let def = dh.ok ? dh.stdout.trim().replace(/^origin\//, '') : '';
      if (!def) { for (const b of ['main', 'master']) { if ((await runBin(git, ['-C', clone, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`])).ok) { def = b; break; } } }
      if (def && (await runBin(git, ['-C', clone, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${def}`])).ok) {
        await runBin(git, ['-C', clone, 'checkout', '-f', def]);
        await runBin(git, ['-C', clone, 'reset', '--hard', `origin/${def}`]);
      }
      const name = d.repo.split('/').pop() || 'dep';
      const link = path.join(depsDir, name);
      // The junction target (the managed clone) is a STABLE path, so an existing link already reflects the
      // just-refreshed content — only create it when missing. (Never remove-recurse a junction: that could
      // delete the target.) 'junction' on Windows needs no admin; 'dir' symlink elsewhere.
      if (!existsSync(link)) {
        try { await fsp.symlink(clone, link, process.platform === 'win32' ? 'junction' : 'dir'); }
        catch (err) { logFatal('git:link-deps/symlink', err); continue; }
      }
      linked.push({ name, repo: d.repo });
    }
    return { ok: true, linked };
  } catch (err) { logFatal('git:link-deps', err); return { ok: false, error: 'Could not link dependencies' }; }
});

// Create (or reuse) a worktree for a TASK's validate run — a branch `task-<id>` off the LATEST remote default,
// so the agent can investigate the repo to validate a proposed issue (read-only; no PR). Brief → .slayer/task-<id>.md.
ipcMain.handle('git:task-worktree-add', async (_e, p: { provider?: ProviderId; repo: string; dir: string; id: string; brief?: string }) => {
  try {
    const repo = p?.repo, dir = p?.dir;
    const provider = (p?.provider || 'github') as ProviderId;
    const id = String(p?.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);   // sanitize → safe branch/folder name
    if (!providerOf(provider) || typeof repo !== 'string' || !/^[\w.-]+(\/[\w.-]+)+$/.test(repo) || !id) return { ok: false, error: 'Invalid request' };
    const git = await resolveBin('git'); if (!git) return { ok: false, error: 'git not found on PATH' };
    const rr = await resolveRepoRoot(git, provider, repo, dir);
    if (!rr.ok) return { ok: false, error: rr.error };
    const repoRoot = rr.repoRoot;
    if (!(await runBin(git, ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', 'HEAD'])).ok) return { ok: false, error: 'This repository has no commits yet.' };
    // Start from the freshly-fetched remote default (same logic as issue worktrees).
    await runBin(git, ['-C', repoRoot, 'fetch', 'origin', '--prune'], { timeout: 120000 });
    let dh = await runBin(git, ['-C', repoRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (!dh.ok) { await runBin(git, ['-C', repoRoot, 'remote', 'set-head', 'origin', '-a']); dh = await runBin(git, ['-C', repoRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']); }
    let base = dh.ok ? dh.stdout.trim().replace(/^origin\//, '') : '';
    if (!base) { for (const b of ['main', 'master']) { if ((await runBin(git, ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`])).ok) { base = b; break; } } }
    let startPoint = '';
    if (base) { const rp = await runBin(git, ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]); if (rp.ok) startPoint = rp.stdout.trim(); }
    if (!startPoint) { const cur = await runBin(git, ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD']); startPoint = (cur.ok && cur.stdout.trim()) || 'HEAD'; }
    const branch = `task-${id}`;
    const folder = worktreeFolder(repoRoot);
    const wtPath = path.join(app.getPath('userData'), 'worktrees', folder, branch);
    const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
    await pruneAndSweepWorktrees(git, repoRoot);
    const list = await runBin(git, ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
    const reused = list.ok && norm(list.stdout).split('\n').some((ln) => ln.startsWith('worktree ') && norm(ln.slice(9).trim()) === norm(wtPath));
    if (!reused) {
      const hasBranch = (await runBin(git, ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
      const addArgs = hasBranch ? ['-C', repoRoot, 'worktree', 'add', wtPath, branch] : ['-C', repoRoot, 'worktree', 'add', wtPath, '-b', branch, startPoint];
      const add = await runBin(git, addArgs, { timeout: 60000 });
      if (!add.ok) { const msg = (add.stderr || add.stdout || 'git worktree add failed').trim().split('\n').filter(Boolean).pop() || 'git worktree add failed'; return { ok: false, error: msg }; }
    }
    const briefRel = await dropSlayerBrief(git, wtPath, `.slayer/task-${id}.md`, typeof p?.brief === 'string' ? p.brief : '');
    return { ok: true, path: wtPath, branch, reused, briefRel };
  } catch (err) { logFatal('git:task-worktree-add', err); return { ok: false, error: 'Worktree creation failed' }; }
});

/* -------------------- issue pipelines (staged agent runs, gated by verdict files) -------------------- */
// Every pipeline artifact lives in the worktree's `.slayer/` dir (already git-excluded by worktree-add):
// per-stage brief files `stage-<i>.md` and per-gate verdict files `stage-<i>.json`. Both handlers refuse
// any path that escapes `.slayer/` — the renderer only ever passes those two shapes, but validate anyway.
function slayerPath(wt: string, rel: string): string | null {
  if (typeof wt !== 'string' || !wt || typeof rel !== 'string' || !rel) return null;
  const base = path.resolve(wt, '.slayer');
  const abs = path.resolve(wt, rel);
  const within = abs === base || abs.startsWith(base + path.sep);
  return within ? abs : null; // reject anything outside .slayer/ (path traversal guard)
}
// Prep a stage before launch: (optionally) write its brief file, and always clear this stage's stale
// verdict (so a re-run of a reused worktree can't read the previous run's pass/fail).
ipcMain.handle('pipeline:prep', async (_e, p: { wt: string; briefRel?: string; brief?: string; stage: number }) => {
  try {
    const wt = p?.wt || '';
    const dir = path.join(wt, '.slayer');
    await fsp.mkdir(dir, { recursive: true });
    if (typeof p?.briefRel === 'string' && p.briefRel && typeof p?.brief === 'string') {
      const bp = slayerPath(wt, p.briefRel); if (!bp) return { ok: false };
      await fsp.writeFile(bp, p.brief, 'utf8');
    }
    if (Number.isInteger(p?.stage)) {
      const vp = slayerPath(wt, `.slayer/stage-${p.stage}.json`);
      if (vp) await fsp.rm(vp, { force: true }); // clear stale verdict; force → no throw if absent
    }
    return { ok: true };
  } catch (err) { logFatal('pipeline:prep', err); return { ok: false }; }
});
// Read a gate stage's verdict. `found:false` until the agent has written it — the renderer polls this.
ipcMain.handle('pipeline:verdict', async (_e, p: { wt: string; stage: number }) => {
  try {
    if (!Number.isInteger(p?.stage)) return { found: false }; // guard the stage index like pipeline:prep does
    const vp = slayerPath(p?.wt || '', `.slayer/stage-${p?.stage}.json`);
    if (!vp || !existsSync(vp)) return { found: false };
    const raw = await fsp.readFile(vp, 'utf8');
    let obj: unknown;
    try { obj = JSON.parse(raw); } catch { return { found: false }; } // half-written file → treat as not-yet-ready; poll again
    const o = (obj || {}) as { passed?: unknown; summary?: unknown };
    if (typeof o.passed !== 'boolean') return { found: false }; // no verdict yet (agent wrote a partial object)
    return { found: true, passed: o.passed, summary: typeof o.summary === 'string' ? o.summary : '' };
  } catch (err) { logFatal('pipeline:verdict', err); return { found: false }; }
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
// Open `p` in the given editor launcher. `cmd` is ALWAYS an allowlisted token from shared/editors.ts (never a
// raw renderer string), so interpolating it into the Windows shell line below can't inject a command.
function tryEditor(cmd: string, p: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!cmd) return resolve(false); // no editor (system default) — caller falls back to shell.openPath
    if (process.platform === 'win32') {
      // Editor launchers are often .cmd on Windows and need a shell; reject chars in the PATH that could break
      // out of the quoted argument or trigger %VAR% expansion, so a crafted filename can't inject a command.
      if (/["%\r\n]/.test(p)) return resolve(false);
      exec(`${cmd} "${p}"`, { windowsHide: true, timeout: 15000 }, (err) => resolve(!err));
    } else {
      // No shell → the path is a literal argv entry, so $(...)/backticks in a filename can't expand.
      execFile(cmd, [p], { timeout: 15000 }, (err) => resolve(!err));
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
  const id = (await store.getSettings()).fileEditor; // which editor the user chose (allowlisted in shared/editors.ts)
  const cmd = editorCmd(id);
  if (cmd && isCodeFile(abs) && (await tryEditor(cmd, abs))) return { method: 'editor', editor: editorLabel(id) };
  const err = await shell.openPath(abs); // OS default app for the file type (non-code files, 'system', or a missing editor)
  return { method: err ? 'error' : 'default', error: err || undefined };
});
// Open a path the terminal printed — relative paths resolve against the tab's cwd. Strips a trailing
// :line[:col] suffix, and SILENTLY no-ops if it doesn't resolve to a real file, so clicking path-like
// text that isn't actually a file (a false-positive link) does nothing rather than erroring.
ipcMain.handle('fs:open-rel', async (_e, p: { cwd?: string; target: string }) => {
  const raw = typeof p?.target === 'string' ? p.target : '';
  if (!raw) return { ok: false };
  const bare = raw.replace(/:\d+(?::\d+)?$/, ''); // drop a trailing :line or :line:col
  const cwd = typeof p?.cwd === 'string' && p.cwd ? p.cwd : app.getPath('home');
  const abs = path.isAbsolute(bare) ? bare : path.resolve(cwd, bare);
  if (!existsSync(abs)) return { ok: false };
  const cmd = editorCmd((await store.getSettings()).fileEditor);
  if (cmd && isCodeFile(abs) && (await tryEditor(cmd, abs))) return { ok: true, method: 'editor' };
  const err = await shell.openPath(abs);
  return { ok: !err, method: err ? 'error' : 'default' };
});

/* -------------------- workspace (open tabs) -------------------- */
ipcMain.handle('workspace:get', () => store.getWorkspace());
ipcMain.on('workspace:set', (_e, ws) => { void store.setWorkspace(ws); });
// Awaitable flush (unlike the fire-and-forget 'workspace:set') — cloud-sync push calls this first so the backup
// captures the CURRENT tab snapshot rather than one up to ~1.5s stale from the autosave debounce. Does NOT
// finalize (unlike set-sync), so autosave keeps working afterward.
ipcMain.handle('workspace:flush', async (_e, ws) => { try { await store.setWorkspace(ws); } catch (err) { logFatal('workspace:flush', err); } return { ok: true }; });
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
