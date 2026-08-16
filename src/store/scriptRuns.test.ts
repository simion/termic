// The run-log store is the one place in the app that appends at output rate:
// a dev server in a Run tab prints for as long as it lives, and every line is
// a store write. These pin the cap and the identity discipline that keeps that
// write cheap — counts and invariants, which is the class that can gate a PR
// (docs/performance.md).

import { describe, expect, it, beforeEach } from "vitest";
import { useScriptRuns } from "./scriptRuns";

const MAX_LINES = 2000;

beforeEach(() => {
  useScriptRuns.setState({ runs: {} });
});

const lines = (taskId = "ws1", kind = "run") =>
  useScriptRuns.getState().runs[`${taskId}::${kind}`]?.lines ?? [];

describe("scriptRuns.appendLine", () => {
  it("appends in order", () => {
    const { start, appendLine } = useScriptRuns.getState();
    start("ws1", "run");
    appendLine("ws1", "run", "a");
    appendLine("ws1", "run", "b");
    expect(lines()).toEqual(["a", "b"]);
  });

  it("caps at MAX_LINES, keeping the TAIL", () => {
    const { start, appendLine } = useScriptRuns.getState();
    start("ws1", "run");
    for (let i = 0; i < MAX_LINES + 500; i++) appendLine("ws1", "run", `line-${i}`);

    const out = lines();
    expect(out).toHaveLength(MAX_LINES);
    // The newest line is last and the oldest 500 are gone — a dev server's
    // recent output is the part anyone wants.
    expect(out[out.length - 1]).toBe(`line-${MAX_LINES + 499}`);
    expect(out[0]).toBe(`line-${500}`);
  });

  it("holds exactly at the boundary", () => {
    const { start, appendLine } = useScriptRuns.getState();
    start("ws1", "run");
    for (let i = 0; i < MAX_LINES; i++) appendLine("ws1", "run", `l${i}`);
    expect(lines()).toHaveLength(MAX_LINES);
    expect(lines()[0]).toBe("l0");

    appendLine("ws1", "run", "one-more");
    expect(lines()).toHaveLength(MAX_LINES);
    expect(lines()[0]).toBe("l1");
    expect(lines()[MAX_LINES - 1]).toBe("one-more");
  });

  it("allocates ONE new array per line, and leaves other runs' arrays alone", () => {
    const { start, appendLine } = useScriptRuns.getState();
    start("ws1", "run");
    start("ws2", "run");
    for (let i = 0; i < MAX_LINES; i++) appendLine("ws1", "run", `l${i}`);

    const otherBefore = useScriptRuns.getState().runs["ws2::run"].lines;
    const before = lines();
    appendLine("ws1", "run", "next");
    const after = lines();

    // A new array (immutability is what React subscribers key on)...
    expect(after).not.toBe(before);
    // ...but the untouched run keeps its identity, so its subscribers do not
    // re-render because a different task's dev server printed.
    expect(useScriptRuns.getState().runs["ws2::run"].lines).toBe(otherBefore);
  });

  it("does not mutate the array it replaces", () => {
    const { start, appendLine } = useScriptRuns.getState();
    start("ws1", "run");
    appendLine("ws1", "run", "a");
    const snapshot = lines();
    const copy = [...snapshot];

    appendLine("ws1", "run", "b");

    // slice-then-push must build a NEW array; pushing onto the live one would
    // mutate a snapshot React may still be rendering from.
    expect(snapshot).toEqual(copy);
  });
});
