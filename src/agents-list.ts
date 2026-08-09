// The coding agents an issue or PR can be assigned to. Each is a thin adapter: a bin to detect + how to
// launch it in the worktree terminal, seeded with the brief FILE (never task text on the command line). The
// brief FILE dictates the task (validate / fix / review), so the launch wrapper stays neutral — "follow the
// brief". Only Claude Code is verified on this machine; the others follow their documented CLIs (best-effort).
// Single source of truth shared by issues.ts and pr-review.ts.

export interface AgentDef { id: string; name: string; bin: string; launch: (rel: string) => string; }

export const AGENTS: AgentDef[] = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', launch: (rel) => `claude "Read ${rel} and carry out the task it describes in this repository exactly as written, then summarize what you did."` },
  { id: 'gemini', name: 'Gemini CLI', bin: 'gemini', launch: (rel) => `gemini "Read ${rel} and carry out the task it describes in this repository exactly as written, then summarize what you did."` },
  { id: 'codex', name: 'Codex CLI', bin: 'codex', launch: (rel) => `codex "Read ${rel} and carry out the task it describes in this repository exactly as written, then summarize what you did."` },
  { id: 'aider', name: 'Aider', bin: 'aider', launch: (rel) => `aider --message "Read ${rel} and carry out the task it describes in this repository exactly as written, then summarize what you did."` },
  { id: 'antigravity', name: 'Antigravity', bin: 'antigravity', launch: (rel) => `antigravity "Read ${rel} and carry out the task it describes in this repository exactly as written, then summarize what you did."` },
];
