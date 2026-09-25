// Shared context-menu body for a project group folder: the Finder-style colour
// swatch row, Rename, and Ungroup. Used by the sidebar's folder header and the
// dashboard's group card header.
//
// Wrap in a `<ContextMenuContent>` at the call site; this renders only the
// items. ContextMenu primitives specifically, not Dropdown ones: Radix's two
// item components are not interchangeable, and right-clicking a folder means
// the same thing in both views, so one set serves both. (`ProjectActionsMenuItems`
// is the precedent for sharing a menu BODY, not for the primitives - it is a
// Dropdown and is only ever mounted in one.)
//
// `onRename` is optional because renaming is an INLINE edit on the header that
// owns it, and only the sidebar has one. Omitting the prop drops the item
// rather than offering an action that would do nothing.

import { useTranslation } from "react-i18next";
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "@/components/ui/ContextMenu";
import { ACCENTS } from "@/lib/accents";
import { cn } from "@/lib/utils";
import { FolderMinus, Pencil } from "lucide-react";

export function GroupActionsMenuItems({ name, accent, onSetColor, onUngroup, onRename, ungroupLabel = "Ungroup projects" }: {
  name: string;
  /** The group's resolved accent CSS (`accentCss(groupColors[name])`), or
   *  undefined for an uncoloured folder. */
  accent: string | undefined;
  onSetColor: (key: string | null) => void;
  onUngroup: () => void;
  onRename?: () => void;
  /** Task groups reuse this menu; the word is theirs to pick. */
  ungroupLabel?: string;
}) {
  const { t } = useTranslation("sidebar");
  return (
    <>
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
          aria-label={t("groupActions.defaultColour")}
          checked={!accent}
          onSelect={() => onSetColor(null)}
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
        {ACCENTS.map(c => (
          <ContextMenuItem
            key={c.key}
            aria-label={c.label}
            checked={accent === c.css}
            onSelect={() => onSetColor(c.key)}
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
      {onRename && (
        <ContextMenuItem onSelect={onRename}>
          <Pencil />
          {t("groupActions.renameGroup")}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={onUngroup}>
        <FolderMinus />
        {ungroupLabel ?? t("groupActions.ungroup")}
      </ContextMenuItem>
    </>
  );
}
