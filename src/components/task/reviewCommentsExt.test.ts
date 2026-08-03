// @vitest-environment happy-dom
//
// GH #157: the gutter drifted out of step with the code, ~12px per review
// comment, cumulative. CodeMirror fills its height map from each block widget's
// BORDER BOX, so vertical margin on the element `toDOM` returns is space it
// never counts, and a widget that grows after being measured goes stale.
//
// No layout engine here, so these pin the structure that makes the geometry
// correct, not the geometry: the measured element keeps the card's spacing
// inside itself, and a growing composer re-syncs the height map. Real pixel
// alignment is the "review comment alignment" case in e2e/specs/git.e2e.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { reviewCommentsExtension, dispatchFileComment } from "./reviewCommentsExt";
import { useReviewComments } from "@/store/reviewComments";

const TASK = "task-157";
const FILE = "src/thing.ts";
const DOC = "one\ntwo\nthree\nfour\nfive\n";

let views: EditorView[] = [];

function mount() {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    doc: DOC,
    extensions: [reviewCommentsExtension(TASK, FILE)],
  });
  views.push(view);
  return view;
}

/** storeSyncPlugin seeds on a microtask, and widgets mount on the next tick. */
const settle = () => new Promise(r => setTimeout(r, 0));

function addComment(line: number, body: string) {
  return useReviewComments.getState().add({
    taskId: TASK, file: FILE, startLine: line, endLine: line, quote: "x", body,
  });
}

/** The element CodeMirror measures for a widget: the shell we mounted it in. */
const measuredBox = (inner: Element) => inner.parentElement!;

/** happy-dom leaves unset lengths as "", which is 0 for our purposes. */
const px = (v: string) => parseFloat(v) || 0;

/**
 * Does this element hold a child's vertical margin inside its border box? We
 * use `flow-root`, but padding or any other block formatting context works too,
 * so assert the property rather than the implementation.
 */
function containsChildMargins(el: Element): boolean {
  const s = getComputedStyle(el);
  return ["flow-root", "flex", "grid", "table", "inline-block"].includes(s.display)
    || (s.overflow !== "" && s.overflow !== "visible")
    || px(s.paddingTop) > 0;
}

/** The invariant the gutter depends on, asserted on the element CM measures. */
function expectMeasuredBox(inner: Element, view: EditorView) {
  const box = measuredBox(inner);
  expect(box, "widget is not wrapped in a shell").not.toBe(view.contentDOM);
  expect(containsChildMargins(box), `${box.firstElementChild?.className} shell is not a BFC`).toBe(true);
  expect({ top: px(getComputedStyle(box).marginTop), bottom: px(getComputedStyle(box).marginBottom) })
    .toEqual({ top: 0, bottom: 0 });
}

beforeEach(() => {
  useReviewComments.getState().clear(TASK);
});

afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("review comment block widgets", () => {
  it("mounts a comment card in a measured box that owns its spacing", async () => {
    addComment(2, "look at this");
    const view = mount();
    await settle();

    const card = view.contentDOM.querySelector(".tc-comment-card");
    expect(card).toBeTruthy();
    expectMeasuredBox(card!, view);

    // Guards against passing vacuously: if the spacing were simply deleted, a
    // zero-margin measured box would prove nothing. The margin must still exist,
    // just contained.
    const s = getComputedStyle(card!);
    expect(px(s.marginTop)).toBeGreaterThan(0);
    expect(px(s.marginBottom)).toBeGreaterThan(0);
  });

  it("mounts the composer the same way", async () => {
    const view = mount();
    await settle();
    dispatchFileComment(view);
    await settle();

    const composer = view.contentDOM.querySelector(".tc-comment-composer");
    expect(composer).toBeTruthy();
    expectMeasuredBox(composer!, view);
  });

  it("holds for every block widget once several comments stack up", async () => {
    // The reported case: drift was invisible at one comment and obvious at
    // three, so assert the invariant across all of them at once.
    addComment(1, "a");
    addComment(3, "b");
    addComment(5, "c");
    const view = mount();
    await settle();
    dispatchFileComment(view);
    await settle();

    expect(view.contentDOM.querySelectorAll(".tc-comment-card")).toHaveLength(3);

    // Anything in the content column that is not a line is a block widget, so
    // this also catches a NEW widget added later without a shell.
    const blocks = Array.from(view.contentDOM.children).filter(el => !el.classList.contains("cm-line"));
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const b of blocks) expectMeasuredBox(b.firstElementChild!, view);
  });

  it("re-measures when the composer's textarea grows", async () => {
    // The other half of the fix: the textarea auto-grows past the height
    // CodeMirror measured on mount, which leaves a stale height in the map.
    const view = mount();
    await settle();
    dispatchFileComment(view);
    await settle(); // mount's own autoGrow has run by here

    const ta = view.contentDOM.querySelector<HTMLTextAreaElement>(".tc-comment-textarea")!;
    const requestMeasure = vi.spyOn(view, "requestMeasure");

    ta.value = "one\ntwo\nthree";
    ta.dispatchEvent(new Event("input"));

    expect(requestMeasure).toHaveBeenCalled();
  });
});
