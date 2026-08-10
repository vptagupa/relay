// Types shared across the IPC boundary.

// Per-terminal color overrides (hex). Any omitted color falls back to the app theme.
// Both the tab and the body have an independent background + text color.
export interface TermColors {
  tabBg?: string;                   // tab background
  tabFg?: string;                   // tab text
  bodyBg?: string;                  // terminal body background
  bodyFg?: string;                  // terminal body text
}

// A structured command block — the "owned history" unit. Built from shell-integration
// markers in the main process and persisted so history restores as blocks, not just text.
export interface Block {
  id: string;
  command: string;
  output: string;
  cwd: string;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  running: boolean;
  interactive?: boolean;            // ran a full-screen (alt-screen) app like vim/top
  pinned?: boolean;                 // user-pinned in the History panel
}

export interface SavedSession extends TermColors {
  id: string;                       // library record id
  termId: string;                   // terminal id — reattaches to the live shell if still running
  wsId?: string;                    // the workspace this session belongs to (its Library is per-workspace)
  name: string;
  cwd: string;
  model: string;
  createdAt: number;
  lastUsed: number;
  scrollback?: string;              // serialized buffer, used only when the shell is gone (e.g. after restart)
  blocks?: Block[];                 // command history as structured blocks
  chat?: ChatTurn[];                // this terminal's agent conversation
}

// A currently-open terminal, persisted so the workspace restores on relaunch.
export interface OpenTab extends TermColors {
  id: string;
  name: string;
  model: string;
  cwd: string;
  libId?: string;                   // link to a Library entry, if this terminal was saved
  scrollback?: string;
  blocks?: Block[];                 // command history as structured blocks
  chat?: ChatTurn[];                // this terminal's agent conversation
  group?: number;                   // which split group (pane) this tab belongs to
  // block-id namespace; preserved across a keep-alive reattach so the live shell's continuing block
  // ids match the restored blocks (updates in place, no duplicate). A fresh nonce on a cold restart.
  bkNonce?: string;
}

// A workspace's live tab snapshot (its split layout + open terminals), stored by workspace id in
// workspace.json (frequent writes). One per WorkspaceDef.
export interface Workspace {
  active: string;
  tabs: OpenTab[];
  gv?: string[];                    // visible tab id per group (split-layout restore)
  focus?: number;
  layout?: unknown;                 // nested split-tree layout (opaque; renderer-owned shape)
}

// A named workspace: identity + root folder + scoped overrides (the "definition"; rare writes →
// relay.json). Kept separate from the Workspace snapshot so a definition edit doesn't re-serialize
// the whole tab state, and a snapshot autosave doesn't touch the definition.
export interface WorkspaceDef {
  id: string;
  name: string;
  color: string;                    // switcher orientation cue
  root: string | null;              // absolute project folder (null = none)
  themeId: string | null;           // per-workspace theme override; null = inherit the global theme
  // Agent trust (VS Code-style): when false, the agent ALWAYS asks before a file write/edit or command
  // in this workspace, even if global auto-approve is on. undefined = trusted (so migrated/older defs and
  // the default workspace are unaffected); new workspaces start untrusted until the user trusts them.
  trusted?: boolean;
  createdAt: number;
  lastOpenedAt: number;
}

// A terminal spec inside a workspace blueprint — structure only, no live state.
export interface BlueprintTab {
  name: string;
  cwd?: string;                     // absolute path; omitted = the spawned workspace's root
  command?: string;                 // optional startup command run on spawn (may hold [param] tokens — Phase 4.2)
  group?: number;                   // which split group (pane)
}

// A reusable workspace blueprint — the "Template" in the UI. Saved in-app (relay.json); "New from
// template" spawns a fresh workspace from it. Named "blueprint" in code to avoid colliding with
// Settings.template (the THEME id), which is an unrelated string.
export interface WorkspaceBlueprint {
  id: string;
  name: string;
  root: string | null;              // default folder for spawned workspaces
  themeId: string | null;           // theme for spawned workspaces (null = inherit)
  color: string;                    // switcher orientation cue for spawned workspaces
  tabs: BlueprintTab[];
  layout?: unknown;                 // split-tree layout (opaque; group indices)
  createdAt: number;
}

// A saved command snippet — created by highlighting text in a block and bookmarking it.
export interface Bookmark {
  id: string;
  text: string;
  createdAt: number;
  groupId?: string;                 // which BookmarkGroup it belongs to (undefined = ungrouped)
}

// A named group of bookmarks. Array order in Settings.bookmarkGroups is the display order.
export interface BookmarkGroup {
  id: string;
  name: string;
}

export interface Settings {
  workspace: string | null;         // opened project root
  defaultModel: string;
  autoApprove: boolean;             // agent tool calls run without prompting
  autoSave: boolean;                // open terminals persist across relaunch
  theme: 'dark' | 'light';
  template: 'graphite' | 'ember' | 'voltage' | 'aurora' | 'daylight'; // selected design theme
  sidebarCollapsed: boolean;
  toolbarShown: boolean;            // top toolbar visibility
  librarySort: 'recent' | 'name' | 'model' | 'custom';
  librarySplit: number;             // Library section height as a fraction of the sidebar (0–1)
  sidebarWidth: number;             // sidebar width in px
  shellIntegration: boolean;        // inject command-block markers into new shells
  blocksView: boolean;              // Warp-style blocks as the main view (vs classic xterm)
  fileEditor?: string;              // editor id (see shared/editors.ts) the Files list opens a code file in; default 'code' (VS Code), 'system' = OS default
  notifications: boolean;           // desktop notification when a long command finishes unfocused
  bookmarks: Bookmark[];            // saved command snippets
  bookmarkGroups: BookmarkGroup[];  // groups for organizing bookmarks (display order = array order)
  hasKey: Record<string, boolean>;  // provider -> whether a key is stored (never the key itself)
  issueTags?: Record<string, string[]>; // private local tags, keyed "repo#number" → ["mine","reviewing"] (never touch GitHub)
  sidebarView?: 'library' | 'files' | 'issues' | 'prs' | 'tasks'; // which rail panel is active in the sidebar
  issueRepos?: string[]; // LEGACY (pre per-workspace): global tracked repos — migrated into issueReposByWs
  issueRepo?: string;    // LEGACY (pre per-workspace): global active repo — migrated into issueRepoByWs
  issueReposByWs?: Record<string, string[]>; // tracked repos per workspace id (Issues are per-workspace)
  issueRepoByWs?: Record<string, string>;    // active repo per workspace id; empty → infer from the folder's remote
  issueAgent?: string;   // preferred coding agent id for Assign (claude/gemini/codex/aider/antigravity)
  issueConcurrency?: number; // max agents the assign queue runs at once (per repo); default 2
  issuePipelineByKey?: Record<string, string>; // per-issue pipeline id, keyed "provider:repo#number"; unset → default validate-fix
  issueDepsByKey?: Record<string, string[]>;   // per-issue dependency repo ids (qualified "provider:repo"), keyed "provider:repo#number" — checked out read-only under .deps/ in the worktree for reference
  issueDbCredByKey?: Record<string, string>;   // per-issue DB credential template id (see DbCredMeta), keyed "provider:repo#number"; injected into the run's env
  prPipelineByKey?: Record<string, string>;    // per-PR review pipeline id, keyed "provider:repo#number"; unset → default review-pr
  prDbCredByKey?: Record<string, string>;      // per-PR DB credential template id, keyed "provider:repo#number"; injected into the review run's env
  tasksByWs?: Record<string, Task[]>;          // per-workspace Tasks: draft an issue, validate it against the repo, file it only if valid
  pipelines?: PipelineDef[]; // user-authored custom pipelines (built-ins live in code); merged into the registry
  stageBriefs?: Record<string, string>; // per stage-kind (validate/fix/reproduce/test/review/custom) default-brief override; seeds new stages in the builder + task validation
  bitbucketWorkspacesByWs?: Record<string, string[]>; // Bitbucket workspace ids to list repos from, per Slayer T workspace id (CHANGE-2770)
  providersScopedMigrated?: boolean; // one-shot flag: the pre-scoping global provider secrets have been moved into a workspace
  notificationsByWs?: Record<string, AppNotification[]>; // per-workspace issue/PR notifications (persisted; survives restart)
  issuePushNotify?: boolean;         // fire native OS notifications for new/closed issues & PRs (default true)
  notifySound?: boolean;             // play a chime when a new issue/PR notification arrives (default true)
  notifyReposByWs?: Record<string, string[]>; // qualified repo ids the poller watches, per workspace id. Undefined for a ws → default to that ws's tracked repos; defined (even []) → exactly these.
  webhookEnabled?: boolean;          // run the local webhook receiver for near-real-time issue/PR notifications
  webhookPort?: number;              // port the webhook receiver listens on (default 47824)
  webhookSecret?: string;            // shared secret verifying incoming webhooks (GitHub HMAC / GitLab token / Bitbucket ?token)
}

// Streaming events emitted by the agent loop to the renderer.
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; preview: string }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; message: string };

export interface DiffLine {
  t: '+' | '-' | ' ';
  text: string;
}

// Approval request sent main -> renderer before a mutating tool runs.
export interface ApprovalRequest {
  id: string;
  kind: 'write' | 'edit' | 'command';
  title: string;
  detail: string;        // command line, or a short summary
  diff?: DiffLine[];     // present for write/edit — rendered as a colored diff
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// A per-workspace notification for a provider event (new/closed issue or PR), shown in the header bell and
// (optionally) fired as a native OS notification. Detected by the background poller diffing each repo over time.
// A Task = a proposed issue you validate against the repo BEFORE filing it. Run a validate-only pipeline; if
// the agent judges it valid, an issue is created on the provider with the validation result; if not, no issue
// is filed and the result is kept on the task. Persisted per-workspace in Settings.tasksByWs.
export interface Task {
  id: string;
  provider: string;                              // github | gitlab | bitbucket
  repo: string;                                  // native repo id (owner/name)
  title: string;
  body: string;                                  // the proposed issue description (what to validate)
  // validate flow: draft→validating→invalid|open|closed. New Feature flow: draft→authoring→reviewing→open|revise.
  status: 'draft' | 'validating' | 'invalid' | 'error' | 'open' | 'closed' | 'valid' | 'authoring' | 'reviewing' | 'revise'; // 'valid' = legacy (filed)
  result?: string;                               // the validation / review summary (set once it runs)
  issueNumber?: number;                          // if valid → the filed issue
  issueUrl?: string;
  agentId?: string;                              // agent used for the validate run
  tags?: string[];                               // 'bug' | 'enhancement' | 'newfeature' — inject type-appropriate guidance into the brief
  webResearch?: boolean;                         // New Feature only: include the web-research (global brands) step in the author brief
  deps?: string[];                               // dependency repo ids ("provider:repo") linked read-only under .deps/ for the validate run
  dbCredId?: string;                             // DB credential template id (see DbCredMeta) injected into the validate run's env
  ts: number;                                    // created (epoch ms)
  ranAt?: number;                                // last validated (epoch ms)
}

// A saved database-credential TEMPLATE. The full record (incl. password + extra values) is encrypted at rest
// in the OS keychain and lives ONLY in the main process (see keys.ts). This is the SANITIZED shape the renderer
// receives: connection metadata for display/editing, but NEVER the password or any extra-var value. When a
// pipeline run references a template, the main process injects it into that run's shell environment as the
// `envVars` (DB_*, DATABASE_URL, engine aliases, extras) — the secret is never written to a file or the brief.
export interface DbCredMeta {
  id: string;
  label: string;                 // human name shown in the picker (e.g. "PRIISMS prod DB")
  engine?: string;               // postgres | mysql | mongodb | mssql | redis | sqlite | other
  host?: string;
  port?: string;
  database?: string;
  user?: string;
  hasPassword: boolean;          // a password is stored (its value is never returned)
  extraKeys: string[];           // NAMES of the extra env vars (values are secret, not returned)
  envVars: string[];             // full list of env var NAMES this template injects — drives the brief note
  ts?: number;                   // created (epoch ms) — display order
}
export interface AppNotification {
  id: string;                                    // stable dedupe key: `${kind}:${provider}:${repo}#${number}`
  kind: 'new-issue' | 'closed-issue' | 'new-pr' | 'closed-pr';
  provider: string;                              // github | gitlab | bitbucket
  repo: string;                                  // owner/name (native repo id)
  number: number;
  title: string;
  url: string;
  actor?: string;                                // the person behind it: issue/PR author (new), or who closed/merged it (webhook)
  ts: number;                                    // when we detected it (epoch ms)
  read: boolean;
}

// --- Issue Agent (Phase 1: read-only) ---
// A provider issue, normalized by the adapter. Phase 1 pulls GitHub issues via the `gh` CLI.
export interface IssueLabel { name: string; color?: string; }
export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: IssueLabel[];
  state: string;
  url: string;
  assignees?: string[];             // GitHub logins assigned to the issue (for the "assigned to me" filter)
  author?: string;                  // the creator's login/username (for the "created by" filter)
  milestone?: string;               // milestone title, if any
}

// --- Issue Pipelines (serializable, so custom pipelines can be authored + persisted) ---
// A pipeline is a graph of STAGES wired by conditional EDGES. Briefs are TEMPLATE STRINGS (tokens
// {issue} {number} {title} {closeStep} {verdictRel}) so a user-authored pipeline round-trips through JSON;
// edges reference a stage by its stable `id` (not its editable name) or the sentinel 'stop'.
export type StageKind = 'validate' | 'fix' | 'reproduce' | 'test' | 'review' | 'custom';
export type EdgeWhen = 'valid' | 'invalid' | 'always';
export interface PipelineEdge { when: EdgeWhen; to: string; } // to = a stage id, or 'stop' (stop & report)
export interface StageDef {
  id: string;            // stable id (edge targets + canvas key); the display `name` can be renamed freely
  name: string;
  kind: StageKind;
  brief: string;         // template with {issue} {number} {title} {closeStep} {verdictRel}
  edges: PipelineEdge[]; // outgoing transitions; a conditional edge makes this a GATE, no edges = terminal
  x?: number; y?: number; // builder-canvas layout (ignored by the runner)
}
export interface PipelineDef {
  id: string;
  name: string;
  desc: string;
  builtin?: boolean;     // shipped-in-code pipelines can't be deleted/renamed (they can be duplicated)
  stages: StageDef[];
  stopPos?: { x: number; y: number }; // builder-canvas position of the ⛔ Stop node (layout only; runner ignores)
}
