// Read-only preview for image/PDF files opened from the file tree. No
// CodeMirror instance. Images render as an <img> fed a base64 data URL read
// over IPC (taskFileReadBase64). PDFs render as an <embed> pointed at the
// `taskpdf:` URI scheme (src-tauri): WKWebView renders a PDF served as a real
// application/pdf resource, but shows blank for a data: URL, so PDFs can't go
// through the base64 channel. Same extension whitelist on both sides
// (previewKindForPath / preview_mime_for_ext).
//
// The native PDF view owns the scrolled-to page and exposes it to nothing:
// no DOM scroller to read, no API to set. So the page survives only as long
// as that view does. Two things can kill it, and both are handled: hiding the
// tab (TaskView keeps PDF tabs in the render tree instead of display:none)
// and reloading the <embed> (the URL only moves when the file's fingerprint
// does, see the fsRevision effect below).

import { useEffect, useRef, useState } from "react";
import type { EditTab, Task } from "@/lib/types";
import { taskFileFp, taskFileReadBase64 } from "@/lib/ipc";
import { previewKindForPath, taskPdfSrc } from "@/lib/previewPaths";
import { useApp } from "@/store/app";

/** What the PDF branch renders, tagged with the file it describes. */
type PdfState = { id: string; path: string; fp?: string; err?: string };

export function PreviewPane({ task, tab }: { task: Task; tab: EditTab }) {
  const kind = previewKindForPath(tab.path);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  // PDFs only: the `mtime:len` fingerprint that stands in for the file's
  // bytes in the <embed> URL, STAMPED WITH THE FILE IT WAS MEASURED FOR.
  // A preview tab is recyclable — clicking another file swaps `tab.path`
  // under this same mounted component — and React renders before the effect
  // that would clear a plain fingerprint. Carrying the identity means a
  // fingerprint can never be paired with someone else's path for a frame,
  // which would put a second, pointless URL (and so a second fetch) on the
  // embed. `pdf` is null until the identities agree, i.e. until this file's
  // own stat lands, and the embed doesn't render before then.
  const [pdfState, setPdfState] = useState<PdfState | null>(null);
  const pdf = pdfState && pdfState.id === task.id && pdfState.path === tab.path ? pdfState : null;

  // Last-read `mtime:len` fingerprint, sent as `knownFp` on the next read so
  // an agent-settle refetch of an unchanged file skips the read + base64
  // encode entirely (`unchanged: true`, no `mime`/`data`). Reset whenever the
  // tab switches to a different file, a fresh file has nothing to compare
  // against. Images only — PDFs stream through the `taskpdf:` scheme.
  const fpRef = useRef<string | undefined>(undefined);
  const identityRef = useRef<string | null>(null);

  // Per-task "files changed" tick (bumped on agent-settle) — re-fetch a
  // preview an agent just (re)wrote. No dirty/unsaved state to protect here
  // (the pane is read-only), so this can reload silently, unlike EditorPane's
  // disk-changed prompt.
  const fsRevision = useApp(s => s.fsRevision[task.id] ?? 0);

  useEffect(() => {
    // PDFs never come through here: they render declaratively via <embed>
    // below, fed by the stat-only fingerprint effect further down. So the
    // base64 read runs for images only.
    if (kind !== "image") return;
    let alive = true;
    const identity = `${task.id}:${tab.path}`;
    const isNewFile = identityRef.current !== identity;
    identityRef.current = identity;
    if (isNewFile) {
      fpRef.current = undefined;
      setLoading(true);
      setErr(null);
      setUrl(null);
    }
    taskFileReadBase64(task.id, tab.path, fpRef.current)
      .then(({ unchanged, mime, data, fp }) => {
        if (!alive) return;
        fpRef.current = fp;
        // Clear any error from a prior (failed) load: a successful refetch on
        // an fsRevision tick must not leave a stale error banner over the
        // freshly loaded bytes.
        setErr(null);
        if (unchanged) {
          // Bytes already on screen are still correct.
          setLoading(false);
          return;
        }
        if (!mime || !data) {
          setErr("empty response");
          setLoading(false);
          return;
        }
        setUrl(`data:${mime};base64,${data}`);
        setLoading(false);
      })
      .catch(e => {
        if (!alive) return;
        setErr(String(e));
        setLoading(false);
      });
    return () => { alive = false; };
  }, [kind, task.id, tab.path, fsRevision]);

  // PDFs take the same fsRevision tick but only stat the file: the bytes
  // reach the webview through the `taskpdf:` scheme, so all this needs to
  // decide is whether the <embed> URL should move. It must move only on a
  // real rewrite. fsRevision fires once per agent turn whether or not this
  // file was touched, and a reload restarts the native PDF view at page 1 —
  // in the workflow this pane exists for (agent regenerates a PDF, user
  // reads it, types the next instruction, repeat) that would throw the
  // reader's place away every turn.
  useEffect(() => {
    if (kind !== "pdf") return;
    let alive = true;
    const id = task.id;
    const path = tab.path;
    const isCurrent = (p: PdfState | null): p is PdfState => !!p && p.id === id && p.path === path;
    taskFileFp(id, path)
      .then(fp => {
        // An empty fp means the path resolved but wouldn't stat, which
        // `safe_task_path` makes a TOCTOU-width race rather than a state you
        // can sit in. Not worth acting on: hold the render (which on a first
        // load is still "Loading…") and let the next tick settle it.
        if (alive && fp) setPdfState(p => (isCurrent(p) && p.fp === fp ? p : { id, path, fp }));
      })
      .catch(e => {
        // A file caught mid-rewrite (gone for an instant) errors here. With
        // this file's PDF already on screen that's not worth a teardown —
        // hold the render and let the next tick pick up the replacement.
        if (alive) setPdfState(p => (isCurrent(p) && p.fp ? p : { id, path, err: String(e) }));
      });
    return () => { alive = false; };
  }, [kind, task.id, tab.path, fsRevision]);

  if (kind === "pdf") {
    // Native PDF via the custom secure scheme, keyed on the file's
    // fingerprint (see taskPdfSrc). TaskView keeps this element in the
    // render tree while the tab is hidden, so the page the user is on
    // survives a tab switch as long as this URL holds still.
    return (
      <div className="relative h-full overflow-auto bg-[var(--color-bg)]">
        {!pdf && <div className="p-4 text-[14px] text-[var(--color-fg-dim)]">Loading…</div>}
        {pdf?.err && <div className="p-4 text-[14px] text-[var(--color-err)]">Error: {pdf.err}</div>}
        {pdf?.fp && (
          <embed src={taskPdfSrc(task.id, tab.path, pdf.fp)} type="application/pdf" className="h-full w-full" />
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-auto bg-[var(--color-bg)]">
      {loading && <div className="p-4 text-[14px] text-[var(--color-fg-dim)]">Loading…</div>}
      {err && <div className="p-4 text-[14px] text-[var(--color-err)]">Error: {err}</div>}
      {url && (
        <div className="flex h-full items-center justify-center p-4">
          <img src={url} alt={tab.title} className="max-h-full max-w-full object-contain" />
        </div>
      )}
    </div>
  );
}
