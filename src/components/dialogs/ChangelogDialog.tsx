// Full release-notes browser — every version in changelog.json, newest
// first. Opened from the sidebar UpdateCard's "Changelog →" link (and
// reusable from anywhere via useUI().openChangelog()).
//
// Data comes from store/update.ts, which fetches changelog.json once at
// launch. If that fetch failed (offline at startup) we retry when the
// dialog opens. Each version is just a dated one-line summary — the
// same string the sidebar UpdateCard shows for the latest release.

import { useEffect } from "react";
import { useUI } from "@/store/ui";
import { useUpdate } from "@/store/update";
import { AppDialog } from "@/components/ui/Dialog";
import { Loader2 } from "lucide-react";

export function ChangelogDialog() {
  const open = useUI(s => s.changelogOpen);
  const close = useUI(s => s.closeChangelog);
  const changelog = useUpdate(s => s.changelog);
  const status = useUpdate(s => s.changelogStatus);
  const currentVersion = useUpdate(s => s.currentVersion);
  const fetchChangelog = useUpdate(s => s.fetchChangelog);

  // Retry the fetch on open if the changelog never loaded (the launch
  // fetch failed — offline, CF hiccup, etc.).
  useEffect(() => {
    if (open && !changelog && status !== "loading") void fetchChangelog();
  }, [open, changelog, status, fetchChangelog]);

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => { if (!v) close(); }}
      title="Changelog"
      className="max-w-2xl"
    >
      {!changelog && status === "loading" && (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--color-fg-dim)]">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--color-accent)]" />
          Loading changelog…
        </div>
      )}

      {!changelog && status === "error" && (
        <div className="py-10 text-center text-[13px] text-[var(--color-fg-dim)]">
          <p>Couldn't load the changelog.</p>
          <button
            type="button"
            onClick={() => void fetchChangelog()}
            className="mt-2 text-[var(--color-accent)] hover:underline"
          >
            Retry
          </button>
        </div>
      )}

      {changelog && changelog.length === 0 && (
        <p className="py-10 text-center text-[13px] text-[var(--color-fg-dim)]">
          No changelog entries yet.
        </p>
      )}

      {changelog && changelog.length > 0 && (
        <div className="flex flex-col py-1">
          {changelog.map(e => (
            <article
              key={e.version}
              className="mt-4 flex flex-col gap-1 border-t border-[var(--color-border-soft)] pt-4 first:mt-0 first:border-0 first:pt-0"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[13px] font-semibold text-[var(--color-fg)]">
                  v{e.version}
                </span>
                {e.date && (
                  <span className="text-[11.5px] text-[var(--color-fg-faint)]">{e.date}</span>
                )}
                {e.version === currentVersion && (
                  <span className="rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-dim)]">
                    Installed
                  </span>
                )}
              </div>
              {e.summary && (
                <p className="text-[12.5px] leading-snug text-[var(--color-fg)]">{e.summary}</p>
              )}
              {e.notes && e.notes.length > 0 && (
                <ul className="mt-1 list-disc space-y-1 pl-5 text-[12.5px] leading-snug text-[var(--color-fg-dim)] marker:text-[var(--color-fg-faint)]">
                  {e.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      )}
    </AppDialog>
  );
}
