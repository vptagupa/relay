// Command palette (Ctrl+K) — the open/close/filter/render/keyboard machinery. It's generic: it
// renders and runs a list of PalAction the app supplies via initPalette(), so this module stays
// decoupled from the ~30 concrete commands (those live in the renderer, which owns the functions
// each action calls). Selection state (palItems/palSel) is private — callers drive it through the
// exported functions rather than poking at it.

import { $, esc } from './dom';

export interface PalAction { g: string; t: string; run: () => void; }

let palItems: PalAction[] = [];
let palSel = 0;
let getActions: () => PalAction[] = () => [];

/** Supply the command registry (the renderer builds it since each action calls an app function). */
export function initPalette(provider: () => PalAction[]): void { getActions = provider; }

/** Filter the registry by query and render the grouped list (first match preselected). */
export function renderPalette(q: string): void {
  const all = getActions();
  palItems = q ? all.filter((a) => (a.t + ' ' + a.g).toLowerCase().includes(q.toLowerCase())) : all;
  palSel = 0;
  if (!palItems.length) { $('#palList').innerHTML = '<div class="pal-empty">No matches</div>'; return; }
  let html = '', lastG = '';
  palItems.forEach((a, i) => { if (a.g !== lastG) { html += `<div class="pal-group">${esc(a.g)}</div>`; lastG = a.g; } html += `<div class="pal-item ${i === 0 ? 'sel' : ''}" data-i="${i}">${esc(a.t)}</div>`; });
  $('#palList').innerHTML = html;
}

export function openPalette(): void { renderPalette(''); ($('#palInput') as HTMLInputElement).value = ''; $('#palette').classList.add('show'); $('#scrim').classList.add('show'); setTimeout(() => ($('#palInput') as HTMLElement).focus(), 20); }
export function closePalette(): void { $('#palette').classList.remove('show'); if (!$('#settings').classList.contains('show')) $('#scrim').classList.remove('show'); }

/** Move the selection by `d` (wraps) and keep it in view. */
export function palMove(d: number): void { if (!palItems.length) return; palSel = (palSel + d + palItems.length) % palItems.length; [...document.querySelectorAll('#palList .pal-item')].forEach((el, i) => el.classList.toggle('sel', i === palSel)); (document.querySelector('#palList .pal-item.sel') as HTMLElement)?.scrollIntoView({ block: 'nearest' }); }
/** Run the currently selected action (Enter). */
export function palRun(): void { const a = palItems[palSel]; if (a) { closePalette(); a.run(); } }
/** Run the action at index `i` (a list click). */
export function palClick(i: number): void { palSel = i; palRun(); }
