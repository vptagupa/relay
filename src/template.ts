// The app's full chrome markup — winbar, title bar, sidebar (Library + Files), terminal area,
// status bar, and every floating surface (agent, history, bookmarks, palette, settings, approval,
// confirm, menus, toast). Pure markup with two dynamic holes: the icon sprite (from ./icons) and the
// pane grid (the renderer generates one pane per NPANES and passes the joined HTML in as `panes`).
// Element ids/classes here are the contract the renderer wires events to after this is injected.

import { ICON_SPRITE } from './icons';

export function appHtml(panes: string): string {
  return `
  ${ICON_SPRITE}
  <div class="app">
    <div class="winbar">
      <div class="winbar-brand"><span class="winbar-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.3 8l3.1 4-3.1 4"/><path d="M11.6 8.4h7.2"/><path d="M15.2 8.4v7.6"/></svg></span><span class="winbar-title">Slayer T</span></div>
      <button class="ws-chip" id="wsChip" title="Switch workspace (⌘⇧W)"><span class="ws-dot"></span><span class="ws-name" id="wsChipName">Workspace</span><span class="ws-car">▾</span></button>
      <div class="winbar-ctx">
        <button class="winbar-search" id="winSearch" title="Search commands & sessions (⌘K)">
          <span class="winbar-search-ic">⌕</span>
          <span class="winbar-search-ph">Search commands, sessions…</span>
          <span class="kbd">⌘K</span>
        </button>
      </div>
      <button class="win-icon" id="winSettings" title="Settings"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
      <button class="notif-bell" id="notifBell" title="Notifications — new/closed issues &amp; PRs (this workspace)"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg><span class="notif-badge" id="notifBadge" style="display:none">0</span></button>
      <div class="win-controls">
        <button class="win-btn" id="winMin" aria-label="Minimize"><svg viewBox="0 0 10 10"><line x1="1" y1="5" x2="9" y2="5"/></svg></button>
        <button class="win-btn" id="winMax" aria-label="Maximize"><svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7"/></svg></button>
        <button class="win-btn close" id="winClose" aria-label="Close"><svg viewBox="0 0 10 10"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg></button>
      </div>
    </div>
    <div class="notif-menu" id="notifMenu"></div>
    <header class="titlebar">
      <div class="brand"><span class="ws" id="wsLabel">No folder open</span></div>
      <div class="tb-spacer"></div>
      <button class="tb-btn" id="btnOpen">Open folder…</button>
      <button class="tb-btn" id="btnHistory" title="Command history (⌘⇧H)">☰ History</button>
      <button class="tb-btn accent" id="btnAgent">✦ Agent <span class="kbd">⌘J</span></button>
      <button class="tb-btn" id="btnPalette" title="Command palette"><span class="kbd">⌘K</span></button>
      <button class="tb-btn tb-icon" id="btnTheme" title="Toggle theme">◐</button>
      <button class="tb-btn tb-icon" id="btnSettings" title="Settings">⚙</button>
    </header>
    <div class="main" id="main">
      <aside class="sidebar">
        <nav class="side-rail" id="sideRail">
          <button class="rail-btn" data-act="new" title="New terminal (⌘T)"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>New</span></button>
          <button class="rail-btn" data-view="files" title="Files"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/></svg><span>Files</span></button>
          <button class="rail-btn" data-view="library" title="Library"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg><span>Library</span></button>
          <button class="rail-btn" data-view="issues" title="Issues"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/></svg><span>Issues</span></button>
          <button class="rail-btn" data-view="prs" title="Pull Requests"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg><span>PR</span></button>
          <button class="rail-btn" data-act="agent" title="Agent"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.2 5.6L20 10l-5 3.4L16.5 20 12 16.4 7.5 20 9 13.4 4 10l5.8-1.4z"/></svg><span>Agent</span></button>
        </nav>
        <div class="side-body">
          <div class="side-view side-library active" id="viewLibrary">
            <div class="side-head"><span class="side-title">Library</span>
              <select class="lib-sort" id="libSort" title="Sort saved terminals">
                <option value="recent">Recent</option><option value="name">Name</option><option value="model">Model</option><option value="custom">Custom</option>
              </select></div>
            <div class="side-list" id="libList"></div>
          </div>
          <div class="side-view side-files" id="viewFiles">
            <div class="side-head"><span class="side-title">Files</span><button class="files-up" id="filesUp" title="Parent folder"><svg width="15" height="15"><use href="#i-up"/></svg></button></div>
            <div class="files-path" id="filesPath">—</div>
            <div class="side-list" id="fileList"></div>
          </div>
          <div class="side-view side-issues" id="viewIssues">
            <div class="side-head"><span class="side-title">Issues</span><button class="iss-repo-sel" id="issSideRepo" title="Switch repository"></button><button class="files-up" id="issSources" title="Sources — connect providers &amp; pick repos"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button><button class="files-up" id="issMap" title="Map issues → pipelines"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="7" height="5" rx="1"/><rect x="14" y="15" width="7" height="5" rx="1"/><path d="M10 6.5h4a3 3 0 0 1 3 3v5.5"/></svg></button><button class="files-up" id="issOwners" title="Summary — issues by owner"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></button><button class="files-up" id="issSidePull" title="Pull issues"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg></button></div>
            <div class="iss-state" id="issState" style="display:none"><button class="iss-seg on" data-st="open">Open</button><button class="iss-seg" data-st="closed">Closed</button></div>
            <input class="iss-search" id="issSearch" placeholder="search issues &amp; tags…" spellcheck="false" style="display:none" />
            <div class="iss-filters" id="issFilters" style="display:none"></div>
            <div class="side-list" id="issSideList"></div>
          </div>
          <div class="side-view side-prs" id="viewPRs">
            <div class="side-head"><span class="side-title">Pull Requests</span><button class="iss-repo-sel" id="prSideRepo" title="Repo — shared with Issues (click to pick it there)"></button><button class="files-up" id="prMap" title="Map PRs → review pipelines"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="7" height="5" rx="1"/><rect x="14" y="15" width="7" height="5" rx="1"/><path d="M10 6.5h4a3 3 0 0 1 3 3v5.5"/></svg></button><button class="files-up" id="prPull" title="Refresh pull requests"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg></button></div>
            <div class="iss-state" id="prScope"><button class="iss-seg on" data-sc="repo">This repo</button><button class="iss-seg" data-sc="all">All repos</button></div>
            <div class="iss-state" id="prState" style="display:none"><button class="iss-seg on" data-st="open">Open</button><button class="iss-seg" data-st="closed">Closed</button></div>
            <div class="side-list" id="prList"></div>
          </div>
          <div class="side-foot"><span class="sdot" id="storeDot"></span><span id="storeText">Saved on this machine</span></div>
        </div>
      </aside>
      <div class="main-divider" id="mainDivider" title="Drag to resize sidebar"></div>
      <section class="term-area">
        <div class="tabstrip">
          <button class="side-toggle" id="btnSidebar" title="Toggle library (⌘B)">▤</button>
          <button class="tab-add" id="btnNewTab" title="New terminal (⌘T)"><svg width="16" height="16"><use href="#i-plus"/></svg></button>
          <button class="tab-add" id="btnAddFolder" title="Open folder in new terminal (⌘⇧O)"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="9.5" y1="13.5" x2="14.5" y2="13.5"/></svg></button>
          <button class="tab-add cc" id="btnClaude" title="Launch Claude Code (⌘⇧L)"><svg width="16" height="16"><use href="#i-spark"/></svg></button>
          <div class="tt-spacer"></div>
          <button class="tt-model" id="tabModelBtn" title="Model for this terminal"><span class="dot"></span><span id="tabModelName">Opus 5</span> ▾</button>
          <button class="tt-icon blocks-toggle on" id="btnBlocks" title="Blocks view / Classic terminal (⌘⇧B)"><svg width="16" height="16"><use href="#i-grid"/></svg></button>
          <button class="tt-icon" id="btnSplitRight" title="Split right — clone this terminal into a pane on the right (⌘⇧E)"><svg width="16" height="16"><use href="#i-split"/></svg></button>
          <button class="tt-icon" id="btnSplitDown" title="Split down — clone this terminal into a pane below"><svg width="16" height="16"><use href="#i-splitdown"/></svg></button>
          <button class="tt-icon" id="btnBookmarks" title="Bookmarks — highlight a command to save one (⌘⇧K)"><svg width="16" height="16"><use href="#i-star"/></svg></button>
          <button class="tt-icon" id="btnSave" title="Save to Library (⌘S)"><svg width="16" height="16"><use href="#i-save"/></svg></button>
          <button class="tt-icon" id="btnClear" title="Clear terminal (⌃L)"><svg width="16" height="16"><use href="#i-clear"/></svg></button>
        </div>
        <div class="term-stack">
         <div class="pane-grid" id="paneGrid">
          ${panes}
         </div>
        </div>
      </section>
    </div>
    <footer class="statusbar">
      <div class="st-seg accent"><span class="dot"></span><span id="stSession">—</span></div>
      <div class="st-seg" id="stCwd">~</div>
      <div class="st-spacer"></div>
      <div class="st-seg btn" id="stAutosave"><span class="dot"></span><span id="stAutosaveText">Auto-save on</span></div>
      <div class="st-seg btn" id="stAgent"><span class="dot"></span>agent · Opus 5</div>
      <div class="st-seg tnum" id="stClock">--:--</div>
    </footer>
  </div>

  <aside class="agent" id="agentPanel">
    <div class="agent-head">
      <div class="agent-ava">✦</div>
      <div><div class="agent-title">Agent</div>
        <button class="model-btn" id="modelBtn"><span class="dot"></span><span id="modelBtnName">Opus 5</span> ▾</button></div>
      <button class="agent-close" id="btnAgentClose">✕</button>
    </div>
    <div class="agent-body" id="agentBody"></div>
    <div class="agent-inputwrap">
      <textarea class="agent-input" id="agentInput" rows="1" placeholder="Ask the agent to read or change files in this project…"></textarea>
      <button class="agent-send" id="agentSend">➤</button>
    </div>
  </aside>

  <aside class="history" id="historyPanel" role="dialog" aria-label="Command history">
    <div class="hist-head"><div class="hist-title">☰ History</div><button class="hist-x" id="btnHistoryClose" aria-label="Close">✕</button></div>
    <div class="hist-tools">
      <div class="hist-search"><span>⌕</span><input id="histSearch" placeholder="Search commands & output" spellcheck="false"></div>
      <button class="hist-filter" id="histFilter" title="Show failures only">✗ Fails</button>
      <div class="hist-exwrap"><button class="hist-export" id="histExport" title="Export session">⤓</button><div class="hist-exmenu" id="histExMenu"><button data-fmt="md">Markdown</button><button data-fmt="json">JSON</button><button data-fmt="txt">Plain text</button><button data-fmt="html">HTML</button></div></div>
    </div>
    <div class="hist-body"><aside class="hist-rail" id="histRail"></aside><div class="hist-list" id="histList"></div></div>
  </aside>

  <div class="model-menu" id="modelMenu" role="listbox"></div>
  <div class="ws-menu" id="wsMenu" role="listbox"></div>
  <div class="ws-menu" id="tplMenu" role="listbox"></div>
  <div class="ctx-menu" id="tabMenu" role="menu"></div>
  <div class="ctx-menu" id="tabsMenu" role="menu"></div>
  <div class="color-pop" id="colorPop"></div>

  <div class="palette" id="palette">
    <div class="pal-input-wrap"><span class="pal-ic">⌘</span><input class="pal-input" id="palInput" placeholder="Type a command or search sessions…" spellcheck="false"></div>
    <div class="pal-list" id="palList"></div>
  </div>

  <div class="scrim" id="scrim"></div>

  <div class="modal" id="settings">
    <div class="modal-head">Settings</div>
    <div class="modal-sub">API keys are encrypted with your OS keychain and stay in the app's main process — never in this window.</div>
    <div class="modal-body">
      <div class="field"><label>Theme</label><div class="theme-grid" id="themeGrid"></div><div class="fhint">Recolors the whole app and the terminal. Quick-cycle with the ◐ button in the title bar.</div></div>
      <div class="field"><label>Project folder</label><div class="row"><input id="setWs" readonly placeholder="none"><button class="set" id="setWsBtn">Choose…</button></div></div>
      <div class="field"><label>Open files in</label><select id="fileEditorSel"></select><div class="fhint">Which editor a clicked file (in the Files list or a terminal path) opens in. Non-code files always use your OS default, and it falls back to the OS default if the editor isn't installed.</div></div>
      <div class="field"><label>Anthropic API key (Claude) <span class="opt">optional</span></label><div class="row"><input id="keyAnthropic" type="password" placeholder="blank = use your Claude Code login"><button class="set" data-key="anthropic">Save</button></div><div class="state off" id="stateAnthropic">not set</div><div class="fhint">Leave blank to sign in with your Claude subscription / Claude Code login (or an environment key). Paste a key only to override.</div></div>
      <div class="field"><label>OpenAI API key (GPT)</label><div class="row"><input id="keyOpenai" type="password" placeholder="sk-…"><button class="set" data-key="openai">Save</button></div><div class="state off" id="stateOpenai">not set</div></div>
      <div class="field"><label>Google AI API key (Gemini)</label><div class="row"><input id="keyGoogle" type="password" placeholder="AIza…"><button class="set" data-key="google">Save</button></div><div class="state off" id="stateGoogle">not set</div></div>
      <label class="chk"><input type="checkbox" id="autoApprove"> Auto-approve agent file writes & commands (skip the confirm step)</label>
      <label class="chk"><input type="checkbox" id="shellIntegration"> Command blocks — capture each command as a block in History (shell integration; applies to new terminals)</label>
      <label class="chk"><input type="checkbox" id="blocksViewSet"> Blocks view — show commands as blocks in the main terminal (full-screen apps drop to the live terminal automatically)</label>
      <label class="chk"><input type="checkbox" id="notifySet"> Notify me when a long command finishes while Slayer T isn't focused</label>
      <label class="chk"><input type="checkbox" id="notifyIssuesSet"> Notify me about new/closed issues &amp; pull requests across my tracked repos</label>
      <div class="field"><label>Something broke?</label><div class="row"><button class="set" id="btnReportBug">Report a bug…</button><button class="set" id="btnRevealLog">Reveal error log</button></div><div class="fhint">Collects the app version, OS, and the recent error log (secrets scrubbed), copies it to your clipboard, and opens a pre-filled GitHub issue.</div></div>
    </div>
    <div class="modal-foot"><button class="btn primary" id="settingsClose">Done</button></div>
  </div>

  <div class="approval" id="approval">
    <div class="a-title" id="apTitle"></div>
    <div class="a-detail" id="apDetail"></div>
    <div class="a-foot"><button class="btn" id="apDeny">Deny</button><button class="btn primary" id="apAllow">Allow</button></div>
  </div>

  <aside class="history bookmarks" id="bookmarksPanel" role="dialog" aria-label="Bookmarks">
    <div class="hist-head"><div class="hist-title">★ Bookmarks</div><button class="hist-x" id="btnBookmarksClose" aria-label="Close">✕</button></div>
    <div class="hist-tools"><button class="hist-filter" id="bkmNew" title="Add a bookmark manually">＋ Bookmark</button><button class="hist-filter" id="bkmAddGroup" title="Add a group">＋ Group</button></div>
    <div class="hist-list" id="bkmList"></div>
  </aside>

  <div class="bkm-pop" id="bkmPop"><button id="bkmAdd">★ Bookmark</button></div>

  <div class="cd-pop" id="cdPop"><div class="cd-hint">cd — ↑↓ select · Tab drill · Enter fill</div><div class="cd-list" id="cdList"></div></div>

  <div class="confirm" id="confirmBox" role="alertdialog" aria-labelledby="cfTitle">
    <div class="a-title" id="cfTitle">Close terminal?</div>
    <div class="a-detail" id="cfDetail"></div>
    <div class="a-foot"><button class="btn" id="cfCancel">Cancel</button><button class="btn primary" id="cfOk">Close</button></div>
  </div>

  <div class="toast-wrap" id="toastWrap"></div>
`;
}
