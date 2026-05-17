// Layout:
//   ┌──────────────────────────────────────────────────────────┐
//   │  unified bar (traffic-lights | toggle | breadcrumbs | …) │
//   ├────────┬──────────────────────────┬────────────────────┤
//   │ sidebr │ main (tabs + content)    │ right panel        │
//   └────────┴──────────────────────────┴────────────────────┘

import { useEffect } from "react";
import { useApp } from "@/store/app";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { UnifiedBar } from "@/components/UnifiedBar";
import { MainArea } from "@/components/workspace/MainArea";
import { RightPanel } from "@/components/workspace/RightPanel";
import { Settings } from "@/components/settings/Settings";
import { Dialogs } from "@/components/dialogs/Dialogs";
import { TinyproxyBanner } from "@/components/TinyproxyBanner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useAttentionNotifier } from "@/hooks/useAttentionNotifier";

export function App() {
  const loadAll = useApp(s => s.loadAll);
  const compact = useApp(s => s.compactSidebar);
  const hideRP  = useApp(s => s.rightPanelHidden);
  const activeWs = useApp(s => s.activeWorkspaceId);
  const view = useApp(s => s.view.page);
  const settingsOpen = useApp(s => !!s.view.settingsOpen);

  useShortcuts();
  useAttentionNotifier();

  useEffect(() => {
    loadAll();
    const onFocus = () => loadAll();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
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
          className="grid min-h-0 flex-1"
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
          <ErrorBoundary label="Sidebar"><Sidebar /></ErrorBoundary>
          <main className="flex min-w-0 flex-col bg-[var(--color-bg)]">
            <ErrorBoundary label="MainArea"><MainArea /></ErrorBoundary>
          </main>
          {showRP && <ErrorBoundary label="RightPanel"><RightPanel /></ErrorBoundary>}
        </div>
      </div>
      {showSettings && (
        <div className="fixed inset-0 z-40 bg-[var(--color-bg)]">
          <ErrorBoundary label="Settings"><Settings /></ErrorBoundary>
        </div>
      )}
      <Dialogs />
      <TinyproxyBanner />
    </>
  );
}
