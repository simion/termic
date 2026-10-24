// The markdown preview toolbar's review menu (`Aa`) and outline toggle. Every
// control writes a global pref (store/prefs: markdownReader, markdownOutline,
// markdownSavePreviewEdits), so it applies to every markdown preview at once,
// the diff view's included. Reader settings land as CSS variables on the
// preview, so a change restyles without re-rendering the document. See
// docs/ui.md "Review menu".
//
// Font size has no ⌘+ / ⌘- / ⌘0 of its own: those are the app's zoom
// (shortcuts `zoom-in` / `zoom-out` / `zoom-reset`). The stepper is the way.

import { useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ListTree, Minus, Plus } from "lucide-react";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/Popover";
import { usePrefs } from "@/store/prefs";
import {
  READER_DEFAULTS, READER_FONT, READER_OPTIONS, READER_SIZE_MAX, READER_SIZE_MIN, type ReaderSettings,
} from "@/lib/markdown/reader";
import { cn } from "@/lib/utils";

const toolbarBtn = cn(
  "inline-flex h-6 items-center rounded px-2 text-[12px] font-medium",
  "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
  "disabled:pointer-events-none disabled:opacity-35",
  "data-[on=true]:bg-[var(--color-bg-3)] data-[on=true]:text-[var(--color-fg)]",
);

/** Whether the outline shows in this view, and its setter: split view has a
 *  switch of its own (off by default), preview-only the other. */
export function useOutline(split: boolean): [boolean, (v: boolean) => void] {
  const on = usePrefs(s => split ? s.markdownOutlineSplit : s.markdownOutline);
  const p = usePrefs.getState;
  return [on, v => split ? p().setMarkdownOutlineSplit(v) : p().setMarkdownOutline(v)];
}

/** The toolbar's outline button: the same pref as the menu's switch. */
export function OutlineToggle({ disabled, split }: { disabled: boolean; split: boolean }) {
  const { t } = useTranslation("panels");
  const [on, setOn] = useOutline(split);
  return (
    <button
      type="button"
      data-testid="md-outline-toggle"
      data-on={on && !disabled}
      aria-pressed={on}
      disabled={disabled}
      title={t("mdReview.outline")}
      aria-label={t("mdReview.toggleOutline")}
      onClick={() => setOn(!on)}
      className={toolbarBtn}
    ><ListTree className="h-3.5 w-3.5" /></button>
  );
}

type Opt<T extends string> = { v: T; label: string; style?: CSSProperties };

/** A segmented control: one radio per value. */
function Seg<T extends string>({ id, label, value, options, onChange }: {
  id: string; label: string; value: T; options: readonly Opt<T>[]; onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-[5px] border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-0.5">
      {options.map(o => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          data-testid={`md-review-${id}-${o.v}`}
          onClick={() => onChange(o.v)}
          style={o.style}
          className={cn(
            "h-[22px] flex-1 rounded-[3px] px-1 text-[11.5px]",
            value === o.v
              ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]"
              : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
          )}
        >{o.label}</button>
      ))}
    </div>
  );
}

function Switch({ id, label, value, onChange }: { id: string; label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      data-testid={`md-review-${id}`}
      onClick={() => onChange(!value)}
      className={cn(
        "relative h-[17px] w-[30px] justify-self-start rounded-full",
        value ? "bg-[var(--color-accent-deep)]" : "bg-[var(--color-bg-3)]",
      )}
    >
      <span
        className={cn(
          "absolute left-[2px] top-[2px] h-[13px] w-[13px] rounded-full transition-transform",
          value ? "translate-x-[13px] bg-[var(--color-accent-fg)]" : "bg-[var(--color-fg)]",
        )}
      />
    </button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="my-[7px] grid grid-cols-[98px_1fr] items-center gap-2">
      <span className="text-[var(--color-fg-dim)]">{label}</span>
      {children}
    </div>
  );
}

const Hint = ({ children }: { children: ReactNode }) => (
  <div className="-mt-0.5 mb-1.5 ml-[106px] text-[11.5px] leading-[1.4] text-[var(--color-fg-faint)]">{children}</div>
);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-[var(--color-border-soft)] pb-1.5 pt-2 first:border-t-0">
      <div className="mb-1 text-[10.5px] uppercase tracking-[0.08em] text-[var(--color-fg-faint)]">{title}</div>
      {children}
    </div>
  );
}

/** The `Aa` button and its popover. Disabled in Editor-only view. */
export function ReviewMenu({ disabled, split }: { disabled: boolean; split: boolean }) {
  const { t } = useTranslation("panels");
  const r = usePrefs(s => s.markdownReader);
  const [outline, setOutline] = useOutline(split);
  const save = usePrefs(s => s.markdownSavePreviewEdits);
  const [open, setOpen] = useState(false);
  const prefs = usePrefs.getState;
  const set = <K extends keyof ReaderSettings>(k: K) => (v: ReaderSettings[K]) => prefs().setMarkdownReader({ [k]: v });
  const opts = <T extends string>(vals: readonly T[], label: (v: T) => string, style?: (v: T) => CSSProperties): Opt<T>[] =>
    vals.map(v => ({ v, label: label(v), style: style?.(v) }));
  const measureLabel = { narrow: t("mdReview.narrow"), readable: t("mdReview.readable"), wide: t("mdReview.wide"), full: t("mdReview.full") };
  const wideLabel = { text: t("mdReview.wideText"), wide: t("mdReview.wideWide"), full: t("mdReview.wideFull") };
  const fontLabel = { sans: t("mdReview.sans"), serif: t("mdReview.serif"), mono: t("mdReview.mono") };
  const leadingLabel = { compact: t("mdReview.compact"), normal: t("mdReview.normal"), relaxed: t("mdReview.relaxed") };
  const lnLabel = { off: t("mdReview.lnOff"), hover: t("mdReview.lnHover"), always: t("mdReview.lnAlways") };
  const stepBtn = "flex h-6 w-[26px] items-center justify-center rounded border border-[var(--color-border-soft)] bg-[var(--color-bg)] text-[var(--color-fg)] disabled:opacity-40";
  const reset = () => {
    prefs().setMarkdownReader(READER_DEFAULTS);
    prefs().setMarkdownOutline(false);
    prefs().setMarkdownOutlineSplit(false);
    prefs().setMarkdownSavePreviewEdits(true);
  };

  return (
    <PopoverRoot open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="md-review-menu"
          disabled={disabled}
          title={t("mdReview.settings")}
          aria-label={t("mdReview.settings")}
          // a serif glyph, so the button reads as "type"
          style={{ fontFamily: READER_FONT.serif }}
          className={cn(toolbarBtn, "px-[9px] text-[13.5px] font-semibold tracking-[0.02em] data-[state=open]:bg-[var(--color-bg-3)] data-[state=open]:text-[var(--color-fg)]")}
        >Aa</button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={4} className="w-[318px] rounded-lg px-3 pb-2.5 pt-1 text-[12.5px]">
        <div data-testid="md-review-panel" role="group" aria-label={t("mdReview.settings")}>
          <Section title={t("mdReview.layout")}>
            <Row label={t("mdReview.textWidth")}>
              <Seg id="measure" label={t("mdReview.textWidth")} value={r.measure}
                options={opts(READER_OPTIONS.measure, v => measureLabel[v])} onChange={set("measure")} />
            </Row>
            <Row label={t("mdReview.wideContent")}>
              <Seg id="wide" label={t("mdReview.wideContentLabel")} value={r.wide}
                options={opts(READER_OPTIONS.wide, v => wideLabel[v])} onChange={set("wide")} />
            </Row>
            <Hint>{t("mdReview.wideHint")}</Hint>
          </Section>
          <Section title={t("mdReview.type")}>
            <Row label={t("mdReview.size")}>
              <div className="flex items-center gap-1.5">
                <button type="button" data-testid="md-review-size-down" aria-label={t("mdReview.smaller")} className={stepBtn}
                  disabled={r.size <= READER_SIZE_MIN} onClick={() => set("size")(r.size - 1)}><Minus className="h-3 w-3" /></button>
                <output data-testid="md-review-size" className="min-w-[44px] text-center font-mono text-[12px] tabular-nums">{r.size}px</output>
                <button type="button" data-testid="md-review-size-up" aria-label={t("mdReview.larger")} className={stepBtn}
                  disabled={r.size >= READER_SIZE_MAX} onClick={() => set("size")(r.size + 1)}><Plus className="h-3 w-3" /></button>
              </div>
            </Row>
            <Row label={t("mdReview.font")}>
              <Seg id="font" label={t("mdReview.font")} value={r.font}
                options={opts(READER_OPTIONS.font, v => fontLabel[v], v => ({ fontFamily: READER_FONT[v] }))} onChange={set("font")} />
            </Row>
            <Row label={t("mdReview.leading")}>
              <Seg id="leading" label={t("mdReview.leading")} value={r.leading}
                options={opts(READER_OPTIONS.leading, v => leadingLabel[v])} onChange={set("leading")} />
            </Row>
          </Section>
          <Section title={t("mdReview.review")}>
            <Row label={t("mdReview.lineNumbers")}>
              <Seg id="ln" label={t("mdReview.lineNumbers")} value={r.lineNumbers}
                options={opts(READER_OPTIONS.lineNumbers, v => lnLabel[v])} onChange={set("lineNumbers")} />
            </Row>
            <Row label={t("mdReview.outline")}>
              <Switch id="outline" label={t("mdReview.outline")} value={outline} onChange={setOutline} />
            </Row>
            <Row label={t("mdReview.saveEdits")}>
              <Switch id="save" label={t("mdReview.saveEdits")} value={save} onChange={v => prefs().setMarkdownSavePreviewEdits(v)} />
            </Row>
            <Hint>{t("mdReview.saveHint")}</Hint>
          </Section>
          <div className="flex items-center justify-between border-t border-[var(--color-border-soft)] pt-2 text-[11.5px] text-[var(--color-fg-faint)]">
            <span>{t("mdReview.applies")}</span>
            <button type="button" data-testid="md-review-reset" onClick={reset}
              className="rounded px-0.5 py-0.5 text-[12px] text-[var(--color-accent)] hover:underline">{t("mdReview.reset")}</button>
          </div>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
