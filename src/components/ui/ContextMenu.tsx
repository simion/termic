import * as CM from "@radix-ui/react-context-menu";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Right-click context menu. Mirrors Dropdown.tsx (same visual language) but
// built on Radix's context-menu primitive: the trigger is the right-clicked
// region and the menu anchors to the cursor, not to an element edge.

export const ContextMenuRoot    = CM.Root;

export function ContextMenuTrigger({ children, className, asChild, disabled }: {
  children: ReactNode; className?: string; asChild?: boolean; disabled?: boolean;
}) {
  return (
    <CM.Trigger asChild={asChild} className={className} disabled={disabled}>
      {children}
    </CM.Trigger>
  );
}

export function ContextMenuContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <CM.Portal>
      <CM.Content
        collisionPadding={8}
        // Same bubbling guard as Dropdown: a click on an item must not leak
        // through the React portal tree to the clickable row underneath.
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ maxHeight: "var(--radix-context-menu-content-available-height)" }}
        className={cn(
          "z-50 min-w-[180px] overflow-y-auto overflow-x-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] p-1 shadow-xl",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className,
        )}
      >{children}</CM.Content>
    </CM.Portal>
  );
}

export function ContextMenuItem({ children, className, onSelect, disabled, destructive }: {
  children: ReactNode; className?: string; onSelect?: () => void; disabled?: boolean; destructive?: boolean;
}) {
  return (
    <CM.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[13px]",
        "outline-none data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed",
        destructive
          ? "text-[var(--color-err)] data-[highlighted]:bg-[var(--color-err)] data-[highlighted]:text-white"
          : "text-[var(--color-fg)] data-[highlighted]:bg-[var(--color-hover)]",
        "[&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0",
        className,
      )}
    >{children}</CM.Item>
  );
}

export const ContextMenuSeparator = () => (
  <CM.Separator className="my-1 h-px bg-[var(--color-border-soft)]" />
);
export const ContextMenuLabel = ({ children }: { children: ReactNode }) => (
  <CM.Label className="px-2 py-1 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
    {children}
  </CM.Label>
);
