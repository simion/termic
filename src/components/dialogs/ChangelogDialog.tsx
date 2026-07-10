// Full release-notes browser. Opened from the sidebar UpdateCard's
// "Changelog →" link (and reusable from anywhere via useUI().openChangelog()).
//
// The body is the human-authored CHANGELOG.md, rendered with the same
// markdown pipeline as the editor's preview (MarkdownPreview). Data comes
// from store/update.ts, which fetches changelog.md (+ the slim changelog.json)
// once at launch. If that fetch failed (offline at startup) we retry when the
// dialog opens; if only the markdown failed we fall back to the per-version
// summaries from the JSON.

import { lazy, Suspense, useEffect } from "react";
import { useUI } from "@/store/ui";
import { useUpdate } from "@/store/update";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { AppDialog } from "@/components/ui/Dialog";
import { Loader2 } from "lucide-react";

// markdown-it + mermaid are heavy; load the renderer only when the dialog
// actually shows notes (same lazy split the editor preview uses).
const MarkdownPreview = lazy(() =>
  import("@/components/task/MarkdownPreview").then(m => ({ default: m.MarkdownPreview })),
);

// Drop CHANGELOG.md's leading "# Changelog" title + intro paragraph — the
// dialog has its own "Changelog" title bar. Render from the first version
// heading onward (mirrors the /changelog page on termic.dev).
function stripHeader(md: string): string {
  const i = md.search(/^## \[/m);
  return i >= 0 ? md.slice(i) : md;
}

export function ChangelogDialog() {
  const open = useUI(s => s.changelogOpen);
  const close = useUI(s => s.closeChangelog);
  const changelog = useUpdate(s => s.changelog);
  const markdown = useUpdate(s => s.changelogMarkdown);
  const status = useUpdate(s => s.changelogStatus);
  const currentVersion = useUpdate(s => s.currentVersion);
  const fetchChangelog = useUpdate(s => s.fetchChangelog);

  const themeDark = resolveTheme(usePrefs(s => s.themeMode)) !== "light";
  const hasData = !!markdown || !!changelog;

  // Retry the fetch on open if nothing ever loaded (the launch fetch failed —
  // offline, CF hiccup, etc.).
  useEffect(() => {
    if (open && !hasData && status !== "loading") void fetchChangelog();
  }, [open, hasData, status, fetchChangelog]);

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => { if (!v) close(); }}
      title="Changelog"
      className="max-w-4xl"
    >
      {!hasData && status === "loading" && (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--color-fg-dim)]">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--color-accent)]" />
          Loading changelog…
        </div>
      )}

      {!hasData && status === "error" && (
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

      {/* Primary path: render the human-authored markdown. MarkdownPreview owns
          its own scroll container, so give it a bounded height. */}
      {markdown && (
        <div className="-mx-1 h-[65vh]">
          <Suspense fallback={
            <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--color-fg-dim)]">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--color-accent)]" />
              Loading changelog…
            </div>
          }>
            <MarkdownPreview text={stripHeader(markdown)} themeDark={themeDark} linkify={false} />
          </Suspense>
        </div>
      )}

      {/* Fallback: the markdown fetch failed but the slim JSON loaded — show
          each version's one-line summary. */}
      {!markdown && changelog && changelog.length === 0 && (
        <p className="py-10 text-center text-[13px] text-[var(--color-fg-dim)]">
          No changelog entries yet.
        </p>
      )}
      {!markdown && changelog && changelog.length > 0 && (
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
            </article>
          ))}
        </div>
      )}
    </AppDialog>
  );
}
