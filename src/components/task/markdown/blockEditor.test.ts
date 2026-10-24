// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { claim, renderDoc } from "@/lib/markdown/engine";
import { applyDocEdit, type DocEdit, type PreviewEditTarget } from "@/lib/markdown/edit";
import { editableBlock, useBlockEditor } from "./blockEditor";
import { rebuildWithSlots } from "./previewSlots";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// a sacrificial first line: DOMPurify under happy-dom unwraps the first
// element (see lib/markdown/markdown.test.ts)
const DOC = "x\n\n# Title\n\nSome *text*\nwrapped.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";

function renderInto(host: HTMLElement, text: string): void {
  host.innerHTML = renderDoc(text).html;
  claim(host);
}

describe("editableBlock", () => {
  const host = document.createElement("div");
  renderInto(host, DOC);
  const at = (sel: string) => editableBlock(host.querySelector(sel)!, host);

  it("is the innermost stamped block, and the table for anything in one", () => {
    expect(at("em")?.tagName).toBe("P");
    expect(at("li")?.textContent).toBe("one");
    expect(at("td")?.tagName).toBe("TABLE");
    expect(at("h1")?.dataset.srcLine).toBe("3");
  });

  it("ignores app UI and things outside the document", () => {
    const slot = document.createElement("div");
    slot.setAttribute("data-tc-slot", "");
    slot.innerHTML = "<p data-src-line='1'>ui</p>";
    host.append(slot);
    expect(editableBlock(slot.querySelector("p")!, host)).toBeNull();
    expect(editableBlock(document.createElement("p"), host)).toBeNull();
    slot.remove();
  });
});

describe("useBlockEditor", () => {
  let root: Root | null = null;
  afterEach(() => { act(() => root?.unmount()); root = null; document.body.replaceChildren(); });

  // a buffer standing in for the editor: applies DocEdits like the real target
  function setup(text = DOC) {
    const buf = { text, edits: [] as DocEdit[] };
    const edit: PreviewEditTarget = {
      canEdit: true,
      apply(e) {
        const r = applyDocEdit(buf.text, e);
        if (!r.ok) return r.reason;
        buf.text = r.text;
        buf.edits.push(e);
        return "applied";
      },
      read: (a, b) => buf.text.split("\n").slice(a - 1, b).join("\n"),
      text: () => buf.text,
      undo() {}, redo() {}, save() {},
    };
    const host = document.createElement("div");
    host.className = "markdown-body";
    document.body.append(host);
    renderInto(host, text);
    const api: { current: ReturnType<typeof useBlockEditor> | null } = { current: null };
    function Harness({ text }: { text: string }) {
      api.current = useBlockEditor({ hostRef: { current: host }, edit, text, focusPane: () => {} });
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(Harness, { text })));
    /** what MarkdownPreview's main effect does on new text */
    const rebuild = (next: string) => {
      act(() => root!.render(createElement(Harness, { text: next })));
      rebuildWithSlots(host, () => renderInto(host, next), () => api.current!.place());
    };
    const editor = () => host.querySelector<HTMLElement>(".tc-block-editor");
    const cm = () => EditorView.findFromDOM(editor()!.querySelector(".cm-editor")!)!;
    const type = (s: string) => cm().dispatch({ changes: { from: 0, to: cm().state.doc.length, insert: s } });
    const button = (label: string) => Array.from(editor()!.querySelectorAll("button")).find(b => b.textContent === label)!;
    const open = (el: Element) => api.current!.open(el as HTMLElement);
    return { buf, host, edit, rebuild, editor, cm, type, button, open, api };
  }

  it("opens on a block's exact source lines, hides the block, and commits a DocEdit", () => {
    const { buf, host, editor, cm, type, button, open } = setup();
    const p = Array.from(host.querySelectorAll("p")).find(el => el.textContent?.startsWith("Some"))!;
    expect(open(p)).toBe(true);
    expect(p.hidden).toBe(true);
    expect(editor()!.nextElementSibling).toBe(p);
    expect(cm().state.doc.toString()).toBe("Some *text*\nwrapped.");
    type("Some *text*\nrewrapped.\n");
    button("Save").click();
    expect(buf.edits).toEqual([{ fromLine: 5, toLine: 6, expect: "Some *text*\nwrapped.", insert: "Some *text*\nrewrapped." }]);
    expect(editor()).toBeNull();
    expect(p.hidden).toBe(false);
  });

  it("cancel writes nothing, and an unchanged save just closes", () => {
    const { buf, host, editor, button, open } = setup();
    open(host.querySelector("li")!);
    button("Cancel").click();
    expect(editor()).toBeNull();
    open(host.querySelector("li")!);
    button("Save").click();
    expect(editor()).toBeNull();
    expect(buf.edits).toEqual([]);
  });

  it("survives a rebuild that shifts its block, and commits at the new lines", () => {
    const { buf, host, rebuild, editor, cm, type, button, open } = setup();
    open(host.querySelectorAll("li")[1] as HTMLElement);
    type("- two, edited");
    // an agent adds two lines above
    buf.text = buf.text.replace("# Title\n", "# Title\n\nintro\n");
    rebuild(buf.text);
    const li = host.querySelectorAll("li")[1] as HTMLElement;
    expect(editor()!.nextElementSibling).toBe(li);
    expect(li.hidden).toBe(true);
    expect(cm().state.doc.toString()).toBe("- two, edited");
    expect(editor()!.textContent).toContain("line 11");
    button("Save").click();
    expect(buf.text).toContain("- one\n- two, edited\n");
  });

  it("a block changed underneath keeps the user's text: take theirs, or use mine", () => {
    const { buf, host, rebuild, editor, cm, type, button, open } = setup();
    open(host.querySelector("h1")!);
    type("# Mine");
    buf.text = buf.text.replace("# Title", "# Theirs");
    rebuild(buf.text);
    const bar = editor()!.querySelector<HTMLElement>(".tc-block-editor-conflict")!;
    expect(bar.hidden).toBe(false);
    expect(cm().state.doc.toString()).toBe("# Mine");
    // a plain save is refused: the lines are not what the editor opened on
    button("Save").click();
    expect(buf.text).toContain("# Theirs");
    expect(editor()).not.toBeNull();
    button("Use mine").click();
    expect(buf.text).toContain("# Mine\n");
    expect(editor()).toBeNull();
  });

  it("take theirs discards the editor's text", () => {
    const { buf, host, editor, type, button, open } = setup();
    open(host.querySelector("h1")!);
    type("# Mine");
    buf.text = buf.text.replace("# Title", "# Theirs");
    button("Save").click();
    button("Take theirs").click();
    expect(editor()).toBeNull();
    expect(buf.text).toContain("# Theirs");
  });

  it("does not open without a write path", () => {
    const { host, edit, open } = setup();
    edit.canEdit = false;
    expect(open(host.querySelector("h1")!)).toBe(false);
  });

  it("a change that reaches past the block loses it: nothing is written, Use mine copies", () => {
    const { buf, host, rebuild, editor, type, button, open } = setup();
    open(host.querySelector("h1")!);
    type("# Mine");
    // the agent adds a line above AND rewrites the heading: the old line
    // numbers now hold something else, so writing there would clobber it
    buf.text = buf.text.replace("x\n\n# Title\n", "x\n\nnew intro\n\n# Theirs\n");
    const before = buf.text;
    rebuild(buf.text);
    expect(editor()!.querySelector<HTMLElement>(".tc-block-editor-conflict")!.hidden).toBe(false);
    expect(button("Copy mine")).toBeTruthy();
    expect(button("Use mine")).toBeUndefined();
    button("Save").click();
    button("Copy mine").click();
    expect(buf.text).toBe(before);
    expect(buf.edits).toEqual([]);
    expect(editor()).toBeNull();
  });

  it("a block whose lines grew is replaced whole by Use mine, not merged", () => {
    const { buf, host, rebuild, editor, type, button, open } = setup();
    open(Array.from(host.querySelectorAll("p")).find(el => el.textContent?.startsWith("Some"))!);
    type("Mine.");
    // the block's own last line changes and it grows by one
    buf.text = buf.text.replace("wrapped.\n", "wrapped,\nand a third line.\n");
    rebuild(buf.text);
    expect(editor()!.textContent).toContain("lines 5-7");
    button("Use mine").click();
    expect(buf.text).toContain("# Title\n\nMine.\n\n- one");
  });

  it("does not jump to an identical twin when its own block changes", () => {
    const twins = "x\n\n- [ ] Add tests\n- [ ] Add tests\n";
    const { buf, host, rebuild, editor, cm, type, button, open } = setup(twins);
    open(host.querySelectorAll("li")[0]);
    type("- [ ] Add more tests");
    // the agent ticks the item being edited; its twin still reads the same
    buf.text = "x\n\n- [x] Add tests\n- [ ] Add tests\n";
    rebuild(buf.text);
    expect(editor()!.querySelector<HTMLElement>(".tc-block-editor-conflict")!.hidden).toBe(false);
    expect(editor()!.textContent).toContain("line 3");
    button("Save").click();
    expect(buf.text).toBe("x\n\n- [x] Add tests\n- [ ] Add tests\n");
    expect(cm().state.doc.toString()).toBe("- [ ] Add more tests");
  });

  it("follows the live buffer when it is ahead of the rendered copy", () => {
    const { buf, host, cm, type, button, open } = setup();
    open(host.querySelectorAll("li")[1]);
    type("- two, edited");
    // written before the preview's debounce rebuilt: the rendered lines are stale
    buf.text = buf.text.replace("# Title\n", "# Title\n\nintro\n");
    button("Save").click();
    expect(buf.text).toContain("- one\n- two, edited\n");
    expect(cm).toBeTruthy();
  });

  it("an edit just outside the block that reshapes it loses it, with the bar up", () => {
    const { buf, host, rebuild, editor, type, button, open } = setup();
    open(Array.from(host.querySelectorAll("p")).find(el => el.textContent?.startsWith("Some"))!);
    type("Mine.");
    // a lazy continuation line: the block's own lines are untouched, but the
    // paragraph is now 5-7, so there is no paragraph at 5-6 to write over
    buf.text = buf.text.replace("wrapped.\n", "wrapped.\nagent line\n");
    const before = buf.text;
    rebuild(buf.text);
    expect(editor()!.querySelector<HTMLElement>(".tc-block-editor-conflict")!.hidden).toBe(false);
    expect(button("Copy mine")).toBeTruthy();
    button("Save").click();
    expect(buf.text).toBe(before);
  });

  it("an ambiguous deletion between identical blocks loses the block instead of picking one", () => {
    const { buf, host, rebuild, editor, type, button, open } = setup("x\n\n- Same\n- A\n- Same\n");
    open(host.querySelectorAll("li")[0]);
    type("- Mine");
    // the agent deletes the first two items: the survivor is the OTHER Same
    buf.text = "x\n\n- Same\n";
    rebuild(buf.text);
    expect(button("Copy mine")).toBeTruthy();
    button("Save").click();
    expect(buf.text).toBe("x\n\n- Same\n");
    expect(editor()).not.toBeNull();
  });

  it("Use mine pressed while the buffer is ahead of the render runs once the render confirms", () => {
    const { buf, host, rebuild, editor, type, button, open } = setup();
    open(host.querySelector("h1")!);
    type("# Mine");
    buf.text = buf.text.replace("# Title", "# Theirs");
    rebuild(buf.text);
    // another write lands before the preview's debounce re-renders
    buf.text += "\nmore\n";
    button("Use mine").click();
    expect(buf.text).toContain("# Theirs");
    expect(editor()).not.toBeNull();
    rebuild(buf.text);
    expect(buf.text).toContain("# Mine\n");
    expect(editor()).toBeNull();
  });

  it("opens on a double-click, and never on a link", () => {
    const { host, editor, api } = setup("x\n\nSome [link](https://example.com) here\n");
    const p = host.querySelector("p:last-of-type")!;
    const dbl = (target: Element) => act(() => api.current!.onDoubleClick({ target } as unknown as React.MouseEvent));
    dbl(host.querySelector("a")!);
    expect(editor()).toBeNull();
    dbl(p);
    expect(editor()).not.toBeNull();
  });

  it("hides a code block's header with it, and shows it again on close", () => {
    const { host, editor, button, open } = setup("x\n\n```sh\nmake\n```\n");
    const pre = host.querySelector("pre")!;
    const head = document.createElement("div");
    head.className = "md-code-head";
    pre.before(head);
    open(pre);
    expect(pre.hidden && head.hidden).toBe(true);
    expect(editor()!.nextElementSibling).toBe(head);
    button("Cancel").click();
    expect(pre.hidden || head.hidden).toBe(false);
  });
});
