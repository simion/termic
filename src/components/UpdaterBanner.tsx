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
import { betaInfo, isBetaBuild } from "@/lib/build";
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

  // Beta: "Termic Beta.app", built from a branch by `make beta` and installed
  // next to the shipped app, sharing its data dir. It never self-updates
  // (store/update.ts skips the probe), so `update` is always null here and the
  // pill is permanent: the one thing telling this window apart from a shipped
  // one that is reading the very same tasks.
  if (isBetaBuild()) {
    const info = betaInfo();
    return (
      <span
        title={
          info
            ? `Termic Beta, built from ${info}. Shares the release app's data. Re-run make beta to move it forward.`
            : "Termic Beta, a local build. Shares the release app's data."
        }
        className="flex select-none items-center rounded-full border border-[var(--color-info)]/40 bg-[var(--color-info)]/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-info)]"
      >
        BETA
      </span>
    );
  }

  // Nothing pending, the user already dismissed this version, or the
  // sidebar is expanded (UpdateCard owns the surface there) → no pill.
  if (!update || update.version === dismissedVersion || !compact) return null;

  return (
    <button
      type="button"
      onClick={() => void install()}
      disabled={installing !== null}
      title={`Update to ${update.version} (current: ${update.currentVersion})`}
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
