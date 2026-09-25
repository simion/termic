// ⇧⌘F find-in-files. Streams results live: every keystroke fires a fresh
// search with a new searchId; Rust SIGKILLs the previous in-flight search
// automatically so we never fan out into zombies.
//
// No caching, no indexing. Literal and case-insensitive by default; the `.*`
// toggle switches the query to a regex and `Aa` drops the case folding. Both
// toggles persist in prefs.
//
// Rust picks the backend (GH #181): ripgrep when installed, `git grep`
// otherwise. That decides the regex flavor the `.*` tooltip names, and
// whether we offer the install hint, so the dialog asks for it once.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation, Trans } from "react-i18next";
import { Search, X, Zap } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import {
  taskGrepStart, taskGrepCancel, taskFindBackend,
  onGrepResult, onGrepDone, type FindBackend, type GrepHit, type GrepOpts,
} from "@/lib/ipc";
import { hitRanges } from "@/lib/findMatches";
import { fileIconUrl } from "@/lib/explorer/iconResolver";
import { cn } from "@/lib/utils";

const MAX_FILES = 50;
const MAX_HITS_PER_FILE = 12;
// 350ms crosses the median inter-key gap of slow typing on large repos —
// firing grep mid-word means spinning up `git grep` over the whole worktree
// just to SIGKILL it on the next keystroke. Tuned together with MIN_QUERY:
// a 1-2 char literal on a giant repo always truncates at the cap anyway.
const DEBOUNCE_MS = 350;
const MIN_QUERY = 3;
// Progressive reveal: render this many rows up-front, then reveal another
// chunk when the user scrolls near the bottom. Keeps the DOM small during
// the hot path (typing) without committing to full virtualization.
const RENDER_CHUNK = 80;
const RIPGREP_INSTALL_URL = "https://github.com/BurntSushi/ripgrep#installation";

// Cache the backend for the app's lifetime, but ONLY once Rust calls it
// settled. Early after launch the login-shell PATH hasn't landed, so an
// installed rg can still be invisible; keeping that answer would leave
// the install hint up all session for someone who has it. Unsettled means
// ask again on the next open (one IPC per ⇧⌘F, and it settles fast).
let settledBackend: FindBackend | null = null;
async function loadBackend(): Promise<FindBackend> {
  if (settledBackend) return settledBackend;
  try {
    const info = await taskFindBackend();
    if (info.settled) settledBackend = info.backend;
    return info.backend;
  } catch {
    return "git-grep";
  }
}

interface FileGroup { path: string; hits: GrepHit[] }

/** A clickable result row OR a file-header row, for flat keyboard
 *  navigation across groups. Header rows have `hit: null`. */
type Row =
  | { kind: "header"; path: string }
  | { kind: "hit"; hit: GrepHit };

function FlagToggle(
  { on, onToggle, glyph, title, testId }:
  { on: boolean; onToggle: () => void; glyph: string; title: string; testId: string },
) {
  return (
    <button
      type="button"
      // Keep the caret in the query input: the toggle re-runs the search,
      // and Enter must still open the highlighted row.
      onMouseDown={e => e.preventDefault()}
      onClick={onToggle}
      aria-pressed={on}
      title={title}
      data-testid={testId}
      data-no-drag
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 font-mono text-[12px] leading-none",
        on
          ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
          : "text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]",
      )}
    >
      {glyph}
    </button>
  );
}

function highlight(hit: GrepHit, needle: string, opts: GrepOpts): React.ReactNode {
  const preview = hit.preview;
  const ranges = hitRanges(hit, needle, opts);
  if (!ranges.length) return preview;
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (const [start, end] of ranges) {
    if (start > i) out.push(preview.slice(i, start));
    out.push(
      <b key={key++} className="text-[var(--color-accent)] font-semibold">
        {preview.slice(start, end)}
      </b>,
    );
    i = end;
  }
  out.push(preview.slice(i));
  return <>{out}</>;
}

export function FindInFilesDialog() {
  const { t } = useTranslation("dialogs");
  const taskId = useUI(s => s.findInFilesTaskId);
  const close = useUI(s => s.closeFindInFiles);
  const openPreviewTab = useApp(s => s.openPreviewTab);
  // Project name for the scope hint — users need to know which repo is
  // being searched (tasks can come from any project).
  const projectName = useApp(s => {
    if (!taskId) return null;
    const task = s.tasks.find(w => w.id === taskId);
    if (!task) return null;
    return s.projects.find(p => p.id === task.project_id)?.name ?? null;
  });

  // Asked on OPEN, not on mount: this component is mounted for the app's
  // whole life, and at startup the PATH probe usually hasn't landed yet.
  const [backend, setBackend] = useState<FindBackend | null>(null);
  useEffect(() => {
    if (!taskId) return;
    let live = true;
    loadBackend().then(b => { if (live) setBackend(b); });
    return () => { live = false; };
  }, [taskId]);

  const regexMode = usePrefs(s => s.findInFilesRegex);
  const setRegexMode = usePrefs(s => s.setFindInFilesRegex);
  const matchCase = usePrefs(s => s.findInFilesMatchCase);
  const setMatchCase = usePrefs(s => s.setFindInFilesMatchCase);

  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<FileGroup[]>([]);
  const [searching, setSearching] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [renderLimit, setRenderLimit] = useState(RENDER_CHUNK);
  const listRef = useRef<HTMLDivElement>(null);

  // searchId is bumped each keystroke; late events from older searches
  // arrive with mismatched ids and are ignored. Kept in a ref so the
  // event listeners (which close over the value at subscribe time) can
  // compare against the freshest value, not a stale snapshot.
  const activeSearchIdRef = useRef<string>("");

  // Reset everything on open. On close, cancel any in-flight grep so we
  // don't waste CPU once the user moves on.
  useEffect(() => {
    if (!taskId) return;
    setQuery("");
    setGroups([]);
    setTruncated(false);
    setSearching(false);
    setActiveIdx(0);
    return () => { taskGrepCancel(taskId).catch(() => {}); };
  }, [taskId]);

  // Debounced search. Every keystroke schedules a fresh search; the
  // previous one is auto-killed by Rust (per-task slot).
  useEffect(() => {
    if (!taskId) return;
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) {
      // Short queries (1-2 chars) on a giant repo always blow past the
      // 500-hit cap and are useless to scroll. Show a prompt instead of
      // firing grep. Also clears stale groups when the user backspaces
      // below the threshold.
      activeSearchIdRef.current = "";
      setGroups([]);
      setTruncated(false);
      setSearching(false);
      return;
    }

    // Cleanup handle shared across the debounce setTimeout and the
    // useEffect cleanup. If the effect tears down BEFORE the timer fires
    // we just clear the timer; once the timer fires this gets reassigned
    // to the per-search teardown so we can release Tauri listeners too.
    let cleanupCurrent: (() => void) | null = null;

    const t = window.setTimeout(() => {
      const searchId = crypto.randomUUID();
      activeSearchIdRef.current = searchId;
      // Don't clear groups/truncated here — keep the previous query's
      // results visible until the new search produces its own. Replacing
      // atomically on flush avoids the empty→populated flash on every
      // keystroke. Highlight will momentarily mismatch the stale rows
      // against the new needle, which is still less jarring than blank.
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
      // Always tear listeners down on any terminal event — superseded or
      // not. Previously the `searchId !== current` guard returned early
      // BEFORE the unlisten calls, leaking two Tauri listeners per
      // keystroke. Helper centralizes the cleanup so neither branch
      // forgets it.
      const teardown = () => {
        if (pendingFlush != null) { clearTimeout(pendingFlush); pendingFlush = null; }
        unResult?.(); unResult = null;
        unDone?.(); unDone = null;
      };

      onGrepResult(searchId, hits => {
        if (activeSearchIdRef.current !== searchId) return;
        for (const hit of hits) {
          const arr = acc.get(hit.path);
          if (arr) {
            if (arr.length < MAX_HITS_PER_FILE) arr.push(hit);
          } else if (acc.size < MAX_FILES) {
            acc.set(hit.path, [hit]);
          }
        }
        if (pendingFlush == null) pendingFlush = window.setTimeout(flush, 40);
      }).then(u => {
        // If the search was already superseded before listener wired up,
        // detach immediately.
        if (activeSearchIdRef.current !== searchId) u();
        else unResult = u;
      });

      onGrepDone(searchId, d => {
        const isCurrent = activeSearchIdRef.current === searchId;
        if (isCurrent) {
          if (pendingFlush != null) { clearTimeout(pendingFlush); flush(); }
          // Zero-result searches never call flush(), so the stale groups
          // from the previous query would otherwise linger. Clear here.
          if (acc.size === 0) setGroups([]);
          setTruncated(d.truncated);
          setSearching(false);
        }
        teardown();
      }).then(u => {
        if (activeSearchIdRef.current !== searchId) u();
        else unDone = u;
      });

      taskGrepStart(taskId, trimmed, searchId, { regex: regexMode, case_sensitive: matchCase })
        .catch(() => setSearching(false));

      // Hand teardown to the useEffect cleanup. A fresh keystroke / dialog
      // close supersedes this search: invalidate the ref to short-circuit
      // late events and release listener handles even if Rust never emits
      // done (SIGKILLed thread can exit mid-flush).
      cleanupCurrent = () => {
        if (activeSearchIdRef.current === searchId) activeSearchIdRef.current = "";
        teardown();
      };
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(t);
      cleanupCurrent?.();
    };
    // Deps stay the primitive flags, never a freshly-built options object:
    // a new identity each render would restart git grep on every render.
  }, [taskId, query, regexMode, matchCase]);

  function cancelSearch() {
    if (!taskId) return;
    activeSearchIdRef.current = "";
    setSearching(false);
    taskGrepCancel(taskId).catch(() => {});
  }

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
    setRenderLimit(RENDER_CHUNK);
    // Scroll back to top so newly arrived results aren't hidden below.
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [rows.length]);

  function pickHit(hit: GrepHit) {
    if (!taskId) return;
    const name = hit.path.split("/").pop() || hit.path;
    openPreviewTab(taskId, {
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
    // Keyboard nav crossing the render boundary needs to grow the slice
    // so the active row actually exists in the DOM (otherwise scrollIntoView
    // would no-op and the user would be selecting an invisible row).
    if (i >= renderLimit) setRenderLimit(Math.min(rows.length, i + RENDER_CHUNK));
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

  function countText(): string {
    const matches = t(totalHits === 1 ? "findInFiles.matchCountOne" : "findInFiles.matchCountMany", { count: totalHits });
    const files = t(groups.length === 1 ? "findInFiles.fileCountOne" : "findInFiles.fileCountMany", { count: groups.length });
    return `${matches} ${files}${truncated ? t("findInFiles.truncatedSuffix") : ""}`;
  }

  function statusLeft(): React.ReactNode {
    const trimmed = query.trim();
    if (!trimmed) {
      const scope = projectName ?? t("findInFiles.thisTask");
      const backendName = backend === "ripgrep" ? "ripgrep" : "git grep";
      /* Held back until the probe lands, so the backend name never
          flips under the user a frame after the dialog opens. */
      if (!backend) {
        return (
          <Trans
            t={t}
            i18nKey="findInFiles.searchingInNoBackend"
            values={{ scope }}
            components={{ b: <span className="font-semibold text-[var(--color-fg)]" />, code: <code className="text-[12px]" /> }}
          />
        );
      }
      return (
        <Trans
          t={t}
          i18nKey="findInFiles.searchingIn"
          values={{ scope, backend: backendName }}
          components={{ b: <span className="font-semibold text-[var(--color-fg)]" />, code: <code className="text-[12px]" /> }}
        />
      );
    }
    if (trimmed.length < MIN_QUERY) return t("findInFiles.minChars", { count: MIN_QUERY });
    if (groups.length) return countText();
    return searching ? "" : t("findInFiles.noMatches");
  }

  return (
    <Dialog.Root open={!!taskId} onOpenChange={(v) => (v ? null : close())}>
      <Dialog.Portal>
        {/* Soft animated dim (matches the ⇧⌘P palette): fades in/out via
            data-state instead of a snap, for contrast without flicker. */}
        <Dialog.Overlay className="termic-backdrop fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          className="termic-pop fixed left-1/2 top-12 z-50 w-[min(760px,92vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] shadow-2xl outline-none"
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">{t("findInFiles.srTitle")}</Dialog.Title>
          <Dialog.Description className="sr-only">{t("findInFiles.srDesc")}</Dialog.Description>
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
              placeholder={t("findInFiles.placeholder", {
                scope: projectName ?? t("findInFiles.scopeFiles"),
                syntax: regexMode ? t("findInFiles.syntaxRegexp") : t("findInFiles.syntaxLiteral"),
                case: matchCase ? t("findInFiles.caseSensitive") : t("findInFiles.caseInsensitive"),
              })}
              className="w-full bg-transparent pl-1 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
            />
            <FlagToggle
              on={matchCase} onToggle={() => setMatchCase(!matchCase)}
              glyph="Aa" title={t("findInFiles.matchCaseTitle")} testId="fif-case"
            />
            <FlagToggle
              on={regexMode} onToggle={() => setRegexMode(!regexMode)}
              glyph=".*"
              title={backend === "ripgrep"
                ? t("findInFiles.regexTitleRipgrep")
                : t("findInFiles.regexTitleGitGrep")}
              testId="fif-regex"
            />
            {/* Fallback only: ripgrep is faster on big repos, so tell the
                user it exists. Never shown once rg is on their PATH. */}
            {backend === "git-grep" && (
              <button
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={() => { openUrl(RIPGREP_INSTALL_URL).catch(() => {}); }}
                title={t("findInFiles.rgHintTitle")}
                data-testid="fif-rg-hint"
                data-no-drag
                className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
              >
                <Zap className="h-3 w-3" />
                rg
              </button>
            )}
          </div>
          {/* ONE row for every state, always mounted at a fixed height:
              message or count on the left, the search indicator pinned
              right. Everything that changes while typing lives here, so
              neither the toggles above nor the rows below ever shift. */}
          <div
            data-testid="fif-status"
            className={cn(
              "flex min-h-5 items-center justify-between gap-3 px-3 py-3 text-[13px]",
              query ? "text-[var(--color-fg-faint)]" : "text-[var(--color-fg-dim)]",
              rows.length > 0 && "border-b border-[var(--color-border)]",
            )}
          >
            <span className="truncate">{statusLeft()}</span>
            {searching && (
              <span className="flex shrink-0 items-center gap-1">
                {t("findInFiles.searching")}
                <button
                  type="button"
                  onClick={cancelSearch}
                  title={t("findInFiles.cancelSearchTitle")}
                  data-no-drag
                  className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
          </div>
          <div
            ref={listRef}
            data-testid="fif-results"
            onScroll={(e) => {
              const el = e.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 240 && renderLimit < rows.length) {
                setRenderLimit(Math.min(rows.length, renderLimit + RENDER_CHUNK));
              }
            }}
            className={cn("max-h-[78vh] overflow-y-auto", rows.length > 0 && "py-1")}
          >
            {rows.slice(0, renderLimit).map((r, i) => {
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
                    {highlight(h, query.trim(), { regex: regexMode, case_sensitive: matchCase })}
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
