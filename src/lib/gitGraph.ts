// Lane layout for the Git graph (issue #199) — the pure part, so it can be
// unit-tested without a DOM. Given commits in the order git printed them
// (`--topo-order`, newest first), it decides which column each commit's dot
// sits in and which line segments cross each row.
//
// The classic "active lanes" algorithm (see pvigier's Commit Graph Drawing
// Algorithms, and what gitk / Git Graph / VS Code's SCM graph all do): a lane
// is a column currently waiting for a specific commit. Walking newest → oldest,
// a commit takes the lane that was waiting for it (or a free one), then hands
// that lane to its FIRST parent — which is what keeps a branch drawn as one
// straight vertical line — and gives every other parent a lane of its own.
//
// Rendering (GraphPanel) only needs per-row data, so that's what comes out:
// the dot's lane + colour, and the segments to stroke across that row.

/** The minimum a commit must carry to be laid out. */
export interface GraphCommit {
  sha: string;
  /** Parent shas, first parent first (git's order — do not sort). */
  parents: string[];
}

/** One line segment crossing a row.
 *
 *  - `through` spans the full row height (a branch that neither starts nor
 *    ends here). `fromLane === toLane` always: existing lanes never move
 *    sideways, only new ones pick a free column.
 *  - `in` runs from the top edge down to the dot — a child's line arriving at
 *    this commit (several arrive on a merge).
 *  - `out` runs from the dot to the bottom edge — this commit's line leaving
 *    towards a parent. A merge emits one per parent.
 */
export interface GraphLink {
  fromLane: number;
  toLane: number;
  color: number;
  kind: "through" | "in" | "out";
}

export interface GraphRow {
  sha: string;
  /** Column of this commit's dot. */
  lane: number;
  /** Palette index for the dot (the colour of the line it continues). */
  color: number;
  links: GraphLink[];
  /** Columns in use around this row, i.e. how wide the graph must be here. */
  width: number;
}

/** A lane that is open: the column is reserved until `sha` is reached. */
interface Lane {
  sha: string;
  color: number;
}

/** Leftmost free column, or a new one on the right. Reusing the leftmost gap
 *  is what keeps the graph narrow once a branch merges back. */
function firstFree(lanes: (Lane | null)[]): number {
  const i = lanes.indexOf(null);
  return i === -1 ? lanes.length : i;
}

/** Drop trailing empties so `width` reflects what is actually drawn. */
function trim(lanes: (Lane | null)[]): void {
  while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
}

/**
 * Lay out `commits` (newest first, as git printed them).
 *
 * Parents outside the list are normal: a page of history dangles its lines off
 * the bottom edge, exactly like every other graph viewer. A commit whose
 * parent was somehow already emitted just starts a fresh lane rather than
 * drawing an upward line — a page boundary must never produce a cycle.
 */
export function layoutGraph(commits: GraphCommit[]): GraphRow[] {
  const rows: GraphRow[] = [];
  let lanes: (Lane | null)[] = [];
  let nextColor = 0;

  for (const commit of commits) {
    // Every lane waiting for this commit converges on its dot.
    const waiting: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i]?.sha === commit.sha) waiting.push(i);
    }

    const before = lanes.slice();
    const lane = waiting.length ? waiting[0] : firstFree(lanes);
    const color = waiting.length ? lanes[lane]!.color : nextColor++;

    const after = lanes.slice();
    for (const i of waiting) after[i] = null;
    // A commit with no waiting lane still owns its column for this row (it is
    // a head / an unreferenced tip), so reserve it before parents pick lanes.
    after[lane] = null;
    while (after.length <= lane) after.push(null);

    const links: GraphLink[] = [];

    commit.parents.forEach((parent, k) => {
      // Another line already heading for this parent? Then this commit's line
      // joins it instead of opening a duplicate column — that is what makes a
      // merged-back branch close up rather than run on forever.
      const existing = after.findIndex(l => l?.sha === parent);
      if (existing >= 0) {
        links.push({ fromLane: lane, toLane: existing, color: after[existing]!.color, kind: "out" });
        return;
      }
      // First parent inherits the commit's own lane + colour: the branch stays
      // a straight vertical line. Others open a lane (and a colour) of their own.
      const target = k === 0 ? lane : firstFree(after);
      while (after.length <= target) after.push(null);
      const c = k === 0 ? color : nextColor++;
      after[target] = { sha: parent, color: c };
      links.push({ fromLane: lane, toLane: target, color: c, kind: "out" });
    });

    for (let i = 0; i < before.length; i++) {
      const l = before[i];
      if (!l) continue;
      if (l.sha === commit.sha) {
        links.push({ fromLane: i, toLane: lane, color: l.color, kind: "in" });
      } else {
        // Untouched lanes keep their column, so these are plain verticals.
        links.push({ fromLane: i, toLane: i, color: l.color, kind: "through" });
      }
    }

    trim(after);
    rows.push({
      sha: commit.sha,
      lane,
      color,
      links,
      width: Math.max(before.length, after.length, lane + 1),
    });
    lanes = after;
  }

  return rows;
}

/** Widest row, i.e. how many columns the graph gutter needs. 0 for no rows. */
export function graphWidth(rows: GraphRow[]): number {
  return rows.reduce((m, r) => Math.max(m, r.width), 0);
}
