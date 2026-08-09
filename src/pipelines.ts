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

const REVIEW_BRIEF = `{issue}

---

## Review — adversarially check the change
Review the change on this branch as a skeptical reviewer: correctness, edge cases, regressions, and whether it actually resolves the issue. Don't modify the code — but DO build and run it to verify (not just read it):
- **No errors:** it builds / compiles / type-checks cleanly.
- **No runtime errors:** exercising the affected path (or the project's tests) raises no exceptions or crashes.
- **Correct behaviour:** the right result on normal AND edge-case inputs, with no regression to existing behaviour.
Call out every error, exception, or incorrect behaviour you find.

Write \`{verdictRel}\` as JSON: {"passed": true, "summary": "your review verdict + any concerns"} — passed=true only if the change is correct, builds, runs without errors, and behaves correctly.`;

const CUSTOM_BRIEF = `{issue}

---

## Custom stage
Replace this with the task for this stage, then carry it out.
(If this stage should gate the next one, end by writing \`{verdictRel}\` as JSON: {"passed": true, "summary": "…"}.)`;

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

When you're done, write your verdict to \`{verdictRel}\` as JSON on one object:
{"passed": true, "summary": "one short paragraph: your review — is it correct & ready to merge, and any concerns/risks"}
Set passed=true only if it builds, runs without errors, behaves correctly, and is ready to merge; false if it needs changes (errors, runtime failures, wrong behaviour, bugs, missing tests, risky).`;

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
  { kind: 'custom',    label: 'Custom',    dot: '#9aa3af', gates: false, brief: CUSTOM_BRIEF },
];
export const kindSpec = (kind: StageKind): KindSpec => STAGE_KINDS.find((k) => k.kind === kind) || STAGE_KINDS[STAGE_KINDS.length - 1];
// The default brief for a stage kind, honoring a user override (Settings.stageBriefs) when set; else the built-in.
export function stageBrief(kind: StageKind, overrides?: Record<string, string>): string {
  const o = overrides?.[kind];
  return (o && o.trim()) ? o : kindSpec(kind).brief;
}

/* ----------------------------- brief rendering ----------------------------- */
export interface BriefCtx { issue: string; number: number; title: string; closeStep: string; verdictRel: string; base?: string; }
// Interpolate ONLY the known tokens (so literal JSON braces like {"passed":…} in the template are untouched).
export function renderBrief(brief: string, ctx: BriefCtx): string {
  return brief
    .replace(/\{issue\}/g, ctx.issue)
    .replace(/\{number\}/g, String(ctx.number))
    .replace(/\{title\}/g, ctx.title)
    .replace(/\{closeStep\}/g, ctx.closeStep)
    .replace(/\{base\}/g, ctx.base || 'the base branch')
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
  id: 'validate-fix', name: 'Validate → Fix', builtin: true,
  desc: 'Confirm the issue is real & reproducible, then fix it. Stops (invalid) if it isn’t.',
  stages: [
    { id: 'validate', name: 'Validate', kind: 'validate', brief: VALIDATE_BRIEF, edges: [{ when: 'valid', to: 'fix' }, { when: 'invalid', to: STOP }], x: 30, y: 110 },
    { id: 'fix', name: 'Fix', kind: 'fix', brief: FIX_BRIEF, edges: [], x: 320, y: 56 },
  ],
};
const fixOnly: PipelineDef = {
  id: 'fix-only', name: 'Fix only', builtin: true,
  desc: 'Skip the gate — go straight to a fix + PR (self-validates in one run).',
  stages: [{ id: 'fix', name: 'Fix', kind: 'fix', brief: FIX_ONLY_BRIEF, edges: [], x: 60, y: 120 }],
};
export const BUILTIN_PIPELINES: PipelineDef[] = [validateFix, fixOnly];

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
export const PR_BUILTIN_PIPELINES: PipelineDef[] = [reviewPr];
export function prPipelines(custom?: PipelineDef[]): PipelineDef[] {
  const seen = new Set(PR_BUILTIN_PIPELINES.map((p) => p.id));
  const extra = (custom || []).filter((p) => p && p.id && !seen.has(p.id));
  return [...PR_BUILTIN_PIPELINES, ...extra];
}
export function prPipelineById(id?: string, custom?: PipelineDef[]): PipelineDef {
  const all = prPipelines(custom);
  return all.find((p) => p.id === id) || all[0];
}
