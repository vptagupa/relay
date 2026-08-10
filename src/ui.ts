// Shared UI interaction helpers — a transient toast and inline (contenteditable) rename. They touch
// only the DOM (no app state, no relay), so any view can import them directly instead of the renderer
// owning them privately or feature modules having to inject them.

import { $, esc } from './dom';

let toastT: ReturnType<typeof setTimeout> | null = null;

/** Show a transient toast that auto-dismisses; `ok` styles it as a success. */
export function toast(msg: string, ok = false): void {
  const w = $('#toastWrap');
  w.innerHTML = `<div class="toast ${ok ? 'ok' : ''}"><span class="tdot"></span>${esc(msg)}</div>`;
  if (toastT) clearTimeout(toastT); // don't let a prior toast's timer clear this newer one early
  toastT = setTimeout(() => { w.innerHTML = ''; toastT = null; }, 2600);
}

/** Turn `el` into an inline editor: select its text, commit on Enter/blur, insert a newline on Shift+Enter,
 *  cancel (restore) on Escape. `onDone` always runs afterward (commit OR cancel). A draggable ancestor is
 *  un-draggabled while editing. (Multiline shows for fields whose CSS is white-space:pre-wrap, e.g. bookmarks.) */
export function makeEditable(el: HTMLElement, commit: (v: string) => void, onDone?: () => void): void {
  const dragAnc = el.closest('[draggable="true"]') as HTMLElement | null; // don't drag while renaming
  if (dragAnc) dragAnc.draggable = false;
  const original = el.textContent || '';
  el.setAttribute('contenteditable', 'true');
  el.focus();
  const sel = window.getSelection(); const r = document.createRange();
  r.selectNodeContents(el); sel?.removeAllRanges(); sel?.addRange(r);
  let finished = false;
  const done = (save: boolean) => {
    if (finished) return; finished = true;
    el.onblur = null; el.onkeydown = null; // detach BEFORE blur so cancel can't re-commit via onblur
    el.removeAttribute('contenteditable');
    if (dragAnc) dragAnc.draggable = true;
    if (save) commit(el.textContent?.trim() || ''); else el.textContent = original; // Escape restores the old text
    el.blur();
    onDone?.(); // always runs, on commit OR cancel
  };
  el.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) document.execCommand('insertText', false, '\n'); // Shift+Enter → a literal newline (multiline bookmarks); pre-wrap renders it, textContent keeps it
      else done(true);                                                  // plain Enter commits
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } // don't let Escape also close the panel
  };
  el.onblur = () => done(true);
}
