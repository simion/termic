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
export const visualProjectOrder = (list: Project[]): Project[] => {
  // A server's projects draw under it in SERVERS, after this computer's.
  // shortcut: servers in order of their first project, while the sidebar
  // draws them in the remote store's order; upgrade if they ever disagree.
  const local = projectSections(list.filter(p => !p.server)).flatMap(s => (s.kind === "loose" ? [s.p] : s.members));
  const servers = [...new Set(list.filter(p => p.server).map(p => p.server!))];
  return [...local, ...servers.flatMap(id => list.filter(p => p.server === id))];
};

/** Section list ordered so any section holding an active task floats to the
 *  top, sections keeping their relative order otherwise (Array.sort is stable).
 *
 *  Section AFTER sorting, never before. The dashboard has floated projects with
 *  live tasks to the top since the project list learned to scroll, and sorting
 *  the flat project list first would interleave that rule with the sectioning
 *  one: a group is anchored at its FIRST member's index, so moving members
 *  around moves the folder and reorders it internally. With store order
 *  `A(group G, idle), B(loose, active), C(group G, active)`, sorting first
 *  gives `[B, G{C, A}]` where the sidebar renders `[G{A, C}, B]` — the folder
 *  lands in a different place AND its members swap. Sorting whole sections
 *  keeps a folder intact and keeps its members in the order every other
 *  surface shows them. */
export function sortSectionsActiveFirst(
  sections: ProjectSection[],
  isActive: (projectId: string) => boolean,
): ProjectSection[] {
  const active = (s: ProjectSection): boolean =>
    s.kind === "loose" ? isActive(s.p.id) : s.members.some(p => isActive(p.id));
  return [...sections].sort((a, b) => Number(active(b)) - Number(active(a)));
}
