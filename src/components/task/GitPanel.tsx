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
import { useTranslation, Trans } from "react-i18next";
import {
  ChevronRight, ChevronDown, ArrowDown, ArrowUp, List, ListTree, Rows3, Check, Eye, Search, Trash2, MessageSquare, Loader2, GitBranch, GitMerge, RotateCw, FileText,
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
import { PrCard } from "./PrCard";
import { usePr } from "@/store/pr";

// Per-side status → glyph / fill / ink / label, shared with Compare (GH #208)
// so the two panels cannot drift. Re-exported here because this is where they
// used to live and DiffPane / ComparePanel import from this module.
import { SC, COL, INK, LBL } from "@/lib/gitStatus";
export { SC, COL, INK, LBL };

export type ViewMode = "tree" | "list" | "combined";

const LS_VIEW   = "gitViewMode";
const LS_HIDE   = "gitHideUntracked";
const LS_RATIO  = "gitSplitRatio";
const LS_PUSH   = "gitPushDefault";
const LS_UCOL   = "gitUnstagedCollapsed";
const LS_SCOL   = "gitStagedCollapsed";
/** Which of the three views the Git tab is on. Persisted: someone reviewing a
 *  feature sits in Compare or History for the length of the review, across
 *  task switches and relaunches. */
const LS_VIEWTAB = "gitPanelView";

/** The three questions this tab answers, as one control. Commit is the only
 *  one you ACT in (stage, discard, commit, push); the other two are read-only
 *  views of what the branch has already done. */
export type GitView = "commit" | "compare" | "history";
// Labels/titles are i18n keys into the gitPanel subtree, resolved at render.
const GIT_VIEWS: { id: GitView; labelKey: string; titleKey: string }[] = [
  { id: "commit",  labelKey: "gitPanel.viewCommit",  titleKey: "gitPanel.viewCommitTitle" },
  { id: "compare", labelKey: "gitPanel.viewCompare", titleKey: "gitPanel.viewCompareTitle" },
  { id: "history", labelKey: "gitPanel.viewHistory", titleKey: "gitPanel.viewHistoryTitle" },
];
function readGitView(): GitView {
  try {
    const v = localStorage.getItem(LS_VIEWTAB);
    if (v === "compare" || v === "history") return v;
  } catch {}
  return "commit";
}

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

export function GitPanel({ task, status, refresh, onOpenDiff, onOpenFile, onDoubleClickDiff, onOpenCommitDiff, onOpenCompareDiff, reloadToken = 0 }: {
  task: Task;
  status: GitStatus | null;
  refresh: () => void;
  /** Opens a diff tab for a task-relative path (already prefixed).
   *  `pane` picks the diff's sides (GH #122): staged → HEAD→index,
   *  unstaged → index→worktree. */
  onOpenDiff: (path: string, pane: "unstaged" | "staged") => void;
  /** Opens the WHOLE file (an editor tab) for a task-relative path, instead
   *  of its diff. A diff is the wrong reader for a file that is mostly new:
   *  a doc added in one commit renders as an unbroken wall of `+`, and a
   *  markdown file loses its preview entirely. Same path shape as
   *  onOpenDiff, so member repos are already prefixed. */
  onOpenFile: (path: string) => void;
  onDoubleClickDiff: (path: string) => void;
  /** Opens a diff of one file at one revision, for the Graph section:
   *  `sha^` against `sha`, no working-tree side. */
  onOpenCommitDiff?: (path: string, sha: string, title: string) => void;
  /** Opens a compare diff: the base commit against the LIVE file. A separate
   *  prop from onOpenCommitDiff because the two produce different SIDES from
   *  the same-looking (path, sha, title) call. Routing Compare through the
   *  commit opener made every compare diff read as a historical one, losing
   *  the working-tree right side and with it the review affordances that are
   *  the whole reason to review from here. */
  onOpenCompareDiff?: (path: string, baseSha: string, title: string) => void;
  /** Same refresh signals the status poll rides, forwarded to the Graph. */
  reloadToken?: number;
}) {
  const { t } = useTranslation("panels");
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
  const [view, setView] = useState<GitView>(() => readGitView());
  const changeView = (v: GitView) => { setView(v); persist(LS_VIEWTAB, v); };
  // The blame popup's "Show in History": RightPanel has already put this tab on
  // screen, and the Graph is the only view that can show a commit.
  const commitReveal = useUI(s => s.commitReveal);
  const seenRevealAt = useRef(0);
  useEffect(() => {
    if (!commitReveal || commitReveal.taskId !== task.id) return;
    if (commitReveal.at === seenRevealAt.current) return;
    seenRevealAt.current = commitReveal.at;
    changeView("history");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitReveal, task.id]);
  // History's scope lives here, not in HistoryPanel: the picker rides this
  // component's sub-tab row, so this is where the value it edits has to sit.
  // Reset per repo, since refs belong to one.
  const [graphAll, setGraphAll] = useState(false);
  const [graphRefs, setGraphRefs] = useState<string[]>([]);
  const [graphFirstParent, setGraphFirstParent] = useState(false);
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
  useEffect(() => { setGraphAll(false); setGraphRefs([]); setGraphFirstParent(false); }, [activeRepoDir, task.id]);

  const persist = (key: string, val: string) => { try { localStorage.setItem(key, val); } catch {} };
  const changeViewMode = (v: ViewMode) => { setViewMode(v); persist(LS_VIEW, v); };
  const toggleHide = () => setHideUntracked(h => { const n = !h; persist(LS_HIDE, n ? "1" : "0"); return n; });
  const toggleUnstagedCollapsed = () => setUnstagedCollapsed(c => { const n = !c; persist(LS_UCOL, n ? "1" : "0"); return n; });
  const toggleStagedCollapsed   = () => setStagedCollapsed(c => { const n = !c; persist(LS_SCOL, n ? "1" : "0"); return n; });

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
  // No prune here (GH #248). This pane sees only UNCOMMITTED files, but the
  // viewed map is shared with the Compare panel's branch diff, so pruning
  // against this list wiped every Compare mark the moment an agent committed.
  // Marks expire per file via their fingerprint; dead tasks are cleaned up in
  // app.loadAll. See store/fileViewed.ts.

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
    const label = opts?.label ?? (paths.length === 1 ? paths[0] : t("shared.fileMany", { count: paths.length }));
    useUI.getState().askConfirm({
      title: t("gitPanel.discardTitle"),
      message: t("gitPanel.discardMessage", { label }),
      confirmLabel: t("gitPanel.discardConfirm"),
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
  }, [task.id, dir, focusNext, closePreviewDiff, pushToast, t]);

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
        pushToast(push ? t("gitPanel.committedPushed") : t("gitPanel.committed"), "success");
        refresh();
        // A push is the moment PR state likely changes (new commits on an
        // open PR, or the user is about to create one) - poll right away.
        if (push) usePr.getState().refresh(task.id, true);
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
      .then(() => {
        pushToast(ahead > 0
          ? (ahead === 1 ? t("gitPanel.pushedOne") : t("gitPanel.pushedMany", { count: ahead }))
          : t("gitPanel.pushed"), "success");
        refresh();
        usePr.getState().refresh(task.id, true);
      })
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
    return <div className="px-3 py-3 text-[13.5px] text-[var(--color-fg-faint)]">{t("shared.loading")}</div>;
  }
  // A repo termic could not read at all (or a plain folder) has nothing to
  // show and no graph to draw, so it keeps the bare message.
  if (!repo) {
    return (
      <div className="flex h-full flex-col">
        {!task.is_main_checkout && <PrCard task={task} />}
        {!nonGit && <BranchBar task={task} branch={status.repos[0]?.branch ?? task.branch} dir="" />}
        <div className="px-3 py-3 text-[13.5px] text-[var(--color-fg-faint)]">
          {nonGit
            ? t("gitPanel.notGit")
            : t("gitPanel.clean")}
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
  const commitDisabled = committing || !subject.trim() || stagedCount === 0;
  const commitLabel = pushDefault
    ? (stagedCount === 1 ? t("gitPanel.commitFileAndPush", { count: stagedCount }) : t("gitPanel.commitFilesAndPush", { count: stagedCount }))
    : (stagedCount === 1 ? t("gitPanel.commitFile", { count: stagedCount }) : t("gitPanel.commitFiles", { count: stagedCount }));
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

  // The other half of a row: open the file itself rather than its diff. The
  // row stays selected either way, so switching between the two readings of
  // one file never loses your place in the list. Prefixing with `dir` here
  // (not in the row) keeps every path this panel hands out task-relative,
  // exactly like `activate`.
  const openWholeFile = (pane: "unstaged" | "staged", p: string) => {
    setSelected(`${pane} ${p}`);
    if (clickable) onOpenFile(dir ? `${dir}/${p}` : p);
  };

  return (
    <div className="flex h-full flex-col">
      {/* A main checkout sits on the project's default branch by definition
          (see archiveTask.ts's own no-branch-to-delete reasoning) - there is
          never a PR/MR whose head is that branch, so there's nothing here
          worth polling for. */}
      {!task.is_main_checkout && <PrCard task={task} />}
      {/* 0. Repo sub-tabs (wrapping pills). OUTERMOST of the three controls
          here: which repo you are looking at is what the branch bar and all
          three sub-tabs below are ABOUT, so it cannot sit inside them. */}
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

      {/* 1. Current branch + switcher (fork-style: stash, checkout, re-apply),
          for the repo selected above. */}
      {!nonGit && (
        <BranchBar
          task={task}
          branch={repo?.branch ?? task.branch}
          dir={dir}
          right={<div className="relative ml-auto flex min-w-[30%] flex-1 items-center">
            <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={view === "history" ? t("gitPanel.searchMessages") : t("gitPanel.filterPlaceholder")}
              title={t("gitPanel.filterTip")}
              spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
              className="h-6 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] pl-7 pr-2 text-[12px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)]"
            />
          </div>}
        />
      )}

      {/* 2. Sub-tabs, plus whatever chrome the active one needs on the SAME
          row. Two rows of tabs would be a lot for a panel that drags down to
          220px, and the file filter is meaningless in History, so History
          hands that half of the row to the ref picker instead. */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-soft)] px-2">
        <div className="flex shrink-0 items-stretch gap-0.5">
          {GIT_VIEWS.map(v => (
            <button
              key={v.id}
              type="button"
              data-testid={`git-view-${v.id}`}
              data-active={view === v.id ? "true" : "false"}
              onClick={() => changeView(v.id)}
              title={t(v.titleKey)}
              className={cn(
                "flex h-6 items-center rounded-md px-1.5 text-[11.5px] leading-none transition-colors",
                view === v.id
                  ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]"
                  : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
              )}
            >
              {t(v.labelKey)}
            </button>
          ))}
        </div>
        {view === "history" ? (
          <div className="ml-auto flex min-w-0 items-center text-[11.5px]">
            <ScopePicker
              taskId={task.id}
              repoDir={dir}
              branch={repo?.branch ?? task.branch}
              allBranches={graphAll}
              picked={graphRefs}
              firstParent={graphFirstParent}
              onChange={(all, refs, fp) => { setGraphAll(all); setGraphRefs(refs); setGraphFirstParent(fp); }}
            />
          </div>
        ) : (
          <DropdownRoot>
            <DropdownTrigger asChild>
              <button
                title={t("gitPanel.viewOptions")}
                className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
              >
                {viewMode === "tree" ? <ListTree className="h-4 w-4" /> : viewMode === "combined" ? <Rows3 className="h-4 w-4" /> : <List className="h-4 w-4" />}
              </button>
            </DropdownTrigger>
            <DropdownMenu align="end">
              <ViewItem label={t("gitPanel.viewTree")}          active={viewMode === "tree"}     onSelect={() => changeViewMode("tree")} />
              <ViewItem label={t("gitPanel.viewCombined")} active={viewMode === "combined"} onSelect={() => changeViewMode("combined")} />
              <ViewItem label={t("gitPanel.viewList")}          active={viewMode === "list"}     onSelect={() => changeViewMode("list")} />
              <DropdownSeparator />
              <ViewItem label={t("gitPanel.hideUntracked")} active={hideUntracked} onSelect={toggleHide} />
            </DropdownMenu>
          </DropdownRoot>
        )}
      </div>

      {/* 3-5. The body: whichever view is active, at full height. The graph
          used to live in a collapsible section under the file lists, sharing
          the body by a draggable ratio. It is the one view here that wants
          vertical space and it was getting whatever two file lists left over,
          so it is a sub-tab now and the collapse flag, the ratio, the divider
          and their two localStorage keys are gone with it. */}
      <div ref={bodyRef} className="relative flex min-h-0 flex-1 flex-col">
        {clean && view === "commit" ? (
          <div className="px-3 py-3 text-[13.5px] text-[var(--color-fg-faint)]">
            {t("gitPanel.clean")}
          </div>
        ) : view === "history" ? (
          <HistoryPanel
            task={task}
            repoDir={dir}
            scope={{ allBranches: graphAll, refs: graphRefs, firstParent: graphFirstParent }}
            search={search}
            reloadToken={reloadToken}
            onOpenDiff={(path, sha, title) => onOpenCommitDiff?.(path, sha, title)}
          />
        ) : view === "compare" ? (
          <ComparePanel
            task={task}
            repoDir={dir}
            search={search}
            viewMode={viewMode}
            reloadToken={reloadToken}
            onOpenDiff={(path, sha, title) => onOpenCompareDiff?.(path, sha, title)}
            onOpenFile={onOpenFile}
          />
        ) : (<>
        <Pane
          title={t("gitPanel.unstaged")} files={unstaged} pane="unstaged" viewMode={viewMode}
          collapsed={collapsed} setCollapsed={setCollapsed}
          paneCollapsed={unstagedCollapsed} onTogglePane={toggleUnstagedCollapsed}
          clickable={clickable} selectedKey={selected} stageGlyph={stageGlyph}
          taskId={task.id} viewedCount={countViewed(unstaged)}
          headerAction={unstaged.length > 0 ? { label: t("gitPanel.stageAll"), onClick: () => doStage(unstaged.map(f => f.path)) } : undefined}
          onRowClick={(p) => activate("unstaged", p)}
          onRowOpenFile={(p) => openWholeFile("unstaged", p)}
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
          title={t("gitPanel.staged")} files={staged} pane="staged" viewMode={viewMode}
          collapsed={collapsed} setCollapsed={setCollapsed}
          paneCollapsed={stagedCollapsed} onTogglePane={toggleStagedCollapsed}
          clickable={clickable} selectedKey={selected} stageGlyph={stageGlyph}
          taskId={task.id} viewedCount={countViewed(staged)}
          headerAction={staged.length > 0 ? { label: t("gitPanel.unstageAll"), onClick: () => doUnstage(staged.map(f => f.path)) } : undefined}
          onRowClick={(p) => activate("staged", p)}
          onRowOpenFile={(p) => openWholeFile("staged", p)}
          onToggle={doUnstage}
          onDiscard={(paths) => doDiscard(paths, paths.length === 1 ? { pane: "staged" } : undefined)}
          rowActionIcon="up"
          root={task.path} repoDir={dir}
          className={stagedCollapsed ? "shrink-0" : "min-h-0 flex-1"}
        />
        </>)}
      </div>

      {/* 6. Commit form. Changes only: the compare list holds committed work
          too, so a "Commit N files" button under it would be counting a
          staging area that is not on screen. */}
      {view === "commit" && !clean && (
      <div className="flex shrink-0 flex-col gap-1.5 border-t border-[var(--color-border-soft)] p-2">
        <input
          value={subject}
          onChange={e => setSubject(e.target.value)}
          onKeyDown={onCommitKey}
          placeholder={t("gitPanel.commitSubject")}
          spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
          className="h-7 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[13px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)]"
        />
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          onKeyDown={onCommitKey}
          placeholder={t("gitPanel.description")}
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
              ? (ahead === 1 ? t("gitPanel.pushTipOne") : t("gitPanel.pushTipMany", { count: ahead }))
              : t("gitPanel.pushTipNew")}
            className={cn(
              FOOTER_BTN,
              "mr-auto shrink-0 gap-1.5 rounded-md border border-[var(--color-border)] px-2.5",
              pushDisabled
                ? "cursor-not-allowed text-[var(--color-fg-faint)] opacity-50"
                : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
            )}
          >
            {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
            {pushing ? t("gitPanel.pushing") : t("gitPanel.push")}
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
            {committing ? t("gitPanel.committing") : commitLabel}
          </button>
          <DropdownRoot>
            <DropdownTrigger asChild>
              <button
                disabled={commitDisabled}
                title={t("gitPanel.commitOptions")}
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
                <span>{t("gitPanel.commitItem")}</span>
              </DropdownItem>
              <DropdownItem onSelect={() => setPush(true)}>
                <Check className={cn("h-3.5 w-3.5", !pushDefault && "opacity-0")} />
                <span>{t("gitPanel.commitAndPush")}</span>
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
function BranchBar({ task, branch, dir, right }: {
  task: Task;
  branch: string;
  dir: string;
  /** Rendered on the right of the same row. The branch chip is one short
   *  control on a full-width row, so the filter rides with it rather than
   *  spending a row of its own in a panel that drags down to 220px. */
  right?: React.ReactNode;
}) {
  const { t } = useTranslation("panels");
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
        if (r.conflicted) {
          pushToast(
            mode === "rebase"
              ? t("gitPanel.rebaseConflict", { branch: r.branch, target: r.target })
              : t("gitPanel.mergeConflict", { branch: r.branch, target: r.target }),
            "error",
            { ttlMs: 8000 },
          );
        } else if (r.stash_conflicted) {
          pushToast(
            t("gitPanel.stashConflict", { branch: r.branch, target: r.target }),
            "error",
            { ttlMs: 8000 },
          );
        } else if (r.up_to_date) {
          pushToast(t("gitPanel.upToDate", { branch: r.branch, target: r.target }));
        } else if (r.stashed) {
          pushToast(t("gitPanel.updatedStashed", { branch: r.branch, target: r.target }));
        } else {
          pushToast(t("gitPanel.updated", { branch: r.branch, target: r.target }));
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
          pushToast(t("gitPanel.switchedConflict", { branch: r.branch }), "error", { ttlMs: 8000 });
        } else if (r.stashed) {
          pushToast(t("gitPanel.switchedStashed", { branch: r.branch }));
        } else {
          pushToast(t("gitPanel.switched", { branch: r.branch }));
        }
      })
      .catch(e => pushToast(String(e), "error"))
      .finally(() => setSwitching(false));
  };

  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-soft)] px-2">
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
            data-testid="branch-chip"
            title={t("gitPanel.branchChipTip")}
            className={cn(
              "flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[12px] transition-colors hover:border-[var(--color-accent-soft)] disabled:opacity-50",
              // Only when it SHARES the row. The chip is sized to its content
              // and `right` is a flex-basis-0 item, so a basis-0 item absorbs
              // none of the shrink: a long branch name took the whole row and
              // left the filter its padding (a ~36px stub with no room for a
              // character). The 30% floor on `right` is what actually reserves
              // the space; this cap is the same rule said from this side, and
              // it subtracts the row's gap so the two do not add up past 100%
              // and push each other out.
              right && "max-w-[calc(70%_-_0.375rem)]",
            )}
          >
            {switching || updating
              ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-fg-faint)]" />
              : <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />}
            <span className="truncate font-mono text-[var(--color-fg)]">{branch || t("shared.detachedHead")}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-[var(--color-fg-faint)]" />
          </button>
        </DropdownTrigger>
        <DropdownMenu align="start">
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-[var(--color-fg-faint)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("gitPanel.loadingBranches")}
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
                    <DropdownLabel>{t("gitPanel.update")}</DropdownLabel>
                    {canPull && (
                      <DropdownItem onSelect={() => runUpdate("pull")} className="items-center">
                        <ArrowDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-dim)]" />
                        <span className="truncate text-[12px]">
                          <Trans i18nKey="gitPanel.pullFrom" values={{ upstream: info!.upstream }} components={{ mono: <span className="font-mono" /> }} />
                        </span>
                      </DropdownItem>
                    )}
                    {canBase && (
                      <>
                        <DropdownItem onSelect={() => runUpdate("merge")} className="items-center">
                          <GitMerge className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-dim)]" />
                          <span className="truncate text-[12px]">
                            <Trans i18nKey="gitPanel.mergeInto" values={{ base: info!.base }} components={{ mono: <span className="font-mono" /> }} />
                          </span>
                        </DropdownItem>
                        <DropdownItem onSelect={() => runUpdate("rebase")} className="items-center">
                          <RotateCw className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-dim)]" />
                          <span className="truncate text-[12px]">
                            <Trans i18nKey="gitPanel.rebaseOnto" values={{ base: info!.base }} components={{ mono: <span className="font-mono" /> }} />
                          </span>
                        </DropdownItem>
                      </>
                    )}
                    <DropdownSeparator />
                  </>
                );
              })()}
              {!branches || branches.length === 0 ? (
                <div className="px-2 py-1.5 text-[12px] text-[var(--color-fg-faint)]">{t("gitPanel.noBranches")}</div>
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
      {right}
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
  /** Open the whole file (editor tab) for one repo-relative path. */
  onRowOpenFile: (path: string) => void;
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
  taskId, viewedCount = 0, headerAction, onRowClick, onRowOpenFile, onToggle, onDiscard, rowActionIcon, root, repoDir, truncated, className, style,
}: PaneProps) {
  const { t } = useTranslation("panels");
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
          {t("gitPanel.truncated")}
        </div>
      )}
      {!paneCollapsed && (
        <div className="min-h-0 flex-1 overflow-hidden">
          {files.length === 0 ? (
            <div className="px-3 py-1.5 text-[12px] text-[var(--color-fg-faint)]">
              {pane === "unstaged" ? t("gitPanel.nothingToStage") : t("gitPanel.nothingStaged")}
            </div>
          ) : (
            <FileList
              files={files} pane={pane} viewMode={viewMode}
              collapsed={collapsed} setCollapsed={setCollapsed} clickable={clickable}
              selectedKey={selectedKey} stageGlyph={stageGlyph} taskId={taskId}
              onRowClick={onRowClick} onRowOpenFile={onRowOpenFile}
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
    onOpenFile: p.onRowOpenFile,
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
  const { t } = useTranslation("panels");
  const { name, dirPath, depth, leaves, isCollapsed } = row;
  const DirActionIcon = rowActionIcon === "down" ? ArrowDown : ArrowUp;
  const dirLabel = rowActionIcon === "down" ? t("gitPanel.stageFolder") : t("gitPanel.unstageFolder");
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
          {rowActionIcon === "down" ? t("gitPanel.stageNamed", { name }) : t("gitPanel.unstageNamed", { name })}
        </ContextMenuItem>
        <ContextMenuItem destructive onSelect={() => onDiscard(leaves)}>
          <Trash2 />
          {t("gitPanel.discardNamed", { name })}
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
  const { t } = useTranslation("panels");
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
        const dirLabel = rowActionIcon === "down" ? t("gitPanel.stageFolder") : t("gitPanel.unstageFolder");
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
                {rowActionIcon === "down" ? t("gitPanel.stageNamed", { name: k.name }) : t("gitPanel.unstageNamed", { name: k.name })}
              </ContextMenuItem>
              <ContextMenuItem destructive onSelect={() => onDiscard(leaves)}>
                <Trash2 />
                {t("gitPanel.discardNamed", { name: k.name })}
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
// arrow button). `clickable` is `!!repo` — a task with no git repo at all,
// which renders no rows anyway. It is NOT about repo_root members: those are
// diffable and openable like any other group (see `clickable` above and
// resolve_task_git_path), and a stale comment here claiming otherwise is
// what talked a later reader into gating Open file on it.
function FileRow({ file, label, depth = 0, pane, selectedKey, stageGlyph, taskId, clickable, onClick, onOpenFile, onToggle, onDiscard, rowActionIcon, root, repoDir }: {
  file: GitFile;
  label: string;
  depth?: number;
  pane: "unstaged" | "staged";
  selectedKey: string | null;
  stageGlyph: string;
  taskId: string;
  clickable: boolean;
  onClick: (p: string) => void;
  onOpenFile: (p: string) => void;
  onToggle: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  rowActionIcon: "up" | "down";
  root: string;
  repoDir: string;
}) {
  const { t } = useTranslation("panels");
  const key = file.status;
  const ActionIcon = rowActionIcon === "down" ? ArrowDown : ArrowUp;
  const actionLabel = rowActionIcon === "down" ? t("gitPanel.stage") : t("gitPanel.unstage");
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
  // Same condition as the eye: a deletion has no working-tree file to open.
  //
  // NOT also gated on `clickable`. That reads like the careful choice and is
  // the wrong one: `clickable` is `!!repo` (no git repo at all), which is
  // nothing to do with repo_root members, and `task_file_read` resolves a
  // `<dir_name>/…` path inside the member's own checkout even when that
  // checkout lives outside the wrapper. A repo-less task renders no rows to
  // gate anyway, so the extra condition only ever misled a reader.
  const canOpenFile = canView;
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
      // The row highlight is the feature's "you did not lose your place"
      // promise, and it is carried by a themed border class. A state
      // attribute is what a spec can assert without pinning a class string.
      data-selected={selected}
      // ⌥-click reads the file instead of its diff. Plain click keeps
      // opening the diff, which is what this panel is for; the modifier is
      // the fast path for the case where the diff is the wrong reader (a
      // new doc, a rewritten markdown file), and the context menu is the
      // discoverable one.
      onClick={(e) => (canOpenFile && e.altKey ? onOpenFile(file.path) : onClick(file.path))}
      onDoubleClick={() => onToggle([file.path])}
    >
      <span
        className="inline-flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded px-0.5 text-[10.5px] font-semibold"
        style={{ background: COL[key] || "var(--color-fg-dim)", color: INK[key] || "var(--color-status-ink)" }}
      >{SC[key] || key}</span>
      <img src={fileIconUrl(label)} alt="" className={cn("h-4 w-4 shrink-0 file-icon", viewed && !selected && "opacity-50")} />
      {/* Same face and size as the All files tree (13px, medium, not mono).
          A changed file and the same file in the tree are the same object;
          rendering one in monospace made them read as different kinds of
          thing, and mono is wider, so long paths truncated sooner. */}
      <span className={cn("truncate flex-1 font-medium", viewed && !selected && "text-[var(--color-fg-faint)] line-through decoration-[var(--color-fg-faint)]/40")}>{label}</span>
      {commentCount > 0 && (
        <Tip side="left" content={commentCount === 1 ? t("shared.inlineCommentOne") : t("shared.inlineCommentMany", { count: commentCount })}>
          <span className="flex shrink-0 items-center gap-0.5 rounded bg-[var(--color-bg-3)] px-1 text-[10.5px] tabular-nums text-[var(--color-fg-dim)]">
            <MessageSquare className="h-2.5 w-2.5" />
            {commentCount}
          </span>
        </Tip>
      )}
      {canOpenFile && (
        <Tip side="left" content={t("shared.openFileTip")}>
          <button
            onClick={(e) => { e.stopPropagation(); onOpenFile(file.path); }}
            // The row's dblclick STAGES, and a button that stops only
            // `click` still lets the second one through: double-clicking a
            // read-only action would quietly mutate the index. Reading a
            // file must never stage it, however fast you click.
            onDoubleClick={(e) => e.stopPropagation()}
            aria-label={t("shared.openFile")}
            // Left of the eye: this navigates, the eye records a judgement,
            // the arrow acts on the index. Same quiet-until-hover treatment
            // as the eye, so a third control does not make the resting row
            // any busier than it already was.
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
            onClick={toggleViewed}
            // Same hole as the Open file button above, and it predates it:
            // a double-click on the eye staged the file through the row.
            onDoubleClick={(e) => e.stopPropagation()}
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
            {rowActionIcon === "down" ? t("gitPanel.stage") : t("gitPanel.unstage")}
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
          {t("gitPanel.discardChanges")}
        </ContextMenuItem>
        {canOpenFile && (
          <ContextMenuItem onSelect={() => onOpenFile(file.path)}>
            <FileText />
            {t("shared.openFile")}
          </ContextMenuItem>
        )}
        {canView && (
          <ContextMenuItem onSelect={() => useFileViewed.getState().toggle(taskId, fullPath, file.fp)}>
            <Check />
            {viewed ? t("shared.markNotViewed") : t("shared.markViewed")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <CopyPathItems rel={fullPath} root={root} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
