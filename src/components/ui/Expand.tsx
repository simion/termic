// Opens and shuts a block with a short height + fade, for the sidebar's
// projects, folders and task groups. Closed content still unmounts (the
// sidebar stays as cheap as it was): it is held for the exit animation only.
//
// The wrapper is the SAME element in every phase, `display: contents` while
// still, so toggling never remounts the rows inside and adds no box to the
// layout. It animates grid-template-rows 0fr <-> 1fr, which reaches the
// content's natural height without measuring it. Nothing animates on first
// mount, so a window opening does not ripple.

import { useLayoutEffect, useRef, useState } from "react";

export const EXPAND_MS = 240; // matches the CSS animations in index.css

export function Expand({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [held, setHeld] = useState(open);
  const [phase, setPhase] = useState<"in" | "out" | null>(null);
  const first = useRef(true);

  // Layout effect: the phase class lands before the first paint of a newly
  // opened block, so it never flashes at full height first.
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    setHeld(true);
    setPhase(open ? "in" : "out");
    const t = window.setTimeout(() => {
      setPhase(null);
      if (!open) setHeld(false);
    }, EXPAND_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open && !held) return null;
  return (
    <div className={phase ? `termic-expand-${phase}` : "contents"}>
      <div className={phase ? "min-h-0 overflow-hidden" : "contents"}>{children}</div>
    </div>
  );
}
