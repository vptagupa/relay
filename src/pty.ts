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

// On restore we replay the previous session's output INLINE so it's visible in the terminal
// (matching the Blocks view). Because the shell is spawned at the correct size (fit-before-
// spawn), there's no resize repaint; the only thing that could wipe the replayed history is
// the fresh shell's own startup clear — erase-scrollback (CSI 3J), erase-viewport (CSI 2J),
// or full reset (ESC c) — so we strip just those for a short window after spawn. Cursor moves
// and alt-screen are left untouched, so normal shell behaviour (cls, vim, …) is unaffected.
const STARTUP_GUARD_MS = 1500;
const STARTUP_CLEARS = /\x1b\[3J|\x1b\[2J|\x1bc/g;

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
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>;
  // Relay may itself be launched from inside a Claude Code session; its environment then
  // carries Claude Code runtime/session markers. If those leak into the shell, a `claude`
  // run INSIDE Relay thinks it's a nested child session and disables transcript saving.
  // Scrub the markers so Claude Code launched in Relay is always a clean top-level session.
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID']) delete env[k];
  // Relay is a full-color terminal: don't let a NO_COLOR / FORCE_COLOR=0 inherited from its own
  // launch environment strip color from programs (Claude Code, git, npm…) run inside it.
  delete env.NO_COLOR;
  if (env.FORCE_COLOR === '0' || env.FORCE_COLOR === 'false') delete env.FORCE_COLOR;
  const proc = pty.spawn(shellPath, spawnArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: startDir,
    env,
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
    // Replay inline (a couple of blank lines separate it from the fresh shell's first prompt).
    term.buf = restore + '\r\n\x1b[90m— restored session · live shell below —\x1b[0m\r\n\r\n';
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
