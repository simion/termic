// The recently-used-tabs walk (⌃⇥ unless rebound): hold the modifier, tap the
// key to step back through the places you were looking at, add Shift to step
// the other way, release the modifier to land.
//
// A pure decision so the fiddly part is testable, exactly like `doubleTap.ts`.
// And the fiddly part is NOT the stepping — it is everything that must NOT end
// the gesture:
//
//   - Pressing Shift to go backwards fires a `keydown` for "Shift" BEFORE the
//     Tab arrives. A naive "any other key ends it" rule makes ⌃⇧⇥ impossible.
//   - Holding Control auto-repeats `keydown` for "Control" the whole time. The
//     same naive rule would end the gesture on the first repeat, a few dozen ms
//     in.
//
// The ring is a SNAPSHOT taken on the first press. Each step changes what is on
// screen, which feeds the recency list the ring came from; walking the live
// list would reorder it under the next keypress.

import type { Place } from "@/store/recentPlaces";
import { samePlace } from "@/store/recentPlaces";

export interface CtrlTabState {
  active: boolean;
  /** The snapshot being walked. Index 0 is where the gesture started, when it
   *  started somewhere at all. */
  ring: Place[];
  /** Where in `ring` we are. -1 means "nowhere in it" — see `buildRing`. */
  index: number;
  /** Where the gesture began, for the departure bookkeeping on landing. */
  origin: Place | null;
}

export const IDLE: CtrlTabState = { active: false, ring: [], index: 0, origin: null };

/** Keys that are part of holding a chord, not a keystroke that interrupts it. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]);

/**
 * The ring for one gesture, plus the index to start from.
 *
 * `current` leads the ring when there is one, so index 0 is "where I already
 * am" and the first tap goes to index 1. It is legitimately absent — the
 * Dashboard and History have no active task while the ring is still full, and
 * `closeTab` moves `activeTab` to a neighbour without going through
 * `setActiveTabId` — and then the first tap must land on index 0 rather than
 * skipping the most recent place. That is what index -1 encodes.
 */
export function buildRing(current: Place | null, mru: Place[]): { ring: Place[]; index: number } {
  if (!current) return { ring: mru, index: -1 };
  return { ring: [current, ...mru.filter(p => !samePlace(p, current))], index: 0 };
}

/**
 * One Tab press. Returns the next state and the place to show, or null when
 * there is nowhere to go (which still CLAIMS the key — see useShortcuts).
 */
export function step(
  state: CtrlTabState,
  opts: { shift: boolean; repeat: boolean; ring: () => { ring: Place[]; index: number } },
): { state: CtrlTabState; target: Place | null } {
  // Holding Tab down repeats the keydown. With no overlay every step is a real
  // content switch, so advancing on repeat would strobe every place in the ring
  // for as long as the key is held. `trackDoubleShift` ignores repeats too.
  if (opts.repeat) return { state, target: null };

  const started = state.active
    ? state
    : (() => {
        const { ring, index } = opts.ring();
        return { active: true, ring, index, origin: index >= 0 ? (ring[index] ?? null) : null };
      })();

  const n = started.ring.length;
  if (n === 0) return { state: started, target: null };
  // Sitting at index 0 of a one-entry ring means the only place there is, is
  // the one already on screen.
  if (started.index >= 0 && n < 2) return { state: started, target: null };

  const index = started.index < 0
    ? (opts.shift ? n - 1 : 0)
    : (opts.shift ? (started.index - 1 + n) % n : (started.index + 1) % n);

  return { state: { ...started, index }, target: started.ring[index] };
}

/**
 * End the gesture. `commit` is the place to land on properly (null when the
 * walk never moved, or wrapped back to where it began); `origin` is where it
 * started, for the departure bookkeeping.
 */
export function end(state: CtrlTabState): {
  state: CtrlTabState;
  commit: Place | null;
  origin: Place | null;
} {
  if (!state.active || state.index < 0) return { state: IDLE, commit: null, origin: state.origin };
  const landed = state.ring[state.index] ?? null;
  const origin = state.origin;
  const moved = landed && (!origin || !samePlace(landed, origin));
  return { state: IDLE, commit: moved ? landed : null, origin };
}

/**
 * Should this keydown end a walk in flight?
 *
 * Modifiers and auto-repeats must not: holding the modifier repeats forever,
 * and Shift is how the walk reverses. Nor does the gesture's own tap key,
 * matched by `code` (`tapCode`, "Tab" unless rebound): with Option held, ` is
 * a dead key and its `key` says "Dead". A real keystroke does end it, and is
 * NOT swallowed — the user meant it for whatever is now on screen.
 */
export function endsGesture(key: string, repeat: boolean, code = "", tapCode = "Tab"): boolean {
  if (repeat) return false;
  if (MODIFIER_KEYS.has(key)) return false;
  if (code === tapCode) return false;
  // A platform that reports no code: the default tap key by name.
  return !(tapCode === "Tab" && key === "Tab");
}
