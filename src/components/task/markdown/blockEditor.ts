// Edit one rendered block in place: double-click a block (or the gutter's
// pencil) and a small CodeMirror opens in a slot over it, seeded with the
// block's exact source lines. ⌘Enter, ⌘S or blur commits a DocEdit through
// the preview's write path; Esc cancels. The block is hidden while its editor
// is open.
//
// The editor lives in a slot (previewSlots), so it survives the preview's
// full rebuilds, and follows its block across them by diffing the source
// (remapRange): lines shifting above it are fine. When the block's own lines
// change underneath (an agent wrote the file, or the split editor), the
// editor keeps the user's text and offers "Take theirs" / "Use mine". When
// the change reaches past the block, where the block went is a guess, so
// nothing is written: "Use mine" becomes "Copy mine". See docs/markdown.md.

import { useEffect, useRef, type RefObject } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { i18n } from "@/lib/i18n";
import { kbd } from "@/lib/platform";
import { langForId } from "@/lib/languageExts";
import { editorSurfaceTheme, resolveEditorTheme } from "@/lib/editorTheme";
import type { PreviewEditTarget } from "@/lib/markdown/edit";
import { elRange, remapRange, sliceLines, type LineRange } from "@/lib/markdown/lines";
import { copyToClipboard } from "@/lib/clipboard";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { useUI } from "@/store/ui";
import { inChrome, newSlot } from "./previewSlots";

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(`panels:mdEdit.${key}`, opts);
const rangeLabel = (a: number, b: number) => a === b ? t("lineOne", { line: a }) : t("lineRange", { start: a, end: b });

// table parts are not blocks of their own to edit: the table is
const TABLE_PART = "thead, tbody, tfoot, tr, th, td";

/** The block a double-click (or the gutter's pencil) on `target` edits: the
 *  innermost stamped element holding it (a list item, not the list; the
 *  paragraph inside a quote), except that anything in a table edits the
 *  table. Null outside the document or inside app UI (a slot, a checkbox). */
export function editableBlock(target: Element, host: HTMLElement): HTMLElement | null {
  if (!host.contains(target) || inChrome(target) || target.closest("input")) return null;
  let el = target.closest<HTMLElement>("[data-src-line]");
  if (el?.matches(TABLE_PART)) el = el.closest<HTMLElement>("table[data-src-line]") ?? el;
  return el && host.contains(el) ? el : null;
}

/** The gutter pencil's tooltip for a hovered number's range. */
export const editBlockTitle = (r: LineRange) => t("editBlock", { range: rangeLabel(r.startLine, r.endLine) });

/** `s` without its trailing newlines. A loop, not /\n+$/: that regex is
 *  quadratic on a long run of blank lines followed by text. */
function trimNewlines(s: string): string {
  let e = s.length;
  while (e && s.charCodeAt(e - 1) === 10) e--;
  return s.slice(0, e);
}

/** The code header codeHeader puts before a <pre>: app chrome that belongs
 *  to the block, so it hides and shows with it. */
function chromeOf(el: HTMLElement): HTMLElement | null {
  const prev = el.previousElementSibling;
  return prev instanceof HTMLElement && prev.matches(".md-code-head") ? prev : null;
}

function setBlockHidden(el: HTMLElement, hidden: boolean) {
  el.hidden = hidden;
  const head = chromeOf(el);
  if (head) head.hidden = hidden;
}

interface Session {
  slot: HTMLElement;
  view: EditorView;
  startLine: number;
  endLine: number;
  /** the source startLine/endLine are lines of; remapRange from here */
  text: string;
  /** the source in which a rendered block of `tag` was last seen at exactly
   *  startLine..endLine. "Use mine" writes only when that is `text`: a line
   *  diff alone cannot tell "the heading was rewritten" from "a paragraph was
   *  added above and the heading rewritten" */
  placed: string;
  tag: string;
  /** the block's lines when the editor opened: the edit's `expect` */
  original: string;
  block: HTMLElement | null;
  /** the bar is up (changed or lost): blur no longer commits */
  conflict: boolean;
  /** where the block went is not known: nothing may be written */
  lost: boolean;
  /** "Use mine" was pressed while the buffer was ahead of the render: the
   *  next place() that confirms the block runs it */
  pendingMine: boolean;
  setConflict(on: boolean): void;
  setLost(): void;
  setLabel(): void;
}

export function useBlockEditor({ hostRef, edit, text, focusPane }: {
  hostRef: RefObject<HTMLElement | null>;
  edit: PreviewEditTarget | undefined;
  /** the source the preview rendered: what a block's lines are seeded from */
  text: string;
  focusPane: () => void;
}) {
  const live = useRef({ edit, text, focusPane });
  live.current = { edit, text, focusPane };
  const sessionRef = useRef<Session | null>(null);

  function close(refocus: boolean) {
    const s = sessionRef.current;
    if (!s) return;
    sessionRef.current = null;
    s.view.destroy();
    s.slot.remove();
    if (s.block) setBlockHidden(s.block, false);
    if (refocus) live.current.focusPane();
  }

  /** Move the session's range onto `next` (a newer copy of the source).
   *  False when where the block went is not known. */
  function follow(s: Session, next: string): boolean {
    if (s.lost) return false;
    const m = remapRange(s.text, next, s);
    s.text = next;
    if (!m) { s.setLost(); return false; }
    if (m.startLine !== s.startLine || m.endLine !== s.endLine) {
      s.startLine = m.startLine;
      s.endLine = m.endLine;
      s.setLabel();
    }
    if (m.changed) s.setConflict(true);
    return true;
  }

  function commit(force: boolean): void {
    const s = sessionRef.current;
    const target = live.current.edit;
    if (!s || !target?.canEdit) return;
    const mine = trimNewlines(s.view.state.doc.toString());
    if (!force && mine === s.original) { close(true); return; }
    // the buffer may be ahead of the rendered copy (the typing debounce, an
    // agent's write): follow the block onto it before writing anything
    if (!follow(s, target.text()) || (s.conflict && !force)) return;
    // the buffer is ahead of the render: the coming rebuild checks the block
    // is still one block at these lines, then place() runs "Use mine"
    if (force && s.text !== s.placed) { s.pendingMine = true; return; }
    // "Use mine": the block's own lines changed and nothing else did, so
    // replace whatever they read now
    const expect = force ? target.read(s.startLine, s.endLine) : s.original;
    const outcome = expect == null ? "range"
      : target.apply({ fromLine: s.startLine, toLine: s.endLine, expect, insert: mine },
        t("editedRange", { range: rangeLabel(s.startLine, s.endLine) }));
    if (outcome === "applied") close(true);
    else s.setConflict(true);
  }

  function open(el: HTMLElement): boolean {
    const host = hostRef.current;
    const target = live.current.edit;
    if (!host || !target?.canEdit || !host.contains(el) || !el.dataset.srcLine) return false;
    close(false);
    const r = elRange(el);
    if (!r) return false;
    const { startLine, endLine } = r;
    const original = sliceLines(live.current.text, startLine, endLine);

    const slot = newSlot();
    slot.className = "tc-block-editor";
    const head = document.createElement("div");
    head.className = "tc-block-editor-head";
    const label = document.createElement("span");
    const hint = document.createElement("span");
    hint.className = "tc-block-editor-hint";
    hint.textContent = t("hint", { save: kbd("⌘↵") });
    head.append(label, hint);
    const body = document.createElement("div");
    body.className = "tc-block-editor-body";
    const bar = document.createElement("div");
    bar.className = "tc-block-editor-conflict";
    bar.hidden = true;
    const msg = document.createElement("span");
    const btn = (cls: string, text: string, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `tc-btn ${cls}`;
      b.textContent = text;
      b.addEventListener("click", run);
      return b;
    };
    const mineBtn = btn("tc-btn-primary", t("useMine"), () => {
      if (!s.lost) { commit(true); return; }
      void copyToClipboard(trimNewlines(view.state.doc.toString()), t("copyMineLabel"));
      close(true);
    });
    bar.append(msg, btn("tc-btn-ghost", t("takeTheirs"), () => close(true)), mineBtn);
    const foot = document.createElement("div");
    foot.className = "tc-block-editor-foot";
    foot.append(btn("tc-btn-ghost", t("cancel"), () => close(true)), btn("tc-btn-primary", t("save"), () => commit(false)));
    slot.append(head, body, bar, foot);

    const p = usePrefs.getState();
    const appIsLight = resolveTheme(p.themeMode) === "light";
    const lang = new Compartment();
    const view = new EditorView({
      parent: body,
      state: EditorState.create({
        doc: original,
        selection: { anchor: original.length },
        extensions: [
          keymap.of([
            { key: "Mod-Enter", run: () => { commit(false); return true; } },
            { key: "Mod-s", preventDefault: true, run: () => { commit(false); return true; } },
            { key: "Escape", run: () => { close(true); return true; } },
          ]),
          history(),
          drawSelection(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          lang.of([]),
          resolveEditorTheme(appIsLight ? p.editorThemeIdLight : p.editorThemeIdDark, appIsLight),
          editorSurfaceTheme(p.editorFontSize, p.codeLigatures),
        ],
      }),
    });
    // markdown's grammar is already loaded by the tab's own editor, so this
    // lands at once; the editor opens without waiting for it either way
    // e2e only, as in EditorPane: the suite drives CodeMirror through its API
    if (import.meta.env.VITE_E2E) (view.dom as unknown as { __cmView: EditorView }).__cmView = view;
    void langForId("markdown").then(ext => {
      if (ext && sessionRef.current?.view === view) view.dispatch({ effects: lang.reconfigure(ext) });
    });

    const s: Session = {
      slot, view, startLine, endLine, text: live.current.text, placed: live.current.text, tag: el.tagName, original, block: el,
      conflict: false, lost: false, pendingMine: false,
      setConflict(on) {
        s.conflict = on;
        bar.hidden = !on;
        slot.classList.toggle("tc-block-editor-stale", on);
        if (on && !s.lost) msg.textContent = t("conflict");
      },
      setLost() {
        s.lost = true;
        s.setConflict(true);
        msg.textContent = t("lost");
        mineBtn.textContent = t("copyMine");
      },
      setLabel() { label.textContent = t("editing", { range: rangeLabel(s.startLine, s.endLine) }); },
    };
    s.setLabel();
    sessionRef.current = s;

    // keep focus in the editor when its chrome is clicked (the buttons act
    // on click; WebKit does not focus a clicked button anyway)
    slot.addEventListener("mousedown", e => {
      if (!(e.target as Element).closest(".cm-editor")) e.preventDefault();
    });
    slot.addEventListener("keydown", e => { if (e.key === "Escape") e.stopPropagation(); });
    // blur commits, unless focus only moved within the editor, the window
    // lost focus, a rebuild is moving the slot, or a conflict is on screen.
    // Deferred: focus lands on its new element after focusout.
    slot.addEventListener("focusout", () => {
      setTimeout(() => {
        if (sessionRef.current !== s || s.conflict || !slot.isConnected || !document.hasFocus()) return;
        if (slot.contains(document.activeElement)) return;
        commit(false);
      }, 0);
    });

    (chromeOf(el) ?? el).before(slot);
    setBlockHidden(el, true);
    view.focus();
    return true;
  }

  /** After a rebuild: follow the block onto the new source, hide it and put
   *  the editor back over it. A block that cannot be followed is lost: the
   *  editor parks where its lines were and shows the bar. */
  function place() {
    const s = sessionRef.current;
    const host = hostRef.current;
    if (!s || !host) return;
    follow(s, live.current.text);
    const stamped = Array.from(host.querySelectorAll<HTMLElement>("[data-src-line]"));
    const at = (b: HTMLElement) => elRange(b) ?? { startLine: 0, endLine: 0 };
    const el = s.lost ? null
      : stamped.find(b => b.tagName === s.tag && at(b).startLine === s.startLine && at(b).endLine === s.endLine) ?? null;
    s.block = el;
    if (el) s.placed = s.text;
    // no block of its kind at exactly those lines: either a changed range
    // reached outside it after all, or an edit just outside it reshaped the
    // block (a lazy continuation line, a setext underline). Lost either way.
    else if (!s.lost) s.setLost();
    if (el) {
      // the code header (if any) comes back in hydrate, after this, and
      // codeHeader hides it beside a hidden <pre>
      setBlockHidden(el, true);
      if (el.previousSibling !== s.slot) el.before(s.slot);
      if (s.pendingMine) { s.pendingMine = false; commit(true); }
      return;
    }
    s.pendingMine = false;
    // ponytail: no block at those lines any more; park the editor before the
    // next top-level block, under the lost bar.
    let next: Element | null = stamped.find(b => at(b).startLine >= s.startLine) ?? null;
    while (next && next.parentElement !== host) next = next.parentElement;
    if (next) { if (next.previousSibling !== s.slot) next.before(s.slot); }
    else if (host.lastChild !== s.slot) host.append(s.slot);
  }

  /** Never on a link: its first click already followed it. */
  function onDoubleClick(e: React.MouseEvent) {
    const host = hostRef.current;
    if (!host || !live.current.edit?.canEdit) return;
    if ((e.target as Element).closest("a")) return;
    const el = editableBlock(e.target as Element, host);
    if (!el) return;
    window.getSelection()?.removeAllRanges();
    open(el);
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => close(false), []);
  // a read-only preview has nothing to commit to
  useEffect(() => { if (!edit?.canEdit) close(false); }, [edit?.canEdit]);

  /** `open(el)`: the gutter pencil's way in, on any block of this preview
   *  (editableBlock picks the table for a row). False when it cannot edit. */
  return {
    place, onDoubleClick, close: () => close(false),
    open: (el: HTMLElement) => {
      const host = hostRef.current;
      const b = host && editableBlock(el, host);
      return !!b && open(b);
    },
  };
}
