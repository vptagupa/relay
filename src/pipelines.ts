// Issue Pipelines — the registry (single source of truth), mirroring the themes.ts pattern.
//
// A pipeline is a small graph: STAGES wired by conditional EDGES. Each stage is one real agent run in the
// issue's worktree, seeded with a stage-specific brief FILE. A stage that emits a verdict (the agent writes
// `.slayer/stage-<i>.json` → { passed, summary }) is a GATE: its outgoing edges each carry a condition
// (`when: 'valid' | 'invalid' | 'always'`) matched against that verdict, and only the matching edge's
// target runs next. The built-in pipeline is Validate → Fix:
//   • Validate: confirm the issue is real, correct & reproducible — write a verdict, change nothing.
//       edges: when valid → Fix,  when invalid → stop.
//   • Fix: implement the smallest correct change and open the PR/MR. (no edges → terminal → review)
// So a `passed:false` verdict routes to `stop` — Fix never runs, no PR, and the issue row shows `invalid`
// with the agent's reason (a one-click override can still run Fix anyway).
//
// Adding a pipeline = adding one object here (and, for a new stage kind, its brief template). Nothing in
// the runner or the UI needs to change — they follow `stages` + `edges`.

import type { Issue } from './shared/types';

// Stage kinds map 1:1 to the row/graph status a stage shows while it runs. `validate`/`fix` are shipped;
// the rest are here so the registry (and future editor) can grow without touching the runner.
export type StageKind = 'validate' | 'fix' | 'reproduce' | 'test' | 'review' | 'custom';

// The row status a stage drives while it's the active stage. A gated stage awaits a verdict; a
// non-gated stage is terminal (its completion is signalled externally — e.g. a Fix opens a PR → review).
export type StageStatus = 'validating' | 'fixing' | 'working';

// A transition out of a stage. `when` is matched against the stage's verdict (`always` = fires regardless,
// used as a fallback); `to` is the next stage's `name`, or the sentinel `STOP` ('stop') — end the line and
// report (the invalid off-ramp). A stage that has ANY edges advances by writing its verdict file; the runner
// polls for it, then picks the matching edge. A stage with NO edges is terminal (Fix → its PR ends the line).
export type EdgeWhen = 'valid' | 'invalid' | 'always';
export interface PipelineEdge { when: EdgeWhen; to: string; }
export const STOP = 'stop';

// Everything a stage's brief template needs, filled in by the runner at launch time.
export interface StageCtx {
  i: Issue;            // the issue itself (title + body + number) — goes in the brief FILE, never on the CLI
  closeStep: string;   // provider-specific "open the PR/MR + Closes #n" instruction (from PROVS[provider])
  verdictRel: string;  // where a GATE stage must write its `{ passed, summary }` verdict (relative to the worktree)
}

export interface PipelineStage {
  name: string;        // display label (graph node + row status text derive from this / status)
  kind: StageKind;
  status: StageStatus; // the run-status the row shows while this stage is active
  brief: (c: StageCtx) => string; // the stage's editable-seed brief, written to a FILE the agent reads
  edges?: PipelineEdge[]; // outgoing transitions; a conditional edge makes this a GATE. No edges → terminal.
}

export interface Pipeline {
  id: string;
  name: string;
  desc: string;
  stages: PipelineStage[];
}

// A stage is a GATE — it forks on the verdict — when at least one outgoing edge is conditional. (Used for the
// "if valid" graph label; the runner awaits a verdict for ANY stage with edges, not only conditional ones.)
export const isGate = (s: PipelineStage): boolean => !!s.edges?.some((e) => e.when === 'valid' || e.when === 'invalid');
// Which edge fires given a verdict — prefer the matching condition, else an `always` fallback; null → end the line.
export function nextEdge(stage: PipelineStage, passed: boolean): PipelineEdge | null {
  const edges = stage.edges || [];
  const want: EdgeWhen = passed ? 'valid' : 'invalid';
  return edges.find((e) => e.when === want) || edges.find((e) => e.when === 'always') || null;
}
export const stageIndexByName = (p: Pipeline, name: string): number => p.stages.findIndex((s) => s.name === name);

const bodyOf = (i: Issue): string => (i.body || '').trim() || '_(no description provided)_';
const head = (i: Issue): string => `# Issue #${i.number}: ${i.title}\n\n${bodyOf(i)}`;

// ---- shipped stages ----------------------------------------------------------------------------------

// Validate (GATE): investigate whether the issue is real WITHOUT touching code, then emit a verdict the
// runner reads. This is how "how does Claude know it's valid?" is answered — not a guess, a real
// investigation whose conclusion is written to a structured file the runner gates on.
const validateStage: PipelineStage = {
  name: 'Validate', kind: 'validate', status: 'validating',
  edges: [{ when: 'valid', to: 'Fix' }, { when: 'invalid', to: STOP }], // the conditional gate: valid → Fix, invalid → stop
  brief: ({ i, verdictRel }) => `${head(i)}

---

## Stage 1 — VALIDATE (do not change any code)

Decide whether this issue is real, correct, and worth fixing in THIS repository. Investigate, don't assume:
- Locate the relevant code and read it.
- Try to reproduce the reported problem (run the path, or write a throwaway repro).
- Check whether it's already fixed (recent commits), works as intended, or the report is inaccurate/too vague/a duplicate.

Do **not** edit code, create commits, or open a PR in this stage — this is validation only.

When you're done, write your verdict to \`${verdictRel}\` as JSON on a single object:
\`\`\`json
{ "passed": true, "summary": "one short paragraph: what you checked and why it is (or isn't) valid" }
\`\`\`
Set \`passed\` to **true** only if the issue is real, reproducible, and actionable. Set it to **false** if it's already fixed, not reproducible, works as intended, too vague to act on, or a duplicate — and explain why in \`summary\`. The verdict decides whether the Fix stage runs, so be honest and specific.`,
};

// Fix (terminal): the issue is validated real → implement the smallest correct change and open the PR/MR.
const fixStage: PipelineStage = {
  name: 'Fix', kind: 'fix', status: 'fixing',
  brief: ({ i, closeStep }) => `${head(i)}

---

## Stage 2 — FIX

This issue has been validated as real. Now resolve it:
1. Make the smallest change that correctly fixes it.
2. Run the project's checks/tests if there are any.
3. Summarize what you changed and why.
4. ${closeStep}`,
};

// Fix-only variant of the Fix stage — for the single-stage pipeline it also self-validates first (there's
// no separate gate), preserving the original one-shot Assign behaviour.
const fixOnlyStage: PipelineStage = {
  name: 'Fix', kind: 'fix', status: 'fixing',
  brief: ({ i, closeStep }) => `${head(i)}

---

## Task
1. **Validate the issue first.** Before changing anything, check whether the reported problem is real, correct, and reproducible in this codebase. If it is already fixed, not reproducible, or the report is inaccurate/invalid, say so clearly with evidence and stop — do not force a change.
2. If it is valid, implement a fix:
   - Make the smallest change that correctly resolves it.
   - Run the project's checks/tests if there are any.
3. Summarize what you did — the fix and why, or (if no change was needed) why the issue isn't valid.
4. If the fix looks good, ${closeStep}`,
};

// ---- registry ----------------------------------------------------------------------------------------

export const PIPELINES: Pipeline[] = [
  {
    id: 'validate-fix', name: 'Validate → Fix',
    desc: 'Confirm the issue is real & reproducible, then fix it. Stops (invalid) if it isn’t.',
    stages: [validateStage, fixStage],
  },
  {
    id: 'fix-only', name: 'Fix only',
    desc: 'Skip the gate — go straight to a fix + PR (self-validates in one run).',
    stages: [fixOnlyStage],
  },
];

export const defaultPipeline = (): Pipeline => PIPELINES[0];
export const pipelineById = (id?: string): Pipeline => PIPELINES.find((p) => p.id === id) || PIPELINES[0];
