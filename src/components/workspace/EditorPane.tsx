// CodeMirror 6 editor with syntax highlight. Loads file contents, picks the
// right language extension by extension, mounts once.

import { useEffect, useRef, useState } from "react";
import type { EditTab, Workspace } from "@/lib/types";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
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
import { StreamLanguage } from "@codemirror/language";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { githubDarkInit } from "@uiw/codemirror-theme-github";
import { Button } from "@/components/ui/Button";
import { workspaceFileRead, openPath } from "@/lib/ipc";
import { FolderOpen, GitCompare } from "lucide-react";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";

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
  const addTab = useApp(s => s.addTab);

  const editorFontSize = usePrefs(s => s.editorFontSize);
  const codeLigatures  = usePrefs(s => s.codeLigatures);

  function buildTheme(sizePx: number, ligatures: boolean) {
    return EditorView.theme({
      "&": { height: "100%", fontSize: `${sizePx}px` },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        // `normal` enables ligatures (=>, !==, etc.); `none` disables them.
        fontVariantLigatures: ligatures ? "normal" : "none",
      },
    });
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const content = await workspaceFileRead(ws.id, tab.path);
        if (!alive || !hostRef.current) return;
        const lang = langForPath(tab.path);
        const view = new EditorView({
          state: EditorState.create({
            doc: content,
            extensions: [
              lineNumbers(),
              history(),
              highlightActiveLine(),
              keymap.of([...defaultKeymap, ...historyKeymap]),
              githubDarkInit({ settings: { background: "#0b0b0d", gutterBackground: "#0b0b0d" } }),
              langCompRef.current.of(lang ? [lang] : []),
              themeCompRef.current.of(buildTheme(editorFontSize, codeLigatures)),
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

  // Re-apply theme compartment when the user changes size or ligatures.
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ effects: themeCompRef.current.reconfigure(buildTheme(editorFontSize, codeLigatures)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorFontSize, codeLigatures]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3">
        <span className="font-mono text-[12.5px] text-[var(--color-fg-dim)] truncate">{tab.path}</span>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() =>
            addTab(ws.id, { id: crypto.randomUUID(), type: "diff", path: tab.path, title: `Δ ${tab.path.split("/").pop()}` })
          }><GitCompare className="h-4 w-4" /> Diff</Button>
          <Button size="sm" variant="ghost" onClick={() => openPath(`${ws.path}/${tab.path}`).catch(() => {})}>
            <FolderOpen className="h-4 w-4" /> Open
          </Button>
        </div>
      </div>
      <div ref={hostRef} className="flex-1 min-h-0 overflow-hidden">
        {loading && <div className="p-4 text-[14px] text-[var(--color-fg-dim)]">Loading…</div>}
        {err && <div className="p-4 text-[14px] text-[var(--color-err)]">Error: {err}</div>}
      </div>
    </div>
  );
}
