// Turning command blocks (+ agent chat) into plain text and exportable documents — pure, no DOM.
//
// The Blocks view keeps rich Block objects (raw ANSI output, exit codes, timing); this module is the
// text side of that: strip a block to its plain command/output, decide what counts as a "real" block,
// and serialize a session to Markdown / JSON / plain text / HTML. Kept separate from the DOM view so
// export is testable and doesn't depend on the renderer.

import type { Block, ChatTurn } from './shared/types';
import { modelById } from './shared/models';
import { stripAnsi, collapseCR } from './ansi';

export type ExFmt = 'md' | 'json' | 'txt' | 'html';

// Only the fields export needs — not the full renderer Tab (which carries xterm/DOM handles).
export interface ExportTab { name: string; cwd: string; model: string; chat: ChatTurn[]; }

/** A block worth showing/exporting: it has a command, some output, or is an interactive session. */
export function realBlock(b: Block): boolean { return !!((b.command && b.command.trim()) || b.output.trim() || b.interactive); }

/** Block output as plain text (ANSI stripped, CR-overwrites collapsed); interactive sessions elide output. */
function outText(b: Block): string { return b.interactive ? '(interactive session)' : collapseCR(stripAnsi(b.output)).trimEnd(); }
/** The command on a single line (newlines flattened) — for labels, copy, and export headers. */
export function cmdText(b: Block): string { return stripAnsi(b.command).replace(/[\r\n]+/g, ' ').trim(); }
// The command exactly as typed — newlines preserved (for display + faithful re-run).
export function cmdRaw(b: Block): string { return stripAnsi(b.command).replace(/\r\n?/g, '\n').replace(/\s+$/, ''); }

// Serialize a terminal's blocks (+ chat) to Markdown / JSON / plain text / HTML. `blocks`
// is passed in so this covers both whole-session export and single-block "share".
export function buildExport(t: ExportTab, blocks: Block[], fmt: ExFmt): { content: string; ext: string } {
  if (fmt === 'json') {
    return { ext: 'json', content: JSON.stringify({
      name: t.name, cwd: t.cwd, model: t.model,
      blocks: blocks.map((b) => ({ command: cmdText(b), output: outText(b), exitCode: b.exitCode, interactive: !!b.interactive, startedAt: b.startedAt, endedAt: b.endedAt })),
      chat: t.chat,
    }, null, 2) };
  }
  if (fmt === 'txt') {
    const L: string[] = [t.name, `cwd: ${t.cwd || '~'}`, ''];
    for (const b of blocks) { L.push(`$ ${cmdText(b)}${b.exitCode != null ? `   [exit ${b.exitCode}]` : ''}`); const o = outText(b); if (o) L.push(o); L.push(''); }
    if (t.chat.length) { L.push('--- Agent ---', ''); for (const m of t.chat) L.push(`${m.role === 'user' ? 'You' : 'Agent'}: ${m.content}`, ''); }
    return { ext: 'txt', content: L.join('\n') };
  }
  if (fmt === 'html') {
    const h = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let o = `<!doctype html><meta charset=utf8><title>${h(t.name)}</title><style>body{background:#0b0e13;color:#d8dee7;font:13px ui-monospace,Consolas,monospace;padding:24px;max-width:900px;margin:auto}h1{font:600 18px system-ui,sans-serif;color:#f4f7fb}.m{color:#66717f;margin-bottom:16px}.b{border:1px solid #232a33;border-radius:9px;margin:10px 0;overflow:hidden}.c{background:#11161d;padding:9px 12px;color:#e8edf3}.c .p{color:#f0b429}.o{padding:9px 12px;white-space:pre-wrap;color:#b6c0cb}.ok{color:#7ee787}.fail{color:#ff7b72}</style>`;
    o += `<h1>${h(t.name)}</h1><div class=m>${h(t.cwd || '~')} · ${h(modelById(t.model).name)}</div>`;
    for (const b of blocks) { const badge = b.exitCode === 0 ? '<span class=ok>✓ 0</span>' : b.exitCode != null ? `<span class=fail>✗ ${b.exitCode}</span>` : ''; o += `<div class=b><div class=c><span class=p>❯</span> ${h(cmdText(b))} ${badge}</div><div class=o>${h(outText(b))}</div></div>`; }
    if (t.chat.length) { o += '<h1>Agent</h1>'; for (const m of t.chat) o += `<div class=b><div class=c>${m.role === 'user' ? 'You' : 'Agent'}</div><div class=o>${h(m.content)}</div></div>`; }
    return { ext: 'html', content: o };
  }
  const L: string[] = [`# ${t.name}`, '', `Working directory: \`${t.cwd || '~'}\`  ·  Model: ${modelById(t.model).name}`, ''];
  if (blocks.length) { L.push('## Terminal', ''); for (const b of blocks) { const o = outText(b); L.push('```console', '❯ ' + cmdText(b) + (b.exitCode != null ? `   # exit ${b.exitCode}` : '')); if (o) L.push(o); L.push('```', ''); } }
  if (t.chat.length) { L.push('## Agent conversation', ''); for (const m of t.chat) L.push(`**${m.role === 'user' ? 'You' : 'Agent'}:** ${m.content}`, ''); }
  return { ext: 'md', content: L.join('\n') };
}
