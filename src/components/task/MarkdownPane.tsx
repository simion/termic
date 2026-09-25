// Wrapper for markdown buffers: the shared source / split / preview shell
// (SourcePreviewShell) over the CodeMirror editor and the rendered
// MarkdownPreview. The shell owns the toolbar, the split divider and the
// keep-mounted rules; everything here is markdown-specific — the live buffer
// feeding the preview, `file.md#heading` reveals, and the remote-image gate.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EditorView } from "@codemirror/view";
import type { EditTab, ExternalTab, ScratchTab, Task } from "@/lib/types";
import { EditorPane } from "./EditorPane";
import { SourcePreviewShell, type SourceView } from "./SourcePreviewShell";
import { useApp } from "@/store/app";
import { usePrefs, resolveTheme } from "@/store/prefs";

const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").then(m => ({ default: m.MarkdownPreview })),
);

export function MarkdownPane(
  { task, tab, visible, ownsFind, active = false }: {
    task: Task;
    /** A `.md` file, or a SCRATCHPAD whose syntax resolves to markdown (GH
     *  #244). A pad has no path, so relative links and images resolve from
     *  the task root and there is no `file.md#heading` reveal to consume;
     *  everything else — the toolbar, the split divider, the live-buffer
     *  preview — is identical, because the preview is fed by the editor
     *  buffer rather than by disk.
     *  Or an EXTERNAL `.md` (an absolute path outside the task, read-only):
     *  its links resolve against its own directory, see MarkdownCtx.external. */
    tab: EditTab | ScratchTab | ExternalTab;
    /** Laid out (not a `display:none` background tab in this task). */
    visible: boolean;
    /** Find belongs to this tab. True for one tab app-wide, see TaskView. */
    ownsFind: boolean;
    /** The tab in front of its task: whichever half is showing takes focus. */
    active?: boolean;
  },
) {
  // Fall back to the last-used view (a persisted pref) so a freshly opened
  // doc shows however you last looked at one. Toggling writes BOTH the
  // per-tab override and the global pref, so the choice survives relaunch.
  const defaultView = usePrefs(s => s.markdownDefaultView);
  const { t } = useTranslation("panels");
  const view: SourceView = tab.mdView ?? defaultView;
  const setView = (v: SourceView) => {
    useApp.getState().patchTab(task.id, tab.id, { mdView: v });
    usePrefs.getState().setMarkdownDefaultView(v);
  };

  // Remote-image gate (issue #69): the pref is the default, a per-tab
  // override unblocks just this document without touching it. The override
  // is one-way (there's no "re-block" affordance) and session-only, like
  // mdView — it dies with the tab, matching "load images this time".
  const loadRemoteImages = usePrefs(s => s.loadRemoteImages);
  const remoteImagesAllowed = tab.remoteImagesUnblocked ?? loadRemoteImages;
  // "Always" flips the global pref instead of just this tab's override — it
  // covers every future document, not just this one. The confirmation
  // (bar text + Settings link) is MarkdownPreview's own transient banner
  // state, not a toast — see its onAlwaysLoadRemoteImages handling.
  const alwaysLoadRemoteImages = () => usePrefs.getState().setLoadRemoteImages(true);

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
  // A pad is never recycled onto another document, but it still needs a
  // stable label here, so the key is the source rather than the path.
  const srcKey = tab.type === "edit" ? tab.path
    : tab.type === "external" ? `external:${tab.path}`
    : `scratch:${tab.scratchId}`;
  // Task-relative for an edit tab, ABSOLUTE for an external one (the ctx's
  // `external` flag says which), "" for a pad.
  const filePath = tab.type === "scratch" ? "" : tab.path;
  const [buf, setBuf] = useState({ path: srcKey, text: "" });
  const text = buf.path === srcKey ? buf.text : "";
  const debounceRef = useRef<number | null>(null);
  function onContent(view: EditorView) {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    const path = srcKey;
    debounceRef.current = window.setTimeout(() => setBuf({ path, text: view.state.doc.toString() }), 200);
  }
  // Keyed on tab.path (not just unmount): a debounced write scheduled for
  // the PREVIOUS path must be cancelled the instant the tab recycles to a
  // new one, not left to fire later. Without this, navigating away and
  // quickly back (before the 200ms timer fires) lets the stale write land
  // AFTER the tab is back on the original path — its `path` no longer
  // matches `tab.path`, so `text` derives "" and blanks an already-correct
  // preview until the next real content update arrives.
  useEffect(() => () => { if (debounceRef.current != null) window.clearTimeout(debounceRef.current); }, [srcKey]);

  // A pending file.md#heading reveal is only consumable by the rendered
  // preview: a tab sitting in source view switches to preview (tab-local
  // mdView only; the global default-view pref is not touched). Without this
  // the reveal would linger unconsumed and fire as a surprise scroll when
  // the user eventually toggles the view themselves.
  const revealHeading = tab.type === "edit" ? tab.revealHeading : undefined;
  useEffect(() => {
    if (revealHeading && view === "source") {
      useApp.getState().patchTab(task.id, tab.id, { mdView: "preview" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealHeading]);

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
  const external = tab.type === "external";
  const ctx = { taskId: task.id, filePath, epoch: fsRev, memberDirs, external };

  return (
    <SourcePreviewShell
      view={view}
      setView={setView}
      active={active}
      editor={<EditorPane task={task} tab={tab} onContent={onContent} active={active && view !== "preview"} />}
      preview={({ showPreview, showEditor }) => (
        <Suspense fallback={<div className="p-4 text-[14px] text-[var(--color-fg-dim)]">{t("shared.loadingPreview")}</div>}>
          <MarkdownPreview
            text={text}
            themeDark={themeDark}
            ctx={ctx}
            revealHeading={revealHeading}
            onRevealConsumed={() => useApp.getState().patchTab(task.id, tab.id, { revealHeading: undefined })}
            // TaskView's flags are about the tab; `showPreview` is the md
            // view mode. A source-view tab keeps this preview mounted but
            // off screen, so both need ANDing.
            visible={visible && showPreview}
            ownsFind={ownsFind && showPreview}
            editorVisible={showEditor}
            remoteImagesAllowed={remoteImagesAllowed}
            onUnblockRemoteImages={
              remoteImagesAllowed ? undefined
                : () => useApp.getState().patchTab(task.id, tab.id, { remoteImagesUnblocked: true })
            }
            onAlwaysLoadRemoteImages={remoteImagesAllowed ? undefined : alwaysLoadRemoteImages}
          />
        </Suspense>
      )}
    />
  );
}
