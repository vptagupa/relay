// A shared multi-select "filter by author" popup, anchored to an icon button. Used by both the Issues and PR
// rails. The author list is the repo's members (∪ any authors already loaded); `selected` is mutated in place
// as the user ticks authors, and `onChange` fires after each toggle so the caller re-renders its list. The
// popup stays open while you tick multiple authors and closes on an outside click; clicking the same icon
// again toggles it shut.

import { esc } from './dom';

let closeCurrent: (() => void) | null = null;

export function openAuthorFilter(anchor: HTMLElement, authors: string[], selected: Set<string>, onChange: () => void, menuId: string): void {
  const reopeningSame = !!document.getElementById(menuId);
  if (closeCurrent) closeCurrent();     // close whatever's open (this menu, or another rail's)
  if (reopeningSame) return;            // clicking the same icon again → just close

  const menu = document.createElement('div'); menu.className = 'iss-menu author-menu'; menu.id = menuId;
  const onDoc = (e: MouseEvent) => { const t = e.target as Node; if (menu.contains(t) || anchor.contains(t)) return; close(); };
  const close = (): void => { menu.remove(); document.removeEventListener('click', onDoc, true); if (closeCurrent === close) closeCurrent = null; };
  closeCurrent = close;

  const draw = (): void => {
    const allRow = `<button class="iss-mi ${selected.size === 0 ? 'on' : ''}" data-all="1"><span class="d">✍</span> All authors</button>`;
    const list = authors.length
      ? `<div class="iss-menu-list">${authors.map((a) => `<label class="authchk"><input type="checkbox" data-author="${esc(a)}"${selected.has(a) ? ' checked' : ''}><span>${esc(a)}</span></label>`).join('')}</div>`
      : '<div class="auth-empty">No members found — pull the list, or check repo access.</div>';
    menu.innerHTML = allRow + list;
    (menu.querySelector('[data-all]') as HTMLElement).onclick = (e) => { e.stopPropagation(); selected.clear(); onChange(); draw(); };
    menu.querySelectorAll<HTMLInputElement>('input[data-author]').forEach((cb) => {
      cb.onchange = () => {
        const a = cb.dataset.author!; if (cb.checked) selected.add(a); else selected.delete(a);
        menu.querySelector('[data-all]')?.classList.toggle('on', selected.size === 0);
        onChange();   // re-render the rail's list (the popup stays open for more toggles)
      };
    });
  };
  draw();
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))) + 'px';
  menu.style.top = Math.round(r.bottom + 4) + 'px';
  setTimeout(() => document.addEventListener('click', onDoc, true), 0);
}
