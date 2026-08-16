// Fork-style git staging panel (the "Git" tab of the right panel).
//
// Layout, top to bottom:
//   1. Repo sub-tabs   — multi-repo tasks only; one wrapping pill per
//      repo that has changes (even if just one), each badged with its
//      changed-file count. Clean repos get no pill.
//   2. Toolbar         — Changes / Compare switch, search filter, view-mode
//      menu (Tree / List / Combined List + Hide untracked). The filter and the
//      view mode are shared by both modes.
//   3. Unstaged pane   — resizable, scrollable file list.
//   4. Resize handle   — drag to repartition the two panes.
//   5. Staged pane     — resizable, scrollable file list.
//   6. Commit form     — subject, description, Amend, split Commit button.
//
// In Compare mode (issue #208) 3-5 are replaced by ComparePanel: one list of
// everything this branch differs by against a chosen ref, committed work
// included, which is the half the staging panes structurally cannot show. The
// commit form goes with them, since nothing in that list is stageable. The
// Graph section below (issue #199) is present in both modes.
//
// Backend: task_git_status returns staged/unstaged split per repo;
// task_stage / _unstage / _commit mutate the selected repo. Paths are
// repo-relative; member diffs are re-prefixed with `dir_name` before
// opening (the host stays unprefixed).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight, ChevronDown, ArrowDown, ArrowUp, List, ListTree, Rows3, Check, Eye, Search, Trash2, MessageSquare, Loader2, GitBranch, GitMerge, RotateCw,
} from "lucide-react";
import type { Task, GitStatus, GitRepo, GitFile, UpdateMode, UpdateInfo } from "@/lib/types";
import { taskStage, taskUnstage, taskCommit, taskDiscard, taskGitBranches, taskGitCheckout, taskGitUpdate, taskGitUpdateInfo, taskGitPush } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { useFileViewed, useIsViewed } from "@/store/fileViewed";
import { useReviewComments } from "@/store/reviewComments";
import { bindingMatches, bindingGlyphs } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { Button } from "@/components/ui/Button";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator, DropdownLabel } from "@/components/ui/Dropdown";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/ContextMenu";
import { Tip } from "@/components/ui/Tooltip";
import { CopyPathItems } from "./CopyPathItems";
import { HistoryPanel, ScopePicker } from "./HistoryPanel";
import { ComparePanel } from "./ComparePanel";
import { fileIconUrl, folderIconUrl } from "@/lib/explorer/iconResolver";

// Per-side status → glyph / color / label. `?` is untracked (rendered as
// a green +, same as a fresh add). Exported so Compare (GH #208)
// renders a status the same way this one does rather than keeping a second
// copy that can drift.
export const SC: Record<string, string>  = { M: "M", A: "+", "?": "+", D: "D", R: "R", C: "C", U: "U" };
export const COL: Record<string, string> = { M: "var(--color-accent)", A: "var(--color-ok)", "?": "var(--color-ok)", D: "var(--color-err)", R: "var(--color-accent)", C: "var(--color-accent)", U: "var(--color-err)" };
export const LBL: Record<string, string> = { M: "modified", A: "added", "?": "untracked", D: "deleted", R: "renamed", C: "copied", U: "conflict" };

export type ViewMode = "tree" | "list" | "combined";

const LS_VIEW   = "gitViewMode";
const LS_HIDE   = "gitHideUntracked";
const LS_RATIO  = "gitSplitRatio";
const LS_PUSH   = "gitPushDefault";
const LS_UCOL   = "gitUnstagedCollapsed";
const LS_SCOL   = "gitStagedCollapsed";
/** Graph section: collapsed by default (the working tree is why you opened
 *  this tab), and its own share of the body once expanded. */
const LS_GCOL   = "gitGraphCollapsed";
/** Changes (the working tree) vs Compare (this branch against a ref, GH #208).
 *  Persisted: someone reviewing a feature flips to Compare and stays there for
 *  the length of the review, across task switches and relaunches. */
const LS_MODE   = "gitPanelMode";
const LS_GRATIO = "gitGraphRatio";

/** Every button on the commit footer, so Push and Commit cannot drift apart.
 *  `box-border` and `leading-none` are the load-bearing half: Push carries a
 *  1px border and Commit does not, and without both of these the border and
 *  the line box each add their own height to one button only. */
const FOOTER_BTN =
  "box-border flex h-7 items-center whitespace-nowrap text-[12.5px] leading-none font-medium transition-colors";

export function readView(): ViewMode {
  try { const v = localStorage.getItem(LS_VIEW); if (v === "tree" || v === "list" || v === "combined") return v; } catch {}
  return "tree";
}
function readBool(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}
function readRatio(key = LS_RATIO, fallback = 0.5): number {
  try { const n = parseFloat(localStorage.getItem(key) || ""); if (n >= 0.1 && n <= 0.9) return n; } catch {}
  return fallback;
}

export function GitPanel({ task, status, refresh, onOpenDiff, onDoubleClickDiff, onOpenCommitDiff, reloadToken = 0 }: {
  task: Task;
  status: GitStatus | null;
  refresh: () => void;
  /** Opens a diff tab for a task-relative path (already prefixed).
   *  `pane` picks the diff's sides (GH #122): staged → HEAD→index,
   *  unstaged → index→worktree. */
  onOpenDiff: (path: string, pane: "unstaged" | "staged") => void;
  onDoubleClickDiff: (path: string) => void;
  /** Opens a diff of one file at one revision, for the Graph section. */
  onOpenCommitDiff?: (path: string, sha: string, title: string) => void;
  /** Same refresh signals the status poll rides, forwarded to the Graph. */
  reloadToken?: number;
}) {
  const pushToast = useUI(s => s.pushToast);
  const nonGit = useApp(s => s.projects.find(p => p.id === task.project_id)?.non_git);
  // Resolved (user-overridable) bindings for the contextual Git shortcuts.
  const stageBinding = usePrefs(s => s.shortcuts["stage-file"]);
  const discardBinding = usePrefs(s => s.shortcuts["discard-file"]);
  const stageGlyph = bindingGlyphs(stageBinding).join("");

  const [activeRepoDir, setActiveRepoDir] = useState<string>("");
  // Dir of a repo the user just committed. Its pill stays visible and focused
  // even once it goes clean, so a commit (or the slower commit-and-push, whose
  // mid-push status poll would otherwise see the repo already clean) doesn't
  // yank the pill away to a different changed repo. Cleared when the user
  // picks another repo or the task switches.
  const [pinnedRepoDir, setPinnedRepoDir] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => readView());
  const [hideUntracked, setHideUntracked] = useState<boolean>(() => readBool(LS_HIDE));
  const [ratio, setRatio] = useState<number>(() => readRatio());
  const [search, setSearch] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushDefault, setPushDefault] = useState<boolean>(() => readBool(LS_PUSH));
  // Section collapse (header-only). Global, not per task, so it is never
  // reset by the task-switch effect below.
  const [unstagedCollapsed, setUnstagedCollapsed] = useState<boolean>(() => readBool(LS_UCOL));
  const [stagedCollapsed, setStagedCollapsed] = useState<boolean>(() => readBool(LS_SCOL));
  // Graph starts collapsed: this tab is opened to stage and commit, and the
  // graph costs a `git log` per repo. One line of chrome until asked for.
  const [graphCollapsed, setGraphCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_GCOL) !== "0"; } catch { return true; }
  });
  const [graphRatio, setGraphRatio] = useState<number>(() => readRatio(LS_GRATIO, 0.5));
  const [mode, setMode] = useState<"changes" | "compare">(() => {
    try { return localStorage.getItem(LS_MODE) === "compare" ? "compare" : "changes"; } catch { return "changes"; }
  });
  const changeMode = (m: "changes" | "compare") => { setMode(m); persist(LS_MODE, m); };
  // Graph scope lives here, not in HistoryPanel: the picker rides the Graph
  // header (this component's markup), so this is where the value it edits has
  // to sit. Reset per repo, since refs belong to one.
  const [graphAll, setGraphAll] = useState(false);
  const [graphRefs, setGraphRefs] = useState<string[]>([]);
  // Collapsed tree folders, keyed `${pane}\0${dirPath}`.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Selected row, keyed `${pane}\0${path}` (a file can sit in both panes
  // when partially staged, so the pane is part of the key). Fork-style:
  // the clicked row stays highlighted and shows its stage button.
  const [selected, setSelected] = useState<string | null>(null);

  const repos = status?.repos ?? [];
  const changedRepos = repos.filter(r => r.changed > 0);
  // Pills show changed repos plus a pinned (just-committed) one, even at 0
  // changes — so the pill the user committed in stays put. Preserves repo order.
  const pinnedExists = !!pinnedRepoDir && repos.some(r => r.dir_name === pinnedRepoDir);
  const visibleRepos = pinnedExists
    ? repos.filter(r => r.changed > 0 || r.dir_name === pinnedRepoDir)
    : changedRepos;

  // Keep the selection on a repo that actually has changes — the pills only
  // list changed repos now, so an activeRepoDir pointing at a clean repo
  // (fresh open, or one that just went clean after a commit) has no pill and
  // must snap to the first changed repo so its files show immediately. The
  // exception is a pinned repo the user just committed: hold focus there.
  useEffect(() => {
    if (repos.length === 0) return;
    if (pinnedExists && activeRepoDir === pinnedRepoDir) return;
    const cur = changedRepos.find(r => r.dir_name === activeRepoDir);
    if (cur) return;
    const next = changedRepos[0] ?? repos[0];
    if (next && next.dir_name !== activeRepoDir) setActiveRepoDir(next.dir_name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, activeRepoDir, pinnedExists]);

  // Reset transient form state on task switch. Skipped on the first run:
  // on mount every value here is already empty, and blanking activeRepoDir
  // would undo the snap the effect above just made — both effects flush in
  // the same commit, so the snap loses, and afterwards its deps are
  // unchanged ("" in, "" out) so it never re-runs. A multi-repo task then
  // sat on repos[0] (the wrapper, usually clean) with an empty file list
  // and no pill selected until the user clicked one.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    setSubject(""); setBody(""); setSearch("");
    setActiveRepoDir(""); setSelected(null); setPinnedRepoDir(null);
  }, [task.id]);

  // Refs belong to one repo, so a repo (or task) switch drops the graph's
  // scope back to Auto. Carrying it would ask for branches the new repo does
  // not have, which the backend answers with an empty graph.
  useEffect(() => { setGraphAll(false); setGraphRefs([]); }, [activeRepoDir, task.id]);

  const persist = (key: string, val: string) => { try { localStorage.setItem(key, val); } catch {} };
  const changeView = (v: ViewMode) => { setViewMode(v); persist(LS_VIEW, v); };
  const toggleHide = () => setHideUntracked(h => { const n = !h; persist(LS_HIDE, n ? "1" : "0"); return n; });
  const toggleUnstagedCollapsed = () => setUnstagedCollapsed(c => { const n = !c; persist(LS_UCOL, n ? "1" : "0"); return n; });
  const toggleStagedCollapsed   = () => setStagedCollapsed(c => { const n = !c; persist(LS_SCOL, n ? "1" : "0"); return n; });
  const toggleGraphCollapsed    = () => setGraphCollapsed(c => { const n = !c; persist(LS_GCOL, n ? "1" : "0"); return n; });

  const repo: GitRepo | undefined = repos.find(r => r.dir_name === activeRepoDir) ?? repos[0];
  // Every group is diffable: the backend's resolve_task_git_path runs
  // git in the group's OWN repo cwd (member.path), so repo_root members
  // (live checkouts that live outside the wrapper subtree) resolve fine —
  // safe_task_path is checked against that member cwd, not the wrapper.
  const clickable = !!repo;

  const filt = (files: GitFile[]) => {
    let out = files;
    if (hideUntracked) out = out.filter(f => f.status !== "?");
    const q = search.trim().toLowerCase();
    if (q) out = out.filter(f => f.path.toLowerCase().includes(q));
    return out;
  };
  const unstaged = useMemo(() => filt(repo?.unstaged ?? []), [repo, hideUntracked, search]);
  const staged   = useMemo(() => filt(repo?.staged   ?? []), [repo, hideUntracked, search]);
  const stagedCount = staged.length;

  // "Viewed" marks (GH #42). Subscribe to this task's map so the per-pane
  // "N/M viewed" header counts re-render when a row is ticked.
  const viewedMap = useFileViewed(s => s.byTask[task.id]);
  const pruneViewed = useFileViewed(s => s.prune);
  // Drop viewed marks for files that no longer have changes (committed /
  // discarded) so localStorage doesn't accumulate dead paths. Keyed by the
  // task-relative path (member files prefixed with their dir_name).
  useEffect(() => {
    if (!status) return;
    const valid = new Set<string>();
    for (const r of status.repos) {
      const pfx = r.dir_name ? `${r.dir_name}/` : "";
      for (const f of r.staged) valid.add(pfx + f.path);
      for (const f of r.unstaged) valid.add(pfx + f.path);
    }
    pruneViewed(task.id, valid);
  }, [status, task.id, pruneViewed]);

  // ── git mutations ──
  const dir = repo?.dir_name ?? "";
  // Count of marked-viewed files in a pane, for its "N/M viewed" header. A
  // file counts only while its stashed fingerprint still matches the live
  // one (an agent edit moves fp and silently clears the mark).
  const countViewed = (files: GitFile[]) =>
    files.reduce((n, f) => n + (f.fp !== "" && viewedMap?.[dir ? `${dir}/${f.path}` : f.path] === f.fp ? 1 : 0), 0);
  // After a single file leaves its pane (stage / unstage / discard), move the
  // selection to the NEXT file in that pane's visual order so files can be
  // worked through in sequence — never linger on the file just acted on. If it
  // was the last file in the pane, clear the selection and close the preview
  // ("pending", italic-titled) diff tab so no stale diff is left open.
  // Drop the selection and close the preview ("pending", italic-titled) diff
  // tab so no stale diff is left open after the last file is gone.
  const closePreviewDiff = useCallback(() => {
    setSelected(null);
    const st = useApp.getState();
    const diff = (st.tabs[task.id] || []).find(t => t.preview && t.type === "diff");
    if (diff) st.closeTab(task.id, diff.id);
  }, [task.id]);

  const focusNext = useCallback((pane: "unstaged" | "staged", path: string) => {
    const list = orderedFiles(pane === "unstaged" ? unstaged : staged, viewMode)
      .map(f => f.path);
    const idx = list.indexOf(path);
    const next = idx >= 0 ? list[idx + 1] : undefined;
    if (next) {
      setSelected(`${pane} ${next}`);
      if (clickable) onOpenDiff(dir ? `${dir}/${next}` : next, pane);
      return;
    }
    closePreviewDiff();
  }, [unstaged, staged, viewMode, clickable, onOpenDiff, dir, closePreviewDiff]);

  // Keep the sidebar selection in lockstep with the open preview diff. The
  // diff pane can move the preview tab on its own (Mark-as-viewed advances to
  // the next file), and that path change must re-highlight the matching row —
  // and switch the active repo sub-tab if the next file lives in another repo.
  // Without this, the row highlight stays stuck on the file you started from.
  const previewDiffPath = useApp(s => {
    const t = (s.tabs[task.id] || []).find(t => t.preview && t.type === "diff");
    return t ? (t as any).path as string : null;
  });
  useEffect(() => {
    if (!previewDiffPath) return;
    for (const r of repos) {
      const pfx = r.dir_name ? `${r.dir_name}/` : "";
      if (pfx && !previewDiffPath.startsWith(pfx)) continue;
      const rel = pfx ? previewDiffPath.slice(pfx.length) : previewDiffPath;
      // Membership check (not just the prefix) disambiguates the host repo
      // (empty dir_name, so its prefix matches everything) from members.
      const pane = r.unstaged.some(f => f.path === rel) ? "unstaged"
        : r.staged.some(f => f.path === rel) ? "staged" : null;
      if (!pane) continue;
      if (r.dir_name !== activeRepoDir) setActiveRepoDir(r.dir_name);
      setSelected(`${pane} ${rel}`);
      return;
    }
  }, [previewDiffPath, repos, activeRepoDir]);

  // Bulk "Stage all" / "Unstage all" leave the selection alone.
  const doStage = (paths: string[]) => {
    if (paths.length === 0) return;
    taskStage(task.id, dir, paths).then(() => {
      if (paths.length === 1) focusNext("unstaged", paths[0]);
      refresh();
    }).catch(e => pushToast(String(e), "error"));
  };
  const doUnstage = (paths: string[]) => {
    if (paths.length === 0) return;
    taskUnstage(task.id, dir, paths).then(() => {
      if (paths.length === 1) focusNext("staged", paths[0]);
      refresh();
    }).catch(e => pushToast(String(e), "error"));
  };

  // Discard always confirms first (irreversible). Shared by the ⇧⌘D shortcut
  // and the right-click menu on both files and folders. `pane` advances the
  // selection to the next file after a single-file discard; multi-path
  // (folder) discards just drop the preview diff.
  const doDiscard = useCallback((paths: string[], opts?: { pane?: "unstaged" | "staged"; label?: string }) => {
    if (paths.length === 0) return;
    const label = opts?.label ?? (paths.length === 1 ? paths[0] : `${paths.length} files`);
    useUI.getState().askConfirm({
      title: "Discard changes",
      message: `Discard all changes to ${label}? This cannot be undone.`,
      confirmLabel: "Discard",
      destructive: true,
    }).then(ok => {
      if (!ok) return;
      taskDiscard(task.id, dir, paths)
        .then(() => {
          if (opts?.pane && paths.length === 1) focusNext(opts.pane, paths[0]);
          else closePreviewDiff();
          // Discard mutates the WORKING TREE (restores tracked files,
          // deletes untracked ones) — a plain refresh() would update git
          // status but leave the file tree listing deleted files and open
          // editors holding the discarded buffer (where a ⌘S would
          // resurrect it). bumpFsRevision fans out to all of them, git
          // status included.
          useApp.getState().bumpFsRevision(task.id);
        })
        .catch(err => pushToast(String(err), "error"));
    });
  }, [task.id, dir, focusNext, closePreviewDiff, pushToast]);

  const doCommit = (push: boolean) => {
    if (!subject.trim() || committing) return;
    setCommitting(true);
    // Pin BEFORE the IPC: commit-and-push leaves the repo clean the moment the
    // commit lands (well before the push returns), so the 4s status poll could
    // fire mid-push and snap the pill away unless the pin is already in place.
    setPinnedRepoDir(dir);
    taskCommit(task.id, dir, subject, body, false, push)
      .then(() => {
        setSubject(""); setBody("");
        // The committed files no longer have changes — drop the now-stale
        // preview diff tab (same as clearing the last staged/unstaged file).
        closePreviewDiff();
        pushToast(push ? "Committed and pushed" : "Committed", "success");
        refresh();
      })
      .catch(e => pushToast(String(e), "error"))
      .finally(() => setCommitting(false));
  };
  const setPush = (push: boolean) => { setPushDefault(push); persist(LS_PUSH, push ? "1" : "0"); doCommit(push); };

  /** Push what is already committed. Pins the repo for the same reason
   *  `doCommit` does: the push clears `ahead`, and an unpinned pill for a
   *  clean repo would vanish under the user mid-action. */
  const doPush = () => {
    if (pushing) return;
    setPushing(true);
    setPinnedRepoDir(dir);
    taskGitPush(task.id, dir)
      .then(() => { pushToast(ahead > 0 ? `Pushed ${ahead} commit${ahead === 1 ? "" : "s"}` : "Pushed", "success"); refresh(); })
      .catch(e => pushToast(String(e), "error"))
      .finally(() => setPushing(false));
  };

  // ── resizable split ──
  // ResizeHandle calls onDrag with the delta since the LAST mousemove, so
  // we MUST accumulate from the latest ratio. Using the render-time `ratio`
  // here would compute every move off the same stale base and make the
  // divider snap back and forth. A functional update reads the live value;
  // a ref carries it into onEnd for the persist.
  // The ratio only applies while both sections show their file list; a
  // collapsed one is header-height and the other takes the rest.
  const bothOpen = !unstagedCollapsed && !stagedCollapsed;
  const bodyRef = useRef<HTMLDivElement>(null);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  const onSplitDrag = (dy: number) => {
    const h = bodyRef.current?.clientHeight ?? 0;
    if (h <= 0) return;
    setRatio(r => Math.min(0.9, Math.max(0.1, r + dy / h)));
  };

  // Same accumulate-from-live-value rule as the staged/unstaged divider, for
  // the one between the working tree and the graph. Measured against the whole
  // body, since that is what the two of them share.
  const graphRatioRef = useRef(graphRatio);
  graphRatioRef.current = graphRatio;
  const onGraphDrag = (dy: number) => {
    const h = bodyRef.current?.clientHeight ?? 0;
    if (h <= 0) return;
    // Dragging DOWN (dy > 0) grows the file lists and shrinks the graph.
    setGraphRatio(r => Math.min(0.9, Math.max(0.1, r - dy / h)));
  };

  // Keyboard shortcuts for the selected file:
  //   ⌘S / Ctrl+S        → stage (if unstaged) / unstage (if staged)
  //   ⇧⌘D / Ctrl+Shift+D → discard changes (confirm first)
  // Capture phase + stopPropagation so ⇧⌘D preempts the global
  // "new bottom-split terminal" binding ONLY when a file is selected and
  // we're not typing; otherwise the event falls through untouched.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isStage = bindingMatches(e, stageBinding);
      const isDiscard = bindingMatches(e, discardBinding);
      if (!isStage && !isDiscard) return;
      if (!selected) return;                 // nothing selected → let others handle
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable || ae.closest?.(".cm-editor"))) {
        return;                              // typing (editor / commit form) wins
      }
      const sp = selected.indexOf(" ");
      if (sp < 0) return;
      const pane = selected.slice(0, sp) as "unstaged" | "staged";
      const path = selected.slice(sp + 1);
      e.preventDefault();
      e.stopPropagation();
      if (isStage) {
        const fn = pane === "unstaged" ? taskStage : taskUnstage;
        fn(task.id, dir, [path]).then(() => {
          focusNext(pane, path);   // advance to the next file in this pane
          refresh();
        }).catch(err => pushToast(String(err), "error"));
      } else {
        doDiscard([path], { pane });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selected, dir, task.id, refresh, pushToast, stageBinding, discardBinding, focusNext, doDiscard]);

  if (!status) {
    return <div className="px-3 py-3 text-[13.5px] text-[var(--color-fg-faint)]">Loading…</div>;
  }
  // A repo termic could not read at all (or a plain folder) has nothing to
  // show and no graph to draw, so it keeps the bare message.
  if (!repo) {
    return (
      <div className="flex h-full flex-col">
        {!nonGit && <BranchBar task={task} branch={status.repos[0]?.branch ?? task.branch} dir="" />}
        <div className="px-3 py-3 text-[13.5px] text-[var(--color-fg-faint)]">
          {nonGit
            ? "Not a git repository. Changes aren't tracked here."
            : "No changes. Working tree is clean."}
        </div>
      </div>
    );
  }
  // A CLEAN tree is not the same thing. It used to take the branch above and
  // return before the toolbar, which meant the Graph and Compare both vanished
  // the moment you committed: the exact moment they became the only two views
  // with anything to say (GH #208). The shell renders either way now and the
  // message takes the file panes' place.
  const clean = status.total_changed === 0 && !pinnedExists;

  // Show repo pills only for repos that actually have changes — even when
  // that's a single repo. Unchanged repos are noise here; the "All files"
  // tab is where you browse repos that aren't currently dirty.
  const showSubTabs = repos.length > 1 && visibleRepos.length > 0;
  const fileWord = stagedCount === 1 ? "File" : "Files";
  const commitDisabled = committing || !subject.trim() || stagedCount === 0;
  const commitLabel = `Commit ${stagedCount} ${fileWord}${pushDefault ? " and Push" : ""}`;
  // Commits the upstream does not have. 0 covers both "in sync" and "no
  // upstream": in the second case the button still works and creates one,
  // which is why it is not disabled on a 0 count.
  const ahead = repo?.ahead ?? 0;
  const pushDisabled = pushing || committing || nonGit;

  // ⌘/Ctrl+Enter from either commit field fires the commit button (the
  // remembered Commit / Commit-and-Push mode), so you never have to reach
  // for the mouse after typing the message.
  const onCommitKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !commitDisabled) {
      e.preventDefault();
      doCommit(pushDefault);
    }
  };

  // Single click: select the row (keeps it highlighted + shows its stage
  // button, Fork-style) and open the diff preview. Works for every group
  // including repo_root members — the backend diffs in the member's own
  // repo cwd, so the file resolves even though it's outside the wrapper.
  void onDoubleClickDiff;
  const activate = (pane: "unstaged" | "staged", p: string) => {
    setSelected(`${pane} ${p}`);
    if (clickable) onOpenDiff(dir ? `${dir}/${p}` : p, pane);
  };

  return (
    <div className="flex h-full flex-col">
      {/* 0. Current branch + switcher (fork-style: stash, checkout, re-apply) */}
      {!nonGit && <BranchBar task={task} branch={repo?.branch ?? task.branch} dir={dir} />}
      {/* 1. Repo sub-tabs (wrapping pills) */}
      {showSubTabs && (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-[var(--color-border-soft)] px-2 py-1.5">
          {visibleRepos.map(r => (
            <button
              key={r.dir_name}
              onClick={() => {
                if (r.dir_name === activeRepoDir) return;
                // Picking another repo releases the just-committed pin, so the
                // clean pill it was holding open can drop away.
                setPinnedRepoDir(null);
                setActiveRepoDir(r.dir_name);
                // The open diff belongs to the previous repo — drop the
                // selection and close the preview diff tab so we don't show
                // a stale file from another repo.
                setSelected(null);
                const st = useApp.getState();
                const diff = (st.tabs[task.id] || []).find(t => t.preview && t.type === "diff");
                if (diff) st.closeTab(task.id, diff.id);
              }}
              title={`${r.name} (${r.branch})`}
              data-testid="repo-pill"
              data-repo-dir={r.dir_name}
              data-active={r.dir_name === activeRepoDir ? "true" : "false"}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[12px] transition-colors",
                r.dir_name === activeRepoDir
                  ? "border-[var(--color-accent)] bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                  : "border-transparent text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
              )}
            >
              <span className="truncate max-w-[140px]">{r.name}</span>
              {r.changed > 0 && (
                <span className="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[var(--color-bg-3)] px-1 text-[10.5px] tabular-nums text-[var(--color-fg-dim)]">
                  {r.changed}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* 2. Toolbar: mode switch + search + view-mode menu. The filter and the
          view mode are shared by both modes deliberately, so flipping between
          them keeps what you typed and where a folder sits. */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-soft)] px-2">
        {!nonGit && (
          <div className="flex shrink-0 items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[2px]">
            {(["changes", "compare"] as const).map(m => (
              <button
                key={m}
                type="button"
                data-testid={`git-mode-${m}`}
                data-active={mode === m ? "true" : "false"}
                onClick={() => changeMode(m)}
                title={m === "changes"
                  ? "What you can stage right now"
                  : "Everything this branch differs by, committed and not"}
                className={cn(
                  "flex h-[18px] items-center rounded-[4px] px-1.5 text-[11px] leading-none transition-colors",
                  mode === m
                    ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]"
                    : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                )}
              >
                {m === "changes" ? "Changes" : "Compare"}
              </button>
            ))}
          </div>
        )}
        <div className="relative flex flex-1 items-center">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter files"
            spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
            className="h-6 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] pl-7 pr-2 text-[12px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)]"
          />
        </div>
        <DropdownRoot>
          <DropdownTrigger asChild>
            <button
              title="View options"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
            >
              {viewMode === "tree" ? <ListTree className="h-4 w-4" /> : viewMode === "combined" ? <Rows3 className="h-4 w-4" /> : <List className="h-4 w-4" />}
            </button>
          </DropdownTrigger>
          <DropdownMenu align="end">
            <ViewItem label="View as Tree"          active={viewMode === "tree"}     onSelect={() => changeView("tree")} />
            <ViewItem label="View as Combined List" active={viewMode === "combined"} onSelect={() => changeView("combined")} />
            <ViewItem label="View as List"          active={viewMode === "list"}     onSelect={() => changeView("list")} />
            <DropdownSeparator />
            <ViewItem label="Hide untracked files" active={hideUntracked} onSelect={toggleHide} />
          </DropdownMenu>
        </DropdownRoot>
      </div>

      {/* 3-5. The upper half (Changes: Unstaged / handle / Staged, or Compare:
          one list against a ref), then the Graph section under it. The two
          split the body: expanded, the graph takes `graphRatio` and the upper
          half the rest, both sides resizable by the divider between them.
          Compare occupies the same slot rather than adding a third section:
          it answers the same question as the staging panes, over a wider
          window, so showing both at once would be two views of one thing. */}
      <div ref={bodyRef} className="relative flex min-h-0 flex-1 flex-col">
      <div
        className="relative flex min-h-0 flex-col"
        style={graphCollapsed
          ? { flex: "1 1 0%", minHeight: 0 }
          : { flexBasis: `${(1 - graphRatio) * 100}%`, flexGrow: 0, flexShrink: 1, minHeight: 0 }}
      >
        {clean && mode === "changes" ? (
          <div className="px-3 py-3 text-[13.5px] text-[var(--color-fg-faint)]">
            No changes. Working tree is clean.
          </div>
        ) : mode === "compare" ? (
          <ComparePanel
            task={task}
            repoDir={dir}
            search={search}
            viewMode={viewMode}
            reloadToken={reloadToken}
            onOpenDiff={(path, sha, title) => onOpenCommitDiff?.(path, sha, title)}
          />
        ) : (<>
        <Pane
          title="Unstaged" files={unstaged} pane="unstaged" viewMode={viewMode}
          collapsed={collapsed} setCollapsed={setCollapsed}
          paneCollapsed={unstagedCollapsed} onTogglePane={toggleUnstagedCollapsed}
          clickable={clickable} selectedKey={selected} stageGlyph={stageGlyph}
          taskId={task.id} viewedCount={countViewed(unstaged)}
          headerAction={unstaged.length > 0 ? { label: "Stage all", onClick: () => doStage(unstaged.map(f => f.path)) } : undefined}
          onRowClick={(p) => activate("unstaged", p)}
          onToggle={doStage}
          onDiscard={(paths) => doDiscard(paths, paths.length === 1 ? { pane: "unstaged" } : undefined)}
          rowActionIcon="down"
          root={task.path} repoDir={dir} truncated={repo?.truncated}
          className={unstagedCollapsed ? "shrink-0" : "min-h-0 flex-1"}
          style={bothOpen ? { flexBasis: `${ratio * 100}%`, flexGrow: 0, flexShrink: 0 } : undefined}
        />
        <div className="relative h-px shrink-0 bg-[var(--color-border-soft)]">
          {bothOpen && (
            <ResizeHandle direction="y" className="top-0" onDrag={onSplitDrag} onEnd={() => persist(LS_RATIO, String(ratioRef.current))} />
          )}
        </div>
        <Pane
          title="Staged" files={staged} pane="staged" viewMode={viewMode}
          collapsed={collapsed} setCollapsed={setCollapsed}
          paneCollapsed={stagedCollapsed} onTogglePane={toggleStagedCollapsed}
          clickable={clickable} selectedKey={selected} stageGlyph={stageGlyph}
          taskId={task.id} viewedCount={countViewed(staged)}
          headerAction={staged.length > 0 ? { label: "Unstage all", onClick: () => doUnstage(staged.map(f => f.path)) } : undefined}
          onRowClick={(p) => activate("staged", p)}
          onToggle={doUnstage}
          onDiscard={(paths) => doDiscard(paths, paths.length === 1 ? { pane: "staged" } : undefined)}
          rowActionIcon="up"
          root={task.path} repoDir={dir}
          className={stagedCollapsed ? "shrink-0" : "min-h-0 flex-1"}
        />
        </>)}
      </div>

      {/* Divider between the working tree and the graph. Only draggable while
          the graph is open; collapsed, its header is the whole section. */}
      <div className="relative h-px shrink-0 bg-[var(--color-border-soft)]">
        {!graphCollapsed && (
          <ResizeHandle direction="y" className="top-0" onDrag={onGraphDrag} onEnd={() => persist(LS_GRATIO, String(graphRatioRef.current))} />
        )}
      </div>

      <div
        className={cn("flex min-h-0 flex-col", graphCollapsed && "shrink-0")}
        style={graphCollapsed ? undefined : { flexBasis: `${graphRatio * 100}%`, flexGrow: 0, flexShrink: 1, minHeight: 0 }}
        data-testid="git-graph-section"
        data-collapsed={graphCollapsed ? "true" : "false"}
      >
        {/* Header row: the disclosure, and the scope picker beside it once
            open. The picker had its own row inside the panel, under a branch
            chip repeating what the BranchBar at the top of this tab already
            says; that was two rows spent on one control. Collapsed, there is
            no graph to scope, so it is not drawn. */}
        <div className="flex h-[26px] w-full shrink-0 items-center gap-1 pr-1.5">
          <button
            data-testid="git-graph-toggle"
            onClick={toggleGraphCollapsed}
            aria-expanded={!graphCollapsed}
            className="flex h-full min-w-0 flex-1 items-center gap-1 px-2 text-left text-[11px] font-semibold tracking-wide text-[var(--color-fg-dim)] uppercase hover:bg-[var(--color-hover)]"
          >
            {graphCollapsed
              ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
              : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />}
            Graph
          </button>
          {!graphCollapsed && (
            <div className="text-[11.5px]">
              <ScopePicker
                taskId={task.id}
                repoDir={dir}
                branch={repo?.branch ?? task.branch ?? ""}
                allBranches={graphAll}
                picked={graphRefs}
                onChange={(all, refs) => { setGraphAll(all); setGraphRefs(refs); }}
              />
            </div>
          )}
        </div>
        {/* Unmounted while collapsed, not hidden: mounted it holds a git log
            per repo and re-reads on every refresh tick. */}
        {!graphCollapsed && (
          <div className="min-h-0 flex-1">
            <HistoryPanel
              task={task}
              repoDir={dir}
              scope={{ allBranches: graphAll, refs: graphRefs }}
              reloadToken={reloadToken}
              onOpenDiff={(path, sha, title) => onOpenCommitDiff?.(path, sha, title)}
            />
          </div>
        )}
      </div>
      </div>

      {/* 6. Commit form. Changes only: the compare list holds committed work
          too, so a "Commit N files" button under it would be counting a
          staging area that is not on screen. */}
      {mode === "changes" && !clean && (
      <div className="flex shrink-0 flex-col gap-1.5 border-t border-[var(--color-border-soft)] p-2">
        <input
          value={subject}
          onChange={e => setSubject(e.target.value)}
          onKeyDown={onCommitKey}
          placeholder="Commit subject"
          spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
          className="h-7 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[13px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)]"
        />
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          onKeyDown={onCommitKey}
          placeholder="Description"
          rows={2}
          spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
          className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[12.5px] leading-snug text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)]"
        />
        {/* Split commit button: main = remembered mode, caret picks.
            Push sits beside it because the commits it sends are usually not
            the one you are about to make: an agent's, or your own from the
            terminal. Its badge is how many are waiting. */}
        <div className="flex items-center justify-end gap-1.5">
          <button
            data-testid="git-push"
            data-ahead={ahead}
            disabled={pushDisabled}
            onClick={doPush}
            title={ahead > 0
              ? `Push ${ahead} commit${ahead === 1 ? "" : "s"} to the remote`
              : "Push this branch to the remote"}
            className={cn(
              FOOTER_BTN,
              "mr-auto shrink-0 gap-1.5 rounded-md border border-[var(--color-border)] px-2.5",
              pushDisabled
                ? "cursor-not-allowed text-[var(--color-fg-faint)] opacity-50"
                : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
            )}
          >
            {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
            {pushing ? "Pushing…" : "Push"}
            {/* Sized as a pill, not as a text box: `h-4` + centering keeps it
                on the button's optical centre line (a bare span inherits the
                button's `leading-none`, so its height was whatever the digits
                happened to be), and `min-w-4` stops "1" from rendering as a
                sliver next to "15". */}
            {ahead > 0 && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent-soft)] px-1 text-[10.5px] leading-none tabular-nums text-[var(--color-accent)]">
                {ahead}
              </span>
            )}
          </button>
          {/* Commit + its caret are one split button, so they sit in their own
              flex box with no gap. The pair is what gives way when the panel is
              narrow: the label truncates on one line instead of wrapping, which
              broke "Commit 0 Files" across two lines and pushed the row past
              the panel's edge. */}
          <div className="flex min-w-0 items-center">
          <button
            disabled={commitDisabled}
            onClick={() => doCommit(pushDefault)}
            title={commitLabel}
            className={cn(
              FOOTER_BTN,
              "min-w-0 truncate rounded-l-md bg-[var(--color-accent)] px-3 text-[var(--color-accent-fg)]",
              commitDisabled ? "cursor-not-allowed opacity-40" : "hover:brightness-110",
            )}
          >
            {committing ? "Committing…" : commitLabel}
          </button>
          <DropdownRoot>
            <DropdownTrigger asChild>
              <button
                disabled={commitDisabled}
                title="Commit options"
                className={cn(
                  FOOTER_BTN,
                  "w-6 shrink-0 justify-center rounded-r-md border-l border-black/15 bg-[var(--color-accent)] text-[var(--color-accent-fg)]",
                  commitDisabled ? "cursor-not-allowed opacity-40" : "hover:brightness-110",
                )}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </DropdownTrigger>
            <DropdownMenu align="end">
              <DropdownItem onSelect={() => setPush(false)}>
                <Check className={cn("h-3.5 w-3.5", pushDefault && "opacity-0")} />
                <span>Commit</span>
              </DropdownItem>
              <DropdownItem onSelect={() => setPush(true)}>
                <Check className={cn("h-3.5 w-3.5", !pushDefault && "opacity-0")} />
                <span>Commit and Push</span>
              </DropdownItem>
            </DropdownMenu>
          </DropdownRoot>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

// Current-branch chip + switcher + update menu (issue #101). The chip shows the
// live branch (from git status, so it's always the true HEAD even after a
// switch). Opening the dropdown lazily lists local branches and resolves what
// the update section can offer; picking a branch does a Fork-style switch
// (stash local work, checkout, re-apply) via task_git_checkout. Update brings
// the branch up to date from its upstream (pull) or the task's base (merge /
// rebase) via task_git_update. Conflicts are surfaced as error toasts, not
// swallowed - the op is left in progress for the user to resolve in the
// terminal.
function BranchBar({ task, branch, dir }: {
  task: Task;
  branch: string;
  dir: string;
}) {
  const pushToast = useUI(s => s.pushToast);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [updating, setUpdating] = useState(false);

  const loadBranches = () => {
    if (loading) return;
    setLoading(true);
    // Settled independently: a task_git_update_info failure must not blank
    // the branch list it happens to share a menu with (Promise.all did, and
    // a binary predating the command rendered "No local branches." on a
    // repo full of them). The update section is optional sugar, so its
    // failure degrades silently to "no Update items"; the switcher is the
    // menu's core and its failure gets the toast.
    Promise.allSettled([taskGitBranches(task.id, dir), taskGitUpdateInfo(task.id, dir)])
      .then(([bs, i]) => {
        if (bs.status === "fulfilled") setBranches(bs.value);
        else pushToast(String(bs.reason), "error");
        setInfo(i.status === "fulfilled" ? i.value : null);
      })
      .finally(() => setLoading(false));
  };

  const runUpdate = (mode: UpdateMode) => {
    if (updating || switching) return;
    setUpdating(true);
    taskGitUpdate(task.id, dir, mode)
      .then(r => {
        setBranches(null);   // stale after an update - reload on next open
        setInfo(null);
        // Merge/rebase rewrote the working tree — refresh the file tree and
        // open editors too, not just git status (same reasoning as discard).
        useApp.getState().bumpFsRevision(task.id);
        const verb = mode === "rebase" ? "Rebase" : "Merge";
        if (r.conflicted) {
          const finish = mode === "rebase"
            ? "then run git rebase --continue."
            : "then commit the result.";
          pushToast(
            `${verb} of ${r.branch} from ${r.target} hit conflicts. Resolve them in the terminal, ${finish}`,
            "error",
            { ttlMs: 8000 },
          );
        } else if (r.stash_conflicted) {
          pushToast(
            `Updated ${r.branch} from ${r.target}, but re-applying your local changes hit conflicts. Resolve them in the terminal; a copy is kept in git stash list.`,
            "error",
            { ttlMs: 8000 },
          );
        } else if (r.up_to_date) {
          pushToast(`${r.branch} is already up to date with ${r.target}.`);
        } else if (r.stashed) {
          pushToast(`Updated ${r.branch} from ${r.target}. Local changes were auto-stashed and restored.`);
        } else {
          pushToast(`Updated ${r.branch} from ${r.target}.`);
        }
      })
      .catch(e => pushToast(String(e), "error"))
      .finally(() => setUpdating(false));
  };

  const switchTo = (target: string) => {
    if (switching || target === branch) return;
    setSwitching(true);
    taskGitCheckout(task.id, dir, target)
      .then(r => {
        setBranches(null);   // stale after a switch - reload on next open
        // Checkout rewrote the working tree — full fan-out, not just status.
        useApp.getState().bumpFsRevision(task.id);
        if (r.conflicted) {
          pushToast(`Switched to ${r.branch}. Your stashed changes conflicted on re-apply; resolve them.`, "error", { ttlMs: 8000 });
        } else if (r.stashed) {
          pushToast(`Switched to ${r.branch}. Local changes stashed and re-applied.`);
        } else {
          pushToast(`Switched to ${r.branch}.`);
        }
      })
      .catch(e => pushToast(String(e), "error"))
      .finally(() => setSwitching(false));
  };

  return (
    <div className="flex h-8 shrink-0 items-center border-b border-[var(--color-border-soft)] px-2">
      {/* Load on OPEN, not on the trigger's onClick: Radix opens the menu on
          pointerdown and its modal layer sets pointer-events:none on the rest
          of the page before the mouse button is released, so with a REAL
          mouse the trigger never receives the click and the load never ran
          ("No local branches." forever). A programmatic .click() bypasses
          hit-testing, which is why tests missed it. */}
      <DropdownRoot onOpenChange={o => { if (o) loadBranches(); }}>
        <DropdownTrigger asChild>
          <button
            disabled={switching || updating}
            title="Switch branch or update from the base (stashes and re-applies local changes)"
            className="flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[12px] transition-colors hover:border-[var(--color-accent-soft)] disabled:opacity-50"
          >
            {switching || updating
              ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-fg-faint)]" />
              : <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />}
            <span className="truncate font-mono text-[var(--color-fg)]">{branch || "detached HEAD"}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-[var(--color-fg-faint)]" />
          </button>
        </DropdownTrigger>
        <DropdownMenu align="start">
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-[var(--color-fg-faint)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading branches…
            </div>
          ) : (
            <>
              {(() => {
                // Pull needs an upstream (task branches are cut --no-track, so
                // it appears only after a first push). Merge / rebase need a
                // base that isn't the branch itself (repo-root and adopted
                // tasks record their own branch as the base).
                const canPull = !!info?.upstream;
                const canBase = !!info?.base && info.base !== info.branch;
                if (!canPull && !canBase) return null;
                return (
                  <>
                    <DropdownLabel>Update</DropdownLabel>
                    {canPull && (
                      <DropdownItem onSelect={() => runUpdate("pull")} className="items-center">
                        <ArrowDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-dim)]" />
                        <span className="truncate text-[12px]">
                          Pull from <span className="font-mono">{info!.upstream}</span>
                        </span>
                      </DropdownItem>
                    )}
                    {canBase && (
                      <>
                        <DropdownItem onSelect={() => runUpdate("merge")} className="items-center">
                          <GitMerge className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-dim)]" />
                          <span className="truncate text-[12px]">
                            Merge <span className="font-mono">{info!.base}</span> into this branch
                          </span>
                        </DropdownItem>
                        <DropdownItem onSelect={() => runUpdate("rebase")} className="items-center">
                          <RotateCw className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-dim)]" />
                          <span className="truncate text-[12px]">
                            Rebase onto <span className="font-mono">{info!.base}</span>
                          </span>
                        </DropdownItem>
                      </>
                    )}
                    <DropdownSeparator />
                  </>
                );
              })()}
              {!branches || branches.length === 0 ? (
                <div className="px-2 py-1.5 text-[12px] text-[var(--color-fg-faint)]">No local branches.</div>
              ) : (
                branches.map(b => (
                  <DropdownItem key={b} onSelect={() => switchTo(b)} className="items-center">
                    <Check className={cn("h-3.5 w-3.5", b !== branch && "opacity-0")} />
                    <span className="truncate font-mono text-[12px]">{b}</span>
                  </DropdownItem>
                ))
              )}
            </>
          )}
        </DropdownMenu>
      </DropdownRoot>
    </div>
  );
}

function ViewItem({ label, active, onSelect }: { label: string; active: boolean; onSelect: () => void }) {
  return (
    <DropdownItem onSelect={onSelect} className="items-center">
      <Check className={cn("h-3.5 w-3.5", !active && "opacity-0")} />
      <span className="text-[13px]">{label}</span>
    </DropdownItem>
  );
}

// ─────────────────────────── pane + file list ───────────────────────────

interface PaneProps {
  title: string;
  files: GitFile[];
  pane: "unstaged" | "staged";
  viewMode: ViewMode;
  collapsed: Set<string>;
  setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** The whole section is collapsed to its header (no file list). */
  paneCollapsed: boolean;
  onTogglePane: () => void;
  clickable: boolean;
  /** Currently selected row key (`${pane} ${path}`), or null. */
  selectedKey: string | null;
  /** Display glyph for the stage/unstage shortcut, e.g. "⌘S". */
  stageGlyph: string;
  /** Owning task id — keys the per-file viewed marks + comment counts. */
  taskId: string;
  /** How many of this pane's files are currently marked viewed (header badge). */
  viewedCount?: number;
  headerAction?: { label: string; onClick: () => void };
  onRowClick: (path: string) => void;
  /** Stage (unstaged pane) or unstage (staged pane) the given paths.
   *  Accepts many so a directory row can act on its whole subtree. */
  onToggle: (paths: string[]) => void;
  /** Discard changes to the given paths (confirms first). Same multi-path
   *  contract as onToggle so a folder row discards its whole subtree. */
  onDiscard: (paths: string[]) => void;
  rowActionIcon: "up" | "down";
  /** Task absolute root + active repo's dir_name. Used to build the
   *  absolute / task-relative paths for the "Copy path" context items.
   *  Git paths are repo-relative, so the task-relative form prefixes
   *  `repoDir` (empty for the host repo). */
  root: string;
  repoDir: string;
  truncated?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

function Pane({
  title, files, pane, viewMode, collapsed, setCollapsed, paneCollapsed, onTogglePane, clickable, selectedKey, stageGlyph,
  taskId, viewedCount = 0, headerAction, onRowClick, onToggle, onDiscard, rowActionIcon, root, repoDir, truncated, className, style,
}: PaneProps) {
  return (
    <div className={cn("flex flex-col overflow-hidden", className)} style={style}>
      <div className="group flex h-7 shrink-0 items-center border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] hover:bg-[var(--color-hover)]">
        <button
          type="button"
          onClick={onTogglePane}
          aria-expanded={!paneCollapsed}
          data-testid="git-pane-header"
          data-pane={pane}
          data-collapsed={paneCollapsed}
          className="flex h-full flex-1 items-center gap-1.5 pl-2.5 pr-1 text-[11.5px] font-medium uppercase tracking-[0.06em] text-[var(--color-fg-dim)] group-hover:text-[var(--color-fg)]"
        >
          {paneCollapsed
            ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
            : <ChevronDown  className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />}
          {title}
          <span className="tabular-nums text-[var(--color-fg-faint)]">{files.length}</span>
          {viewedCount > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-[var(--color-bg-3)] px-1.5 py-px text-[10px] font-medium normal-case tracking-normal text-[var(--color-fg-dim)]">
              <Check className="h-2.5 w-2.5" />
              <span className="tabular-nums">{viewedCount}/{files.length}</span>
            </span>
          )}
        </button>
        {headerAction && (
          <button
            onClick={headerAction.onClick}
            className="mr-2.5 shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
          >
            {headerAction.label}
          </button>
        )}
      </div>
      {!paneCollapsed && truncated && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-2.5 py-1 text-[11px] text-[var(--color-fg-faint)]">
          File list capped at 5 000 entries. Add large dirs to .gitignore.
        </div>
      )}
      {!paneCollapsed && (
        <div className="min-h-0 flex-1 overflow-hidden">
          {files.length === 0 ? (
            <div className="px-3 py-1.5 text-[12px] text-[var(--color-fg-faint)]">
              {pane === "unstaged" ? "Nothing to stage" : "Nothing staged"}
            </div>
          ) : (
            <FileList
              files={files} pane={pane} viewMode={viewMode}
              collapsed={collapsed} setCollapsed={setCollapsed} clickable={clickable}
              selectedKey={selectedKey} stageGlyph={stageGlyph} taskId={taskId}
              onRowClick={onRowClick}
              onToggle={onToggle} onDiscard={onDiscard} rowActionIcon={rowActionIcon}
              root={root} repoDir={repoDir}
            />
          )}
        </div>
      )}
    </div>
  );
}

type FileListProps = Omit<PaneProps, "title" | "headerAction" | "className" | "style" | "paneCollapsed" | "onTogglePane">;

function FileList(props: FileListProps) {
  const { files, viewMode, collapsed, pane } = props;
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

  const rows = useMemo(
    () => flattenRows(files, viewMode, collapsed, pane),
    [files, viewMode, collapsed, pane],
  );

  const ROW_H = 26;
  const OVERSCAN = 5;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const endIdx = Math.min(rows.length - 1, Math.ceil((scrollTop + containerH) / ROW_H) + OVERSCAN);
  const paddingTop = startIdx * ROW_H;
  const paddingBottom = Math.max(0, (rows.length - 1 - endIdx) * ROW_H);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto py-0.5"
      onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
    >
      {paddingTop > 0 && <div style={{ height: paddingTop }} aria-hidden />}
      {rows.slice(startIdx, endIdx + 1).map(row => renderFlatRow(row, props))}
      {paddingBottom > 0 && <div style={{ height: paddingBottom }} aria-hidden />}
    </div>
  );
}

function rowProps(p: FileListProps) {
  return {
    pane: p.pane,
    selectedKey: p.selectedKey,
    stageGlyph: p.stageGlyph,
    taskId: p.taskId,
    clickable: p.clickable,
    onClick: p.onRowClick,
    onToggle: p.onToggle,
    onDiscard: p.onDiscard,
    rowActionIcon: p.rowActionIcon,
    root: p.root,
    repoDir: p.repoDir,
  };
}

/** All file paths under a tree node (the node's whole subtree). Used to
 *  stage/unstage an entire directory from its tree row. */
function collectLeafPaths(node: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    if (n.file) out.push(n.file.path);
    for (const c of n.children.values()) walk(c);
  };
  walk(node);
  return out;
}

// ── virtual-scroll flat rows ──

export type FlatRow =
  | { kind: "file"; file: GitFile; label: string; depth: number }
  | { kind: "dir"; name: string; dirPath: string; depth: number; leaves: string[]; isCollapsed: boolean }
  | { kind: "dirhdr"; label: string };

/** Flatten a file list into rows for the active view mode. Exported because
 *  Compare (GH #208) renders its OWN rows (churn columns, no stage
 *  buttons) but must group and order them exactly like the Commit tab does —
 *  two file lists in the same panel that disagreed about where a folder sits
 *  would read as a bug. `pane` only namespaces the collapsed-folder keys. */
export function flattenRows(files: GitFile[], viewMode: ViewMode, collapsed: Set<string>, pane: string): FlatRow[] {
  if (viewMode === "list") {
    return [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(f => ({ kind: "file" as const, file: f, label: f.path, depth: 0 }));
  }
  if (viewMode === "combined") {
    const groups = new Map<string, GitFile[]>();
    for (const f of files) {
      const slash = f.path.lastIndexOf("/");
      const d = slash === -1 ? "" : f.path.slice(0, slash);
      (groups.get(d) ?? groups.set(d, []).get(d)!).push(f);
    }
    const rows: FlatRow[] = [];
    for (const d of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
      if (d) rows.push({ kind: "dirhdr", label: d });
      for (const f of groups.get(d)!.sort((a, b) => a.path.localeCompare(b.path))) {
        rows.push({ kind: "file", file: f, label: f.path.split("/").pop() || f.path, depth: d ? 1 : 0 });
      }
    }
    return rows;
  }
  // Tree: flatten depth-first, folders before files at each level, respecting collapsed state.
  const root = buildTree(files);
  const rows: FlatRow[] = [];
  const walk = (node: TreeNode, depth: number) => {
    const kids = [...node.children.values()].sort((a, b) => {
      const ad = a.children.size > 0 ? 0 : 1;
      const bd = b.children.size > 0 ? 0 : 1;
      return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
    });
    for (const k of kids) {
      if (k.children.size > 0) {
        const isCollapsed = collapsed.has(`${pane}\0${k.path}`);
        rows.push({ kind: "dir", name: k.name, dirPath: k.path, depth, leaves: collectLeafPaths(k), isCollapsed });
        if (!isCollapsed) walk(k, depth + 1);
      } else if (k.file) {
        rows.push({ kind: "file", file: k.file, label: k.name, depth });
      }
    }
  };
  walk(root, 0);
  return rows;
}

function renderFlatRow(row: FlatRow, props: FileListProps) {
  if (row.kind === "dirhdr") {
    return (
      <div key={`h:${row.label}`} className="truncate px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-dim)]">
        {row.label}
      </div>
    );
  }
  if (row.kind === "dir") {
    return (
      <DirRow
        key={`d:${row.dirPath}`}
        row={row}
        pane={props.pane}
        setCollapsed={props.setCollapsed}
        onToggle={props.onToggle}
        onDiscard={props.onDiscard}
        rowActionIcon={props.rowActionIcon}
        stageGlyph={props.stageGlyph}
        root={props.root}
        repoDir={props.repoDir}
      />
    );
  }
  return <FileRow key={`f:${props.pane}:${row.file.path}`} file={row.file} label={row.label} depth={row.depth} {...rowProps(props)} />;
}

function DirRow({ row, pane, setCollapsed, onToggle, onDiscard, rowActionIcon, stageGlyph, root, repoDir }: {
  row: FlatRow & { kind: "dir" };
  pane: string;
  setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>;
  onToggle: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  rowActionIcon: "up" | "down";
  stageGlyph: string;
  root: string;
  repoDir: string;
}) {
  const { name, dirPath, depth, leaves, isCollapsed } = row;
  const DirActionIcon = rowActionIcon === "down" ? ArrowDown : ArrowUp;
  const dirLabel = rowActionIcon === "down" ? "Stage folder" : "Unstage folder";
  const toggle = useCallback(() => {
    const key = `${pane}\0${dirPath}`;
    setCollapsed(prev => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }, [pane, dirPath, setCollapsed]);
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
        <div
          onClick={toggle}
          className="group flex h-[26px] w-full cursor-pointer items-center gap-1.5 px-2 pr-1 text-left text-[13px] text-[var(--color-fg)]/85 hover:bg-[var(--color-hover)]"
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)] transition-transform", !isCollapsed && "rotate-90")} />
          <img src={folderIconUrl(name, !isCollapsed)} alt="" className="h-4 w-4 shrink-0 file-icon" />
          <span className="truncate flex-1 font-medium">{name}</span>
          <Tip
            side="left"
            content={
              <span className="flex items-center gap-1.5">
                {dirLabel}
                <kbd className="rounded bg-[var(--color-bg-3)] px-1 text-[10.5px] text-[var(--color-fg-faint)]">{stageGlyph}</kbd>
              </span>
            }
          >
            <button
              onClick={(e) => { e.stopPropagation(); onToggle(leaves); }}
              className="shrink-0 rounded p-0.5 text-[var(--color-fg-faint)] opacity-0 hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] group-hover:opacity-100"
            >
              <DirActionIcon className="h-3.5 w-3.5" />
            </button>
          </Tip>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onToggle(leaves)}>
          <DirActionIcon />
          {rowActionIcon === "down" ? "Stage" : "Unstage"} <span className="font-medium">"{name}"</span>
        </ContextMenuItem>
        <ContextMenuItem destructive onSelect={() => onDiscard(leaves)}>
          <Trash2 />
          Discard <span className="font-medium">"{name}"</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <CopyPathItems rel={repoDir ? `${repoDir}/${dirPath}` : dirPath} root={root} isDir />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

// ── tree ──
type TreeNode = { name: string; path: string; file?: GitFile; children: Map<string, TreeNode> };

/** Flatten files into the exact top-to-bottom order the given view renders
 *  them, so "go to the next file" (focusNext, diff-pane Mark-as-viewed)
 *  follows what the eye sees. Tree view puts folders before files at each
 *  level — a flat path sort would interleave them and make the next file
 *  jump around (GH: diff-pane advance order). */
export function orderedFiles(files: GitFile[], viewMode: ViewMode): GitFile[] {
  if (viewMode === "list") {
    return [...files].sort((a, b) => a.path.localeCompare(b.path));
  }
  if (viewMode === "combined") {
    const groups = new Map<string, GitFile[]>();
    for (const f of files) {
      const slash = f.path.lastIndexOf("/");
      const d = slash === -1 ? "" : f.path.slice(0, slash);
      (groups.get(d) ?? groups.set(d, []).get(d)!).push(f);
    }
    return [...groups.keys()]
      .sort((a, b) => a.localeCompare(b))
      .flatMap(d => groups.get(d)!.sort((a, b) => a.path.localeCompare(b.path)));
  }
  // Tree: folders-first depth-first, mirroring TreeView's per-level sort.
  const root = buildTree(files);
  const out: GitFile[] = [];
  const walk = (node: TreeNode) => {
    const kids = [...node.children.values()].sort((a, b) => {
      const ad = a.children.size > 0 ? 0 : 1;
      const bd = b.children.size > 0 ? 0 : 1;
      return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
    });
    for (const k of kids) {
      if (k.children.size > 0) walk(k);
      else if (k.file) out.push(k.file);
    }
  };
  walk(root);
  return out;
}

function buildTree(files: GitFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const childPath = node.path ? `${node.path}/${part}` : part;
      let child = node.children.get(part);
      if (!child) { child = { name: part, path: childPath, children: new Map() }; node.children.set(part, child); }
      if (i === parts.length - 1) child.file = f;
      node = child;
    }
  }
  return root;
}

function TreeView(props: FileListProps) {
  const { files, pane, collapsed, setCollapsed, onToggle, onDiscard, rowActionIcon, stageGlyph, root, repoDir } = props;
  const tree = useMemo(() => buildTree(files), [files]);
  const DirActionIcon = rowActionIcon === "down" ? ArrowDown : ArrowUp;

  const toggle = (path: string) => {
    const key = `${pane}\0${path}`;
    setCollapsed(prev => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  };

  const render = (node: TreeNode, depth: number): React.ReactNode[] => {
    const kids = [...node.children.values()].sort((a, b) => {
      const ad = a.children.size > 0 ? 0 : 1;
      const bd = b.children.size > 0 ? 0 : 1;
      return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
    });
    const out: React.ReactNode[] = [];
    for (const k of kids) {
      if (k.children.size > 0) {
        const key = `${pane}\0${k.path}`;
        const isCollapsed = collapsed.has(key);
        const dirLabel = rowActionIcon === "down" ? "Stage folder" : "Unstage folder";
        const leaves = collectLeafPaths(k);
        out.push(
          <ContextMenuRoot key={`d:${k.path}`}>
            <ContextMenuTrigger asChild>
              <div
                onClick={() => toggle(k.path)}
                className="group flex h-[26px] w-full cursor-pointer items-center gap-1.5 px-2 pr-1 text-left text-[13px] text-[var(--color-fg)]/85 hover:bg-[var(--color-hover)]"
                style={{ paddingLeft: 6 + depth * 12 }}
              >
                <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)] transition-transform", !isCollapsed && "rotate-90")} />
                <img src={folderIconUrl(k.name, !isCollapsed)} alt="" className="h-4 w-4 shrink-0 file-icon" />
                <span className="truncate flex-1 font-medium">{k.name}</span>
                <Tip
                  side="left"
                  content={
                    <span className="flex items-center gap-1.5">
                      {dirLabel}
                      <kbd className="rounded bg-[var(--color-bg-3)] px-1 text-[10.5px] text-[var(--color-fg-faint)]">{stageGlyph}</kbd>
                    </span>
                  }
                >
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggle(leaves); }}
                    className="shrink-0 rounded p-0.5 text-[var(--color-fg-faint)] opacity-0 hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] group-hover:opacity-100"
                  >
                    <DirActionIcon className="h-3.5 w-3.5" />
                  </button>
                </Tip>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {/* Git actions first (stage + discard), then path/finder items. */}
              <ContextMenuItem onSelect={() => onToggle(leaves)}>
                <DirActionIcon />
                {rowActionIcon === "down" ? "Stage" : "Unstage"} <span className="font-medium">"{k.name}"</span>
              </ContextMenuItem>
              <ContextMenuItem destructive onSelect={() => onDiscard(leaves)}>
                <Trash2 />
                Discard <span className="font-medium">"{k.name}"</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <CopyPathItems rel={repoDir ? `${repoDir}/${k.path}` : k.path} root={root} isDir />
            </ContextMenuContent>
          </ContextMenuRoot>,
        );
        if (!isCollapsed) out.push(...render(k, depth + 1));
      } else if (k.file) {
        out.push(<FileRow key={`f:${k.path}`} file={k.file} label={k.name} depth={depth} {...rowProps(props)} />);
      }
    }
    return out;
  };

  return <>{render(tree, 0)}</>;
}

// ── row ──
// Single click selects (highlight + persistent action button) and opens
// the diff preview. Double click stages / unstages (same as the trailing
// arrow button). The arrow + the staging double-click work even on
// non-clickable repo_root rows (no diff there, but staging is fine).
function FileRow({ file, label, depth = 0, pane, selectedKey, stageGlyph, taskId, clickable, onClick, onToggle, onDiscard, rowActionIcon, root, repoDir }: {
  file: GitFile;
  label: string;
  depth?: number;
  pane: "unstaged" | "staged";
  selectedKey: string | null;
  stageGlyph: string;
  taskId: string;
  clickable: boolean;
  onClick: (p: string) => void;
  onToggle: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  rowActionIcon: "up" | "down";
  root: string;
  repoDir: string;
}) {
  const key = file.status;
  const ActionIcon = rowActionIcon === "down" ? ArrowDown : ArrowUp;
  const actionLabel = rowActionIcon === "down" ? "Stage" : "Unstage";
  const selected = selectedKey === `${pane} ${file.path}`;
  // Task-relative path: how viewed marks + review comments key a file
  // (matches the diff tab's path, prefixed for member repos).
  const fullPath = repoDir ? `${repoDir}/${file.path}` : file.path;
  const viewed = useIsViewed(taskId, fullPath, file.fp);
  // Live count of pending inline comments left on this file (GH #28). A
  // primitive return keeps the selector reference-stable.
  const commentCount = useReviewComments(s => {
    const arr = s.byTask[taskId];
    if (!arr) return 0;
    let n = 0;
    for (const c of arr) if (c.file === fullPath) n++;
    return n;
  });
  // A deletion has no working-tree file to fingerprint (fp === ""), so the
  // viewed mark can't anchor to content — hide the checkbox there.
  const canView = file.fp !== "";
  const toggleViewed = (e: React.MouseEvent) => {
    e.stopPropagation();
    useFileViewed.getState().toggle(taskId, fullPath, file.fp);
  };
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
    <div
      className={cn(
        "group flex h-[26px] w-full items-center gap-2 border-l-2 pr-2.5 text-[13px]",
        selected
          ? "border-[var(--color-accent)] bg-[var(--color-sel)] text-[var(--color-fg)]"
          : cn(
              "border-transparent text-[var(--color-fg-dim)]",
              clickable ? "hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]" : "opacity-80",
            ),
        clickable ? "cursor-pointer" : "cursor-default",
      )}
      // 2px accent bar eats into the left pad; subtract it so glyphs don't shift.
      style={{ paddingLeft: 6 + depth * 12 + 8 - 2 }}
      title={`${LBL[key] || key}: ${file.path}`}
      data-testid="git-file-row"
      data-pane={pane}
      data-path={file.path}
      onClick={() => onClick(file.path)}
      onDoubleClick={() => onToggle([file.path])}
    >
      <span
        className="inline-flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded px-0.5 text-[10.5px] font-semibold text-black"
        style={{ background: COL[key] || "var(--color-fg-dim)" }}
      >{SC[key] || key}</span>
      <img src={fileIconUrl(label)} alt="" className={cn("h-4 w-4 shrink-0 file-icon", viewed && !selected && "opacity-50")} />
      {/* Same face and size as the All files tree (13px, medium, not mono).
          A changed file and the same file in the tree are the same object;
          rendering one in monospace made them read as different kinds of
          thing, and mono is wider, so long paths truncated sooner. */}
      <span className={cn("truncate flex-1 font-medium", viewed && !selected && "text-[var(--color-fg-faint)] line-through decoration-[var(--color-fg-faint)]/40")}>{label}</span>
      {commentCount > 0 && (
        <Tip side="left" content={`${commentCount} inline ${commentCount === 1 ? "comment" : "comments"}`}>
          <span className="flex shrink-0 items-center gap-0.5 rounded bg-[var(--color-bg-3)] px-1 text-[10.5px] tabular-nums text-[var(--color-fg-dim)]">
            <MessageSquare className="h-2.5 w-2.5" />
            {commentCount}
          </span>
        </Tip>
      )}
      {canView && (
        <Tip side="left" content={viewed ? "Mark as not viewed" : "Mark as viewed"}>
          <button
            onClick={toggleViewed}
            aria-pressed={viewed}
            // An eye, not a checkbox: a tickbox next to the stage arrow reads
            // as "stage this" (every git client uses checkboxes for staging).
            // The eye says "seen" and shares no vocabulary with staging.
            className={cn(
              "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded transition-colors",
              viewed
                ? "text-[var(--color-accent)]"
                : cn(
                    "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                    // Faintly present so the feature is discoverable, but quiet
                    // until the row is hovered/selected.
                    selected ? "opacity-100" : "opacity-30 group-hover:opacity-100",
                  ),
            )}
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
        </Tip>
      )}
      <Tip
        side="left"
        content={
          <span className="flex items-center gap-1.5">
            {rowActionIcon === "down" ? "Stage" : "Unstage"}
            <kbd className="rounded bg-[var(--color-bg-3)] px-1 text-[10.5px] text-[var(--color-fg-faint)]">{stageGlyph}</kbd>
          </span>
        }
      >
        <button
          onClick={(e) => { e.stopPropagation(); onToggle([file.path]); }}
          className={cn(
            "shrink-0 rounded p-0.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]",
            // Visible while hovering the row OR when the row is selected,
            // matching Fork (the focused file keeps its stage button).
            selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <ActionIcon className="h-3.5 w-3.5" />
        </button>
      </Tip>
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {/* Git actions first (stage + discard), then the path/finder items. */}
        <ContextMenuItem onSelect={() => onToggle([file.path])}>
          <ActionIcon />
          {actionLabel}
        </ContextMenuItem>
        <ContextMenuItem destructive onSelect={() => onDiscard([file.path])}>
          <Trash2 />
          Discard changes
        </ContextMenuItem>
        {canView && (
          <ContextMenuItem onSelect={() => useFileViewed.getState().toggle(taskId, fullPath, file.fp)}>
            <Check />
            {viewed ? "Mark as not viewed" : "Mark as viewed"}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <CopyPathItems rel={fullPath} root={root} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
