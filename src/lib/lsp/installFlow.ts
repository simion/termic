// Downloading a language server, from either surface that offers it (GH #174).
//
// The bug this exists to stop coming back: Search Everywhere's offer row had
// an Install button that only ARMED the checkout. Arming without an executable
// grants nothing anything can act on, so the dialog waited for symbols that
// were never coming while the editor chip went on offering the same download.
// The chip's own button did it correctly, three lines away in another file.
//
// So there is one flow, and both surfaces call it: disclose, download, and
// report a failure. Arming stays with the caller, because only it knows which
// grant key and task it is arming for.

import { lspInstall } from "./install";
import { memoryNote, serverFor } from "./serverNames";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";

export interface InstallRequest {
  /** Language/server id, e.g. "typescript". */
  server: string;
  /** What is being downloaded, e.g. "TypeScript 7 7.0.2". */
  label: string;
  /** Download size in bytes; 0 or null prints no figure rather than a wrong one. */
  bytes?: number | null;
  /** What to call the language in the sentence, e.g. "TypeScript". */
  language: string;
}

/** The disclosure both surfaces show. Split out so a test can read it without
 *  a dialog: what it must always carry is the size, where the bytes come from,
 *  and that nothing lands on the user's PATH. */
export function installMessage(req: InstallRequest): string {
  const mb = req.bytes ? Math.round(req.bytes / 1_000_000) : 0;
  return [
    i18n.t("backend:lsp.installMessage", {
      language: req.language,
      size: mb ? i18n.t("backend:lsp.installSize", { mb }) : "",
    }),
    memoryNote(serverFor(null, req.server)),
  ].filter(Boolean).join("\n\n");
}

/**
 * Ask, then download. Returns true when the server is on disk and the caller
 * should arm; false when the user declined or the download failed.
 *
 * The confirm `key` is per SERVER, not per surface: the size and the memory
 * figure are one disclosure about one process, and someone who has read it
 * once should not read it again because they came from the other button.
 */
export async function confirmAndInstall(req: InstallRequest): Promise<boolean> {
  const ui = useUI.getState();
  const ok = await ui.askConfirm({
    title: i18n.t("backend:lsp.downloadTitle", { label: req.label }),
    message: installMessage(req),
    confirmLabel: i18n.t("backend:lsp.downloadConfirm"),
    key: `code-intel-install:${req.server}`,
  });
  if (!ok) return false;
  try {
    await lspInstall(req.server);
    return true;
  } catch (e) {
    // Never silent: a failed download that reported nothing looks exactly like
    // a successful one that did not work, which is what sent this bug through
    // review in the first place.
    useUI.getState().pushToast(i18n.t("backend:lsp.installFailed", { label: req.label, error: String(e) }), "error");
    return false;
  }
}
