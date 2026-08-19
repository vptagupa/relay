# Slayer T — Feature Roadmap

> Status: Backlog · Owner: Slayer T · Date: 2026-08-17

A prioritized backlog of the next candidate features, grouped by intent. Each entry is a **compact spec**
(summary, why now, scope, where it slots into THIS codebase, effort). When a feature is greenlit, promote it to
a full spec at `docs/features/<slug>.md` (the `_TEMPLATE.md` structure) — that's what the **New Feature** task
pipeline authors.

**Where we are:** Slayer T is an agentic terminal + multi-provider (GitHub / GitLab / Bitbucket) Issue/PR/Task
orchestrator. Recent work made the provider integration **write-capable** — create issue, add/remove labels, post
a PR comment, task-type labels. The provider write pattern is established: an `Adapter` method in
`src/providers.ts` → a validated IPC handler in `src/main.ts` → a typed bridge in `src/preload.ts` → UI in
`src/issues.ts` / `src/prs.ts`.

---

## Lane 1 — Close the provider loop
Small, high value-per-effort, and direct extensions of the label/comment work. Goal: fully triage and ship
without leaving the app.

### 1. Read the conversation (issue/PR comments)
**Summary.** Show the comment/discussion thread inline; today you can *post* a PR comment but can't *read* the thread.
**Why now.** Completes the comment loop we just shipped — posting without reading is half a feature.
**Scope.** Provider `prComments()` / `issueComments()` GET (paged, newest last); render the thread in the PR hover
card (below the description) and the issue details view. Read-only; reuse the existing comment composer to reply.
**Fits.** `providers.ts` (`prComments`/`issueComments` + `Adapter`) · `main.ts`/`preload.ts` (IPC) · `prs.ts`
(hover card thread) · `issues.ts` (details thread).
**Effort.** Small–moderate.

### 2. PR lifecycle actions — merge / close / review
**Summary.** From the PR card: **merge** (with method choice), **close**, and submit a real **approve /
request-changes** review verdict.
**Why now.** A pipeline can review a PR, but a human still has to leave the app to actually ship it.
**Scope.** GitHub: `PUT /pulls/{n}/merge`, `PATCH …state=closed`, `POST /pulls/{n}/reviews`. GitLab MR merge /
close / approve. Bitbucket merge / decline. Guard destructive actions with a confirm; reflect the new state on the
row.
**Fits.** `providers.ts` (`prMerge`/`prClose`/`prReview`) · `main.ts`/`preload.ts` · `prs.ts` (card actions) ·
`pr-review.ts` (a passing review verdict could offer one-click approve).
**Effort.** Moderate.

### 3. Assign a person (assignees)
**Summary.** Set / clear an issue or PR's assignees, plus a one-click **self-assign**. `i.assignees` is already
displayed — just not settable.
**Why now.** Same shape as the labels we just added; the display already exists.
**Scope.** Provider `setAssignees()` (GitHub `POST/DELETE …/assignees`; GitLab `assignee_ids`; Bitbucket
reviewers). A member picker reusing the existing `repoMembers` list.
**Fits.** `providers.ts` (`setAssignees` + reuse `repoMembers`) · `main.ts`/`preload.ts` · `issues.ts`/`prs.ts`
(assignee chip + picker).
**Effort.** Small–moderate.

### 4. Close / reopen an issue + comment on an issue
**Summary.** Close/reopen an issue from its details; comment on an issue (symmetric with the PR comment we shipped).
**Why now.** Rounds out issue triage; the comment composer already exists.
**Scope.** Provider `setIssueState()` (open/closed) + reuse the comment path (GitHub issue comments = the same
endpoint as PR comments). Buttons in the issue details view.
**Fits.** `providers.ts` (`setIssueState`, generalize `prComment` → `issueComment`) · `issues.ts` (details actions).
**Effort.** Small.

---

## Lane 2 — Bigger bets (identity-expanding)

### 5. SSH client
**Summary.** Connect to remote hosts and open remote shells — the biggest capability jump for a terminal app.
**Why now.** A spec already exists (the "Slayer — SSH Client Spec" artifact); it moves Slayer T from a local
terminal to a remote workstation.
**Scope.** A connection manager (hosts, keys via the OS keychain / `safeStorage`), SSH PTYs alongside local ones,
and reconnect/keep-alive. Decide `ssh` binary via `node-pty` vs. an `ssh2` library.
**Fits.** New module + `pty.ts` (SSH-backed terminals) · `main.ts` (connection lifecycle) · a new rail/UI.
Reference: the SSH Client Spec artifact.
**Effort.** Large.

### 6. Multi-window workspaces
**Summary.** Open each workspace in its own OS window; run several live at once.
**Why now.** Already proposed and diagrammed (the "Multi-Window Workspaces" artifact); shells already survive in
main, snapshots are already per-id.
**Scope.** Promote the `win` singleton to a window registry, route IPC per-window, one-workspace-per-window guard,
cross-window settings/def sync.
**Fits.** `main.ts` (window registry + IPC routing) · `workspaces.ts` (open-in-new-window + sync).
Reference: the Multi-Window Workspaces artifact. **Blocked on:** two decisions (separate windows vs. tiled;
pinned vs. switchable).
**Effort.** Moderate.

### 7. In-app diff viewer
**Summary.** Read a PR's diff inside the app — no worktree spin-up or provider round-trip.
**Why now.** Reviewing currently means opening a worktree or the provider; a quick read-only diff would cover most
review glances.
**Scope.** Provider `prDiff()` (GitHub `/pulls/{n}` diff media type or `/files`; GitLab MR changes; Bitbucket
diff) + a syntax-aware, collapsible diff component (hunks, file tree).
**Fits.** `providers.ts` (`prDiff`) · a new diff view opened from the PR card.
**Effort.** Moderate–large (the renderer component is the bulk).

---

## Lane 3 — Polish / developer experience

### 8. Rate-limit / API-health indicator
**Summary.** Surface remaining API quota + a "rate-limited, backing off" state in the header.
**Why now.** The rate-limit tracking already exists (`providerRateLimit`); it's just not visible.
**Scope.** A small header/status chip reading `relay.providerRateLimit()`; amber when low, red + reset countdown
when limited.
**Fits.** `preload.ts` (`providerRateLimit` exists) · a header indicator + light polling.
**Effort.** Small.

### 9. Agent run history
**Summary.** A log of past pipeline runs + verdicts across issues/PRs/tasks (what ran, pass/fail, when, the PR it
produced).
**Why now.** Runs are ephemeral (`runStatus`/`runs` are in-memory); there's no record of what the agent did.
**Scope.** Persist run outcomes to a store, and a history view (filter by repo / outcome).
**Fits.** `issues.ts` / `pr-review.ts` / `tasks.ts` (emit outcomes) · `store.ts` (persist) · a history rail/view.
**Effort.** Moderate.

### 10. Global search
**Summary.** One search across issues, PRs, and tasks (and their labels/authors).
**Why now.** Each rail searches its own list; there's no cross-rail find.
**Scope.** Start client-side over loaded items; optionally escalate to provider search endpoints for depth.
**Fits.** A command-palette-style overlay reading the rails' loaded data.
**Effort.** Small–moderate (client-side) / larger with provider search.

---

## Recommended sequence
1. **Lane 1** end-to-end (read comments → PR merge/close/review → assign → issue close/comment) — cheap, compounding,
   removes the last reasons to leave the app mid-review.
2. **One Lane-2 bet** by appetite: **SSH** to expand what the app *is*, or **multi-window** to finish the workspace
   flow (unblock its two decisions first).
3. **Lane 3** polish opportunistically (the rate-limit indicator is nearly free).

## Related design artifacts
- **Multi-Window Workspaces** — proposal + before/after diagram (feature #6).
- **Slayer — SSH Client Spec** — the SSH feature spec (feature #5).
