import { describe, it, expect } from "vitest";
import { planTaskMove } from "@/lib/taskMove";
import type { Task } from "@/lib/types";

const g = { id: "g" };
const t = (id: string, group?: { id: string }) => ({ id, project_id: "p", name: id, ...(group ? { group } : {}) }) as unknown as Task;
// a, [g: g, g2, g3], b, c
const rows = [t("a"), t("g", g), t("g2", g), t("g3", g), t("b"), t("c")];
const ids = (r: ReturnType<typeof planTaskMove>) => ("ids" in r ? r.ids.join(" ") : `ERR ${r.error}`);

describe("planTaskMove", () => {
  it("moves an ungrouped task to the top and bottom of the project", () => {
    expect(ids(planTaskMove(rows, "c", { edge: "top" }))).toBe("c a g g2 g3 b");
    expect(ids(planTaskMove(rows, "a", { edge: "bottom" }))).toBe("g g2 g3 b c a");
  });

  it("moves before and after another ungrouped task", () => {
    expect(ids(planTaskMove(rows, "c", { before: "b" }))).toBe("a g g2 g3 c b");
    expect(ids(planTaskMove(rows, "a", { after: "c" }))).toBe("g g2 g3 b c a");
  });

  it("treats a target inside a group as the whole block", () => {
    expect(ids(planTaskMove(rows, "c", { before: "g2" }))).toBe("a c g g2 g3 b");
    expect(ids(planTaskMove(rows, "a", { after: "g" }))).toBe("g g2 g3 a b c");
  });

  it("moves a grouped task among its group's members only", () => {
    expect(ids(planTaskMove(rows, "g3", { edge: "top" }))).toBe("a g3 g g2 b c");
    expect(ids(planTaskMove(rows, "g", { edge: "bottom" }))).toBe("a g2 g3 g b c");
    expect(ids(planTaskMove(rows, "g3", { before: "g2" }))).toBe("a g g3 g2 b c");
    expect(ids(planTaskMove(rows, "g2", { before: "b" }))).toMatch(/^ERR .*group --leave/);
  });

  it("refuses itself, a task from elsewhere, and a task it does not hold", () => {
    expect(ids(planTaskMove(rows, "a", { before: "a" }))).toMatch(/itself/);
    expect(ids(planTaskMove(rows, "a", { before: "zzz" }))).toMatch(/same project/);
    expect(ids(planTaskMove(rows, "zzz", { edge: "top" }))).toMatch(/not in this project/);
  });

  it("is a no-op shape when already there", () => {
    expect(ids(planTaskMove(rows, "a", { edge: "top" }))).toBe("a g g2 g3 b c");
  });
});
