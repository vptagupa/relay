// Issue Agent — pulls a repo's open GitHub issues via the keyless `gh` CLI (read-only), then lets you
// ASSIGN one to a coding agent: it creates an isolated git worktree (branch issue-<n>), drops the
// editable brief inside it, and opens a Relay terminal tab that launches Claude Code there. Owns the
// panel state + its DOM events; what it needs from the renderer (closing sibling panels, opening a
// terminal tab) is INJECTED via initIssues(deps) — so renderer.ts depends on this module, never the
// reverse. Next: surface the agent's result / open-PR affordance once the fix lands.

import { state } from './state';
import { $, esc } from './dom';
import { toast } from './ui';
import type { Issue } from './shared/types';

const relay = (window as any).relay;

export interface IssuesDeps {
  closeOtherPanels: () => void;   // close Agent/History/Bookmarks so panels don't overlap
  openAgentTab: (o: { cwd: string; name: string; runCmd?: string }) => void; // open a terminal tab in the issue worktree, optionally auto-launching the agent
}
let deps: IssuesDeps;

type Phase = 'idle' | 'loading' | 'ready' | 'error' | 'noagent' | 'noauth' | 'norepo';
let phase: Phase = 'idle';
let repo: string | null = null;
let issues: Issue[] = [];
let errMsg = '';
let loadedFor = '';   // the workspace folder the current result was pulled for (re-pull when it changes)
let loadSeq = 0;      // supersedes an in-flight pull when a newer one starts (folder switch / double Pull)

const hexColor = (c?: string) => (c && /^[0-9a-fA-F]{6}$/.test(c) ? '#' + c : '');

function labelHtml(l: { name: string; color?: string }): string {
  const c = hexColor(l.color);
  return `<span class="iss-lb"${c ? ` style="border-color:${c}88;color:${c}"` : ''}>${esc(l.name)}</span>`;
}

function renderPanel(): void {
  const repoEl = $('#issuesRepo'); if (repoEl) repoEl.textContent = repo || '';
  const el = $('#issuesList'); if (!el) return;
  const hint = (icon: string, msg: string, sub = '') =>
    `<div class="iss-empty"><div class="ie-i">${icon}</div><div>${msg}</div>${sub ? `<div class="ie-sub">${sub}</div>` : ''}</div>`;

  if (phase === 'loading') { el.innerHTML = `<div class="iss-empty"><div class="ie-spin"></div><div>Pulling issues…</div></div>`; return; }
  if (phase === 'noagent') { el.innerHTML = hint('🔌', 'GitHub CLI not found', 'Install <code>gh</code> to pull issues, then reopen this panel.'); return; }
  if (phase === 'noauth') { el.innerHTML = hint('🔒', 'Not signed in to GitHub', 'Run <code>gh auth login</code> in a terminal, then hit ⟳ Pull.'); return; }
  if (phase === 'norepo') { el.innerHTML = hint('🗂️', 'No GitHub repo here', esc(errMsg) || 'Open a project folder whose git remote is on GitHub.'); return; }
  if (phase === 'error') { el.innerHTML = hint('⚠️', 'Couldn’t pull issues', esc(errMsg)); return; }
  if (!issues.length) { el.innerHTML = hint('✓', 'No open issues', repo ? esc(repo) : ''); return; }

  el.innerHTML = issues.map((i) => `
    <div class="iss-row" data-num="${i.number}">
      <button class="iss-open" data-url="${esc(i.url)}" title="Open #${i.number} on GitHub">
        <div class="iss-top"><span class="iss-num">#${i.number}</span><span class="iss-title">${esc(i.title)}</span></div>
        ${i.labels.length ? `<div class="iss-labels">${i.labels.map(labelHtml).join('')}</div>` : ''}
      </button>
      <button class="iss-assign" data-num="${i.number}" title="Assign to Claude Code — create an isolated worktree and launch the agent">⚡</button>
    </div>`).join('');
  el.querySelectorAll<HTMLElement>('.iss-open').forEach((r) => {
    r.onclick = () => { const u = r.dataset.url; if (u) relay.openExternal(u); };
  });
  el.querySelectorAll<HTMLElement>('.iss-assign').forEach((b) => {
    b.onclick = () => { const n = Number(b.dataset.num); const iss = issues.find((x) => x.number === n); if (iss) void openAssign(iss); };
  });
}

// Detect gh → resolve the active workspace's repo → pull its open issues. Each failure lands on a
// specific, actionable panel state rather than a dead UI.
export async function loadIssues(): Promise<void> {
  const seq = ++loadSeq;                            // a newer pull supersedes this one at each await point
  const dir = state.settings.workspace || '';
  loadedFor = dir; phase = 'loading'; renderPanel();
  const det = await relay.githubDetect(); if (seq !== loadSeq) return;
  if (!det.gh) { phase = 'noagent'; renderPanel(); return; }
  if (!det.authed) { phase = 'noauth'; renderPanel(); return; }
  repo = dir ? await relay.githubRepo(dir) : null; if (seq !== loadSeq) return;
  if (!repo) { phase = 'norepo'; errMsg = dir ? 'This folder’s git remote isn’t on GitHub.' : 'No project folder is open.'; renderPanel(); return; }
  const r = await relay.githubIssues(repo); if (seq !== loadSeq) return;
  if (!r.ok) { phase = 'error'; errMsg = r.error || 'gh failed'; renderPanel(); return; }
  issues = r.issues || []; phase = 'ready'; renderPanel();
}

/* ----------------------------- assign → agent ----------------------------- */
// A self-contained modal (own scrim; Escape or scrim-click closes), reusing the app's dialog styles.
function modal(html: string): { root: HTMLElement; close: () => void } {
  const root = document.createElement('div'); root.className = 'tpl-modal';
  root.innerHTML = `<div class="tpl-sc"></div>${html}`;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
  document.body.appendChild(root);
  document.addEventListener('keydown', onKey);
  root.querySelector('.tpl-sc')?.addEventListener('click', close);
  return { root, close };
}

// The brief handed to the agent — the issue itself plus a small, explicit task. Editable before launch.
function defaultBrief(i: Issue): string {
  const body = (i.body || '').trim() || '_(no description provided)_';
  return `# Issue #${i.number}: ${i.title}

${body}

---

## Task
Implement a fix for the issue described above in this repository.
- Make the smallest change that correctly resolves it.
- Run the project's checks/tests if there are any.
- When you're done, summarize what you changed and why.
- If the fix looks good, open a pull request with \`gh pr create\`.
`;
}

let assigning = false; // guard the whole create-worktree round-trip against a double submit
async function openAssign(i: Issue): Promise<void> {
  const dir = state.settings.workspace || '';
  const det = await relay.claudeDetect().catch(() => ({ installed: false }));
  const agentOk = !!det.installed;
  const primary = agentOk ? '⚡ Assign & launch' : 'Create worktree & open';
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">Assign #${i.number} to Claude Code<small>${esc(i.title)}</small></span></div>
      <div class="bd">
        <div class="iss-agent ${agentOk ? 'ok' : 'no'}">${agentOk ? '✓ Claude Code detected — keyless, runs in its own subscription session' : '⚠ <code>claude</code> not found — the worktree still opens; install Claude Code to auto-launch the agent.'}</div>
        <label class="iss-lbl">Brief for the agent <span class="mut">— edit before launch</span></label>
        <textarea class="iss-brief" spellcheck="false" rows="12">${esc(defaultBrief(i))}</textarea>
        <div class="iss-wt">Creates an isolated worktree on branch <code>issue-${i.number}</code> and runs the agent there.</div>
      </div>
      <div class="ft"><span class="hint">Saved as <code>.slayer/issue-${i.number}.md</code> (git-excluded)</span><span class="r"><button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-ok>${primary}</button></span></div>
    </div>`);
  const ta = root.querySelector('.iss-brief') as HTMLTextAreaElement;
  const okBtn = root.querySelector('[data-ok]') as HTMLButtonElement;
  root.querySelector('[data-x]')?.addEventListener('click', close);
  setTimeout(() => ta.focus(), 30);
  okBtn.addEventListener('click', async () => {
    if (assigning) return;
    assigning = true; okBtn.disabled = true; okBtn.textContent = 'Creating worktree…';
    const res = await relay.worktreeAdd(dir, i.number, ta.value).catch(() => ({ ok: false, error: 'Worktree creation failed' }));
    assigning = false;
    if (!root.isConnected) return; // user backed out (Escape/scrim) while the worktree was being created — don't launch
    if (!res.ok) { okBtn.disabled = false; okBtn.textContent = primary; toast(res.error || 'Could not create worktree'); return; }
    const rel = res.briefRel || '';
    // Short, shell-safe launch line: point the agent at the brief file (no quoting of the issue text at all).
    const runCmd = agentOk
      ? (rel ? `claude "Read ${rel} and implement the fix for the GitHub issue it describes in this repository, then summarize the changes."` : 'claude')
      : undefined;
    deps.openAgentTab({ cwd: res.path!, name: `issue #${i.number}`, runCmd });
    close(); closeIssues();
    toast(res.reused ? `Reopened worktree for #${i.number}` : (agentOk ? `Launching Claude Code on #${i.number}` : `Worktree ready for #${i.number}`), true);
  });
}

export function openIssues(): void {
  deps?.closeOtherPanels();
  $('#issuesPanel').classList.add('show');
  // Reload on open unless we already have a good result for the current folder — so an error state
  // (no agent / not signed in / no repo) retries and switching folders re-pulls, but a good pull is cached.
  if (phase !== 'ready' || (state.settings.workspace || '') !== loadedFor) void loadIssues(); else renderPanel();
}
export function closeIssues(): void { $('#issuesPanel').classList.remove('show'); }
const isOpen = () => $('#issuesPanel').classList.contains('show');

// Wire the toolbar button + the panel's own controls. Call once, after the template DOM exists.
export function initIssues(d: IssuesDeps): void {
  deps = d;
  $('#btnIssues').onclick = () => (isOpen() ? closeIssues() : openIssues());
  $('#btnIssuesClose').onclick = closeIssues;
  $('#issuesRefresh').onclick = () => { void loadIssues().then(() => { if (phase === 'ready') toast(`Pulled ${issues.length} issue${issues.length === 1 ? '' : 's'}`, true); }); };
}
