// Diff viewer with a Side-by-side ⇄ Unified toggle, both backed by
// CodeMirror 6 with full syntax highlighting (langForPath, shared
// with EditorPane). Side-by-side uses MergeView; unified uses
// unifiedMergeView in a single read-only editor.

import { useEffect, useRef, useState } from "react";
import type { DiffTab, Task, GitFile } from "@/lib/types";
import { taskFileDiffSides, taskGitStatus } from "@/lib/ipc";
import { orderedFiles, readView } from "./GitPanel";
import { Button } from "@/components/ui/Button";
import { FolderOpen, Columns2, AlignJustify, Eye } from "lucide-react";
import { useApp } from "@/store/app";
import { useFileViewed, useIsViewed } from "@/store/fileViewed";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { cn } from "@/lib/utils";
import { langForPath } from "./EditorPane";
import { resolveEditorTheme, editorSurfaceTheme } from "@/lib/editorTheme";
import { reviewCommentsExtension, dispatchFileComment } from "./reviewCommentsExt";
import { MessageSquarePlus } from "lucide-react";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent } from "@/components/ui/ContextMenu";
import { CopyPathItems } from "./CopyPathItems";
import { attachHiddenScrollRestore } from "@/lib/hiddenScrollRestore";

type Mode = "side" | "unified";
const LS_DIFF_MODE = "diffMode";

// Issue #40: syntax themes color comments dim by design (Atom One, the default
// dark "auto" theme, uses #54636D), which de-emphasizes them while you write
// code. In a DIFF you're reading what changed, so a changed comment block
// renders as dim slate text on the green/red line wash, very low contrast.
// Override comments to the app's `--color-fg-dim` (still subdued, but legible
// on every palette and auto-adapting light/dark). Scoped to the diff only so
// the editor keeps comments recessive. Prec.highest so it wins over the syntax
// theme's own comment rule; other tags fall through (this styles comments only).
const diffCommentContrast = Prec.highest(
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--color-fg-dim)" },
    ]),
  ),
);

function readMode(): Mode {
  try { return (localStorage.getItem(LS_DIFF_MODE) as Mode) === "side" ? "side" : "unified"; }
  catch { return "unified"; }
}
function writeMode(m: Mode) {
  try { localStorage.setItem(LS_DIFF_MODE, m); } catch {}
}

export function DiffPane({ task, tab }: { task: Task; tab: DiffTab }) {
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(() => readMode());
  // New or deleted file: one diff side is empty, so side-by-side would
  // just show a blank pane (issue #26). We render unified instead and
  // disable the toggle, without touching the persisted preference.
  const [oneSided, setOneSided] = useState(false);
  // True once a comment-bearing editor is mounted (either mode). Gates the
  // header "Comment" button so it never fires into a not-yet-built view.
  const [commentable, setCommentable] = useState(false);
  // Working-tree fingerprint of this file (from the diff load), so the
  // header's "Viewed" toggle anchors to the same fp the Git panel rows use
  // (GH #42). Empty for a deletion → the toggle is hidden.
  const [fp, setFp] = useState("");
  const viewed = useIsViewed(task.id, tab.path, fp);
  const hostRef = useRef<HTMLDivElement>(null);
  // The host div is the scroll container for both modes; its position
  // dies with the box when a hidden task/tab goes display:none in
  // WKWebView — record and re-apply it. The host outlives mode/file
  // swaps (only innerHTML is replaced), so attach once.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    return attachHiddenScrollRestore(el);
  }, []);
  // Only one of these is mounted at a time depending on `mode`.
  const mergeRef = useRef<MergeView | null>(null);
  const editorRef = useRef<EditorView | null>(null);
  const addTab = useApp(s => s.addTab);
  const editorFontSize = usePrefs(s => s.editorFontSize);

  // Mark this file viewed and, when ticking it ON, walk to the next file you
  // haven't looked at yet — the GitHub PR-review flow. Mirrors the Git panel's
  // focusNext (advance after acting on a file) but skips files already viewed,
  // since "what's next" in a review means the next UNSEEN diff. Un-viewing
  // never navigates. Files are flattened to task-relative paths in the
  // same alphabetical order the Git panel rows use.
  const markViewedAndAdvance = async () => {
    const wasViewed = viewed;
    useFileViewed.getState().toggle(task.id, tab.path, fp);
    if (wasViewed) return; // un-viewing: stay put
    try {
      const status = await taskGitStatus(task.id);
      const seen = useFileViewed.getState().byTask[task.id] ?? {};
      // Match the sidebar exactly: it shows ONE repo at a time, stacked as
      // Unstaged then Staged, each pane in the active view's render order
      // (tree puts folders first — a flat path sort would jump around). So
      // resolve this file's repo, then walk that repo's files in that order.
      const viewMode = readView();
      const hideUntracked = (() => { try { return localStorage.getItem("gitHideUntracked") === "1"; } catch { return false; } })();
      for (const r of status.repos) {
        const pfx = r.dir_name ? `${r.dir_name}/` : "";
        if (pfx && !tab.path.startsWith(pfx)) continue;
        const rel = pfx ? tab.path.slice(pfx.length) : tab.path;
        const filt = (fs: GitFile[]) => hideUntracked ? fs.filter(f => f.status !== "?") : fs;
        const ordered = [
          ...orderedFiles(filt(r.unstaged), viewMode).map(f => ({ f, pane: "unstaged" as const })),
          ...orderedFiles(filt(r.staged), viewMode).map(f => ({ f, pane: "staged" as const })),
        ];
        // A partially-staged file appears in BOTH panes — anchor the walk
        // at the occurrence this tab was opened from, not the first one.
        const idx = ordered.findIndex(x => x.f.path === rel && (!tab.scope || x.pane === tab.scope));
        if (idx === -1) continue; // file lives in a different repo
        const next = ordered
          .slice(idx + 1)
          .find(x => x.f.fp !== "" && seen[pfx + x.f.path] !== x.f.fp);
        if (next) {
          useApp.getState().openPreviewTab(task.id, {
            type: "diff",
            path: pfx + next.f.path,
            // Keep the pane the file came from so the walked-to diff
            // shows the same sides a click on its row would (GH #122).
            scope: next.pane,
            title: `Δ ${next.f.path.split("/").pop()}`,
          });
        }
        return;
      }
    } catch {
      // Status fetch failed — leave the current (now-viewed) diff open.
    }
  };
  // Same syntax theme as the editor. A change re-renders → the effect
  // below rebuilds the diff view with the new palette. The "auto" syntax
  // theme also follows the app palette, so rebuild on theme switch too.
  const editorThemeId = usePrefs(s => s.editorThemeId);
  const themeMode = usePrefs(s => s.themeMode);
  const appIsLight = resolveTheme(themeMode) === "light";

  function setModeAndPersist(m: Mode) {
    writeMode(m);
    setMode(m);
  }

  useEffect(() => {
    let alive = true;
    setErr(null);
    setCommentable(false);
    taskFileDiffSides(task.id, tab.path, tab.scope).then(sides => {
      if (!alive || !hostRef.current) return;
      // Existence flags, not content emptiness — "" is what BOTH a missing
      // side and an empty (or non-UTF8) file serialize to, and a file
      // truncated to 0 bytes still has two real sides to compare.
      const degenerate = !sides.original_exists || !sides.modified_exists;
      setOneSided(degenerate);
      setFp(sides.fp);
      // Tear any prior view down before mounting the new one.
      mergeRef.current?.destroy();
      mergeRef.current = null;
      editorRef.current?.destroy();
      editorRef.current = null;
      hostRef.current.innerHTML = "";

      const lang = langForPath(tab.path);
      const baseExt: Extension[] = [
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        lineNumbers(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        // Same syntax theme as the editor; surfaces pulled from the app
        // CSS vars. dimActiveLine=true — the diff's per-line red/green
        // tints carry the signal, the active-line wash would muddy it.
        resolveEditorTheme(editorThemeId, appIsLight),
        diffCommentContrast, // issue #40: keep changed comments legible on the wash
        editorSurfaceTheme(editorFontSize, false, true),
        EditorView.theme({
          // @codemirror/merge styles "changed text" as a 2px
          // linear-gradient strip pinned to the bottom of the run —
          // it renders as a ragged green/red underline under every
          // changed word, the eyesore. Replace it with a flat
          // translucent highlight box.
          //
          // !important is REQUIRED: the merge baseTheme's selector
          // (`&dark.cm-merge-b .cm-changedText`, 3 classes) out-
          // specifies a plain `.cm-changedText` rule, so without it
          // our flat background loses and the gradient underline
          // stays. The merge rules aren't !important themselves, so
          // !important wins regardless of specificity.
          // Issue #40: keep the changed-WORD highlights soft so they don't
          // wash out syntax-coloured (often dim, e.g. comments) text on the
          // inserted side. A gentle word tint + a clear per-LINE wash carry
          // the add/remove signal instead of a heavy block behind the text.
          ".cm-changedText": {
            background: "rgba(64,160,90,0.16) !important",
            textDecoration: "none",
            borderRadius: "2px",
            boxShadow: "none",
          },
          // Side-by-side: the original ("a") editor's changed runs are
          // removals — tint them red. More specific than the plain
          // `.cm-changedText` above so it wins on that side only.
          "&.cm-merge-a .cm-changedText": {
            background: "rgba(239,83,80,0.16) !important",
          },
          // Per-line washes. Symmetric green/red so an inserted line and a
          // deleted line read at the same weight (the old setup tinted the
          // deleted side lighter, which made added lines look "louder").
          ".cm-changedLine": {
            backgroundColor: "rgba(64,160,90,0.13) !important",
          },
          "ins.cm-insertedLine, .cm-insertedLine": {
            backgroundColor: "rgba(64,160,90,0.13) !important",
          },
          ".cm-deletedChunk": {
            backgroundColor: "rgba(239,83,80,0.12)",
          },
          "del.cm-deletedLine, .cm-deletedLine": {
            backgroundColor: "rgba(239,83,80,0.13) !important",
          },
          ".cm-deletedText": {
            background: "rgba(239,83,80,0.16) !important",
            textDecoration: "none",
          },
          // CodeMirror merge wraps inserted/deleted lines in <ins>/<del>
          // tags — the browser's UA stylesheet underlines <ins> and
          // strikes through <del>, which is what made every changed
          // line look underlined. Drop those.
          "ins.cm-insertedLine, ins.cm-insertedLine *": {
            textDecoration: "none !important",
          },
          "ins.cm-insertedLine .cm-changedText, .cm-insertedLine .cm-changedText, ins.cm-insertedLine .cm-insertedText, .cm-insertedLine .cm-insertedText, ins.cm-insertedLine .cm-inserted, .cm-insertedLine .cm-inserted": {
            background: "transparent !important",
          },
          "del.cm-deletedLine, del.cm-deletedLine *": {
            textDecoration: "none !important",
          },
          "del.cm-deletedLine .cm-deletedText, .cm-deletedLine .cm-deletedText, del.cm-deletedLine .cm-deleted, .cm-deletedLine .cm-deleted": {
            background: "transparent !important",
          },
          // The "N unchanged lines" collapsed-fold widget. @codemirror/merge
          // ships it with a hard-coded dark gradient that renders as a solid
          // black bar under a light app theme (issue #40). Re-skin it to the
          // app surface vars so it tracks any palette.
          ".cm-collapsedLines": {
            background: "color-mix(in srgb, var(--color-fg) 6%, transparent) !important",
            color: "var(--color-fg-dim) !important",
            backgroundImage: "none !important",
            borderTop: "1px solid var(--color-border-soft)",
            borderBottom: "1px solid var(--color-border-soft)",
          },
          ".cm-collapsedLines:hover": {
            background: "color-mix(in srgb, var(--color-fg) 11%, transparent) !important",
            color: "var(--color-fg) !important",
          },
        }),
      ];
      if (lang) baseExt.push(lang as Extension);

      // Inline review comments (#28) on the MODIFIED side in BOTH modes, so
      // line numbers + quotes always refer to the new file (what an agent
      // acts on). In side-by-side the comment cards are block widgets on the
      // `b` pane: MergeView only re-aligns its two panes at change-chunk
      // boundaries, so the panes drift slightly below a card until the next
      // hunk. Accepted tradeoff (unified is pixel-exact); the alternative is
      // an out-of-flow overlay, which is a lot more machinery for this.
      const commentExt = reviewCommentsExtension(task.id, tab.path);

      if (mode === "side" && !degenerate) {
        mergeRef.current = new MergeView({
          parent: hostRef.current,
          a: { doc: sides.original, extensions: baseExt },
          b: { doc: sides.modified, extensions: [...baseExt, commentExt] },
          highlightChanges: true,
          gutter: true,
          collapseUnchanged: { margin: 3, minSize: 6 },
        });
        setCommentable(true);
      } else {
        editorRef.current = new EditorView({
          parent: hostRef.current,
          doc: sides.modified,
          extensions: [
            ...baseExt,
            commentExt,
            unifiedMergeView({
              original: sides.original,
              highlightChanges: true,
              gutter: true,
              syntaxHighlightDeletions: true,
              mergeControls: false,
              collapseUnchanged: { margin: 3, minSize: 6 },
            }),
          ],
        });
        setCommentable(true);
      }
    }).catch(e => alive && setErr(String(e)));
    return () => {
      alive = false;
      mergeRef.current?.destroy(); mergeRef.current = null;
      editorRef.current?.destroy(); editorRef.current = null;
    };
  }, [task.id, tab.path, tab.scope, editorFontSize, mode, editorThemeId, appIsLight]);

  const effectiveMode: Mode = oneSided ? "unified" : mode;

  return (
    // bg MUST be opaque: tab swap keeps the codex/claude terminal
    // mounted under us via visibility-toggle, and xterm's WebGL canvas
    // bleeds through any transparent ancestor.
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3">
        {/* Selectable + right-clickable so the path can be copied (GH #44).
            `select-text` overrides the pane's default non-selectable chrome. */}
        <ContextMenuRoot>
          <ContextMenuTrigger asChild>
            <span
              title={tab.path}
              className="font-mono text-[12.5px] text-[var(--color-fg-dim)] truncate cursor-text select-text"
            >{tab.path}</span>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <CopyPathItems rel={tab.path} root={task.path} />
          </ContextMenuContent>
        </ContextMenuRoot>
        <div className="flex items-center gap-1">
          {/* Side-by-side ⇄ Unified toggle. Persisted in localStorage
              so the user's preference sticks across launches. */}
          <div className="mr-1 inline-flex items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[2px]">
            <button
              type="button"
              title="Unified (inline)"
              onClick={() => setModeAndPersist("unified")}
              className={cn(
                "h-6 rounded-[5px] px-1.5 text-[11.5px] transition-colors",
                effectiveMode === "unified"
                  ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]"
                  : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
              )}
            ><AlignJustify className="h-3.5 w-3.5" /></button>
            <button
              type="button"
              title={oneSided ? "Side by side is unavailable: new or deleted file, nothing to compare" : "Side by side"}
              disabled={oneSided}
              onClick={() => setModeAndPersist("side")}
              className={cn(
                "h-6 rounded-[5px] px-1.5 text-[11.5px] transition-colors",
                effectiveMode === "side"
                  ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]"
                  : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                oneSided && "cursor-not-allowed opacity-40 hover:text-[var(--color-fg-dim)]",
              )}
            ><Columns2 className="h-3.5 w-3.5" /></button>
          </div>
          {/* Whole-file comment. Targets the modified pane: the `b` editor in
              side-by-side, the single editor in unified. */}
          {commentable && (
            <Button size="sm" variant="ghost" title="Leave a comment on this whole file" onClick={() => {
              const v = mergeRef.current?.b ?? editorRef.current;
              if (v) { v.focus(); dispatchFileComment(v); }
            }}><MessageSquarePlus className="h-4 w-4" /> Comment</Button>
          )}
          <Button size="sm" variant="ghost" title="Open this file in the editor" onClick={() =>
            addTab(task.id, { id: crypto.randomUUID(), type: "edit", path: tab.path, title: tab.path.split("/").pop() || tab.path })
          }><FolderOpen className="h-4 w-4" /> Open</Button>
          {/* Mark-as-viewed (GH #42): mirrors the Git panel row checkbox.
              Hidden for deletions (no working-tree file to fingerprint). */}
          {fp !== "" && (
            <Button
              size="sm"
              variant="ghost"
              title={viewed ? "Mark as not viewed" : "Mark as viewed, then go to the next unviewed file"}
              onClick={markViewedAndAdvance}
              className={cn(viewed && "text-[var(--color-accent)]")}
            >
              <Eye className="h-4 w-4" />
              {viewed ? "Viewed" : "Mark as viewed"}
            </Button>
          )}
        </div>
      </div>
      {err && <div className="p-4 font-mono text-[12.5px] text-[var(--color-err)]">Error: {err}</div>}
      {!err && (
        <div
          ref={hostRef}
          data-selectable
          className="min-h-0 flex-1 overflow-auto"
        />
      )}
    </div>
  );
}
