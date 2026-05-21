// CodeMirror 6 editor with syntax highlight. Loads file contents, picks the
// right language extension by extension, mounts once.

import { useEffect, useRef, useState } from "react";
import type { EditTab, Workspace } from "@/lib/types";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { search } from "@codemirror/search";
import { lintGutter } from "@codemirror/lint";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { yaml } from "@codemirror/lang-yaml";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { cpp } from "@codemirror/lang-cpp";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { StreamLanguage, indentUnit } from "@codemirror/language";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { workspaceFileRead, workspaceFileWrite } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { resolveEditorTheme, editorSurfaceTheme } from "@/lib/editorTheme";

// Map a file path to a CodeMirror language extension. We match by extension
// first, then fall back to basename heuristics for files like `Dockerfile`,
// `Makefile`, etc. that have no extension.
export function langForPath(p: string) {
  const base = p.split("/").pop() || p;
  const lower = base.toLowerCase();
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";

  // Filename-based (no extension or special name).
  if (/^dockerfile/i.test(base))                           return StreamLanguage.define(dockerFile);
  if (lower === "makefile" || lower.endsWith(".mk"))       return null;  // no good CM grammar
  if (lower === "justfile")                                return StreamLanguage.define(shell);
  if (/^(\.env|\.env\..+)$/i.test(base))                   return StreamLanguage.define(properties);

  // Extension-based.
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext))
    return javascript({ jsx: true, typescript: ext.startsWith("ts") });
  if (["py", "pyi"].includes(ext))                         return python();
  if (ext === "rs")                                        return rust();
  if (ext === "json")                                      return json();
  if (["md", "markdown", "mdx"].includes(ext))             return markdown();
  if (["html", "htm"].includes(ext))                       return html();
  if (ext === "css")                                       return css();
  if (["yaml", "yml"].includes(ext))                       return yaml();
  if (ext === "sql")                                       return sql();
  if (["xml", "svg"].includes(ext))                        return xml();
  if (["c", "cc", "cpp", "cxx", "h", "hpp", "hh"].includes(ext)) return cpp();
  if (ext === "go")                                        return go();
  if (["java", "kt"].includes(ext))                        return java();
  if (["sh", "bash", "zsh", "fish"].includes(ext))         return StreamLanguage.define(shell);
  if (ext === "toml")                                      return StreamLanguage.define(toml);
  if (["rb", "rake"].includes(ext))                        return StreamLanguage.define(ruby);
  if (["properties", "conf", "ini", "env"].includes(ext))  return StreamLanguage.define(properties);
  return null;
}

export function EditorPane({ ws, tab }: { ws: Workspace; tab: EditTab }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompRef = useRef(new Compartment());
  // Theme lives in its own compartment so font-size / ligatures changes can be
  // reconfigured live without recreating the entire EditorView.
  const themeCompRef = useRef(new Compartment());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Mirrors the tab's `dirty` flag so the CodeMirror updateListener
  // only touches the store on the clean→dirty edge, not every
  // keystroke (patchTab re-renders the whole TabBar).
  const dirtyRef = useRef(false);

  const editorFontSize = usePrefs(s => s.editorFontSize);
  const codeLigatures  = usePrefs(s => s.codeLigatures);
  // Syntax theme (atomone, tokyo-night, …). Independent of the app
  // themeMode — surfaces still track the app palette via CSS vars.
  const editorThemeId  = usePrefs(s => s.editorThemeId);

  // Everything in the theme compartment: the chosen syntax theme plus the
  // surface overrides (font-size / ligatures fold in here too). All
  // reconfigure live — no EditorView rebuild, so cursor + undo survive.
  function buildTheme(sizePx: number, ligatures: boolean, themeId: string): Extension[] {
    return [
      resolveEditorTheme(themeId),
      editorSurfaceTheme(sizePx, ligatures),
    ];
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const content = await workspaceFileRead(ws.id, tab.path);
        if (!alive || !hostRef.current) return;
        const lang = langForPath(tab.path);

        // Flip the tab's dirty dot on the first edit after a load/save.
        const markDirty = () => {
          if (dirtyRef.current) return;
          dirtyRef.current = true;
          useApp.getState().patchTab(ws.id, tab.id, { dirty: true });
        };
        // ⌘S → write the buffer to disk. termic NEVER auto-saves; this
        // is the only path that clears `dirty`. Returns true so
        // CodeMirror treats the key as handled and preventDefault's it.
        const saveDoc = (v: EditorView): boolean => {
          const name = tab.path.split("/").pop() || tab.path;
          workspaceFileWrite(ws.id, tab.path, v.state.doc.toString())
            .then(() => {
              dirtyRef.current = false;
              useApp.getState().patchTab(ws.id, tab.id, { dirty: false });
              useUI.getState().pushToast(`Saved ${name}`, "success");
            })
            .catch(e => useUI.getState().pushToast(`Save failed: ${e}`, "error"));
          return true;
        };

        const view = new EditorView({
          state: EditorState.create({
            doc: content,
            extensions: [
              // ⌘S save — first in the array = highest precedence, so it
              // wins over anything basicSetup's keymaps bind.
              keymap.of([{ key: "Mod-s", preventDefault: true, run: saveDoc }]),
              // basicSetup: line numbers, fold gutter, history, indentOnInput,
              // bracket matching, close-brackets, autocomplete, active-line +
              // selection-match highlight, and the default/search/history keymaps.
              basicSetup,
              search({ top: true }),
              lintGutter(),
              indentUnit.of("  "),
              EditorState.tabSize.of(2),
              EditorView.updateListener.of(u => { if (u.docChanged) markDirty(); }),
              langCompRef.current.of(lang ? [lang] : []),
              themeCompRef.current.of(
                buildTheme(editorFontSize, codeLigatures, editorThemeId),
              ),
            ],
          }),
          parent: hostRef.current,
        });
        viewRef.current = view;
        setLoading(false);
      } catch (e) { setErr(String(e)); setLoading(false); }
    })();
    return () => { alive = false; viewRef.current?.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.id, tab.path]);

  // Re-apply theme compartment when the user changes font size,
  // ligatures, or the syntax theme — all reconfigure live.
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({
      effects: themeCompRef.current.reconfigure(
        buildTheme(editorFontSize, codeLigatures, editorThemeId),
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorFontSize, codeLigatures, editorThemeId]);

  return (
    // No chrome bar: the tab already shows the filename, and the old
    // Diff / Open buttons were redundant with the Changes panel and the
    // file tree. The editor fills the whole pane. Opaque bg so nothing
    // bleeds through during the load frame (terminals stay mounted
    // underneath via the visibility-toggle keep-alive).
    <div ref={hostRef} className="h-full overflow-hidden bg-[var(--color-bg)]">
      {loading && <div className="p-4 text-[14px] text-[var(--color-fg-dim)]">Loading…</div>}
      {err && <div className="p-4 text-[14px] text-[var(--color-err)]">Error: {err}</div>}
    </div>
  );
}
