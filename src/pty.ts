import * as os from 'node:os';
import * as fsync from 'node:fs';
import type { WebContents } from 'electron';
import * as pty from 'node-pty';
import { createShellParser, shellIntegrationInit, type BlockEvent } from './blocks';

// One real pseudo-terminal per terminal id. The shell keeps running even when its
// tab is closed (detached), so reopening the terminal can REATTACH and replay the
// full output buffer — a true resume, not a fresh shell. Output is streamed to the
// currently attached renderer; the renderer draws it with xterm.js.

interface Term {
  proc: pty.IPty;
  buf: string;                    // rolling output buffer, for replay on reattach
  wc: WebContents | null;         // currently attached renderer (null when detached)
  parser: { feed(chunk: string): string } | null; // shell-integration block parser
}

const terms = new Map<string, Term>();
const BUF_CAP = 512 * 1024;       // cap replay buffer (~512 KB of output)

// We replay restored history into SCROLLBACK (above a clean viewport — see createTerm),
// which is immune to viewport clears and resizes. The only sequences that could still
// reach scrollback are erase-scrollback (CSI 3J) and full reset (ESC c), which a fresh
// shell can emit on startup — so we strip just those for a short window after spawn.
// Everything else (viewport clears, cursor moves, alt-screen) is harmless to scrollback
// and left untouched, so normal shell behaviour (cls, vim, …) is unaffected.
const STARTUP_GUARD_MS = 1500;
const STARTUP_CLEARS = /\x1b\[3J|\x1bc/g;

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.RELAY_SHELL || 'powershell.exe';
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

/**
 * Create OR reattach a terminal. Returns true if it reattached to an existing
 * live shell (buffer replayed), false if a new shell was spawned.
 */
export function createTerm(id: string, cwd: string, wc: WebContents, cols = 80, rows = 24, restore?: string, integrate = false): boolean {
  const existing = terms.get(id);
  if (existing) {
    // Same-run resume: the shell is still alive — replay its real output. (restore ignored.)
    existing.wc = wc;
    try { existing.proc.resize(cols, rows); } catch { /* pty may have exited */ }
    if (!wc.isDestroyed() && existing.buf) wc.send('pty:data', { id, data: existing.buf });
    return true;
  }

  const startDir = cwd && fsync.existsSync(cwd) ? cwd : os.homedir(); // saved folder may be gone
  const shellPath = defaultShell();
  const base = shellPath.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  // PowerShell: inject the shell-integration setup via -EncodedCommand at startup so it runs
  // silently (never echoed as a typed line, even on restored terminals) and before the first
  // prompt. bash/zsh get it typed in after spawn (below). Base64 avoids all quoting issues.
  const isPwsh = integrate && (base.includes('powershell') || base.startsWith('pwsh'));
  const spawnArgs = isPwsh
    ? ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(shellIntegrationInit('powershell'), 'utf16le').toString('base64')]
    : [];
  const proc = pty.spawn(shellPath, spawnArgs, {
    name: 'xterm-color',
    cols,
    rows,
    cwd: startDir,
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  });
  const term: Term = { proc, buf: '', wc, parser: null };
  terms.set(id, term);

  // Shell integration: the parser turns the shell's OSC markers into structured command
  // blocks (streamed to the renderer as pty:block) and strips the markers from the text
  // that reaches xterm. The markers are enabled by an init line sent below.
  const parser = integrate
    ? createShellParser((e: BlockEvent) => {
        if (term.wc && !term.wc.isDestroyed()) term.wc.send('pty:block', { id, event: e });
      })
    : null;
  term.parser = parser;

  // Cross-restart resume: the OS shell process is gone, so we replay the saved output
  // under a brand-new shell. A fresh shell (PowerShell/ConPTY especially) repaints by
  // clearing its VIEWPORT on startup and on the first resize, which would wipe replayed
  // history left on screen. So we push the replayed history up into the SCROLLBACK with
  // trailing newlines, leaving a clean viewport for the fresh shell.
  if (restore) {
    const pushToScrollback = '\r\n'.repeat(Math.max(rows, 1));
    term.buf = restore + '\r\n\x1b[90m— end of restored session · scroll up ↑ · shell below is fresh —\x1b[0m' + pushToScrollback;
    if (!wc.isDestroyed()) wc.send('pty:data', { id, data: term.buf });
  }

  const spawnAt = Date.now();
  proc.onData((data) => {
    // For a brief window after a restore-spawn, drop the shell's startup clears so its
    // repaint can't wipe the restored history. After the window, everything works normally.
    if (restore && Date.now() - spawnAt < STARTUP_GUARD_MS) data = data.replace(STARTUP_CLEARS, '');
    const clean = parser ? parser.feed(data) : data; // strip integration markers before display
    term.buf += clean;
    if (term.buf.length > BUF_CAP) term.buf = term.buf.slice(term.buf.length - BUF_CAP);
    if (term.wc && !term.wc.isDestroyed()) term.wc.send('pty:data', { id, data: clean });
  });
  proc.onExit(({ exitCode }) => {
    if (term.wc && !term.wc.isDestroyed()) term.wc.send('pty:exit', { id, exitCode });
    terms.delete(id);
  });

  // Enable the block markers once the shell is ready to read input (a short delay lets the
  // profile finish loading so the prompt-function redefinition sticks).
  // bash/zsh: enable integration by typing the init in once the shell is ready (PowerShell
  // already got it via -EncodedCommand at spawn). Clear the one-time echo on a fresh terminal.
  if (integrate && !isPwsh) {
    const initCmd = shellIntegrationInit(base);
    if (initCmd) {
      const clear = restore ? '' : '; clear';
      setTimeout(() => { try { proc.write(initCmd + clear + '\r'); } catch { /* pty gone */ } }, 300);
    }
  }
  return false;
}

export function writeTerm(id: string, data: string): void {
  terms.get(id)?.proc.write(data);
}

export function resizeTerm(id: string, cols: number, rows: number): void {
  try {
    terms.get(id)?.proc.resize(cols, rows);
  } catch {
    /* resize can throw if the pty just exited */
  }
}

// Tab closed but keep the shell running so it can be reopened/resumed.
export function detachTerm(id: string): void {
  const t = terms.get(id);
  if (t) t.wc = null;
}

// Actually terminate the shell.
export function killTerm(id: string): void {
  const t = terms.get(id);
  if (t) {
    try { t.proc.kill(); } catch { /* ignore */ }
    terms.delete(id);
  }
}

export function killAll(): void {
  for (const id of [...terms.keys()]) killTerm(id);
}
