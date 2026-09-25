// MUST be first: migrates renamed localStorage keys (workspace -> task) before
// any store module reads them at init. See src/lib/lsMigration.ts.
import "@/lib/lsMigration";
// i18n must initialize before App renders (resources are bundled, so this is
// synchronous). The prefs store's setLanguage drives runtime switching.
import "@/lib/i18n";
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
import { installRecentPlacesTracker } from "@/lib/recentPlacesTracker";
import { initUserPresence } from "@/lib/userPresence";
import { initWindowFocus } from "@/lib/windowFocus";

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
    const [app, ui, prefs, race, pr, ipc, core, runTabs, scriptRuns, prompts, agentRace, issuePrompt, seedPrompt, signalLog, reviewComments, deepLink, previewBrowser, pendingTasks, archivingTasks, cmLanguage, cmAutocomplete, codeIntel, lspStatus, navHistory, pageSession, profiles, agentUsage, usageUnknownDismissed, scratchCli] =
      await Promise.all([
        import("@/store/app"),
        import("@/store/ui"),
        import("@/store/prefs"),
        import("@/store/race"),
        import("@/store/pr"),
        import("@/lib/ipc"),
        import("@tauri-apps/api/core"),
        import("@/lib/runTabs"),
        import("@/store/scriptRuns"),
        import("@/store/prompts"),
        import("@/lib/agentRace"),
        import("@/lib/issuePrompt"),
        import("@/lib/seedPrompt"),
        import("@/lib/agentSignalLog"),
        import("@/store/reviewComments"),
        import("@/lib/deepLink"),
        import("@/lib/previewBrowser"),
        import("@/store/pendingTasks"),
        import("@/store/archivingTasks"),
        import("@codemirror/language"),
        import("@codemirror/autocomplete"),
        import("@/store/codeIntel"),
        import("@/store/lspStatus"),
        import("@/store/navHistory"),
        import("@/lib/lsp/pageSession"),
        import("@/store/profiles"),
        import("@/store/agentUsage"),
        import("@/store/usageUnknownDismissed"),
        import("@/lib/scratchCli"),
      ]);
    (window as unknown as Record<string, unknown>).__termic = {
      useApp: app.useApp,
      useUI: ui.useUI,
      usePrefs: prefs.usePrefs,
      useRace: race.useRace,
      usePr: pr.usePr,
      // One pass of the BACKGROUND status poller (GH #281). Exposed because
      // its real cadence is minutes and the badge it drives lives on rows
      // whose PR card is not mounted - there is nothing on screen to click
      // that would run it.
      prStatusPassNow: pr.prStatusPassNow,
      // Profiles (GH #280). Exposed so a spec can read the registry as this
      // window sees it without scraping the strip, and can restore the
      // dormant state in teardown even when the body threw half way.
      useProfiles: profiles.useProfiles,
      // Plan usage (GH #277). Exposed so a spec can seed a reading rather than
      // wait for a real agent to report one, which no fixture agent does.
      useAgentUsage: agentUsage.useAgentUsage,
      // Which agents' "Usage unknown" label is dismissed, so a spec can put
      // the footer back the way it found it.
      useUsageUnknownDismissed: usageUnknownDismissed.useUsageUnknownDismissed,
      // The webview half of `termic scratchpad`. Exposed so a spec can land a
      // write in the SAME tick as an editor remount, which a round trip over
      // the control socket can only hit by luck (lib/scratchLive).
      padHandler: scratchCli.padHandler,
      ipc,
      invoke: core.invoke,
      runTabs,
      scriptRuns: scriptRuns.useScriptRuns,
      // Prompt library (localStorage-backed): exposed so the reorder-drag spec
      // can snapshot the order in before() and put it back in after() — the
      // profile must be left byte-identical (see the signal-inspector note).
      usePromptLibrary: prompts.usePromptLibrary,
      // GH #245: the exact helper both preview buttons and the terminal link
      // openers delegate to, so a spec exercises the real resolution path.
      previewBrowser,
      agentRace,
      issuePrompt,
      seedPrompt,
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
      // Tasks mid-creation (GH #242 — non-blocking worktree create). Exposed
      // so specs can seed a synthetic pending entry directly, rather than
      // racing the fixture repo's (near-instant) real worktree add to catch
      // PendingTaskRow / CreatingTaskPane in their "creating" state.
      usePendingTasks: pendingTasks.usePendingTasks,
      // Tasks mid-archive (GH #246 — non-blocking archive). Exposed for the
      // same reason as usePendingTasks: the fixture repo's archive finishes
      // far too fast to catch the "Archiving…" row by racing a real one.
      useArchivingTasks: archivingTasks.useArchivingTasks,
      // CodeMirror's own indentation facet. Indentation is detected per file
      // (lib/detectIndent), and the only honest way to assert what the editor
      // decided is to read it from the state the editor actually uses.
      // CodeMirror's indentation facet (indentation is detected per file, see
      // lib/detectIndent) and its completion command, which a spec needs to
      // open the popup without depending on WKWebView routing a keystroke into
      // a contenteditable.
      cm: {
        indentUnit: cmLanguage.indentUnit,
        startCompletion: cmAutocomplete.startCompletion,
        // How far the grammar has actually got. A spec that asks "is what is
        // on screen highlighted" by looking at the DOM is racing the parse;
        // this is the state the highlight is derived FROM, so it answers
        // deterministically.
        syntaxTree: cmLanguage.syntaxTree,
      },
      // Code-intelligence grants (GH #174). In memory by design (a grant that
      // survived a relaunch would be exactly the stickiness it refuses), so a
      // spec has to arm a checkout through the store the chip writes to.
      useCodeIntel: codeIntel.useCodeIntel,
      // The store plus `grantKey`, because a grant is keyed by (checkout,
      // server) and a spec must not hand-roll that key.
      codeIntel,
      // What each language server is doing: the phases a real server passes
      // through go by far too fast to catch by racing one.
      lspStatus,
      // The jump trail behind Back / Forward.
      navHistory,
      // This page load's stamp. A spec cannot simulate the reload it guards
      // against (that would end its own session), so it drives the sweep the
      // way the next page does: reap everything NOT stamped with this.
      lspPageId: pageSession.LSP_PAGE_ID,
    };
  })().catch((e: unknown) => {
    // Without this a single failed dynamic import above left the hook
    // silently unset: the app rendered normally and every e2e spec then
    // failed with "window.__termic missing", pointing at the build. Record
    // WHY, where requireTermicApi can print it, and in the debug log.
    const msg = String((e as Error)?.stack ?? e);
    (window as unknown as Record<string, unknown>).__termicBootError = msg;
    logLine(`[termic] e2e hook failed to attach: ${msg}`).catch(() => {});
  });
}

// Track Cmd/Ctrl held → `termic-mod-held` on <html>, so terminal links show
// the hand cursor only while the modifier is down (the underline stays on
// plain hover). See modKeyClass.ts + index.css.
initModKeyClass();
initUserPresence();
initWindowFocus();

// Record what is on screen, so ⌃⇥ can step back through it. A subscription
// rather than a hook into the setters, so every way of selecting a task or tab
// feeds it: the sidebar, the CLI, deep links, the palette, LSP navigation.
installRecentPlacesTracker();

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
