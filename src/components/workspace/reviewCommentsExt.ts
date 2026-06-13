// CodeMirror extension that turns a (read-only) diff/file view into a
// PR-style review surface (GH issue #28): select lines → "Add comment",
// type feedback, and it's held in the reviewComments store until the user
// sends the whole batch to an agent. Committed comments render as cards
// pinned under their range; commented lines get a left accent stripe.
//
// This is framework-free DOM (CodeMirror widgets aren't React). It talks to
// the Zustand store directly for persistence, and pushes store changes back
// into the editor via a StateEffect so cards stay in sync when a comment is
// deleted from the pending-comments bar elsewhere.
//
// Only mounted on the MODIFIED side (unified editor, or the `b` pane of a
// side-by-side MergeView) so line numbers and quotes always refer to the
// new file — which is what an agent needs to act.

import {
  EditorView, WidgetType, Decoration, type DecorationSet, showTooltip, type Tooltip,
  ViewPlugin, type PluginValue, gutter, GutterMarker,
} from "@codemirror/view";
import { StateField, StateEffect, type EditorState, RangeSet, type Range } from "@codemirror/state";
import { useReviewComments, type ReviewComment } from "@/store/reviewComments";

/** A comment-in-progress (range + quote captured, body being typed). */
interface Composer {
  mode: "new" | "edit";
  id?: string;
  startLine: number | null;
  endLine: number | null;
  quote: string;
  initialBody: string;
}

interface CommentData {
  /** Committed comments for THIS file, line-sorted. Synced from the store. */
  comments: ReviewComment[];
  composer: Composer | null;
}

interface Ctx {
  wsId: string;
  file: string;
}

const setComments = StateEffect.define<ReviewComment[]>();
const openComposer = StateEffect.define<Composer>();
const closeComposer = StateEffect.define<void>();

const dataField = StateField.define<CommentData>({
  create: () => ({ comments: [], composer: null }),
  update(value, tr) {
    let { comments, composer } = value;
    for (const e of tr.effects) {
      if (e.is(setComments)) {
        comments = e.value;
        // The edited comment was deleted out from under us → drop the composer.
        if (composer?.mode === "edit" && !comments.some(c => c.id === composer!.id)) composer = null;
      } else if (e.is(openComposer)) {
        composer = e.value;
      } else if (e.is(closeComposer)) {
        composer = null;
      }
    }
    if (comments === value.comments && composer === value.composer) return value;
    return { comments, composer };
  },
});

// Which line the mouse is currently over (1-based), or null. Drives the
// per-line "＋ comment" gutter button (GitHub/PR-style hover affordance).
// Module-level singletons reused by every editor instance — each view keeps
// its own field state, exactly like the comment effects above.
const setHoverLine = StateEffect.define<number | null>();
const hoverLineField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHoverLine)) value = e.value;
    return value;
  },
});

const clampLine = (state: EditorState, n: number) => Math.max(1, Math.min(state.doc.lines, n));

function locLabel(start: number | null, end: number | null, file: string): string {
  const base = file.split("/").pop() || file;
  if (start == null) return `${base} · whole file`;
  if (end != null && end !== start) return `${base} · lines ${start}–${end}`;
  return `${base} · line ${start}`;
}

// ── Widgets ───────────────────────────────────────────────────────────────

class ComposerWidget extends WidgetType {
  constructor(readonly c: Composer, readonly ctx: Ctx) { super(); }

  eq(other: ComposerWidget) {
    // Same composer identity → reuse the DOM so an unrelated transaction
    // (e.g. a selection change) doesn't blow away a focused textarea.
    return other.c.mode === this.c.mode
      && other.c.id === this.c.id
      && other.c.startLine === this.c.startLine
      && other.c.endLine === this.c.endLine;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "tc-comment-composer";

    const head = document.createElement("div");
    head.className = "tc-comment-loc";
    head.textContent = locLabel(this.c.startLine, this.c.endLine, this.ctx.file);
    wrap.appendChild(head);

    const ta = document.createElement("textarea");
    ta.className = "tc-comment-textarea";
    ta.placeholder = "Leave a comment for the agent…";
    ta.value = this.c.initialBody;
    ta.rows = 1;
    ta.spellcheck = false;
    ta.autocapitalize = "off";
    ta.setAttribute("autocorrect", "off");
    wrap.appendChild(ta);

    // Start at one line, grow with content (Shift+Enter newlines) up to a cap.
    const autoGrow = () => {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
    };
    ta.addEventListener("input", autoGrow);

    const row = document.createElement("div");
    row.className = "tc-comment-actions";

    const hint = document.createElement("span");
    hint.className = "tc-comment-hint";
    hint.textContent = "↵ to save · ⇧↵ for newline";
    row.appendChild(hint);

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "tc-btn tc-btn-ghost";
    cancel.textContent = "Cancel";
    row.appendChild(cancel);

    const save = document.createElement("button");
    save.type = "button";
    save.className = "tc-btn tc-btn-primary";
    save.textContent = this.c.mode === "edit" ? "Update" : "Comment";
    row.appendChild(save);

    wrap.appendChild(row);

    const commit = () => {
      const body = ta.value.trim();
      if (!body) { ta.focus(); return; }
      const store = useReviewComments.getState();
      if (this.c.mode === "edit" && this.c.id) {
        store.update(this.ctx.wsId, this.c.id, body);
      } else {
        store.add({
          wsId: this.ctx.wsId,
          file: this.ctx.file,
          startLine: this.c.startLine,
          endLine: this.c.endLine,
          quote: this.c.quote,
          body,
        });
      }
      view.dispatch({ effects: closeComposer.of() });
      view.focus();
    };
    const cancelFn = () => {
      view.dispatch({ effects: closeComposer.of() });
      view.focus();
    };

    save.addEventListener("click", commit);
    cancel.addEventListener("click", cancelFn);
    ta.addEventListener("keydown", (e) => {
      // Enter submits; Shift+Enter inserts a newline (chat-composer muscle
      // memory). ⌘/Ctrl+Enter still commits too — it just isn't required.
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancelFn(); }
      e.stopPropagation(); // keep keystrokes out of CodeMirror's keymap
    });

    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); autoGrow(); }, 0);
    return wrap;
  }

  ignoreEvent() { return true; }
}

class CommentCardWidget extends WidgetType {
  constructor(readonly comment: ReviewComment, readonly ctx: Ctx) { super(); }

  eq(other: CommentCardWidget) {
    return other.comment.id === this.comment.id && other.comment.body === this.comment.body;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "tc-comment-card";

    const head = document.createElement("div");
    head.className = "tc-comment-card-head";

    const loc = document.createElement("span");
    loc.className = "tc-comment-loc";
    loc.textContent = locLabel(this.comment.startLine, this.comment.endLine, this.ctx.file);
    head.appendChild(loc);

    const tools = document.createElement("div");
    tools.className = "tc-comment-tools";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "tc-icon-btn";
    edit.title = "Edit comment";
    edit.textContent = "Edit";
    tools.appendChild(edit);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "tc-icon-btn tc-icon-btn-danger";
    del.title = "Delete comment";
    del.textContent = "Delete";
    tools.appendChild(del);

    head.appendChild(tools);
    wrap.appendChild(head);

    const body = document.createElement("div");
    body.className = "tc-comment-body";
    body.textContent = this.comment.body;
    wrap.appendChild(body);

    edit.addEventListener("click", () => {
      view.dispatch({
        effects: openComposer.of({
          mode: "edit",
          id: this.comment.id,
          startLine: this.comment.startLine,
          endLine: this.comment.endLine,
          quote: this.comment.quote,
          initialBody: this.comment.body,
        }),
      });
    });
    del.addEventListener("click", () => {
      useReviewComments.getState().remove(this.ctx.wsId, this.comment.id);
    });

    return wrap;
  }

  ignoreEvent() { return true; }
}

// ── Decorations ─────────────────────────────────────────────────────────────

function buildDeco(state: EditorState, ctx: Ctx): DecorationSet {
  const { comments, composer } = state.field(dataField);
  const ranges: Range<Decoration>[] = [];

  // Accent stripe on every committed-comment line.
  for (const c of comments) {
    if (c.startLine == null || c.endLine == null) continue;
    const a = clampLine(state, c.startLine), b = clampLine(state, c.endLine);
    for (let ln = a; ln <= b; ln++) {
      ranges.push(Decoration.line({ class: "tc-commented-line" }).range(state.doc.line(ln).from));
    }
  }

  // Committed comment cards (skip the one currently being edited).
  for (const c of comments) {
    if (composer?.mode === "edit" && composer.id === c.id) continue;
    const anchor = c.endLine == null ? null : clampLine(state, c.endLine);
    const pos = anchor == null ? 0 : state.doc.line(anchor).to;
    ranges.push(
      Decoration.widget({ widget: new CommentCardWidget(c, ctx), block: true, side: anchor == null ? -1 : 1 }).range(pos),
    );
  }

  // Active composer.
  if (composer) {
    const anchor = composer.endLine == null ? null : clampLine(state, composer.endLine);
    const pos = anchor == null ? 0 : state.doc.line(anchor).to;
    ranges.push(
      Decoration.widget({ widget: new ComposerWidget(composer, ctx), block: true, side: anchor == null ? -1 : 2 }).range(pos),
    );
  }

  return ranges.length ? RangeSet.of(ranges, true) : Decoration.none;
}

// ── Selection tooltip: "Add comment" ────────────────────────────────────────

function commentTooltips(state: EditorState): readonly Tooltip[] {
  const range = state.selection.main;
  if (range.empty) return [];
  const startLine = state.doc.lineAt(range.from).number;
  const endLine = state.doc.lineAt(range.to).number;
  return [{
    pos: range.from,
    above: true,
    arrow: false,
    create(view) {
      const dom = document.createElement("div");
      dom.className = "tc-add-comment-tip";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tc-add-comment-btn";
      btn.textContent = endLine > startLine
        ? `＋ Comment on lines ${startLine}–${endLine}`
        : `＋ Comment on line ${startLine}`;
      // mousedown + preventDefault so the editor doesn't clear the selection
      // before we read it.
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        // Re-clamp against the live doc: the selection that produced this
        // tooltip could in principle reference a line past the doc end.
        const last = view.state.doc.lines;
        const s = Math.max(1, Math.min(startLine, last));
        const en = Math.max(s, Math.min(endLine, last));
        const quote = view.state.sliceDoc(view.state.doc.line(s).from, view.state.doc.line(en).to);
        view.dispatch({
          // Collapse selection so this tooltip dismisses, then open composer.
          selection: { anchor: view.state.doc.line(s).from },
          effects: openComposer.of({ mode: "new", startLine: s, endLine: en, quote, initialBody: "" }),
        });
      });
      dom.appendChild(btn);
      return { dom };
    },
  }];
}

// ── Store subscription plugin ────────────────────────────────────────────────

function commentsForFile(wsId: string, file: string): ReviewComment[] {
  const all = useReviewComments.getState().byWs[wsId] ?? [];
  return all
    .filter((c) => c.file === file)
    .slice()
    // Sort by line, then by id as a stable tiebreaker so comments sharing a
    // line (or both file-level) keep a deterministic order — otherwise the
    // dedup signature could flip and force needless decoration rebuilds.
    .sort((a, b) => (a.startLine ?? -1) - (b.startLine ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function storeSyncPlugin(ctx: Ctx) {
  return ViewPlugin.define((view): PluginValue => {
    // The store fires on EVERY mutation app-wide (any workspace/file), and
    // DiffPane keeps views alive across tab switches + can mount two views
    // for the same file (main + right split). So two guards:
    //   1. `destroyed` — the seed microtask and late subscription callbacks
    //      must never dispatch into a view torn down by a rebuild/tab switch
    //      (CodeMirror throws on dispatch-after-destroy).
    //   2. `lastSig` — only dispatch when THIS file's comments actually
    //      changed, so an edit on an unrelated file doesn't rebuild our
    //      decorations (and selection-only transactions keep the cheap
    //      decoField map path).
    let destroyed = false;
    let lastSig: string | null = null;
    const push = () => {
      if (destroyed) return;
      const list = commentsForFile(ctx.wsId, ctx.file);
      // JSON-encode so a free-form body (spaces, colons, newlines) can't
      // collide with another comment's serialization and suppress an update.
      const sig = JSON.stringify(list.map(c => [c.id, c.startLine, c.endLine, c.body]));
      if (sig === lastSig) return;
      lastSig = sig;
      view.dispatch({ effects: setComments.of(list) });
    };
    const unsub = useReviewComments.subscribe(push);
    // Seed (the store may already hold comments for this file, e.g. when the
    // diff tab is re-opened). Defer so the field is installed first.
    queueMicrotask(push);
    return { destroy() { destroyed = true; unsub(); } };
  });
}

// ── Per-line hover gutter: "＋ comment on this line" ─────────────────────────

// lucide `message-square-plus`, inlined (widgets are framework-free DOM).
const COMMENT_ICON_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>` +
  `<path d="M12 8v6"/><path d="M9 11h6"/></svg>`;

class AddCommentGutterMarker extends GutterMarker {
  constructor(readonly ctx: Ctx, readonly lineNo: number) { super(); }

  eq(other: AddCommentGutterMarker) { return other.lineNo === this.lineNo; }

  toDOM(view: EditorView) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tc-line-add-btn";
    btn.title = "Comment on this line";
    btn.innerHTML = COMMENT_ICON_SVG;
    // mousedown + preventDefault so the click doesn't move the editor
    // selection (and dismiss us) before we read the line.
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const s = clampLine(view.state, this.lineNo);
      const line = view.state.doc.line(s);
      view.dispatch({
        selection: { anchor: line.from },
        effects: openComposer.of({ mode: "new", startLine: s, endLine: s, quote: line.text, initialBody: "" }),
      });
    });
    return btn;
  }
}

/** Gutter that shows a comment button on the single hovered line. */
function commentGutter(ctx: Ctx) {
  return gutter({
    class: "tc-comment-gutter",
    lineMarker(view, block) {
      const hovered = view.state.field(hoverLineField);
      if (hovered == null) return null;
      const lineNo = view.state.doc.lineAt(block.from).number;
      return lineNo === hovered ? new AddCommentGutterMarker(ctx, lineNo) : null;
    },
    // Only recompute markers when the hovered line changes — not on every
    // selection/scroll transaction.
    lineMarkerChange(update) {
      return update.startState.field(hoverLineField) !== update.state.field(hoverLineField);
    },
  });
}

/** Tracks the hovered line and pushes it into `hoverLineField`. Dispatches
 *  only when the line actually changes (coalesced to one rAF per frame) so a
 *  fast mouse sweep doesn't flood the editor with transactions. */
function hoverTrackPlugin() {
  return ViewPlugin.define((view): PluginValue => {
    let current: number | null = null;
    let raf = 0;
    let pending: { x: number; y: number } | null = null;
    const apply = () => {
      raf = 0;
      if (!pending) return;
      const pos = view.posAtCoords(pending);
      const ln = pos == null ? null : view.state.doc.lineAt(pos).number;
      if (ln === current) return;
      current = ln;
      view.dispatch({ effects: setHoverLine.of(ln) });
    };
    const onMove = (e: MouseEvent) => {
      pending = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onLeave = () => {
      pending = null;
      if (current !== null) { current = null; view.dispatch({ effects: setHoverLine.of(null) }); }
    };
    view.scrollDOM.addEventListener("mousemove", onMove);
    view.scrollDOM.addEventListener("mouseleave", onLeave);
    return {
      destroy() {
        if (raf) cancelAnimationFrame(raf);
        view.scrollDOM.removeEventListener("mousemove", onMove);
        view.scrollDOM.removeEventListener("mouseleave", onLeave);
      },
    };
  });
}

// ── Public extension factory ─────────────────────────────────────────────────

/** Build the review-comments extension for one file in one workspace. */
export function reviewCommentsExtension(wsId: string, file: string) {
  const ctx: Ctx = { wsId, file };

  const decoField = StateField.define<DecorationSet>({
    create: (state) => buildDeco(state, ctx),
    update(deco, tr) {
      const before = tr.startState.field(dataField);
      const after = tr.state.field(dataField);
      if (before === after && !tr.docChanged) return deco.map(tr.changes);
      return buildDeco(tr.state, ctx);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const tooltipField = StateField.define<readonly Tooltip[]>({
    create: (state) => commentTooltips(state),
    update(tips, tr) {
      if (!tr.docChanged && !tr.selection) return tips;
      return commentTooltips(tr.state);
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  });

  return [
    dataField,
    hoverLineField,
    decoField,
    tooltipField,
    commentGutter(ctx),
    hoverTrackPlugin(),
    storeSyncPlugin(ctx),
    baseTheme,
  ];
}

/** Open a whole-file comment composer programmatically (DiffPane header). */
export function dispatchFileComment(view: EditorView) {
  view.dispatch({ effects: openComposer.of({ mode: "new", startLine: null, endLine: null, quote: "", initialBody: "" }) });
}

// ── Styling (self-contained; only CSS vars, no hard-coded hex) ───────────────

const baseTheme = EditorView.baseTheme({
  ".tc-commented-line": {
    backgroundColor: "var(--color-accent-soft)",
    boxShadow: "inset 2px 0 0 0 var(--color-accent)",
  },
  ".tc-add-comment-tip": { background: "transparent", border: "none" },
  ".tc-add-comment-btn": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "4px 9px",
    borderRadius: "7px",
    fontSize: "12px",
    fontWeight: "500",
    lineHeight: "1",
    cursor: "pointer",
    color: "#fff",
    background: "var(--color-accent)",
    border: "1px solid var(--color-accent-deep)",
    boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
    whiteSpace: "nowrap",
  },
  ".tc-add-comment-btn:hover": { background: "var(--color-accent-deep)" },
  // Inline thread cards: an accent left rail ties them to the commented-line
  // stripe, a flat fill (no popover shadow) so they read as part of the diff,
  // not floating over it.
  ".tc-comment-card, .tc-comment-composer": {
    margin: "3px 14px 9px 14px",
    padding: "8px 11px 9px",
    borderRadius: "8px",
    border: "1px solid var(--color-border-soft)",
    borderLeft: "2.5px solid var(--color-accent)",
    background: "var(--color-bg-2)",
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  ".tc-comment-composer": { background: "var(--color-bg-1)" },
  ".tc-comment-loc": {
    display: "inline-flex",
    alignItems: "center",
    fontSize: "10.5px",
    fontWeight: "600",
    letterSpacing: "0.01em",
    color: "var(--color-fg-faint)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  ".tc-comment-card-head": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    marginBottom: "5px",
  },
  ".tc-comment-tools": { display: "flex", gap: "2px", opacity: "0", transition: "opacity 120ms" },
  ".tc-comment-card:hover .tc-comment-tools": { opacity: "1" },
  ".tc-comment-body": {
    fontSize: "13px",
    lineHeight: "1.45",
    color: "var(--color-fg)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  ".tc-comment-textarea": {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    margin: "6px 0",
    padding: "6px 8px",
    minHeight: "32px",
    maxHeight: "220px",
    overflowY: "auto",
    resize: "none",
    lineHeight: "1.45",
    borderRadius: "6px",
    border: "1px solid var(--color-border)",
    background: "var(--color-bg)",
    color: "var(--color-fg)",
    fontSize: "13px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    outline: "none",
  },
  ".tc-comment-textarea:focus": { borderColor: "var(--color-accent)" },
  ".tc-comment-actions": { display: "flex", alignItems: "center", gap: "8px" },
  ".tc-comment-hint": { fontSize: "11px", color: "var(--color-fg-faint)", marginRight: "auto" },
  ".tc-btn": {
    padding: "4px 11px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: "500",
    cursor: "pointer",
    border: "1px solid transparent",
  },
  ".tc-btn-ghost": { background: "transparent", color: "var(--color-fg-dim)", borderColor: "var(--color-border)" },
  ".tc-btn-ghost:hover": { background: "var(--color-hover)", color: "var(--color-fg)" },
  ".tc-btn-primary": { background: "var(--color-accent)", color: "#fff", borderColor: "var(--color-accent-deep)" },
  ".tc-btn-primary:hover": { background: "var(--color-accent-deep)" },
  ".tc-icon-btn": {
    padding: "2px 7px",
    borderRadius: "5px",
    fontSize: "11px",
    cursor: "pointer",
    background: "transparent",
    border: "none",
    color: "var(--color-fg-faint)",
  },
  ".tc-icon-btn:hover": { background: "var(--color-hover)", color: "var(--color-fg)" },
  ".tc-icon-btn-danger:hover": { color: "var(--color-err)" },

  // Per-line hover gutter. A slim fixed column so the diff doesn't reflow as
  // the button appears/disappears; the marker only renders on the hovered line.
  ".tc-comment-gutter": { width: "20px" },
  ".tc-comment-gutter .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
  },
  ".tc-line-add-btn": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "17px",
    height: "17px",
    padding: "0",
    border: "none",
    borderRadius: "5px",
    cursor: "pointer",
    color: "#fff",
    background: "var(--color-accent)",
    boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
  },
  ".tc-line-add-btn:hover": { background: "var(--color-accent-deep)" },
  ".tc-line-add-btn svg": { width: "12px", height: "12px" },
});
