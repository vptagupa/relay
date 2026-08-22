// PM task → VALIDATION. Runs a synced project-management task (Echo, …) through the same single-stage VALIDATE
// agent run as a local task — in a git worktree of the repo its project is mapped to — and writes the verdict
// back to the provider (a "working" status on launch; a "validated" status + the summary on a valid verdict).
// It does NOT fix or open a PR: the integration action is validation only, matching the local task's Validate.
// A dedicated renderer-side runner (reusing pipelines.ts + the worktree/pipeline IPCs), so issues.ts stays
// untouched. The worktree machinery auto-clones a mapped repo that isn't the open folder.

import { state } from './state';
import { stageBrief, nextEdge, stageIndexById, STOP, renderBrief, type PipelineDef, type BriefCtx } from './pipelines';
import { AGENTS } from './agents-list';
import { toast } from './ui';

const relay = (window as any).relay;

// The fixed VALIDATE-only pipeline every integration run uses: one gated `validate` stage (its verdict decides
// valid/invalid), no fix/review/PR. Uses the same validate brief as local tasks (honoring the Settings override).
const validatePipeline = (): PipelineDef => ({
  id: 'pm-validate', name: 'Validate', builtin: true, desc: 'Validate a synced task against its repo.',
  stages: [{ id: 'validate', name: 'Validate', kind: 'validate', brief: stageBrief('validate', state.settings.stageBriefs), edges: [{ when: 'valid', to: STOP }, { when: 'invalid', to: STOP }], x: 0, y: 0 }],
});

export interface PmPipeDeps {
  openAgentTab: (o: { cwd: string; name: string; runCmd?: string; dbCredId?: string }) => Promise<string>;
  onAgentTabClosed: (cb: (tabId: string) => void) => void;
  refresh: () => void;                        // re-render the rail so chip states update
}
let deps: PmPipeDeps;

export type PmRunStatus = 'idle' | 'queued' | 'working' | 'done' | 'failed';
const OCCUPYING: PmRunStatus[] = ['working'];

interface PmRun {
  provider: string; projectId: string; taskKey: string; title: string; head: string; ws: string;
  repoProvider: string; repo: string;         // the git repo the pipeline builds in (auto-cloned if not the open folder)
  working?: string; done?: string;            // provider status names for write-back
  runId: string;                              // worktree/branch id → task-<runId>
  pipeline: PipelineDef; stageIdx: number; wt: string; agentId: string; brief0Rel: string;
  agentTabId?: string; awaiting: boolean; reason?: string; // awaiting = poll this stage's verdict (a validate stage is always gated)
}
const runs = new Map<string, PmRun>();
const runStatus = new Map<string, PmRunStatus>();
const keyOf = (provider: string, taskKey: string): string => `${provider}#${taskKey}`;
const CAP = (): number => Math.max(1, Math.min(8, Number(state.settings.issueConcurrency) || 2));
function workingCount(): number { let c = 0; for (const s of runStatus.values()) if (OCCUPYING.includes(s)) c++; return c; }

// A PM task has no git issue number, so closeStep is a plain "open a PR" (no `Closes #N`).
const CLOSE_STEP = 'open a pull request with your change (e.g. `gh pr create` / `glab mr create`, or your provider’s CLI) and describe what you did. There is no issue number to reference.';
const briefCtx = (run: PmRun, idx: number): BriefCtx => ({ issue: run.head, number: 0, title: run.taskKey, closeStep: CLOSE_STEP, verdictRel: `.slayer/stage-${idx}.json` });

/* ----------------------------- write-back to the provider ----------------------------- */
async function setTaskStatus(run: PmRun, status?: string): Promise<void> {
  if (!status) return;
  try { await relay.pmTaskUpdate(run.ws, run.provider, run.taskKey, { status }); } catch { /* best-effort */ }
}
// On completion: write the validation VERDICT back — the summary appended to the task description, and (only on
// a valid verdict) the "validated" status. Best-effort; every field optional. No PR (validation, not a build).
async function reportValidated(run: PmRun, passed: boolean): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (passed && run.done) patch.status = run.done;
  if (run.reason) {
    try { const d = await relay.pmTaskGet(run.ws, run.provider, run.taskKey); const desc = (d?.ok && d.data?.description) || ''; patch.description = `${desc}${desc ? '\n\n' : ''}Slayer T validation — ${passed ? 'valid ✓' : 'invalid'}: ${run.reason}`.slice(0, 20000); } catch { /* */ }
  }
  if (Object.keys(patch).length) { try { await relay.pmTaskUpdate(run.ws, run.provider, run.taskKey, patch); } catch { /* */ } }
}

/* ----------------------------- runner (staged, gated by verdict files) ----------------------------- */
async function launchStage(key: string, idx: number): Promise<void> {
  const run = runs.get(key); if (!run) return;
  const stage = run.pipeline.stages[idx]; if (!stage) return;
  run.stageIdx = idx; run.awaiting = false; run.reason = undefined; run.agentTabId = undefined;
  runStatus.set(key, 'working');
  const briefRel = idx === 0 ? run.brief0Rel : `.slayer/stage-${idx}.md`;
  // Stage 0's brief file already exists (task-worktree-add wrote it); write later stages + clear this stage's
  // stale verdict so a reused worktree can't read a previous run's pass/fail. Then launch the agent on the FILE.
  const brief = renderBrief(stage.brief, briefCtx(run, idx));
  await relay.pipelinePrep(run.wt, idx === 0 ? null : briefRel, idx === 0 ? null : brief, idx).catch(() => {});
  if (!runs.has(key)) return;                  // freed while we prepped
  run.awaiting = !!stage.edges?.length; // poll the verdict only now (after the stale one is cleared); the validate stage is gated
  const agent = AGENTS.find((a) => a.id === run.agentId);
  void deps.openAgentTab({ cwd: run.wt, name: `${run.taskKey} · ${stage.name.toLowerCase()}`, runCmd: agent ? agent.launch(briefRel) : undefined })
    .then((tabId) => { const r = runs.get(key); if (r && r.stageIdx === idx) r.agentTabId = tabId; })
    .catch(() => { /* nothing to bind */ });
  deps.refresh(); ensureStagePoll();
}

function startRun(r: PmRun): void {
  const key = keyOf(r.provider, r.taskKey);
  runs.set(key, r);
  runStatus.set(key, 'working');
  void setTaskStatus(r, r.working);            // write-back: mark the task in progress on the provider
  void launchStage(key, 0);
}

/* ----------------------------- verdict poll ----------------------------- */
let stageTimer: number | null = null;
function ensureStagePoll(): void {
  const active = [...runs.values()].some((r) => r.awaiting);
  if (active && stageTimer == null) stageTimer = window.setInterval(() => void pollStages(), 4000);
  else if (!active && stageTimer != null) { clearInterval(stageTimer); stageTimer = null; }
}
let polling = false;
async function pollStages(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    for (const [key, run] of [...runs.entries()].filter(([, r]) => r.awaiting)) {
      const v = await relay.pipelineVerdict(run.wt, run.stageIdx).catch(() => null);
      if (!runs.has(key) || !run.awaiting) continue;
      if (!v || !v.found) continue;
      run.awaiting = false;
      const edge = nextEdge(run.pipeline.stages[run.stageIdx], !!v.passed);
      const target = edge && edge.to !== STOP ? stageIndexById(run.pipeline, edge.to) : -1;
      if (edge && edge.to !== STOP && target >= 0) {
        toast(`${run.taskKey} — ${run.pipeline.stages[run.stageIdx].name} done; starting ${run.pipeline.stages[target].name}`, true);
        await launchStage(key, target);
      } else if (v.passed) {
        run.reason = v.summary || 'Valid.'; runStatus.set(key, 'done');
        toast(`${run.taskKey} — validated ✓`, true);
        void reportValidated(run, true); deps.refresh();
      } else {
        run.reason = v.summary || 'Not valid.'; runStatus.set(key, 'failed');
        toast(`${run.taskKey} — not valid`); void reportValidated(run, false); deps.refresh();
      }
    }
  } finally { polling = false; ensureStagePoll(); }
}

/* ----------------------------- public: assign, status, chip ----------------------------- */
export interface AssignParams {
  provider: string; projectId: string; ws: string; task: { key: string; title: string; description?: string };
  repoProvider: string; repo: string;         // git repo id parts
  working?: string; done?: string;            // status write-back: on start / on a valid verdict
  agentId: string; brief0: string;            // the (edited) validate brief
}
const taskHead = (t: { key: string; title: string; description?: string }): string => `# ${t.title || t.key}\n\n${(t.description || '').trim() || '_(no description)_'}`;
export async function assignPmTask(p: AssignParams): Promise<void> {
  const key = keyOf(p.provider, p.task.key);
  const cur = runStatus.get(key);
  if (cur && OCCUPYING.includes(cur)) { toast(`${p.task.key} is already running`); return; }
  if (workingCount() >= CAP()) { toast(`At capacity (${CAP()} runs) — try again when one finishes`, false); return; }
  const pipeline = validatePipeline();
  const runId = `${p.provider}-${p.task.key}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const dir = state.settings.workspace || '';
  const brief0 = p.brief0 || validateBrief(p.task);   // the (possibly edited) validate brief
  runStatus.set(key, 'working'); deps.refresh();  // optimistic — reflect immediately while the worktree preps (auto-clone can take a while)
  const res = await relay.taskWorktreeAdd(p.repoProvider, p.repo, dir, runId, brief0).catch(() => ({ ok: false as const, error: 'Worktree creation failed' }));
  if (!res.ok || !res.path) { runStatus.delete(key); deps.refresh(); toast(res.error || 'Could not create the worktree', false); return; }
  startRun({
    provider: p.provider, projectId: p.projectId, taskKey: p.task.key, title: p.task.title, head: taskHead(p.task), ws: p.ws,
    repoProvider: p.repoProvider, repo: p.repo, working: p.working, done: p.done, runId,
    pipeline, stageIdx: 0, wt: res.path, agentId: p.agentId, brief0Rel: res.briefRel || `.slayer/task-${runId}.md`, awaiting: false,
  });
  toast(`Validating ${p.task.key} in ${p.repo}`, true);
}

export const pmRunStatusOf = (provider: string, taskKey: string): PmRunStatus => runStatus.get(keyOf(provider, taskKey)) || 'idle';
export const PM_RUN_LABEL: Record<PmRunStatus, string> = { idle: '', queued: 'queued', working: 'validating', done: 'valid ✓', failed: 'invalid' };
// Click a run chip: dismiss a terminal outcome, or free a running one (its terminal/agent keeps going; this just
// releases the slot + row state so you can re-assign).
export function onPmRunChip(provider: string, taskKey: string): void {
  const key = keyOf(provider, taskKey); const st = runStatus.get(key);
  if (!st || st === 'idle') return;
  const run = runs.get(key);
  if (st === 'done' || st === 'failed') { if (run?.reason) toast(`${taskKey}: ${run.reason}`); }
  else toast(`Freed the slot held by ${taskKey}`);
  runStatus.delete(key); runs.delete(key); deps.refresh(); ensureStagePoll();
}

// The rendered validate brief for a task — pre-fills the Validate dialog's editable brief (same brief a local
// task uses, honoring the Settings override).
export const validateBrief = (task: { key: string; title: string; description?: string }): string =>
  renderBrief(validatePipeline().stages[0].brief, { issue: taskHead(task), number: 0, title: task.key, closeStep: CLOSE_STEP, verdictRel: '.slayer/stage-0.json' });

export function initPmPipeline(d: PmPipeDeps): void {
  deps = d;
  // A stage's terminal closed → if that run is still the current stage and holding a slot, free it (the agent is
  // gone with the unsaved shell), so a dead run can't wedge the cap.
  d.onAgentTabClosed((tabId: string) => {
    for (const [key, run] of runs) {
      if (run.agentTabId !== tabId) continue;
      if (OCCUPYING.includes(runStatus.get(key) as PmRunStatus)) { runStatus.delete(key); runs.delete(key); deps.refresh(); ensureStagePoll(); }
      return;
    }
  });
}
