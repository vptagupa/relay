// Pure bookmark list algebra — the array transforms behind the Bookmarks panel, with no DOM,
// state, or persistence. The renderer owns the panel (render, drag wiring, the selection pill,
// and awaiting relay.patchSettings); it calls these to compute the next list/groups, then persists
// the result. Kept pure so the fiddly drag-reorder + group-membership rules are unit-testable.

import type { Bookmark, BookmarkGroup } from './shared/types';

/** The group a bookmark effectively belongs to (undefined if it has none, or its group was deleted). */
export function groupOf(b: Bookmark, groups: BookmarkGroup[]): string | undefined {
  return groups.some((g) => g.id === b.groupId) ? b.groupId : undefined;
}

/** Prepend a new bookmark, de-duplicating by text and capping the list at `cap`. Returns a new list. */
export function addToList(list: Bookmark[], text: string, id: string, createdAt: number, cap = 300): Bookmark[] {
  return [{ id, text, createdAt }, ...list.filter((b) => b.text !== text)].slice(0, cap);
}

// Move bookmark `id` into group `gid` and position it: before/after the sibling `beforeId` when
// dropped on one, else appended after the last item already in the target group. Returns a new list.
export function reorderBookmark(list: Bookmark[], groups: BookmarkGroup[], id: string, gid: string | undefined, beforeId: string | null, before: boolean): Bookmark[] {
  const out = [...list];
  const di = out.findIndex((b) => b.id === id); if (di < 0) return list;
  const dragged = { ...out[di], groupId: gid };
  out.splice(di, 1);
  if (beforeId && beforeId !== id) {
    let ti = out.findIndex((b) => b.id === beforeId);
    if (ti < 0) ti = out.length; else if (!before) ti += 1;
    out.splice(ti, 0, dragged);
  } else {
    // append after the last item already in the target group
    let at = out.length;
    for (let k = out.length - 1; k >= 0; k--) { if (groupOf(out[k], groups) === gid) { at = k + 1; break; } }
    out.splice(at, 0, dragged);
  }
  return out;
}

/** Delete group `id`, orphaning its bookmarks back to Ungrouped. Returns the new groups + list. */
export function removeGroup(groups: BookmarkGroup[], list: Bookmark[], id: string): { groups: BookmarkGroup[]; list: Bookmark[] } {
  return {
    groups: groups.filter((g) => g.id !== id),
    list: list.map((b) => b.groupId === id ? { ...b, groupId: undefined } : b),
  };
}
