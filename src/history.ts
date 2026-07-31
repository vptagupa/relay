// History panel view-model — pure derivations over a tab's command blocks, no DOM or state. The
// renderer owns the panel (rail/list DOM via blockHtml, scroll handling, search box, export menu);
// it calls these to decide which blocks to show and how to label them in the outline rail.

import type { Block } from './shared/types';
import { realBlock } from './blocks-text';
import { stripAnsi } from './ansi';

/** Blocks to show in History: real blocks, optionally failures only, optionally matching `query`
 *  (searched across command + output, ANSI-stripped, case-insensitive). Returns a new array. */
export function filterHistory(blocks: Block[], query: string, failOnly: boolean): Block[] {
  let out = blocks.filter(realBlock);
  if (failOnly) out = out.filter((b) => b.exitCode != null && b.exitCode !== 0);
  const q = query.trim().toLowerCase();
  if (q) out = out.filter((b) => (stripAnsi(b.command) + ' ' + stripAnsi(b.output)).toLowerCase().includes(q));
  return out;
}

/** Outline-rail descriptor for a block: a status dot class + a one-line label. */
export function railEntry(b: Block): { dot: string; label: string } {
  const dot = b.running ? 'run' : b.interactive ? 'int' : b.exitCode === 0 ? 'ok' : b.exitCode != null ? 'fail' : 'ok';
  const label = stripAnsi(b.command).replace(/[\r\n]+/g, ' ').trim() || (b.interactive ? '(interactive)' : 'prompt');
  return { dot, label };
}
