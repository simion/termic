// The task query behind both filter bars (docs/ui.md "Kanban view" >
// Filtering, and "The sidebar's filter bar"): parse, match, the funnel
// menu's chips with counts, and autocomplete values. The board and the
// sidebar each own their query TEXT (ui store) and their menu state; this
// owns everything they would otherwise copy, so the two menus cannot drift.
//
// It also owns the board COLUMN of every task it matches over, because
// `status:`, the menu's counts, the board's layout and the sidebar's status
// chips all read the same column, and a caller handing one in could hand in
// the wrong one. Columns come from the per-task status facts
// (`createStatusFactsSelector`), which keep their identity through output stamps and
// live titles, so holding them costs a re-render only when a task's
// attention, working or untouched fact flips.
//
// Subscriptions follow the board's rule: nothing is held that the query, the
// open menu or the caller's own column reads (`taskQueryNeeds`) do not read.
// A sidebar with an empty query pays for none of this.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store/app";
import { usePr } from "@/store/pr";
import { useDiffStat } from "@/store/diffStat";
import {
  createBoardFilterFactsSelector,
  createStatusFactsSelector,
  EMPTY_BOARD_FILTER_FACTS,
  EMPTY_STATUS_FACTS,
  type BoardFilterFacts,
  type StatusTabFacts,
} from "@/store/sidebarTabs";
import type { FilterFacetOption, FilterFacetSection } from "@/components/views/BoardFilterBar";
import {
  boardQueryUses,
  boardTaskMatches,
  dropBoardClauses,
  isBoardQueryActive,
  parseBoardQuery,
  setBoardClause,
  type BoardMatchCtx,
  type BoardQualifier,
  type BoardQuery,
} from "@/lib/boardFilter";
import {
  BOARD_STATE_COLUMNS,
  boardColumnFromFacts,
  NO_TAB_FACTS,
  type BoardColumn,
  type BoardStateColumn,
} from "@/lib/taskBoardState";
import { prBadgeAppearance } from "@/lib/prBadgeAppearance";
import { agentDisplayName } from "@/lib/agents";
import { groupOf } from "@/lib/projectGroups";
import { accentCss } from "@/lib/accents";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { cn } from "@/lib/utils";
import type { WorkStatePrefs } from "@/lib/taskWorkState";
import type { Project, Task } from "@/lib/types";

export const COL_LABEL: Record<BoardStateColumn, string> = {
  backlog: "board.colBacklog",
  attention: "board.colAttention",
  working: "board.colWorking",
  review: "board.colReview",
  settled: "board.colSettled",
};

/** The dot / card-edge colour each column wears, all @theme tokens: warn is
 *  the attention bell's colour, accent marks the actively-working agent,
 *  pr-open is the green PR glyph, info is the settled bullet, and backlog is
 *  deliberately neutral (nothing has happened there yet). A card's left edge
 *  repeats its column's colour so the stack scans without reading the
 *  headers. */
export const COL_ACCENT: Record<BoardStateColumn, string> = {
  backlog: "var(--color-fg-faint)",
  attention: "var(--color-warn)",
  working: "var(--color-accent)",
  review: "var(--color-pr-open)",
  settled: "var(--color-info)",
};

/** How often a `has:changes` query asks for its hidden tasks' diffstats.
 *  Each tick measures up to MAX_PER_FLUSH stale ones (DIFF_STALE_MS), so a
 *  big board cycles through in a few ticks and then idles on no-ops. */
const CHANGES_POLL_MS = 2_000;

/** The facts selector a query without free text holds instead: a constant,
 *  so an unfiltered surface subscribes to nothing new. */
const selectNoFilterFacts = (): BoardFilterFacts => EMPTY_BOARD_FILTER_FACTS;
const selectNoStatusFacts = (): StatusTabFacts => EMPTY_STATUS_FACTS;

/** The menu's sections while it is closed: a constant, so the memoized bar
 *  sees no new prop while its surface re-renders. */
const NO_SECTIONS: FilterFacetSection[] = [];
const NO_COLUMNS: ReadonlyMap<string, BoardColumn> = new Map();

/** What a query holds subscriptions for. Pure, so selectorFanout.test.ts can
 *  pin that an empty, closed bar holds none of them. */
export function taskQueryNeeds(query: BoardQuery, menuOpen: boolean, alwaysColumns: boolean) {
  const filtering = isBoardQueryActive(query);
  // The funnel menu counts every facet, `checks:` and `has:changes`
  // included, so while it is open this holds the same subscriptions a query
  // using them would.
  const watching = filtering || menuOpen;
  const columns = alwaysColumns || menuOpen || boardQueryUses(query, "status");
  return {
    filtering,
    watching,
    columns,
    /** PR state moves both `pr:` matches and the review column. */
    pr: watching || columns,
    checks: menuOpen || boardQueryUses(query, "checks"),
    changes: menuOpen || boardQueryUses(query, "has", "changes") || boardQueryUses(query, "no", "changes"),
    freeText: query.terms.length > 0,
  };
}

/** Same entries as `prev`: hand `prev` back, so a facts flip that moves no
 *  card keeps every memo downstream of the map. */
function sameColumns(prev: ReadonlyMap<string, BoardColumn>, next: ReadonlyMap<string, BoardColumn>): boolean {
  if (prev.size !== next.size) return false;
  for (const [id, c] of next) if (prev.get(id) !== c) return false;
  return true;
}

export interface TaskQuery {
  query: BoardQuery;
  /** The parsed query filters something (`project:` mid-typing does not). */
  filtering: boolean;
  matches: (w: Task) => boolean;
  /** The funnel menu's chips; a constant while the menu is closed. */
  sections: FilterFacetSection[];
  valuesFor: (key: BoardQualifier) => readonly string[];
  /** Every matched-over task's board column; empty unless something reads
   *  columns (`status:`, the open menu, or `alwaysColumns`). */
  columnOf: ReadonlyMap<string, BoardColumn>;
  /** Live tasks in `column` that the rest of the query lets through: its
   *  `status:` clauses are dropped, so each status chip answers for its own
   *  column whichever chip is on. Needs columns. */
  columnCount: (column: BoardColumn) => number;
  /** A project's folder accent, for chips and the board's headers. */
  projectAccent: (p: Project | undefined) => string | undefined;
}

export function useTaskQuery({ text, menuOpen, live, archived, workPrefs, alwaysColumns = false, facts }: {
  text: string;
  menuOpen: boolean;
  /** Tasks the surface lists, unarchived, in a project of this profile. */
  live: Task[];
  /** Archived tasks the surface can show; undefined where it shows none,
   *  which also drops the Archived chip. */
  archived?: Task[];
  workPrefs: WorkStatePrefs;
  /** The caller reads `columnOf` itself (the board's layout, the status
   *  chips' counts), so columns are derived whatever the query says. */
  alwaysColumns?: boolean;
  /** Free-text facts the caller already holds (the sidebar's tab facts are
   *  a superset). Undefined: hold the board's own, only while there is free
   *  text. */
  facts?: BoardFilterFacts;
}): TaskQuery {
  const { t } = useTranslation("chrome");
  const projects = useApp(s => s.projects);
  const agents = useApp(s => s.agents);
  const groupColors = useApp(s => s.groupColors);
  const query = useMemo(() => parseBoardQuery(text), [text]);
  const needs = taskQueryNeeds(query, menuOpen, alwaysColumns);
  const { filtering } = needs;
  const usesChanges = needs.changes;

  // Re-run triggers for the non-reactive pr and diffStat reads in matchCtx
  // and the column map. `checks:` folds the check state in only while the
  // query reads it: otherwise every check tick of every PR would re-render
  // the surface.
  const prKey = usePr(s => needs.pr
    ? Object.values(s.byTask).map(e => `${e.lookup?.pr?.state ?? "?"}${needs.checks ? e.lookup?.pr?.checks ?? "" : ""}`).join("|")
    : "");
  const changesKey = useDiffStat(s => usesChanges
    ? Object.entries(s.byTask).map(([id, e]) => `${id}:${e.stat ? e.stat.files_changed > 0 : "?"}`).join("|")
    : "");
  // Free text reads tab titles and property values; the facts record keeps
  // its identity while agents stream (bear trap 5).
  const [selectFilterFacts] = useState(createBoardFilterFactsSelector);
  const ownFacts = useApp(!facts && needs.freeText ? selectFilterFacts : selectNoFilterFacts);
  const filterFacts = facts ?? ownFacts;

  // Columns from the board's own precedence over three facts per task.
  const [selectStatusFacts] = useState(createStatusFactsSelector);
  const statusFacts = useApp(needs.columns ? selectStatusFacts : selectNoStatusFacts);
  const lastColumns = useRef<ReadonlyMap<string, BoardColumn>>(NO_COLUMNS);
  const columnOf = useMemo(() => {
    if (!needs.columns) return NO_COLUMNS;
    const pr = usePr.getState().byTask;
    const map = new Map<string, BoardColumn>();
    for (const w of live) map.set(w.id, boardColumnFromFacts(w, statusFacts[w.id] ?? NO_TAB_FACTS, pr[w.id]?.lookup ?? null, workPrefs));
    for (const w of archived ?? []) map.set(w.id, "archived");
    if (sameColumns(lastColumns.current, map)) return lastColumns.current;
    lastColumns.current = map;
    return map;
    // prKey is the re-run trigger for the non-reactive pr read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needs.columns, live, archived, statusFacts, workPrefs, prKey]);

  const projectById = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  const projectAccent = useCallback((p: Project | undefined): string | undefined => {
    const g = p ? groupOf(p) : null;
    return g ? accentCss(groupColors[g]) : undefined;
  }, [groupColors]);

  const matchCtx = useCallback((w: Task): BoardMatchCtx => {
    const stat = useDiffStat.getState().byTask[w.id]?.stat;
    return {
      project: projectById.get(w.project_id),
      column: columnOf.get(w.id),
      pr: usePr.getState().byTask[w.id]?.lookup ?? null,
      changed: stat ? stat.files_changed > 0 : null,
      facts: filterFacts[w.id],
      agents,
    };
    // prKey / changesKey are the re-run triggers for the non-reactive pr and
    // diffStat reads above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectById, columnOf, filterFacts, agents, prKey, changesKey]);
  const matches = useCallback(
    (w: Task): boolean => boardTaskMatches(w, matchCtx(w), query),
    [matchCtx, query],
  );
  const columnCount = useCallback((column: BoardColumn): number => {
    const rest = dropBoardClauses(query, "status");
    let n = 0;
    for (const w of live) if (columnOf.get(w.id) === column && boardTaskMatches(w, matchCtx(w), rest)) n++;
    return n;
  }, [query, live, columnOf, matchCtx]);

  // `has:changes` on a task nothing drew: cards and rows ask for their own
  // diffstat when they mount, so a task filtered out from the start would
  // stay unmeasured (or, measured once, go stale) and never match. Ask for
  // all of them while the query (or the menu's count) reads it, on a tick:
  // `requestMany` measures at most MAX_PER_FLUSH stale tasks per call, oldest
  // first, so one call on mount left everything past the first batch
  // unmeasured. A fresh task is a no-op, and the timer only exists while
  // a `has:`/`no:changes` clause or the menu does.
  useEffect(() => {
    if (!usesChanges) return;
    const ids = live.map(w => w.id);
    const ask = () => useDiffStat.getState().requestMany(ids);
    ask();
    const timer = setInterval(ask, CHANGES_POLL_MS);
    return () => clearInterval(timer);
  }, [usesChanges, live]);

  // Autocomplete values for the keys with open-ended values, from what is
  // listed right now (a project with no tasks is not a useful pick).
  const valuesFor = useCallback((key: BoardQualifier): readonly string[] => {
    const known = [...live, ...(archived ?? [])];
    switch (key) {
      case "project": return [...new Set(known.flatMap(w => [
        projectById.get(w.project_id)?.name ?? "",
        ...(w.composition ?? []).map(m => m.dir_name),
      ]).filter(Boolean))];
      case "group": return [...new Set(known.map(w => {
        const p = projectById.get(w.project_id);
        return p ? groupOf(p) : "";
      }).filter(Boolean))];
      case "agent": return [...new Set(known.map(w => w.cli))];
      case "branch": return [...new Set(live.map(w => w.branch).filter(Boolean))];
      case "base": return [...new Set(known.map(w => w.base_branch).filter(Boolean))];
      default: return [];
    }
  }, [live, archived, projectById]);

  // The filter menu's chips, built only while the menu is open. Each count
  // is the current query with that chip INCLUDED (`setBoardClause`, the
  // edit the click makes), run through the real matcher, so an off chip
  // reads exactly what clicking it leaves and an included one reads what
  // the surface shows. O(chips x tasks), never while closed.
  const sections = useMemo((): FilterFacetSection[] => {
    if (!menuOpen) return NO_SECTIONS;
    const all = [...live, ...(archived ?? [])];
    const ctxs = new Map(all.map(w => [w.id, matchCtx(w)]));
    const count = (key: BoardQualifier, value: string) => {
      const q = parseBoardQuery(setBoardClause(text, key, value, "include"));
      let n = 0;
      for (const w of all) if (boardTaskMatches(w, ctxs.get(w.id)!, q)) n++;
      return n;
    };
    const opt = (key: BoardQualifier, value: string, label: string, extra: Partial<FilterFacetOption> = {}): FilterFacetOption =>
      ({ key, value, label, count: count(key, value), ...extra });

    const projectByName = new Map<string, Project>();
    for (const p of projects) if (!projectByName.has(p.name)) projectByName.set(p.name, p);
    // the sidebar lists no archived tasks, so it gets no Archived chip
    const statusCols: (BoardStateColumn | "archived")[] = archived ? [...BOARD_STATE_COLUMNS, "archived"] : [...BOARD_STATE_COLUMNS];
    const projectNames = valuesFor("project");
    const groups = valuesFor("group");
    const prStates = ["open", "draft", "merged", "closed"] as const;
    return [
      {
        id: "status",
        title: t("board.filterSecStatus"),
        options: statusCols.map(c => opt("status", c, t(c === "archived" ? "board.colArchived" : COL_LABEL[c]), {
          swatch: c === "archived" ? "var(--color-fg-faint)" : COL_ACCENT[c],
        })),
      },
      {
        id: "project",
        title: t("board.filterSecProject"),
        options: projectNames.map(name => {
          // First project of that name: `project:` is name-based, so two
          // same-named projects are one chip (docs/ui.md).
          const p = projectByName.get(name);
          return opt("project", name, name, { swatch: projectAccent(p) ?? "var(--color-fg-faint)" });
        }),
      },
      { id: "group", title: t("board.filterSecGroup"), options: groups.map(g => opt("group", g, g)) },
      {
        id: "agent",
        title: t("board.filterSecAgent"),
        options: valuesFor("agent").map(cli => opt("agent", cli, agentDisplayName(cli, agents), {
          icon: (
            <span className={cn(CLI_BRAND_COLOR[resolveIconId(cli, agents)] || "text-[var(--color-fg-faint)]")}>
              <CliIcon cli={resolveIconId(cli, agents)} className="h-3 w-3" />
            </span>
          ),
        })),
      },
      {
        id: "pr",
        title: t("board.filterSecPr"),
        options: [
          ...prStates.map(st => opt("pr", st, t(`board.filterPr_${st}`), { swatch: prBadgeAppearance(st, null).color })),
          opt("pr", "none", t("board.filterPr_none")),
        ],
      },
      {
        id: "checks",
        title: t("board.filterSecChecks"),
        options: [
          opt("checks", "passing", t("board.filterChecks_passing"), { swatch: "var(--color-ok)" }),
          opt("checks", "failing", t("board.filterChecks_failing"), { swatch: "var(--color-err)" }),
          opt("checks", "pending", t("board.filterChecks_pending"), { swatch: "var(--color-warn)" }),
        ],
      },
      {
        id: "flags",
        title: t("board.filterSecFlags"),
        options: [
          opt("has", "changes", t("board.filterFlag_changes")),
          opt("is", "worktree", t("board.filterFlag_worktree")),
          opt("is", "main", t("board.filterFlag_main")),
          opt("is", "multi", t("board.filterFlag_multi")),
          opt("is", "sandboxed", t("board.filterFlag_sandboxed")),
          opt("is", "docker", t("board.filterFlag_docker")),
          opt("is", "yolo", t("board.filterFlag_yolo")),
        ],
      },
    ];
  }, [menuOpen, text, live, archived, matchCtx, valuesFor, projects, projectAccent, agents, t]);

  return { query, filtering, matches, sections, valuesFor, columnOf, columnCount, projectAccent };
}
