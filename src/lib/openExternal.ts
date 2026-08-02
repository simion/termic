// Handing a file to the OS default app (GH #147), the file tree's
// double-click. Split from the component so the outcome-to-toast mapping is
// testable without mounting React.
//
// The open/reveal fallback itself lives in Rust (`open_file_external`): only
// the backend can see the launcher's exit status, which is what says "nothing
// is registered for .blend". This module just reports the outcome.

import { openFileExternal } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import { IS_MAC } from "@/lib/shortcuts";

const FILE_MANAGER = IS_MAC ? "Finder" : "File Manager";

/** Open `abs` in its default app. `name` is the basename, used in the toast.
 *  Never throws: a failure to open is reported to the user, not to the
 *  caller, since every call site is a click handler with nowhere to put it. */
export async function openInDefaultApp(abs: string, name: string): Promise<void> {
  const toast = useUI.getState().pushToast;
  try {
    const outcome = await openFileExternal(abs);
    // A successful launch speaks for itself (the app comes to the front), so
    // only the fallback needs saying. Without this the user sees a file
    // manager pop up with no explanation of why the app didn't open.
    if (outcome === "revealed") {
      toast(`No app is set to open ${name}. Showed it in ${FILE_MANAGER}.`, "info");
    }
  } catch (e) {
    toast(`Could not open ${name}: ${String(e)}`, "error");
  }
}
