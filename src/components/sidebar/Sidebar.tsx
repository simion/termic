// Left sidebar: traffic-light spacer, toggle, primary nav, projects tree, footer.
// Two layout flavors: full (220px) vs compact (56px, icon-only with tooltips).

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type FocusEvent as ReactFocusEvent } from "react";
import { useApp, useTaskTabs, useActiveTabId } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { LayoutGrid, History, FolderPlus, Settings, Plus, Archive, Layers, Moon, Cog, MoreVertical, GitBranch, GitBranchPlus, FolderGit2, ChevronRight, ChevronDown, Bell, Bug, Mail, Zap, X, Pencil, Copy, ChevronsDownUp, ChevronsUpDown, Check, AudioWaveform, Radio, SquareChevronRight, CircleStop, Loader2, Trash2, Folder, FolderMinus, FolderOpen, Megaphone, Keyboard } from "lucide-react";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator, DropdownLabel } from "@/components/ui/Dropdown";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuLabel, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent } from "@/components/ui/ContextMenu";
import { ProjectActionsMenuItems } from "./ProjectActionsMenuItems";
import { UpdateCard } from "./UpdateCard";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { useUI } from "@/store/ui";
import { cn } from "@/lib/utils";
import { formatTerminalTitle } from "@/lib/terminalTitle";
import { requestCloseTab } from "@/lib/closeTab";
import { taskRename, projectRename, openPath, projectReorder, taskSetYolo, projectRemove, projectUpdate, projectSetGroup } from "@/lib/ipc";
import { copyToClipboard } from "@/lib/clipboard";
import { groupOf, projectSections } from "@/lib/projectGroups";
import { createQuickTask, derivedBranch, type NewTaskMode } from "@/lib/quickTask";
import { confirmAndArchive } from "@/lib/archiveTask";
import { startSpotlight, stopSpotlight } from "@/lib/spotlight";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import type { Task, TerminalTab } from "@/lib/types";
import { effectiveSandboxMode, isSandboxEnforced } from "@/lib/types";
import { SandboxIcon, SANDBOX_VISUALS } from "@/components/SandboxIcon";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";

/** Pick a default name for a freshly-created task (repo-root OR worktree).
 *  Format: "<agent>-N" where N is the next unused index for that CLI among
 *  ALL of the project's existing rows. "shell" → "terminal". The user can
 *  edit before pressing Enter.
 *
 *  Repo-root and worktree rows share one counter on purpose: they share a
 *  namespace (a worktree's branch derives from its name, and the sidebar
 *  rejects a duplicate name either way), so counting only one kind hands
 *  out a name the other kind already took. */
function defaultTaskName(cli: string, taskList: Task[]): string {
  const slug = cli === "shell" ? "terminal" : cli.toLowerCase();
  const prefix = `${slug}-`;
  const used = new Set<number>();
  for (const w of taskList) {
    if (w.name === slug) { used.add(1); continue; }
    if (!w.name.startsWith(prefix)) continue;
    const tail = w.name.slice(prefix.length);
    const n = Number(tail);
    if (Number.isInteger(n) && n > 0) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `${slug}-${n}`;
}

// Group folder accent palette. Keys persist in localStorage (via
// useApp.groupColors); css points at the --color-palette-* tokens in index.css
// @theme; label is for screen readers only (the picker renders bare
// swatches). An unknown stored key (hand-edited storage, palette entry
// removed in a future version) resolves to undefined = default styling.
const GROUP_COLORS: { key: string; label: string; css: string }[] = [
  { key: "red",    label: "Red",    css: "var(--color-palette-red)" },
  { key: "orange", label: "Orange", css: "var(--color-palette-orange)" },
  { key: "yellow", label: "Yellow", css: "var(--color-palette-yellow)" },
  { key: "green",  label: "Green",  css: "var(--color-palette-green)" },
  { key: "teal",   label: "Teal",   css: "var(--color-palette-teal)" },
  { key: "blue",   label: "Blue",   css: "var(--color-palette-blue)" },
  { key: "purple", label: "Purple", css: "var(--color-palette-purple)" },
  { key: "pink",   label: "Pink",   css: "var(--color-palette-pink)" },
];
const groupColorCss = (key: string | undefined): string | undefined =>
  GROUP_COLORS.find(c => c.key === key)?.css;

// `compact` is normally read from the store, but the Arc-style hover reveal
// (App.tsx) renders TWO instances at once: the 56px icon rail (`compact`)
// plus a full-width overlay (`compact={false}`) that slides in on hover. The
// optional prop lets that overlay force full mode regardless of the store.
export function Sidebar({ compact: compactProp }: { compact?: boolean } = {}) {
  const compactStore = useApp(s => s.compactSidebar);
  const compact = compactProp ?? compactStore;
  const openSettings = useApp(s => s.openSettings);
  const projects = useApp(s => s.projects);
  const sidebarWidth = useApp(s => s.sidebarWidth);
  const setSidebarWidth = useApp(s => s.setSidebarWidth);
  const tasks = useApp(s => s.tasks);
  const activeTask = useApp(s => s.activeTaskId);
  const setActive = useApp(s => s.setActiveTask);
  const setView = useApp(s => s.setView);
  const currentView = useApp(s => s.view.page);
  const tabs = useApp(s => s.tabs);
  const mountedTasks = useApp(s => s.mountedTasks);
  const loadAll = useApp(s => s.loadAll);
  const openNewProject = useUI(s => s.openNewProject);
  const openNewTask = useUI(s => s.openNewTask);
  const collapsedProjects = useApp(s => s.collapsedProjects);
  const setProjectCollapsed = useApp(s => s.setProjectCollapsed);
  const collapsedGroups = useApp(s => s.collapsedGroups);
  const setGroupCollapsed = useApp(s => s.setGroupCollapsed);
  const groupColors = useApp(s => s.groupColors);
  const setGroupColor = useApp(s => s.setGroupColor);
  const setAllTasksCollapsed = useApp(s => s.setAllTasksCollapsed);
  const setAllGroupsCollapsed = useApp(s => s.setAllGroupsCollapsed);
  // (agents subscription lives inside ProjectActionsMenuItems now —
  // Sidebar itself doesn't need the registry.)

  // If the user disabled the settled highlight (Settings → General),
  // every isUnread() call returns false — the icon stays in its calm
  // state regardless of agent activity.
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const branchPrefix = usePrefs(s => s.branchPrefix);
  const taskExpandMode = usePrefs(s => s.taskExpandMode);
  const setTaskExpandMode = usePrefs(s => s.setTaskExpandMode);
  const hideInactiveProjects = usePrefs(s => s.hideInactiveProjects);
  const setHideInactiveProjects = usePrefs(s => s.setHideInactiveProjects);
  // Temporary, non-persisted reveal of the hidden inactive projects. Reset
  // whenever the hide pref flips off so the "Show N inactive" row starts
  // collapsed next time the user re-enables hiding.
  const [showInactive, setShowInactive] = useState(false);
  const isUnread = (taskId: string) =>
    settledHighlight &&
    (tabs[taskId] || []).some(t => t.type === "terminal" && t.unread);

  /** Build a mailto: URL with prefilled subject + body and hand it to
   *  the OS's default mail handler via `open_path` (the same Rust
   *  command the Open button uses for preview URLs — it shells out to
   *  macOS `open`, which DTRT for mailto: too).
   *
   *  `open` always exits 0 once it hands the URL to *some* app, even
   *  when that app can't do anything useful with a mailto: link — on
   *  macOS the mailto: scheme handler in LaunchServices isn't tied to
   *  the "default email reader" setting, and can end up pointing at a
   *  browser (e.g. Chrome) instead of Mail/Outlook, which just opens a
   *  blank tab (#103). There's no reliable way to detect that failure
   *  from here, so always copy the address too: whatever mailto: does,
   *  the user still walks away with contact@termic.dev in hand. */
  const openMailto = (to: string, subject: string, body: string) => {
    const url = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    openPath(url).catch(() => {});
    copyToClipboard(to, to);
  };
  /** Open a prefilled "New issue" on the public GitHub tracker. Same
   *  query-string shape as openMailto so both support buttons route through
   *  one builder. */
  const openIssue = (title: string, body: string) => {
    const url = `https://github.com/simion/termic/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    openPath(url).catch(() => {});
  };
  /** True if ANY tab in the task just transitioned to settled/idle
   *  (work-done signal — agent stopped producing output, waiting on
   *  user). Gated on the same `settledHighlight` pref so the check
   *  disappears entirely when the user disables the work-done UI. */
  const isWorkDone = (taskId: string) =>
    settledHighlight &&
    (tabs[taskId] || []).some(t =>
      // Authoritative per-tab work state (driven by OSC 9;4 / 133 / 9
      // / title in TerminalPane). Replaces the old `unread.reason="done"`
      // edge — see the workState state machine.
      t.type === "terminal" && t.workState === "done",
    );
  // Distinct from work-done: the agent is explicitly blocked on the
  // user (Gemini ✋ Action Required, Codex Waiting, OSC 1337
  // RequestAttention). Different sidebar icon (bell vs check).
  const needsAttention = (taskId: string) =>
    settledHighlight &&
    (tabs[taskId] || []).some(t =>
      t.type === "terminal" && t.unread?.reason === "attention",
    );
  const isLoaded = (taskId: string) =>
    (tabs[taskId] || []).some(t => t.type === "terminal" && t.ptyId);

  // Inline rename state for PROJECTS and GROUPS (for groups, `id` is the
  // group NAME — groups are derived from Project.group labels and have no
  // id). Task rename is managed inside TaskRow so it can co-exist with
  // per-tab rename state.
  const [renaming, setRenaming] = useState<{ kind: "proj" | "group"; id: string; value: string } | null>(null);
  // Radix menus close AFTER onSelect and asynchronously restore focus to the
  // trigger; autoFocus on the freshly-mounted input loses that race (worse for
  // groups, whose header is focusable and reclaims it). Re-focus + select on
  // the next two frames to land after Radix's restore tick. Same workaround as
  // the task rename input (see TaskRow). Keyed on which rename so switching
  // targets re-focuses, but typing (value change) doesn't re-select.
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!renaming) return;
    let cancelled = false;
    const r1 = requestAnimationFrame(() => {
      const r2 = requestAnimationFrame(() => {
        if (cancelled) return;
        // Focus + select unconditionally (same as PendingRepoRootRow's
        // name prompt): when the rename starts AFTER the menu's
        // focus-restore already settled (e.g. new-group, where async IPC
        // delays setRenaming), autoFocus wins — but the suggested name
        // must still be selected so typing replaces it.
        const el = renameInputRef.current;
        if (el) { el.focus(); el.select(); }
      });
      if (cancelled) cancelAnimationFrame(r2);
    });
    return () => { cancelled = true; cancelAnimationFrame(r1); };
  }, [renaming?.kind, renaming?.id]);
  // Project whose `+` dropdown is currently open. Used to keep the row
  // visually "hovered" (bg + Cog visible) while the menu is open;
  // otherwise the menu trigger looks like it un-selected its parent.
  const [menuOpenProjectId, setMenuOpenProjectId] = useState<string | null>(null);
  // Inline name-prompt state for repo-root task creation. When the
  // user picks an agent from the project's `+` menu, we stash the choice
  // here and render a focused input row under the project — Enter creates
  // the task with the typed name, Esc cancels. This is the
  // low-friction alternative to a modal dialog.
  // Inline "new task" name prompt. For a worktree it also carries the
  // auto-derived (but editable) branch; `branchEdited` freezes auto-derive
  // once the user touches the branch field.
  const [pendingRepoRoot, setPendingRepoRoot] =
    useState<{
      projectId: string;
      cli: string;
      mode: NewTaskMode;
      value: string;
      branch: string;
      branchEdited: boolean;
    } | null>(null);
  // Guards the inline commit against a double Enter while the (multi-second)
  // create IPC is in flight — otherwise two tasks / a swallowed error.
  const inlineCreatingRef = useRef(false);
  // Drag-to-reorder PROJECTS. Pointer-event based (WKWebView's HTML5
  // DnD is unreliable in Tauri). The row physically moves during the
  // drag — we mutate the live `projects` order in the app store on
  // every pointermove, so the item being dragged actually shifts
  // past siblings instead of just showing a drop-target ring.
  //
  // CRITICAL: pointermove + pointerup listeners go on `document`,
  // NOT the per-row React element. When the array reorders mid-drag,
  // React detaches + reattaches the moved DOM node, which kills any
  // pointer capture held on it — subsequent moves fire on whatever
  // element sits under the cursor, and per-row handlers bail because
  // they check `armed.id !== p.id`. Document-level listeners survive
  // every reorder.
  //
  // Flow:
  //   onPointerDown (per-row) → arm dragArmed.current + add document
  //     pointermove/pointerup listeners
  //   document pointermove past 4px → enter dragging
  //   document pointermove while dragging → hit-test, splice store
  //   document pointerup → IPC project_reorder + clean up listeners
  const [dragProjectId, setDragProjectId] = useState<string | null>(null);
  // translateY applied to the dragged header so it follows the cursor (the
  // smooth feel, same as the prompt library); the list still reorders live.
  const [dragTy, setDragTy] = useState(0);
  const dragArmed = useRef<
    { id: string; x: number; y: number; started: boolean; grabOffsetY: number; appliedTy: number; pointerY: number; origGroup: string; fromFold: boolean } | null
  >(null);
  const dragListenersRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);
  // Folder header the cursor is currently over while dragging a project —
  // "drop INTO this group". State drives the header highlight; the ref is
  // what the document-level pointerup reads (the listener closure would
  // otherwise see a stale state value).
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const dragOverGroupRef = useRef<string | null>(null);
  // Clicking a group header to dismiss its open rename input must NOT also
  // toggle collapse: the input's blur (→ commitRename → renaming=null) fires
  // on mousedown, BEFORE the click event, so a state check in onClick sees
  // rename already closed. Captured on pointerdown instead, when the input
  // is still mounted. Also set after a completed group drag so the click
  // that follows pointerup doesn't collapse the folder that was just moved.
  const suppressGroupToggle = useRef(false);

  // ── Group header drag-to-reorder ──────────────────────────────────────
  // Same pointer pattern as project rows, but the unit is the whole folder:
  // its members move through the array as one contiguous block (labels
  // never change), and the section container follows the cursor.
  const [dragGroupName, setDragGroupName] = useState<string | null>(null);
  const [dragGroupTy, setDragGroupTy] = useState(0);
  const groupDragArmed = useRef<
    { name: string; x: number; y: number; started: boolean; grabOffsetY: number; appliedTy: number; pointerY: number } | null
  >(null);
  const groupDragListenersRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);

  // All drag hit-testing is scoped to THIS instance's DOM — the Arc-style
  // hover reveal renders two Sidebars at once (compact rail + full overlay),
  // and a document-wide query would also match the other instance's rows.
  const dragRoot = (): ParentNode => asideRef.current ?? document;

  // translateY that keeps the dragged header under the cursor, self-correcting
  // against the live layout after each reorder (reads the header's real rect
  // minus the transform already applied to recover its untranslated slot).
  const computeProjectTy = (clientY: number): number => {
    const armed = dragArmed.current;
    const el = armed && dragRoot().querySelector<HTMLElement>(`[data-project-id="${CSS.escape(armed.id)}"]`);
    if (!armed || !el) return 0;
    const layoutTop = el.getBoundingClientRect().top - armed.appliedTy;
    const ty = (clientY - armed.grabOffsetY) - layoutTop;
    armed.appliedTy = ty;
    return ty;
  };

  // Tear-down helper, used by both pointerup and pointercancel.
  const endDrag = (commit: boolean) => {
    const ls = dragListenersRef.current;
    if (ls) {
      document.removeEventListener("pointermove", ls.move);
      document.removeEventListener("pointerup", ls.up);
      document.removeEventListener("pointercancel", ls.up);
      dragListenersRef.current = null;
    }
    const armed = dragArmed.current;
    const wasStarted = armed?.started ?? false;
    const hoverGroup = dragOverGroupRef.current;
    dragArmed.current = null;
    dragOverGroupRef.current = null;
    setDragOverGroup(null);
    setDragProjectId(null);
    setDragTy(0);
    if (commit && wasStarted && armed) {
      const list = [...useApp.getState().projects];
      const idx = list.findIndex(x => x.id === armed.id);
      if (idx === -1) return;
      let dragged = list[idx];
      if (hoverGroup) {
        // Dropped on a folder header → become the group's first member
        // (that's where the cursor is). Update the local order optimistically
        // and expand the folder so the drop is visible.
        dragged = { ...dragged, group: hoverGroup };
        list.splice(idx, 1);
        // First member of the group in array order. Grouped rows never fold
        // under "Hide inactive projects" (only loose rows do), so every member
        // is visible; the shown() guard just keeps this in lockstep with the
        // render's shownInline.
        const hideInactive = usePrefs.getState().hideInactiveProjects;
        const wss = useApp.getState().tasks;
        const firstIdx = list.findIndex(x =>
          groupOf(x) === hoverGroup
          && (!hideInactive || !!groupOf(x) || wss.some(w => w.project_id === x.id && !w.archived)),
        );
        // -1 = dragged is the folder's SOLE (visible) member (dropped on
        // its own header): keep its slot instead of teleporting the
        // folder to the end of the list.
        list.splice(firstIdx === -1 ? idx : firstIdx, 0, dragged);
        useApp.setState({ projects: list });
        setGroupCollapsed(hoverGroup, false);
      }
      // Group changed during the drag (live adoption between rows, or the
      // header drop above) → persist it before the reorder. projectSetGroup
      // touches ONLY the group field, so a stale snapshot of the dragged
      // project can't clobber concurrent edits to its other fields.
      const newGroup = groupOf(dragged);
      const groupChanged = newGroup !== armed.origGroup;
      const finalIds = list.map(x => x.id);
      (async () => {
        try {
          if (groupChanged) await projectSetGroup([dragged.id], newGroup || null);
          await projectReorder(finalIds);
        } catch {
          void useApp.getState().loadAll();
        }
      })();
    }
  };

  // Single shared pointermove handler — keyed off armed.id (the
  // dragged project) rather than any per-row closure. Survives the
  // dragged element being reparented during reorder.
  const onDragPointerMove = (e: PointerEvent) => {
    const armed = dragArmed.current;
    if (!armed) return;
    if (!armed.started) {
      const dx = e.clientX - armed.x;
      const dy = e.clientY - armed.y;
      if (dx * dx + dy * dy < 16) return;
      armed.started = true;
      setDragProjectId(armed.id);
    }
    // Follow the cursor every move (before the reorder hit-test, which has
    // early returns), so the header tracks smoothly even when no swap happens.
    armed.pointerY = e.clientY;
    setDragTy(computeProjectTy(e.clientY));
    const dragId = armed.id;
    const all = useApp.getState().projects;
    const fromIdx = all.findIndex(x => x.id === dragId);
    if (fromIdx === -1) return;

    // Anchors below resolve against the projects the user can SEE. Grouped
    // rows never fold under "Collapse inactive ungrouped projects" (only loose
    // rows do), so shown() mirrors the render's shownInline: grouped always
    // visible, loose visible only when active. getState (not the render
    // closure): the document-level listener is captured once at pointerdown and
    // would otherwise read stale values.
    const hideInactive = usePrefs.getState().hideInactiveProjects;
    const wss = useApp.getState().tasks;
    const shown = (x: typeof all[number]) =>
      !hideInactive || !!groupOf(x) || wss.some(w => w.project_id === x.id && !w.archived);
    // First VISIBLE member of group `g` in array order (skipping the
    // dragged row) — matches the first row rendered inside the folder.
    const firstIdOfGroup = (g: string): string | null =>
      all.find(x => x.id !== dragId && shown(x) && groupOf(x) === g)?.id ?? null;
    // Id of the project that FOLLOWS group `g`'s last VISIBLE member in
    // array order (null = end of array) — "insert at the end of the folder".
    const idAfterGroup = (g: string): string | null => {
      let last = -1;
      all.forEach((x, i) => { if (x.id !== dragId && shown(x) && groupOf(x) === g) last = i; });
      for (let i = last + 1; i < all.length; i++) if (all[i].id !== dragId) return all[i].id;
      return null;
    };
    // Project following the dragged row itself — the "stay at this index"
    // slot, used when the dragged row is a folder's SOLE member (the
    // group-relative anchors above have nothing to anchor to then).
    const idAfterSelf = (): string | null => {
      for (let i = fromIdx + 1; i < all.length; i++) if (all[i].id !== dragId) return all[i].id;
      return null;
    };

    // Zone-based target: where the cursor is decides both the slot AND the
    // dragged project's group.
    //   inside a folder's rendered container:
    //     header top half    → before the folder, ungrouped
    //     header bottom half → INTO the folder (highlight; assign on drop)
    //     members area       → before the member under the cursor, in-group;
    //                          past the last member (but still inside the
    //                          container) stays at the folder's end — so
    //                          hovering the tail of your own folder doesn't
    //                          eject you.
    //   outside any folder: walk loose headers + whole folder sections in
    //   document order; first midpoint below the cursor wins, ungrouped.
    let hovered: string | null = null;
    let slot: { beforeId: string | null; group: string } | null = null;
    const curGroup = groupOf(all[fromIdx]);
    // The revealed inactive fold is its own drag domain: rows there render
    // flat in a separate section regardless of their group label, so a
    // reorder across it must NOT rewrite the dragged project's group —
    // neither stripping a grouped inactive row nor silently adopting a
    // group when an inactive row passes an active folder's y-range. That
    // cuts BOTH ways: a drag that ORIGINATES in the fold keeps its group
    // everywhere (fold rows render flat, so an adoption or strip would be
    // invisible until hide-inactive is toggled off) — sections are plain
    // reorder boundaries for it, never drop targets.
    const fold = dragRoot().querySelector<HTMLElement>("[data-inactive-fold]");
    const foldRect = fold?.getBoundingClientRect();
    const inFold = !!foldRect && e.clientY >= foldRect.top && e.clientY <= foldRect.bottom;
    let inSection: HTMLElement | null = null;
    if (!inFold && !armed.fromFold) {
      for (const sec of Array.from(dragRoot().querySelectorAll<HTMLElement>("[data-group-section]"))) {
        const r = sec.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) { inSection = sec; break; }
      }
    }
    if (inFold && fold) {
      slot = { beforeId: null, group: curGroup };
      for (const el of Array.from(fold.querySelectorAll<HTMLElement>("[data-project-id]"))) {
        if (el.dataset.projectId === dragId) continue;
        const r = el.getBoundingClientRect();
        if (e.clientY < (r.top + r.bottom) / 2) {
          slot = { beforeId: el.dataset.projectId!, group: curGroup };
          break;
        }
      }
    } else if (inSection) {
      const g = inSection.dataset.groupSection!;
      const header = inSection.querySelector<HTMLElement>("[data-group-name]");
      const hr = header?.getBoundingClientRect();
      if (hr && e.clientY < (hr.top + hr.bottom) / 2) {
        // ?? idAfterSelf(): dragged is the folder's sole member — pulling
        // it out above the header keeps its index, just ungroups it.
        slot = { beforeId: firstIdOfGroup(g) ?? idAfterSelf(), group: "" };
      } else if (hr && e.clientY <= hr.bottom) {
        hovered = g;
      } else if (!firstIdOfGroup(g)) {
        // Members area of a folder whose only member IS the dragged row:
        // nothing to reorder against — stay put.
        slot = null;
      } else {
        slot = { beforeId: idAfterGroup(g), group: g };
        for (const el of Array.from(inSection.querySelectorAll<HTMLElement>("[data-project-id]"))) {
          if (el.dataset.projectId === dragId) continue;
          const r = el.getBoundingClientRect();
          if (e.clientY < (r.top + r.bottom) / 2) {
            slot = { beforeId: el.dataset.projectId!, group: g };
            break;
          }
        }
      }
    } else {
      // Fold-origin drags keep their label (see the fold-domain note above);
      // everything else dropped at top level becomes ungrouped.
      slot = { beforeId: null, group: armed.fromFold ? curGroup : "" };
      const boundaries = Array.from(
        dragRoot().querySelectorAll<HTMLElement>("[data-project-id], [data-group-section]"),
      ).filter(el =>
        el.dataset.groupSection !== undefined
          ? true
          : el.dataset.projectId !== dragId
            && !el.closest("[data-group-section]")
            && !el.closest("[data-inactive-fold]"));
      for (const el of boundaries) {
        const r = el.getBoundingClientRect();
        if (e.clientY < (r.top + r.bottom) / 2) {
          slot.beforeId = el.dataset.groupSection !== undefined
            ? (firstIdOfGroup(el.dataset.groupSection) ?? idAfterSelf())
            : el.dataset.projectId!;
          break;
        }
      }
    }
    if (hovered !== dragOverGroupRef.current) {
      dragOverGroupRef.current = hovered;
      setDragOverGroup(hovered);
    }
    if (hovered || !slot) return;

    const { beforeId, group: targetGroup } = slot;
    const nextIds = all.map(x => x.id).filter(id => id !== dragId);
    const insertAt = beforeId
      ? nextIds.findIndex(id => id === beforeId)
      : nextIds.length;
    const targetIdx = insertAt === -1 ? nextIds.length : insertAt;
    if (targetIdx === fromIdx && targetGroup === curGroup) return;
    nextIds.splice(targetIdx, 0, dragId);
    useApp.setState(s => ({
      projects: nextIds
        .map(id => s.projects.find(x => x.id === id)!)
        .filter(Boolean)
        // Live group adoption: the row visually slides into / out of the
        // folder as it crosses the boundary; persisted on drop by endDrag.
        .map(p => p.id === dragId && groupOf(p) !== targetGroup
          ? { ...p, group: targetGroup || undefined }
          : p),
    }));
  };

  // translateY for the dragged SECTION (group drag) — same self-correcting
  // scheme as computeProjectTy, measured on the section container.
  const computeGroupTy = (clientY: number): number => {
    const armed = groupDragArmed.current;
    const el = armed && dragRoot().querySelector<HTMLElement>(`[data-group-section="${CSS.escape(armed.name)}"]`);
    if (!armed || !el) return 0;
    const layoutTop = el.getBoundingClientRect().top - armed.appliedTy;
    const ty = (clientY - armed.grabOffsetY) - layoutTop;
    armed.appliedTy = ty;
    return ty;
  };

  const endGroupDrag = (commit: boolean) => {
    const ls = groupDragListenersRef.current;
    if (ls) {
      document.removeEventListener("pointermove", ls.move);
      document.removeEventListener("pointerup", ls.up);
      document.removeEventListener("pointercancel", ls.up);
      groupDragListenersRef.current = null;
    }
    const wasStarted = groupDragArmed.current?.started ?? false;
    groupDragArmed.current = null;
    setDragGroupName(null);
    setDragGroupTy(0);
    if (commit && wasStarted) {
      const finalIds = useApp.getState().projects.map(x => x.id);
      projectReorder(finalIds).catch(() => { void useApp.getState().loadAll(); });
    }
  };

  const onGroupDragPointerMove = (e: PointerEvent) => {
    const armed = groupDragArmed.current;
    if (!armed) return;
    if (!armed.started) {
      const dx = e.clientX - armed.x;
      const dy = e.clientY - armed.y;
      if (dx * dx + dy * dy < 16) return;
      armed.started = true;
      setDragGroupName(armed.name);
    }
    armed.pointerY = e.clientY;
    setDragGroupTy(computeGroupTy(e.clientY));
    const name = armed.name;
    const all = useApp.getState().projects;
    const members = all.filter(x => groupOf(x) === name);
    if (members.length === 0) return;
    const rest = all.filter(x => groupOf(x) !== name);
    const hideInactive = usePrefs.getState().hideInactiveProjects;
    const wss = useApp.getState().tasks;
    const shown = (x: typeof all[number]) =>
      !hideInactive || !!groupOf(x) || wss.some(w => w.project_id === x.id && !w.archived);
    // Top-level boundaries only: loose rows + OTHER folder sections in
    // document order. A folder can't nest, so its drop slots are always
    // between top-level items; first midpoint below the cursor wins.
    const boundaries = Array.from(
      dragRoot().querySelectorAll<HTMLElement>("[data-project-id], [data-group-section]"),
    ).filter(el =>
      el.dataset.groupSection !== undefined
        ? el.dataset.groupSection !== name
        : !el.closest("[data-group-section]") && !el.closest("[data-inactive-fold]"));
    let beforeId: string | null = null;
    for (const el of boundaries) {
      const r = el.getBoundingClientRect();
      if (e.clientY < (r.top + r.bottom) / 2) {
        beforeId = el.dataset.groupSection !== undefined
          ? rest.find(x => shown(x) && groupOf(x) === el.dataset.groupSection)?.id ?? null
          : el.dataset.projectId!;
        break;
      }
    }
    const at = beforeId ? rest.findIndex(x => x.id === beforeId) : rest.length;
    const insertAt = at === -1 ? rest.length : at;
    const next = [...rest.slice(0, insertAt), ...members, ...rest.slice(insertAt)];
    if (next.every((x, i) => x === all[i])) return;
    useApp.setState({ projects: next });
  };

  // After a live reorder re-renders the list, the dragged header sits in a new
  // slot — re-derive its transform from the new layout BEFORE paint so it
  // doesn't jump for a frame.
  useLayoutEffect(() => {
    if (dragArmed.current?.started) setDragTy(computeProjectTy(dragArmed.current.pointerY));
    if (groupDragArmed.current?.started) setDragGroupTy(computeGroupTy(groupDragArmed.current.pointerY));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  async function commitRename() {
    if (!renaming) return;
    const { kind, id, value } = renaming;
    setRenaming(null);
    const trimmed = value.trim();
    if (!trimmed) return;
    try {
      if (kind === "proj") {
        await projectRename(id, trimmed);
      } else {
        // Group rename = relabel every member in ONE atomic write (groups
        // are derived from Project.group, there is no group entity).
        // Renaming onto an existing group's name merges the two.
        // Uppercase again at commit (belt to the input's braces) — a
        // lowercase label on disk would diverge from what groupOf renders.
        const label = trimmed.toUpperCase();
        if (label === id) return;
        const memberIds = useApp.getState().projects
          .filter(p => groupOf(p) === id).map(p => p.id);
        await projectSetGroup(memberIds, label);
        useApp.getState().renameGroupState(id, label);
      }
      await loadAll();
    } catch (e) {
      console.error("rename failed", e);
      // Resync from disk — the UI may be showing optimistic state.
      void loadAll();
    }
  }

  // ── Project groups (UI-only folders in this list) ──────────────────────
  // A group exists iff ≥1 project carries its label; ordered by first
  // appearance in the (user-orderable) projects array. Includes groups
  // whose members are currently folded into the inactive section so the
  // "Move to group" menu can still target them.
  const allGroups: string[] = [];
  for (const p of projects) {
    const g = groupOf(p);
    if (g && !allGroups.includes(g)) allGroups.push(g);
  }

  const moveToGroup = async (p: typeof projects[number], group: string | null): Promise<boolean> => {
    try {
      // Filing INTO an existing folder also repositions the project to the
      // folder's end in the array. Without this a project that sits earlier
      // in the array than the folder would drag the whole folder up to its
      // old position (a section renders at its FIRST member's index).
      let reorderIds: string[] | null = null;
      if (group) {
        const all = useApp.getState().projects;
        if (all.some(x => x.id !== p.id && groupOf(x) === group)) {
          const list = all.filter(x => x.id !== p.id);
          let last = -1;
          list.forEach((x, i) => { if (groupOf(x) === group) last = i; });
          list.splice(last + 1, 0, { ...p, group });
          useApp.setState({ projects: list });
          reorderIds = list.map(x => x.id);
        }
      }
      await projectSetGroup([p.id], group);
      if (reorderIds) await projectReorder(reorderIds);
      // Expand the destination so the project doesn't silently vanish
      // into a collapsed folder.
      if (group) setGroupCollapsed(group, false);
      await loadAll();
      return true;
    } catch (e) {
      console.error("move to group failed", e);
      void loadAll();
      return false;
    }
  };

  const createGroupWith = async (p: typeof projects[number]) => {
    const names = new Set(allGroups);
    let name = "NEW GROUP";
    for (let n = 2; names.has(name); n += 1) name = `NEW GROUP ${n}`;
    const ok = await moveToGroup(p, name);
    // Immediately offer the real name — but only when the fresh folder
    // actually renders an editable header: full mode (compact has no inline
    // rename, matching project rename) AND a visible member (a hidden
    // inactive project renders no folder, which would strand the rename
    // state with no input to commit or escape it).
    if (ok && !compact && shownInline(p)) {
      setRenaming({ kind: "group", id: name, value: name });
    }
  };

  const dissolveGroup = async (name: string) => {
    const ids = useApp.getState().projects.filter(p => groupOf(p) === name).map(p => p.id);
    try {
      await projectSetGroup(ids, null);
      await loadAll();
    } catch (e) {
      console.error("ungroup failed", e);
      void loadAll();
    }
  };

  const asideRef = useRef<HTMLElement>(null);

  // Inactive = no active (non-archived) tasks. When the hide pref is on we
  // split the list into two groups that each KEEP the original project order:
  // active rows render in place, inactive rows fold into a group below the
  // "Show N inactive" toggle. Membership is purely "does it have a task" —
  // a project only graduates to the active group once an actual task
  // exists, NOT while its repo-name prompt is still open (the prompt renders in
  // place within the revealed inactive group). Because both groups preserve
  // order, a folded project that gains a task pops back to its rightful
  // position among the active rows.
  //
  // GROUPED projects are EXEMPT from the fold: a project inside a folder stays
  // in that folder regardless of activity, so hide-inactive never yanks a
  // grouped project out to the flat bottom fold (that read as a bug — you
  // grouped it on purpose). Only LOOSE (ungrouped) inactive projects fold. So
  // the fold is "declutter the loose top-level list"; folders stay intact and
  // are the user's own organization to prune.
  const projectIsActive = (pid: string) =>
    tasks.some(w => w.project_id === pid && !w.archived);
  const shownInline = (p: typeof projects[number]) =>
    !hideInactiveProjects || projectIsActive(p.id) || !!groupOf(p);
  const activeProjects = projects.filter(shownInline);
  const inactiveProjects = projects.filter(p => !shownInline(p));
  const inactiveCount = inactiveProjects.length;
  // If hiding is disabled (or nothing is hidden), keep the reveal latch off so
  // re-enabling starts collapsed.
  if (showInactive && inactiveCount === 0) setShowInactive(false);

  return (
    <aside ref={asideRef} className="relative flex h-full flex-col overflow-hidden border-r border-[var(--color-border-soft)] bg-[var(--color-bg-1)]">
      {/* Primary nav: Dashboard / History (no top chrome — that's the unified bar's job now) */}
      <nav className={cn("flex flex-col gap-0.5", compact ? "p-1.5 pt-2" : "p-2 pt-3")}>
        <NavItem icon={<LayoutGrid className={iconSize(compact)} />} label="Dashboard"
          active={currentView === "dashboard" && !activeTask} compact={compact}
          onClick={() => setView("dashboard")}
        />
        <NavItem icon={<History className={iconSize(compact)} />} label="History"
          active={currentView === "history" && !activeTask} compact={compact}
          onClick={() => setView("history")}
        />
      </nav>

      {/* Projects section */}
      <div className={cn("flex-1 overflow-y-auto min-h-0", compact ? "px-1.5 py-1.5" : "px-2 py-2")}>
        <div className={cn(
          "flex items-center justify-between text-[12px] uppercase tracking-wider text-[var(--color-fg-dim)]",
          compact ? "flex-col gap-1.5 py-1" : "px-2 py-1",
        )}>
          {!compact && <span>Projects</span>}
          <div className={cn("flex gap-0.5", compact && "flex-col")}>
            <DropdownRoot>
              <Tip content="Project list options">
                <DropdownTrigger asChild>
                  <Button size="icon" variant="icon">
                    <ChevronsUpDown className={iconSize(compact)} />
                  </Button>
                </DropdownTrigger>
              </Tip>
              {/* preventDefault on close keeps focus from snapping back to the
                  trigger, which would otherwise re-fire its (focus-triggered)
                  tooltip and leave it stuck open after selecting an item. */}
              <DropdownMenu side="right" align="start" sideOffset={4} className="w-[280px]" onCloseAutoFocus={(e) => e.preventDefault()}>
                {/* Both actions cover group folders too — expanding agents
                    under a still-collapsed folder would look like a no-op,
                    and "collapse all" means the whole tree tidies up. */}
                <DropdownItem onSelect={() => { setAllTasksCollapsed(false); setAllGroupsCollapsed(false); }}>
                  <ChevronsUpDown className="h-5 w-5 text-[var(--color-fg-dim)]" />
                  <span>Expand all agents</span>
                </DropdownItem>
                <DropdownItem onSelect={() => { setAllTasksCollapsed(true); setAllGroupsCollapsed(true); }}>
                  <ChevronsDownUp className="h-5 w-5 text-[var(--color-fg-dim)]" />
                  <span>Collapse all agents</span>
                </DropdownItem>
                <DropdownSeparator />
                <DropdownLabel>Default expand behavior</DropdownLabel>
                {([
                  ["chevron", "Chevron only", "Only the chevron toggles."],
                  ["click",   "Click name",   "Active row toggles; auto-expands at 2+."],
                  ["always",  "Auto open",    "Start expanded; chevron still collapses."],
                ] as const).map(([id, label, hint]) => {
                  const isActive = taskExpandMode === id;
                  return (
                    <DropdownItem
                      key={id}
                      onSelect={() => setTaskExpandMode(id)}
                      className={isActive
                        ? "bg-[var(--color-sel)] data-[highlighted]:bg-[var(--color-sel)]"
                        : undefined}
                    >
                      {isActive
                        ? <Check className="h-5 w-5 text-[var(--color-accent)]" />
                        : <span className="h-5 w-5 shrink-0" />}
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className={isActive ? "text-[var(--color-accent)] font-medium" : undefined}>{label}</span>
                        <span className="text-[11px] leading-snug text-[var(--color-fg-dim)]">{hint}</span>
                      </div>
                    </DropdownItem>
                  );
                })}
                <DropdownSeparator />
                <DropdownItem
                  onSelect={() => setHideInactiveProjects(!hideInactiveProjects)}
                  className={hideInactiveProjects
                    ? "bg-[var(--color-sel)] data-[highlighted]:bg-[var(--color-sel)]"
                    : undefined}
                >
                  {/* Checkmark when on, empty slot when off — same pattern as
                      the expand-mode rows above (no stray icon). */}
                  {hideInactiveProjects
                    ? <Check className="h-5 w-5 text-[var(--color-accent)]" />
                    : <span className="h-5 w-5 shrink-0" />}
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className={hideInactiveProjects ? "text-[var(--color-accent)] font-medium" : undefined}>Collapse inactive projects</span>
                    <span className="text-[11px] leading-snug text-[var(--color-fg-dim)]">Fold ungrouped projects with no agents into a row at the bottom. Grouped projects stay in their folder.</span>
                  </div>
                </DropdownItem>
              </DropdownMenu>
            </DropdownRoot>
            <Tip content="Add project (repo)"><Button size="icon" variant="icon" onClick={openNewProject}>
              <FolderPlus className={iconSize(compact)} /></Button></Tip>
          </div>
        </div>

        <div className="flex flex-col gap-0.5">
          {(() => {
          const renderProject = (p: typeof projects[number]) => {
            const taskList = tasks.filter(w => w.project_id === p.id && !w.archived);
            // Empty projects default to collapsed (no point pinning a blank
            // expanded row). User overrides stick: explicit true / false
            // wins; undefined falls back to emptiness-based default.
            const explicit = collapsedProjects[p.id];
            // Render-only fold while THIS project is being dragged: the
            // translateY rides on the header alone, so expanded task rows
            // would sit frozen in place while their header floats away.
            // Folding for the drag's duration makes the header read as
            // "picking the project up"; persisted collapse state is
            // untouched, so the rows return on drop exactly as they were.
            const collapsed = dragProjectId === p.id
              || (explicit !== undefined ? explicit : taskList.length === 0);
            // Compact + collapsed: surface aggregated activity on the
            // project monogram so a collapsed project still signals that
            // something underneath wants attention (attention > done).
            const projAttention = compact && collapsed && taskList.some(w => needsAttention(w.id));
            const projDone = compact && collapsed && !projAttention && taskList.some(w => isWorkDone(w.id));
            const isMulti = (p.type ?? "single") === "multi";
            return (
              <div
                key={p.id}
                className="rounded-md"
              >
                <ContextMenuRoot>
                <ContextMenuTrigger className="contents">
                <Tip content={compact ? p.name : ""}>
                  <div
                    // data-project-id lives on the HEADER (not the
                    // wrapper) because the wrapper includes all the
                    // nested task rows — its bounding rect can
                    // be 6× the header's height, putting the midpoint
                    // far below the visible row. Hit-testing against
                    // headers means the cursor only has to traverse
                    // a single header's height to trigger a swap,
                    // matching what the user sees.
                    data-project-id={p.id}
                    style={dragProjectId === p.id ? { transform: `translateY(${dragTy}px)`, position: "relative", zIndex: 20 } : undefined}
                    // Compact mode has no drag-to-reorder (the pointer
                    // handler below bails), so a plain click handles the
                    // collapse toggle the monogram represents.
                    onClick={compact ? () => setProjectCollapsed(p.id, !collapsed) : undefined}
                    // Project header is the drag handle. Pointer-down
                    // arms it (doesn't commit to "we're dragging" yet);
                    // a pointer-move past the threshold flips into
                    // dragging mode. Plain click → collapse toggle
                    // still fires because pointerup before threshold
                    // hits the click path normally.
                    onPointerDown={(e) => {
                      if (compact) return;
                      if (e.button !== 0) return;
                      const target = e.target as HTMLElement;
                      // Bail on interactive controls AND anything inside a
                      // portaled menu/dialog: those render to document.body but
                      // still bubble synthetic pointer events up the React tree
                      // to this header, so grabbing the `+` menu's content
                      // would otherwise start a project drag.
                      if (target.closest('button, input, a, [data-no-drag], [role="menu"], [role="dialog"]')) return;
                      dragArmed.current = {
                        id: p.id, x: e.clientX, y: e.clientY, started: false,
                        grabOffsetY: e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top,
                        appliedTy: 0, pointerY: e.clientY,
                        origGroup: groupOf(p),
                        // Fold rows are ungrouped inactive projects, so a drag
                        // that STARTS there must never rewrite the group: the
                        // change would be invisible until the fold is revealed
                        // (see the fold-domain note in onDragPointerMove).
                        fromFold: !!(e.currentTarget as HTMLElement).closest("[data-inactive-fold]"),
                      };
                      // Attach document-level listeners so drag
                      // tracking survives the dragged DOM node being
                      // reparented mid-drag (React reorders kill
                      // element-level pointer capture).
                      const onUp = (ev: PointerEvent) => {
                        const armed = dragArmed.current;
                        const wasStarted = armed?.started ?? false;
                        endDrag(true);
                        // Plain click (no drag past threshold) →
                        // toggle collapse, matching the original
                        // header onClick behavior we replaced.
                        if (armed && !wasStarted && ev.target instanceof Node) {
                          // Only fire collapse if pointerup is still
                          // over the same project header — same as a
                          // real click would behave.
                          const header = (ev.target as HTMLElement).closest('[data-project-id]') as HTMLElement | null;
                          if (header?.dataset.projectId === p.id) {
                            setProjectCollapsed(p.id, !collapsed);
                          }
                        }
                      };
                      dragListenersRef.current = { move: onDragPointerMove, up: onUp };
                      document.addEventListener("pointermove", onDragPointerMove);
                      document.addEventListener("pointerup", onUp);
                      document.addEventListener("pointercancel", onUp);
                    }}
                    className={cn(
                      "group flex items-center justify-between rounded-md text-[12px] font-semibold uppercase tracking-[0.06em] cursor-pointer transition-colors",
                      // Full mode highlights the whole row on hover; compact
                      // mode hovers the centered monogram tile instead.
                      !compact && "hover:bg-[var(--color-hover)]",
                      taskList.length === 0 ? "text-[var(--color-fg-faint)]" : "text-[var(--color-fg)]",
                      menuOpenProjectId === p.id && "bg-[var(--color-hover)]",
                      compact ? "px-0 py-0.5 justify-center" : "pl-2 pr-0 py-1.5",
                      dragProjectId === p.id && "bg-[var(--color-accent)]/15 text-[var(--color-accent)] shadow-lg",
                    )}
                  >
                    {compact ? (
                      // Compact mode: a project monogram tile (initials) —
                      // distinguishable at a glance, unlike a stack of
                      // identical chevrons. Dimmed when collapsed; carries
                      // an aggregated activity dot so collapsed projects
                      // still signal work underneath.
                      <div
                        className={cn(
                          "relative mx-auto flex h-8 w-8 items-center justify-center rounded-md text-[10.5px] font-semibold leading-none transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
                          collapsed ? "text-[var(--color-fg-faint)]" : "text-[var(--color-fg-dim)]",
                        )}
                      >
                        {projectMonogram(p.name)}
                        {(projAttention || projDone) && (
                          <span
                            className="absolute -right-0.5 -top-0.5 block h-2.5 w-2.5 rounded-full ring-2 ring-[var(--color-bg-1)]"
                            style={{ backgroundColor: projAttention ? "var(--color-warn)" : "var(--color-info)" }}
                          />
                        )}
                      </div>
                    ) : (
                      <>
                        <div className="flex min-w-0 items-center gap-1.5">
                          {collapsed
                            ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                            : <ChevronDown  className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                          }
                          {renaming && renaming.kind === "proj" && renaming.id === p.id ? (
                            <input
                              ref={renameInputRef}
                              autoFocus
                              value={renaming.value}
                              onChange={e => setRenaming({ ...renaming, value: e.target.value })}
                              onBlur={commitRename}
                              onKeyDown={e => {
                                if (e.key === "Enter") commitRename();
                                else if (e.key === "Escape") setRenaming(null);
                              }}
                              onClick={e => e.stopPropagation()}
                              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                              className="rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[13.5px] outline-none w-full"
                            />
                          ) : (
                            <span className="truncate">{p.name}</span>
                          )}
                          {/* Multi-repo marker sits AFTER the name so
                              project names stay vertically aligned
                              regardless of type (no snake-indent). */}
                          {(p.type ?? "single") === "multi" && (
                            <Tip content="Multi-repo project">
                              <Layers className="h-3 w-3 shrink-0 text-[var(--color-accent)]" />
                            </Tip>
                          )}
                        </div>
                        {/* Trio of project-row actions revealed on hover.
                            Settings + Open-repo-as-task are hover-only
                            so the row stays clean; New-task stays
                            visible because it's the headline action. */}
                        <div className="flex items-center gap-0.5">
                          <Tip content="Project settings">
                            <button
                              className={cn(
                                "rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] transition-opacity",
                                // Stay visible while the `+` dropdown is
                                // open (otherwise the gear vanishes the
                                // moment the user opens the menu).
                                menuOpenProjectId === p.id
                                  ? "opacity-100"
                                  : "opacity-0 group-hover:opacity-100",
                              )}
                              onClick={(e) => { e.stopPropagation(); useApp.getState().openSettings("repositories", p.id); }}
                            ><Cog className="h-4 w-4" /></button>
                          </Tip>
                          {/* Single `+` trigger → instant dropdown with the
                              two project-level actions. Replaces the two
                              separate icons (FolderGit2 + GitBranchPlus) we
                              used to show side by side — less visual noise
                              on the row, clearer affordance (the universal
                              "+" = "create / open something here"). */}
                          <DropdownRoot
                            onOpenChange={(o) => setMenuOpenProjectId(o ? p.id : null)}
                          >
                            <Tip content="New task for this project">
                              <DropdownTrigger asChild>
                                <button
                                  onClick={e => e.stopPropagation()}
                                  className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] data-[state=open]:bg-[var(--color-bg-3)] data-[state=open]:text-[var(--color-fg)]"
                                ><Plus className="h-4 w-4" /></button>
                              </DropdownTrigger>
                            </Tip>
                            <DropdownMenu side="right" align="start" sideOffset={4} className="w-[276px]">
                              <ProjectActionsMenuItems
                                projectId={p.id}
                                onPick={(cli, mode) => {
                                  // The inline name prompt only renders under an
                                  // expanded project, so expand first or the row
                                  // would be invisible on a collapsed one.
                                  setProjectCollapsed(p.id, false);
                                  const value = defaultTaskName(cli, taskList);
                                  setPendingRepoRoot({
                                    projectId: p.id,
                                    cli,
                                    mode,
                                    value,
                                    branch: mode === "worktree" ? derivedBranch(value, branchPrefix) : "",
                                    branchEdited: false,
                                  });
                                }}
                              />
                            </DropdownMenu>
                          </DropdownRoot>
                        </div>
                      </>
                    )}
                  </div>
                </Tip>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuLabel>{p.name}</ContextMenuLabel>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    disabled={!!p.non_git}
                    onSelect={() => requestAnimationFrame(() => openNewTask(p.id))}
                  >
                    <Plus />
                    New task
                  </ContextMenuItem>
                  {/* Broadcast to the MAIN agent of every task in this
                      project. Count = live main agents; disabled when there is
                      nothing to fan out to (0 or 1). Computed here so it only
                      runs when the menu is actually open. */}
                  {(() => {
                    const n = taskList.filter(w => (tabs[w.id] ?? []).some(
                      t => t.type === "terminal" && !!(t as TerminalTab).is_default
                        && !(t as TerminalTab).paneId && !(t as TerminalTab).runTab
                        && !!(t as TerminalTab).ptyId,
                    )).length;
                    return (
                      <ContextMenuItem
                        disabled={n <= 1}
                        onSelect={() => requestAnimationFrame(() => useUI.getState().openProjectBroadcast(p.id))}
                      >
                        <Megaphone />
                        Broadcast message ({n})
                      </ContextMenuItem>
                    );
                  })()}
                  {/* Stop every live task in this project without archiving
                      (GH #119) — the issue's original ask. */}
                  {(() => {
                    const live = taskList.filter(w => mountedTasks.has(w.id));
                    if (live.length === 0) return null;
                    return (
                      <ContextMenuItem
                        onSelect={() => {
                          const st = useApp.getState();
                          for (const w of live) st.stopTask(w.id);
                          useUI.getState().pushToast(
                            live.length === 1 ? `Stopped ${live[0].name}` : `Stopped ${live.length} tasks`,
                            "success",
                          );
                        }}
                      >
                        <CircleStop />
                        Stop all tasks ({live.length})
                      </ContextMenuItem>
                    );
                  })()}
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => openSettings("repositories", p.id)}>
                    <Cog />
                    Settings
                  </ContextMenuItem>
                  {!compact && (
                    <ContextMenuItem onSelect={() => {
                      setProjectCollapsed(p.id, false);
                      setRenaming({ kind: "proj", id: p.id, value: p.name });
                    }}>
                      <Pencil />
                      Rename
                    </ContextMenuItem>
                  )}
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Folder />
                      Move to group
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {allGroups.map(g => (
                        <ContextMenuItem
                          key={g}
                          onSelect={() => { if (g !== groupOf(p)) moveToGroup(p, g); }}
                        >
                          {groupOf(p) === g
                            ? <Check className="text-[var(--color-accent)]" />
                            : <span className="h-3.5 w-3.5 shrink-0" />}
                          <span className="truncate">{g}</span>
                        </ContextMenuItem>
                      ))}
                      {allGroups.length > 0 && <ContextMenuSeparator />}
                      <ContextMenuItem onSelect={() => createGroupWith(p)}>
                        <FolderPlus />
                        New group
                      </ContextMenuItem>
                      {!!groupOf(p) && (
                        <ContextMenuItem onSelect={() => moveToGroup(p, null)}>
                          <FolderMinus />
                          Remove from group
                        </ContextMenuItem>
                      )}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  {isMulti && (
                    <ContextMenuItem onSelect={async () => {
                      await projectUpdate({ ...p, spotlight_enabled: !p.spotlight_enabled });
                      await loadAll();
                    }}>
                      <Radio />
                      {p.spotlight_enabled ? "Disable spotlight" : "Enable spotlight"}
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem onSelect={() => openPath(p.root_path).catch(() => {})}>
                    <FolderOpen />
                    Reveal in Finder
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => copyToClipboard(p.root_path, "path")}>
                    <Copy />
                    Copy path
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem destructive onSelect={async () => {
                    const ui = useUI.getState();
                    const ok = await ui.askConfirm({
                      title: `Remove "${p.name}"?`,
                      message: "All tasks will be archived and their worktrees removed from disk. The repo folder is kept. This cannot be undone from inside Termic.",
                      confirmLabel: "Remove",
                      destructive: true,
                    });
                    const confirmed = typeof ok === "boolean" ? ok : ok.confirmed;
                    if (!confirmed) return;
                    ui.setBusy(`Removing "${p.name}"…`);
                    try {
                      await projectRemove(p.id);
                      await loadAll();
                    } finally {
                      ui.setBusy(null);
                    }
                  }}>
                    <Trash2 />
                    Remove project
                  </ContextMenuItem>
                </ContextMenuContent>
                </ContextMenuRoot>

                {/* Empty expanded project — single placeholder CTA that
                    opens the SAME dropdown as the row's `+` icon (one
                    "Open repo with <agent>" per registered agent plus a
                    New worktree action). One affordance instead of two
                    cramped side-by-side buttons that had to ellipsis at
                    narrow widths. */}
                {!collapsed && taskList.length === 0 && !compact && pendingRepoRoot?.projectId !== p.id && (
                  <div
                    className="ml-5 mr-1 mb-1 mt-0.5"
                    onClick={e => e.stopPropagation()}
                  >
                    <DropdownRoot>
                      <DropdownTrigger asChild>
                        <button
                          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] bg-transparent px-2 py-2 text-[12.5px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] data-[state=open]:border-[var(--color-accent-soft)] data-[state=open]:text-[var(--color-fg)]"
                        >
                          <Plus className="h-3.5 w-3.5 shrink-0" />
                          <span>New task</span>
                        </button>
                      </DropdownTrigger>
                      <DropdownMenu side="right" align="start" sideOffset={4} className="w-[276px]">
                        <ProjectActionsMenuItems
                                projectId={p.id}
                                onPick={(cli, mode) => {
                                  // The inline name prompt only renders under an
                                  // expanded project, so expand first or the row
                                  // would be invisible on a collapsed one.
                                  setProjectCollapsed(p.id, false);
                                  const value = defaultTaskName(cli, taskList);
                                  setPendingRepoRoot({
                                    projectId: p.id,
                                    cli,
                                    mode,
                                    value,
                                    branch: mode === "worktree" ? derivedBranch(value, branchPrefix) : "",
                                    branchEdited: false,
                                  });
                                }}
                              />
                      </DropdownMenu>
                    </DropdownRoot>
                  </div>
                )}

                {!collapsed && [...taskList].sort((a, b) =>
                  // Pure creation order, oldest first: new tasks append at the
                  // bottom. No grouping by main-checkout vs worktree. RFC3339
                  // `created` compares lexicographically = chronologically.
                  (a.created || "").localeCompare(b.created || ""),
                ).map(w => (
                  <TaskRow key={w.id} w={w} compact={compact} />
                ))}
                {/* Inline name prompt renders at the BOTTOM — that's
                    where a newly-created repo-root task lands in
                    the sort order, so the row physically appears in
                    the spot it'll occupy after Enter. */}
                {!collapsed && pendingRepoRoot?.projectId === p.id && (
                  <PendingRepoRootRow
                    mode={pendingRepoRoot.mode}
                    cli={pendingRepoRoot.cli}
                    value={pendingRepoRoot.value}
                    branch={pendingRepoRoot.branch}
                    onChange={(v) => setPendingRepoRoot(prev => {
                      if (!prev) return prev;
                      // Keep the branch in lock-step with the name until the
                      // user takes over the branch field.
                      const branch = prev.branchEdited ? prev.branch : derivedBranch(v, branchPrefix);
                      return { ...prev, value: v, branch };
                    })}
                    onBranchChange={(b) => setPendingRepoRoot(prev => prev && { ...prev, branch: b, branchEdited: true })}
                    onCancel={() => setPendingRepoRoot(null)}
                    onCommit={async () => {
                      if (inlineCreatingRef.current) return; // double-Enter guard
                      const pr = pendingRepoRoot;
                      const name = pr.value.trim();
                      // Empty name: keep the row open (don't silently cancel);
                      // the user can type or press Esc.
                      if (!name) return;
                      const ui = useUI.getState();
                      inlineCreatingRef.current = true;
                      if (pr.mode === "worktree") {
                        // Close the inline row and show the SAME progress UI the
                        // New Task modal shows on submit (worktree add + copy can
                        // take seconds; errors surface there too).
                        setPendingRepoRoot(null);
                        ui.setTaskCreateProgress({ phase: "creating", err: null });
                        try {
                          await createQuickTask({
                            projectId: pr.projectId, mode: "worktree", cli: pr.cli,
                            name, branch: pr.branch.trim(),
                          });
                          ui.setTaskCreateProgress(null); // success closes the overlay
                        } catch (err) {
                          ui.setTaskCreateProgress({ phase: "error", err: String(err) });
                        } finally {
                          inlineCreatingRef.current = false;
                        }
                      } else {
                        // Main checkout is instant. On failure, toast and KEEP the
                        // row open so the user can fix the name and retry.
                        try {
                          await createQuickTask({ projectId: pr.projectId, mode: "repo_root", cli: pr.cli, name });
                          setPendingRepoRoot(null);
                        } catch (err) {
                          ui.pushToast(String(err), "error");
                        } finally {
                          inlineCreatingRef.current = false;
                        }
                      }
                    }}
                  />
                )}
              </div>
            );
          };
          // Collapsible group folder wrapping its member projects. Groups
          // are pure UI (a label on Project) — this renders the header +
          // indented members, with collapse state keyed by group NAME.
          const renderGroup = (name: string, members: typeof projects) => {
            // Object.hasOwn: the record round-trips through JSON.parse, so a
            // group named "toString"/"constructor" would otherwise read an
            // inherited function off the prototype and render collapsed.
            const collapsed = Object.hasOwn(collapsedGroups, name)
              ? collapsedGroups[name] === true
              : false;
            // Count ALL members (hidden inactive ones included) — the header
            // count is also what Rename/Ungroup operate on, so it must not
            // understate the group while "Hide inactive projects" is on.
            const totalCount = projects.filter(x => groupOf(x) === name).length;
            // Aggregated activity for a collapsed folder (attention > done)
            // so hidden members can still call for the user — same signal
            // the compact project monogram carries.
            const memberIds = new Set(members.map(m => m.id));
            const grpWs = collapsed
              ? tasks.filter(w => memberIds.has(w.project_id) && !w.archived)
              : [];
            const grpAttention = collapsed && grpWs.some(w => needsAttention(w.id));
            const grpDone = collapsed && !grpAttention && grpWs.some(w => isWorkDone(w.id));
            // User-assigned accent (Object.hasOwn: JSON-parsed record, see
            // `collapsed` above). Unknown keys resolve to undefined = default.
            const accent = groupColorCss(
              Object.hasOwn(groupColors, name) ? groupColors[name] : undefined,
            );
            if (compact) {
              // Compact rail: a chevron-only divider row (no room for a
              // label — the tooltip carries name + count). Members render
              // as regular monogram tiles below, hidden when collapsed.
              return (
                <div key={`group:${name}`}>
                  <Tip content={`${name} (${totalCount})`}>
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      onClick={() => setGroupCollapsed(name, !collapsed)}
                      // Inline color deliberately beats the hover class — a
                      // colored folder stays its color under the cursor.
                      style={accent ? { color: accent } : undefined}
                      className="relative mx-auto flex h-6 w-8 items-center justify-center rounded-md text-[var(--color-fg-faint)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
                    >
                      {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      {(grpAttention || grpDone) && (
                        <span
                          className="absolute -right-0.5 -top-0.5 block h-2 w-2 rounded-full ring-2 ring-[var(--color-bg-1)]"
                          style={{ backgroundColor: grpAttention ? "var(--color-warn)" : "var(--color-info)" }}
                        />
                      )}
                    </button>
                  </Tip>
                  {!collapsed && members.map(renderProject)}
                </div>
              );
            }
            const isGroupRenaming = renaming?.kind === "group" && renaming.id === name;
            return (
              <div
                key={`group:${name}`}
                data-group-section={name}
                style={dragGroupName === name ? { transform: `translateY(${dragGroupTy}px)`, position: "relative", zIndex: 20 } : undefined}
              >
                <ContextMenuRoot>
                  <ContextMenuTrigger className="contents">
                    <div
                      data-group-name={name}
                      role="button"
                      tabIndex={0}
                      aria-expanded={!collapsed}
                      // The rename input's blur (→ commitRename → renaming
                      // cleared) fires between pointerdown and click, so a
                      // click that merely dismisses the input would ALSO
                      // toggle collapse if we checked state in onClick.
                      // Capture "was renaming" at pointerdown instead.
                      // The header doubles as the folder's DRAG HANDLE —
                      // same arm-on-pointerdown / start-past-threshold
                      // pattern as project rows, so a plain click still
                      // toggles collapse.
                      onPointerDown={(ev) => {
                        if (ev.button !== 0) return;
                        suppressGroupToggle.current = isGroupRenaming;
                        if (isGroupRenaming) return;
                        const target = ev.target as HTMLElement;
                        if (target.closest("button, input, a, [data-no-drag]")) return;
                        const section = (ev.currentTarget as HTMLElement).closest("[data-group-section]");
                        if (!section) return;
                        groupDragArmed.current = {
                          name, x: ev.clientX, y: ev.clientY, started: false,
                          grabOffsetY: ev.clientY - section.getBoundingClientRect().top,
                          appliedTy: 0, pointerY: ev.clientY,
                        };
                        const onUp = () => {
                          const wasStarted = groupDragArmed.current?.started ?? false;
                          endGroupDrag(true);
                          if (wasStarted) {
                            // The click that follows pointerup must not
                            // collapse the folder that was just dragged.
                            // Reset on a macrotask in case no click fires
                            // (pointerup landed off the header).
                            suppressGroupToggle.current = true;
                            setTimeout(() => { suppressGroupToggle.current = false; }, 0);
                          }
                        };
                        groupDragListenersRef.current = { move: onGroupDragPointerMove, up: onUp };
                        document.addEventListener("pointermove", onGroupDragPointerMove);
                        document.addEventListener("pointerup", onUp);
                        document.addEventListener("pointercancel", onUp);
                      }}
                      onClick={() => {
                        if (suppressGroupToggle.current) { suppressGroupToggle.current = false; return; }
                        setGroupCollapsed(name, !collapsed);
                      }}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          setGroupCollapsed(name, !collapsed);
                        }
                      }}
                      // Accent yields to the drag/drop states below — their
                      // classes lose to an inline style, so skip it while
                      // this header is a drop target or being dragged.
                      style={accent && dragOverGroup !== name && dragGroupName !== name
                        ? { color: accent }
                        : undefined}
                      className={cn(
                        // Same size/weight as project rows (an 11.5px header
                        // read weaker than its members), but the DEFAULT
                        // color is the muted fg-faint of inactive projects —
                        // folders are structure, not content, and only an
                        // assigned accent should make one loud. Matches the
                        // Default swatch in the color picker.
                        "flex cursor-pointer items-center gap-1.5 rounded-md py-1 pl-2 pr-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg-faint)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
                        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]",
                        // Drop target while a project drag hovers this header.
                        dragOverGroup === name && "bg-[var(--color-accent)]/15 text-[var(--color-accent)] ring-1 ring-inset ring-[var(--color-accent)]",
                        // The folder itself is being dragged.
                        dragGroupName === name && "bg-[var(--color-accent)]/15 text-[var(--color-accent)] shadow-lg",
                      )}
                    >
                      {collapsed
                        ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                        : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />}
                      {/* No own color class when accented — inherits the
                          header's currentColor so glyph + name match. */}
                      <Folder className={cn("h-3.5 w-3.5 shrink-0", !accent && "text-[var(--color-fg-faint)]")} />
                      {renaming?.kind === "group" && renaming.id === name ? (
                        <input
                          ref={renameInputRef}
                          autoFocus
                          value={renaming.value}
                          // Group names are ALL-CAPS at the data layer (they
                          // key collapse/color state and must render the same
                          // everywhere), so uppercase as typed — covers paste
                          // too, since it runs on the resulting value.
                          onChange={e => setRenaming({ ...renaming, value: e.target.value.toUpperCase() })}
                          onBlur={commitRename}
                          onKeyDown={e => {
                            if (e.key === "Enter") commitRename();
                            else if (e.key === "Escape") setRenaming(null);
                            // Don't leak Enter/Space to the header's own
                            // keydown toggle.
                            e.stopPropagation();
                          }}
                          onClick={e => e.stopPropagation()}
                          onPointerDown={e => e.stopPropagation()}
                          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                          className="w-full min-w-0 flex-1 rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[12px] normal-case tracking-normal outline-none"
                        />
                      ) : (
                        <span className="truncate">{name}</span>
                      )}
                      {(grpAttention || grpDone) && (
                        <span
                          className="block h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: grpAttention ? "var(--color-warn)" : "var(--color-info)" }}
                        />
                      )}
                      {!isGroupRenaming && (
                        <span className="ml-auto shrink-0 tabular-nums text-[11px] text-[var(--color-fg-faint)]">{totalCount}</span>
                      )}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuLabel>{name}</ContextMenuLabel>
                    {/* Finder-tag-style inline swatch row — no submenu to
                        aim through, the dots ARE the menu entry. Label-less
                        by design (a "Red" label would lie if a theme ever
                        re-tunes the hue); names survive as aria-labels.
                        Default leads as a fg-faint swatch — the muted tint
                        an uncolored folder actually renders with — and the
                        active pick carries a ring. */}
                    <div className="flex items-center gap-0.5 px-1 pb-1">
                      <ContextMenuItem
                        aria-label="Default"
                        checked={!accent}
                        onSelect={() => setGroupColor(name, null)}
                        className="rounded-full p-1"
                      >
                        <span
                          className={cn(
                            "block h-4 w-4 rounded-full",
                            !accent && "ring-1 ring-[var(--color-fg)] ring-offset-1 ring-offset-[var(--color-bg-1)]",
                          )}
                          style={{ backgroundColor: "var(--color-fg-faint)" }}
                        />
                      </ContextMenuItem>
                      {GROUP_COLORS.map(c => (
                        <ContextMenuItem
                          key={c.key}
                          aria-label={c.label}
                          checked={accent === c.css}
                          onSelect={() => setGroupColor(name, c.key)}
                          className="rounded-full p-1"
                        >
                          <span
                            className={cn(
                              "block h-4 w-4 rounded-full",
                              accent === c.css && "ring-1 ring-[var(--color-fg)] ring-offset-1 ring-offset-[var(--color-bg-1)]",
                            )}
                            style={{ backgroundColor: c.css }}
                          />
                        </ContextMenuItem>
                      ))}
                    </div>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => setRenaming({ kind: "group", id: name, value: name })}>
                      <Pencil />
                      Rename group
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => dissolveGroup(name)}>
                      <FolderMinus />
                      Ungroup projects
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenuRoot>
                {/* Indented members with a tree guide line — reads as
                    "inside the folder" without stealing much width. */}
                {!collapsed && (
                  <div
                    // Tint the guide line toward the group's accent so a
                    // long member list stays attributable mid-scroll. If
                    // color-mix is unavailable the invalid value is dropped
                    // and the class's border color applies.
                    style={accent ? { borderColor: `color-mix(in srgb, ${accent} 45%, transparent)` } : undefined}
                    className="ml-[13px] flex flex-col gap-0.5 border-l border-[var(--color-border-soft)] pl-1"
                  >
                    {members.map(renderProject)}
                  </div>
                )}
              </div>
            );
          };
          // Section the inline-shown projects (shownInline: active, plus ANY
          // grouped project since folders never fold). Ungrouped active
          // projects render in place; a group renders as one folder at its
          // FIRST member's position with all its members. Only ungrouped
          // inactive projects drop to the flat fold below. Keyboard nav
          // (useShortcuts) walks the same visualProjectOrder.
          const sections = projectSections(activeProjects);
          return (
            <>
              {/* Active projects render in place (original order). */}
              {sections.map(s => s.kind === "loose" ? renderProject(s.p) : renderGroup(s.name, s.members))}
              {/* "INACTIVE PROJECTS" section header — same type treatment as
                  the PROJECTS header above. Clicking it toggles the fold; the
                  inactive group renders BELOW it so revealing never reshuffles
                  the active rows. */}
              {hideInactiveProjects && inactiveCount > 0 && (
                <button
                  key="inactive-header"
                  type="button"
                  onClick={() => setShowInactive(v => !v)}
                  title={compact ? `${inactiveCount} inactive ${inactiveCount === 1 ? "project" : "projects"}` : undefined}
                  className={cn(
                    "flex items-center text-[12px] uppercase tracking-wider text-[var(--color-fg-dim)] hover:text-[var(--color-fg)] transition-colors",
                    compact ? "flex-col gap-1 py-1" : "justify-between px-2 py-1 mt-1",
                  )}
                >
                  {compact ? (
                    <>
                      {showInactive
                        ? <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                        : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                      <span className="tabular-nums normal-case">{inactiveCount}</span>
                    </>
                  ) : (
                    <>
                      <span className="flex items-center gap-1">
                        {showInactive
                          ? <ChevronDown className="h-3 w-3 shrink-0" />
                          : <ChevronRight className="h-3 w-3 shrink-0" />}
                        Inactive Projects
                      </span>
                      <span className="tabular-nums">{inactiveCount}</span>
                    </>
                  )}
                </button>
              )}
              {/* data-inactive-fold marks this as a separate drag domain:
                  rows here are ungrouped inactive projects, so drags across
                  the fold reorder only and never touch group labels. */}
              {hideInactiveProjects && showInactive && (
                <div data-inactive-fold className="flex flex-col gap-0.5">
                  {inactiveProjects.map(renderProject)}
                </div>
              )}
            </>
          );
          })()}
        </div>
      </div>

      {/* UpdateCard floats absolutely at the bottom-left of the sidebar,
          stacked above project rows and the footer so it remains visible
          regardless of scroll position. Renders nothing in compact mode
          or when there's no pending update / unseen release. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[var(--bottom-bar-h)] z-20">
        <div className="pointer-events-auto">
          <UpdateCard />
        </div>
      </div>

      <div>
        {/* Footer */}
        <div className={cn(
          "flex border-t border-[var(--color-border-soft)] gap-1",
          // --bottom-bar-h (expanded) is the shared height for every bottom
          // bar. Compact mode stays a vertical icon stack with its own padding.
          compact ? "flex-col items-center p-2" : "items-center h-[var(--bottom-bar-h)] px-2",
        )}>
          {/* Left cluster (full mode): support — bug + contact. The bug
              button opens a prefilled GitHub issue (public tracker, better
              than email for triage + dedupe); Contact stays a mailto: that
              opens the user's default mail client. Compact mode is
              flex-col, so left/right ordering collapses into a top/bottom
              stack. */}
          <Tip content="Report a bug">
            <Button size="icon" variant="icon" onClick={() =>
              openIssue("Bug: ", "What happened:\n\n\nSteps to reproduce:\n\n\nTermic version: ")
            }>
              <Bug className={iconSize(compact)} />
            </Button>
          </Tip>
          <Tip content="Contact">
            <Button size="icon" variant="icon" onClick={() =>
              openMailto("contact@termic.dev", "Hello from Termic", "")
            }>
              <Mail className={iconSize(compact)} />
            </Button>
          </Tip>
          <Tip content="Keyboard shortcuts">
            <Button size="icon" variant="icon" onClick={() => useUI.getState().openShortcutsHelp()}>
              <Keyboard className={iconSize(compact)} />
            </Button>
          </Tip>
          {/* Right cluster: Add project, then Settings rightmost.
              Settings sits at the absolute edge so the gear is exactly
              where users reflexively reach for it (same position as
              macOS preferences in most apps). +project sits just inside
              it. ml-auto on the first right-cluster item pushes both. */}
          <Tip content="Add project"><Button size="icon" variant="icon" className={compact ? undefined : "ml-auto"} onClick={openNewProject}>
            <FolderPlus className={iconSize(compact)} />
          </Button></Tip>
          <Tip content="Settings (⌘,)"><Button size="icon" variant="icon" onClick={() => openSettings()}>
            <Settings className={iconSize(compact)} />
          </Button></Tip>
        </div>
      </div>

      {/* Drag handle on the sidebar's right edge — disabled in compact mode
          (compact has a fixed 56px width that's the whole point of the mode). */}
      {!compact && (
        <ResizeHandle
          direction="x"
          className="right-0"
          onDrag={(dx) => {
            // Read the CURRENTLY RENDERED width via DOM measurement, not
            // the stored preferred — when the window is narrow the clamp
            // in App.tsx caps the visual width below preferred, and
            // dragging from the preferred would feel disconnected.
            // Measuring from the actual element keeps the drag responsive.
            // The user's new value becomes the preferred (their ceiling
            // until the next manual drag).
            const cur = asideRef.current?.getBoundingClientRect().width
              ?? useApp.getState().sidebarWidth;
            const next = Math.round(Math.max(160, Math.min(800, cur + dx)));
            useApp.getState().setSidebarWidth(next);
          }}
        />
      )}
    </aside>
  );
}

/** Tailwind size class for sidebar icons, beefier in compact mode where the
 *  56px column has the budget for it (and the icons need to be readable
 *  without text labels). */
/** Two-character monogram for the compact-rail project tile — just the
 *  first two letters of the name (`termic` → TE, `my-app` → MY). The
 *  tooltip still carries the full name. */
function projectMonogram(name: string): string {
  const cleaned = name.trim();
  return cleaned ? cleaned.slice(0, 2).toUpperCase() : "?";
}

function iconSize(compact: boolean) {
  // Bumped one step in both modes. h-4 (16px) felt undersized next to
  // 14px body text; h-[18px] reads as deliberate without taking over.
  // Compact mode jumps to h-6 (24px) — icon-only mode benefits more from
  // the size since there's no label crutch.
  return compact ? "h-6 w-6" : "h-[18px] w-[18px]";
}

// Tiny status badge reused on both the task header (aggregated, when
// collapsed) and on each tab child row.
//   done      → solid blue bullet (work finished, untouched until input)
//   attention → orange bell (agent explicitly blocked on user)
// The "working" spinner is opt-in (Settings → General → Work-in-progress
// indicator) and OFF by default — it can misfire on noisy TUIs (Claude
// Code's continuous redraws, Codex's status counter). The internal
// workState=="working" is always tracked so the done detector fires on
// busy→idle transitions; this badge just surfaces it when enabled.
function TabBadge({ reason }: { reason: "attention" | "done" | "working" }) {
  if (reason === "working") {
    return (
      <span className="shrink-0 text-[var(--color-fg-faint)]" title="Agent working" aria-label="Working">
        <Loader2 className="h-3 w-3 animate-spin" />
      </span>
    );
  }
  if (reason === "attention") {
    return (
      <span className="shrink-0 text-[var(--color-warn)]" title="Agent needs your input">
        <Bell className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  // done — solid blue bullet, iTerm2-style, in --color-info (defined in
  // @theme; themes can override). h-3.5 visually matches the bell + spinner.
  return (
    <span
      className="shrink-0 flex items-center justify-center"
      title="Agent finished a turn"
      aria-label="Work done"
    >
      <span
        className="block h-2 w-2 rounded-full"
        style={{ backgroundColor: "var(--color-info)" }}
      />
    </span>
  );
}

// ─── TaskRow ────────────────────────────────────────────────────────────
// Extracted component so each task subscribes only to its own tab state
// (isolated re-renders). Handles expand/collapse, task rename, tab rename, and
// shows all terminal tabs as indented children.

function TaskRow({ w, compact }: { w: Task; compact: boolean }) {
  const tabs = useTaskTabs(w.id);
  const activeTabId = useActiveTabId(w.id);
  const activeTaskId = useApp(s => s.activeTaskId);
  const setActive = useApp(s => s.setActiveTask);
  const setActiveTabId = useApp(s => s.setActiveTabId);
  const loadAll = useApp(s => s.loadAll);
  const terminalTabCount = useApp(s => (s.tabs[w.id] ?? []).filter(t => t.type === "terminal").length);
  const agents = useApp(s => s.agents);
  const expandMode = usePrefs(s => s.taskExpandMode);
  // Default collapsed state varies with the user's chosen expand mode.
  // The user can still override per-row via the chevron — once they
  // explicitly toggle, `collapsedTasks[w.id]` holds and the mode
  // default is ignored for that task.
  //   chevron → start collapsed; row click never toggles.
  //   click   → legacy behavior: collapsed when ≤1 tab, auto-expanded at 2+.
  //   always  → start expanded; chevron-collapsed sticks.
  const defaultCollapsed =
    expandMode === "always"  ? false :
    expandMode === "chevron" ? true  :
    /* click */                terminalTabCount <= 1;
  const collapsed = useApp(s => s.collapsedTasks[w.id] ?? defaultCollapsed);
  const setTaskCollapsed = useApp(s => s.setTaskCollapsed);
  const setTaskYolo = useApp(s => s.setTaskYolo);
  const ensureDefaultTab = useApp(s => s.ensureDefaultTab);
  const renameTab = useApp(s => s.renameTab);
  const clearTabCustomTitle = useApp(s => s.clearTabCustomTitle);
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);

  const project = useApp(s => s.projects.find(p => p.id === w.project_id) ?? null);
  const spotlightTaskId = useApp(s => s.spotlightTaskId[w.project_id] ?? null);
  const isSpotlighted = spotlightTaskId === w.id;
  // Spotlight is worktree-only: non-repo-root, single-repo, git, spotlight_enabled.
  const spotlightAvailable = !w.is_main_checkout && !!project?.spotlight_enabled && project?.type !== "multi" && !project?.non_git;

  const isActive = activeTaskId === w.id;
  // Live this session = mounted (its TaskView is rendered and owns PTYs).
  // Gates the Stop menu item; a never-visited or already-stopped task has
  // nothing to stop.
  const isMounted = useApp(s => s.mountedTasks.has(w.id));
  const stopTask = useApp(s => s.stopTask);
  // Sidebar only shows main-pane terminal tabs; split-pane tabs live in SplitView.
  const terminalTabs = tabs.filter((t): t is TerminalTab => t.type === "terminal" && !t.paneId);
  const isLoaded = terminalTabs.some(t => t.ptyId);
  // The sidebar only renders terminal tabs as child rows; edit/diff tabs
  // are transient file views with no row. When the active tab is one of
  // those (or there's no active tab), no child row carries the selection,
  // so the task HEADER must show it instead.
  const activeTabIsTerminalChild = terminalTabs.some(
    t => t.id === activeTabId,
  );

  // Task actions menu — controlled so a right-click on the row can
  // open the same menu the kebab button triggers.
  const [menuOpen, setMenuOpen] = useState(false);
  // Task rename
  const [taskRenaming, setTaskRenaming] = useState<string | null>(null);
  const taskRenameInputRef = useRef<HTMLInputElement | null>(null);
  // External rename trigger (⇧⌘P command palette → "Rename task"). The
  // palette can't reach into this row's local state, so it bumps a nonce on
  // the UI store; we start the inline rename when it targets us, then clear
  // it so a later collapse/expand re-mount doesn't re-fire. The palette
  // expands the row's project first, so by the time we mount this runs.
  const renameReq = useUI(s => s.renameRequest);
  useEffect(() => {
    if (renameReq && renameReq.taskId === w.id) {
      setTaskRenaming(w.name);
      useUI.setState({ renameRequest: null });
    }
  }, [renameReq?.nonce, w.id, w.name]);
  // Radix DropdownMenu closes AFTER onSelect fires and asynchronously
  // restores focus; autoFocus on the freshly-mounted input loses the race.
  // Re-focus on the next two frames to land after Radix's restore tick.
  useEffect(() => {
    if (taskRenaming === null) return;
    let cancelled = false;
    const r1 = requestAnimationFrame(() => {
      const r2 = requestAnimationFrame(() => {
        if (cancelled) return;
        const el = taskRenameInputRef.current;
        if (el && document.activeElement !== el) {
          el.focus();
          el.select();
        }
      });
      if (cancelled) cancelAnimationFrame(r2);
    });
    return () => { cancelled = true; cancelAnimationFrame(r1); };
  }, [taskRenaming !== null]);
  // Tab rename — per-tab id + draft value
  const [tabRenaming, setTabRenaming] = useState<{ id: string; value: string } | null>(null);

  // Auto-expand rules per mode:
  //   "click"  — auto-expand 1→2+ (legacy behavior).
  //   "always" — on wake (0→1+), clear any prior chevron-collapse so
  //              the mode default (expanded) wins again. Users who
  //              collapse a task and then put it to sleep
  //              shouldn't return to a still-collapsed row when they
  //              wake the agent — that contradicts "Auto open".
  //   "chevron"— never auto-expand (the whole point: predictability).
  // Auto-collapse on going to 0 stays in all modes — an empty
  // task has nothing to expand.
  const prevCountRef = useRef(terminalTabCount);
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = terminalTabCount;
    if (expandMode === "click" && prev <= 1 && terminalTabCount >= 2) {
      setTaskCollapsed(w.id, false);
    } else if (expandMode === "always" && prev === 0 && terminalTabCount > 0) {
      setTaskCollapsed(w.id, false);
    } else if (prev > 0 && terminalTabCount === 0) {
      setTaskCollapsed(w.id, true);
    }
  }, [terminalTabCount, w.id, setTaskCollapsed, expandMode]);

  // Aggregated work status shown on the row header when collapsed.
  // Priority: attention > done. ("working" intentionally not surfaced.)
  const hasAttention = settledHighlight && tabs.some(t => t.unread?.reason === "attention");
  const hasDone = settledHighlight && !hasAttention
    && tabs.some(t => t.type === "terminal" && t.workState === "done");
  // Working aggregate is independent of settledHighlight (it's its own
  // opt-in pref) but yields to attention/done — a finished or blocked agent
  // is more actionable than one still chugging.
  const hasWorking = workingIndicator && !hasAttention && !hasDone
    && tabs.some(t => t.type === "terminal" && t.workState === "working");

  async function commitTaskRename() {
    if (taskRenaming === null) return;
    const trimmed = taskRenaming.trim();
    setTaskRenaming(null);
    // Empty → reset to the branch name (clears any custom label).
    const next = trimmed || w.branch;
    if (next === w.name) return;
    try { await taskRename(w.id, next); await loadAll(); }
    catch (e) { console.error("rename failed", e); }
  }

  function commitTabRename() {
    if (!tabRenaming) return;
    const trimmed = tabRenaming.value.trim();
    if (trimmed) renameTab(w.id, tabRenaming.id, trimmed);
    else clearTabCustomTitle(w.id, tabRenaming.id);
    setTabRenaming(null);
  }

  // Compact mode: render a minimal icon-only row (no tree, no children).
  if (compact) {
    return (
      <Tip content={w.name} side="right">
        <div
          onClick={() => setActive(w.id)}
          className={cn(
            "relative mx-auto flex h-8 w-8 items-center justify-center rounded-md cursor-pointer transition-colors",
            isActive
              ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
              : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
            !isLoaded && "opacity-60",
          )}
        >
          <CliIcon cli={w.cli} className="h-4 w-4" />
          {/* Activity dot in the corner — the compact rail has no room
              for the full bell/check badge, so color carries meaning:
              warm = needs you, blue = work done. The ring lifts it off
              the icon regardless of the tile's background. */}
          {(hasAttention || hasDone) ? (
            <span
              className="absolute -right-0.5 -top-0.5 block h-2.5 w-2.5 rounded-full ring-2 ring-[var(--color-bg-1)]"
              style={{ backgroundColor: hasAttention ? "var(--color-warn)" : "var(--color-info)" }}
            />
          ) : hasWorking ? (
            // No room for a full spinner on the rail; a faint pulsing dot
            // carries "still working" without competing with the bold
            // attention/done colors.
            <span className="absolute -right-0.5 -top-0.5 block h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--color-fg-faint)] ring-2 ring-[var(--color-bg-1)]" />
          ) : null}
        </div>
      </Tip>
    );
  }

  return (
    <div className="mb-px">
      {/* Task header row */}
      <div
        onClick={() => {
          setActive(w.id);
          if (terminalTabs.length === 0) {
            // No terminals yet — wake the task through the store's
            // restore/seed path. MUST be ensureDefaultTab, not an inline
            // addTab: the durable agent tabs (persisted_tabs) are keyed by
            // tab id, so minting a fresh id here would orphan every stored
            // session and break auto-resume (it also no-ops ensureDefaultTab
            // in TaskView, which mounts after this click).
            ensureDefaultTab(w.id, w.cli || "claude");
          } else {
            if (activeTabId) setActiveTabId(w.id, activeTabId);
            // Only the "click" mode treats a row click on the already
            // active task as a collapse toggle. The other modes
            // require the explicit chevron, which removed the "random
            // expand" feel users complained about.
            if (isActive && expandMode === "click") setTaskCollapsed(w.id, !collapsed);
          }
        }}
        // Right-click anywhere on the row opens the same actions menu as
        // the kebab button (which it anchors to).
        onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true); }}
        className={cn(
          "group/wsrow ml-3 flex items-center gap-1 rounded-md px-1 py-1 text-[13px] cursor-pointer select-none transition-colors",
          // Strong selection on the header when active AND no child row
          // carries it: collapsed (children hidden) OR the active tab is an
          // edit/diff view (no row). Expanded with an active terminal tab
          // delegates the highlight to that child row instead.
          isActive && (collapsed || !activeTabIsTerminalChild)
            ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
            : isActive
            ? "text-[var(--color-fg)] hover:bg-[var(--color-hover)]"
            : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
          !isLoaded && "opacity-60",
        )}
      >
        {terminalTabs.length === 0
          ? <Moon className="shrink-0 h-3.5 w-3.5 mx-0.5 text-[var(--color-fg-faint)] opacity-40" />
          : <button
              onClick={(e) => { e.stopPropagation(); setTaskCollapsed(w.id, !collapsed); }}
              className="shrink-0 rounded p-0.5 hover:bg-[var(--color-bg-3)] transition-colors"
              data-no-drag
            >
              {collapsed
                ? <ChevronRight className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
                : <ChevronDown  className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
              }
            </button>
        }

        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {taskRenaming !== null ? (
            <input
              ref={taskRenameInputRef}
              autoFocus
              value={taskRenaming}
              onChange={e => setTaskRenaming(e.target.value)}
              onBlur={commitTaskRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTaskRename();
                else if (e.key === "Escape") setTaskRenaming(null);
                e.stopPropagation();
              }}
              onClick={e => e.stopPropagation()}
              onDoubleClick={e => e.stopPropagation()}
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              className="min-w-0 flex-1 rounded border-0 bg-[var(--color-bg-2)] px-1 py-[3px] text-[13px] text-[var(--color-fg)] outline-none ring-1 ring-inset ring-[var(--color-accent)]"
            />
          ) : (
            <>
              <span className="min-w-0 truncate font-medium">{w.name}</span>
              <TaskLocationIcon isMainCheckout={w.is_main_checkout} size="h-3.5 w-3.5" />
            </>
          )}
          {/* Spotlight active indicator: just the animated wave icon.
              No branch text — avoids any truncation of the task name. */}
          {!taskRenaming && isSpotlighted ? (
            <Tip content={`Spotlight: changes are synced with ${project?.base_branch?.replace(/^[^/]+\//, "") ?? "main"}`} delay={0}>
              <AudioWaveform className="termic-spotlight-wave h-3 w-3 shrink-0 text-[var(--color-accent)]" />
            </Tip>
          ) : (
            /* Terminal count — only shown when >1. Was fg-faint which
               vanished on warm-dark surfaces; bump to fg-dim + tabular
               nums so the digit stays legible at small sizes. */
            !taskRenaming && terminalTabs.length > 1 && (
              <span className="shrink-0 text-[11px] font-medium tabular-nums text-[var(--color-fg-dim)]">
                ({terminalTabs.length})
              </span>
            )
          )}
        </div>

        {/* Trailing slot: status badge by default, single kebab (⋮)
            menu dropdown on hover. Replaces the prior archive + shield
            pair — a single icon hosts Sandbox + Archive in a Radix
            DropdownMenu. Instant hover swap (no 2s delay): the kebab is
            unobtrusive enough that revealing it immediately doesn't
            crowd the row. The badge only renders when collapsed
            (expanded rows put per-tab badges on their children). */}
        <span className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center">
          {collapsed && (hasAttention || hasDone || hasWorking) && (
            <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover/wsrow:opacity-0">
              {hasAttention ? <TabBadge reason="attention" /> : hasDone ? <TabBadge reason="done" /> : <TabBadge reason="working" />}
            </span>
          )}
          <DropdownRoot open={menuOpen} onOpenChange={setMenuOpen}>
            <Tip content="Task menu">
            <DropdownTrigger asChild>
              <button
                data-no-drag
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "absolute inset-0 flex items-center justify-center rounded hover:bg-[var(--color-bg-3)]",
                  // A persistent badge (sandbox on OR dangerous YOLO) keeps
                  // the button visible; unless the collapsed attention/done
                  // badge is active — it lives in the same slot and the
                  // status icon would cover it.
                  (w.sandbox_enabled || (!!w.yolo && !isSandboxEnforced(effectiveSandboxMode(w)))) && !(collapsed && (hasAttention || hasDone || hasWorking))
                    ? "opacity-100 pointer-events-auto"
                    : "opacity-0 group-hover/wsrow:opacity-100 pointer-events-none group-hover/wsrow:pointer-events-auto",
                  taskRenaming !== null && "pointer-events-none",
                )}
              >
                {/* Idle badge, hidden on row hover so the cog shows through.
                    Precedence: dangerous YOLO (red, no cage) → sandbox mode.
                    Running state is shown via OPACITY (dim when idle, solid
                    when an agent is running), so the icon's FILL is free to
                    encode the MODE — full enforce = filled shield, FS-only /
                    monitor = outline. That keeps the two enforce modes
                    distinguishable even when no agent is running. */}
                {(() => {
                  const wMode = effectiveSandboxMode(w);
                  const stateOpacity = terminalTabs.length > 0 ? "opacity-100" : "opacity-40";
                  if (!!w.yolo && !isSandboxEnforced(wMode)) {
                    return (
                      <Zap
                        className={cn("absolute h-3.5 w-3.5 text-[var(--color-err)] transition-opacity group-hover/wsrow:opacity-0", stateOpacity)}
                        fill="currentColor"
                      />
                    );
                  }
                  if (wMode !== "off") {
                    return (
                      <SandboxIcon
                        mode={wMode}
                        className={cn("absolute h-3.5 w-3.5 transition-opacity group-hover/wsrow:opacity-0", stateOpacity)}
                      />
                    );
                  }
                  return null;
                })()}
                {/* Kebab: always visible on hover (badge or not). A
                    "⋮" menu affordance, distinct from the project-level
                    Settings cog above so the two don't read as the same
                    action. */}
                <MoreVertical
                  className={cn(
                    "h-3.5 w-3.5 text-[var(--color-fg-faint)] transition-opacity",
                    (w.sandbox_enabled || (!!w.yolo && !isSandboxEnforced(effectiveSandboxMode(w)))) && "opacity-0 group-hover/wsrow:opacity-100",
                  )}
                />
              </button>
            </DropdownTrigger>
            </Tip>
            <DropdownMenu
              side="right"
              align="start"
              // Don't return focus to the trigger on close — the user
              // walks away from the cog after picking an item; leaving
              // the trigger highlighted with a focus ring is just noise.
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              {spotlightAvailable && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={async () => {
                    if (isSpotlighted) {
                      try { await stopSpotlight(w.id); }
                      catch (e) { useUI.getState().pushToast(String(e), "error"); }
                    } else {
                      try {
                        await startSpotlight(w.project_id, w.id);
                        setActive(w.id);
                      } catch (e) { useUI.getState().pushToast(String(e), "error"); }
                    }
                  }}
                >
                  <AudioWaveform className={cn("h-4 w-4", isSpotlighted && "text-[var(--color-accent)]")} />
                  <span>{isSpotlighted ? "Stop spotlight" : "Start spotlight"}</span>
                </DropdownItem>
              )}
              <DropdownItem
                // items-center + no top-nudge: these rows are single-line
                // so the default two-line layout offsets the icon visually.
                className="items-center [&>svg]:mt-0"
                onSelect={() => useUI.getState().openSandbox(w.id)}
              >
                <SandboxIcon mode={effectiveSandboxMode(w)} className="h-4 w-4" />
                <span>{effectiveSandboxMode(w) === "off" ? "Sandbox settings" : SANDBOX_VISUALS[effectiveSandboxMode(w)].shortLabel}</span>
              </DropdownItem>
              {/* Per-task YOLO toggle. Disabled (auto-on) under
                  Enforcing — the seatbelt is the boundary there. Red when
                  on without a cage (dangerous). */}
              <DropdownItem
                className="items-center [&>svg]:mt-0"
                disabled={isSandboxEnforced(effectiveSandboxMode(w))}
                onSelect={() => {
                  if (isSandboxEnforced(effectiveSandboxMode(w))) return;
                  const next = !w.yolo;
                  setTaskYolo(w.id, next);
                  void taskSetYolo(w.id, next);
                }}
              >
                <Zap
                  className={cn(
                    "h-4 w-4 text-[var(--color-fg-faint)]",
                    (!!w.yolo && !isSandboxEnforced(effectiveSandboxMode(w))) && "text-[var(--color-err)]",
                    effectiveSandboxMode(w) === "enforce" && "text-[var(--color-ok)]",
                    effectiveSandboxMode(w) === "enforce-fs" && "text-[var(--color-ok)]",
                  )}
                  fill={(isSandboxEnforced(effectiveSandboxMode(w)) || !!w.yolo) ? "currentColor" : "none"}
                />
                <span>
                  {effectiveSandboxMode(w) === "enforce"
                    ? "YOLO: auto-on (Enforcing)"
                    : effectiveSandboxMode(w) === "enforce-fs"
                    ? "YOLO: auto-on (Enforcing FS)"
                    : w.yolo ? "YOLO: on" : "YOLO: off"}
                </span>
              </DropdownItem>
              <DropdownItem
                className="items-center [&>svg]:mt-0"
                onSelect={() => setTaskRenaming(w.name)}
              >
                <Pencil className="h-4 w-4" />
                <span>Rename</span>
              </DropdownItem>
              {/* Custom-command tasks carry an editable launch
                  script (agent / shell tasks resolve their command
                  from the registry, so there's nothing to edit). */}
              {w.cli === "custom" && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={() => useUI.getState().openEditCommand(w.id)}
                >
                  <SquareChevronRight className="h-4 w-4" />
                  <span>Edit command</span>
                </DropdownItem>
              )}
              {/* Resume override: only for agent tasks (shell / custom
                  tabs don't resume an agent session). Lets a task
                  resume a named session instead of termic's auto-managed
                  uuid, e.g. `--resume {WORKSPACE_NAME}`. */}
              {w.cli !== "custom" && w.cli !== "shell" && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={() => useUI.getState().openResumeOverride(w.id)}
                >
                  <History className={cn("h-4 w-4", w.resume_override && "text-[var(--color-accent)]")} />
                  <span>{w.resume_override ? "Resume args override: on" : "Resume args override"}</span>
                </DropdownItem>
              )}
              {w.branch && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={() => copyToClipboard(w.branch, `"${w.branch}"`)}
                >
                  <Copy className="h-4 w-4" />
                  <span>Copy branch name</span>
                </DropdownItem>
              )}
              {/* Duplicate: only for worktree tasks (the repo-root
                  entry IS the project's checkout, can't be branched
                  off cleanly). Pre-fills the New worktree dialog with
                  the source branch as the `base` so the new worktree
                  branches off this one's current tip. */}
              {!w.is_main_checkout && w.branch && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  // Defer one frame so the dropdown's focus-teardown
                  // doesn't steal focus from the dialog's autofocused name
                  // input (see ProjectActionsMenuItems for the full why).
                  onSelect={() => requestAnimationFrame(() => useUI.getState().openNewTask(w.project_id, { baseBranch: w.branch }))}
                >
                  <GitBranchPlus className="h-4 w-4" />
                  <span>Duplicate worktree</span>
                </DropdownItem>
              )}
              <DropdownSeparator />
              {/* Stop without archiving (GH #119): kill the agents, free
                  the memory, keep the session. Opening the task again
                  respawns with resume — same lifecycle as restarting
                  termic, scoped to one task. */}
              {isMounted && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={() => {
                    stopTask(w.id);
                    useUI.getState().pushToast(`Stopped ${w.name}`, "success");
                  }}
                >
                  <CircleStop className="h-4 w-4" />
                  <span>Stop task</span>
                </DropdownItem>
              )}
              <DropdownItem
                className="items-center [&>svg]:mt-0"
                onSelect={async () => {
                  if (taskRenaming !== null) return;
                  await confirmAndArchive(w);
                }}
              >
                <Archive className="h-4 w-4" />
                <span>Archive task</span>
              </DropdownItem>
            </DropdownMenu>
          </DropdownRoot>
        </span>
      </div>

      {/* Tab children — terminal tabs only; edit/diff are transient file views */}
      {!collapsed && terminalTabs.map(tab => {
        const isTabActive = isActive && tab.id === activeTabId;
        const isTabHot = isTabActive;
        const showBell    = settledHighlight && tab.unread?.reason === "attention";
        const showDone    = settledHighlight && !showBell && tab.workState === "done";
        const showWorking = workingIndicator && !showBell && !showDone && tab.workState === "working";
        const rawTitle = tab.customTitle ? tab.title : (tab.liveTitle || tab.title);
        const title = tab.customTitle
          ? rawTitle
          : formatTerminalTitle(rawTitle, tab.cli, showWorking);
        const isTabRenaming = tabRenaming?.id === tab.id;

        return (
          <div
            key={tab.id}
            onClick={() => {
              setActive(w.id);
              setActiveTabId(w.id, tab.id);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (!isTabRenaming) setTabRenaming({ id: tab.id, value: title });
            }}
            className={cn(
              "group/tab ml-8 flex items-center gap-1.5 rounded-md px-1.5 py-[3px] text-[12.5px] cursor-pointer select-none transition-colors",
              isTabHot
                ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
                : isTabActive
                  ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                  : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
            )}
          >
            {/* Brand icon stays at the start; the work-state badge moves
                to the end of the row (after the title) per iTerm2's
                tab-bullet placement. */}
            <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(tab.cli, agents)] || "text-[var(--color-fg-dim)]")}>
              <CliIcon cli={resolveIconId(tab.cli, agents)} className="h-3.5 w-3.5" />
            </span>

            {isTabRenaming ? (
              <input
                autoFocus
                value={tabRenaming!.value}
                onChange={e => setTabRenaming(r => r ? { ...r, value: e.target.value } : r)}
                onBlur={commitTabRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitTabRename(); }
                  else if (e.key === "Escape") { e.preventDefault(); setTabRenaming(null); }
                  e.stopPropagation();
                }}
                onClick={e => e.stopPropagation()}
                onDoubleClick={e => e.stopPropagation()}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                // No `py-*`: the parent row already has py-[3px]; doubling
                // pads the input up to a taller row than the static span
                // (the row jumped a few px when entering rename mode).
                // `leading-tight` keeps the text vertically centred against
                // the surrounding non-renaming rows.
                className="min-w-0 flex-1 rounded border-0 bg-[var(--color-bg-2)] px-1 py-0 leading-tight text-[12.5px] text-[var(--color-fg)] outline-none ring-1 ring-inset ring-[var(--color-accent)]"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{title}</span>
            )}
            {/* Trailing slot — status badge by default. Close × only
                appears when hovering the badge itself, not the whole
                row — row hover keeps the badge visible. */}
            <span className="group/badge relative flex h-4 w-4 shrink-0 items-center justify-center">
              {(showBell || showDone || showWorking) && (
                <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover/badge:opacity-0">
                  {showBell ? <TabBadge reason="attention" /> : showDone ? <TabBadge reason="done" /> : <TabBadge reason="working" />}
                </span>
              )}
              <button
                title="Close tab"
                onClick={(e) => { e.stopPropagation(); requestCloseTab(w.id, tab.id); }}
                className={cn(
                  "absolute inset-0 flex items-center justify-center rounded p-0.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]",
                  (showBell || showDone || showWorking)
                    // Badge visible: X only on badge-slot hover
                    ? "opacity-0 group-hover/badge:opacity-100 pointer-events-none group-hover/badge:pointer-events-auto"
                    // No badge: X on row hover (original behaviour)
                    : "opacity-0 group-hover/tab:opacity-100 pointer-events-none group-hover/tab:pointer-events-auto",
                )}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function NavItem({ icon, label, active, compact, onClick }: {
  icon: React.ReactNode; label: string; active?: boolean; compact: boolean; onClick: () => void;
}) {
  // In compact mode we use a fixed-size square button (h-9 w-9) centered in
  // the column (mx-auto) so every left-rail icon sits at the exact same x —
  // otherwise NavItem's `w-full` paints a wider highlight that visually shifts
  // it left of the project/task icons below it.
  // font-medium (500) gives the sidebar labels enough weight to read crisp
  // against the bg without looking shouty.
  const btn = (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center rounded-md text-[13px] font-medium",
        compact
          ? "mx-auto h-9 w-9 justify-center"
          : "gap-2 px-2.5 py-1.5",
        active ? "bg-[var(--color-sel)] text-[var(--color-fg)]" : "text-[var(--color-fg)] hover:bg-[var(--color-hover)]",
      )}
    >
      {icon}
      {!compact && <span>{label}</span>}
    </button>
  );
  return compact ? <Tip content={label}>{btn}</Tip> : btn;
}

/** Inline name-prompt row rendered above the task list while the
 *  user is creating a new repo-root task. Mirrors the geometry of
 *  the rename input (py-[3px], no border, accent ring) so the row
 *  doesn't jump vertically when the input mounts. Auto-focused +
 *  pre-selected so the user can hit Enter to accept the default
 *  ("claude-1") or just start typing to replace. */
function PendingRepoRootRow({ mode, cli, value, branch, onChange, onBranchChange, onCommit, onCancel }: {
  mode: NewTaskMode;
  cli: string;
  value: string;
  branch: string;
  onChange: (v: string) => void;
  onBranchChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isWorktree = mode === "worktree";
  // Show the picked agent's brand icon (or the terminal glyph for a shell) as
  // the leading marker, so the row confirms which CLI is about to launch.
  const agents = useApp(s => s.agents);
  const iconId = resolveIconId(cli, agents);
  useEffect(() => {
    // Two-frame focus matches the Radix dropdown close timing — same
    // workaround used by the task rename input. autoFocus alone
    // races the menu's focus restoration.
    let cancelled = false;
    const r1 = requestAnimationFrame(() => {
      const r2 = requestAnimationFrame(() => {
        if (cancelled) return;
        const el = ref.current;
        if (el) { el.focus(); el.select(); }
      });
      if (cancelled) cancelAnimationFrame(r2);
    });
    return () => { cancelled = true; cancelAnimationFrame(r1); };
  }, []);
  const keyHandler = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); onCommit(); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    e.stopPropagation();
  };
  // Cancel only when focus leaves the WHOLE row — tabbing name → branch must
  // not dismiss it (single-field rows never had a second focus target).
  const handleBlur = (e: ReactFocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node | null)) onCancel();
  };
  const inputCls =
    "min-w-0 flex-1 rounded border-0 bg-[var(--color-bg-2)] px-1 py-[3px] text-[13px] text-[var(--color-fg)] outline-none ring-1 ring-inset ring-[var(--color-accent)]";
  return (
    <div
      ref={containerRef}
      onBlur={handleBlur}
      className="ml-3 mr-1 flex flex-col gap-1 rounded-md px-1 py-1"
    >
      {/* Both rows share an identical leading-icon column (same glyph box +
          same gap) so the name and branch inputs left-align exactly. */}
      <div className="flex items-center gap-1.5">
        <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-dim)]")}>
          <CliIcon cli={iconId} className="h-3.5 w-3.5" />
        </span>
        <input
          ref={ref}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={keyHandler}
          placeholder="Task name"
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          className={inputCls}
        />
      </div>
      {isWorktree && (
        // Auto-derived branch, editable. Indented by one icon column (pl-5 =
        // name icon 14px + gap 6px) so the GitBranch glyph lines up with the
        // START of the name input above it, reading as a child of the name.
        <div className="flex items-center gap-1.5 pl-5">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
          <input
            value={branch}
            onChange={e => onBranchChange(e.target.value)}
            onKeyDown={keyHandler}
            placeholder="branch"
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            className={cn(inputCls, "font-mono text-[12px] text-[var(--color-fg-dim)] ring-[var(--color-border)]")}
          />
        </div>
      )}
    </div>
  );
}
