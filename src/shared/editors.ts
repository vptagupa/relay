// The code editors the Files list (and clicked terminal paths) can open a file in. `cmd` is the CLI launcher
// expected on PATH (the same token on every platform for these editors); '' = the OS default file association.
//
// SECURITY: this is an ALLOWLIST. The main process only ever launches a command taken from THIS list (looked up
// from the saved editor id), never a raw string from the renderer — so a compromised renderer can't turn
// "open a file" into arbitrary command execution. An unknown/blank id resolves to the OS default (no launch).

export interface EditorDef { id: string; label: string; cmd: string; }

export const EDITORS: EditorDef[] = [
  { id: 'system', label: 'System default', cmd: '' },
  { id: 'code', label: 'VS Code', cmd: 'code' },
  { id: 'code-insiders', label: 'VS Code Insiders', cmd: 'code-insiders' },
  { id: 'cursor', label: 'Cursor', cmd: 'cursor' },
  { id: 'windsurf', label: 'Windsurf', cmd: 'windsurf' },
  { id: 'codium', label: 'VSCodium', cmd: 'codium' },
  { id: 'subl', label: 'Sublime Text', cmd: 'subl' },
  { id: 'zed', label: 'Zed', cmd: 'zed' },
  { id: 'webstorm', label: 'WebStorm', cmd: 'webstorm' },
  { id: 'idea', label: 'IntelliJ IDEA', cmd: 'idea' },
];

export const DEFAULT_EDITOR = 'code'; // preserves the pre-setting behaviour (VS Code first, else OS default)

export const editorById = (id?: string): EditorDef | undefined => EDITORS.find((e) => e.id === (id == null ? DEFAULT_EDITOR : id));
// The launcher command for a saved id, or '' (→ OS default) for 'system' / an unknown id. Never returns a
// value that isn't in the allowlist above.
export function editorCmd(id?: string): string {
  const e = editorById(id);
  return e ? e.cmd : '';
}
export const editorLabel = (id?: string): string => editorById(id)?.label || 'System default';
