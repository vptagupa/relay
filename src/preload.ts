import { contextBridge, ipcRenderer, clipboard } from 'electron';
import * as os from 'node:os';
import type { Settings, SavedSession, AgentEvent, ApprovalRequest, ChatTurn, Workspace, WorkspaceDef, WorkspaceBlueprint, Block, Issue } from './shared/types';
import type { ProviderId } from './providers'; // type-only — erased at build, no main-process code pulled in

// Real identity for the Blocks-view prompt line (user@host + home for ~ shortening).
function sysInfo() { try { return { user: os.userInfo().username, host: os.hostname().split('.')[0], home: os.homedir() }; } catch { return { user: 'user', host: 'relay', home: '' }; } }

type BlockEvt = { type: 'start' | 'update' | 'end'; block: Block } | { type: 'cwd'; cwd: string };

// The only surface the renderer can touch. No Node, no fs, no API keys here.
const api = {
  // --- terminals (real PTYs) ---
  ptyCreate: (id: string, cwd: string, cols: number, rows: number, restore?: string, runCmd?: string): Promise<{ reattached: boolean; alt: boolean }> => ipcRenderer.invoke('pty:create', { id, cwd, cols, rows, restore, runCmd }),
  ptyWrite: (id: string, data: string) => ipcRenderer.send('pty:write', { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  ptyDetach: (id: string) => ipcRenderer.send('pty:detach', { id }),
  ptyKill: (id: string) => ipcRenderer.send('pty:kill', { id }),
  onPtyData: (cb: (id: string, data: string) => void) => {
    const h = (_: unknown, m: { id: string; data: string }) => cb(m.id, m.data);
    ipcRenderer.on('pty:data', h);
    return () => ipcRenderer.off('pty:data', h);
  },
  onPtyExit: (cb: (id: string, code: number) => void) => {
    const h = (_: unknown, m: { id: string; exitCode: number }) => cb(m.id, m.exitCode);
    ipcRenderer.on('pty:exit', h);
    return () => ipcRenderer.off('pty:exit', h);
  },
  // Structured command blocks parsed from shell-integration markers.
  onPtyBlock: (cb: (id: string, ev: BlockEvt) => void) => {
    const h = (_: unknown, m: { id: string; event: BlockEvt }) => cb(m.id, m.event);
    ipcRenderer.on('pty:block', h);
    return () => ipcRenderer.off('pty:block', h);
  },

  // --- workspace + settings ---
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  patchSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:patch', patch),
  openWorkspace: (): Promise<Settings> => ipcRenderer.invoke('workspace:open'),
  // Pick a folder; resolves to its path, or null if the dialog was cancelled.
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-folder').then((r: { path: string | null }) => r.path),

  // --- keys (write-only from the UI) ---
  setKey: (provider: string, value: string): Promise<Settings> => ipcRenderer.invoke('keys:set', { provider, value }),

  // --- sessions (the Library) ---
  listSessions: (): Promise<SavedSession[]> => ipcRenderer.invoke('sessions:list'),
  upsertSession: (s: SavedSession): Promise<SavedSession[]> => ipcRenderer.invoke('sessions:upsert', s),
  deleteSession: (id: string): Promise<SavedSession[]> => ipcRenderer.invoke('sessions:delete', id),
  reorderSessions: (ids: string[]): Promise<SavedSession[]> => ipcRenderer.invoke('sessions:reorder', ids),

  // --- workspace (open tabs restored on relaunch) — operate on the ACTIVE workspace ---
  getWorkspace: (): Promise<Workspace> => ipcRenderer.invoke('workspace:get'),
  setWorkspace: (ws: Workspace) => ipcRenderer.send('workspace:set', ws),
  // Synchronous write for the final flush on window close (blocks until it's on disk).
  flushWorkspace: (ws: Workspace) => ipcRenderer.sendSync('workspace:set-sync', ws),

  // --- named workspaces (definitions + per-id snapshots) ---
  getWorkspaceMeta: (): Promise<{ workspaces: WorkspaceDef[]; activeWorkspaceId: string }> => ipcRenderer.invoke('workspaces:meta'),
  saveWorkspaceMeta: (workspaces: WorkspaceDef[], activeWorkspaceId: string) => ipcRenderer.send('workspaces:save-meta', { workspaces, activeWorkspaceId }),
  getWorkspaceSnapshot: (id: string): Promise<Workspace> => ipcRenderer.invoke('workspace:get-snapshot', id),
  saveWorkspaceSnapshot: (id: string, ws: Workspace) => ipcRenderer.send('workspace:save-snapshot', { id, ws }),

  // --- Issue Agent — multi-provider (GitHub / GitLab / Bitbucket) ---
  // GitHub + Bitbucket connect via OAuth (device flow / in-browser loopback); GitLab via a pasted PAT. All
  // tokens are encrypted in the OS keychain in the main process — the renderer only ever sees { connected, login }.
  // Every provider call carries the active Slayer T workspace id `ws` — connections + creds are isolated per workspace.
  githubDeviceStart: (ws: string): Promise<{ ok: boolean; userCode?: string; verificationUri?: string; deviceCode?: string; interval?: number; expiresIn?: number; error?: string }> => ipcRenderer.invoke('github:device-start', { ws }),
  githubDevicePoll: (ws: string, deviceCode: string): Promise<{ status: string; login?: string; interval?: number; error?: string }> => ipcRenderer.invoke('github:device-poll', { ws, deviceCode }),
  // Bitbucket connects via OAuth 2.0 authorization-code + loopback redirect (no device flow). One call runs
  // the whole browser round trip in main and resolves when it finishes — the renderer just awaits it.
  bitbucketOAuth: (ws: string): Promise<{ ok: boolean; login?: string; error?: string }> => ipcRenderer.invoke('bitbucket:oauth', { ws }),
  // OAuth-app config (client id / secret used to START the login flow), per workspace. Get returns the public
  // client id + a hasSecret flag (never the secret). Set stores them encrypted in the OS keychain.
  providerOAuthConfigGet: (ws: string, provider: ProviderId): Promise<{ clientId: string; hasSecret: boolean; needsSecret: boolean; configured: boolean }> => ipcRenderer.invoke('provider:oauth-config-get', { ws, provider }),
  providerOAuthConfigSet: (ws: string, provider: ProviderId, clientId: string, secret?: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('provider:oauth-config-set', { ws, provider, clientId, secret }),
  // Move the pre-scoping global secrets into a workspace once (renderer guards with a settings flag).
  providerMigrateGlobal: (ws: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('provider:migrate-global', { ws }),
  // Connection state for a provider in a workspace (never the token).
  providerAuthState: (ws: string, provider: ProviderId): Promise<{ connected: boolean; login?: string }> => ipcRenderer.invoke('provider:auth-state', { ws, provider }),
  // Connect GitLab with a pasted token (+ optional host for self-managed GitLab), scoped to the workspace.
  providerConnect: (ws: string, provider: ProviderId, token: string, host?: string): Promise<{ ok: boolean; login?: string; error?: string }> => ipcRenderer.invoke('provider:connect', { ws, provider, token, host }),
  providerDisconnect: (ws: string, provider: ProviderId): Promise<{ ok: boolean }> => ipcRenderer.invoke('provider:disconnect', { ws, provider }),
  // Infer { provider, repo } from a folder's git `origin` remote (null if not a recognized provider remote).
  providerRepoFromRemote: (dir: string): Promise<{ provider: ProviderId; repo: string } | null> => ipcRenderer.invoke('provider:repo-from-remote', dir),
  // Pull ONE page (100 GH/GL, 50 BB) of a repo's issues for infinite scroll; hasMore signals another page exists.
  providerIssues: (ws: string, provider: ProviderId, repo: string, state: 'open' | 'closed' = 'open', page = 1): Promise<{ ok: boolean; issues?: Issue[]; hasMore?: boolean; error?: string }> => ipcRenderer.invoke('provider:issues', { ws, provider, repo, state, page }),
  // List the connected user's repos/projects for the Sources picker (Bitbucket also needs workspace ids).
  providerRepos: (ws: string, provider: ProviderId, workspaces?: string[]): Promise<{ ok: boolean; repos?: { repo: string; desc: string; priv: boolean }[]; error?: string }> => ipcRenderer.invoke('provider:repos', { ws, provider, workspaces }),
  // PRs/MRs for a repo by state (default open, page 1) — links an issue's branch to its PR AND drives the PR rail.
  providerPrs: (ws: string, provider: ProviderId, repo: string, state: 'open' | 'closed' = 'open', page = 1): Promise<{ ok: boolean; prs?: { number: number; branch: string; url: string; draft: boolean; title?: string; author?: string; state?: string; updatedAt?: number }[]; hasMore?: boolean; error?: string }> => ipcRenderer.invoke('provider:prs', { ws, provider, repo, state, page }),
  // Full PR/MR (with body/labels/reviewers/base branch) — fetched on demand for the details hover.
  providerPrDetail: (ws: string, provider: ProviderId, repo: string, number: number): Promise<{ ok: boolean; detail?: { number: number; title: string; body: string; state: string; draft: boolean; url: string; author?: string; sourceBranch: string; baseBranch: string; labels: string[]; reviewers: string[]; createdAt?: number; updatedAt?: number }; error?: string }> => ipcRenderer.invoke('provider:pr-detail', { ws, provider, repo, number }),
  // Which coding agents are installed on PATH (for the Assign-to picker).
  agentsDetect: (): Promise<Record<string, boolean>> => ipcRenderer.invoke('agents:detect'),
  // Open a URL in the user's default browser (e.g. an issue on GitHub).
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open:external', url),
  // Assign: create (or reuse) an isolated worktree for an issue and drop the edited brief inside it.
  worktreeAdd: (provider: ProviderId, repo: string, dir: string, number: number, brief: string): Promise<{ ok: boolean; path?: string; branch?: string; base?: string; reused?: boolean; briefRel?: string; error?: string }> => ipcRenderer.invoke('git:worktree-add', { provider, repo, dir, number, brief }),

  // --- issue pipelines (staged agent runs) ---
  // Prep a stage before launch: write its brief file into the worktree's .slayer/ (skip for stage 0 —
  // worktree-add already wrote it) and clear this stage's stale verdict so a re-run starts clean.
  pipelinePrep: (wt: string, briefRel: string | null, brief: string | null, stage: number): Promise<{ ok: boolean }> => ipcRenderer.invoke('pipeline:prep', { wt, briefRel: briefRel || undefined, brief: brief || undefined, stage }),
  // Poll a gate stage's verdict — { found:false } until the agent has written { passed, summary }.
  pipelineVerdict: (wt: string, stage: number): Promise<{ found: boolean; passed?: boolean; summary?: string }> => ipcRenderer.invoke('pipeline:verdict', { wt, stage }),

  // --- workspace blueprints (reusable "Templates") ---
  getBlueprints: (): Promise<WorkspaceBlueprint[]> => ipcRenderer.invoke('blueprints:get'),
  saveBlueprints: (blueprints: WorkspaceBlueprint[]) => ipcRenderer.send('blueprints:save', blueprints),

  // --- Claude Code integration ---
  claudeDetect: (): Promise<{ installed: boolean; path?: string }> => ipcRenderer.invoke('claude:detect'),
  claudeAuth: (): Promise<{ relayKey: boolean; ambient: boolean }> => ipcRenderer.invoke('claude:auth'),
  exportSession: (p: { name: string; content: string; ext: string }): Promise<{ ok: boolean; path?: string; error?: string }> => ipcRenderer.invoke('session:export', p),
  // Import a workspace from a picked JSON file; resolves the raw parsed payload for the renderer to validate.
  importWorkspace: (): Promise<{ ok: boolean; data?: unknown; error?: string }> => ipcRenderer.invoke('workspace:import'),

  // --- file browser ---
  fsList: (dir: string): Promise<{ path: string; parent: string; entries: { name: string; isDir: boolean }[]; truncated?: boolean; error?: string }> => ipcRenderer.invoke('fs:list', dir),
  fsOpen: (p: string): Promise<{ method: 'vscode' | 'default' | 'error'; error?: string }> => ipcRenderer.invoke('fs:open', p),
  // Open a path a terminal printed, resolved against the tab's cwd (for clickable file-path links). No-op if it's not a real file.
  revealPath: (cwd: string, target: string): Promise<{ ok: boolean; method?: string }> => ipcRenderer.invoke('fs:open-rel', { cwd, target }),

  // --- agent ---
  agentSend: (payload: { model: string; history: ChatTurn[]; userMessage: string }): Promise<void> =>
    ipcRenderer.invoke('agent:send', payload),
  onAgentEvent: (cb: (e: AgentEvent) => void) => {
    const h = (_: unknown, e: AgentEvent) => cb(e);
    ipcRenderer.on('agent:event', h);
    return () => ipcRenderer.off('agent:event', h);
  },
  onApproval: (cb: (req: ApprovalRequest) => void) => {
    const h = (_: unknown, req: ApprovalRequest) => cb(req);
    ipcRenderer.on('agent:approval', h);
    return () => ipcRenderer.off('agent:approval', h);
  },
  approve: (id: string, ok: boolean) => ipcRenderer.send('agent:approval-response', { id, ok }),

  // --- platform + custom window controls ---
  platform: process.platform,
  sys: sysInfo(),
  winMinimize: () => ipcRenderer.send('win:minimize'),
  winMaximize: () => ipcRenderer.send('win:maximize'),
  winClose: () => ipcRenderer.send('win:close'),
  winFocus: () => ipcRenderer.send('win:focus'),
  onWinState: (cb: (maximized: boolean) => void) => {
    const h = (_: unknown, max: boolean) => cb(max);
    ipcRenderer.on('win:state', h);
    return () => ipcRenderer.off('win:state', h);
  },

  // Read/write the OS clipboard via Electron (no focus / user-gesture requirement, unlike navigator.clipboard).
  copyText: (text: string): void => clipboard.writeText(text),
  readText: (): string => clipboard.readText(),

  // --- slayert:// deeplinks (main → renderer) ---
  onDeeplink: (cb: (intent: { kind: string; name: string }) => void) => {
    const h = (_: unknown, intent: { kind: string; name: string }) => cb(intent);
    ipcRenderer.on('deeplink', h);
    return () => ipcRenderer.off('deeplink', h);
  },
};

contextBridge.exposeInMainWorld('relay', api);
export type RelayApi = typeof api;
