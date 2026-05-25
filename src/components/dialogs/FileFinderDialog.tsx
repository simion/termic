// ⌘P file finder — Sublime-style fuzzy match on workspace files.
// Refetches the file list on every open (no cache); good enough for a
// rarely-used feature and saves us an invalidation story.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { workspaceListFilesForFinder } from "@/lib/ipc";
import { fileIconUrl } from "@/lib/explorer/iconResolver";
import { cn } from "@/lib/utils";

const MAX_RESULTS = 50;

interface Scored {
  path: string;
  score: number;
  /** Indexes into `path` that matched a query char — for bolding. */
  matches: number[];
}

/**
 * Single-term match. Tries substring first (so "review" highlights the
 * full contiguous "Review", not scattered r-e-v-i-e-w chars greedily
 * picked from earlier in the path) — preferring occurrences inside the
 * basename and at word boundaries. Falls back to subsequence.
 */
function matchTerm(s: string, lower: string, term: string, slash: number): { score: number; matches: number[] } | null {
  const t = term.toLowerCase();
  // Substring fast path: scan all occurrences, pick the best by
  // basename-ness + word-boundary-ness. Contiguous matches always beat
  // scattered subsequence matches (huge consecutive bonus below).
  let bestSubstr: { idx: number; score: number } | null = null;
  for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + 1)) {
    let sc = 100 + t.length * 9; // baseline: contiguous run of t.length chars
    const prev = i > 0 ? s[i - 1] : "/";
    if (prev === "/" || prev === "-" || prev === "_" || prev === ".") sc += 10;
    if (i > slash) sc += 8;
    sc -= i * 0.05; // mild earlier-is-better tiebreak
    if (!bestSubstr || sc > bestSubstr.score) bestSubstr = { idx: i, score: sc };
  }
  if (bestSubstr) {
    const matches: number[] = [];
    for (let i = 0; i < t.length; i++) matches.push(bestSubstr.idx + i);
    return { score: bestSubstr.score, matches };
  }
  // Subsequence fallback for typos / out-of-order chars.
  const matches: number[] = [];
  let qi = 0;
  let prevMatch = -2;
  let score = 0;
  for (let i = 0; i < lower.length && qi < t.length; i++) {
    if (lower[i] !== t[qi]) continue;
    matches.push(i);
    let bonus = 1;
    if (i === prevMatch + 1) bonus += 8;
    const prev = i > 0 ? s[i - 1] : "/";
    if (prev === "/" || prev === "-" || prev === "_" || prev === ".") bonus += 4;
    if (i > slash) bonus += 2;
    if (s[i] === term[qi]) bonus += 1;
    score += bonus;
    prevMatch = i;
    qi++;
  }
  if (qi < t.length) return null;
  return { score, matches };
}

/**
 * Fuzzy match. Splits the query on whitespace into AND-ed terms — every
 * term must subsequence-match (Sublime / fzf convention: "components
 * broa" finds files containing both). Each term gets its own independent
 * pass so the order/positions of terms don't have to line up.
 */
function fuzzyScore(s: string, query: string): Scored | null {
  if (!query) return { path: s, score: 0, matches: [] };
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.length) return { path: s, score: 0, matches: [] };
  const lower = s.toLowerCase();
  const slash = s.lastIndexOf("/");
  const allMatches = new Set<number>();
  let total = 0;
  for (const t of terms) {
    const r = matchTerm(s, lower, t, slash);
    if (!r) return null;
    total += r.score;
    for (const m of r.matches) allMatches.add(m);
  }
  total -= s.length * 0.01;
  return { path: s, score: total, matches: [...allMatches].sort((a, b) => a - b) };
}

function Highlighted({ text, matches }: { text: string; matches: number[] }) {
  if (!matches.length) return <>{text}</>;
  const set = new Set(matches);
  const out: React.ReactNode[] = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      if (buf) { out.push(buf); buf = ""; }
      out.push(<b key={i} className="text-[var(--color-accent)] font-semibold">{text[i]}</b>);
    } else {
      buf += text[i];
    }
  }
  if (buf) out.push(buf);
  return <>{out}</>;
}

export function FileFinderDialog() {
  const wsId = useUI(s => s.fileFinderWsId);
  const close = useUI(s => s.closeFileFinder);
  const openPreviewTab = useApp(s => s.openPreviewTab);
  const persistTab = useApp(s => s.persistTab);
  // Project name for the search-scope hint in the input placeholder.
  const projectName = useApp(s => {
    if (!wsId) return null;
    const ws = s.workspaces.find(w => w.id === wsId);
    if (!ws) return null;
    return s.projects.find(p => p.id === ws.project_id)?.name ?? null;
  });

  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Refetch on every open. The user explicitly wanted a fresh listing each
  // time ⌘P is hit — saves a cache invalidation story for a feature that's
  // hit rarely enough that the ~50ms reload doesn't matter.
  useEffect(() => {
    if (!wsId) return;
    setQuery("");
    setActiveIdx(0);
    setErr(null);
    setLoading(true);
    let cancelled = false;
    workspaceListFilesForFinder(wsId)
      .then(list => { if (!cancelled) { setFiles(list); setLoading(false); } })
      .catch(e => { if (!cancelled) { setErr(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [wsId]);

  const results = useMemo<Scored[]>(() => {
    if (!files.length) return [];
    if (!query) {
      return files.slice(0, MAX_RESULTS).map(p => ({ path: p, score: 0, matches: [] }));
    }
    const scored: Scored[] = [];
    for (const f of files) {
      const s = fuzzyScore(f, query);
      if (s) scored.push(s);
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS);
  }, [files, query]);

  // Reset selection whenever results change so we never end up with an
  // active index past the end of the list.
  useEffect(() => { setActiveIdx(0); }, [query]);

  function pick(path: string) {
    if (!wsId) return;
    const name = path.split("/").pop() || path;
    // Reuse an existing tab for this file if there is one — otherwise
    // open a preview tab and persist it (Enter = "I really want this").
    const existing = (useApp.getState().tabs[wsId] || []).find(
      t => t.type === "edit" && (t as any).path === path,
    );
    if (existing) {
      useApp.getState().setActiveTabId(wsId, existing.id);
    } else {
      openPreviewTab(wsId, { type: "edit", path, title: name });
      // openPreviewTab assigns the tab id internally; find it back and pin.
      queueMicrotask(() => {
        const t = (useApp.getState().tabs[wsId] || []).find(
          x => x.type === "edit" && (x as any).path === path,
        );
        if (t) persistTab(wsId, t.id);
      });
    }
    close();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[activeIdx];
      if (r) pick(r.path);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  // Scroll the active row into view on keyboard nav.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  return (
    <Dialog.Root open={!!wsId} onOpenChange={(v) => (v ? null : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          // Top-anchored (Sublime / VS Code / Conductor convention) — feels
          // wrong floating in the vertical center for a quick-pick.
          className="fixed left-1/2 top-12 z-50 w-[min(640px,90vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] shadow-2xl outline-none"
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">Find file</Dialog.Title>
          <Dialog.Description className="sr-only">Type to fuzzy-search files in this workspace.</Dialog.Description>
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
              placeholder={loading
                ? "Loading files…"
                : projectName ? `Search files in ${projectName}` : "Search files by name"}
              className="w-full bg-transparent pl-1 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
            />
          </div>
          <div ref={listRef} className="max-h-[70vh] overflow-y-auto py-1">
            {err && (
              <div className="px-3 py-3 text-[13px] text-[var(--color-err)]">{err}</div>
            )}
            {!err && !loading && results.length === 0 && (
              <div className="px-3 py-3 text-[13px] text-[var(--color-fg-faint)]">
                {query ? "No matches" : "No files"}
              </div>
            )}
            {results.map((r, i) => {
              const name = r.path.split("/").pop() || r.path;
              const dir = r.path.slice(0, r.path.length - name.length);
              // Translate absolute match indexes into name- and dir-relative
              // ones so each Highlighted span gets its own subset.
              const nameStart = dir.length;
              const nameMatches = r.matches.filter(m => m >= nameStart).map(m => m - nameStart);
              const dirMatches = r.matches.filter(m => m < nameStart);
              return (
                <button
                  key={r.path}
                  data-row={i}
                  onClick={() => pick(r.path)}
                  onMouseMove={() => setActiveIdx(i)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]",
                    i === activeIdx
                      ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                      : "text-[var(--color-fg)]",
                  )}
                >
                  <img src={fileIconUrl(name)} alt="" className="h-4 w-4 shrink-0 file-icon" />
                  <span className="truncate">
                    <Highlighted text={name} matches={nameMatches} />
                  </span>
                  {dir && (
                    <span className="ml-2 min-w-0 flex-1 truncate text-[12px] text-[var(--color-fg-faint)]">
                      <Highlighted text={dir.replace(/\/$/, "")} matches={dirMatches} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
