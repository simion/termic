// Lazy-loading file tree for the "All files" panel.
// - Initial render fetches the workspace root only.
// - Clicking a dir expands it and fetches its entries on demand (cached by rel-path).
// - Clicking a file opens/selects an edit tab in the workspace.
// - Indentation reflects depth; chevrons rotate to indicate expansion state.

import { useEffect, useState, useCallback } from "react";
import { ChevronRight } from "lucide-react";
import type { FileEntry } from "@/lib/types";
import { workspaceDirList } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";
import { fileIconUrl, folderIconUrl } from "@/lib/explorer/iconResolver";

interface Props { wsId: string; }

export function FileTree({ wsId }: Props) {
  const [rootEntries, setRootEntries] = useState<FileEntry[] | null>(null);
  // Per-dir cache of children, keyed by rel-path ("" = root).
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  // Expanded set keyed by rel-path.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Tracks in-flight dir loads so we don't double-fetch.
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [err, setErr] = useState<string | null>(null);

  // Load root on mount / wsId change. Reset everything else — different
  // workspace has a different file tree.
  useEffect(() => {
    setRootEntries(null); setChildren({}); setExpanded(new Set()); setErr(null);
    workspaceDirList(wsId, "")
      .then(list => { setRootEntries(list); setChildren({ "": list }); })
      .catch(e => setErr(String(e)));
  }, [wsId]);

  const ensureLoaded = useCallback(async (rel: string) => {
    if (children[rel] || loading.has(rel)) return;
    setLoading(s => { const n = new Set(s); n.add(rel); return n; });
    try {
      const list = await workspaceDirList(wsId, rel);
      setChildren(c => ({ ...c, [rel]: list }));
    } catch (e) { console.error("dir list failed", rel, e); }
    finally { setLoading(s => { const n = new Set(s); n.delete(rel); return n; }); }
  }, [wsId, children, loading]);

  const toggle = useCallback((rel: string) => {
    setExpanded(s => {
      const n = new Set(s);
      if (n.has(rel)) n.delete(rel); else { n.add(rel); ensureLoaded(rel); }
      return n;
    });
  }, [ensureLoaded]);

  if (err) return <div className="px-3 py-2 text-[12.5px] text-[var(--color-err)]">{err}</div>;
  if (!rootEntries) return <div className="px-3 py-2 text-[13.5px] text-[var(--color-fg-faint)]">Loading…</div>;
  if (rootEntries.length === 0) return <div className="px-3 py-2 text-[13.5px] text-[var(--color-fg-faint)]">(empty)</div>;

  return (
    <div className="flex flex-col select-none">
      {rootEntries.map(e => (
        <TreeNode
          key={e.name} wsId={wsId} entry={e} depth={0} rel={e.name}
          expanded={expanded} children_={children} toggle={toggle}
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
  expanded: Set<string>;
  children_: Record<string, FileEntry[]>;
  toggle: (rel: string) => void;
}

function TreeNode({ wsId, entry, depth, rel, expanded, children_, toggle }: NodeProps) {
  const addTab = useApp(s => s.addTab);
  const setActiveTabId = useApp(s => s.setActiveTabId);
  const tabs = useApp(s => s.tabs[wsId] || []);
  const activeTabId = useApp(s => s.activeTab[wsId]);
  const isOpen = expanded.has(rel);
  const kids = children_[rel];

  const activeTab = tabs.find(t => t.id === activeTabId);
  const isActive = activeTab?.type === "edit" && activeTab.path === rel;

  function onClick() {
    if (entry.is_dir) {
      toggle(rel);
    } else {
      const existing = tabs.find(t => t.type === "edit" && t.path === rel);
      if (existing) {
        setActiveTabId(wsId, existing.id);
      } else {
        addTab(wsId, { id: crypto.randomUUID(), type: "edit", path: rel, title: entry.name });
      }
    }
  }

  const iconUrl = entry.is_dir ? folderIconUrl(entry.name, isOpen) : fileIconUrl(entry.name);

  return (
    <>
      <button
        onClick={onClick}
        title={rel}
        className={cn(
          "group flex h-[26px] w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-[13px] transition-colors duration-150 outline-none select-none",
          isActive
            ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
            : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        )}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--color-fg-faint)]">
          {entry.is_dir ? (
            <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-150", isOpen && "rotate-90")} />
          ) : null}
        </span>
        {iconUrl ? (
          <img src={iconUrl} alt="" className="h-4 w-4 shrink-0" />
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}
        <span className="truncate flex-1 min-w-0 font-medium">{entry.name}</span>
      </button>
      {entry.is_dir && isOpen && kids && kids.map(c => (
        <TreeNode
          key={c.name} wsId={wsId} entry={c} depth={depth + 1} rel={`${rel}/${c.name}`}
          expanded={expanded} children_={children_} toggle={toggle}
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
