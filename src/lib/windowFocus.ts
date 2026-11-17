// Whether Termic's window has OS focus, as one synchronous fact.
//
// `isUserWatchingIn` decides whether a finished turn earns a badge, and it used
// to ask only whether a window EXISTS (`windowless`). A Termic open behind the
// user's browser therefore counted as watched, so an agent finishing while they
// were in another app was treated as already seen: no badge, no bell, and
// nothing waiting when they came back. The window existing is not the same as
// somebody looking at it.
//
// Installed once from main.tsx, next to the other window listeners.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUI } from "@/store/ui";

let initialized = false;
/** E2E only (`pinWindowFocus`): the focus a spec stated, held against the
 *  real desktop's events. Null in the app, always. */
let pinned: boolean | null = null;

/** Hold the window's focus at `v` whatever real focus events say, or let them
 *  decide again with null. For e2e specs: the invisible test window never
 *  has real focus, so any focus, blur or visibilitychange from the desktop it
 *  runs on (someone using the machine) re-read `document.hasFocus()` as false
 *  and undid the presence a spec had just set. */
export function pinWindowFocus(v: boolean | null): void {
  pinned = v;
  if (v === null) sync();
  else useUI.getState().setWindowFocused(v);
}

/** `document.hasFocus()` is the truth; the events only say when to re-ask it.
 *  Inferring focus from which event arrived gets it wrong when they interleave
 *  (a blur and a visibilitychange during a Space switch), and the answer is
 *  cheap enough to just read. */
function sync(): void {
  if (pinned !== null) return;
  let focused = true;
  try {
    focused = document.visibilityState !== "hidden" && document.hasFocus();
  } catch {
    // No document (tests, teardown). "Focused" is the conservative default:
    // it suppresses badges rather than inventing them.
  }
  useUI.getState().setWindowFocused(focused);
}

export function initWindowFocus(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);
  // The AUTHORITATIVE source, and the reason the DOM listeners above are not
  // enough on their own. They fire when the WEBVIEW's focus changes, which is
  // not the same event as the OS window gaining focus: cmd-tabbing back to
  // Termic left `document.hasFocus()` reporting stale, so a badge earned while
  // the user was away survived their return and only cleared when they clicked
  // a task. Reported exactly that way. Tauri reports the window's own focus, so
  // it is used verbatim rather than as a cue to re-read the DOM.
  getCurrentWindow()
    .onFocusChanged(({ payload: focused }) => {
      if (pinned !== null) return;
      useUI.getState().setWindowFocused(focused);
    })
    .catch(() => {
      // No Tauri (vitest, a browser preview). The DOM listeners still apply.
    });
  sync();
}
