// Right-click menu on a tab pill (issue #183). Shared by all three strips: the
// main TabBar, a split pane's PaneHeader, and TaskView's bottom scratch shells.
// Each host supplies its own strip and its own close/pin wiring; the item set
// and the "which siblings does this close" rules live here.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pin, PinOff, X, SquareSplitHorizontal, SquareSplitVertical, Move } from "lucide-react";
import {
  ContextMenuRoot, ContextMenuTrigger, ContextMenuContent,
  ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/ContextMenu";
import { closableSiblings, type StripTab } from "@/lib/tabActions";

export function TabContextMenu({
  tabs, tabId, pinned, onPin, onUnpin, onClose, onCloseMany,
  onSplitRight, onSplitDown, canSplitOut = true, onMoveToSplit,
  children,
}: {
  /** This strip's tabs, in display order. */
  tabs: StripTab[];
  tabId: string;
  pinned: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onClose: () => void;
  onCloseMany: (tabIds: string[]) => void;
  /** Split the tab's own pane (main included) and move it into the new
   *  half. Omitted where splitting doesn't apply, e.g. the bottom scratch
   *  strip, which isn't part of the split tree. */
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  /** False when the tab is alone in its pane/main: splitting would just
   *  leave an empty neighbor and move nothing. Split Right/Down and Move to
   *  Split stay visible but disabled rather than vanish, same as Close
   *  others/Close to the right above. */
  canSplitOut?: boolean;
  /** Arm a cursor-following move: same drag ghost and edge highlight as a
   *  real pointer drag, just started from the menu instead of a grab.
   *  Present only when another pane already exists to move into. */
  onMoveToSplit?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("task");
  const others = closableSiblings(tabs, tabId, "others");
  const right = closableSiblings(tabs, tabId, "right");
  return (
    <ContextMenuRoot>
      {/* `contents` rather than asChild: TabPill neither forwards a ref nor
          spreads unknown props, so Radix's Slot would drop them. A
          display:contents span generates no box, so the pill stays the strip's
          flex item and the contextmenu event still bubbles through. */}
      <ContextMenuTrigger className="contents">{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {pinned ? (
          <ContextMenuItem onSelect={onUnpin}><PinOff /> {t("tabMenu.unpin")}</ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={onPin}><Pin /> {t("tabMenu.pin")}</ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onClose}><X /> {t("tabMenu.close")}</ContextMenuItem>
        <ContextMenuItem disabled={!others.length} onSelect={() => onCloseMany(others)}>
          {t("tabMenu.closeOthers")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!right.length} onSelect={() => onCloseMany(right)}>
          {t("tabMenu.closeRight")}
        </ContextMenuItem>
        {(onSplitRight || onSplitDown || onMoveToSplit) && <ContextMenuSeparator />}
        {onSplitRight && (
          <ContextMenuItem disabled={!canSplitOut} onSelect={onSplitRight}>
            <SquareSplitHorizontal /> {t("tabMenu.splitRight")}
          </ContextMenuItem>
        )}
        {onSplitDown && (
          <ContextMenuItem disabled={!canSplitOut} onSelect={onSplitDown}>
            <SquareSplitVertical /> {t("tabMenu.splitDown")}
          </ContextMenuItem>
        )}
        {onMoveToSplit && (
          <ContextMenuItem onSelect={onMoveToSplit}>
            <Move /> {t("tabMenu.moveToSplit")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
