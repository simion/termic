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

import { useTranslation } from "react-i18next";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useUpdate, entryFor, cmpVersion } from "@/store/update";
import { cn } from "@/lib/utils";
import { X, ArrowDownToLine, RotateCw, ArrowRight, Sparkles, Check } from "lucide-react";
import { releasedAgo, releaseKind } from "@/lib/updateNotice";

export function UpdateCard() {
  const { t, i18n } = useTranslation("sidebar");
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
    (mode === "update" ? t("updateCard.defaultSummary") : "");
  // A patch merge reuses its release's entry, so its summary is one the user
  // has already read: the version and its age are the news. A patch is a
  // single quiet row; a minor or major release keeps the card.
  const kind = releaseKind(mode === "update" ? currentVersion : lastSeenVersion, version!);
  // The release's age only says something while an update is OFFERED (how
  // long it has waited); on "Updated to" it is just noise ("today").
  const ago = mode === "update" ? releasedAgo(update!.date, Date.now(), i18n.language) : "";
  const stamp = ago ? `v${version} · ${ago}` : `v${version}`;
  const dismiss = () => (mode === "update" ? dismissUpdate() : dismissWhatsNew());

  if (kind === "patch") {
    return (
      <div data-testid="update-patch" className="mx-2 mb-2 flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-accent-soft)] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg-1))] pl-2 pr-1 text-[12px] text-[var(--color-fg)]">
        {mode === "update"
          ? <ArrowDownToLine className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          : <Check className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />}
        <button
          type="button"
          title={summary}
          onClick={() => { openChangelog(); if (mode === "whatsnew") dismissWhatsNew(); }}
          className="min-w-0 flex-1 truncate text-left hover:text-[var(--color-fg)]"
        >
          {mode === "update" ? t("updateCard.patch") : t("updateCard.updated")} <span className="tabular-nums text-[var(--color-fg-dim)]">{stamp}</span>
        </button>
        {mode === "update" && (
          <button
            type="button"
            onClick={() => void install()}
            disabled={installing !== null}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-[var(--color-accent)] hover:bg-[var(--color-hover)] disabled:opacity-70"
          >
            {installing === null ? t("updateCard.update") : (
              <><RotateCw className="h-3 w-3 animate-spin" />{installing === "downloading" ? t("updateCard.downloading") : t("updateCard.restarting")}</>
            )}
          </button>
        )}
        <button
          type="button"
          aria-label={t("dismiss", { ns: "common" })}
          onClick={dismiss}
          className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // A minor or major release: drawn like the app's notifications
  // (ui/Toaster.tsx ToastFrame), lighter: the title with the release's age,
  // the summary, and the actions along the bottom.
  const cell = "flex min-h-[32px] flex-1 items-center justify-center gap-1.5 px-2 text-[12px] font-medium outline-none hover:bg-[var(--color-hover)] focus-visible:bg-[var(--color-hover)] disabled:opacity-70";
  return (
    <div data-testid="update-card" className="group relative mx-2 mb-2 shrink-0 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-1)] shadow-[0_10px_30px_-8px_rgba(0,0,0,0.55)]">
      <div className="flex gap-2.5 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 pr-4">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[13px] font-semibold text-[var(--color-fg)]">
              {/* Just the name and version: a longer title truncated beside the
                  age. The update's arrow is on its button; what's new, which has
                  no button, says so with a small sparkle here. */}
              {mode === "whatsnew" && <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />}
              {t("updateCard.title", { version })}
            </div>
            {ago && <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-fg-faint)]">{ago}</span>}
          </div>
          <p className="mt-0.5 line-clamp-3 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">{summary}</p>
        </div>
      </div>
      <button
        type="button"
        aria-label={t("dismiss", { ns: "common" })}
        onClick={dismiss}
        className="absolute right-1.5 top-1.5 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <div className="flex divide-x divide-[var(--color-border-soft)] border-t border-[var(--color-border-soft)]">
        <button
          type="button"
          onClick={() => {
            openChangelog();
            // What's new is a one-shot nudge: opening the changelog satisfies
            // it. The update stays (the user still needs to install it).
            if (mode === "whatsnew") dismissWhatsNew();
          }}
          className={cn(cell, "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]")}
        >
          {t("updateCard.changelog")}
          <ArrowRight className="h-3 w-3" />
        </button>
        {mode === "update" && (
          <button type="button" onClick={() => void install()} disabled={installing !== null} className={cn(cell, "text-[var(--color-accent)]")}>
            {installing === null && (<><ArrowDownToLine className="h-3.5 w-3.5 shrink-0" />{t("updateCard.updateNow")}</>)}
            {installing === "downloading" && (<><RotateCw className="h-3.5 w-3.5 shrink-0 animate-spin" />{t("updateCard.downloading")}</>)}
            {installing === "installing" && (<><RotateCw className="h-3.5 w-3.5 shrink-0 animate-spin" />{t("updateCard.restarting")}</>)}
          </button>
        )}
      </div>
    </div>
  );
}
