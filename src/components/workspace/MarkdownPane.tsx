// Wrapper for markdown edit tabs: a thin toolbar (source / split / preview)
// over the CodeMirror editor and the rendered MarkdownPreview. The editor
// stays MOUNTED in every mode (toggled via display, never unmounted) so the
// undo history, cursor, and any unsaved buffer survive a mode switch — and so
// it can keep feeding live text to the preview via onContent.

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import type { EditTab, Workspace } from "@/lib/types";
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

export function MarkdownPane({ ws, tab }: { ws: Workspace; tab: EditTab }) {
  const view: View = tab.mdView ?? "source";
  const setView = (v: View) => useApp.getState().patchTab(ws.id, tab.id, { mdView: v });

  // Live buffer text fed from the editor's onContent. Debounced so split-mode
  // typing doesn't re-parse markdown + re-run mermaid on every keystroke. We
  // read view.state.doc lazily INSIDE the timeout, so a burst of keystrokes
  // stringifies the buffer once (at fire time) instead of on every keypress.
  const [text, setText] = useState("");
  const debounceRef = useRef<number | null>(null);
  function onContent(view: EditorView) {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setText(view.state.doc.toString()), 200);
  }
  useEffect(() => () => { if (debounceRef.current != null) window.clearTimeout(debounceRef.current); }, []);

  // Split divider position as a percentage of width given to the editor.
  const [editorPct, setEditorPct] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);

  // Subscribe so the preview/mermaid theme tracks app palette changes.
  const themeMode = usePrefs(s => s.themeMode);
  const themeDark = resolveTheme(themeMode) !== "light";

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
          <EditorPane ws={ws} tab={tab} onContent={onContent} />
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
              <MarkdownPreview text={text} themeDark={themeDark} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
