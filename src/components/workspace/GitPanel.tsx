// Fork-style git staging panel (the "Git" tab of the right panel).
//
// Layout, top to bottom:
//   1. Repo sub-tabs   — multi-repo workspaces only; one wrapping pill per
//      repo that has changes (even if just one), each badged with its
//      changed-file count. Clean repos get no pill.
//   2. Toolbar         — search filter + view-mode menu (Tree / List /
//      Combined List + Hide untracked).
//   3. Unstaged pane   — resizable, scrollable file list.
//   4. Resize handle   — drag to repartition the two panes.
//   5. Staged pane     — resizable, scrollable file list.
//   6. Commit form     — subject, description, Amend, split Commit button.
//
// Backend: workspace_git_status returns staged/unstaged split per repo;
// workspace_stage / _unstage / _commit mutate the selected repo. Paths are
// repo-relative; member diffs are re-prefixed with `dir_name` before
// opening (the host stays unprefixed).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight, ChevronDown, ArrowDown, ArrowUp, List, ListTree, Rows3, Check, Search, Trash2,
} from "lucide-react";
import type { Workspace, GitStatus, GitRepo, GitFile } from "@/lib/types";
import { workspaceStage, workspaceUnstage, workspaceCommit, workspaceDiscard } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { bindingMatches, bindingGlyphs } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { Button } from "@/components/ui/Button";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator } from "@/components/ui/Dropdown";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/ContextMenu";
import { Tip } from "@/components/ui/Tooltip";
import { CopyPathItems } from "./CopyPathItems";
import { fileIconUrl, folderIconUrl } from "@/lib/explorer/iconResolver";

// Per-side status → glyph / color / label. `?` is untracked (rendered as
// a green +, same as a fresh add).
const SC: Record<string, string>  = { M: "M", A: "+", "?": "+", D: "D", R: "R", C: "C", U: "U" };
const COL: Record<string, string> = { M: "var(--color-accent)", A: "var(--color-ok)", "?": "var(--color-ok)", D: "var(--color-err)", R: "var(--color-accent)", C: "var(--color-accent)", U: "var(--color-err)" };
const LBL: Record<string, string> = { M: "modified", A: "added", "?": "untracked", D: "deleted", R: "renamed", C: "copied", U: "conflict" };

type ViewMode = "tree" | "list" | "combined";

const LS_VIEW   = "gitViewMode";
const LS_HIDE   = "gitHideUntracked";
const LS_RATIO  = "gitSplitRatio";
const LS_PUSH   = "gitPushDefault";

function readView(): ViewMode {
  try { const v = localStorage.getItem(LS_VIEW); if (v === "tree" || v === "list" || v === "combined") return v; } catch {}
  return "tree";
}
function readBool(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}
function readRatio(): number {
  try { const n = parseFloat(localStorage.getItem(LS_RATIO) || ""); if (n >= 0.1 && n <= 0.9) return n; } catch {}
  return 0.5;
}

export function GitPanel({ ws, status, refresh, onOpenDiff, onDoubleClickDiff }: {
  ws: Workspace;
  status: GitStatus | null;
  refresh: () => void;
  /** Opens a diff tab for a workspace-relative path (already prefixed). */
  onOpenDiff: (path: string) => void;
  onDoubleClickDiff: (path: string) => void;
}) {
  const pushToast = useUI(s => s.pushToast);
  const nonGit = useApp(s => s.projects.find(p => p.id === ws.project_id)?.non_git);
  // Resolved (user-overridable) bindings for the contextual Git shortcuts.
  const stageBinding = usePrefs(s => s.shortcuts["stage-file"]);
  const discardBinding = usePrefs(s => s.shortcuts["discard-file"]);
  const stageGlyph = bindingGlyphs(stageBinding).join("");

  const [activeRepoDir, setActiveRepoDir] = useState<string>("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => readView());
  const [hideUntracked, setHideUntracked] = useState<boolean>(() => readBool(LS_HIDE));
  const [ratio, setRatio] = useState<number>(() => readRatio());
  const [search, setSearch] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [committing, setCommitting] = useState(false);
  const [pushDefault, setPushDefault] = useState<boolean>(() => readBool(LS_PUSH));
  // Collapsed tree folders, keyed `${pane}\0${dirPath}`.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Selected row, keyed `${pane}\0${path}` (a file can sit in both panes
  // when partially staged, so the pane is part of the key). Fork-style:
  // the clicked row stays highlighted and shows its stage button.
  const [selected, setSelected] = useState<string | null>(null);

  const repos = status?.repos ?? [];
  const changedRepos = repos.filter(r => r.changed > 0);

  // Keep the selection on a repo that actually has changes — the pills only
  // list changed repos now, so an activeRepoDir pointing at a clean repo
  // (fresh open, or one that just went clean after a commit) has no pill and
  // must snap to the first changed repo so its files show immediately.
  useEffect(() => {
    if (repos.length === 0) return;
    const cur = changedRepos.find(r => r.dir_name === activeRepoDir);
    if (cur) return;
    const next = changedRepos[0] ?? repos[0];
    if (next && next.dir_name !== activeRepoDir) setActiveRepoDir(next.dir_name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, activeRepoDir]);

  // Reset transient form state on workspace switch.
  useEffect(() => {
    setSubject(""); setBody(""); setSearch("");
    setActiveRepoDir(""); setSelected(null);
  }, [ws.id]);

  const persist = (key: string, val: string) => { try { localStorage.setItem(key, val); } catch {} };
  const changeView = (v: ViewMode) => { setViewMode(v); persist(LS_VIEW, v); };
  const toggleHide = () => setHideUntracked(h => { const n = !h; persist(LS_HIDE, n ? "1" : "0"); return n; });

  const repo: GitRepo | undefined = repos.find(r => r.dir_name === activeRepoDir) ?? repos[0];
  // Every group is diffable: the backend's resolve_workspace_git_path runs
  // git in the group's OWN repo cwd (member.path), so repo_root members
  // (live checkouts that live outside the wrapper subtree) resolve fine —
  // safe_workspace_path is checked against that member cwd, not the wrapper.
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

  // ── git mutations ──
  const dir = repo?.dir_name ?? "";
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
    const diff = (st.tabs[ws.id] || []).find(t => t.preview && t.type === "diff");
    if (diff) st.closeTab(ws.id, diff.id);
  }, [ws.id]);

  const focusNext = useCallback((pane: "unstaged" | "staged", path: string) => {
    const list = (pane === "unstaged" ? unstaged : staged)
      .map(f => f.path)
      .sort((a, b) => a.localeCompare(b));
    const idx = list.indexOf(path);
    const next = idx >= 0 ? list[idx + 1] : undefined;
    if (next) {
      setSelected(`${pane} ${next}`);
      if (clickable) onOpenDiff(dir ? `${dir}/${next}` : next);
      return;
    }
    closePreviewDiff();
  }, [unstaged, staged, clickable, onOpenDiff, dir, closePreviewDiff]);

  // Bulk "Stage all" / "Unstage all" leave the selection alone.
  const doStage = (paths: string[]) => {
    if (paths.length === 0) return;
    workspaceStage(ws.id, dir, paths).then(() => {
      if (paths.length === 1) focusNext("unstaged", paths[0]);
      refresh();
    }).catch(e => pushToast(String(e), "error"));
  };
  const doUnstage = (paths: string[]) => {
    if (paths.length === 0) return;
    workspaceUnstage(ws.id, dir, paths).then(() => {
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
      workspaceDiscard(ws.id, dir, paths)
        .then(() => {
          if (opts?.pane && paths.length === 1) focusNext(opts.pane, paths[0]);
          else closePreviewDiff();
          refresh();
        })
        .catch(err => pushToast(String(err), "error"));
    });
  }, [ws.id, dir, focusNext, closePreviewDiff, refresh, pushToast]);

  const doCommit = (push: boolean) => {
    if (!subject.trim() || committing) return;
    setCommitting(true);
    workspaceCommit(ws.id, dir, subject, body, false, push)
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

  // ── resizable split ──
  // ResizeHandle calls onDrag with the delta since the LAST mousemove, so
  // we MUST accumulate from the latest ratio. Using the render-time `ratio`
  // here would compute every move off the same stale base and make the
  // divider snap back and forth. A functional update reads the live value;
  // a ref carries it into onEnd for the persist.
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
        const fn = pane === "unstaged" ? workspaceStage : workspaceUnstage;
        fn(ws.id, dir, [path]).then(() => {
          focusNext(pane, path);   // advance to the next file in this pane
          refresh();
        }).catch(err => pushToast(String(err), "error"));
      } else {
        doDiscard([path], { pane });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selected, dir, ws.id, refresh, pushToast, stageBinding, discardBinding, focusNext, doDiscard]);

  if (!status) {
    return <div className="px-3 py-3 text-[13.5px] text-[var(--color-fg-faint)]">Loading…</div>;
  }
  if (!repo || status.total_changed === 0) {
    return (
      <div className="px-3 py-3 text-[13.5px] text-[var(--color-fg-faint)]">
        {nonGit
          ? "Not a git repository. Changes aren't tracked here."
          : "No changes. Working tree is clean."}
      </div>
    );
  }

  // Show repo pills only for repos that actually have changes — even when
  // that's a single repo. Unchanged repos are noise here; the "All files"
  // tab is where you browse repos that aren't currently dirty.
  const showSubTabs = repos.length > 1 && changedRepos.length > 0;
  const fileWord = stagedCount === 1 ? "File" : "Files";
  const commitDisabled = committing || !subject.trim() || stagedCount === 0;
  const commitLabel = `Commit ${stagedCount} ${fileWord}${pushDefault ? " and Push" : ""}`;

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
    if (clickable) onOpenDiff(dir ? `${dir}/${p}` : p);
  };

  return (
    <div className="flex h-full flex-col">
      {/* 1. Repo sub-tabs (wrapping pills) */}
      {showSubTabs && (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-[var(--color-border-soft)] px-2 py-1.5">
          {changedRepos.map(r => (
            <button
              key={r.dir_name}
              onClick={() => {
                if (r.dir_name === activeRepoDir) return;
                setActiveRepoDir(r.dir_name);
                // The open diff belongs to the previous repo — drop the
                // selection and close the preview diff tab so we don't show
                // a stale file from another repo.
                setSelected(null);
                const st = useApp.getState();
                const diff = (st.tabs[ws.id] || []).find(t => t.preview && t.type === "diff");
                if (diff) st.closeTab(ws.id, diff.id);
              }}
              title={`${r.name} (${r.branch})`}
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

      {/* 2. Toolbar: search + view-mode menu */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-soft)] px-2">
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

      {/* 3-5. Unstaged / handle / Staged */}
      <div ref={bodyRef} className="relative flex min-h-0 flex-1 flex-col">
        <Pane
          title="Unstaged" files={unstaged} pane="unstaged" viewMode={viewMode}
          collapsed={collapsed} setCollapsed={setCollapsed}
          clickable={clickable} selectedKey={selected} stageGlyph={stageGlyph}
          headerAction={unstaged.length > 0 ? { label: "Stage all", onClick: () => doStage(unstaged.map(f => f.path)) } : undefined}
          onRowClick={(p) => activate("unstaged", p)}
          onToggle={doStage}
          onDiscard={(paths) => doDiscard(paths, paths.length === 1 ? { pane: "unstaged" } : undefined)}
          rowActionIcon="down"
          root={ws.path} repoDir={dir}
          style={{ flexBasis: `${ratio * 100}%`, flexGrow: 0, flexShrink: 0 }}
        />
        <div className="relative h-px shrink-0 bg-[var(--color-border-soft)]">
          <ResizeHandle direction="y" className="top-0" onDrag={onSplitDrag} onEnd={() => persist(LS_RATIO, String(ratioRef.current))} />
        </div>
        <Pane
          title="Staged" files={staged} pane="staged" viewMode={viewMode}
          collapsed={collapsed} setCollapsed={setCollapsed}
          clickable={clickable} selectedKey={selected} stageGlyph={stageGlyph}
          headerAction={staged.length > 0 ? { label: "Unstage all", onClick: () => doUnstage(staged.map(f => f.path)) } : undefined}
          onRowClick={(p) => activate("staged", p)}
          onToggle={doUnstage}
          onDiscard={(paths) => doDiscard(paths, paths.length === 1 ? { pane: "staged" } : undefined)}
          rowActionIcon="up"
          root={ws.path} repoDir={dir}
          className="min-h-0 flex-1"
        />
      </div>

      {/* 6. Commit form */}
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
        {/* Split commit button: main = remembered mode, caret picks. */}
        <div className="flex justify-end">
          <button
            disabled={commitDisabled}
            onClick={() => doCommit(pushDefault)}
            className={cn(
              "flex h-7 items-center rounded-l-md bg-[var(--color-accent)] px-3 text-[12.5px] font-medium text-white transition-colors",
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
                  "flex h-7 w-6 items-center justify-center rounded-r-md border-l border-black/15 bg-[var(--color-accent)] text-white transition-colors",
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
  clickable: boolean;
  /** Currently selected row key (`${pane} ${path}`), or null. */
  selectedKey: string | null;
  /** Display glyph for the stage/unstage shortcut, e.g. "⌘S". */
  stageGlyph: string;
  headerAction?: { label: string; onClick: () => void };
  onRowClick: (path: string) => void;
  /** Stage (unstaged pane) or unstage (staged pane) the given paths.
   *  Accepts many so a directory row can act on its whole subtree. */
  onToggle: (paths: string[]) => void;
  /** Discard changes to the given paths (confirms first). Same multi-path
   *  contract as onToggle so a folder row discards its whole subtree. */
  onDiscard: (paths: string[]) => void;
  rowActionIcon: "up" | "down";
  /** Workspace absolute root + active repo's dir_name. Used to build the
   *  absolute / workspace-relative paths for the "Copy path" context items.
   *  Git paths are repo-relative, so the workspace-relative form prefixes
   *  `repoDir` (empty for the host repo). */
  root: string;
  repoDir: string;
  className?: string;
  style?: React.CSSProperties;
}

function Pane({
  title, files, pane, viewMode, collapsed, setCollapsed, clickable, selectedKey, stageGlyph,
  headerAction, onRowClick, onToggle, onDiscard, rowActionIcon, root, repoDir, className, style,
}: PaneProps) {
  return (
    <div className={cn("flex flex-col overflow-hidden", className)} style={style}>
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2.5">
        <span className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-[var(--color-fg-dim)]">
          {title}
          <span className="ml-1.5 tabular-nums text-[var(--color-fg-faint)]">{files.length}</span>
        </span>
        {headerAction && (
          <button
            onClick={headerAction.onClick}
            className="rounded px-1.5 py-0.5 text-[11.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          >
            {headerAction.label}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-0.5">
        {files.length === 0 ? (
          <div className="px-3 py-1.5 text-[12px] text-[var(--color-fg-faint)]">
            {pane === "unstaged" ? "Nothing to stage" : "Nothing staged"}
          </div>
        ) : (
          <FileList
            files={files} pane={pane} viewMode={viewMode}
            collapsed={collapsed} setCollapsed={setCollapsed} clickable={clickable}
            selectedKey={selectedKey} stageGlyph={stageGlyph}
            onRowClick={onRowClick}
            onToggle={onToggle} onDiscard={onDiscard} rowActionIcon={rowActionIcon}
            root={root} repoDir={repoDir}
          />
        )}
      </div>
    </div>
  );
}

function FileList(props: Omit<PaneProps, "title" | "headerAction" | "className" | "style">) {
  const { files, viewMode } = props;
  if (viewMode === "list") {
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    return <>{sorted.map(f => <FileRow key={f.path} file={f} label={f.path} {...rowProps(props)} />)}</>;
  }
  if (viewMode === "combined") {
    // Group by parent dir; dir shown once as a dim subheader.
    const groups = new Map<string, GitFile[]>();
    for (const f of files) {
      const slash = f.path.lastIndexOf("/");
      const d = slash === -1 ? "" : f.path.slice(0, slash);
      (groups.get(d) ?? groups.set(d, []).get(d)!).push(f);
    }
    const dirs = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    return (
      <>
        {dirs.map(d => (
          <div key={d || "."}>
            {d && (
              <div className="truncate px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-dim)]">{d}</div>
            )}
            {groups.get(d)!.sort((a, b) => a.path.localeCompare(b.path)).map(f => (
              <FileRow key={f.path} file={f} label={f.path.split("/").pop() || f.path} depth={d ? 1 : 0} {...rowProps(props)} />
            ))}
          </div>
        ))}
      </>
    );
  }
  // Tree view.
  return <TreeView {...props} />;
}

function rowProps(p: Omit<PaneProps, "title" | "headerAction" | "className" | "style">) {
  return {
    pane: p.pane,
    selectedKey: p.selectedKey,
    stageGlyph: p.stageGlyph,
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

// ── tree ──
type TreeNode = { name: string; path: string; file?: GitFile; children: Map<string, TreeNode> };

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

function TreeView(props: Omit<PaneProps, "title" | "headerAction" | "className" | "style">) {
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
                className="group flex h-[24px] w-full cursor-pointer items-center gap-1.5 px-2 pr-1 text-left text-[12.5px] text-[var(--color-fg)]/85 hover:bg-[var(--color-hover)]"
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
function FileRow({ file, label, depth = 0, pane, selectedKey, stageGlyph, clickable, onClick, onToggle, onDiscard, rowActionIcon, root, repoDir }: {
  file: GitFile;
  label: string;
  depth?: number;
  pane: "unstaged" | "staged";
  selectedKey: string | null;
  stageGlyph: string;
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
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
    <div
      className={cn(
        "group flex h-[26px] w-full items-center gap-2 border-l-2 pr-1 text-[13px]",
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
      onClick={() => onClick(file.path)}
      onDoubleClick={() => onToggle([file.path])}
    >
      <span
        className="inline-flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded px-0.5 text-[10.5px] font-semibold text-black"
        style={{ background: COL[key] || "var(--color-fg-dim)" }}
      >{SC[key] || key}</span>
      <img src={fileIconUrl(label)} alt="" className="h-4 w-4 shrink-0 file-icon" />
      <span className="truncate flex-1 font-mono text-[12px]">{label}</span>
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
        <ContextMenuSeparator />
        <CopyPathItems rel={repoDir ? `${repoDir}/${file.path}` : file.path} root={root} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
