// ⌘I context picker — fuzzy-search workspace files/folders, multi-select, and
// insert `@path` tokens into the active agent terminal's PTY. The advanced
// sibling of FileFinderDialog: two panes (list + preview), recency ranking,
// folder selection. Shares the fuzzy matcher (lib/fuzzy) and ranking/insertion
// logic (lib/contextPicker); refetches the file list on every open like ⌘P.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Search, Check, Folder, X } from "lucide-react";
import { useUI } from "@/store/ui";
import {
  workspaceContextFiles,
  workspaceChanges,
  workspaceFileRead,
  ptyWrite,
  type ContextFile,
} from "@/lib/ipc";
import { rankContextFiles, buildInsertion } from "@/lib/contextPicker";
import { fileIconUrl } from "@/lib/explorer/iconResolver";
import { cn } from "@/lib/utils";

const MAX_RESULTS = 60;
const PREVIEW_DEBOUNCE_MS = 120;
const PREVIEW_MAX_LINES = 200;
const PREVIEW_MAX_BYTES = 10_000;

// Strip ANSI escape sequences and other control chars so a previewed file
// can't move the cursor / inject escapes into the dialog render.
function sanitize(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

type Preview =
  | { kind: "text"; path: string; lines: string[] }
  | { kind: "dir"; path: string; lines: string[] }
  | { kind: "binary"; path: string }
  | { kind: "error"; path: string; msg: string }
  | null;

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

export function ContextPickerDialog() {
  const cp = useUI(s => s.contextPicker);
  const close = useUI(s => s.closeContextPicker);
  const wsId = cp?.wsId ?? null;

  const [files, setFiles] = useState<ContextFile[]>([]);
  const [changed, setChanged] = useState<Set<string>>(() => new Set());
  const [loadedAt, setLoadedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<Preview>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Refetch files + git-changed set on every open (no cache — matches ⌘P).
  useEffect(() => {
    if (!wsId) return;
    setQuery(""); setActiveIdx(0); setSelected(new Set()); setErr(null);
    setPreview(null); setLoading(true);
    let cancelled = false;
    Promise.all([workspaceContextFiles(wsId), workspaceChanges(wsId).catch(() => null)])
      .then(([list, changes]) => {
        if (cancelled) return;
        const set = new Set<string>();
        if (changes) {
          const groups = changes.groups ?? [];
          if (groups.length) {
            for (const g of groups) for (const f of g.files) set.add(f.path);
          } else {
            for (const f of changes.files) set.add(f.path);
          }
        }
        setFiles(list); setChanged(set); setLoadedAt(Date.now()); setLoading(false);
      })
      .catch(e => { if (!cancelled) { setErr(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [wsId]);

  const results = useMemo(() => {
    if (!files.length) return [];
    return rankContextFiles(files, changed, query, loadedAt || Date.now()).slice(0, MAX_RESULTS);
  }, [files, changed, query, loadedAt]);

  const isDirMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const f of files) m.set(f.path, f.is_dir);
    return m;
  }, [files]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  // Keep the active row in view on keyboard nav.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const active = results[activeIdx];

  // Debounced, cancellable preview of the highlighted entry.
  useEffect(() => {
    if (!wsId || !active) { setPreview(null); return; }
    let cancelled = false;
    const { path, is_dir } = active;
    const handle = window.setTimeout(async () => {
      if (is_dir) {
        const prefix = path + "/";
        const kids = files
          .filter(f => f.path.startsWith(prefix))
          .map(f => f.path.slice(prefix.length).split("/")[0])
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 100);
        if (!cancelled) setPreview({ kind: "dir", path, lines: kids });
        return;
      }
      try {
        const content = await workspaceFileRead(wsId, path);
        if (cancelled) return;
        if (content.includes("\u0000")) { setPreview({ kind: "binary", path }); return; }
        const lines = sanitize(content.slice(0, PREVIEW_MAX_BYTES)).split("\n").slice(0, PREVIEW_MAX_LINES);
        setPreview({ kind: "text", path, lines });
      } catch (e) {
        if (!cancelled) setPreview({ kind: "error", path, msg: String(e) });
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [wsId, active?.path, active?.is_dir, files]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(path: string) {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path); else n.add(path);
      return n;
    });
  }

  // Close, re-emitting the literal '@' to the PTY when the picker was opened
  // by swallowing a typed '@' and nothing was inserted. Idempotent: reads the
  // live store, so a second close (Radix onOpenChange after our Esc handler)
  // sees a null picker and re-emits nothing.
  function closeMaybeReemit(inserted: boolean) {
    const c = useUI.getState().contextPicker;
    if (!inserted && c?.atOrigin) ptyWrite(c.ptyId, [0x40]).catch(() => {});
    close();
  }

  function confirm() {
    if (!cp) return;
    let chosen: { path: string; is_dir: boolean }[];
    if (selected.size > 0) {
      chosen = [...selected].map(p => ({ path: p, is_dir: !!isDirMap.get(p) }));
    } else if (active) {
      chosen = [{ path: active.path, is_dir: active.is_dir }];
    } else {
      return;
    }
    const str = buildInsertion(chosen);
    if (str) ptyWrite(cp.ptyId, Array.from(new TextEncoder().encode(str))).catch(() => {});
    closeMaybeReemit(true);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault(); setActiveIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Tab") {
      // Tab toggles multi-select on the active row. (Space is NOT a toggle —
      // it's needed for multi-term fuzzy queries in the search box.)
      e.preventDefault();
      if (active) toggle(active.path);
    } else if (e.key === "Enter") {
      e.preventDefault(); confirm();
    } else if (e.key === "Escape") {
      e.preventDefault(); closeMaybeReemit(false);
    }
  }

  const selectedList = [...selected];

  return (
    <Dialog.Root open={!!cp} onOpenChange={(v) => { if (!v) closeMaybeReemit(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="fixed left-1/2 top-12 z-50 flex h-[70vh] w-[min(880px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] shadow-2xl outline-none"
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">Add context</Dialog.Title>
          <Dialog.Description className="sr-only">
            Fuzzy-search files and folders to insert as @path tokens into the active terminal.
          </Dialog.Description>

          {/* Search */}
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
              placeholder={loading ? "Loading files…" : "Add context — Tab to multi-select, Enter to insert"}
              className="w-full bg-transparent pl-1 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
            />
          </div>

          {/* Selection chips */}
          {selectedList.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
              {selectedList.map(p => {
                const name = p.split("/").pop() || p;
                return (
                  <button
                    key={p}
                    onClick={() => toggle(p)}
                    title={p}
                    className="flex items-center gap-1 rounded bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg-3)]"
                  >
                    <span className="max-w-[180px] truncate">{name}{isDirMap.get(p) ? "/" : ""}</span>
                    <X className="h-3 w-3 shrink-0 text-[var(--color-fg-faint)]" />
                  </button>
                );
              })}
            </div>
          )}

          {/* Two panes */}
          <div className="flex min-h-0 flex-1">
            {/* List */}
            <div ref={listRef} className="w-[44%] min-w-0 overflow-y-auto border-r border-[var(--color-border)] py-1">
              {err && <div className="px-3 py-3 text-[13px] text-[var(--color-err)]">{err}</div>}
              {!err && !loading && results.length === 0 && (
                <div className="px-3 py-3 text-[13px] text-[var(--color-fg-faint)]">
                  {query ? "No matches" : "No files"}
                </div>
              )}
              {results.map((r, i) => {
                const name = r.path.split("/").pop() || r.path;
                const dir = r.path.slice(0, r.path.length - name.length);
                const nameStart = dir.length;
                const nameMatches = r.matches.filter(m => m >= nameStart).map(m => m - nameStart);
                const dirMatches = r.matches.filter(m => m < nameStart);
                const isSel = selected.has(r.path);
                return (
                  <button
                    key={r.path}
                    data-row={i}
                    onClick={() => { setActiveIdx(i); toggle(r.path); }}
                    onMouseMove={() => setActiveIdx(i)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]",
                      i === activeIdx ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]" : "text-[var(--color-fg)]",
                    )}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      {isSel
                        ? <Check className="h-3.5 w-3.5 text-[var(--color-accent)]" />
                        : r.is_dir
                          ? <Folder className="h-4 w-4 text-[var(--color-fg-faint)]" />
                          : <img src={fileIconUrl(name)} alt="" className="h-4 w-4 file-icon" />}
                    </span>
                    <span className="truncate">
                      <Highlighted text={name} matches={nameMatches} />{r.is_dir ? "/" : ""}
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

            {/* Preview */}
            <div className="min-w-0 flex-1 overflow-auto bg-[var(--color-bg)]">
              {!preview && (
                <div className="p-3 text-[12px] text-[var(--color-fg-faint)]">
                  {active ? "" : "Select a file to preview"}
                </div>
              )}
              {preview?.kind === "binary" && (
                <div className="p-3 text-[12px] text-[var(--color-fg-faint)]">Binary file</div>
              )}
              {preview?.kind === "error" && (
                <div className="p-3 text-[12px] text-[var(--color-err)]">{preview.msg}</div>
              )}
              {preview?.kind === "dir" && (
                <div className="p-3">
                  <div className="mb-1 text-[12px] text-[var(--color-fg-faint)]">
                    {preview.lines.length} item{preview.lines.length === 1 ? "" : "s"}
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-[var(--color-fg-dim)]">
                    {preview.lines.join("\n")}
                  </pre>
                </div>
              )}
              {preview?.kind === "text" && (
                <pre className="p-3 font-mono text-[12px] leading-relaxed text-[var(--color-fg-dim)]">
                  {preview.lines.join("\n")}
                </pre>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
