// The renderer's single source of truth: the app-state singleton plus its type and derived
// accessors. Everything that mutates UI state does so through `state`; views derive from it
// (e.g. leaves(layout), gTab(g)) rather than caching the same fact twice. Kept in one module so
// feature views can import the state they read instead of the renderer owning it privately.

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { Settings, SavedSession, ChatTurn, Block } from './shared/types';
import { DEFAULT_MODEL } from './shared/models';
import type { LNode } from './layout';

// A tab is polymorphic: kind 'terminal' (the default — an xterm + pty) or 'file' (an in-app code viewer/editor).
// term/fit/ser are terminal-only (undefined for file tabs); filePath is file-only. `el` is the generic pane host
// element for either kind. New content kinds slot in the same way — add to the union + guard the terminal-only sites.
export interface Tab { id: string; name: string; model: string; cwd: string; repo?: string; repoCwd?: string; libId?: string; kind: 'terminal' | 'file'; term?: Terminal; fit?: FitAddon; ser?: SerializeAddon; el: HTMLElement; filePath?: string; fileDirty?: boolean; lastCols?: number; lastRows?: number; fitted?: boolean; replayQ?: string; tabBg?: string; tabFg?: string; bodyBg?: string; bodyFg?: string; chat: ChatTurn[]; blocks: Block[]; bkNonce: string; cmdHistory: string[]; histIdx: number; liveInteractive: boolean; group: number; }

export const state = {
  tabs: [] as Tab[],
  active: '' as string,
  gv: ['', '', '', ''] as string[],      // visible tab id per group slot
  groups: 1,                             // number of open groups/panes (derived from layout leaves)
  focus: 0,                              // which group has focus
  layout: { g: 0 } as LNode,             // nested split tree (leaves = pane indices)
  maxG: null as null | number,           // a group temporarily maximized (fills the pane grid)
  booting: true,                         // suppress autosave until a workspace has finished restoring (shared by renderer + workspaces.ts)
  settings: { workspace: null, defaultModel: DEFAULT_MODEL, autoApprove: false, autoSave: true, theme: 'dark', template: 'graphite', sidebarCollapsed: false, toolbarShown: false, librarySort: 'recent', librarySplit: 0.4, sidebarWidth: 260, hasKey: {} } as Settings,
  library: [] as SavedSession[],
  history: [] as ChatTurn[],
  browsePath: '' as string,
  browse: null as null | { path: string; parent: string; entries: { name: string; isDir: boolean }[] },
};

export const activeTab = () => state.tabs.find((t) => t.id === state.active);
export const gTab = (g: number) => state.tabs.find((t) => t.id === state.gv[g]);   // visible tab of group g
export const groupTabs = (g: number) => state.tabs.filter((t) => t.group === g);   // all tabs in group g
