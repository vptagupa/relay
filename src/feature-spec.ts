// New Feature tasks — the STANDARD spec authoring + review briefs and templates. A "New Feature" task runs two
// agent stages in its worktree: (0) AUTHOR — research + write a standardized spec doc + styled HTML artifact
// under docs/features/; (1) REVIEW — gate the spec against the 5 C's (correct, complete, concrete, consistent,
// project-aligned). On a passing review the task files an implementation issue.
//
// The template lives HERE as the single source of truth (embedded in the author brief), so every feature spec —
// in any repo — comes out in the same format and styling. docs/features/_TEMPLATE.md / _TEMPLATE.html mirror it
// as the human-readable, version-controlled standard.

import type { Task } from './shared/types';

export const FEATURE_TAG = 'newfeature';
export const isFeatureTask = (t: Pick<Task, 'tags'>): boolean => !!t.tags?.includes(FEATURE_TAG);

// Stable file slug from the title: "Dark Mode Toggle" -> "dark-mode-toggle".
export function slugify(title: string): string {
  return (title || 'feature').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'feature';
}
const head = (t: Task): string => `# ${t.title}\n\n${(t.body || '').trim() || '_(no description provided)_'}`;

/* ----------------------------- the standard spec template (single source of truth) ----------------------------- */
export const SPEC_TEMPLATE = `# {Feature name} — Feature Spec

> Status: Draft · Owner: Slayer T · Date: {YYYY-MM-DD} · Related: {issue/PR, or —} · Tags: New Feature

## 1. Summary
One or two sentences: what this feature is and the value it delivers.

## 2. Problem & motivation
The concrete user pain today and why solving it matters now.

## 3. Goals / Non-goals
- **Goals:** measurable outcomes this feature must achieve.
- **Non-goals:** explicitly out of scope (prevents scope creep).

## 4. Target users & user stories
Personas, then "As a <persona>, I want <capability> so that <benefit>." Cover the primary flows.

## 5. Competitive research
How leading / global brands solve this, **with source links**, and the patterns worth adopting or avoiding for this project.

## 6. Requirements
### Functional
Numbered, testable requirements.
### Non-functional
Performance, security, accessibility, privacy, i18n as applicable.

## 7. UX & flows
Key screens/states, the happy path, and edge/error states. Reference the artifact for visuals.

## 8. Technical design
Architecture fit, data model, APIs/contracts, dependencies, and **specifically how it slots into THIS codebase** (name the real modules/seams).

## 9. Rollout & metrics
Phasing/flags, and the success metrics that tell us it worked.

## 10. Risks & mitigations
The top risks and how each is mitigated.

## 11. Open questions
Anything still undecided, with an owner or a proposed default.`;

// The artifact is a self-contained, theme-aware HTML rendering of the SAME sections. The brief hands the agent
// this exact skeleton so every feature's artifact is visually identical — only the section content changes.
export const ARTIFACT_TEMPLATE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{Feature name} — Feature Spec</title>
<style>
  :root{--bg:#fff;--fg:#1a1c20;--muted:#5b626b;--card:#f6f7f9;--border:#e3e6ea;--accent:#6e7bff;--code:#eef0f4}
  @media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e8ec;--muted:#9aa3af;--card:#171a1f;--border:#282c33;--accent:#8b95ff;--code:#1b1f26}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 system-ui,'Segoe UI',sans-serif}
  .wrap{max-width:860px;margin:0 auto;padding:40px 24px 80px}
  header{border-bottom:1px solid var(--border);padding-bottom:20px;margin-bottom:8px}
  h1{font-size:30px;margin:0 0 8px}.meta{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:6px 14px}
  .tag{display:inline-block;background:var(--accent);color:#fff;border-radius:99px;padding:2px 10px;font-size:12px;font-weight:600}
  h2{font-size:19px;margin:34px 0 10px;padding-top:8px}
  h3{font-size:15px;margin:18px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  p,li{color:var(--fg)}a{color:var(--accent)}
  table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px}th,td{border:1px solid var(--border);padding:8px 10px;text-align:left}th{background:var(--card)}
  code{background:var(--code);padding:1px 5px;border-radius:5px;font-size:13px}
  blockquote{margin:0;padding:10px 14px;background:var(--card);border-left:3px solid var(--accent);border-radius:0 8px 8px 0;color:var(--muted)}
  section{border-top:1px solid var(--border);padding-top:6px}section:first-of-type{border-top:0}
</style></head><body><div class="wrap">
<header><h1>{Feature name}</h1><div class="meta"><span class="tag">New Feature</span><span>Status: Draft</span><span>Date: {YYYY-MM-DD}</span><span>Owner: Slayer T</span></div></header>
<!-- One <section> per spec heading (Summary, Problem & motivation, … Open questions), each with an <h2> and the content. Use <table> for requirements, <a href> for research sources. Keep it self-contained (no external assets). -->
</div></body></html>`;

const WEB_RESEARCH_ON = `\n## Web research (REQUIRED for this run)
Before writing, research how leading / global brands and well-known products solve this problem. Prefer primary sources (product docs, design-system pages, engineering blogs). Capture 3–6 concrete patterns worth adopting or avoiding, each with a source URL, and fold them into section 5 (Competitive research). If web access is unavailable, use your own knowledge and clearly mark that sources are from training rather than live lookups.`;
const WEB_RESEARCH_OFF = `\n## Web research
Not requested — base section 5 (Competitive research) on your own knowledge of how comparable products solve this; keep it brief and note that no live web research was run.`;

/* ----------------------------- stage 0: author ----------------------------- */
export function authorBrief(t: Task, opts: { webResearch: boolean }): string {
  const slug = slugify(t.title);
  return `# Feature Spec — AUTHOR stage — ${t.title}

You are authoring a FEATURE SPECIFICATION for this repository. Do NOT implement the feature or touch product code. Your ONLY deliverables are two files:
- \`docs/features/${slug}.md\` — the spec, following the template below EXACTLY (every section filled, no TBDs).
- \`docs/features/${slug}.html\` — a self-contained, styled artifact rendering the same content (use the artifact skeleton below verbatim; only fill the sections).

## The feature to specify
${head(t)}
${opts.webResearch ? WEB_RESEARCH_ON : WEB_RESEARCH_OFF}

## Steps
1. Read enough of THIS codebase to ground section 8 (Technical design) in the real architecture — name actual modules/seams it would use.
2. Write \`docs/features/${slug}.md\` from the SPEC TEMPLATE; fill the \`{...}\` placeholders; today's date for the date.
3. Write \`docs/features/${slug}.html\` from the ARTIFACT TEMPLATE; one <section> per heading; keep it self-contained and theme-aware.
4. \`git add docs/features/ && git commit -m "docs: feature spec for ${t.title}"\`. If an \`origin\` remote exists, \`git push -u origin HEAD\` so the spec is shareable (best-effort — don't fail the run if push is rejected).
5. Write your verdict to \`.slayer/stage-0.json\` as strict JSON: {"passed": true, "summary": "<2–3 sentences: the feature in a nutshell + confirm both files were written (and pushed, if applicable)>"}. Use passed:false ONLY if you truly could not author it — explain why in summary.

## SPEC TEMPLATE — docs/features/${slug}.md
${SPEC_TEMPLATE}

## ARTIFACT TEMPLATE — docs/features/${slug}.html
${ARTIFACT_TEMPLATE}`;
}

/* ----------------------------- stage 1: review ----------------------------- */
export function reviewBrief(t: Task): string {
  const slug = slugify(t.title);
  return `# Feature Spec — REVIEW stage — ${t.title}

The spec was authored at \`docs/features/${slug}.md\` (with the artifact \`docs/features/${slug}.html\`). REVIEW it against the five criteria below. You MAY edit the spec/artifact files to fix gaps (then re-commit) — but do NOT implement the product feature.

## Criteria (ALL must hold to pass)
1. **CORRECT** — technically accurate and genuinely FEASIBLE in THIS codebase; no wrong claims about how the code works.
2. **COMPLETE** — every template section is filled; no TBD/placeholder left; competitive research is present${'' /* with sources when research was on */}.
3. **CONCRETE** — specific and actionable; requirements are testable, not vague aspirations.
4. **CONSISTENT** — internally coherent and follows this project's conventions and architecture.
5. **ALIGNED** — fits the project's goals and how the codebase actually works.

## Steps
1. Read the spec + artifact and cross-check against the codebase.
2. For any criterion that fails, FIX the file(s) to satisfy it, then \`git commit\` (and push if an origin exists).
3. Write \`.slayer/stage-1.json\` as strict JSON: {"passed": <true ONLY if all five hold after your fixes>, "summary": "<what you verified, gaps found, and what you fixed>"}.`;
}

/* ----------------------------- the issue filed on a passing review ----------------------------- */
export function featureIssueBody(t: Task, reviewSummary: string): string {
  const slug = slugify(t.title);
  return `${(t.body || '').trim() || '_(feature described in the spec)_'}

---
**Feature spec authored & reviewed by Slayer T.** The full specification and artifact are in the repo:
- Spec: \`docs/features/${slug}.md\`
- Artifact: \`docs/features/${slug}.html\`
(on branch \`task-${t.id}\` if not yet merged)

**Review verdict:** ${reviewSummary}`;
}
