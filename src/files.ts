// Files sidebar — browse the active terminal's folder, click to navigate into a directory or open a
// file in the editor. The only privileged operations (listing a directory, opening a file) are the
// preload fs bridge, injected once via initFiles so this module never touches relay/window directly.

import { $, esc, svgIcon } from './dom';
import { state, activeTab } from './state';
import { toast } from './ui';

interface FsEntry { name: string; isDir: boolean }
interface FsResult { path: string; parent: string; entries: FsEntry[]; error?: string; truncated?: boolean }
type FsList = (path: string) => Promise<FsResult>;
type FsOpen = (path: string) => Promise<{ method: string; editor?: string }>;
type OpenInApp = (path: string) => void;

let fsList: FsList = async () => ({ path: '', parent: '', entries: [] });
let fsOpen: FsOpen = async () => ({ method: 'error' });
let openInApp: OpenInApp | undefined;

// Render the current folder into the Files sidebar. Target follows the active terminal's cwd
// (or the browsed path, or the project folder). Exported so the renderer can refresh on tab switch.
export async function renderFiles(): Promise<void> {
  const target = state.browsePath || activeTab()?.cwd || state.settings.workspace || '';
  const res = await fsList(target);
  const el = $('#fileList');
  if (res.error) { el.innerHTML = `<div class="lib-empty">${esc(res.error)}</div>`; return; }
  state.browse = res; state.browsePath = res.path;
  $('#filesPath').textContent = res.path || '—'; $('#filesPath').title = res.path;
  const rows = res.entries.map((e) => `
    <div class="file-item" data-fpath="${esc(res.path + '/' + e.name)}" data-dir="${e.isDir}">
      <span class="file-ic ${e.isDir ? 'dir' : ''}">${svgIcon(e.isDir ? 'i-folder' : 'i-file', 15)}</span><span class="file-name">${esc(e.name)}</span>
    </div>`).join('');
  const note = res.truncated ? `<div class="lib-empty">Showing first ${res.entries.length.toLocaleString()} items — folder is larger.</div>` : '';
  el.innerHTML = (rows || '<div class="lib-empty">(empty folder)</div>') + note;
}

// Wire the Files sidebar (parent-folder button + click-to-navigate/open) and supply the fs bridge.
// Call once, after the template is in the DOM.
export function initFiles(deps: { fsList: FsList; fsOpen: FsOpen; openInApp?: OpenInApp }): void {
  fsList = deps.fsList; fsOpen = deps.fsOpen; openInApp = deps.openInApp;
  $('#filesUp').onclick = () => { if (state.browse && state.browse.parent && state.browse.parent !== state.browse.path) { state.browsePath = state.browse.parent; renderFiles(); } };
  $('#fileList').addEventListener('click', async (e) => {
    const el = (e.target as HTMLElement).closest('[data-fpath]') as HTMLElement | null; if (!el) return;
    const p = el.dataset.fpath!;
    if (el.dataset.dir === 'true') { state.browsePath = p; renderFiles(); return; }
    // When the file-open editor is "System default", open it INSIDE Slayer T (a new file-viewer tab) rather than
    // handing it to the OS. Any specific external editor (VS Code, …) still launches externally, unchanged.
    if (openInApp && state.settings.fileEditor === 'system') { openInApp(p); return; }
    const r = await fsOpen(p);
    const name = p.split('/').pop();
    toast(r.method === 'editor' ? `Opening ${name} in ${r.editor || 'your editor'}` : r.method === 'error' ? `Couldn't open ${name}` : `Opening ${name}`, r.method !== 'error');
  });
}
