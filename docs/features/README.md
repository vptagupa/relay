# Feature specs

Every **New Feature** task in Slayer T authors a spec here, in a standard format, then a review stage gates it
against five criteria (correct, complete, concrete, consistent, project-aligned) before an implementation issue
is filed.

- **`_TEMPLATE.md`** — the standard spec structure. Each feature spec is `docs/features/<slug>.md`.
- **`_TEMPLATE.html`** — the standard, self-contained, theme-aware artifact. Each feature's artifact is
  `docs/features/<slug>.html`.

The authoritative copy of both templates lives in code (`src/feature-spec.ts`), embedded into the authoring
brief so specs come out identical in any repo; these files are the human-readable mirror. Keep them in sync.
