// `termic move` / MCP `task_move`: where a task lands in its project's
// sidebar list. Pure, over the list as drawn (groups gathered into blocks by
// `layoutTaskList`), so what is stored is what the user will see, the rule a
// drag already follows.

import type { Task } from "@/lib/types";
import { flattenSegments, layoutTaskList } from "@/lib/taskGroups";

export type MovePlace = { before: string } | { after: string } | { edge: "top" | "bottom" };

/** The project's ids in their new display order, or why the move is refused.
 *  `rows`: one project's live tasks, in store order.
 *
 *  In a group with other members, a task moves among them only: placed
 *  outside, `layoutTaskList` would pull it straight back into the block.
 *  Outside a group (or alone in one), a target inside a group means the
 *  whole block: before its first member or after its last. */
export function planTaskMove(rows: Task[], id: string, place: MovePlace): { ids: string[] } | { error: string } {
  const flat = flattenSegments(layoutTaskList(rows));
  const me = flat.find(t => t.id === id);
  if (!me) return { error: "that task is not in this project's list" };
  const rest = flat.filter(t => t.id !== id);
  const gid = me.group?.id ?? null;
  const span = (g: string) => {
    const at = rest.flatMap((t, i) => (t.group?.id === g ? [i] : []));
    return at.length ? { first: at[0], last: at[at.length - 1] } : null;
  };
  const mine = gid ? span(gid) : null;
  let at: number;
  if ("edge" in place) {
    if (mine) at = place.edge === "top" ? mine.first : mine.last + 1;
    else at = place.edge === "top" ? 0 : rest.length;
  } else {
    const ref = "before" in place ? place.before : place.after;
    if (ref === id) return { error: "a task cannot move relative to itself" };
    const i = rest.findIndex(t => t.id === ref);
    if (i < 0) return { error: "the target task is not in the same project" };
    const tg = rest[i].group?.id ?? null;
    const before = "before" in place;
    if (mine) {
      if (tg !== gid) {
        return { error: "this task is in a group and moves among its members; use --top / --bottom, or leave the group first (termic group --leave)" };
      }
      at = before ? i : i + 1;
    } else if (tg) {
      const block = span(tg)!;
      at = before ? block.first : block.last + 1;
    } else {
      at = before ? i : i + 1;
    }
  }
  const next = [...rest.slice(0, at), me, ...rest.slice(at)];
  // Through the layout once more: the stored order is the drawn one.
  return { ids: flattenSegments(layoutTaskList(next)).map(t => t.id) };
}
