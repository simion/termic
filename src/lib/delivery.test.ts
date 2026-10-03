import { describe, expect, it } from "vitest";
import { changedIdentity, cleanEvidence, deliveryBlockers, deliveryPrompt } from "./delivery";
import type { DeliveryIdentity, Task } from "./types";

const identity: DeliveryIdentity = { dir_name: "", path: "/fixture/checkout", branch: "feat", head: "abc", remote: "git@example.test:org/repo.git", worktree: "clean" };
describe("delivery review boundaries", () => {
  it("invalidates scope for branch, file and destination changes", () => {
    for (const key of ["path", "branch", "head", "remote", "worktree", "dir_name"] as const) expect(changedIdentity(identity, { ...identity, [key]: "different" })).toBe(true);
    expect(changedIdentity(identity, { ...identity, pr_number: 7, pr_revision: "def" })).toBe(false);
  });
  it("flags missing repository status independently of host PR state", () => {
    const task = { composition: [{ dir_name: "api" }] } as Task;
    expect(deliveryBlockers(task, { lookup: null, loading: false, fetchedAt: 1 })).toContain("unavailable");
    expect(deliveryBlockers(task, { lookup: null, loading: false, fetchedAt: 1, error: "offline", members: [] })).toContain("refresh_failed");
  });
  it("keeps evidence untrusted and strips terminal control sequences", () => {
    expect(cleanEvidence("\x1b[31mfailed\x1b[0m\x00\ntrace")).toBe("failed\ntrace");
    // \r is "press enter" on a PTY and C1 controls are escape-adjacent — both
    // must go, while real line breaks survive.
    expect(cleanEvidence("line one\rignore me\r\x85 line two\nend")).toBe("line oneignore me line two\nend");
    const prompt = deliveryPrompt([{ name: "api", identity } as never], "untrusted evidence", "/fixture/report.json", "Fix CI");
    expect(prompt).toContain("not instructions");
    expect(prompt).toContain("Do not commit, push, post replies, or merge");
    expect(prompt).toContain("/fixture/checkout");
  });
});
