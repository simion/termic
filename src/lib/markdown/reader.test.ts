import { describe, expect, it } from "vitest";
import { parseReaderSettings, READER_DEFAULTS, readerClass, readerStyle, sameReader, type ReaderSettings } from "./reader";

const at = (p: Partial<ReaderSettings>) => readerStyle({ ...READER_DEFAULTS, ...p });

describe("readerStyle", () => {
  it("defaults to a 72ch measure at 16px/1.6, wide content at the full pane", () => {
    const s = readerStyle(READER_DEFAULTS);
    expect(s["--md-measure"]).toBe("72ch");
    expect(s["--md-measure-min"]).toBe("min(72ch, 100%)");
    expect(s["--md-wide-max"]).toBe("100%");
    expect(s["--md-size"]).toBe("16px");
    expect(s["--md-leading"]).toBe("1.6");
    expect(s["--md-font"]).toMatch(/^-apple-system/);
    expect(readerClass(READER_DEFAULTS)).toBe("md-ln-hover");
  });

  it("maps each measure", () => {
    expect(at({ measure: "narrow" })["--md-measure"]).toBe("60ch");
    expect(at({ measure: "wide" })["--md-measure"]).toBe("100ch");
  });

  it("wide content: same as the text, at least 120ch, or the pane", () => {
    expect(at({ wide: "text" })["--md-wide-max"]).toBe("72ch");
    expect(at({ wide: "wide" })["--md-wide-max"]).toBe("max(72ch, 120ch)");
    // a wide text measure is never narrowed by the wide-content cap
    expect(at({ measure: "wide", wide: "wide" })["--md-wide-max"]).toBe("max(100ch, 120ch)");
  });

  it("full text width puts everything at the pane, whatever wide says", () => {
    const s = at({ measure: "full", wide: "text" });
    expect(s["--md-measure"]).toBe("100%");
    expect(s["--md-measure-min"]).toBe("100%");
    expect(s["--md-wide-max"]).toBe("100%");
  });

  it("fonts and leading", () => {
    expect(at({ font: "serif" })["--md-font"]).toMatch(/^ui-serif, "New York"/);
    expect(at({ font: "mono" })["--md-font"]).toMatch(/^ui-monospace/);
    expect(at({ leading: "compact" })["--md-leading"]).toBe("1.4");
    expect(at({ leading: "relaxed" })["--md-leading"]).toBe("1.8");
    expect(at({ size: 19 })["--md-size"]).toBe("19px");
  });
});

describe("parseReaderSettings", () => {
  it("keeps a valid stored value", () => {
    const v: ReaderSettings = { measure: "wide", wide: "text", size: 18, font: "serif", leading: "relaxed", lineNumbers: "always" };
    expect(parseReaderSettings(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });

  it("drops unknown values to their default, one field at a time", () => {
    expect(parseReaderSettings({ measure: "huge", font: "comic", lineNumbers: "always" }))
      .toEqual({ ...READER_DEFAULTS, lineNumbers: "always" });
  });

  it("clamps and rounds the size, and ignores a non-number", () => {
    expect(parseReaderSettings({ size: 3 }).size).toBe(12);
    expect(parseReaderSettings({ size: 99 }).size).toBe(24);
    expect(parseReaderSettings({ size: 17.6 }).size).toBe(18);
    expect(parseReaderSettings({ size: "20" }).size).toBe(16);
    expect(parseReaderSettings({ size: NaN }).size).toBe(16);
  });

  it("anything not an object is the defaults", () => {
    for (const raw of [null, undefined, "x", 4, []]) expect(parseReaderSettings(raw)).toEqual(READER_DEFAULTS);
  });

  it("sameReader compares every field", () => {
    expect(sameReader(READER_DEFAULTS, { ...READER_DEFAULTS })).toBe(true);
    expect(sameReader(READER_DEFAULTS, { ...READER_DEFAULTS, leading: "compact" })).toBe(false);
  });
});
