// Lazy-loading file tree for the "All files" panel.
// - Initial render fetches the workspace root only.
// - Clicking a dir expands it and fetches its entries on demand (cached by rel-path).
// - Clicking a file opens/selects an edit tab in the workspace.
// - Indentation reflects depth; chevrons rotate to indicate expansion state.

import { useEffect, useState, useCallback, useRef } from "react";
import { ChevronRight, Pencil, Trash2 } from "lucide-react";
import type { FileEntry } from "@/lib/types";
import { workspaceDirList, workspacePathRename, workspacePathDelete } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { cn } from "@/lib/utils";
import { fileIconUrl, folderIconUrl } from "@/lib/explorer/iconResolver";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/ContextMenu";
import { CopyPathItems } from "./CopyPathItems";

interface Props {
  wsId: string;
  /** Bump to force a re-read from disk (e.g. the header refresh button).
   *  Preserves the expanded folder set: root + every open dir is
   *  re-fetched, the rest of the cache is dropped. */
  reloadToken?: number;
  /** The manual-refresh counter alone (a subset of `reloadToken`). When it
   *  changes, the root re-read also restores any missing repo-root member
   *  symlink. Agent-settle reloads bump `reloadToken` but not this, so they
   *  skip the heal. */
  refreshToken?: number;
}

// Expanded folders, kept per workspace across switches. FileTree is a single
// shared instance (lives under RightPanel, not per-workspace), so its local
// `expanded` state would be wiped every time `wsId` changes. This module-level
// map survives the swap so re-selecting a workspace restores its open folders.
const expandedByWs = new Map<string, Set<string>>();

// Compare a freshly re-fetched listing against the cached one. `next` holds
// only the dirs we re-read (root + expanded), which are exactly the ones the
// tree renders, so it's the source of truth for keys: if every dir in `next`
// matches what we already have (same names, same dir-ness, same order from a
// stable readdir), the visible tree is unchanged and we can skip the update.
function sameChildren(
  prev: Record<string, FileEntry[]>,
  next: Record<string, FileEntry[]>,
): boolean {
  for (const rel in next) {
    const a = prev[rel];
    const b = next[rel];
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < b.length; i++) {
      if (a[i].name !== b[i].name || a[i].is_dir !== b[i].is_dir) return false;
    }
  }
  return true;
}

export function FileTree({ wsId, reloadToken = 0, refreshToken = 0 }: Props) {
  // Absolute workspace root, used to build the "Copy path" (absolute) item.
  // Tree `rel` paths are workspace-root-relative, so absolute = root/rel.
  const root = useApp(s => s.workspaces.find(w => w.id === wsId)?.path ?? "");
  const [rootEntries, setRootEntries] = useState<FileEntry[] | null>(null);
  // Per-dir cache of children, keyed by rel-path ("" = root).
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  // Expanded set keyed by rel-path. Seeded from (and mirrored back to) the
  // per-workspace map so switching away and back keeps the tree open.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(expandedByWs.get(wsId)));
  // Tracks in-flight dir loads so we don't double-fetch.
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [err, setErr] = useState<string | null>(null);

  // Mirror the expanded set in a ref so the reload effect can re-fetch
  // currently-open dirs without depending on `expanded` (which would
  // make it re-run on every expand/collapse).
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  // Mirror children too: the reload effect (driven by an agent settling)
  // compares the fresh listing against this to avoid a setState — and the
  // whole-tree re-render it triggers — when nothing on disk actually changed.
  const childrenRef = useRef(children);
  childrenRef.current = children;

  const treeRef = useRef<HTMLDivElement>(null);
  // Path briefly highlighted after a reveal-in-tree.
  const [revealedRel, setRevealedRel] = useState<string | null>(null);
  const revealFile = useApp(s => s.revealFile);
  const clearReveal = useApp(s => s.clearReveal);

  // Load root on mount / wsId change. Restore this workspace's previously
  // expanded folders (empty on first visit) and re-fetch them so they show
  // their contents; the stale cache for the old workspace is dropped.
  useEffect(() => {
    const saved = new Set(expandedByWs.get(wsId));
    setRootEntries(null); setChildren({}); setExpanded(saved); setErr(null);
    let alive = true;
    // Launch is an intentional moment — heal missing member symlinks here.
    const toLoad = ["", ...saved];
    Promise.all(toLoad.map(rel =>
      workspaceDirList(wsId, rel, rel === "")
        .then(list => [rel, list] as const)
        .catch(() => [rel, null] as const),
    )).then(results => {
      if (!alive) return;
      const patch: Record<string, FileEntry[]> = {};
      for (const [rel, list] of results) if (list) patch[rel] = list;
      if (!patch[""]) { setErr("Failed to read workspace files"); return; }
      setRootEntries(patch[""]);
      // Merge (not replace) so a reveal-in-tree that expanded ancestor dirs
      // while this load was in flight doesn't get its children clobbered.
      // The synchronous reset above already dropped stale entries.
      setChildren(c => ({ ...c, ...patch }));
    });
    return () => { alive = false; };
  }, [wsId]);

  // Manual refresh: re-read root + every expanded dir from disk, keeping
  // the expansion state. Skips the initial render (token starts at 0).
  const firstRef = useRef(true);
  const prevRefresh = useRef(refreshToken);
  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return; }
    let alive = true;
    // Heal member symlinks only when THIS reload was the manual refresh
    // button (refreshToken bumped), not an agent-settle / settings re-read.
    const heal = refreshToken !== prevRefresh.current;
    prevRefresh.current = refreshToken;
    const toLoad = ["", ...Array.from(expandedRef.current)];
    Promise.all(toLoad.map(rel =>
      workspaceDirList(wsId, rel, heal && rel === "").then(list => [rel, list] as const).catch(() => [rel, null] as const),
    )).then(results => {
      if (!alive) return;
      const next: Record<string, FileEntry[]> = {};
      for (const [rel, list] of results) if (list) next[rel] = list;
      // Skip the update (and the tree-wide re-render) if every re-fetched
      // dir is byte-identical to what we already have. The common case after
      // an agent turn is "nothing in the visible tree changed".
      if (sameChildren(childrenRef.current, next)) return;
      setChildren(next);
      setRootEntries(next[""] ?? []);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  const ensureLoaded = useCallback(async (rel: string) => {
    if (children[rel] || loading.has(rel)) return;
    setLoading(s => { const n = new Set(s); n.add(rel); return n; });
    try {
      const list = await workspaceDirList(wsId, rel);
      setChildren(c => ({ ...c, [rel]: list }));
    } catch (e) { console.error("dir list failed", rel, e); }
    finally { setLoading(s => { const n = new Set(s); n.delete(rel); return n; }); }
  }, [wsId, children, loading]);

  // Force a re-read of one dir from disk + update the cache. Used after a
  // context-menu rename/delete mutates that directory's contents. "" = root.
  const refetchDir = useCallback(async (rel: string) => {
    try {
      const list = await workspaceDirList(wsId, rel);
      setChildren(c => ({ ...c, [rel]: list }));
      if (rel === "") setRootEntries(list);
    } catch (e) { console.error("refetch dir failed", rel, e); }
  }, [wsId]);

  const toggle = useCallback((rel: string) => {
    setExpanded(s => {
      const n = new Set(s);
      if (n.has(rel)) n.delete(rel); else { n.add(rel); ensureLoaded(rel); }
      expandedByWs.set(wsId, n);
      return n;
    });
  }, [ensureLoaded, wsId]);

  // Reveal-in-tree: expand the path's ancestors, scroll to it, highlight it.
  // Driven by the store (set by the editor breadcrumb / locate button) so it
  // works even after the panel is un-hidden and switched to the files view.
  useEffect(() => {
    if (!revealFile || revealFile.wsId !== wsId || !revealFile.path) return;
    let alive = true;
    const { path, isDir } = revealFile;
    (async () => {
      const parts = path.split("/").filter(Boolean);
      const upto = isDir ? parts.length : parts.length - 1;
      const dirs: string[] = [];
      for (let i = 0; i < upto; i++) dirs.push(parts.slice(0, i + 1).join("/"));
      const patch: Record<string, FileEntry[]> = {};
      await Promise.all(dirs.map(async d => {
        try { patch[d] = await workspaceDirList(wsId, d); } catch {}
      }));
      if (!alive) return;
      if (Object.keys(patch).length) setChildren(c => ({ ...c, ...patch }));
      setExpanded(s => { const n = new Set(s); dirs.forEach(d => n.add(d)); expandedByWs.set(wsId, n); return n; });
      setRevealedRel(path);
      // Two rAFs so the freshly-expanded rows have laid out before scrolling.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        treeRef.current
          ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
          ?.scrollIntoView({ block: "center" });
      }));
      clearReveal();
    })();
    return () => { alive = false; };
  }, [revealFile, wsId, clearReveal]);

  // Fade the reveal highlight after a moment.
  useEffect(() => {
    if (!revealedRel) return;
    const t = setTimeout(() => setRevealedRel(null), 1600);
    return () => clearTimeout(t);
  }, [revealedRel]);

  if (err) return <div className="px-3 py-2 text-[12.5px] text-[var(--color-err)]">{err}</div>;
  if (!rootEntries) return <div className="px-3 py-2 text-[13.5px] text-[var(--color-fg-faint)]">Loading…</div>;
  if (rootEntries.length === 0) return <div className="px-3 py-2 text-[13.5px] text-[var(--color-fg-faint)]">(empty)</div>;

  return (
    <div ref={treeRef} className="flex flex-col select-none">
      {rootEntries.map(e => (
        <TreeNode
          key={e.name} wsId={wsId} entry={e} depth={0} rel={e.name} root={root}
          expanded={expanded} children_={children} toggle={toggle} revealed={revealedRel} refetch={refetchDir}
        />
      ))}
    </div>
  );
}

interface NodeProps {
  wsId: string;
  entry: FileEntry;
  depth: number;
  rel: string;
  /** Absolute workspace root, for the "Copy path" context item. */
  root: string;
  expanded: Set<string>;
  children_: Record<string, FileEntry[]>;
  toggle: (rel: string) => void;
  revealed: string | null;
  /** Re-read a directory after a rename/delete mutates its contents. */
  refetch: (rel: string) => void;
}

function TreeNode({ wsId, entry, depth, rel, root, expanded, children_, toggle, revealed, refetch }: NodeProps) {
  const openPreviewTab = useApp(s => s.openPreviewTab);
  const persistTab = useApp(s => s.persistTab);
  const closeTab = useApp(s => s.closeTab);
  const tabs = useApp(s => s.tabs[wsId] || []);
  const activeTabId = useApp(s => s.activeTab[wsId]);
  const isOpen = expanded.has(rel);
  const kids = children_[rel];

  // Inline rename state. While renaming the row swaps to a text input.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(entry.name);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!renaming) return;
    const el = renameInputRef.current;
    if (el) { el.focus(); el.select(); }
  }, [renaming]);

  // The directory this entry lives in (re-read after a mutation).
  const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";

  // Close any open edit/diff tabs pointing at a path that just moved or was
  // deleted (the entry itself, or anything beneath it when it's a folder).
  function closeStaleTabs(p: string) {
    for (const t of tabs) {
      if ((t.type === "edit" || t.type === "diff") && (t.path === p || t.path.startsWith(`${p}/`))) {
        closeTab(wsId, t.id);
      }
    }
  }

  // Enter and the input's onBlur both fire submit; this guard keeps the
  // rename from running twice (the second call would hit the old, now
  // missing path and toast a spurious error).
  const submittingRef = useRef(false);
  async function submitRename() {
    if (submittingRef.current) return;
    const name = draft.trim();
    if (!name || name === entry.name) { setRenaming(false); return; }
    submittingRef.current = true;
    setRenaming(false);
    try {
      await workspacePathRename(wsId, rel, name);
      closeStaleTabs(rel);
      refetch(parentRel);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
      submittingRef.current = false;
    }
  }

  async function remove() {
    const ok = await useUI.getState().askConfirm({
      title: `Delete ${entry.name}?`,
      message: entry.is_dir
        ? "This permanently deletes the folder and everything inside it."
        : "This permanently deletes the file.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await workspacePathDelete(wsId, rel);
      closeStaleTabs(rel);
      refetch(parentRel);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
  }

  const activeTab = tabs.find(t => t.id === activeTabId);
  const isActive = activeTab?.type === "edit" && activeTab.path === rel;

  function onClick() {
    if (entry.is_dir) {
      toggle(rel);
    } else {
      openPreviewTab(wsId, { type: "edit", path: rel, title: entry.name });
    }
  }

  function onDoubleClick() {
    if (entry.is_dir) return;
    const existing = tabs.find(t => t.type === "edit" && t.path === rel);
    if (existing) {
      persistTab(wsId, existing.id);
    }
  }

  const iconUrl = entry.is_dir ? folderIconUrl(entry.name, isOpen) : fileIconUrl(entry.name);

  return (
    <>
      {renaming ? (
        <div
          className="flex h-[26px] w-full min-w-0 items-center gap-2 rounded-sm px-2 text-[13px]"
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" />
          {iconUrl ? <img src={iconUrl} alt="" className="h-4 w-4 shrink-0 file-icon" /> : <span className="h-4 w-4 shrink-0" />}
          <input
            ref={renameInputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); submitRename(); }
              else if (e.key === "Escape") { e.preventDefault(); setRenaming(false); setDraft(entry.name); }
            }}
            onBlur={submitRename}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            className="min-w-0 flex-1 rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1 py-[1px] text-[13px] text-[var(--color-fg)] outline-none"
          />
        </div>
      ) : (
      <ContextMenuRoot>
      <ContextMenuTrigger asChild>
      <button
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        title={rel}
        data-path={rel}
        className={cn(
          "group flex h-[26px] w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-[13px] transition-colors duration-150 outline-none select-none",
          rel === revealed && "ring-1 ring-inset ring-[var(--color-accent)]",
          // While this row's context menu is open, keep it visibly marked so
          // it's clear which item the actions apply to (Radix sets
          // data-state="open" on the trigger).
          "data-[state=open]:bg-[var(--color-hover)] data-[state=open]:text-[var(--color-fg)] data-[state=open]:ring-1 data-[state=open]:ring-inset data-[state=open]:ring-[var(--color-border)]",
          isActive
            ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
            // Idle rows: a NEUTRAL dimmed foreground (fg at 85%), not
            // --color-fg-dim. fg-dim is a warm clay tone reserved for
            // genuine muted text; on a long file list it reads as
            // "brown". terax dims its file tree the same way — the
            // plain foreground knocked back, hue untouched.
            : "text-[var(--color-fg)]/85 hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        )}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--color-fg-faint)]">
          {entry.is_dir ? (
            <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-150", isOpen && "rotate-90")} />
          ) : null}
        </span>
        {iconUrl ? (
          <img src={iconUrl} alt="" className="h-4 w-4 shrink-0 file-icon" />
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )
      }
        <span className="truncate flex-1 min-w-0 font-medium">{entry.name}</span>
      </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <CopyPathItems rel={rel} root={root} isDir={entry.is_dir} />
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => { setDraft(entry.name); setRenaming(true); }}>
          <Pencil /> Rename
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem destructive onSelect={remove}>
          <Trash2 /> Remove
        </ContextMenuItem>
      </ContextMenuContent>
      </ContextMenuRoot>
      )}
      {entry.is_dir && isOpen && kids && kids.map(c => (
        <TreeNode
          key={c.name} wsId={wsId} entry={c} depth={depth + 1} rel={`${rel}/${c.name}`} root={root}
          expanded={expanded} children_={children_} toggle={toggle} revealed={revealed} refetch={refetch}
        />
      ))}
      {entry.is_dir && isOpen && !kids && (
        <div 
          className="h-[22px] flex items-center text-[12px] text-[var(--color-fg-faint)] italic" 
          style={{ paddingLeft: 6 + (depth + 1) * 12 + 22 }}
        >
          Loading…
        </div>
      )}
    </>
  );
}
