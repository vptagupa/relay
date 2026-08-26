// The languages the in-app file viewer can syntax-highlight. This is the single source of truth for BOTH the
// Settings toggles (which languages are enabled) and the extension→language lookup the viewer uses.
//
// SCALABLE SEAM: adding a language = add ONE entry here, then register its highlight.js module in fileviewer.ts
// (one import + one map entry). Nothing else changes. `id` must match the highlight.js language name.

export interface LangDef { id: string; label: string; exts: string[] }

export const LANGUAGES: LangDef[] = [
  { id: 'javascript', label: 'JavaScript', exts: ['js', 'jsx', 'mjs', 'cjs'] },
  { id: 'typescript', label: 'TypeScript', exts: ['ts', 'tsx', 'mts', 'cts'] },
  { id: 'python', label: 'Python', exts: ['py', 'pyw'] },
  { id: 'php', label: 'PHP', exts: ['php'] },
  { id: 'java', label: 'Java', exts: ['java'] },
  { id: 'xml', label: 'HTML / XML', exts: ['html', 'htm', 'xml', 'svg', 'vue', 'xhtml'] },
  { id: 'css', label: 'CSS / SCSS', exts: ['css', 'scss', 'sass', 'less'] },
  { id: 'json', label: 'JSON', exts: ['json', 'jsonc'] },
  { id: 'bash', label: 'Shell', exts: ['sh', 'bash', 'zsh'] },
  { id: 'markdown', label: 'Markdown', exts: ['md', 'markdown'] },
  { id: 'go', label: 'Go', exts: ['go'] },
  { id: 'rust', label: 'Rust', exts: ['rs'] },
  { id: 'sql', label: 'SQL', exts: ['sql'] },
  { id: 'yaml', label: 'YAML', exts: ['yml', 'yaml'] },
  { id: 'c', label: 'C / C++', exts: ['c', 'h', 'cpp', 'cc', 'hpp', 'cxx'] },
  { id: 'csharp', label: 'C#', exts: ['cs'] },
  { id: 'ruby', label: 'Ruby', exts: ['rb'] },
];

const EXT_MAP: Record<string, LangDef> = {};
for (const l of LANGUAGES) for (const e of l.exts) EXT_MAP[e] = l;

export const langForExt = (ext: string): LangDef | undefined => EXT_MAP[(ext || '').toLowerCase()];
export function langForPath(p: string): LangDef | undefined {
  const m = /\.([^.\\/]+)$/.exec(p || '');
  return m ? langForExt(m[1]) : undefined;
}
