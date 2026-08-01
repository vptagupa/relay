// Workspace blueprints — reusable "Templates" (Phase 4.1) with typed [params] (Phase 4.2).
// Save the active workspace as a template, then spawn fresh workspaces from it; a template's terminals
// can carry a startup command with [tokens] that are prompted for on spawn, substituted, and run.
//
// This module OWNS the blueprint list + the pending-startup buffer, and wires the Templates menu (#tplMenu)
// plus the two dialogs. It stays out of the tab engine: everything it needs from the workspace core /
// renderer (switching, registering a def, the active def, sendCommand, confirm, …) is INJECTED via
// initBlueprints — so renderer.ts depends on this module, never the reverse.

import { state } from './state';
import { $, esc, uid } from './dom';
import { toast } from './ui';
import type { WorkspaceBlueprint, BlueprintTab, WorkspaceDef, Workspace, OpenTab } from './shared/types';

const relay = (window as any).relay;

// --- injected dependencies: the seam to the workspace core / renderer ---
export interface BlueprintDeps {
  switchWorkspace: (id: string) => Promise<void>;
  addWorkspaceDef: (def: WorkspaceDef) => void;      // append a freshly-spawned workspace to the def list
  uniqueWsName: (base: string) => string;
  nextWsColor: () => string;
  activeWorkspaceDef: () => WorkspaceDef | undefined;
  sendCommand: (id: string, raw: string) => void;
  confirmDialog: (title: string, detail: string, okLabel?: string) => Promise<boolean>;
  shortCwd: (c: string) => string;
  isBooting: () => boolean;                          // a switch/boot is in flight — don't spawn/capture mid-rebuild
}
let deps: BlueprintDeps;

// --- module state ---
let blueprints: WorkspaceBlueprint[] = [];
// Startup commands to run ONCE per spawned terminal, on its first shell-integration prompt (the 'cwd'
// event) with a timeout fallback if integration is off. Never stored on the tab — a pure one-shot.
const pendingStartup = new Map<string, string>();

// A startup-command token: [name]. Fresh regex each call (avoids /g lastIndex state bugs).
const paramRe = () => /\[([A-Za-z0-9_.-]+)\]/g;
function scanParams(bp: WorkspaceBlueprint): string[] {
  const set = new Set<string>();
  for (const t of bp.tabs) { const re = paramRe(); let m; while ((m = re.exec(t.command || ''))) set.add(m[1]); }
  return [...set];
}
const subst = (cmd: string, values: Record<string, string>): string => cmd.replace(paramRe(), (_m, n) => values[n] ?? `[${n}]`);

function saveBlueprints(): void { relay.saveBlueprints(blueprints); }
function uniqueBlueprintName(base: string): string {
  const names = new Set(blueprints.map((b) => b.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) { const n = `${base} ${i}`; if (!names.has(n)) return n; }
}

// Capture the ACTIVE workspace (folder, theme, colour, split layout, terminals) as a reusable template.
export function saveAsTemplate(): void {
  if (deps.isBooting()) return;
  const def = deps.activeWorkspaceDef(); if (!def) return;
  const tabs: BlueprintTab[] = state.tabs.map((t) => ({ name: t.name, cwd: t.cwd, group: t.group }));
  const bp: WorkspaceBlueprint = {
    id: 'bp_' + uid(), name: uniqueBlueprintName(def.name),
    root: def.root, themeId: def.themeId, color: def.color,
    tabs, layout: state.layout, createdAt: Date.now(),
  };
  blueprints.push(bp); saveBlueprints();
  toast(`Saved template “${bp.name}”`, true);
}

function runStartup(id: string): void {
  const cmd = pendingStartup.get(id); if (cmd === undefined) return;
  pendingStartup.delete(id);
  if (state.tabs.some((t) => t.id === id)) deps.sendCommand(id, cmd);
}
// Called by the renderer's pty 'cwd' handler on each terminal's first prompt (shell ready).
export function runStartupIfPending(id: string): void { if (pendingStartup.has(id)) runStartup(id); }

// Build a fresh tab snapshot from a blueprint (new ids; terminals in their cwds or the workspace root;
// visible tab per group = first in that group) plus the [id, substituted-command] pairs to run on spawn.
function buildFromBlueprint(bp: WorkspaceBlueprint, values: Record<string, string>): { ws: Workspace; cmds: Array<[string, string]> } {
  const cmds: Array<[string, string]> = [];
  const tabs: OpenTab[] = bp.tabs.map((bt) => {
    const id = uid(); const cmd = (bt.command || '').trim();
    if (cmd) cmds.push([id, subst(cmd, values)]);
    return { id, name: bt.name || 'terminal', model: state.settings.defaultModel, cwd: bt.cwd || bp.root || '', group: typeof bt.group === 'number' ? bt.group : 0, bkNonce: uid() };
  });
  const gv: string[] = ['', '', '', ''];
  for (const t of tabs) { const g = t.group ?? 0; if (g >= 0 && g < gv.length && !gv[g]) gv[g] = t.id; }
  return { ws: { active: tabs[0]?.id ?? '', tabs, gv, focus: 0, layout: bp.layout }, cmds };
}
// Spawn a new workspace from a template + param values, switch to it, and run each terminal's command.
async function spawnBlueprint(bp: WorkspaceBlueprint, values: Record<string, string>): Promise<void> {
  if (deps.isBooting()) return;
  const nid = 'ws_' + uid();
  const def: WorkspaceDef = { id: nid, name: deps.uniqueWsName(bp.name), color: bp.color || deps.nextWsColor(), root: bp.root, themeId: bp.themeId, trusted: false, createdAt: Date.now(), lastOpenedAt: Date.now() };
  const built = buildFromBlueprint(bp, values);
  relay.saveWorkspaceSnapshot(nid, built.ws); // persist BEFORE switch reads it back
  for (const [tid, cmd] of built.cmds) pendingStartup.set(tid, cmd);
  deps.addWorkspaceDef(def);
  await deps.switchWorkspace(nid); // adopts root/theme, rebuilds the terminals; commands fire on first prompt
  if (built.cmds.length) { const ids = built.cmds.map((c) => c[0]); setTimeout(() => ids.forEach(runStartup), 2200); } // fallback if integration is off
  toast(`New workspace from “${bp.name}”`, true);
}
// Spawn from a template: prompt for its [params] first (if any), else spawn straight away.
export function newFromBlueprint(id: string): void {
  if (deps.isBooting()) return;
  const bp = blueprints.find((b) => b.id === id); if (!bp) return;
  const params = scanParams(bp);
  if (params.length) openParamPrompt(bp, params); else void spawnBlueprint(bp, {});
}
async function deleteBlueprint(id: string): Promise<void> {
  const bp = blueprints.find((b) => b.id === id); if (!bp) return;
  closeTplMenu();
  if (!(await deps.confirmDialog('Delete template?', `“${bp.name}” will be removed — this can’t be undone.`, 'Delete'))) return;
  blueprints = blueprints.filter((b) => b.id !== id); saveBlueprints(); renderTplMenu();
  toast(`Deleted “${bp.name}”`);
}

// A self-contained modal overlay (own scrim; Escape or scrim-click closes). Themed via the app's CSS vars.
function modal(html: string): { root: HTMLElement; close: () => void } {
  const root = document.createElement('div'); root.className = 'tpl-modal';
  root.innerHTML = `<div class="tpl-sc"></div>${html}`;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
  document.body.appendChild(root);
  document.addEventListener('keydown', onKey);
  root.querySelector('.tpl-sc')?.addEventListener('click', close);
  return { root, close };
}
// Screen 1 — edit a template's name + per-terminal startup commands; live-collect its [params].
function openTemplateEditor(id: string): void {
  const bp = blueprints.find((b) => b.id === id); if (!bp) return;
  closeTplMenu();
  const rows = bp.tabs.length
    ? bp.tabs.map((t, i) => `<div class="te-row"><div class="th"><span class="ic">›_</span>&nbsp;${esc(t.name || 'terminal')}<span class="g">pane ${(t.group ?? 0) + 1}</span></div><textarea class="te-cmd" data-i="${i}" rows="1" spellcheck="false" placeholder="startup command — optional · use [name] for a prompt">${esc(t.command || '')}</textarea></div>`).join('')
    : '<div class="te-mut" style="padding:6px 2px">This template has no terminals.</div>';
  const { root, close } = modal(`<div class="tpl-card">
      <div class="hd"><span class="dot" style="background:${esc(bp.color)}"></span><span class="t">Edit template<small>${esc(bp.root ? deps.shortCwd(bp.root) : 'no folder')} · ${bp.tabs.length} terminal${bp.tabs.length === 1 ? '' : 's'}</small></span></div>
      <div class="bd"><input class="te-name" value="${esc(bp.name)}" placeholder="Template name" spellcheck="false" />${rows}<div class="te-params"><span class="lab">Parameters</span><span class="te-plist"></span></div></div>
      <div class="ft"><span class="hint">Wrap a variable in <code>[name]</code> to make it a prompt</span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-ok>Done</button></span></div>
    </div>`);
  const plist = root.querySelector('.te-plist') as HTMLElement;
  const nameEl = root.querySelector('.te-name') as HTMLInputElement;
  const areas = [...root.querySelectorAll('.te-cmd')] as HTMLTextAreaElement[];
  const refresh = () => {
    const set = new Set<string>();
    for (const ta of areas) { const re = paramRe(); let m; while ((m = re.exec(ta.value))) set.add(m[1]); ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
    plist.innerHTML = set.size ? [...set].map((p) => `<span class="pchip">${esc(p)}</span>`).join('') : '<span class="te-mut">none — plain commands</span>';
  };
  areas.forEach((ta) => ta.addEventListener('input', refresh)); refresh();
  root.querySelector('[data-x]')?.addEventListener('click', close);
  root.querySelector('[data-ok]')?.addEventListener('click', () => {
    const nm = nameEl.value.trim(); if (nm) bp.name = nm;
    areas.forEach((ta) => { const i = +ta.dataset.i!; if (bp.tabs[i]) bp.tabs[i].command = ta.value.trim() || undefined; });
    saveBlueprints(); renderTplMenu(); close(); toast(`Saved “${bp.name}”`, true);
  });
}
// Screen 2 — fill each [param] once, with a live preview of the resolved commands, then spawn.
function openParamPrompt(bp: WorkspaceBlueprint, params: string[]): void {
  closeTplMenu();
  const flds = params.map((p) => `<div class="pp-fld"><label>${esc(p)}</label><input class="pp-inp" data-p="${esc(p)}" placeholder="[${esc(p)}]" spellcheck="false" /></div>`).join('');
  const { root, close } = modal(`<div class="tpl-card">
      <div class="hd"><span class="dot" style="background:${esc(bp.color)}"></span><span class="t">New workspace from “${esc(bp.name)}”<small>${params.length} blank${params.length === 1 ? '' : 's'} to fill</small></span></div>
      <div class="bd">${flds}<div class="pp-prev"><div class="pl">Commands to run</div><div class="pp-list"></div></div></div>
      <div class="ft"><span class="hint"></span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-ok>Create workspace</button></span></div>
    </div>`);
  const inps = [...root.querySelectorAll('.pp-inp')] as HTMLInputElement[];
  const list = root.querySelector('.pp-list') as HTMLElement;
  const values = () => Object.fromEntries(inps.map((i) => [i.dataset.p!, i.value]));
  const refresh = () => {
    const v = values();
    const cmds = bp.tabs.filter((t) => (t.command || '').trim());
    list.innerHTML = cmds.length
      ? cmds.map((t) => `<div class="pp-cmd"><span class="who">${esc(t.name || 'terminal')} ›</span> ${esc(t.command!).replace(paramRe(), (_m, n) => v[n] ? `<span class="fill">${esc(v[n])}</span>` : `<span class="tok">[${esc(n)}]</span>`)}</div>`).join('')
      : '<div class="pp-cmd te-mut">no commands — just opens the folders</div>';
  };
  const okBtn = root.querySelector('[data-ok]') as HTMLButtonElement;
  const filled = () => inps.every((i) => i.value.trim() !== ''); // every [param] must be filled — a blank would break the command
  const sync = () => { refresh(); okBtn.disabled = !filled(); };
  inps.forEach((i) => i.addEventListener('input', sync)); sync();
  setTimeout(() => inps[0]?.focus(), 30);
  const go = () => { if (!filled()) return; const v = values(); close(); void spawnBlueprint(bp, v); };
  okBtn.addEventListener('click', go);
  root.querySelector('[data-x]')?.addEventListener('click', close);
  inps.forEach((i) => i.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return; e.preventDefault();
    if (filled()) go(); else (inps.find((x) => !x.value.trim()) ?? inps[0]).focus(); // Enter → next empty field, else submit
  }));
}
function renderTplMenu(): void {
  const rows = blueprints.length
    ? blueprints.map((b) => {
        const ps = scanParams(b);
        const sub = `${b.root ? deps.shortCwd(b.root) : 'no folder'} · ${b.tabs.length} tab${b.tabs.length === 1 ? '' : 's'}${ps.length ? ` · ⚡ ${ps.join(', ')}` : ''}`;
        return `<div class="ws-item" data-tpl="${b.id}" title="New workspace from this template">
        <span class="ws-dot" style="background:${esc(b.color)}"></span>
        <span class="ws-col"><span class="ws-nm">${esc(b.name)}</span><span class="ws-pth">${esc(sub)}</span></span>
        <span class="ws-acts"><button data-tpledit="${b.id}" title="Edit commands &amp; params">✎</button><button data-tpldel="${b.id}" title="Delete">✕</button></span>
      </div>`;
      }).join('')
    : '<div class="ws-empty">No templates yet.<br>Set up a workspace, then “Save current as template”.</div>';
  $('#tplMenu').innerHTML = rows + `<div class="ws-sep"></div><div class="ws-act" data-tplsave><span class="g">＋</span> Save current as template</div>`;
}
export function openTplMenu(): void {
  renderTplMenu();
  const r = $('#wsChip').getBoundingClientRect(); const m = $('#tplMenu');
  m.style.left = r.left + 'px'; m.style.top = (r.bottom + 6) + 'px'; m.classList.add('show');
}
function closeTplMenu(): void { $('#tplMenu').classList.remove('show'); }

// Find a template by name (for slayert://template/<name> deeplinks).
export function findBlueprint(name: string): WorkspaceBlueprint | undefined { return blueprints.find((b) => b.name === name); }
// Load persisted templates (called on boot).
export async function loadBlueprints(): Promise<void> { blueprints = await relay.getBlueprints(); }

// Wire dependencies + the Templates menu (#tplMenu) events. Call once, after #tplMenu exists.
export function initBlueprints(d: BlueprintDeps): void {
  deps = d;
  $('#tplMenu').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const ed = t.closest('[data-tpledit]') as HTMLElement | null; if (ed) { openTemplateEditor(ed.dataset.tpledit!); return; }
    const del = t.closest('[data-tpldel]') as HTMLElement | null; if (del) { void deleteBlueprint(del.dataset.tpldel!); return; }
    if (t.closest('[data-tplsave]')) { closeTplMenu(); saveAsTemplate(); return; }
    const it = t.closest('[data-tpl]') as HTMLElement | null;
    if (it) { closeTplMenu(); newFromBlueprint(it.dataset.tpl!); }
  });
  document.addEventListener('mousedown', (e) => { if (!(e.target as HTMLElement).closest('#tplMenu')) closeTplMenu(); });
}
