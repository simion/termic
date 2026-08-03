// GitHub-style folder view (issue #151). A directory link in a markdown
// preview used to only nudge the sidebar tree; it now opens this pane in the
// preview tab: the folder's contents as a clickable list, with the folder's
// README rendered underneath when it has one.
//
// The listing is read-only and cheap (one `task_dir_list` per folder), so
// unlike EditorPane there's no dirty state to protect — an agent-settle tick
// (fsRevision) just re-reads silently.

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ChevronRight, CornerLeftUp, FolderOpen } from "lucide-react";
import type { DirTab, FileEntry, Task } from "@/lib/types";
import { taskDirList, taskFileRead } from "@/lib/ipc";
import { findReadme } from "@/lib/readme";
import { navigateDirTab } from "@/lib/dirTabs";
import { fileIconUrl, folderIconUrl } from "@/lib/explorer/iconResolver";
import { useApp } from "@/store/app";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { cn } from "@/lib/utils";

const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").then(m => ({ default: m.MarkdownPreview })),
);

/** Join a task-root-relative dir with a child name. "" is the task root,
 *  where a leading "/" would turn the result absolute. */
function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function DirListingPane(
  { task, tab, visible = true }: {
    task: Task; tab: DirTab;
    /** Whether this tab is the one actually on screen. Threaded down to the
     *  README's MarkdownPreview, which arms a capture-phase window listener
     *  for ⌘F and revalidates images on every fsRevision tick — both of
     *  which a `display: none` listing must not do. Without it a hidden
     *  listing swallows ⌘F for the whole app. */
    visible?: boolean;
  },
) {
  const dir = tab.path;
  // Entries are LABELLED with the folder they were read for. Recycling this
  // tab to another folder must not flash the previous folder's contents
  // while the new read is in flight, and deriving null for a mismatched
  // label shows "Loading…" from the first render instead. A plain
  // `setEntries(null)` on every effect run would blink on each fsRevision
  // tick too, where the listing on screen is still the right one.
  const [listing, setListing] = useState<{ path: string; entries: FileEntry[] } | null>(null);
  const entries = listing?.path === dir ? listing.entries : null;
  // Labelled like `listing` and `readme` below: an unlabelled error would
  // paint the PREVIOUS folder's failure over the new folder's "Loading…" for
  // one frame, blaming a folder that hasn't been read yet.
  const [err, setErr] = useState<{ path: string; msg: string } | null>(null);
  // README source, labelled with the path it was read for. A stale label
  // (tab recycled to another folder before the read landed) renders as no
  // README rather than the previous folder's text.
  const [readme, setReadme] = useState<{ path: string; text: string } | null>(null);

  // Per-task "files changed" tick, bumped when an agent settles — exactly
  // when the listing and the README may have gone stale.
  const fsRev = useApp(s => s.fsRevision[task.id] ?? 0);

  useEffect(() => {
    let alive = true;
    setErr(null);
    taskDirList(task.id, dir)
      .then(list => { if (alive) setListing({ path: dir, entries: list }); })
      .catch(e => { if (alive) { setListing({ path: dir, entries: [] }); setErr({ path: dir, msg: String(e) }); } });
    return () => { alive = false; };
  }, [task.id, dir, fsRev]);

  // `task_dir_list` already returns folders first then files, alphabetic
  // within each group (see task_dir_list_sync's trailing sort_by), which is
  // exactly the order to render. FileTree trusts it too; re-sorting here
  // would just be a second copy of the rule, free to drift.
  const readmeName = useMemo(() => entries ? findReadme(entries) : null, [entries]);
  const readmePath = readmeName ? joinRel(dir, readmeName) : null;

  useEffect(() => {
    if (!readmePath) { setReadme(null); return; }
    let alive = true;
    taskFileRead(task.id, readmePath)
      .then(text => { if (alive) setReadme({ path: readmePath, text }); })
      // A README that won't read is not an error worth a banner — the
      // listing is still the point of the pane. Drop it and show the list.
      .catch(() => { if (alive) setReadme(null); });
    return () => { alive = false; };
  }, [task.id, readmePath, fsRev]);

  // Remote-image gate for the rendered README, same contract as
  // MarkdownPane: the pref is the default, a per-tab override unblocks
  // just this document. See docs/sandbox.md "Known gap".
  const loadRemoteImages = usePrefs(s => s.loadRemoteImages);
  const remoteImagesAllowed = tab.remoteImagesUnblocked ?? loadRemoteImages;
  const themeDark = resolveTheme(usePrefs(s => s.themeMode)) !== "light";
  const memberDirs = useMemo(() => task.composition?.map(m => m.dir_name), [task.composition]);

  const segments = dir ? dir.split("/") : [];
  const parent = segments.length ? segments.slice(0, -1).join("/") : null;

  const openEntry = (e: FileEntry) => {
    const rel = joinRel(dir, e.name);
    if (e.is_dir) { navigateDirTab(task.id, tab.id, rel); return; }
    // Pin this listing BEFORE opening the file. While the listing occupies
    // the preview slot, the file would recycle it away and there'd be no way
    // back to the folder you were browsing. Persisting first hands the slot
    // to the file instead, so the listing stays put and a second file click
    // still recycles rather than piling up a tab per file.
    useApp.getState().persistTab(task.id, tab.id);
    useApp.getState().openPreviewTab(task.id, { type: "edit", path: rel, title: e.name });
  };

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      {/* Path bar. Geometry matches EditorBreadcrumb (h-7) so switching
          between a file tab and a folder tab doesn't shift the content. */}
      <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2 text-[12px]">
        <img src={folderIconUrl(segments[segments.length - 1] ?? "", true)} alt="" className="mr-1 h-3.5 w-3.5 shrink-0 file-icon" />
        <div className="flex min-w-0 flex-1 items-center overflow-hidden">
          <button
            onClick={() => navigateDirTab(task.id, tab.id, "")}
            title="Task root"
            className={cn(
              "max-w-[240px] truncate rounded px-1 py-0.5 hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
              segments.length ? "text-[var(--color-fg-dim)]" : "text-[var(--color-fg)]",
            )}
          >{task.path.split("/").pop() || "/"}</button>
          {segments.map((seg, i) => {
            const rel = segments.slice(0, i + 1).join("/");
            const isLast = i === segments.length - 1;
            return (
              <div key={rel} className="flex min-w-0 items-center">
                <ChevronRight className="mx-0.5 h-3 w-3 shrink-0 text-[var(--color-fg-faint)]" />
                <button
                  onClick={() => navigateDirTab(task.id, tab.id, rel)}
                  title={rel}
                  className={cn(
                    "max-w-[240px] truncate rounded px-1 py-0.5 hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
                    isLast ? "text-[var(--color-fg)]" : "text-[var(--color-fg-dim)]",
                  )}
                >{seg}</button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[900px] p-4">
          {err?.path === dir && (
            <div className="mb-3 rounded border border-[var(--color-border)] px-3 py-2 text-[12.5px] text-[var(--color-fg-dim)]">
              Couldn't read this folder: {err.msg}
            </div>
          )}
          {entries === null ? (
            <div className="text-[13px] text-[var(--color-fg-dim)]">Loading…</div>
          ) : (
            <div data-testid="dir-listing" className="overflow-hidden rounded border border-[var(--color-border)]">
              {/* ".." first, the way GitHub and every file manager do it.
                  Deliberately NOT tagged data-dir-entry: it isn't a member of
                  the folder, and lumping it in would make "what's in here"
                  queries (and the e2e row assertions) lie. Rendered even for
                  an empty folder, which otherwise has no way out. */}
              {parent !== null && (
                <button
                  data-testid="dir-up"
                  onClick={() => navigateDirTab(task.id, tab.id, parent)}
                  title={parent ? `Up to ${parent}` : "Up to the task root"}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
                >
                  <CornerLeftUp className="h-4 w-4 shrink-0" />..
                </button>
              )}
              {/* Only when the folder genuinely IS empty. On a read failure
                  the entries are [] too, and claiming "empty" directly under
                  "Couldn't read this folder" contradicts the error above. */}
              {entries.length === 0 && err?.path !== dir && (
                <div className={cn(
                  "flex items-center gap-2 px-3 py-6 text-[13px] text-[var(--color-fg-dim)]",
                  parent !== null && "border-t border-[var(--color-border-soft)]",
                )}>
                  <FolderOpen className="h-4 w-4" />This folder is empty.
                </div>
              )}
              {entries.map((e, i) => (
                <button
                  key={e.name}
                  data-dir-entry={e.name}
                  onClick={() => openEntry(e)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[var(--color-fg)] hover:bg-[var(--color-hover)]",
                    (i > 0 || parent !== null) && "border-t border-[var(--color-border-soft)]",
                  )}
                >
                  <img
                    src={e.is_dir ? folderIconUrl(e.name, false) : fileIconUrl(e.name)}
                    alt=""
                    className="h-4 w-4 shrink-0 file-icon"
                  />
                  <span className="truncate">{e.name}</span>
                </button>
              ))}
            </div>
          )}

          {/* README under the listing, exactly where GitHub puts it. The
              ctx filePath is the README's OWN path, not the folder's, so
              relative links inside it resolve against the right base. */}
          {readmePath && readme?.path === readmePath && (
            <div data-testid="dir-readme" className="mt-4 overflow-hidden rounded border border-[var(--color-border)]">
              <div className="flex h-8 items-center gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3 text-[12px] text-[var(--color-fg-dim)]">
                <img src={fileIconUrl(readmeName!)} alt="" className="h-3.5 w-3.5 shrink-0 file-icon" />
                {readmeName}
              </div>
              {/* Height-capped rather than h-full: MarkdownPreview fills its
                  container, and this one sits inside the page's own scroller. */}
              <div className="h-[70vh]">
                <Suspense fallback={<div className="p-4 text-[13px] text-[var(--color-fg-dim)]">Loading preview…</div>}>
                  <MarkdownPreview
                    text={readme.text}
                    visible={visible}
                    themeDark={themeDark}
                    ctx={{ taskId: task.id, filePath: readmePath, epoch: fsRev, memberDirs, hostDirTabId: tab.id }}
                    remoteImagesAllowed={remoteImagesAllowed}
                    onUnblockRemoteImages={
                      remoteImagesAllowed ? undefined
                        : () => useApp.getState().patchTab(task.id, tab.id, { remoteImagesUnblocked: true })
                    }
                    onAlwaysLoadRemoteImages={
                      remoteImagesAllowed ? undefined : () => usePrefs.getState().setLoadRemoteImages(true)
                    }
                  />
                </Suspense>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
