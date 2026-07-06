// Drop-zone detection for tab drags (see PaneHeader / useTabStripDrag).
// Dropping in a pane's CENTER moves the tab into that pane; dropping within
// EDGE_FRACTION of an edge splits the pane in half and the tab lands in the
// new half. The overlay CSS (index.css, [data-drop-zone]) mirrors this.

export type DropZone = "center" | "left" | "right" | "top" | "bottom";

const EDGE_FRACTION = 0.2;

export function detectDropZone(rect: DOMRect, x: number, y: number): DropZone {
  if (!rect.width || !rect.height) return "center";
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  if (rx < EDGE_FRACTION) return "left";
  if (rx > 1 - EDGE_FRACTION) return "right";
  if (ry < EDGE_FRACTION) return "top";
  if (ry > 1 - EDGE_FRACTION) return "bottom";
  return "center";
}

/** Apply the drop highlight (overlay + optional split zone) to a host. */
export function setDropHighlight(el: HTMLElement, zone: DropZone): void {
  el.setAttribute("data-drop-target", "");
  if (zone === "center") el.removeAttribute("data-drop-zone");
  else el.setAttribute("data-drop-zone", zone);
}

export function clearDropHighlight(el: HTMLElement | null): void {
  el?.removeAttribute("data-drop-target");
  el?.removeAttribute("data-drop-zone");
}
