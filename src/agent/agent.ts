import { randomUUID } from 'node:crypto';
import { providerOf, modelById } from '../shared/models';
import type { AgentEvent, ApprovalRequest, ChatTurn } from '../shared/types';
import { getSettings, getActiveWorkspaceDef } from '../store';
import { getKey } from '../keys';
import type { ToolContext } from './tools';
import { runAnthropic, runOpenAI, runGoogle, type RunArgs } from './providers';

const SYSTEM = `You are Slayer T, a coding agent embedded in a terminal app. You help the user build and modify the project that is currently open.

You can read and list files, make surgical edits (edit_file), write whole files (write_file), and run shell commands — all confined to the open project folder. Read a file before editing it, and prefer edit_file with a unique snippet over rewriting a whole file; use write_file for new files. Make the smallest change that satisfies the request. When you edit files or run commands, explain briefly what and why. Report outcomes plainly: if something failed, say so with the error.`;

export interface OrchestrateArgs {
  model: string;
  history: ChatTurn[];
  userMessage: string;
  approve: (req: ApprovalRequest) => Promise<boolean>;
  emit: (e: AgentEvent) => void;
}

export async function runAgent(args: OrchestrateArgs): Promise<void> {
  const settings = await getSettings();
  const provider = providerOf(args.model);
  const apiKey = await getKey(provider);

  if (!settings.workspace) return args.emit({ type: 'error', message: 'Open a project folder first (the agent works inside it).' });
  // Anthropic can run on ambient credentials (your Claude Code / Claude subscription login,
  // or an ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN in the environment), so a pasted key is
  // optional there. Other providers still need a stored key.
  if (!apiKey && provider !== 'anthropic') return args.emit({ type: 'error', message: `No API key set for ${provider}. Add one in Settings to use ${modelById(args.model).name}.` });

  // Per-workspace agent trust: an untrusted workspace forces approvals even when global auto-approve is
  // on (undefined trusted = trusted, so migrated/default workspaces are unaffected). Enforced here in the
  // main process so the renderer can't bypass the gate. See ToolContext.autoApprove.
  const wsDef = await getActiveWorkspaceDef();
  const trusted = wsDef?.trusted !== false;

  const ctx: ToolContext = {
    workspace: settings.workspace,
    autoApprove: settings.autoApprove && trusted,
    approve: args.approve,
    newId: () => randomUUID(),
  };

  const run: RunArgs = {
    model: args.model,
    apiKey: apiKey || '',
    system: SYSTEM,
    history: args.history,
    userMessage: args.userMessage,
    ctx,
    emit: args.emit,
  };

  try {
    if (provider === 'anthropic') await runAnthropic(run);
    else if (provider === 'openai') await runOpenAI(run);
    else await runGoogle(run);
  } catch (e: any) {
    args.emit({ type: 'error', message: e?.message || String(e) });
  }
}
