import * as DM from "@radix-ui/react-dropdown-menu";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export const DropdownRoot   = DM.Root;
export const DropdownTrigger = DM.Trigger;

interface MenuProps {
  children: ReactNode;
  align?: "start" | "center" | "end";
  /** Which edge of the trigger the menu prefers. Radix still flips on
   *  collision; "right" is handy for sidebar menus that would otherwise
   *  flip UP and overlap the window chrome when the trigger sits near the
   *  bottom of a scrolled list. */
  side?: "top" | "right" | "bottom" | "left";
  /** Vertical gap between trigger and menu. 0 = docked. */
  sideOffset?: number;
  /** Minimum distance to keep from the viewport edges when positioning /
   *  flipping. Keeps a tall menu off the title-bar / window edges. */
  collisionPadding?: number;
  className?: string;
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
  /** Pass-through for Radix's `onCloseAutoFocus`. Call
   *  `event.preventDefault()` to skip the auto focus-return to the
   *  trigger when the caller is moving focus elsewhere itself
   *  (e.g. spawning a tab and focusing its terminal). */
  onCloseAutoFocus?: (event: Event) => void;
}

export function DropdownMenu({ children, align = "end", side, sideOffset = 4, collisionPadding = 8, className, onMouseEnter, onMouseLeave, onCloseAutoFocus }: MenuProps) {
  return (
    <DM.Portal>
      <DM.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onCloseAutoFocus={onCloseAutoFocus}
        // React portals keep their React-tree parent for SYNTHETIC events
        // even when the DOM target is document.body. Without these stops,
        // a click on a menu item bubbles through the React tree up to
        // whatever wraps the trigger (e.g. a clickable workspace row that
        // toggles collapse). Stop at the menu root so triggers can stay
        // inside clickable containers without leaking the click.
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        // Cap the menu to the space Radix measured between the trigger and the
        // viewport edge (its own CSS var) and scroll the overflow. Without this
        // a tall menu (e.g. the 10-agent picker) in a SHORT window can't fit
        // above or below the trigger and spills over the window chrome.
        style={{ maxHeight: "var(--radix-dropdown-menu-content-available-height)" }}
        className={cn(
          "z-50 min-w-[160px] overflow-y-auto overflow-x-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] p-1 shadow-xl",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className,
        )}
      >{children}</DM.Content>
    </DM.Portal>
  );
}

export function DropdownItem({ children, className, onSelect, disabled }: {
  children: ReactNode; className?: string; onSelect?: () => void; disabled?: boolean;
}) {
  return (
    <DM.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        // items-start (not items-center): when an item has a two-line layout
        // (title + subtitle), centering the icon vertically against the
        // whole block makes it float between the two lines. Top-align lets
        // it sit next to the title where the eye expects it.
        "flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-[14px] text-[var(--color-fg)]",
        "outline-none data-[highlighted]:bg-[var(--color-hover)] data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed",
        // Nudge leading icons down to sit at the title's optical center
        // (lucide icons are top-heavy at small sizes).
        "[&>svg]:mt-[2px]",
        className,
      )}
    >{children}</DM.Item>
  );
}

export const DropdownSeparator = () => (
  <DM.Separator className="my-1 h-px bg-[var(--color-border-soft)]" />
);
export const DropdownLabel = ({ children }: { children: ReactNode }) => (
  <DM.Label className="px-2 py-1 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
    {children}
  </DM.Label>
);
