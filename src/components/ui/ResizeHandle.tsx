// Thin draggable bar for resizing a panel along one axis. Positioned
// absolutely by the parent — the handle covers a 4px hit area, paints 1px
// on hover so it doesn't add visual clutter unless the user is hunting for it.
//
// Calls `onDrag(delta)` with the pixel delta since the LAST mousemove (not
// since drag start), so consumers can just `state += delta` and clamp.

import { useRef } from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** "x" = vertical bar (drag horizontal); "y" = horizontal bar (drag vertical). */
  direction: "x" | "y";
  onDrag: (delta: number) => void;
  /** Optional: called once when drag starts. */
  onStart?: () => void;
  /** Optional: called once when drag ends (e.g., persist final value). */
  onEnd?: () => void;
  /** When true, the handle paints a visible resting line (use for splits where
   *  the border is the only separator, e.g. the vertical right split). */
  alwaysVisible?: boolean;
  className?: string;
}

export function ResizeHandle({ direction, onDrag, onStart, onEnd, alwaysVisible, className }: Props) {
  const lastRef = useRef<number | null>(null);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    lastRef.current = direction === "x" ? e.clientX : e.clientY;
    document.body.style.cursor = direction === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    // Kill column/row transitions while dragging — otherwise the grid lerps
    // toward each new width and the handle visibly trails the cursor.
    document.documentElement.style.setProperty("--cols-transition", "none");
    document.documentElement.classList.add("is-resizing");
    onStart?.();
    function onMove(ev: MouseEvent) {
      const prev = lastRef.current; if (prev == null) return;
      const cur = direction === "x" ? ev.clientX : ev.clientY;
      onDrag(cur - prev);
      lastRef.current = cur;
    }
    function onUp() {
      lastRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.documentElement.style.removeProperty("--cols-transition");
      document.documentElement.classList.remove("is-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      onEnd?.();
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      onMouseDown={onMouseDown}
      className={cn(
        "absolute z-20 group",
        // 1px wide/tall handle, offset by 1px so it straddles the panel edge.
        // Avoids fractional offsets (`-ml-0.5` = -2px on retina but 0px-ish on
        // 1x → sub-pixel placement); -ml-px is exactly 1 device pixel.
        direction === "x"
          ? alwaysVisible
            ? "top-0 bottom-0 w-[2px] -ml-[2px] cursor-col-resize"
            : "top-0 bottom-0 w-px -ml-px cursor-col-resize"
          : "left-0 right-0 h-px -mt-px cursor-row-resize",
        className,
      )}
      // Hit area is bigger than the visible line — paint via a child that
      // expands on hover so the grab target is forgiving while the resting
      // state stays minimal.
    >
      <div
        className={cn(
          "h-full w-full transition-colors group-hover:bg-[var(--color-accent-soft)] group-active:bg-[var(--color-accent)]",
          alwaysVisible && "bg-[var(--color-border-soft)]",
        )}
      />
      {/* Invisible wider hit area for easier grabbing — 4px on each side of
          the visible 1px handle. */}
      <div
        aria-hidden
        className={cn(
          "absolute",
          direction === "x"
            ? "top-0 bottom-0 -left-2 -right-2"
            : "left-0 right-0 -top-1 -bottom-1",
        )}
      />
    </div>
  );
}
