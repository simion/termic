// Wrapper for markdown edit tabs: a thin toolbar (source / split / preview)
// over the CodeMirror editor and the rendered MarkdownPreview. The editor
// stays MOUNTED in every mode (toggled via display, never unmounted) so the
// undo history, cursor, and any unsaved buffer survive a mode switch — and so
// it can keep feeding live text to the preview via onContent.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import type { EditTab, Task } from "@/lib/types";
import { EditorPane } from "./EditorPane";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { useApp } from "@/store/app";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { cn } from "@/lib/utils";
import { FileCode2, Eye, Columns2 } from "lucide-react";

const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").then(m => ({ default: m.MarkdownPreview })),
);

type View = "source" | "preview" | "split";

function ToolbarButton({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded px-2.5 text-[12px] font-medium transition-colors",
        active
          ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]"
          : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
      )}
    >{children}</button>
  );
}

export function MarkdownPane({ task, tab }: { task: Task; tab: EditTab }) {
  // Fall back to the last-used view (a persisted pref) so a freshly opened
  // doc shows however you last looked at one. Toggling writes BOTH the
  // per-tab override and the global pref, so the choice survives relaunch.
  const defaultView = usePrefs(s => s.markdownDefaultView);
  const view: View = tab.mdView ?? defaultView;
  const setView = (v: View) => {
    useApp.getState().patchTab(task.id, tab.id, { mdView: v });
    usePrefs.getState().setMarkdownDefaultView(v);
  };

  // Live buffer text fed from the editor's onContent. Debounced so split-mode
  // typing doesn't re-parse markdown + re-run mermaid on every keystroke. We
  // read view.state.doc lazily INSIDE the timeout, so a burst of keystrokes
  // stringifies the buffer once (at fire time) instead of on every keypress.
  //
  // The text is labeled with the tab.path it was read for: recycled preview
  // tabs swap tab.path WITHOUT remounting this pane (WorkspaceView keys by
  // tab id), so until EditorPane reloads, the buffer still holds the OLD
  // file. Deriving "" for a mismatched label keeps the preview (and its
  // revealHeading consumption) from ever acting on the previous document.
  const [buf, setBuf] = useState({ path: tab.path, text: "" });
  const text = buf.path === tab.path ? buf.text : "";
  const debounceRef = useRef<number | null>(null);
  function onContent(view: EditorView) {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    const path = tab.path;
    debounceRef.current = window.setTimeout(() => setBuf({ path, text: view.state.doc.toString() }), 200);
  }
  // Keyed on tab.path (not just unmount): a debounced write scheduled for
  // the PREVIOUS path must be cancelled the instant the tab recycles to a
  // new one, not left to fire later. Without this, navigating away and
  // quickly back (before the 200ms timer fires) lets the stale write land
  // AFTER the tab is back on the original path — its `path` no longer
  // matches `tab.path`, so `text` derives "" and blanks an already-correct
  // preview until the next real content update arrives.
  useEffect(() => () => { if (debounceRef.current != null) window.clearTimeout(debounceRef.current); }, [tab.path]);

  // A pending file.md#heading reveal is only consumable by the rendered
  // preview: a tab sitting in source view switches to preview (tab-local
  // mdView only; the global default-view pref is not touched). Without this
  // the reveal would linger unconsumed and fire as a surprise scroll when
  // the user eventually toggles the view themselves.
  useEffect(() => {
    if (tab.revealHeading && view === "source") {
      useApp.getState().patchTab(task.id, tab.id, { mdView: "preview" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.revealHeading]);

  // Split divider position as a percentage of width given to the editor.
  const [editorPct, setEditorPct] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);

  // Subscribe so the preview/mermaid theme tracks app palette changes.
  const themeMode = usePrefs(s => s.themeMode);
  const themeDark = resolveTheme(themeMode) !== "light";

  // fsRevision bumps when an agent settles — exactly when images on disk may
  // have changed — so it doubles as the preview's image-cache invalidator.
  const fsRev = useApp(s => s.fsRevision[task.id] ?? 0);

  // Memoized so MarkdownPreview's effects can safely depend on it: `task.composition`
  // is frozen at workspace creation (stable across unrelated store updates),
  // but `.map(...)` allocates a fresh array every render — an unmemoized
  // array literal in an effect's dependency array would make that effect
  // re-run (and, for the main render effect, rebuild innerHTML) on every
  // single re-render regardless of whether composition actually changed.
  const memberDirs = useMemo(() => task.composition?.map(m => m.dir_name), [task.composition]);

  const showEditor = view === "source" || view === "split";
  const showPreview = view === "preview" || view === "split";

  // Lazy-mount the preview on its first reveal, then KEEP it mounted and
  // toggle visibility via `display` (like the editor). This preserves the
  // lazy markdown-it/mermaid import for users who never preview, while
  // avoiding a re-parse + mermaid re-render on every Editor↔Preview switch.
  const [previewMounted, setPreviewMounted] = useState(showPreview);
  useEffect(() => { if (showPreview) setPreviewMounted(true); }, [showPreview]);

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      {/* Mode toolbar — right-aligned, matches the bottom-split strip geometry. */}
      <div className="flex h-8 shrink-0 items-center justify-end gap-0.5 border-b border-[var(--color-border-soft)] px-2">
        <ToolbarButton active={view === "source"}  onClick={() => setView("source")}><FileCode2 className="h-3.5 w-3.5" />Editor</ToolbarButton>
        <ToolbarButton active={view === "preview"} onClick={() => setView("preview")}><Eye className="h-3.5 w-3.5" />Preview</ToolbarButton>
        <ToolbarButton active={view === "split"}   onClick={() => setView("split")}><Columns2 className="h-3.5 w-3.5" />Split</ToolbarButton>
      </div>

      <div ref={containerRef} className="relative flex min-h-0 flex-1">
        {/* Editor: kept mounted in all modes; hidden (not unmounted) in preview. */}
        <div
          className="relative min-h-0"
          style={{
            display: showEditor ? "block" : "none",
            width: view === "split" ? `${editorPct}%` : "100%",
          }}
        >
          <EditorPane task={task} tab={tab} onContent={onContent} />
        </div>

        {view === "split" && (
          // Wrapper positioned at the divider; ResizeHandle (w-px -ml-px)
          // straddles the wrapper's left edge so the 1px grab line sits
          // exactly on the editor/preview boundary.
          <div className="absolute inset-y-0 z-20" style={{ left: `${editorPct}%` }}>
            <ResizeHandle
              direction="x"
              onDrag={(dx) => {
                const w = containerRef.current?.clientWidth ?? 800;
                setEditorPct(p => Math.max(20, Math.min(80, p + (dx / w) * 100)));
              }}
            />
          </div>
        )}

        {/* Preview: lazy-mounted on first reveal, then kept mounted with a
            display toggle so switching modes doesn't re-import markdown-it /
            mermaid or re-render diagrams. */}
        {previewMounted && (
          <div
            className="relative min-h-0 border-l border-[var(--color-border-soft)]"
            style={{
              display: showPreview ? "block" : "none",
              width: view === "split" ? `${100 - editorPct}%` : "100%",
            }}
          >
            <Suspense fallback={<div className="p-4 text-[14px] text-[var(--color-fg-dim)]">Loading preview…</div>}>
              <MarkdownPreview
                text={text}
                themeDark={themeDark}
                ctx={{ taskId: task.id, filePath: tab.path, epoch: fsRev, memberDirs }}
                revealHeading={tab.revealHeading}
                onRevealConsumed={() => useApp.getState().patchTab(task.id, tab.id, { revealHeading: undefined })}
                visible={showPreview}
              />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
