// ⇧⌘F find-in-files. Streams `git grep` results live: every keystroke
// fires a fresh search with a new searchId; Rust SIGKILLs the previous
// in-flight grep automatically so we never fan out into zombies.
//
// No caching, no indexing, no regex. Literal case-insensitive match —
// matches the MVP plan in the conversation. Add toggles only if used.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import {
  workspaceGrepStart, workspaceGrepCancel,
  onGrepResult, onGrepDone, type GrepHit,
} from "@/lib/ipc";
import { fileIconUrl } from "@/lib/explorer/iconResolver";
import { cn } from "@/lib/utils";

const MAX_FILES = 50;
const MAX_HITS_PER_FILE = 12;
const DEBOUNCE_MS = 120;

interface FileGroup { path: string; hits: GrepHit[] }

/** A clickable result row OR a file-header row, for flat keyboard
 *  navigation across groups. Header rows have `hit: null`. */
type Row =
  | { kind: "header"; path: string }
  | { kind: "hit"; hit: GrepHit };

function highlight(preview: string, needle: string): React.ReactNode {
  if (!needle) return preview;
  const lower = preview.toLowerCase();
  const n = needle.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < preview.length) {
    const idx = lower.indexOf(n, i);
    if (idx === -1) { out.push(preview.slice(i)); break; }
    if (idx > i) out.push(preview.slice(i, idx));
    out.push(
      <b key={key++} className="text-[var(--color-accent)] font-semibold">
        {preview.slice(idx, idx + n.length)}
      </b>,
    );
    i = idx + n.length;
  }
  return <>{out}</>;
}

export function FindInFilesDialog() {
  const wsId = useUI(s => s.findInFilesWsId);
  const close = useUI(s => s.closeFindInFiles);
  const openPreviewTab = useApp(s => s.openPreviewTab);
  // Project name for the scope hint — users need to know which repo is
  // being searched (workspaces can come from any project).
  const projectName = useApp(s => {
    if (!wsId) return null;
    const ws = s.workspaces.find(w => w.id === wsId);
    if (!ws) return null;
    return s.projects.find(p => p.id === ws.project_id)?.name ?? null;
  });

  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<FileGroup[]>([]);
  const [searching, setSearching] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // searchId is bumped each keystroke; late events from older searches
  // arrive with mismatched ids and are ignored. Kept in a ref so the
  // event listeners (which close over the value at subscribe time) can
  // compare against the freshest value, not a stale snapshot.
  const activeSearchIdRef = useRef<string>("");

  // Reset everything on open. On close, cancel any in-flight grep so we
  // don't waste CPU once the user moves on.
  useEffect(() => {
    if (!wsId) return;
    setQuery("");
    setGroups([]);
    setTruncated(false);
    setSearching(false);
    setActiveIdx(0);
    return () => { workspaceGrepCancel(wsId).catch(() => {}); };
  }, [wsId]);

  // Debounced search. Every keystroke schedules a fresh search; the
  // previous one is auto-killed by Rust (per-workspace slot).
  useEffect(() => {
    if (!wsId) return;
    const trimmed = query.trim();
    if (!trimmed) {
      activeSearchIdRef.current = "";
      setGroups([]);
      setTruncated(false);
      setSearching(false);
      return;
    }

    const t = window.setTimeout(() => {
      const searchId = crypto.randomUUID();
      activeSearchIdRef.current = searchId;
      setGroups([]);
      setTruncated(false);
      setSearching(true);

      // Accumulator outside React state so high-rate result events don't
      // trigger one render per hit. We flush into state on a throttle.
      const acc = new Map<string, GrepHit[]>();
      let pendingFlush: number | null = null;
      const flush = () => {
        pendingFlush = null;
        if (activeSearchIdRef.current !== searchId) return;
        const next: FileGroup[] = [];
        for (const [path, hits] of acc) {
          if (next.length >= MAX_FILES) break;
          next.push({ path, hits: hits.slice(0, MAX_HITS_PER_FILE) });
        }
        setGroups(next);
      };

      let unResult: (() => void) | null = null;
      let unDone: (() => void) | null = null;

      onGrepResult(searchId, hit => {
        if (activeSearchIdRef.current !== searchId) return;
        const arr = acc.get(hit.path);
        if (arr) {
          if (arr.length < MAX_HITS_PER_FILE) arr.push(hit);
        } else if (acc.size < MAX_FILES) {
          acc.set(hit.path, [hit]);
        }
        if (pendingFlush == null) pendingFlush = window.setTimeout(flush, 40);
      }).then(u => {
        // If the search was already superseded before listener wired up,
        // detach immediately.
        if (activeSearchIdRef.current !== searchId) u();
        else unResult = u;
      });

      onGrepDone(searchId, d => {
        if (activeSearchIdRef.current !== searchId) return;
        if (pendingFlush != null) { clearTimeout(pendingFlush); flush(); }
        setTruncated(d.truncated);
        setSearching(false);
        unResult?.(); unResult = null;
        unDone?.(); unDone = null;
      }).then(u => {
        if (activeSearchIdRef.current !== searchId) u();
        else unDone = u;
      });

      workspaceGrepStart(wsId, trimmed, searchId).catch(() => setSearching(false));
    }, DEBOUNCE_MS);

    return () => clearTimeout(t);
  }, [wsId, query]);

  // Flatten groups into a single list of selectable rows (file headers +
  // hit rows) so ↑/↓ traverses everything in visual order.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of groups) {
      out.push({ kind: "header", path: g.path });
      for (const h of g.hits) out.push({ kind: "hit", hit: h });
    }
    return out;
  }, [groups]);

  // Keep activeIdx on a hit row; ↑/↓ skip headers.
  useEffect(() => {
    // After results change, snap to the first hit if available.
    const firstHit = rows.findIndex(r => r.kind === "hit");
    setActiveIdx(firstHit >= 0 ? firstHit : 0);
  }, [rows.length]);

  function pickHit(hit: GrepHit) {
    if (!wsId) return;
    const name = hit.path.split("/").pop() || hit.path;
    openPreviewTab(wsId, {
      type: "edit",
      path: hit.path,
      title: name,
      revealAt: { line: hit.line, col: hit.col || undefined },
    });
    close();
  }

  function moveActive(delta: number) {
    if (!rows.length) return;
    let i = activeIdx + delta;
    while (i >= 0 && i < rows.length && rows[i].kind !== "hit") i += delta;
    if (i < 0 || i >= rows.length) return;
    setActiveIdx(i);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown")      { e.preventDefault(); moveActive(1); }
    else if (e.key === "ArrowUp")   { e.preventDefault(); moveActive(-1); }
    else if (e.key === "Enter")     {
      e.preventDefault();
      const r = rows[activeIdx];
      if (r?.kind === "hit") pickHit(r.hit);
    }
    else if (e.key === "Escape")    { e.preventDefault(); close(); }
  }

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const totalHits = groups.reduce((n, g) => n + g.hits.length, 0);

  return (
    <Dialog.Root open={!!wsId} onOpenChange={(v) => (v ? null : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="fixed left-1/2 top-12 z-50 w-[min(760px,92vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] shadow-2xl outline-none"
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">Find in files</Dialog.Title>
          <Dialog.Description className="sr-only">Search file contents across the workspace.</Dialog.Description>
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
            <Search className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)]" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              placeholder={projectName ? `Find in ${projectName} (literal, case-insensitive)` : "Find in files (literal, case-insensitive)"}
              className="w-full bg-transparent pl-1 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
            />
            {query && (
              <span className="shrink-0 text-[11.5px] text-[var(--color-fg-faint)]">
                {searching ? "searching…" : `${totalHits} match${totalHits === 1 ? "" : "es"} in ${groups.length} file${groups.length === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`}
              </span>
            )}
          </div>
          <div ref={listRef} className="max-h-[78vh] overflow-y-auto py-1">
            {!query && (
              <div className="px-3 py-3 text-[13px] text-[var(--color-fg-dim)]">
                Searching <span className="font-semibold text-[var(--color-fg)]">{projectName ?? "this workspace"}</span> via <code className="text-[12px]">git grep</code>. Respects <code className="text-[12px]">.gitignore</code>.
              </div>
            )}
            {query && !searching && groups.length === 0 && (
              <div className="px-3 py-3 text-[13px] text-[var(--color-fg-faint)]">No matches</div>
            )}
            {rows.map((r, i) => {
              if (r.kind === "header") {
                const name = r.path.split("/").pop() || r.path;
                const dir = r.path.slice(0, r.path.length - name.length).replace(/\/$/, "");
                return (
                  <div
                    key={`h:${r.path}`}
                    data-row={i}
                    className="mt-1 flex items-center gap-2 px-3 py-1 text-[12.5px] text-[var(--color-fg-dim)]"
                  >
                    <img src={fileIconUrl(name)} alt="" className="h-4 w-4 shrink-0 file-icon" />
                    <span className="truncate font-semibold text-[var(--color-fg)]">{name}</span>
                    {dir && <span className="truncate text-[12px] text-[var(--color-fg-faint)]">{dir}</span>}
                  </div>
                );
              }
              const h = r.hit;
              return (
                <button
                  key={`r:${h.path}:${h.line}:${h.col}:${i}`}
                  data-row={i}
                  onClick={() => pickHit(h)}
                  onMouseMove={() => setActiveIdx(i)}
                  className={cn(
                    "flex w-full items-baseline gap-3 px-3 py-1 text-left font-mono text-[12.5px]",
                    i === activeIdx
                      ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                      : "text-[var(--color-fg-dim)]",
                  )}
                >
                  <span className="w-12 shrink-0 text-right tabular-nums text-[var(--color-fg-faint)]">{h.line}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]">
                    {highlight(h.preview, query.trim())}
                  </span>
                </button>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
