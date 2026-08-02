import { describe, it, expect } from "vitest";
import { keepsDisplayWhenHidden, previewKindForPath, taskPdfSrc } from "@/lib/previewPaths";

describe("previewKindForPath", () => {
  it("routes image extensions to \"image\"", () => {
    expect(previewKindForPath("shot.png")).toBe("image");
    expect(previewKindForPath("nested/dir/photo.JPG")).toBe("image");
    expect(previewKindForPath("icon.svg")).toBe("image");
  });

  it("routes .pdf to \"pdf\"", () => {
    expect(previewKindForPath("doc.pdf")).toBe("pdf");
    expect(previewKindForPath("Report.PDF")).toBe("pdf");
  });

  it("returns null for non-previewable and extension-less files", () => {
    expect(previewKindForPath("main.ts")).toBeNull();
    expect(previewKindForPath("README.md")).toBeNull();
    expect(previewKindForPath("Makefile")).toBeNull();
  });
});

describe("keepsDisplayWhenHidden", () => {
  it("exempts a PDF edit tab from display:none", () => {
    expect(keepsDisplayWhenHidden({ type: "edit", path: "docs/report.pdf" })).toBe(true);
  });

  it("does not exempt anything else", () => {
    // Terminals are the whole reason display:none is load-bearing.
    expect(keepsDisplayWhenHidden({ type: "terminal" })).toBe(false);
    // An <img> has no native state to lose.
    expect(keepsDisplayWhenHidden({ type: "edit", path: "shot.png" })).toBe(false);
    expect(keepsDisplayWhenHidden({ type: "edit", path: "src/main.ts" })).toBe(false);
    // A diff of a PDF renders text through DiffPane, not the native embed.
    expect(keepsDisplayWhenHidden({ type: "diff", path: "docs/report.pdf" })).toBe(false);
    expect(keepsDisplayWhenHidden({ type: "edit" })).toBe(false);
  });
});

describe("taskPdfSrc", () => {
  it("changes only when the fingerprint changes", () => {
    const a = taskPdfSrc("task-1", "docs/report.pdf", "1700:900");
    expect(taskPdfSrc("task-1", "docs/report.pdf", "1700:900")).toBe(a);
    expect(taskPdfSrc("task-1", "docs/report.pdf", "1800:912")).not.toBe(a);
  });

  it("encodes the id, the path and the fingerprint", () => {
    const src = taskPdfSrc("task 1/x", "my docs/a b.pdf", "17:9");
    expect(src).toBe("taskpdf://localhost/task%201%2Fx/my%20docs%2Fa%20b.pdf?v=17%3A9");
    // The handler splits on the first '/', so neither segment may contain a
    // raw one.
    expect(src.slice("taskpdf://localhost/".length).split("/")).toHaveLength(2);
  });
});
