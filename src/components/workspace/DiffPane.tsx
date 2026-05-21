// Diff viewer with a Side-by-side ⇄ Unified toggle, both backed by
// CodeMirror 6 with full syntax highlighting (langForPath, shared
// with EditorPane). Side-by-side uses MergeView; unified uses
// unifiedMergeView in a single read-only editor.

import { useEffect, useRef, useState } from "react";
import type { DiffTab, Workspace } from "@/lib/types";
import { workspaceFileDiffSides, openPath } from "@/lib/ipc";
import { Button } from "@/components/ui/Button";
import { FolderOpen, Eye, Columns2, AlignJustify } from "lucide-react";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { resolveTheme } from "@/store/prefs";
import { cn } from "@/lib/utils";
import { langForPath, editorBaseTheme } from "./EditorPane";

type Mode = "side" | "unified";
const LS_DIFF_MODE = "diffMode";

function readMode(): Mode {
  try { return (localStorage.getItem(LS_DIFF_MODE) as Mode) === "unified" ? "unified" : "side"; }
  catch { return "side"; }
}
function writeMode(m: Mode) {
  try { localStorage.setItem(LS_DIFF_MODE, m); } catch {}
}

export function DiffPane({ ws, tab }: { ws: Workspace; tab: DiffTab }) {
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(() => readMode());
  const hostRef = useRef<HTMLDivElement>(null);
  // Only one of these is mounted at a time depending on `mode`.
  const mergeRef = useRef<MergeView | null>(null);
  const editorRef = useRef<EditorView | null>(null);
  const addTab = useApp(s => s.addTab);
  const editorFontSize = usePrefs(s => s.editorFontSize);
  // Light/dark diff palette follows the app theme. A theme switch
  // re-renders → the effect below rebuilds the MergeView with the
  // matching githubLight/githubDark palette.
  const themeMode = usePrefs(s => s.themeMode);

  function setModeAndPersist(m: Mode) {
    writeMode(m);
    setMode(m);
  }

  useEffect(() => {
    let alive = true;
    setErr(null);
    workspaceFileDiffSides(ws.id, tab.path).then(sides => {
      if (!alive || !hostRef.current) return;
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
        // GitHub light/dark palette, surfaces pulled from the app
        // theme's CSS vars. lineHighlight is transparent — the diff's
        // own per-line tints already carry the signal.
        editorBaseTheme(resolveTheme(themeMode) === "light", { lineHighlight: "transparent" }),
        EditorView.theme({
          "&": { fontSize: `${editorFontSize}px` },
          ".cm-content, .cm-gutters": { fontFamily: "inherit" },
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
          ".cm-changedText": {
            background: "rgba(64,160,90,0.26) !important",
            textDecoration: "none",
            borderRadius: "2px",
            boxShadow: "none",
          },
          // Side-by-side: the original ("a") editor's changed runs are
          // removals — tint them red. More specific than the plain
          // `.cm-changedText` above so it wins on that side only.
          "&.cm-merge-a .cm-changedText": {
            background: "rgba(239,83,80,0.24) !important",
          },
          ".cm-changedLine": {
            backgroundColor: "rgba(64,160,90,0.10) !important",
          },
          ".cm-deletedChunk": {
            backgroundColor: "rgba(239,83,80,0.08)",
          },
          ".cm-deletedText": {
            background: "rgba(239,83,80,0.26) !important",
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
        }),
      ];
      if (lang) baseExt.push(lang as Extension);

      if (mode === "side") {
        mergeRef.current = new MergeView({
          parent: hostRef.current,
          a: { doc: sides.original, extensions: baseExt },
          b: { doc: sides.modified, extensions: baseExt },
          highlightChanges: true,
          gutter: true,
          collapseUnchanged: { margin: 3, minSize: 6 },
        });
      } else {
        editorRef.current = new EditorView({
          parent: hostRef.current,
          doc: sides.modified,
          extensions: [
            ...baseExt,
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
      }
    }).catch(e => alive && setErr(String(e)));
    return () => {
      alive = false;
      mergeRef.current?.destroy(); mergeRef.current = null;
      editorRef.current?.destroy(); editorRef.current = null;
    };
  }, [ws.id, tab.path, editorFontSize, mode, themeMode]);

  return (
    // bg MUST be opaque: tab swap keeps the codex/claude terminal
    // mounted under us via visibility-toggle, and xterm's WebGL canvas
    // bleeds through any transparent ancestor.
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3">
        <span className="font-mono text-[12.5px] text-[var(--color-fg-dim)] truncate">{tab.path}</span>
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
                mode === "unified"
                  ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]"
                  : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
              )}
            ><AlignJustify className="h-3.5 w-3.5" /></button>
            <button
              type="button"
              title="Side by side"
              onClick={() => setModeAndPersist("side")}
              className={cn(
                "h-6 rounded-[5px] px-1.5 text-[11.5px] transition-colors",
                mode === "side"
                  ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]"
                  : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
              )}
            ><Columns2 className="h-3.5 w-3.5" /></button>
          </div>
          <Button size="sm" variant="ghost" onClick={() =>
            addTab(ws.id, { id: crypto.randomUUID(), type: "edit", path: tab.path, title: tab.path.split("/").pop() || tab.path })
          }><Eye className="h-4 w-4" /> View</Button>
          <Button size="sm" variant="ghost" onClick={() => openPath(`${ws.path}/${tab.path}`).catch(() => {})}>
            <FolderOpen className="h-4 w-4" /> Open
          </Button>
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
