// Command-block renderers — the HTML for a single command block, shared by the History panel
// (blockHtml) and the Warp-style Blocks view (bvBlockHtml). Kept in one module because both panels
// render the same Block shape; the renderer just injects the system identity (user/host/home) once
// via initBlockView and toggles collapsedBlocks. Reads only pure helpers (esc/ansi/cmdRaw) + activeTab.

import type { Block } from './shared/types';
import { esc } from './dom';
import { stripAnsi, collapseCR, ansiToHtml } from './ansi';
import { cmdRaw } from './blocks-text';
import { activeTab } from './state';

// Real identity for the Blocks-view prompt line (agent@host ~/path). Injected from relay.sys at boot.
let SYS: { user: string; host: string; home: string } = { user: 'user', host: 'relay', home: '' };
export function initBlockView(sys: { user: string; host: string; home: string } | undefined): void { if (sys) SYS = sys; }

// Blocks the user has collapsed (by block id). Kept out of the DOM so it survives the
// Blocks-view re-renders that rebuild innerHTML — otherwise a collapse would flicker back open.
export const collapsedBlocks = new Set<string>();

export function fmtDur(ms: number): string { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`; }

// Home-relative cwd for the prompt line (D:\proj\x → ~/x when under home).
function promptCwd(c: string): string {
  let p = (c || SYS.home || '~').replace(/\\/g, '/');
  const home = (SYS.home || '').replace(/\\/g, '/');
  if (home && (p === home || p.startsWith(home + '/'))) p = '~' + p.slice(home.length);
  return p;
}

// A command block as a History-panel card (plain output unless `color`). Uses collapsedBlocks state.
export function blockHtml(b: Block, color = false): string {
  const badge = b.running ? '<span class="hb-badge run">running…</span>'
    : b.exitCode === 0 ? '<span class="hb-badge ok">✓ 0</span>'
    : b.exitCode != null ? `<span class="hb-badge fail">✗ ${b.exitCode}</span>` : '';
  const dur = b.endedAt && b.startedAt ? fmtDur(b.endedAt - b.startedAt) : '';
  const d = new Date(b.startedAt); const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const cmd = stripAnsi(b.command).replace(/[\r\n]+/g, ' ').trim();
  if (b.interactive) {
    return `<div class="hb interactive" data-bid="${b.id}">
      <div class="hb-head"><span class="hb-p" style="color:var(--c-blue)">◧</span><span class="hb-cmd">${cmd ? esc(cmd) : 'interactive session'}</span><span class="hb-meta">${dur ? `<span>${dur}</span>` : ''}<span>${clock}</span></span>${badge}</div>
      <div class="hb-int">Interactive full-screen session — ran live in the terminal (screen not captured as history).</div>
      <div class="hb-actions"><button data-act="copycmd">Copy cmd</button><button data-act="rerun">Re-run</button><button data-act="pin">${b.pinned ? '★ Pinned' : '☆ Pin'}</button><button data-act="share">Share</button></div>
    </div>`;
  }
  const plain = collapseCR(stripAnsi(b.output)).trim();
  const out = color ? ansiToHtml(collapseCR(b.output)) : esc(plain);
  const failed = b.exitCode != null && b.exitCode !== 0;
  return `<div class="hb${collapsedBlocks.has(b.id) ? ' collapsed' : ''}${b.pinned ? ' pin' : ''}" data-bid="${b.id}">
    <div class="hb-head"><span class="hb-p">❯</span><span class="hb-cmd">${cmd ? esc(cmd) : '<span class="dim">prompt</span>'}</span><span class="hb-meta">${dur ? `<span>${dur}</span>` : ''}<span>${clock}</span></span>${badge}<span class="hb-chev" data-act="collapse" title="Collapse / expand">▾</span></div>
    <div class="hb-out">${plain ? out : '<span class="dim">(no output)</span>'}</div>
    <div class="hb-actions"><button data-act="copycmd">Copy cmd</button><button data-act="copyout">Copy output</button><button data-act="rerun">Re-run</button><button data-act="pin">${b.pinned ? '★ Pinned' : '☆ Pin'}</button><button data-act="share">Share</button>${failed ? '<button data-act="fix" class="fix">Ask agent to fix</button>' : ''}</div>
  </div>`;
}

// Blocks-view (Warp-style transcript) renderer — matches the artifact: a colored
// `user@host ~/path $ command` prompt line, output beneath, subtle left-accent band,
// hover-revealed actions. Output keeps its ANSI colors.
export function bvBlockHtml(b: Block): string {
  const cwd = b.cwd || activeTab()?.cwd || '';
  const cmd = cmdRaw(b); // display exactly as typed — newlines preserved (CSS renders them)
  const d = new Date(b.startedAt);
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const dur = b.endedAt && b.startedAt ? fmtDur(b.endedAt - b.startedAt) : '';
  // Artifact-style prompt line: user@host  ~/path  (accent user · dim host · path).
  const prompt = `<span class="p-user">${esc(SYS.user)}</span><span class="p-at">@</span><span class="p-host">${esc(SYS.host)}</span> <span class="p-path">${esc(promptCwd(cwd))}</span>`;
  if (b.interactive) {
    return `<div class="bvb int" data-bid="${b.id}" title="ran in ${esc(promptCwd(cwd))}"><div class="bvb-cmd"><span class="bvb-line">${prompt} <span class="bvb-text">${esc(cmd || 'interactive')}</span></span><span class="bvb-badge int">tui</span><span class="bvb-ts">${clock}</span></div><div class="bvb-out"><span class="o-dim">— interactive full-screen session · ran live in the terminal —</span></div></div>`;
  }
  const failed = b.exitCode != null && b.exitCode !== 0;
  const cls = b.running ? 'run' : failed ? 'fail' : 'ok';
  const badge = b.running ? '<span class="bvb-badge run">running…</span>'
    : failed ? `<span class="bvb-badge fail">exit ${b.exitCode}</span>`
    : `<span class="bvb-badge ok">✓</span>`; // clean green check on success (duration moves to the hover timestamp)
  const out = ansiToHtml(collapseCR(b.output));
  return `<div class="bvb ${cls}" data-bid="${b.id}" title="ran in ${esc(promptCwd(cwd))}">
    <div class="bvb-cmd"><span class="bvb-line">${prompt} <span class="bvb-text">${cmd ? esc(cmd) : ''}</span></span>${badge}<span class="bvb-ts">${dur ? esc(dur) + ' · ' : ''}${clock}</span>
      <span class="bvb-actions"><button data-act="copyout" title="Copy output">copy</button><button data-act="rerun" title="Re-run">re-run</button><button data-act="pin" title="Pin">${b.pinned ? '★' : 'pin'}</button><button data-act="share" title="Export block">share</button>${failed ? '<button data-act="fix" title="Ask the agent to fix">ask agent</button>' : ''}</span>
    </div>${out.trim() ? `<div class="bvb-out">${out}</div>` : ''}</div>`;
}
