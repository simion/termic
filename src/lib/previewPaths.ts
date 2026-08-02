// Which file-tree tabs render as a binary preview (image/PDF) instead of
// the CodeMirror editor. Kept in sync by hand with `preview_mime_for_ext`
// in src-tauri/src/lib.rs — the backend's whitelist for the base64 read
// channel; this is the frontend's routing subset of the same extensions.

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

function extOf(path: string): string {
  const base = path.split("/").pop() || path;
  return base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
}

/** "image" | "pdf" for a path the preview pane can render, else null (route
 *  to the regular editor). Extension-only, no IPC round trip — used at
 *  open-time to pick which pane component mounts. */
export function previewKindForPath(path: string): "image" | "pdf" | null {
  const ext = extOf(path);
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return null;
}

/** Tabs that must keep their `display` when hidden (TaskView drops every
 *  other hidden tab to display:none). Only the native PDF `<embed>`: its
 *  page lives inside WKWebView's PDF view, which is torn down and rebuilt at
 *  page 1 when the element leaves the render tree, and nothing in the DOM
 *  can record or restore it (unlike a CodeMirror or diff scroller, which
 *  lib/hiddenScrollRestore repairs). A diff tab on a .pdf path is NOT this:
 *  DiffPane renders text, not the embed. */
export function keepsDisplayWhenHidden(tab: { type: string; path?: string }): boolean {
  return tab.type === "edit" && !!tab.path && previewKindForPath(tab.path) === "pdf";
}

/** URL for the native PDF `<embed>`, served by the `taskpdf:` scheme handler
 *  in src-tauri. `fp` is the file's `mtime:len` fingerprint, used as the
 *  cache-buster: WKWebView re-fetches when the URL changes, so identical
 *  bytes MUST produce an identical URL or every agent turn would reload the
 *  PDF and drop the reader back to page 1. The backend ignores the value.
 *  encodeURIComponent so a task id or file name with odd characters survives
 *  the round trip (the handler splits on the first '/'). */
export function taskPdfSrc(taskId: string, path: string, fp: string): string {
  return `taskpdf://localhost/${encodeURIComponent(taskId)}/${encodeURIComponent(path)}?v=${encodeURIComponent(fp)}`;
}
