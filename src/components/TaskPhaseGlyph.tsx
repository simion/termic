// The derived phase, as one monochrome glyph.
//
// WHY A GLYPH AND NOT A COLOURED CHIP. PR #292 shipped a coloured status
// square beside the PR chip and it was rejected: the two used one colour
// vocabulary for different meanings (purple was "merged" on the chip and "In
// review" on the square), so a row could show both at once and contradict
// itself. The first version of this feature over-corrected and drew nothing
// at all, which left three of the five phases invisible on a row and the
// other two legible only by accident, because the PR chip happened to be
// there.
//
// Shape carries the phase, colour stays the PR chip's. That is what actually
// answers #292: the collision was a colour collision, and two marks that
// cannot disagree are redundant at worst. They cannot disagree here because
// the phase is DERIVED from the PR state, so a merged PR IS Done.
//
// The chip is also not purely redundant. It says things the phase throws away
// on purpose: failing checks (red) and draft, because CI status is a property
// of the work rather than a stage of it. One mark answers "where does this
// stand", the other answers "what does the forge say".
//
// Monochrome also means the phase survives for a colourblind reader, which
// the chip alone never did.

import { Circle, Contrast, CircleDot, CircleCheck, Moon, type LucideIcon } from "lucide-react";
import { PHASE_LABEL, type TaskPhase } from "@/lib/taskPhase";
import { cn } from "@/lib/utils";

/** Shapes read as a progression, in the vocabulary GitHub and Linear already
 *  taught: empty ring, half filled, something to look at, done. Parked is the
 *  odd one out on purpose, because it is not a stage of that progression, and
 *  it reuses the Moon the Park menu item and dialog already carry. */
const PHASE_ICON: Record<TaskPhase, LucideIcon> = {
  todo: Circle,
  in_progress: Contrast,
  in_review: CircleDot,
  done: CircleCheck,
  parked: Moon,
};

/**
 * `note` is appended to the tooltip when there is one (today: a park reason),
 * so "blocked on the API key" has somewhere to live now that the row no
 * longer spells "Parked" out in words.
 */
export function TaskPhaseGlyph({ phase, note, className }: {
  phase: TaskPhase;
  note?: string;
  className?: string;
}) {
  const Icon = PHASE_ICON[phase];
  const label = phaseGlyphTitle(phase, note);
  return (
    // The wrapper carries the testid, the phase and the tooltip together, on
    // purpose. `title` on an <svg> is not reliably rendered as a tooltip, and
    // splitting the three across two nodes would leave a spec reading the
    // phase off one element and the reason off another.
    <span
      data-testid="task-phase"
      data-phase={phase}
      title={label}
      aria-label={label}
      className={cn("flex shrink-0 items-center text-[var(--color-fg-faint)]", className)}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

/** The tooltip string. Exported because the sidebar will want the same words
 *  if the glyph ever lands on a task row there. */
export function phaseGlyphTitle(phase: TaskPhase, note?: string): string {
  return note ? `${PHASE_LABEL[phase]}: ${note}` : PHASE_LABEL[phase];
}
