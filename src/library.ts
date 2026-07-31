// Library ordering — pure sort for the saved-sessions list, no DOM or state. The renderer owns the
// panel (render, rename, drag, persistence); it calls this with state.library + the chosen sort mode.

import type { SavedSession } from './shared/types';
import { modelById } from './shared/models';

/** Order saved sessions for the Library list. 'custom' keeps the stored (drag) order untouched;
 *  otherwise sort by name, by model name (then name as a tiebreak), or most-recently-used first.
 *  Returns a new array — the caller's list is never mutated. */
export function sortSessions(sessions: SavedSession[], mode: string): SavedSession[] {
  if (mode === 'custom') return [...sessions]; // manual drag order (stored array order)
  return [...sessions].sort((a, b) =>
    mode === 'name' ? a.name.localeCompare(b.name)
      : mode === 'model' ? (modelById(a.model).name.localeCompare(modelById(b.model).name) || a.name.localeCompare(b.name))
        : b.lastUsed - a.lastUsed);
}
