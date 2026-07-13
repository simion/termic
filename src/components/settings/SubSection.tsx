/** A group of related fields inside a settings card.
 *
 *  The card is already a bordered surface, so a bordered box for the group
 *  nests a frame inside a frame and the two borders read as a mistake. This
 *  instead ends the card's surface and starts a new one: the section bleeds out
 *  to the card's edges (the negative margin cancels the card's px-4 — the one
 *  thing this depends on) and changes background, with a hairline where each
 *  surface begins. The legend uses the faint uppercase style the settings
 *  sections already use for labels, so it reads as a marker for what follows
 *  rather than as another field stacked above it.
 *
 *  bg-3, not bg-2: the card is bg-1, and bg-2 sits 8/255 away from it (#1c1c1c
 *  on #141414), which is invisible. The band then read as a hairline with
 *  nothing behind it. bg-3 is the first token that is a real step off the card
 *  in every theme, so the surface change carries the grouping and the hairline
 *  only sharpens the edge. The fields inside stay on --color-bg, which is now
 *  clearly recessed against the band rather than level with it.
 *
 *  As the LAST child it runs flush to the card's bottom: it eats the card's
 *  bottom padding, drops its own bottom hairline (the card's border is already
 *  there) and rounds its corners to sit inside that border. Without this the
 *  band stopped a padding's width short, so its hairline and the card's ran
 *  parallel with a sliver of the card's background trapped between them — the
 *  same double-border it exists to avoid. Radius is the card's 8px less its
 *  1px border, so the fill meets the border instead of cutting the curve. */
export function SubSection({ title, hint, action, children }: {
  title: string;
  hint?: string;
  /** A control that governs the whole section, e.g. its on/off switch. It sits
   *  on the legend row, so the thing that turns the section off is part of the
   *  section rather than a loose field above it, and the body below is visibly
   *  what it governs. Sections that switch off should render no children. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="-mx-4 space-y-3 border-y border-[var(--color-border)] bg-[var(--color-bg-3)] px-4 py-3 last:-mb-4 last:rounded-b-[7px] last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-faint)]">{title}</div>
          {hint && <div className="mt-1 text-[12px] text-[var(--color-fg-dim)]">{hint}</div>}
        </div>
        {action && <div className="shrink-0 pt-0.5">{action}</div>}
      </div>
      {children}
    </section>
  );
}
