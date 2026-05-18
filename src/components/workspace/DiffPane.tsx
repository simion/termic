// Side-by-side diff viewer using CodeMirror 6's MergeView. Picks the
// same language extension EditorPane uses so the diff has full syntax
// highlighting on both sides. Falls back to a single read-only editor
// if the file is identical / missing.

import { useEffect, useRef, useState } from "react";
import type { DiffTab, Workspace } from "@/lib/types";
import { workspaceFileDiffSides, openPath } from "@/lib/ipc";
import { Button } from "@/components/ui/Button";
import { FolderOpen, Eye } from "lucide-react";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { MergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { githubDarkInit } from "@uiw/codemirror-theme-github";
import { langForPath } from "./EditorPane";

export function DiffPane({ ws, tab }: { ws: Workspace; tab: DiffTab }) {
  const [err, setErr] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const addTab = useApp(s => s.addTab);
  const editorFontStack = usePrefs(s => s.editorFontId);
  const editorFontSize  = usePrefs(s => s.editorFontSize);

  useEffect(() => {
    let alive = true;
    setErr(null);
    workspaceFileDiffSides(ws.id, tab.path).then(sides => {
      if (!alive || !hostRef.current) return;
      // Tear any previous instance down (e.g. user switched diff tab
      // backing path via rename — unlikely but cheap to handle).
      mergeRef.current?.destroy();
      hostRef.current.innerHTML = "";

      const lang = langForPath(tab.path);
      const baseExt: Extension[] = [
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        lineNumbers(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        // Match the editor theme so both panes feel like one app.
        // `bg-bg` on the wrapper handles the surrounding chrome.
        githubDarkInit({
          settings: {
            background: "var(--color-bg)",
            foreground: "var(--color-fg)",
            caret: "var(--color-accent)",
            selection: "rgba(217,119,87,0.15)",
            lineHighlight: "transparent",
            gutterBackground: "var(--color-bg)",
            gutterForeground: "var(--color-fg-faint)",
          },
        }),
        EditorView.theme({
          "&": { fontSize: `${editorFontSize}px` },
          ".cm-content, .cm-gutters": { fontFamily: "inherit" },
        }),
      ];
      if (lang) baseExt.push(lang as Extension);

      mergeRef.current = new MergeView({
        parent: hostRef.current,
        a: { doc: sides.original, extensions: baseExt },
        b: { doc: sides.modified, extensions: baseExt },
        // Word-level intra-line diff highlighting.
        revertControls: undefined,
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 6 },
      });
    }).catch(e => alive && setErr(String(e)));
    return () => {
      alive = false;
      mergeRef.current?.destroy();
      mergeRef.current = null;
    };
    // editorFontStack intentionally not a dep — CM editors honor the
    // CSS `font-family: inherit` from the container, which gets the
    // prefs-driven stack via the wrapper className below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.id, tab.path, editorFontSize]);

  void editorFontStack;

  return (
    // bg MUST be opaque: tab swap keeps the codex/claude terminal
    // mounted under us via visibility-toggle, and xterm's WebGL canvas
    // (per-line bg here is alpha rgba) bleeds through any transparent
    // ancestor. Solid color-bg seals the layer.
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3">
        <span className="font-mono text-[12.5px] text-[var(--color-fg-dim)] truncate">{tab.path}</span>
        <div className="flex gap-1">
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
