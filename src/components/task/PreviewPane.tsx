// Read-only preview for image/PDF files opened from the file tree. No
// CodeMirror instance. Images render as an <img> fed a base64 data URL read
// over IPC (taskFileReadBase64). PDFs render as an <embed> pointed at the
// `taskpdf:` URI scheme (src-tauri): WKWebView renders a PDF served as a real
// application/pdf resource, but shows blank for a data: URL, so PDFs can't go
// through the base64 channel. Same extension whitelist on both sides
// (previewKindForPath / preview_mime_for_ext).

import { useEffect, useRef, useState } from "react";
import type { EditTab, Task } from "@/lib/types";
import { taskFileReadBase64 } from "@/lib/ipc";
import { previewKindForPath } from "@/lib/previewPaths";
import { useApp } from "@/store/app";

export function PreviewPane({ task, tab }: { task: Task; tab: EditTab }) {
  const kind = previewKindForPath(tab.path);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

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
    // PDFs render declaratively via <embed> below (the `?v=` cache-buster on
    // its src is what reloads them on an fsRevision tick), so the base64 fetch
    // only runs for images.
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

  if (kind === "pdf") {
    // Native PDF via the custom secure scheme. The `?v=` param busts the
    // webview cache on agent-settle so a rewritten PDF reloads; the backend
    // ignores its value. encodeURIComponent so a task id or file name with odd
    // characters survives the round trip (the handler splits on the first '/').
    const src = `taskpdf://localhost/${encodeURIComponent(task.id)}/${encodeURIComponent(tab.path)}?v=${fsRevision}`;
    return (
      <div className="relative h-full overflow-auto bg-[var(--color-bg)]">
        <embed src={src} type="application/pdf" className="h-full w-full" />
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
