// The split-pane layout tree — pure algebra, no DOM and no renderer state.
//
// Relay's panes are arranged as a binary split tree: a node is either a LEAF (one pane, identified
// by its group index 0..3) or a SPLIT of two child nodes along a row/col axis with a ratio `r`
// (child `a` gets `r`, child `b` gets `1 - r`). Every operation here is a pure function of the tree
// so it can be reasoned about and unit-tested in isolation; the renderer owns turning a tree into
// DOM (renderNode/reconcilePanes) and persisting it.

export type Leaf = { g: number };
export type Split = { d: 'row' | 'col'; r: number; a: LNode; b: LNode };
export type LNode = Leaf | Split;

export const isLeaf = (n: LNode): n is Leaf => 'g' in n;

/** All pane (group) indices in the tree, left-to-right / top-to-bottom order. */
export function leaves(n: LNode): number[] { return isLeaf(n) ? [n.g] : [...leaves(n.a), ...leaves(n.b)]; }

/** The first leaf reached depth-first (used to pick a fallback pane). Internal helper. */
function firstLeaf(n: LNode): number { return isLeaf(n) ? n.g : firstLeaf(n.a); }

/** Return a new tree with the leaf for group `g` swapped for `repl` (e.g. a fresh split). Pure. */
export function replaceLeaf(n: LNode, g: number, repl: LNode): LNode {
  return isLeaf(n) ? (n.g === g ? repl : n) : { ...n, a: replaceLeaf(n.a, g, repl), b: replaceLeaf(n.b, g, repl) };
}

/** Return a new tree with the leaf for group `g` removed, collapsing its parent split into the sibling. Pure. */
export function removeLeaf(n: LNode, g: number): LNode {
  if (isLeaf(n)) return n;
  if (isLeaf(n.a) && n.a.g === g) return n.b;
  if (isLeaf(n.b) && n.b.g === g) return n.a;
  return { ...n, a: removeLeaf(n.a, g), b: removeLeaf(n.b, g) };
}

/** The group index sharing a split with `g` (for choosing where focus/tabs go when `g` closes), or null. */
export function siblingLeaf(n: LNode, g: number): number | null {
  if (isLeaf(n)) return null;
  if (isLeaf(n.a) && n.a.g === g) return firstLeaf(n.b);
  if (isLeaf(n.b) && n.b.g === g) return firstLeaf(n.a);
  return siblingLeaf(n.a, g) ?? siblingLeaf(n.b, g);
}

// Validate an untrusted (persisted / hand-edited) layout tree: well-formed nodes, leaf groups in
// range 0..3, unique, and each present in `allowed` (groups that actually have restored tabs).
export function isValidLayout(n: unknown, allowed: Set<number>): n is LNode {
  const seen = new Set<number>();
  const walk = (x: any): boolean => {
    if (x && typeof x === 'object' && typeof x.g === 'number') {
      if (!Number.isInteger(x.g) || x.g < 0 || x.g >= 4 || seen.has(x.g) || !allowed.has(x.g)) return false;
      seen.add(x.g); return true;
    }
    if (x && typeof x === 'object' && (x.d === 'row' || x.d === 'col') && typeof x.r === 'number') return walk(x.a) && walk(x.b);
    return false;
  };
  return walk(n);
}
