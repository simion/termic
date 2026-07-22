// Clipboard helpers. One place so every "copy" affordance gives the same
// toast feedback and failure handling instead of each call site re-deriving
// the writeText(...).then().catch() boilerplate.

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useUI } from "@/store/ui";

/** Copy arbitrary text, with a confirmation / failure toast. `label` is the
 *  human noun for the toast, e.g. "path" → `Copied path`.
 *
 *  Writes via the Rust clipboard plugin, NOT navigator.clipboard: WKWebView
 *  gates the web API on transient user activation + document focus, and a
 *  Radix menu's onSelect fires from a synthetic event that carries neither —
 *  every context-menu copy rejected with NotAllowedError. The plugin talks
 *  to NSPasteboard directly and has no gesture requirement; the web API is
 *  kept only as a fallback should the IPC ever fail. */
export function copyToClipboard(text: string, label = "text") {
  return writeText(text)
    .catch(() => navigator.clipboard.writeText(text))
    .then(() => useUI.getState().pushToast(`Copied ${label}`, "success"))
    .catch(() => useUI.getState().pushToast("Couldn't copy to clipboard", "error"));
}

/** Join a task root with a task-relative path into an absolute
 *  path, tolerating an empty relative segment and stray slashes. */
export function joinPath(root: string, rel: string): string {
  const r = rel.replace(/^\/+/, "");
  if (!r) return root;
  return `${root.replace(/\/+$/, "")}/${r}`;
}
