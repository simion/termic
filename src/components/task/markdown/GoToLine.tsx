// Go to line in the rendered preview (shortcut `preview-go-to-line`, ⌘G by
// default): a small input like the find bar. Enter scrolls to the innermost
// block holding source line N, or the next block when N is a blank line, and
// flashes it. Past the end of the file it says so and stays open.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Hash } from "lucide-react";
import { blockForLine, elRange, type LineRange } from "@/lib/markdown/lines";
import { flashTo } from "@/lib/markdown/reveal";

/** Scroll `scroller` to the block for `line` and flash it. False when the
 *  document has no block to land on. A block inside a closed <details>
 *  counts: landing opens it, the same as find and a footnote jump. */
export function revealLine(host: HTMLElement, scroller: HTMLElement, line: number): boolean {
  const els: HTMLElement[] = [], ranges: LineRange[] = [];
  for (const el of Array.from(host.querySelectorAll<HTMLElement>("[data-src-line]"))) {
    const r = elRange(el);
    // a block with no box is nowhere to scroll to, unless a closed <details>
    // is all that hides it (a block under the block editor is not one)
    if (r && (el.getClientRects().length || el.closest("details:not([open])"))) { els.push(el); ranges.push(r); }
  }
  if (!els.length) return false;
  const i = blockForLine(ranges, line);
  // trailing blank lines after the last block: land on the last one
  flashTo(scroller, els[i < 0 ? els.length - 1 : i]);
  return true;
}

export function GoToLineBar({ inputRef, last, onGo, onClose }: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** the file's last line */
  last: number;
  /** jump; the bar closes after */
  onGo: (line: number) => void;
  /** `refocus`: hand the keyboard back to the preview (Escape, not a blur) */
  onClose: (refocus: boolean) => void;
}) {
  const { t } = useTranslation("panels");
  const [value, setValue] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  return (
    <div
      data-testid="md-goto"
      className="absolute right-4 top-3 z-10 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] py-1 pl-2.5 pr-2 shadow-lg"
    >
      <Hash className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
      <input
        ref={inputRef}
        value={value}
        inputMode="numeric"
        aria-label={t("mdReader.goToLine")}
        placeholder={t("mdReader.goToLine")}
        onChange={(e) => { setValue(e.target.value); setHint(null); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onClose(true); return; }
          if (e.key !== "Enter") return;
          e.preventDefault();
          const n = Number.parseInt(value.trim(), 10);
          if (!Number.isFinite(n) || n < 1) setHint(t("mdReader.goToNaN"));
          else if (n > last) setHint(t("mdReader.goToPastEnd", { last }));
          else onGo(n);
        }}
        onBlur={() => onClose(false)}
        spellCheck={false}
        autoComplete="off"
        className="w-24 bg-transparent font-mono text-[13px] text-[var(--color-fg)] outline-none placeholder:font-sans placeholder:text-[var(--color-fg-faint)]"
      />
      <span className="min-w-[8rem] text-[11.5px] text-[var(--color-fg-faint)]">
        {hint ?? t("mdReader.goToHint", { last })}
      </span>
    </div>
  );
}
