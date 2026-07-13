// Sidebar project-group helpers. Groups are UI-only: a label on Project;
// a group exists iff at least one project carries it. Shared between the
// Sidebar (rendering + drag) and useShortcuts (keyboard nav must walk the
// same visual order the sidebar renders).

import type { Project } from "./types";

/** Normalized group label; "" = ungrouped. The single normalization point —
 *  every group comparison must go through this so an untrimmed or
 *  differently-cased label on disk can't split one visual group into two
 *  keys. Group names are ALL-CAPS by design (the rename input enforces it
 *  at entry; this read-side uppercase converges any legacy mixed-case
 *  label written before that rule). */
export const groupOf = (p: Project): string => (p.group ?? "").trim().toUpperCase();

export type ProjectSection =
  | { kind: "loose"; p: Project }
  | { kind: "group"; name: string; members: Project[] };

/** Section the given (already-filtered) project list in visual order:
 *  ungrouped projects render in place; a group renders as ONE section at
 *  its first member's position, members in array order. */
export function projectSections(list: Project[]): ProjectSection[] {
  const sections: ProjectSection[] = [];
  const groupAt = new Map<string, number>();
  for (const p of list) {
    const g = groupOf(p);
    if (!g) { sections.push({ kind: "loose", p }); continue; }
    const at = groupAt.get(g);
    if (at === undefined) {
      groupAt.set(g, sections.length);
      sections.push({ kind: "group", name: g, members: [p] });
    } else {
      (sections[at] as Extract<ProjectSection, { kind: "group" }>).members.push(p);
    }
  }
  return sections;
}

/** Flat project list in the ORDER the sidebar renders them (group members
 *  pulled together at the group's position). */
export const visualProjectOrder = (list: Project[]): Project[] =>
  projectSections(list).flatMap(s => (s.kind === "loose" ? [s.p] : s.members));
