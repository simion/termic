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
import { useUI } from "@/store/ui";

// Per-terminal drop metadata. We store getters (not bare values) so a Restart
// that mints a fresh pty id — or a sandbox toggle that flips mid-session — is
// picked up at drop time without the component having to re-register.
//   ptyId     — the terminal's CURRENT pty id, or null when the PTY has exited.
//   taskId      — owning task (used to stage files into a per-task temp dir).
//   sandboxed — whether THIS terminal's process runs under the seatbelt. Only
//               the agent PTY is sandboxed; the scratch shell never is, so it
//               always inserts the raw path with no prompt.
interface DropTarget {
  ptyId: () => string | null;
  taskId: string;
  sandboxed: () => boolean;
}
const targets = new Map<HTMLElement, DropTarget>();

export function registerTerminalDropTarget(
  host: HTMLElement,
  ptyId: () => string | null,
  opts?: { taskId?: string; sandboxed?: () => boolean },
): () => void {
  targets.set(host, {
    ptyId,
    taskId: opts?.taskId ?? "",
    sandboxed: opts?.sandboxed ?? (() => false),
  });
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

function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : p;
}

// Write space-joined escaped paths into the PTY, as if typed at the prompt.
function writePaths(ptyId: string, paths: string[]): void {
  const text = paths.map(shellEscapePath).join(" ") + " ";
  ipc.ptyWrite(ptyId, Array.from(new TextEncoder().encode(text))).catch(() => {});
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
    const target = targets.get(host);
    const ptyId = target?.ptyId() ?? null;
    if (!target || !ptyId) return;           // terminal present but PTY exited
    const paths = p.paths.slice();

    // Unsandboxed terminals (scratch shell, non-sandboxed agents): insert the
    // raw path immediately, exactly like macOS Terminal. No prompt.
    if (!target.sandboxed()) {
      writePaths(ptyId, paths);
      return;
    }

    // Sandboxed agent: the seatbelt denies common drop sources (Desktop,
    // Downloads, …), so ask the user how to share the file. Async — the
    // listener callback can't await, so we kick off a promise.
    void handleSandboxedDrop(ptyId, target.taskId, paths);
  });
}

/** Prompt the user, then act on their choice for a drop onto a sandboxed
 *  agent. Kept out of the listener so the event callback stays sync. */
async function handleSandboxedDrop(ptyId: string, taskId: string, paths: string[]): Promise<void> {
  const ui = useUI.getState();
  const choice = await ui.askTerminalDrop({ paths, taskId });

  if (choice.kind === "cancel") return;

  if (choice.kind === "temp") {
    // Stage each file into TMPDIR (sandbox-readable) and insert those paths.
    const staged: string[] = [];
    for (const src of paths) {
      try { staged.push(await ipc.terminalStageFile(taskId, src)); }
      catch (e) { useUI.getState().pushToast(`Couldn't stage ${src}: ${e}`, "error"); }
    }
    if (staged.length > 0) writePaths(ptyId, staged);
    return;
  }

  // allow-folder / allow-file: add to the sandbox allow-list, insert the REAL
  // path, and tell the user it needs an agent restart to take effect (the
  // running process still holds the old profile).
  const toAllow = choice.kind === "allow-folder"
    ? Array.from(new Set(paths.map(parentDir)))
    : paths.slice();
  let added = 0;
  for (const path of toAllow) {
    try { await ipc.taskSandboxAddAllowedPath(taskId, path); added++; }
    catch (e) { useUI.getState().pushToast(`Couldn't allow ${path}: ${e}`, "error"); }
  }
  writePaths(ptyId, paths);
  if (added > 0) {
    useUI.getState().pushToast(
      "Path allowed. Restart the agent for the sandbox to pick it up.",
      "success",
    );
  }
}
