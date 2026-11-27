// "The user just came back." One signal, derived from the only thing that
// proves somebody is looking: input. Every keystroke, click and wheel tick
// stamps `lastSeen`; the first one to land AWAY_MS or more after the previous
// stamp is a return from absence and fans out to the subscribers.
//
// Window focus and visibilitychange count as input too, but they are not
// enough on their own. The case this exists for: a laptop driven over Screen
// Sharing, Termic frontmost, caffeinate holding the system awake, the
// display left to sleep. Every Claude pane blank on return, never on a
// desktop. That setup never blurs the window or hides the document, so the
// renderer's focus/visibility probe never runs, and WebKit delivered no loss
// event, no restore event, and `isContextLost()` stayed false: from JS a
// blank renderer is indistinguishable from a healthy one. The first input
// after a long gap is the one edge that setup still has, and the terminal
// renderer rebuilds on it without asking (loadTerminalRenderer).
//
// Cost: one Date.now() and a subtraction per input event, no store, no
// allocation. Installed once from main.tsx like the other window listeners.

// 10 minutes: long enough that watching an agent work is never "away" (a
// rebuild rides the first input after the gap, synchronously, on every
// mounted pane's next reveal too, so routine idle must not trip it), short
// enough to beat any display-sleep timer that produces the blank state.
export const AWAY_MS = 10 * 60_000;

type Listener = (awayMs: number) => void;
const listeners = new Set<Listener>();
let lastSeen = Date.now();
let initialized = false;

function seen(): void {
  const now = Date.now();
  const away = now - lastSeen;
  lastSeen = now;
  if (away < AWAY_MS) return;
  for (const l of listeners) { try { l(away); } catch { /* one bad subscriber must not starve the rest */ } }
}

export function initUserPresence(): void {
  if (initialized) return;
  initialized = true;
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  window.addEventListener("keydown", seen, opts);
  window.addEventListener("pointerdown", seen, opts);
  window.addEventListener("wheel", seen, opts);
  window.addEventListener("focus", seen);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") seen();
  });
}

/** Milliseconds since the last input Termic itself saw (the stand-in for
 *  system idle time where the OS gives none, src-tauri/src/push.rs). */
export function sinceLastInput(): number {
  return Date.now() - lastSeen;
}

/** Run `listener` on the first input after AWAY_MS or more without any.
 *  Returns the unsubscribe. */
export function onReturnFromAway(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
