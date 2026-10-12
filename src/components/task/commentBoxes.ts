// The review-comment composer and card, as framework-free DOM. Two surfaces
// host them: the CodeMirror review extension (as block widgets, see
// reviewCommentsExt) and the rendered markdown preview (in slots it places
// after the commented block, see previewComments). Both write the same
// reviewComments store, so the boxes own the store calls and the host only
// says where they go and what happens when one closes. Styles are the
// `.tc-comment-*` rules in index.css.

import { i18n } from "@/lib/i18n";
import { useReviewComments, type ReviewComment } from "@/store/reviewComments";
import { sendCommentsToAgent } from "@/lib/sendComments";

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(`panels:reviewExt.${key}`, opts);

function locLabel(start: number | null, end: number | null, file: string): string {
  const base = file.split("/").pop() || file;
  if (start == null) return t("locWholeFile", { file: base });
  if (end != null && end !== start) return t("locLines", { file: base, start, end });
  return t("locLine", { file: base, start });
}

/** Where a comment goes: the task, its file, and the surface that made it
 *  (decides how the batch is worded to the agent, see composeCommentsMessage). */
export interface CommentTarget {
  taskId: string;
  file: string;
  source: "diff" | "editor";
}

/** A comment being written. `id` is set when it edits a queued one. */
export interface ComposerSpec {
  id?: string;
  startLine: number | null;
  endLine: number | null;
  quote: string;
  body: string;
}

// lucide `send` — the same glyph the pending-comments bar puts on its Send
// button, so "this goes to the agent now" looks the same everywhere.
const SEND_ICON_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/>` +
  `<path d="m21.854 2.147-10.94 10.939"/></svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

export function buildComposer(spec: ComposerSpec, target: CommentTarget, host: {
  /** The composer is done. `sent` = it handed the stage to the agent, which
   *  takes focus itself, so the host must not grab it back. */
  onClose: (sent: boolean) => void;
  /** The box changed height after mounting (the textarea grew). */
  onResize?: () => void;
}): HTMLElement {
  const wrap = el("div", "tc-comment-composer");
  const label = locLabel(spec.startLine, spec.endLine, target.file);
  wrap.appendChild(el("div", "tc-comment-loc", label));

  // The selected code, shown as the first "message" in the box. It always
  // travelled with the comment (composeCommentsMessage fences it), but the
  // composer only ever showed a line range, so the send looked like it was
  // sending line numbers. Now the payload is on screen before you commit to
  // it, and the comment below is plainly the second half of the message.
  const quote = spec.quote.replace(/\n+$/, "");
  if (quote) wrap.appendChild(el("div", "tc-comment-quote", quote));

  const ta = el("textarea", "tc-comment-textarea");
  // Send takes the selection with an empty body, so say so rather than
  // implying a comment is required.
  ta.placeholder = quote ? t("placeholderOptional") : t("placeholder");
  ta.value = spec.body;
  // Rough starting height (no layout yet, so `scrollHeight` is 0 here) to
  // keep an edit composer from mounting at one line and popping open a frame
  // later; `autoGrow` corrects for wrapping once it is in the document.
  ta.rows = Math.min(spec.body.split("\n").length, 8);
  ta.spellcheck = false;
  ta.autocapitalize = "off";
  ta.setAttribute("autocorrect", "off");
  wrap.appendChild(ta);

  // Grow with content (Shift+Enter newlines) up to a cap.
  const autoGrow = () => {
    ta.style.height = "auto";
    // border-box, and scrollHeight leaves the borders out: sizing to it alone
    // left the box 2px short of its text, which overflowed into scrollbars
    // (visible once zoom or a classic-scrollbar setting shows them). Scroll
    // only once the cap is actually reached.
    const borders = ta.offsetHeight - ta.clientHeight;
    const want = ta.scrollHeight + borders;
    ta.style.height = `${Math.min(want, 220)}px`;
    ta.style.overflowY = want > 220 ? "auto" : "hidden";
    host.onResize?.();
  };
  ta.addEventListener("input", autoGrow);

  // Two ways out, because a remark on code is sometimes the whole thought
  // and sometimes one of five. "Add to pending" queues it with the rest;
  // "Send" (the accent CTA) ships this one immediately, and the comment body
  // is OPTIONAL there — the selected code alone is a legitimate message.
  // Editing an existing queued comment offers Update only: it is already in
  // the queue, and the bar is where a queue gets sent.
  const editing = !!spec.id;

  const commit = () => {
    const body = ta.value.trim();
    // The selection IS the message; a comment is something you may add to
    // it. So only a comment with nothing in it at all — no quote either,
    // i.e. an empty whole-file remark — has nothing to queue, and that is
    // the one case worth bouncing back to the box.
    if (!body && !quote) { ta.focus(); return; }
    const store = useReviewComments.getState();
    if (spec.id) store.update(target.taskId, spec.id, body);
    else store.add({ ...target, startLine: spec.startLine, endLine: spec.endLine, quote: spec.quote, body });
    host.onClose(false);
  };
  const sendNow = () => {
    const draft: ReviewComment = {
      ...target, id: spec.id ?? "draft", startLine: spec.startLine, endLine: spec.endLine, quote: spec.quote, body: ta.value.trim(),
    };
    void sendCommentsToAgent(target.taskId, [draft], { label });
    host.onClose(true);
  };
  const cancel = () => host.onClose(false);

  const row = el("div", "tc-comment-actions");
  row.appendChild(el("span", "tc-comment-hint", t("hint")));
  row.appendChild(button("tc-btn tc-btn-ghost tc-btn-cancel", i18n.t("common:cancel"), cancel));
  row.appendChild(button("tc-btn tc-btn-ghost tc-btn-queue", editing ? t("update") : t("addToPending"), commit));
  if (!editing) {
    const send = button("tc-btn tc-btn-primary tc-btn-send", "", sendNow);
    send.innerHTML = SEND_ICON_SVG;
    send.appendChild(el("span", "", t("send")));
    send.title = t("sendNowTip");
    row.appendChild(send);
  }
  wrap.appendChild(row);

  ta.addEventListener("keydown", (e) => {
    // Enter takes the accent action (send now), Shift+Enter inserts a
    // newline — chat-composer muscle memory, and the CTA is what Enter
    // should mean. Editing a queued comment has no send button, so there
    // Enter still updates it in place.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (editing) commit(); else sendNow();
    }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    e.stopPropagation(); // keep keystrokes out of the host's keymap
  });

  setTimeout(() => {
    // The composer can mount outside the visible viewport (a file-level
    // comment anchors at doc start). Reveal it before focusing: focus() on an
    // off-screen child of a scroller does not scroll it in.
    wrap.scrollIntoView({ block: "nearest" });
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    autoGrow();
  }, 0);
  return wrap;
}

export function buildCard(comment: ReviewComment, onEdit: () => void): HTMLElement {
  const wrap = el("div", "tc-comment-card");
  const head = el("div", "tc-comment-card-head");
  head.appendChild(el("span", "tc-comment-loc", locLabel(comment.startLine, comment.endLine, comment.file)));
  const tools = el("div", "tc-comment-tools");
  const edit = button("tc-icon-btn", i18n.t("common:edit"), onEdit);
  edit.title = t("editComment");
  tools.appendChild(edit);
  const del = button("tc-icon-btn tc-icon-btn-danger", i18n.t("common:delete"),
    () => useReviewComments.getState().remove(comment.taskId, comment.id));
  del.title = t("deleteComment");
  tools.appendChild(del);
  head.appendChild(tools);
  wrap.appendChild(head);

  // A queued selection with no remark on it is legitimate (the code is the
  // message), but an empty card looks broken. Say what it is instead; the
  // quote itself is right above, in the file.
  const body = comment.body.trim();
  wrap.appendChild(el("div", body ? "tc-comment-body" : "tc-comment-body tc-comment-body-empty",
    body || i18n.t("panels:reviewBar.selectionOnly")));
  return wrap;
}
