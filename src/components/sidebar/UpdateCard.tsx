// "Something new" card — bottom of the sidebar, just above the footer
// row. Two mutually-exclusive modes (resolved in store/update.ts):
//
//   - update available → terracotta "Update now" button downloads,
//                         installs and relaunches into the new version.
//   - what's new       → post-update nudge: the running version is
//                         newer than the last one the user acknowledged.
//
// Deliberately minimal: one summary line + a "Changelog →" link into the
// full release notes. No per-version title on the card — that lives in
// the Changelog dialog.
//
// Shown ONLY when the sidebar is expanded. Collapsed mode falls back to
// the UpdaterBanner pill in the unified bar. Sidebar wraps this + the
// footer in one `mt-auto` group, so the card sits flush above the footer.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useUpdate, entryFor, cmpVersion } from "@/store/update";
import { cn } from "@/lib/utils";
import { X, ArrowDownToLine, RotateCw, ArrowRight, Sparkles } from "lucide-react";

export function UpdateCard() {
  const compact = useApp(s => s.compactSidebar);
  const openChangelog = useUI(s => s.openChangelog);

  const update = useUpdate(s => s.update);
  const installing = useUpdate(s => s.installing);
  const install = useUpdate(s => s.install);
  const dismissUpdate = useUpdate(s => s.dismissUpdate);
  const dismissWhatsNew = useUpdate(s => s.dismissWhatsNew);
  const changelog = useUpdate(s => s.changelog);
  const currentVersion = useUpdate(s => s.currentVersion);
  const dismissedVersion = useUpdate(s => s.dismissedVersion);
  const lastSeenVersion = useUpdate(s => s.lastSeenVersion);

  // Collapsed sidebar → the unified-bar pill owns the surface.
  if (compact) return null;

  // ── mode resolution ──────────────────────────────────────────────
  const updateAvailable = !!update && update.version !== dismissedVersion;
  const whatsNew =
    !update && !!currentVersion && cmpVersion(currentVersion, lastSeenVersion) > 0;

  if (!updateAvailable && !whatsNew) return null;

  const mode: "update" | "whatsnew" = updateAvailable ? "update" : "whatsnew";
  const version = mode === "update" ? update!.version : currentVersion;
  const entry = entryFor(changelog, version);

  // what's-new with nothing authored for the running version → skip;
  // there's no point nudging the user toward an empty release note.
  if (mode === "whatsnew" && !entry) return null;

  const summary =
    entry?.summary ||
    (mode === "update" ? "A new version of Termic is ready to install." : "");

  return (
    <div className="relative mx-2 mb-2 shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-2)] p-3">
      {/* Dismiss — absolute so the content starts at the card's top
          padding, no empty header row. */}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => (mode === "update" ? dismissUpdate() : dismissWhatsNew())}
        className="absolute right-1.5 top-1.5 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      {/* "What's new" eyebrow — what's-new mode only; the update card's
          "Update now" button already signals what it is. A quiet accent
          kicker (icon + text), not a filled badge. */}
      {mode === "whatsnew" && (
        <div className="mb-1.5 flex items-center gap-1 text-[var(--color-accent)]">
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span className="text-[11px] font-semibold">What's new</span>
        </div>
      )}

      {/* `pr-5` on the update card keeps the first line clear of the
          absolute × (the what's-new badge already pushes text below it). */}
      <p
        className={cn(
          "text-[12.5px] leading-snug text-[var(--color-fg-dim)]",
          mode === "update" && "pr-5",
        )}
      >
        {summary}
      </p>

      <button
        type="button"
        onClick={() => {
          openChangelog();
          // In what's-new mode the card is a one-shot nudge — opening the
          // full changelog satisfies it, so dismiss it. The update card stays
          // (the user still needs the "Update now" button).
          if (mode === "whatsnew") dismissWhatsNew();
        }}
        className="mt-2 flex items-center gap-1 text-[12px] font-medium text-[var(--color-accent)] hover:underline"
      >
        Changelog
        <ArrowRight className="h-3 w-3" />
      </button>

      {mode === "update" && (
        <button
          type="button"
          onClick={() => void install()}
          disabled={installing !== null}
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent-deep)] px-2 py-1.5 text-[12px] font-medium text-white hover:bg-[#8a3a1c] disabled:opacity-70"
        >
          {installing === null && (
            <>
              <ArrowDownToLine className="h-3.5 w-3.5 shrink-0" />
              <span>Update now</span>
            </>
          )}
          {installing === "downloading" && (
            <>
              <RotateCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span>Downloading…</span>
            </>
          )}
          {installing === "installing" && (
            <>
              <RotateCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span>Restarting…</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}
