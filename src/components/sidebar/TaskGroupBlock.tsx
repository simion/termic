// One drawn task group inside a project: a caption row in the group's accent,
// and its members behind a rail of the same colour. The rules for WHICH rows
// are in a group and where the block sits live in src/lib/taskGroups.ts; this
// only draws what it is handed.
//
// The wrapper carries `data-task-group-id` for the sidebar's task drag, which
// hit-tests these blocks to decide whether a dropped row joins or leaves.

import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent } from "@/components/ui/ContextMenu";
import { GroupActionsMenuItems } from "./GroupActionsMenuItems";
import { accentCss } from "@/lib/accents";
import { groupBadgeKinds, groupColorCss } from "@/lib/taskGroups";
import { usePrefs } from "@/store/prefs";
import { TaskWorkBadge } from "@/components/TaskWorkBadge";
import { taskGroupDissolve, taskGroupUpdate } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import type { TaskGroup } from "@/lib/types";
import { cn } from "@/lib/utils";

export function TaskGroupBlock({ group, projectId, label, compact, count, memberIds, collapsed = false, summarized = collapsed, onToggleCollapsed, dragging = false, dragTy = 0, onDragPointerDown, children }: {
  group: TaskGroup;
  projectId: string;
  /** Resolved by `groupLabel`: own name, else the lead's live name. */
  label: string;
  compact: boolean;
  /** Members in THIS project, for the count on the caption. */
  count: number;
  /** Their task ids, for the collapsed caption's marks. */
  memberIds: string[];
  /** Members hidden behind the caption (the Sidebar passes only the active
   *  task's row as children then, if it is one of them). */
  collapsed?: boolean;
  /** The members are actually hidden this render, so the caption carries
   *  their marks. Differs from `collapsed` while a filter is on: the chevron
   *  still shows (and toggles) the stored collapse, but the matching rows
   *  are on screen, so a summary would repeat them. */
  summarized?: boolean;
  onToggleCollapsed?: () => void;
  /** This block is being dragged by its caption: it follows the cursor. */
  dragging?: boolean;
  dragTy?: number;
  /** The caption is the block's drag handle (Sidebar owns the drag). */
  onDragPointerDown?: (e: React.PointerEvent, groupId: string, projectId: string) => void;
  children: ReactNode;
}) {
  const color = groupColorCss(group);
  const { t } = useTranslation("sidebar");
  // The rename draft lives in the UI store, not in this component: Move to
  // group > New group starts it from the TASK's menu, and the block it
  // targets is mounted by the same reload, so local state could be lost to a
  // remount between the two (it was, intermittently, in the e2e run).
  const renaming = useUI(s => (s.groupRenaming?.groupId === group.id ? s.groupRenaming.value : null));
  const setRenaming = (value: string | null) =>
    useUI.setState({ groupRenaming: value === null ? null : { groupId: group.id, value } });
  const inputRef = useRef<HTMLInputElement | null>(null);
  // A menu closing restores focus after autoFocus has run; take it back two
  // frames later (TaskRow's rename does the same).
  // Select the whole name the moment a rename starts, so typing replaces it.
  // Unconditional: `autoFocus` has usually focused the field already, and a
  // select gated on "not focused yet" never ran, leaving the caret at the
  // end. Once now, and again two frames on for a menu whose close hands
  // focus back after us.
  useEffect(() => {
    if (renaming === null) return;
    const take = () => { inputRef.current?.focus(); inputRef.current?.select(); };
    take();
    const r = requestAnimationFrame(() => requestAnimationFrame(() => {
      if (document.activeElement !== inputRef.current) take();
    }));
    return () => cancelAnimationFrame(r);
  }, [renaming !== null]);

  const reload = () => useApp.getState().loadAll();
  const commitRename = () => {
    if (renaming === null) return;
    const next = renaming.trim();
    setRenaming(null);
    // Typing the label it already shows is not a rename: on an unnamed group
    // it would pin the lead's name and stop following it.
    if (next === label) return;
    void taskGroupUpdate(group.id, next || null, group.color ?? null).finally(reload);
  };

  // The icon rail has no room for a caption; the rail alone marks the block.
  if (compact) {
    return (
      <div
        data-task-group-id={group.id}
        data-task-group-project-id={projectId}
        data-task-group-rail
        className="border-l-2 pl-px"
        style={{ borderColor: color }}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      data-task-group-id={group.id}
      data-task-group-project-id={projectId}
      data-testid={`task-group-${group.id}`}
      // The whole block rides the transform, members and their expanded tabs
      // with it, so nothing is left frozen in place under a moving caption.
      style={dragging ? { transform: `translateY(${dragTy}px)`, position: "relative", zIndex: 20 } : undefined}
      className={cn("mb-px", dragging && "rounded-md bg-[var(--color-bg-1)] shadow-lg")}
    >
      <ContextMenuRoot>
        <ContextMenuTrigger asChild>
          {/* The caption copies a task row's box model (TaskRow's header: ml-3,
              px-1, gap-1, an 18px chevron box, then a gap-1.5 name container),
              so its icon sits in the chevron column and its label in the name
              column of the loose rows around it, by construction rather than
              by tuned pixels. */}
          <div
            data-testid={`task-group-header-${group.id}`}
            // Hover like a task row: the caption is a clickable row, not a label.
            className="ml-3 flex h-[var(--task-row-h)] cursor-pointer select-none items-center gap-1 rounded-md px-1 text-[13px] font-medium transition-colors hover:bg-[var(--color-hover)]"
            style={{ color }}
            onPointerDown={onDragPointerDown ? (e) => onDragPointerDown(e, group.id, projectId) : undefined}
            // A click toggles, at once. A double-click still renames, and it
            // arrives as click(1), click(2), dblclick: the second click is
            // ignored and the dblclick undoes the first one's toggle, so a
            // rename leaves the group as it was. Delaying every click by the
            // double-click window instead would make every expand feel slow.
            onClick={(e) => {
              if (renaming !== null || e.detail > 1) return;
              onToggleCollapsed?.();
            }}
            onDoubleClick={() => {
              if (renaming !== null) return;
              onToggleCollapsed?.();
              setRenaming(label);
            }}
          >
            {/* The chevron sits where a task row's does. It is a button of
                its own for the keyboard; a click on it is the caption's
                toggle, and it takes no part in the rename gesture. */}
            <button
              type="button"
              data-no-drag
              data-testid={`task-group-toggle-${group.id}`}
              aria-label={collapsed ? t("taskGroup.expand") : t("taskGroup.collapse")}
              title={collapsed ? t("taskGroup.expand") : t("taskGroup.collapse")}
              aria-expanded={!collapsed}
              onClick={(e) => { e.stopPropagation(); if (e.detail <= 1) onToggleCollapsed?.(); }}
              onDoubleClick={(e) => e.stopPropagation()}
              className="shrink-0 rounded p-0.5 hover:bg-[var(--color-bg-3)]"
            >
              {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {renaming !== null ? (
                // Same font, weight and colour as the label it replaces, with
                // no padding or border in the box: the outline is drawn
                // OUTSIDE, so entering rename moves no text by a pixel.
                <input
                  ref={inputRef}
                  autoFocus
                  data-testid={`task-group-rename-${group.id}`}
                  value={renaming}
                  placeholder={t("taskGroup.renamePlaceholder")}
                  onChange={e => setRenaming(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => {
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") setRenaming(null);
                    e.stopPropagation();
                  }}
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => e.stopPropagation()}
                  onDoubleClick={e => e.stopPropagation()}
                  autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                  className="m-0 w-full min-w-0 flex-1 rounded-sm border-0 bg-[var(--color-bg)] p-0 [font:inherit] text-inherit outline outline-1 outline-offset-2 outline-[var(--color-accent)]"
                />
              ) : (
                <span data-testid={`task-group-label-${group.id}`} className="truncate">{label}</span>
              )}
            </div>
            {renaming === null && (summarized
              ? <GroupBadges groupId={group.id} memberIds={memberIds} count={count} />
              : <span className="ml-auto shrink-0 pr-1 tabular-nums text-[11px] font-normal text-[var(--color-fg-faint)]">{count}</span>)}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <GroupActionsMenuItems
            name={label}
            accent={accentCss(group.color)}
            onSetColor={key => { void taskGroupUpdate(group.id, group.name ?? null, key).finally(reload); }}
            onRename={() => setRenaming(label)}
            onUngroup={() => { void taskGroupDissolve(group.id).finally(reload); }}
            ungroupLabel={t("taskGroup.ungroupTasks")}
          />
        </ContextMenuContent>
      </ContextMenuRoot>
      {/* The rail is this wrapper's left border, at 24px: under the centre of
          the caption's icon (12 margin + 4 padding + 2 + half of 14 = 25).
          The inner stack is pulled back 6px so the members land 18px right
          of the loose rows (measured in the e2e spec), the step a project
          folder gives its members; their tab rows move with them. */}
      <div data-task-group-rail className="ml-6 border-l-2" style={{ borderColor: color }}>
        <div className="-ml-1.5">{children}</div>
      </div>
    </div>
  );
}

/** The marks a collapsed group carries on the right of its caption: one of
 *  each that any member's row would draw (`groupBadgeKinds`), else the count.
 *  Mounted only while collapsed, and subscribed through a joined string, so
 *  the caption re-renders when the SET of marks changes, not on every tab
 *  write (docs/performance.md, selector fanout). */
function GroupBadges({ groupId, memberIds, count }: { groupId: string; memberIds: string[]; count: number }) {
  const { t } = useTranslation("sidebar");
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  const partialPref = usePrefs(s => s.partialDoneIndicator);
  const key = useApp(s => groupBadgeKinds(
    memberIds.map(id => s.tabs[id] ?? []),
    { settledHighlight, workingIndicator, attentionIndicator },
    partialPref,
  ).join(","));
  // The count stays beside the marks: it is what says "N tasks are tucked
  // away in here". With the marks alone, a collapsed group read as a group
  // whose tasks had vanished.
  const countEl = <span className="shrink-0 tabular-nums text-[11px] font-normal text-[var(--color-fg-faint)]">{count}</span>;
  if (!key) {
    return <span className="ml-auto flex shrink-0 items-center pr-1">{countEl}</span>;
  }
  return (
    <span
      data-testid={`task-group-badges-${groupId}`}
      data-kinds={key}
      className="ml-auto flex shrink-0 items-center gap-1 pr-1"
    >
      {key.split(",").map(k => k === "partial" ? (
        // TaskWorkBadge's partial mark needs a report to title it; the group
        // stands for several, so it draws the same outlined dot directly.
        <span key={k} title={t("taskGroup.delegatedPartialTip")} aria-label={t("taskGroup.delegatedPartialAria")} className="flex items-center justify-center">
          <span className="block h-2 w-2 rounded-full border-[1.5px]" style={{ borderColor: "var(--color-info)" }} />
        </span>
      ) : (
        <TaskWorkBadge key={k} reason={k as "attention" | "done" | "working" | "delegated"} />
      ))}
      <span className="ml-0.5" data-testid={`task-group-count-${groupId}`}>{countEl}</span>
    </span>
  );
}
