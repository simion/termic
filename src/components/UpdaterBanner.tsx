// Compact self-update surface — a small terracotta pill in the unified
// bar, shown ONLY when the sidebar is collapsed. When the sidebar is
// expanded the richer UpdateCard (sidebar, above the footer) is the
// update surface instead; this pill is the collapsed-mode fallback so
// a pending update is never unreachable.
//
// All update state — the check() probe, changelog fetch, install +
// relaunch dance — lives in store/update.ts. This component is pure
// presentation.

import { useEffect, useState } from "react";
import { useApp } from "@/store/app";
import { useUpdate } from "@/store/update";
import { automationArmed } from "@/lib/ipc";
import { ArrowDownToLine, RotateCw } from "lucide-react";

export function UpdaterBanner() {
  const update = useUpdate(s => s.update);
  const installing = useUpdate(s => s.installing);
  const install = useUpdate(s => s.install);
  const dismissedVersion = useUpdate(s => s.dismissedVersion);
  const compact = useApp(s => s.compactSidebar);

  // Is this window driven by the e2e automation bridge? If so the DEV pill
  // becomes a red E2E pill so an automated run is never mistaken for a normal
  // dev window. Only probed in dev builds (the command is absent in release).
  const [isE2E, setIsE2E] = useState(false);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    automationArmed().then(setIsE2E).catch(() => {});
  }, []);

  // Dev builds can't surface a real update (no signed release to check
  // against). With no mock update injected, claim the slot with a DEV
  // marker so a `tauri dev` window is unmistakable. VITE_MOCK_UPDATE
  // populates `update`, in which case we fall through to the real pill.
  // Opt out of the marker with VITE_HIDE_DEV_PILL=1 (e.g. for screen
  // recordings / screenshots where the badge is just noise).
  const hideDevPill =
    import.meta.env.VITE_HIDE_DEV_PILL === "1" ||
    import.meta.env.VITE_HIDE_DEV_PILL === "true";
  if (import.meta.env.DEV && !update && !hideDevPill) {
    return isE2E ? (
      <span
        title="Driven by the e2e automation bridge (TERMIC_AUTOMATION=1)."
        className="flex select-none items-center rounded-full border border-[var(--color-err)]/50 bg-[var(--color-err)]/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-err)]"
      >
        E2E
      </span>
    ) : (
      <span
        title="Development build, not a released version."
        className="flex select-none items-center rounded-full border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-warn)]"
      >
        DEV
      </span>
    );
  }

  // Is the update pill about to claim this slot? Pending, undismissed, and
  // the sidebar collapsed (expanded, the sidebar's UpdateCard owns it).
  const updatePillVisible = !!update && update.version !== dismissedVersion && compact;

  // Beta: a release build of a branch, installed into /Applications by
  // `make install-beta`. Same bundle id as the shipped app, so without a
  // marker there is nothing to tell them apart. Yields the slot to a real
  // pending update (installing it is how you get back to a shipped build).
  const beta =
    import.meta.env.VITE_BETA === "1" || import.meta.env.VITE_BETA === "true";
  if (beta && !updatePillVisible) {
    const info = import.meta.env.VITE_BETA_INFO;
    return (
      <span
        title={
          info
            ? `Beta build from ${info}, installed locally. Not a released version.`
            : "Beta build, installed locally. Not a released version."
        }
        className="flex select-none items-center rounded-full border border-[var(--color-info)]/40 bg-[var(--color-info)]/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-info)]"
      >
        BETA
      </span>
    );
  }

  if (!updatePillVisible) return null;
  const pending = update!;

  return (
    <button
      type="button"
      onClick={() => void install()}
      disabled={installing !== null}
      title={`Update to ${pending.version} (current: ${pending.currentVersion})`}
      className="flex items-center gap-1.5 rounded-full border border-[var(--color-accent-deep)] bg-[var(--color-accent-deep)] px-2.5 py-0.5 text-[12px] font-medium text-white hover:bg-[#8a3a1c] disabled:opacity-70"
    >
      {installing === null && (
        <>
          <ArrowDownToLine className="h-3 w-3" />
          <span>Download &amp; restart</span>
        </>
      )}
      {installing === "downloading" && (
        <>
          <RotateCw className="h-3 w-3 animate-spin" />
          <span>Downloading…</span>
        </>
      )}
      {installing === "installing" && (
        <>
          <RotateCw className="h-3 w-3 animate-spin" />
          <span>Restarting…</span>
        </>
      )}
    </button>
  );
}
