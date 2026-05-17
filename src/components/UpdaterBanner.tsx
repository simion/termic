// In-app self-update surface. Lives in the top-right of the unified
// bar - a small terracotta pill that appears only when an update is
// actually available. Clicking it kicks the download + install +
// relaunch flow, which is gated by an ed25519 signature check the
// tauri-plugin-updater performs against the public key baked into
// `tauri.conf.json`'s `plugins.updater.pubkey`.
//
// Lifecycle:
//   - On mount, calls check() once. If `update` is non-null, surfaces
//     the pill.
//   - Tick every 6h while the app is open so long-running sessions
//     eventually notice releases that landed mid-day.
//   - Click → downloadAndInstall() then relaunch(); the bundled
//     `tauri-plugin-updater` handles the dance.
//   - Errors are logged but never blocking - if the network is down
//     or the manifest is malformed, no pill, no harm.

import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ArrowDownToLine, RotateCw } from "lucide-react";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export function UpdaterBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [busy, setBusy] = useState<"checking" | "downloading" | "installing" | null>(null);

  // Initial check on mount + periodic re-check.
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const u = await check();
        if (!cancelled) setUpdate(u);
      } catch (e) {
        // Don't pester - the pill simply won't appear. Logged for
        // dev visibility.
        console.warn("[updater] check failed:", e);
      }
    };
    probe();
    const id = window.setInterval(probe, CHECK_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  if (!update) return null;

  async function install() {
    if (!update) return;
    setBusy("downloading");
    try {
      // downloadAndInstall fires a progress callback we ignore for v1 -
      // banner just says "Installing...". v2 idea: show byte progress
      // for the download phase.
      await update.downloadAndInstall();
      setBusy("installing");
      // Tauri-plugin-process relaunch() spawns a fresh instance of the
      // (just-installed) .app and exits the current one cleanly.
      await relaunch();
    } catch (e) {
      console.error("[updater] install failed:", e);
      setBusy(null);
    }
  }

  return (
    <button
      type="button"
      onClick={install}
      disabled={busy !== null}
      title={`Update to ${update.version} (current: ${update.currentVersion})`}
      className="flex items-center gap-1.5 rounded-full border border-[var(--color-accent-deep)] bg-[var(--color-accent-deep)] px-2.5 py-0.5 text-[12px] font-medium text-white hover:bg-[#8a3a1c] disabled:opacity-70"
    >
      {busy === null && (
        <>
          <ArrowDownToLine className="h-3 w-3" />
          <span>Update {update.version}</span>
        </>
      )}
      {busy === "downloading" && (
        <>
          <RotateCw className="h-3 w-3 animate-spin" />
          <span>Downloading…</span>
        </>
      )}
      {busy === "installing" && (
        <>
          <RotateCw className="h-3 w-3 animate-spin" />
          <span>Restarting…</span>
        </>
      )}
    </button>
  );
}
