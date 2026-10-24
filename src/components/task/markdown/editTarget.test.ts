import { describe, it, expect, vi } from "vitest";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { applyDocEdit } from "@/lib/markdown/edit";
import { editChange, editorEditTarget, previewSaveAction, readLines } from "./editTarget";

const lf = (doc: string) => EditorState.create({ doc });
const crlf = (doc: string) => EditorState.create({ doc, extensions: EditorState.lineSeparator.of("\r\n") });
const run = (s: EditorState, e: Parameters<typeof editChange>[1]) => {
  const c = editChange(s, e);
  // sliceDoc joins with the buffer's own separator (doc.toString() is always \n)
  return typeof c === "string" ? c : s.update({ changes: c }).state.sliceDoc();
};

describe("preview edit target line math", () => {
  it("reads 1-based inclusive lines without their separator", () => {
    expect(readLines(lf("a\nb\nc"), 2, 3)).toBe("b\nc");
    expect(readLines(crlf("a\r\nb\r\nc"), 1, 2)).toBe("a\nb");
    expect(readLines(lf("a"), 0, 1)).toBeNull();
    expect(readLines(lf("a\nb"), 2, 3)).toBeNull();
    expect(readLines(lf("a\nb"), 2, 1)).toBeNull();
  });

  it("replaces exactly the lines, and agrees with applyDocEdit", () => {
    const doc = "# T\n\n- [ ] one\n- [ ] two\n";
    const edit = { fromLine: 4, toLine: 4, expect: "- [ ] two", insert: "- [x] two" };
    expect(run(lf(doc), edit)).toBe("# T\n\n- [ ] one\n- [x] two\n");
    const pure = applyDocEdit(doc, edit);
    expect(pure.ok && pure.text).toBe(run(lf(doc), edit));
  });

  it("keeps a CRLF buffer CRLF, including lines the edit adds", () => {
    const s = crlf("a\r\nb\r\nc");
    expect(run(s, { fromLine: 2, toLine: 2, expect: "b", insert: "b1\nb2" })).toBe("a\r\nb1\r\nb2\r\nc");
    expect(applyDocEdit("a\r\nb\r\nc", { fromLine: 2, toLine: 2, expect: "b", insert: "b1\nb2" }))
      .toEqual({ ok: true, text: "a\r\nb1\r\nb2\r\nc" });
  });

  it("refuses when the lines moved, or are not there", () => {
    expect(run(lf("a\nB\nc"), { fromLine: 2, toLine: 2, expect: "b", insert: "x" })).toBe("conflict");
    expect(run(lf("a"), { fromLine: 2, toLine: 2, expect: "", insert: "x" })).toBe("range");
  });

  it("an empty insert leaves one empty line", () => {
    expect(run(lf("a\nb\nc"), { fromLine: 2, toLine: 2, expect: "b", insert: "" })).toBe("a\n\nc");
  });
});

describe("previewSaveAction", () => {
  it("saves only a clean buffer, and only when asked to", () => {
    expect(previewSaveAction(true, false, true)).toBe("save");
    expect(previewSaveAction(true, true, true)).toBe("kept");
    expect(previewSaveAction(false, false, true)).toBe("unsaved");
    expect(previewSaveAction(true, false, false)).toBe("none");
  });
});

describe("editorEditTarget undo / redo", () => {
  // enough of an EditorView for apply and the history commands
  function target(dirty = false, canEdit = true) {
    const v = {
      state: EditorState.create({ doc: "- [ ] a\n", extensions: history() }),
      dispatch(t: Transaction | TransactionSpec) { v.state = (t instanceof Transaction ? t : v.state.update(t)).state; },
    };
    const onApplied = vi.fn();
    const t = editorEditTarget(v as unknown as EditorView, { canEdit, isDirty: () => dirty, onApplied, save: () => {} });
    return { v, t, onApplied };
  }

  it("goes through the save policy like an edit, so an auto-saved tick is unticked on disk too", () => {
    const { v, t, onApplied } = target();
    t.apply({ fromLine: 1, toLine: 1, expect: "- [ ] a", insert: "- [x] a" });
    t.undo();
    expect(v.state.doc.toString()).toBe("- [ ] a\n");
    expect(onApplied).toHaveBeenCalledTimes(2);
    expect(onApplied.mock.calls[1][1]).toBe(false);
    t.redo();
    expect(v.state.doc.toString()).toBe("- [x] a\n");
    expect(onApplied).toHaveBeenCalledTimes(3);
  });

  it("reports nothing when there is nothing to undo, or no write path", () => {
    const a = target();
    a.t.undo();
    expect(a.onApplied).not.toHaveBeenCalled();
    const b = target(false, false);
    b.t.undo();
    expect(b.onApplied).not.toHaveBeenCalled();
  });
});
