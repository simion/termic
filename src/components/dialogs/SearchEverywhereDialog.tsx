// Search Everywhere — double-Shift, JetBrains' gesture (GH #174).
//
// One list, no tabs, and that is deliberate: **most people never turn code
// intelligence on**, so a symbols-only dialog would be a dead key for them.
// Files always work (no server involved), symbols merge in when a checkout is
// armed, and when it is not, one row offers to arm it — which is also where
// someone discovers the feature exists.
//
// ⌘P is untouched. It is a fast, single-purpose thing people have muscle
// memory for; adding modes to it would tax everyone to serve the few who want
// symbols. JetBrains keeps them separate for the same reason.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { Compass, Search } from "lucide-react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useCodeIntel, checkoutRoot, grantKey } from "@/store/codeIntel";
import { projectUpdate, taskListFilesForFinder } from "@/lib/ipc";
import { lspOffer } from "@/lib/lsp/install";
import { confirmAndInstall } from "@/lib/lsp/installFlow";
import type { SymbolHit } from "@/lib/lsp/symbolSearch";
import { languagesPresent } from "@/lib/lsp/projectLanguages";
import { SERVERS, languageName } from "@/lib/lsp/languages";
import { codeIntelNameLower } from "@/lib/lsp/featureName";
import { memoryShort, serverFor } from "@/lib/lsp/serverNames";
import { CodeIntelActions } from "@/components/task/CodeIntelActions";
import { fileIconUrl } from "@/lib/explorer/iconResolver";
import { fuzzyMatch, Highlighted } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";
import { bindingGlyphs } from "@/lib/shortcuts";
import { focusedTabId } from "@/lib/splitTree";
import { effectiveLanguageId } from "@/lib/languages";
import { lspServerFor } from "@/lib/lsp/languages";

const MAX_FILES = 25;
const MAX_SYMBOLS = 25;

interface FileRow { kind: "file"; path: string; matches: number[]; score: number }
interface SymbolRow { kind: "symbol"; hit: SymbolHit }
interface OfferRow {
  kind: "offer"; server: string; label: string; installable: boolean; exe: string | null;
  /** Download size for an installable row, so its confirm can say what it
   *  costs. 0 when unknown, which prints no figure rather than inventing one. */
  bytes: number;
}
type Row = OfferRow | FileRow | SymbolRow;

export function SearchEverywhereDialog() {
  const { t } = useTranslation("dialogs");
  const taskId = useUI(s => s.searchEverywhereTaskId);
  const close = useUI(s => s.closeSearchEverywhere);
  const openPreviewTab = useApp(s => s.openPreviewTab);

  const task = useApp(s => s.tasks.find(t => t.id === taskId));
  const project = useApp(s => (task ? s.projects.find(p => p.id === task.project_id) : undefined));
  const root = task ? checkoutRoot(task, project) : "";
  const offered = usePrefs(s => s.codeIntelligence);
  const fileFinderBinding = usePrefs(s => s.shortcuts["file-finder"]);
  const typeChecking = usePrefs(s => s.codeIntelDiagnostics);
  const grants = useCodeIntel(s => s.grants);
  const armed = SERVERS.filter(sv => (grants[grantKey(root, sv)]?.length ?? 0) > 0);

  const activePaneId = useApp(s => taskId ? s.activePaneId[taskId] : null);
  const mainActiveTabId = useApp(s => taskId ? s.activeTab[taskId] : null);
  const splitTree = useApp(s => taskId ? s.splitTree[taskId] : null);
  const tabId = focusedTabId(splitTree, activePaneId, mainActiveTabId);
  const activeTab = useApp(s => {
    if (!taskId || !tabId) return null;
    return s.tabs[taskId]?.find(t => t.id === tabId) || null;
  });
  const activeLspServerId = activeTab?.type === "edit" || activeTab?.type === "external"
    ? lspServerFor(effectiveLanguageId(activeTab), activeTab.path)
    : null;

  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [symbols, setSymbols] = useState<SymbolHit[]>([]);
  const [offers, setOffers] = useState<
    Array<{ server: string; label: string; installable: boolean; exe: string | null; bytes: number }>
  >([]);
  const [activeIdx, setActiveIdx] = useState(0);
  /** Server id currently downloading, so its button says so and cannot be
   *  pressed twice into two concurrent fetches of the same archive. */
  const [installing, setInstalling] = useState<string | null>(null);
  /** Which button within the active row the keyboard is on. */
  const [actionIdx, setActionIdx] = useState(0);
  // In flight, including the debounce. Without it the Symbols section had only
  // two states, "rows" and "gone", so every keystroke tore the section out and
  // put it back and the list below jumped by its height.
  const [searching, setSearching] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!taskId) return;
    setQuery("");
    setActiveIdx(0);
    setSymbols([]);
    let alive = true;
    taskListFilesForFinder(taskId).then(list => { if (alive) setFiles(list); }).catch(() => {});
    return () => { alive = false; };
  }, [taskId]);

  // Hold the armed servers open while the dialog is up: it can be opened with
  // no editor at all, which is exactly when someone wants to find a symbol.
  useEffect(() => {
    if (!taskId || !offered || !armed.length) return;
    let releases: Array<() => void> = [];
    let alive = true;
    void (async () => {
      const { acquireClient } = await import("@/lib/lsp/host");
      if (alive) releases = armed.map(sv => acquireClient(root, sv).release);
    })();
    return () => { alive = false; releases.forEach(r => r()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, offered, root, armed.join(",")]);

  // What could be armed, for the offer row. Only asked when nothing is.
  //
  // Ordered by what the PROJECT is written in, not by a fixed list. Opening
  // this with no editor is the common case (it is the one place you can search
  // with nothing open) and there is then no buffer to take a language from, so
  // a Django repo was offered TypeScript first purely because typescript sorts
  // early in a hard-coded array. The file list is already here; it knows.
  // Two questions, two thresholds. `languagesPresent` is what to OFFER (a
  // single .ts file is a reason to offer, not a reason to start something),
  // and it still refuses a language the checkout has no trace of, which is the
  // complaint: "Enable Rust" and "Enable Go" on a Django repo.
  const detected = useMemo(() => languagesPresent(files), [files]);
  useEffect(() => {
    if (!taskId || !root || armed.length) { setOffers([]); return; }
    let alive = true;
    void (async () => {
      const found: Array<{ server: string; label: string; installable: boolean; exe: string | null; bytes: number }> = [];
      // ONLY what this project is written in. Offering "Enable Rust" and
      // "Enable Go" on a Django repo is noise dressed as help: it asks the
      // reader to evaluate three languages that appear nowhere in their
      // checkout, and the one that does appear is buried among them. Detection
      // is over the file list the dialog already has (projectLanguages), so
      // this costs nothing.
      // Every detected language is offered: the project's list is about what
      // starts automatically, not about what the reader may ask for here.
      const order = detected.filter(d => SERVERS.includes(d));
      for (const server of order) {
        try {
          const offer = await lspOffer(root, server);
          if (offer.exe) {
            found.push({ server, label: server, installable: false, exe: offer.exe, bytes: 0 });
          } else if (offer.installLabel) {
            found.push({
              server, label: offer.installLabel, installable: true, exe: null,
              bytes: offer.installBytes ?? 0,
            });
          }
        } catch { /* not available on this platform */ }
      }
      if (alive) setOffers(found);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, root, armed.length, project?.id, detected.join(",")]);

  // Symbols are a request per keystroke to every armed server, so they wait
  // for a pause. Files are local and filter instantly.
  useEffect(() => {
    if (!taskId || !offered || !armed.length || !query.trim()) {
      setSymbols([]);
      setSearching(false);
      return;
    }
    let alive = true;
    // Marked as searching from the KEYSTROKE, not from the request: the 180ms
    // debounce is part of the wait as far as the reader is concerned, and
    // showing stale rows as though they answered the new query is worse than
    // saying "Searching".
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        const { searchSymbols } = await import("@/lib/lsp/symbolSearch");
        const hits = await searchSymbols(root, query, "all", MAX_SYMBOLS);
        if (!alive) return;
        setSymbols(hits);
        setSearching(false);
      })();
    }, 180);
    return () => { alive = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, offered, root, query, armed.join(",")]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    // Which language to offer, at the TOP of the list. The focused editor's
    // when there is one; otherwise what the project is mostly written in.
    //
    // The footer offer alone was not enough: it sits under twenty-five file
    // rows, so opening this with nothing in the editor showed "Search files"
    // and, as far as anyone could tell, no way to get symbols at all. That is
    // the one case where the dialog is most useful and least discoverable.
    const offerFor = activeLspServerId
      ?? offers.find(o => detected.includes(o.server))?.server
      ?? null;
    if (offerFor && !armed.includes(offerFor as any)) {
      const offer = offers.find(o => o.server === offerFor);
      if (offer) {
        out.push({ kind: "offer", ...offer });
      }
    }
    out.push(...symbols.map(hit => ({ kind: "symbol" as const, hit })));
    if (!query.trim()) {
      out.push(...files.slice(0, MAX_FILES).map(p => ({ kind: "file" as const, path: p, matches: [], score: 0 })));
      return out;
    }
    const scored: FileRow[] = [];
    for (const f of files) {
      const m = fuzzyMatch(f, query);
      if (m) scored.push({ kind: "file", path: f, matches: m.matches, score: m.score });
    }
    scored.sort((a, b) => b.score - a.score);
    // Symbols first: a symbol is a more specific answer than a filename that
    // happens to contain the same letters.
    out.push(...scored.slice(0, MAX_FILES));
    return out;
  }, [files, symbols, query, activeLspServerId, armed, offers, detected]);

  useEffect(() => { setActiveIdx(0); }, [query]);
  // Landing on a row always starts at its first button, so ← / → describe a
  // position within THIS row rather than a setting that follows the reader
  // down the list.
  useEffect(() => { setActionIdx(0); }, [activeIdx, query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  function pick(row: Row) {
    if (!taskId || !task) return;
    if (row.kind === "offer") {
      // An installable row has nothing to arm yet: arming it alone was the
      // keyboard half of the same bug the button had.
      if (row.installable) void installAndArm(row);
      else arm(row.server);
      return; // Do NOT close the dialog
    }
    if (row.kind === "file") {
      openPreviewTab(taskId, { type: "edit", path: row.path, title: row.path.split("/").pop() || row.path });
    } else {
      const inside = row.hit.path.startsWith(task.path + "/");
      openPreviewTab(taskId, {
        type: inside ? "edit" : "external",
        path: inside ? row.hit.path.slice(task.path.length + 1) : row.hit.path,
        title: row.hit.file.split("/").pop() ?? row.hit.file,
        revealAt: { line: row.hit.line },
      });
    }
    close();
  }

  /**
   * Download the server, THEN arm. This row's Install button used to call
   * `arm()` alone, which grants and flips the feature on without fetching
   * anything: with no executable on the machine nothing could start, so the
   * dialog sat waiting for symbols that were never coming and the editor chip
   * went on offering the same download.
   *
   * Shares `confirmAndInstall` with the chip, so there is one disclosure and
   * one download path rather than two that can drift apart again.
   */
  async function installAndArm(row: OfferRow) {
    if (!taskId || installing) return;
    setInstalling(row.server);
    try {
      const ready = await confirmAndInstall({
        server: row.server,
        label: row.label,
        bytes: row.bytes,
        language: languageName(row.server),
      });
      if (ready) arm(row.server);
    } finally {
      setInstalling(null);
    }
  }

  /** Turn it on for THIS task's checkout. The grant is refcounted and lapses
   *  when the checkout's last task closes, which is the whole point of it. */
  function arm(server: string) {
    if (!taskId) return;
    usePrefs.getState().setCodeIntelligence(true);
    useCodeIntel.getState().arm(grantKey(root, server), taskId);
  }

  /**
   * Turn it on now AND tell the project to keep doing it.
   *
   * Two separate acts, deliberately: the grant is per checkout and temporary,
   * `code_intel_auto` is the standing instruction that arms future tasks. One
   * button for each, because "just this once" and "always, on this repo" are
   * different amounts of memory to agree to and only the reader knows which
   * they meant.
   *
   * The value is the NARROWEST one that covers where they are standing: a
   * worktree task needs "all" (which is one server per worktree, and can
   * multiply), the main checkout needs only "main" (one server per language,
   * shared by every task on it). Widening beyond that would be spending their
   * memory on a guess.
   */
  async function armAlways(server: string) {
    if (!taskId || !task || !project) return;
    arm(server);
    const auto = task.is_main_checkout ? "main" : "all";
    if (project.code_intel_auto === auto || project.code_intel_auto === "all") return;
    try {
      await projectUpdate({ ...project, code_intel_auto: auto });
      await useApp.getState().loadAll();
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
  }

  /** "zuban, about 85 MB": what starts, and what it holds while it runs.
   *  Empty for a server we have no measurement for, because inventing one is
   *  worse than saying nothing. */
  function costLine(row: OfferRow): string {
    if (row.installable) return "";
    const name = serverFor(row.exe, row.server);
    const cost = memoryShort(name);
    return cost ? `${name}, ${cost}` : name;
  }

  /** How many buttons the row at `i` offers to the keyboard. Result rows are
   *  one thing you press Enter on; the offer row is a choice between two. */
  function actionCount(row: Row | undefined): number {
    if (!row || row.kind !== "offer") return 1;
    return row.installable ? 1 : 2;
  }

  /**
   * Press the row's focused button.
   *
   * The offer row's buttons live in `CodeIntelActions`, which owns what each
   * one means: arming discloses the memory cost, "Always" also writes the
   * project's standing instruction. Enter has to go THROUGH them rather than
   * around them, or the keyboard path quietly skips the disclosure the mouse
   * path shows. They fire on mousedown (so the query input never loses focus
   * mid-type), hence a mousedown here rather than `.click()`.
   */
  function activateOffer() {
    const btns = listRef.current?.querySelectorAll<HTMLElement>(
      `[data-row="${activeIdx}"] button`,
    );
    btns?.[Math.min(actionIdx, btns.length - 1)]
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const row = rows[activeIdx];
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      // Only when the row has somewhere to go. Otherwise ← / → stay what they
      // are everywhere else in a text field: moving the caret through what you
      // typed, which is the more common thing to want while typing.
      const n = actionCount(row);
      if (n < 2) return;
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setActionIdx(i => Math.min(Math.max(i + step, 0), n - 1));
    }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (!row) return;
      if (row.kind === "offer" && !row.installable) activateOffer();
      else pick(row);
    }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  }

  const firstFileIdx = rows.findIndex(r => r.kind === "file");

  /** One row, by its index in the flat `rows` list, which is what keyboard
   *  navigation and `activeIdx` address. Sections are a rendering concern
   *  layered on top; they must not renumber anything. */
  function renderRow(row: Row, i: number) {
    const active = i === activeIdx;
    if (row.kind === "offer") {
      return (
        <div
          key="offer"
          data-row={i}
          data-testid="se-offer-row"
          data-server={row.server}
          className={cn(
            "flex w-full items-center gap-3 px-3 py-2.5",
            // The row is in the arrow-key order, so it has to show when it is
            // the one Enter would act on, exactly like a result row does.
            active && "bg-[var(--color-bg-2)]",
          )}
        >
          <Compass className="h-5 w-5 shrink-0 text-[var(--color-accent)]" />
          <span className="flex min-w-0 flex-col">
            <span className="text-[13.5px] font-medium text-[var(--color-fg)]">
              {row.installable
                ? t("searchEverywhere.offerTitleInstall", { language: languageName(row.server), label: row.label })
                : t("searchEverywhere.offerTitleEnable", { language: languageName(row.server) })}
            </span>
            <span className="text-[11.5px] text-[var(--color-fg-dim)]">
              {/* The memory figure, on the row, because turning this on from
                  here used to raise a confirm dialog ON TOP of this one to
                  say a single number. The number is the consent, so it stays;
                  the modal was only ever its container, and a modal stacked
                  over an open dialog is the worst container available. */}
              {t("searchEverywhere.offerSub")}
              {costLine(row) && ` ${t("searchEverywhere.offerSubCost", { cost: costLine(row) })}`}
            </span>
          </span>
          <span className="ml-auto shrink-0">
            {row.installable ? (
              <button
                type="button"
                data-testid={`se-arm-${row.server}`}
                disabled={installing === row.server}
                onMouseDown={(e) => { e.preventDefault(); void installAndArm(row); }}
                className="rounded-md bg-[var(--color-accent-deep)] px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-60"
              >
                {installing === row.server ? t("searchEverywhere.downloading") : t("searchEverywhere.install")}
              </button>
            ) : (
              <CodeIntelActions
                taskId={taskId!}
                server={row.server}
                compact
                // Only when the row actually PRINTED the figure. `costLine`
                // is empty for a server we have no measurement for, and
                // silencing the prompt in that case would drop the disclosure
                // rather than move it, which is the one thing this prop must
                // never do.
                disclosed={!!costLine(row)}
                focusedAction={active ? actionIdx : null}
              />
            )}
          </span>
        </div>
      );
    }
    return (
      <button
        key={row.kind === "file" ? `f:${row.path}` : `s:${row.hit.path}:${row.hit.line}:${row.hit.name}`}
        data-row={i}
        data-testid={row.kind === "symbol" ? "se-symbol-row" : "se-file-row"}
        onClick={() => pick(row)}
        onMouseMove={() => setActiveIdx(i)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]",
          active ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]" : "text-[var(--color-fg)]",
        )}
      >
        {row.kind === "file" ? (
          <>
            <img src={fileIconUrl(row.path.split("/").pop() || row.path)} alt="" className="h-4 w-4 shrink-0 file-icon" />
            <span className="truncate"><Highlighted text={row.path} matches={row.matches} /></span>
          </>
        ) : (
          <>
            <img src={fileIconUrl(row.hit.file)} alt="" className="h-4 w-4 shrink-0 file-icon" />
            {/* Highlighted the same way a file row is, with the same matcher:
                the part you typed is the part worth finding with your eye, and
                a symbol list is longer and more uniform than a file list. */}
            <span className="truncate">
              <Highlighted text={row.hit.name} matches={fuzzyMatch(row.hit.name, query)?.matches ?? []} />
            </span>
            <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">{row.hit.kind}</span>
            {/* When the rest were collapsed, say how many rather than
                pretending this was the only one. */}
            {row.hit.alsoIn ? (
              <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">
                {t("searchEverywhere.more", { count: row.hit.alsoIn })}
              </span>
            ) : null}
            <span className="ml-auto min-w-0 truncate text-[12px] text-[var(--color-fg-faint)]">
              {row.hit.file}:{row.hit.line}
            </span>
          </>
        )}
      </button>
    );
  }

  /** The list, as fixed sections. An offer sits above them: it is not a
   *  result, it is the reason there are none. */
  const indexed = rows.map((row, index) => ({ row, index }));
  const offerEntry = indexed.find(e => e.row.kind === "offer");
  const sections: Array<{ id: string; title: string; rows: typeof indexed; empty: string; hint?: string }> = [];
  if (armed.length) {
    sections.push({
      id: "symbols",
      title: t("searchEverywhere.sectionSymbols"),
      rows: indexed.filter(e => e.row.kind === "symbol"),
      empty: searching ? t("searchEverywhere.symbolsSearching") : query.trim() ? t("searchEverywhere.symbolsNoMatch") : t("searchEverywhere.symbolsIdle"),
    });
  }
  sections.push({
    id: "files",
    title: t("searchEverywhere.sectionFiles"),
    rows: indexed.filter(e => e.row.kind === "file"),
    empty: query.trim() ? t("searchEverywhere.filesNoMatch") : t("searchEverywhere.filesIdle"),
    // Where this half of the dialog lives on its own. Someone who only ever
    // wants a file should not have to come through the symbol search to get
    // one, and the header is where they are already looking when they scroll
    // past the symbols. Read from the live binding, never the default: the key
    // is rebindable, and a header naming a chord that opens nothing is worse
    // than a header with no chord at all.
    hint: fileFinderBinding ? bindingGlyphs(fileFinderBinding).join("") : undefined,
  });

  return (
    <Dialog.Root open={!!taskId} onOpenChange={(v) => (v ? null : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="termic-backdrop fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          data-testid="search-everywhere"
          className="termic-pop fixed left-1/2 top-12 z-50 w-[min(760px,92vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] shadow-2xl outline-none"
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">{t("searchEverywhere.srTitle")}</Dialog.Title>
          <Dialog.Description className="sr-only">
            {t("searchEverywhere.srDesc", { feature: codeIntelNameLower(typeChecking) })}
          </Dialog.Description>
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
            <Search className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)]" />
            <input
              autoFocus
              data-testid="search-everywhere-input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              // Names the KINDS, because "symbols" alone does not tell anyone
              // that this is where you find a class by name. Files stay last:
              // they are what everyone already expects a search box to do.
              placeholder={armed.length
                ? t("searchEverywhere.placeholderArmed")
                : t("searchEverywhere.placeholderFiles")}
              className="w-full bg-transparent pl-1 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
            />
          </div>

          <div ref={listRef} className="max-h-[70vh] overflow-y-auto py-1">
            {offerEntry && renderRow(offerEntry.row, offerEntry.index)}

            {/* Sections are STRUCTURE, not a consequence of having results.
                Deriving the headers from the row list meant an empty result
                deleted its section and everything below jumped up by its
                height: type one more character and the whole list moved. Both
                sections are always here, and an empty one says so. */}
            {sections.map(section => (
              <div key={section.id}>
                <div className="flex items-center gap-2 px-3 pb-0.5 pt-2 text-[11px] uppercase tracking-wide text-[var(--color-fg-faint)]">
                  <span>{section.title}</span>
                  {section.hint && (
                    <span className="ml-auto normal-case tracking-normal">
                      {t("searchEverywhere.filesOnlyHint", { keys: section.hint })}
                    </span>
                  )}
                </div>
                {section.rows.length > 0
                  ? section.rows.map(({ row, index }) => renderRow(row, index))
                  : (
                    <div
                      data-testid={`se-empty-${section.id}`}
                      className="px-3 py-1.5 text-[12.5px] text-[var(--color-fg-faint)]"
                    >
                      {section.empty}
                    </div>
                  )}
              </div>
            ))}

            {/* The discovery point: someone who has never turned this on finds
                out it exists at the moment they went looking for a symbol. */}
            {!armed.length && offers.filter(o => o.server !== rows.find(r => r.kind === "offer")?.server).length > 0 && (
              <div className="border-t border-[var(--color-border-soft)] px-3 py-2.5 text-[12.5px] text-[var(--color-fg-dim)]">
                <span className="mr-2">{t("searchEverywhere.discoveryLead")}</span>
                {offers.filter(o => o.server !== rows.find(r => r.kind === "offer")?.server).map(o => (
                  <button
                    key={o.server}
                    data-testid={`se-arm-${o.server}`}
                    onClick={() => arm(o.server)}
                    className="mr-2 rounded border border-[var(--color-border)] px-2 py-0.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-hover)]"
                  >
                    {o.installable
                      ? t("searchEverywhere.installLanguage", { language: languageName(o.server), label: o.label })
                      : t("searchEverywhere.enableLanguage", { language: languageName(o.server) })}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
