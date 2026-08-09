// Tasks — draft a PROPOSED issue, VALIDATE it against the repo with a validate-only agent run, and file it as
// a real issue ONLY if the agent judges it valid. Invalid → no issue is created; the validation result is kept
// on the task instead. Reuses the issue VALIDATE_BRIEF + the generic pipeline:prep / pipeline:verdict IPC, and
// a dedicated task worktree (`task-<id>` off the latest default). DI-seam module: initTasks(deps).

import { state } from './state';
import { $, esc } from './dom';
import { toast } from './ui';
import { VALIDATE_BRIEF, renderBrief } from './pipelines';
import { AGENTS } from './agents-list';
import type { Task } from './shared/types';

const relay = (window as any).relay;
type ProviderId = 'github' | 'gitlab' | 'bitbucket';
const PROV_DOT: Record<ProviderId, string> = { github: 'gh', gitlab: 'gl', bitbucket: 'bb' };
const STATUS_LABEL: Record<Task['status'], string> = { draft: 'draft', validating: 'validating…', valid: 'issue open', open: 'issue open', closed: 'issue closed', invalid: 'not valid', error: 'error' };
// A task that filed an issue (for DISPLAY: show the issue link + open/closed chip).
const isFiled = (t: Task): boolean => !!t.issueNumber && (t.status === 'open' || t.status === 'closed' || t.status === 'valid');
// A filed task still worth POLLING: only OPEN (and legacy 'valid'). A 'closed' task is terminal, so we stop
// polling it — the poll load winds down as issues close and stops completely when none are open. (Reopens on the
// provider aren't re-tracked; closed is treated as final.)
const needsSync = (t: Task): boolean => !!t.issueNumber && (t.status === 'open' || t.status === 'valid');

export interface TasksDeps {
  activeWsId: () => string;                                                     // active workspace (tasks are per-workspace)
  openAgentTab: (o: { cwd: string; name: string; runCmd?: string }) => void;    // open the validate run in a worktree tab
}
let deps: TasksDeps;
const wsKey = () => deps.activeWsId() || 'ws_default';

function parseRepoId(id: string): { provider: ProviderId; repo: string } {
  const m = /^(github|gitlab|bitbucket):(.+)$/.exec(id || '');
  return m ? { provider: m[1] as ProviderId, repo: m[2] } : { provider: 'github', repo: id };
}

/* ----------------------------- persistence (per workspace) ----------------------------- */
const tasksFor = (ws: string): Task[] => (state.settings.tasksByWs || {})[ws] || [];
let writeChain: Promise<void> = Promise.resolve();
// Persist a CAPTURED task map (serialized). Callers pass the map they just built and set on state.settings, so
// an unrelated concurrent patchSettings that reassigns state.settings can't make us write back a stale map.
function saveTasks(map: Record<string, Task[]>): Promise<void> {
  writeChain = writeChain.then(async () => {
    try { state.settings = await relay.patchSettings({ tasksByWs: map }); } catch { /* keep the in-memory map */ }
  });
  return writeChain;
}
// `ws` defaults to the active workspace (create / run happen there), but a background validation that resolves
// AFTER the user switched workspaces must write to the task's OWN workspace — the poll passes r.ws explicitly.
// `allowCreate` is false on the async poll path: if the task was DELETED during the create-issue await, don't
// resurrect it by re-inserting.
function upsertTask(t: Task, ws = wsKey(), allowCreate = true): void {
  const list = [...tasksFor(ws)];
  const i = list.findIndex((x) => x.id === t.id);
  if (i >= 0) list[i] = t; else if (allowCreate) list.unshift(t); else return; // deleted mid-flight → drop it
  const map = { ...(state.settings.tasksByWs || {}), [ws]: list };
  state.settings.tasksByWs = map;   // update in-memory FIRST so render() shows it now
  void saveTasks(map); render();    // persist the CAPTURED map (survives an unrelated concurrent settings write)
}
function deleteTask(id: string): void {
  const ws = wsKey(); const list = tasksFor(ws).filter((t) => t.id !== id);
  const map = { ...(state.settings.tasksByWs || {}), [ws]: list };
  state.settings.tasksByWs = map;
  void saveTasks(map); render();
}

/* ----------------------------- validate run + verdict poll ----------------------------- */
interface Running { wt: string; ws: string; provider: ProviderId; repo: string; }
const running = new Map<string, Running>();   // taskId → its live validate run (in-memory; a restart drops it, re-validate to resume)
const taskHead = (t: Task): string => `# ${t.title}\n\n${(t.body || '').trim() || '_(no description provided)_'}`;
// The validate brief for a task: {issue} = the proposed issue head; the agent writes its verdict to stage-0.json.
const validateBrief = (t: Task): string => renderBrief(VALIDATE_BRIEF, { issue: taskHead(t), number: 0, title: t.title, closeStep: '', verdictRel: '.slayer/stage-0.json' });
// The .deps/ reference note appended to the brief when dependency repos are selected (same as the issue Assign).
function depsNote(ids: string[]): string {
  if (!ids.length) return '';
  const lines = ids.map((id) => { const { repo: r } = parseRepoId(id); return `- \`.deps/${r.split('/').pop()}\` — ${id}`; }).join('\n');
  return `\n\n---\n\n## Reference repositories (read-only — do NOT modify these)\nThese related repos are checked out under \`.deps/\` for context while you validate:\n${lines}\nRead them to understand interfaces/contracts.`;
}

let pollTimer: number | null = null;
function ensurePoll(): void {
  if (running.size && pollTimer == null) pollTimer = window.setInterval(() => void poll(), 4000);
  else if (!running.size && pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
}
let polling = false;
async function poll(): Promise<void> {
  if (polling) return; polling = true;
  try {
    for (const [id, r] of [...running.entries()]) {
      const v = await relay.pipelineVerdict(r.wt, 0).catch(() => null);
      if (!running.has(id) || !v || !v.found) continue;          // verdict not written yet — keep polling
      running.delete(id);
      const t = tasksFor(r.ws).find((x) => x.id === id); if (!t) continue;
      const summary = (v.summary || '').trim() || (v.passed ? 'Validated as real.' : 'Judged not valid.');
      if (v.passed) {
        // Valid → file a real issue on the provider, with the validation result appended to the description.
        const body = `${(t.body || '').trim()}\n\n---\n**Validated by Slayer T** — confirmed against the codebase before filing:\n\n${summary}`;
        const res = await relay.providerCreateIssue(r.ws, r.provider, r.repo, t.title, body).catch(() => ({ ok: false, error: 'request failed' }));
        if (res.ok) { upsertTask({ ...t, status: 'open', result: summary, issueNumber: res.number, issueUrl: res.url, ranAt: Date.now() }, r.ws, false); toast(`Task valid → filed issue #${res.number} (open)`, true); ensureTracking(); }
        else { upsertTask({ ...t, status: 'error', result: `Validated ✓ but filing the issue failed: ${res.error || 'unknown'}\n\n${summary}`, ranAt: Date.now() }, r.ws, false); toast(`Validated, but couldn't file the issue: ${res.error || ''}`); }
      } else {
        // Not valid → NO issue is filed; keep the reason on the task.
        upsertTask({ ...t, status: 'invalid', result: summary, ranAt: Date.now() }, r.ws, false); toast('Task not valid — no issue filed');
      }
    }
  } finally { polling = false; ensurePoll(); }
}

/* ----------------------------- filed-issue lifecycle tracking (survives reboot) ----------------------------- */
// For every task that filed an issue (across ALL workspaces), poll its current open/closed state and sync the
// task status. The status is persisted (tasksByWs), so a reboot shows the last-known state immediately; this
// re-syncs it. Each workspace uses its own provider credentials.
let trackTimer: number | null = null;
let tracking = false;
function ensureTracking(): void {
  const any = Object.values(state.settings.tasksByWs || {}).some((list) => (list || []).some(needsSync));
  if (any && trackTimer == null) trackTimer = window.setInterval(() => void trackIssues(), 120000);   // every 2 min
  else if (!any && trackTimer != null) { clearInterval(trackTimer); trackTimer = null; }
}
async function trackIssues(): Promise<void> {
  if (tracking) return; tracking = true;
  try {
    for (const [ws, list] of Object.entries(state.settings.tasksByWs || {})) {
      for (const t of [...(list || [])]) {
        if (!needsSync(t)) continue;
        const r = await relay.providerIssueState(ws, t.provider as ProviderId, t.repo, t.issueNumber!).catch(() => null);
        if (!r || !r.ok || !r.state) continue;                      // not connected / transient → keep the last-known status
        const next: Task['status'] = r.state === 'closed' ? 'closed' : 'open';
        const cur = tasksFor(ws).find((x) => x.id === t.id);        // re-read (the map may have changed during the await)
        if (cur && needsSync(cur) && cur.status !== next) upsertTask({ ...cur, status: next }, ws, false);
      }
    }
  } finally { tracking = false; ensureTracking(); }
}

/* ----------------------------- dialogs ----------------------------- */
function modal(html: string): { root: HTMLElement; close: () => void } {
  const root = document.createElement('div'); root.className = 'tpl-modal';
  root.innerHTML = `<div class="tpl-sc"></div>${html}`;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
  document.body.appendChild(root); document.addEventListener('keydown', onKey);
  root.querySelector('.tpl-sc')?.addEventListener('click', close);
  return { root, close };
}

// Create (existing omitted) OR edit (existing passed) a task. Edit keeps the task's id/status/result/deps; only
// the repo, title, and description change.
function openTaskForm(existing?: Task): void {
  const ws = wsKey();
  const tracked = (state.settings.issueReposByWs || {})[ws] || [];
  if (!tracked.length) { toast('Track a repo first (Issues rail → Sources)'); return; }
  const curId = existing ? `${existing.provider}:${existing.repo}` : '';
  // Always include the edited task's OWN repo as an option — even if it's no longer tracked — so Save can't
  // silently reassign the task to the first tracked repo.
  const optionIds = (curId && !tracked.includes(curId)) ? [curId, ...tracked] : tracked;
  const repoOpts = optionIds.map((id) => { const { provider, repo } = parseRepoId(id); return `<option value="${esc(id)}"${id === curId ? ' selected' : ''}>${esc(repo)} · ${provider}${!tracked.includes(id) ? ' (untracked)' : ''}</option>`; }).join('');
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">${existing ? 'Edit task' : 'New task'}</span></div>
      <div class="bd">
        <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Repository</label><select class="iss-agentsel" id="tkRepo">${repoOpts}</select></div>
        <label class="iss-lbl">Title</label>
        <input class="tk-input" id="tkTitle" placeholder="Short summary of the proposed issue" spellcheck="false">
        <label class="iss-lbl">Description <span class="mut">— what to validate</span></label>
        <textarea class="iss-brief" spellcheck="false" rows="8" id="tkBody" placeholder="Describe the bug/change to validate against the repo…"></textarea>
        <div class="iss-wt">A task is a <b>proposed issue</b>. Run validate to have the agent confirm it against the codebase — an issue is filed only if it's valid.</div>
      </div>
      <div class="ft"><span class="hint"></span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button>${existing ? '<button class="tpl-btn pri" data-ok>Save</button>' : '<button class="tpl-btn ghost" data-ok>Draft</button><button class="tpl-btn pri" data-exec>⚡ Create &amp; execute</button>'}</span></div>
    </div>`);
  const titleEl = root.querySelector('#tkTitle') as HTMLInputElement;
  const bodyEl = root.querySelector('#tkBody') as HTMLTextAreaElement;
  if (existing) { titleEl.value = existing.title; bodyEl.value = existing.body || ''; }   // set via JS (no attribute-escaping pitfalls)
  root.querySelector('[data-x]')?.addEventListener('click', close);
  setTimeout(() => titleEl.focus(), 30);
  // exec=true (create only, "Create & execute") → create the draft, then jump straight into the validate/run dialog.
  const submit = (exec: boolean): void => {
    const repoId = (root.querySelector('#tkRepo') as HTMLSelectElement).value;
    const title = titleEl.value.trim();
    const body = bodyEl.value.trim();
    if (!title) { toast('A title is required'); return; }
    const { provider, repo } = parseRepoId(repoId);
    if (existing) {
      // Changing the repo invalidates a prior validation / filed issue (they belonged to the old repo) → reset to draft.
      const repoChanged = provider !== existing.provider || repo !== existing.repo;
      upsertTask(repoChanged
        ? { ...existing, provider, repo, title, body, status: 'draft', result: undefined, issueNumber: undefined, issueUrl: undefined }
        : { ...existing, provider, repo, title, body });
      close(); toast('Task updated', true);
      return;
    }
    const id = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e7).toString(36)}`;
    const t: Task = { id, provider, repo, title, body, status: 'draft', ts: Date.now() };
    upsertTask(t); close();
    if (exec) void runValidate(t); else toast('Task created', true);
  };
  root.querySelector('[data-ok]')?.addEventListener('click', () => submit(false));
  root.querySelector('[data-exec]')?.addEventListener('click', () => submit(true));
}

let submitting = false;
async function runValidate(t: Task): Promise<void> {
  const dir = state.settings.workspace || '';
  const detected = await relay.agentsDetect().catch(() => ({} as Record<string, boolean>));
  const installed = AGENTS.filter((a) => detected[a.id]);
  const agentOk = installed.length > 0;
  let agentId = (state.settings.issueAgent && detected[state.settings.issueAgent]) ? state.settings.issueAgent! : (installed[0]?.id || '');
  const agentOpts = AGENTS.map((a) => `<option value="${a.id}"${a.id === agentId ? ' selected' : ''}${detected[a.id] ? '' : ' disabled'}>${esc(a.name)}${detected[a.id] ? '' : ' — not installed'}</option>`).join('');
  const primary = agentOk ? '⚡ Run validate' : 'Create worktree & open';
  // Dependency repos the validate agent may READ (linked read-only under .deps/) — the workspace's OTHER tracked repos.
  const depCandidates = ((state.settings.issueReposByWs || {})[wsKey()] || []).filter((id) => id !== `${t.provider}:${t.repo}`);
  const selectedDeps = new Set((t.deps || []).filter((id) => depCandidates.includes(id)));
  const seedBrief = () => validateBrief(t) + depsNote([...selectedDeps]);
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Validate task<small>${esc(t.title)}</small></span></div>
      <div class="bd">
        <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Assign to</label><select class="iss-agentsel" id="tkAgent"${agentOk ? '' : ' disabled'}>${agentOpts}</select></div>
        <div class="iss-agent ${agentOk ? 'ok' : 'no'}">${agentOk ? '✓ validates against the repo in an isolated worktree — no code changes, no PR' : '⚠ No coding agent on PATH — the worktree opens; install Claude Code (or Gemini / Codex / Aider) to auto-run.'}</div>
        ${depCandidates.length ? `<label class="iss-lbl">Dependencies <span class="mut">— read-only repos the agent can view under <code>.deps/</code></span></label>
        <div class="iss-deps" id="tkDeps">${depCandidates.map((id) => { const { repo: r } = parseRepoId(id); return `<label class="iss-dep"><input type="checkbox" value="${esc(id)}"${selectedDeps.has(id) ? ' checked' : ''}><b>${esc(r.split('/').pop() || r)}</b><span class="mut">${esc(id)}</span></label>`; }).join('')}</div>` : ''}
        <label class="iss-lbl">Validate brief <span class="mut">— edit before launch</span></label>
        <textarea class="iss-brief" spellcheck="false" rows="12" id="tkBrief">${esc(seedBrief())}</textarea>
        <div class="iss-wt">Checks out <code>${esc(t.repo)}</code> at its latest default branch and asks the agent to confirm this is real. <b>If valid → an issue is filed</b> with the result; if not, no issue is created.</div>
      </div>
      <div class="ft"><span class="hint">Validate-only — files an issue only on a valid verdict</span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-ok>${primary}</button></span></div>
    </div>`);
  const ta = root.querySelector('#tkBrief') as HTMLTextAreaElement;
  const okBtn = root.querySelector('[data-ok]') as HTMLButtonElement;
  const asel = root.querySelector('#tkAgent') as HTMLSelectElement | null;
  if (asel) asel.onchange = () => { agentId = asel.value; void relay.patchSettings({ issueAgent: agentId }); };
  let briefDirty = false;
  ta.oninput = () => { briefDirty = true; };
  root.querySelector('#tkDeps')?.addEventListener('change', () => {   // toggle a dependency → re-seed the .deps/ note (unless the brief was edited)
    selectedDeps.clear();
    root.querySelectorAll<HTMLInputElement>('#tkDeps input:checked').forEach((cb) => selectedDeps.add(cb.value));
    if (!briefDirty) ta.value = seedBrief();
  });
  root.querySelector('[data-x]')?.addEventListener('click', close);
  setTimeout(() => ta.focus(), 30);
  okBtn.addEventListener('click', async () => {
    if (submitting) return;
    submitting = true; okBtn.disabled = true; okBtn.textContent = 'Creating worktree…';
    const res = await relay.taskWorktreeAdd(t.provider as ProviderId, t.repo, dir, t.id, ta.value).catch(() => ({ ok: false, error: 'Worktree creation failed' }));
    submitting = false;
    // Launch even if the dialog was Escaped during creation — the worktree exists and the agent/brief/deps are
    // already captured; an accidental Escape must not silently drop the run (the success toast still fires).
    if (!res.ok) { okBtn.disabled = false; okBtn.textContent = primary; toast(res.error || 'Could not create worktree'); return; }
    const depIds = [...selectedDeps];
    if (depIds.length) { okBtn.textContent = 'Linking dependencies…'; await relay.linkDeps(res.path!, dir, depIds.map((id) => parseRepoId(id))).catch(() => null); }
    const briefRel = res.briefRel || '';
    await relay.pipelinePrep(res.path!, null, null, 0).catch(() => {});   // clear a stale verdict so a re-validate starts clean
    const agent = AGENTS.find((a) => a.id === agentId);
    upsertTask({ ...t, status: (agentOk && agent) ? 'validating' : t.status, agentId, deps: depIds });
    if (agentOk && agent) { running.set(t.id, { wt: res.path!, ws: wsKey(), provider: t.provider as ProviderId, repo: t.repo }); ensurePoll(); }
    deps.openAgentTab({ cwd: res.path!, name: `task: ${t.title.slice(0, 22)}`, runCmd: agent ? agent.launch(briefRel) : undefined });
    close();
    toast((agentOk && agent) ? 'Validating task…' : 'Worktree ready for the task', true);
  });
}

function openTaskDetails(t: Task): void {
  const filed = isFiled(t);   // already has a filed issue → don't offer Re-validate (would file a DUPLICATE); offer "Open issue" instead
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">${esc(t.title)}<small>${esc(t.repo)} · ${esc(STATUS_LABEL[t.status])}</small></span></div>
      <div class="bd">
        <div class="det-body">${t.body ? esc(t.body) : '<span class="mut">No description.</span>'}</div>
        ${t.result ? `<label class="iss-lbl">Validation result</label><div class="tk-result">${esc(t.result)}</div>` : ''}
        ${t.issueUrl ? `<div class="iss-wt">Filed as issue <a href="#" data-issue>#${t.issueNumber} ↗</a> — status: <b>${t.status === 'closed' ? 'closed' : 'open'}</b> (synced from the issue)</div>` : ''}
      </div>
      <div class="ft"><span class="hint"></span><span class="r"><button class="tpl-btn ghost" data-del>Delete</button><button class="tpl-btn ghost" data-edit>Edit</button>${filed ? `<button class="tpl-btn pri" data-open>Open issue #${t.issueNumber} ↗</button>` : `<button class="tpl-btn pri" data-run>${t.status === 'draft' ? '⚡ Validate' : '⟲ Re-validate'}</button>`}<button class="tpl-btn ghost" data-x>Close</button></span></div>
    </div>`);
  root.querySelector('[data-x]')?.addEventListener('click', close);
  root.querySelector('[data-issue]')?.addEventListener('click', (e) => { e.preventDefault(); if (t.issueUrl) relay.openExternal(t.issueUrl); });
  root.querySelector('[data-open]')?.addEventListener('click', () => { if (t.issueUrl) relay.openExternal(t.issueUrl); });
  root.querySelector('[data-del]')?.addEventListener('click', () => { close(); deleteTask(t.id); toast('Task deleted'); });
  root.querySelector('[data-edit]')?.addEventListener('click', () => { close(); openTaskForm(t); });
  root.querySelector('[data-run]')?.addEventListener('click', () => { close(); void runValidate(t); });
}

/* ----------------------------- render the rail ----------------------------- */
function render(): void {
  const el = $('#taskList'); if (!el) return;
  const list = tasksFor(wsKey());
  if (!list.length) { el.innerHTML = `<div class="isr-empty"><div class="isr-ei">📝</div><div>No tasks yet</div><div class="isr-es">Draft a proposed issue, validate it against the repo, and file it only if valid.</div></div>`; return; }
  el.innerHTML = list.map((t) => `<div class="tk-row" data-id="${esc(t.id)}">
      <div class="tk-body">
        <div class="tk-title">${esc(t.title)}</div>
        <div class="tk-meta"><span class="pr-repo-lbl"><span class="src-dot ${PROV_DOT[(t.provider as ProviderId)] || 'gh'}"></span>${esc(t.repo)}</span>${t.issueUrl ? `<span class="tk-issue" data-url="${esc(t.issueUrl)}" title="Open the filed issue">issue #${t.issueNumber} ↗</span>` : ''}</div>
        ${t.result ? `<div class="tk-result trunc">${esc(t.result)}</div>` : ''}
      </div>
      <div class="tk-side"><span class="tk-st ${t.status}">${esc(STATUS_LABEL[t.status])}</span></div>
    </div>`).join('');
  el.querySelectorAll<HTMLElement>('.tk-row').forEach((row) => {
    const t = list.find((x) => x.id === row.dataset.id); if (!t) return;
    row.onclick = (e) => {
      const issue = (e.target as HTMLElement).closest('.tk-issue') as HTMLElement | null;
      if (issue) { const u = issue.dataset.url; if (u) relay.openExternal(u); return; }
      openTaskDetails(t);
    };
  });
}

/* ----------------------------- wire-up ----------------------------- */
export function initTasks(d: TasksDeps): void {
  deps = d;
  const nw = $('#taskNew'); if (nw) nw.onclick = () => openTaskForm();
  render();
  // Resume filed-issue tracking after a reboot: the persisted status shows immediately; re-sync shortly after.
  ensureTracking();
  if (Object.values(state.settings.tasksByWs || {}).some((list) => (list || []).some(needsSync))) setTimeout(() => void trackIssues(), 8000);
}
export function renderTasks(): void { render(); }   // called on workspace switch so the list reflects the active ws
