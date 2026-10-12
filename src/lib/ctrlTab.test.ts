import { describe, it, expect } from "vitest";
import { buildRing, step, end, endsGesture, IDLE, type CtrlTabState } from "./ctrlTab";
import type { Place } from "@/store/recentPlaces";

// The stepping is the easy part. What matters is everything that must NOT end
// the gesture (Shift, and Control's own auto-repeat), and the fact that the
// ring is a snapshot — walking the live list would reorder it under the very
// next keypress.

const p = (taskId: string, tabId: string): Place => ({ taskId, tabId });

const A1 = p("A", "1");
const A2 = p("A", "2");
const B1 = p("B", "1");
const C1 = p("C", "1");

/** Drive a whole gesture: `presses` is one entry per Tab tap (true = Shift). */
function walk(current: Place | null, mru: Place[], presses: boolean[]) {
  let state: CtrlTabState = IDLE;
  const targets: (Place | null)[] = [];
  for (const shift of presses) {
    const r = step(state, { shift, repeat: false, ring: () => buildRing(current, mru) });
    state = r.state;
    targets.push(r.target);
  }
  return { targets, ...end(state) };
}

describe("the ⌃⇥ ring", () => {
  it("puts where you are at the head, so the first tap goes to the last place", () => {
    const { ring, index } = buildRing(A1, [A1, B1, C1]);
    expect(ring).toEqual([A1, B1, C1]);
    expect(index).toBe(0);
  });

  it("does not duplicate the current place when the list already holds it", () => {
    // setActiveTab records as you go, so `current` is normally already the head.
    const { ring } = buildRing(B1, [B1, A1]);
    expect(ring).toEqual([B1, A1]);
  });

  it("starts outside the ring when nothing is on screen", () => {
    // The Dashboard and History have no active task, but the ring is still
    // full. The first tap must land on the most recent place, not skip it.
    const { ring, index } = buildRing(null, [A1, B1]);
    expect(ring).toEqual([A1, B1]);
    expect(index).toBe(-1);
  });
});

describe("walking", () => {
  it("goes one back on one tap and two back on two", () => {
    const { targets } = walk(A1, [A1, B1, C1], [false, false]);
    expect(targets).toEqual([B1, C1]);
  });

  it("reverses under Shift", () => {
    // Two forward to C1, then one back should return to B1.
    const { targets } = walk(A1, [A1, B1, C1], [false, false, true]);
    expect(targets).toEqual([B1, C1, B1]);
  });

  it("wraps at both ends", () => {
    const fwd = walk(A1, [A1, B1, C1], [false, false, false]);
    expect(fwd.targets[2]).toEqual(A1);          // past the end, back home
    const back = walk(A1, [A1, B1, C1], [true]);
    expect(back.targets[0]).toEqual(C1);         // first tap backwards = last
  });

  it("lands on the most recent place when it starts from nowhere", () => {
    const { targets } = walk(null, [A1, B1], [false]);
    expect(targets).toEqual([A1]);
  });

  it("does nothing when the only place in the ring is the one on screen", () => {
    const { targets, commit } = walk(A1, [A1], [false, false]);
    expect(targets).toEqual([null, null]);
    expect(commit).toBeNull();
  });

  it("does nothing when the ring is empty", () => {
    const { targets, commit } = walk(null, [], [false]);
    expect(targets).toEqual([null]);
    expect(commit).toBeNull();
  });

  it("does not advance on auto-repeat", () => {
    // Holding Tab down repeats the keydown. Every step is a real content
    // switch, so advancing would strobe the whole ring while the key is held.
    let state: CtrlTabState = IDLE;
    const ring = () => buildRing(A1, [A1, B1, C1]);
    const first = step(state, { shift: false, repeat: false, ring });
    state = first.state;
    const held = step(state, { shift: false, repeat: true, ring });
    expect(held.target).toBeNull();
    expect(held.state.index).toBe(first.state.index);
  });

  it("walks the snapshot, not a list that moved underneath it", () => {
    // Each step changes what is on screen, which is what feeds the recency
    // list. If the ring were re-read per press, the second tap would walk a
    // list whose order the first tap had just changed.
    const mru = [A1, B1, C1];
    let state: CtrlTabState = IDLE;
    const r1 = step(state, { shift: false, repeat: false, ring: () => buildRing(A1, mru) });
    state = r1.state;
    // Simulate the live list reordering exactly as recording B1 would.
    mru.splice(0, mru.length, B1, A1, C1);
    const r2 = step(state, { shift: false, repeat: false, ring: () => buildRing(B1, mru) });
    expect(r1.target).toEqual(B1);
    expect(r2.target).toEqual(C1);   // not A1, which the moved list would give
  });
});

describe("landing", () => {
  it("commits the place it stopped on", () => {
    const { commit, origin } = walk(A1, [A1, B1, C1], [false, false]);
    expect(commit).toEqual(C1);
    expect(origin).toEqual(A1);
  });

  it("commits nothing when the walk wrapped back to where it began", () => {
    // Three taps around a three-entry ring. Landing where you started must not
    // re-run the arrival bookkeeping for a place you never left.
    const { commit } = walk(A1, [A1, B1, C1], [false, false, false]);
    expect(commit).toBeNull();
  });

  it("commits nothing when no tap ever moved", () => {
    expect(end(IDLE).commit).toBeNull();
  });

  it("reports the origin so the departure reset can be scoped to a real move", () => {
    const { origin } = walk(A2, [A2, A1], [false]);
    expect(origin).toEqual(A2);
  });
});

describe("what interrupts a walk", () => {
  it("is not ended by the Shift that reverses it", () => {
    // ⌃⇧⇥ fires keydown "Shift" BEFORE the Tab. Ending on it makes walking
    // backwards impossible.
    expect(endsGesture("Shift", false)).toBe(false);
  });

  it("is not ended by Control repeating while it is held", () => {
    expect(endsGesture("Control", true)).toBe(false);
    expect(endsGesture("Control", false)).toBe(false);
  });

  it("is not ended by the Tab presses that drive it", () => {
    expect(endsGesture("Tab", false)).toBe(false);
  });

  it("is not ended by any other modifier being taken up mid-hold", () => {
    for (const k of ["Alt", "Meta", "CapsLock"]) {
      expect(endsGesture(k, false)).toBe(false);
    }
  });

  it("is ended by a real keystroke", () => {
    expect(endsGesture("c", false)).toBe(true);
    expect(endsGesture("Enter", false)).toBe(true);
  });

  it("is not ended by a repeat of a real keystroke either", () => {
    // The first press already ended it; a repeat arriving after that must not
    // be read as a second interruption.
    expect(endsGesture("c", true)).toBe(false);
  });
});

describe("what interrupts a walk on a rebound gesture", () => {
  it("is not ended by its own tap key, matched by code", () => {
    // Option + ` on macOS: the key is a dead key and says "Dead". The code is
    // the physical key, which is what the gesture recorded.
    expect(endsGesture("Dead", false, "Backquote", "Backquote")).toBe(false);
    expect(endsGesture("`", false, "Backquote", "Backquote")).toBe(false);
  });

  it("is ended by Tab once Tab is not the gesture's key", () => {
    expect(endsGesture("Tab", false, "Tab", "Backquote")).toBe(true);
  });

  it("is not ended by the held Option, nor AltGr", () => {
    expect(endsGesture("Alt", true, "AltLeft", "Backquote")).toBe(false);
    expect(endsGesture("AltGraph", false, "AltRight", "Backquote")).toBe(false);
  });

  it("is ended by a real keystroke", () => {
    expect(endsGesture("j", false, "KeyJ", "Backquote")).toBe(true);
  });

  it("still knows Tab by name where the code is missing", () => {
    expect(endsGesture("Tab", false, "", "Tab")).toBe(false);
    expect(endsGesture("Tab", false, "Tab", "Tab")).toBe(false);
  });
});
