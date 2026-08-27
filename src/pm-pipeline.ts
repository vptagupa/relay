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
import { LABEL_NAME, detailsBlock } from './tasks';   // tag id → provider label name + the "Task details" issue block, identical to a local task

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
  repoProvider: string; repo: string;         // the git repo validated against (auto-cloned if not the open folder)
  start?: string; valid?: string; fixed?: string; // lifecycle status names: on start / on valid (issue filed) / on fixed (issue closed)
  tags?: string[];                            // task type (bug|enhancement|feature) → applied as issue labels when filed, like a local task
  deps?: string[];                            // dependency repo ids → recorded in the filed issue's "Task details" block, like a local task
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
// Append a line to the task's provider description (read-modify-write, capped). Best-effort. The description
// fallback for providers that can't comment.
async function appendTaskDesc(ws: string, provider: string, taskKey: string, line: string, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    const d = await relay.pmTaskGet(ws, provider, taskKey);
    const desc = (d?.ok && d.data?.description) || '';
    await relay.pmTaskUpdate(ws, provider, taskKey, { description: `${desc}${desc ? '\n\n' : ''}${line}`.slice(0, 20000), ...extra });
  } catch { /* best-effort */ }
}
// Write a lifecycle note to the task: as a COMMENT on its thread (preferred — visible to watchers, notifies
// @mentions), else appended to the description if the provider can't comment. The status (optional) is applied
// alongside either way. All best-effort.
async function postNote(ws: string, provider: string, taskKey: string, text: string, status?: string): Promise<void> {
  const c = await relay.pmComment(ws, provider, taskKey, text).catch(() => ({ ok: false }));
  if (c?.ok) { if (status) { try { await relay.pmTaskUpdate(ws, provider, taskKey, { status }); } catch { /* */ } } return; }
  await appendTaskDesc(ws, provider, taskKey, text, status ? { status } : {}); // no comment support → fall back to the description
}

// --- standard comment format ---------------------------------------------------------------------------------
// Every lifecycle note Slayer T writes to a provider task uses ONE consistent, scannable layout: a titled header,
// the agent's verdict, then a labeled detail list (repo / issue / labels / status) and a context footer. Echo
// stores comment bodies verbatim ("no markup is rendered", per its REST docs), so this is deliberately PLAIN TEXT
// — emoji header, `• ` bullets, inline URLs — not Markdown, so it reads cleanly wherever the comment is shown.
type NoteKind = 'valid' | 'invalid' | 'revalidated' | 'fixed';
const KIND_HEAD: Record<NoteKind, string> = {
  valid: 'Validation passed ✓',
  invalid: 'Validation failed ✗',
  revalidated: 'Re-validated ✓',
  fixed: 'Fixed ✓',
};
interface NoteFields {
  kind: NoteKind;
  summary?: string;                     // the agent's verdict/reason
  repo?: string;                        // owner/repo
  issue?: { number: number; url?: string };
  labels?: string[];                    // provider labels applied to the filed issue
  status?: string;                      // the task status this event sets (shown as a transition)
  note?: string;                        // a trailing context line
}
// Build the standard comment body. Absent fields are omitted so each event shows only what's relevant.
function noteBody(f: NoteFields): string {
  const head = `🗡️ Slayer T — ${KIND_HEAD[f.kind]}`;
  const verdict = f.summary ? `\n\n${f.summary.trim()}` : '';
  const rows: string[] = [];
  if (f.repo) rows.push(`• Repository: ${f.repo}`);
  if (f.issue) rows.push(`• Issue: #${f.issue.number}${f.issue.url ? ` — ${f.issue.url}` : ''}`);
  if (f.labels && f.labels.length) rows.push(`• Labels: ${f.labels.join(', ')}`);
  if (f.status) rows.push(`• Status: → ${f.status}`);
  const list = rows.length ? `\n\n${rows.join('\n')}` : '';
  const foot = f.note ? `\n\n— ${f.note}` : '';
  return `${head}${verdict}${list}${foot}`;
}

// --- filed-issue title tag ----------------------------------------------------------------------------------
// The filed issue number lives only in this machine's local pmTracked, so other viewers can't see it. To share it
// we tag the PROVIDER TASK's TITLE with " · owner/repo#N" — the one list-visible free field, so every machine's
// task list shows it. These helpers write/parse/strip that tag; they're the single source of its format.
const ISSUE_TAG_RE = /\s*·\s*[\w.-]+\/[\w.-]+#\d+\s*$/;              // the trailing tag, for stripping (idempotency)
export const stripIssueTag = (title: string): string => (title || '').replace(ISSUE_TAG_RE, '').replace(/\s+$/, '');
export const parseIssueTag = (title: string): { repo: string; number: number } | null => { const m = /·\s*([\w.-]+\/[\w.-]+)#(\d+)\s*$/.exec(title || ''); return m ? { repo: m[1], number: Number(m[2]) } : null; };
const withIssueTag = (title: string, repo: string, n: number): string => `${stripIssueTag(title)} · ${repo}#${n}`;

// On the verdict: INVALID → mark invalid + summary. VALID → file a git issue in the mapped repo, link it on the
// task, set the "valid/issued" status, and START WATCHING the issue for closure (→ the task's "fixed" status).
async function reportValidated(run: PmRun, passed: boolean): Promise<void> {
  if (!passed) {
    await postNote(run.ws, run.provider, run.taskKey, noteBody({ kind: 'invalid', summary: run.reason || 'Not valid against the repository.', repo: run.repo, note: 'No issue was filed. Re-validate from Slayer T after changes.' }));
    return;
  }
  // Already has an OPEN filed issue being watched (a re-validate) → don't file a duplicate; just refresh status/note.
  // A previously-fixed (closed) issue does not block: re-validating files a fresh one.
  if (openTracked().some((t) => t.provider === run.provider && t.taskKey === run.taskKey)) {
    const t = openTracked().find((x) => x.provider === run.provider && x.taskKey === run.taskKey);
    await postNote(run.ws, run.provider, run.taskKey, noteBody({ kind: 'revalidated', summary: run.reason || 'Valid against the repository.', repo: run.repo, issue: t ? { number: t.issueNumber, url: t.issueUrl } : undefined, status: run.valid, note: 'A tracked issue already exists for this task — no duplicate was filed.' }), run.valid);
    return;
  }
  // Valid → file the issue so it can be fixed + tracked.
  const body = `${run.head}\n\n---\nSynced from ${run.provider} task **${run.taskKey}** via Slayer T. Closing this issue marks the ${run.provider} task fixed.${detailsBlock(run.tags, run.deps)}`;
  const iss = await relay.providerCreateIssue(run.ws, run.repoProvider, run.repo, run.title, body).catch(() => ({ ok: false as const }));
  const filed = iss?.ok && typeof iss.number === 'number';
  const link = filed ? `${run.repo}#${iss.number}${iss.url ? ` — ${iss.url}` : ''}` : '';
  // Apply the task's type as real provider labels on the new issue (best-effort — a label failure must never unfile
  // it), exactly like a local task. Collect the names actually applied so the write-back note shows them too.
  const labels: string[] = [];
  if (filed) for (const tg of run.tags || []) { const name = LABEL_NAME[tg]; if (name) { labels.push(name); void relay.providerAddLabel(run.ws, run.repoProvider, run.repo, iss.number, name).catch(() => {}); } }
  await postNote(run.ws, run.provider, run.taskKey, noteBody({
    kind: 'valid', summary: run.reason || 'Valid against the repository.', repo: run.repo,
    issue: filed ? { number: iss.number!, url: iss.url } : undefined, labels, status: run.valid,
    note: filed ? 'Closing the issue will mark this task fixed.' : 'Validation passed, but filing the issue failed — see Slayer T.',
  }), run.valid);
  if (filed) {
    // Tag the provider task's TITLE with the filed issue ref so EVERY viewer (any machine) sees it in the list —
    // not just this machine's local record. Idempotent (strips any prior tag), best-effort.
    const newTitle = withIssueTag(run.title, run.repo, iss.number!);
    if (newTitle !== run.title) void relay.pmTaskUpdate(run.ws, run.provider, run.taskKey, { title: newTitle }).catch(() => {});
    await addTracked({ ws: run.ws, provider: run.provider, taskKey: run.taskKey, projectId: run.projectId, repoProvider: run.repoProvider, repo: run.repo, issueNumber: iss.number!, issueUrl: iss.url || '', fixedStatus: run.fixed, tags: labels.length ? [...(run.tags || [])] : undefined, closed: false });
    deps.refresh();   // the record now exists → redraw the rail row with its issue badge + type labels
    toast(`${run.taskKey} valid → filed ${link} · watching for fix`, true);
  } else toast(`${run.taskKey} valid ✓ (couldn't file the issue)`, false);
}

/* ----------------------------- issue-closure tracking (valid → filed → fixed) ----------------------------- */
type Tracked = NonNullable<typeof state.settings.pmTracked>[number];
const trackedList = (): Tracked[] => state.settings.pmTracked || [];
const openTracked = (): Tracked[] => trackedList().filter((t) => !t.closed); // still watched for closure (closed ones are kept only for the rail-row display)
// The filed-issue display record for a provider task's rail row (labels + issue ref), whether still open or fixed —
// so the integration list shows its issue + type labels exactly like a local task row. Undefined until validated.
// Workspace-scoped: the same provider task validated in two workspaces keeps separate records.
export const pmFiledOf = (ws: string, provider: string, taskKey: string): Tracked | undefined =>
  trackedList().find((t) => t.ws === ws && t.provider === provider && t.taskKey === taskKey);
async function saveTracked(list: Tracked[]): Promise<void> { state.settings = await relay.patchSettings({ pmTracked: list }); }
async function addTracked(t: Tracked): Promise<void> {
  const list = trackedList().filter((x) => !(x.provider === t.provider && x.taskKey === t.taskKey)); // one active watch per task
  await saveTracked([...list, t]); ensureTrackPoll();
}
let trackTimer: number | null = null;
function ensureTrackPoll(): void {
  const has = openTracked().length > 0;   // only open issues need polling; closed ones linger only for display
  if (has && trackTimer == null) { trackTimer = window.setInterval(() => void pollTracked(), 120000); void pollTracked(); } // every 2 min + an immediate pass
  else if (!has && trackTimer != null) { clearInterval(trackTimer); trackTimer = null; }
}
let trackingPoll = false;
const twKey = (t: { provider: string; taskKey: string }): string => `${t.provider}#${t.taskKey}`;
// Watch each tracked issue for closure (its PR merged, or closed) with an EXACT single-issue state check — not a
// list heuristic, so it works regardless of repo activity. Perf: the checks run CONCURRENTLY and the closed ones
// are removed from the watch list in ONE settings write (not one per closure). A failed check keeps the watch.
async function pollTracked(): Promise<void> {
  if (trackingPoll) return; trackingPoll = true;
  try {
    const list = openTracked(); if (!list.length) return;
    const checks = await Promise.all(list.map(async (t) => ({ t, closed: ((await relay.providerIssueState(t.ws, t.repoProvider, t.repo, t.issueNumber).catch(() => null))?.state) === 'closed' })));
    const closed = checks.filter((c) => c.closed).map((c) => c.t);
    if (!closed.length) return;
    await Promise.all(closed.map((t) => postNote(t.ws, t.provider, t.taskKey, noteBody({ kind: 'fixed', repo: t.repo, issue: { number: t.issueNumber, url: t.issueUrl }, labels: t.tags?.map((tg) => LABEL_NAME[tg]).filter(Boolean), status: t.fixedStatus, note: 'The filed issue was closed, so Slayer T marked this task fixed.' }), t.fixedStatus)));
    const done = new Set(closed.map(twKey));
    // Keep the record (mark `closed`) rather than deleting it, so the rail row still shows the fixed issue + its
    // labels — the same way a local task row stays visible as "issue closed". A single re-read + write.
    await saveTracked(trackedList().map((x) => (done.has(twKey(x)) ? { ...x, closed: true } : x)));
    deps.refresh();   // reflect the fixed/closed issue on the rail row
    for (const t of closed) toast(`${t.taskKey} → fixed (${t.repo}#${t.issueNumber} closed)`, true);
  } finally { trackingPoll = false; ensureTrackPoll(); }
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
  void setTaskStatus(r, r.start);              // write-back: mark the task in progress on the provider
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
  start?: string; valid?: string; fixed?: string; // lifecycle status write-back: on start / on valid (issued) / on fixed (issue closed)
  agentId: string; brief0: string;            // the (edited) validate brief
  deps?: string[];                            // dependency repo ids ("provider:owner/repo") linked read-only under .deps/
  tags?: string[];                            // task type (bug|enhancement|feature) → applied as issue labels when filed
}
const taskHead = (t: { key: string; title: string; description?: string }): string => `# ${t.title || t.key}\n\n${(t.description || '').trim() || '_(no description)_'}`;
// Returns true once the worktree exists and the run has started, false on any early-out (already running, at
// capacity, worktree failed) — so the caller's dialog can stay open + re-enable on failure, like a local task.
export async function assignPmTask(p: AssignParams): Promise<boolean> {
  const key = keyOf(p.provider, p.task.key);
  const cur = runStatus.get(key);
  if (cur && OCCUPYING.includes(cur)) { toast(`${p.task.key} is already running`); return false; }
  if (workingCount() >= CAP()) { toast(`At capacity (${CAP()} runs) — try again when one finishes`, false); return false; }
  const pipeline = validatePipeline();
  const runId = `${p.provider}-${p.task.key}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const dir = state.settings.workspace || '';
  const norm = (r: string) => r.replace(/\/+$/, '').replace(/\.git$/i, ''); // tolerate a mapping stored with a trailing .git/ — the API + worktree expect "owner/repo"
  const repo = norm(p.repo);
  const brief0 = p.brief0 || validateBrief(p.task);   // the (possibly edited) validate brief
  runStatus.set(key, 'working'); deps.refresh();  // optimistic — reflect immediately while the worktree preps (auto-clone can take a while)
  const res = await relay.taskWorktreeAdd(p.repoProvider, repo, dir, runId, brief0).catch(() => ({ ok: false as const, error: 'Worktree creation failed' }));
  if (!res.ok || !res.path) { runStatus.delete(key); deps.refresh(); toast(res.error || 'Could not create the worktree', false); return false; }
  // Link any selected dependency repos read-only under .deps/ (same as a local task's Validate), so the agent can
  // read related interfaces/contracts while it validates. Best-effort — a link failure must not block the run.
  if (p.deps && p.deps.length) {
    const parsed = p.deps.map((id) => { const i = id.indexOf(':'); return { provider: id.slice(0, i), repo: norm(id.slice(i + 1)) }; });
    await relay.linkDeps(res.path, dir, parsed).catch(() => null);
  }
  startRun({
    provider: p.provider, projectId: p.projectId, taskKey: p.task.key, title: p.task.title, head: taskHead(p.task), ws: p.ws,
    repoProvider: p.repoProvider, repo, start: p.start, valid: p.valid, fixed: p.fixed, tags: p.tags, deps: p.deps, runId,
    pipeline, stageIdx: 0, wt: res.path, agentId: p.agentId, brief0Rel: res.briefRel || `.slayer/task-${runId}.md`, awaiting: false,
  });
  toast(`Validating ${p.task.key} in ${repo}`, true);
  return true;
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
  ensureTrackPoll(); // resume watching any filed issues for closure (survives restart via Settings.pmTracked)
}
