// Pure helper functions for manipulating the split-pane tree.
// No React, no store — just data transformations that both the store
// (write path) and SplitView (read path) can share.

export type SplitDir = 'v' | 'h';

export interface SplitNode {
  type: 'split';
  id: string;
  dir: SplitDir;
  /** Fraction of space given to child `a` (0.1..0.9 clamped). */
  ratio: number;
  a: SplitTree;
  b: SplitTree;
}

export interface PaneLeaf {
  type: 'pane';
  id: string;
  /** true = the original workspace pane; its content mirrors activeTab[wsId].
   *  false/absent = a split pane with its own tab (or empty SplitLauncher). */
  isMain?: boolean;
  /** null = empty (shows SplitLauncher). non-null = owns a specific tab. */
  tabId: string | null;
}

export type SplitTree = SplitNode | PaneLeaf;

// ── traversal ────────────────────────────────────────────────────────────────

export function findLeaf(tree: SplitTree, id: string): PaneLeaf | null {
  if (tree.type === 'pane') return tree.id === id ? tree : null;
  return findLeaf(tree.a, id) ?? findLeaf(tree.b, id);
}

export function findSplitById(tree: SplitTree, splitId: string): SplitNode | null {
  if (tree.type === 'pane') return null;
  if (tree.id === splitId) return tree;
  return findSplitById(tree.a, splitId) ?? findSplitById(tree.b, splitId);
}

export function getAllLeaves(tree: SplitTree): PaneLeaf[] {
  if (tree.type === 'pane') return [tree];
  return [...getAllLeaves(tree.a), ...getAllLeaves(tree.b)];
}

export function countLeaves(tree: SplitTree): number {
  if (tree.type === 'pane') return 1;
  return countLeaves(tree.a) + countLeaves(tree.b);
}

/** True if any split node in the tree has the given direction. */
export function treeHasDir(tree: SplitTree, dir: SplitDir): boolean {
  if (tree.type === 'pane') return false;
  return tree.dir === dir || treeHasDir(tree.a, dir) || treeHasDir(tree.b, dir);
}

// ── mutations (return new tree, do not mutate input) ─────────────────────────

export function replaceNode(
  tree: SplitTree,
  targetId: string,
  replacement: SplitTree,
): SplitTree {
  if (tree.type === 'pane') return tree.id === targetId ? replacement : tree;
  return {
    ...tree,
    a: replaceNode(tree.a, targetId, replacement),
    b: replaceNode(tree.b, targetId, replacement),
  };
}

/** Remove a leaf by id. Returns null only if the tree HAD one leaf (the root itself). */
export function removeLeaf(tree: SplitTree, targetId: string): SplitTree | null {
  if (tree.type === 'pane') return tree.id === targetId ? null : tree;
  const newA = removeLeaf(tree.a, targetId);
  const newB = removeLeaf(tree.b, targetId);
  if (newA === null) return newB; // a was removed → b takes the whole space
  if (newB === null) return newA; // b was removed → a takes the whole space
  return { ...tree, a: newA, b: newB };
}

export function updateLeafTabId(
  tree: SplitTree,
  leafId: string,
  tabId: string,
): SplitTree {
  if (tree.type === 'pane') {
    return tree.id === leafId ? { ...tree, tabId } : tree;
  }
  return {
    ...tree,
    a: updateLeafTabId(tree.a, leafId, tabId),
    b: updateLeafTabId(tree.b, leafId, tabId),
  };
}

export function updateSplitRatio(
  tree: SplitTree,
  splitId: string,
  ratio: number,
): SplitTree {
  if (tree.type === 'pane') return tree;
  const clamped = Math.max(0.1, Math.min(0.9, ratio));
  if (tree.id === splitId) return { ...tree, ratio: clamped };
  return {
    ...tree,
    a: updateSplitRatio(tree.a, splitId, ratio),
    b: updateSplitRatio(tree.b, splitId, ratio),
  };
}

// ── equalization ─────────────────────────────────────────────────────────────

/**
 * After a split in `dir`, redistribute ratios so all same-axis columns/rows
 * become equal. A perpendicular subtree counts as ONE slot (not one per leaf)
 * so mixed v/h layouts are handled correctly — e.g. adding a vertical pane
 * next to an existing horizontal pair keeps the pair as one visual column.
 *
 * Perpendicular split nodes are recursed into independently, so h-rows inside
 * a v-tree get their own equalization pass.
 */
export function equalizeSplitsOnAxis(tree: SplitTree, dir: SplitDir): SplitTree {
  if (tree.type === 'pane') return tree;
  if (tree.dir !== dir) {
    return { ...tree, a: equalizeSplitsOnAxis(tree.a, dir), b: equalizeSplitsOnAxis(tree.b, dir) };
  }
  const total = countAxisSlots(tree, dir);
  return applyAxisRatios(tree, dir, total);
}

/** Count "slots" along `dir`: a same-dir split adds its children's slots;
 *  a leaf or a perpendicular subtree counts as 1 slot. */
function countAxisSlots(tree: SplitTree, dir: SplitDir): number {
  if (tree.type === 'pane') return 1;
  if (tree.dir !== dir) return 1; // perpendicular subtree = 1 column/row
  return countAxisSlots(tree.a, dir) + countAxisSlots(tree.b, dir);
}

function applyAxisRatios(node: SplitTree, dir: SplitDir, total: number): SplitTree {
  if (node.type === 'pane' || node.dir !== dir) return node;
  const leftSlots = countAxisSlots(node.a, dir);
  return {
    ...node,
    ratio: leftSlots / total,
    a: applyAxisRatios(node.a, dir, leftSlots),
    b: applyAxisRatios(node.b, dir, total - leftSlots),
  };
}

// ── proportional redistribution ──────────────────────────────────────────────

/**
 * "Slot fraction" of each leaf in `dir`: the fraction of total `dir`-space
 * that the leaf's column (v) or row (h) occupies.
 * Perpendicular-direction splits share the same slot → both arms get the same
 * parent slot value so they're treated as a single unit in the `dir` axis.
 */
export function getLeafSlotFractions(tree: SplitTree, dir: SplitDir): Map<string, number> {
  const map = new Map<string, number>();
  function walk(node: SplitTree, slot: number) {
    if (node.type === 'pane') { map.set(node.id, slot); return; }
    if (node.dir === dir) {
      walk(node.a, slot * node.ratio);
      walk(node.b, slot * (1 - node.ratio));
    } else {
      walk(node.a, slot);
      walk(node.b, slot);
    }
  }
  walk(tree, 1.0);
  return map;
}

function subtreeDirFraction(subtree: SplitTree, dir: SplitDir, fracs: Map<string, number>): number {
  if (subtree.type === 'pane') return fracs.get(subtree.id) ?? 0;
  if (subtree.dir === dir) {
    return subtreeDirFraction(subtree.a, dir, fracs) + subtreeDirFraction(subtree.b, dir, fracs);
  }
  // Perpendicular: all leaves share the same slot fraction — return any one.
  const first = getAllLeaves(subtree)[0];
  return first ? (fracs.get(first.id) ?? 0) : 0;
}

/** Rewrite split ratios so each leaf's dir-slot fraction matches `fracs`.
 *  Perpendicular splits' internal ratios are left unchanged. */
export function setLeafFractionsByDir(
  tree: SplitTree,
  dir: SplitDir,
  fracs: Map<string, number>,
): SplitTree {
  if (tree.type === 'pane') return tree;
  if (tree.dir !== dir) {
    return { ...tree, a: setLeafFractionsByDir(tree.a, dir, fracs), b: setLeafFractionsByDir(tree.b, dir, fracs) };
  }
  const aFrac = subtreeDirFraction(tree.a, dir, fracs);
  const bFrac = subtreeDirFraction(tree.b, dir, fracs);
  const total = aFrac + bFrac;
  return {
    ...tree,
    ratio: total > 0 ? Math.max(0.05, Math.min(0.95, aFrac / total)) : tree.ratio,
    a: setLeafFractionsByDir(tree.a, dir, fracs),
    b: setLeafFractionsByDir(tree.b, dir, fracs),
  };
}

// ── geometry (normalized 0..1 coordinates) ────────────────────────────────────

export interface Rect { x: number; y: number; w: number; h: number }

export function computeLeafBounds(tree: SplitTree): Map<string, Rect> {
  const map = new Map<string, Rect>();
  function walk(node: SplitTree, x: number, y: number, w: number, h: number) {
    if (node.type === 'pane') { map.set(node.id, { x, y, w, h }); return; }
    if (node.dir === 'v') {
      const aw = w * node.ratio;
      walk(node.a, x, y, aw, h);
      walk(node.b, x + aw, y, w - aw, h);
    } else {
      const ah = h * node.ratio;
      walk(node.a, x, y, w, ah);
      walk(node.b, x, y + ah, w, h - ah);
    }
  }
  walk(tree, 0, 0, 1, 1);
  return map;
}

/** Bounding rect of every SplitNode (non-leaf) in normalized 0..1 coords. */
export function computeSplitNodeRects(tree: SplitTree): Map<string, Rect> {
  const map = new Map<string, Rect>();
  function walk(node: SplitTree, x: number, y: number, w: number, h: number) {
    if (node.type === 'pane') return;
    map.set(node.id, { x, y, w, h });
    if (node.dir === 'v') {
      const aw = w * node.ratio;
      walk(node.a, x, y, aw, h);
      walk(node.b, x + aw, y, w - aw, h);
    } else {
      const ah = h * node.ratio;
      walk(node.a, x, y, w, ah);
      walk(node.b, x, y + ah, w, h - ah);
    }
  }
  walk(tree, 0, 0, 1, 1);
  return map;
}

export type NavDir = 'left' | 'right' | 'up' | 'down';

/** Return the id of the leaf adjacent to `currentId` in the given direction, or null. */
export function findAdjacentPane(
  tree: SplitTree,
  currentId: string,
  dir: NavDir,
): string | null {
  const all = computeLeafBounds(tree);
  const curr = all.get(currentId);
  if (!curr) return null;

  const EPS = 0.005; // tolerance for floating-point edge alignment
  const currCx = curr.x + curr.w / 2;
  const currCy = curr.y + curr.h / 2;
  // best: primary sort = proximity (dist), secondary = alignment on the perpendicular axis.
  let best: { id: string; dist: number; perp: number } | null = null;

  for (const [id, b] of all) {
    if (id === currentId) continue;
    const bCx = b.x + b.w / 2;
    const bCy = b.y + b.h / 2;
    let qualifies = false;
    let dist = 0;
    let perp = 0; // lower = better aligned

    if (dir === 'right') {
      qualifies = b.x >= curr.x + curr.w - EPS &&
        b.y + b.h >= curr.y - EPS && b.y <= curr.y + curr.h + EPS;
      dist = b.x - (curr.x + curr.w);
      perp = Math.abs(bCy - currCy);
    } else if (dir === 'left') {
      qualifies = b.x + b.w <= curr.x + EPS &&
        b.y + b.h >= curr.y - EPS && b.y <= curr.y + curr.h + EPS;
      dist = curr.x - (b.x + b.w);
      perp = Math.abs(bCy - currCy);
    } else if (dir === 'down') {
      qualifies = b.y >= curr.y + curr.h - EPS &&
        b.x + b.w >= curr.x - EPS && b.x <= curr.x + curr.w + EPS;
      dist = b.y - (curr.y + curr.h);
      perp = Math.abs(bCx - currCx);
    } else { // up
      qualifies = b.y + b.h <= curr.y + EPS &&
        b.x + b.w >= curr.x - EPS && b.x <= curr.x + curr.w + EPS;
      dist = curr.y - (b.y + b.h);
      perp = Math.abs(bCx - currCx);
    }

    if (qualifies && dist >= -EPS) {
      if (!best || dist < best.dist - EPS || (Math.abs(dist - best.dist) < EPS && perp < best.perp)) {
        best = { id, dist, perp };
      }
    }
  }

  return best?.id ?? null;
}
