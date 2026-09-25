import { describe, it, expect } from "vitest";
import { binaryNotice, classifyEditorLoadError, isUnviewable, tooLargeNotice } from "./editorError";

// The rule this pins: a wrong viewer (binary, or too big to load) is a calm
// notice + OS actions, everything else is a real failure (raw message, red).
// Get it backwards and either a spreadsheet looks like a crash, or a
// permission error offers an "Open in default app" button that fails again.

describe("classifyEditorLoadError", () => {
  it("treats the Rust UTF-8 rejection as binary and replaces the message", () => {
    // The exact string src-tauri/src/lib.rs returns from read_text_file_capped.
    const e = classifyEditorLoadError("file is not valid UTF-8");
    expect(e.kind).toBe("binary");
    expect(e.message).toBe(binaryNotice());
  });

  it("matches loosely enough to survive a reword on the Rust side", () => {
    for (const msg of ["invalid UTF-8", "not VALID utf-8 text", "Error: file is not valid UTF-8"])
      expect(classifyEditorLoadError(msg).kind).toBe("binary");
  });

  it("treats the read cap as a wrong-viewer state too, and names the size", () => {
    const e = classifyEditorLoadError("file too large to preview (4600000 bytes)");
    expect(e.kind).toBe("too-large");
    expect(e.message).toBe("This file is too large for the editor to show (4.6 MB).");
  });

  it("drops the size when Rust could not report an exact one", () => {
    // The grew-mid-read path returns "(>2000000 bytes)", which is a CAP, not
    // a file size, so quoting it back would state something untrue.
    const e = classifyEditorLoadError("file too large to preview (>2000000 bytes)");
    expect(e.kind).toBe("too-large");
    expect(e.message).toBe("This file is too large for the editor to show.");
  });

  it("keeps a genuine failure raw, verbatim", () => {
    const e = classifyEditorLoadError("No such file or directory (os error 2)");
    expect(e.kind).toBe("raw");
    expect(e.message).toBe("No such file or directory (os error 2)");
  });

  it("does not mistake an unrelated error for either notice", () => {
    expect(classifyEditorLoadError("permission denied").kind).toBe("raw");
    expect(classifyEditorLoadError("not a file: /tmp/x").kind).toBe("raw");
    expect(classifyEditorLoadError("open failed: too many open files").kind).toBe("raw");
  });

  it("stringifies whatever the IPC layer rejected with", () => {
    expect(classifyEditorLoadError(new Error("file is not valid UTF-8")).kind).toBe("binary");
    expect(classifyEditorLoadError(new Error("no task")).message).toBe("Error: no task");
  });
});

describe("isUnviewable", () => {
  it("is true for exactly the two kinds that get buttons", () => {
    expect(isUnviewable(classifyEditorLoadError("file is not valid UTF-8"))).toBe(true);
    expect(isUnviewable(classifyEditorLoadError("file too large to preview (9 bytes)"))).toBe(true);
    expect(isUnviewable(classifyEditorLoadError("permission denied"))).toBe(false);
  });
});

describe("tooLargeNotice", () => {
  it("scales the unit and never shows a misleading 0 KB", () => {
    expect(tooLargeNotice(2_000_000)).toContain("2.0 MB");
    expect(tooLargeNotice(1_500_000)).toContain("1.5 MB");
    expect(tooLargeNotice(300_000)).toContain("300 KB");
    expect(tooLargeNotice(12)).toContain("1 KB");
  });
});
