import { describe, it, expect } from "vitest";
import { groupOf, projectSections, sortSectionsActiveFirst, visualProjectOrder } from "@/lib/projectGroups";
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

describe("sortSectionsActiveFirst", () => {
  // The bug this helper exists to prevent: sorting the flat project list and
  // THEN sectioning moves the folder (a group is anchored at its first
  // member's index) and reorders its members. Sorting sections does neither.
  const list = [proj("a", "G"), proj("b"), proj("c", "G")];
  const activeIs = (...ids: string[]) => (id: string) => ids.includes(id);

  it("floats a section whose member has an active task, folder intact", () => {
    const sorted = sortSectionsActiveFirst(projectSections(list), activeIs("c"));
    expect(sorted.map(s => (s.kind === "loose" ? s.p.id : s.name))).toEqual(["G", "b"]);
    // Members keep STORE order: "c" being the active one does not promote it
    // inside its own folder.
    expect((sorted[0] as Extract<typeof sorted[number], { kind: "group" }>).members.map(p => p.id))
      .toEqual(["a", "c"]);
  });

  it("floats a loose active project above an idle folder", () => {
    const sorted = sortSectionsActiveFirst(projectSections(list), activeIs("b"));
    expect(sorted.map(s => (s.kind === "loose" ? s.p.id : s.name))).toEqual(["b", "G"]);
  });

  it("is stable: with nothing active, order is untouched", () => {
    const sorted = sortSectionsActiveFirst(projectSections(list), () => false);
    expect(sorted.map(s => (s.kind === "loose" ? s.p.id : s.name))).toEqual(["G", "b"]);
  });

  it("is stable: with everything active, order is untouched", () => {
    const sorted = sortSectionsActiveFirst(projectSections(list), () => true);
    expect(sorted.map(s => (s.kind === "loose" ? s.p.id : s.name))).toEqual(["G", "b"]);
  });

  it("does not mutate the input", () => {
    const sections = projectSections(list);
    const before = sections.map(s => (s.kind === "loose" ? s.p.id : s.name));
    sortSectionsActiveFirst(sections, activeIs("b"));
    expect(sections.map(s => (s.kind === "loose" ? s.p.id : s.name))).toEqual(before);
  });
});

describe("a mixed-case group name keys the same everywhere", () => {
  // The sharing claim the dashboard makes is that it and the sidebar agree on
  // the key for `collapsedGroups` / `groupColors`. Every existing fixture here
  // and in the e2e suite uses an already-uppercase name, so nothing proved the
  // normalization actually reaches the section name.
  it("names the section by the NORMALIZED label, not the stored one", () => {
    const sections = projectSections([proj("a", "Infrastructure"), proj("b", " infrastructure ")]);
    expect(sections).toHaveLength(1);
    const g = sections[0] as Extract<typeof sections[number], { kind: "group" }>;
    expect(g.name).toBe("INFRASTRUCTURE");
    expect(g.members.map(p => p.id)).toEqual(["a", "b"]);
  });

  it("gives two spellings of one group a single section", () => {
    const sections = projectSections([proj("a", "Infra"), proj("b"), proj("c", "INFRA")]);
    expect(sections.map(s => (s.kind === "loose" ? s.p.id : s.name))).toEqual(["INFRA", "b"]);
  });
});

describe("visualProjectOrder with servers", () => {
  it("puts a server's projects after this computer's, together per server", () => {
    const p = (id: string, server?: string) => ({ id, name: id, server } as Project);
    const order = visualProjectOrder([p("a"), p("s1", "box"), p("b"), p("t1", "vps"), p("s2", "box")]).map(x => x.id);
    expect(order).toEqual(["a", "b", "s1", "s2", "t1"]);
  });
});
