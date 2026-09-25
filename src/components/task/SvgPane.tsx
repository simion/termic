// Wrapper for SVG edit tabs (GH #247): the same source / split / preview
// shell markdown uses, over the CodeMirror editor and a rendered <img>.
//
// Before this, an SVG opened as a read-only PreviewPane image and the only
// way to change one was to open it somewhere else. An SVG is both a picture
// and a text file, which is exactly the shape SourcePreviewShell already
// serves.
//
// The preview renders the editor's LIVE buffer, not the file on disk, so a
// split-view edit updates as you type and there is no IPC read here at all
// (EditorPane already loaded the file, and calls onContent on load as well as
// on every edit). That also means the picture always matches the source next
// to it, including unsaved changes.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EditorView } from "@codemirror/view";
import type { EditTab, Task } from "@/lib/types";
import { EditorPane } from "./EditorPane";
import { PreviewPane } from "./PreviewPane";
import { SourcePreviewShell, type SourceView } from "./SourcePreviewShell";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { svgDataUrl } from "@/lib/previewPaths";

export function SvgPane(
  { task, tab, active = false }: { task: Task; tab: EditTab; active?: boolean },
) {
  // Same per-tab override + persisted global default as markdown, but its OWN
  // pref: the two kinds want opposite defaults. Someone who reads markdown as
  // source still expects an SVG to open as a picture, which is what clicking
  // one in the file tree has always done.
  const defaultView = usePrefs(s => s.svgDefaultView);
  const { t } = useTranslation("panels");
  const view: SourceView = tab.mdView ?? defaultView;
  const setView = (v: SourceView) => {
    useApp.getState().patchTab(task.id, tab.id, { mdView: v });
    usePrefs.getState().setSvgDefaultView(v);
  };

  // Live buffer text from the editor's onContent, debounced so split-mode
  // typing doesn't rebuild the data URL (and re-decode the image) on every
  // keystroke. Read lazily INSIDE the timeout so a burst of keystrokes
  // stringifies the buffer once, at fire time.
  //
  // Labeled with the tab.path it was read for: a recycled preview tab swaps
  // tab.path WITHOUT remounting this pane, so until EditorPane reloads, the
  // buffer still holds the OLD file. Deriving "" for a mismatched label keeps
  // the previous document's picture from showing under the new file's name.
  const [buf, setBuf] = useState({ path: tab.path, text: "" });
  const text = buf.path === tab.path ? buf.text : "";
  const debounceRef = useRef<number | null>(null);
  function onContent(view: EditorView) {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    const path = tab.path;
    debounceRef.current = window.setTimeout(() => setBuf({ path, text: view.state.doc.toString() }), 200);
  }
  // Keyed on tab.path, not just unmount: a debounced write scheduled for the
  // PREVIOUS path must be cancelled the instant the tab recycles, or it lands
  // after the tab is back on the original path and blanks a correct preview.
  useEffect(() => () => { if (debounceRef.current != null) window.clearTimeout(debounceRef.current); }, [tab.path]);

  const url = useMemo(() => (text ? svgDataUrl(text) : null), [text]);

  // EditorPane calls onContent ON LOAD, so a buffer still empty this long
  // after opening means the READ failed, not that it hasn't happened yet:
  // task_file_read refuses anything over its 2 MB cap or not valid UTF-8.
  // Those SVGs rendered fine before this pane existed (the base64 preview
  // channel has its own, larger budget and doesn't care about encoding), so
  // fall back to the read-only disk preview rather than regressing them to a
  // permanent "Loading…". Deliberately NOT mounted up front: that would put
  // a second read on every SVG open just to cover a case that resolves in
  // ~200ms for every file that can be edited at all.
  const [editorStalled, setEditorStalled] = useState(false);
  useEffect(() => {
    if (text) { setEditorStalled(false); return; }
    const t = window.setTimeout(() => setEditorStalled(true), 1500);
    return () => window.clearTimeout(t);
  }, [text, tab.path]);

  return (
    <SourcePreviewShell
      view={view}
      setView={setView}
      active={active}
      editor={<EditorPane task={task} tab={tab} onContent={onContent} active={active && view !== "preview"} />}
      preview={() => (
        <div className="h-full overflow-auto bg-[var(--color-bg)]">
          {url
            ? (
              // Checkerboard behind the image: most SVGs have a transparent
              // background, and a white logo on the editor's dark background
              // is invisible without something to sit on.
              <div
                className="flex h-full items-center justify-center p-4"
                style={{
                  backgroundImage:
                    "linear-gradient(45deg, var(--color-bg-2) 25%, transparent 25%, transparent 75%, var(--color-bg-2) 75%), " +
                    "linear-gradient(45deg, var(--color-bg-2) 25%, transparent 25%, transparent 75%, var(--color-bg-2) 75%)",
                  backgroundSize: "16px 16px",
                  backgroundPosition: "0 0, 8px 8px",
                }}
              >
                <img data-testid="svg-preview" src={url} alt={tab.title} className="max-h-full max-w-full object-contain" />
              </div>
            )
            : editorStalled
              ? <PreviewPane task={task} tab={tab} />
              : <div className="p-4 text-[14px] text-[var(--color-fg-dim)]">{t("shared.loading")}</div>}
        </div>
      )}
    />
  );
}
