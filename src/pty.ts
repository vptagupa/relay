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
  parser: { feed(chunk: string): string; close(): void } | null; // shell-integration block parser
  pending: Map<string, BlockEvent>; // block/cwd events emitted while detached (wc null); flushed on reattach
  alt: boolean;                   // shell is in the alternate screen — a full-screen TUI (Claude Code, vim, top…) owns the display
  touchedAt: number;              // last activity (create / attach / data / input) — LRU key for the over-cap reaper
}
// Enter / leave the alternate screen (DEC private modes 1049 / 1047 / 47). Whichever appears LAST in a
// chunk wins, so we track the current mode across output.
function updateAltScreen(t: Term, chunk: string): void {
  let lastEnter = -1, lastExit = -1, m: RegExpExecArray | null;
  const enter = /\x1b\[\?(?:1049|1047|47)h/g, exit = /\x1b\[\?(?:1049|1047|47)l/g;
  while ((m = enter.exec(chunk))) lastEnter = m.index;
  while ((m = exit.exec(chunk))) lastExit = m.index;
  if (lastEnter > lastExit) t.alt = true; else if (lastExit > lastEnter) t.alt = false;
}

const terms = new Map<string, Term>();
const BUF_CAP = 512 * 1024;       // cap replay buffer (~512 KB of output)
// Hard ceiling on LIVE shells. Agent shells (claude → back to a live prompt) never self-exit, and closing a
// resumable tab only DETACHES (keeps the process alive), so a long session piles up dozens of live shells +
// buffers in the main process → memory/handle exhaustion → a silent OOM kill. Past the cap we evict the OLDEST
// DETACHED (kept-alive) shells first; an attached (visible) tab is never killed out from under the user.
const TERM_CAP = 32;
let onReap: ((killed: number, total: number) => void) | null = null;
export function setReapLogger(fn: (killed: number, total: number) => void): void { onReap = fn; }
// Snapshot for the memory heartbeat: how many shells are live, and how many are attached vs detached.
export function termStats(): { total: number; attached: number; detached: number } {
  let attached = 0;
  for (const t of terms.values()) if (t.wc && !t.wc.isDestroyed()) attached++;
  return { total: terms.size, attached, detached: terms.size - attached };
}
// Evict the oldest DETACHED shells until we're back under TERM_CAP. Never kills an attached (visible) tab — if
// every over-cap shell happens to be attached, nothing is killed (the user genuinely has that many tabs open).
function reapOverCap(): void {
  if (terms.size <= TERM_CAP) return;
  const detached = [...terms.entries()].filter(([, t]) => !t.wc || t.wc.isDestroyed()).sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  let over = terms.size - TERM_CAP, killed = 0;
  for (const [id] of detached) { if (over <= 0) break; killTerm(id); over--; killed++; } // killTerm is hoisted (declared below)
  if (killed) onReap?.(killed, terms.size);
}

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
export function createTerm(id: string, cwd: string, wc: WebContents, cols = 80, rows = 24, restore?: string, integrate = false, runCmd?: string, envExtra?: Record<string, string>, useConpty = true): boolean {
  const existing = terms.get(id);
  if (existing) {
    // Same-run resume: the shell is still alive. (restore ignored.)
    existing.wc = wc;
    existing.touchedAt = Date.now();   // reattached → most-recently-used, so the reaper spares it

    try { existing.proc.resize(cols, rows); } catch { /* pty may have exited */ }
    if (!wc.isDestroyed()) {
      if (existing.alt) {
        // Reattaching a live full-screen TUI (Claude Code/Ink, vim, top…). Two traps we must avoid:
        //   • Replaying the raw buffer: it can be up to 512 KB and OVERFLOWS the renderer's bounded replay
        //     queue (writeToTab keeps only the last 512 KB), which evicts the "enter alt-screen" and starts
        //     mid-frame → garbled.
        //   • Nudging the pty size to force a redraw: rapid resizes wedge Ink's renderer (killed input echo).
        // So send ONLY a tiny "enter a clean alt-screen" (it survives the queue), and replay nothing else.
        // The app repaints a full fresh frame on the renderer's normal fit/SIGWINCH after restore, and that
        // frame lands cleanly on this screen. (The renderer restores the tab's live-interactive view.)
        wc.send('pty:data', { id, data: '\x1b[?1049h\x1b[H\x1b[2J' });
      } else if (existing.buf) {
        wc.send('pty:data', { id, data: existing.buf }); // normal shell: replay its scrollback text
      }
    }
    // Flush the block/cwd events that occurred while detached — the raw buffer above only carries the
    // terminal text, so without this the Blocks view would miss commands that ran while switched away.
    for (const e of existing.pending.values()) if (!wc.isDestroyed()) wc.send('pty:block', { id, event: e });
    existing.pending.clear();
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
  // Caller-supplied extra vars (e.g. a referenced DB credential template resolved in main) — applied LAST so a
  // run's credentials win over anything inherited. These carry secrets: they reach only this child process's
  // environment, never the renderer, a file, or the replay buffer.
  if (envExtra) for (const [k, v] of Object.entries(envExtra)) if (typeof v === 'string') env[k] = v;
  const proc = pty.spawn(shellPath, spawnArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: startDir,
    env,
    useConpty, // win32 only (ignored elsewhere): false → legacy winpty backend, the ConPTY fallback for PCs where ConPTY is broken
  } as import('node-pty').IWindowsPtyForkOptions);
  const term: Term = { proc, buf: '', wc, parser: null, pending: new Map(), alt: false, touchedAt: Date.now() };
  terms.set(id, term);

  // Shell integration: the parser turns the shell's OSC markers into structured command
  // blocks (streamed to the renderer as pty:block) and strips the markers from the text
  // that reaches xterm. The markers are enabled by an init line sent below.
  const parser = integrate
    ? createShellParser((e: BlockEvent) => {
        if (term.wc && !term.wc.isDestroyed()) term.wc.send('pty:block', { id, event: e });
        else term.pending.set(e.type === 'cwd' ? ' cwd' : e.block.id, e); // detached: keep the latest event per block (+ latest cwd) to flush on reattach
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
  let lastDataAt = spawnAt; // bumped on every chunk — lets a startup command wait for the shell to go quiet
  let clearCarry = ''; // trailing partial escape held across chunks so a split "\x1b[" + "2J" still matches
  proc.onData((data) => {
    lastDataAt = Date.now();
    term.touchedAt = lastDataAt;   // active output keeps a (detached) shell recent → the reaper spares busy shells
    // For a brief window after a restore-spawn, drop the shell's startup clears so its
    // repaint can't wipe the restored history. After the window, everything works normally.
    if (restore && Date.now() - spawnAt < STARTUP_GUARD_MS) {
      data = clearCarry + data; clearCarry = '';
      data = data.replace(STARTUP_CLEARS, '');
      const m = data.match(/\x1b(?:\[[0-9]{0,2})?$/); // could be the start of \x1b[2J / \x1b[3J / \x1bc
      if (m && m[0].length < 4) { clearCarry = m[0]; data = data.slice(0, data.length - m[0].length); }
    } else if (clearCarry) { data = clearCarry + data; clearCarry = ''; } // window ended — flush any held bytes
    const clean = parser ? parser.feed(data) : data; // strip integration markers before display
    const wasAlt = term.alt;
    updateAltScreen(term, clean); // track alt-screen so a reattach knows to force-repaint a full-screen TUI
    term.buf += clean;
    if (term.buf.length > BUF_CAP) term.buf = term.buf.slice(term.buf.length - BUF_CAP);
    if (term.wc && !term.wc.isDestroyed()) {
      term.wc.send('pty:data', { id, data: clean });
      // Alt-screen entered/left → tell the renderer directly so the Blocks view can drop to the LIVE terminal
      // for a full-screen TUI (Claude Code's trust prompt, vim, top…). This is terminal-level, so it works even
      // when no shell-integration command block is being tracked (e.g. an agent-launched `claude`), which the
      // block-level `interactive` flag would miss — the cause of the garbled TUI in Blocks view.
      if (term.alt !== wasAlt) term.wc.send('pty:alt', { id, alt: term.alt });
    }
  });
  proc.onExit(({ exitCode }) => {
    try { term.parser?.close(); } catch { /* finalize any open block */ }
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
  // A caller-requested startup command (e.g. "launch the coding agent in this issue worktree"). Write it
  // once the shell goes QUIET — profile + integration init done, prompt drawn and waiting for input. A
  // fixed delay is fragile: a heavy prompt (oh-my-posh, module autoload) can still be loading past any
  // hardcoded cutoff and swallow the line, so the agent silently never launches. Poll instead — fire
  // after the output has been idle a short beat (past a minimum settle), with a hard ceiling so a
  // never-quiet prompt still gets it. Only reached on a fresh spawn (the reattach path returned above),
  // so reopening a kept-alive shell never re-launches the agent.
  if (runCmd) {
    const iv = setInterval(() => {
      if (!terms.has(id)) { clearInterval(iv); return; } // shell exited before we fired — stop
      const now = Date.now();
      if ((now - lastDataAt >= 450 && now - spawnAt >= 700) || now - spawnAt >= 12000) {
        clearInterval(iv);
        try { proc.write(runCmd + '\r'); } catch { /* pty gone */ }
      }
    }, 150);
  }
  reapOverCap(); // a new shell was just added — evict the oldest kept-alive ones if we're over the ceiling
  return false;
}

export function writeTerm(id: string, data: string): void {
  try { const t = terms.get(id); if (t) { t.touchedAt = Date.now(); t.proc.write(data); } } catch { /* pty may have exited between the lookup and the write */ }
}

// Is a shell currently in the alternate screen (a full-screen TUI like Claude Code is running)? On reattach
// the renderer uses this to restore the tab's live-interactive view — Blocks view would otherwise hide the
// running TUI after a workspace switch (the tab is rebuilt with liveInteractive reset to false).
export function isAltScreen(id: string): boolean { return !!terms.get(id)?.alt; }

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
