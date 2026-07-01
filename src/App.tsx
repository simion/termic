// Layout:
//   ┌──────────────────────────────────────────────────────────┐
//   │  unified bar (traffic-lights | toggle | breadcrumbs | …) │
//   ├────────┬──────────────────────────┬────────────────────┤
//   │ sidebr │ main (tabs + content)    │ right panel        │
//   └────────┴──────────────────────────┴────────────────────┘

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/store/app";
import { workspaceSpotlightStatus } from "@/lib/ipc";
import { installPointerEventsGuard } from "@/lib/pointerEventsGuard";
import { cn } from "@/lib/utils";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { UnifiedBar } from "@/components/UnifiedBar";
import { MainArea } from "@/components/workspace/MainArea";
import { RightPanel } from "@/components/workspace/RightPanel";
import { Settings } from "@/components/settings/Settings";
import { Dialogs } from "@/components/dialogs/Dialogs";
import { Toaster } from "@/components/ui/Toaster";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useAttentionNotifier } from "@/hooks/useAttentionNotifier";
import { useIsFullscreen } from "@/hooks/useIsFullscreen";
import { useUpdate } from "@/store/update";
import { focusMainTab } from "@/lib/tabFocus";

export function App() {
  const loadAll = useApp(s => s.loadAll);
  const compact = useApp(s => s.compactSidebar);
  const hideRP  = useApp(s => s.rightPanelHidden);
  const activeWs = useApp(s => s.activeWorkspaceId);
  const view = useApp(s => s.view.page);
  const settingsOpen = useApp(s => !!s.view.settingsOpen);

  // Track the last terminal or editor element that had keyboard focus so we
  // can restore to the exact pane (main, split, bottom, editor) when the
  // window regains focus. Only track terminal/editor — not buttons, dialogs,
  // or inputs, which either don't need restoring or handle it themselves.
  const lastTermFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".xterm, .cm-editor")) lastTermFocusRef.current = t;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  // macOS native full-screen hides the traffic lights, so the Settings modal
  // doesn't need to reserve the top-left titlebar gap there.
  const isFullscreen = useIsFullscreen();

  useShortcuts();
  useAttentionNotifier();

  useEffect(() => {
    installPointerEventsGuard();
    loadAll();
    // CLI install detection runs at startup + when Settings → Agent CLIs
    // opens (AgentsSection drives the latter). Deliberately NOT on every
    // window focus — `loadAll` re-runs on focus, detection does not.
    useApp.getState().refreshClis();
    // Kick off the update check + changelog fetch (idempotent).
    useUpdate.getState().init();

    // Hydrate spotlight state from Rust (survives hot-reloads).
    workspaceSpotlightStatus().then(map => {
      const { setSpotlight } = useApp.getState();
      for (const [projectId, wsId] of Object.entries(map)) setSpotlight(projectId, wsId);
    }).catch(() => {});

    // Keep spotlight store in sync with Rust events.
    const unlistenStatus = listen<{ project_id: string; ws_id: string | null }>(
      "spotlight://status",
      ev => useApp.getState().setSpotlight(ev.payload.project_id, ev.payload.ws_id),
    );
    const onFocus = () => {
      loadAll();
      // Restore focus to whichever terminal/editor was last active when the
      // window lost focus. One rAF lets the click event settle first so we
      // don't race with elements that capture focus from the triggering click.
      // Guard: if the click already landed on a focusable interactive element
      // (terminal, editor, input, button, dialog) leave it alone.
      requestAnimationFrame(() => {
        const ae = document.activeElement as HTMLElement | null;
        const alreadyCaptured = ae && (
          ae.closest(".xterm, .cm-editor") ||
          ae.closest("input, textarea, button, a, [contenteditable]") ||
          ae.closest('[role="dialog"]')
        );
        if (alreadyCaptured) return;
        // Restore to last focused terminal/editor, or fall back to main tab.
        const last = lastTermFocusRef.current;
        if (last && document.contains(last)) {
          last.focus();
        } else {
          const s = useApp.getState();
          if (s.activeWorkspaceId) focusMainTab(s.activeTab[s.activeWorkspaceId]);
        }
      });
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      unlistenStatus.then(u => u());
    };
  }, [loadAll]);

  // Column widths come from the store so the resize handles can mutate them.
  // Compact sidebar mode is always a fixed 56px; the user-set sidebarWidth
  // only applies in full mode.
  const sidebarWidth = useApp(s => s.sidebarWidth);
  const rightPanelWidth = useApp(s => s.rightPanelWidth);
  const showRP = !!activeWs && !hideRP;
  // Sidebar / right panel widths use CSS `clamp(MIN, PREFERRED, vw-CAP)`:
  //   - PREFERRED is whatever the user manually dragged to (their ceiling).
  //   - vw-CAP kicks in when the viewport shrinks below `preferred / cap%`,
  //     so a small window doesn't get sidebars proportionally stealing
  //     half the screen — they shrink down to their MIN until the window
  //     grows again, at which point they return to PREFERRED but never
  //     exceed it.
  //   - Compact sidebar is a fixed 56px (icon-only mode — no clamping).
  // Net: drag-to-resize sets the "max ever" ceiling. Window shrinking
  // squeezes the panels down. Window growing back restores them — but
  // not beyond what the user actually wanted.
  const sbCol = compact
    ? "56px"
    : `clamp(160px, ${sidebarWidth}px, 33vw)`;
  const rpCol = `clamp(220px, ${rightPanelWidth}px, 35vw)`;
  const cols = showRP
    ? `${sbCol} 1fr ${rpCol}`
    : `${sbCol} 1fr`;

  // Settings is rendered as a full-window OVERLAY (z-50) on top of the
  // normal app layout. The grid below it stays mounted so every workspace
  // keeps its PTYs alive — closing settings dumps you straight back into
  // your live terminals. Previous "if (settings) return <Settings/>" branch
  // unmounted MainArea and killed every PTY.
  void view;
  // Settings is now a transient overlay flag — see store comment.
  const showSettings = settingsOpen;

  return (
    <>
      <div className="flex h-screen w-screen flex-col">
        <UnifiedBar />
        {/* grid-template-columns transition animates sidebar/right-panel show/hide. */}
        <div
          className="grid min-h-0 flex-1 overflow-hidden"
          style={{
            gridTemplateColumns: cols,
            gridTemplateRows: "minmax(0, 1fr)",
            // Animate show/hide of side panels, but DISABLE the transition
            // while the user is actively dragging a resize handle — otherwise
            // the column lerps toward each new width and visibly lags ~220ms
            // behind the cursor, which feels like the handle is fighting back.
            transition: "var(--cols-transition, grid-template-columns 220ms cubic-bezier(0.4, 0, 0.2, 1))",
          }}
        >
          <SidebarSlot />
          <main className="flex min-w-0 flex-col bg-[var(--color-bg)]">
            <ErrorBoundary label="MainArea"><MainArea /></ErrorBoundary>
          </main>
          {showRP && <ErrorBoundary label="RightPanel"><RightPanel /></ErrorBoundary>}
        </div>
      </div>
      {showSettings && (
        <div
          className={`fixed inset-0 z-40 flex bg-black/50 ${isFullscreen ? "p-4" : "px-4 pb-4 pt-10"}`}
          onMouseDown={e => { if (e.target === e.currentTarget) useApp.getState().closeSettings(); }}
        >
          <div className="relative w-full overflow-hidden rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-bg)] shadow-2xl">
            <ErrorBoundary label="Settings"><Settings /></ErrorBoundary>
          </div>
        </div>
      )}
      <Dialogs />
      <Toaster />
    </>
  );
}

/** Sidebar grid cell. In full mode it's just the sidebar. In compact mode
 *  it's the 56px icon rail PLUS an Arc-style hover reveal that slides the
 *  full sidebar in over the main content. */
function SidebarSlot() {
  const compact = useApp(s => s.compactSidebar);
  if (!compact) return <ErrorBoundary label="Sidebar"><Sidebar /></ErrorBoundary>;
  return <CompactSidebarReveal />;
}

/** Arc-style peek for the collapsed sidebar. The 56px icon rail holds the
 *  grid column; hovering it slides the full sidebar in from the left as a
 *  floating overlay (it covers part of the main area, never reflows it),
 *  then retracts off the left edge when the cursor leaves. */
function CompactSidebarReveal() {
  const sidebarWidth = useApp(s => s.sidebarWidth);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const cancelClose = () => {
    if (closeTimer.current !== undefined) {
      clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
  };
  // Retract after a short grace period — but stay pinned while a Radix
  // menu/popover spawned from inside the panel is open (those portal to
  // <body>, so moving the cursor onto one fires mouseleave on the panel)
  // OR while focus lives inside the panel (an inline rename/create input).
  // Closing in either case would yank the surface out from under the user.
  const tryClose = () => {
    if (
      document.querySelector("[data-radix-popper-content-wrapper]") ||
      panelRef.current?.contains(document.activeElement)
    ) {
      closeTimer.current = window.setTimeout(tryClose, 120);
      return;
    }
    setOpen(false);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(tryClose, 120);
  };
  useEffect(() => () => cancelClose(), []);

  return (
    <div
      className="relative"
      onMouseEnter={() => { cancelClose(); setOpen(true); }}
      onMouseLeave={scheduleClose}
    >
      {/* 56px icon rail — always present, owns the grid column width. */}
      <ErrorBoundary label="Sidebar"><Sidebar compact /></ErrorBoundary>
      {/* Full sidebar overlay. Kept mounted so the slide animates both
          ways; pointer-events are dropped while retracted so it never
          eats clicks over the content beneath it. */}
      <div
        ref={panelRef}
        aria-hidden={!open}
        className={cn(
          "absolute inset-y-0 left-0 z-30 transition-transform duration-200 ease-out",
          open ? "shadow-2xl shadow-black/40" : "pointer-events-none",
        )}
        style={{
          width: `clamp(160px, ${sidebarWidth}px, 33vw)`,
          transform: open ? "translateX(0)" : "translateX(-100%)",
        }}
      >
        <ErrorBoundary label="Sidebar"><Sidebar compact={false} /></ErrorBoundary>
      </div>
    </div>
  );
}
