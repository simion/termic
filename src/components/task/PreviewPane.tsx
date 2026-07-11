// Read-only preview for image/PDF files opened from the file tree. No
// CodeMirror instance: just an <img>/<embed> fed a base64 data URL read
// over IPC (taskFileReadBase64), same extension whitelist as the Rust
// side (previewKindForPath / preview_mime_for_ext).

import { useEffect, useRef, useState } from "react";
import type { EditTab, Task } from "@/lib/types";
import { taskFileReadBase64 } from "@/lib/ipc";
import { previewKindForPath } from "@/lib/previewPaths";
import { useApp } from "@/store/app";

export function PreviewPane({ task, tab }: { task: Task; tab: EditTab }) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  // Last-read `mtime:len` fingerprint, sent as `knownFp` on the next read so
  // an agent-settle refetch of an unchanged file skips the read + base64
  // encode entirely (`unchanged: true`, no `mime`/`data`). Reset whenever the
  // tab switches to a different file, a fresh file has nothing to compare
  // against.
  const fpRef = useRef<string | undefined>(undefined);
  const identityRef = useRef<string | null>(null);

  // Per-task "files changed" tick (bumped on agent-settle) — re-fetch a
  // preview an agent just (re)wrote. No dirty/unsaved state to protect here
  // (the pane is read-only), so this can reload silently, unlike EditorPane's
  // disk-changed prompt.
  const fsRevision = useApp(s => s.fsRevision[task.id] ?? 0);

  useEffect(() => {
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
  }, [task.id, tab.path, fsRevision]);

  const kind = previewKindForPath(tab.path);

  return (
    <div className="relative h-full overflow-auto bg-[var(--color-bg)]">
      {loading && <div className="p-4 text-[14px] text-[var(--color-fg-dim)]">Loading…</div>}
      {err && <div className="p-4 text-[14px] text-[var(--color-err)]">Error: {err}</div>}
      {url && kind === "image" && (
        <div className="flex h-full items-center justify-center p-4">
          <img src={url} alt={tab.title} className="max-h-full max-w-full object-contain" />
        </div>
      )}
      {url && kind === "pdf" && (
        <embed src={url} type="application/pdf" className="h-full w-full" />
      )}
    </div>
  );
}
