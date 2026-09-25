// CodeMirror 6 editor with syntax highlight. Loads file contents, resolves the
// language (manual pick > path > content sniff) and mounts once.
//
// This pane OWNS language resolution: the grammars live in CodeMirror's
// registry, which is reachable only from lazily-loaded panes like this one, so
// `lib/languages` cannot map a path to a language and the answer is written
// back to `tab.syntaxAuto` for the breadcrumb and the picker to read. Loading
// a grammar is a chunk fetch, hence lib/langSwitch guarding every apply.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EditTab, ScratchTab, ExternalTab, Task } from "@/lib/types";
import { EditorState, Compartment, Annotation, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, tooltips } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { search } from "@codemirror/search";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { indentUnit } from "@codemirror/language";
import { taskFileRead, fileReadExternal, taskFileWrite, scratchRead, scratchWrite, scratchSetMeta, revealPath } from "@/lib/ipc";
import { langForId, langForPath } from "@/lib/languageExts";
import { PLAIN_TEXT, effectiveLanguageId, normalizeLanguageId } from "@/lib/languages";
import { detectSyntaxFromContent } from "@/lib/detectSyntax";
import { detectIndent, type IndentStyle } from "@/lib/detectIndent";
import { useCodeIntel, checkoutRoot, grantKey } from "@/store/codeIntel";
import { lspServerFor } from "@/lib/lsp/languages";
import { classifyEditorLoadError, isUnviewable, type EditorLoadError } from "@/lib/editorError";
import { FILE_MANAGER, openInDefaultApp } from "@/lib/openExternal";
import { joinPath } from "@/lib/clipboard";
import { Button } from "@/components/ui/Button";
import { ExternalLink, FolderOpen } from "lucide-react";
import { attachHiddenScrollRestore } from "@/lib/hiddenScrollRestore";
import { reviewCommentsExtension, dispatchSelectionComment } from "./reviewCommentsExt";
import { inlineBlameExtension, invalidateBlame, refreshBlame, markBlameStale } from "./inlineBlameExt";
import { bindingMatches } from "@/lib/shortcuts";
import { padDiskGen, padDiskSettled, registerLivePad, trackPadDiskWrite } from "@/lib/scratchLive";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { resolveEditorTheme, editorSurfaceTheme } from "@/lib/editorTheme";
import { deriveScratchTitle } from "@/lib/scratchTitle";
import { createLangSwitch } from "@/lib/langSwitch";
import { forceParsing } from "@codemirror/language";
import { navHint } from "@/lib/lsp/navHint";
import { gotoLocation as revealLine } from "@/lib/gotoLocation";

/** How long after the last keystroke a scratchpad's buffer is flushed to the
 *  scratch store and its title re-derived. Both ride the TYPING path, so both
 *  are debounced and both bail when the value is unchanged: writing an
 *  identical title through a store setter copies the whole app state and
 *  re-runs every mounted task's selectors (docs/performance.md bear trap 8). */
const SCRATCH_FLUSH_MS = 500;

/** The syntax to highlight this tab with AND its grammar, resolved together:
 *  a manual pick, else the path, else a sniff of the content (an extension-less
 *  file, a `.txt` that is really JSON, and every scratchpad — a pad has no path
 *  at all, so the sniffer is the only thing that CAN decide).
 *
 *  `byPath` is passed in already resolved because the caller runs it
 *  concurrently with reading the file: both are dynamic imports away from the
 *  network of grammar chunks, and doing them in series would show on a cold
 *  editor open.
 *
 *  Writes NOTHING to the store. The automatic answer comes back as `auto` for
 *  the caller to persist once it has committed to this load — patching from in
 *  here would re-render mid-await and race the caller's own claim on the
 *  language switch. */
async function resolveSyntax(
  tab: EditTab | ScratchTab | ExternalTab,
  content: string,
  byPath: { id: string; ext: Extension } | null,
): Promise<{ id: string; ext: Extension | null; auto: string | null }> {
  if (tab.syntax) {
    const id = normalizeLanguageId(tab.syntax);
    return { id, ext: await langForId(id), auto: null };
  }
  if (byPath) return { id: byPath.id, ext: byPath.ext, auto: byPath.id };
  const sniffed = detectSyntaxFromContent(content);
  const id = sniffed ?? (tab.syntaxAuto ? normalizeLanguageId(tab.syntaxAuto) : PLAIN_TEXT);
  return { id, ext: await langForId(id), auto: sniffed };
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

/** CodeMirror's two halves of "how wide is a level": what pressing Tab
 *  inserts, and how wide an existing tab character renders. */
function indentExtension(style: IndentStyle): Extension {
  return [indentUnit.of(style.unit), EditorState.tabSize.of(style.size)];
}

// Marks a doc-replacing transaction as an external reload (file changed on
// disk), not a user edit — so the updateListener skips flipping the dirty dot.
const ExternalReload = Annotation.define<boolean>();

export function EditorPane({ task, tab, active, onContent }: {
  task: Task;
  /** An `edit` tab reads and writes a file in the worktree; a `scratch` tab
   *  (GH #244) reads and writes an untitled buffer in the scratch store and
   *  turns OFF everything that needs a path: inline blame, review comments,
   *  and the changed-on-disk watch. Everything else — the CodeMirror setup,
   *  the theme and language compartments, find, the ⌘S binding — is shared,
   *  because a second editor component would drift from this one inside two
   *  releases. */
  tab: EditTab | ScratchTab | ExternalTab;
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
  const { t } = useTranslation("panels");
  const isScratch = tab.type === "scratch";
  // GH #240: an out-of-task file is read-only and has no task-relative path,
  // so every TASK-SCOPED feature below keys off this rather than `!isScratch`.
  // Blame, review comments and the changed-on-disk watcher all address a file
  // by (task, relative path); an absolute path outside the task has no such
  // address, and asking git about it would be a question about the wrong repo.
  const isTaskFile = tab.type === "edit";
  // The one string that identifies what this editor is showing. Both the
  // mount effect and every path-keyed extension key off it, so a preview tab
  // recycling to another file and a pad are the same kind of change.
  const srcKey = tab.type === "scratch" ? `scratch:${tab.scratchId}` : tab.path;
  // Empty for a pad. Only ever read on branches guarded by `!isScratch`;
  // it exists so the shared code below does not need a cast per use.
  const filePath = tab.type === "edit" ? tab.path : "";

  const hostRef = useRef<HTMLDivElement>(null);
  // Latest onContent in a ref so the mount effect (which only runs on
  // [task.id, tab.path]) always calls the current callback.
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;
  const viewRef = useRef<EditorView | null>(null);
  const langCompRef = useRef(new Compartment());
  // Claimed by every mount, path change and syntax change. Grammar loads are
  // async now (the registry code-splits ~150 of them), so a slow one from a
  // load that has since been superseded has to be dropped rather than
  // dispatched into a view that has moved on. See lib/langSwitch.
  const langSwitchRef = useRef(createLangSwitch());
  // Which language id the compartment currently holds, so switching syntax
  // (or loading a file) doesn't reconfigure it to what it already is.
  const langIdRef = useRef<string | null>(null);
  // Theme lives in its own compartment so font-size / ligatures changes can be
  // reconfigured live without recreating the entire EditorView.
  const themeCompRef = useRef(new Compartment());
  // Indentation is per FILE, not per app: it comes from the buffer's own
  // content, and a reload (or a preview tab recycling onto another file)
  // re-reads it.
  const indentCompRef = useRef(new Compartment());
  // Code intelligence (GH #174) gets the same treatment as blame: its own
  // compartment, so arming a task reconfigures in place instead of rebuilding
  // the view, and with the feature off the extension is never constructed —
  // no client, no server, nothing imported.
  const lspCompRef = useRef(new Compartment());
  // Drops this editor's hold on the shared server. The LAST editor to release
  // a checkout's server is what starts its idle reap, so failing to call this
  // leaks a process holding gigabytes.
  const lspReleaseRef = useRef<(() => void) | null>(null);
  // Blame lives in its own compartment so the pref (and the palette's toggle)
  // can switch it on and off without rebuilding the view. With it off the
  // extension is not constructed at all, so nothing is fetched, no state
  // field exists, and the editor is byte-for-byte what it was before.
  const blameCompRef = useRef(new Compartment());
  // Soft wrap (prefs.editorWordWrap), reconfigured in place like blame.
  const wrapCompRef = useRef(new Compartment());
  const wrapOnRef = useRef<boolean | null>(null);
  // Which value the compartment currently holds, so the toggle effect can skip
  // the run React fires on mount (the view was just built with this value, and
  // reconfiguring would tear the plugins down and rebuild them for nothing).
  const blameOnRef = useRef<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<EditorLoadError | null>(null);
  // Mirrors the tab's `dirty` flag so the CodeMirror updateListener
  // only touches the store on the clean→dirty edge, not every
  // keystroke (patchTab re-renders the whole TabBar).
  const dirtyRef = useRef(false);
  // Scratchpad flush state (GH #244). The last content and title actually
  // written, so the debounced flush can bail when nothing changed; the
  // pending timer; and the unmount flush, rebound by every mount.
  const lastFlushedRef = useRef<string | null>(null);
  const lastTitleRef = useRef<string | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  // Unregisters this pad from lib/scratchLive (the CLI's way into the buffer).
  const unregisterPadRef = useRef<(() => void) | null>(null);
  // Read by the async load below, which outlives the render it started in.
  const activeRef = useRef(active);
  activeRef.current = active;
  const flushScratchRef = useRef<(() => void) | null>(null);

  // Per-task "files changed" tick. Bumped when an agent terminal
  // settles (see app store). We re-read on its rising edge so an open file
  // the agent just rewrote refreshes without a window blur/focus cycle —
  // the common case where the agent runs in the same window the user watches.
  const fsRevision = useApp(s => s.fsRevision[task.id] ?? 0);
  // Bumped by a save here, by the Git panel, and by an agent's commit landing.
  // Blame's answer changes with it.
  const gitRevision = useApp(s => s.gitRevision[task.id] ?? 0);

  // ONE definition of the blame extension, shared by the mount and the toggle
  // effect: two copies of the same `onOpenCommit` would drift.
  const buildBlame = useCallback((enabled: boolean) => enabled && isTaskFile
    ? inlineBlameExtension(task.id, filePath, {
        // A `commit:<sha>` diff, the same scope the History panel opens, so it
        // lands somewhere that already knows how to render a historical
        // revision.
        //
        // A REAL tab, not `openPreviewTab`: the preview slot is very likely the
        // file being read (that is where the annotation was hovered), and
        // recycling it would close the file to show its own history. Reuses an
        // identical diff if one is already open rather than stacking duplicates.
        onOpenCommit: sha => {
          const scope = `commit:${sha}` as const;
          const existing = (useApp.getState().tabs[task.id] ?? []).find(
            t => t.type === "diff" && t.path === filePath && t.scope === scope,
          );
          if (existing) {
            useApp.getState().setActiveTabId(task.id, existing.id);
            return;
          }
          useApp.getState().addTab(task.id, {
            id: crypto.randomUUID(),
            type: "diff",
            path: filePath,
            scope,
            title: `\u0394 ${filePath.split("/").pop() || filePath} @ ${sha.slice(0, 7)}`,
          });
        },
      })
    : [], [task.id, filePath, isTaskFile]);

  const editorFontSize = usePrefs(s => s.editorFontSize);
  const codeLigatures  = usePrefs(s => s.codeLigatures);
  const inlineBlame    = usePrefs(s => s.inlineBlame);
  const editorWordWrap = usePrefs(s => s.editorWordWrap);
  // Syntax theme (atomone, tokyo-night, …), independently configurable per
  // app mode (#40): a dark-optimized theme can look wrong on a light app
  // surface, and vice versa. "auto" within each still follows the app
  // palette so a light app never renders dark tokens on a light bg.
  const editorThemeIdDark  = usePrefs(s => s.editorThemeIdDark);
  const editorThemeIdLight = usePrefs(s => s.editorThemeIdLight);
  const themeMode      = usePrefs(s => s.themeMode);
  const appIsLight     = resolveTheme(themeMode) === "light";
  const editorThemeId  = appIsLight ? editorThemeIdLight : editorThemeIdDark;

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
    let detachScrollRestore: (() => void) | null = null;
    // Reset per-load state up front. This effect re-runs when the path
    // changes (preview tabs reuse one instance + swap tab.path), so a
    // stale error from a prior file — e.g. a binary like .DS_Store that
    // failed the UTF-8 read — must be cleared or it renders on top of the
    // next file's content.
    setErr(null);
    setLoading(true);
    // Where the time goes when a file opens, behind localStorage.editorDebug
    // === "1" (same convention as ptyDebug). Every stage of the open is
    // awaited before the view exists, so a window where the TEXT is on screen
    // unstyled should be impossible; when someone sees one, this says which
    // stage was actually slow instead of inviting a guess.
    const openedAt = performance.now();
    const elog = (stage: string) => {
      try {
        if (localStorage.getItem("editorDebug") !== "1") return;
        // eslint-disable-next-line no-console
        console.log(`[editor] ${Math.round(performance.now() - openedAt)}ms ${stage}`);
      } catch { /* private mode */ }
    };
    const langIsCurrent = langSwitchRef.current.claim();
    (async () => {
      try {
        // The grammar load rides alongside the file read rather than after it:
        // both are async, and a language the user has not opened this session
        // is a chunk fetch, which would otherwise land on the critical path of
        // every cold editor open.
        // A pad's file can be written while this editor loads it (see
        // lib/scratchLive): wait out writes already in flight, and note the
        // generation so one that starts during the load is caught below.
        const pad = tab.type === "scratch" ? [task.id, tab.scratchId] as const : null;
        if (pad) await padDiskSettled(...pad);
        let padGen = pad ? padDiskGen(...pad) : 0;
        const [loaded, byPath] = await Promise.all([
          tab.type === "scratch"
            ? scratchRead(task.id, tab.scratchId)
            // An out-of-task file has no task-relative form, so it cannot go
            // through the contained read (GH #240).
            : tab.type === "external"
              ? fileReadExternal(tab.path)
              : taskFileRead(task.id, tab.path),
          (tab.type === "edit" || tab.type === "external") && !tab.syntax
            ? langForPath(tab.path) : Promise.resolve(null),
        ]);
        if (!alive || !hostRef.current) return;
        let content = loaded;
        elog(`read + grammar (${content.length} chars, ${byPath?.id ?? "no path match"})`);
        const resolved = await resolveSyntax(tab, content, byPath);
        elog(`syntax resolved: ${resolved.id}${resolved.ext ? "" : " (NO GRAMMAR)"}`);
        // A "Set syntax" pick made while the grammar was loading owns the
        // compartment now; this one is stale and must not land on top of it.
        if (!alive || !hostRef.current || !langIsCurrent()) return;
        // Re-read until no pad write began since the last one. Nothing below
        // awaits before the view registers as the live pad, so from here on a
        // write goes into the buffer instead of past it.
        while (pad && padDiskGen(...pad) !== padGen) {
          await padDiskSettled(...pad);
          padGen = padDiskGen(...pad);
          content = await scratchRead(...pad);
          if (!alive || !hostRef.current || !langIsCurrent()) return;
        }
        blameOnRef.current = usePrefs.getState().inlineBlame;
        langIdRef.current = resolved.id;
        const lang = resolved.ext;
        // Persisted AFTER the guard and with nothing awaited behind it, so the
        // re-render it triggers cannot interleave with this load. Bail when
        // unchanged: this runs on every load and every external reload, and an
        // unconditional write is the store churn bear trap 8 is about.
        if (resolved.auto && resolved.auto !== tab.syntaxAuto) {
          useApp.getState().patchTab(task.id, tab.id, { syntaxAuto: resolved.auto });
        }

        // Flip the tab's dirty dot on the first edit after a load/save. A
        // pad is seeded dirty and STAYS dirty for its whole life (nothing has
        // been saved anywhere the user chose), so this is a no-op there after
        // the first call.
        const markDirty = () => {
          if (dirtyRef.current) return;
          dirtyRef.current = true;
          useApp.getState().patchTab(task.id, tab.id, { dirty: true });
        };
        if (tab.type === "scratch") dirtyRef.current = true;
        // ── scratchpad crash safety (GH #244) ──────────────────────────
        // The buffer write and the title derivation both ride the TYPING
        // path, so both are debounced together and both bail when their
        // value is unchanged (docs/performance.md bear trap 8). Neither is
        // "saving": the dirty dot stays on, because nothing has been written
        // anywhere the user chose.
        const flushScratch = (v: EditorView) => {
          if (tab.type !== "scratch") return;
          const text = v.state.doc.toString();
          if (text !== lastFlushedRef.current) {
            lastFlushedRef.current = text;
            trackPadDiskWrite(task.id, tab.scratchId, scratchWrite(task.id, tab.scratchId, text)).catch(() => {});
          }
          // Re-sniff the syntax as the buffer fills. An edit tab resolves
          // this once at mount because its PATH answers, but a pad is always
          // CREATED EMPTY: sniffing only at mount would ask the question at
          // the one moment there is nothing to go on, and the answer would
          // never change however much JSON the user then typed. A manual pick
          // still wins, and an unchanged guess bails.
          const cur0 = (useApp.getState().tabs[task.id] ?? []).find(t => t.id === tab.id);
          if (cur0?.type === "scratch" && !cur0.syntax) {
            const sniffed = detectSyntaxFromContent(text);
            if (sniffed && sniffed !== cur0.syntaxAuto) {
              useApp.getState().patchTab(task.id, tab.id, { syntaxAuto: sniffed });
            }
          }
          const derived = deriveScratchTitle(text);
          // A double-click rename locks the title, exactly like a renamed
          // terminal tab locks against the agent's OSC titles.
          const cur = (useApp.getState().tabs[task.id] ?? []).find(t => t.id === tab.id);
          if (cur?.type !== "scratch" || cur.customTitle) return;
          if (derived === lastTitleRef.current || derived === cur.title) {
            lastTitleRef.current = derived;
            return;
          }
          lastTitleRef.current = derived;
          useApp.getState().patchTab(task.id, tab.id, { title: derived });
          scratchSetMeta(task.id, tab.scratchId, { title: derived }).catch(() => {});
        };
        const scheduleScratchFlush = (v: EditorView) => {
          if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
          flushTimerRef.current = window.setTimeout(() => {
            flushTimerRef.current = null;
            flushScratch(v);
          }, SCRATCH_FLUSH_MS);
        };
        flushScratchRef.current = () => {
          // Unmount flush. ONLY while the pad is still a pad: a Discard-close
          // deletes the record and then unmounts this editor, and re-writing
          // the buffer on the way out would resurrect the note the user just
          // threw away. Promotion changes the tab's type, which is the same
          // check.
          const cur = (useApp.getState().tabs[task.id] ?? []).find(t => t.id === tab.id);
          if (cur?.type !== "scratch") return;
          const v = viewRef.current;
          if (v) flushScratch(v);
        };
        lastFlushedRef.current = content;
        lastTitleRef.current = null;

        // ⌘S → write the buffer to disk. termic NEVER auto-saves; this
        // is the only path that clears `dirty`. Returns true so
        // CodeMirror treats the key as handled and preventDefault's it.
        const saveDoc = (v: EditorView): boolean => {
          // A pad has nowhere to save TO yet. ⌘S opens the promote picker
          // instead of writing to the scratch store: quietly filing the note
          // under `<data_dir>/scratch/` would report success and put it
          // somewhere the user will never look again (GH #244).
          if (tab.type === "scratch") {
            void useUI.getState().askScratchSave(task.id, tab.id);
            return true;
          }
          // No uncontained WRITE pairs with the uncontained read that opened
          // this buffer, deliberately: `task_file_write` refuses absolute
          // paths. Swallow the key rather than let it reach a write that
          // would throw from Rust. The buffer is `readOnly` too, so there is
          // nothing unsaved to lose.
          if (tab.type === "external") {
            useUI.getState().pushToast(t("editor.readOnlyToast"), "info");
            return true;
          }
          const name = tab.path.split("/").pop() || tab.path;
          taskFileWrite(task.id, tab.path, v.state.doc.toString())
            .then(() => {
              dirtyRef.current = false;
              useApp.getState().patchTab(task.id, tab.id, { dirty: false });
              useUI.getState().pushToast(t("editor.savedToast", { name }), "success");
              // Git-only tick (NOT bumpFsRevision: that would make every
              // open editor — this one included — re-read from disk, and a
              // keystroke landing between the write and that re-read would
              // pop a spurious "changed on disk" banner). Must stay in this
              // .then(): bumped before the write resolves, the status could
              // be computed against the old file.
              useApp.getState().bumpGitRevision(task.id);
              // The file on disk is what `git blame` reads, and it just
              // changed: drop the snapshot and let the extension re-fetch.
              if (usePrefs.getState().inlineBlame) {
                invalidateBlame(task.id, tab.path);
                v.dispatch({ effects: refreshBlame.of() });
              }
            })
            .catch(e => useUI.getState().pushToast(t("editor.saveFailed", { error: e }), "error"));
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
              // Keep every tooltip inside the editor pane. CodeMirror otherwise
              // assumes the whole document viewport is available space, so a
              // card anchored at the end of a long line ran under the right
              // panel, and one near the top ran under the tab bar. Applies to
              // the blame card and the review-comment tooltip alike, which is
              // why it is mounted here rather than inside either extension.
              tooltips({
                tooltipSpace: view => {
                  const r = view.scrollDOM.getBoundingClientRect();
                  const pad = 6;
                  return {
                    left: r.left + pad, top: r.top + pad,
                    right: r.right - pad, bottom: r.bottom - pad,
                  };
                },
              }),
              // Selection → the SAME review-comment surface the diff pane
              // uses (GH #28): select, comment, and it queues in the
              // reviewComments store until the user sends the batch from the
              // pending-comments bar. Deliberately not a one-shot "type an
              // @ref at the agent": half the value of commenting on code is
              // making several remarks and shipping them as one instruction.
              // Comments key off `file`, so an editor comment and a diff
              // comment on the same path land in one list.
              // Caveat vs the diff pane: this buffer is EDITABLE, and stored
              // line numbers do not map through edits. A comment made before
              // heavy typing above it can end up quoting the wrong lines. It
              // is bounded (comments are transient, sent then cleared) and
              // clampLine keeps a stale range in bounds.
              !isTaskFile ? [] : reviewCommentsExtension(task.id, filePath,
                // Quiet surface: no icon chasing the mouse down the gutter, no
                // labelled pill over the selection. One gutter icon, only
                // while something is selected. The diff pane keeps both.
                // `source: "editor"` also drops the "I reviewed your changes"
                // framing from the message: this is code the user is reading,
                // not a review of the agent's work.
                { selection: "gutter", hoverGutter: false, source: "editor" }),
              // Out-of-task files are read-only (GH #240). There is no write
              // path for an absolute path, so an editable buffer could only
              // ever invite work that cannot be saved.
              ...(tab.type === "external"
                ? [EditorView.editable.of(false), EditorState.readOnly.of(true)]
                : []),
              // Read off the file rather than assumed: two spaces is wrong for
              // most of what an agent writes (Python is 4, Go and Makefiles are
              // tabs, and a Makefile's tabs are the format). Its own
              // compartment so a reload can re-detect without rebuilding the
              // view. See lib/detectIndent.
              indentCompRef.current.of(indentExtension(detectIndent(content))),
              lspCompRef.current.of([]),
              EditorView.updateListener.of(u => {
                if (u.docChanged) {
                  // A programmatic reload (file changed on disk) carries the
                  // ExternalReload annotation — don't treat it as a user edit,
                  // or the tab would sprout a phantom "modified" dot.
                  if (!u.transactions.some(t => t.annotation(ExternalReload)))
                    markDirty();
                  if (isScratch) scheduleScratchFlush(u.view);
                  onContentRef.current?.(u.view);
                }
              }),
              blameCompRef.current.of(buildBlame(blameOnRef.current ?? false)),
              wrapCompRef.current.of((wrapOnRef.current = usePrefs.getState().editorWordWrap) ? EditorView.lineWrapping : []),
              langCompRef.current.of(lang ? [lang] : []),
              // ⌘-click always answers, even with no server running: it
              // offers to turn code intelligence on for a language something
              // can serve, and says so plainly for one nothing can. Silence
              // was the old behaviour and it reads as a broken editor.
              // Main-chunk safe by construction (see lib/lsp/navHint.ts).
              navHint(task.id, () => langIdRef.current ?? resolved.id, tab.type === "external" ? tab.path : filePath),
              themeCompRef.current.of(
                buildTheme(editorFontSize, codeLigatures, editorThemeId),
              ),
            ],
          }),
          parent: hostRef.current,
        });
        viewRef.current = view;
        elog("view created");
        if (tab.type === "scratch") {
          // An agent's `termic scratchpad write` lands IN this buffer: the human sees
          // it at once, Cmd+Z takes it back, and the immediate flush makes the
          // file agree with the window.
          unregisterPadRef.current = registerLivePad(task.id, tab.scratchId, {
            text: () => view.state.doc.toString(),
            write: (text, append) => {
              const len = view.state.doc.length;
              view.dispatch({
                changes: append ? { from: len, insert: text } : { from: 0, to: len, insert: text },
                userEvent: "input.termic",
              });
              if (flushTimerRef.current !== null) {
                window.clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
              }
              flushScratch(view);
            },
          });
        }
        // The first frame that actually carries a highlight token. If this is
        // hundreds of ms after "view created", the grammar is in place and
        // CodeMirror is still parsing; if the gap is zero, the flash someone
        // reported is not the editor at all.
        if (localStorage.getItem("editorDebug") === "1") {
          const started = performance.now();
          const tick = () => {
            if (!viewRef.current) return;
            if (view.dom.querySelector('[class*="tok-"], .cm-line span')) {
              elog(`first highlighted token (+${Math.round(performance.now() - started)}ms after view)`);
              return;
            }
            if (performance.now() - started > 5000) return;
            setTimeout(tick, 8);
          };
          tick();
        }
        // E2E-only: expose the CodeMirror view on its DOM node so the
        // WebdriverIO suite can drive real edits/saves through the editor's
        // own API (synthetic key/text events don't route to a contenteditable
        // reliably in WKWebView). Stripped from real builds (VITE_E2E unset).
        if (import.meta.env.VITE_E2E) {
          (view.dom as unknown as { __cmView: EditorView }).__cmView = view;
        }
        // Scroll position dies with the box when a hidden task/tab goes
        // display:none in WKWebView — record and re-apply it.
        detachScrollRestore = attachHiddenScrollRestore(view.scrollDOM);
        setLoading(false);
        // A tab opened ACTIVE (⌘P on a file that was not open) mounts with the
        // view still loading, so the focus-on-active effect below finds no view
        // and returns: focus stayed on <body>, and the next ⌘F had no editor to
        // go to. Focus once the view exists, if this tab is still the one in
        // front. A timer for the same reason as that effect.
        if (activeRef.current) {
          window.setTimeout(() => {
            if (viewRef.current === view && activeRef.current) view.focus();
          }, 0);
        }
        // Seed the preview/split wrapper with the live view so it can
        // render before the user makes any edit.
        onContentRef.current?.(view);
        // Initial jump-to-line for Find-in-Files: do it once the view
        // exists. The other useEffect below handles subsequent jumps
        // (clicking a different match while the tab's already open).
        // A pad opens on an empty buffer with the "Untitled" title already
        // set; seed the derivation state so a RESTORED pad whose first line
        // has not changed does not write an identical title back on the first
        // keystroke.
        if (tab.type === "scratch") lastTitleRef.current = deriveScratchTitle(content);
        if (tab.type === "edit" && tab.revealAt) {
          revealLine(view, tab.revealAt.line, tab.revealAt.col);
          useApp.getState().consumeReveal(task.id, tab.id);
        }
        // Colour what is ON SCREEN before handing the editor over.
        //
        // CodeMirror parses from the START of the document, and highlighting
        // needs the tree. Open at the top and the first paint is coloured;
        // open DEEP (a restored scroll position, or a go-to-definition landing
        // at line 2300) and the viewport is a thousand lines past anything
        // parsed, so the text paints plain and colours in only when the
        // background parse catches up. Measured on a 2400-line Python file:
        // text at 31ms, first coloured token at 973ms. That is the "white text
        // for half a second" everybody sees and nobody could place, and it
        // never reproduces at the top of a file, which is where anyone
        // debugging it naturally looks.
        //
        // `forceParsing` runs that parse synchronously up to the end of the
        // viewport, capped. The cap is what keeps this honest: a file too big
        // to parse in the budget falls back to exactly the old behaviour
        // rather than blocking the open. 60ms is under the frame budget this
        // repo holds itself to for an editor open, and covers a few thousand
        // lines of any grammar measured here.
        forceParsing(view, view.viewport.to, 60);
      } catch (e) {
        if (!alive) return;
        // A binary file (.xlsx, archives, compiled blobs, .DS_Store) and one
        // past the read cap are both WRONG-VIEWER states, not failures, and
        // render as a calm notice with a way out; everything else stays a
        // red raw error. See lib/editorError.ts for the rule.
        setErr(classifyEditorLoadError(e));
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
      // Flush the last <500ms of typing before the view goes away (tab
      // switch, task switch, app teardown). Runs BEFORE destroy(), while the
      // doc is still readable.
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flushScratchRef.current?.();
      flushScratchRef.current = null;
      unregisterPadRef.current?.();
      unregisterPadRef.current = null;
      detachScrollRestore?.();
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, srcKey]);

  // True-editor tabs surface a "file changed on disk" prompt instead of
  // silently reloading. Pending until the user acts; rendered only while the
  // tab is focused (see the banner in the return).
  const [diskChanged, setDiskChanged] = useState(false);
  // Focused = this task is up front AND this tab is the active main-pane tab
  // (edit/diff tabs only open in the main pane, not in split panes).
  const isActive = useApp(s => s.activeTaskId === task.id && s.activeTab[task.id] === tab.id);

  // Keyboard route to the same composer. A window listener rather than a
  // CodeMirror keymap entry because the binding is user-rebindable (usePrefs).
  // Which editor answers: the one holding DOM focus; when focus is somewhere
  // else entirely (file tree, terminal, nowhere), the visible active tab. That
  // pair is exclusive, so two mounted editors can never both fire on one press.
  const sendRefBinding = usePrefs(s => s.shortcuts["add-selection-to-agent"]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!bindingMatches(e, sendRefBinding)) return;
      const v = viewRef.current;
      if (!v) return;
      const focused = (document.activeElement as HTMLElement | null)?.closest?.(".cm-editor");
      if (focused ? focused !== v.dom : !isActive) return;
      // Nothing selected: let the key fall through untouched.
      if (!dispatchSelectionComment(v)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sendRefBinding, task.id, isActive]);

  // Swap fresh disk content into the live view, annotated so it doesn't flip
  // the dirty dot. Used by both the silent preview-reload path and the user
  // confirming the true-editor prompt.
  const applyDiskContent = useCallback((content: string) => {
    const v = viewRef.current;
    if (!v || !isTaskFile) return;
    if (content !== v.state.doc.toString())
      v.dispatch({
        effects: indentCompRef.current.reconfigure(indentExtension(detectIndent(content))),
        changes: { from: 0, to: v.state.doc.length, insert: content },
        annotations: ExternalReload.of(true),
      });
    // The buffer now matches disk again, so blame can be trusted again. Same
    // reasoning as the save path, and the same reason docs/ideas/lsp.md wants
    // this path to fire a full-document didChange.
    if (usePrefs.getState().inlineBlame) {
      invalidateBlame(task.id, filePath);
      v.dispatch({ effects: refreshBlame.of() });
    }
    setDiskChanged(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, filePath, isTaskFile]);

  // React to an external change (GH #57). An UNTOUCHED buffer (no unsaved
  // edits) just mirrors disk silently — preview tab or not, source or
  // markdown-preview mode; asking about a file the user never modified was
  // noise, and in markdown preview mode the banner lived inside the hidden
  // editor so nothing visibly refreshed at all. Only a DIRTY buffer gets the
  // banner: reloading would discard real typing, so the user decides.
  const reloadFromDisk = useCallback(() => {
    const v = viewRef.current;
    // A pad has no file on disk to diverge from. Nothing outside this editor
    // can touch its buffer, so there is nothing to watch and nothing to ask
    // about (GH #244).
    if (!v || !isTaskFile) return;
    taskFileRead(task.id, filePath).then(content => {
      const v2 = viewRef.current;
      if (!v2) return;
      if (content === v2.state.doc.toString()) { setDiskChanged(false); return; }
      if (dirtyRef.current) { setDiskChanged(true); return; }
      applyDiskContent(content);
    }).catch(() => {});
  }, [task.id, filePath, isTaskFile, applyDiskContent]);

  // User accepted the prompt: re-read (content may have moved on since the
  // change was detected) and swap it in, discarding the buffer's edits — so
  // the dirty flag must clear too or the dot would lie.
  const acceptDiskReload = useCallback(() => {
    taskFileRead(task.id, filePath).then(content => {
      applyDiskContent(content);
      dirtyRef.current = false;
      useApp.getState().patchTab(task.id, tab.id, { dirty: false });
    }).catch(() => {});
  }, [task.id, filePath, tab.id, applyDiskContent]);

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
    // A timer, not requestAnimationFrame: WebKit freezes rAF while the window
    // is occluded, so a tab that became active in the background would still
    // be unfocused when you came back to it (lib/tabFocus.ts, 0e66f79).
    const timer = window.setTimeout(() => view.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [active]);

  // Reload when an agent terminal in this task settles. Skip the first
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
    const revealAt = tab.type === "edit" ? tab.revealAt : undefined;
    if (!v || !revealAt) return;
    revealLine(v, revealAt.line, revealAt.col);
    useApp.getState().consumeReveal(task.id, tab.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.type === "edit" ? tab.revealAt : undefined, task.id, tab.id]);

  // Toggling the blame pref reconfigures its compartment in place: no view
  // rebuild, so the cursor, undo history and scroll position all survive.
  useEffect(() => {
    const v = viewRef.current;
    if (!v || blameOnRef.current === inlineBlame) return;
    blameOnRef.current = inlineBlame;
    v.dispatch({ effects: blameCompRef.current.reconfigure(buildBlame(inlineBlame)) });
  }, [inlineBlame, buildBlame]);

  // Same in-place reconfigure for word wrap: toggling it from the palette
  // keeps the cursor, undo history and scroll position. The ref records what
  // the view was built with, so a mount never dispatches a no-op transaction.
  useEffect(() => {
    const v = viewRef.current;
    if (!v || wrapOnRef.current === editorWordWrap) return;
    wrapOnRef.current = editorWordWrap;
    v.dispatch({ effects: wrapCompRef.current.reconfigure(editorWordWrap ? EditorView.lineWrapping : []) });
  }, [editorWordWrap]);

  // What this buffer is highlighted as, and the one place a language is
  // decided (a manual Set-syntax pick beats the derived answer). Declared
  // above the code-intelligence effect, which reads it.
  const syntaxId = effectiveLanguageId(tab);

  // ── code intelligence (GH #174) ──────────────────────────────────────────
  //
  // Three things have to be true before a server exists: the feature is
  // OFFERED (app-wide pref, off by default), this task's CHECKOUT is armed
  // (the grant, which is where the memory cost is actually agreed to), and the
  // buffer is a language something can answer for. A pad is excluded outright:
  // it has no path, so it has no URI, and a language server has nothing useful
  // to say about a note.
  const codeIntelOffered = usePrefs(s => s.codeIntelligence);
  const project = useApp(s => s.projects.find(p => p.id === task.project_id));
  const navRoot = checkoutRoot(task, project);
  // Per checkout AND per language: a repo with Python and JavaScript in it is
  // two servers and two decisions, so arming one must not start the other.
  const navServer = lspServerFor(syntaxId, tab.type === "external" ? tab.path : filePath);
  const navArmed = useCodeIntel(s =>
    (navServer ? s.grants[grantKey(navRoot, navServer)]?.length ?? 0 : 0) > 0);
  const navOn = codeIntelOffered && navArmed && !isScratch;
  // The URI the server knows this buffer by. A task file is task-relative and
  // has to be made absolute; an EXTERNAL file (GH #240 — a definition followed
  // into site-packages or the module cache) is already absolute and is NOT
  // under the task at all, which is the whole point of that tab type. Getting
  // this wrong would tell the server about a path that does not exist and it
  // would answer about nothing.
  const navAbsPath = tab.type === "external" ? tab.path : `${task.path}/${filePath}`;
  useEffect(() => {
    // `loading` is in the deps so this runs again once the view exists: the
    // mount effect is async (file read + grammar chunk), so on a cold open
    // this fires first with no view to reconfigure.
    const v = viewRef.current;
    if (!v) return;
    let alive = true;
    const detach = () => {
      lspReleaseRef.current?.();
      lspReleaseRef.current = null;
    };
    if (!navOn) {
      detach();
      // Dropping the extension leaves the LINT state field behind, so the last
      // squiggles a now-dead server reported would stay on screen, pointing at
      // code nobody is checking any more.
      // Both in ONE transaction, with the effects MERGED: setDiagnostics
      // carries its own effect, and overwriting `effects` with the
      // reconfigure would silently drop the clear.
      const clear = setDiagnostics(v.state, []);
      const clearEffects = clear.effects
        ? (Array.isArray(clear.effects) ? clear.effects : [clear.effects])
        : [];
      v.dispatch({ ...clear, effects: [...clearEffects, lspCompRef.current.reconfigure([])] });
      return;
    }
    // The whole subsystem is behind this import, so an unarmed app never
    // fetches the client, the LSP types, or anything they pull in.
    (async () => {
      const { codeIntelExtension } = await import("@/lib/lsp/editorExtension");
      const built = await codeIntelExtension({
        root: navRoot,
        absPath: navAbsPath,
        registryName: syntaxId,
      });
      if (!alive || !built) { built?.release(); return; }
      const view = viewRef.current;
      if (!view) { built.release(); return; }
      detach();
      lspReleaseRef.current = built.release;
      view.dispatch({ effects: lspCompRef.current.reconfigure(built.extension) });
    })();
    return () => { alive = false; detach(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navOn, navRoot, navAbsPath, loading, syntaxId]);

  // "Set syntax" (breadcrumb button / command palette) writes `tab.syntax`;
  // the content sniff writes `tab.syntaxAuto`. Either way the language
  // compartment is reconfigured in place — no view rebuild, so the cursor,
  // undo history and scroll position survive changing a file's syntax.
  useEffect(() => {
    const v = viewRef.current;
    if (!v || langIdRef.current === syntaxId) return;
    langIdRef.current = syntaxId;
    const isCurrent = langSwitchRef.current.claim();
    langForId(syntaxId).then(lang => {
      // Two picks in quick succession resolve in whatever order their chunks
      // fetch in, so the LAST pick wins by claim order, not by arrival.
      if (!isCurrent()) return;
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ effects: langCompRef.current.reconfigure(lang ? [lang] : []) });
    });
  }, [syntaxId]);

  // A commit landing anywhere (Git panel, or the agent committing in its own
  // terminal) can re-attribute lines this file's snapshot already described.
  // Drop the cache, but only MARK the mounted view stale: this tick also fires
  // for staging and unstaging, and re-blaming eagerly would fork git on every
  // click in the Git panel, per open editor, to redraw one line that usually
  // did not change. The refetch rides the reader's next cursor move.
  useEffect(() => {
    if (gitRevision === 0 || !inlineBlame || !isTaskFile) return;
    invalidateBlame(task.id);
    viewRef.current?.dispatch({ effects: markBlameStale.of() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitRevision, task.id, inlineBlame, isTaskFile]);

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

  // Absolute path the two OS actions on the notice act on. A `scratch` pad
  // has no file behind it (and cannot fail either read check anyway), so it
  // has none, and the notice falls back to the raw error rather than offering
  // to open something that does not exist. `external` tabs are already
  // absolute; `edit` paths are task-relative.
  const unviewableAbs =
    tab.type === "external" ? tab.path : tab.type === "edit" ? joinPath(task.path, tab.path) : null;

  return (
    // No chrome bar: the tab already shows the filename, and the old
    // Diff / Open buttons were redundant with the Changes panel and the
    // file tree. The editor fills the whole pane. Opaque bg so nothing
    // bleeds through during the load frame (terminals stay mounted
    // underneath via the visibility-toggle keep-alive).
    <div ref={hostRef} className="relative h-full overflow-hidden bg-[var(--color-bg)]">
      {loading && <div className="p-4 text-[14px] text-[var(--color-fg-dim)]">{t("shared.loading")}</div>}
      {err && isUnviewable(err) && unviewableAbs && (
        <UnviewableFileNotice abs={unviewableAbs} message={err.message} />
      )}
      {err && (!isUnviewable(err) || !unviewableAbs) && (
        <div className="p-4 text-[14px] text-[var(--color-err)]">{t("shared.errorWithMessage", { message: err.message })}</div>
      )}
      {/* Dirty buffers only: disk diverged while the user has unsaved edits,
          so ask before clobbering (clean buffers reload silently, GH #57). */}
      {diskChanged && isActive && (
        <div className="absolute right-3 top-3 z-30 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-2 text-[13px] text-[var(--color-fg)] shadow-lg">
          <span>{t("editor.diskChanged")}</span>
          <button
            onClick={acceptDiskReload}
            className="rounded bg-[var(--color-accent)] px-2 py-[3px] font-medium text-[var(--color-accent-fg)] hover:opacity-90"
          >
            {t("editor.reload")}
          </button>
          <button
            onClick={() => setDiskChanged(false)}
            className="rounded px-2 py-[3px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          >
            {t("editor.keepMine")}
          </button>
        </div>
      )}
    </div>
  );
}

/** The pane a file the editor cannot show lands on: binary, or past the read
 *  cap. Not an error state: the file is fine, this viewer just can't read it,
 *  so the job here is to hand the user off to something that can. The two
 *  cases share a pane because they share an answer, and only the sentence
 *  above the buttons differs. Centered and dimmed to match the sibling
 *  treatments for the same class of file (BinaryDiffBody in the diff pane,
 *  PreviewPane's centered image), rather than red text in the top-left
 *  corner of an otherwise empty pane.
 *
 *  Both actions are the ones already in the path context menu
 *  (CopyPathItems), same wording and same order, calling the same helpers —
 *  so `openInDefaultApp`'s "nothing is registered for .blend, showed it in
 *  Finder instead" toast comes along for free. */
function UnviewableFileNotice({ abs, message }: { abs: string; message: string }) {
  const { t } = useTranslation("panels");
  const name = abs.split("/").pop() || abs;
  const reveal = () => {
    revealPath(abs).catch((e: unknown) => useUI.getState().pushToast(String(e), "error"));
  };
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 p-4 text-center"
      data-testid="unviewable-file-notice"
    >
      <div className="max-w-[420px] text-[13px] text-[var(--color-fg-dim)]">{message}</div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => void openInDefaultApp(abs, name)}>
          <ExternalLink className="h-3.5 w-3.5" /> {t("editor.openInDefaultApp")}
        </Button>
        <Button variant="secondary" size="sm" onClick={reveal}>
          <FolderOpen className="h-3.5 w-3.5" /> {t("editor.revealIn", { manager: FILE_MANAGER })}
        </Button>
      </div>
    </div>
  );
}
