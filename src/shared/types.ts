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
  notifications: boolean;           // desktop notification when a long command finishes unfocused
  bookmarks: Bookmark[];            // saved command snippets
  bookmarkGroups: BookmarkGroup[];  // groups for organizing bookmarks (display order = array order)
  hasKey: Record<string, boolean>;  // provider -> whether a key is stored (never the key itself)
  issueTags?: Record<string, string[]>; // private local tags, keyed "repo#number" → ["mine","reviewing"] (never touch GitHub)
  sidebarView?: 'library' | 'files' | 'issues'; // which rail panel is active in the sidebar
  issueRepos?: string[]; // LEGACY (pre per-workspace): global tracked repos — migrated into issueReposByWs
  issueRepo?: string;    // LEGACY (pre per-workspace): global active repo — migrated into issueRepoByWs
  issueReposByWs?: Record<string, string[]>; // tracked repos per workspace id (Issues are per-workspace)
  issueRepoByWs?: Record<string, string>;    // active repo per workspace id; empty → infer from the folder's remote
  issueAgent?: string;   // preferred coding agent id for Assign (claude/gemini/codex/aider/antigravity)
  issueConcurrency?: number; // max agents the assign queue runs at once (per repo); default 2
  issuePipeline?: string; // preferred pipeline id for Assign (validate-fix | fix-only); default validate-fix
  pipelines?: PipelineDef[]; // user-authored custom pipelines (built-ins live in code); merged into the registry
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
