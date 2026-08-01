// Single source of truth for Relay's themes.
//
// TO ADD A THEME: append one Theme object below. Its CSS variables, xterm terminal palette,
// the Settings swatch, and any structural traits all derive from this object — no edits to
// styles.css, renderer.ts, or any component are needed. The renderer applies `vars` to
// document.documentElement, sets `data-theme`, and toggles a `.t-<trait>` class per trait.
//
// `vars` keys are CSS custom-property names WITHOUT the leading `--`. Values may reference other
// vars (e.g. 'var(--surface)') or use color-mix — they're written verbatim into the property.

const ANSI_DARK = {
  black: '#3b3f4a', red: '#ff7b72', green: '#7ee787', yellow: '#f0c674', blue: '#6cb6ff',
  magenta: '#d2a8ff', cyan: '#56d4dd', white: '#d8dee7', brightBlack: '#66717f',
  brightRed: '#ffa198', brightGreen: '#a2f2b0', brightYellow: '#f7d774', brightBlue: '#89bdff',
  brightMagenta: '#e0bbff', brightCyan: '#7ee0e8', brightWhite: '#ffffff',
};
const ANSI_LIGHT = {
  black: '#161b22', red: '#c0341d', green: '#15803d', yellow: '#9a6700', blue: '#1d4ed8',
  magenta: '#9333ea', cyan: '#0e7490', white: '#55606e', brightBlack: '#8a94a3',
  brightRed: '#dc2626', brightGreen: '#16a34a', brightYellow: '#b45309', brightBlue: '#2563eb',
  brightMagenta: '#a855f7', brightCyan: '#0891b2', brightWhite: '#161b22',
};

/** Structural add-ons a theme can opt into; each maps to a `.t-<trait>` class on <html>. */
export type ThemeTrait = 'glass' | 'neon' | 'light-tabs';

export interface Theme {
  id: string;
  name: string;
  swatch: [string, string];        // two colors for the Settings picker preview
  traits: ThemeTrait[];            // structural treatments (see styles.css → "theme traits")
  vars: Record<string, string>;    // CSS custom properties (keys WITHOUT the leading --)
  xterm: Record<string, string>;   // xterm.js theme palette
}

export const THEMES: Theme[] = [
  {
    id: 'graphite', name: 'Graphite', swatch: ['#0b0c0e', '#6e7bff'], traits: [],
    vars: {
      bg: '#0b0c0e', surface: '#121317', 'surface-2': '#171920', 'surface-3': '#1c1e24', canvas: '#0e0f12',
      border: '#26282f', 'border-strong': '#343742', text: '#e8eaee', 'text-dim': '#a2a8b2', muted: '#6b7280',
      accent: '#6e7bff', 'accent-2': '#8fd0ff', 'accent-ghost': 'rgba(110,123,255,.14)', 'accent-line': 'rgba(110,123,255,.5)',
      ok: '#4ec46a', err: '#f0616a', sel: 'rgba(110,123,255,.24)', 'on-accent': '#0b0c0e',
      shadow: '0 22px 60px -20px rgba(0,0,0,.62)',
      r: '6px', 'r-sm': '4px', 'r-lg': '10px', gap: '11px', pad: '9px',
    },
    xterm: { background: '#0e0f12', foreground: '#e8eaee', cursor: '#6e7bff', cursorAccent: '#0e0f12', selectionBackground: 'rgba(110,123,255,.28)', ...ANSI_DARK },
  },
  {
    id: 'ember', name: 'Ember', swatch: ['#15110d', '#f2a93b'], traits: [],
    vars: {
      bg: '#15110d', surface: '#1d1712', 'surface-2': '#241c15', 'surface-3': '#2c2118', canvas: '#181310',
      border: '#3a2c20', 'border-strong': '#493829', text: '#f4ebe0', 'text-dim': '#c7b6a2', muted: '#8a7461',
      accent: '#f2a93b', 'accent-2': '#ffcf85', 'accent-ghost': 'rgba(242,169,59,.14)', 'accent-line': 'rgba(242,169,59,.55)',
      ok: '#8bbf5f', err: '#e5644e', sel: 'rgba(242,169,59,.24)', 'on-accent': '#231604',
      shadow: '0 22px 60px -20px rgba(0,0,0,.6)',
      r: '9px', 'r-sm': '6px', 'r-lg': '13px', gap: '14px', pad: '12px',
    },
    xterm: { background: '#181310', foreground: '#f4ebe0', cursor: '#f2a93b', cursorAccent: '#181310', selectionBackground: 'rgba(242,169,59,.26)', ...ANSI_DARK },
  },
  {
    id: 'voltage', name: 'Voltage', swatch: ['#0a0713', '#ff2e97'], traits: ['neon'],
    vars: {
      bg: '#0a0713', surface: '#120c22', 'surface-2': '#170f2b', 'surface-3': '#1e1440', canvas: '#0c0819',
      border: '#33215c', 'border-strong': '#402c66', text: '#ece6ff', 'text-dim': '#ab9de0', muted: '#6c5da8',
      accent: '#ff2e97', 'accent-2': '#22d3ee', 'accent-ghost': 'rgba(255,46,151,.16)', 'accent-line': 'rgba(255,46,151,.55)',
      ok: '#2bd9a6', err: '#ff4d6d', sel: 'rgba(255,46,151,.26)', 'on-accent': '#0a0713',
      shadow: '0 22px 60px -20px rgba(0,0,0,.72),0 0 50px -24px rgba(34,211,238,.5)',
      r: '4px', 'r-sm': '3px', 'r-lg': '6px', gap: '10px', pad: '8px',
    },
    xterm: { background: '#0c0819', foreground: '#ece6ff', cursor: '#ff2e97', cursorAccent: '#0c0819', selectionBackground: 'rgba(255,46,151,.28)', ...ANSI_DARK, magenta: '#ff6ac1', cyan: '#22d3ee', brightMagenta: '#ff8fd0', brightCyan: '#67e8f9' },
  },
  {
    id: 'aurora', name: 'Aurora', swatch: ['#0b1120', '#a78bfa'], traits: ['glass'],
    vars: {
      bg: '#0b1120', surface: '#151d31', 'surface-2': '#1b2438', 'surface-3': '#232e48', canvas: '#0d1426',
      border: '#263149', 'border-strong': '#384662', text: '#eaf1ff', 'text-dim': '#aebbd6', muted: '#7683a0',
      accent: '#a78bfa', 'accent-2': '#5eead4', 'accent-ghost': 'rgba(167,139,250,.16)', 'accent-line': 'rgba(167,139,250,.5)',
      ok: '#34d399', err: '#fb7185', sel: 'rgba(167,139,250,.26)', 'on-accent': '#0b1120',
      shadow: '0 24px 64px -22px rgba(3,7,25,.75)',
      r: '11px', 'r-sm': '8px', 'r-lg': '16px', gap: '16px', pad: '13px',
      path: '#7cc6ff', // glass-trait prompt path color (falls back to --accent-2 for other glass themes)
    },
    xterm: { background: '#0d1426', foreground: '#eaf1ff', cursor: '#a78bfa', cursorAccent: '#0d1426', selectionBackground: 'rgba(167,139,250,.28)', ...ANSI_DARK },
  },
  {
    id: 'daylight', name: 'Daylight', swatch: ['#f5f6f8', '#0e7c66'], traits: ['light-tabs'],
    vars: {
      bg: '#f5f6f8', surface: '#ffffff', 'surface-2': '#f2f4f7', 'surface-3': '#eef7f4', canvas: '#fbfcfd',
      border: '#e4e7ec', 'border-strong': '#ccd3dd', text: '#161b22', 'text-dim': '#55606e', muted: '#8a94a3',
      accent: '#0e7c66', 'accent-2': '#2563eb', 'accent-ghost': 'rgba(14,124,102,.1)', 'accent-line': 'rgba(14,124,102,.34)',
      ok: '#15803d', err: '#dc2626', sel: 'rgba(14,124,102,.16)', 'on-accent': '#ffffff',
      shadow: '0 24px 60px -26px rgba(20,40,60,.24)',
      r: '8px', 'r-sm': '5px', 'r-lg': '12px', gap: '13px', pad: '11px',
    },
    xterm: { background: '#fbfcfd', foreground: '#161b22', cursor: '#0e7c66', cursorAccent: '#fbfcfd', selectionBackground: 'rgba(14,124,102,.2)', ...ANSI_LIGHT },
  },
];

export const DEFAULT_THEME = 'graphite';
export const themeById = (id: string | undefined): Theme => THEMES.find((t) => t.id === id) || THEMES[0];
