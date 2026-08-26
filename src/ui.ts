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

// A lazy hover-preview card for a list. Hovering a row (matching `rowSel`) for ~350ms calls `render(row)` for the
// card's HTML (a string, a Promise for async data, or null to skip); the card is positioned beside the row and
// shown. The card is HOVERABLE + scrollable (like the PR hover): a `mouseenter` on it cancels the pending hide, and
// leaving a row only SCHEDULES a hide (a grace delay), so moving the mouse across the gap onto the card — or between
// a row's own children — never closes it. Delegated on the container, so it survives row re-renders. Attach once.
export function attachHoverCard(container: HTMLElement | null, rowSel: string, render: (row: HTMLElement) => string | null | Promise<string | null>): void {
  if (!container) return;
  let card: HTMLDivElement | null = null;
  let showT: number | null = null;
  let hideT: number | null = null;
  let token = 0;   // bumped on every show/hide; a stale async render whose token changed is dropped
  const cancelHide = (): void => { if (hideT) { clearTimeout(hideT); hideT = null; } };
  const scheduleHide = (): void => { cancelHide(); hideT = window.setTimeout(() => { token++; if (card) card.style.display = 'none'; }, 240); };
  const ensureCard = (): HTMLDivElement => {
    if (!card) {
      card = document.createElement('div'); card.className = 'hovercard'; document.body.appendChild(card);
      card.addEventListener('mouseenter', cancelHide);   // moving ONTO the card keeps it open
      card.addEventListener('mouseleave', scheduleHide); // leaving the card hides it after the grace delay
    }
    return card;
  };
  const position = (row: HTMLElement, c: HTMLDivElement): void => {
    const r = row.getBoundingClientRect(); const w = c.offsetWidth || 330;
    let left = r.left - w - 12; if (left < 8) left = r.right + 12;   // prefer LEFT of the (right-docked) rail
    c.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
    c.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - c.offsetHeight - 8))}px`;
  };
  container.addEventListener('mouseover', (e) => {
    const row = (e.target as HTMLElement).closest(rowSel) as HTMLElement | null;
    if (!row || !container.contains(row)) return;
    cancelHide();
    if (showT) clearTimeout(showT);
    const my = ++token;
    showT = window.setTimeout(async () => {
      let html: string | null = null;
      try { html = await Promise.resolve(render(row)); } catch { html = null; }
      if (my !== token || !html) return;               // cursor moved on / nothing to show
      const c = ensureCard(); c.innerHTML = html; c.scrollTop = 0; c.style.display = 'block';
      position(row, c);
    }, 350);
  });
  container.addEventListener('mouseout', (e) => {
    const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
    // Keep it open while moving WITHIN a row's children, onto another row, or onto the card itself.
    if (to && ((to.closest && to.closest(rowSel)) || card?.contains(to))) return;
    if (showT) { clearTimeout(showT); showT = null; }   // hadn't shown yet → cancel the pending show
    scheduleHide();                                     // shown → hide after a grace delay (bridges the row→card gap)
  });
  container.addEventListener('scroll', () => { if (showT) { clearTimeout(showT); showT = null; } token++; if (card) card.style.display = 'none'; }, true);
}
