// Drag-and-drop file paths into terminals — macOS Terminal.app / iTerm2 parity.
//
// Termic runs inside a Tauri WKWebView, and Tauri's native file-drop (the
// window's `dragDropEnabled`, which defaults to true) intercepts an OS drag
// BEFORE the webview's HTML5 `drop` event would ever fire. So the usual
// browser drag-and-drop route is a dead end on two counts: the DOM `drop`
// event never arrives, AND WKWebView wouldn't expose the dropped File's real
// filesystem path even if it did (a webview security restriction). Tauri's
// native `onDragDropEvent` is the only place the absolute paths surface —
// together with the physical-pixel drop point.
//
// We register ONE window-level listener and route each drop to whichever
// terminal sits under the cursor, writing the file path(s) into that
// terminal's PTY through the exact same byte channel as a keystroke
// (ipc.ptyWrite). To the agent CLI it's indistinguishable from the user
// typing the path — which is precisely what dragging a screenshot into iTerm
// does today, so paths land in a shape claude/gemini/codex already parse.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as ipc from "@/lib/ipc";

// host element → getter for that terminal's CURRENT pty id (or null when the
// PTY has exited). Each TerminalPane / AuxTerminal registers its xterm host on
// mount and removes it on unmount. We store a getter rather than a bare string
// so a Restart that mints a fresh pty id is picked up at drop time without the
// component having to re-register.
const targets = new Map<HTMLElement, () => string | null>();

export function registerTerminalDropTarget(
  host: HTMLElement,
  ptyId: () => string | null,
): () => void {
  targets.set(host, ptyId);
  return () => { targets.delete(host); };
}

// Backslash-escape every character outside a conservative safe set, mirroring
// how macOS Terminal.app / iTerm2 insert a dragged file's path. This is the
// exact shape the agent CLIs already receive when you drag a screenshot into
// iTerm, so spaces / parens / $ / & / etc. survive verbatim into the prompt
// (or into a plain shell, where the escaping is also correct).
function shellEscapePath(p: string): string {
  return p.replace(/[^A-Za-z0-9._/-]/g, "\\$&");
}

// Walk up from the drop point to the nearest registered terminal host. Returns
// the host element, or null if the drop landed outside any terminal (editor,
// file tree, diff pane, sidebar, …) — those drops are left untouched.
function hostForPoint(xCss: number, yCss: number): HTMLElement | null {
  let el = document.elementFromPoint(xCss, yCss) as HTMLElement | null;
  while (el) {
    if (targets.has(el)) return el;
    el = el.parentElement;
  }
  return null;
}

// ── Drop highlight ─────────────────────────────────────────────────────────
// Outline the terminal a drop would land in, so the target is obvious mid-drag.
// The class paints an inset ring via box-shadow (see index.css); box-shadow
// doesn't affect layout, so it can't perturb xterm's fit()/cell grid.
const HILITE = "termic-drop-target";
let hilited: HTMLElement | null = null;

function setHighlight(host: HTMLElement | null): void {
  if (hilited === host) return;
  hilited?.classList.remove(HILITE);
  host?.classList.add(HILITE);
  hilited = host;
}

let unlisten: UnlistenFn | null = null;

// Register the single app-wide drag-drop listener. Call once at startup.
export async function initTerminalDropHandler(): Promise<void> {
  // Idempotent: a second call (e.g. an HMR module re-eval in dev) must not
  // stack a second listener that would double-insert every dropped path.
  if (unlisten) return;
  unlisten = await getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    // Tauri reports the drop point in PHYSICAL pixels; document.elementFromPoint
    // wants CSS pixels. (Testing heads-up: with devtools open the reported
    // position can be inaccurate — a documented Tauri limitation. Detach the
    // debugger to verify drop targeting.)
    const dpr = window.devicePixelRatio || 1;

    if (p.type === "enter" || p.type === "over") {
      setHighlight(hostForPoint(p.position.x / dpr, p.position.y / dpr));
      return;
    }
    if (p.type === "leave") {
      setHighlight(null);
      return;
    }
    // p.type === "drop"
    setHighlight(null);
    if (!p.paths || p.paths.length === 0) return;
    const host = hostForPoint(p.position.x / dpr, p.position.y / dpr);
    if (!host) return;                       // dropped outside any terminal
    const ptyId = targets.get(host)?.() ?? null;
    if (!ptyId) return;                      // terminal present but PTY exited
    const text = p.paths.map(shellEscapePath).join(" ") + " ";
    ipc.ptyWrite(ptyId, Array.from(new TextEncoder().encode(text))).catch(() => {});
  });
}
