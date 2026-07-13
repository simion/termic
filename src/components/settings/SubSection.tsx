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
 *  Don't place one flush against the card's top or bottom edge: the band is
 *  square and the card is rounded, so it would poke through the corner. */
export function SubSection({ title, hint, children }: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="-mx-4 space-y-3 border-y border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-4 py-3">
      <div>
        <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-faint)]">{title}</div>
        {hint && <div className="mt-1 text-[12px] text-[var(--color-fg-dim)]">{hint}</div>}
      </div>
      {children}
    </section>
  );
}
