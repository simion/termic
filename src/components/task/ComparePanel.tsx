// "How does this task read next to another branch" — the Compare mode of the
// right panel's Git tab (issue #208).
//
// The Changes view only ever shows the working tree, so the moment an agent
// commits, its work vanishes from the panel; the Graph section (issue #199)
// shows the commits but never their combined effect. When an agent eats the
// elephant in six commits, neither answers the question you actually have,
// which is "what does all of it add up to". Compare is that answer: ONE list
// of every path that differs between a ref and the working tree, committed and
// uncommitted alike. One list means it does not split committed work from
// uncommitted into separate sections; it is NOT flat. It renders through the
// Changes view's own `flattenRows` in whichever of tree / list / combined is
// stored, so both file lists in this panel group and order identically.
//
// Deliberately a GENERIC ref-to-ref compare, not a PR view. Any local or
// remote-tracking ref in the repo can be the base; the task's own
// `base_branch` is only what the picker opens on. Comparing a spike against a
// sibling feature branch is the same code path.
//
// The panel owns only what is specific to comparing:
//   1. Compare bar   — `<base> → <branch>`, the base being the picker.
//   2. Summary strip — file count, diffstat, viewed progress.
//   3. File rows     — virtualized; click opens a `base:<sha>` diff.
// The repo pills, the filter box and the view-mode menu belong to GitPanel and
// arrive as props, so switching between Changes and Compare does not reset
// what you typed or which repo you were looking at.
//
// Unlike a diff read out of the graph, the right side here is the LIVE file,
// so the review affordances stay switched on: viewed marks anchor to a real
// worktree fingerprint and an inline comment lands on the version about to be
// edited. That is what makes this the surface for reviewing a whole feature.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight, ChevronDown, Check, Eye, Loader2, GitCompare as GitCompareIcon,
  ArrowRight, MessageSquare, AlertTriangle, FileText,
} from "lucide-react";
import type { GitCompare, GitFile, Task } from "@/lib/types";
import { taskGitCompare, taskGitRefs } from "@/lib/ipc";
import { useFileViewed, useIsViewed } from "@/store/fileViewed";
import { useReviewComments } from "@/store/reviewComments";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/Tooltip";
import {
  DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator, DropdownLabel,
} from "@/components/ui/Dropdown";
import {
  ContextMenuRoot, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/ContextMenu";
import { CopyPathItems } from "./CopyPathItems";
import { fileIconUrl, folderIconUrl } from "@/lib/explorer/iconResolver";
import { flattenRows, type FlatRow, type ViewMode } from "./GitPanel";
import { SC, COL, INK, LBL } from "@/lib/gitStatus";

/** Whether the compare runs from the merge base. Global rather than per task:
 *  it expresses how someone reads a diff, not anything about one branch. */
const LS_MERGE_BASE = "gitCompareMergeBase";
const ROW_H = 26;

function readMergeBase(): boolean {
  // Defaults ON — see the three-dot reasoning on the Rust side.
  try { return localStorage.getItem(LS_MERGE_BASE) !== "0"; } catch { return true; }
}

/** taskId → the ref that task was last compared against. Compare is a mode of
 *  the Git tab, so flipping back to Changes UNMOUNTS this panel; without
 *  somewhere outside the component to keep it, a deliberately chosen base
 *  would silently snap back to the task default on every round trip. In memory
 *  rather than localStorage on purpose: it is worth surviving a mode switch,
 *  not worth accumulating a key per task forever. */
const lastBase = new Map<string, string>();

/** `+12 −3`, or nothing at all when git couldn't count (a binary file). Zero
 *  is a real answer and still renders, so a pure rename doesn't look broken. */
function Churn({ added, removed }: { added?: number; removed?: number }) {
  if (added === undefined && removed === undefined) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 tabular-nums text-[10.5px]">
      {added !== undefined && <span className="text-[var(--color-ok)]">+{added}</span>}
      {removed !== undefined && <span className="text-[var(--color-err)]">−{removed}</span>}
    </span>
  );
}

export function ComparePanel({ task, repoDir, search, viewMode, reloadToken, onOpenDiff, onOpenFile }: {
  task: Task;
  /** Which repo of a multi-repo task to compare. Owned by GitPanel's pills so
   *  the two views cannot disagree about which repo you are looking at. */
  repoDir: string;
  /** GitPanel's filter box, shared with the Changes view for the same reason. */
  search: string;
  /** GitPanel's stored view mode. Shared so a folder sits in the same place in
   *  both lists; two file lists in one panel that disagreed would read as a bug. */
  viewMode: ViewMode;
  /** Bumped by the panel header's refresh, an agent settling, and the git
   *  tick a commit fires — the same signals the Changes view rides. */
  reloadToken: number;
  /** Open a diff for one file, sides = the compare base → the working tree. */
  onOpenDiff: (path: string, baseSha: string, title: string) => void;
  /** Opens the whole file (an editor tab) instead of its diff. Takes a
   *  task-relative path, like the Commit tab's opener. */
  onOpenFile: (path: string) => void;
}) {
  // No non-git check here on purpose. `Project.non_git` describes the HOST
  // folder, and a multi-repo project's host is routinely a plain folder full
  // of real git repos, so asking it "is this a git repository" answered for
  // the wrong thing and told someone looking at a selected member repo that
  // it was not one. GitPanel only mounts this once it has resolved a repo,
  // and `repoDir` names which, so the question is already settled upstream.
  // The picker opens on whatever this task was last compared against, falling
  // back to its own base ("origin/main" for a normal worktree task), which is
  // the comparison people want ~every time. Only a default: any ref below can
  // replace it.
  const { t } = useTranslation("panels");
  const [base, setBaseState] = useState(() => lastBase.get(task.id) ?? task.base_branch ?? "");
  const setBase = useCallback((ref: string) => {
    lastBase.set(task.id, ref);
    setBaseState(ref);
  }, [task.id]);
  const [mergeBase, setMergeBase] = useState<boolean>(() => readMergeBase());
  const [refs, setRefs] = useState<{ local: string[]; remote: string[] } | null>(null);
  const [cmp, setCmp] = useState<GitCompare | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const persist = (key: string, val: string) => { try { localStorage.setItem(key, val); } catch {} };
  const toggleMergeBase = () => setMergeBase(v => { const n = !v; persist(LS_MERGE_BASE, n ? "1" : "0"); return n; });

  // A different task is a different branch: fall back to ITS remembered ref,
  // then to ITS base, rather than keeping one that may not even exist in the
  // new repo. setBaseState (not setBase) so merely switching tasks doesn't
  // rewrite the remembered choice with a default.
  useEffect(() => {
    setBaseState(lastBase.get(task.id) ?? task.base_branch ?? "");
    setSelected(null);
    setRefs(null);
  }, [task.id, task.base_branch]);

  // Switching repo in a multi-repo task re-reads that repo's refs, and the
  // previous selection points at a file in a repo we are no longer showing.
  useEffect(() => { setSelected(null); setRefs(null); }, [repoDir]);

  useEffect(() => {
    if (!base) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    taskGitCompare(task.id, repoDir, base, mergeBase)
      .then(r => { if (alive) { setCmp(r); setErr(null); } })
      .catch(e => { if (alive) { setErr(String(e)); setCmp(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [task.id, repoDir, base, mergeBase, reloadToken]);

  /** Refs are only needed once the picker opens, and re-reading them on every
   *  compare would be a process per keystroke of the filter. */
  const loadRefs = useCallback(() => {
    if (refs) return;
    // `task_git_refs` is the graph's ref list: heads, remote-tracking refs and
    // tags, each tagged with its kind. Split it back into the two groups the
    // picker shows. Tags ride with the remote group rather than getting a
    // third section: comparing against one is legitimate and rare.
    taskGitRefs(task.id, repoDir)
      .then(rs => setRefs({
        local: rs.filter(r => r.kind === "branch").map(r => r.name),
        remote: rs.filter(r => r.kind !== "branch").map(r => r.name),
      }))
      .catch(() => setRefs({ local: [], remote: [] }));
  }, [refs, task.id, repoDir]);

  const files = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = cmp?.files ?? [];
    return q ? all.filter(f => f.path.toLowerCase().includes(q)) : all;
  }, [cmp, search]);

  const rows = useMemo(
    () => flattenRows(files, viewMode, collapsed, "compare"),
    [files, viewMode, collapsed],
  );

  // Viewed progress over the FILTERED list, so the fraction always describes
  // the rows on screen. A file counts only while its stashed fingerprint still
  // matches the live one (an agent edit moves fp and clears the mark).
  const viewedMap = useFileViewed(s => s.byTask[task.id]);
  const viewedCount = useMemo(() => {
    const pfx = repoDir ? `${repoDir}/` : "";
    return files.reduce((n, f) => n + (f.fp !== "" && viewedMap?.[pfx + f.path] === f.fp ? 1 : 0), 0);
  }, [files, viewedMap, repoDir]);

  // Diffstat over the filtered rows for the same reason.
  const { added, removed } = useMemo(() => files.reduce(
    (acc, f) => ({ added: acc.added + (f.added ?? 0), removed: acc.removed + (f.removed ?? 0) }),
    { added: 0, removed: 0 },
  ), [files]);

  const openFile = useCallback((path: string) => {
    if (!cmp) return;
    setSelected(path);
    const full = repoDir ? `${repoDir}/${path}` : path;
    onOpenDiff(full, cmp.base_sha, `Δ ${path.split("/").pop()}`);
  }, [cmp, repoDir, onOpenDiff]);

  // The other reading of the same row: the file itself, not the comparison.
  // Selection moves either way, so the list keeps your place when you switch.
  const openWholeFile = useCallback((path: string) => {
    setSelected(path);
    onOpenFile(repoDir ? `${repoDir}/${path}` : path);
  }, [repoDir, onOpenFile]);

  // ── virtual scroll (same fixed-height slice the Commit tab's list uses) ──
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerH, setContainerH] = useState(400);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerH(el.clientHeight));
    ro.observe(el);
    setContainerH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const OVERSCAN = 5;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const endIdx = Math.min(rows.length - 1, Math.ceil((scrollTop + containerH) / ROW_H) + OVERSCAN);

  const branchLabel = cmp?.branch || task.branch || t("compare.workingTree");

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="compare-panel">
      {/* 1. Compare bar. Reads left-to-right as the diff does: the base on the
          left is the side being compared FROM, this branch on the right is the
          side being compared TO. Without naming both, a file marked "D" is
          ambiguous (deleted by whom?), which is the single most confusing
          thing a compare view can leave unsaid. */}
      {/* WRAPS rather than truncates. Two long names is the normal case, not
          the edge one, and on one row flexbox splits the deficit in proportion
          to how long each name already is, so a 30-character branch drove the
          picker opposite it down to "d…". A second row costs 26px in a panel
          that only shows it when it is needed; a ref you cannot read costs the
          whole bar its point. `min-h-8` + `py-1` keeps the one-row case the
          same 32px it was. */}
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-[var(--color-border-soft)] px-2 py-1 text-[11.5px]">
        <GitCompareIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
        <DropdownRoot onOpenChange={o => { if (o) loadRefs(); }}>
          <DropdownTrigger asChild>
            <button
              data-testid="compare-base"
              data-base={base}
              title={t("compare.comparingAgainst", { base: base || t("compare.nothingYet") })}
              // Sized to the ref it holds, not to a share of the row: a
              // `max-w-[55%]` truncated "feature/new-claude-w…" while the
              // three characters of "main" opposite it sat in open space.
              // It still shrinks (min-w-0) if the picker ALONE outgrows the
              // row; two names that do not fit together take a row each
              // instead, which is what the bar's flex-wrap is for.
              className="flex h-6 min-w-0 shrink items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 transition-colors hover:border-[var(--color-accent-soft)]"
            >
              <span className="truncate font-mono text-[var(--color-fg)]">{base || t("compare.pickBranch")}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-[var(--color-fg-faint)]" />
            </button>
          </DropdownTrigger>
          <DropdownMenu align="start">
            <DropdownLabel>{t("compare.compareAgainst")}</DropdownLabel>
            {!refs ? (
              <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-[var(--color-fg-faint)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("compare.readingBranches")}
              </div>
            ) : refs.local.length + refs.remote.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-[var(--color-fg-faint)]">{t("compare.noBranches")}</div>
            ) : (
              <>
                {refs.local.map(b => <RefItem key={`l:${b}`} label={b} active={b === base} onSelect={() => setBase(b)} />)}
                {refs.remote.length > 0 && refs.local.length > 0 && <DropdownSeparator />}
                {refs.remote.map(b => <RefItem key={`r:${b}`} label={b} active={b === base} onSelect={() => setBase(b)} />)}
              </>
            )}
            <DropdownSeparator />
            {/* The one real semantic choice this view has, so it lives with
                the ref rather than in a settings pane. */}
            <DropdownItem onSelect={toggleMergeBase} className="items-start">
              <Check className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", !mergeBase && "opacity-0")} />
              <span className="flex flex-col gap-0.5">
                <span className="text-[12px]">{t("compare.fromCommonAncestor")}</span>
                <span className="max-w-[220px] text-[11px] leading-snug text-[var(--color-fg-faint)]">
                  {t("compare.commonAncestorHint")}
                </span>
              </span>
            </DropdownItem>
          </DropdownMenu>
        </DropdownRoot>
        <ArrowRight className="h-3 w-3 shrink-0 text-[var(--color-fg-faint)]" />
        <span
          // The item that carries the wrap: it is the reliably long one, so
          // when the two names do not fit together it is the one that takes
          // the second row, WHOLE. min-w-0 still lets it truncate, but only
          // once one name alone is wider than the panel.
          className="min-w-0 shrink truncate font-mono text-[var(--color-fg-dim)]"
          data-testid="compare-target"
          title={t("compare.targetTip", { branch: branchLabel })}
        >
          {branchLabel}
        </span>
        {!mergeBase && (
          <Tip content={t("compare.directTip")} side="left">
            <span className="ml-auto shrink-0 rounded bg-[var(--color-bg-3)] px-1 text-[10px] text-[var(--color-fg-faint)]">{t("compare.direct")}</span>
          </Tip>
        )}
      </div>

      {/* 2. Summary strip. The whole reason someone opens this tab is to judge
          size and impact before reading a single file, so the count and the
          diffstat come before the list, not buried in it. */}
      {cmp && !err && (
        <div
          data-testid="compare-summary"
          data-files={files.length}
          className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2.5 text-[11.5px] text-[var(--color-fg-dim)]"
        >
          <span className="shrink-0 tabular-nums">
            {files.length === 1 ? t("shared.fileOne") : t("shared.fileMany", { count: files.length })}
          </span>
          <Churn added={added} removed={removed} />
          {viewedCount > 0 && (
            <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-bg-3)] px-1.5 py-px text-[10px] font-medium">
              <Eye className="h-2.5 w-2.5" />
              <span className="tabular-nums">{viewedCount}/{files.length}</span>
            </span>
          )}
        </div>
      )}

      {cmp?.no_merge_base && (
        <Note>
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {t("compare.noMergeBase", { base })}
        </Note>
      )}
      {cmp?.truncated && <Note>{t("compare.truncated")}</Note>}

      {/* 5. Rows. */}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-auto py-0.5"
        onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
      >
        {err && <Empty tone="err">{err}</Empty>}
        {!err && !base && (
          <Empty>{t("compare.noBase")}</Empty>
        )}
        {!err && base && loading && !cmp && (
          <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-[var(--color-fg-faint)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("compare.comparing")}
          </div>
        )}
        {!err && cmp && files.length === 0 && (
          <Empty>
            {search.trim()
              ? t("compare.noMatch")
              : t("compare.nothingDiffers", { base: cmp.base })}
          </Empty>
        )}

        {startIdx > 0 && <div style={{ height: startIdx * ROW_H }} aria-hidden />}
        {rows.slice(startIdx, endIdx + 1).map(row => (
          <Row
            key={row.kind === "file" ? `f:${row.file.path}` : row.kind === "dir" ? `d:${row.dirPath}` : `h:${row.label}`}
            row={row}
            taskId={task.id}
            root={task.path}
            repoDir={repoDir}
            selected={row.kind === "file" && selected === row.file.path}
            onOpen={openFile}
            onOpenWholeFile={openWholeFile}
            setCollapsed={setCollapsed}
          />
        ))}
        {rows.length - 1 > endIdx && <div style={{ height: (rows.length - 1 - endIdx) * ROW_H }} aria-hidden />}
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

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-2.5 py-1 text-[11px] text-[var(--color-fg-faint)]">
      {children}
    </div>
  );
}

function RefItem({ label, active, onSelect }: { label: string; active: boolean; onSelect: () => void }) {
  return (
    <DropdownItem onSelect={onSelect} className="items-center">
      <Check className={cn("h-3.5 w-3.5 shrink-0", !active && "opacity-0")} />
      <span className="truncate font-mono text-[12px]">{label}</span>
    </DropdownItem>
  );
}

function Row({ row, taskId, root, repoDir, selected, onOpen, onOpenWholeFile, setCollapsed }: {
  row: FlatRow;
  taskId: string;
  root: string;
  repoDir: string;
  selected: boolean;
  onOpen: (path: string) => void;
  onOpenWholeFile: (path: string) => void;
  setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  if (row.kind === "dirhdr") {
    return (
      <div className="truncate px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-dim)]">
        {row.label}
      </div>
    );
  }
  if (row.kind === "dir") {
    return <DirRow row={row} setCollapsed={setCollapsed} />;
  }
  return (
    <FileRow
      file={row.file} label={row.label} depth={row.depth}
      taskId={taskId} root={root} repoDir={repoDir}
      selected={selected} onOpen={onOpen} onOpenWholeFile={onOpenWholeFile}
    />
  );
}

/** A folder in tree view. No stage/discard action, unlike the Commit tab's:
 *  half of what this list shows is already committed, and a control that
 *  silently applied to only the other half would be a trap. */
function DirRow({ row, setCollapsed }: {
  row: FlatRow & { kind: "dir" };
  setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const { name, dirPath, depth, isCollapsed } = row;
  const toggle = () => setCollapsed(prev => {
    const key = `compare\0${dirPath}`;
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });
  return (
    <div
      data-testid="compare-dir-row"
      data-dir={dirPath}
      onClick={toggle}
      style={{ height: ROW_H, paddingLeft: 6 + depth * 12 }}
      className="flex w-full cursor-pointer items-center gap-1.5 px-2 pr-1 text-left text-[12.5px] text-[var(--color-fg)]/85 hover:bg-[var(--color-hover)]"
    >
      <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)] transition-transform", !isCollapsed && "rotate-90")} />
      <img src={folderIconUrl(name, !isCollapsed)} alt="" className="h-4 w-4 shrink-0 file-icon" />
      <span className="flex-1 truncate font-medium">{name}</span>
    </div>
  );
}

/** One changed path. Deliberately the Commit tab's row minus the stage arrow
 *  and plus a churn column: the same glyph, icon, strike-through-when-viewed
 *  and eye toggle, so moving between the two tabs never asks you to relearn
 *  a row. */
function FileRow({ file, label, depth, taskId, root, repoDir, selected, onOpen, onOpenWholeFile }: {
  file: GitFile;
  label: string;
  depth: number;
  taskId: string;
  root: string;
  repoDir: string;
  selected: boolean;
  onOpen: (path: string) => void;
  onOpenWholeFile: (path: string) => void;
}) {
  const { t } = useTranslation("panels");
  const key = file.status;
  const fullPath = repoDir ? `${repoDir}/${file.path}` : file.path;
  const viewed = useIsViewed(taskId, fullPath, file.fp);
  const commentCount = useReviewComments(s => {
    const arr = s.byTask[taskId];
    if (!arr) return 0;
    let n = 0;
    for (const c of arr) if (c.file === fullPath) n++;
    return n;
  });
  // A file deleted in the working tree has nothing to fingerprint, so its
  // viewed mark could not anchor to content.
  const canView = file.fp !== "";
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
        <div
          data-testid="compare-file-row"
          data-path={file.path}
          data-status={key}
          data-selected={selected}
          title={`${LBL[key] || key}: ${file.path}`}
          // ⌥-click reads the file instead of the comparison, mirroring the
          // Commit tab's row. Gated on canView for the same reason the eye
          // is: a deleted file has no working-tree content to open.
          onClick={e => (canView && e.altKey ? onOpenWholeFile(file.path) : onOpen(file.path))}
          style={{ height: ROW_H, paddingLeft: 6 + depth * 12 + 8 - 2 }}
          className={cn(
            "group flex w-full cursor-pointer items-center gap-2 border-l-2 pr-2.5 text-[13px]",
            selected
              ? "border-[var(--color-accent)] bg-[var(--color-sel)] text-[var(--color-fg)]"
              : "border-transparent text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
          )}
        >
          <span
            className="inline-flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded px-0.5 text-[10.5px] font-semibold"
            style={{ background: COL[key] || "var(--color-fg-dim)", color: INK[key] || "var(--color-status-ink)" }}
          >{SC[key] || key}</span>
          <img src={fileIconUrl(label)} alt="" className={cn("h-4 w-4 shrink-0 file-icon", viewed && !selected && "opacity-50")} />
          <span className={cn(
            "min-w-0 flex-1 truncate font-mono text-[12px]",
            viewed && !selected && "text-[var(--color-fg-faint)] line-through decoration-[var(--color-fg-faint)]/40",
          )}>
            {label}
          </span>
          {commentCount > 0 && (
            <Tip side="left" content={commentCount === 1 ? t("shared.inlineCommentOne") : t("shared.inlineCommentMany", { count: commentCount })}>
              <span className="flex shrink-0 items-center gap-0.5 rounded bg-[var(--color-bg-3)] px-1 text-[10.5px] tabular-nums text-[var(--color-fg-dim)]">
                <MessageSquare className="h-2.5 w-2.5" />
                {commentCount}
              </span>
            </Tip>
          )}
          <Churn added={file.added} removed={file.removed} />
          {canView && (
            <Tip side="left" content={t("shared.openFileTip")}>
              <button
                onClick={e => { e.stopPropagation(); onOpenWholeFile(file.path); }}
                aria-label={t("shared.openFile")}
                className={cn(
                  "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded transition-colors",
                  "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                  selected ? "opacity-100" : "opacity-30 group-hover:opacity-100",
                )}
              >
                <FileText className="h-3.5 w-3.5" />
              </button>
            </Tip>
          )}
          {canView && (
            <Tip side="left" content={viewed ? t("shared.markNotViewed") : t("shared.markViewed")}>
              <button
                onClick={e => { e.stopPropagation(); useFileViewed.getState().toggle(taskId, fullPath, file.fp); }}
                aria-pressed={viewed}
                className={cn(
                  "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded transition-colors",
                  viewed
                    ? "text-[var(--color-accent)]"
                    : cn(
                        "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                        selected ? "opacity-100" : "opacity-30 group-hover:opacity-100",
                      ),
                )}
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
            </Tip>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {canView && (<>
          <ContextMenuItem onSelect={() => onOpenWholeFile(file.path)}>
            <FileText />
            {t("shared.openFile")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => useFileViewed.getState().toggle(taskId, fullPath, file.fp)}>
            <Check />
            {viewed ? t("shared.markNotViewed") : t("shared.markViewed")}
          </ContextMenuItem>
        </>)}
        <ContextMenuSeparator />
        <CopyPathItems rel={fullPath} root={root} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
