// ⌘N global project picker — fuzzy-search any loaded project (by name + path)
// and open the standard New Workspace dialog for it. Built for the
// hundreds-of-projects case where scrolling the sidebar to find the `+` is
// the bottleneck. Selecting a row just calls openNewWorkspace(project.id) —
// the exact same flow as the sidebar `+` → "New git worktree".

import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Search, Layers, FolderGit2 } from "lucide-react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { fuzzyMatch, Highlighted } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";

const MAX_RESULTS = 15;

interface Scored {
  id: string;
  name: string;
  path: string;
  isMulti: boolean;
  score: number;
  /** Match indexes relative to the name. */
  nameMatches: number[];
  /** Match indexes relative to the path. */
  pathMatches: number[];
}

export function ProjectPickerDialog() {
  const open = useUI(s => s.projectPickerOpen);
  const close = useUI(s => s.closeProjectPicker);
  const openNewWorkspace = useUI(s => s.openNewWorkspace);
  const projects = useApp(s => s.projects);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset query each time the picker opens.
  useEffect(() => {
    if (open) { setQuery(""); setActiveIdx(0); }
  }, [open]);

  const results = useMemo<Scored[]>(() => {
    const toScored = (p: typeof projects[number], score: number, nameMatches: number[], pathMatches: number[]): Scored => ({
      id: p.id,
      name: p.name,
      path: p.root_path,
      isMulti: (p.type ?? "single") === "multi",
      score,
      nameMatches,
      pathMatches,
    });
    if (!query) {
      // No filter: keep sidebar order so the list isn't empty before typing.
      return projects.slice(0, MAX_RESULTS).map(p => toScored(p, 0, [], []));
    }
    const scored: Scored[] = [];
    for (const p of projects) {
      // Match against "<name> <path>" so a query can hit either; split the
      // match indexes back into name- and path-relative sets for highlighting.
      const hay = `${p.name} ${p.root_path}`;
      const m = fuzzyMatch(hay, query);
      if (!m) continue;
      const nameLen = p.name.length;
      const pathStart = nameLen + 1;
      const nameMatches = m.matches.filter(i => i < nameLen);
      const pathMatches = m.matches.filter(i => i >= pathStart).map(i => i - pathStart);
      scored.push(toScored(p, m.score, nameMatches, pathMatches));
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS);
  }, [projects, query]);

  // Keep the active index in range whenever results change.
  useEffect(() => { setActiveIdx(0); }, [query]);

  function pick(id: string) {
    // Close the picker first, then open the New Workspace dialog so the two
    // modals never stack.
    close();
    openNewWorkspace(id);
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
      if (r) pick(r.id);
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
    <Dialog.Root open={open} onOpenChange={(v) => (v ? null : close())}>
      <Dialog.Portal>
        {/* Soft animated dim (matches the ⌘K palette): fades in/out via
            data-state instead of a snap, for contrast without flicker. */}
        <Dialog.Overlay className="termic-backdrop fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          className="termic-pop fixed left-1/2 top-12 z-50 w-[min(760px,92vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] shadow-2xl outline-none"
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">New workspace</Dialog.Title>
          <Dialog.Description className="sr-only">Search a project to start a new workspace.</Dialog.Description>
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
              placeholder="Search a project to start a new workspace"
              className="w-full bg-transparent pl-1 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
            />
          </div>
          <div ref={listRef} className="max-h-[70vh] overflow-y-auto py-1">
            {results.length === 0 && (
              <div className="px-3 py-3 text-[13px] text-[var(--color-fg-faint)]">
                {query ? "No matching projects" : "No projects"}
              </div>
            )}
            {results.map((r, i) => {
              const Icon = r.isMulti ? Layers : FolderGit2;
              return (
                <button
                  key={r.id}
                  data-row={i}
                  onClick={() => pick(r.id)}
                  onMouseMove={() => setActiveIdx(i)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]",
                    i === activeIdx
                      ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                      : "text-[var(--color-fg)]",
                  )}
                >
                  <Icon className={cn("h-4 w-4 shrink-0", r.isMulti ? "text-[var(--color-accent)]" : "text-[var(--color-fg-dim)]")} />
                  <span className="truncate">
                    <Highlighted text={r.name} matches={r.nameMatches} />
                  </span>
                  <span className="ml-2 min-w-0 flex-1 truncate text-[12px] text-[var(--color-fg-faint)]">
                    <Highlighted text={r.path} matches={r.pathMatches} />
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
