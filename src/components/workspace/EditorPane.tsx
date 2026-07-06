// CodeMirror 6 editor with syntax highlight. Loads file contents, picks the
// right language extension by extension, mounts once.

import { useCallback, useEffect, useRef, useState } from "react";
import type { EditTab, Workspace } from "@/lib/types";
import { EditorState, Compartment, Annotation, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
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
import { usePrefs, resolveTheme } from "@/store/prefs";
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
  // HTML-ish template formats reuse the HTML grammar — component markup
  // gets tag highlighting; <script>/<style> blocks won't get deep JS/CSS
  // parsing but the same trade VS Code makes without dedicated extensions.
  if (["html", "htm", "vue", "svelte", "astro", "hbs", "handlebars",
       "ejs", "mustache", "twig", "liquid", "njk"].includes(ext)) return html();
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

// CodeMirror's search/replace panel inputs (plus any future panel that
// renders text inputs) inherit WKWebView's spellcheck + autocorrect.
// They squiggle every regex, identifier, and non-English token the
// user types. A MutationObserver on the view's DOM strips the attrs
// off any input that appears, including inputs added later when the
// search panel opens. Cheap: one observer per editor instance.
const noAutocorrectOnPanelInputs = ViewPlugin.define(view => {
  const strip = (root: ParentNode) => {
    root.querySelectorAll("input, textarea").forEach(el => {
      const i = el as HTMLInputElement | HTMLTextAreaElement;
      i.spellcheck = false;
      i.setAttribute("autocorrect", "off");
      i.setAttribute("autocapitalize", "off");
      i.setAttribute("autocomplete", "off");
    });
  };
  strip(view.dom);
  const mo = new MutationObserver(muts => {
    for (const m of muts) {
      m.addedNodes.forEach(n => {
        if (n instanceof HTMLElement) strip(n);
      });
    }
  });
  mo.observe(view.dom, { childList: true, subtree: true });
  return { destroy() { mo.disconnect(); } };
});

// Marks a doc-replacing transaction as an external reload (file changed on
// disk), not a user edit — so the updateListener skips flipping the dirty dot.
const ExternalReload = Annotation.define<boolean>();

/** Scroll the editor to a 1-based line/col and place the cursor there.
 *  Centers the line vertically. Clamps line to the doc bounds so a stale
 *  grep hit on a file that's since shrunk doesn't blow up. */
function revealLine(view: EditorView, line: number, col?: number) {
  const doc = view.state.doc;
  const safe = Math.max(1, Math.min(line, doc.lines));
  const lineObj = doc.line(safe);
  const pos = col && col > 0
    ? Math.min(lineObj.from + col - 1, lineObj.to)
    : lineObj.from;
  view.dispatch({
    selection: { anchor: pos, head: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  // Defer focus to next frame — if the editor isn't visible yet (lazy
  // mount), focus() would no-op silently. requestAnimationFrame gives
  // the layout a tick to settle.
  requestAnimationFrame(() => view.focus());
}

export function EditorPane({ ws, tab, active, onContent }: {
  ws: Workspace;
  tab: EditTab;
  /** True when this tab is the active main tab — mirrors TerminalPane's
   *  `active` prop so the editor self-focuses on tab switch, closing, etc. */
  active?: boolean;
  /** Called with the live EditorView on load and after every edit. The
   *  markdown split/preview wrapper uses this to render live without
   *  re-reading disk; it reads `view.state.doc` lazily (inside its own
   *  debounce) so we don't stringify the whole buffer on every keystroke.
   *  Plain editor tabs pass nothing. */
  onContent?: (view: EditorView) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Latest onContent in a ref so the mount effect (which only runs on
  // [ws.id, tab.path]) always calls the current callback.
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;
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

  // Per-workspace "files changed" tick. Bumped when an agent terminal
  // settles (see app store). We re-read on its rising edge so an open file
  // the agent just rewrote refreshes without a window blur/focus cycle —
  // the common case where the agent runs in the same window the user watches.
  const fsRevision = useApp(s => s.fsRevision[ws.id] ?? 0);

  const editorFontSize = usePrefs(s => s.editorFontSize);
  const codeLigatures  = usePrefs(s => s.codeLigatures);
  // Syntax theme (atomone, tokyo-night, …). Surfaces track the app
  // palette via CSS vars; the "auto" syntax theme also follows the app
  // palette so a light app never renders dark tokens on a light bg (#40).
  const editorThemeId  = usePrefs(s => s.editorThemeId);
  const themeMode      = usePrefs(s => s.themeMode);
  const appIsLight     = resolveTheme(themeMode) === "light";

  // Everything in the theme compartment: the chosen syntax theme plus the
  // surface overrides (font-size / ligatures fold in here too). All
  // reconfigure live — no EditorView rebuild, so cursor + undo survive.
  function buildTheme(sizePx: number, ligatures: boolean, themeId: string): Extension[] {
    return [
      resolveEditorTheme(themeId, appIsLight),
      editorSurfaceTheme(sizePx, ligatures),
    ];
  }

  useEffect(() => {
    let alive = true;
    // Reset per-load state up front. This effect re-runs when the path
    // changes (preview tabs reuse one instance + swap tab.path), so a
    // stale error from a prior file — e.g. a binary like .DS_Store that
    // failed the UTF-8 read — must be cleared or it renders on top of the
    // next file's content.
    setErr(null);
    setLoading(true);
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
              // Tab indents (and Shift-Tab dedents) instead of moving DOM
              // focus to the next button. High precedence so it wins.
              keymap.of([{ key: "Mod-s", preventDefault: true, run: saveDoc }, indentWithTab]),
              // basicSetup: line numbers, fold gutter, history, indentOnInput,
              // bracket matching, close-brackets, autocomplete, active-line +
              // selection-match highlight, and the default/search/history keymaps.
              basicSetup,
              search({ top: true }),
              // CodeMirror's search panel inputs inherit WKWebView's
              // browser defaults (spellcheck + autocorrect ON), which
              // squiggle every regex / identifier / non-English token
              // the user types into Find/Replace. Strip the attrs on
              // any input that appears inside the editor's DOM.
              noAutocorrectOnPanelInputs,
              lintGutter(),
              indentUnit.of("  "),
              EditorState.tabSize.of(2),
              EditorView.updateListener.of(u => {
                if (u.docChanged) {
                  // A programmatic reload (file changed on disk) carries the
                  // ExternalReload annotation — don't treat it as a user edit,
                  // or the tab would sprout a phantom "modified" dot.
                  if (!u.transactions.some(t => t.annotation(ExternalReload)))
                    markDirty();
                  onContentRef.current?.(u.view);
                }
              }),
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
        // Seed the preview/split wrapper with the live view so it can
        // render before the user makes any edit.
        onContentRef.current?.(view);
        // Initial jump-to-line for Find-in-Files: do it once the view
        // exists. The other useEffect below handles subsequent jumps
        // (clicking a different match while the tab's already open).
        if (tab.revealAt) {
          revealLine(view, tab.revealAt.line, tab.revealAt.col);
          useApp.getState().consumeReveal(ws.id, tab.id);
        }
      } catch (e) {
        if (!alive) return;
        const msg = String(e);
        // Binary files (.DS_Store, images, compiled blobs) fail the Rust
        // UTF-8 read. Show a human message instead of the raw stream error.
        setErr(/valid UTF-8/i.test(msg)
          ? "This file isn't valid UTF-8 text (it looks binary), so it can't be shown in the editor."
          : msg);
        setLoading(false);
      }
    })();
    return () => { alive = false; viewRef.current?.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.id, tab.path]);

  // True-editor tabs surface a "file changed on disk" prompt instead of
  // silently reloading. Pending until the user acts; rendered only while the
  // tab is focused (see the banner in the return).
  const [diskChanged, setDiskChanged] = useState(false);
  // Focused = this workspace is up front AND this tab is the active main-pane tab
  // (edit/diff tabs only open in the main pane, not in split panes).
  const isActive = useApp(s => s.activeWorkspaceId === ws.id && s.activeTab[ws.id] === tab.id);

  // Swap fresh disk content into the live view, annotated so it doesn't flip
  // the dirty dot. Used by both the silent preview-reload path and the user
  // confirming the true-editor prompt.
  const applyDiskContent = useCallback((content: string) => {
    const v = viewRef.current;
    if (!v) return;
    if (content !== v.state.doc.toString())
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: content },
        annotations: ExternalReload.of(true),
      });
    setDiskChanged(false);
  }, []);

  // React to an external change (GH #57). An UNTOUCHED buffer (no unsaved
  // edits) just mirrors disk silently — preview tab or not, source or
  // markdown-preview mode; asking about a file the user never modified was
  // noise, and in markdown preview mode the banner lived inside the hidden
  // editor so nothing visibly refreshed at all. Only a DIRTY buffer gets the
  // banner: reloading would discard real typing, so the user decides.
  const reloadFromDisk = useCallback(() => {
    const v = viewRef.current;
    if (!v) return;
    workspaceFileRead(ws.id, tab.path).then(content => {
      const v2 = viewRef.current;
      if (!v2) return;
      if (content === v2.state.doc.toString()) { setDiskChanged(false); return; }
      if (dirtyRef.current) { setDiskChanged(true); return; }
      applyDiskContent(content);
    }).catch(() => {});
  }, [ws.id, tab.path, applyDiskContent]);

  // User accepted the prompt: re-read (content may have moved on since the
  // change was detected) and swap it in, discarding the buffer's edits — so
  // the dirty flag must clear too or the dot would lie.
  const acceptDiskReload = useCallback(() => {
    workspaceFileRead(ws.id, tab.path).then(content => {
      applyDiskContent(content);
      dirtyRef.current = false;
      useApp.getState().patchTab(ws.id, tab.id, { dirty: false });
    }).catch(() => {});
  }, [ws.id, tab.path, tab.id, applyDiskContent]);

  // Reload on window focus: covers external edits while away (another app,
  // a `git` in a real terminal, an agent in a different window).
  useEffect(() => {
    window.addEventListener("focus", reloadFromDisk);
    return () => window.removeEventListener("focus", reloadFromDisk);
  }, [reloadFromDisk]);

  // Mirror TerminalPane's active-focus pattern: when this tab becomes the
  // active main tab, focus the editor. Belt-and-suspenders alongside
  // focusMainTab() — ensures focus lands even when DOM timing is tricky
  // (split panes, Radix dialogs, visibility toggling).
  useEffect(() => {
    if (!active) return;
    const view = viewRef.current;
    if (!view) return;
    requestAnimationFrame(() => view.focus());
  }, [active]);

  // Reload when an agent terminal in this workspace settles. Skip the first
  // run (the mount effect already loaded fresh content); thereafter every
  // bump of fsRevision means a turn finished and the file may have changed.
  const fsFirstRef = useRef(true);
  useEffect(() => {
    if (fsFirstRef.current) { fsFirstRef.current = false; return; }
    reloadFromDisk();
  }, [fsRevision, reloadFromDisk]);

  // Subsequent jumps: tab.revealAt changes when the user clicks a new
  // Find-in-Files result for an already-open file. Mount effect above
  // handles the first jump (view doesn't exist yet at that point).
  useEffect(() => {
    const v = viewRef.current;
    if (!v || !tab.revealAt) return;
    revealLine(v, tab.revealAt.line, tab.revealAt.col);
    useApp.getState().consumeReveal(ws.id, tab.id);
  }, [tab.revealAt, ws.id, tab.id]);

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
  }, [editorFontSize, codeLigatures, editorThemeId, appIsLight]);

  return (
    // No chrome bar: the tab already shows the filename, and the old
    // Diff / Open buttons were redundant with the Changes panel and the
    // file tree. The editor fills the whole pane. Opaque bg so nothing
    // bleeds through during the load frame (terminals stay mounted
    // underneath via the visibility-toggle keep-alive).
    <div ref={hostRef} className="relative h-full overflow-hidden bg-[var(--color-bg)]">
      {loading && <div className="p-4 text-[14px] text-[var(--color-fg-dim)]">Loading…</div>}
      {err && <div className="p-4 text-[14px] text-[var(--color-err)]">Error: {err}</div>}
      {/* Dirty buffers only: disk diverged while the user has unsaved edits,
          so ask before clobbering (clean buffers reload silently, GH #57). */}
      {diskChanged && isActive && (
        <div className="absolute right-3 top-3 z-30 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-2 text-[13px] text-[var(--color-fg)] shadow-lg">
          <span>This file changed on disk. Reload discards your edits.</span>
          <button
            onClick={acceptDiskReload}
            className="rounded bg-[var(--color-accent)] px-2 py-[3px] font-medium text-white hover:opacity-90"
          >
            Reload
          </button>
          <button
            onClick={() => setDiskChanged(false)}
            className="rounded px-2 py-[3px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          >
            Keep mine
          </button>
        </div>
      )}
    </div>
  );
}
