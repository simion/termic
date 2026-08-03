// Opening and navigating a directory tab (issue #151).
//
// Two callers reach a folder and they need DIFFERENT tab semantics:
//
//   openDirTab     — a directory link in a markdown preview. Arriving from
//                    another document, so it recycles the preview tab slot,
//                    exactly like a link to a file does.
//   navigateDirTab — a row / breadcrumb / up-button inside a listing. This
//                    is navigation WITHIN one tab, so it rewrites that tab
//                    in place. Going through openDirTab here would strand a
//                    PINNED listing (preview: false, so it is not the
//                    preview slot) showing the old folder while the new one
//                    landed in some other tab.
//
// Both reveal the folder in the sidebar tree, which is the half that must
// never drift between them.

import { useApp } from "@/store/app";
import { findLeaf } from "@/lib/splitTree";
import type { SplitTree, Tab } from "@/lib/types";

/** Tab label for a directory: its basename, falling back to the task
 *  root's own folder name for the root (rel ""), which has none. */
export function dirTabTitle(rel: string, taskRoot: string): string {
  return rel.split("/").pop() || taskRoot.split("/").pop() || "/";
}

/** Show `rel` (task-root-relative, "" = task root) as a folder listing in
 *  the preview tab, and reveal it in the file tree. The tree reveal
 *  force-opens a hidden right panel — that is `revealInTree`'s existing
 *  contract, kept so a folder link behaves the same however it's reached. */
export function openDirTab(taskId: string, rel: string): void {
  const st = useApp.getState();
  const root = st.tasks.find(t => t.id === taskId)?.path ?? "";
  // The tree keys on non-empty rel paths; revealing "" (the root) would
  // highlight nothing, so only the panel-opening half would land.
  if (rel) st.revealInTree(taskId, rel, true);
  st.openPreviewTab(taskId, { type: "dir", path: rel, title: dirTabTitle(rel, root) });
}

/** Apply a folder move to an open dir tab: reveal it in the tree and patch
 *  the tab's path, label, and history cursor. A manually renamed tab keeps
 *  its label — `customTitle` is the same lock the OSC-title path respects,
 *  and the user's name outranks the folder's. */
function applyDirMove(
  taskId: string, tabId: string, rel: string,
  history: string[], index: number,
  { forcePanel }: { forcePanel: boolean },
): void {
  const st = useApp.getState();
  const root = st.tasks.find(t => t.id === taskId)?.path ?? "";
  const tab = (st.tabs[taskId] ?? []).find(t => t.id === tabId);
  // The tree reveal force-opens a hidden right panel, which is right for a
  // CLICK (you asked to go there) but wrong for a keystroke: ⌘[ would
  // resurrect a panel you deliberately closed, and you could not dismiss it
  // while walking the trail. Skipping it also skips the reveal's one
  // taskDirList per ancestor plus the sidebar re-render, on a key that
  // repeats (CLAUDE.md: an unnecessary sidebar re-render is a real
  // regression). With the panel already open, the tree still tracks.
  if (rel && (forcePanel || !st.rightPanelHidden)) st.revealInTree(taskId, rel, true);
  st.patchTab(taskId, tabId, {
    path: rel,
    dirHistory: history,
    dirHistoryIndex: index,
    // Moving folders swaps which README renders, so the per-document
    // remote-image approval (issue #69) must not ride along — the same
    // invariant openPreviewTab's revealPatch enforces when it recycles a
    // slot. Without this, approving images in one folder's README silently
    // unblocks every README you browse to afterwards, and the webview sits
    // outside the sandbox (docs/sandbox.md, "Known gap").
    remoteImagesUnblocked: undefined,
    ...(tab?.customTitle ? null : { title: dirTabTitle(rel, root) }),
  });
}

/** Move an OPEN directory tab to another folder, in place. Keeps the tab's
 *  pinned state and its pane, so a listing navigates like a browser rather
 *  than spraying tabs — and a pinned listing still navigates at all.
 *  Pushes onto the tab's history, truncating anything ahead of the cursor
 *  (browser semantics: navigating after a back abandons the forward trail). */
export function navigateDirTab(taskId: string, tabId: string, rel: string): void {
  const st = useApp.getState();
  const tab = (st.tabs[taskId] ?? []).find(t => t.id === tabId);
  const prior = tab?.type === "dir" ? tab : undefined;
  const history = (prior?.dirHistory ?? []).slice(0, (prior?.dirHistoryIndex ?? -1) + 1);
  history.push(rel);
  applyDirMove(taskId, tabId, rel, history, history.length - 1, { forcePanel: true });
}

/** Step a directory tab's history by `delta` (-1 back, +1 forward). Returns
 *  false, changing nothing, when there is nowhere to go — which is how ⌘[ /
 *  ⌘] fall through to previous/next task at either end of the trail, instead
 *  of swallowing the app's most-used navigation keys for nothing. */
export function goDirHistory(taskId: string, tabId: string, delta: -1 | 1): boolean {
  const st = useApp.getState();
  const tab = (st.tabs[taskId] ?? []).find(t => t.id === tabId);
  if (tab?.type !== "dir") return false;
  const history = tab.dirHistory ?? [];
  const next = (tab.dirHistoryIndex ?? 0) + delta;
  if (next < 0 || next >= history.length) return false;
  applyDirMove(taskId, tabId, history[next], history, next, { forcePanel: false });
  return true;
}

/** Where the keyboard is, as far as folder history cares. Computed from the
 *  DOM by the shortcut handler and passed in, so the decision below is a
 *  pure function every branch of which can be unit-tested. */
export interface HistoryFocus {
  /** Focus is inside the bottom terminal drawer. */
  inBottom: boolean;
  /** Pane leaf id when focus is inside a NON-main split pane, else null. */
  splitPaneId: string | null;
  /** Focus is inside the main content area. */
  inMainPane: boolean;
  /** Nothing holds focus (document.body). Ordinary browsing lands here: a
   *  row click unmounts the button under the cursor. */
  noFocus: boolean;
}

type HistoryState = {
  tabs: Record<string, Tab[]>;
  splitTree: Record<string, SplitTree>;
  activePaneId: Record<string, string>;
  activeTab: Record<string, string>;
};

/** Which tab, if any, ⌘[ / ⌘] should treat as a folder listing to walk.
 *  Returns undefined when no listing may claim the key, so it falls through
 *  to previous/next task.
 *
 *  DOM focus always wins where it exists, because it is the only signal that
 *  cannot go stale: `activePaneId` is not updated by the main tab strip, so
 *  it can still name a split pane while the user is provably typing in the
 *  main one. It is consulted ONLY when nothing holds focus at all, where it
 *  is the best evidence available and keeps a split-pane listing from being
 *  shadowed by the main pane's. */
export function dirHistoryTarget(
  state: HistoryState, taskId: string, focus: HistoryFocus,
): string | undefined {
  // The drawer holds terminals; no listing there, and one elsewhere must not
  // reach over and claim a key aimed at the drawer.
  if (focus.inBottom) return undefined;
  const tabs = state.tabs[taskId] ?? [];
  const isDir = (id: string | undefined) =>
    id && tabs.find(t => t.id === id)?.type === "dir" ? id : undefined;

  if (focus.splitPaneId) {
    const tree = state.splitTree[taskId];
    const leaf = tree ? findLeaf(tree, focus.splitPaneId) : null;
    return isDir(leaf?.activeTabId ?? undefined);
  }
  if (focus.inMainPane) return isDir(state.activeTab[taskId]);
  if (focus.noFocus) {
    const tree = state.splitTree[taskId];
    const paneId = state.activePaneId[taskId];
    const leaf = tree && paneId ? findLeaf(tree, paneId) : null;
    return isDir(leaf && !leaf.isMain ? (leaf.activeTabId ?? undefined) : state.activeTab[taskId]);
  }
  // Sidebar, right panel, a dialog, settings: the keyboard belongs to them.
  // A listing they are covering must never eat the key, or ⌘[ does nothing
  // the user can see.
  return undefined;
}
