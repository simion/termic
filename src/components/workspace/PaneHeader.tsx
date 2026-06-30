// Thin header bar shown at the top of each split pane (iTerm-style).
// Provides: title, drag-to-rearrange handle, and a close button.

import { useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface PaneHeaderProps {
  title: string;
  paneId: string;
  wsId: string;
  /** Called when the user presses the close button. */
  onClose: () => void;
  /** Fired when a drag of this header initiates (passes paneId). */
  onDragStart: (paneId: string, e: React.MouseEvent) => void;
  isDragging: boolean;
  /** The main pane cannot be closed individually; hide the X button. */
  isMainPane?: boolean;
}

export function PaneHeader({ title, paneId, onClose, onDragStart, isDragging, isMainPane }: PaneHeaderProps) {
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={ref}
      data-pane-header=""
      data-pane-id={paneId}
      className={cn(
        "flex h-6 shrink-0 items-center justify-between gap-1 border-b border-[var(--color-border-soft)]",
        "bg-[var(--color-bg-2)] px-1.5 select-none",
        isMainPane ? "cursor-default" : isDragging ? "cursor-grabbing" : "cursor-grab",
      )}
      onMouseDown={(e) => {
        // Ignore right-clicks and clicks on the close button.
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("[data-pane-close]")) return;
        onDragStart(paneId, e);
      }}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[11px] font-medium text-[var(--color-fg-dim)]">
        {isMainPane && (
          <span
            title="Main pane"
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]"
          />
        )}
        {title}
      </span>
      {!isMainPane && (
        <button
          data-pane-close=""
          title="Close pane"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="shrink-0 rounded p-0.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
