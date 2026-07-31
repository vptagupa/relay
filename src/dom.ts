// Shared renderer DOM/render primitives. Runs in the renderer (browser) context, so it uses the
// DOM globals directly; it holds no app state and imports nothing. Every UI module imports these
// rather than redefining them, so there's one $, one E(), one esc, one svgIcon across the app.

/** querySelector with a caller-chosen element type (defaults to HTMLElement). */
export const $ = <T extends HTMLElement = HTMLElement>(s: string): T => document.querySelector(s) as T;

/** A fresh unique id (UUID) for tabs, blocks, etc. */
export const uid = (): string => (crypto as { randomUUID(): string }).randomUUID();

/** Escape a string for safe interpolation into an HTML template. */
export const esc = (s: string): string => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Inline SVG icon referencing a <symbol> from the sprite injected into the page (artifact line-icon set). */
export const svgIcon = (id: string, sz = 16): string => `<svg width="${sz}" height="${sz}" aria-hidden="true"><use href="#${id}"/></svg>`;

// Persistent per-pane elements are reused as split leaves. Once a pane is removed from the grid
// (during a layout rebuild) it's detached from the document, so querySelector can no longer find
// it. Resolve each ONCE while still attached and cache the live reference.
const _elCache: Record<string, HTMLElement> = {};
export const E = (sel: string): HTMLElement => (_elCache[sel] ??= document.querySelector(sel) as HTMLElement);
