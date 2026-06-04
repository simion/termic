import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { logLine } from "@/lib/ipc";
import { initTerminalDropHandler } from "@/lib/terminalDrop";

// StrictMode disabled: it double-mounts effects in dev, which races our async
// PTY spawn flow (first spawn gets killed by the strict teardown before its
// listeners are wired). The xterm/PTY pipeline is genuinely stateful and is
// not happy with the double-invoke discipline. Re-enable if we add expensive
// pure effects that benefit from the duplicate-call check.

// Suppress the WKWebView native right-click context menu app-wide. xterm
// terminals and CodeMirror still get their selection/copy via keyboard
// shortcuts; we don't want browser-style "Reload"/"Inspect" menus showing.
window.addEventListener("contextmenu", (e) => e.preventDefault());

// Mirror uncaught errors + unhandled promise rejections to the Rust-side
// debug log so they show up in the dev terminal (`/var/folders/.../T/
// conductor-debug.log`) instead of being trapped inside the WKWebView
// console only. Also keep them in console.error so devtools sees them too.
function forwardError(label: string, message: string, stack?: string) {
  // eslint-disable-next-line no-console
  console.error(`[${label}]`, message, stack);
  logLine(`${label}: ${message}${stack ? "\n" + stack : ""}`).catch(() => {});
}
window.addEventListener("error", (e) => {
  forwardError("window.error", String(e.message), e.error?.stack);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  forwardError("unhandledrejection", String(r?.message ?? r), r?.stack);
});

createRoot(document.getElementById("root")!).render(<App />);

// App-wide terminal drag-and-drop: dropping a file onto a terminal inserts
// its path at the prompt (like macOS Terminal). One native Tauri listener for
// the whole app — see src/lib/terminalDrop.ts for why the browser DnD API
// can't be used here. Fire-and-forget; failure just means no drop support.
initTerminalDropHandler().catch(() => {});
