// Reader settings for the rendered preview: text measure, how far wide
// content may break out, type size, font, leading and the line-number mode.
// Every one lands as a CSS variable (plus a mode class) on `.markdown-body`,
// so changing one never re-parses or re-renders the document. The rules that
// read them are the "Markdown reader layout" section of index.css; the why is
// docs/ui.md "Markdown preview".

export type Measure = "narrow" | "readable" | "wide" | "full";
export type WideWidth = "text" | "wide" | "full";
export type ReaderFont = "sans" | "serif" | "mono";
export type Leading = "compact" | "normal" | "relaxed";
export type LineNumbers = "off" | "hover" | "always";

export interface ReaderSettings {
  /** the prose measure */
  measure: Measure;
  /** how far tables, code, diagrams and image-only paragraphs may run */
  wide: WideWidth;
  /** base font size in px */
  size: number;
  font: ReaderFont;
  leading: Leading;
  lineNumbers: LineNumbers;
}

export const READER_DEFAULTS: Readonly<ReaderSettings> = {
  measure: "readable", wide: "full", size: 16, font: "sans", leading: "normal", lineNumbers: "hover",
};

export const READER_SIZE_MIN = 12;
export const READER_SIZE_MAX = 24;

// every value each setting may take, in the order the review menu shows them
export const READER_OPTIONS = {
  measure: ["narrow", "readable", "wide", "full"],
  wide: ["text", "wide", "full"],
  font: ["sans", "serif", "mono"],
  leading: ["compact", "normal", "relaxed"],
  lineNumbers: ["off", "hover", "always"],
} as const satisfies { [K in Exclude<keyof ReaderSettings, "size">]: readonly ReaderSettings[K][] };

const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T =>
  (opts as readonly unknown[]).includes(v) ? v as T : d;

/** Settings from a stored (or synced, or hand-edited) value: an unknown
 *  enum is its default, the size is clamped to 12..24, anything not an
 *  object is the defaults. */
export function parseReaderSettings(raw: unknown): ReaderSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = READER_DEFAULTS, opt = READER_OPTIONS;
  const size = typeof o.size === "number" && Number.isFinite(o.size)
    ? Math.max(READER_SIZE_MIN, Math.min(READER_SIZE_MAX, Math.round(o.size)))
    : d.size;
  return {
    measure: pick(o.measure, opt.measure, d.measure),
    wide: pick(o.wide, opt.wide, d.wide),
    size,
    font: pick(o.font, opt.font, d.font),
    leading: pick(o.leading, opt.leading, d.leading),
    lineNumbers: pick(o.lineNumbers, opt.lineNumbers, d.lineNumbers),
  };
}

export function sameReader(a: ReaderSettings, b: ReaderSettings): boolean {
  return a.measure === b.measure && a.wide === b.wide && a.size === b.size
    && a.font === b.font && a.leading === b.leading && a.lineNumbers === b.lineNumbers;
}

const MEASURE: Record<Measure, string> = { narrow: "60ch", readable: "72ch", wide: "100ch", full: "100%" };
const LEADING: Record<Leading, string> = { compact: "1.4", normal: "1.6", relaxed: "1.8" };
// sans is the base rule's own stack (GitHub's); serif and mono are system faces only
export const READER_FONT: Record<ReaderFont, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
  serif: 'ui-serif, "New York", "Iowan Old Style", Georgia, serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
};

/** The CSS variables for `settings`, ready for a React `style`. */
export function readerStyle(s: ReaderSettings): Record<string, string> {
  const m = MEASURE[s.measure];
  const full = s.measure === "full";
  return {
    "--md-measure": m,
    "--md-measure-min": full ? "100%" : `min(${m}, 100%)`,
    "--md-wide-max": full || s.wide === "full" ? "100%" : s.wide === "text" ? m : `max(${m}, 120ch)`,
    "--md-size": `${s.size}px`,
    "--md-leading": LEADING[s.leading],
    "--md-font": READER_FONT[s.font],
  };
}

/** The mode class the host carries (the gutter padding keys off it). */
export function readerClass(s: ReaderSettings): string {
  return `md-ln-${s.lineNumbers}`;
}
