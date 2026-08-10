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

/** Insert a search box just above `listEl` that filters its direct children by text (case-insensitive
 *  substring). A no-op for short lists (≤ `min`) where a filter would only be clutter. Used by the repo
 *  pickers (Sources, notification watch-list, dependency selectors) so long repo lists are searchable. */
export function addSearch(listEl: HTMLElement | null, placeholder = 'Search…', min = 6): void {
  if (!listEl) return;
  const items = Array.from(listEl.children) as HTMLElement[];
  if (items.length <= min) return;
  const search = document.createElement('input');
  search.type = 'text'; search.className = 'list-search'; search.placeholder = placeholder;
  search.spellcheck = false; search.autocomplete = 'off';
  listEl.parentElement?.insertBefore(search, listEl);
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    for (const it of items) it.style.display = !q || (it.textContent || '').toLowerCase().includes(q) ? '' : 'none';
  };
}

/** Turn `el` into an inline editor: select its text, commit on Enter/blur, insert a newline on Shift+Enter,
 *  cancel (restore) on Escape. `onDone` always runs afterward (commit OR cancel). A draggable ancestor is
 *  un-draggabled while editing. (Multiline shows for fields whose CSS is white-space:pre-wrap, e.g. bookmarks.) */
export function makeEditable(el: HTMLElement, commit: (v: string) => void, onDone?: () => void): void {
  const dragAnc = el.closest('[draggable="true"]') as HTMLElement | null; // don't drag while renaming
  if (dragAnc) dragAnc.draggable = false;
  const original = el.innerText;   // innerText = the RENDERED text, so multiline line breaks read back as \n
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
    // Read innerText, NOT textContent: Shift+Enter inserts a block break (<div>/<br>) that textContent flattens
    // (dropping the newlines), whereas innerText renders it back as \n — so the saved text keeps its line breaks.
    if (save) commit(el.innerText.trim()); else el.textContent = original; // Escape restores the old text
    el.blur();
    onDone?.(); // always runs, on commit OR cancel
  };
  el.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) document.execCommand('insertText', false, '\n'); // Shift+Enter → newline (multiline bookmarks); read back via innerText so the break survives on save
      else done(true);                                                  // plain Enter commits
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } // don't let Escape also close the panel
  };
  el.onblur = () => done(true);
}
