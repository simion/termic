// MUST be first: migrates renamed localStorage keys (workspace -> task) before
// any store module reads them at init. See src/lib/lsMigration.ts.
import "@/lib/lsMigration";
import { createRoot } from "react-dom/client";
import "./index.css";
// GH #70: register + start loading the terminal's owned JetBrains Mono faces at
// boot so the WebGL glyph-atlas gate (lib/terminalFontReady) resolves before the
// first terminal spawns, not on first paint.
import "@/lib/terminalFontReady";
import { App } from "./App";
import { logLine } from "@/lib/ipc";
import { initTerminalDropHandler } from "@/lib/terminalDrop";
import { initWindowlessMode } from "@/lib/windowlessMode";
import { initModKeyClass } from "@/lib/modKeyClass";

// StrictMode disabled: it double-mounts effects in dev, which races our async
// PTY spawn flow (first spawn gets killed by the strict teardown before its
// listeners are wired). The xterm/PTY pipeline is genuinely stateful and is
// not happy with the double-invoke discipline. Re-enable if we add expensive
// pure effects that benefit from the duplicate-call check.

// Suppress the WKWebView native right-click context menu app-wide. xterm
// terminals and CodeMirror still get their selection/copy via keyboard
// shortcuts; we don't want browser-style "Reload"/"Inspect" menus showing.
window.addEventListener("contextmenu", (e) => e.preventDefault());

// Boot marker: lets us confirm a webview reload actually picked up the latest
// frontend bundle (Vite HMR does NOT hot-apply store changes). Grep the debug
// log for this tag after ⌘R; if it's missing, you're on stale code.
logLine("[termic] boot build=resume-fix-v3-sidebar-bypass").catch(() => {});

// Test/automation hooks: expose the zustand stores + ipc wrappers on
// `window.__termic` so tests reach real app state/IPC instead of scraping
// the DOM. Available in `tauri dev` (the automation.rs bridge, see
// docs/automation.md) AND in the WebdriverIO e2e binary, which is a
// production frontend build but is compiled with VITE_E2E=1 (see the
// `e2e:build` npm script + the `e2e` skill). Tree-shaken out of real
// release bundles: both flags are statically false there.
if (import.meta.env.DEV || import.meta.env.VITE_E2E) {
  void (async () => {
    const [app, ui, prefs, race, ipc, core, runTabs, scriptRuns, prompts, agentRace, signalLog, reviewComments, deepLink] =
      await Promise.all([
        import("@/store/app"),
        import("@/store/ui"),
        import("@/store/prefs"),
        import("@/store/race"),
        import("@/lib/ipc"),
        import("@tauri-apps/api/core"),
        import("@/lib/runTabs"),
        import("@/store/scriptRuns"),
        import("@/store/prompts"),
        import("@/lib/agentRace"),
        import("@/lib/agentSignalLog"),
        import("@/store/reviewComments"),
        import("@/lib/deepLink"),
      ]);
    (window as unknown as Record<string, unknown>).__termic = {
      useApp: app.useApp,
      useUI: ui.useUI,
      usePrefs: prefs.usePrefs,
      useRace: race.useRace,
      ipc,
      invoke: core.invoke,
      runTabs,
      scriptRuns: scriptRuns.useScriptRuns,
      // Prompt library (localStorage-backed): exposed so the reorder-drag spec
      // can snapshot the order in before() and put it back in after() — the
      // profile must be left byte-identical (see the signal-inspector note).
      usePromptLibrary: prompts.usePromptLibrary,
      agentRace,
      // Queued inline review comments: the e2e suite asserts what a selection
      // actually queued (line range + quote), which no DOM surface spells out
      // in full — the card shows a label, not the anchored text.
      useReviewComments: reviewComments.useReviewComments,
      // The observed-title buffer behind Settings → Agents' signal inspector.
      // Exposed so specs can drive recordTitle/noteSubmit/noteDone directly —
      // the same functions TerminalPane calls — instead of racing a live
      // agent's spinner to produce a specific title at a specific moment.
      signalLog,
      // `termic://` deep links (GH #192). Exposed because WebDriver cannot
      // ask macOS to open a URL scheme — the OS half is LaunchServices, not
      // the app — so specs drive the handler with the same raw URL string
      // Rust would have queued, exercising everything from parse onward.
      deepLink,
    };
  })();
}

// Track Cmd/Ctrl held → `termic-mod-held` on <html>, so terminal links show
// the hand cursor only while the modifier is down (the underline stays on
// plain hover). See modKeyClass.ts + index.css.
initModKeyClass();

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

// Windowless mode: collapse task panes when Termic goes windowless so
// xterm's renderers actually pause. See src/lib/windowlessMode.ts.
initWindowlessMode().catch(() => {});
