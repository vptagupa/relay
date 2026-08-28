// PR Review pipelines — assign a pull request to a build/review pipeline, the same way an issue is assigned.
// Unlike an issue (which gets a fresh worktree + fix branch), a PR is reviewed on its OWN branch: the main
// process fetches the PR head and checks it out (`git:pr-worktree-add` → branch `pr-<n>`), so the agent reads
// the real diff. Each stage is one agent run seeded from a brief FILE in the worktree's .slayer/; a GATE stage
// writes a verdict (`stage-<i>.json`) that decides ready ✓ vs changes-requested.
//
// This is a self-contained peer of the Issues runner (issues.ts) — it deliberately does NOT reach into it, so
// the working issue flow can't regress. It reuses the PURE pipeline helpers (pipelines.ts) + the generic
// worktree/verdict IPC (pipeline:prep / pipeline:verdict, which are worktree-scoped, not issue-scoped).
// DI-seam module: initPrReview(deps). Owns per-PR pipeline picks (Settings.prPipelineByKey) + the live runs.

import { state } from './state';
import { esc } from './dom';
import { toast } from './ui';
import { prPipelines, prPipelineById, renderBrief, nextEdge, stageIndexById, STOP, kindSpec, commentNote, browserNote, orchestratorStopBody, type PipelineDef, type BriefCtx } from './pipelines';
import { openPipelineBuilder } from './pipeline-editor';
import { AGENTS, redriveAgent, redrivePrompt } from './agents-list';
import { dbCredOptions, dbCredNote, loadDbCreds, dbCredMetas } from './dbcreds';
import { repoDepsFor, depsNote } from './repo-deps';

const relay = (window as any).relay;

type ProviderId = 'github' | 'gitlab' | 'bitbucket';
const PR_WORD: Record<ProviderId, string> = { github: 'PR', gitlab: 'MR', bitbucket: 'PR' };

// The minimum a PR row must carry for a review assignment (a superset of the PR rail's PrItem).
export interface PrRef { number: number; title?: string; branch: string; url?: string; provider?: ProviderId; repo?: string; }
// Where the PR lives + the local folder to resolve/clone it from (the active workspace root).
export interface PrCtx { provider: ProviderId; repo: string; dir: string; }

export interface PrReviewDeps {
  openAgentTab: (o: { cwd: string; name: string; runCmd?: string; dbCredId?: string }) => Promise<string>; // open a terminal tab in the worktree, launching the agent (dbCredId → inject a DB credential template into its env); resolves to the tab id
  onAgentTabClosed: (cb: (tabId: string) => void) => void;                    // subscribe to terminal-closed → free the review slot held by that tab
  tabActivity: (tabId: string) => number | undefined;                        // last-output ms of a stage's terminal → the review⇄fix watchdog's activity signal
  refresh: () => void;                                                        // re-render the PR rail (a run's status changed)
}
let deps: PrReviewDeps;

/* ----------------------------- per-PR pipeline (persisted, like per-issue) ----------------------------- */
const customPipelines = (): PipelineDef[] => state.settings.pipelines || [];
const prPipeKey = (prov: ProviderId, repo: string, n: number) => `${prov}:${repo || ''}#${n}`;
function prPipelineFor(prov: ProviderId, repo: string, n: number): string {
  const stored = (state.settings.prPipelineByKey || {})[prPipeKey(prov, repo, n)];
  const all = prPipelines(customPipelines());
  return stored && all.some((p) => p.id === stored) ? stored : all[0].id;
}
// Serialize per-PR-pipeline writes (patchSettings replaces prPipelineByKey wholesale) so two fast board drags
// can't clobber each other — each write reads the freshest map (updated by the previous write's assignment).
let prPipeWriteChain: Promise<void> = Promise.resolve();
function setPrPipeline(prov: ProviderId, repo: string, n: number, id: string): Promise<void> {
  prPipeWriteChain = prPipeWriteChain.then(async () => {
    const map = { ...(state.settings.prPipelineByKey || {}) };
    const all = prPipelines(customPipelines());
    if (id === all[0].id) delete map[prPipeKey(prov, repo, n)]; else map[prPipeKey(prov, repo, n)] = id; // storing the default = no entry
    try { state.settings = await relay.patchSettings({ prPipelineByKey: map }); } catch { /* keep the in-memory pick */ }
  });
  return prPipeWriteChain;
}
// Per-PR DB credential template id (see dbcreds.ts), keyed like the per-PR pipeline. Injected into each review
// stage's env so the agent can exercise the change against a real database without being asked for credentials.
function prDbCredFor(prov: ProviderId, repo: string, n: number): string { return (state.settings.prDbCredByKey || {})[prPipeKey(prov, repo, n)] || ''; }
let prDbCredWriteChain: Promise<void> = Promise.resolve();
function setPrDbCred(prov: ProviderId, repo: string, n: number, id: string): Promise<void> {
  prDbCredWriteChain = prDbCredWriteChain.then(async () => {
    const map = { ...(state.settings.prDbCredByKey || {}) };
    if (id) map[prPipeKey(prov, repo, n)] = id; else delete map[prPipeKey(prov, repo, n)];
    try { state.settings = await relay.patchSettings({ prDbCredByKey: map }); } catch { /* keep the in-memory pick */ }
  });
  return prDbCredWriteChain;
}

// Per-PR dependency repos (read-only reference), keyed like the per-PR pipeline. Checked out under .deps/ in the
// review worktree so the agent can read related repos (interfaces/contracts) while reviewing. Same model as the
// issue Assign's deps picker; serialized writes so two fast board actions can't clobber the map.
function prDepsFor(prov: ProviderId, repo: string, n: number): string[] { return (state.settings.prDepsByKey || {})[prPipeKey(prov, repo, n)] || []; }
let prDepsWriteChain: Promise<void> = Promise.resolve();
function setPrDeps(prov: ProviderId, repo: string, n: number, ids: string[]): Promise<void> {
  prDepsWriteChain = prDepsWriteChain.then(async () => {
    const map = { ...(state.settings.prDepsByKey || {}) };
    if (ids.length) map[prPipeKey(prov, repo, n)] = ids; else delete map[prPipeKey(prov, repo, n)];
    try { state.settings = await relay.patchSettings({ prDepsByKey: map }); } catch { /* keep the in-memory pick */ }
  });
  return prDepsWriteChain;
}

// Per-PR auto-approve: when on, a clean Review Agent verdict (passed=true) auto-posts an "Approve" review on the PR.
function prAutoApproveFor(prov: ProviderId, repo: string, n: number): boolean { return !!(state.settings.prAutoApproveByKey || {})[prPipeKey(prov, repo, n)]; }
let prAutoApproveWriteChain: Promise<void> = Promise.resolve();
function setPrAutoApprove(prov: ProviderId, repo: string, n: number, on: boolean): Promise<void> {
  prAutoApproveWriteChain = prAutoApproveWriteChain.then(async () => {
    const map = { ...(state.settings.prAutoApproveByKey || {}) };
    if (on) map[prPipeKey(prov, repo, n)] = true; else delete map[prPipeKey(prov, repo, n)];
    try { state.settings = await relay.patchSettings({ prAutoApproveByKey: map }); } catch { /* keep the in-memory pick */ }
  });
  return prAutoApproveWriteChain;
}
// When auto-approve is ON, the review verdict gates a REAL merge-approval — so tighten the bar in the brief: the
// agent must treat a pass as an approval and hold passed=true to "genuinely clean", failing even non-blocking /
// fixable concerns it would otherwise leave as a comment. Only applies to a REVIEW stage.
function autoApproveNote(kind: string, on: boolean): string {
  if (!on || kind !== 'review') return '';
  return `\n\n---\n## Auto-approve is ON for this review\nYour verdict gates a real merge-approval: **passed=true here will auto-approve this pull request.** Hold it to a strict bar — set passed=true ONLY if the PR is genuinely clean with NO remaining concerns, **blocking OR non-blocking/fixable**. If there is ANY concern you would otherwise leave as a non-blocking review comment (a nit, a missing test, a follow-up), set **passed=false** instead, so it's surfaced rather than silently approved.`;
}

// Per-PR "verify in Chrome": when on, a browser gate (mirrors the backend gate) is appended to the review + fix
// briefs — a UI/frontend change must be exercised in a REAL browser, not passed on inspection alone.
function prBrowserFor(prov: ProviderId, repo: string, n: number): boolean { return !!(state.settings.prBrowserByKey || {})[prPipeKey(prov, repo, n)]; }
let prBrowserWriteChain: Promise<void> = Promise.resolve();
function setPrBrowser(prov: ProviderId, repo: string, n: number, on: boolean): Promise<void> {
  prBrowserWriteChain = prBrowserWriteChain.then(async () => {
    const map = { ...(state.settings.prBrowserByKey || {}) };
    if (on) map[prPipeKey(prov, repo, n)] = true; else delete map[prPipeKey(prov, repo, n)];
    try { state.settings = await relay.patchSettings({ prBrowserByKey: map }); } catch { /* keep the in-memory pick */ }
  });
  return prBrowserWriteChain;
}
const clonePipeline = (p: PipelineDef): PipelineDef => JSON.parse(JSON.stringify(p));

/* ----------------------------- run state ----------------------------- */
// A review run's status. `reviewing`/`working` hold a concurrency slot; `queued` waits; `ready`/`changes` are
// terminal outcomes kept for the row chip (they don't hold a slot).
export type PrStatus = 'idle' | 'queued' | 'reviewing' | 'working' | 'ready' | 'changes';
const OCCUPYING: PrStatus[] = ['reviewing', 'working'];
const stageToStatus = (kind: string): PrStatus => (kind === 'review' ? 'reviewing' : 'working');

interface PrRunInfo {
  provider: ProviderId; repo: string; number: number; title: string;
  headText: string;      // `# PR #n: title\n\n body` — seeds each stage's {issue} token
  base: string;          // base branch (for the {base} token), '' if unknown
  source: string;        // source (head) branch — the {source} push target for the resolve stage
  pipeline: PipelineDef; // snapshot at assign time (survives later edits to a custom pipeline)
  stageIdx: number; wt: string; agentId: string; brief0Rel: string;
  agentTabId?: string;   // the current stage's terminal — closing it frees this review's slot
  awaiting: boolean;     // true while a GATE stage's verdict is being polled
  reason?: string;       // the review summary (shown after a terminal outcome)
  stageTabs?: Record<string, string>; // review⇄fix loop: stage id → its terminal, reused across rounds (re-driven, not reopened)
  rounds?: number;       // count of review→fix cycles so far (loop-cap guard)
  lastReviewSummary?: string; // the latest review's concerns → injected into the next Fix brief + posted as a PR comment
  awaitingSince?: number; // ms timestamp the current gate started awaiting a verdict → the stage watchdog's clock
  recoverStage?: number;  // after a watchdog stall: the stage index whose verdict we keep watching (late-verdict recovery)
  recoverUntil?: number;  // ms deadline for that recovery watch — after it, give up (manual re-assign still available)
}
interface PrQueueItem { provider: ProviderId; repo: string; number: number; title: string; headText: string; base: string; source: string; cwd: string; agentId: string; agentName: string; pipeline: PipelineDef; brief0Rel: string; }

const prRuns = new Map<string, PrRunInfo>();       // "provider:repo#number" → run
const prRunStatus = new Map<string, PrStatus>();   // "provider:repo#number" → status
const prQueue: PrQueueItem[] = [];
// Cap total concurrent review agents (global across repos — a PR review can span the "All repos" view). Shares
// the same knob as the issue queue; note the two queues are independent, so issues + PRs run up to CAP each.
const CAP = (): number => Math.max(1, Math.min(8, Number(state.settings.issueConcurrency) || 2));
const keyOf = (prov: ProviderId, repo: string, n: number) => `${prov}:${repo || ''}#${n}`;
function workingCount(): number { let c = 0; for (const s of prRunStatus.values()) if (OCCUPYING.includes(s)) c++; return c; }

/* ----------------------------- brief context ----------------------------- */
const prHead = (n: number, title: string, body?: string): string =>
  `# ${title || `PR #${n}`} (PR #${n})\n\n${(body || '').trim() || '_(no description provided)_'}`;
function prBriefCtx(run: { number: number; title: string; headText: string; base: string; source?: string }, idx: number): BriefCtx {
  return { issue: run.headText, number: run.number, title: run.title, closeStep: 'Summarize your review verdict.', base: run.base || '', source: run.source || '', verdictRel: `.slayer/stage-${idx}.json` };
}
// The rendered seed brief for a stage — editable in Assign before launch. Includes the commentNote nudge so a
// REVIEW stage (always stage 0 of a PR pipeline, written once from the dialog and never rewritten by launchPrStage)
// still tells the agent to post its verdict on the PR per ./CLAUDE.md — on a first-attempt pass as well as re-reviews.
function stageBriefText(p: PipelineDef, idx: number, ctx: { number: number; title: string; headText: string; base: string; source?: string }, prov: ProviderId): string {
  const stage = p.stages[idx]; if (!stage) return '';
  return renderBrief(stage.brief, prBriefCtx(ctx, idx)) + commentNote(stage.kind, prov);
}

/* ----------------------------- runner (staged, gated by verdict files) ----------------------------- */
const MAX_REVIEW_ROUNDS = 5; // review→fix cycles before the auto-fix loop stops and asks for a human
// Watchdog (activity-based) — see issues.ts for the rationale. A gate is "stuck" only if its terminal has gone
// silent for STAGE_IDLE_MS (a working agent streams output); STAGE_HARD_CAP_MS is an absolute backstop. On a stall
// we free the slot but keep watching the verdict for RECOVER_GRACE_MS so a late-finishing agent still advances.
const STAGE_IDLE_MS = 15 * 60 * 1000;         // no terminal output for this long ⇒ treat as stuck
const STAGE_HARD_CAP_MS = 4 * 60 * 60 * 1000; // absolute ceiling regardless of activity
const RECOVER_GRACE_MS = 60 * 60 * 1000;      // after a stall, keep watching for a late verdict this long
// Desktop notification for a loop transition (respects the app's notifications setting).
function notify(title: string, body: string): void {
  try { if (state.settings.notifications && typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body: (body || '').slice(0, 180) }); } catch { /* best-effort */ }
}
// The review/fix VERDICT comments are now posted by the AGENTS themselves (Review Agent / Fix Agent), per the
// worktree's CLAUDE.md protocol — see commentNote() + agent-guide.ts. The app only posts ORCHESTRATOR notices the
// agent can't (e.g. "auto-fix stopped after N rounds"), clearly signed so it's distinct from the agent identities.
function postOrchestratorNote(run: PrRunInfo, body: string): void {
  void relay.providerPrComment(activeWs(), run.provider, run.repo, run.number, `### 🤖 Slayer T orchestrator\n\n${body}`).catch(() => {});
}

async function launchPrStage(key: string, idx: number): Promise<void> {
  const run = prRuns.get(key); if (!run) return;
  const stage = run.pipeline.stages[idx]; if (!stage) return;
  run.stageIdx = idx; run.awaiting = false; run.reason = undefined; run.agentTabId = undefined; // not awaiting yet — clear the stale verdict FIRST (below); tab rebound once it opens
  run.recoverStage = undefined; run.recoverUntil = undefined; // (re)launching this run supersedes any pending recovery watch
  prRunStatus.set(key, stageToStatus(stage.kind)); // synchronous, so workingCount() is correct before the async prep
  const briefRel = idx === 0 ? run.brief0Rel : `.slayer/stage-${idx}.md`;
  // A referenced DB credential template → injected into this stage's env (every stage is its own shell) and its
  // note appended to LATER-stage briefs too (stage 0 already carries the note from the Assign dialog's textarea).
  const dbCredId = prDbCredFor(run.provider, run.repo, run.number);
  // Stage 0's brief file is already on disk (pr-worktree-add wrote it); write later stages + clear this stage's
  // stale verdict so a reused worktree can't read a previous run's pass/fail. Then launch the agent on the FILE.
  let brief = renderBrief(stage.brief, prBriefCtx(run, idx)) + dbCredNote(dbCredId) + depsNote(prDepsFor(run.provider, run.repo, run.number)) + browserNote(stage.kind, prBrowserFor(run.provider, run.repo, run.number)) + commentNote(stage.kind, run.provider); // + .deps/ note + browser gate + post result per ./CLAUDE.md
  // Auto-fix loop: hand the Fix stage the exact concerns the latest review raised.
  if (stage.kind === 'fix' && run.lastReviewSummary) brief += `\n\n---\n\n## Review concerns to address\n${run.lastReviewSummary}`;
  await relay.pipelinePrep(run.wt, idx === 0 ? null : briefRel, idx === 0 ? null : brief, idx).catch(() => {});
  if (!prRuns.has(key)) return;                      // freed/cleared while we prepped
  run.awaiting = !!stage.edges?.length;              // only NOW poll for a verdict — after the stale one is gone (no early stale read)
  run.awaitingSince = run.awaiting ? Date.now() : undefined; // start the watchdog clock for this gate
  const agent = AGENTS.find((a) => a.id === run.agentId);
  // Loop re-entry: this stage already has a live terminal → re-drive its running agent session with the next
  // round's brief instead of opening a new tab (interactive agents only; one-shot ones exited, so reopen).
  const existingTab = run.stageTabs?.[stage.id];
  if (existingTab && agent?.interactive) {
    run.agentTabId = existingTab;
    // Loop re-entry → a CONTEXTUAL prompt (fix: new concerns to verify+fix; review: new commit to re-review), not the
    // neutral first-run brief prompt. Submit is a SEPARATE Enter (else the REPL treats text+CR as a paste and won't run it).
    redriveAgent(existingTab, redrivePrompt(stage.kind, briefRel));
    deps.refresh(); ensureStagePoll();
    return;
  }
  // First run of this stage (or a one-shot agent) → open a fresh terminal + remember it for reuse across rounds.
  void deps.openAgentTab({ cwd: run.wt, name: `PR #${run.number} · ${stage.name.toLowerCase()}`, runCmd: agent ? agent.launch(briefRel) : undefined, dbCredId: dbCredId || undefined })
    .then((tabId) => { const r = prRuns.get(key); if (r && r.stageIdx === idx) { r.agentTabId = tabId; (r.stageTabs ||= {})[stage.id] = tabId; } })
    .catch(() => { /* nothing to bind */ });
  deps.refresh(); ensureStagePoll();
}

function startPrPipeline(o: { provider: ProviderId; repo: string; number: number; title: string; headText: string; base: string; source: string; pipeline: PipelineDef; wt: string; agentId: string; brief0Rel: string }): void {
  const key = keyOf(o.provider, o.repo, o.number);
  prRuns.set(key, { provider: o.provider, repo: o.repo, number: o.number, title: o.title, headText: o.headText, base: o.base, source: o.source, pipeline: o.pipeline, stageIdx: 0, wt: o.wt, agentId: o.agentId, brief0Rel: o.brief0Rel, awaiting: false });
  prRunStatus.set(key, stageToStatus(o.pipeline.stages[0].kind)); // synchronous, so a drain loop can't over-launch past CAP
  void launchPrStage(key, 0);
}

// Launch a prepared run now, or queue it if at capacity (its worktree + stage-0 brief already exist, so a
// queued run auto-launches the instant a slot frees). Shared by Assign and the map board.
function launchOrQueue(o: { provider: ProviderId; repo: string; number: number; title: string; headText: string; base: string; source: string; agentId: string; agentName: string; pipeline: PipelineDef; wt: string; brief0Rel: string }): 'queued' | 'launched' {
  const key = keyOf(o.provider, o.repo, o.number);
  if (workingCount() >= CAP()) {
    if (!prQueue.some((q) => keyOf(q.provider, q.repo, q.number) === key)) // don't double-queue
      prQueue.push({ provider: o.provider, repo: o.repo, number: o.number, title: o.title, headText: o.headText, base: o.base, source: o.source, cwd: o.wt, agentId: o.agentId, agentName: o.agentName, pipeline: o.pipeline, brief0Rel: o.brief0Rel });
    prRunStatus.set(key, 'queued');
    return 'queued';
  }
  startPrPipeline(o);
  return 'launched';
}

// Fill every free slot from the queue (FIFO). Safe to call often; no-ops when full/empty.
function drainQueue(): void {
  let launched = false;
  while (workingCount() < CAP() && prQueue.length) {
    const item = prQueue.shift()!;
    // Skip an item the user cancelled while it waited (its status was cleared).
    if (prRunStatus.get(keyOf(item.provider, item.repo, item.number)) !== 'queued') continue;
    startPrPipeline({ provider: item.provider, repo: item.repo, number: item.number, title: item.title, headText: item.headText, base: item.base, source: item.source, pipeline: item.pipeline, wt: item.cwd, agentId: item.agentId, brief0Rel: item.brief0Rel });
    toast(`Auto-launching review of ${PR_WORD[item.provider]} #${item.number}`, true);
    launched = true;
  }
  if (launched) deps.refresh();
}

// Verdict poll — advances GATE stages. Runs only while some run awaits a verdict, and stops itself otherwise.
let stageTimer: number | null = null;
function ensureStagePoll(): void {
  const active = [...prRuns.values()].some((r) => r.awaiting || r.recoverStage != null);
  if (active && stageTimer == null) stageTimer = window.setInterval(() => void pollStages(), 4000);
  else if (!active && stageTimer != null) { clearInterval(stageTimer); stageTimer = null; }
}
// Isolate a single run's poll failure — an unexpected throw must never abort the whole pass, spin every tick, or
// surface as an unhandled rejection. Log it, stop the run re-processing, and surface it as changes-requested.
function pollFail(key: string, run: PrRunInfo | undefined, err: unknown): void {
  try { console.error('[loop] pollStages failed for PR', run?.number, err); } catch { /* ignore */ }
  if (run) { run.awaiting = false; run.recoverStage = undefined; run.recoverUntil = undefined; run.reason = run.reason || 'Stopped after an internal error — re-assign to retry.'; }
  try { prRunStatus.set(key, 'changes'); drainQueue(); deps.refresh(); } catch { /* refresh is likely what threw — never recurse */ }
}
let polling = false;
async function pollStages(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    // ── awaiting gates: advance on a verdict, or trip the activity-based watchdog ──
    for (const [key, run] of [...prRuns.entries()].filter(([, r]) => r.awaiting)) {
      try {
        // Watchdog: stuck only if the terminal has gone SILENT for STAGE_IDLE_MS (a working agent keeps emitting) or
        // blown past the STAGE_HARD_CAP_MS backstop. On a stall we free the slot but hand off to recovery (below), which
        // keeps watching this stage's verdict so a late-finishing agent's real result is never thrown away.
        if (run.awaitingSince) {
          const act = run.agentTabId ? deps.tabActivity(run.agentTabId) : undefined;
          const idleFor = Date.now() - Math.max(run.awaitingSince, act || 0);
          const ranFor = Date.now() - run.awaitingSince;
          if (idleFor > STAGE_IDLE_MS || ranFor > STAGE_HARD_CAP_MS) {
            run.awaiting = false;
            run.recoverStage = run.stageIdx; run.recoverUntil = Date.now() + RECOVER_GRACE_MS; // keep watching for a late verdict
            const why = ranFor > STAGE_HARD_CAP_MS ? `ran ${Math.round(STAGE_HARD_CAP_MS / 3600000)}h without a verdict` : `produced no output for ${Math.round(STAGE_IDLE_MS / 60000)}m`;
            run.reason = `${run.pipeline.stages[run.stageIdx].name} ${why} — the agent looks stuck. Take over from its terminal, or re-assign. (If it's still working, its verdict will still be picked up.)`;
            prRunStatus.set(key, 'changes');
            toast(`PR #${run.number} — ${run.pipeline.stages[run.stageIdx].name} stalled`, false);
            notify(`PR #${run.number}: stage stalled`, run.reason);
            drainQueue(); deps.refresh();
            continue;
          }
        }
        const v = await relay.pipelineVerdict(run.wt, run.stageIdx).catch(() => null);
        if (!prRuns.has(key) || !run.awaiting) continue;   // resolved/cleared while we awaited
        if (!v || !v.found) continue;                       // verdict not written yet — keep polling
        run.awaiting = false;
        run.recoverStage = undefined; run.recoverUntil = undefined; // a real, on-time verdict supersedes any recovery
        await advanceOnVerdict(key, run, v);
      } catch (err) { pollFail(key, run, err); } // one bad run must not abort the pass or wedge the others
    }
    // ── late-verdict recovery: a stalled gate whose verdict finally landed still advances (never lose finished work) ──
    for (const [key, run] of [...prRuns.entries()].filter(([, r]) => r.recoverStage != null && !r.awaiting)) {
      try {
        if (run.recoverUntil && Date.now() > run.recoverUntil) { run.recoverStage = undefined; run.recoverUntil = undefined; continue; } // grace expired — give up (re-assign still works)
        const v = await relay.pipelineVerdict(run.wt, run.recoverStage!).catch(() => null);
        if (!prRuns.has(key) || run.recoverStage == null) continue; // cleared while we read (re-assign / relaunch)
        if (!v || !v.found) continue;                               // still no verdict — keep watching until grace expires
        const e = nextEdge(run.pipeline.stages[run.recoverStage], !!v.passed);
        const willAdvance = !!(e && e.to !== STOP && stageIndexById(run.pipeline, e.to) >= 0);
        if (willAdvance && workingCount() >= CAP()) continue;       // no slot to resume into — retry next tick
        run.stageIdx = run.recoverStage; run.recoverStage = undefined; run.recoverUntil = undefined; run.reason = undefined;
        toast(`PR #${run.number} — verdict arrived after the stall; resuming`, true);
        notify(`PR #${run.number}: resuming`, 'A late verdict landed — continuing the pipeline.');
        await advanceOnVerdict(key, run, v);
      } catch (err) { pollFail(key, run, err); } // one bad run must not abort the pass or wedge the others
    }
  } finally { polling = false; ensureStagePoll(); }
}

// Apply a gate stage's verdict: advance to the next stage, or finalize (ready ✓ / changes requested). Shared by
// the awaiting poll and the late-verdict recovery poll so routing + PR-comment write-back can't drift between them.
async function advanceOnVerdict(key: string, run: PrRunInfo, v: { passed?: boolean; summary?: string }): Promise<void> {
  const fromStage = run.pipeline.stages[run.stageIdx];
  const edge = nextEdge(fromStage, !!v.passed);
  const target = edge && edge.to !== STOP ? stageIndexById(run.pipeline, edge.to) : -1;
  const summary = (v.summary || '').trim();
  if (edge && edge.to !== STOP && target >= 0) {
    const toStage = run.pipeline.stages[target];
    // Leaving a review with concerns → capture them for the Fix brief (the Review Agent already posted them on the PR).
    if (fromStage.kind === 'review') run.lastReviewSummary = summary || 'Changes requested.';
    // Loop-cap guard: a review→fix cycle. After MAX rounds without a clean pass, stop and ask for a human.
    if (fromStage.kind === 'review' && toStage.kind === 'fix') {
      run.rounds = (run.rounds || 0) + 1;
      if (run.rounds > MAX_REVIEW_ROUNDS) {
        run.reason = `Still has concerns after ${MAX_REVIEW_ROUNDS} review⇄fix rounds — needs a human.\n\n${summary}`;
        prRunStatus.set(key, 'changes');
        postOrchestratorNote(run, orchestratorStopBody(MAX_REVIEW_ROUNDS, summary));
        toast(`PR #${run.number} — auto-fix stopped after ${MAX_REVIEW_ROUNDS} rounds`, false);
        notify(`PR #${run.number}: needs a human`, `Still has concerns after ${MAX_REVIEW_ROUNDS} review⇄fix rounds.`);
        drainQueue(); deps.refresh();
        return; // don't advance — end the loop
      }
    }
    toast(`PR #${run.number} — ${fromStage.name} done; starting ${toStage.name}` + (toStage.kind === 'fix' ? ` (round ${run.rounds})` : ''), true);
    notify(`PR #${run.number}: ${toStage.name} starting`, fromStage.kind === 'review' ? summary : `${fromStage.name} done`);
    await launchPrStage(key, target);
  } else if (v.passed) {
    // A valid/always edge to Stop, or no outgoing edge → the review passed: ready ✓ (the Review Agent posted the verdict).
    run.reason = summary || 'Looks good.'; prRunStatus.set(key, 'ready');
    toast(`PR #${run.number} — review passed ✓ ready to merge`, true);
    notify(`PR #${run.number}: review passed ✓`, summary || 'Ready to merge.');
    // Auto-approve (opt-in, per-PR): a clean REVIEW verdict posts an Approve review on the user's behalf. Best-effort
    // — most providers refuse to approve your OWN PR (author ≠ reviewer identity), so surface that as a toast.
    if (fromStage.kind === 'review' && prAutoApproveFor(run.provider, run.repo, run.number)) {
      void relay.providerPrReview(activeWs(), run.provider, run.repo, run.number, 'approve', `✅ Auto-approved by Slayer T — the Review Agent's verdict passed clean.\n\n${summary}`.slice(0, 60000))
        .then((r: { ok: boolean; error?: string }) => {
          if (r.ok) { toast(`PR #${run.number} — auto-approved ✓`, true); notify(`PR #${run.number}: auto-approved ✓`, 'The review passed clean.'); }
          else { toast(`PR #${run.number} — auto-approve failed: ${r.error || 'request failed'}`, false); }
        })
        .catch(() => toast(`PR #${run.number} — auto-approve request failed`, false));
    }
    drainQueue(); deps.refresh();
  } else {
    // The invalid off-ramp (or a failed verdict with no matching edge) → changes requested (the Review Agent posted it).
    run.reason = summary || 'Changes requested.'; prRunStatus.set(key, 'changes');
    toast(`PR #${run.number} — review: changes requested`);
    notify(`PR #${run.number}: changes requested`, summary);
    drainQueue(); deps.refresh();
  }
}

/* ----------------------------- status + chip actions (used by the PR rail) ----------------------------- */
export function prStatusOf(prov: ProviderId, repo: string, n: number): PrStatus { return prRunStatus.get(keyOf(prov, repo, n)) || 'idle'; }
export const PR_STATUS_LABEL: Record<PrStatus, string> = { idle: '', queued: 'queued', reviewing: 'reviewing', working: 'working', ready: 'ready ✓', changes: 'changes' };
// Click a status chip: cancel a queued item, free a running one, or dismiss a terminal outcome.
export function onPrChip(prov: ProviderId, repo: string, n: number): void {
  const key = keyOf(prov, repo, n); const st = prRunStatus.get(key);
  if (!st || st === 'idle') return;
  if (st === 'queued') { const i = prQueue.findIndex((q) => keyOf(q.provider, q.repo, q.number) === key); if (i >= 0) prQueue.splice(i, 1); prRunStatus.delete(key); prRuns.delete(key); toast(`Removed PR #${n} from the review queue`); }
  else if (st === 'ready' || st === 'changes') { const r = prRuns.get(key); if (r?.reason) { toast(`PR #${n}: ${r.reason}`); } prRunStatus.delete(key); prRuns.delete(key); }
  else { prRunStatus.delete(key); prRuns.delete(key); toast(`Freed the review slot held by PR #${n}`); drainQueue(); }
  deps.refresh(); ensureStagePoll();
}

/* ----------------------------- dialog scaffold ----------------------------- */
function modal(html: string): { root: HTMLElement; close: () => void } {
  const root = document.createElement('div'); root.className = 'tpl-modal';
  root.innerHTML = `<div class="tpl-sc"></div>${html}`;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
  document.body.appendChild(root);
  document.addEventListener('keydown', onKey);
  // Overlay/scrim click does NOT close the dialog — close via its own button or Escape (the scrim is a static backdrop).
  return { root, close };
}
// A compact wired-path preview: kind-coloured stage chips along the pipeline's success path.
function pipePreview(p: PipelineDef): string {
  const order: number[] = []; const seen = new Set<number>(); let idx = 0;
  while (idx >= 0 && idx < p.stages.length && !seen.has(idx)) {
    seen.add(idx); order.push(idx);
    const st = p.stages[idx];
    const e = (st.edges || []).find((x) => x.when === 'valid') || (st.edges || []).find((x) => x.when === 'always');
    if (!e || e.to === STOP) break;
    idx = stageIndexById(p, e.to);
  }
  return order.map((i) => { const s = p.stages[i]; return `<span class="prp-st"><span class="prp-dot" style="background:${kindSpec(s.kind).dot}"></span>${esc(s.name)}</span>`; }).join('<span class="prp-arr">→</span>');
}

/* ----------------------------- assign a single PR ----------------------------- */
// A resolve pipeline's stage-0 needs a DIFFERENT worktree prep (merge the base in to surface the conflict) than a
// review's (just check out the head), and drives resolve-specific dialog copy. Keyed off the stage kind.
const isResolvePipe = (pl: PipelineDef): boolean => pl.stages[0]?.kind === 'resolve';
let assigning = false;
export async function openPrAssign(pr: PrRef, ctx: PrCtx, opts?: { pipelineId?: string }): Promise<void> {
  const prov = (pr.provider || ctx.provider) as ProviderId;
  const repo = pr.repo || ctx.repo;
  const dir = ctx.dir;
  const num = pr.number;
  const source = pr.branch;   // the PR's source (head) branch — the {source} push target for a resolve stage
  await loadDbCreds();   // refresh the saved DB credential templates so the picker is current
  const detected = await relay.agentsDetect().catch(() => ({} as Record<string, boolean>));
  const installed = AGENTS.filter((a) => detected[a.id]);
  const agentOk = installed.length > 0;
  let agentId = (state.settings.issueAgent && detected[state.settings.issueAgent]) ? state.settings.issueAgent! : (installed[0]?.id || '');
  const agentOpts = AGENTS.map((a) => `<option value="${a.id}"${a.id === agentId ? ' selected' : ''}${detected[a.id] ? '' : ' disabled'}>${esc(a.name)}${detected[a.id] ? '' : ' — not installed'}</option>`).join('');
  const pipes = () => prPipelines(customPipelines());
  // Pre-select a pipeline when asked (the ⚔ Resolve button passes 'resolve-pr'); else the PR's stored/default pick.
  let pipelineId = (opts?.pipelineId && pipes().some((p) => p.id === opts.pipelineId)) ? opts.pipelineId : prPipelineFor(prov, repo, num);
  const pipeOpts = () => pipes().map((p) => `<option value="${p.id}"${p.id === pipelineId ? ' selected' : ''}>${esc(p.name)}${p.builtin ? '' : ' ✎'}</option>`).join('');
  let pipeline = prPipelineById(pipelineId, customPipelines());
  // Seed the brief from the PR list item now; enrich with the fetched body + base branch when it arrives.
  let head = prHead(num, pr.title || '', '');
  let base = '';
  let briefDirty = false;
  let ptitle = pr.title || '';                          // best-known PR title (list item now; enriched by fetchDetail)
  let selectedDbCred = prDbCredFor(prov, repo, num);   // DB credential template injected into the run's env
  // Dependencies: read-only reference repos checked out under .deps/ for the review. Candidates = the workspace's
  // OTHER tracked repos; default to this repo's saved deps template until the user customizes it for this PR.
  const prRepoId = `${prov}:${repo || ''}`;
  const depCandidates = ((state.settings.issueReposByWs || {})[activeWs()] || []).filter((id) => id !== prRepoId);
  const savedPrDeps = prDepsFor(prov, repo, num);
  const selectedDeps = new Set((savedPrDeps.length ? savedPrDeps : repoDepsFor(prRepoId)).filter((id) => depCandidates.includes(id)));
  let selectedAutoApprove = prAutoApproveFor(prov, repo, num); // auto-post an Approve review when the verdict passes clean
  let selectedBrowser = prBrowserFor(prov, repo, num);        // verify UI changes in a real Chrome browser
  // The full stage-0 brief: template + DB-creds note + .deps/ note + (if on) the browser gate + the strict
  // auto-approve note. One source, so every re-seed stays consistent.
  const seedBrief = () => stageBriefText(pipeline, 0, { number: num, title: ptitle, headText: head, base, source }, prov) + dbCredNote(selectedDbCred) + depsNote([...selectedDeps]) + browserNote(pipeline.stages[0].kind, selectedBrowser) + autoApproveNote(pipeline.stages[0].kind, selectedAutoApprove);
  const running = prStatusOf(prov, repo, num);
  const active = running !== 'idle' && running !== 'ready' && running !== 'changes';
  // Verb/primary/worktree-note track the selected pipeline: a resolve pipeline reads "Resolve", a review "Review".
  const verbFor = (pl: PipelineDef) => isResolvePipe(pl) ? 'Resolve' : 'Review';
  const primaryFor = () => agentOk ? (isResolvePipe(pipeline) ? '⚔ Resolve conflict' : '⚡ Run review') : 'Create worktree & open';
  const wtNoteFor = (pl: PipelineDef) => isResolvePipe(pl)
    ? `Merges the base branch into an isolated <code>pr-${num}</code> worktree so the conflict is live, then the agent resolves it, commits, and pushes to update the PR.`
    : `Checks out <code>${esc(pr.branch)}</code> into an isolated worktree on <code>pr-${num}</code> and reviews the real diff. Later stages use their built-in briefs.`;

  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t"><span id="prAsgVerb">${verbFor(pipeline)}</span> ${PR_WORD[prov]} #${num}<small>${esc(pr.title || pr.branch)}</small></span></div>
      <div class="bd">
        ${running !== 'idle' ? `<div class="iss-agent ok" id="prAsgStatus">Current: <b>${esc(PR_STATUS_LABEL[running] || running)}</b>${active ? ' — <a href="#" id="prAsgFree">free the slot</a>' : ''}</div>` : ''}
        <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Assign to</label><select class="iss-agentsel" id="prAgentSel"${agentOk ? '' : ' disabled'}>${agentOpts}</select></div>
        <div class="iss-agent ${agentOk ? 'ok' : 'no'}">${agentOk ? '✓ runs in its OWN isolated worktree — never touches your checkout' : '⚠ No coding agent on PATH — the worktree still opens; install Claude Code (or Gemini / Codex / Aider) to auto-run.'}</div>
        <div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Pipeline</label><select class="iss-agentsel" id="prPipeSel">${pipeOpts()}</select><button class="iss-pipebuild" id="prPipeBuild" title="Build / edit pipelines">✎ Build</button></div>
        <div class="pipe-preview" id="prGraph">${pipePreview(pipeline)}</div>
        <div class="iss-pipedesc" id="prPipeDesc">${esc(pipeline.desc)}</div>
        ${dbCredMetas().length ? `<div class="iss-agentrow"><label class="iss-lbl" style="margin:0">Database</label><select class="iss-agentsel" id="prDb">${dbCredOptions(selectedDbCred)}</select></div>` : ''}
        ${depCandidates.length ? `<label class="iss-lbl">Dependencies <span class="mut">— read-only repos the agent can view under <code>.deps/</code></span></label>
        <div class="iss-deps" id="prDeps">${depCandidates.map((id) => `<label class="iss-dep"><input type="checkbox" value="${esc(id)}"${selectedDeps.has(id) ? ' checked' : ''}><b>${esc(id.split('/').pop() || id)}</b><span class="mut">${esc(id)}</span></label>`).join('')}</div>` : ''}
        <label class="iss-check" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin:2px 0"><input type="checkbox" id="prBrowser"${selectedBrowser ? ' checked' : ''}> Verify UI changes in a Chrome browser <span class="mut">— the agent opens the affected page and exercises it, not just the diff</span></label>
        <label class="iss-check" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin:2px 0"><input type="checkbox" id="prAutoApprove"${selectedAutoApprove ? ' checked' : ''}> Auto-approve the pull request when the review passes <span class="mut">— posts an Approve review only if the verdict is clean</span></label>
        <label class="iss-lbl">Brief · <span id="prBriefStage">${esc(pipeline.stages[0].name)}</span> stage <span class="mut">— edit before launch</span></label>
        <textarea class="iss-brief" spellcheck="false" rows="10" id="prBrief">${esc(seedBrief())}</textarea>
        <div class="iss-wt" id="prAsgWt">${wtNoteFor(pipeline)}</div>
      </div>
      <div class="ft"><span class="hint">Saved as <code>.slayer/pr-${num}.md</code> (git-excluded)</span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-ok>${primaryFor()}</button></span></div>
    </div>`);

  const ta = root.querySelector('#prBrief') as HTMLTextAreaElement;
  const okBtn = root.querySelector('[data-ok]') as HTMLButtonElement;
  const asel = root.querySelector('#prAgentSel') as HTMLSelectElement | null;
  if (asel) asel.onchange = () => { agentId = asel.value; void relay.patchSettings({ issueAgent: agentId }); };
  const psel = root.querySelector('#prPipeSel') as HTMLSelectElement | null;
  const syncPipe = () => {
    pipeline = prPipelineById(pipelineId, customPipelines());
    const g = root.querySelector('#prGraph'); if (g) g.innerHTML = pipePreview(pipeline);
    const d = root.querySelector('#prPipeDesc'); if (d) d.textContent = pipeline.desc;
    const bs = root.querySelector('#prBriefStage'); if (bs) bs.textContent = pipeline.stages[0]?.name || '';
    const vb = root.querySelector('#prAsgVerb'); if (vb) vb.textContent = verbFor(pipeline);           // Resolve / Review header
    const wn = root.querySelector('#prAsgWt'); if (wn) wn.innerHTML = wtNoteFor(pipeline);              // worktree note follows the kind
    if (!assigning) okBtn.textContent = primaryFor();                                                   // "⚔ Resolve conflict" / "⚡ Run review"
    if (!briefDirty) ta.value = seedBrief();
  };
  if (psel) psel.onchange = () => { pipelineId = psel.value; void setPrPipeline(prov, repo, num, pipelineId); syncPipe(); };
  const dbSel = root.querySelector('#prDb') as HTMLSelectElement | null;   // pick a DB credential template → persist + re-seed the DB note (unless edited)
  if (dbSel) dbSel.onchange = () => { selectedDbCred = dbSel.value; void setPrDbCred(prov, repo, num, selectedDbCred); if (!briefDirty) ta.value = seedBrief(); };
  // Toggle a dependency repo → persist it for this PR and re-seed the brief's .deps/ note (unless the brief was edited).
  root.querySelectorAll<HTMLInputElement>('#prDeps input').forEach((cb) => cb.onchange = () => {
    if (cb.checked) selectedDeps.add(cb.value); else selectedDeps.delete(cb.value);
    void setPrDeps(prov, repo, num, [...selectedDeps]);
    if (!briefDirty) ta.value = seedBrief();
  });
  // Browser-verify toggle → persist + re-seed the brief's browser gate.
  const brCb = root.querySelector('#prBrowser') as HTMLInputElement | null;
  if (brCb) brCb.onchange = () => { selectedBrowser = brCb.checked; void setPrBrowser(prov, repo, num, selectedBrowser); if (!briefDirty) ta.value = seedBrief(); };
  // Auto-approve toggle → persist + re-seed the brief's strict-verdict note (so a pass truly means clean).
  const aaCb = root.querySelector('#prAutoApprove') as HTMLInputElement | null;
  if (aaCb) aaCb.onchange = () => { selectedAutoApprove = aaCb.checked; void setPrAutoApprove(prov, repo, num, selectedAutoApprove); if (!briefDirty) ta.value = seedBrief(); };
  root.querySelector('#prPipeBuild')?.addEventListener('click', () => {
    openPipelineBuilder(pipeline, (savedId) => {
      if (savedId) { pipelineId = savedId; void setPrPipeline(prov, repo, num, pipelineId); }
      if (psel) psel.innerHTML = pipeOpts();
      syncPipe();
    });
  });
  ta.oninput = () => { briefDirty = true; };
  root.querySelector('[data-x]')?.addEventListener('click', close);
  root.querySelector('#prAsgFree')?.addEventListener('click', (e) => { e.preventDefault(); onPrChip(prov, repo, num); close(); });

  // Enrich the brief with the PR body + base branch (async; re-seed only if the user hasn't edited it).
  void fetchDetail();
  async function fetchDetail(): Promise<void> {
    const res = await relay.providerPrDetail(activeWs(), prov, repo, num).catch(() => null);
    if (!root.isConnected || !res || !res.ok || !res.detail) return;
    ptitle = res.detail.title || pr.title || '';
    head = prHead(num, ptitle, res.detail.body);
    base = res.detail.baseBranch || '';
    if (!briefDirty) ta.value = seedBrief();
  }

  setTimeout(() => ta.focus(), 30);
  okBtn.addEventListener('click', async () => {
    if (assigning) return;
    const resolveMode = isResolvePipe(pipeline);
    assigning = true; okBtn.disabled = true; okBtn.textContent = resolveMode ? 'Preparing conflict worktree…' : 'Checking out PR…';
    // A resolve stage needs the base branch to merge in; make sure it's loaded (the async detail fetch may not
    // have landed yet if the user clicked fast).
    if (resolveMode && !base) { const d = await relay.providerPrDetail(activeWs(), prov, repo, num).catch(() => null); if (d && d.ok && d.detail) base = d.detail.baseBranch || ''; }
    // Resolve merges the base in (conflict live); review just checks out the head. Both drop stage-0's brief + return briefRel.
    const res = resolveMode
      ? await relay.prResolveWorktree(prov, repo, dir, num, source, base, ta.value).catch(() => ({ ok: false, error: 'Resolve worktree failed' }))
      : await relay.prWorktreeAdd(prov, repo, dir, num, pr.branch, ta.value).catch(() => ({ ok: false, error: 'Worktree creation failed' }));
    assigning = false;
    // Launch even if the dialog was Escaped during prep — the worktree exists and the agent/brief are already
    // captured; an accidental Escape must not silently drop the run (the toast still fires).
    if (!res.ok) { okBtn.disabled = false; okBtn.textContent = primaryFor(); toast(res.error || (resolveMode ? 'Could not prepare the conflict worktree' : 'Could not check out the PR')); return; }
    // Link the selected dependency repos read-only under .deps/ (best-effort — a dep that won't clone is skipped).
    if (selectedDeps.size) { okBtn.textContent = 'Linking dependencies…'; await relay.linkDeps(res.path!, dir, [...selectedDeps].map((id) => { const s = id.indexOf(':'); return { provider: (s > 0 ? id.slice(0, s) : 'github') as ProviderId, repo: s > 0 ? id.slice(s + 1) : id }; })).catch(() => null); }
    const brief0Rel = res.briefRel || '';
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!(agentOk && agent)) {   // no coding agent → just open the (conflict-materialized) worktree as a plain terminal
      deps.openAgentTab({ cwd: res.path!, name: resolveMode ? `${PR_WORD[prov]} #${num} · resolve` : `${PR_WORD[prov]} #${num}`, runCmd: resolveMode ? 'git status' : undefined });
      deps.refresh(); close();
      toast(res.reused ? `Reopened worktree for ${PR_WORD[prov]} #${num}` : (resolveMode ? `Conflict worktree ready for ${PR_WORD[prov]} #${num}` : `Worktree ready for ${PR_WORD[prov]} #${num}`), true);
      return;
    }
    const r = launchOrQueue({ provider: prov, repo, number: num, title: pr.title || pr.branch, headText: head, base, source, agentId, agentName: agent.name, pipeline: clonePipeline(pipeline), wt: res.path!, brief0Rel });
    deps.refresh(); close();
    const noun = resolveMode ? 'conflict-resolve' : 'review';
    toast(r === 'queued' ? `Queued ${noun} of ${PR_WORD[prov]} #${num} — starts when a slot frees (${workingCount()}/${CAP()} running)`
      : `${resolveMode ? 'Resolving' : 'Reviewing'} ${PR_WORD[prov]} #${num} · ${pipeline.name}`, true);
  });
}

/* ----------------------------- map board (PRs → pipelines, bulk) ----------------------------- */
export async function openPrMap(prs: PrRef[], ctx: PrCtx): Promise<void> {
  const detected = await relay.agentsDetect().catch(() => ({} as Record<string, boolean>));
  const agentOk = AGENTS.some((a) => detected[a.id]);
  const agentId = (state.settings.issueAgent && detected[state.settings.issueAgent]) ? state.settings.issueAgent! : (AGENTS.find((a) => detected[a.id])?.id || '');
  const provOf = (p: PrRef) => (p.provider || ctx.provider) as ProviderId;
  const repoOf = (p: PrRef) => p.repo || ctx.repo;
  const mappable = prs.filter((p) => prStatusOf(provOf(p), repoOf(p), p.number) === 'idle');
  const pipes = prPipelines(customPipelines());
  // Keyed by the mappable INDEX, not the PR number: across repos (All-repos scope) two PRs can share a number,
  // so number keys would collide. The index is unique and the list is fixed for the life of the dialog.
  const mapping = new Map<number, string>();      // mappable index → pipeline id
  { const stored = state.settings.prPipelineByKey || {}; mappable.forEach((p, k) => { const pid = stored[prPipeKey(provOf(p), repoOf(p), p.number)]; if (pid && pipes.some((x) => x.id === pid)) mapping.set(k, pid); }); }
  let connecting: { from: number; x: number; y: number } | null = null;   // from = mappable index

  const IW = 236, IH = 58, PW = 300, PH = 60, IX = 16, PX = 520, W = 840;
  const IY = (k: number) => 22 + k * (IH + 12);
  const PY = (k: number) => 26 + k * (PH + 14);
  const H = Math.max(mappable.length ? IY(mappable.length) : 70, pipes.length ? PY(pipes.length) : 70) + 20;
  const pIndex = (pid: string) => pipes.findIndex((p) => p.id === pid);

  const root = document.createElement('div'); root.className = 'tpl-modal im-modal';
  root.innerHTML = `<div class="tpl-sc"></div><div class="tpl-card im-card">
      <div class="pb-head"><span class="dot" style="background:var(--accent)"></span><span class="im-title">Map PRs → review pipelines</span><span class="pb-sp"></span>
        <span class="im-count" id="pmCount"></span><button class="tpl-btn ghost" id="pmCancel">Close</button><button class="tpl-btn pri" id="pmRun" disabled>Run mapped</button></div>
      <div class="im-body"><div class="im-canvas" id="pmCanvas" style="width:${W}px;height:${H}px"></div></div>
      <div class="pb-foot">Drag from a PR’s right dot onto a pipeline to map it. Click an arrow’s × (or the mapped PR) to remove it.${agentOk ? '' : ' <span style="color:#e0a44a">⚠ no coding agent on PATH — worktrees open but won’t auto-run.</span>'}</div>
    </div>`;
  document.body.appendChild(root);
  const canvas = root.querySelector('#pmCanvas') as HTMLElement;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
  document.addEventListener('keydown', onKey);
  // Overlay/scrim click does NOT close the dialog — close via its own button or Escape (the scrim is a static backdrop).
  root.querySelector('#pmCancel')?.addEventListener('click', close);
  const canvasPoint = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  function renderMap(): void {
    const paths: string[] = [];
    for (const [k, pid] of mapping) {
      const pi = pIndex(pid); if (k < 0 || k >= mappable.length || pi < 0) continue;
      const ax = IX + IW, ay = IY(k) + IH / 2, tx = PX, ty = PY(pi) + PH / 2;
      const mx = (ax + tx) / 2, my = (ay + ty) / 2;
      const d = `M${ax},${ay} C${ax + 70},${ay} ${tx - 70},${ty} ${tx},${ty}`;
      paths.push(`<g class="im-edge" data-idx="${k}">`
        + `<path class="im-hit" d="${d}" fill="none"/>`
        + `<path class="im-line" d="${d}" fill="none" marker-end="url(#pmah)"/>`
        + `<circle class="im-dot" cx="${ax}" cy="${ay}" r="4"/><circle class="im-dot" cx="${tx}" cy="${ty}" r="4"/>`
        + `<g class="im-xg" transform="translate(${mx},${my})"><circle class="im-xbg" r="8"/><path class="im-xm" d="M-3.2,-3.2 L3.2,3.2 M3.2,-3.2 L-3.2,3.2" fill="none"/></g>`
        + `</g>`);
    }
    if (connecting) { const k = connecting.from; if (k >= 0 && k < mappable.length) { const ax = IX + IW, ay = IY(k) + IH / 2; paths.push(`<path d="M${ax},${ay} L${connecting.x},${connecting.y}" fill="none" style="stroke:var(--accent-2);stroke-width:2;stroke-dasharray:5 4"/>`); } }
    const svg = `<svg class="pb-svg" width="${W}" height="${H}"><defs><marker id="pmah" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="#6e7bff"/></marker></defs>${paths.join('')}</svg>`;
    const prNodes = mappable.length ? mappable.map((p, k) => `<div class="im-issue${mapping.has(k) ? ' mapped' : ''}" data-idx="${k}" style="left:${IX}px;top:${IY(k)}px;width:${IW}px">
        <div class="im-hash">#${p.number}</div><div class="im-t">${esc(p.title || p.branch)}</div><span class="pb-port out" data-idx="${k}"></span></div>`).join('')
      : `<div class="im-none" style="left:${IX}px;top:22px">No idle PRs to map.</div>`;
    const pipeNodes = pipes.map((p, pk) => `<div class="im-pipe" data-pid="${esc(p.id)}" style="left:${PX}px;top:${PY(pk)}px;width:${PW}px">
        <span class="pb-port in"></span><div class="im-pn">${esc(p.name)}${p.builtin ? '' : ' <i class="im-cust">custom</i>'}</div><div class="im-ps">${pipePreview(p)}</div></div>`).join('');
    canvas.innerHTML = svg + prNodes + pipeNodes;
    canvas.querySelectorAll<HTMLElement>('.im-issue').forEach((node) => node.onclick = (e) => { if ((e.target as HTMLElement).closest('.pb-port')) return; const k = Number(node.dataset.idx); if (mapping.has(k)) { mapping.delete(k); const p = mappable[k]; if (p) void setPrPipeline(provOf(p), repoOf(p), p.number, pipes[0].id); renderMap(); } });
    canvas.querySelectorAll<SVGGElement>('.im-edge').forEach((g) => g.addEventListener('click', () => { const k = Number(g.dataset.idx); if (!mapping.has(k)) return; mapping.delete(k); const p = mappable[k]; if (p) void setPrPipeline(provOf(p), repoOf(p), p.number, pipes[0].id); renderMap(); }));
    canvas.querySelectorAll<HTMLElement>('.pb-port.out').forEach((port) => port.onpointerdown = (e) => {
      e.stopPropagation(); e.preventDefault();
      const from = Number(port.dataset.idx); connecting = { from, ...canvasPoint(e) };
      const move = (ev: PointerEvent) => { if (connecting) { const q = canvasPoint(ev); connecting.x = q.x; connecting.y = q.y; renderMap(); } };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        const tgt = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement)?.closest('.im-pipe') as HTMLElement | null;
        connecting = null; if (tgt?.dataset.pid) { mapping.set(from, tgt.dataset.pid); const p = mappable[from]; if (p) void setPrPipeline(provOf(p), repoOf(p), p.number, tgt.dataset.pid); } renderMap();
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    const cnt = root.querySelector('#pmCount'); if (cnt) cnt.textContent = mapping.size ? `${mapping.size} mapped` : '';
    (root.querySelector('#pmRun') as HTMLButtonElement).disabled = mapping.size === 0;
  }

  let running = false;
  root.querySelector('#pmRun')?.addEventListener('click', async () => {
    if (running || !mapping.size) return; running = true;
    const runBtn = root.querySelector('#pmRun') as HTMLButtonElement; runBtn.disabled = true; runBtn.textContent = 'Running…';
    let ok = 0;
    for (const [k, pid] of mapping) {
      const p = mappable[k]; const pipeline = pipes.find((x) => x.id === pid); if (!p || !pipeline) continue;
      const prov = provOf(p), repo = repoOf(p), n = p.number;
      const head = prHead(n, p.title || '', '');
      const resolveMode = isResolvePipe(pipeline);
      // A resolve pipeline needs the base branch (fetched per-PR) merged into the worktree; a review just checks out the head.
      let base = '';
      if (resolveMode) { const d = await relay.providerPrDetail(activeWs(), prov, repo, n).catch(() => null); if (d && d.ok && d.detail) base = d.detail.baseBranch || ''; }
      const brief0 = stageBriefText(pipeline, 0, { number: n, title: p.title || '', headText: head, base, source: p.branch }, prov);
      const res = resolveMode
        ? await relay.prResolveWorktree(prov, repo, ctx.dir, n, p.branch, base, brief0).catch(() => ({ ok: false } as { ok: boolean; path?: string; briefRel?: string }))
        : await relay.prWorktreeAdd(prov, repo, ctx.dir, n, p.branch, brief0).catch(() => ({ ok: false } as { ok: boolean; path?: string; briefRel?: string }));
      if (!res.ok) { toast(`Worktree failed for ${PR_WORD[prov]} #${n}`); continue; }
      const agent = AGENTS.find((a) => a.id === agentId);
      if (agentOk && agent) launchOrQueue({ provider: prov, repo, number: n, title: p.title || p.branch, headText: head, base, source: p.branch, agentId, agentName: agent.name, pipeline: clonePipeline(pipeline), wt: res.path!, brief0Rel: res.briefRel || '' });
      else deps.openAgentTab({ cwd: res.path!, name: resolveMode ? `${PR_WORD[prov]} #${n} · resolve` : `${PR_WORD[prov]} #${n}`, runCmd: resolveMode ? 'git status' : undefined });
      ok++;
    }
    deps.refresh(); running = false; close();
    toast(`Mapped ${ok} PR${ok === 1 ? '' : 's'} to ${agentOk ? 'their review pipelines' : 'worktrees'}`, true);
  });

  renderMap();
}

/* ----------------------------- wire-up ----------------------------- */
// A terminal closed: if it was the CURRENT stage's tab of an OCCUPYING review, its agent is gone → free the slot
// so the review queue can drain. A stale/finished-stage tab, or an already-resolved run, is ignored.
function onAgentTabClosed(tabId: string): void {
  for (const [key, run] of prRuns) {
    // Drop the closed tab from this run's loop-reuse map so the next round opens a fresh terminal for that stage.
    let owned = run.agentTabId === tabId;
    if (run.stageTabs) for (const sid of Object.keys(run.stageTabs)) if (run.stageTabs[sid] === tabId) { delete run.stageTabs[sid]; owned = true; }
    if (!owned) continue;
    // Only free the slot if the CURRENTLY-running stage's terminal closed (not a prior loop stage's idle one).
    if (run.agentTabId === tabId && OCCUPYING.includes(prRunStatus.get(key) as PrStatus)) {
      prRunStatus.delete(key); prRuns.delete(key);
      toast(`Freed the review slot held by PR #${run.number} — its terminal was closed`);
      drainQueue(); deps.refresh(); ensureStagePoll();
    }
    return; // a tab belongs to one run
  }
}
let wsIdFn: () => string = () => 'ws_default';
const activeWs = () => wsIdFn() || 'ws_default';
export function initPrReview(d: PrReviewDeps & { activeWsId: () => string }): void {
  deps = d; wsIdFn = d.activeWsId;
  d.onAgentTabClosed(onAgentTabClosed);   // closing a review terminal frees its slot (queue can't wedge on a dead run)
}
