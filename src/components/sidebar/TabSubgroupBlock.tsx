// One drawn tab subgroup inside a task's sidebar tree (docs/ui.md "Tab
// subgroups"): a caption row in the subgroup's accent and its member tab rows
// behind a rail of the same colour. Which rows are members and where the
// block sits is src/lib/tabSubgroups.ts; TaskRow hands this the rows to draw.
//
// The wrapper carries `data-tab-subgroup-id` for the sidebar's tab-row drag
// (TaskRow's `hitTestTabSubgroup`), which decides whether a dropped row joins
// or leaves by the block's rect, the caption included.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent } from "@/components/ui/ContextMenu";
import { GroupActionsMenuItems } from "./GroupActionsMenuItems";
import { GroupCaption } from "./GroupCaption";
import { WorkMarkList } from "./RollupMarks";
import { accentCss } from "@/lib/accents";
import { groupColorCss } from "@/lib/taskGroups";
import { subgroupBadgeKinds } from "@/lib/tabSubgroups";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
import type { TabSubgroup } from "@/lib/types";

export function TabSubgroupBlock({ taskId, subgroup, count, hiddenIds, collapsed, onToggleCollapsed, children }: {
  taskId: string;
  subgroup: TabSubgroup;
  /** Members in the block, for the caption's count. */
  count: number;
  /** Members hidden behind the caption this render (collapsed, minus the
   *  active tab's row and any filter match), whose marks the caption carries.
   *  Empty while expanded. */
  hiddenIds: string[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("sidebar");
  const color = groupColorCss(subgroup);
  // The draft lives in the UI store: Move to subgroup > New subgroup starts
  // it from a tab row's menu, before this block has mounted.
  const renaming = useUI(s => (s.tabSubgroupRenaming?.subgroupId === subgroup.id ? s.tabSubgroupRenaming.value : null));
  const setRenaming = (value: string | null) =>
    useUI.setState({ tabSubgroupRenaming: value === null ? null : { subgroupId: subgroup.id, value } });
  const commitRename = () => {
    if (renaming === null) return;
    setRenaming(null);
    // An emptied field keeps the old name (the store ignores a blank one).
    useApp.getState().renameTabSubgroup(taskId, subgroup.id, renaming);
  };

  return (
    <div
      data-tab-subgroup-id={subgroup.id}
      data-testid={`tab-subgroup-${subgroup.id}`}
      data-collapsed={collapsed ? "" : undefined}
    >
      <ContextMenuRoot>
        <ContextMenuTrigger asChild>
          {/* The caption copies a tab row's box model (ml-8, px-1.5, py-[3px],
              gap-1.5, a 14px glyph box), so its chevron sits in the column
              of the rows' agent icons and its name in their title column. */}
          <GroupCaption
            testIdPrefix="tab-subgroup"
            id={subgroup.id}
            label={subgroup.name}
            color={color}
            collapsed={collapsed}
            onToggleCollapsed={onToggleCollapsed}
            renaming={renaming}
            onRenameStart={() => setRenaming(subgroup.name)}
            onRenameChange={setRenaming}
            onRenameCommit={commitRename}
            onRenameCancel={() => setRenaming(null)}
            renamePlaceholder={t("tabSubgroup.renamePlaceholder")}
            expandLabel={t("tabSubgroup.expand")}
            collapseLabel={t("tabSubgroup.collapse")}
            className="ml-8 flex items-center gap-1.5 rounded-md px-1.5 py-[3px] text-[12.5px]"
            chevronClassName="flex h-3.5 w-3.5 items-center justify-center"
            trailing={hiddenIds.length
              ? <SubgroupBadges taskId={taskId} subgroupId={subgroup.id} hiddenIds={hiddenIds} count={count} />
              : <span data-testid={`tab-subgroup-count-${subgroup.id}`} className="ml-auto shrink-0 pr-0.5 tabular-nums text-[11px] font-normal text-[var(--color-fg-faint)]">{count}</span>}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <GroupActionsMenuItems
            name={subgroup.name}
            accent={accentCss(subgroup.color)}
            onSetColor={key => useApp.getState().recolorTabSubgroup(taskId, subgroup.id, key ?? undefined)}
            onRename={() => setRenaming(subgroup.name)}
            onUngroup={() => useApp.getState().dissolveTabSubgroup(taskId, subgroup.id)}
            ungroupLabel={t("tabSubgroup.ungroupTabs")}
            renameLabel={t("tabSubgroup.renameSubgroup")}
          />
        </ContextMenuContent>
      </ContextMenuRoot>
      {/* The rail runs under the centre of the caption's chevron: the row's
          ml-8 plus its px-1.5, plus half the 14px glyph box, less half the
          line. 1px, the task groups' weight; members sit one step further
          in (TaskRow draws them with ml-12), so the rail clears their
          highlight. Spacing is rem-based, hence calc, not px. */}
      <div className="relative">
        <span
          aria-hidden
          data-tab-subgroup-rail
          className="pointer-events-none absolute bottom-0 top-0 w-px"
          style={{ left: "calc(var(--spacing) * 9.5 + 6.5px)", backgroundColor: color }}
        />
        {children}
      </div>
    </div>
  );
}

/** The marks a collapsed subgroup's caption carries for its HIDDEN members:
 *  one of each their rows would draw, then the count. Subscribed through a
 *  joined string, so the caption re-renders when the SET of marks changes,
 *  not on every tab write (docs/performance.md, selector fanout). */
function SubgroupBadges({ taskId, subgroupId, hiddenIds, count }: {
  taskId: string; subgroupId: string; hiddenIds: string[]; count: number;
}) {
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  const partialPref = usePrefs(s => s.partialDoneIndicator);
  const key = useApp(s => subgroupBadgeKinds(
    (s.tabs[taskId] ?? []).filter(tab => hiddenIds.includes(tab.id)),
    { settledHighlight, workingIndicator, attentionIndicator },
    partialPref,
  ).join(","));
  const countEl = (
    <span data-testid={`tab-subgroup-count-${subgroupId}`} className="shrink-0 tabular-nums text-[11px] font-normal text-[var(--color-fg-faint)]">{count}</span>
  );
  return (
    <span
      data-testid={`tab-subgroup-badges-${subgroupId}`}
      data-kinds={key}
      className="ml-auto flex shrink-0 items-center gap-1 pr-0.5"
    >
      {key && <WorkMarkList kinds={key} />}
      <span className={key ? "ml-0.5" : undefined}>{countEl}</span>
    </span>
  );
}
