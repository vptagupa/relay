// The Build rail — run a chosen pipeline against a SOURCE (a local project FOLDER, or a tracked REPO worktree),
// seeded by a free-form PROMPT instead of an issue/PR. A DI-seam feature module (like tasks.ts / pm-pipeline.ts):
// it owns the rail's state + DOM + a self-contained pipeline runner (stage advancement, the review⇄fix loop, an
// activity-based watchdog, late-verdict recovery, terminal reuse) and receives what it needs via initBuild(deps).
// It never imports back into renderer.ts.

import { state } from './state';
import { $, esc } from './dom';
import { toast } from './ui';
import { buildPipelines, buildPipelineById, nextEdge, stageIndexById, STOP, renderBrief, type PipelineDef, type BriefCtx } from './pipelines';
import { openPipelineBuilder } from './pipeline-editor';
import { AGENTS, redriveAgent, redrivePrompt } from './agents-list';

const relay = (window as any).relay;

export interface BuildDeps {
  openAgentTab: (o: { cwd: string; name: string; runCmd?: string }) => Promise<string>; // open a terminal tab in cwd, launching the agent; resolves to the tab id
  onAgentTabClosed: (cb: (tabId: string) => void) => void;                                // subscribe to terminal-closed → free the run holding a slot via that tab
  tabActivity: (tabId: string) => number | undefined;                                     // last-output ms of a stage's terminal → the watchdog's activity signal
  activeWsId: () => string;                                                                // active workspace id (tracked repos are per-workspace)
}
let deps: BuildDeps;
const wsKey = () => deps.activeWsId() || 'ws_default';
const customPipelines = (): PipelineDef[] => state.settings.pipelines || [];
let detected: Record<string, boolean> = {}; // agent id → installed on PATH

/* ----------------------------- runner state ----------------------------- */
type BuildStatus = 'idle' | 'queued' | 'working' | 'done' | 'failed';
const OCCUPYING: BuildStatus[] = ['working'];
interface BuildRun {
  id: string;                        // unique run id (also the repo worktree branch id: task-<id>)
  label: string;                     // short display label (folder / repo name)
  sourceKind: 'folder' | 'repo';
  provider?: string; repo?: string;  // repo source only
  wt: string;                        // working dir (the folder itself, or the created worktree)
  pipeline: PipelineDef;             // snapshot at execute time
  agentId: string;
  prompt: string;
  brief0Rel: string;                 // stage 0's brief file, already on disk
  stageIdx: number;
  agentTabId?: string;               // the CURRENT stage's terminal
  stageTabs?: Record<string, string>;// review⇄fix loop: stage id → its terminal, reused across rounds
  awaiting: boolean;                 // true while a GATE stage's verdict is being polled
  awaitingSince?: number;
  recoverStage?: number; recoverUntil?: number; // late-verdict recovery after a stall
  rounds?: number;                   // review→fix cycles so far (loop cap)
  lastReviewSummary?: string;        // latest review's concerns → injected into the next Fix brief
  reason?: string;                   // terminal outcome / stall explanation (shown in the run row)
}
const runs = new Map<string, BuildRun>();
const runStatus = new Map<string, BuildStatus>();
const CAP = (): number => Math.max(1, Math.min(8, Number(state.settings.issueConcurrency) || 2));
function workingCount(): number { let c = 0; for (const s of runStatus.values()) if (OCCUPYING.includes(s)) c++; return c; }

const MAX_REVIEW_ROUNDS = 5;
const STAGE_IDLE_MS = 15 * 60 * 1000;         // no terminal output for this long ⇒ treat as stuck
const STAGE_HARD_CAP_MS = 4 * 60 * 60 * 1000; // absolute ceiling regardless of activity
const RECOVER_GRACE_MS = 60 * 60 * 1000;      // after a stall, keep watching for a late verdict this long

function notify(title: string, body: string): void {
  try { if (state.settings.notifications && typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body: (body || '').slice(0, 180) }); } catch { /* best-effort */ }
}

// A stage's brief context — the PROMPT is the {issue} token; no issue number; closeStep only opens a PR for a repo.
function briefCtx(run: BuildRun, idx: number): BriefCtx {
  const closeStep = run.sourceKind === 'repo'
    ? 'open a pull request with your change (e.g. `gh pr create`) and describe what you did.'
    : 'summarize your change — this runs in a local folder, so do NOT open a pull request.';
  return { issue: run.prompt, number: 0, title: run.label, closeStep, base: '', source: '', verdictRel: `.slayer/stage-${idx}.json` };
}

/* ----------------------------- runner ----------------------------- */
async function launchStage(key: string, idx: number): Promise<void> {
  const run = runs.get(key); if (!run) return;
  const stage = run.pipeline.stages[idx]; if (!stage) return;
  run.stageIdx = idx; run.awaiting = false; run.reason = undefined; run.agentTabId = undefined;
  run.recoverStage = undefined; run.recoverUntil = undefined; // (re)launching supersedes any pending recovery
  runStatus.set(key, 'working');
  const briefRel = idx === 0 ? run.brief0Rel : `.slayer/stage-${idx}.md`;
  let brief = renderBrief(stage.brief, briefCtx(run, idx));
  // Auto-fix loop re-fix: hand the Fix stage the review's concerns.
  if (stage.kind === 'fix' && run.lastReviewSummary) brief += `\n\n---\n\n## Review concerns to address\n${run.lastReviewSummary}`;
  await relay.pipelinePrep(run.wt, idx === 0 ? null : briefRel, idx === 0 ? null : brief, idx).catch(() => {}); // write later-stage brief + clear its stale verdict
  if (!runs.has(key)) return;
  run.awaiting = !!stage.edges?.length;             // only a GATE stage (has edges) writes a verdict we poll for
  run.awaitingSince = run.awaiting ? Date.now() : undefined;
  const agent = AGENTS.find((a) => a.id === run.agentId);
  const existingTab = run.stageTabs?.[stage.id];
  if (existingTab && agent?.interactive) {          // loop re-entry → re-drive the live REPL, don't reopen a tab
    run.agentTabId = existingTab;
    redriveAgent(existingTab, redrivePrompt(stage.kind, briefRel));
    render(); ensureStagePoll();
    return;
  }
  void deps.openAgentTab({ cwd: run.wt, name: `${run.label} · ${stage.name.toLowerCase()}`, runCmd: agent ? agent.launch(briefRel) : undefined })
    .then((tabId) => { const r = runs.get(key); if (r && r.stageIdx === idx) { r.agentTabId = tabId; (r.stageTabs ||= {})[stage.id] = tabId; } })
    .catch(() => { /* tab open failed elsewhere */ });
  render(); ensureStagePoll();
}

// Apply a gate stage's verdict: advance to the next stage, or finalize the run. Shared by the awaiting + recovery polls.
async function advanceOnVerdict(key: string, run: BuildRun, v: { passed?: boolean; summary?: string }): Promise<void> {
  const fromStage = run.pipeline.stages[run.stageIdx];
  const edge = nextEdge(fromStage, !!v.passed);
  const target = edge && edge.to !== STOP ? stageIndexById(run.pipeline, edge.to) : -1;
  const summary = (v.summary || '').trim();
  if (edge && edge.to !== STOP && target >= 0) {
    const toStage = run.pipeline.stages[target];
    if (fromStage.kind === 'review') run.lastReviewSummary = summary || 'Changes requested.';
    if (fromStage.kind === 'review' && toStage.kind === 'fix') {
      run.rounds = (run.rounds || 0) + 1;
      if (run.rounds > MAX_REVIEW_ROUNDS) {
        run.reason = `Still has concerns after ${MAX_REVIEW_ROUNDS} review⇄fix rounds — needs a human.\n\n${summary}`;
        runStatus.set(key, 'failed');
        toast(`${run.label} — auto-fix stopped after ${MAX_REVIEW_ROUNDS} rounds`, false);
        notify(`Build ${run.label}: needs a human`, `Still has concerns after ${MAX_REVIEW_ROUNDS} rounds.`);
        render();
        return;
      }
    }
    toast(`${run.label} — ${fromStage.name} done; starting ${toStage.name}` + (toStage.kind === 'fix' && run.rounds ? ` (round ${run.rounds})` : ''), true);
    notify(`Build ${run.label}: ${toStage.name} starting`, fromStage.kind === 'review' ? summary : `${fromStage.name} done`);
    await launchStage(key, target);
  } else if (edge && edge.to === STOP && edge.when !== 'invalid') {
    run.reason = summary || 'Complete.'; runStatus.set(key, 'done');
    toast(`${run.label} — ${fromStage.name} passed; build complete`, true);
    notify(`Build ${run.label}: complete ✓`, summary || 'Done.'); render();
  } else if (edge && edge.to === STOP) {
    run.reason = summary || 'Stopped.'; runStatus.set(key, 'failed');
    toast(`${run.label} — stopped`); notify(`Build ${run.label}: stopped`, run.reason || ''); render();
  } else if (v.passed) {
    run.reason = summary || 'Done.'; runStatus.set(key, 'done'); render();
  } else {
    run.reason = summary || 'Stopped.'; runStatus.set(key, 'failed'); render();
  }
}

// Isolate a single run's poll failure — one bad run must never abort the pass or spin.
function pollFail(key: string, run: BuildRun | undefined, err: unknown): void {
  try { console.error('[build] pollStages failed for', run?.label, err); } catch { /* ignore */ }
  if (run) { run.awaiting = false; run.recoverStage = undefined; run.recoverUntil = undefined; run.reason = run.reason || 'Stopped after an internal error — re-run to retry.'; }
  try { runStatus.set(key, 'failed'); render(); } catch { /* render is likely what threw — never recurse */ }
}

let stageTimer: number | null = null;
function ensureStagePoll(): void {
  const active = [...runs.values()].some((r) => r.awaiting || r.recoverStage != null);
  if (active && stageTimer == null) stageTimer = window.setInterval(() => void pollStages(), 4000);
  else if (!active && stageTimer != null) { clearInterval(stageTimer); stageTimer = null; }
}
let polling = false;
async function pollStages(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    // ── awaiting gates: advance on a verdict, or trip the activity-based watchdog ──
    for (const [key, run] of [...runs.entries()].filter(([, r]) => r.awaiting)) {
      try {
        if (run.awaitingSince) {
          const act = run.agentTabId ? deps.tabActivity(run.agentTabId) : undefined;
          const idleFor = Date.now() - Math.max(run.awaitingSince, act || 0);
          const ranFor = Date.now() - run.awaitingSince;
          if (idleFor > STAGE_IDLE_MS || ranFor > STAGE_HARD_CAP_MS) {
            run.awaiting = false;
            run.recoverStage = run.stageIdx; run.recoverUntil = Date.now() + RECOVER_GRACE_MS;
            const why = ranFor > STAGE_HARD_CAP_MS ? `ran ${Math.round(STAGE_HARD_CAP_MS / 3600000)}h without a verdict` : `produced no output for ${Math.round(STAGE_IDLE_MS / 60000)}m`;
            run.reason = `${run.pipeline.stages[run.stageIdx].name} ${why} — the agent looks stuck. Take over from its terminal, or re-run. (If it's still working, its verdict will still be picked up.)`;
            runStatus.set(key, 'failed');
            toast(`${run.label} — ${run.pipeline.stages[run.stageIdx].name} stalled`, false);
            notify(`Build ${run.label}: stage stalled`, run.reason); render();
            continue;
          }
        }
        const v = await relay.pipelineVerdict(run.wt, run.stageIdx).catch(() => null);
        if (!runs.has(key) || !run.awaiting) continue;
        if (!v || !v.found) continue;
        run.awaiting = false; run.recoverStage = undefined; run.recoverUntil = undefined;
        await advanceOnVerdict(key, run, v);
      } catch (err) { pollFail(key, run, err); }
    }
    // ── late-verdict recovery ──
    for (const [key, run] of [...runs.entries()].filter(([, r]) => r.recoverStage != null && !r.awaiting)) {
      try {
        if (run.recoverUntil && Date.now() > run.recoverUntil) { run.recoverStage = undefined; run.recoverUntil = undefined; continue; }
        const v = await relay.pipelineVerdict(run.wt, run.recoverStage!).catch(() => null);
        if (!runs.has(key) || run.recoverStage == null) continue;
        if (!v || !v.found) continue;
        const e = nextEdge(run.pipeline.stages[run.recoverStage], !!v.passed);
        const willAdvance = !!(e && e.to !== STOP && stageIndexById(run.pipeline, e.to) >= 0);
        if (willAdvance && workingCount() >= CAP()) continue;
        run.stageIdx = run.recoverStage; run.recoverStage = undefined; run.recoverUntil = undefined; run.reason = undefined;
        toast(`${run.label} — verdict arrived after the stall; resuming`, true);
        notify(`Build ${run.label}: resuming`, 'A late verdict landed — continuing.');
        await advanceOnVerdict(key, run, v);
      } catch (err) { pollFail(key, run, err); }
    }
  } finally { polling = false; ensureStagePoll(); }
}

// A terminal closed. The live stage's tab closing means its agent is gone: a GATE stage (awaiting a verdict) was
// interrupted → failed; a TERMINAL stage (no edges, e.g. "Run") ran to completion → done.
function onAgentTabClosed(tabId: string): void {
  for (const [key, run] of runs) {
    let owned = run.agentTabId === tabId;
    if (run.stageTabs) for (const sid of Object.keys(run.stageTabs)) if (run.stageTabs[sid] === tabId) { delete run.stageTabs[sid]; owned = true; }
    if (!owned) continue;
    if (run.agentTabId === tabId && OCCUPYING.includes(runStatus.get(key) as BuildStatus)) {
      const terminal = !run.pipeline.stages[run.stageIdx]?.edges?.length;
      runStatus.set(key, terminal ? 'done' : 'failed');
      if (!terminal) run.reason = 'The agent terminal was closed before it finished.';
      run.awaiting = false; run.recoverStage = undefined;
      render(); ensureStagePoll();
    }
    return; // a tab belongs to one run
  }
}

/* ----------------------------- execute ----------------------------- */
let executing = false;
async function execute(): Promise<void> {
  if (executing) return;
  const kind = (state.settings.buildSourceKind || 'folder') as 'folder' | 'repo';
  const prompt = (($('#buildPrompt') as HTMLTextAreaElement | null)?.value || '').trim();
  if (!prompt) { toast('Write a prompt first', false); return; }
  const agentId = ($('#buildAgentSel') as HTMLSelectElement | null)?.value || '';
  if (!agentId || !detected[agentId]) { toast('No coding agent detected on PATH', false); return; }
  const pipeline = buildPipelineById(($('#buildPipeSel') as HTMLSelectElement | null)?.value, customPipelines());
  if (workingCount() >= CAP()) { toast(`At capacity (${CAP()} runs) — wait for one to finish`, false); return; }
  const dir = state.settings.workspace || '';
  const runId = `build-${Date.now().toString(36)}${Math.floor(Math.random() * 1e5).toString(36)}`;
  const exec = $('#buildExec') as HTMLButtonElement | null;
  executing = true; if (exec) { exec.disabled = true; exec.textContent = 'Preparing…'; }
  try {
    const brief0Ctx: BriefCtx = { issue: prompt, number: 0, title: '', closeStep: kind === 'repo' ? 'open a pull request with your change and describe what you did.' : 'summarize your change — do NOT open a pull request.', base: '', source: '', verdictRel: '.slayer/stage-0.json' };
    const brief0 = renderBrief(pipeline.stages[0].brief, brief0Ctx);
    let wt = '', brief0Rel = '', label = '', provider: string | undefined, repo: string | undefined;
    if (kind === 'folder') {
      const folder = state.settings.buildFolder || '';
      if (!folder) { toast('Pick a project folder first (Browse…)', false); return; }
      wt = folder; brief0Rel = '.slayer/build-0.md'; label = folder.split(/[\\/]/).filter(Boolean).pop() || 'folder';
      const p = await relay.pipelinePrep(wt, brief0Rel, brief0, 0).catch(() => ({ ok: false }));
      if (!p || !p.ok) { toast('Could not write the brief into that folder — is the path valid?', false); return; }
    } else {
      const id = state.settings.buildRepo || '';
      const m = /^(github|gitlab|bitbucket):(.+)$/.exec(id);
      if (!m) { toast('Pick a repository first', false); return; }
      provider = m[1]; repo = m[2].replace(/\/+$/, '').replace(/\.git$/i, ''); label = repo.split('/').pop() || repo;
      const res = await relay.taskWorktreeAdd(provider, repo, dir, runId, brief0).catch(() => ({ ok: false as const, error: 'Worktree creation failed' }));
      if (!res.ok || !res.path) { toast(res.error || 'Could not create the worktree', false); return; }
      wt = res.path; brief0Rel = res.briefRel || `.slayer/task-${runId}.md`;
    }
    const run: BuildRun = { id: runId, label, sourceKind: kind, provider, repo, wt, pipeline: JSON.parse(JSON.stringify(pipeline)), agentId, prompt, brief0Rel, stageIdx: 0, awaiting: false };
    runs.set(runId, run); runStatus.set(runId, 'working');
    void launchStage(runId, 0);
    const pta = $('#buildPrompt') as HTMLTextAreaElement | null; if (pta) pta.value = ''; // clear for the next run
    toast(`Building ${label} · ${pipeline.name}`, true);
    renderRuns();
  } finally { executing = false; if (exec) { exec.disabled = false; exec.textContent = '⚡ Execute'; } }
}

/* ----------------------------- rail render ----------------------------- */
const STATUS_LABEL: Record<BuildStatus, string> = { idle: '', queued: 'queued', working: 'working', done: 'done ✓', failed: 'stopped' };
function render(): void { renderRuns(); }
function renderRuns(): void {
  const el = $('#buildRuns'); if (!el) return;
  const list = [...runs.values()].sort((a, b) => (b.id < a.id ? -1 : 1)); // newest first (ids are time-ordered)
  if (!list.length) { el.innerHTML = ''; return; }
  el.innerHTML = list.map((r) => {
    const st = runStatus.get(r.id) || 'working';
    const stage = r.pipeline.stages[r.stageIdx];
    const sub = st === 'working' ? `${esc(stage?.name || '')}${r.rounds ? ` · round ${r.rounds}` : ''}` : (r.reason ? esc(r.reason.split('\n')[0]).slice(0, 120) : '');
    return `<div class="build-run" data-run="${esc(r.id)}" style="border:1px solid var(--line,#2a2e37);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px">
      <div style="display:flex;align-items:center;gap:8px"><b style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.label)}</b><span class="mut" style="font-size:11px">${esc(r.pipeline.name)}</span><span class="isr-st ${st}" style="margin-left:auto;font-size:11px">${esc(STATUS_LABEL[st] || st)}</span></div>
      ${sub ? `<div class="mut" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sub}</div>` : ''}
      ${(st === 'done' || st === 'failed') ? `<div style="margin-top:2px"><a href="#" data-dismiss="${esc(r.id)}" style="font-size:11px" class="mut">dismiss</a></div>` : ''}
    </div>`;
  }).join('');
  el.querySelectorAll<HTMLElement>('[data-dismiss]').forEach((a) => a.onclick = (e) => { e.preventDefault(); const id = a.dataset.dismiss!; runs.delete(id); runStatus.delete(id); renderRuns(); });
}

// (Re)build the source rows, agent + pipeline dropdowns from current state. Called on show + after picks change.
export function renderBuild(): void {
  const kind = (state.settings.buildSourceKind || 'folder') as 'folder' | 'repo';
  const seg = $('#buildSrcKind'); if (seg) seg.querySelectorAll<HTMLElement>('.iss-seg').forEach((b) => b.classList.toggle('on', b.dataset.sk === kind));
  const fRow = $('#buildFolderRow'); if (fRow) (fRow as HTMLElement).style.display = kind === 'folder' ? 'flex' : 'none';
  const rRow = $('#buildRepoRow'); if (rRow) (rRow as HTMLElement).style.display = kind === 'repo' ? 'block' : 'none';
  const fp = $('#buildFolderPath'); if (fp) { const f = state.settings.buildFolder || ''; fp.textContent = f || 'No folder selected'; fp.setAttribute('title', f); }
  // Repo dropdown = this workspace's tracked repos.
  const rsel = $('#buildRepoSel') as HTMLSelectElement | null;
  if (rsel) {
    const tracked = (state.settings.issueReposByWs || {})[wsKey()] || [];
    const cur = state.settings.buildRepo || tracked[0] || '';
    rsel.innerHTML = tracked.length
      ? tracked.map((id) => { const m = /^(github|gitlab|bitbucket):(.+)$/.exec(id); const r = m ? m[2] : id; return `<option value="${esc(id)}"${id === cur ? ' selected' : ''}>${esc(r)}</option>`; }).join('')
      : `<option value="">No tracked repos — add them in Issues → Sources</option>`;
    if (tracked.length && cur !== state.settings.buildRepo) void relay.patchSettings({ buildRepo: cur }).then((s: unknown) => { state.settings = s as typeof state.settings; });
  }
  // Agent dropdown.
  const asel = $('#buildAgentSel') as HTMLSelectElement | null;
  if (asel) {
    const cur = (state.settings.issueAgent && detected[state.settings.issueAgent]) ? state.settings.issueAgent! : (AGENTS.find((a) => detected[a.id])?.id || '');
    asel.innerHTML = AGENTS.map((a) => `<option value="${a.id}"${a.id === cur ? ' selected' : ''}${detected[a.id] ? '' : ' disabled'}>${esc(a.name)}${detected[a.id] ? '' : ' — not installed'}</option>`).join('');
  }
  // Pipeline dropdown + description.
  const psel = $('#buildPipeSel') as HTMLSelectElement | null;
  if (psel) {
    const cur = buildPipelineById(state.settings.buildPipeline, customPipelines());
    psel.innerHTML = buildPipelines(customPipelines()).map((p) => `<option value="${p.id}"${p.id === cur.id ? ' selected' : ''}>${esc(p.name)}${p.builtin ? '' : ' ✎'}</option>`).join('');
    const d = $('#buildPipeDesc'); if (d) d.textContent = cur.desc;
  }
  renderRuns();
}

/* ----------------------------- wire-up ----------------------------- */
export function initBuild(d: BuildDeps): void {
  deps = d;
  deps.onAgentTabClosed(onAgentTabClosed);
  void relay.agentsDetect().then((r: Record<string, boolean>) => { detected = r || {}; if (state.settings.sidebarView === 'build') renderBuild(); }).catch(() => {});

  $('#buildSrcKind')?.querySelectorAll<HTMLElement>('.iss-seg').forEach((b) => b.onclick = () => {
    const k = (b.dataset.sk === 'repo' ? 'repo' : 'folder') as 'folder' | 'repo';
    if ((state.settings.buildSourceKind || 'folder') === k) return;
    void relay.patchSettings({ buildSourceKind: k }).then((s: unknown) => { state.settings = s as typeof state.settings; renderBuild(); });
  });
  $('#buildBrowse')?.addEventListener('click', async () => {
    const path = await relay.pickFolder().catch(() => null);
    if (!path) return;
    state.settings = await relay.patchSettings({ buildFolder: path });
    renderBuild();
  });
  ($('#buildRepoSel') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
    void relay.patchSettings({ buildRepo: (e.target as HTMLSelectElement).value }).then((s: unknown) => { state.settings = s as typeof state.settings; });
  });
  ($('#buildAgentSel') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
    void relay.patchSettings({ issueAgent: (e.target as HTMLSelectElement).value });
  });
  ($('#buildPipeSel') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
    void relay.patchSettings({ buildPipeline: (e.target as HTMLSelectElement).value }).then((s: unknown) => { state.settings = s as typeof state.settings; const d2 = $('#buildPipeDesc'); if (d2) d2.textContent = buildPipelineById((e.target as HTMLSelectElement).value, customPipelines()).desc; });
  });
  $('#buildPipeBuild')?.addEventListener('click', () => {
    openPipelineBuilder(buildPipelineById(state.settings.buildPipeline, customPipelines()), (savedId) => {
      if (savedId) void relay.patchSettings({ buildPipeline: savedId }).then((s: unknown) => { state.settings = s as typeof state.settings; renderBuild(); });
      else renderBuild();
    });
  });
  $('#buildExec')?.addEventListener('click', () => void execute());
}
