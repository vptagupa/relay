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
  createdAt: number;
  lastOpenedAt: number;
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
