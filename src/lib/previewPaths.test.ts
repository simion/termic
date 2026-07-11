import { describe, it, expect } from "vitest";
import { previewKindForPath } from "@/lib/previewPaths";

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
