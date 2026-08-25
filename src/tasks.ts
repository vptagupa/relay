// Tasks — draft a PROPOSED issue, VALIDATE it against the repo with a validate-only agent run, and file it as
// a real issue ONLY if the agent judges it valid. Invalid → no issue is created; the validation result is kept
// on the task instead. Reuses the issue VALIDATE_BRIEF + the generic pipeline:prep / pipeline:verdict IPC, and
// a dedicated task worktree (`task-<id>` off the latest default). DI-seam module: initTasks(deps).

import { state } from './state';
import { $, esc } from './dom';
import { toast, addSearch } from './ui';
import { stageBrief, renderBrief } from './pipelines';
import { AGENTS } from './agents-list';
import { dbCredOptions, dbCredNote, loadDbCreds, dbCredMetas } from './dbcreds';
import { authorBrief, reviewBrief, featureIssueBody, isFeatureTask, FEATURE_TAG } from './feature-spec';
import { repoDepsFor } from './repo-deps';
import { noteChecks, notesNote, defaultNoteIds } from './brief-notes';
import type { Task } from './shared/types';

const relay = (window as any).relay;
type ProviderId = 'github' | 'gitlab' | 'bitbucket';
const PROV_DOT: Record<ProviderId, string> = { github: 'gh', gitlab: 'gl', bitbucket: 'bb' };
const STATUS_LABEL: Record<Task['status'], string> = { draft: 'draft', validating: 'validating…', valid: 'issue open', open: 'issue open', closed: 'issue closed', invalid: 'not valid', error: 'error', authoring: 'authoring spec…', reviewing: 'reviewing spec…', revise: 'needs revision' };
// A task that filed an issue (for DISPLAY: show the issue link + open/closed chip).
const isFiled = (t: Task): boolean => !!t.issueNumber && (t.status === 'open' || t.status === 'closed' || t.status === 'valid');
// A filed task still worth POLLING: only OPEN (and legacy 'valid'). A 'closed' task is terminal, so we stop
// polling it — the poll load winds down as issues close and stops completely when none are open. (Reopens on the
// provider aren't re-tracked; closed is treated as final.)
const needsSync = (t: Task): boolean => !!t.issueNumber && (t.status === 'open' || t.status === 'valid');

export interface TasksDeps {
  activeWsId: () => string;                                                     // active workspace (tasks are per-workspace)
  openAgentTab: (o: { cwd: string; name: string; runCmd?: string; dbCredId?: string }) => Promise<string>;    // open the validate run in a worktree tab (dbCredId → inject a DB credential template into its env); resolves to the tab id
  onAgentTabClosed: (cb: (tabId: string) => void) => void;                      // subscribe to terminal-closed → auto-stop the run whose terminal that was
  pushToProvider?: (t: Task) => Promise<{ provider: string; projectId: string; taskKey: string } | null>; // "Push to integration": create/update this task in a PM provider; returns the link (pmRef) to store, or null
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
// A live run. `validate` = single stage 0 (bug/enhancement). `feature` = New Feature: stage 0 author → stage 1
// review; `stage` tracks which one is being polled. agentId/dbCredId are needed to launch the review stage.
interface Running { wt: string; ws: string; provider: ProviderId; repo: string; kind: 'validate' | 'feature'; stage: number; agentId: string; dbCredId?: string; agentTabId?: string; }
const running = new Map<string, Running>();   // taskId → its live run (in-memory; a restart drops it, re-run to resume)
const taskHead = (t: Task): string => `# ${t.title}\n\n${(t.body || '').trim() || '_(no description provided)_'}`;
// The validate brief for a task: {issue} = the proposed issue head; the agent writes its verdict to stage-0.json.
const validateBrief = (t: Task): string => renderBrief(stageBrief('validate', state.settings.stageBriefs), { issue: taskHead(t), number: 0, title: t.title, closeStep: '', verdictRel: '.slayer/stage-0.json' });
// Task type tags — ticking one injects type-appropriate validation guidance into the brief. Exported so the PM
// integration's Validate uses the SAME types + guidance as a local task (single source of truth).
export const TAG_DEFS: { id: string; label: string }[] = [{ id: 'bug', label: '🐛 Bug' }, { id: 'enhancement', label: '✨ Enhancement' }, { id: FEATURE_TAG, label: '🚀 New Feature' }];
const TAG_NOTE: Record<string, string> = {
  bug: `\n\n## Type: BUG\nTreat this as a bug report — confirm it's a REAL, REPRODUCIBLE defect in this repository: locate the code and reproduce it (run the path, or write a throwaway repro). passed=false if it's already fixed, not reproducible, or works as intended.`,
  enhancement: `\n\n## Type: ENHANCEMENT\nTreat this as an enhancement request — confirm it's a sensible improvement that ISN'T already implemented and fits this codebase: check it doesn't already exist, is feasible, and is concrete/actionable. passed=false if it already exists, is out of scope, or is too vague.`,
  // A local New-Feature task AUTHORS a spec (never validate/tagNote), so this note is only reached by the PM
  // integration, which validates every type (it doesn't author): confirm the feature is sound + not yet built.
  [FEATURE_TAG]: `\n\n## Type: NEW FEATURE\nTreat this as a new-feature request — confirm it's a sensible feature that ISN'T already implemented, fits this codebase, and is concrete/actionable. passed=false if it already exists, is out of scope, or is too vague to build.`,
};
export const tagNote = (tags: string[]): string => tags.map((t) => TAG_NOTE[t] || '').join('');
const tagChecks = (selected: Set<string>): string => TAG_DEFS.map((d) => `<label class="tk-tag"><input type="checkbox" data-tag="${d.id}"${selected.has(d.id) ? ' checked' : ''}> ${d.label}</label>`).join('');
// The .deps/ reference note appended to the brief when dependency repos are selected (same as the issue Assign).
// Exported so the integration Validate dialog (pm-ui) appends the identical note.
export function depsNote(ids: string[]): string {
  if (!ids.length) return '';
  const lines = ids.map((id) => { const { repo: r } = parseRepoId(id); return `- \`.deps/${r.split('/').pop()}\` — ${id}`; }).join('\n');
  return `\n\n---\n\n## Reference repositories (read-only — do NOT modify these)\nThese related repos are checked out under \`.deps/\` for context while you validate:\n${lines}\nRead them to understand interfaces/contracts.`;
}

let pollTimer: number | null = null;
function ensurePoll(): void {
  if (running.size && pollTimer == null) pollTimer = window.setInterval(() => void poll(), 4000);
  else if (!running.size && pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
}
// Human names for a task's type tags: for the issue BODY, and the real provider LABELS applied to the new issue.
const TYPE_NAME: Record<string, string> = { bug: 'Bug', enhancement: 'Enhancement', [FEATURE_TAG]: 'New Feature' };
// Exported so the integration Validate flow (pm-pipeline) labels its filed issue with the exact same names.
export const LABEL_NAME: Record<string, string> = { bug: 'bug', enhancement: 'enhancement', [FEATURE_TAG]: 'feature' };
// A "Task details" block appended to the filed issue's body so the issue records the task's type + context.
// Exported (as `detailsBlock`) so the integration Validate flow builds the identical block from its own tags/deps.
export function detailsBlock(tags: string[] | undefined, deps: string[] | undefined): string {
  const types = (tags || []).map((tg) => TYPE_NAME[tg]).filter(Boolean);
  const rows: string[] = [];
  if (types.length) rows.push(`- **Type:** ${types.join(', ')}`);
  if (deps && deps.length) rows.push(`- **Related repositories:** ${deps.map((d) => `\`${d}\``).join(', ')}`);
  return rows.length ? `\n\n---\n### Task details\n${rows.join('\n')}` : '';
}
const taskDetailsBlock = (t: Task): string => detailsBlock(t.tags, t.deps);

// File an issue for a passed task and reflect the outcome (shared by validate + feature). Deletes-before-await
// happened in the caller; here we createIssue, apply the task's type as real labels (best-effort), + upsert.
async function fileIssueFor(t: Task, r: Running, body: string, resultSummary: string): Promise<void> {
  const res = await relay.providerCreateIssue(r.ws, r.provider, r.repo, t.title, body).catch(() => ({ ok: false, error: 'request failed' }));
  if (res.ok) {
    upsertTask({ ...t, status: 'open', result: resultSummary, issueNumber: res.number, issueUrl: res.url, ranAt: Date.now() }, r.ws, false);
    // Tag the new issue with its type on the provider (best-effort — a label failure must never unfile the issue).
    if (res.number) for (const tg of t.tags || []) { const name = LABEL_NAME[tg]; if (name) void relay.providerAddLabel(r.ws, r.provider, r.repo, res.number, name).catch(() => {}); }
    toast(`Filed issue #${res.number} (open)`, true); ensureTracking();
  } else { upsertTask({ ...t, status: 'error', result: `Approved ✓ but filing the issue failed: ${res.error || 'unknown'}\n\n${resultSummary}`, ranAt: Date.now() }, r.ws, false); toast(`Couldn't file the issue: ${res.error || ''}`); }
}

let polling = false;
async function poll(): Promise<void> {
  if (polling) return; polling = true;
  try {
    for (const [id, r] of [...running.entries()]) {
      const v = await relay.pipelineVerdict(r.wt, r.stage).catch(() => null);
      if (!running.has(id) || !v || !v.found) continue;          // verdict not written yet — keep polling
      const t = tasksFor(r.ws).find((x) => x.id === id);
      const summary = (v.summary || '').trim();

      // --- New Feature: stage 0 author → stage 1 review → file issue ---
      if (r.kind === 'feature') {
        if (r.stage === 0) {
          // Author stage finished. On success advance to the REVIEW stage (keep the run alive at stage 1).
          if (!t) { running.delete(id); continue; }
          if (!v.passed) { running.delete(id); upsertTask({ ...t, status: 'error', result: summary || 'Could not author the spec.', ranAt: Date.now() }, r.ws, false); toast('Spec authoring failed'); continue; }
          const reviewRel = '.slayer/stage-1.md';
          await relay.pipelinePrep(r.wt, reviewRel, reviewBrief(t), 1).catch(() => {}); // write the review brief + clear its stale verdict
          r.stage = 1; r.agentTabId = undefined; running.set(id, r);   // rebound once the review tab opens
          upsertTask({ ...t, status: 'reviewing', result: summary || 'Spec authored.', ranAt: Date.now() }, r.ws, false);
          const agent = AGENTS.find((a) => a.id === r.agentId);
          void deps.openAgentTab({ cwd: r.wt, name: `review: ${t.title.slice(0, 20)}`, runCmd: agent ? agent.launch(reviewRel) : undefined, dbCredId: r.dbCredId })
            .then((tid) => { const rr = running.get(id); if (rr && rr.stage === 1) rr.agentTabId = tid; }).catch(() => {});
          toast('Spec authored → reviewing…', true);
          continue;
        }
        // Review stage finished.
        running.delete(id);
        if (!t) continue;
        if (v.passed) await fileIssueFor(t, r, featureIssueBody(t, summary || 'Reviewed and approved.') + taskDetailsBlock(t), summary || 'Spec reviewed ✓ — correct, complete, concrete, consistent, aligned.');
        else { upsertTask({ ...t, status: 'revise', result: summary || 'Review found gaps — revise the spec and re-run.', ranAt: Date.now() }, r.ws, false); toast('Spec needs revision'); }
        continue;
      }

      // --- validate (bug / enhancement / untagged): single stage ---
      running.delete(id);
      if (!t) continue;
      const vsum = summary || (v.passed ? 'Validated as real.' : 'Judged not valid.');
      if (v.passed) await fileIssueFor(t, r, `${(t.body || '').trim()}${taskDetailsBlock(t)}\n\n---\n**Validated by Slayer T** — confirmed against the codebase before filing:\n\n${vsum}`, vsum);
      else { upsertTask({ ...t, status: 'invalid', result: vsum, ranAt: Date.now() }, r.ws, false); toast('Task not valid — no issue filed'); }
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
  // Overlay/scrim click does NOT close — a stray click outside the card must not discard the form. Close via the
  // dialog's own button (or Escape). The scrim stays as the dimmed backdrop.
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
  const selectedTags = new Set(existing?.tags || []);
  let webResearch = existing?.webResearch ?? true;   // New Feature: research global brands (default on)
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">${existing ? 'Edit task' : 'New task'}</span></div>
      <div class="bd">
        <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Repository</label><select class="iss-agentsel" id="tkRepo">${repoOpts}</select></div>
        <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Type</label><div class="tk-tags" id="tkTags">${tagChecks(selectedTags)}</div></div>
        <div class="tk-featopts" id="tkFeatOpts" style="display:${selectedTags.has(FEATURE_TAG) ? 'block' : 'none'}">
          <label class="tk-tag"><input type="checkbox" id="tkWebResearch"${webResearch ? ' checked' : ''}> 🔎 Do a web research <span class="mut">— study how global brands solve it</span></label>
        </div>
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
  root.querySelector('#tkTags')?.addEventListener('change', () => {
    selectedTags.clear(); root.querySelectorAll<HTMLInputElement>('#tkTags input:checked').forEach((cb) => selectedTags.add(cb.dataset.tag!));
    const opts = root.querySelector('#tkFeatOpts') as HTMLElement | null; if (opts) opts.style.display = selectedTags.has(FEATURE_TAG) ? 'block' : 'none'; // reveal New Feature options
  });
  root.querySelector('#tkWebResearch')?.addEventListener('change', (e) => { webResearch = (e.target as HTMLInputElement).checked; });
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
      const tags = [...selectedTags];
      const wr = selectedTags.has(FEATURE_TAG) ? webResearch : undefined;
      upsertTask(repoChanged
        ? { ...existing, provider, repo, title, body, tags, webResearch: wr, status: 'draft', result: undefined, issueNumber: undefined, issueUrl: undefined }
        : { ...existing, provider, repo, title, body, tags, webResearch: wr });
      close(); toast('Task updated', true);
      return;
    }
    const id = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e7).toString(36)}`;
    const t: Task = { id, provider, repo, title, body, tags: [...selectedTags], webResearch: selectedTags.has(FEATURE_TAG) ? webResearch : undefined, status: 'draft', ts: Date.now() };
    upsertTask(t); close();
    if (exec) void runValidate(t); else toast('Task created', true);
  };
  root.querySelector('[data-ok]')?.addEventListener('click', () => submit(false));
  root.querySelector('[data-exec]')?.addEventListener('click', () => submit(true));
}

let submitting = false;
async function runValidate(t: Task): Promise<void> {
  const dir = state.settings.workspace || '';
  await loadDbCreds();   // refresh the saved DB credential templates so the picker is current
  const detected = await relay.agentsDetect().catch(() => ({} as Record<string, boolean>));
  const installed = AGENTS.filter((a) => detected[a.id]);
  const agentOk = installed.length > 0;
  let agentId = (state.settings.issueAgent && detected[state.settings.issueAgent]) ? state.settings.issueAgent! : (installed[0]?.id || '');
  const agentOpts = AGENTS.map((a) => `<option value="${a.id}"${a.id === agentId ? ' selected' : ''}${detected[a.id] ? '' : ' disabled'}>${esc(a.name)}${detected[a.id] ? '' : ' — not installed'}</option>`).join('');
  const feature = isFeatureTask(t);   // New Feature → author-spec brief + a review stage; otherwise validate-only
  const primary = agentOk ? (feature ? '🚀 Author spec' : '⚡ Run validate') : 'Create worktree & open';
  const dlgTitle = feature ? 'Author feature spec' : 'Validate task';
  const agentOkNote = feature ? '✓ authors a spec + styled artifact under docs/features/ in an isolated worktree, then reviews it' : '✓ validates against the repo in an isolated worktree — no code changes, no PR';
  const briefLabel = feature ? 'Author brief' : 'Validate brief';
  const footHint = feature ? 'Author → review → files an issue on a passing review' : 'Validate-only — files an issue only on a valid verdict';
  const wtNote = feature
    ? `Checks out <code>${esc(t.repo)}</code>, writes the spec + artifact under <code>docs/features/</code>, then a review stage gates it against the 5 C's. <b>On a passing review → an issue is filed</b>.`
    : `Checks out <code>${esc(t.repo)}</code> at its latest default branch and asks the agent to confirm this is real. <b>If valid → an issue is filed</b> with the result; if not, no issue is created.`;
  // Dependency repos the validate agent may READ (linked read-only under .deps/) — the workspace's OTHER tracked repos.
  const depCandidates = ((state.settings.issueReposByWs || {})[wsKey()] || []).filter((id) => id !== `${t.provider}:${t.repo}`);
  const savedDeps = t.deps || [];
  const initialDeps = savedDeps.length ? savedDeps : repoDepsFor(`${t.provider}:${t.repo}`); // no saved deps → default to this repo's dependency template
  const selectedDeps = new Set(initialDeps.filter((id) => depCandidates.includes(id)));
  let selectedDbCred = t.dbCredId || '';   // DB credential template injected into the run's env
  const selectedNotes = new Set(defaultNoteIds());   // configurable brief notes (Settings) — default-on ones pre-checked
  const seedBrief = () => (feature ? authorBrief(t, { webResearch: t.webResearch !== false }) : validateBrief(t) + tagNote(t.tags || [])) + depsNote([...selectedDeps]) + dbCredNote(selectedDbCred) + notesNote([...selectedNotes]);
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">${dlgTitle}<small>${esc(t.title)}</small></span></div>
      <div class="bd">
        <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Assign to</label><select class="iss-agentsel" id="tkAgent"${agentOk ? '' : ' disabled'}>${agentOpts}</select></div>
        <div class="iss-agent ${agentOk ? 'ok' : 'no'}">${agentOk ? agentOkNote : '⚠ No coding agent on PATH — the worktree opens; install Claude Code (or Gemini / Codex / Aider) to auto-run.'}</div>
        ${depCandidates.length ? `<label class="iss-lbl">Dependencies <span class="mut">— read-only repos the agent can view under <code>.deps/</code></span></label>
        <div class="iss-deps" id="tkDeps">${depCandidates.map((id) => { const { repo: r } = parseRepoId(id); return `<label class="iss-dep"><input type="checkbox" value="${esc(id)}"${selectedDeps.has(id) ? ' checked' : ''}><b>${esc(r.split('/').pop() || r)}</b><span class="mut">${esc(id)}</span></label>`; }).join('')}</div>` : ''}
        ${dbCredMetas().length ? `<div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Database</label><select class="iss-agentsel" id="tkDb">${dbCredOptions(selectedDbCred)}</select></div>` : ''}
        ${noteChecks(selectedNotes)}
        <label class="iss-lbl">${briefLabel} <span class="mut">— edit before launch</span></label>
        <textarea class="iss-brief" spellcheck="false" rows="12" id="tkBrief">${esc(seedBrief())}</textarea>
        <div class="iss-wt">${wtNote}</div>
      </div>
      <div class="ft"><span class="hint">${footHint}</span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-ok>${primary}</button></span></div>
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
  addSearch(root.querySelector('#tkDeps'), 'Search dependency repos…'); // filter a long dependency-repo list
  const dbSel = root.querySelector('#tkDb') as HTMLSelectElement | null;   // pick a DB credential template → re-seed the DB note (unless edited)
  if (dbSel) dbSel.onchange = () => { selectedDbCred = dbSel.value; if (!briefDirty) ta.value = seedBrief(); };
  root.querySelector('#bnChecks')?.addEventListener('change', () => {   // toggle a brief note → re-seed (unless the brief was edited)
    selectedNotes.clear();
    root.querySelectorAll<HTMLInputElement>('#bnChecks input:checked').forEach((cb) => selectedNotes.add(cb.dataset.note!));
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
    const runningStatus: Task['status'] = feature ? 'authoring' : 'validating';
    upsertTask({ ...t, status: (agentOk && agent) ? runningStatus : t.status, agentId, deps: depIds, dbCredId: selectedDbCred || undefined });
    if (agentOk && agent) { running.set(t.id, { wt: res.path!, ws: wsKey(), provider: t.provider as ProviderId, repo: t.repo, kind: feature ? 'feature' : 'validate', stage: 0, agentId, dbCredId: selectedDbCred || undefined }); ensurePoll(); }
    void deps.openAgentTab({ cwd: res.path!, name: `${feature ? 'spec' : 'task'}: ${t.title.slice(0, 20)}`, runCmd: agent ? agent.launch(briefRel) : undefined, dbCredId: selectedDbCred || undefined })
      .then((tid) => { const r = running.get(t.id); if (r && r.stage === 0) r.agentTabId = tid; }).catch(() => {});
    close();
    toast((agentOk && agent) ? (feature ? 'Authoring feature spec…' : 'Validating task…') : 'Worktree ready', true);
  });
}

function openTaskDetails(t: Task): void {
  const filed = isFiled(t);   // already has a filed issue → don't offer a re-run (would file a DUPLICATE); offer "Open issue" instead
  const feature = isFeatureTask(t);
  const inProgress = t.status === 'validating' || t.status === 'authoring' || t.status === 'reviewing'; // a stage is live — don't offer to re-run
  const runLabel = feature ? (t.status === 'draft' ? '🚀 Author spec' : '⟲ Re-author') : (t.status === 'draft' ? '⚡ Validate' : '⟲ Re-validate');
  const resultLabel = feature ? 'Spec / review result' : 'Validation result';
  const stopWord = feature ? (t.status === 'reviewing' ? 'review' : 'authoring') : 'validating';
  const action = filed ? `<button class="tpl-btn pri" data-open>Open issue #${t.issueNumber} ↗</button>`
    : inProgress ? `<button class="tpl-btn pri" data-stop title="Stop this run and reset the task so you can re-run it">■ Stop ${stopWord}</button>`
    : `<button class="tpl-btn pri" data-run>${runLabel}</button>`;
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">${esc(t.title)}<small>${esc(t.repo)} · ${esc(STATUS_LABEL[t.status])}</small></span></div>
      <div class="bd">
        <div class="det-body">${t.body ? esc(t.body) : '<span class="mut">No description.</span>'}</div>
        ${t.result ? `<label class="iss-lbl">${resultLabel}</label><div class="tk-result">${esc(t.result)}</div>` : ''}
        ${t.issueUrl ? `<div class="iss-wt">Filed as issue <a href="#" data-issue>#${t.issueNumber} ↗</a> — status: <b>${t.status === 'closed' ? 'closed' : 'open'}</b> (synced from the issue)</div>` : ''}
      </div>
      <div class="ft"><span class="hint">${t.pmRef ? `<span class="mut">↑ linked to ${esc(t.pmRef.provider)} ${esc(t.pmRef.taskKey)}</span>` : ''}</span><span class="r"><button class="tpl-btn ghost" data-term style="display:none">⧉ Open terminal</button>${deps.pushToProvider && !t.pmRef ? `<button class="tpl-btn ghost" data-push title="Create this task in a connected integration">↑ Push</button>` : ''}<button class="tpl-btn ghost" data-del>Delete</button><button class="tpl-btn ghost" data-edit>Edit</button>${action}<button class="tpl-btn ghost" data-x>Close</button></span></div>
    </div>`);
  root.querySelector('[data-x]')?.addEventListener('click', close);
  // ↑ Push this local task to a PM provider (Echo…) — only shown while UNLINKED. Once pushed it stores the link
  // and the button becomes a static "pushed" indicator (no re-push / update).
  root.querySelector('[data-push]')?.addEventListener('click', async () => {
    const ref = await deps.pushToProvider?.(t);
    if (ref) { const cur = tasksFor(wsKey()).find((x) => x.id === t.id) || t; upsertTask({ ...cur, pmRef: ref }); close(); }
  });
  root.querySelector('[data-issue]')?.addEventListener('click', (e) => { e.preventDefault(); if (t.issueUrl) relay.openExternal(t.issueUrl); });
  root.querySelector('[data-open]')?.addEventListener('click', () => { if (t.issueUrl) relay.openExternal(t.issueUrl); });
  root.querySelector('[data-del]')?.addEventListener('click', () => { close(); deleteTask(t.id); toast('Task deleted'); });
  root.querySelector('[data-edit]')?.addEventListener('click', () => { close(); openTaskForm(t); });
  root.querySelector('[data-run]')?.addEventListener('click', () => { close(); void runValidate(t); });
  // ■ Stop — cancel a live run (or clear a stuck one whose terminal/app was closed) and reset to draft so the
  // task is runnable again. The orphaned agent tab, if still open, just finishes into a verdict nobody polls.
  root.querySelector('[data-stop]')?.addEventListener('click', () => {
    running.delete(t.id); ensurePoll();
    const cur = tasksFor(wsKey()).find((x) => x.id === t.id) || t;
    upsertTask({ ...cur, status: 'draft' });
    close(); toast('Stopped — task reset to draft');
  });
  // ⧉ Reopen a terminal in this task's existing worktree (survives a closed tab / crash / quit). Shown only if it exists.
  const termBtn = root.querySelector<HTMLElement>('[data-term]');
  if (termBtn) void relay.worktreesList(t.provider as ProviderId, t.repo, state.settings.workspace || '').then((res: { ok: boolean; list: { branch: string; path: string }[] }) => {
    const wt = res.ok ? res.list.find((w: { branch: string; path: string }) => w.branch === `task-${t.id}`)?.path : undefined;
    if (wt) { termBtn.style.display = ''; termBtn.onclick = () => { close(); deps.openAgentTab({ cwd: wt, name: `task: ${t.title.slice(0, 20)}` }); }; }
  }).catch(() => { /* best-effort */ });
}

/* ----------------------------- render the rail ----------------------------- */
let taskRepoFilter = '';   // '' = all repos; else "provider:repo" — a client-side filter of the local task list
const taskRepoId = (t: Task): string => `${t.provider}:${t.repo}`;
function render(): void {
  const el = $('#taskList'); if (!el) return;
  const all = tasksFor(wsKey());
  if (taskRepoFilter && !all.some((t) => taskRepoId(t) === taskRepoFilter)) taskRepoFilter = ''; // drop a stale filter (ws switch / deletion)
  const repoEl = $('#taskRepo');
  if (repoEl) {
    (repoEl as HTMLElement).style.display = all.length ? '' : 'none';
    repoEl.textContent = `${taskRepoFilter ? parseRepoId(taskRepoFilter).repo : 'All repos'} ▾`;
  }
  if (!all.length) { el.innerHTML = `<div class="isr-empty"><div class="isr-ei">📝</div><div>No tasks yet</div><div class="isr-es">Draft a proposed issue, validate it against the repo, and file it only if valid.</div></div>`; return; }
  const list = taskRepoFilter ? all.filter((t) => taskRepoId(t) === taskRepoFilter) : all;
  if (!list.length) { el.innerHTML = `<div class="isr-empty"><div class="isr-ei">🗂️</div><div>No tasks for this repo</div><div class="isr-es">Switch the repo filter back to All.</div></div>`; return; }
  el.innerHTML = list.map((t) => `<div class="tk-row" data-id="${esc(t.id)}">
      <div class="tk-body">
        <div class="tk-title">${esc(t.title)}</div>
        <div class="tk-meta"><span class="pr-repo-lbl"><span class="src-dot ${PROV_DOT[(t.provider as ProviderId)] || 'gh'}"></span>${esc(t.repo)}</span>${(t.tags || []).map((tg) => `<span class="tk-tagchip ${esc(tg)}">${esc(tg === FEATURE_TAG ? 'feature' : tg)}</span>`).join('')}${t.issueUrl ? `<span class="tk-issue" data-url="${esc(t.issueUrl)}" title="Open the filed issue">issue #${t.issueNumber} ↗</span>` : ''}</div>
        ${t.result ? `<div class="tk-result trunc">${esc(t.result)}</div>` : ''}
      </div>
      <div class="tk-side">${t.pmRef ? `<span class="tk-pushed" title="Pushed to ${esc(t.pmRef.provider)} · ${esc(t.pmRef.taskKey)}">↑ pushed</span>` : (deps.pushToProvider ? `<button class="tk-push" data-push title="Push to a connected integration">↑</button>` : '')}<span class="tk-st ${t.status}">${esc(STATUS_LABEL[t.status])}</span></div>
    </div>`).join('');
  el.querySelectorAll<HTMLElement>('.tk-row').forEach((row) => {
    const t = list.find((x) => x.id === row.dataset.id); if (!t) return;
    row.onclick = async (e) => {
      const issue = (e.target as HTMLElement).closest('.tk-issue') as HTMLElement | null;
      if (issue) { const u = issue.dataset.url; if (u) relay.openExternal(u); return; }
      const push = (e.target as HTMLElement).closest('.tk-push') as HTMLElement | null;
      if (push) { e.stopPropagation(); const ref = await deps.pushToProvider?.(t); if (ref) { const cur = tasksFor(wsKey()).find((x) => x.id === t.id) || t; upsertTask({ ...cur, pmRef: ref }); } return; } // ↑ push this task to a provider from the list
      openTaskDetails(t);
    };
  });
}

// Repo filter dropdown — the distinct repos among the workspace's tasks, plus "All repos". Client-side (tasks are local).
function closeTaskRepoMenu(): void { document.getElementById('taskRepoMenu')?.remove(); }
function openTaskRepoMenu(): void {
  const btn = $('#taskRepo'); if (!btn) return;
  if (document.getElementById('taskRepoMenu')) { closeTaskRepoMenu(); return; }
  const repos = [...new Set(tasksFor(wsKey()).map(taskRepoId))].sort();
  const allRow = `<button class="iss-mi ${!taskRepoFilter ? 'on' : ''}" data-repo=""><span class="d">⌂</span> All repos</button>`;
  const rows = repos.map((id) => { const { provider: p, repo: r } = parseRepoId(id); return `<button class="iss-mi ${taskRepoFilter === id ? 'on' : ''}" data-repo="${esc(id)}"><span class="d src-dot ${PROV_DOT[(p as ProviderId)] || 'gh'}"></span> ${esc(r)}</button>`; }).join('');
  const menu = document.createElement('div'); menu.className = 'iss-menu'; menu.id = 'taskRepoMenu';
  menu.innerHTML = allRow + (rows ? `<div class="iss-menu-list">${rows}</div>` : '');
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect(); menu.style.left = Math.round(r.left) + 'px'; menu.style.top = Math.round(r.bottom + 4) + 'px';
  menu.querySelectorAll<HTMLElement>('.iss-mi').forEach((mi) => {
    mi.onclick = (e) => { e.stopPropagation(); closeTaskRepoMenu(); taskRepoFilter = mi.dataset.repo || ''; render(); };
  });
  setTimeout(() => document.addEventListener('click', closeTaskRepoMenu, { once: true }), 0);
}

/* ----------------------------- wire-up ----------------------------- */
// On boot the in-memory `running` map is empty, so any task PERSISTED as in-progress has no live run behind it —
// its agent died with the previous session and its verdict will never arrive, so it would show "validating…"
// forever with no way forward. Reset those (across all workspaces) to draft so they're runnable again. (Within a
// session, a killed terminal is handled by the Stop button in Details.)
function recoverStuckTasks(): void {
  const wip = (s: Task['status']): boolean => s === 'validating' || s === 'authoring' || s === 'reviewing';
  const byWs = { ...(state.settings.tasksByWs || {}) };
  let n = 0, changed = false;
  for (const [ws, list] of Object.entries(byWs)) {
    if (!list?.some((t) => wip(t.status))) continue;
    byWs[ws] = list.map((t) => wip(t.status) ? (n++, { ...t, status: 'draft' as Task['status'] }) : t);
    changed = true;
  }
  if (changed) { state.settings.tasksByWs = byWs; void saveTasks(byWs); }
  if (n) toast(`Reset ${n} interrupted validation${n > 1 ? 's' : ''} — re-run when ready`);
}

// A terminal closed: if it was a live run's tab, the agent is gone (an unsaved shell is killed on close) → reset
// the task to draft so it doesn't sit stuck at "validating…" and is runnable again. (The Details ■ Stop button
// still covers a run whose tab you kept open.)
function onAgentTabClosed(tabId: string): void {
  for (const [id, r] of running) {
    if (r.agentTabId !== tabId) continue;
    running.delete(id); ensurePoll();
    const t = tasksFor(r.ws).find((x) => x.id === id);
    if (t) { upsertTask({ ...t, status: 'draft' }, r.ws, false); toast(`Stopped “${t.title.slice(0, 24)}” — its terminal was closed`); }
    return;
  }
}

export function initTasks(d: TasksDeps): void {
  deps = d;
  deps.onAgentTabClosed(onAgentTabClosed);   // closing a validate/author terminal auto-resets the task to draft
  const nw = $('#taskNew'); if (nw) nw.onclick = () => openTaskForm();
  const rsel = $('#taskRepo'); if (rsel) rsel.onclick = (e) => { e.stopPropagation(); openTaskRepoMenu(); };
  recoverStuckTasks();   // clear any "validating…" left stuck by a previous session before the first render
  render();
  // Resume filed-issue tracking after a reboot: the persisted status shows immediately; re-sync shortly after.
  ensureTracking();
  if (Object.values(state.settings.tasksByWs || {}).some((list) => (list || []).some(needsSync))) setTimeout(() => void trackIssues(), 8000);
}
export function renderTasks(): void { render(); }   // called on workspace switch so the list reflects the active ws
