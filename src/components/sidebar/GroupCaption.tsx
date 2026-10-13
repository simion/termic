// The caption row of a collapsible group in the sidebar tree: a chevron, the
// group's name in its accent (or an inline rename field in its place), and a
// trailing slot for the count or the collapsed marks. Shared by task groups
// (TaskGroupBlock) and tab subgroups inside a task (TabSubgroupBlock), so the
// two read as one kind of thing and their click / double-click / rename
// gestures cannot drift apart. Each caller supplies the box model that lines
// the caption up with the rows it heads.
//
// Spreads unknown props onto the row and takes a `ref`, so it can sit inside
// a Radix `ContextMenuTrigger asChild`.

import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function GroupCaption({
  testIdPrefix, id, label, color, collapsed, onToggleCollapsed,
  renaming, onRenameStart, onRenameChange, onRenameCommit, onRenameCancel,
  renamePlaceholder, expandLabel, collapseLabel, className, chevronClassName,
  trailing, ref, ...rest
}: {
  /** `task-group` / `tab-subgroup`: the testids are `<prefix>-header-<id>`,
   *  `-toggle-`, `-rename-` and `-label-`. */
  testIdPrefix: string;
  id: string;
  label: string;
  /** Resolved CSS colour of the caption text. */
  color: string;
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  /** The rename draft, or null when not renaming. */
  renaming: string | null;
  onRenameStart: () => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  renamePlaceholder: string;
  expandLabel: string;
  collapseLabel: string;
  /** The row's box model and type size. */
  className: string;
  chevronClassName: string;
  trailing?: ReactNode;
  ref?: Ref<HTMLDivElement>;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "color">) {
  const inputRef = useRef<HTMLInputElement | null>(null);
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

  return (
    <div
      ref={ref}
      {...rest}
      data-testid={`${testIdPrefix}-header-${id}`}
      data-collapsed={collapsed ? "" : undefined}
      className={cn("cursor-pointer select-none font-medium transition-colors hover:bg-[var(--color-hover)]", className)}
      style={{ ...rest.style, color }}
      // A click toggles, at once. A double-click still renames, and it
      // arrives as click(1), click(2), dblclick: the second click is
      // ignored and the dblclick undoes the first one's toggle, so a
      // rename leaves the group as it was. Delaying every click by the
      // double-click window instead would make every expand feel slow.
      onClick={(e) => {
        if (renaming !== null || e.detail > 1) return;
        onToggleCollapsed?.();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (renaming !== null) return;
        onToggleCollapsed?.();
        onRenameStart();
      }}
    >
      {/* A button of its own for the keyboard; a click on it is the
          caption's toggle, and it takes no part in the rename gesture. */}
      <button
        type="button"
        data-no-drag
        data-testid={`${testIdPrefix}-toggle-${id}`}
        aria-label={collapsed ? expandLabel : collapseLabel}
        title={collapsed ? expandLabel : collapseLabel}
        aria-expanded={!collapsed}
        onClick={(e) => { e.stopPropagation(); if (e.detail <= 1) onToggleCollapsed?.(); }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={cn("shrink-0 rounded hover:bg-[var(--color-bg-3)]", chevronClassName)}
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {renaming !== null ? (
          // Same font, weight and colour as the label it replaces, with no
          // padding or border in the box: the outline is drawn OUTSIDE, so
          // entering rename moves no text by a pixel.
          <input
            ref={inputRef}
            autoFocus
            data-testid={`${testIdPrefix}-rename-${id}`}
            value={renaming}
            placeholder={renamePlaceholder}
            onChange={e => onRenameChange(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={e => {
              if (e.key === "Enter") onRenameCommit();
              else if (e.key === "Escape") onRenameCancel();
              e.stopPropagation();
            }}
            onPointerDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            className="m-0 w-full min-w-0 flex-1 rounded-sm border-0 bg-[var(--color-bg)] p-0 [font:inherit] text-inherit outline outline-1 outline-offset-2 outline-[var(--color-accent)]"
          />
        ) : (
          <span data-testid={`${testIdPrefix}-label-${id}`} className="truncate">{label}</span>
        )}
      </div>
      {renaming === null && trailing}
    </div>
  );
}
