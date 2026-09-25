// The source / preview / split chrome shared by every file kind that has
// both an editable source and a rendered form: markdown (MarkdownPane) and
// SVG (SvgPane). Extracted from MarkdownPane so the two cannot drift — one
// toolbar, one split behaviour, one set of mount rules.
//
// Two rules the panes depend on and must not re-implement:
//
//   * The editor stays MOUNTED in every mode (toggled via `display`, never
//     unmounted) so undo history, cursor and any unsaved buffer survive a
//     mode switch, and so it keeps feeding live text to the preview.
//   * The preview is lazy-mounted on its FIRST reveal and then kept mounted
//     the same way. That preserves the lazy import for someone who never
//     previews, while avoiding a re-parse (markdown-it + mermaid) or an image
//     decode on every Editor↔Preview toggle.
//
// `display: none` and not `visibility: hidden`, per docs/performance.md bear
// trap 2: a visibility-hidden pane keeps rendering.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { cn } from "@/lib/utils";
import { FileCode2, Eye, Columns2 } from "lucide-react";

export type SourceView = "source" | "preview" | "split";

function ToolbarButton({ mode, active, onClick, children }: {
  mode: SourceView; active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      // Both panes render this toolbar with the same three labels, and every
      // visited task stays mounted, so visible text alone can't identify a
      // button. e2e targets this attribute; see the e2e skill's selector rule.
      data-view-btn={mode}
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

export function SourcePreviewShell(
  { view, setView, editor, preview, active = false }: {
    view: SourceView;
    /** This tab is the one in front. Source and split views focus the editor
     *  themselves (the caller passes `active` into it); preview-only focuses
     *  the preview here, so a file opened with ⌘P takes the keyboard in every
     *  mode rather than leaving it on <body>. */
    active?: boolean;
    setView: (v: SourceView) => void;
    /** The CodeMirror pane. Mounted in every mode. */
    editor: React.ReactNode;
    /** Rendered form. Called only once the preview has been mounted; the
     *  flags are passed through because a preview kept mounted off screen
     *  still needs to know it is not visible (find ownership, scroll sync). */
    preview: (s: { showPreview: boolean; showEditor: boolean }) => React.ReactNode;
  },
) {
  const { t } = useTranslation("panels");
  const showEditor = view === "source" || view === "split";
  const showPreview = view === "preview" || view === "split";

  // Split divider position as a percentage of width given to the editor.
  const [editorPct, setEditorPct] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);

  const [previewMounted, setPreviewMounted] = useState(showPreview);
  useEffect(() => { if (showPreview) setPreviewMounted(true); }, [showPreview]);

  // Preview-only: focus the preview's own focus target (its find checks that
  // focus is inside it), or the column when the lazy preview has none yet.
  // Retried on a timer, not rAF, for the reason lib/tabFocus.ts gives: the
  // preview chunk may still be loading, and rAF freezes on an occluded window.
  const previewColRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || view !== "preview") return;
    let tries = 30;
    let timer: number | undefined;
    const attempt = () => {
      const col = previewColRef.current;
      const target = col?.querySelector<HTMLElement>("[tabindex]") ?? null;
      if (target) {
        target.focus();
        if (document.activeElement === target) return;
      }
      if (--tries > 0) timer = window.setTimeout(attempt, 16);
      else col?.focus();
    };
    timer = window.setTimeout(attempt, 0);
    return () => window.clearTimeout(timer);
  }, [active, view]);

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]" data-testid="source-preview-shell" data-view={view}>
      {/* Mode toolbar — right-aligned, matches the bottom-split strip geometry. */}
      <div className="flex h-8 shrink-0 items-center justify-end gap-0.5 border-b border-[var(--color-border-soft)] px-2">
        <ToolbarButton mode="source"  active={view === "source"}  onClick={() => setView("source")}><FileCode2 className="h-3.5 w-3.5" />{t("sourcePreview.editor")}</ToolbarButton>
        <ToolbarButton mode="preview" active={view === "preview"} onClick={() => setView("preview")}><Eye className="h-3.5 w-3.5" />{t("sourcePreview.preview")}</ToolbarButton>
        <ToolbarButton mode="split"   active={view === "split"}   onClick={() => setView("split")}><Columns2 className="h-3.5 w-3.5" />{t("sourcePreview.split")}</ToolbarButton>
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
          {editor}
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

        {previewMounted && (
          <div
            ref={previewColRef}
            tabIndex={-1}
            className="relative min-h-0 border-l border-[var(--color-border-soft)] outline-none"
            style={{
              display: showPreview ? "block" : "none",
              width: view === "split" ? `${100 - editorPct}%` : "100%",
            }}
          >
            {preview({ showPreview, showEditor })}
          </div>
        )}
      </div>
    </div>
  );
}
