import * as DM from "@radix-ui/react-dropdown-menu";
import { isValidElement, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export const DropdownRoot   = DM.Root;

/** Callers write `<DropdownTrigger asChild><button disabled={…}>` — the
 *  `disabled` lands on the DOM button but never reaches Radix's open handler,
 *  which only checks the Trigger's own prop. Chrome suppresses pointer events
 *  on disabled buttons so it limps along there; WKWebView fires pointerdown
 *  anyway, so a disabled-looking trigger still opens the menu. Mirror the
 *  child's disabled flag onto the Trigger so the guard actually runs. */
export function DropdownTrigger({ children, disabled, ...props }: ComponentProps<typeof DM.Trigger>) {
  const childDisabled = isValidElement(children) ? (children.props as { disabled?: boolean }).disabled : undefined;
  return <DM.Trigger disabled={disabled ?? childDisabled} {...props}>{children}</DM.Trigger>;
}

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
        // whatever wraps the trigger (e.g. a clickable task row that
        // toggles collapse, or a project header's pointer-drag handler).
        // Stop at the menu root so triggers can stay inside clickable /
        // draggable containers without leaking the event. onPointerDown is
        // the one the project drag-to-reorder arms on, so it must stop too.
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
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

/** `onSelect` receives Radix's event: call `preventDefault()` on it to keep
 *  the menu OPEN after the pick (for a setting the user toggles mid-menu,
 *  like "Branch from", where closing would make them reopen to continue). */
/** `data-*` attributes are forwarded to the rendered item. They were being
 *  DROPPED, which is worse than not supporting them: a `data-testid` written
 *  on an item compiled, rendered nothing, and left a spec searching the DOM
 *  for a hook that could never exist (the History scope picker's rows, red
 *  since the day they were written). */
type DataAttrs = { [key: `data-${string}`]: string | number | boolean | undefined };

export function DropdownItem({ children, className, onSelect, disabled, ...data }: {
  children: ReactNode; className?: string; onSelect?: (event: Event) => void; disabled?: boolean;
} & DataAttrs) {
  return (
    <DM.Item
      {...data}
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

/** Nested submenu. Radix keeps focus/keyboard nav inside the parent menu, so
 *  a submenu is the one way to hang a long list (branches, …) off a menu row
 *  without closing it or stacking a second popover. Wrap trigger + content in
 *  `DropdownSub`. */
export const DropdownSub = DM.Sub;

/** `data-*` is forwarded here for the same reason it is on `DropdownItem`
 *  above: a submenu trigger is a row a spec has to find, and silently
 *  dropping the attribute leaves it hunting for a hook that cannot exist. */
export function DropdownSubTrigger({ children, className, ...data }: {
  children: ReactNode; className?: string;
} & DataAttrs) {
  return (
    <DM.SubTrigger
      {...data}
      className={cn(
        // Mirrors DropdownItem, minus the cursor: a submenu trigger opens on
        // hover, it isn't a click target that does something.
        "flex items-center gap-2 rounded-sm px-2 py-1.5 text-[14px] text-[var(--color-fg)]",
        "outline-none data-[highlighted]:bg-[var(--color-hover)] data-[state=open]:bg-[var(--color-hover)]",
        className,
      )}
    >{children}</DM.SubTrigger>
  );
}

export function DropdownSubContent({ children, className }: {
  children: ReactNode; className?: string;
}) {
  return (
    <DM.Portal>
      <DM.SubContent
        sideOffset={2}
        collisionPadding={8}
        // Same event containment as DropdownMenu: a portaled submenu still
        // bubbles SYNTHETIC events to the React-tree parent, which for the
        // sidebar is a clickable/draggable project row.
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        style={{ maxHeight: "var(--radix-dropdown-menu-content-available-height)" }}
        className={cn(
          "z-50 min-w-[180px] overflow-y-auto overflow-x-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] p-1 shadow-xl",
          className,
        )}
      >{children}</DM.SubContent>
    </DM.Portal>
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
