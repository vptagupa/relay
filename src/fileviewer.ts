// In-app code file viewer/editor — the content of a `kind:'file'` tab. Self-contained behind a DI seam (like
// blueprints.ts / workspaces.ts): the renderer injects fs read/write, the highlight-enabled check, a dirty→tab
// notifier, and toast, so this module never reaches into renderer.ts or the global state.
//
// Read-only by default with a syntax-highlighted view + line-number gutter; an ✎ Edit toggle swaps in a plain
// editable textarea, and Save (or Ctrl/Cmd-S) writes it back. Highlighting is highlight.js core with only the
// registered languages bundled — adding a language is one entry in shared/languages.ts + one import + map entry
// below (the scalable seam).

import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import php from 'highlight.js/lib/languages/php';
import java from 'highlight.js/lib/languages/java';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import c from 'highlight.js/lib/languages/c';
import csharp from 'highlight.js/lib/languages/csharp';
import ruby from 'highlight.js/lib/languages/ruby';
import { esc } from './dom';
import { LANGUAGES, langForPath, type LangDef } from './shared/languages';

// id (matching shared/languages.ts) → highlight.js module. Register each once.
const MODULES: Record<string, unknown> = { javascript, typescript, python, php, java, xml, css, json, bash, markdown, go, rust, sql, yaml, c, csharp, ruby };
for (const l of LANGUAGES) { const m = MODULES[l.id]; if (m) { try { hljs.registerLanguage(l.id, m as never); } catch { /* dup */ } } }

export interface FileViewerDeps {
  fsRead: (p: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  fsWrite: (p: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  highlightOn: (langId: string) => boolean;          // is this language's highlighting enabled in Settings
  onDirty: (id: string, dirty: boolean) => void;      // notify the tab so its title can show an unsaved dot
  toast: (msg: string, ok?: boolean) => void;
}

interface FV { el: HTMLElement; path: string; lang?: LangDef; text: string; editing: boolean; dirty: boolean; loaded: boolean }
const views = new Map<string, FV>();
let deps: FileViewerDeps;

export function initFileViewer(d: FileViewerDeps): void { deps = d; }

// Create a viewer inside `el` (the file tab's host element) for the file at `path`. Async-loads the content.
export function mountFileViewer(id: string, el: HTMLElement, path: string): void {
  const fv: FV = { el, path, lang: langForPath(path), text: '', editing: false, dirty: false, loaded: false };
  views.set(id, fv);
  el.innerHTML = `<div class="fv-msg">Loading ${esc(path.split(/[\\/]/).pop() || '')}…</div>`;
  void load(id);
}
async function load(id: string): Promise<void> {
  const fv = views.get(id); if (!fv) return;
  const r = await deps.fsRead(fv.path).catch((): { ok: boolean; text?: string; error?: string } => ({ ok: false, error: 'read failed' }));
  if (views.get(id) !== fv) return;                     // tab closed / reused while reading
  if (!r.ok) { fv.el.innerHTML = `<div class="fv-msg err">${esc(r.error || 'Could not open this file')}</div>`; return; }
  fv.text = r.text || ''; fv.loaded = true;
  render(id);
}

export function disposeFileViewer(id: string): void { views.delete(id); }
export const isFileDirty = (id: string): boolean => !!views.get(id)?.dirty;
export function focusFileViewer(id: string): void {
  const fv = views.get(id); if (!fv) return;
  (fv.el.querySelector('.fv-edit') as HTMLElement | null)?.focus() ?? (fv.el.querySelector('.fv-scroll') as HTMLElement | null)?.focus();
}

function render(id: string): void {
  const fv = views.get(id); if (!fv || !fv.loaded) return;
  const name = fv.path.split(/[\\/]/).pop() || fv.path;
  const langLabel = fv.lang ? fv.lang.label : 'Plain text';
  fv.el.innerHTML = `
    <div class="fv-bar">
      <span class="fv-name" title="${esc(fv.path)}">${esc(name)}${fv.dirty ? ' •' : ''}</span>
      <span class="fv-lang">${esc(langLabel)}</span>
      <span class="fv-ro">${fv.editing ? 'editing' : 'read-only'}</span>
      <span class="fv-spacer"></span>
      ${fv.editing
        ? `<button class="fv-btn pri" data-fv="save">Save</button><button class="fv-btn" data-fv="cancel">Cancel</button>`
        : `<button class="fv-btn" data-fv="edit" title="Edit this file">✎ Edit</button>`}
    </div>
    <div class="fv-body">${fv.editing ? editorHtml(fv) : readonlyHtml(fv)}</div>`;
  wire(id);
  if (fv.editing) (fv.el.querySelector('.fv-edit') as HTMLElement | null)?.focus();
}

// Read-only render: line-number gutter + the highlighted code. The gutter is a separate <pre> of 1..N (N from the
// RAW line count, so multi-line highlight spans can't desync it); vertical scroll moves both, horizontal scroll
// only the code.
const HL_CAP = 500_000; // above this, skip highlighting (hljs per-keystroke on a huge file would jank the UI) — plain text
// Highlight a string to HTML (or escape it if highlighting is off/unavailable/too large). Shared by the read-only
// view AND the live editor overlay, so both render identically.
function hlString(fv: FV, str: string): string {
  const useHl = !!fv.lang && deps.highlightOn(fv.lang.id) && str.length <= HL_CAP;
  try { return useHl ? hljs.highlight(str, { language: fv.lang!.id, ignoreIllegals: true }).value : esc(str); }
  catch { return esc(str); }
}
const gutterFor = (n: number): string => Array.from({ length: Math.max(1, n) }, (_, i) => String(i + 1)).join('\n');

function readonlyHtml(fv: FV): string {
  const code = hlString(fv, fv.text);
  return `<div class="fv-scroll" tabindex="0"><pre class="fv-gutter" aria-hidden="true">${gutterFor(fv.text.split('\n').length)}</pre><pre class="fv-codepre"><code class="hljs">${code || '&nbsp;'}</code></pre></div>`;
}
// Edit mode keeps highlighting LIVE: a transparent textarea (visible caret) sits over a highlighted <pre> that
// mirrors its text; on input we re-highlight the layer and on scroll we mirror scrollTop/Left + the gutter, so the
// colored text stays perfectly under the caret while you type. The layers share identical font/padding/line metrics.
function editorHtml(fv: FV): string {
  const n = fv.text.split('\n').length;
  return `<div class="fv-editscroll">
      <div class="fv-egutwrap"><pre class="fv-egutter" aria-hidden="true">${gutterFor(n)}</pre></div>
      <div class="fv-editarea">
        <pre class="fv-hl" aria-hidden="true"><code class="hljs">${hlString(fv, fv.text) || '&nbsp;'}</code></pre>
        <textarea class="fv-edit" spellcheck="false" wrap="off">${esc(fv.text)}</textarea>
      </div>
    </div>`;
}

function wire(id: string): void {
  const fv = views.get(id); if (!fv) return;
  fv.el.querySelectorAll<HTMLElement>('[data-fv]').forEach((b) => (b.onclick = () => void action(id, b.dataset.fv!)));
  const ta = fv.el.querySelector('.fv-edit') as HTMLTextAreaElement | null;
  if (ta) {
    const hlCode = fv.el.querySelector('.fv-hl code') as HTMLElement | null;
    const hlPre = fv.el.querySelector('.fv-hl') as HTMLElement | null;
    const egut = fv.el.querySelector('.fv-egutter') as HTMLElement | null;
    // Keep the highlight layer + gutter aligned with the textarea's scroll position.
    const syncScroll = () => { if (hlPre) { hlPre.scrollTop = ta.scrollTop; hlPre.scrollLeft = ta.scrollLeft; } if (egut) egut.style.transform = `translateY(${-ta.scrollTop}px)`; };
    ta.addEventListener('scroll', syncScroll);
    ta.oninput = () => {
      const cur = views.get(id); if (!cur) return;
      const d = ta.value !== cur.text;
      if (d !== cur.dirty) { cur.dirty = d; deps.onDirty(id, d); const nm = fv.el.querySelector('.fv-name'); if (nm) nm.textContent = `${(cur.path.split(/[\\/]/).pop() || cur.path)}${d ? ' •' : ''}`; }
      if (hlCode) hlCode.innerHTML = hlString(cur, ta.value) || '&nbsp;';   // re-highlight the layer LIVE
      if (egut) { const lines = ta.value.split('\n').length; if ((egut.textContent || '').split('\n').length !== lines) egut.textContent = gutterFor(lines); }
      syncScroll();
    };
    ta.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void action(id, 'save'); }
      else if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart, en = ta.selectionEnd; ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en); ta.selectionStart = ta.selectionEnd = s + 2; ta.dispatchEvent(new Event('input')); } // 2-space soft tab
    };
  }
}

async function action(id: string, what: string): Promise<void> {
  const fv = views.get(id); if (!fv) return;
  if (what === 'edit') { fv.editing = true; render(id); return; }
  if (what === 'cancel') { fv.editing = false; if (fv.dirty) { fv.dirty = false; deps.onDirty(id, false); } render(id); return; }
  if (what === 'save') {
    const ta = fv.el.querySelector('.fv-edit') as HTMLTextAreaElement | null; if (!ta) return;
    const content = ta.value;
    const r = await deps.fsWrite(fv.path, content).catch(() => ({ ok: false, error: 'save failed' }));
    if (!r.ok) { deps.toast(r.error || 'Could not save', false); return; }
    fv.text = content; fv.dirty = false; fv.editing = false; deps.onDirty(id, false);
    render(id);
    deps.toast(`Saved ${fv.path.split(/[\\/]/).pop()}`, true);
  }
}
