import { describe, it, expect } from "vitest";
import { groupOf, projectSections, visualProjectOrder } from "@/lib/projectGroups";
import type { Project } from "@/lib/types";

// Only id/name/group matter to the helpers; keep fixtures terse.
const proj = (id: string, group?: string): Project =>
  ({ id, name: id, group } as Project);

describe("groupOf", () => {
  it("returns \"\" for a missing or whitespace-only label", () => {
    expect(groupOf(proj("a"))).toBe("");
    expect(groupOf(proj("a", ""))).toBe("");
    expect(groupOf(proj("a", "   "))).toBe("");
  });

  it("trims and uppercases (THE normalization point)", () => {
    expect(groupOf(proj("a", "  backend "))).toBe("BACKEND");
    expect(groupOf(proj("a", "Frontend"))).toBe("FRONTEND");
  });

  it("converges mixed-case labels onto one key", () => {
    expect(groupOf(proj("a", "frontend"))).toBe(groupOf(proj("b", "FRONTEND")));
  });
});

describe("projectSections", () => {
  it("keeps ungrouped projects loose, in place", () => {
    const sections = projectSections([proj("a"), proj("b")]);
    expect(sections).toEqual([
      { kind: "loose", p: proj("a") },
      { kind: "loose", p: proj("b") },
    ]);
  });

  it("renders a group ONCE, at its first member's position, members in array order", () => {
    const a = proj("a"), g1 = proj("g1", "G"), b = proj("b"), g2 = proj("g2", "G");
    const sections = projectSections([a, g1, b, g2]);
    expect(sections).toEqual([
      { kind: "loose", p: a },
      { kind: "group", name: "G", members: [g1, g2] },
      { kind: "loose", p: b },
    ]);
  });

  it("merges differently-cased / untrimmed labels into one section", () => {
    const g1 = proj("g1", "backend"), g2 = proj("g2", " BACKEND ");
    const sections = projectSections([g1, g2]);
    expect(sections).toEqual([
      { kind: "group", name: "BACKEND", members: [g1, g2] },
    ]);
  });

  it("keeps distinct groups distinct", () => {
    const a = proj("a", "ONE"), b = proj("b", "TWO");
    const sections = projectSections([a, b]);
    expect(sections.map(s => s.kind === "group" && s.name)).toEqual(["ONE", "TWO"]);
  });
});

describe("visualProjectOrder", () => {
  it("flattens sections: group members pulled together at the group's position", () => {
    const a = proj("a"), g1 = proj("g1", "G"), b = proj("b"), g2 = proj("g2", "G");
    expect(visualProjectOrder([a, g1, b, g2]).map(p => p.id))
      .toEqual(["a", "g1", "g2", "b"]);
  });

  it("is the identity for a group-free list", () => {
    const list = [proj("a"), proj("b"), proj("c")];
    expect(visualProjectOrder(list)).toEqual(list);
  });
});
