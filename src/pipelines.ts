// Issue Pipelines — the registry + logic over the serializable model in shared/types.ts.
//
// A pipeline is a graph: STAGES wired by conditional EDGES. Each stage is one real agent run in the issue's
// worktree, seeded from a brief TEMPLATE (tokens {issue} {number} {title} {closeStep} {verdictRel}). A stage
// that emits a verdict (`.slayer/stage-<i>.json` → { passed, summary }) is a GATE: its outgoing edges each
// carry a condition (`when: 'valid'|'invalid'|'always'`) matched against that verdict; only the matching
// edge's target (a stage id, or the sentinel STOP) runs next. No edges → terminal (its PR ends the line).
//
// Built-ins live here (code); user-authored pipelines live in Settings.pipelines and are merged in. Both are
// the SAME serializable shape, so the visual builder can create/clone/edit either (built-ins are read-only —
// clone to change). Adding a pipeline = adding data; nothing in the runner or the UI changes.

import type { PipelineDef, StageDef, PipelineEdge, EdgeWhen, StageKind } from './shared/types';
export type { PipelineDef, StageDef, PipelineEdge, EdgeWhen, StageKind } from './shared/types';

export const STOP = 'stop'; // reserved edge target: end the line & report (the invalid off-ramp)

// The row RunStatus a stage drives while active (validate/fix get their own chip; the rest are generic).
export type StageStatus = 'validating' | 'fixing' | 'working';
export const stageStatus = (kind: StageKind): StageStatus => (kind === 'validate' ? 'validating' : kind === 'fix' ? 'fixing' : 'working');

/* ----------------------------- brief templates (by kind) ----------------------------- */
export const VALIDATE_BRIEF = `{issue}

---

## Validate — do not change any code
Decide whether this issue is real, correct, and reproducible in THIS repository. Investigate, don't assume: locate the relevant code and read it; try to reproduce it (run the path, or write a throwaway repro); check whether it's already fixed, works as intended, is too vague, or is a duplicate. Do NOT edit code, commit, or open a PR in this stage.

When you're done, write your verdict to \`{verdictRel}\` as JSON on one object:
{"passed": true, "summary": "one short paragraph: what you checked and why it is (or isn't) valid"}
Set passed=true only if the issue is real, reproducible, and actionable; false if already fixed / not reproducible / works as intended / too vague / a duplicate. The verdict decides whether the next stage runs.`;

const FIX_BRIEF = `{issue}

---

## Fix
This issue has been validated as real. Resolve it:
1. Make the smallest change that correctly fixes it.
2. Run the project's checks/tests if there are any.
3. Summarize what you changed and why.
4. {closeStep}`;

// Fix stage for a pipeline that has a REVIEW (or other gate) AFTER it. A plain Fix is terminal — it ends at
// its PR and writes no verdict, so the runner would never advance to the next stage. This variant appends an
// always-pass verdict so the pipeline moves on to review once the fix (and its PR) are done.
const FIX_GATED_BRIEF = `${FIX_BRIEF}

When the fix is complete, write \`{verdictRel}\` as JSON on one object: {"passed": true, "summary": "what you changed"} — this hands off to the review stage (it does not decide pass/fail; the review does).`;

const FIX_ONLY_BRIEF = `{issue}

---

## Task
1. **Validate the issue first.** Before changing anything, check whether the reported problem is real, correct, and reproducible in this codebase. If it is already fixed, not reproducible, or the report is inaccurate/invalid, say so clearly with evidence and stop — do not force a change.
2. If it is valid, implement a fix: make the smallest change that correctly resolves it, and run the project's checks/tests if there are any.
3. Summarize what you did — the fix and why, or (if no change was needed) why the issue isn't valid.
4. If the fix looks good, {closeStep}`;

const REPRODUCE_BRIEF = `{issue}

---

## Reproduce — write a failing test, change nothing else
Write the smallest test (or script) that reproduces this issue and currently FAILS. Do not fix the bug; keep the test.

When done, write \`{verdictRel}\` as JSON: {"passed": true, "summary": "how you reproduced it / the failing test"} — passed=true if you produced a reliably failing repro, false if you could not reproduce it.`;

const TEST_BRIEF = `{issue}

---

## Test — run the checks
Run the project's test / build / lint checks. Don't change product code beyond what's needed to run them.

Write \`{verdictRel}\` as JSON: {"passed": true, "summary": "which checks ran and the result"} — passed=true only if the checks are green.`;

// Shared review gate: a backend-touching change is NEVER passed on inspection alone — the reviewer must have
// actually run the backend and confirmed the affected path works, or the verdict must be passed=false. Kept in
// ONE place and interpolated into every review brief so the rule can't drift between the issue + PR reviews.
const BACKEND_GATE = `## Backend must be proven working — do NOT pass on inspection alone
First decide whether this change touches the BACKEND — a server, an HTTP/RPC/GraphQL endpoint, a database schema/migration/query, a queue/worker/cron job, auth, or any server-side business logic. If it does, reading the diff is NOT enough: you MUST actually run the backend and exercise the affected path (call the endpoint, run the query/migration, trigger the job) and observe a correct, error-free result end-to-end.
If the change is backend-related and you did NOT — or could NOT — actually run it and confirm it works, you MUST set passed=false and state plainly what stayed unverified. Never pass a backend change on assumed, inferred, or "the code looks correct" reasoning — only on behaviour you actually observed working.`;

const REVIEW_BRIEF = `{issue}

---

## Review — adversarially check the change
Review the change on this branch as a skeptical reviewer: correctness, edge cases, regressions, and whether it actually resolves the issue. Don't modify the code — but DO build and run it to verify (not just read it):
- **No errors:** it builds / compiles / type-checks cleanly.
- **No runtime errors:** exercising the affected path (or the project's tests) raises no exceptions or crashes.
- **Correct behaviour:** the right result on normal AND edge-case inputs, with no regression to existing behaviour.
Call out every error, exception, or incorrect behaviour you find.

${BACKEND_GATE}

Write \`{verdictRel}\` as JSON: {"passed": true, "summary": "your review verdict + any concerns"} — passed=true only if the change is correct, builds, runs without errors, and behaves correctly, AND (when the issue is backend-related) you actually ran the backend and confirmed the affected path works. If it's a backend change you could not validate, passed=false.`;

// The review stage of the auto-fix LOOP (issues). Same review, strict gate: ANY concern → passed=false so it's
// auto-fixed and re-reviewed; only a genuinely clean change ends the loop.
const REVIEW_LOOP_BRIEF = REVIEW_BRIEF + `

## Auto-fix loop — verdict rule
This review feeds an automatic fix→re-review loop. Set **passed=true ONLY when the change is clean with ZERO remaining concerns, caveats, or risks**. If ANYTHING should still be addressed — a minor caveat, a missing test, an unverified path — set **passed=false** and list EACH concern as its own point in the summary. Those concerns are auto-fixed (pushed to the same PR) and re-reviewed, so be specific and actionable.`;

const CUSTOM_BRIEF = `{issue}

---

## Custom stage
Replace this with the task for this stage, then carry it out.
(If this stage should gate the next one, end by writing \`{verdictRel}\` as JSON: {"passed": true, "summary": "…"}.)`;

// PR resolve: the PR's source branch is checked out AND its base branch has already been merged in (by the
// resolve worktree prep), so the conflict is live for the agent to fix, commit, and push back to the PR.
export const PR_RESOLVE_BRIEF = `{issue}

---

## Resolve this pull request's merge conflict
The PR's source branch is checked out in THIS worktree, and its base branch (\`{base}\`) has just been merged in — leaving merge conflicts that block the PR. Resolve them so the PR can merge cleanly:

1. **Find the conflicts:** \`git status\` and \`git diff --name-only --diff-filter=U\` list the conflicted files. (If there are none, the base merged cleanly — skip to step 4.)
2. **Resolve each file:** reconcile the \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` markers by keeping the intent of BOTH sides — the PR's change AND the base's change. Never blindly discard either side; read the surrounding code to understand what each meant.
3. **Verify:** \`git add\` the resolved files, then run the project's build / tests to confirm nothing broke.
4. **Commit & push:** \`git commit --no-edit\` to conclude the merge, then \`git push origin HEAD:{source}\` to update the pull request's branch. If that push is rejected (e.g. the PR comes from a fork you can't push to), do NOT push elsewhere — stop and report that a maintainer needs to push the resolution, and set passed=false below.

Do not change unrelated code. If a conflict genuinely needs a human decision, leave it, explain what's ambiguous, and set passed=false below.

When you're done, write your verdict to \`{verdictRel}\` as JSON on one object:
{"passed": true, "summary": "which files you resolved, whether the build/tests passed, and that you pushed the update"}
Set passed=true only if you resolved ALL conflicts, the build/tests pass, and you pushed; false if anything remains unresolved or needs a human.`;

// PR review: the PR's SOURCE branch is already checked out in the worktree, so the agent reviews the real diff.
export const PR_REVIEW_BRIEF = `{issue}

---

## Review this pull request — do not change any code
The PR's source branch is checked out in THIS worktree. Review the change as a skeptical reviewer: read the diff against the base branch (\`git diff {base}...HEAD\`, or your tools), and judge correctness, edge cases, regressions, security, tests, and whether it does what the PR claims.

Beyond reading the diff, verify it actually works (don't edit, commit, or push — but DO build/run):
- **No errors:** it builds / compiles / type-checks cleanly.
- **No runtime errors:** exercising the affected path (or the project's tests) raises no exceptions or crashes.
- **Correct behaviour:** the right result on normal AND edge-case inputs, with no regression to existing behaviour.
Call out every error, exception, or incorrect behaviour you find.

${BACKEND_GATE}

When you're done, write your verdict to \`{verdictRel}\` as JSON on one object:
{"passed": true, "summary": "one short paragraph: your review — is it correct & ready to merge, and any concerns/risks"}
Set passed=true only if it builds, runs without errors, behaves correctly, and is ready to merge — AND (when the PR is backend-related) you actually ran the backend and confirmed the affected path works; false if it needs changes (errors, runtime failures, wrong behaviour, bugs, missing tests, risky) OR it's a backend change you could not validate.`;

// The review stage of the auto-fix LOOP. Same review, but the verdict gate is strict: ANY concern → passed=false,
// so it gets auto-fixed and re-reviewed. Only a genuinely clean PR ends the loop.
export const PR_REVIEW_LOOP_BRIEF = PR_REVIEW_BRIEF + `

## Auto-fix loop — verdict rule
This review feeds an automatic fix→re-review loop. Set **passed=true ONLY when the PR is clean with ZERO remaining concerns, caveats, or risks** and is ready to merge as-is. If ANYTHING should still be addressed — even a minor caveat, a missing test, or an unverified path — set **passed=false** and list EACH concern as its own point in the summary. Those concerns are auto-fixed and the PR is re-reviewed, so be specific and actionable.`;

// The fix stage of the auto-fix loop: address the review's concerns on the PR's OWN branch and push. The concerns
// from the latest review are appended to this brief by the runner. Hands back to review (always-pass verdict).
export const PR_REVIEW_FIX_BRIEF = `{issue}

---

## Address the review's concerns on this pull request
The PR's source branch is checked out in THIS worktree, and a review just ran — its concerns are listed at the end of this brief (and posted as a comment on the PR). Fix EVERY concern, in this repository:

- Make changes on the **current branch** (do NOT create a new branch).
- Build / type-check / run the affected path to confirm each fix works and adds no new errors.
- **Commit & push:** \`git add -A && git commit -m "fix: address review feedback"\`, then \`git push origin HEAD:{source}\` to update the pull request's branch. If the push is rejected (e.g. a fork you can't push to), do NOT push elsewhere — stop, report that a maintainer must push, and set passed=false below.

Do not change unrelated code. When you're done, write \`{verdictRel}\` as JSON on one object:
{"passed": true, "summary": "what you changed to address each concern"}
This hands back to the review stage for a re-review — it does not decide pass/fail (the review does).`;

/* ----------------------------- stage-kind catalog ----------------------------- */
// One entry per kind: the palette label, the graph dot colour, whether it typically GATES (→ its brief
// writes a verdict), and the seed brief. Add a kind here (+ a `.k-<kind> .sg-dot` colour in styles.css)
// and the builder palette + runner pick it up — no other change.
export interface KindSpec { kind: StageKind; label: string; dot: string; gates: boolean; brief: string; }
export const STAGE_KINDS: KindSpec[] = [
  { kind: 'validate',  label: 'Validate',  dot: '#5b9dd9', gates: true,  brief: VALIDATE_BRIEF },
  { kind: 'fix',       label: 'Fix',       dot: 'var(--accent)', gates: false, brief: FIX_BRIEF },
  { kind: 'reproduce', label: 'Reproduce', dot: '#22c3cf', gates: true,  brief: REPRODUCE_BRIEF },
  { kind: 'test',      label: 'Test',      dot: '#8fd0ff', gates: true,  brief: TEST_BRIEF },
  { kind: 'review',    label: 'Review',    dot: '#a78bfa', gates: true,  brief: REVIEW_BRIEF },
  { kind: 'resolve',   label: 'Resolve',   dot: '#e0774a', gates: true,  brief: PR_RESOLVE_BRIEF },
  { kind: 'custom',    label: 'Custom',    dot: '#9aa3af', gates: false, brief: CUSTOM_BRIEF },
];
export const kindSpec = (kind: StageKind): KindSpec => STAGE_KINDS.find((k) => k.kind === kind) || STAGE_KINDS[STAGE_KINDS.length - 1];
// The default brief for a stage kind, honoring a user override (Settings.stageBriefs) when set; else the built-in.
export function stageBrief(kind: StageKind, overrides?: Record<string, string>): string {
  const o = overrides?.[kind];
  return (o && o.trim()) ? o : kindSpec(kind).brief;
}

// A short nudge appended to a review/fix stage's brief telling the agent to post its result on the PR following the
// worktree's CLAUDE.md commenting protocol (identity + standard format). The FULL protocol lives in that CLAUDE.md;
// this only points at it — so the agent actually posts, and non-Claude agents read+follow it too. `prov` is loose
// (a provider id) to avoid a type import here; bitbucket has no first-class comment CLI wired, so it gets nothing.
export function commentNote(kind: StageKind, prov: string): string {
  if ((kind !== 'review' && kind !== 'fix') || prov === 'bitbucket') return '';
  const cmd = prov === 'gitlab' ? '`glab mr note --message "<comment>"`' : '`gh pr comment <number> --body "<comment>"`';
  const who = kind === 'review' ? 'the **Review Agent**' : 'the **Fix Agent**';
  const what = kind === 'review'
    ? 'post your verdict as a comment on the pull request'
    : 'post a comment on the pull request summarizing what you changed (and, if a Review Agent reviewed before you, frame it as a response to their review)';
  return `\n\n---\n## Post your result on the pull request\nBefore you finish, ${what}, following the commenting protocol in \`./CLAUDE.md\` — read it, identify yourself as ${who}, and use its standard format. Post with ${cmd}.`;
}

// A browser-verification gate appended to a review/fix brief when the user opts into "verify in Chrome": a UI change
// must be exercised in a REAL browser, not passed on inspection alone (mirrors BACKEND_GATE). Shared by the PR and
// issue pipelines. Returns '' unless enabled AND the stage is a review or fix.
export function browserNote(kind: StageKind | string, on: boolean): string {
  if (!on || (kind !== 'review' && kind !== 'fix')) return '';
  const tail = kind === 'review'
    ? 'If it is a UI change you could NOT verify in a browser, or it misbehaves on screen, set passed=false and state what stayed unverified.'
    : 'Confirm your fix in the browser before you push.';
  return `\n\n---\n## Verify in the browser (Chrome) — do NOT pass a UI change on inspection alone\nThis change may touch the FRONTEND / UI. Reading the diff is not enough: start the app (its dev server or build) and open the affected page in a REAL Chrome browser using your browser tooling (a Chrome/Playwright/Puppeteer MCP, or drive Chrome directly). Exercise the changed flow — navigate to it, click, submit, resize — and confirm it renders and behaves correctly: the intended result on screen, no broken layout, and a clean browser console (no new errors/warnings from this change). ${tail} If the change is purely backend / non-UI, say so briefly and skip the browser step.`;
}

/* ----------------------------- brief rendering ----------------------------- */
export interface BriefCtx { issue: string; number: number; title: string; closeStep: string; verdictRel: string; base?: string; source?: string; }
// Interpolate ONLY the known tokens (so literal JSON braces like {"passed":…} in the template are untouched).
export function renderBrief(brief: string, ctx: BriefCtx): string {
  return brief
    .replace(/\{issue\}/g, ctx.issue)
    .replace(/\{number\}/g, String(ctx.number))
    .replace(/\{title\}/g, ctx.title)
    .replace(/\{closeStep\}/g, ctx.closeStep)
    .replace(/\{base\}/g, ctx.base || 'the base branch')
    .replace(/\{source\}/g, ctx.source || 'HEAD')
    .replace(/\{verdictRel\}/g, ctx.verdictRel);
}

/* ----------------------------- graph helpers ----------------------------- */
// A stage GATES (forks on the verdict) when it has a conditional edge. The runner awaits a verdict for ANY
// stage with edges (see issues.ts); `isGate` drives the "if valid" graph label.
export const isGate = (s: StageDef): boolean => (s.edges || []).some((e) => e.when === 'valid' || e.when === 'invalid');
// Which edge fires for a verdict — matching condition first, else an `always` fallback; null → end the line.
export function nextEdge(stage: StageDef, passed: boolean): PipelineEdge | null {
  const edges = stage.edges || [];
  const want: EdgeWhen = passed ? 'valid' : 'invalid';
  return edges.find((e) => e.when === want) || edges.find((e) => e.when === 'always') || null;
}
export const stageIndexById = (p: PipelineDef, id: string): number => p.stages.findIndex((s) => s.id === id);

/* ----------------------------- built-in pipelines ----------------------------- */
const validateFix: PipelineDef = {
  id: 'validate-fix', name: 'Validate → Fix → Review', builtin: true,
  desc: 'Confirm the issue is real & reproducible, fix it, then adversarially review the fix (build/run it, and validate the backend if touched). Stops (invalid) if the issue isn’t real.',
  stages: [
    { id: 'validate', name: 'Validate', kind: 'validate', brief: VALIDATE_BRIEF, edges: [{ when: 'valid', to: 'fix' }, { when: 'invalid', to: STOP }], x: 30, y: 110 },
    { id: 'fix', name: 'Fix', kind: 'fix', brief: FIX_GATED_BRIEF, edges: [{ when: 'always', to: 'review' }], x: 320, y: 56 },
    { id: 'review', name: 'Review', kind: 'review', brief: REVIEW_BRIEF, edges: [{ when: 'valid', to: STOP }, { when: 'invalid', to: STOP }], x: 610, y: 56 },
  ],
};
const fixOnly: PipelineDef = {
  id: 'fix-only', name: 'Fix only', builtin: true,
  desc: 'Skip the gate — go straight to a fix + PR (self-validates in one run).',
  stages: [{ id: 'fix', name: 'Fix', kind: 'fix', brief: FIX_ONLY_BRIEF, edges: [], x: 60, y: 120 }],
};
// The auto-fix LOOP for issues: Validate → Fix → Review, where Review's concerns route BACK to Fix (which pushes
// to the same PR) and re-review — looping until a clean review, capped by the runner. Fix + Review each reuse one
// terminal across rounds. This is the "automate review + fix" option.
const validateFixLoop: PipelineDef = {
  id: 'validate-fix-loop', name: 'Validate → Fix → Review (auto-loop)', builtin: true,
  desc: 'Validate, fix, and review — then auto-fix any review concerns on the same PR and re-review, looping until clean (capped).',
  stages: [
    { id: 'validate', name: 'Validate', kind: 'validate', brief: VALIDATE_BRIEF, edges: [{ when: 'valid', to: 'fix' }, { when: 'invalid', to: STOP }], x: 30, y: 110 },
    { id: 'fix', name: 'Fix', kind: 'fix', brief: FIX_GATED_BRIEF, edges: [{ when: 'always', to: 'review' }], x: 300, y: 56 },
    { id: 'review', name: 'Review', kind: 'review', brief: REVIEW_LOOP_BRIEF, edges: [{ when: 'valid', to: STOP }, { when: 'invalid', to: 'fix' }], x: 570, y: 56 },
  ],
};
export const BUILTIN_PIPELINES: PipelineDef[] = [validateFix, validateFixLoop, fixOnly];

/* ----------------------------- registry (built-in + user-authored) ----------------------------- */
// The full list = built-ins first, then any custom pipelines (Settings.pipelines) that don't collide on id.
export function allPipelines(custom?: PipelineDef[]): PipelineDef[] {
  const seen = new Set(BUILTIN_PIPELINES.map((p) => p.id));
  const extra = (custom || []).filter((p) => p && p.id && !seen.has(p.id));
  return [...BUILTIN_PIPELINES, ...extra];
}
export function pipelineById(id?: string, custom?: PipelineDef[]): PipelineDef {
  const all = allPipelines(custom);
  return all.find((p) => p.id === id) || all[0];
}
export const defaultPipeline = (custom?: PipelineDef[]): PipelineDef => allPipelines(custom)[0];

/* ----------------------------- PR review pipelines (separate registry) ----------------------------- */
// PR review pipelines are kept OUT of the issue registry (allPipelines) so neither picker shows the other's
// built-ins: the Issues picker never offers "Review PR", and the PR picker never offers the issue fix flows.
// User-authored pipelines (Settings.pipelines) are generic, so they DO appear in both.
const reviewPr: PipelineDef = {
  id: 'review-pr', name: 'Review PR', builtin: true,
  desc: 'Check out the PR branch and review the real diff; reports ready ✓ or changes-requested.',
  stages: [{ id: 'review', name: 'Review', kind: 'review', brief: PR_REVIEW_BRIEF, edges: [{ when: 'valid', to: STOP }, { when: 'invalid', to: STOP }], x: 60, y: 110 }],
};
// Resolve-conflicts pipeline: the worktree prep merges the base branch in (conflict live), then the agent fixes
// the conflicts, commits, and pushes. A GATE stage → its verdict reports resolved ✓ or needs-a-human (changes).
const resolvePr: PipelineDef = {
  id: 'resolve-pr', name: 'Resolve conflicts', builtin: true,
  desc: 'Merge the base branch in, then have the agent resolve the conflicts, commit, and push the update.',
  stages: [{ id: 'resolve', name: 'Resolve', kind: 'resolve', brief: PR_RESOLVE_BRIEF, edges: [{ when: 'valid', to: STOP }, { when: 'invalid', to: STOP }], x: 60, y: 110 }],
};
// The auto-fix LOOP: Review → (clean) Stop, or (concerns) Fix → back to Review. Loops until a clean review, capped
// by the runner. The two stages reuse one terminal each across rounds (the runner re-drives their live sessions).
const reviewFixPr: PipelineDef = {
  id: 'review-fix-pr', name: 'Review + auto-fix', builtin: true,
  desc: 'Review the PR; on concerns, auto-fix them on the branch and re-review — looping until clean (capped).',
  stages: [
    { id: 'review', name: 'Review', kind: 'review', brief: PR_REVIEW_LOOP_BRIEF, edges: [{ when: 'valid', to: STOP }, { when: 'invalid', to: 'fix' }], x: 60, y: 110 },
    { id: 'fix', name: 'Fix', kind: 'fix', brief: PR_REVIEW_FIX_BRIEF, edges: [{ when: 'always', to: 'review' }], x: 340, y: 110 },
  ],
};
export const PR_BUILTIN_PIPELINES: PipelineDef[] = [reviewPr, reviewFixPr, resolvePr];
export function prPipelines(custom?: PipelineDef[]): PipelineDef[] {
  const seen = new Set(PR_BUILTIN_PIPELINES.map((p) => p.id));
  const extra = (custom || []).filter((p) => p && p.id && !seen.has(p.id));
  return [...PR_BUILTIN_PIPELINES, ...extra];
}
export function prPipelineById(id?: string, custom?: PipelineDef[]): PipelineDef {
  const all = prPipelines(custom);
  return all.find((p) => p.id === id) || all[0];
}
