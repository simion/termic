// Committed history with a commit graph — the right panel's "History" tab
// (issue #199). The Commit tab only ever shows the working tree, so once an
// agent committed, its work vanished from the UI and people left for VS Code
// or Fork to see what had just happened.
//
// Modelled on VS Code's Source Control Graph: one dense row per commit (lanes,
// ref chips, subject, relative time), click a commit to see the files it
// touched, click a file to open its diff. Lane maths lives in lib/gitGraph.ts
// (pure + unit-tested); this file is the rendering and the IPC.
//
// Layout, top to bottom:
//   1. Repo pills   — multi-repo tasks only, same idea as the Commit tab.
//   2. Scope row    — branch chip + "This branch" / "All branches".
//   3. Commit rows  — graph gutter, chips, subject, age. Selected row expands
//                     into its meta line + file list.
//   4. Load more    — pages of PAGE_SIZE, appended.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Tag, ArrowUp, Loader2, Copy, Check } from "lucide-react";
import type { GitCommit, GitFile, Task } from "@/lib/types";
import { taskGitLog, taskGitCommitFiles } from "@/lib/ipc";
import { layoutGraph, graphWidth, type GraphRow } from "@/lib/gitGraph";
import { copyToClipboard } from "@/lib/clipboard";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/Tooltip";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuLabel } from "@/components/ui/ContextMenu";
import { fileIconUrl } from "@/lib/explorer/iconResolver";

/** Commits per page. VS Code's graph loads 50 and pages on scroll; a page here
 *  is a bit bigger because the rows are one line and the fetch is one process. */
const PAGE_SIZE = 100;

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

/** Same status → glyph/colour mapping the Commit tab uses, so a file reads the
 *  same whether it is pending or historical. */
const SC: Record<string, string> = { M: "M", A: "+", D: "D", R: "R", C: "C" };
const COL: Record<string, string> = {
  M: "var(--color-accent)", A: "var(--color-ok)", D: "var(--color-err)",
  R: "var(--color-accent)", C: "var(--color-accent)",
};

/** "now" / "14m" / "3h" / "6d" / "8 Mar" — terse, because it sits at the right
 *  edge of a narrow row. Anything older than a year carries the year. */
export function commitAge(unixSeconds: number, now = Date.now()): string {
  const secs = Math.floor(now / 1000 - unixSeconds);
  if (!Number.isFinite(secs)) return "";
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const d = new Date(unixSeconds * 1000);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
}

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

export function HistoryPanel({ task, reloadToken, onOpenDiff }: {
  task: Task;
  /** Bumped by the panel header's refresh and by agent-settle / git ticks.
   *  Re-reads the pages already on screen without resetting the scroll. */
  reloadToken: number;
  /** Open a diff tab for one file of one commit (sides = sha^ → sha). */
  onOpenDiff: (path: string, sha: string, title: string) => void;
}) {
  const nonGit = useApp(s => s.projects.find(p => p.id === task.project_id)?.non_git);
  const members = task.composition ?? [];
  const [repoDir, setRepoDir] = useState("");
  const [allBranches, setAllBranches] = useState(false);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branch, setBranch] = useState("");
  const [upstream, setUpstream] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  // How many rows are on screen, for the refresh below. A ref, not state: the
  // refresh effect must READ it without re-firing every time a page lands.
  const loadedRef = useRef(PAGE_SIZE);
  loadedRef.current = Math.max(PAGE_SIZE, commits.length);

  // A different repo or scope is a different history, not more of this one.
  useEffect(() => { setSelected(null); }, [repoDir, allBranches, task.id]);

  // Refresh: re-read from the top, as many rows as are showing. It has to be a
  // fresh window rather than a patch, because a commit landing at HEAD shifts
  // every offset below it — the one thing this tab exists to show.
  useEffect(() => {
    if (nonGit) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    taskGitLog(task.id, repoDir, 0, loadedRef.current, allBranches)
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
  }, [task.id, repoDir, allBranches, reloadToken, nonGit]);

  /** Next page, appended. Uses the backend's `skip`, so paging back through a
   *  long history costs one page per click instead of re-walking everything
   *  above it. Deduped by sha: a commit landing between two page fetches
   *  shifts the window, and the overlap would otherwise render twice. */
  const loadMore = useCallback(() => {
    setPaging(true);
    taskGitLog(task.id, repoDir, commits.length, PAGE_SIZE, allBranches)
      .then(page => {
        setCommits(prev => {
          const seen = new Set(prev.map(c => c.sha));
          return [...prev, ...page.commits.filter(c => !seen.has(c.sha))];
        });
        setHasMore(page.has_more);
      })
      .catch(e => setErr(String(e)))
      .finally(() => setPaging(false));
  }, [task.id, repoDir, allBranches, commits.length]);

  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const lanes = Math.min(graphWidth(rows), MAX_LANES);
  const gutter = Math.max(lanes, 1) * LANE_W + 6;

  const openDiff = useCallback((sha: string, f: GitFile) => {
    const prefix = repoDir ? `${repoDir}/` : "";
    onOpenDiff(prefix + f.path, sha, `Δ ${f.path.split("/").pop()}`);
  }, [repoDir, onOpenDiff]);

  if (nonGit) {
    return <Empty>This project is not a git repository, so it has no history.</Empty>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="history-panel">
      {/* Repo pills — multi-repo tasks pick which repo's history to read. */}
      {members.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-[var(--color-border-soft)] px-2 py-1.5">
          <RepoPill label={task.name} active={repoDir === ""} onClick={() => setRepoDir("")} />
          {members.map(m => (
            <RepoPill key={m.dir_name} label={m.dir_name} active={repoDir === m.dir_name} onClick={() => setRepoDir(m.dir_name)} />
          ))}
        </div>
      )}

      {/* Scope: which branch's history, in the panel's own voice. */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-soft)] px-2 text-[11.5px]">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
        <span className="min-w-0 flex-1 truncate text-[var(--color-fg-dim)]" title={branch || "detached HEAD"}>
          {branch || "detached HEAD"}
        </span>
        <button
          data-testid="history-scope"
          data-all={allBranches ? "true" : "false"}
          onClick={() => setAllBranches(v => !v)}
          title={allBranches ? "Showing every branch in this repo" : "Showing this branch only"}
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 transition-colors",
            allBranches
              ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
              : "text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
          )}
        >
          {allBranches ? "All branches" : "This branch"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {err && <Empty tone="err">{err}</Empty>}
        {!err && loading && commits.length === 0 && (
          <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-[var(--color-fg-faint)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading history…
          </div>
        )}
        {!err && !loading && commits.length === 0 && (
          <Empty>No commits yet. Anything an agent commits shows up here.</Empty>
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
            Load more
          </button>
        )}
      </div>
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
  const chips = useMemo(() => parseRefs(commit.refs), [commit.refs]);
  return (
    <div data-testid="history-commit" data-sha={commit.sha}>
      <ContextMenuRoot>
        <ContextMenuTrigger>
          <div
            data-testid="history-commit-row"
            onClick={onSelect}
            style={{ height: ROW_H }}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 pr-2 text-[12px]",
              selected ? "bg-[var(--color-sel)]" : "hover:bg-[var(--color-hover)]",
            )}
          >
            <LaneGutter row={row} lanes={lanes} width={gutter} />
            {/* Capped: a commit that happens to carry four refs (a branch, its
                remote, the remote HEAD, a tag) would otherwise push the
                subject — the thing you are actually scanning for — off the
                row. The rest live in the overflow chip's tooltip. */}
            {chips.slice(0, MAX_CHIPS).map(c => <RefBadge key={c.label + c.kind} chip={c} />)}
            {chips.length > MAX_CHIPS && (
              <span
                title={chips.slice(MAX_CHIPS).map(c => c.label).join(", ")}
                className="shrink-0 rounded bg-[var(--color-bg-3)] px-1 text-[10.5px] leading-[16px] text-[var(--color-fg-faint)]"
              >
                +{chips.length - MAX_CHIPS}
              </span>
            )}
            {/* Outgoing marker: committed here, not on the remote yet. Hidden
                entirely when the branch has no upstream, where "unpushed"
                would describe every commit and mean nothing. */}
            {showUnpushed && commit.unpushed && (
              <Tip content="Not pushed yet" side="left">
                <ArrowUp className="h-3 w-3 shrink-0 text-[var(--color-warn)]" />
              </Tip>
            )}
            <span data-testid="history-subject" className="min-w-0 flex-1 truncate text-[var(--color-fg)]" title={commit.subject}>
              {commit.subject}
            </span>
            <span className="shrink-0 tabular-nums text-[11px] text-[var(--color-fg-faint)]">
              {commitAge(commit.timestamp)}
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>{commit.short}</ContextMenuLabel>
          <ContextMenuItem onSelect={() => copyToClipboard(commit.sha, "commit SHA")}>
            <Copy className="h-4 w-4" />
            Copy SHA
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => copyToClipboard(commit.short, "short SHA")}>
            <Copy className="h-4 w-4" />
            Copy short SHA
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => copyToClipboard(commit.subject, "commit message")}>
            <Copy className="h-4 w-4" />
            Copy message
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuRoot>
      {selected && (
        <CommitDetail
          commit={commit}
          taskId={taskId}
          repoDir={repoDir}
          indent={gutter}
          onOpenDiff={onOpenDiff}
        />
      )}
    </div>
  );
});

function RefBadge({ chip }: { chip: RefChip }) {
  const style =
    chip.kind === "head"   ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" :
    chip.kind === "tag"    ? "bg-[var(--color-bg-3)] text-[var(--color-warn)]" :
    chip.kind === "remote" ? "bg-[var(--color-bg-3)] text-[var(--color-fg-faint)]" :
                             "bg-[var(--color-bg-3)] text-[var(--color-fg-dim)]";
  return (
    <span
      data-testid="history-ref"
      title={chip.label}
      className={cn("flex max-w-[40%] shrink-0 items-center gap-0.5 rounded px-1 text-[10.5px] leading-[16px]", style)}
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
      className="border-b border-[var(--color-border-soft)] bg-[var(--color-bg)] pb-1.5"
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
          title="Copy the full SHA"
        >
          {copied ? <Check className="h-3 w-3 text-[var(--color-ok)]" /> : <Copy className="h-3 w-3" />}
          {commit.short}
        </button>
        <span className="min-w-0 truncate" title={commit.email}>{commit.author}</span>
        <span className="ml-auto shrink-0" title={when.toString()}>{when.toLocaleString()}</span>
      </div>

      {err && <div className="px-1 py-1 text-[11px] text-[var(--color-err)]">{err}</div>}
      {!err && files === null && (
        <div className="flex items-center gap-1.5 px-1 py-1 text-[11px] text-[var(--color-fg-faint)]">
          <Loader2 className="h-3 w-3 animate-spin" /> Reading changes…
        </div>
      )}
      {files?.length === 0 && (
        <div className="px-1 py-1 text-[11px] text-[var(--color-fg-faint)]">No file changes in this commit.</div>
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
            <span className="max-w-[45%] shrink-0 truncate text-[10.5px] text-[var(--color-fg-faint)]">
              {f.path.slice(0, f.path.lastIndexOf("/"))}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
