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
