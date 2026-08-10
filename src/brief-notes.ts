// Brief notes — reusable prompt snippets the user configures once (Settings → Agents) and toggles per run in
// the issue Assign / task Validate dialogs. Checked notes are appended to the agent's brief under an
// "Additional notes" section. Each note can be flagged `on` (checked by default). E.g. a note like "If the issue
// relates to other repositories or services, file a GitHub issue for each." Stored in Settings.briefNotes.

import { state } from './state';
import { $, esc } from './dom';
import { toast } from './ui';
import type { BriefNote } from './shared/types';

const relay = (window as any).relay;

const notes = (): BriefNote[] => state.settings.briefNotes || [];
/** Note ids that are checked by default (their `on` flag) — the initial selection in the dialogs. */
export function defaultNoteIds(): string[] { return notes().filter((n) => n.on && n.text.trim()).map((n) => n.id); }
export const hasNotes = (): boolean => notes().some((n) => n.text.trim());

/** The brief section for the checked notes (by id). Empty if none selected. */
export function notesNote(ids: string[]): string {
  const sel = notes().filter((n) => ids.includes(n.id) && n.text.trim());
  if (!sel.length) return '';
  return `\n\n---\n\n## Additional notes\n${sel.map((n) => `- ${n.text.trim()}`).join('\n')}`;
}

/** Checkbox block for the Assign/Validate dialogs (pre-checked per `selected`). '' when no notes are configured. */
export function noteChecks(selected: Set<string>): string {
  const list = notes().filter((n) => n.text.trim());
  if (!list.length) return '';
  return `<label class="iss-lbl">Notes <span class="mut">— appended to the brief</span></label>
    <div class="bn-checks" id="bnChecks">${list.map((n) => `<label class="bn-check"><input type="checkbox" data-note="${esc(n.id)}"${selected.has(n.id) ? ' checked' : ''}><span>${esc(n.text)}</span></label>`).join('')}</div>`;
}

/* ----------------------------- Settings panel ----------------------------- */
async function save(list: BriefNote[]): Promise<void> {
  state.settings.briefNotes = list;                        // optimistic so the list re-renders immediately
  try { state.settings = await relay.patchSettings({ briefNotes: list }); } catch { /* keep the in-memory list */ }
  renderList();
}
function renderList(): void {
  const el = $('#bnList'); if (!el) return;
  const list = notes();
  if (!list.length) { el.innerHTML = '<div class="rd-hint">No notes yet — add one below.</div>'; return; }
  el.innerHTML = list.map((n) => `<div class="bn-row"><label class="bn-on" title="Checked by default in Assign / Validate"><input type="checkbox" data-on="${esc(n.id)}"${n.on ? ' checked' : ''}> default</label><div class="bn-text">${esc(n.text)}</div><button class="rd-del" data-del="${esc(n.id)}" title="Remove note">×</button></div>`).join('');
  el.querySelectorAll<HTMLInputElement>('[data-on]').forEach((cb) => { cb.onchange = () => void save(notes().map((n) => n.id === cb.dataset.on ? { ...n, on: cb.checked } : n)); });
  el.querySelectorAll<HTMLElement>('[data-del]').forEach((b) => { b.onclick = () => { void save(notes().filter((n) => n.id !== b.dataset.del)); toast('Note removed'); }; });
}

export function initBriefNotes(): void {
  const inp = $('#bnInput') as HTMLTextAreaElement | null;
  const add = $('#bnAdd');
  if (add && inp) add.onclick = () => {
    const t = inp.value.trim(); if (!t) { toast('Enter a note first'); return; }
    const id = `bn${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    void save([...notes(), { id, text: t, on: false }]);
    inp.value = ''; toast('Note added', true);
  };
  renderList();
}
export function refreshBriefNotes(): void { renderList(); }
