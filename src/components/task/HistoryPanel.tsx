// Committed history with a commit graph — the Graph section at the foot of
// the right panel's Git tab (issue #199, moved there by GH #208).
//
// The staging half of that tab only ever shows the working tree, so once an
// agent committed, its work vanished from the UI and people left for VS Code
// or Fork to see what had just happened.
//
// Modelled on VS Code's Source Control Graph: one dense row per commit (lanes,
// ref chips, subject, relative time), click a commit to see the files it
// touched, click a file to open its diff. Lane maths lives in lib/gitGraph.ts
// (pure + unit-tested); this file is the rendering and the IPC.
//
// Layout, top to bottom:
//   1. Repo pills   — only when uncontrolled; inside Git, that tab's win.
//   2. Scope row    — likewise: embedded, the picker rides the Graph header.
//   3. Commit rows  — graph gutter, chips, subject, age. Selected row expands
//                     into its meta line + file list.
//   4. Load more    — pages of PAGE_SIZE, appended.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, Tag, Loader2, Copy, Check, ChevronDown } from "lucide-react";
import type { GitCommit, GitFile, GitRef, Task } from "@/lib/types";
import { taskGitLog, taskGitRefs, taskGitCommitFiles, taskGitCommitOffset } from "@/lib/ipc";
import { layoutGraph, graphWidth, type GraphRow } from "@/lib/gitGraph";
import { copyToClipboard } from "@/lib/clipboard";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { splitTrailers } from "@/lib/commitMessage";
import { cn } from "@/lib/utils";
import * as RT from "@radix-ui/react-tooltip";
import { Tip } from "@/components/ui/Tooltip";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuLabel } from "@/components/ui/ContextMenu";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownLabel, DropdownSeparator } from "@/components/ui/Dropdown";
import { fileIconUrl } from "@/lib/explorer/iconResolver";

/** Commits per page. VS Code's graph loads 50 and pages on scroll; a page here
 *  is a bit bigger because the rows are one line and the fetch is one process. */
const PAGE_SIZE = 100;

/** Rows kept above a revealed commit, so it lands in context rather than pinned
 *  to the very top of the list. */
const REVEAL_CONTEXT = 10;

/** Geometry of the lane gutter, in px. Rows are one line tall so a busy day of
 *  agent commits fits on screen without scrolling. */
const ROW_H = 26;
const LANE_W = 12;
const DOT_R = 3.5;
/** Lanes past this are clipped: a 220px panel can't render a 30-wide graph, and
 *  an unbounded gutter would eat the subject column. */
const MAX_LANES = 6;

/** Fold an overflowing column onto the last drawn one, the way VS Code
 *  collapses a graph too wide for its gutter. Dropping those columns instead
 *  is what a clip must never do to a DOT: a commit row with no node reads as
 *  an empty line, and the deeper the graph the more rows lose their marker. */
export function clampLane(lane: number, lanes: number): number {
  return Math.min(Math.max(lane, 0), Math.max(lanes - 1, 0));
}
/** Ref chips shown inline before the subject; the rest collapse into "+N". */
const MAX_CHIPS = 2;
/** Gap between a row's dot and where its text starts. */
const TEXT_GAP = 8;

/** Left inset for a row's text, so a subject starts just past its OWN dot
 *  instead of at one column shared with every row. VS Code's graph reads this
 *  way, and it is what makes a branch's rows visibly belong to it: an indented
 *  run of subjects IS the branch. Clipped lanes fold onto the last drawn one,
 *  exactly as the dot does, so text never parts company with its marker. */
/** Where an expanded commit's detail block starts. Its OWN lane's text
 *  indent, so the files line up under the subject they belong to, not the
 *  full gutter (which is every lane in the graph: on a repo with six of them
 *  that shoved the block 60px right no matter which lane the commit was on,
 *  and pushed the header out of the panel). Capped at two lanes because a
 *  deep lane would eat the width the filenames need. */
export function detailIndent(lane: number, lanes: number): number {
  return Math.min(textIndent(lane, lanes), textIndent(2, Math.max(lanes, 3)));
}

export function textIndent(lane: number, lanes: number): number {
  return clampLane(lane, lanes) * LANE_W + LANE_W / 2 + DOT_R + TEXT_GAP;
}

/** Lane colours. Theme-aware by construction — these are the same palette
 *  tokens the sidebar's folder colours use, so every theme (including custom
 *  ones) recolours the graph for free. */
const LANE_COLORS = [
  "var(--color-palette-blue)",
  "var(--color-palette-purple)",
  "var(--color-palette-green)",
  "var(--color-palette-orange)",
  "var(--color-palette-pink)",
  "var(--color-palette-teal)",
  "var(--color-palette-yellow)",
  "var(--color-palette-red)",
];
const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

/** Same status → glyph/colour mapping the staging list uses, so a file reads the
 *  same whether it is pending or historical. */
// Re-exported: it used to live here, and the History panel is still its most
// visible consumer. The implementation moved to lib/ so inline blame can share
// it without importing this component.
import { commitAge } from "@/lib/commitAge";
export { commitAge };

const SC: Record<string, string> = { M: "M", A: "+", D: "D", R: "R", C: "C" };
const COL: Record<string, string> = {
  M: "var(--color-accent)", A: "var(--color-ok)", D: "var(--color-err)",
  R: "var(--color-accent)", C: "var(--color-accent)",
};

/** Split git's `%D` decorations into what a chip should say.
 *  "HEAD -> main" → the branch, flagged as head; "tag: v1" → a tag. */
export interface RefChip { label: string; kind: "head" | "branch" | "remote" | "tag" }
export function parseRefs(refs: string[]): RefChip[] {
  const out: RefChip[] = [];
  for (const raw of refs) {
    const r = raw.trim();
    if (!r) continue;
    if (r.startsWith("tag: ")) { out.push({ label: r.slice(5), kind: "tag" }); continue; }
    if (r.startsWith("HEAD -> ")) { out.push({ label: r.slice(8), kind: "head" }); continue; }
    if (r === "HEAD") { out.push({ label: "HEAD", kind: "head" }); continue; }
    // A remote-tracking ref is "<remote>/<branch>"; the plain local branch has
    // no slash-prefixed remote. Close enough to colour them apart, and a wrong
    // guess costs a shade, not information.
    out.push({ label: r, kind: r.includes("/") ? "remote" : "branch" });
  }
  // Most informative first, because the row only has room for a couple: where
  // HEAD is, then local branches, then tags, and remote-tracking refs last —
  // "origin/main" is the least surprising thing a commit can be labelled with.
  const rank = { head: 0, branch: 1, tag: 2, remote: 3 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/** How long the cursor must rest on a row before its card appears. Long,
 *  because the card is a reward for stopping, not something to trip over while
 *  scanning the list, but short enough that resting on a row feels answered. Once one HAS opened, moving to another row shows it at
 *  once (Radix's skipDelayDuration) — having paid the wait once, you are
 *  reading cards now, and re-charging the timer per row would be maddening. */
const CARD_DELAY_MS = 1500;
/** Grace after a card closes during which the next opens instantly. */
const CARD_SKIP_MS = 900;

// splitTrailers moved to lib/commitMessage.ts (shared with the editor's blame
// popup) and is re-exported here, where it used to live and where the History
// panel's own tests still import it from.
export { splitTrailers } from "@/lib/commitMessage";


export function HistoryPanel({ task, reloadToken, onOpenDiff, repoDir: repoDirProp, scope, search = "" }: {
  task: Task;
  /** Bumped by the panel header's refresh and by agent-settle / git ticks.
   *  Re-reads the pages already on screen without resetting the scroll. */
  reloadToken: number;
  /** Open a diff tab for one file of one commit (sides = sha^ → sha). */
  onOpenDiff: (path: string, sha: string, title: string) => void;
  /** Repo to read, when the host already has a repo selector of its own (the
   *  Git tab's pills). Given one, this panel drops its own pills instead of
   *  showing a second set that can disagree with them. */
  repoDir?: string;
  /** Scope, when the host renders the picker itself (the Git tab puts it on
   *  its sub-tab row). Given one, this panel drops its own scope row. */
  scope?: { allBranches: boolean; refs: string[]; firstParent: boolean };
  /** The Git tab's filter box, shared with its file lists. Here it is a
   *  message search run BY GIT (`--grep`, literal and case-insensitive) over
   *  the whole history, not a filter over the page on screen: "does this
   *  branch have a commit about X" is a question about the history, and
   *  answering it from the loaded rows would make it a question about how far
   *  the user had scrolled. Debounced, so it is one `git log` per pause, not
   *  per keystroke. */
  search?: string;
}) {
  const { t } = useTranslation("panels");
  // `Project.non_git` describes the HOST folder. A multi-repo project's host
  // is routinely a plain folder holding real git repos, so it only answers for
  // this panel when the panel is standing alone and reading the task's own
  // path. Embedded, GitPanel has already resolved a repo and named it in
  // `repoDir`, and asking the project instead told someone looking at a
  // selected member repo that it was not a git repository.
  const projectNonGit = useApp(s => s.projects.find(p => p.id === task.project_id)?.non_git);
  const controlled = repoDirProp !== undefined;
  const nonGit = controlled ? false : !!projectNonGit;
  const members = controlled ? [] : (task.composition ?? []);
  const [ownRepoDir, setRepoDir] = useState("");
  const repoDir = controlled ? repoDirProp : ownRepoDir;
  /** Scope, owned here when the panel stands alone and by the host when it is
   *  embedded (the Git tab renders the picker on its Graph header, so it has
   *  to hold the value the picker edits). Empty refs and not `allBranches` =
   *  Auto: HEAD alone, the "what did the agent just do?" default. */
  const [ownAllBranches, setAllBranches] = useState(false);
  const [ownPickedRefs, setPickedRefs] = useState<string[]>([]);
  const [ownFirstParent, setFirstParent] = useState(false);
  const allBranches = scope ? scope.allBranches : ownAllBranches;
  const pickedRefs = scope ? scope.refs : ownPickedRefs;
  const firstParent = scope ? scope.firstParent : ownFirstParent;
  /** Stable dep for the fetch effects: a new array every render would refetch
   *  forever, and the ref list is short enough to compare as a string. */
  const refsKey = pickedRefs.join(" ");
  /** The search actually sent to git. Trailing-edge debounce: typing "login"
   *  is one walk on the pause, not five walks and four wasted ones. */
  const [grep, setGrep] = useState("");
  const query = search.trim();
  useEffect(() => {
    if (query === grep) return;
    const t = window.setTimeout(() => setGrep(query), 250);
    return () => window.clearTimeout(t);
  }, [query, grep]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branch, setBranch] = useState("");
  const [upstream, setUpstream] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  /** The scrolling list, so a revealed commit can be brought into view. */
  const listRef = useRef<HTMLDivElement>(null);
  // How many rows are on screen, for the refresh below. A ref, not state: the
  // refresh effect must READ it without re-firing every time a page lands.
  const loadedRef = useRef(PAGE_SIZE);
  loadedRef.current = Math.max(PAGE_SIZE, commits.length);

  // A different repo or scope is a different history, not more of this one.
  useEffect(() => { setSelected(null); }, [repoDir, allBranches, refsKey, firstParent, grep, task.id]);
  // Refs belong to a repo. Carrying a selection across would ask for branches
  // the new repo does not have, which is answered with an empty graph. Only
  // ours to reset when we own it; the host clears its own on the same signal.
  useEffect(() => {
    if (scope) return;
    setPickedRefs([]); setAllBranches(false); setFirstParent(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope identity is not the signal
  }, [repoDir, task.id]);

  // Refresh: re-read from the top, as many rows as are showing. It has to be a
  // fresh window rather than a patch, because a commit landing at HEAD shifts
  // every offset below it — the one thing this tab exists to show.
  useEffect(() => {
    if (nonGit) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    taskGitLog(task.id, repoDir, 0, loadedRef.current, allBranches, pickedRefs, firstParent, grep)
      .then(page => {
        if (!alive) return;
        setCommits(page.commits);
        setBranch(page.branch);
        setUpstream(page.upstream);
        setHasMore(page.has_more);
        setErr(null);
      })
      .catch(e => { if (alive) setErr(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refsKey is pickedRefs
  }, [task.id, repoDir, allBranches, refsKey, firstParent, grep, reloadToken, nonGit]);

  /** Next page, appended. Uses the backend's `skip`, so paging back through a
   *  long history costs one page per click instead of re-walking everything
   *  above it. Deduped by sha: a commit landing between two page fetches
   *  shifts the window, and the overlap would otherwise render twice. */
  const loadMore = useCallback(() => {
    setPaging(true);
    taskGitLog(task.id, repoDir, commits.length, PAGE_SIZE, allBranches, pickedRefs, firstParent, grep)
      .then(page => {
        setCommits(prev => {
          const seen = new Set(prev.map(c => c.sha));
          return [...prev, ...page.commits.filter(c => !seen.has(c.sha))];
        });
        setHasMore(page.has_more);
      })
      .catch(e => setErr(String(e)))
      .finally(() => setPaging(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refsKey is pickedRefs
  }, [task.id, repoDir, allBranches, refsKey, firstParent, grep, commits.length]);

  // "Show this commit in History", from the editor's blame popup.
  //
  // If the commit is already on screen this is just a select + scroll. If it is
  // not, we ask git WHERE it is (`task_git_commit_offset`) and fetch the one
  // page around it. The earlier version paged forward until the sha turned up,
  // which works on a young repo and is hopeless on a monorepo: a two-year-old
  // commit is tens of thousands of rows down, and no page budget reaches it.
  const commitReveal = useUI(s => s.commitReveal);
  const revealSha = commitReveal && commitReveal.taskId === task.id ? commitReveal.sha : null;
  const revealAt = commitReveal?.at ?? 0;
  /** The request we have already jumped for, so a jump happens once. */
  const jumpedForRef = useRef(0);
  useEffect(() => {
    if (!revealSha || loading) return;
    if (commits.some(c => c.sha === revealSha)) {
      setSelected(revealSha);
      // Honoured: drop the request so it cannot be re-applied later. Left
      // standing it is a standing order, re-pinning the right panel on every
      // task switch and re-selecting this commit in whatever history is on
      // screen.
      useUI.getState().clearCommitReveal();
      // The row renders selected on this pass, so the scroll waits a frame.
      requestAnimationFrame(() => {
        listRef.current
          ?.querySelector(`[data-sha="${revealSha}"]`)
          ?.scrollIntoView({ block: "center" });
      });
      return;
    }
    if (jumpedForRef.current === revealAt || paging) return;
    jumpedForRef.current = revealAt;
    setPaging(true);
    taskGitCommitOffset(task.id, repoDir, revealSha)
      .then(offset => {
        const skip = Math.max(0, offset - REVEAL_CONTEXT);
        return taskGitLog(task.id, repoDir, skip, PAGE_SIZE, allBranches, pickedRefs, firstParent, grep)
          .then(page => {
            // A jump REPLACES the window rather than appending: the rows above
            // belong to a different part of the history and stitching them
            // together would draw a graph with a hole in it.
            setCommits(page.commits);
            setHasMore(page.has_more);
          });
      })
      .catch(() => {
        // Not reachable from HEAD (another branch), or git said no. Say so once
        // and drop the request rather than leaving it to fire elsewhere.
        useUI.getState().pushToast(t("history.notInHistory"), "info");
        useUI.getState().clearCommitReveal();
      })
      .finally(() => setPaging(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSha, revealAt, commits, loading, paging]);

  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const lanes = Math.min(graphWidth(rows), MAX_LANES);
  const gutter = Math.max(lanes, 1) * LANE_W + 6;

  const openDiff = useCallback((sha: string, f: GitFile) => {
    const prefix = repoDir ? `${repoDir}/` : "";
    onOpenDiff(prefix + f.path, sha, `Δ ${f.path.split("/").pop()}`);
  }, [repoDir, onOpenDiff]);

  if (nonGit) {
    return <Empty>{t("history.notGit")}</Empty>;
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="history-panel"
      // Is a fetch in flight? A refetch keeps the PREVIOUS rows on screen
      // until the new page lands (setCommits only fires on success), which is
      // right for the eye and invisible to a reader: the rows for the scope
      // you just left look exactly like the rows for the one you picked. A
      // spec that samples the list between the two reads the wrong scope's
      // commits, and only on a machine slow enough for the gap to exist. That
      // is what this attribute is for.
      data-loading={loading || paging ? "true" : "false"}
    >
      {/* Repo pills — multi-repo tasks pick which repo's history to read. */}
      {members.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-[var(--color-border-soft)] px-2 py-1.5">
          <RepoPill label={task.name} active={repoDir === ""} onClick={() => setRepoDir("")} />
          {members.map(m => (
            <RepoPill key={m.dir_name} label={m.dir_name} active={repoDir === m.dir_name} onClick={() => setRepoDir(m.dir_name)} />
          ))}
        </div>
      )}

      {/* Scope row, only when this panel stands alone. Inside the Git tab the
          picker rides the Graph header instead: the branch is already on the
          BranchBar at the top of that tab, so repeating it here spent a whole
          row saying something the user could already see. */}
      {!controlled && (
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-soft)] px-2 text-[11.5px]">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
          <span className="min-w-0 flex-1 truncate text-[var(--color-fg-dim)]" title={branch || t("shared.detachedHead")}>
            {branch || t("shared.detachedHead")}
          </span>
          <ScopePicker
            taskId={task.id}
            repoDir={repoDir}
            branch={branch}
            allBranches={allBranches}
            picked={pickedRefs}
            firstParent={firstParent}
            onChange={(all, refs, fp) => { setAllBranches(all); setPickedRefs(refs); setFirstParent(fp); }}
          />
        </div>
      )}

      {/* One Provider for the whole list: the wait-then-instant behaviour is
          shared state, so a per-row Provider (what `Tip` builds) would recharge
          the timer on every commit.

          Hoverable, unlike every other tooltip in the app: this one holds a
          whole commit message, which is there to be read and scrolled, so the
          cursor has to be able to enter it. That is also why it sits flush
          against the row (`sideOffset={0}`) with no gap to cross. */}
      <RT.Provider delayDuration={CARD_DELAY_MS} skipDelayDuration={CARD_SKIP_MS}>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {err && <Empty tone="err">{err}</Empty>}
        {!err && loading && commits.length === 0 && (
          <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-[var(--color-fg-faint)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("history.reading")}
          </div>
        )}
        {!err && !loading && commits.length === 0 && (
          grep
            ? <Empty>{t("history.noMatch", { query: grep })}</Empty>
            : <Empty>{t("history.empty")}</Empty>
        )}

        {rows.map((row, i) => (
          <CommitRow
            key={row.sha}
            commit={commits[i]}
            row={row}
            lanes={lanes}
            gutter={gutter}
            showUnpushed={!!upstream}
            selected={selected === row.sha}
            onSelect={() => setSelected(s => (s === row.sha ? null : row.sha))}
            taskId={task.id}
            repoDir={repoDir}
            onOpenDiff={openDiff}
          />
        ))}

        {hasMore && (
          <button
            data-testid="history-load-more"
            onClick={loadMore}
            disabled={loading || paging}
            className="flex w-full items-center justify-center gap-1.5 py-2 text-[12px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-50"
          >
            {(loading || paging) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("history.loadMore")}
          </button>
        )}
      </div>
      </RT.Provider>
    </div>
  );
}

function Empty({ children, tone }: { children: React.ReactNode; tone?: "err" }) {
  return (
    <div className={cn(
      "px-3 py-3 text-[12px]",
      tone === "err" ? "text-[var(--color-err)]" : "text-[var(--color-fg-faint)]",
    )}>
      {children}
    </div>
  );
}

/** Which refs the graph walks, VS Code's ref picker in miniature: a filter
 *  box, then All / Auto, then the repo's branches, remotes and tags, each with
 *  the sha it points at. Multi-select, because comparing two branches in one
 *  graph is the thing a single toggle could never express.
 *
 *  The old control was one button that said "This branch", which is both a
 *  state and an invitation to click: you could not tell which. A list of
 *  checkboxes has neither problem.
 *
 *  Refs load when the menu OPENS, not on mount: this component lives for the
 *  panel's whole life, and a branch created in the terminal must appear
 *  without a reload. */
export function ScopePicker({ taskId, repoDir, branch, allBranches, picked, firstParent, onChange }: {
  taskId: string;
  repoDir: string;
  /** Checked-out branch, so the Auto state can say its NAME. "Auto" alone told
   *  the user nothing about what they were looking at. */
  branch: string;
  allBranches: boolean;
  picked: string[];
  /** Follow only first parents: merged side branches collapse into the merge
   *  that brought them in. Orthogonal to WHICH refs are walked, so it is a
   *  separate toggle rather than a fourth mutually exclusive scope. */
  firstParent: boolean;
  onChange: (allBranches: boolean, refs: string[], firstParent: boolean) => void;
}) {
  const [refs, setRefs] = useState<GitRef[] | null>(null);
  const [filter, setFilter] = useState("");
  const { t } = useTranslation("panels");

  const load = useCallback(() => {
    taskGitRefs(taskId, repoDir).then(setRefs).catch(() => setRefs([]));
  }, [taskId, repoDir]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (r: GitRef) => !q || r.name.toLowerCase().includes(q);
    const of = (kind: GitRef["kind"]) => (refs ?? []).filter(r => r.kind === kind && match(r));
    return [
      { label: t("history.branches"), items: of("branch") },
      { label: t("history.remoteBranches"), items: of("remote") },
      { label: t("history.tags"), items: of("tag") },
    ].filter(g => g.items.length > 0);
  }, [refs, filter, t]);

  // The label is what is being SHOWN, not the name of a mode: the branch when
  // scope is Auto, "All", or the count when refs are picked.
  const label = allBranches
    ? t("history.scopeAll")
    : picked.length === 0
      ? (branch || t("shared.detachedHead"))
      : picked.length === 1 ? picked[0] : t("history.refsCount", { count: picked.length });
  const title = allBranches
    ? t("history.titleAll")
    : picked.length === 0
      ? t("history.titleAuto", { branch: branch || t("shared.detachedHead") })
      : t("history.titlePicked", { refs: picked.join(", ") });

  const toggleRef = (name: string) => {
    const next = picked.includes(name) ? picked.filter(r => r !== name) : [...picked, name];
    // Unchecking the last one lands back on Auto rather than on an empty
    // graph, which is the only state here that shows nothing and explains
    // nothing.
    onChange(false, next, firstParent);
  };

  return (
    <DropdownRoot onOpenChange={(open) => { if (open) { setFilter(""); load(); } }}>
      <DropdownTrigger asChild>
        <button
          data-testid="history-scope"
          data-all={allBranches ? "true" : "false"}
          data-picked={picked.length}
          title={title}
          className={cn(
            "flex min-w-0 max-w-[140px] shrink items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
            allBranches || picked.length > 0
              ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
              : "text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      </DropdownTrigger>
      <DropdownMenu align="end" className="max-h-[60vh] w-[280px] overflow-auto">
        <div className="p-1">
          <input
            autoFocus
            value={filter}
            onChange={e => setFilter(e.target.value)}
            onKeyDown={e => e.stopPropagation()}
            placeholder={t("history.filterRefs")}
            spellCheck={false}
            className="h-6 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 text-[11.5px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)]"
          />
        </div>
        <ScopeRow
          label={t("history.scopeAll")} hint={t("history.hintAll")} closeOnSelect
          checked={allBranches}
          onSelect={() => onChange(!allBranches, [], firstParent)}
        />
        <ScopeRow
          label={t("history.scopeAuto")} hint={branch || t("shared.detachedHead")} closeOnSelect
          checked={!allBranches && picked.length === 0}
          onSelect={() => onChange(false, [], firstParent)}
        />
        <DropdownSeparator />
        {/* Not a fourth scope: it answers "how much of the topology", where
            the rows above answer "starting from which refs". A merge brings a
            whole side branch in as ancestors, so a plain walk of one branch
            still draws every lane that was ever merged into it, which reads as
            "why am I seeing other branches when I picked main". Meaningless
            under All, where seeing every tip is the point. */}
        <ScopeRow
          label={t("history.firstParent")}
          hint={allBranches ? t("history.firstParentHintAll") : t("history.firstParentHintNoAll")}
          checked={firstParent && !allBranches}
          onSelect={() => { if (!allBranches) onChange(allBranches, picked, !firstParent); }}
        />
        {refs === null && (
          <div className="px-2 py-1.5 text-[11.5px] text-[var(--color-fg-faint)]">{t("history.readingRefs")}</div>
        )}
        {refs !== null && groups.length === 0 && (
          <div className="px-2 py-1.5 text-[11.5px] text-[var(--color-fg-faint)]">
            {filter.trim() ? t("history.noRefMatch") : t("history.noRefs")}
          </div>
        )}
        {groups.map(g => (
          <div key={g.label}>
            <DropdownLabel>{g.label}</DropdownLabel>
            {g.items.map(r => (
              <ScopeRow
                key={r.kind + r.name}
                label={r.name} hint={r.sha}
                checked={picked.includes(r.name)}
                onSelect={() => toggleRef(r.name)}
              />
            ))}
          </div>
        ))}
      </DropdownMenu>
    </DropdownRoot>
  );
}

/** One row in the scope picker.
 *
 *  A ref row does NOT close the menu: picking refs is a multi-select, and a
 *  menu that shut after every tick would make selecting three branches three
 *  round trips. All and Auto DO (`closeOnSelect`): each is a complete answer
 *  on its own that clears everything else, so there is nothing left to pick
 *  and holding the menu open would just be a click to dismiss. */
function ScopeRow({ label, hint, checked, onSelect, closeOnSelect }: {
  label: string; hint: string; checked: boolean; onSelect: () => void;
  closeOnSelect?: boolean;
}) {
  return (
    <DropdownItem
      data-testid="history-scope-row"
      data-ref={label}
      data-checked={checked ? "true" : "false"}
      onSelect={(e: Event) => { if (!closeOnSelect) e.preventDefault(); onSelect(); }}
    >
      <Check className={cn("h-3.5 w-3.5 shrink-0", !checked && "opacity-0")} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[10.5px] text-[var(--color-fg-faint)]">{hint}</span>
    </DropdownItem>
  );
}

function RepoPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      data-testid="history-repo-pill"
      onClick={onClick}
      className={cn(
        "max-w-full truncate rounded-full px-2 py-0.5 text-[11px] transition-colors",
        active
          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
          : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
      )}
    >
      {label}
    </button>
  );
}

/** The lane gutter for one row: the through/in/out segments plus this commit's
 *  dot. One inline SVG per row — cheap (a handful of paths), and it scrolls
 *  with the row instead of needing a second synchronised canvas. */
function LaneGutter({ row, lanes, width }: { row: GraphRow; lanes: number; width: number }) {
  const x = (lane: number) => clampLane(lane, lanes) * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  return (
    <svg width={width} height={ROW_H} className="shrink-0" aria-hidden="true">
      {row.links.map((l, i) => {
        const x1 = x(l.fromLane);
        const x2 = x(l.toLane);
        // y-range per kind: a line arriving stops at the dot, one leaving
        // starts there, one just passing crosses the whole row.
        const y1 = l.kind === "out" ? mid : 0;
        const y2 = l.kind === "in" ? mid : ROW_H;
        // Straight where the lane doesn't move; an S-curve where it does, so a
        // branch reads as bending into its neighbour rather than as a corner.
        const d = x1 === x2
          ? `M ${x1} ${y1} L ${x2} ${y2}`
          : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
        return (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={laneColor(l.color)}
            strokeWidth={1.5}
            strokeLinecap="round"
            opacity={0.85}
          />
        );
      })}
      {/* Always drawn — a clipped column collapses onto the last one rather
          than leaving the row without a node. */}
      <circle
        cx={x(row.lane)}
        cy={mid}
        r={DOT_R}
        fill="var(--color-bg)"
        stroke={laneColor(row.color)}
        strokeWidth={2}
      />
    </svg>
  );
}

/** The hover card for one commit: who wrote it, when, and the whole message.
 *
 *  A row is one truncated line, so the full subject, the body and the author
 *  were unreachable without opening the commit. This is the read-only half of
 *  what clicking gives you (which loads files over IPC), at no cost until the
 *  cursor rests.
 *
 *  Rendered inside the shared Provider the list mounts, which is what makes
 *  the first card wait and the rest instant. */
function CommitCard({ commit }: { commit: GitCommit }) {
  const { t } = useTranslation("panels");
  const { prose, coAuthors } = useMemo(() => splitTrailers(commit.body ?? ""), [commit.body]);
  const when = new Date(commit.timestamp * 1000);
  return (
    <div className="flex max-w-[520px] min-w-0 flex-col gap-1.5" data-testid="history-commit-card">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px] text-[var(--color-fg-dim)]">
        <span className="font-medium text-[var(--color-fg)]">{commit.author}</span>
        <span className="text-[var(--color-fg-faint)]">{commit.email}</span>
        <span className="text-[var(--color-fg-faint)]">·</span>
        <span title={when.toISOString()}>{when.toLocaleString()}</span>
      </div>
      {coAuthors.length > 0 && (
        <div className="text-[11.5px] text-[var(--color-fg-dim)]">
          {coAuthors.join(", ")} <span className="text-[var(--color-fg-faint)]">
            {coAuthors.length === 1 ? t("shared.coAuthor") : t("shared.coAuthors")}
          </span>
        </div>
      )}
      {/* The subject in full: the row itself truncates, and a long one is
          exactly the case this card exists for. */}
      <div className="text-[12.5px] leading-snug font-medium text-[var(--color-fg)]">{commit.subject}</div>
      {prose && (
        // `whitespace-pre-wrap`: a commit message's own line breaks are part
        // of it. Capped and scrollable so a 200-line message cannot grow a
        // card taller than the window.
        <div className="max-h-[320px] overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--color-fg-dim)]">
          {prose}
        </div>
      )}
      <div className="font-mono text-[10.5px] text-[var(--color-fg-faint)]">{commit.short}</div>
    </div>
  );
}

/** memo: selecting a commit re-renders the list, and every OTHER row's props
 *  are unchanged — without this, a click repaints every SVG on screen. */
const CommitRow = memo(function CommitRow({
  commit, row, lanes, gutter, showUnpushed, selected, onSelect, taskId, repoDir, onOpenDiff,
}: {
  commit: GitCommit;
  row: GraphRow;
  lanes: number;
  gutter: number;
  showUnpushed: boolean;
  selected: boolean;
  onSelect: () => void;
  taskId: string;
  repoDir: string;
  onOpenDiff: (sha: string, f: GitFile) => void;
}) {
  const { t } = useTranslation("panels");
  const chips = useMemo(() => parseRefs(commit.refs), [commit.refs]);
  return (
    <div data-testid="history-commit" data-sha={commit.sha}>
      <ContextMenuRoot>
        <ContextMenuTrigger>
          {/* Hover card. The Provider is mounted once around the whole list,
              not here, because the wait-then-instant behaviour is shared
              state: pay it on the first commit, read the rest at once. */}
          <RT.Root>
          <RT.Trigger asChild>
          <div
            data-testid="history-commit-row"
            onClick={onSelect}
            style={{ height: ROW_H }}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 pr-2 text-[12px]",
              selected ? "bg-[var(--color-sel)]" : "hover:bg-[var(--color-hover)]",
            )}
          >
            {/* The gutter spans the full graph width and the text starts just
                past THIS row's dot, so the two overlap rather than sitting in
                two columns. Negative margin instead of absolute positioning
                keeps the row a plain flex line that can still be measured. */}
            <LaneGutter row={row} lanes={lanes} width={gutter} />
            <span
              aria-hidden="true"
              className="shrink-0"
              style={{ marginLeft: textIndent(row.lane, lanes) - gutter }}
            />
            {/* Chips are capped by WIDTH, not just by count, and they never
                wrap. Two `max-w-[40%]` chips could take 80% of the row between
                them and leave the subject as an ellipsis, which is what a
                commit on a branch plus its remote looked like.
                
                One line per commit is deliberate: rows are a fixed ROW_H and
                the lane gutter is drawn against that height, so a wrapping row
                would desync the graph it sits in, and a column of uneven rows
                is worse to scan than a truncated ref. Refs are decoration on a
                handful of rows; the subject is what every row is read for, so
                the group yields first and the full names live in the title and
                the hover card. */}
            {chips.length > 0 && (
              <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden" style={{ maxWidth: "45%" }}>
                {chips.slice(0, MAX_CHIPS).map(c => <RefBadge key={c.label + c.kind} chip={c} />)}
                {chips.length > MAX_CHIPS && (
                  <span
                    title={chips.slice(MAX_CHIPS).map(c => c.label).join(", ")}
                    className="shrink-0 rounded bg-[var(--color-bg-3)] px-1 text-[10.5px] leading-[16px] text-[var(--color-fg-faint)]"
                  >
                    +{chips.length - MAX_CHIPS}
                  </span>
                )}
              </span>
            )}
            {/* Outgoing marker: committed here, not on the remote yet. A small
                filled dot before the subject, the way Fork marks these, rather
                than an arrow glyph: at this row height an arrow reads as a
                control you could click, and a run of them down the column
                reads as a toolbar. A dot is a state.

                Hidden entirely when the branch has no upstream, where
                "unpushed" would describe every commit and mean nothing. */}
            {showUnpushed && commit.unpushed && (
              <Tip content={t("history.notPushed")} side="left">
                <span
                  data-testid="history-unpushed"
                  className="h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--color-info)]"
                />
              </Tip>
            )}
            {/* No `title`: the hover card already shows the full subject, and
                the browser's own tooltip drew ON TOP of it a second later. */}
            <span data-testid="history-subject" className="min-w-0 flex-1 truncate text-[var(--color-fg)]">
              {commit.subject}
            </span>
            <span className="shrink-0 tabular-nums text-[11px] text-[var(--color-fg-faint)]">
              {commitAge(commit.timestamp)}
            </span>
          </div>
          </RT.Trigger>
          <RT.Portal>
            <RT.Content
              side="left" align="start" sideOffset={0} collisionPadding={8}
              className="z-[100] rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] p-2.5 shadow-lg data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0"
            >
              <CommitCard commit={commit} />
            </RT.Content>
          </RT.Portal>
          </RT.Root>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>{commit.short}</ContextMenuLabel>
          <ContextMenuItem onSelect={() => copyToClipboard(commit.sha, "commit SHA")}>
            <Copy className="h-4 w-4" />
            {t("history.copySha")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => copyToClipboard(commit.short, "short SHA")}>
            <Copy className="h-4 w-4" />
            {t("history.copyShortSha")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => copyToClipboard(commit.subject, "commit message")}>
            <Copy className="h-4 w-4" />
            {t("history.copyMessage")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuRoot>
      {selected && (
        <CommitDetail
          commit={commit}
          taskId={taskId}
          repoDir={repoDir}
          indent={detailIndent(row.lane, lanes)}
          onOpenDiff={onOpenDiff}
        />
      )}
    </div>
  );
});

function RefBadge({ chip }: { chip: RefChip }) {
  // Every BRANCH reads the same, local or remote. They were three shades of
  // grey-on-grey against one accent-filled pill for HEAD, and "how far back
  // is origin" is one of the two things this graph is read for: the chip
  // answering it cannot be the faintest thing on the row. The label already
  // carries `origin/`, so the prefix distinguishes them and the colour does
  // not have to. Tags keep their own colour and glyph, being a different kind
  // of thing rather than a quieter one.
  const style = chip.kind === "tag"
    ? "bg-[var(--color-bg-3)] text-[var(--color-warn)]"
    : "bg-[var(--color-accent-soft)] text-[var(--color-accent)]";
  return (
    <span
      data-testid="history-ref"
      title={chip.label}
      className={cn("flex min-w-0 shrink items-center gap-0.5 rounded px-1 text-[10.5px] leading-[16px]", style)}
    >
      {chip.kind === "tag" && <Tag className="h-2.5 w-2.5 shrink-0" />}
      <span className="truncate">{chip.label}</span>
    </span>
  );
}

/** The expanded commit: who/when/sha, then the files it touched. Fetched
 *  lazily — the file list of a commit nobody opened is a process we never run. */
function CommitDetail({ commit, taskId, repoDir, indent, onOpenDiff }: {
  commit: GitCommit;
  taskId: string;
  repoDir: string;
  indent: number;
  onOpenDiff: (sha: string, f: GitFile) => void;
}) {
  const [files, setFiles] = useState<GitFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const { t } = useTranslation("panels");

  useEffect(() => {
    let alive = true;
    taskGitCommitFiles(taskId, repoDir, commit.sha)
      .then(f => { if (alive) setFiles(f); })
      .catch(e => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [taskId, repoDir, commit.sha]);

  useEffect(() => () => { if (copiedTimer.current) window.clearTimeout(copiedTimer.current); }, []);

  const when = new Date(commit.timestamp * 1000);
  return (
    <div
      data-testid="history-commit-detail"
      className="min-w-0 overflow-hidden border-b border-[var(--color-border-soft)] bg-[var(--color-bg)] pb-1.5"
      style={{ paddingLeft: indent }}
    >
      <div className="flex items-center gap-1.5 py-1 pr-2 text-[11px] text-[var(--color-fg-faint)]">
        <button
          onClick={() => {
            copyToClipboard(commit.sha, "commit SHA");
            setCopied(true);
            if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
            copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
          }}
          className="flex shrink-0 items-center gap-1 rounded px-1 font-mono hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          title={t("history.copyFullSha")}
        >
          {copied ? <Check className="h-3 w-3 text-[var(--color-ok)]" /> : <Copy className="h-3 w-3" />}
          {commit.short}
        </button>
        <span className="min-w-0 flex-1 truncate" title={commit.email}>{commit.author}</span>
        <span className="min-w-0 shrink truncate text-right" title={when.toString()}>
          {when.toLocaleDateString()}
        </span>
      </div>

      {err && <div className="px-1 py-1 text-[11px] text-[var(--color-err)]">{err}</div>}
      {!err && files === null && (
        <div className="flex items-center gap-1.5 px-1 py-1 text-[11px] text-[var(--color-fg-faint)]">
          <Loader2 className="h-3 w-3 animate-spin" /> {t("history.readingChanges")}
        </div>
      )}
      {files?.length === 0 && (
        <div className="px-1 py-1 text-[11px] text-[var(--color-fg-faint)]">{t("history.noFiles")}</div>
      )}
      {files?.map(f => (
        <button
          key={f.path}
          data-testid="history-file-row"
          data-path={f.path}
          onClick={() => onOpenDiff(commit.sha, f)}
          className="flex w-full items-center gap-1.5 rounded px-1 py-[3px] text-left text-[12px] hover:bg-[var(--color-hover)]"
        >
          <span
            className="w-3 shrink-0 text-center text-[11px] font-semibold"
            style={{ color: COL[f.status] ?? "var(--color-fg-dim)" }}
            title={f.status}
          >
            {SC[f.status] ?? f.status}
          </span>
          <img src={fileIconUrl(f.path)} alt="" className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]" title={f.path}>
            {f.path.split("/").pop()}
          </span>
          {f.path.includes("/") && (
            <span className="min-w-0 max-w-[45%] shrink truncate text-[10.5px] text-[var(--color-fg-faint)]">
              {f.path.slice(0, f.path.lastIndexOf("/"))}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
