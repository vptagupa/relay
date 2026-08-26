// The coding agents an issue or PR can be assigned to. Each is a thin adapter: a bin to detect + how to
// launch it in the worktree terminal, seeded with the brief FILE (never task text on the command line). The
// brief FILE dictates the task (validate / fix / review), so the launch wrapper stays neutral — "follow the
// brief". Only Claude Code is verified on this machine; the others follow their documented CLIs (best-effort).
// Single source of truth shared by issues.ts and pr-review.ts.

// `launch` starts the agent in a fresh shell seeded with the brief FILE. `prompt` is the SAME instruction WITHOUT
// the shell wrapper — used to re-drive an ALREADY-RUNNING interactive session (the review⇄fix loop reuses one
// terminal per stage and feeds the next round's brief to the live agent REPL instead of opening a new tab).
export interface AgentDef { id: string; name: string; bin: string; launch: (rel: string) => string; prompt: (rel: string) => string; interactive: boolean; }

const MSG = (rel: string): string => `Read ${rel} and carry out the task it describes in this repository exactly as written, then summarize what you did.`;

export const AGENTS: AgentDef[] = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', launch: (rel) => `claude "${MSG(rel)}"`, prompt: MSG, interactive: true },
  { id: 'gemini', name: 'Gemini CLI', bin: 'gemini', launch: (rel) => `gemini "${MSG(rel)}"`, prompt: MSG, interactive: true },
  { id: 'codex', name: 'Codex CLI', bin: 'codex', launch: (rel) => `codex "${MSG(rel)}"`, prompt: MSG, interactive: true },
  { id: 'aider', name: 'Aider', bin: 'aider', launch: (rel) => `aider --message "${MSG(rel)}"`, prompt: MSG, interactive: false }, // --message is one-shot → no live REPL to re-drive
  { id: 'antigravity', name: 'Antigravity', bin: 'antigravity', launch: (rel) => `antigravity "${MSG(rel)}"`, prompt: MSG, interactive: true },
];

// Re-drive an ALREADY-RUNNING interactive agent REPL (the review⇄fix loop reuses one terminal per stage) with the
// next round's prompt. It MUST send the prompt text and its submitting Enter as SEPARATE writes: a TUI REPL like
// Claude Code treats a fast text+CR burst as a PASTE and folds the trailing CR into the input as a literal newline
// — so the prompt appears in the box but never runs until you press Enter yourself (the bug this fixes). A lone CR
// sent after this short gap falls OUTSIDE the paste-burst window, so it registers as a real submit and the next
// round auto-executes. Tunable: if a slower REPL still needs a manual Enter, raise the delay.
const REDRIVE_SUBMIT_DELAY_MS = 250;
export function redriveAgent(tabId: string, prompt: string): void {
  const relay = (window as any).relay;
  relay.ptyWrite(tabId, prompt);                                          // type the next round's prompt into the live REPL
  setTimeout(() => relay.ptyWrite(tabId, '\r'), REDRIVE_SUBMIT_DELAY_MS); // …then submit it as a DISTINCT Enter keystroke
}
