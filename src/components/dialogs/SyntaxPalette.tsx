// "Set syntax" picker — the language list for ONE editor tab, fuzzy-filtered
// by label. Reached from the breadcrumb's language button and from the command
// palette. Modelled on PromptPalette.tsx: same non-modal Dialog, same fuzzy
// matcher, same keyboard contract (↑↓ move, Enter picks, Esc cancels).
//
// The pick is per-tab and session-only (`EditTab.syntax`), which is the
// Sublime behaviour: it overrides what the extension says for this buffer,
// for as long as the buffer is open, and never rewrites the file or a setting.
//
// A SCRATCHPAD (GH #244) is the exception, and the tab type where this picker
// matters most: with no extension to go on, a manual pick is the only way to
// say what the buffer is, so `ScratchTab.syntax` is PERSISTED in the scratch
// index. It is written HERE, in the one place a manual pick is made, and
// deliberately not from an effect in the pane: picking Markdown swaps the
// plain editor for the markdown shell, which REMOUNTS EditorPane in the same
// commit, so a pane-side effect would only ever see the new value as its
// initial seed and would never write it.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { Search, Check } from "lucide-react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { scratchSetMeta } from "@/lib/ipc";
import { effectiveLanguageId } from "@/lib/languages";
import { fuzzyMatch, Highlighted } from "@/lib/fuzzy";
import type { EditTab, ExternalTab, ScratchTab } from "@/lib/types";

/** One row per language: the registry name IS the label, and the registry's
 *  aliases are extra fuzzy-search terms that are never displayed. */
type Row = { name: string; keywords: string };

export function SyntaxPalette() {
  const { t } = useTranslation("dialogs");
  const target = useUI(s => s.syntaxPaletteFor);
  const close = useUI(s => s.closeSyntaxPalette);
  const open = !!target;
  // The tab is read live: it can be closed (or recycled onto another file)
  // while the picker is up, in which case there is nothing left to apply to.
  const tab = useApp(s => target
    ? (s.tabs[target.taskId] ?? []).find(
        t => t.id === target.tabId
          && (t.type === "edit" || t.type === "scratch" || t.type === "external"),
      ) as EditTab | ScratchTab | ExternalTab | undefined
    : undefined);
  const currentId = effectiveLanguageId(tab);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // The language list is fetched when the picker OPENS, never at import time.
  // It is CodeMirror's registry (~150 languages), and `lib/languageExts` is
  // the gateway to every grammar chunk behind it — this dialog is mounted from
  // App.tsx, i.e. the MAIN chunk, so a static import here would put all of it
  // on the app-start path (see lib/mainChunkGuard.test.ts). By the time the
  // picker is reachable the editor pane has already loaded the module, so this
  // resolves in a microtask and the list is there on the first paint.
  const [langs, setLangs] = useState<Row[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    import("@/lib/languageExts").then(m => { if (alive) setLangs(m.pickerLanguages()); });
    return () => { alive = false; };
  }, [open]);

  // Open on the language the buffer already uses, so Enter is a no-op rather
  // than a surprise and the list is scrolled to where you are.
  useEffect(() => {
    if (!open || !langs.length) return;
    setQuery("");
    setActiveIdx(Math.max(0, langs.findIndex(l => l.name === currentId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, langs]);
  useEffect(() => { if (query) setActiveIdx(0); }, [query]);

  const rows = useMemo(() => {
    type Scored = { lang: Row; matches: number[] };
    if (!query) return langs.map<Scored>(lang => ({ lang, matches: [] }));
    const out: Array<Scored & { score: number }> = [];
    for (const lang of langs) {
      const m = fuzzyMatch(lang.name, query);
      if (m) { out.push({ lang, matches: m.matches, score: m.score }); continue; }
      // Aliases are searched but never highlighted — "ini" finds "Properties
      // files" without the match indices meaning anything there.
      if (lang.keywords && fuzzyMatch(lang.keywords, query))
        out.push({ lang, matches: [], score: -1 });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }, [query, langs]);

  useEffect(() => {
    if (activeIdx > rows.length - 1) setActiveIdx(Math.max(0, rows.length - 1));
  }, [rows.length, activeIdx]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  function pick(lang: Row) {
    if (target && tab) {
      useApp.getState().patchTab(target.taskId, target.tabId, { syntax: lang.name });
      // A pad's pick outlives the session: there is no extension to re-derive
      // it from, so the scratch index is the only record of it.
      if (tab.type === "scratch") {
        scratchSetMeta(target.taskId, tab.scratchId, { syntax: lang.name }).catch(() => {});
      }
    }
    close();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const l = rows[activeIdx]?.lang;
      if (l) pick(l);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v ? null : close())} modal={false}>
      <Dialog.Portal>
        <div
          aria-hidden
          data-state={open ? "open" : "closed"}
          className="termic-backdrop pointer-events-none fixed inset-0 z-40 bg-black/30"
        />
        <Dialog.Content
          data-testid="syntax-palette"
          onOpenAutoFocus={() => { returnFocusRef.current = (document.activeElement as HTMLElement) ?? null; }}
          onCloseAutoFocus={(e) => {
            // Hand focus back where it came from (the editor, usually) rather
            // than letting it fall to <body> — same dance as PromptPalette.
            e.preventDefault();
            const el = returnFocusRef.current;
            requestAnimationFrame(() => {
              const ae = document.activeElement;
              if ((!ae || ae === document.body) && el && document.contains(el)) el.focus();
            });
          }}
          style={{ background: "color-mix(in srgb, var(--color-bg-1) 86%, transparent)" }}
          className="termic-pop fixed left-1/2 top-[14vh] z-50 w-[min(420px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--color-border)] shadow-2xl outline-none backdrop-blur-lg"
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">{t("syntaxPalette.srTitle")}</Dialog.Title>
          <Dialog.Description className="sr-only">{t("syntaxPalette.srDesc")}</Dialog.Description>
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
            <Search className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)]" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              placeholder={t("syntaxPalette.placeholder")}
              className="w-full bg-transparent pl-1 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
            />
          </div>
          <div ref={listRef} className="no-scrollbar max-h-[min(50vh,360px)] overflow-y-auto py-1">
            {rows.length === 0 && (
              <div className="px-3 py-3 text-[13px] text-[var(--color-fg-faint)]">{t("syntaxPalette.noMatching")}</div>
            )}
            {rows.map(({ lang, matches }, i) => (
              <button
                key={lang.name}
                data-row={i}
                data-lang={lang.name}
                onClick={() => pick(lang)}
                onMouseMove={() => setActiveIdx(i)}
                style={i === activeIdx ? { background: "color-mix(in srgb, var(--color-fg) 13%, transparent)" } : undefined}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-fg)]">
                  {query && matches.length ? <Highlighted text={lang.name} matches={matches} /> : lang.name}
                </span>
                {lang.name === currentId && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />}
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
