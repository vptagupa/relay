// Repository-dependency templates — a per-MAIN-repo default set of dependency repos, defined once in Settings
// and auto-selected in the issue Assign / task Validate deps picker. E.g. map "teacher" -> ["course-service",
// "online-quiz-service"], and any issue/task in "teacher" pre-selects those two under .deps/ (until the user
// customizes that specific issue/task). Keyed by the qualified repo id ("provider:owner/name"), stored in
// Settings.repoDepsByRepo (global — a repo's dependencies are the same wherever it's assigned).

import { state } from './state';
import { $, esc } from './dom';
import { toast } from './ui';

const relay = (window as any).relay;

function parseRepoId(id: string): { provider: string; repo: string } {
  const m = /^(github|gitlab|bitbucket):(.+)$/.exec(id || '');
  return m ? { provider: m[1], repo: m[2] } : { provider: 'github', repo: id };
}
const shortName = (id: string): string => { const { repo } = parseRepoId(id); return repo.split('/').pop() || repo; };

const templates = (): Record<string, string[]> => state.settings.repoDepsByRepo || {};
/** The configured default dependency repo ids for a main repo (empty if none). Used by the deps pickers. */
export function repoDepsFor(repoId: string): string[] { return templates()[repoId] || []; }

// Every tracked repo id across ALL workspaces — the pool for building a template.
function allRepos(): string[] {
  const s = new Set<string>();
  for (const list of Object.values(state.settings.issueReposByWs || {})) for (const id of (list || [])) s.add(id);
  return [...s].sort();
}

let selectedMain = '';

async function saveTemplates(map: Record<string, string[]>): Promise<void> {
  state.settings.repoDepsByRepo = map;                    // optimistic so the list re-renders immediately
  try { state.settings = await relay.patchSettings({ repoDepsByRepo: map }); } catch { /* keep the in-memory map */ }
  renderList();
}

// The dependency checklist for the currently-picked main repo (its saved deps pre-checked). A persistent
// #rdSearch input (wired once in initRepoDeps) filters this list; shown only when the list is long.
function renderDepsChecklist(): void {
  const box = $('#rdDeps'); if (!box) return;
  const search = $('#rdSearch') as HTMLInputElement | null;
  const hideSearch = () => { if (search) { search.style.display = 'none'; search.value = ''; } };
  if (!selectedMain) { box.innerHTML = '<div class="rd-hint">Pick a main repository to choose its dependencies.</div>'; hideSearch(); return; }
  const candidates = allRepos().filter((id) => id !== selectedMain);
  if (!candidates.length) { box.innerHTML = '<div class="rd-hint">No other tracked repos to depend on — track more in the Issues rail → Sources.</div>'; hideSearch(); return; }
  const current = new Set(repoDepsFor(selectedMain));
  box.innerHTML = candidates.map((id) => `<label class="iss-dep"><input type="checkbox" value="${esc(id)}"${current.has(id) ? ' checked' : ''}><b>${esc(shortName(id))}</b><span class="mut">${esc(id)}</span></label>`).join('');
  if (search) { search.value = ''; search.style.display = candidates.length > 6 ? '' : 'none'; } // reset the filter for the new repo's list
}
// Filter the dependency checklist by the search box (reads its live children each time).
function filterDeps(q: string): void {
  const query = q.trim().toLowerCase();
  document.querySelectorAll<HTMLElement>('#rdDeps .iss-dep').forEach((it) => { it.style.display = !query || (it.textContent || '').toLowerCase().includes(query) ? '' : 'none'; });
}

// The saved templates, most useful for a quick "main → deps" overview + delete.
function renderList(): void {
  const el = $('#rdList'); if (!el) return;
  const t = templates(); const keys = Object.keys(t).filter((k) => (t[k] || []).length);
  if (!keys.length) { el.innerHTML = '<div class="rd-hint">No dependency templates yet.</div>'; return; }
  el.innerHTML = keys.sort().map((k) => `<div class="rd-row"><div class="rd-main"><b>${esc(shortName(k))}</b> <span class="mut">→ ${t[k].map((d) => esc(shortName(d))).join(', ')}</span></div><button class="rd-del" data-del="${esc(k)}" title="Remove template">×</button></div>`).join('');
  el.querySelectorAll<HTMLElement>('[data-del]').forEach((b) => { b.onclick = async () => { const map = { ...templates() }; delete map[b.dataset.del!]; await saveTemplates(map); toast('Template removed'); }; });
}

// (Re)populate the main-repo dropdown + refresh the panel — called on init and whenever the Agents tab opens
// (tracked repos may have changed since boot).
export function refreshRepoDeps(): void {
  const mainSel = $('#rdMain') as HTMLSelectElement | null;
  if (mainSel) {
    const repos = allRepos();
    const keep = mainSel.value;
    mainSel.innerHTML = `<option value="">— pick a repo —</option>` + repos.map((id) => `<option value="${esc(id)}">${esc(shortName(id))} · ${esc(parseRepoId(id).provider)}</option>`).join('');
    if (keep && repos.includes(keep)) mainSel.value = keep; else selectedMain = '';
  }
  renderDepsChecklist(); renderList();
}

export function initRepoDeps(): void {
  const mainSel = $('#rdMain') as HTMLSelectElement | null;
  if (mainSel) mainSel.onchange = () => { selectedMain = mainSel.value; renderDepsChecklist(); };
  const search = $('#rdSearch') as HTMLInputElement | null;
  if (search) search.oninput = () => filterDeps(search.value);
  const save = $('#rdSave'); if (save) save.onclick = async () => {
    if (!selectedMain) { toast('Pick a main repository first'); return; }
    const deps = Array.from(document.querySelectorAll<HTMLInputElement>('#rdDeps input:checked')).map((cb) => cb.value);
    const map = { ...templates() };
    if (deps.length) map[selectedMain] = deps; else delete map[selectedMain];   // no deps → clear the template
    await saveTemplates(map);
    toast(deps.length ? `Saved: ${shortName(selectedMain)} → ${deps.length} dep${deps.length === 1 ? '' : 's'}` : 'Template cleared', true);
  };
  refreshRepoDeps();
}
