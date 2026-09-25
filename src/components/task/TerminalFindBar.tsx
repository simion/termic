import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import { findCountLabel, terminalFindDecorations } from "@/lib/terminalFind";

/** The addon's default cap on highlighted matches. Past it the addon stops
 *  decorating and reports index -1; the label says "1000+ matches". */
export const FIND_HIGHLIGHT_LIMIT = 1000;

// Find-in-terminal overlay, shared by every terminal (agent / shell tabs and
// the footer shell) so the two can't drift. Every match is highlighted the
// moment the query changes, the current one stands out, and reopening the bar
// on a kept query highlights again straight away.
//
// Highlights are xterm decorations: the addon re-runs the search 200ms after
// new output while a decorated query is live, so closing MUST clear them, or
// a streaming agent keeps paying for a search nobody is looking at.
export function TerminalFindBar({ open, onClose, termRef, addonRef }: {
  open: boolean;
  onClose: () => void;
  termRef: RefObject<Terminal | null>;
  addonRef: RefObject<SearchAddon | null>;
}) {
  const { t } = useTranslation("task");
  const [query, setQuery] = useState("");
  const [count, setCount] = useState<{ index: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const find = (q: string, dir: "next" | "prev", incremental: boolean) => {
    const a = addonRef.current;
    if (!a) return;
    if (!q) {
      a.clearDecorations();
      termRef.current?.clearSelection();
      setCount(null);
      return;
    }
    const decorations = terminalFindDecorations(termRef.current?.options.theme?.background);
    const opts = { incremental, decorations };
    if (dir === "next") a.findNext(q, opts);
    else a.findPrevious(q, opts);
  };

  useEffect(() => {
    if (!open) return;
    const a = addonRef.current;
    // Subscribed only while open: nothing needs a count for a closed bar.
    const sub = a?.onDidChangeResults(({ resultIndex, resultCount }) =>
      setCount({ index: resultIndex, total: resultCount }));
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
    // A kept query comes back highlighted, not blank until the next key.
    if (query) find(query, "next", true);
    return () => {
      sub?.dispose();
      a?.clearDecorations();
      setCount(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const btn = "rounded p-0.5 text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]";
  return (
    <div
      data-testid="terminal-find"
      className="absolute right-2 top-2 z-20 flex items-center gap-0.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2 py-1 shadow-lg"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={t("find.placeholder")}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        onChange={e => {
          setQuery(e.target.value);
          find(e.target.value, "next", true);
        }}
        onKeyDown={e => {
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
          else if (e.key === "Enter") { e.preventDefault(); find(query, e.shiftKey ? "prev" : "next", false); }
        }}
        className="w-44 bg-transparent text-[12px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
      />
      {query && count && (
        <span data-testid="terminal-find-count" className="mx-1 shrink-0 whitespace-nowrap text-[11px] tabular-nums text-[var(--color-fg-dim)]">
          {findCountLabel(count.index, count.total, FIND_HIGHLIGHT_LIMIT)}
        </span>
      )}
      <button type="button" title={t("find.prevTip")} onClick={() => find(query, "prev", false)} className={btn}><ChevronUp className="h-3.5 w-3.5" /></button>
      <button type="button" title={t("find.nextTip")} onClick={() => find(query, "next", false)} className={btn}><ChevronDown className="h-3.5 w-3.5" /></button>
      <button type="button" title={t("find.closeTip")} onClick={onClose} className={`ml-0.5 ${btn}`}><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}
