# Relay — Agent Terminal (desktop app)

A cross-platform (Windows / macOS / Linux) terminal app that reproduces the Relay
prototype (`agent-terminal.html`) as a **real** application: real OS shells via a
PTY, and a **switchable multi-provider AI coding agent** (Claude, GPT, Gemini) that
can read, edit, and run things inside the project folder you open — like a VS Code
terminal with Claude Code built in.

The original prototype (`agent-terminal.html`) is kept as the design reference.

---

## What's real here (vs. the artifact)

| | Artifact (prototype) | This app |
|---|---|---|
| Shell | Simulated JS interpreter | **Real** shell via `node-pty` (pwsh/zsh/bash), rendered with `xterm.js` |
| Agent | Rule-based suggester | **Real** LLM agent loop with tool use, per provider |
| Files | Fake in-memory FS | **Real** filesystem, confined to the opened project |
| Keys | n/a | Encrypted at rest via Electron `safeStorage` |
| Persistence | localStorage | JSON store in the app's userData dir |

## Model selection / switching

- Each terminal tab has its **own model** (chip on the tab + a picker in the tab strip and the agent panel).
- The picker is grouped by provider: **Anthropic** (Claude Opus 5 / Sonnet 5 / Haiku 4.5 / Fable 5), **OpenAI** (GPT-5.6 Sol / Terra / Luna), **Google** (Gemini 3.1 Pro / 3.5 Flash / 3.1 Flash-Lite).
- All three providers expose the **same tool set**, so switching models never changes what the agent can do — only who answers. Models without a saved key are marked "no key".

## Architecture

```
Electron
├─ main process (Node — full OS access)
│   ├─ src/main.ts            window + all IPC
│   ├─ src/pty.ts             node-pty: one real shell per tab
│   ├─ src/store.ts           sessions (Library) + settings (JSON)
│   ├─ src/keys.ts            API keys, encrypted via safeStorage
│   └─ src/agent/
│       ├─ agent.ts           picks provider by model id, builds the run
│       ├─ tools.ts           read/list/write/run — confined to the workspace, with approval
│       └─ providers.ts       Anthropic / OpenAI / Google agent loops (same tools)
├─ preload (src/preload.ts)   contextBridge — the only surface the UI can touch
└─ renderer (src/renderer.ts, index.html, src/styles.css)
                              the Relay UI + xterm.js terminals + agent chat
```

Security posture: the renderer has **no** Node, filesystem, or key access — it asks
the main process over IPC. The agent is confined to the opened folder, and every
file write / command run pops an **approval** prompt (toggle off in Settings).

---

## Prerequisites

- **Node.js 20+** and npm.
- A toolchain for building the `node-pty` native addon during `npm install`:
  - **Windows:** the "Desktop development with C++" workload (Visual Studio Build Tools) + Python 3.
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Linux:** `build-essential` + `python3`.
  - `node-pty` ships prebuilt binaries for common setups, so a rebuild is often not needed.

## Setup & run

```bash
npm install         # installs deps and rebuilds native modules for Electron
npm start           # launches the app in dev (Vite HMR)
```

Package installers:

```bash
npm run make        # -> Windows .exe / macOS .zip / Linux .deb/.rpm in out/
```

## Using it

1. **Open folder…** (title bar) — pick the project you want to work in.
2. A real terminal opens. Use it like any terminal (`git`, `npm`, etc.).
3. **⚙ Settings** — paste an API key for whichever provider(s) you'll use:
   - Anthropic: <https://console.anthropic.com/>
   - OpenAI: <https://platform.openai.com/api-keys>
   - Google AI Studio: <https://aistudio.google.com/apikey>
4. **✦ Agent** (or `Ctrl/⌘ J`) — pick a model and ask it to work on the project.
   It reads/edits files and runs commands in the opened folder, asking approval first.
5. **Save** (`Ctrl/⌘ S`) — store the terminal in the Library to re-open later.

**Session resume — two levels:**

- **Same app run** (close a tab, reopen it): the shell is **not** killed, it keeps
  running in the background. Reopening **reattaches to the live shell and replays its
  full output**, so you resume the exact session — output *and* any still-running
  process. Shells end when you quit the app or type `exit`.
- **After the app or the whole laptop restarts:** the OS has killed every process, so a
  *live* shell cannot be reattached — that's a hard OS limit (only `tmux`/`screen` or a
  remote/SSH session survive a reboot). Instead, Relay restores the **context**: your
  previous output is reloaded into the terminal's scrollback, in the same working
  folder and with the same model, and a **fresh** shell opens beneath it — so you
  continue where you left off (running processes are not revived). Your shell's own
  command history (PSReadLine / bash) persists too, so `↑` still recalls commands.

Shortcuts: `Ctrl/⌘ K` command palette · `Ctrl/⌘ T` new terminal · `Ctrl/⌘ J` agent · `Ctrl/⌘ S` save · `Ctrl/⌘ L` clear · `Ctrl/⌘ W` close tab · `Esc` close popovers.

## Feature parity with the prototype

All of the prototype's UI functions are implemented: multiple terminals with per-tab
models, the grouped multi-provider model picker (tab strip + agent panel), the **command
palette** (`⌘K`), **light/dark theme** toggle, **auto-save** of open terminals (they
restore on relaunch, with scrollback) plus a status-bar indicator and toggle, the
**Library** with save / re-open / **rename** / **delete**, **clear terminal**,
**sidebar collapse**, a live **clock**, agent **starter chips**, and **tab rename**
(double-click a tab).

---

## Status & honest caveats

This is a **working v1 scaffold**, not a shipped product. It was written but **not
run in this environment** — do `npm install && npm start` and expect small fixes:

- **Provider SDK drift.** `src/agent/providers.ts` targets the Anthropic, OpenAI, and
  Google SDK shapes as of mid-2026. If `npm install` pulls a version with a changed
  signature, adjust that file (each provider is ~30 lines).
- **Model IDs.** Claude IDs are authoritative. The GPT-5.6 and Gemini 3.x IDs in
  `src/shared/models.ts` reflect public info as of mid-2026 — verify against each
  provider's current model list and edit if needed.
- **Dependency versions** in `package.json` are indicative; `npm install` resolves the
  latest matching, and you may need to bump majors.
- **Terminal style (the one intentional divergence).** This uses a classic streaming
  terminal (xterm.js) so interactive programs (vim, top) work with a *real* shell. The
  prototype's Warp-style "command blocks" were possible only because its shell was
  simulated; grouping a real PTY into blocks requires shell integration (OSC 133 prompt
  marks) and is a deliberate later layer, not a dropped feature.
- **Agent tools:** `read_file`, `list_dir`, `write_file`, `edit_file` (surgical
  snippet replace), `run_command`. Writes and edits show a colored **diff** in the
  approval prompt before anything is applied.

## Roadmap ideas

- Per-hunk accept/reject in the diff approval (currently allow/deny the whole change).
- Streaming token output (SSE) instead of per-turn text.
- The Claude Agent SDK as an optional high-fidelity backend for Claude specifically.
- Restore full terminal scrollback with saved sessions; split panes.
