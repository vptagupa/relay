import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import type { ApprovalRequest, DiffLine } from '../shared/types';

// Canonical tool set the agent can call. Each provider adapter maps these into
// its own function-calling schema, so switching models keeps identical tools.

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema (object)
  mutating: boolean;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file within the project. Returns its contents.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to the project root.' } },
      required: ['path'],
      additionalProperties: false,
    },
    mutating: false,
  },
  {
    name: 'list_dir',
    description: 'List the entries of a directory within the project.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path relative to the project root. Use "." for the root.' } },
      required: ['path'],
      additionalProperties: false,
    },
    mutating: false,
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file within the project. Requires user approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the project root.' },
        content: { type: 'string', description: 'Full new file contents.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'edit_file',
    description: 'Make a surgical edit to an existing file by replacing an exact snippet. old_string must occur exactly once (include surrounding context to make it unique). Requires user approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the project root.' },
        old_string: { type: 'string', description: 'The exact text to replace (must match once).' },
        new_string: { type: 'string', description: 'The replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the project root and return its output. Requires user approval.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command line to run.' } },
      required: ['command'],
      additionalProperties: false,
    },
    mutating: true,
  },
];

export interface ToolContext {
  workspace: string;
  autoApprove: boolean;
  approve: (req: ApprovalRequest) => Promise<boolean>;
  newId: () => string;
}

// Confine every path to the workspace root; reject traversal / escapes.
function resolveInside(workspace: string, rel: string): string {
  const abs = path.resolve(workspace, rel);
  const root = path.resolve(workspace);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path "${rel}" escapes the project root.`);
  }
  return abs;
}

async function readIfExists(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

// Line-based LCS diff for the approval preview.
function lineDiff(a: string, b: string): DiffLine[] {
  const A = a ? a.split('\n') : [];
  const B = b ? b.split('\n') : [];
  if (A.length > 1200 || B.length > 1200) {
    return [{ t: ' ', text: `(large file: ${A.length} → ${B.length} lines — diff preview skipped)` }];
  }
  const m = A.length, n = B.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ t: ' ', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', text: A[i] }); i++; }
    else { out.push({ t: '+', text: B[j] }); j++; }
  }
  while (i < m) out.push({ t: '-', text: A[i++] });
  while (j < n) out.push({ t: '+', text: B[j++] });
  return out;
}

function runShell(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr ? `\n${stderr}` : '');
      resolve(err ? `[exit ${(err as any).code ?? 1}]\n${out}` : out || '[no output]');
    });
  });
}

export async function executeTool(name: string, input: any, ctx: ToolContext): Promise<string> {
  if (!ctx.workspace) throw new Error('No project folder is open. Open one first.');
  if (!TOOLS.find((t) => t.name === name)) throw new Error(`Unknown tool: ${name}`);

  // --- read-only tools run immediately ---
  if (name === 'read_file') {
    const abs = resolveInside(ctx.workspace, input.path);
    const text = await fs.readFile(abs, 'utf8');
    return text.length > 60_000 ? text.slice(0, 60_000) + '\n…[truncated]' : text;
  }
  if (name === 'list_dir') {
    const abs = resolveInside(ctx.workspace, input.path || '.');
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).sort().join('\n') || '[empty]';
  }

  // --- mutating tools: build a plan (+diff), approve, then apply ---
  let req: ApprovalRequest;
  let apply: () => Promise<string>;

  if (name === 'write_file') {
    const abs = resolveInside(ctx.workspace, input.path);
    const next = String(input.content ?? '');
    const prev = await readIfExists(abs);
    req = { id: ctx.newId(), kind: 'write', title: `${prev === null ? 'Create' : 'Overwrite'} ${input.path}`, detail: input.path, diff: lineDiff(prev ?? '', next) };
    apply = async () => { await fs.mkdir(path.dirname(abs), { recursive: true }); await fs.writeFile(abs, next, 'utf8'); return `Wrote ${input.path} (${next.length} bytes).`; };
  } else if (name === 'edit_file') {
    const abs = resolveInside(ctx.workspace, input.path);
    const prev = await readIfExists(abs);
    if (prev === null) throw new Error(`File not found: ${input.path}`);
    const oldS = String(input.old_string ?? '');
    const newS = String(input.new_string ?? '');
    if (!oldS) throw new Error('old_string must be non-empty.');
    const matches = prev.split(oldS).length - 1;
    if (matches === 0) throw new Error('old_string not found in file. Read the file and copy the exact text.');
    if (matches > 1) throw new Error(`old_string is not unique (${matches} matches). Include more surrounding context.`);
    const next = prev.replace(oldS, newS);
    req = { id: ctx.newId(), kind: 'edit', title: `Edit ${input.path}`, detail: input.path, diff: lineDiff(prev, next) };
    apply = async () => { await fs.writeFile(abs, next, 'utf8'); return `Edited ${input.path}.`; };
  } else if (name === 'run_command') {
    const command = String(input.command ?? '');
    req = { id: ctx.newId(), kind: 'command', title: 'Run command', detail: command };
    apply = async () => runShell(command, ctx.workspace);
  } else {
    throw new Error(`Unhandled tool: ${name}`);
  }

  if (!ctx.autoApprove) {
    const ok = await ctx.approve(req);
    if (!ok) return 'Denied by user.';
  }
  return apply();
}
