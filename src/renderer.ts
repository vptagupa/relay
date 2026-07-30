import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { MODELS, modelById, DEFAULT_MODEL } from './shared/models';
import type { Settings, SavedSession, AgentEvent, ApprovalRequest, ChatTurn, OpenTab, Block, Bookmark, BookmarkGroup } from './shared/types';

const relay = (window as any).relay;
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const uid = () => (crypto as any).randomUUID();
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

interface Tab { id: string; name: string; model: string; cwd: string; libId?: string; term: Terminal; fit: FitAddon; ser: SerializeAddon; el: HTMLElement; lastCols?: number; lastRows?: number; tabBg?: string; tabFg?: string; bodyBg?: string; bodyFg?: string; chat: ChatTurn[]; blocks: Block[]; bkNonce: string; cmdHistory: string[]; histIdx: number; liveInteractive: boolean; }

const state = {
  tabs: [] as Tab[],
  active: '' as string,
  settings: { workspace: null, defaultModel: DEFAULT_MODEL, autoApprove: false, autoSave: true, theme: 'dark', sidebarCollapsed: false, toolbarShown: false, librarySort: 'recent', librarySplit: 0.4, sidebarWidth: 260, hasKey: {} } as Settings,
  library: [] as SavedSession[],
  history: [] as ChatTurn[],
  browsePath: '' as string,
  browse: null as null | { path: string; parent: string; entries: { name: string; isDir: boolean }[] },
};
const activeTab = () => state.tabs.find((t) => t.id === state.active);

/* ----------------------------- layout ----------------------------- */
$('#app').innerHTML = `
  <div class="app">
    <div class="winbar">
      <div class="winbar-brand"><span class="winbar-mark">›_</span><span class="winbar-title">Relay v2</span></div>
      <div class="winbar-ctx" id="winCtx"></div>
      <div class="win-controls">
        <button class="win-btn" id="winMin" aria-label="Minimize"><svg viewBox="0 0 10 10"><line x1="1" y1="5" x2="9" y2="5"/></svg></button>
        <button class="win-btn" id="winMax" aria-label="Maximize"><svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7"/></svg></button>
        <button class="win-btn close" id="winClose" aria-label="Close"><svg viewBox="0 0 10 10"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg></button>
      </div>
    </div>
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
        <div class="side-view side-library" id="viewLibrary">
          <div class="side-head"><span class="side-title">Library</span>
            <select class="lib-sort" id="libSort" title="Sort saved terminals">
              <option value="recent">Recent</option><option value="name">Name</option><option value="model">Model</option><option value="custom">Custom</option>
            </select></div>
          <div class="side-list" id="libList"></div>
        </div>
        <div class="side-divider" id="sideDivider" title="Drag to resize"></div>
        <div class="side-view side-files" id="viewFiles">
          <div class="side-head"><span class="side-title">Files</span><button class="files-up" id="filesUp" title="Parent folder">↑</button></div>
          <div class="files-path" id="filesPath">—</div>
          <div class="side-list" id="fileList"></div>
        </div>
        <div class="side-foot"><span class="sdot" id="storeDot"></span><span id="storeText">Saved on this machine</span></div>
      </aside>
      <div class="main-divider" id="mainDivider" title="Drag to resize sidebar"></div>
      <section class="term-area">
        <div class="tabstrip">
          <button class="side-toggle" id="btnSidebar" title="Toggle library">▤</button>
          <div class="tabs" id="tabs"></div>
          <button class="tab-add" id="btnNewTab" title="New terminal (⌘T)">+</button>
          <button class="tab-add" id="btnAddFolder" title="Open folder in new terminal (⌘⇧O)"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="9.5" y1="13.5" x2="14.5" y2="13.5"/></svg></button>
          <button class="tab-add cc" id="btnClaude" title="Launch Claude Code (⌘⇧C)">✳</button>
          <div class="tt-spacer"></div>
          <button class="tt-model" id="tabModelBtn" title="Model for this terminal"><span class="dot"></span><span id="tabModelName">Opus 5</span> ▾</button>
          <button class="tt-icon blocks-toggle on" id="btnBlocks" title="Blocks view / Classic terminal (⌘⇧B)">⊞</button>
          <button class="tt-icon" id="btnBookmarks" title="Bookmarks — highlight a command to save one (⌘⇧K)">★</button>
          <button class="tt-icon" id="btnSave" title="Save to Library (⌘S)">⤓</button>
          <button class="tt-icon" id="btnClear" title="Clear terminal (⌃L)">⌫</button>
        </div>
        <div class="term-stack">
          <div class="term-host" id="termHost">
            <div class="term-empty" id="termEmpty">No terminal yet.<br>Press + to open one.</div>
          </div>
          <div class="blocks-view" id="blocksView">
            <div class="bv-scroll" id="bvScroll"></div>
            <div class="bv-input">
              <span class="bv-prompt" id="bvPrompt">❯</span>
              <textarea class="bv-cmd" id="bvCmd" rows="1" placeholder="type a command — Enter runs · Shift+Enter new line · ↑ recalls" spellcheck="false" autocomplete="off"></textarea>
            </div>
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
  <div class="ctx-menu" id="tabMenu" role="menu"></div>
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
      <div class="field"><label>Project folder</label><div class="row"><input id="setWs" readonly placeholder="none"><button class="set" id="setWsBtn">Choose…</button></div></div>
      <div class="field"><label>Anthropic API key (Claude) <span class="opt">optional</span></label><div class="row"><input id="keyAnthropic" type="password" placeholder="blank = use your Claude Code login"><button class="set" data-key="anthropic">Save</button></div><div class="state off" id="stateAnthropic">not set</div><div class="fhint">Leave blank to sign in with your Claude subscription / Claude Code login (or an environment key). Paste a key only to override.</div></div>
      <div class="field"><label>OpenAI API key (GPT)</label><div class="row"><input id="keyOpenai" type="password" placeholder="sk-…"><button class="set" data-key="openai">Save</button></div><div class="state off" id="stateOpenai">not set</div></div>
      <div class="field"><label>Google AI API key (Gemini)</label><div class="row"><input id="keyGoogle" type="password" placeholder="AIza…"><button class="set" data-key="google">Save</button></div><div class="state off" id="stateGoogle">not set</div></div>
      <label class="chk"><input type="checkbox" id="autoApprove"> Auto-approve agent file writes & commands (skip the confirm step)</label>
      <label class="chk"><input type="checkbox" id="shellIntegration"> Command blocks — capture each command as a block in History (shell integration; applies to new terminals)</label>
      <label class="chk"><input type="checkbox" id="blocksViewSet"> Blocks view — show commands as blocks in the main terminal (full-screen apps drop to the live terminal automatically)</label>
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
    <div class="hist-tools"><button class="hist-filter" id="bkmAddGroup" title="Add a group">＋ Group</button></div>
    <div class="hist-list" id="bkmList"></div>
  </aside>

  <div class="bkm-pop" id="bkmPop"><button id="bkmAdd">★ Bookmark</button></div>

  <div class="confirm" id="confirmBox" role="alertdialog" aria-labelledby="cfTitle">
    <div class="a-title" id="cfTitle">Close terminal?</div>
    <div class="a-detail" id="cfDetail"></div>
    <div class="a-foot"><button class="btn" id="cfCancel">Cancel</button><button class="btn primary" id="cfOk">Close</button></div>
  </div>

  <div class="toast-wrap" id="toastWrap"></div>
`;

/* ----------------------------- helpers ----------------------------- */
const XTERM_THEME = {
  background: '#0b0e13', foreground: '#d8dee7', cursor: '#f0b429', cursorAccent: '#0b0e13',
  selectionBackground: 'rgba(240,180,41,.28)',
  black: '#0b0e13', red: '#ff7b72', green: '#7ee787', yellow: '#f0b429', blue: '#6cb6ff',
  magenta: '#d2a8ff', cyan: '#56d4dd', white: '#d8dee7', brightBlack: '#66717f',
};
function toast(msg: string, ok = false) {
  const w = $('#toastWrap');
  w.innerHTML = `<div class="toast ${ok ? 'ok' : ''}"><span class="tdot"></span>${esc(msg)}</div>`;
  setTimeout(() => (w.innerHTML = ''), 2600);
}
// Move the item identified by dragId to before/after targetId within arr.
function reorderById<T>(arr: T[], getId: (x: T) => string, dragId: string, targetId: string, before: boolean) {
  const from = arr.findIndex((x) => getId(x) === dragId); if (from < 0) return;
  const [item] = arr.splice(from, 1);
  let to = arr.findIndex((x) => getId(x) === targetId);
  if (to < 0) { arr.push(item); return; }
  if (!before) to += 1;
  arr.splice(to, 0, item);
}
function makeEditable(el: HTMLElement, commit: (v: string) => void) {
  const dragAnc = el.closest('[draggable="true"]') as HTMLElement | null; // don't drag while renaming
  if (dragAnc) dragAnc.draggable = false;
  el.setAttribute('contenteditable', 'true');
  el.focus();
  const sel = window.getSelection(); const r = document.createRange();
  r.selectNodeContents(el); sel?.removeAllRanges(); sel?.addRange(r);
  const done = (save: boolean) => {
    el.removeAttribute('contenteditable');
    if (dragAnc) dragAnc.draggable = true;
    if (save) commit(el.textContent?.trim() || '');
  };
  el.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); (el as HTMLElement).blur(); } else if (e.key === 'Escape') { done(false); } };
  el.onblur = () => done(true);
}
function shortCwd(c: string) { const h = state.settings.workspace; return c && h && c.startsWith(h) ? '…' + (c.slice(h.length) || '/') : (c || '~'); }
// Real identity + a home-relative cwd for the Blocks-view prompt line (agent@host ~/path $).
const SYS = ((relay.sys as { user: string; host: string; home: string }) || { user: 'user', host: 'relay', home: '' });
function promptCwd(c: string) {
  let p = (c || SYS.home || '~').replace(/\\/g, '/');
  const home = (SYS.home || '').replace(/\\/g, '/');
  if (home && (p === home || p.startsWith(home + '/'))) p = '~' + p.slice(home.length);
  return p;
}
function promptLine(cwd: string) {
  return `<span class="p-user">${esc(SYS.user)}</span><span class="p-at">@</span><span class="p-host">${esc(SYS.host)}</span> <span class="p-path">${esc(promptCwd(cwd))}</span><span class="p-dollar"> $</span>`;
}
// Last path segment of a folder path (handles both \ and /), for naming a folder's terminal.
function baseName(p: string): string { const s = p.replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')); return (i >= 0 ? s.slice(i + 1) : s) || s; }

/* ----------------------------- terminals ----------------------------- */
async function newTab(seed?: Partial<OpenTab> & { libId?: string }, activate = true): Promise<Tab> {
  // Don't open the same terminal twice — switch to it instead.
  if (seed?.id) { const ex = state.tabs.find((t) => t.id === seed.id); if (ex) { if (activate) switchTab(ex.id); return ex; } }
  const id = seed?.id || uid();
  const n = state.tabs.length + 1;
  const term = new Terminal({ fontFamily: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, monospace", fontSize: 13, theme: XTERM_THEME, cursorBlink: true, allowProposedApi: true, scrollback: 5000 });
  const fit = new FitAddon(); const ser = new SerializeAddon();
  term.loadAddon(fit); term.loadAddon(ser);
  const el = document.createElement('div'); el.className = 'xterm-wrap hidden'; // hidden first — avoids overlap flash
  $('#termHost').appendChild(el);
  term.open(el);
  const cwd = seed?.cwd || state.settings.workspace || '';
  const tab: Tab = { id, name: seed?.name || (n > 1 ? `terminal ${n}` : 'terminal'), model: seed?.model || state.settings.defaultModel, cwd, libId: seed?.libId, term, fit, ser, el, tabBg: seed?.tabBg, tabFg: seed?.tabFg, bodyBg: seed?.bodyBg, bodyFg: seed?.bodyFg, chat: seed?.chat ? [...seed.chat] : [], blocks: seed?.blocks ? [...seed.blocks] : [], bkNonce: uid(), cmdHistory: [], histIdx: 0, liveInteractive: false };
  state.tabs.push(tab);
  applyTermColors(tab); // honor any restored per-terminal body/text colors
  term.onData((d) => relay.ptyWrite(id, d));
  term.onSelectionChange(() => { if (state.active === id) refreshPill(); }); // show the ★ pill for terminal selections
  let saveT: any;
  term.onData(() => { clearTimeout(saveT); saveT = setTimeout(persistWorkspace, 1500); }); // keep the persisted snapshot fresh
  if (activate) {
    // Reveal only this tab and size it BEFORE the shell starts, so the pty is created at
    // the right size and doesn't repaint (flash) from a follow-up resize.
    state.active = id;
    $('#termEmpty').style.display = 'none';
    for (const x of state.tabs) x.el.classList.toggle('hidden', x.id !== id);
    fit.fit(); tab.lastCols = term.cols; tab.lastRows = term.rows;
  }
  renderTabs();
  // Reattach to a live shell if one exists (replays its real output); otherwise spawn a
  // fresh shell, seeded with the saved snapshot as scrollback (main handles ordering).
  await relay.ptyCreate(id, cwd, term.cols || 80, term.rows || 24, seed?.scrollback);
  if (activate) switchTab(id);
  renderTabs(); persistWorkspace();
  return tab;
}
// "Add a folder": pick a directory and immediately open a new terminal rooted there,
// named after the folder. The chosen folder also becomes the current project (so plain
// new terminals default to it and the header shows it).
async function addFolderTab() {
  const dir = await relay.pickFolder();
  if (!dir) return; // dialog cancelled
  state.settings = await relay.patchSettings({ workspace: dir });
  updateStatus(); reflectSettings();
  await newTab({ cwd: dir, name: baseName(dir) });
}
// Fit the terminal to its container and resize the pty only when the size actually
// changed — a no-op resize still makes the shell repaint (flash).
function applyResize(t: Tab) {
  t.fit.fit();
  const c = t.term.cols, r = t.term.rows;
  if (c > 0 && r > 0 && (c !== t.lastCols || r !== t.lastRows)) { t.lastCols = c; t.lastRows = r; relay.ptyResize(t.id, c, r); }
}
function switchTab(id: string) {
  state.active = id;
  $('#termEmpty').style.display = state.tabs.length ? 'none' : 'grid';
  for (const t of state.tabs) t.el.classList.toggle('hidden', t.id !== id);
  const t = activeTab();
  if (t) applyResize(t);
  renderTabs(); updateStatus(); reflectModel(); persistWorkspace();
  state.browsePath = t?.cwd || state.settings.workspace || ''; renderFiles(); // Files follows the active terminal
  if ($('#agentPanel').classList.contains('show')) renderChat();      // chat follows the active terminal
  if ($('#historyPanel').classList.contains('show')) renderHistory(); // history follows the active terminal
  updateMainView(); // show Blocks or Classic for this terminal (and focus the right surface)
}
// A small centered confirm dialog. Resolves true (confirmed) / false (cancelled).
let confirmResolve: ((v: boolean) => void) | null = null;
function confirmDialog(title: string, detail: string, okLabel = 'Close'): Promise<boolean> {
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; } // supersede any open confirm
  $('#cfTitle').textContent = title;
  $('#cfDetail').textContent = detail;
  ($('#cfOk') as HTMLElement).textContent = okLabel;
  $('#confirmBox').classList.add('show'); $('#scrim').classList.add('show');
  setTimeout(() => ($('#cfOk') as HTMLElement).focus(), 0);
  return new Promise((res) => { confirmResolve = res; });
}
function closeConfirm(v: boolean) {
  if (!$('#confirmBox').classList.contains('show')) return;
  $('#confirmBox').classList.remove('show');
  if (!$('#settings').classList.contains('show') && !$('#palette').classList.contains('show')) $('#scrim').classList.remove('show');
  const r = confirmResolve; confirmResolve = null; r?.(v);
}
async function closeTab(id: string, skipConfirm = false) {
  const t0 = state.tabs.find((x) => x.id === id); if (!t0) return;
  if (!skipConfirm) {
    const saved = t0.libId || state.library.some((s) => s.termId === t0.id);
    const detail = saved
      ? `“${t0.name}” is saved in your Library — you can reopen it anytime with its history.`
      : `“${t0.name}” isn't saved. Save it (⤓) first if you want to reopen it later.`;
    if (!(await confirmDialog('Close terminal?', detail, 'Close'))) return;
  }
  const i = state.tabs.findIndex((x) => x.id === id); if (i < 0) return; // re-find (state may have changed during confirm)
  const [t] = state.tabs.splice(i, 1);
  flushTabToLibrary(t); // keep its Library entry current so reopening restores the latest history
  relay.ptyDetach(id); t.term.dispose(); t.el.remove(); // keep the shell alive so it can be resumed
  if (state.active === id) state.active = state.tabs[Math.max(0, i - 1)]?.id || '';
  if (!state.tabs.length) { $('#termEmpty').style.display = 'grid'; renderTabs(); updateStatus(); updateMainView(); }
  else switchTab(state.active);
  persistWorkspace();
}
function renderTabs() {
  $('#tabs').innerHTML = state.tabs.map((t) => {
    // Custom tab background/text colors override the default tab styling.
    const style = (t.tabBg || t.tabFg) ? ` style="${t.tabBg ? `background:${t.tabBg};` : ''}${t.tabFg ? `color:${t.tabFg};` : ''}"` : '';
    const fgStyle = t.tabFg ? ` style="color:${t.tabFg}"` : '';
    return `
    <div class="tab ${t.id === state.active ? 'active' : ''}${(t.tabBg || t.tabFg) ? ' colored' : ''}" draggable="true" data-tab="${t.id}" title="${esc(t.name)}"${style}>
      <span class="tab-glyph"${fgStyle}>›_</span><span class="tab-name" data-rename="${t.id}">${esc(t.name)}</span>
      <span class="tab-model"${fgStyle}>${esc(modelById(t.model).short)}</span>
      <span class="tab-close" data-close="${t.id}">✕</span>
    </div>`;
  }).join('');
}
function clearActive() { activeTab()?.term.clear(); }
// Apply a terminal's per-tab body/text colors by overriding its xterm theme (background,
// foreground, cursor) and the wrapper background so the padding matches. Rebuilt from the
// base theme each time, so clearing a color reverts cleanly to the default.
function applyTermColors(t: Tab) {
  t.term.options.theme = {
    ...XTERM_THEME,
    ...(t.bodyBg ? { background: t.bodyBg, cursorAccent: t.bodyBg } : {}),
    ...(t.bodyFg ? { foreground: t.bodyFg, cursor: t.bodyFg } : {}),
  };
  t.el.style.background = t.bodyBg || '';
}

/* ----------------------------- bulk tab close + context menu ----------------------------- */
// Confirm once for the whole batch, then close each without a per-tab prompt.
async function closeTabs(ids: string[]) {
  if (!ids.length) return;
  if (ids.length === 1) return void closeTab(ids[0]);
  if (!(await confirmDialog(`Close ${ids.length} terminals?`, `${ids.length} terminals will close. Saved ones stay in your Library; unsaved ones lose their history.`, `Close ${ids.length}`))) return;
  for (const id of [...ids]) await closeTab(id, true);
}
function closeOthers(id: string) { closeTabs(state.tabs.filter((t) => t.id !== id).map((t) => t.id)); }
function closeRight(id: string) { const i = state.tabs.findIndex((t) => t.id === id); if (i >= 0) closeTabs(state.tabs.slice(i + 1).map((t) => t.id)); }
function closeLeft(id: string) { const i = state.tabs.findIndex((t) => t.id === id); if (i >= 0) closeTabs(state.tabs.slice(0, i).map((t) => t.id)); }
function closeAll() { closeTabs(state.tabs.map((t) => t.id)); }

let tabMenuItems: { label: string; dis?: boolean; run: () => void }[] = [];
function openTabMenu(id: string, x: number, y: number) {
  const i = state.tabs.findIndex((t) => t.id === id);
  tabMenuItems = [
    { label: 'Colors…', run: () => openColorPop(id) },
    { label: 'Close', run: () => closeTab(id) },
    { label: 'Close Others', dis: state.tabs.length <= 1, run: () => closeOthers(id) },
    { label: 'Close to the Right', dis: i >= state.tabs.length - 1, run: () => closeRight(id) },
    { label: 'Close to the Left', dis: i <= 0, run: () => closeLeft(id) },
    { label: 'Close All', run: () => closeAll() },
  ];
  const menu = $('#tabMenu');
  menu.innerHTML = tabMenuItems.map((it, idx) => `<button class="ctx-item ${it.dis ? 'dis' : ''}" data-i="${idx}" ${it.dis ? 'disabled' : ''}>${esc(it.label)}</button>`).join('');
  menu.style.left = Math.min(x, window.innerWidth - 210) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 220) + 'px';
  menu.classList.add('show');
}
function closeTabMenu() { $('#tabMenu').classList.remove('show'); }

/* ----------------------------- per-terminal colors ----------------------------- */
// The tab and the body each get an independent background + text color.
type ColorKey = 'tabBg' | 'tabFg' | 'bodyBg' | 'bodyFg';
const COLOR_PRESETS = ['#f0b429', '#ff7b72', '#7ee787', '#6cb6ff', '#d2a8ff', '#56d4dd', '#f78166', '#3fb950', '#0b0e13', '#d8dee7'];
const COLOR_DEFAULTS: Record<ColorKey, string> = { tabBg: '#161b22', tabFg: '#d8dee7', bodyBg: XTERM_THEME.background, bodyFg: XTERM_THEME.foreground };
let colorPopId = '';
function colorOf(t: Tab, key: ColorKey): string | undefined { return t[key]; }
function renderColorPop(t: Tab) {
  const row = (key: ColorKey, label: string) => {
    const val = colorOf(t, key);
    return `
    <div class="cp-row">
      <div class="cp-label">${label}</div>
      <div class="cp-swatches">
        ${COLOR_PRESETS.map((c) => `<button class="cp-sw${val && val.toLowerCase() === c.toLowerCase() ? ' on' : ''}" data-set="${key}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
        <label class="cp-custom" title="Custom color"><input type="color" data-cust="${key}" value="${val || COLOR_DEFAULTS[key]}"></label>
        <button class="cp-reset" data-reset="${key}" title="Reset to default">⟲</button>
      </div>
    </div>`;
  };
  $('#colorPop').innerHTML =
    `<div class="cp-title">Terminal colors — ${esc(t.name)}</div>` +
    `<div class="cp-group">Tab</div>` + row('tabBg', 'Background') + row('tabFg', 'Text') +
    `<div class="cp-group">Body</div>` + row('bodyBg', 'Background') + row('bodyFg', 'Text') +
    `<div class="cp-foot"><button class="cp-done" id="cpDone">Done</button></div>`;
}
function openColorPop(id: string) {
  closeTabMenu();
  const t = state.tabs.find((x) => x.id === id); if (!t) return;
  colorPopId = id;
  renderColorPop(t);              // build once; picks update in place (see setTabColor)
  $('#colorPop').classList.add('show');
}
function closeColorPop() { colorPopId = ''; $('#colorPop').classList.remove('show'); }
// Update one row's swatch highlight + custom-input value in place — WITHOUT re-rendering
// the popover. (Re-rendering would detach the just-clicked element and make the global
// click-outside handler think the click landed outside, closing the popover on every pick.)
function updateRowUI(key: ColorKey) {
  const t = state.tabs.find((x) => x.id === colorPopId); if (!t) return;
  const val = colorOf(t, key);
  const pop = $('#colorPop');
  pop.querySelectorAll(`.cp-sw[data-set="${key}"]`).forEach((sw) => (sw as HTMLElement).classList.toggle('on', !!val && (sw as HTMLElement).dataset.color!.toLowerCase() === val.toLowerCase()));
  const inp = pop.querySelector(`input[data-cust="${key}"]`) as HTMLInputElement | null;
  if (inp) inp.value = val || COLOR_DEFAULTS[key];
}
// Set (or clear, when color is undefined) one of the four colors, apply it live to the tab
// and body, persist, and refresh only that row. The popover stays open until "Done".
function setTabColor(key: ColorKey, color: string | undefined) {
  const t = state.tabs.find((x) => x.id === colorPopId); if (!t) return;
  t[key] = color;
  applyTermColors(t); renderTabs(); updateRowUI(key); persistWorkspace();
}

/* ----------------------------- workspace persistence (auto-save) ----------------------------- */
let wsT: any, savedFlashT: any;
// Trim persisted history so relay.json stays small: keep the last N blocks and cap each
// block's output. Chat keeps its last N turns.
function slimBlocks(blocks: Block[]): Block[] {
  return blocks.slice(-120).map((b) => ({ ...b, output: b.output.length > 4000 ? '…' + b.output.slice(-4000) : b.output }));
}
function snapshotTabs(): OpenTab[] {
  return state.tabs.map((t) => ({ id: t.id, name: t.name, model: t.model, libId: t.libId, cwd: t.cwd, scrollback: t.ser.serialize({ scrollback: 800 }), tabBg: t.tabBg, tabFg: t.tabFg, bodyBg: t.bodyBg, bodyFg: t.bodyFg, chat: t.chat.slice(-100), blocks: slimBlocks(t.blocks) }));
}
// Persist the open tabs + their scrollback. Coalescing throttle: the first trigger
// schedules a save ~800ms out and any triggers within that window are folded in — so a
// session spent only WATCHING output (no keystrokes) still saves steadily, instead of
// persisting nothing past the opening prompt. `immediate` bypasses it for the final
// flush on window close.
function persistWorkspace(immediate = false) {
  if (!state.settings.autoSave) return;
  const run = () => { wsT = null; relay.setWorkspace({ active: state.active, tabs: snapshotTabs() }); flashSaved(); };
  if (immediate) { if (wsT) clearTimeout(wsT); run(); return; }
  if (wsT) return;              // a save is already scheduled — coalesce into it
  wsT = setTimeout(run, 800);
}
function flashSaved() {
  const el = $('#stAutosave'); el.classList.add('saving'); $('#stAutosaveText').textContent = 'Saved';
  clearTimeout(savedFlashT);
  savedFlashT = setTimeout(() => { el.classList.remove('saving'); $('#stAutosaveText').textContent = 'Auto-save on'; }, 1200);
}
function reflectAutosave() {
  const el = $('#stAutosave');
  el.classList.toggle('off', !state.settings.autoSave);
  $('#stAutosaveText').textContent = state.settings.autoSave ? 'Auto-save on' : 'Auto-save off';
}
async function toggleAutosave() {
  state.settings = await relay.patchSettings({ autoSave: !state.settings.autoSave });
  reflectAutosave();
  if (state.settings.autoSave) { persistWorkspace(); toast('Auto-save enabled — terminals restore on relaunch', true); }
  else toast('Auto-save disabled');
}

/* ----------------------------- library ----------------------------- */
function sortedLibrary(): SavedSession[] {
  const s = state.settings.librarySort;
  if (s === 'custom') return [...state.library]; // manual drag order (stored array order)
  return [...state.library].sort((a, b) =>
    s === 'name' ? a.name.localeCompare(b.name)
      : s === 'model' ? (modelById(a.model).name.localeCompare(modelById(b.model).name) || a.name.localeCompare(b.name))
        : b.lastUsed - a.lastUsed);
}
function renderLibrary() {
  const el = $('#libList');
  if (!state.library.length) { el.innerHTML = '<div class="lib-empty">No saved terminals yet.<br>Open one and press ⤓ Save.</div>'; return; }
  el.innerHTML = sortedLibrary().map((s) => `
    <div class="lib-item" draggable="true" data-open="${s.id}">
      <div class="lib-row"><span class="lib-name" data-libname="${s.id}">${esc(s.name)}</span>
        <span class="lib-actions"><button class="lib-act" data-librename="${s.id}" title="Rename">✎</button><button class="lib-act danger" data-libdel="${s.id}" title="Delete">🗑</button></span></div>
      <div class="lib-meta"><span>${esc(shortCwd(s.cwd))}</span><span>·</span><span style="color:var(--accent)">${esc(modelById(s.model).short)}</span></div>
    </div>`).join('');
}
async function saveActive() {
  const t = activeTab(); if (!t) return toast('No terminal to save');
  // Update the existing Library entry if this terminal was already saved — via its
  // link, or (after a restart, when the link is gone) by matching the stable termId.
  const libId = t.libId || state.library.find((s) => s.termId === t.id)?.id || uid();
  const prev = state.library.find((s) => s.id === libId);
  t.libId = libId;
  const rec: SavedSession = { id: libId, termId: t.id, name: t.name, cwd: t.cwd, model: t.model, scrollback: t.ser.serialize({ scrollback: 800 }), tabBg: t.tabBg, tabFg: t.tabFg, bodyBg: t.bodyBg, bodyFg: t.bodyFg, chat: t.chat.slice(-100), blocks: slimBlocks(t.blocks), createdAt: prev?.createdAt ?? Date.now(), lastUsed: Date.now() };
  state.library = await relay.upsertSession(rec);
  renderLibrary(); persistWorkspace(); toast(prev ? `Updated "${t.name}"` : `Saved "${t.name}"`, true);
}
async function deleteLib(id: string) { state.library = await relay.deleteSession(id); renderLibrary(); toast('Deleted'); }
// When a saved terminal is closed, push its CURRENT blocks/scrollback/chat into its Library
// entry so reopening restores the latest history — not just whatever was there at the last
// manual Save. Updates state.library in memory immediately so an instant reopen sees it too.
function flushTabToLibrary(t: Tab) {
  const libId = t.libId || state.library.find((s) => s.termId === t.id)?.id;
  if (!libId) return; // not a saved terminal — it isn't listed in the Library, so nothing to restore
  const prev = state.library.find((s) => s.id === libId);
  const rec: SavedSession = { id: libId, termId: t.id, name: t.name, cwd: t.cwd, model: t.model, scrollback: t.ser.serialize({ scrollback: 800 }), tabBg: t.tabBg, tabFg: t.tabFg, bodyBg: t.bodyBg, bodyFg: t.bodyFg, chat: t.chat.slice(-100), blocks: slimBlocks(t.blocks), createdAt: prev?.createdAt ?? Date.now(), lastUsed: Date.now() };
  const idx = state.library.findIndex((s) => s.id === libId);
  if (idx >= 0) state.library[idx] = rec; else state.library.push(rec);
  relay.upsertSession(rec).then((lib: SavedSession[]) => { state.library = lib; renderLibrary(); }).catch(() => {});
  renderLibrary();
}

/* ----------------------------- file browser (follows the active terminal) ----------------------------- */
async function renderFiles() {
  const target = state.browsePath || activeTab()?.cwd || state.settings.workspace || '';
  const res = await relay.fsList(target);
  const el = $('#fileList');
  if (res.error) { el.innerHTML = `<div class="lib-empty">${esc(res.error)}</div>`; return; }
  state.browse = res; state.browsePath = res.path;
  $('#filesPath').textContent = res.path || '—'; $('#filesPath').title = res.path;
  el.innerHTML = res.entries.map((e: { name: string; isDir: boolean }) => `
    <div class="file-item" data-fpath="${esc(res.path + '/' + e.name)}" data-dir="${e.isDir}">
      <span class="file-ic">${e.isDir ? '📁' : '📄'}</span><span class="file-name">${esc(e.name)}</span>
    </div>`).join('') || '<div class="lib-empty">(empty folder)</div>';
}
function openSession(s: SavedSession) {
  // If this Library entry is already open in a tab, just focus it — don't duplicate.
  const open = state.tabs.find((t) => (t.libId && t.libId === s.id) || (!!s.termId && t.id === s.termId));
  if (open) { switchTab(open.id); return; }
  newTab({ id: s.termId, name: s.name, model: s.model, cwd: s.cwd, scrollback: s.scrollback, libId: s.id, tabBg: s.tabBg, tabFg: s.tabFg, bodyBg: s.bodyBg, bodyFg: s.bodyFg, chat: s.chat, blocks: s.blocks });
}

/* ----------------------------- model picker ----------------------------- */
function renderModelMenu() {
  const cur = (activeTab()?.model) || state.settings.defaultModel;
  let html = '', lastP = '';
  for (const m of MODELS) {
    if (m.provider !== lastP) { html += `<div class="model-group">${m.provider}</div>`; lastP = m.provider; }
    const hasKey = (state.settings.hasKey as any)[m.provider];
    html += `<button class="model-item ${m.id === cur ? 'active' : ''}" data-model="${m.id}">
      <div class="mi-top"><span class="mi-name">${esc(m.name)}</span>
        ${m.badge ? `<span class="mi-badge">${m.badge}</span>` : ''}
        ${m.id === cur ? '<span class="mi-check">✓</span>' : (!hasKey ? '<span class="mi-nokey">no key</span>' : '')}</div>
      <div class="mi-id">${esc(m.id)}</div><div class="mi-desc">${esc(m.desc)}</div>
      <div class="mi-meta"><span class="mi-chip">${esc(m.ctx)}</span><span class="mi-chip">${esc(m.price)} · Mtok</span></div>
    </button>`;
  }
  $('#modelMenu').innerHTML = html;
}
function openModelMenu(trigger: HTMLElement) {
  renderModelMenu();
  const menu = $('#modelMenu'), r = trigger.getBoundingClientRect(), w = 330;
  menu.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + 'px';
  menu.style.top = r.bottom + 6 + 'px';
  menu.classList.add('show');
}
function closeModelMenu() { $('#modelMenu').classList.remove('show'); }
async function setModel(id: string) {
  const t = activeTab(); if (t) t.model = id;
  state.settings = await relay.patchSettings({ defaultModel: id });
  reflectModel(); renderTabs(); closeModelMenu(); persistWorkspace();
  toast(`${t ? t.name : 'Terminal'} → ${modelById(id).short}`, true);
}
function reflectModel() {
  const m = modelById((activeTab()?.model) || state.settings.defaultModel);
  $('#modelBtnName').textContent = m.short;
  $('#tabModelName').textContent = m.short;
  $('#stAgent').innerHTML = `<span class="dot"></span>agent · ${esc(m.short)}`;
}

/* ----------------------------- theme + sidebar + status ----------------------------- */
function applyTheme() { document.documentElement.setAttribute('data-theme', state.settings.theme); $('#btnTheme').textContent = state.settings.theme === 'dark' ? '☀' : '☾'; }
async function toggleTheme() { state.settings = await relay.patchSettings({ theme: state.settings.theme === 'dark' ? 'light' : 'dark' }); applyTheme(); }
function applySidebar() { $('#main').classList.toggle('collapsed', state.settings.sidebarCollapsed); const t = activeTab(); if (t) setTimeout(() => { t.fit.fit(); relay.ptyResize(t.id, t.term.cols, t.term.rows); }, 210); }
function applyToolbar() { document.querySelector('.titlebar')?.classList.toggle('shown', state.settings.toolbarShown); }
// Size the Library section from the saved fraction of the sidebar height; Files fills the rest.
function applySplit() {
  const sb = document.querySelector('.sidebar') as HTMLElement | null; if (!sb) return;
  const h = sb.clientHeight; const min = 80, max = h - 160; if (max < min) return;
  const frac = state.settings.librarySplit ?? 0.4;
  ($('#viewLibrary') as HTMLElement).style.height = Math.max(min, Math.min(max, Math.round(h * frac))) + 'px';
}
function applySidebarWidth() { ($('#main') as HTMLElement).style.setProperty('--sidebar-w', (state.settings.sidebarWidth || 260) + 'px'); }
async function toggleToolbar() { state.settings = await relay.patchSettings({ toolbarShown: !state.settings.toolbarShown }); applyToolbar(); }
async function toggleSidebar() { state.settings = await relay.patchSettings({ sidebarCollapsed: !state.settings.sidebarCollapsed }); applySidebar(); }
function updateStatus() {
  const t = activeTab();
  $('#stSession').textContent = t ? t.name : '—';
  const cwd = t?.cwd || state.settings.workspace || '';
  $('#stCwd').textContent = shortCwd(cwd);
  $('#wsLabel').textContent = state.settings.workspace || 'No folder open';
  const folder = cwd ? (cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '') : '';
  $('#winCtx').textContent = [folder, t?.name].filter(Boolean).join('  ·  ');
}
function tickClock() { const d = new Date(); $('#stClock').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

/* ----------------------------- agent chat (persisted per terminal) ----------------------------- */
const CHIPS = ['Explain this project', 'Find and fix a bug', 'Add a README', 'Write a test for the current file', 'What does the entry point do?'];
let agentBusy = false;
// The agent conversation belongs to the active terminal, so it saves and restores with it.
function chat(): ChatTurn[] { const t = activeTab(); return t ? t.chat : state.history; }
function renderChat() {
  $('#agentBody').innerHTML = '';
  if (!chat().length) { renderChips(); return; }
  for (const turn of chat()) addMsg(turn.role, turn.content);
}
function renderChips() {
  if (chat().length) return;
  const div = document.createElement('div'); div.className = 'agent-hi';
  div.innerHTML = `Ask me to read or change files in <b>${esc(shortCwd(state.settings.workspace || 'this project'))}</b>. Try:<div class="agent-chips">${CHIPS.map((c) => `<button class="agent-chip">${esc(c)}</button>`).join('')}</div>`;
  $('#agentBody').appendChild(div);
  div.querySelectorAll('.agent-chip').forEach((b) => b.addEventListener('click', () => { ($('#agentInput') as HTMLTextAreaElement).value = b.textContent || ''; sendAgent(); }));
}
function addMsg(role: 'user' | 'assistant', text: string): HTMLElement {
  const div = document.createElement('div'); div.className = `msg ${role}`;
  div.innerHTML = `<div class="who">${role === 'user' ? 'You' : esc(modelById((activeTab()?.model) || state.settings.defaultModel).short)}</div><span class="body"></span>`;
  (div.querySelector('.body') as HTMLElement).textContent = text;
  $('#agentBody').appendChild(div); $('#agentBody').scrollTop = 1e9;
  return div;
}
function addTool(name: string, ok = true, detail = '') {
  const div = document.createElement('div'); div.className = `tool ${ok ? '' : 'err'}`;
  div.innerHTML = `<span class="tname">✦ ${esc(name)}</span> ${esc(detail)}`;
  $('#agentBody').appendChild(div); $('#agentBody').scrollTop = 1e9;
}
async function sendAgent() {
  if (agentBusy) return;
  const input = $('#agentInput') as HTMLTextAreaElement;
  const text = input.value.trim(); if (!text) return;
  input.value = ''; input.style.height = 'auto';
  $('#agentBody').querySelector('.agent-hi')?.remove();
  const model = (activeTab()?.model) || state.settings.defaultModel;
  addMsg('user', text); chat().push({ role: 'user', content: text });
  agentBusy = true;
  let assistantEl: HTMLElement | null = null; let assistantText = '';
  const off = relay.onAgentEvent((e: AgentEvent) => {
    if (e.type === 'text') { assistantText += e.text; if (!assistantEl) assistantEl = addMsg('assistant', ''); (assistantEl.querySelector('.body') as HTMLElement).textContent = assistantText; $('#agentBody').scrollTop = 1e9; }
    else if (e.type === 'tool_start') addTool(e.name, true, typeof e.input === 'object' ? JSON.stringify(e.input).slice(0, 120) : '');
    else if (e.type === 'tool_result') { if (!e.ok) addTool('error', false, e.preview); }
    else if (e.type === 'error') addTool('error', false, e.message);
    else if (e.type === 'done') { if (assistantText) { chat().push({ role: 'assistant', content: assistantText }); persistWorkspace(); } }
  });
  try { await relay.agentSend({ model, history: chat().slice(0, -1), userMessage: text }); }
  finally { off(); agentBusy = false; }
}

/* ----------------------------- command history (blocks) ----------------------------- */
let histFilterFail = false;
let histQuery = '';
// Blocks the user has collapsed (by block id). Kept out of the DOM so it survives the
// Blocks-view re-renders that rebuild innerHTML — otherwise a collapse would flicker back open.
const collapsedBlocks = new Set<string>();
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[=>()][0-9A-Za-z]?/g, '');
}
function fmtDur(ms: number): string { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`; }
// Map an xterm 256-color index to a hex string (16 base + 6×6×6 cube + 24 greys).
function xterm256(n: number): string {
  if (n < 16) return ['#0b0e13', '#ff7b72', '#7ee787', '#f0b429', '#6cb6ff', '#d2a8ff', '#56d4dd', '#d8dee7', '#66717f', '#ff7b72', '#7ee787', '#f0b429', '#6cb6ff', '#d2a8ff', '#56d4dd', '#ffffff'][n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const c = n - 16, r = Math.floor(c / 36), g = Math.floor((c % 36) / 6), b = c % 6;
  const q = (x: number) => (x ? x * 40 + 55 : 0);
  return `rgb(${q(r)},${q(g)},${q(b)})`;
}
// Render command output (raw, with ANSI) to safe HTML — SGR color/bold become styled spans;
// cursor/erase/OSC control sequences are stripped. Used by the Blocks (Warp-style) main view.
function ansiToHtml(raw: string): string {
  const FG: Record<number, string> = { 30: '#66717f', 31: '#ff7b72', 32: '#7ee787', 33: '#f0b429', 34: '#6cb6ff', 35: '#d2a8ff', 36: '#56d4dd', 37: '#d8dee7', 90: '#8b98a6', 91: '#ff7b72', 92: '#7ee787', 93: '#f0b429', 94: '#6cb6ff', 95: '#d2a8ff', 96: '#56d4dd', 97: '#ffffff' };
  const s = raw.replace(/\r(?!\n)/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')       // OSC
    .replace(/\x1b\[[0-9;?]*[@-ln-~]/g, '')                   // CSI except SGR ('m')
    .replace(/\x1b[=>()#][0-9A-Za-z]?/g, '');                 // charset/mode escapes
  const escd = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = ''; const cur: { c?: string; b?: boolean } = {};
  const re = /\x1b\[([0-9;]*)m|([^\x1b]+)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[2] !== undefined) {
      if (cur.c || cur.b) html += `<span style="${cur.c ? `color:${cur.c};` : ''}${cur.b ? 'font-weight:600;' : ''}">${escd(m[2])}</span>`;
      else html += escd(m[2]);
    } else {
      const codes = (m[1] || '0').split(';').map((x) => parseInt(x || '0', 10));
      for (let i = 0; i < codes.length; i++) { const c = codes[i];
        if (c === 0) { cur.c = undefined; cur.b = false; }
        else if (c === 1) cur.b = true;
        else if (c === 22) cur.b = false;
        else if (c === 39) cur.c = undefined;
        else if (FG[c]) cur.c = FG[c];
        else if (c === 38) { if (codes[i + 1] === 5) { cur.c = xterm256(codes[i + 2] || 0); i += 2; } else if (codes[i + 1] === 2) { cur.c = `rgb(${codes[i + 2] || 0},${codes[i + 3] || 0},${codes[i + 4] || 0})`; i += 4; } }
      }
    }
  }
  return html;
}
// Structured command blocks stream in from the shell-integration parser (main process).
relay.onPtyBlock((id: string, ev: { type: 'start' | 'update' | 'end'; block: Block }) => {
  const t = state.tabs.find((x) => x.id === id); if (!t) return;
  // Namespace the parser's per-run ids (b1, b2, …) with a per-tab nonce so a fresh shell's
  // blocks never collide with blocks restored from a previous run of the same terminal.
  const bid = t.bkNonce + ':' + ev.block.id;
  const blk: Block = { ...ev.block, id: bid };
  const i = t.blocks.findIndex((b) => b.id === bid);
  if (i >= 0) t.blocks[i] = { ...blk, pinned: t.blocks[i].pinned };
  else t.blocks.push(blk);
  if (t.blocks.length > 500) t.blocks.splice(0, t.blocks.length - 500);
  // A full-screen app entered alt-screen → drop the Blocks view to the live terminal so
  // vim/top run interactively; when its block ends (app exited), return to the Blocks view.
  if (blk.interactive && !t.liveInteractive) { t.liveInteractive = true; if (t.id === state.active) updateMainView(); }
  if (ev.type === 'end' && t.liveInteractive) { t.liveInteractive = false; if (t.id === state.active) updateMainView(); }
  if (t.id === state.active) refreshBlockViews();
  if (ev.type === 'end') persistWorkspace();
});
function blockHtml(b: Block, color = false): string {
  const badge = b.running ? '<span class="hb-badge run">running…</span>'
    : b.exitCode === 0 ? '<span class="hb-badge ok">✓ 0</span>'
    : b.exitCode != null ? `<span class="hb-badge fail">✗ ${b.exitCode}</span>` : '';
  const dur = b.endedAt && b.startedAt ? fmtDur(b.endedAt - b.startedAt) : '';
  const d = new Date(b.startedAt); const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const cmd = stripAnsi(b.command).replace(/[\r\n]+/g, ' ').trim();
  if (b.interactive) {
    return `<div class="hb interactive" data-bid="${b.id}">
      <div class="hb-head"><span class="hb-p" style="color:var(--c-blue)">◧</span><span class="hb-cmd">${cmd ? esc(cmd) : 'interactive session'}</span><span class="hb-meta">${dur ? `<span>${dur}</span>` : ''}<span>${clock}</span></span>${badge}</div>
      <div class="hb-int">Interactive full-screen session — ran live in the terminal (screen not captured as history).</div>
      <div class="hb-actions"><button data-act="copycmd">Copy cmd</button><button data-act="rerun">Re-run</button><button data-act="pin">${b.pinned ? '★ Pinned' : '☆ Pin'}</button><button data-act="share">Share</button></div>
    </div>`;
  }
  const plain = stripAnsi(b.output).replace(/\r/g, '').trim();
  const out = color ? ansiToHtml(b.output) : esc(plain);
  const failed = b.exitCode != null && b.exitCode !== 0;
  return `<div class="hb${collapsedBlocks.has(b.id) ? ' collapsed' : ''}${b.pinned ? ' pin' : ''}" data-bid="${b.id}">
    <div class="hb-head"><span class="hb-p">❯</span><span class="hb-cmd">${cmd ? esc(cmd) : '<span class="dim">prompt</span>'}</span><span class="hb-meta">${dur ? `<span>${dur}</span>` : ''}<span>${clock}</span></span>${badge}<span class="hb-chev" data-act="collapse" title="Collapse / expand">▾</span></div>
    <div class="hb-out">${plain ? out : '<span class="dim">(no output)</span>'}</div>
    <div class="hb-actions"><button data-act="copycmd">Copy cmd</button><button data-act="copyout">Copy output</button><button data-act="rerun">Re-run</button><button data-act="pin">${b.pinned ? '★ Pinned' : '☆ Pin'}</button><button data-act="share">Share</button>${failed ? '<button data-act="fix" class="fix">Ask agent to fix</button>' : ''}</div>
  </div>`;
}
// Blocks-view (Warp-style transcript) renderer — matches the artifact: a colored
// `user@host ~/path $ command` prompt line, output beneath, subtle left-accent band,
// hover-revealed actions. Output keeps its ANSI colors.
function bvBlockHtml(b: Block): string {
  const cwd = b.cwd || activeTab()?.cwd || '';
  const cmd = cmdRaw(b); // display exactly as typed — newlines preserved (CSS renders them)
  const d = new Date(b.startedAt);
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const dur = b.endedAt && b.startedAt ? fmtDur(b.endedAt - b.startedAt) : '';
  if (b.interactive) {
    return `<div class="bvb int" data-bid="${b.id}" title="ran in ${esc(promptCwd(cwd))}"><div class="bvb-cmd"><span class="bvb-line"><span class="bvb-p">◧</span> <span class="bvb-text">${esc(cmd || 'interactive')}</span></span><span class="bvb-ts">${clock}</span></div><div class="bvb-out"><span class="o-dim">— interactive full-screen session · ran live in the terminal —</span></div></div>`;
  }
  const failed = b.exitCode != null && b.exitCode !== 0;
  const cls = b.running ? 'run' : failed ? 'fail' : 'info';
  const badge = b.running ? '<span class="bvb-badge run">running…</span>' : failed ? `<span class="bvb-badge fail">exit ${b.exitCode}</span>` : '';
  const out = ansiToHtml(b.output);
  return `<div class="bvb ${cls}" data-bid="${b.id}" title="ran in ${esc(promptCwd(cwd))}">
    <div class="bvb-cmd"><span class="bvb-line"><span class="bvb-p">❯</span> <span class="bvb-text">${cmd ? esc(cmd) : ''}</span></span>${badge}<span class="bvb-ts">${dur ? esc(dur) + ' · ' : ''}${clock}</span>
      <span class="bvb-actions"><button data-act="copyout" title="Copy output">copy</button><button data-act="rerun" title="Re-run">re-run</button><button data-act="pin" title="Pin">${b.pinned ? '★' : 'pin'}</button><button data-act="share" title="Export block">share</button>${failed ? '<button data-act="fix" title="Ask the agent to fix">ask agent</button>' : ''}</span>
    </div>${out.trim() ? `<div class="bvb-out">${out}</div>` : ''}</div>`;
}
function realBlock(b: Block): boolean { return !!((b.command && b.command.trim()) || b.output.trim() || b.interactive); }
function renderHistory() {
  const list = $('#histList'); const rail = $('#histRail'); const t = activeTab();
  if (!t) { list.innerHTML = '<div class="hist-empty">No terminal open.</div>'; rail.innerHTML = ''; return; }
  const q = histQuery.trim().toLowerCase();
  let blocks = t.blocks.filter(realBlock);
  if (histFilterFail) blocks = blocks.filter((b) => b.exitCode != null && b.exitCode !== 0);
  if (q) blocks = blocks.filter((b) => (stripAnsi(b.command) + ' ' + stripAnsi(b.output)).toLowerCase().includes(q));
  if (!blocks.length) {
    rail.innerHTML = '';
    list.innerHTML = `<div class="hist-empty">${t.blocks.length ? 'No matching commands.' : 'Run a command to build history.<br><span class="dim">Blocks use shell integration (Settings → Command blocks).</span>'}</div>`;
    return;
  }
  // Outline rail — one entry per block, click to jump to it.
  rail.innerHTML = blocks.map((b) => {
    const dot = b.running ? 'run' : b.interactive ? 'int' : b.exitCode === 0 ? 'ok' : b.exitCode != null ? 'fail' : 'ok';
    const label = stripAnsi(b.command).replace(/[\r\n]+/g, ' ').trim() || (b.interactive ? '(interactive)' : 'prompt');
    return `<div class="hr-item" data-jump="${b.id}" title="${esc(label)}"><span class="hr-dot ${dot}"></span><span class="hr-t">${esc(label)}</span></div>`;
  }).join('');
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
  list.innerHTML = blocks.map((b) => blockHtml(b)).join('');
  if (atBottom && !q) list.scrollTop = list.scrollHeight;
}
function openHistory() { closeAgent(); closeBookmarks(); $('#historyPanel').classList.add('show'); renderHistory(); }
function closeHistory() { $('#historyPanel').classList.remove('show'); }

/* ----------------------------- bookmarks (saved command snippets, grouped) ----------------------------- */
function bookmarks(): Bookmark[] { return state.settings.bookmarks || []; }
function bookmarkGroups(): BookmarkGroup[] { return state.settings.bookmarkGroups || []; }
// The group a bookmark effectively belongs to (undefined if none / group was deleted).
function groupOf(b: Bookmark): string | undefined { return bookmarkGroups().some((g) => g.id === b.groupId) ? b.groupId : undefined; }
const collapsedGroups = new Set<string>(); // collapsed group ids ('' = the Ungrouped section)

async function addBookmark(raw: string) {
  const text = raw.replace(/\s+$/, '').replace(/^\s+/, '');
  if (!text) { toast('Nothing selected'); return; }
  const list = [{ id: uid(), text, createdAt: Date.now() }, ...bookmarks().filter((b) => b.text !== text)].slice(0, 300);
  state.settings = await relay.patchSettings({ bookmarks: list });
  renderBookmarks(); toast('Bookmarked ★', true);
}
async function deleteBookmark(id: string) {
  state.settings = await relay.patchSettings({ bookmarks: bookmarks().filter((b) => b.id !== id) });
  renderBookmarks();
}
// Move a bookmark to `gid` group and reorder it: drop `before`/after `beforeId` (a sibling),
// or append to the group when no sibling target (dropped on empty group area).
async function dropBookmark(id: string, gid: string | undefined, beforeId: string | null, before: boolean) {
  const list = [...bookmarks()];
  const di = list.findIndex((b) => b.id === id); if (di < 0) return;
  const dragged = { ...list[di], groupId: gid };
  list.splice(di, 1);
  if (beforeId && beforeId !== id) {
    let ti = list.findIndex((b) => b.id === beforeId);
    if (ti < 0) ti = list.length; else if (!before) ti += 1;
    list.splice(ti, 0, dragged);
  } else {
    // append after the last item already in the target group
    let at = list.length;
    for (let k = list.length - 1; k >= 0; k--) { if (groupOf(list[k]) === gid) { at = k + 1; break; } }
    list.splice(at, 0, dragged);
  }
  state.settings = await relay.patchSettings({ bookmarks: list });
  renderBookmarks();
}
async function addBookmarkGroup() {
  const g = { id: uid(), name: 'New group' };
  state.settings = await relay.patchSettings({ bookmarkGroups: [...bookmarkGroups(), g] });
  renderBookmarks();
  const nameEl = document.querySelector(`[data-grename="${g.id}"]`) as HTMLElement | null;
  if (nameEl) makeEditable(nameEl, (v) => renameBookmarkGroup(g.id, v));
}
async function renameBookmarkGroup(id: string, v: string) {
  const name = v.trim(); if (!name) { renderBookmarks(); return; }
  state.settings = await relay.patchSettings({ bookmarkGroups: bookmarkGroups().map((g) => g.id === id ? { ...g, name } : g) });
  renderBookmarks();
}
async function deleteBookmarkGroup(id: string) {
  state.settings = await relay.patchSettings({
    bookmarkGroups: bookmarkGroups().filter((g) => g.id !== id),
    bookmarks: bookmarks().map((b) => b.groupId === id ? { ...b, groupId: undefined } : b), // orphans fall back to Ungrouped
  });
  renderBookmarks();
}
function runBookmark(text: string) {
  const t = activeTab(); if (!t) { toast('Open a terminal first'); return; }
  sendCommand(t.id, text); if (!blocksMode(t)) switchTab(t.id);
  closeBookmarks(); toast('Ran bookmark', true);
}
function renderBookmarks() {
  const el = $('#bkmList'); const list = bookmarks(); const groups = bookmarkGroups();
  if (!list.length && !groups.length) { el.innerHTML = '<div class="hist-empty">No bookmarks yet.<br><span class="dim">Highlight a command in a block and click ★ Bookmark. Use ＋ Group to organize them.</span></div>'; return; }
  const itemHtml = (b: Bookmark) => `<div class="bkm-item" data-bid="${b.id}" draggable="true">
    <span class="bkm-grip" title="Drag to reorder or move to a group">⠿</span>
    <div class="bkm-text" data-run="${b.id}">${esc(b.text)}</div>
    <div class="bkm-actions"><button data-bact="run">Run</button><button data-bact="copy">Copy</button><button data-bact="del" title="Delete">✕</button></div>
  </div>`;
  const count = (gid: string | undefined) => list.filter((b) => groupOf(b) === gid).length;
  const sectionItems = (gid: string | undefined) => { const items = list.filter((b) => groupOf(b) === gid); return items.length ? items.map(itemHtml).join('') : '<div class="bkm-gempty">drop bookmarks here</div>'; };
  const col = (gid: string) => collapsedGroups.has(gid) ? ' collapsed' : '';
  let html = '';
  for (const g of groups) {
    html += `<div class="bkm-group${col(g.id)}" data-gid="${g.id}"><div class="bkm-ghead" draggable="true"><span class="bkm-grip" title="Drag to reorder group">⠿</span><button class="bkm-gchev" data-gact="gcollapse" title="Collapse / expand">▾</button><span class="bkm-gname" data-grename="${g.id}">${esc(g.name)}</span><span class="bkm-gcount">${count(g.id)}</span><span class="bkm-gsp"></span><span class="bkm-gactions"><button data-gact="grename" title="Rename group">✎</button><button data-gact="gdel" title="Delete group">🗑</button></span></div><div class="bkm-gitems">${sectionItems(g.id)}</div></div>`;
  }
  html += `<div class="bkm-group${col('')}" data-gid=""><div class="bkm-ghead ung"><button class="bkm-gchev" data-gact="gcollapse" title="Collapse / expand">▾</button><span class="bkm-gname">Ungrouped</span><span class="bkm-gcount">${count(undefined)}</span></div><div class="bkm-gitems">${sectionItems(undefined)}</div></div>`;
  el.innerHTML = html;
}
function openBookmarks() { closeAgent(); closeHistory(); $('#bookmarksPanel').classList.add('show'); renderBookmarks(); }
function closeBookmarks() { $('#bookmarksPanel').classList.remove('show'); }
// Save the current highlighted text (DOM selection in a block, or the xterm selection).
function bookmarkSelection() {
  let text = (window.getSelection()?.toString() || '').trim();
  if (!text) text = (activeTab()?.term.getSelection() || '').trim();
  if (!text) { toast('Highlight a command first'); return; }
  addBookmark(text); hideBkmPop();
}
// Floating "★ Bookmark" pill shown next to a text selection (in a block OR the live terminal).
let pendingBkmText = ''; // captured when the pill shows, so a click can't lose it
function hideBkmPop() { $('#bkmPop').classList.remove('show'); }
function xtermSelection(): string { try { return (activeTab()?.term.getSelection() || '').trim(); } catch { return ''; } }
function showBkmPopAt(cx: number, top: number) {
  const pop = $('#bkmPop'); pop.classList.add('show');
  pop.style.left = Math.min(Math.max(cx - 55, 8), window.innerWidth - 130) + 'px';
  pop.style.top = Math.max(top - 40, 8) + 'px';
}
// Show the pill for the current selection — a DOM selection inside a block/history entry, or the
// live terminal's (xterm) selection. NEVER auto-hides on an empty selection (a TUI like Claude
// Code redraws and clears the terminal selection); dismissal is click-away / Escape / after save.
let lastMouse = { x: 0, y: 0 };
function refreshPill(mx?: number, my?: number) {
  const sel = window.getSelection(); const dom = (sel?.toString() || '').trim();
  const anchor = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode as HTMLElement : sel.anchorNode.parentElement) : null;
  if (dom && dom.length <= 800 && anchor && anchor.closest('#bvScroll, #histList')) {
    pendingBkmText = dom;
    const rect = sel!.getRangeAt(0).getBoundingClientRect();
    showBkmPopAt(rect.left + rect.width / 2, rect.top);
    return;
  }
  const x = xtermSelection();
  if (x && x.length <= 800) { pendingBkmText = x; showBkmPopAt(mx ?? lastMouse.x, my ?? lastMouse.y); }
}

/* --------------------- Blocks (Warp-style) main view --------------------- */
// The live xterm is always mounted underneath; the Blocks view overlays it and becomes the
// primary surface. Full-screen apps (alt-screen) and Classic mode reveal the xterm.
function blocksMode(t: Tab | undefined): boolean { return !!t && state.settings.blocksView && !t.liveInteractive; }
function updateMainView() {
  const t = activeTab(); const on = blocksMode(t);
  $('#blocksView').classList.toggle('show', on);
  $('#btnBlocks').classList.toggle('on', !!state.settings.blocksView);
  $('#btnBlocks').textContent = state.settings.blocksView ? '⊞' : '▭';
  if (on) { renderBlocksView(); setTimeout(() => ($('#bvCmd') as HTMLElement)?.focus(), 0); }
  else if (t) {
    // Reveal the live terminal, then fit AFTER the layout settles and FORCE a resize, so a
    // full-screen app (Claude Code, vim, top) redraws to the exact visible size — otherwise it
    // can keep a stale (too-tall) row count and its bottom line renders under the status bar.
    requestAnimationFrame(() => {
      t.fit.fit();
      if (t.term.cols > 0) { t.lastCols = t.term.cols; t.lastRows = t.term.rows; relay.ptyResize(t.id, t.term.cols, t.term.rows); }
      t.term.focus(); t.term.scrollToBottom();
    });
  }
}
function refreshBlockViews() {
  if ($('#historyPanel').classList.contains('show')) renderHistory();
  if ($('#blocksView').classList.contains('show')) renderBlocksView();
}
let _bvRAF = 0;
function renderBlocksView() { if (_bvRAF) return; _bvRAF = requestAnimationFrame(() => { _bvRAF = 0; renderBlocksViewNow(); }); }
function renderBlocksViewNow() {
  const wrap = $('#bvScroll'); const t = activeTab();
  if (!t) { wrap.innerHTML = '<div class="bv-empty">No terminal open.</div>'; return; }
  ($('#bvPrompt') as HTMLElement).textContent = '❯'; // minimal prompt (folder shown in the status bar / block tooltips)
  const blocks = t.blocks.filter(realBlock);
  const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 80;
  if (!blocks.length) wrap.innerHTML = `<div class="bv-empty">Commands you run appear here as blocks.<br><span class="dim">Type below to run one · ⊞/▭ toggles Classic terminal.</span></div>`;
  else wrap.innerHTML = blocks.map(bvBlockHtml).join('');
  if (atBottom) wrap.scrollTop = wrap.scrollHeight;
}
// Send the composed line to the shell. PSReadLine's Enter handler turns it into a block.
function bvGrow(inp: HTMLTextAreaElement) { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 160) + 'px'; }
function bvSend() {
  const t = activeTab(); if (!t) return;
  const inp = $('#bvCmd') as HTMLTextAreaElement; const cmd = inp.value;
  sendCommand(t.id, cmd);
  if (cmd.trim()) { t.cmdHistory.push(cmd); if (t.cmdHistory.length > 200) t.cmdHistory.shift(); }
  t.histIdx = t.cmdHistory.length;
  inp.value = ''; bvGrow(inp);
}
type ExFmt = 'md' | 'json' | 'txt' | 'html';
function outText(b: Block): string { return b.interactive ? '(interactive session)' : stripAnsi(b.output).replace(/\r/g, '').trimEnd(); }
function cmdText(b: Block): string { return stripAnsi(b.command).replace(/[\r\n]+/g, ' ').trim(); }
// The command exactly as typed — newlines preserved (for display + faithful re-run).
function cmdRaw(b: Block): string { return stripAnsi(b.command).replace(/\r\n?/g, '\n').replace(/\s+$/, ''); }
// Run a command line in a terminal: multi-line goes as a bracketed paste (one command),
// single-line as a plain Enter.
function sendCommand(id: string, raw: string) {
  if (raw.includes('\n')) relay.ptyWrite(id, '\x1b[200~' + raw.replace(/\r\n/g, '\n') + '\x1b[201~\r');
  else relay.ptyWrite(id, raw + '\r');
}
// Serialize a terminal's blocks (+ chat) to Markdown / JSON / plain text / HTML. `blocks`
// is passed in so this covers both whole-session export and single-block "share".
function buildExport(t: Tab, blocks: Block[], fmt: ExFmt): { content: string; ext: string } {
  if (fmt === 'json') {
    return { ext: 'json', content: JSON.stringify({
      name: t.name, cwd: t.cwd, model: t.model,
      blocks: blocks.map((b) => ({ command: cmdText(b), output: outText(b), exitCode: b.exitCode, interactive: !!b.interactive, startedAt: b.startedAt, endedAt: b.endedAt })),
      chat: t.chat,
    }, null, 2) };
  }
  if (fmt === 'txt') {
    const L: string[] = [t.name, `cwd: ${t.cwd || '~'}`, ''];
    for (const b of blocks) { L.push(`$ ${cmdText(b)}${b.exitCode != null ? `   [exit ${b.exitCode}]` : ''}`); const o = outText(b); if (o) L.push(o); L.push(''); }
    if (t.chat.length) { L.push('--- Agent ---', ''); for (const m of t.chat) L.push(`${m.role === 'user' ? 'You' : 'Agent'}: ${m.content}`, ''); }
    return { ext: 'txt', content: L.join('\n') };
  }
  if (fmt === 'html') {
    const h = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let o = `<!doctype html><meta charset=utf8><title>${h(t.name)}</title><style>body{background:#0b0e13;color:#d8dee7;font:13px ui-monospace,Consolas,monospace;padding:24px;max-width:900px;margin:auto}h1{font:600 18px system-ui,sans-serif;color:#f4f7fb}.m{color:#66717f;margin-bottom:16px}.b{border:1px solid #232a33;border-radius:9px;margin:10px 0;overflow:hidden}.c{background:#11161d;padding:9px 12px;color:#e8edf3}.c .p{color:#f0b429}.o{padding:9px 12px;white-space:pre-wrap;color:#b6c0cb}.ok{color:#7ee787}.fail{color:#ff7b72}</style>`;
    o += `<h1>${h(t.name)}</h1><div class=m>${h(t.cwd || '~')} · ${h(modelById(t.model).name)}</div>`;
    for (const b of blocks) { const badge = b.exitCode === 0 ? '<span class=ok>✓ 0</span>' : b.exitCode != null ? `<span class=fail>✗ ${b.exitCode}</span>` : ''; o += `<div class=b><div class=c><span class=p>❯</span> ${h(cmdText(b))} ${badge}</div><div class=o>${h(outText(b))}</div></div>`; }
    if (t.chat.length) { o += '<h1>Agent</h1>'; for (const m of t.chat) o += `<div class=b><div class=c>${m.role === 'user' ? 'You' : 'Agent'}</div><div class=o>${h(m.content)}</div></div>`; }
    return { ext: 'html', content: o };
  }
  const L: string[] = [`# ${t.name}`, '', `Working directory: \`${t.cwd || '~'}\`  ·  Model: ${modelById(t.model).name}`, ''];
  if (blocks.length) { L.push('## Terminal', ''); for (const b of blocks) { const o = outText(b); L.push('```console', '❯ ' + cmdText(b) + (b.exitCode != null ? `   # exit ${b.exitCode}` : '')); if (o) L.push(o); L.push('```', ''); } }
  if (t.chat.length) { L.push('## Agent conversation', ''); for (const m of t.chat) L.push(`**${m.role === 'user' ? 'You' : 'Agent'}:** ${m.content}`, ''); }
  return { ext: 'md', content: L.join('\n') };
}
async function doExport(fmt: ExFmt) {
  const t = activeTab(); if (!t) { toast('No terminal to export'); return; }
  const { content, ext } = buildExport(t, t.blocks.filter(realBlock), fmt);
  const res = await relay.exportSession({ name: t.name, content, ext });
  if (res.ok) toast('Session exported', true); else if (res.error) toast(res.error);
}
async function shareBlock(b: Block) {
  const t = activeTab(); if (!t) return;
  const { content, ext } = buildExport(t, [b], 'md');
  const res = await relay.exportSession({ name: `${t.name}-${cmdText(b).split(' ')[0] || 'block'}`, content, ext });
  if (res.ok) toast('Block exported', true); else if (res.error) toast(res.error);
}
function askAgentFix(b: Block) {
  openAgent();
  const inp = $('#agentInput') as HTMLTextAreaElement;
  inp.value = `This command failed with exit code ${b.exitCode}:\n\n$ ${cmdText(b)}\n\n${stripAnsi(b.output).replace(/\r/g, '').trim().slice(-1500)}\n\nDiagnose the cause and fix it.`;
  sendAgent();
}

/* ----------------------------- Claude Code launcher ----------------------------- */
// Open a terminal in the current project and run the real `claude` CLI. Relay's terminals
// are true shells, so this is actual Claude Code — not a reimplementation.
async function newClaudeTab() {
  const dir = activeTab()?.cwd || state.settings.workspace || '';
  const det = await relay.claudeDetect();
  const t = await newTab({ cwd: dir, name: 'Claude Code', tabBg: '#1c1710', tabFg: '#f0b429' });
  setTimeout(() => {
    if (det.installed) relay.ptyWrite(t.id, 'claude\r');
    else { relay.ptyWrite(t.id, 'npm install -g @anthropic-ai/claude-code'); toast('Claude Code not found — press Enter to install, then run: claude'); }
  }, 650);
}

/* ----------------------------- approval ----------------------------- */
function showApproval(req: ApprovalRequest) {
  $('#apTitle').textContent = req.title;
  const detail = $('#apDetail');
  if (req.diff && req.diff.length) detail.innerHTML = req.diff.map((d) => `<div class="dl ${d.t === '+' ? 'add' : d.t === '-' ? 'del' : 'ctx'}">${esc(d.t + (d.text || ''))}</div>`).join('');
  else detail.textContent = req.detail;
  $('#approval').classList.add('show');
  const done = (ok: boolean) => { relay.approve(req.id, ok); $('#approval').classList.remove('show'); };
  ($('#apAllow') as HTMLElement).onclick = () => done(true);
  ($('#apDeny') as HTMLElement).onclick = () => done(false);
}

/* ----------------------------- command palette ----------------------------- */
interface PalAction { g: string; t: string; run: () => void; }
let palItems: PalAction[] = []; let palSel = 0;
function paletteActions(): PalAction[] {
  const base: PalAction[] = [
    { g: 'Terminal', t: 'New terminal', run: () => newTab() },
    { g: 'Terminal', t: 'Save to Library', run: saveActive },
    { g: 'Terminal', t: 'Rename terminal', run: () => { const el = document.querySelector(`[data-rename="${state.active}"]`) as HTMLElement | null; if (el) makeEditable(el, (v) => renameTab(state.active, v)); } },
    { g: 'Terminal', t: 'Clear terminal', run: clearActive },
    { g: 'Terminal', t: 'Close terminal', run: () => state.active && closeTab(state.active) },
    { g: 'Terminal', t: 'Close other terminals', run: () => state.active && closeOthers(state.active) },
    { g: 'Terminal', t: 'Close terminals to the right', run: () => state.active && closeRight(state.active) },
    { g: 'Terminal', t: 'Close terminals to the left', run: () => state.active && closeLeft(state.active) },
    { g: 'Terminal', t: 'Close all terminals', run: () => closeAll() },
    { g: 'View', t: 'Toggle theme', run: toggleTheme },
    { g: 'View', t: 'Toggle library sidebar', run: toggleSidebar },
    { g: 'View', t: 'Toggle top toolbar', run: toggleToolbar },
    { g: 'View', t: 'Toggle auto-save', run: toggleAutosave },
    { g: 'View', t: 'Ask the agent', run: openAgent },
    { g: 'View', t: 'Command history', run: openHistory },
    { g: 'View', t: 'Bookmarks', run: openBookmarks },
    { g: 'View', t: 'Bookmark highlighted text', run: bookmarkSelection },
    { g: 'View', t: 'Toggle Blocks / Classic terminal', run: toggleBlocksView },
    { g: 'Terminal', t: 'Launch Claude Code', run: newClaudeTab },
    { g: 'App', t: 'Open folder in new terminal…', run: addFolderTab },
    { g: 'App', t: 'Export session (Markdown)', run: () => doExport('md') },
    { g: 'App', t: 'Export session (JSON)', run: () => doExport('json') },
    { g: 'App', t: 'Export session (HTML)', run: () => doExport('html') },
    { g: 'App', t: 'Settings', run: openSettings },
    { g: 'Window', t: 'Minimize window', run: () => relay.winMinimize() },
    { g: 'Window', t: 'Maximize / restore window', run: () => relay.winMaximize() },
    { g: 'Window', t: 'Close window', run: () => relay.winClose() },
  ];
  const models: PalAction[] = MODELS.map((m) => ({ g: 'Model · this terminal', t: `${m.name}${m.id === ((activeTab()?.model) || state.settings.defaultModel) ? '  (current)' : ''}`, run: () => setModel(m.id) }));
  const lib: PalAction[] = state.library.map((s) => ({ g: 'Open from Library', t: `${s.name}  ·  ${modelById(s.model).short}`, run: () => openSession(s) }));
  return base.concat(models, lib);
}
function renderPalette(q: string) {
  const all = paletteActions();
  palItems = q ? all.filter((a) => (a.t + ' ' + a.g).toLowerCase().includes(q.toLowerCase())) : all;
  palSel = 0;
  if (!palItems.length) { $('#palList').innerHTML = '<div class="pal-empty">No matches</div>'; return; }
  let html = '', lastG = '';
  palItems.forEach((a, i) => { if (a.g !== lastG) { html += `<div class="pal-group">${esc(a.g)}</div>`; lastG = a.g; } html += `<div class="pal-item ${i === 0 ? 'sel' : ''}" data-i="${i}">${esc(a.t)}</div>`; });
  $('#palList').innerHTML = html;
}
function openPalette() { renderPalette(''); ($('#palInput') as HTMLInputElement).value = ''; $('#palette').classList.add('show'); $('#scrim').classList.add('show'); setTimeout(() => ($('#palInput') as HTMLElement).focus(), 20); }
function closePalette() { $('#palette').classList.remove('show'); if (!$('#settings').classList.contains('show')) $('#scrim').classList.remove('show'); }
function palMove(d: number) { if (!palItems.length) return; palSel = (palSel + d + palItems.length) % palItems.length; [...document.querySelectorAll('#palList .pal-item')].forEach((el, i) => el.classList.toggle('sel', i === palSel)); (document.querySelector('#palList .pal-item.sel') as HTMLElement)?.scrollIntoView({ block: 'nearest' }); }
function palRun() { const a = palItems[palSel]; if (a) { closePalette(); a.run(); } }

/* ----------------------------- settings ----------------------------- */
function reflectSettings() {
  ($('#setWs') as HTMLInputElement).value = state.settings.workspace || '';
  ($('#autoApprove') as HTMLInputElement).checked = state.settings.autoApprove;
  ($('#shellIntegration') as HTMLInputElement).checked = state.settings.shellIntegration;
  ($('#blocksViewSet') as HTMLInputElement).checked = state.settings.blocksView;
  for (const p of ['anthropic', 'openai', 'google']) {
    const on = (state.settings.hasKey as any)[p];
    const s = $('#state' + p[0].toUpperCase() + p.slice(1));
    s.textContent = on ? 'saved' : 'not set'; s.className = 'state ' + (on ? 'on' : 'off');
  }
  // Anthropic can also authenticate via your Claude Code / ambient login — reflect that.
  relay.claudeAuth().then((a: { relayKey: boolean; ambient: boolean }) => {
    const s = $('#stateAnthropic');
    if (a.relayKey) { s.textContent = 'API key saved'; s.className = 'state on'; }
    else if (a.ambient) { s.textContent = '● using Claude Code login'; s.className = 'state on'; }
    else { s.textContent = 'not set — will try your Claude login'; s.className = 'state off'; }
  }).catch(() => {});
}
function openSettings() { reflectSettings(); $('#settings').classList.add('show'); $('#scrim').classList.add('show'); }
function closeSettings() { $('#settings').classList.remove('show'); if (!$('#palette').classList.contains('show')) $('#scrim').classList.remove('show'); }

/* ----------------------------- rename ----------------------------- */
function renameTab(id: string, v: string) { const t = state.tabs.find((x) => x.id === id); if (t && v) { t.name = v; renderTabs(); persistWorkspace(); } else renderTabs(); }
async function renameLib(id: string, v: string) { const s = state.library.find((x) => x.id === id); if (s && v) { s.name = v; state.library = await relay.upsertSession(s); } renderLibrary(); }

/* ----------------------------- agent open/close ----------------------------- */
function openAgent() { closeHistory(); closeBookmarks(); $('#agentPanel').classList.add('show'); renderChat(); ($('#agentInput') as HTMLElement).focus(); }
function closeAgent() { $('#agentPanel').classList.remove('show'); closeModelMenu(); }

/* ----------------------------- wiring ----------------------------- */
$('#btnNewTab').onclick = () => newTab();
$('#btnAddFolder').onclick = addFolderTab;
$('#btnClaude').onclick = newClaudeTab;
$('#btnHistory').onclick = () => ($('#historyPanel').classList.contains('show') ? closeHistory() : openHistory());
$('#btnHistoryClose').onclick = closeHistory;
$('#btnBookmarks').onclick = () => ($('#bookmarksPanel').classList.contains('show') ? closeBookmarks() : openBookmarks());
$('#btnBookmarksClose').onclick = closeBookmarks;
$('#bkmAdd').onmousedown = (e) => e.preventDefault(); // keep the text selection intact
$('#bkmAdd').onclick = () => { if (pendingBkmText) addBookmark(pendingBkmText); hideBkmPop(); };
// Show the floating "★ Bookmark" pill when text is highlighted in a block/history (DOM selection)
// or the live terminal (xterm — see newTab's onSelectionChange). The deferred mouse-up catches
// terminal selections after xterm has finalized them.
document.addEventListener('selectionchange', () => { if (!$('#bkmPop').contains(document.activeElement)) refreshPill(); });
document.addEventListener('mousemove', (e) => { lastMouse = { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY }; });
document.addEventListener('mouseup', (e) => { const m = e as MouseEvent; setTimeout(() => refreshPill(m.clientX, m.clientY), 0); });
document.addEventListener('mousedown', (e) => { if (!(e.target as HTMLElement).closest('#bkmPop')) hideBkmPop(); });
$('#bkmAddGroup').onclick = addBookmarkGroup;
$('#bkmList').addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const gact = (el.closest('[data-gact]') as HTMLElement | null)?.dataset.gact;
  if (gact) {
    const grp = el.closest('.bkm-group') as HTMLElement | null;
    const gid = grp?.dataset.gid ?? '';
    if (gact === 'gcollapse') { if (collapsedGroups.has(gid)) collapsedGroups.delete(gid); else collapsedGroups.add(gid); grp?.classList.toggle('collapsed'); return; }
    if (!gid) return; // rename/delete need a real (non-Ungrouped) group
    if (gact === 'gdel') deleteBookmarkGroup(gid);
    else if (gact === 'grename') { const n = document.querySelector(`[data-grename="${gid}"]`) as HTMLElement | null; if (n) makeEditable(n, (v) => renameBookmarkGroup(gid, v)); }
    return;
  }
  const item = el.closest('.bkm-item') as HTMLElement | null; if (!item) return;
  const b = bookmarks().find((x) => x.id === item.dataset.bid); if (!b) return;
  const act = (el.closest('[data-bact]') as HTMLElement | null)?.dataset.bact;
  const run = el.closest('[data-run]');
  if (act === 'run' || (run && !act)) runBookmark(b.text);
  else if (act === 'copy') { navigator.clipboard?.writeText(b.text); toast('Copied', true); }
  else if (act === 'del') deleteBookmark(b.id);
});
$('#bkmList').addEventListener('dblclick', (e) => {
  const n = (e.target as HTMLElement).closest('[data-grename]') as HTMLElement | null; if (!n) return;
  makeEditable(n, (v) => renameBookmarkGroup(n.dataset.grename!, v));
});
// Drag-and-drop: reorder bookmarks & move them between groups; reorder groups.
let dragBkm: string | null = null;
let dragGrp: string | null = null;
const clearBkmDrop = () => document.querySelectorAll('#bkmList .drop-top,#bkmList .drop-bottom,#bkmList .drop-into,#bkmList .gdrop-top,#bkmList .gdrop-bottom').forEach((x) => x.classList.remove('drop-top', 'drop-bottom', 'drop-into', 'gdrop-top', 'gdrop-bottom'));
const endBkmDrag = () => { dragBkm = null; dragGrp = null; clearBkmDrop(); document.querySelectorAll('#bkmList .dragging').forEach((x) => x.classList.remove('dragging')); };
$('#bkmList').addEventListener('dragstart', (e) => {
  const t = e.target as HTMLElement;
  const it = t.closest('.bkm-item') as HTMLElement | null;
  const gh = t.closest('.bkm-ghead') as HTMLElement | null;
  if (it && it.getAttribute('draggable') !== 'false') { dragBkm = it.dataset.bid!; it.classList.add('dragging'); (e as DragEvent).dataTransfer!.effectAllowed = 'move'; }
  else if (gh && gh.getAttribute('draggable') !== 'false') { const gid = (gh.closest('.bkm-group') as HTMLElement | null)?.dataset.gid; if (gid) { dragGrp = gid; gh.classList.add('dragging'); (e as DragEvent).dataTransfer!.effectAllowed = 'move'; } }
});
$('#bkmList').addEventListener('dragover', (e) => {
  const ev = e as DragEvent;
  if (dragBkm) {
    ev.preventDefault(); clearBkmDrop();
    const it = (ev.target as HTMLElement).closest('.bkm-item') as HTMLElement | null;
    if (it && it.dataset.bid !== dragBkm) { const r = it.getBoundingClientRect(); it.classList.add(ev.clientY < r.top + r.height / 2 ? 'drop-top' : 'drop-bottom'); }
    else { const grp = (ev.target as HTMLElement).closest('.bkm-group') as HTMLElement | null; if (grp) grp.classList.add('drop-into'); }
  } else if (dragGrp) {
    ev.preventDefault(); clearBkmDrop();
    const grp = (ev.target as HTMLElement).closest('.bkm-group') as HTMLElement | null;
    if (grp && grp.dataset.gid && grp.dataset.gid !== dragGrp) { const r = grp.getBoundingClientRect(); grp.classList.add(ev.clientY < r.top + r.height / 2 ? 'gdrop-top' : 'gdrop-bottom'); }
  }
});
$('#bkmList').addEventListener('drop', async (e) => {
  const ev = e as DragEvent; ev.preventDefault();
  if (dragBkm) {
    const it = (ev.target as HTMLElement).closest('.bkm-item') as HTMLElement | null;
    const grp = (ev.target as HTMLElement).closest('.bkm-group') as HTMLElement | null;
    if (it && it.dataset.bid !== dragBkm) {
      const target = bookmarks().find((b) => b.id === it.dataset.bid!);
      const r = it.getBoundingClientRect();
      await dropBookmark(dragBkm, target?.groupId, it.dataset.bid!, ev.clientY < r.top + r.height / 2);
    } else if (grp) {
      await dropBookmark(dragBkm, grp.dataset.gid || undefined, null, false);
    }
  } else if (dragGrp) {
    const grp = (ev.target as HTMLElement).closest('.bkm-group') as HTMLElement | null;
    if (grp && grp.dataset.gid && grp.dataset.gid !== dragGrp) {
      const r = grp.getBoundingClientRect();
      const gs = [...bookmarkGroups()];
      reorderById(gs, (g) => g.id, dragGrp, grp.dataset.gid!, ev.clientY < r.top + r.height / 2);
      state.settings = await relay.patchSettings({ bookmarkGroups: gs });
      renderBookmarks();
    }
  }
  endBkmDrag();
});
$('#bkmList').addEventListener('dragend', endBkmDrag);
$('#histExport').onclick = (e) => { (e as MouseEvent).stopPropagation(); $('#histExMenu').classList.toggle('show'); };
$('#histExMenu').addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('[data-fmt]') as HTMLElement | null; if (!b) return; $('#histExMenu').classList.remove('show'); doExport(b.dataset.fmt as ExFmt); });
document.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.hist-exwrap')) $('#histExMenu').classList.remove('show'); });
$('#histRail').addEventListener('click', (e) => {
  const it = (e.target as HTMLElement).closest('[data-jump]') as HTMLElement | null; if (!it) return;
  const el = $('#histList').querySelector(`.hb[data-bid="${it.dataset.jump}"]`) as HTMLElement | null;
  if (el) { el.classList.remove('collapsed'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 800); }
});
($('#histSearch') as HTMLInputElement).addEventListener('input', (e) => { histQuery = (e.target as HTMLInputElement).value; renderHistory(); });
$('#histFilter').onclick = () => { histFilterFail = !histFilterFail; $('#histFilter').classList.toggle('on', histFilterFail); renderHistory(); };
function onBlockAreaClick(e: Event) {
  const el = e.target as HTMLElement;
  const card = el.closest('.hb, .bvb') as HTMLElement | null; if (!card) return;
  const t = activeTab(); const b = t?.blocks.find((x) => x.id === card.dataset.bid); if (!t || !b) return;
  const act = (el.closest('[data-act]') as HTMLElement | null)?.dataset.act;
  if (!act) return; // clicking the block body does nothing — only the ▾ arrow collapses (so you can read/select output)
  if (act === 'collapse') { const bid = card.dataset.bid!; if (collapsedBlocks.has(bid)) collapsedBlocks.delete(bid); else collapsedBlocks.add(bid); card.classList.toggle('collapsed'); }
  else if (act === 'copycmd') { navigator.clipboard?.writeText(cmdText(b)); toast('Copied command', true); }
  else if (act === 'copyout') { navigator.clipboard?.writeText(stripAnsi(b.output).replace(/\r/g, '')); toast('Copied output', true); }
  else if (act === 'rerun') { sendCommand(t.id, cmdRaw(b)); if (!blocksMode(t)) switchTab(t.id); toast('Re-ran command', true); }
  else if (act === 'pin') { b.pinned = !b.pinned; refreshBlockViews(); persistWorkspace(); }
  else if (act === 'share') shareBlock(b);
  else if (act === 'fix') askAgentFix(b);
}
$('#histList').addEventListener('click', onBlockAreaClick);
$('#bvScroll').addEventListener('click', onBlockAreaClick);
$('#shellIntegration').addEventListener('change', async (e) => { state.settings = await relay.patchSettings({ shellIntegration: (e.target as HTMLInputElement).checked }); toast('Applies to new terminals'); });
async function toggleBlocksView() { state.settings = await relay.patchSettings({ blocksView: !state.settings.blocksView }); updateMainView(); }
$('#btnBlocks').onclick = toggleBlocksView;
$('#blocksViewSet').addEventListener('change', async (e) => { state.settings = await relay.patchSettings({ blocksView: (e.target as HTMLInputElement).checked }); updateMainView(); });
$('#bvCmd').addEventListener('keydown', (e) => {
  const ev = e as KeyboardEvent; const t = activeTab(); const inp = ev.target as HTMLTextAreaElement;
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); bvSend(); }                    // Enter runs
  else if (ev.key === 'Enter') { requestAnimationFrame(() => bvGrow(inp)); }                     // Shift+Enter: insert a newline, then grow
  else if (ev.key === 'ArrowUp' && !inp.value.includes('\n')) { if (t && t.cmdHistory.length) { ev.preventDefault(); t.histIdx = Math.max(0, t.histIdx - 1); inp.value = t.cmdHistory[t.histIdx] || ''; bvGrow(inp); requestAnimationFrame(() => inp.setSelectionRange(inp.value.length, inp.value.length)); } }
  else if (ev.key === 'ArrowDown' && !inp.value.includes('\n')) { if (t && t.cmdHistory.length) { ev.preventDefault(); t.histIdx = Math.min(t.cmdHistory.length, t.histIdx + 1); inp.value = t.cmdHistory[t.histIdx] || ''; bvGrow(inp); } }
  else if (ev.ctrlKey && ev.key.toLowerCase() === 'c') { if (t) { relay.ptyWrite(t.id, '\x03'); inp.value = ''; bvGrow(inp); } }
  else if (ev.key === 'Tab') ev.preventDefault(); // no shell completion in Blocks mode — use Classic
});
$('#bvCmd').addEventListener('input', (e) => bvGrow(e.target as HTMLTextAreaElement));
$('#btnSave').onclick = saveActive;
$('#btnClear').onclick = clearActive;
$('#btnSidebar').onclick = toggleSidebar;
$('#btnTheme').onclick = toggleTheme;
$('#btnPalette').onclick = openPalette;
$('#btnOpen').onclick = addFolderTab;
$('#stAutosave').onclick = toggleAutosave;
$('#libSort').addEventListener('change', async (e) => { state.settings = await relay.patchSettings({ librarySort: (e.target as HTMLSelectElement).value as any }); renderLibrary(); });

$('#tabs').addEventListener('click', (e) => {
  const c = (e.target as HTMLElement).closest('[data-close]') as HTMLElement | null;
  if (c) { e.stopPropagation(); return closeTab(c.dataset.close!); }
  const t = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null;
  if (t) switchTab(t.dataset.tab!);
});
$('#tabs').addEventListener('dblclick', (e) => {
  const nm = (e.target as HTMLElement).closest('[data-rename]') as HTMLElement | null;
  if (nm) makeEditable(nm, (v) => renameTab(nm.dataset.rename!, v));
});
$('#tabs').addEventListener('contextmenu', (e) => {
  const el = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null; if (!el) return;
  e.preventDefault(); openTabMenu(el.dataset.tab!, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
});
$('#tabMenu').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null;
  if (!b || b.hasAttribute('disabled')) return;
  const it = tabMenuItems[+b.dataset.i!]; closeTabMenu(); it.run();
});
document.addEventListener('click', (e) => { if ($('#tabMenu').classList.contains('show') && !(e.target as HTMLElement).closest('#tabMenu')) closeTabMenu(); });
$('#colorPop').addEventListener('click', (e) => {
  e.stopPropagation(); // keep in-popover clicks from reaching the click-outside handler
  const el = e.target as HTMLElement;
  if (el.closest('#cpDone')) return closeColorPop();
  const sw = el.closest('[data-set]') as HTMLElement | null; if (sw) return setTabColor(sw.dataset.set as ColorKey, sw.dataset.color!);
  const rs = el.closest('[data-reset]') as HTMLElement | null; if (rs) return setTabColor(rs.dataset.reset as ColorKey, undefined);
});
$('#colorPop').addEventListener('input', (e) => { const el = e.target as HTMLInputElement; if (el.dataset.cust) setTabColor(el.dataset.cust as ColorKey, el.value); });
document.addEventListener('click', (e) => { const t = e.target as HTMLElement; if ($('#colorPop').classList.contains('show') && !t.closest('#colorPop') && !t.closest('#tabMenu')) closeColorPop(); });
$('#libList').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const del = t.closest('[data-libdel]') as HTMLElement | null; if (del) { e.stopPropagation(); return deleteLib(del.dataset.libdel!); }
  const rn = t.closest('[data-librename]') as HTMLElement | null; if (rn) { e.stopPropagation(); const nm = document.querySelector(`[data-libname="${rn.dataset.librename}"]`) as HTMLElement | null; if (nm) makeEditable(nm, (v) => renameLib(rn.dataset.librename!, v)); return; }
  const o = t.closest('[data-open]') as HTMLElement | null; if (o && !t.isContentEditable) { const s = state.library.find((x) => x.id === o.dataset.open); if (s) openSession(s); }
});

// custom window controls (macOS keeps its native traffic lights, so hide ours there)
if (relay.platform === 'darwin') document.querySelector('.winbar')?.classList.add('mac');
const MAX_ICON = '<svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7"/></svg>';
const RESTORE_ICON = '<svg viewBox="0 0 10 10"><rect x="1.2" y="2.8" width="6" height="6"/><path d="M3.2 2.8 V1.2 H8.8 V6.8 H7.2"/></svg>';
$('#winMin').onclick = () => relay.winMinimize();
$('#winMax').onclick = () => relay.winMaximize();
$('#winClose').onclick = () => relay.winClose();
relay.onWinState((max: boolean) => { $('#winMax').innerHTML = max ? RESTORE_ICON : MAX_ICON; });

// drag-to-reorder: tabs (horizontal)
let dragTab: string | null = null;
const clearTabDrop = () => document.querySelectorAll('#tabs .drop-left,#tabs .drop-right').forEach((x) => x.classList.remove('drop-left', 'drop-right'));
const endTabDrag = () => { dragTab = null; clearTabDrop(); document.querySelectorAll('#tabs .dragging').forEach((x) => x.classList.remove('dragging')); };
$('#tabs').addEventListener('dragstart', (e) => { const el = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null; if (!el) return; dragTab = el.dataset.tab!; el.classList.add('dragging'); (e as DragEvent).dataTransfer!.effectAllowed = 'move'; });
$('#tabs').addEventListener('dragover', (e) => { if (!dragTab) return; e.preventDefault(); const el = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null; clearTabDrop(); if (el && el.dataset.tab !== dragTab) { const r = el.getBoundingClientRect(); el.classList.add((e as DragEvent).clientX < r.left + r.width / 2 ? 'drop-left' : 'drop-right'); } });
$('#tabs').addEventListener('drop', (e) => { if (!dragTab) return; e.preventDefault(); const el = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null; if (el && el.dataset.tab !== dragTab) { const r = el.getBoundingClientRect(); reorderById(state.tabs, (t) => t.id, dragTab, el.dataset.tab!, (e as DragEvent).clientX < r.left + r.width / 2); renderTabs(); persistWorkspace(); } endTabDrag(); });
$('#tabs').addEventListener('dragend', endTabDrag);

// drag-to-reorder: library (vertical) — switches sort to Custom and persists the order
let dragLib: string | null = null;
const clearLibDrop = () => document.querySelectorAll('#libList .drop-top,#libList .drop-bottom').forEach((x) => x.classList.remove('drop-top', 'drop-bottom'));
const endLibDrag = () => { dragLib = null; clearLibDrop(); document.querySelectorAll('#libList .dragging').forEach((x) => x.classList.remove('dragging')); };
$('#libList').addEventListener('dragstart', (e) => { const el = (e.target as HTMLElement).closest('[data-open]') as HTMLElement | null; if (!el || el.draggable === false) return; dragLib = el.dataset.open!; el.classList.add('dragging'); (e as DragEvent).dataTransfer!.effectAllowed = 'move'; });
$('#libList').addEventListener('dragover', (e) => { if (!dragLib) return; e.preventDefault(); const el = (e.target as HTMLElement).closest('[data-open]') as HTMLElement | null; clearLibDrop(); if (el && el.dataset.open !== dragLib) { const r = el.getBoundingClientRect(); el.classList.add((e as DragEvent).clientY < r.top + r.height / 2 ? 'drop-top' : 'drop-bottom'); } });
$('#libList').addEventListener('drop', async (e) => {
  if (!dragLib) return; e.preventDefault();
  const el = (e.target as HTMLElement).closest('[data-open]') as HTMLElement | null;
  if (el && el.dataset.open !== dragLib) {
    reorderById(state.library, (s) => s.id, dragLib, el.dataset.open!, (e as DragEvent).clientY < r(el).top + r(el).height / 2);
    state.settings = await relay.patchSettings({ librarySort: 'custom' });
    ($('#libSort') as HTMLSelectElement).value = 'custom';
    state.library = await relay.reorderSessions(state.library.map((s) => s.id));
    renderLibrary();
  }
  endLibDrag();
});
$('#libList').addEventListener('dragend', endLibDrag);
function r(el: HTMLElement) { return el.getBoundingClientRect(); }

// resizable sidebar divider (Library ⟷ Files)
$('#sideDivider').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const libEl = $('#viewLibrary'); const divider = $('#sideDivider');
  const startY = (e as MouseEvent).clientY; const startH = libEl.getBoundingClientRect().height;
  divider.classList.add('dragging'); document.body.style.cursor = 'row-resize';
  const move = (ev: MouseEvent) => {
    const sb = (document.querySelector('.sidebar') as HTMLElement).clientHeight;
    const h = Math.max(80, Math.min(sb - 160, startH + (ev.clientY - startY)));
    libEl.style.height = h + 'px';
  };
  const up = async () => {
    document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
    divider.classList.remove('dragging'); document.body.style.cursor = '';
    const sb = (document.querySelector('.sidebar') as HTMLElement).clientHeight;
    state.settings = await relay.patchSettings({ librarySplit: +(libEl.getBoundingClientRect().height / sb).toFixed(3) });
  };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
});
new ResizeObserver(() => applySplit()).observe(document.querySelector('.sidebar') as HTMLElement);

// resizable sidebar ⟷ terminal boundary
$('#mainDivider').addEventListener('mousedown', (e) => {
  if (state.settings.sidebarCollapsed) return;
  e.preventDefault();
  const main = $('#main'); const divider = $('#mainDivider');
  const startX = (e as MouseEvent).clientX; const startW = (document.querySelector('.sidebar') as HTMLElement).getBoundingClientRect().width;
  divider.classList.add('dragging'); document.body.style.cursor = 'col-resize';
  const move = (ev: MouseEvent) => { const w = Math.max(180, Math.min(520, startW + (ev.clientX - startX))); main.style.setProperty('--sidebar-w', w + 'px'); };
  const up = async () => {
    document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
    divider.classList.remove('dragging'); document.body.style.cursor = '';
    const w = (document.querySelector('.sidebar') as HTMLElement).getBoundingClientRect().width;
    state.settings = await relay.patchSettings({ sidebarWidth: Math.round(w) });
  };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
});

// file browser
$('#filesUp').onclick = () => { if (state.browse && state.browse.parent && state.browse.parent !== state.browse.path) { state.browsePath = state.browse.parent; renderFiles(); } };
$('#fileList').addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest('[data-fpath]') as HTMLElement | null; if (!el) return;
  const p = el.dataset.fpath!;
  if (el.dataset.dir === 'true') { state.browsePath = p; renderFiles(); return; }
  const r = await relay.fsOpen(p);
  const name = p.split('/').pop();
  toast(r.method === 'vscode' ? `Opening ${name} in VS Code` : r.method === 'error' ? `Couldn't open ${name}` : `Opening ${name}`, r.method !== 'error');
});

// agent
$('#btnAgent').onclick = openAgent;
$('#stAgent').onclick = openAgent;
$('#btnAgentClose').onclick = closeAgent;
$('#agentSend').onclick = sendAgent;
$('#agentInput').addEventListener('keydown', (e) => { const ev = e as KeyboardEvent; if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendAgent(); } });
$('#agentInput').addEventListener('input', () => { const i = $('#agentInput') as HTMLElement; i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 120) + 'px'; });

// model menu
$('#modelBtn').onclick = (e) => { e.stopPropagation(); $('#modelMenu').classList.contains('show') ? closeModelMenu() : openModelMenu($('#modelBtn')); };
$('#tabModelBtn').onclick = (e) => { e.stopPropagation(); $('#modelMenu').classList.contains('show') ? closeModelMenu() : openModelMenu($('#tabModelBtn')); };
$('#modelMenu').addEventListener('click', (e) => { const it = (e.target as HTMLElement).closest('[data-model]') as HTMLElement | null; if (it) setModel(it.dataset.model!); });

// palette
$('#palInput').addEventListener('input', () => renderPalette(($('#palInput') as HTMLInputElement).value));
$('#palInput').addEventListener('keydown', (e) => { const ev = e as KeyboardEvent; if (ev.key === 'ArrowDown') { ev.preventDefault(); palMove(1); } else if (ev.key === 'ArrowUp') { ev.preventDefault(); palMove(-1); } else if (ev.key === 'Enter') { ev.preventDefault(); palRun(); } else if (ev.key === 'Escape') closePalette(); });
$('#palList').addEventListener('click', (e) => { const it = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null; if (it) { palSel = +it.dataset.i!; palRun(); } });

// settings
$('#btnSettings').onclick = openSettings;
$('#settingsClose').onclick = closeSettings;
$('#cfOk').onclick = () => closeConfirm(true);
$('#cfCancel').onclick = () => closeConfirm(false);
$('#scrim').onclick = () => { closeConfirm(false); closeSettings(); closePalette(); };
$('#setWsBtn').onclick = async () => { state.settings = await relay.openWorkspace(); updateStatus(); reflectSettings(); };
$('#autoApprove').addEventListener('change', async (e) => { state.settings = await relay.patchSettings({ autoApprove: (e.target as HTMLInputElement).checked }); });
document.querySelectorAll('.set[data-key]').forEach((b) => b.addEventListener('click', async () => {
  const p = (b as HTMLElement).dataset.key!;
  const inp = $('#key' + p[0].toUpperCase() + p.slice(1)) as HTMLInputElement;
  if (!inp.value) return;
  state.settings = await relay.setKey(p, inp.value); inp.value = ''; reflectSettings(); toast(`Saved ${p} key`, true);
}));

// global
document.addEventListener('click', (e) => { const t = e.target as HTMLElement; if ($('#modelMenu').classList.contains('show') && !t.closest('#modelMenu') && !t.closest('#modelBtn') && !t.closest('#tabModelBtn')) closeModelMenu(); });
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#bookmarksPanel').classList.contains('show') ? closeBookmarks() : openBookmarks(); }
  else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#palette').classList.contains('show') ? closePalette() : openPalette(); }
  else if (mod && !e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); bookmarkSelection(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); addFolderTab(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); newClaudeTab(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'h') { e.preventDefault(); $('#historyPanel').classList.contains('show') ? closeHistory() : openHistory(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleBlocksView(); }
  else if (mod && e.key.toLowerCase() === 't') { e.preventDefault(); newTab(); }
  else if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); $('#agentPanel').classList.contains('show') ? closeAgent() : openAgent(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveActive(); }
  else if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); clearActive(); }
  else if (mod && e.key.toLowerCase() === 'w') { e.preventDefault(); state.active && closeTab(state.active); }
  else if (e.key === 'Escape') { closeConfirm(false); closeModelMenu(); closePalette(); closeSettings(); closeTabMenu(); closeColorPop(); closeHistory(); closeBookmarks(); hideBkmPop(); }
});

relay.onPtyData((id: string, data: string) => { state.tabs.find((t) => t.id === id)?.term.write(data); persistWorkspace(); });
// Final flush on close — synchronous so the latest scrollback reaches disk before teardown.
// Wrapped so a failed flush can never throw mid-unload (which would abort a clean close).
window.addEventListener('beforeunload', () => {
  try { if (state.settings.autoSave) relay.flushWorkspace({ active: state.active, tabs: snapshotTabs() }); } catch { /* ignore */ }
});
relay.onPtyExit((id: string) => { state.tabs.find((x) => x.id === id)?.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n'); });
relay.onApproval((req: ApprovalRequest) => showApproval(req));
let _roT: any;
new ResizeObserver(() => { clearTimeout(_roT); _roT = setTimeout(() => { const t = activeTab(); if (t) applyResize(t); }, 80); }).observe($('#termHost'));

/* ----------------------------- boot ----------------------------- */
(async function boot() {
  state.settings = await relay.getSettings();
  state.library = await relay.listSessions();
  ($('#libSort') as HTMLSelectElement).value = state.settings.librarySort || 'recent';
  applyTheme(); applySidebarWidth(); applySidebar(); applyToolbar(); applySplit(); reflectAutosave(); renderLibrary(); updateStatus(); reflectModel(); reflectSettings();
  ($('#storeText') as HTMLElement).textContent = 'Saved on this machine';
  tickClock(); setInterval(tickClock, 20000);

  const ws = await relay.getWorkspace();
  if (state.settings.autoSave && ws.tabs.length) {
    // Restore each saved tab. Create the ACTIVE one activated so it's fitted to its real
    // size BEFORE its shell spawns — a post-spawn resize makes ConPTY repaint (and clear)
    // the screen on Windows, wiping the just-restored history.
    const activeId = ws.tabs.some((t: OpenTab) => t.id === ws.active) ? ws.active : ws.tabs[0].id;
    for (const t of ws.tabs) await newTab(t, t.id === activeId);
  } else if (state.settings.workspace) {
    newTab();
  } else {
    $('#termEmpty').innerHTML = 'Open a project folder to start.<br>Press <b>Ctrl/⌘ K</b> → “Open folder”.';
  }
  renderFiles(); // populate the Files section even if no terminal is active yet
  updateMainView(); // reflect Blocks/Classic choice (and the toggle button) on first paint
})();
