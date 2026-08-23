// Integrations UI — the Settings "Integrations" panel (connect/configure) + the "Sync" sidebar rail (browse &
// edit synced tasks). Entirely DATA-DRIVEN by the provider metadata from relay.pmProviders(): the config form
// renders from `configFields`, the connect button branches on `authKind`, the rail's inline editors render from
// `capabilities.editFields`, and the container noun comes from `containerLabel`. Adding a provider changes
// nothing here. The renderer only ever handles config values + task data — never a token or client secret.

import { $, esc } from './dom';
import { toast, addSearch } from './ui';
import { state } from './state';
import { AGENTS } from './agents-list';
import { assignPmTask, pmRunStatusOf, PM_RUN_LABEL, onPmRunChip, validateBrief, initPmPipeline, pmFiledOf } from './pm-pipeline';
import { TAG_DEFS, tagNote, depsNote, LABEL_NAME } from './tasks';   // reuse the exact task-type set + brief guidance + .deps/ note + label names a local task uses
import { repoDepsFor } from './repo-deps';   // a repo's default dependency template (same source the local Validate dialog defaults from)
import type { PmProviderMeta, PmConfig, PmTask, PmProject, EditField } from './pm/types';

const relay = (window as any).relay;

export interface PmDeps {
  activeWsId: () => string;
  confirm: (title: string, detail: string, okLabel: string) => Promise<boolean>;
  openAgentTab: (o: { cwd: string; name: string; runCmd?: string; dbCredId?: string }) => Promise<string>; // for the build pipeline (opens an agent tab in the worktree)
  onAgentTabClosed: (cb: (tabId: string) => void) => void;                                                  // free a run's slot when its terminal closes
}
let deps: PmDeps;
let railTasks: PmTask[] = [];              // current project's tasks in memory → a run-status refresh re-renders without re-fetching

let metas: PmProviderMeta[] = [];
let settingsProvider = '';                 // provider selected in the Settings panel
let connecting = false;                    // an OAuth sign-in is in flight
// Rail state
const PAGE = 25;                            // task page size (Echo tasks cap at 100/req; 25 keeps the rail snappy)
let railProvider = '';
let railProjects: PmProject[] = [];
let railProjectId = '';                     // the project the rail is currently showing (pager reloads it)
let railOffset = 0;                         // pagination offset into the current project's tasks
let filterState: Record<string, string> = {};   // active filter values (reset when the provider changes)
const refCache: Record<string, string[]> = {};   // `${ws}:${provider}:${refName}` → option titles. ws-scoped: statuses/priorities are per-org, so a different workspace/connection must not reuse them.

const ws = (): string => deps.activeWsId();
// Whether the user may filter the rail by assignee for this provider (Settings → Integrations). OFF (default) hides
// the assignee filter and locks the rail to the authenticated user's own tasks; ON lists everyone's and shows it.
const assigneeFilterOn = (provider: string): boolean => !!state.settings.pmAssigneeFilterByProvider?.[provider];
const metaOf = (id: string): PmProviderMeta | undefined => metas.find((m) => m.id === id);

async function loadMetas(): Promise<void> {
  if (metas.length) return;
  metas = (await relay.pmProviders().catch(() => [])) || [];
}

/* ============================ Settings → Integrations ============================ */

export async function refreshPmSettings(): Promise<void> {
  const sel = $('#pmProvider') as HTMLSelectElement | null; if (!sel) return;
  await loadMetas();
  if (!metas.length) { sel.innerHTML = '<option value="">No providers</option>'; return; }
  if (!settingsProvider || !metaOf(settingsProvider)) settingsProvider = metas[0].id;
  sel.innerHTML = metas.map((m) => `<option value="${esc(m.id)}"${m.id === settingsProvider ? ' selected' : ''}>${esc(m.icon)} ${esc(m.name)}</option>`).join('');
  await renderSettingsFor(settingsProvider);
}

async function renderSettingsFor(provider: string): Promise<void> {
  const meta = metaOf(provider); if (!meta) return;
  const cfg: PmConfig = await relay.pmConfigGet(ws(), provider).catch(() => ({ fields: {}, hasSecrets: {}, configured: false }));
  // Config form — one input per declared field; secrets are password inputs showing only a "set" placeholder.
  const form = $('#pmConfig') as HTMLElement | null;
  if (form) {
    form.innerHTML = meta.configFields.map((f) => {
      const val = f.secret ? '' : esc(cfg.fields[f.key] || '');
      const ph = f.secret ? (cfg.hasSecrets[f.key] ? '•••••••• (unchanged)' : esc(f.placeholder || f.label)) : esc(f.placeholder || '');
      return `<div class="field"><label>${esc(f.label)}${f.required ? '' : ' <span class="opt">optional</span>'}</label>`
        + `<input class="tk-input" data-cfg="${esc(f.key)}" type="${f.secret ? 'password' : 'text'}" placeholder="${ph}" value="${val}" spellcheck="false" autocomplete="off">`
        + (f.help ? `<div class="fhint">${esc(f.help)}</div>` : '') + `</div>`;
    }).join('') + `<div class="row"><button class="set" id="pmConfigSave">Save settings</button></div>`
      + (meta.authKind !== 'token' && cfg.redirectUri ? `<div class="fhint">Redirect URI to register (must match <b>exactly</b>): <code class="pm-redir" id="pmRedirect">${esc(cfg.redirectUri)}</code> <a href="#" id="pmCopyRedir">copy</a></div>` : '')
      // Per-provider preference: allow filtering the task rail by assignee. Only offered if the provider actually
      // supports an assignee filter. Persists immediately (it's an app setting, not a provider config field).
      + (meta.capabilities.filters.some((f) => f.key === 'assignee')
        ? `<div class="field pm-optrow"><label class="pm-optlbl"><input type="checkbox" id="pmAssigneeToggle"${assigneeFilterOn(meta.id) ? ' checked' : ''}> Allow filtering tasks by assignee</label>`
          + `<div class="fhint">On — the task rail lists everyone's tasks and shows an assignee filter. Off (default) — the filter is hidden and the rail shows only the tasks assigned to you.</div></div>`
        : '');
    $('#pmConfigSave')?.addEventListener('click', () => void saveConfig());
    $('#pmCopyRedir')?.addEventListener('click', (e) => { e.preventDefault(); const t = ($('#pmRedirect') as HTMLElement)?.textContent || ''; if (t) { relay.copyText(t); toast('Redirect URI copied', true); } });
    $('#pmAssigneeToggle')?.addEventListener('change', (e) => void toggleAssigneeFilter(meta.id, (e.target as HTMLInputElement).checked));
  }
  const note = $('#pmScopesNote'); if (note) note.innerHTML = meta.scopesNote ? esc(meta.scopesNote) : '';
  await reflectStatus(meta);
}

// Toggle the per-provider "allow filter by assignee" setting. Persists immediately, then — if the rail is currently
// showing this provider — re-seeds the assignee scope (OFF → lock to my tasks; ON → clear the forced "me" so it
// lists everyone), rebuilds the filter bar (to show/hide the control), and reloads.
async function toggleAssigneeFilter(provider: string, on: boolean): Promise<void> {
  state.settings = await relay.patchSettings({ pmAssigneeFilterByProvider: { ...(state.settings.pmAssigneeFilterByProvider || {}), [provider]: on } });
  if (railProvider === provider) {
    const meta = metaOf(provider);
    if (meta && meta.capabilities.filters.some((f) => f.key === 'assignee')) {
      if (!on) filterState.assignee = 'me'; else if (filterState.assignee === 'me') delete filterState.assignee;
      renderFilters(meta); railOffset = 0; await loadRailTasks();
    }
  }
  toast(on ? 'Assignee filtering enabled' : 'Assignee filter hidden — showing your tasks', true);
}

async function reflectStatus(meta: PmProviderMeta): Promise<void> {
  const statusEl = $('#pmStatus'); if (!statusEl) return;
  const st = connecting ? null : await relay.pmAuthState(ws(), meta.id).catch(() => null);
  const connected = !!st?.connected;
  statusEl.innerHTML = connecting
    ? '<span class="sync-dot pending"></span> Waiting for you to authorize in your browser…'
    : connected
      ? `<span class="sync-dot on"></span> Connected as <b>${esc(st.account || meta.name)}</b>`
      : '<span class="sync-dot off"></span> Not connected';
  const show = (id: string, on: boolean) => { const el = $(id) as HTMLElement | null; if (el) el.style.display = on ? '' : 'none'; };
  show('#pmConnect', !connected && !connecting);
  show('#pmCancel', connecting);
  show('#pmDisconnect', connected && !connecting);
  const btn = $('#pmConnect') as HTMLButtonElement | null;
  if (btn) btn.textContent = meta.authKind === 'token' ? 'Verify connection' : `Connect ${meta.name}`;
}

// The current form values. Password fields left blank are omitted (so a blank secret keeps the stored one).
function collectConfigValues(): Record<string, string> {
  const values: Record<string, string> = {};
  document.querySelectorAll<HTMLInputElement>('#pmConfig [data-cfg]').forEach((el) => { const v = el.value.trim(); if (v || !el.type.includes('password')) values[el.dataset.cfg!] = v; });
  return values;
}
// Persist the form. Returns true on success; toasts the validation error on failure. `rerender` repaints the
// panel (skip it mid-connect so the "connecting" state isn't clobbered).
async function persistConfig(meta: PmProviderMeta, rerender: boolean): Promise<boolean> {
  const r = await relay.pmConfigSet(ws(), meta.id, collectConfigValues()).catch(() => ({ ok: false, error: 'Save failed' }));
  if (!r?.ok) { toast(r?.error || 'Could not save', false); return false; }
  document.querySelectorAll<HTMLInputElement>('#pmConfig input[type=password]').forEach((el) => (el.value = '')); // stored now; don't keep the secret in the DOM
  if (rerender) await renderSettingsFor(meta.id);
  return true;
}

async function saveConfig(): Promise<void> {
  const meta = metaOf(settingsProvider); if (!meta) return;
  if (await persistConfig(meta, true)) toast(`${meta.name} settings saved`, true);
}

async function connect(): Promise<void> {
  const meta = metaOf(settingsProvider); if (!meta) return;
  // Save whatever is in the form FIRST — clicking Connect is meant to just work; nobody should lose what they
  // typed because a separate Save button went unpressed. A validation error (e.g. a host with no scheme) is
  // toasted by persistConfig and we stop here.
  if (!(await persistConfig(meta, false))) return;
  const cfg: PmConfig = await relay.pmConfigGet(ws(), meta.id).catch(() => ({ configured: false } as PmConfig));
  if (!cfg.configured) { toast('Fill in all the required fields first', false); return; }
  if (meta.authKind === 'token') { await reflectStatus(meta); const st = await relay.pmAuthState(ws(), meta.id).catch(() => null); toast(st?.connected ? `Connected to ${meta.name}` : 'Token not accepted — check the settings', !!st?.connected); return; }
  connecting = true; await reflectStatus(meta);
  const r = await relay.pmOAuth(ws(), meta.id).catch(() => ({ ok: false, error: 'Sign-in failed' }));
  connecting = false;
  if (r?.ok) { toast(`Connected to ${meta.name}${r.account ? ` as ${r.account}` : ''}`, true); }
  else if (!r?.cancelled) toast(r?.error || 'Sign-in failed', false);
  await reflectStatus(meta);
}

async function disconnect(): Promise<void> {
  const meta = metaOf(settingsProvider); if (!meta) return;
  if (!(await deps.confirm(`Disconnect ${meta.name}?`, `Slayer T will forget your ${meta.name} credentials for this workspace. You can reconnect any time.`, 'Disconnect'))) return;
  await relay.pmDisconnect(ws(), meta.id).catch(() => {});
  toast(`Disconnected from ${meta.name}`, true);
  await reflectStatus(meta);
}

/* ============================ Sync rail ============================ */

// Which providers are currently connected (for the rail's provider dropdown).
async function connectedProviders(): Promise<PmProviderMeta[]> {
  const out: PmProviderMeta[] = [];
  for (const m of metas) { const st = await relay.pmAuthState(ws(), m.id).catch(() => null); if (st?.connected) out.push(m); }
  return out;
}

// The connected PM providers — the unified Tasks rail's source segment (in renderer.ts) reads this to offer a
// tab per provider alongside "Local". Returns safe metadata only.
export async function connectedPmProviders(): Promise<{ id: string; name: string; icon: string }[]> {
  await loadMetas();
  return (await connectedProviders()).map((m) => ({ id: m.id, name: m.name, icon: m.icon }));
}

// Show a provider's tasks in the rail (called by the source segment when its tab is picked, and on ws-switch).
// A different provider resets filters + paging (its filters/pages are its own).
export async function showRailProvider(id: string): Promise<void> {
  await loadMetas();
  const meta = metaOf(id);
  if (!meta) { const list = $('#pmRailTasks'); if (list) list.innerHTML = '<div class="pm-empty">Provider unavailable.</div>'; return; }
  if (id !== railProvider) { railProvider = id; filterState = {}; railOffset = 0; }
  // Assignee scoping honors the per-provider "Allow filtering by assignee" setting (Settings → Integrations):
  // OFF (default) locks the rail to the authenticated user's own tasks (the filter is also hidden); ON leaves it
  // unset so the rail lists everyone's tasks and the user can filter by assignee.
  if (meta.capabilities.filters.some((f) => f.key === 'assignee') && !assigneeFilterOn(id)) filterState.assignee = 'me';
  await loadRailProjects();
}

async function loadRailProjects(): Promise<void> {
  const list = $('#pmRailTasks'); const projSel = $('#pmRailProject') as HTMLSelectElement | null;
  const meta = metaOf(railProvider);
  if (list) list.innerHTML = '<div class="pm-empty">Loading…</div>';
  const r = await relay.pmProjects(ws(), railProvider).catch(() => null);
  if (!r?.ok) { if (list) list.innerHTML = `<div class="pm-empty">${esc(r?.error || 'Could not load projects')}</div>`; renderFilters(meta); return; }
  railProjects = (r.data || []) as PmProject[];
  const label = meta?.containerLabel || 'Project';
  if (projSel) { projSel.title = label; projSel.innerHTML = railProjects.length ? railProjects.map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('') : `<option value="">No ${esc(label.toLowerCase())}s</option>`; }
  if (meta) await ensureRefs(meta);          // options for the filter + editor selects
  renderFilters(meta);                       // build the filter bar (once per provider/project context)
  if (railProjects.length) { railProjectId = railProjects[0].id; railOffset = 0; renderRepoRow(); await loadRailTasks(); }
  else { railProjectId = ''; renderRepoRow(); renderPager(meta, 0); if (list) list.innerHTML = `<div class="pm-empty">No ${esc(label.toLowerCase())}s.</div>`; }
}

// Fetch every reference list the editors AND filters need (once per ws+provider+ref), so their selects populate.
async function ensureRefs(meta: PmProviderMeta): Promise<void> {
  const refs = new Set<string>();
  for (const f of meta.capabilities.editFields) if (f.control === 'select' && f.optionsRef) refs.add(f.optionsRef);
  for (const f of meta.capabilities.filters) if (f.control === 'select' && f.optionsRef) refs.add(f.optionsRef);
  for (const ref of refs) {
    const key = `${ws()}:${meta.id}:${ref}`;
    if (refCache[key]) continue;
    const r = await relay.pmReference(ws(), meta.id, ref).catch(() => null);
    if (r?.ok) refCache[key] = (r.data || []).map((x: any) => String(x.title || '')).filter(Boolean);
  }
}

// Render the filter bar from the provider's declared filters. Values come from filterState, so re-rendering
// never loses the active filters. Not called while the user types (only on provider/project/sync).
function renderFilters(meta: PmProviderMeta | undefined): void {
  const bar = $('#pmRailFilters'); if (!bar) return;
  if (!meta || !meta.capabilities.filters.length) { bar.innerHTML = ''; return; }
  // The assignee filter is shown only when the per-provider setting allows it; otherwise the rail is locked to the
  // authenticated user's own tasks (filterState.assignee stays "me") and the control is hidden entirely.
  bar.innerHTML = meta.capabilities.filters.filter((f) => f.key !== 'assignee' || assigneeFilterOn(meta.id)).map((f) => {
    const cur = filterState[f.key] || '';
    if (f.control === 'text') return `<input class="pm-filter-input" data-filter="${esc(f.key)}" type="text" placeholder="${esc(f.placeholder || f.label)}" value="${esc(cur)}" spellcheck="false" autocomplete="off">`;
    const opts = (f.optionsRef ? refCache[`${ws()}:${meta.id}:${f.optionsRef}`] : []) || [];
    // Assignee (shown only when the filter is enabled) offers a "Me" convenience option alongside "anyone" (list
    // all — the default) and the members list, so the user can quickly narrow to their own tasks.
    const meOpt = f.key === 'assignee' ? `<option value="me"${cur === 'me' ? ' selected' : ''}>👤 Me</option>` : '';
    return `<select class="pm-filter-sel" data-filter="${esc(f.key)}"><option value="">${esc(f.label)}: anyone</option>${meOpt}${opts.map((o) => `<option value="${esc(o)}"${o === cur ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }).join('');
}

async function loadRailTasks(): Promise<void> {
  const list = $('#pmRailTasks'); if (!list || !railProjectId) return;
  const meta = metaOf(railProvider); if (!meta) return;
  list.innerHTML = '<div class="pm-empty">Loading…</div>';
  const filters: Record<string, string> = {};
  for (const [k, v] of Object.entries(filterState)) if (v) filters[k] = v;
  const r = await relay.pmTasks(ws(), railProvider, railProjectId, { filters, limit: PAGE, offset: railOffset }).catch(() => null);
  if (!r?.ok) { railTasks = []; list.innerHTML = `<div class="pm-empty">${esc(r?.error || 'Could not load tasks')}</div>`; renderPager(meta, 0); return; }
  railTasks = (r.data || []) as PmTask[];
  renderPager(meta, railTasks.length);
  rerenderTasks();
}

// Re-render the task rows from the in-memory list (no fetch) — used on load AND when a run's status changes so
// the ⚡/chip reflect instantly without re-hitting the API.
function rerenderTasks(): void {
  const list = $('#pmRailTasks'); const meta = metaOf(railProvider); if (!list || !meta) return;
  if (!railTasks.length) { const filtered = Object.values(filterState).some(Boolean); list.innerHTML = `<div class="pm-empty">${railOffset > 0 || filtered ? 'No tasks match.' : 'No tasks here.'}</div>`; return; }
  const selects = meta.capabilities.editFields.filter((f) => f.control === 'select'); // inline-editable selects
  list.innerHTML = railTasks.map((t) => {
    const st = pmRunStatusOf(railProvider, t.key || t.id);
    const chip = st !== 'idle' ? `<span class="pm-run-chip s-${st}" data-runchip="${esc(t.key || t.id)}" title="Click to dismiss / free">${esc(PM_RUN_LABEL[st])}</span>` : '';
    const canAssign = st === 'idle';
    // Once validated, this task has a filed issue: show its type labels + an issue #N badge on the row, exactly like
    // a local task row (same .tk-tagchip / .tk-issue classes). Survives closure — a fixed issue shows as "closed".
    const filed = pmFiledOf(ws(), railProvider, t.key || t.id);
    const labelChips = (filed?.tags || []).map((tg) => `<span class="tk-tagchip ${esc(tg)}">${esc(LABEL_NAME[tg] || tg)}</span>`).join('');
    const issueBadge = filed ? `<span class="tk-issue${filed.closed ? ' closed' : ''}" data-issue-url="${esc(filed.issueUrl)}" title="Open the filed issue (${filed.closed ? 'closed' : 'open'})">issue #${filed.issueNumber}${filed.closed ? ' ✓' : ''} ↗</span>` : '';
    return `<div class="pm-task" data-key="${esc(t.key || t.id)}">
      <div class="pm-task-top"><span class="pm-key">${esc(t.key || '')}</span><span class="pm-title" title="${esc(t.title || '')}">${esc(t.title || '')}</span>${labelChips}${issueBadge}${chip}${canAssign ? `<button class="pm-assign" data-assign="${esc(t.key || t.id)}" title="Validate this task against the repo">⚡</button>` : ''}</div>
      <div class="pm-task-fields">${selects.map((f) => fieldSelect(meta, f, t)).join('')}${t.priority && !selects.some((f) => f.key === 'priority') ? `<span class="pm-prio">${esc(t.priority)}</span>` : ''}</div>
    </div>`;
  }).join('');
}

// Prev/next pager. Only shown for paginated providers; "next" appears when this page came back full (a full page
// implies there may be more — the desk list gives no total), "prev" whenever we're past the first page.
function renderPager(meta: PmProviderMeta | undefined, count: number): void {
  const pager = $('#pmRailPager'); if (!pager) return;
  if (!meta?.capabilities.paginated || (railOffset === 0 && count < PAGE)) { pager.innerHTML = ''; return; }
  const page = Math.floor(railOffset / PAGE) + 1;
  pager.innerHTML = `<button class="pm-page-btn" id="pmPrev"${railOffset === 0 ? ' disabled' : ''}>‹ Prev</button>`
    + `<span class="pm-page-n">Page ${page}</span>`
    + `<button class="pm-page-btn" id="pmNext"${count < PAGE ? ' disabled' : ''}>Next ›</button>`;
}

// One inline editor <select> for an editField, options from the ref cache (or the task's inline statusOptions).
function fieldSelect(meta: PmProviderMeta, f: EditField, t: PmTask): string {
  const cur = String((t as any)[f.key] || '');
  const opts = (f.optionsRef ? refCache[`${ws()}:${meta.id}:${f.optionsRef}`] : t.statusOptions) || (cur ? [cur] : []);
  if (!opts.length) return cur ? `<span class="pm-prio">${esc(cur)}</span>` : '';
  // A blank leading option when the task has no value for this field, so an unset field doesn't look like it's
  // already set to the first option (and a stray same-value pick can't fire a no-op write).
  const blank = cur ? '' : '<option value="" selected></option>';
  const options = opts.map((o) => `<option value="${esc(o)}"${o === cur ? ' selected' : ''}>${esc(o)}</option>`).join('');
  return `<select class="pm-field" data-key="${esc(t.key || t.id)}" data-field="${esc(f.key)}" title="${esc(f.label)}">${blank}${options}</select>`;
}

// Two-way write: changing an inline editor PATCHes the task on the provider immediately.
async function editField(taskKey: string, field: string, value: string, el: HTMLSelectElement): Promise<void> {
  el.disabled = true;
  const r = await relay.pmTaskUpdate(ws(), railProvider, taskKey, { [field]: value }).catch(() => ({ ok: false, error: 'Update failed' }));
  el.disabled = false;
  if (r?.ok) toast(`${taskKey} · ${field} → ${value}`, true);
  else { toast(r?.error || `Could not update ${taskKey}`, false); void loadRailTasks(); } // reload to revert the visible value
}

// A filter changed → apply it from page 1.
let filterTimer: ReturnType<typeof setTimeout> | null = null;
function onFilter(key: string, value: string, debounce: boolean): void {
  filterState[key] = value; railOffset = 0;
  if (filterTimer) clearTimeout(filterTimer);
  if (debounce) filterTimer = setTimeout(() => void loadRailTasks(), 300); else void loadRailTasks();
}

/* ============================ assign to a build pipeline ============================ */
// The app's standard dialog shell (same as tasks.ts's task/validate dialog): a dimmed scrim + a .tpl-card,
// Escape-to-close, no backdrop-click-close (a stray click must not discard the form).
function tplModal(html: string): { root: HTMLElement; close: () => void } {
  const root = document.createElement('div'); root.className = 'tpl-modal';
  root.innerHTML = `<div class="tpl-sc"></div>${html}`;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
  document.body.appendChild(root); document.addEventListener('keydown', onKey);
  return { root, close };
}
const statusSelect = (id: string, opts: string[], cur?: string): string => `<select class="iss-agentsel" id="${id}"><option value="">— none —</option>${opts.map((o) => `<option value="${esc(o)}"${o === cur ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
const agentOptions = (cur?: string): string => AGENTS.map((a) => `<option value="${esc(a.id)}"${a.id === (cur || AGENTS[0].id) ? ' selected' : ''}>${esc(a.name)}</option>`).join('');

// Persist the project→repo map + the provider's on-start/validated status map, so the next Validate for this
// project pre-fills. Read-modify-write the nested per-ws maps (patchSettings replaces top-level keys).
async function saveMappings(projKey: string, repoId: string, statuses: { start: string; valid: string; fixed: string }): Promise<void> {
  const wsId = ws();
  const repoAll = { ...(state.settings.pmProjectRepoByWs || {}) };
  repoAll[wsId] = { ...(repoAll[wsId] || {}), [projKey]: repoId };
  const statAll = { ...(state.settings.pmStatusMapByWs || {}) };
  statAll[wsId] = { ...(statAll[wsId] || {}), [railProvider]: { start: statuses.start || undefined, valid: statuses.valid || undefined, fixed: statuses.fixed || undefined } };
  state.settings = await relay.patchSettings({ pmProjectRepoByWs: repoAll, pmStatusMapByWs: statAll });
}

/* ---- project → build repo mapping (the in-rail control) ---- */
const projRepoOf = (projKey: string): string => state.settings.pmProjectRepoByWs?.[ws()]?.[projKey] || '';
// Persist one project's build repo (empty clears it). Read-modify-write the nested per-ws map.
async function setProjectRepo(projKey: string, repoId: string): Promise<void> {
  const wsId = ws();
  const all = { ...(state.settings.pmProjectRepoByWs || {}) };
  const wsMap = { ...(all[wsId] || {}) };
  if (repoId) wsMap[projKey] = repoId; else delete wsMap[projKey];
  all[wsId] = wsMap;
  state.settings = await relay.patchSettings({ pmProjectRepoByWs: all });
}
// The repo chip under the project selector — shows the current project's mapped build repo, click to set/change.
function renderRepoRow(): void {
  const el = $('#pmRailRepo') as HTMLButtonElement | null; if (!el) return;
  if (!railProjectId) { el.style.display = 'none'; return; }
  el.style.display = '';
  const repo = projRepoOf(`${railProvider}:${railProjectId}`);
  el.classList.toggle('unset', !repo);
  el.innerHTML = repo
    ? `<span class="pm-repo-ic">🔗</span><span class="pm-repo-nm">${esc(repo.replace(/^[^:]+:/, ''))}</span><span class="pm-repo-edit">✎</span>`
    : `<span class="pm-repo-ic">＋</span><span class="pm-repo-nm">Set validate repo</span>`;
}
// Dialog to set/change the current project's build repo — a tracked-repo picker + a manual field.
function openRepoMap(): void {
  if (!railProjectId) return;
  const projKey = `${railProvider}:${railProjectId}`;
  const cur = projRepoOf(projKey);
  const tracked = state.settings.issueReposByWs?.[ws()] || [];
  const projTitle = railProjects.find((p) => p.id === railProjectId)?.title || railProjectId;
  const { root, close } = tplModal(`<div class="tpl-card iss-card">
    <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Validate repository<small>${esc(projTitle)}</small></span></div>
    <div class="bd">
      ${tracked.length ? `<div class="iss-agentrow" style="margin-top:0"><label class="iss-lbl" style="margin:0">Tracked repo</label><select class="iss-agentsel" id="rmPick"><option value="">— choose —</option>${tracked.map((id) => `<option value="${esc(id)}"${id === cur ? ' selected' : ''}>${esc(id.replace(/^[^:]+:/, ''))}</option>`).join('')}</select></div>` : ''}
      <label class="iss-lbl">Repository</label>
      <input class="tk-input" id="rmRepo" placeholder="github:owner/repo" value="${esc(cur)}" spellcheck="false" autocomplete="off">
      <div class="fhint">Tasks in <b>${esc(projTitle)}</b> are validated against this repo when you ⚡ Validate them. It's auto-cloned if it isn't your open project folder.</div>
    </div>
    <div class="ft"><span class="hint"></span><span class="r">${cur ? '<button class="tpl-btn ghost" data-clear>Clear</button>' : ''}<button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-save>Save</button></span></div>
  </div>`);
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  q<HTMLElement>('[data-x]').onclick = close;
  const pick = root.querySelector('#rmPick') as HTMLSelectElement | null;
  if (pick) pick.onchange = () => { if (pick.value) q<HTMLInputElement>('#rmRepo').value = pick.value; };
  root.querySelector('[data-clear]')?.addEventListener('click', async () => { await setProjectRepo(projKey, ''); close(); renderRepoRow(); toast('Validate repo cleared', true); });
  q<HTMLElement>('[data-save]').onclick = async () => {
    const repoId = q<HTMLInputElement>('#rmRepo').value.trim();
    if (repoId && !/^(github|gitlab|bitbucket):[\w.-]+(\/[\w.-]+)+$/.test(repoId)) { toast('Repository must look like github:owner/repo', false); return; }
    await setProjectRepo(projKey, repoId); close(); renderRepoRow(); toast(repoId ? `Validate repo set to ${repoId.replace(/^[^:]+:/, '')}` : 'Validate repo cleared', true);
  };
}

async function openValidate(taskKey: string): Promise<void> {
  const meta = metaOf(railProvider); if (!meta) return;
  const summary = railTasks.find((t) => (t.key || t.id) === taskKey); if (!summary) return;
  const projKey = `${railProvider}:${railProjectId}`;
  const savedRepo = state.settings.pmProjectRepoByWs?.[ws()]?.[projKey] || '';
  const savedStat = state.settings.pmStatusMapByWs?.[ws()]?.[railProvider] || {};
  const statuses = refCache[`${ws()}:${meta.id}:task-statuses`] || [];
  const detail = await relay.pmTaskGet(ws(), railProvider, taskKey).catch(() => null); // list rows omit the description
  const task = { key: summary.key || summary.id, title: summary.title || '', description: (detail?.ok && detail.data?.description) || '' };
  const projTitle = railProjects.find((p) => p.id === railProjectId)?.title || railProjectId;
  // Task type (same set + guidance as a local task). Like a local task, the type's guidance is NOT shown in the
  // brief box — it's appended silently at launch — so the box shows only the base validate prompt. Default to
  // the last type used for this provider, else Bug.
  const selectedTags = new Set<string>();
  const savedType = state.settings.pmTypeByProvider?.[railProvider];
  (savedType && savedType.length ? savedType : ['bug']).forEach((t) => selectedTags.add(t));

  // Dependency repos the validate agent may READ (linked read-only under .deps/) — the workspace's OTHER tracked
  // repos, exactly like a local task's Validate dialog. Default to the mapped repo's dependency template. Like the
  // type guidance, the .deps/ note is appended silently at launch (not shown in the brief box).
  const depCandidates = (state.settings.issueReposByWs?.[ws()] || []).filter((id) => id !== savedRepo);
  const selectedDeps = new Set((savedRepo ? repoDepsFor(savedRepo) : []).filter((id) => depCandidates.includes(id)));

  const { root, close } = tplModal(`<div class="tpl-card iss-card">
    <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Validate against the repo<small>${esc(task.key)} · ${esc(meta.containerLabel)}: ${esc(projTitle)}</small></span></div>
    <div class="bd">
      <label class="iss-lbl">Type <span class="mut">— shapes the validation</span></label>
      <div class="tk-tags" id="pmaTags" style="margin-bottom:12px">${TAG_DEFS.map((d) => `<label class="tk-tag"><input type="checkbox" data-tag="${esc(d.id)}"${selectedTags.has(d.id) ? ' checked' : ''}> ${esc(d.label)}</label>`).join('')}</div>
      <label class="iss-lbl">Validate in repository</label>
      <input class="tk-input" id="pmaRepo" placeholder="github:owner/repo" value="${esc(savedRepo)}" spellcheck="false" autocomplete="off">
      <div class="iss-agentrow" style="margin-top:11px"><label class="iss-lbl" style="margin:0">Assign to</label><select class="iss-agentsel" id="pmaAgent">${agentOptions(state.settings.issueAgent)}</select></div>
      <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Status on start <span class="mut">— optional</span></label>${statusSelect('pmaStart', statuses, savedStat.start)}</div>
      <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Status when valid <span class="mut">— issue filed</span></label>${statusSelect('pmaValid', statuses, savedStat.valid)}</div>
      <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Status when fixed <span class="mut">— issue closed</span></label>${statusSelect('pmaFixed', statuses, savedStat.fixed)}</div>
      ${depCandidates.length ? `<label class="iss-lbl">Dependencies <span class="mut">— read-only repos the agent can view under <code>.deps/</code></span></label>
      <div class="iss-deps" id="pmaDeps">${depCandidates.map((id) => `<label class="iss-dep"><input type="checkbox" value="${esc(id)}"${selectedDeps.has(id) ? ' checked' : ''}><b>${esc(id.split('/').pop() || id)}</b><span class="mut">${esc(id)}</span></label>`).join('')}</div>` : ''}
      <label class="iss-lbl">Brief <span class="mut">— validate prompt, edit before launch</span></label>
      <textarea class="iss-brief" id="pmaBrief" rows="12" spellcheck="false">${esc(validateBrief(task))}</textarea>
    </div>
    <div class="ft"><span class="hint">Valid → files a linked issue, tracked to fixed</span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-go>⚡ Validate</button></span></div>
  </div>`);
  const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  // Ticking a type only records it (the brief box stays the base prompt); its guidance is appended at launch.
  q<HTMLElement>('#pmaTags').onchange = () => {
    selectedTags.clear();
    root.querySelectorAll<HTMLInputElement>('#pmaTags input:checked').forEach((cb) => selectedTags.add(cb.dataset.tag!));
  };
  root.querySelector('#pmaDeps')?.addEventListener('change', () => {   // toggle a dependency repo → record it (linked at launch)
    selectedDeps.clear();
    root.querySelectorAll<HTMLInputElement>('#pmaDeps input:checked').forEach((cb) => selectedDeps.add(cb.value));
  });
  addSearch(root.querySelector('#pmaDeps'), 'Search dependency repos…');   // filter a long dependency-repo list
  q<HTMLElement>('[data-x]').onclick = close;
  q<HTMLElement>('[data-go]').onclick = async () => {
    const repoId = q<HTMLInputElement>('#pmaRepo').value.trim();
    const m = /^(github|gitlab|bitbucket):(.+)$/.exec(repoId);
    if (!m || !/^[\w.-]+(\/[\w.-]+)+$/.test(m[2])) { toast('Repository must look like github:owner/repo', false); return; }
    const agentId = q<HTMLSelectElement>('#pmaAgent').value;
    const start = q<HTMLSelectElement>('#pmaStart').value, valid = q<HTMLSelectElement>('#pmaValid').value, fixed = q<HTMLSelectElement>('#pmaFixed').value;
    const depIds = [...selectedDeps].filter((id) => id !== repoId); // never link the build repo as its own dependency
    const brief0 = q<HTMLTextAreaElement>('#pmaBrief').value + tagNote([...selectedTags]) + depsNote(depIds); // append the type + .deps/ guidance silently, like a local task
    await saveMappings(projKey, repoId, { start, valid, fixed });
    state.settings = await relay.patchSettings({ pmTypeByProvider: { ...(state.settings.pmTypeByProvider || {}), [railProvider]: [...selectedTags] } }); // remember the type for next time
    renderRepoRow(); // reflect a repo set/changed here in the rail chip
    close();
    await assignPmTask({ provider: railProvider, projectId: railProjectId, ws: ws(), task, repoProvider: m[1], repo: m[2], start: start || undefined, valid: valid || undefined, fixed: fixed || undefined, agentId, brief0, deps: depIds, tags: [...selectedTags] });
  };
}

/* ============================ create a task directly in the provider ============================ */
// New task in the current project — created straight in the provider (auto-assigned to you) and it appears in
// the synced list immediately.
async function openCreateTask(): Promise<void> {
  const meta = metaOf(railProvider); if (!meta) return;
  if (!railProjectId) { toast('Pick a project first', false); return; }
  await ensureRefs(meta); // task-statuses (+ priorities) for the pickers
  const statuses = refCache[`${ws()}:${meta.id}:task-statuses`] || [];
  const priorities = refCache[`${ws()}:${meta.id}:task-priorities`] || [];
  const projTitle = railProjects.find((p) => p.id === railProjectId)?.title || railProjectId;
  const { root, close } = tplModal(`<div class="tpl-card iss-card">
    <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">New task<small>${esc(meta.containerLabel)}: ${esc(projTitle)}</small></span></div>
    <div class="bd">
      <label class="iss-lbl">Title</label>
      <input class="tk-input" id="ctTitle" placeholder="What needs doing?" spellcheck="false" autocomplete="off">
      <div class="iss-agentrow" style="margin-top:11px"><label class="iss-lbl" style="margin:0">Status</label><select class="iss-agentsel" id="ctStatus">${statuses.length ? statuses.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('') : '<option value="">— no statuses —</option>'}</select></div>
      ${priorities.length ? `<div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Priority <span class="mut">— optional</span></label><select class="iss-agentsel" id="ctPriority"><option value="">— none —</option>${priorities.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}</select></div>` : ''}
      <label class="iss-lbl">Description</label>
      <textarea class="iss-brief" id="ctDesc" rows="7" spellcheck="false" placeholder="Details (Markdown ok)…"></textarea>
    </div>
    <div class="ft"><span class="hint">Created in ${esc(meta.name)}, assigned to you</span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-go>＋ Create</button></span></div>
  </div>`);
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  q<HTMLElement>('[data-x]').onclick = close;
  setTimeout(() => q<HTMLInputElement>('#ctTitle').focus(), 30);
  q<HTMLElement>('[data-go]').onclick = async () => {
    const title = q<HTMLInputElement>('#ctTitle').value.trim();
    const status = q<HTMLSelectElement>('#ctStatus').value;
    const priority = (root.querySelector('#ctPriority') as HTMLSelectElement | null)?.value || '';
    const description = q<HTMLTextAreaElement>('#ctDesc').value;
    if (!title) { toast('A title is required', false); return; }
    if (!status) { toast('Pick a status', false); return; }
    const body: Record<string, unknown> = { title, status, description, assignee: 'me' };
    if (priority) body.priority = priority;
    const r = await relay.pmTaskCreate(ws(), railProvider, railProjectId, body).catch(() => ({ ok: false, error: 'Create failed' }));
    if (r?.ok && r.data?.key) { toast(`Created ${r.data.key}`, true); close(); railOffset = 0; void loadRailTasks(); } // reload → the new task appears in the synced list
    else toast(r?.error || 'Could not create the task', false);
  };
}

/* ============================ push a local task → provider ============================ */
type PmTaskLink = { provider: string; projectId: string; taskKey: string };
// Open a dialog to CREATE (or UPDATE, if already linked) this local task as a provider task. Resolves with the
// link (pmRef) to store on the local task, or null if cancelled/failed. Re-pushing a linked task updates it.
export async function pushLocalTask(task: { title: string; body?: string; pmRef?: PmTaskLink }): Promise<PmTaskLink | null> {
  await loadMetas();
  const provs = await connectedProviders();
  if (!provs.length) { toast('Connect a provider in Settings → Integrations first', false); return null; }
  return new Promise<PmTaskLink | null>((resolve) => {
    let provider = task.pmRef && provs.some((p) => p.id === task.pmRef!.provider) ? task.pmRef.provider : provs[0].id;
    const { root, close } = tplModal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">${task.pmRef ? 'Update' : 'Push'} to an integration<small>${esc(task.title)}</small></span></div>
      <div class="bd">
        <div class="iss-agentrow" style="margin-top:0"><label class="iss-lbl" style="margin:0">Provider</label><select class="iss-agentsel" id="puProvider">${provs.map((p) => `<option value="${esc(p.id)}"${p.id === provider ? ' selected' : ''}>${esc(p.icon)} ${esc(p.name)}</option>`).join('')}</select></div>
        <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Project</label><select class="iss-agentsel" id="puProject"><option>Loading…</option></select></div>
        <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Status</label><select class="iss-agentsel" id="puStatus"></select></div>
        <label class="iss-lbl">Title</label>
        <input class="tk-input" id="puTitle" value="${esc(task.title)}" spellcheck="false">
        <label class="iss-lbl" style="margin-top:11px">Description</label>
        <textarea class="iss-brief" id="puDesc" rows="7" spellcheck="false">${esc(task.body || '')}</textarea>
      </div>
      <div class="ft"><span class="hint"></span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-go>↑ ${task.pmRef ? 'Update' : 'Push'}</button></span></div>
    </div>`);
    const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
    const done = (ref: PmTaskLink | null) => { close(); resolve(ref); };
    q<HTMLElement>('[data-x]').onclick = () => done(null);
    const loadForProvider = async (): Promise<void> => {
      const pr = await relay.pmProjects(ws(), provider).catch(() => null);
      const projects: PmProject[] = pr?.ok ? (pr.data || []) : [];
      q<HTMLSelectElement>('#puProject').innerHTML = projects.length ? projects.map((p) => `<option value="${esc(p.id)}"${p.id === task.pmRef?.projectId ? ' selected' : ''}>${esc(p.title)}</option>`).join('') : '<option value="">No projects</option>';
      const rr = await relay.pmReference(ws(), provider, 'task-statuses').catch(() => null);
      const statuses: string[] = rr?.ok ? (rr.data || []).map((x: any) => String(x.title || '')).filter(Boolean) : [];
      q<HTMLSelectElement>('#puStatus').innerHTML = statuses.length ? statuses.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('') : '<option value="">— no statuses —</option>';
    };
    q<HTMLSelectElement>('#puProvider').onchange = (e) => { provider = (e.target as HTMLSelectElement).value; void loadForProvider(); };
    void loadForProvider();
    q<HTMLElement>('[data-go]').onclick = async () => {
      const projectId = q<HTMLSelectElement>('#puProject').value;
      const status = q<HTMLSelectElement>('#puStatus').value;
      const title = q<HTMLInputElement>('#puTitle').value.trim();
      const description = q<HTMLTextAreaElement>('#puDesc').value;
      if (!projectId) { toast('Pick a project', false); return; }
      if (!title) { toast('A title is required', false); return; }
      if (!status) { toast('Pick a status', false); return; }
      const linkedSame = !!task.pmRef && task.pmRef.provider === provider && task.pmRef.projectId === projectId;
      // Auto-assign the pushed task to the current user ("me" resolves to the caller); this also satisfies a
      // status that requires an assignee.
      const body = { title, status, description, assignee: 'me' };
      if (linkedSame) {
        const r = await relay.pmTaskUpdate(ws(), provider, task.pmRef!.taskKey, body).catch(() => ({ ok: false, error: 'Update failed' }));
        if (r?.ok) { toast(`Updated ${task.pmRef!.taskKey}`, true); done(task.pmRef!); } else toast(r?.error || 'Update failed', false);
      } else {
        const r = await relay.pmTaskCreate(ws(), provider, projectId, body).catch(() => ({ ok: false, error: 'Create failed' }));
        if (r?.ok && r.data?.key) { toast(`Created ${r.data.key} in ${provider}`, true); done({ provider, projectId, taskKey: r.data.key }); } else toast(r?.error || 'Create failed', false);
      }
    };
  });
}

/* ============================ init ============================ */
export function initPm(d: PmDeps): void {
  deps = d;
  initPmPipeline({ openAgentTab: d.openAgentTab, onAgentTabClosed: d.onAgentTabClosed, refresh: rerenderTasks }); // the PM-task build-pipeline runner
  // Settings panel
  $('#pmProvider')?.addEventListener('change', (e) => { settingsProvider = (e.target as HTMLSelectElement).value; void renderSettingsFor(settingsProvider); });
  $('#pmConnect')?.addEventListener('click', () => void connect());
  $('#pmCancel')?.addEventListener('click', () => { void relay.pmOAuthCancel(); });
  $('#pmDisconnect')?.addEventListener('click', () => void disconnect());
  // Rail (the provider is chosen by the unified rail's source segment in renderer.ts, not a dropdown here)
  $('#pmRailProject')?.addEventListener('change', (e) => { const v = (e.target as HTMLSelectElement).value; if (v) { railProjectId = v; railOffset = 0; renderRepoRow(); void loadRailTasks(); } });
  $('#pmRailRepo')?.addEventListener('click', () => openRepoMap());
  $('#pmRailSync')?.addEventListener('click', () => { railOffset = 0; void loadRailProjects(); });
  $('#pmRailNew')?.addEventListener('click', () => void openCreateTask());
  $('#pmRailTasks')?.addEventListener('change', (e) => { const sel = (e.target as HTMLElement).closest('.pm-field') as HTMLSelectElement | null; if (sel?.dataset.key && sel.dataset.field) void editField(sel.dataset.key, sel.dataset.field, sel.value, sel); });
  // Validate against the repo (⚡) + dismiss/free a run (chip)
  $('#pmRailTasks')?.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const a = t.closest('.pm-assign') as HTMLElement | null; if (a?.dataset.assign) { void openValidate(a.dataset.assign); return; }
    const iss = t.closest('.tk-issue') as HTMLElement | null; if (iss?.dataset.issueUrl) { void relay.openExternal(iss.dataset.issueUrl); return; }
    const c = t.closest('.pm-run-chip') as HTMLElement | null; if (c?.dataset.runchip) onPmRunChip(railProvider, c.dataset.runchip);
  });
  // Filter bar — selects apply immediately; the search box debounces.
  $('#pmRailFilters')?.addEventListener('change', (e) => { const el = (e.target as HTMLElement).closest('.pm-filter-sel') as HTMLSelectElement | null; if (el?.dataset.filter) onFilter(el.dataset.filter, el.value, false); });
  $('#pmRailFilters')?.addEventListener('input', (e) => { const el = (e.target as HTMLElement).closest('.pm-filter-input') as HTMLInputElement | null; if (el?.dataset.filter) onFilter(el.dataset.filter, el.value.trim(), true); });
  // Pager
  $('#pmRailPager')?.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#pmPrev')) { railOffset = Math.max(0, railOffset - PAGE); void loadRailTasks(); }
    else if (t.closest('#pmNext')) { railOffset += PAGE; void loadRailTasks(); }
  });
}
