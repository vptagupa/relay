// The agent guide dropped as CLAUDE.md into every worktree Slayer T creates. Claude Code auto-reads a worktree's
// CLAUDE.md, so this gives EVERY stage's agent (and every loop round) the same standing instructions without
// bloating each brief — the briefs just point at it. It is written non-destructively (never clobbers a repo's own
// CLAUDE.md) and kept out of the PR (git-excluded, or skip-worktree when the repo already tracks a CLAUDE.md); see
// dropAgentGuide() in main.ts.
//
// The protocol it carries: every pipeline agent posts its result on the pull request as a comment, in ONE standard
// readable format, signed with the agent's ROLE identity (Review Agent / Fix Agent) — so a PR reads as a legible
// back-and-forth (review → fix response → re-review) that both the next agent and the humans can follow.

// A marker on our section so a reused worktree is never appended twice, and so our block is distinguishable from a
// repo's own CLAUDE.md content.
export const AGENT_GUIDE_MARK = '<!-- slayer-t:agent-comment-protocol (added per worktree; do NOT commit) -->';

export const AGENT_GUIDE = `# Slayer T — pull-request commenting protocol (for automated agents)

You are one agent in a sequence working this change (typically **Review → Fix → Review → …**). Every stage records
its result **as a comment on the pull request**, so the next agent and the humans can follow the conversation.
Follow this protocol whenever your task is to **review** a change or to **fix / address feedback** on one.

## 1. Sign every comment with your role identity
The FIRST line of any PR comment you post must be a heading that identifies your role:

- If your task is to **review** the change → \`### 🔎 Review Agent\`
- If your task is to **fix** the change or **address review feedback** → \`### 🛠️ Fix Agent\`

Never post an unsigned comment, and never post under the other role's identity.

## 2. How to post
Post to the pull request for the branch you are working on:

- **GitHub:** \`gh pr comment <number> --body "<markdown>"\` (or \`gh pr comment --body "<markdown>"\` from the PR's branch)
- **GitLab:** \`glab mr note --message "<markdown>"\`

Post exactly ONE comment per stage. Never put secrets, tokens, credentials, or whole-file dumps in a comment.

## 3. After a REVIEW — post your verdict
When you finish reviewing (in addition to writing the verdict file the brief asked you to write), post your verdict
as a PR comment in this exact shape:

\`\`\`markdown
### 🔎 Review Agent
**Verdict:** ✅ Approve — ready to merge   _(use exactly one)_   🔁 Changes requested

**Summary:** <2–3 plain-language sentences: what you reviewed and the outcome.>

**What I verified**
- <e.g. built / type-checked cleanly>
- <e.g. ran the tests / exercised the affected path — with the actual observed result>

**Concerns**   _(omit this whole section only if there are genuinely none)_
1. **<short title>** — \`path/to/file:line\` — <why it's a problem and what to change>
2. …
\`\`\`

If everything is clean, set the verdict to ✅ Approve, say so in the summary, and omit the **Concerns** section.
If there is even one concern, set 🔁 Changes requested and list each concern as its own numbered, actionable item.

## 4. After a FIX — respond to the review
When you finish making the change (and, for a re-fix, after you have pushed to the PR's branch), post a PR comment
that **responds to the Review Agent's latest review** — reference it so the thread reads as a reply:

\`\`\`markdown
### 🛠️ Fix Agent
_In response to the Review Agent's review above._

**What I changed**
- <concern 1> → <the fix you made> — \`path/to/file:line\`
- <concern 2> → <the fix> — \`path/to/file:line\`

**Verification:** <built / tests — the actual observed result.>

Ready for re-review.
\`\`\`

Address **every** concern the Review Agent raised. If you deliberately did not act on one, say so explicitly and
explain why, rather than silently skipping it. If no review preceded you (e.g. the very first fix), drop the
"In response to…" line and simply summarize what you changed and how you verified it.

## 5. Keep it readable
These comments are the PR's audit trail. Write them for a human skimming the thread: short sentences, real
\`file:line\` references, the actual result of what you ran — not "should work". One comment, one role, one clear outcome.
`;
