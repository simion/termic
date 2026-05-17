// Termic logo — terminal frame with prompt + blinking cursor.
//
// Three variants:
//   <TermicMark />     — square icon, just the frame (favicon / app bar)
//   <TermicWordmark /> — "termic" text + animated cursor (in-page banners)
//   <TermicHero />     — large combined mark + wordmark for the empty state
//
// All use currentColor for strokes; pair with a colored wrapper to tint.
// Cursor blink is CSS animation (no JS timer).

import { cn } from "@/lib/utils";

const blinkStyle = `
  @keyframes termic-cursor-blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }
  .termic-cursor { animation: termic-cursor-blink 1.05s steps(1) infinite; }
  @keyframes termic-glow {
    0%, 100% { filter: drop-shadow(0 0 0px var(--color-accent)); }
    50%      { filter: drop-shadow(0 0 3px var(--color-accent-soft)); }
  }
  .termic-frame { animation: termic-glow 4s ease-in-out infinite; }

  /* Draw-in: each cell starts invisible + small-scale, pops to full size
     after its delay. Delay is set inline per-cell so columns scan left-to-right
     like a typewriter. Once the last cell lands, the cursor takes over its
     normal blink. */
  @keyframes termic-cell-in {
    0%   { opacity: 0; transform: scale(0.4); }
    60%  { opacity: 1; transform: scale(1.08); }
    100% { opacity: 1; transform: scale(1); }
  }
  .termic-cell-in {
    opacity: 0;
    transform-box: fill-box;
    transform-origin: center;
    animation: termic-cell-in 320ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
  }
`;

/** Square icon — pixelated "T" matching the Blockmark wordmark style.
 *  Same dotted-cell aesthetic as the dashboard hero so the brand reads
 *  consistently from favicon (1×T) to wordmark (TERMIC▮). Layout: 7×7
 *  square grid; the 5-wide crossbar sits on row 0 centered horizontally
 *  (cols 1–5), the vertical stem runs down col 3. One-pixel padding on
 *  the left/right keeps the icon visually centered in a square viewBox. */
export function TermicMark({ size = 32, className }: { size?: number; className?: string }) {
  const cellSize = 4;
  const gap = 1;
  const rows = 7;
  const cols = 7;
  const w = cols * (cellSize + gap) - gap;
  const h = rows * (cellSize + gap) - gap;
  // crossbar cols 1..5 on row 0, stem at col 3 rows 1..6
  const cells: Array<{ r: number; c: number }> = [];
  for (let c = 1; c <= 5; c++) cells.push({ r: 0, c });
  for (let r = 1; r <= 6; r++) cells.push({ r, c: 3 });
  return (
    <span className={cn("inline-flex shrink-0 text-[var(--color-accent)]", className)} aria-hidden>
      <svg width={size} height={size} viewBox={`0 0 ${w} ${h}`}>
        {cells.map(({ r, c }) => (
          <rect
            key={`${r}-${c}`}
            x={c * (cellSize + gap)}
            y={r * (cellSize + gap)}
            width={cellSize} height={cellSize}
            rx={Math.max(0, cellSize * 0.2)}
            fill="currentColor"
          />
        ))}
      </svg>
    </span>
  );
}

/** Wordmark — "termic" + blinking cursor. Use inline next to the mark. */
export function TermicWordmark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 font-mono font-semibold text-[var(--color-fg)]", className)}
      style={{ fontSize: size, lineHeight: 1, letterSpacing: "-0.02em" }}
      aria-hidden
    >
      <style>{blinkStyle}</style>
      <span>termic</span>
      <span
        className="termic-cursor inline-block"
        style={{
          width: size * 0.55,
          height: size * 0.85,
          background: "var(--color-accent)",
          marginLeft: 2,
          borderRadius: 1,
        }}
      />
    </span>
  );
}

/** Hero combo — mark + wordmark + tagline. For the empty state. */
export function TermicHero({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-4", className)}>
      <div className="flex items-center gap-4">
        <TermicMark size={56} />
        <TermicWordmark size={36} />
      </div>
      <div className="text-[12.5px] text-[var(--color-fg-faint)] uppercase tracking-[0.25em]">
        many agents · one window
      </div>
    </div>
  );
}

// ── Block-art variant ────────────────────────────────────────────────────────
// 5×7 pixel bitmaps for each letter. `1` = filled cell, `0` = empty. Designed
// by hand so the kerning and weight match — auto-pixelating a font usually
// looks worse at this scale.
const LETTER: Record<string, string[]> = {
  T: ["11111","00100","00100","00100","00100","00100","00100"],
  E: ["11111","10000","10000","11110","10000","10000","11111"],
  R: ["11110","10001","10001","11110","10100","10010","10001"],
  M: ["10001","11011","10101","10101","10001","10001","10001"],
  I: ["11111","00100","00100","00100","00100","00100","11111"],
  C: ["01111","10000","10000","10000","10000","10000","01111"],
};

/** Block-art wordmark: each letter rendered as a 5×7 grid of small squares.
 *  Square cells (not stretched rectangles like LED segments) — distinct from
 *  Termic's style. Optional cursor block blinks after the final letter. */
export function TermicBlockmark({
  cellSize = 8,
  gap = 1,
  letters = "TERMIC",
  className,
  cursor = true,
  /** When true, cells fade in column-by-column on mount (typewriter feel). */
  animate = true,
  /** Per-column delay in ms during the draw-in animation. */
  columnStepMs = 35,
}: {
  cellSize?: number;
  gap?: number;
  letters?: string;
  className?: string;
  cursor?: boolean;
  animate?: boolean;
  columnStepMs?: number;
}) {
  const chars = letters.toUpperCase().split("");
  const rows = 7;
  const letterCols = 5;
  const totalCols =
    chars.length * letterCols +
    (chars.length - 1) +
    (cursor ? 3 : 0);

  const w = totalCols * (cellSize + gap) - gap;
  const h = rows * (cellSize + gap) - gap;

  // Build all <rect>s up front. Per-cell `animation-delay` is computed from
  // the global column index so the reveal sweeps left-to-right (typewriter).
  const rects: React.ReactElement[] = [];
  let colOffset = 0;
  for (let li = 0; li < chars.length; li++) {
    const glyph = LETTER[chars[li]];
    if (!glyph) { colOffset += letterCols + 1; continue; }
    for (let r = 0; r < rows; r++) {
      const row = glyph[r];
      for (let c = 0; c < letterCols; c++) {
        if (row[c] === "1") {
          const globalCol = colOffset + c;
          rects.push(
            <rect
              key={`${li}-${r}-${c}`}
              x={globalCol * (cellSize + gap)}
              y={r * (cellSize + gap)}
              width={cellSize} height={cellSize}
              rx={Math.max(0, cellSize * 0.2)}
              fill="currentColor"
              className={animate ? "termic-cell-in" : undefined}
              style={animate ? { animationDelay: `${globalCol * columnStepMs}ms` } : undefined}
            />,
          );
        }
      }
    }
    colOffset += letterCols + 1;
  }
  if (cursor) {
    colOffset += 1;
    // Cursor reveals last, then transitions into the perpetual blink. Two
    // separate animations chained via delay: cell-in for the reveal, then
    // the blink takes over (since both target opacity, the final-state
    // opacity from cell-in is `1`, so the blink can pick up cleanly).
    const cursorDelay = animate ? colOffset * columnStepMs + 80 : 0;
    rects.push(
      <rect
        key="cursor"
        x={colOffset * (cellSize + gap)}
        y={0}
        width={cellSize * 2 + gap}
        height={h}
        rx={Math.max(0, cellSize * 0.2)}
        fill="var(--color-accent)"
        className={animate ? "termic-cell-in termic-cursor" : "termic-cursor"}
        style={animate ? {
          animationDelay: `${cursorDelay}ms, ${cursorDelay + 320}ms`,
          animationFillMode: "forwards, none",
        } : undefined}
      />,
    );
  }

  return (
    <span className={cn("inline-block leading-none text-[var(--color-fg)]", className)} aria-label={letters}>
      <style>{blinkStyle}</style>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>{rects}</svg>
    </span>
  );
}
