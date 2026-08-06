// Issue Pipeline builder — a visual node editor for authoring pipelines (item #1 + #3).
//
// A self-contained modal: drag stage nodes (and the ⛔ Stop node) around the canvas, drag from a node's
// OUTPUT port onto another node (or Stop) to wire a conditional edge, click a node to edit its name / kind /
// brief / edges, and Save as a custom pipeline. Always editable — saving a built-in FORKS it into a new
// custom pipeline; custom pipelines persist in Settings.pipelines (via relay.patchSettings) + merge into the registry.
//
// Boundary: this module imports only low-level shared modules (state / dom / ui / pipelines) — never
// renderer.ts or issues.ts. issues.ts drives it by calling openPipelineBuilder().

import { state } from './state';
import { esc } from './dom';
import { toast } from './ui';
import { STAGE_KINDS, kindSpec, isGate, STOP, type PipelineDef, type StageDef, type EdgeWhen, type StageKind } from './pipelines';

const relay = (window as any).relay;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
let sidc = 0;
const newStageId = (): string => `s${Date.now().toString(36)}${(++sidc).toString(36)}`;
const newPipeId = (): string => `pipe_${Date.now().toString(36)}`;

// Node geometry — NW/NH must match the fixed .pb-node size in CSS so edge endpoints hit the ports (a node's
// vertical centre = y + NH/2, where its ports sit). Sized so the built-in graph fits the ~630px canvas.
const NW = 150, NH = 42, CANVAS_W = 600, CANVAS_H = 400;
const DEFAULT_STOP = { x: 330, y: 270 };

/** Open the builder for `base`. `onSaved(id?)` fires after a save (id = the saved pipeline) or a delete (undefined). */
export function openPipelineBuilder(base: PipelineDef, onSaved: (savedId?: string) => void): void {
  let def: PipelineDef = clone(base);
  const stopPos = def.stopPos ? { ...def.stopPos } : { ...DEFAULT_STOP }; // the ⛔ Stop node's position (draggable, persisted)
  // Always editable — you can drag/wire freely. Saving a built-in FORKS it into a new custom pipeline
  // (the shipped built-in is never overwritten); saving a custom updates it in place.
  const editable = true;
  let selected: string | null = null;        // selected stage id (its editor panel is shown)
  let connecting: { from: string; x: number; y: number } | null = null; // live drag-to-connect

  const root = document.createElement('div');
  root.className = 'tpl-modal pb-modal';
  root.innerHTML = `<div class="tpl-sc"></div>
    <div class="tpl-card pb-card">
      <div class="pb-head">
        <span class="dot" style="background:var(--accent)"></span>
        <input class="pb-name" id="pbName" spellcheck="false" value="${esc(def.name)}" />
        ${base.builtin ? '<span class="pb-ro">built-in · Save makes a copy</span>' : '<span class="pb-ro">custom</span>'}
        <span class="pb-sp"></span>
        <button class="tpl-btn ghost" id="pbDup">⧉ Duplicate</button>
        ${!base.builtin ? '<button class="tpl-btn ghost pb-del" id="pbDel">Delete</button>' : ''}
        <button class="tpl-btn ghost" id="pbCancel">Close</button>
        <button class="tpl-btn pri" id="pbSave">Save</button>
      </div>
      <div class="pb-body">
        <div class="pb-palette" id="pbPalette"></div>
        <div class="pb-canvas-wrap"><div class="pb-canvas" id="pbCanvas"></div></div>
        <div class="pb-side" id="pbSide"></div>
      </div>
      <div class="pb-foot"><span id="pbHint"></span></div>
    </div>`;
  document.body.appendChild(root);
  const canvas = root.querySelector('#pbCanvas') as HTMLElement;
  const side = root.querySelector('#pbSide') as HTMLElement;
  const hint = root.querySelector('#pbHint') as HTMLElement;

  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
  document.addEventListener('keydown', onKey);
  root.querySelector('.tpl-sc')?.addEventListener('click', close);
  root.querySelector('#pbCancel')?.addEventListener('click', close);

  // ---- palette (add a stage of each kind) ----
  root.querySelector('#pbPalette')!.innerHTML = `<div class="pb-plab">Add stage</div>` + STAGE_KINDS.map((k) =>
    `<button class="pb-pchip k-${k.kind}" data-kind="${k.kind}" ${editable ? '' : 'disabled'}><span class="pb-pdot" style="background:${k.dot}"></span>${esc(k.label)}</button>`).join('');
  root.querySelectorAll<HTMLElement>('.pb-pchip').forEach((b) => b.onclick = () => { if (editable) addStage(b.dataset.kind as StageKind); });

  // ---- model ops ----
  const stageById = (id: string): StageDef | undefined => def.stages.find((s) => s.id === id);
  const dirtyLayout = () => { /* positions live in def already */ };

  function addStage(kind: StageKind): void {
    const spec = kindSpec(kind);
    const n = def.stages.length;
    const s: StageDef = { id: newStageId(), name: spec.label, kind, brief: spec.brief, edges: [], x: 40 + (n % 3) * 175, y: 40 + Math.floor(n / 3) * 120 };
    def.stages.push(s); selected = s.id; renderAll();
  }
  function removeStage(id: string): void {
    def.stages = def.stages.filter((s) => s.id !== id);
    for (const s of def.stages) s.edges = s.edges.filter((e) => e.to !== id); // drop dangling edges
    if (selected === id) selected = null;
    renderAll();
  }
  function addEdge(from: string, to: string): void {
    const s = stageById(from); if (!s || from === to) return;
    if (s.edges.some((e) => e.to === to)) return;                 // no duplicate target
    const used = new Set(s.edges.map((e) => e.when));
    const when: EdgeWhen = !used.has('valid') ? 'valid' : !used.has('invalid') ? 'invalid' : 'always';
    s.edges.push({ when, to });
    selected = from; renderAll();
  }

  // ---- render ----
  function renderAll(): void { renderCanvas(); renderSide(); refreshPalette(); updateFoot(); }
  function refreshPalette(): void { root.querySelectorAll<HTMLElement>('.pb-pchip').forEach((b) => (b as HTMLButtonElement).disabled = !editable); }

  // The run sequence: the FIRST stage in the list is the entry, then we follow edges (breadth-first). Returns
  // the reached stage ids in run order — this is the order the runner executes, made visible.
  function runOrder(): string[] {
    if (!def.stages.length) return [];
    const order: string[] = []; const seen = new Set<string>(); const q: string[] = [def.stages[0].id];
    while (q.length) {
      const id = q.shift()!; if (id === STOP || seen.has(id)) continue;
      const s = stageById(id); if (!s) continue;
      seen.add(id); order.push(id);
      for (const e of s.edges) if (e.to !== STOP && !seen.has(e.to)) q.push(e.to);
    }
    return order;
  }
  // Footer: the sequence in words + a warning for any stage the start can't reach.
  function updateFoot(): void {
    const order = runOrder();
    const seq = order.map((id) => stageById(id)?.name).filter(Boolean).join(' → ') || '(add a stage)';
    const hasStop = def.stages.some((s) => s.edges.some((e) => e.to === STOP));
    const unreached = def.stages.filter((s) => !order.includes(s.id)).length;
    hint.innerHTML = `<b>Runs:</b> ${esc(seq)}${hasStop ? ' <span style="opacity:.65">(→ Stop on a failed gate)</span>' : ''}${unreached ? ` &nbsp;·&nbsp; <span style="color:#e0a44a">⚠ ${unreached} stage${unreached === 1 ? '' : 's'} unreachable from the start</span>` : ''}`;
  }

  function nodeCenter(id: string): { x: number; y: number } {
    if (id === STOP) return { x: stopPos.x, y: stopPos.y + NH / 2 };
    const s = stageById(id); return { x: (s?.x ?? 0), y: (s?.y ?? 0) };
  }

  function renderCanvas(): void {
    canvas.style.width = CANVAS_W + 'px'; canvas.style.height = CANVAS_H + 'px';
    // SVG edges first (behind the nodes)
    const paths: string[] = [];
    for (const s of def.stages) {
      const a = { x: (s.x ?? 0) + NW, y: (s.y ?? 0) + NH / 2 }; // output port (right-middle)
      for (const e of s.edges) {
        const t = e.to === STOP ? { x: stopPos.x, y: stopPos.y + NH / 2 } : (() => { const n = stageById(e.to); return { x: (n?.x ?? 0), y: (n?.y ?? 0) + NH / 2 }; })();
        const c1x = a.x + 60, c2x = t.x - 60;
        const col = e.when === 'invalid' ? '#e0605e' : e.when === 'always' ? 'var(--muted)' : 'var(--accent)';
        paths.push(`<path d="M${a.x},${a.y} C${c1x},${a.y} ${c2x},${t.y} ${t.x},${t.y}" fill="none" style="stroke:${col};stroke-width:2" marker-end="url(#pbah-${e.when})"/>`);
        const mx = (a.x + t.x) / 2, my = (a.y + t.y) / 2;
        paths.push(`<foreignObject x="${mx - 39}" y="${my - 11}" width="78" height="22"><button xmlns="http://www.w3.org/1999/xhtml" class="pb-elab ${e.when}" data-efrom="${s.id}" data-eto="${esc(e.to)}" title="Remove this connection (change its condition in the side panel)">${e.when} <b class="pb-elx">✕</b></button></foreignObject>`);
      }
    }
    if (connecting) {
      const a = nodeCenter(connecting.from); const ax = a.x + NW, ay = a.y + NH / 2;
      paths.push(`<path d="M${ax},${ay} L${connecting.x},${connecting.y}" fill="none" style="stroke:var(--accent-2);stroke-width:2;stroke-dasharray:5 4"/>`);
    }
    const svg = `<svg class="pb-svg" width="${CANVAS_W}" height="${CANVAS_H}"><defs>
      <marker id="pbah-valid" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="#6e7bff"/></marker>
      <marker id="pbah-invalid" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="#e0605e"/></marker>
      <marker id="pbah-always" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="#8a93a3"/></marker>
    </defs>${paths.join('')}</svg>`;

    // Stop terminal + stage nodes. Number each node by its run order (BFS from the first stage) so the
    // sequence is readable at a glance; the entry (order 1) is badged START.
    const order = runOrder();
    const ordOf = (id: string): number => order.indexOf(id) + 1; // 0 → unreachable
    const stopNode = `<div class="pb-node pb-stop" data-sid="${STOP}" style="left:${stopPos.x}px;top:${stopPos.y}px"><span class="pb-port in" data-in="${STOP}"></span>⛔ Stop &amp; report</div>`;
    const nodes = def.stages.map((s) => {
      const spec = kindSpec(s.kind);
      const term = s.edges.length === 0;
      const ord = ordOf(s.id);
      const numBadge = ord === 1 ? '<span class="pb-num start" title="Runs first (START)">▶</span>' : ord > 1 ? `<span class="pb-num" title="Step ${ord}">${ord}</span>` : '<span class="pb-num un" title="Unreachable from the start">!</span>';
      return `<div class="pb-node k-${s.kind} ${selected === s.id ? 'sel' : ''}" data-sid="${s.id}" style="left:${s.x ?? 0}px;top:${s.y ?? 0}px">
        <span class="pb-port in" data-in="${s.id}"></span>
        ${numBadge}
        <span class="pb-ndot" style="background:${spec.dot}"></span>
        <span class="pb-nname">${esc(s.name)}</span>
        ${isGate(s) ? '<i class="pb-gate">gate</i>' : term ? '<i class="pb-term">→PR</i>' : ''}
        ${editable ? `<button class="pb-nx" data-del="${s.id}" title="Delete stage">×</button>` : ''}
        <span class="pb-port out" data-out="${s.id}" title="Drag to another stage to connect"></span>
      </div>`;
    }).join('');
    canvas.innerHTML = svg + stopNode + nodes;
    wireCanvas();
  }

  // ---- side panel: edit the selected stage ----
  function renderSide(): void {
    const s = selected ? stageById(selected) : null;
    if (!s) {
      side.innerHTML = `<div class="pb-empty">Add a stage from the palette, then click it to edit. Drag a node’s right dot onto another stage (or ⛔ Stop) to connect. The <b>START</b>-badged stage runs first; the footer shows the full sequence.</div>`;
      return;
    }
    const dis = editable ? '' : 'disabled';
    const isStart = def.stages[0]?.id === s.id;
    const kindOpts = STAGE_KINDS.map((k) => `<option value="${k.kind}"${k.kind === s.kind ? ' selected' : ''}>${esc(k.label)}</option>`).join('');
    const targets = [...def.stages.filter((x) => x.id !== s.id).map((x) => ({ id: x.id, name: x.name })), { id: STOP, name: '⛔ Stop & report' }];
    const edgeRows = s.edges.map((e, ei) => `<div class="pb-edge">
        <select class="pb-ewhen" data-ei="${ei}" ${dis}>${(['valid', 'invalid', 'always'] as EdgeWhen[]).map((w) => `<option value="${w}"${e.when === w ? ' selected' : ''}>when ${w}</option>`).join('')}</select>
        <span class="pb-earr">→</span>
        <select class="pb-eto" data-ei="${ei}" ${dis}>${targets.map((t) => `<option value="${esc(t.id)}"${e.to === t.id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        ${editable ? `<button class="pb-erm" data-ei="${ei}" title="Remove edge">×</button>` : ''}
      </div>`).join('') || `<div class="pb-noedge">No edges → this stage is terminal (its PR ends the line).</div>`;
    side.innerHTML = `
      ${isStart ? '<div class="pb-startrow">▶ Start — runs first</div>' : '<button class="pb-setstart">★ Make this the start</button>'}
      <div class="pb-srow"><label>Name</label><input class="pb-sname" spellcheck="false" value="${esc(s.name)}" ${dis} /></div>
      <div class="pb-srow"><label>Kind</label><select class="pb-skind" ${dis}>${kindOpts}</select></div>
      <div class="pb-srow"><label>Brief <span class="pb-tok">tokens: {issue} {number} {closeStep} {verdictRel}</span></label><textarea class="pb-sbrief" spellcheck="false" rows="9" ${dis}>${esc(s.brief)}</textarea></div>
      <div class="pb-srow"><label>Edges <span class="pb-tok">a conditional edge makes this a gate</span></label>${edgeRows}</div>`;
    side.querySelector('.pb-setstart')?.addEventListener('click', () => { def.stages = [s, ...def.stages.filter((x) => x.id !== s.id)]; renderAll(); }); // move to index 0 = the entry
    (side.querySelector('.pb-sname') as HTMLInputElement).oninput = (ev) => { s.name = (ev.target as HTMLInputElement).value; const el = canvas.querySelector(`.pb-node[data-sid="${s.id}"] .pb-nname`); if (el) el.textContent = s.name; };
    (side.querySelector('.pb-skind') as HTMLSelectElement).onchange = (ev) => { s.kind = (ev.target as HTMLSelectElement).value as StageKind; renderAll(); };
    (side.querySelector('.pb-sbrief') as HTMLTextAreaElement).oninput = (ev) => { s.brief = (ev.target as HTMLTextAreaElement).value; };
    side.querySelectorAll<HTMLSelectElement>('.pb-ewhen').forEach((sel) => sel.onchange = () => { s.edges[Number(sel.dataset.ei)].when = sel.value as EdgeWhen; renderCanvas(); });
    side.querySelectorAll<HTMLSelectElement>('.pb-eto').forEach((sel) => sel.onchange = () => { s.edges[Number(sel.dataset.ei)].to = sel.value; renderCanvas(); });
    side.querySelectorAll<HTMLElement>('.pb-erm').forEach((b) => b.onclick = () => { s.edges.splice(Number(b.dataset.ei), 1); renderAll(); });
  }

  // ---- canvas pointer handling: move nodes + drag-to-connect ----
  function wireCanvas(): void {
    // edge-label click → remove that connection (its condition is editable via the source stage's side panel)
    canvas.querySelectorAll<HTMLElement>('.pb-elab').forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const s = stageById(b.dataset.efrom!); if (!s) return;
      s.edges = s.edges.filter((ed) => ed.to !== b.dataset.eto);
      renderAll();
    });
    canvas.querySelectorAll<HTMLElement>('.pb-nx').forEach((b) => b.onpointerdown = (e) => e.stopPropagation());
    canvas.querySelectorAll<HTMLElement>('.pb-nx').forEach((b) => b.onclick = (e) => { e.stopPropagation(); removeStage(b.dataset.del!); });
    canvas.querySelectorAll<HTMLElement>('.pb-port.out').forEach((port) => {
      port.onpointerdown = (e) => {
        e.stopPropagation(); e.preventDefault();
        const from = port.dataset.out!;
        connecting = { from, ...canvasPoint(e) };
        const move = (ev: PointerEvent) => { if (connecting) { const p = canvasPoint(ev); connecting.x = p.x; connecting.y = p.y; renderCanvas(); } };
        const up = (ev: PointerEvent) => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
          const tgt = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement)?.closest('.pb-node') as HTMLElement | null;
          const to = tgt?.dataset.sid;
          connecting = null;
          if (to && to !== from) addEdge(from, to); else renderCanvas();
        };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      };
    });

    // Drag to move — stage nodes AND the ⛔ Stop node (its position is stored in def.stopPos).
    canvas.querySelectorAll<HTMLElement>('.pb-node').forEach((node) => {
      node.onpointerdown = (e) => {
        if ((e.target as HTMLElement).closest('.pb-port,.pb-nx')) return; // ports/delete handle themselves
        e.preventDefault();
        const sid = node.dataset.sid!;
        const isStop = sid === STOP;
        const s = isStop ? null : stageById(sid); if (!isStop && !s) return;
        const cur = isStop ? stopPos : { x: s!.x ?? 0, y: s!.y ?? 0 };
        const start = canvasPoint(e); const ox = cur.x - start.x, oy = cur.y - start.y;
        let moved = false;
        const move = (ev: PointerEvent) => {
          const p = canvasPoint(ev);
          const nx = Math.max(0, Math.min(CANVAS_W - NW, p.x + ox)), ny = Math.max(0, Math.min(CANVAS_H - NH, p.y + oy));
          moved = true; node.style.left = nx + 'px'; node.style.top = ny + 'px';
          if (isStop) { stopPos.x = nx; stopPos.y = ny; def.stopPos = { x: nx, y: ny }; } else { s!.x = nx; s!.y = ny; }
          renderCanvas();
        };
        const up = () => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
          if (!moved && !isStop) { selected = sid; renderAll(); } else dirtyLayout(); // Stop isn't editable, so a plain click does nothing
        };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      };
    });
  }
  function canvasPoint(e: PointerEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---- header actions ----
  (root.querySelector('#pbName') as HTMLInputElement).oninput = (e) => { def.name = (e.target as HTMLInputElement).value; };
  root.querySelector('#pbDup')?.addEventListener('click', () => {
    def = { ...clone(def), id: newPipeId(), name: def.name.replace(/\s*\(copy\)$/, '') + ' (copy)', builtin: false, desc: def.desc };
    (root.querySelector('#pbName') as HTMLInputElement).value = def.name;
    const ro = root.querySelector('.pb-ro'); if (ro) ro.textContent = 'custom';
    toast('Duplicated — editing a copy', true);
    renderAll();
  });
  root.querySelector('#pbDel')?.addEventListener('click', async () => {
    const list = (state.settings.pipelines || []).filter((p) => p.id !== def.id);
    try { state.settings = await relay.patchSettings({ pipelines: list }); toast('Pipeline deleted'); onSaved(undefined); close(); }
    catch { toast('Could not delete'); }
  });
  root.querySelector('#pbSave')?.addEventListener('click', async () => {
    def.name = (def.name || '').trim() || 'Untitled pipeline';
    if (!def.stages.length) { toast('Add at least one stage'); return; }
    if (def.builtin) { def.id = newPipeId(); if (def.name === base.name) def.name = base.name + ' (copy)'; } // fork a built-in → new custom
    def.builtin = false;
    def.desc = def.desc || `${def.stages.length}-stage custom pipeline`;
    const list = (state.settings.pipelines || []).slice();
    const i = list.findIndex((p) => p.id === def.id);
    if (i >= 0) list[i] = def; else list.push(def);
    try { state.settings = await relay.patchSettings({ pipelines: list }); toast(`Saved “${def.name}”`, true); onSaved(def.id); close(); }
    catch { toast('Could not save pipeline'); }
  });

  renderAll();
}
