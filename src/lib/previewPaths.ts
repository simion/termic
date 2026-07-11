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
