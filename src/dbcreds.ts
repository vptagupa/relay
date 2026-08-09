// Database credential TEMPLATES — a small renderer-side helper over the encrypted main-process store (keys.ts).
// The user saves reusable DB connection templates in Settings; when a pipeline is assigned (issue / PR / task)
// they pick one, and the main process injects it into that run's shell environment (DB_*, DATABASE_URL, engine
// aliases, extras) so the agent can connect WITHOUT asking for — or hardcoding — credentials.
//
// SECURITY: this module never holds a stored password or extra-var value. It only ever sees the sanitized
// DbCredMeta (connection metadata + the NAMES of the env vars a template injects). Secrets are entered once in
// the form (write-only), sent straight to main, encrypted at rest, and resolved to env vars only in main.
// This is a shared helper (like pipelines.ts), consumed by the feature modules — it owns only its Settings panel.

import { $, esc } from './dom';
import { toast } from './ui';
import type { DbCredMeta } from './shared/types';

const relay = (window as any).relay;

// Engine choices (value = normalized key main understands; label = friendly). "other" → discrete DB_* only.
const ENGINES: { id: string; label: string }[] = [
  { id: '', label: '— pick —' },
  { id: 'postgres', label: 'PostgreSQL' },
  { id: 'mysql', label: 'MySQL / MariaDB' },
  { id: 'mongodb', label: 'MongoDB' },
  { id: 'mssql', label: 'SQL Server' },
  { id: 'redis', label: 'Redis' },
  { id: 'sqlite', label: 'SQLite' },
  { id: 'other', label: 'Other' },
];

/* ----------------------------- cache (refreshed from main) ----------------------------- */
let metas: DbCredMeta[] = [];
export function dbCredMetas(): DbCredMeta[] { return metas; }
export function dbCredById(id?: string): DbCredMeta | undefined { return id ? metas.find((m) => m.id === id) : undefined; }
export async function loadDbCreds(): Promise<void> { metas = await relay.dbCredsList().catch(() => [] as DbCredMeta[]); }

/* ----------------------------- consumed by the assign dialogs ----------------------------- */
// <option> list for a dialog's Database <select> — a "(none)" first entry, then each template by label.
export function dbCredOptions(selectedId?: string): string {
  return `<option value="">— none —</option>` + metas.map((m) =>
    `<option value="${esc(m.id)}"${m.id === selectedId ? ' selected' : ''}>${esc(m.label)}${m.engine ? ` · ${esc(m.engine)}` : ''}</option>`).join('');
}
// The brief note naming the env vars a selected template injects (NO secret values — names only, straight from
// main's computed envVars so it can't drift from what's actually set). Empty string if no/unknown template.
export function dbCredNote(id?: string): string {
  const m = dbCredById(id); if (!m) return '';
  const vars = (m.envVars || []).map((v) => `- \`${v}\``).join('\n');
  return `\n\n---\n\n## Database credentials\nCredentials for **${m.label}**${m.engine ? ` (${m.engine})` : ''} are provided in this run's ENVIRONMENT.`
    + ` Do NOT ask for them, print them, hardcode them, or commit them. Available environment variables:\n${vars}\n`
    + `Read them from the environment to connect (e.g. the DATABASE_URL / DB_* variables — use your shell's env syntax). Treat every value as a secret.`;
}

/* ----------------------------- Settings panel ----------------------------- */
function modal(html: string): { root: HTMLElement; close: () => void } {
  const root = document.createElement('div'); root.className = 'tpl-modal';
  root.innerHTML = `<div class="tpl-sc"></div>${html}`;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
  document.body.appendChild(root); document.addEventListener('keydown', onKey);
  root.querySelector('.tpl-sc')?.addEventListener('click', close);
  return { root, close };
}

export function renderDbCredList(): void {
  const el = $('#dbCredList'); if (!el) return;
  if (!metas.length) { el.innerHTML = `<div class="db-empty">No database credentials yet.</div>`; return; }
  el.innerHTML = metas.map((m) => {
    const conn = [m.user, m.host && `${m.host}${m.port ? ':' + m.port : ''}`].filter(Boolean).join('@');
    const sub = [m.engine || 'db', conn, m.database].filter(Boolean).join(' · ');
    return `<button class="db-row" type="button" data-id="${esc(m.id)}"><span class="db-label">${esc(m.label)}</span><span class="db-sub">${esc(sub)}</span></button>`;
  }).join('');
  el.querySelectorAll<HTMLElement>('.db-row').forEach((row) => {
    const m = metas.find((x) => x.id === row.dataset.id);
    if (m) row.onclick = () => openDbCredForm(m);
  });
}

// Create (existing omitted) or edit a template. On edit, the password + extra VALUES are unknown here, so the
// password field is left blank ("unchanged") and extras show KEYS only — blank values mean "keep the stored one".
function openDbCredForm(existing?: DbCredMeta): void {
  const engOpts = ENGINES.map((e) => `<option value="${e.id}"${e.id === (existing?.engine || '') ? ' selected' : ''}>${esc(e.label)}</option>`).join('');
  const extrasText = (existing?.extraKeys || []).map((k) => `${k}=`).join('\n');
  const { root, close } = modal(`<div class="tpl-card iss-card">
      <div class="hd"><span class="dot" style="background:var(--accent)"></span><span class="t">${existing ? 'Edit database credential' : 'New database credential'}</span></div>
      <div class="bd">
        <label class="iss-lbl">Label</label>
        <input class="tk-input" id="dbLabel" placeholder="e.g. PRIISMS prod DB" spellcheck="false">
        <div class="db-grid">
          <div><label class="iss-lbl">Engine</label><select class="iss-agentsel" id="dbEngine">${engOpts}</select></div>
          <div><label class="iss-lbl">Database</label><input class="tk-input" id="dbName" spellcheck="false"></div>
          <div><label class="iss-lbl">Host</label><input class="tk-input" id="dbHost" placeholder="localhost" spellcheck="false"></div>
          <div><label class="iss-lbl">Port</label><input class="tk-input" id="dbPort" placeholder="5432" spellcheck="false"></div>
          <div><label class="iss-lbl">User</label><input class="tk-input" id="dbUser" spellcheck="false"></div>
          <div><label class="iss-lbl">Password</label><input class="tk-input" id="dbPass" type="password" placeholder="${existing ? '•••••••• (unchanged)' : ''}" autocomplete="off"></div>
        </div>
        <label class="iss-lbl">Extra variables <span class="mut">— one <code>KEY=VALUE</code> per line (e.g. <code>PGSSLMODE=require</code>)</span></label>
        <textarea class="iss-brief db-extras" spellcheck="false" rows="3" id="dbExtras" placeholder="KEY=VALUE"></textarea>
        <div class="iss-wt">Stored <b>encrypted</b> in your OS keychain — the password never leaves the app's main process or reaches this window. When referenced by a pipeline, it's injected into that run's environment (DB_HOST, DB_USER, DB_PASSWORD, DATABASE_URL, …); it's never written to a file or the brief.${existing ? ' Leave a value blank to keep it unchanged.' : ''}</div>
      </div>
      <div class="ft"><span class="hint"></span><span class="r">${existing ? '<button class="tpl-btn ghost" data-del>Delete</button>' : ''}<button class="tpl-btn ghost" data-x>Cancel</button><button class="tpl-btn pri" data-ok>${existing ? 'Save' : 'Add'}</button></span></div>
    </div>`);
  const val = (sel: string) => (root.querySelector(sel) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  // Prefill non-secret fields via JS (no attribute-escaping pitfalls); password stays blank on edit.
  if (existing) {
    (root.querySelector('#dbLabel') as HTMLInputElement).value = existing.label || '';
    (root.querySelector('#dbName') as HTMLInputElement).value = existing.database || '';
    (root.querySelector('#dbHost') as HTMLInputElement).value = existing.host || '';
    (root.querySelector('#dbPort') as HTMLInputElement).value = existing.port || '';
    (root.querySelector('#dbUser') as HTMLInputElement).value = existing.user || '';
    (root.querySelector('#dbExtras') as HTMLTextAreaElement).value = extrasText;
  }
  root.querySelector('[data-x]')?.addEventListener('click', close);
  root.querySelector('[data-del]')?.addEventListener('click', async () => {
    close();
    metas = await relay.dbCredDelete(existing!.id).catch(() => metas);
    renderDbCredList(); toast('Credential deleted');
  });
  setTimeout(() => (root.querySelector('#dbLabel') as HTMLInputElement).focus(), 30);
  root.querySelector('[data-ok]')?.addEventListener('click', async () => {
    const label = val('#dbLabel').trim();
    if (!label) { toast('A label is required'); return; }
    // Parse extras: "KEY=VALUE" per line (split on the FIRST '='). Blank value → keep stored (edit) / skip (new).
    const extras: Record<string, string> = {};
    for (const line of val('#dbExtras').split('\n')) {
      const t = line.trim(); if (!t) continue;
      const i = t.indexOf('='); if (i <= 0) continue;
      extras[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    const pass = val('#dbPass');
    const input = {
      id: existing?.id,
      label, engine: val('#dbEngine') || undefined,
      host: val('#dbHost').trim() || undefined, port: val('#dbPort').trim() || undefined,
      database: val('#dbName').trim() || undefined, user: val('#dbUser').trim() || undefined,
      password: pass ? pass : undefined,   // blank → main keeps the stored password on edit
      extras,
    };
    metas = await relay.dbCredSave(input).catch(() => metas);
    close(); renderDbCredList(); toast(existing ? 'Credential saved' : 'Credential added', true);
  });
}

/* ----------------------------- wire-up ----------------------------- */
export function initDbCreds(): void {
  const addBtn = $('#dbAddBtn'); if (addBtn) addBtn.onclick = () => openDbCredForm();
  void loadDbCreds().then(renderDbCredList);
}
