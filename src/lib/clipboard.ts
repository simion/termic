// Clipboard helpers. One place so every "copy" affordance gives the same
// toast feedback and failure handling instead of each call site re-deriving
// the navigator.clipboard.writeText(...).then().catch() boilerplate.

import { useUI } from "@/store/ui";

/** Copy arbitrary text, with a confirmation / failure toast. `label` is the
 *  human noun for the toast, e.g. "path" → `Copied path`. */
export function copyToClipboard(text: string, label = "text") {
  return navigator.clipboard.writeText(text)
    .then(() => useUI.getState().pushToast(`Copied ${label}`, "success"))
    .catch(() => useUI.getState().pushToast("Couldn't copy to clipboard", "error"));
}

/** Join a workspace root with a workspace-relative path into an absolute
 *  path, tolerating an empty relative segment and stray slashes. */
export function joinPath(root: string, rel: string): string {
  const r = rel.replace(/^\/+/, "");
  if (!r) return root;
  return `${root.replace(/\/+$/, "")}/${r}`;
}
