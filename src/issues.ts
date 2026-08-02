// Issue Agent — Phase 1: a read-only Issues panel that pulls a repo's open GitHub issues via the
// keyless `gh` CLI. Owns the panel state + its DOM events; the one thing it needs from the renderer
// (closing the sibling floating panels) is INJECTED via initIssues(deps) — so renderer.ts depends on
// this module, never the reverse. Later phases (assign → agent → worktree → PR) layer onto this seam.

import { state } from './state';
import { $, esc } from './dom';
import { toast } from './ui';
import type { Issue } from './shared/types';

const relay = (window as any).relay;

export interface IssuesDeps {
  closeOtherPanels: () => void;   // close Agent/History/Bookmarks so panels don't overlap
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
    <button class="iss-row" data-url="${esc(i.url)}" title="Open #${i.number} on GitHub">
      <div class="iss-top"><span class="iss-num">#${i.number}</span><span class="iss-title">${esc(i.title)}</span></div>
      ${i.labels.length ? `<div class="iss-labels">${i.labels.map(labelHtml).join('')}</div>` : ''}
    </button>`).join('');
  el.querySelectorAll<HTMLElement>('.iss-row').forEach((r) => {
    r.onclick = () => { const u = r.dataset.url; if (u) relay.openExternal(u); };
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
