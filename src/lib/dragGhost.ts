// Floating drag ghost: a small labeled pill that follows the cursor while a
// tab is being dragged, so it's always obvious a drag is in progress — the
// pill in the strip barely moves (reorder) or doesn't move at all (cross-pane
// drag), which read as "nothing is happening". One singleton node on <body>;
// styling in index.css (.termic-drag-ghost).

let el: HTMLElement | null = null;

export function showDragGhost(label: string, x: number, y: number): void {
  if (!el) {
    el = document.createElement("div");
    el.className = "termic-drag-ghost";
    document.body.appendChild(el);
  }
  el.textContent = label;
  moveDragGhost(x, y);
}

export function moveDragGhost(x: number, y: number): void {
  if (el) el.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
}

export function hideDragGhost(): void {
  el?.remove();
  el = null;
}
