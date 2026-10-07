import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { isBoardQueryActive, parseBoardQuery } from "@/lib/boardFilter";

export type TreeFold = "project" | "folder" | "taskGroup";
export const treeFoldKey = (kind: TreeFold, id: string) => (kind === "project" ? id : `${kind}:${id}`);

/** The one way to fold or open anything in the sidebar tree (docs/ui.md "The
 *  sidebar's filter bar"). While the full sidebar's query filters, the tree
 *  draws the throwaway folds in the ui store, so a fold goes there and the
 *  user's stored layout is left alone; otherwise it is the stored fold. A
 *  write that went around this either rewrote the layout from inside a
 *  filter or changed a fold the tree was not drawing. `compact` is the
 *  sidebar the fold is for: the icon rail has no filter bar. */
export function setTreeFold(kind: TreeFold, id: string, folded: boolean, compact: boolean) {
  if (!compact && isBoardQueryActive(parseBoardQuery(useUI.getState().sidebarQuery))) {
    useUI.getState().setSidebarQueryFold(treeFoldKey(kind, id), folded);
    return;
  }
  const app = useApp.getState();
  if (kind === "project") app.setProjectCollapsed(id, folded);
  else if (kind === "folder") app.setGroupCollapsed(id, folded);
  else app.setTaskGroupCollapsed(id, folded);
}
