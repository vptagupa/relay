import { contextBridge, ipcRenderer, clipboard } from 'electron';
import * as os from 'node:os';
import type { Settings, SavedSession, AgentEvent, ApprovalRequest, ChatTurn, Workspace, WorkspaceDef, WorkspaceBlueprint, Block, Issue, DbCredMeta } from './shared/types';
import type { ProviderId } from './providers'; // type-only — erased at build, no main-process code pulled in

// Real identity for the Blocks-view prompt line (user@host + home for ~ shortening).
function sysInfo() { try { return { user: os.userInfo().username, host: os.hostname().split('.')[0], home: os.homedir() }; } catch { return { user: 'user', host: 'relay', home: '' }; } }

type BlockEvt = { type: 'start' | 'update' | 'end'; block: Block } | { type: 'cwd'; cwd: string };

// The only surface the renderer can touch. No Node, no fs, no API keys here.
const api = {
  // --- terminals (real PTYs) ---
  // `dbCredId` (optional) references a saved DB credential template — main resolves it into env vars for the run.
  ptyCreate: (id: string, cwd: string, cols: number, rows: number, restore?: string, runCmd?: string, dbCredId?: string): Promise<{ reattached: boolean; alt: boolean }> => ipcRenderer.invoke('pty:create', { id, cwd, cols, rows, restore, runCmd, dbCredId }),
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
  // Alt-screen entered/left — the Blocks view uses this to drop to the live terminal for a full-screen TUI.
  onPtyAlt: (cb: (id: string, alt: boolean) => void) => {
    const h = (_: unknown, m: { id: string; alt: boolean }) => cb(m.id, m.alt);
    ipcRenderer.on('pty:alt', h);
    return () => ipcRenderer.off('pty:alt', h);
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

  // --- database credential templates (encrypted in the main process; the renderer only ever sees metadata) ---
  // The password + any extra-var VALUES stay in the OS keychain and never come back here — save is write-only for
  // secrets (blank password / blank extra value on edit = keep the stored one). Every call returns the fresh list.
  dbCredsList: (): Promise<DbCredMeta[]> => ipcRenderer.invoke('dbcreds:list'),
  dbCredSave: (input: { id?: string; label: string; engine?: string; host?: string; port?: string; database?: string; user?: string; password?: string; extras?: Record<string, string> }): Promise<DbCredMeta[]> => ipcRenderer.invoke('dbcreds:save', input),
  dbCredDelete: (id: string): Promise<DbCredMeta[]> => ipcRenderer.invoke('dbcreds:delete', { id }),

  // --- cloud sync (Google Drive, end-to-end encrypted) ---
  // Google tokens + the sync passphrase live encrypted in the main process; the renderer only ever sees status
  // ({ connected, email, … }) and the OAuth client id — never a token, the client secret, or the passphrase.
  gdriveOAuth: (): Promise<{ ok: boolean; email?: string; error?: string; cancelled?: boolean }> => ipcRenderer.invoke('gdrive:oauth'),
  gdriveOAuthCancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('gdrive:oauth-cancel'),
  gdriveAuthState: (): Promise<{ connected: boolean; email?: string }> => ipcRenderer.invoke('gdrive:auth-state'),
  gdriveDisconnect: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('gdrive:disconnect'),
  gdriveConfigGet: (): Promise<{ clientId: string; hasSecret: boolean; configured: boolean }> => ipcRenderer.invoke('gdrive:config-get'),
  gdriveConfigSet: (clientId: string, secret?: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('gdrive:config-set', { clientId, secret }),
  syncStatus: (): Promise<{ configured: boolean; connected: boolean; email: string; hasPassphrase: boolean; lastPush: number; lastPull: number; remoteExists: boolean; remoteModified: string }> => ipcRenderer.invoke('sync:status'),
  syncHasPassphrase: (): Promise<{ has: boolean }> => ipcRenderer.invoke('sync:has-passphrase'),
  syncSetPassphrase: (passphrase: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('sync:set-passphrase', { passphrase }),
  syncPush: (): Promise<{ ok: boolean; error?: string; ts?: number }> => ipcRenderer.invoke('sync:push'),
  syncPull: (): Promise<{ ok: boolean; error?: string; applied?: boolean; ts?: number; missing?: boolean }> => ipcRenderer.invoke('sync:pull'),
  syncRelaunch: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('sync:relaunch'),
  // Awaitable workspace flush — the renderer calls this before a sync push so the backup captures the live tabs.
  syncFlushWorkspace: (ws: Workspace): Promise<{ ok: boolean }> => ipcRenderer.invoke('workspace:flush', ws),

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
  providerIssues: (ws: string, provider: ProviderId, repo: string, state: 'open' | 'closed' = 'open', page = 1, authors?: string[]): Promise<{ ok: boolean; issues?: Issue[]; hasMore?: boolean; error?: string }> => ipcRenderer.invoke('provider:issues', { ws, provider, repo, state, page, authors }),
  // List the connected user's repos/projects for the Sources picker (Bitbucket also needs workspace ids).
  providerRepos: (ws: string, provider: ProviderId, workspaces?: string[]): Promise<{ ok: boolean; repos?: { repo: string; desc: string; priv: boolean }[]; error?: string }> => ipcRenderer.invoke('provider:repos', { ws, provider, workspaces }),
  // PRs/MRs for a repo by state (default open, page 1) — links an issue's branch to its PR AND drives the PR rail.
  providerPrs: (ws: string, provider: ProviderId, repo: string, state: 'open' | 'closed' = 'open', page = 1, authors?: string[]): Promise<{ ok: boolean; prs?: { number: number; branch: string; url: string; draft: boolean; title?: string; author?: string; state?: string; updatedAt?: number }[]; hasMore?: boolean; error?: string }> => ipcRenderer.invoke('provider:prs', { ws, provider, repo, state, page, authors }),
  // Full PR/MR (with body/labels/reviewers/base branch) — fetched on demand for the details hover.
  providerPrDetail: (ws: string, provider: ProviderId, repo: string, number: number): Promise<{ ok: boolean; detail?: { number: number; title: string; body: string; state: string; draft: boolean; url: string; author?: string; sourceBranch: string; baseBranch: string; mergeState: 'clean' | 'conflict' | 'unknown'; labels: string[]; reviewers: string[]; createdAt?: number; updatedAt?: number }; error?: string }> => ipcRenderer.invoke('provider:pr-detail', { ws, provider, repo, number }),
  // Repo members/collaborators — the PR rail's author-filter list.
  providerRepoMembers: (ws: string, provider: ProviderId, repo: string): Promise<{ ok: boolean; members?: string[]; error?: string }> => ipcRenderer.invoke('provider:repo-members', { ws, provider, repo }),
  // Add / remove a REAL label on the provider issue — returns the issue's full updated label set (name + colour).
  providerAddLabel: (ws: string, provider: ProviderId, repo: string, number: number, label: string): Promise<{ ok: boolean; labels?: { name: string; color?: string }[]; error?: string }> => ipcRenderer.invoke('provider:add-label', { ws, provider, repo, number, label }),
  providerRemoveLabel: (ws: string, provider: ProviderId, repo: string, number: number, label: string): Promise<{ ok: boolean; labels?: { name: string; color?: string }[]; error?: string }> => ipcRenderer.invoke('provider:remove-label', { ws, provider, repo, number, label }),
  // Post a comment on a PR/MR — returns the comment's url when the provider gives one.
  providerPrComment: (ws: string, provider: ProviderId, repo: string, number: number, body: string): Promise<{ ok: boolean; url?: string; error?: string }> => ipcRenderer.invoke('provider:pr-comment', { ws, provider, repo, number, body }),
  // API rate-limit state — pollers skip a cycle while `limited` is true (until the window resets).
  providerRateLimit: (): Promise<{ remaining: number; resetMs: number; backoffUntil: number; limited: boolean }> => ipcRenderer.invoke('provider:rate-limit'),
  // Real-time notifications via a local webhook receiver: start/stop it, and subscribe to parsed issue/PR events.
  webhookControl: (enabled: boolean, port: number, secret: string): Promise<{ ok: boolean; running: boolean; error?: string }> => ipcRenderer.invoke('webhook:control', { enabled, port, secret }),
  webhookStatus: (): Promise<{ running: boolean }> => ipcRenderer.invoke('webhook:status'),
  onWebhookEvent: (cb: (ev: { kind: string; provider: string; repo: string; number: number; title: string; url: string; actor?: string }) => void): void => { ipcRenderer.on('webhook:event', (_e, ev) => cb(ev)); },
  // "Report a bug" diagnostics: app/OS versions + a scrubbed tail of the crash log; and reveal the log file.
  collectDiagnostics: (): Promise<{ version: string; os: string; arch: string; electron: string; chrome: string; node: string; logTail: string }> => ipcRenderer.invoke('diag:collect'),
  revealLog: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('diag:reveal'),
  // Which coding agents are installed on PATH (for the Assign-to picker).
  agentsDetect: (): Promise<Record<string, boolean>> => ipcRenderer.invoke('agents:detect'),
  // Open a URL in the user's default browser (e.g. an issue on GitHub).
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open:external', url),
  // Assign: create (or reuse) an isolated worktree for an issue and drop the edited brief inside it.
  worktreeAdd: (provider: ProviderId, repo: string, dir: string, number: number, brief: string): Promise<{ ok: boolean; path?: string; branch?: string; base?: string; reused?: boolean; briefRel?: string; error?: string }> => ipcRenderer.invoke('git:worktree-add', { provider, repo, dir, number, brief }),
  // Review-assign a PR: create (or reuse) an isolated worktree with the PR's SOURCE branch checked out
  // (fetches the PR head; `branch` = source branch, needed for Bitbucket which has no numbered PR ref).
  prWorktreeAdd: (provider: ProviderId, repo: string, dir: string, number: number, branch: string, brief: string): Promise<{ ok: boolean; path?: string; branch?: string; reused?: boolean; briefRel?: string; error?: string }> => ipcRenderer.invoke('git:pr-worktree-add', { provider, repo, dir, number, branch, brief }),
  // Resolve a PR's merge conflict: check out its SOURCE branch into a worktree, merge the BASE branch in so the
  // conflict is live for the user/agent to resolve, then push the resolution back to update the PR.
  // `merging` = left mid-merge with conflicts (the expected path); `clean` = base merged with no conflict;
  // `dirty` = the worktree had uncommitted changes, left untouched; `pushable` = the source branch is on origin,
  // so `git push origin HEAD:<source>` will update the PR (false for fork PRs whose head isn't in origin).
  // `brief` (optional) seeds the resolve pipeline's stage-0 brief file, returned as `briefRel` like prWorktreeAdd.
  prResolveWorktree: (provider: ProviderId, repo: string, dir: string, number: number, branch: string, base: string, brief?: string): Promise<{ ok: boolean; path?: string; branch?: string; base?: string; briefRel?: string; conflicts?: string[]; merging?: boolean; clean?: boolean; dirty?: boolean; pushable?: boolean; error?: string }> => ipcRenderer.invoke('git:pr-resolve-worktree', { provider, repo, dir, number, branch, base, brief }),
  // Link dependency repos into an issue worktree as read-only reference (checked out to their latest default under .deps/).
  linkDeps: (wt: string, dir: string, deps: { provider: ProviderId; repo: string }[]): Promise<{ ok: boolean; linked?: { name: string; repo: string }[]; error?: string }> => ipcRenderer.invoke('git:link-deps', { wt, dir, deps }),
  // List EXISTING worktrees for a repo (branch → path), no side effects — to reopen a terminal in an issue/task worktree after its tab/app closed.
  worktreesList: (provider: ProviderId, repo: string, dir: string): Promise<{ ok: boolean; list: { branch: string; path: string }[] }> => ipcRenderer.invoke('git:worktrees', { provider, repo, dir }),
  // About dialog: live app resource usage (all processes), a fast worktree list (sizes filled lazily/budgeted),
  // a budgeted total, and delete-to-reclaim.
  appStats: (): Promise<{ ramMB: number; cpuPct: number }> => ipcRenderer.invoke('app:stats'),
  worktreesManage: (): Promise<{ ok: boolean; list: { folder: string; branch: string; path: string; mtimeMs: number }[] }> => ipcRenderer.invoke('worktrees:list'),
  worktreeSize: (path: string): Promise<{ ok: boolean; sizeMB?: number; partial?: boolean }> => ipcRenderer.invoke('worktrees:size', { path }),
  worktreesTotal: (): Promise<{ ok: boolean; totalMB: number; partial: boolean }> => ipcRenderer.invoke('worktrees:total'),
  worktreeRemove: (path: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('worktrees:remove', { path }),
  // Tasks: a validate-only worktree (branch task-<id> off the latest default) + filing a validated task as a real issue.
  taskWorktreeAdd: (provider: ProviderId, repo: string, dir: string, id: string, brief: string): Promise<{ ok: boolean; path?: string; branch?: string; reused?: boolean; briefRel?: string; error?: string }> => ipcRenderer.invoke('git:task-worktree-add', { provider, repo, dir, id, brief }),
  providerCreateIssue: (ws: string, provider: ProviderId, repo: string, title: string, body: string): Promise<{ ok: boolean; number?: number; url?: string; error?: string }> => ipcRenderer.invoke('provider:create-issue', { ws, provider, repo, title, body }),
  providerIssueState: (ws: string, provider: ProviderId, repo: string, number: number): Promise<{ ok: boolean; state?: 'open' | 'closed'; error?: string }> => ipcRenderer.invoke('provider:issue-state', { ws, provider, repo, number }),

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
  fsOpen: (p: string): Promise<{ method: 'editor' | 'default' | 'error'; editor?: string; error?: string }> => ipcRenderer.invoke('fs:open', p),
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
