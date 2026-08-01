// Theme runtime — applies the registry (src/themes.ts) to the live document: look up the active
// theme from settings, write its CSS vars + trait classes onto <html>, and render the picker grid.
// The registry stays the single source of truth for a theme's values; this is how they reach the DOM.
// (Re-tinting live terminals + persisting the choice stay in the renderer, next to the terminals.)

import { THEMES, themeById, type Theme } from './themes';
import { state } from './state';
import { $ } from './dom';

/** The theme currently selected in settings (falls back to the first theme). */
export const activeTheme = (): Theme => themeById(state.settings.template);
/** The active theme's xterm palette. */
export function activeXterm(): Record<string, string> { return activeTheme().xterm; }
/** The Settings theme-picker list, derived from the registry. */
export const TEMPLATES = THEMES.map((t) => ({ id: t.id, name: t.name, c1: t.swatch[0], c2: t.swatch[1] }));
/** The active theme's id. */
export const curTemplate = (): string => activeTheme().id;

// Write a theme's variables + traits onto <html>. Split out so it can run synchronously at boot
// (before the first paint / any terminals exist) to avoid a flash of the wrong theme.
export function applyThemeVars(t: Theme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', t.id);
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty('--' + k, v);
  for (const c of [...root.classList]) if (c.startsWith('t-')) root.classList.remove(c); // clear old trait classes
  for (const trait of t.traits) root.classList.add('t-' + trait);
}

// Render the Settings theme picker (swatches + names; marks the current theme and the default).
export function renderThemeGrid(): void {
  const cur = curTemplate();
  $('#themeGrid').innerHTML = TEMPLATES.map((t) =>
    `<button class="theme-sw ${t.id === cur ? 'on' : ''}" data-tpl="${t.id}" title="${t.name}"><span class="pv"><i style="background:${t.c1}"></i><i style="background:${t.c2}"></i></span><span class="nm">${t.name}${t.id === 'graphite' ? ' · default' : ''}</span></button>`).join('');
}
