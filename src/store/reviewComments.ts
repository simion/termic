// Pending inline review comments — PR-style feedback the user leaves on a
// diff/file, batched and then sent into an agent's PTY in one message
// (GH issue #28). Kept in its own transient store (like ui.ts) so adding a
// comment doesn't churn the task tree, and so the data survives tab
// switches (a DiffPane unmounts its CodeMirror view when you leave the tab,
// but the comments must persist until sent).
//
// A comment is anchored to a file path + a 1-based line range, plus the
// quoted source text at that range. The quote is what makes this robust:
// if the agent has since edited the file, line numbers drift but the quoted
// snippet stays greppable, so the agent can still locate the spot.

import { create } from "zustand";

export interface ReviewComment {
  id: string;
  /** Owning task. Comments are scoped per task. */
  taskId: string;
  /** Repo-relative file path (matches DiffTab.path / EditTab.path). */
  file: string;
  /** 1-based inclusive line range the comment targets. Null for a
   *  file-level comment (no specific lines — "comment on the whole file"). */
  startLine: number | null;
  endLine: number | null;
  /** The source text at the range, verbatim. Empty for file-level
   *  comments. Used both for display and as drift-proof context for the
   *  agent. */
  quote: string;
  /** The user's feedback. */
  body: string;
}

/** A comment-in-progress: range + quote captured, body not yet written.
 *  Lives separately from the committed list so an open composer doesn't
 *  count toward the pending total or get sent. */
export interface DraftComment {
  taskId: string;
  file: string;
  startLine: number | null;
  endLine: number | null;
  quote: string;
}

interface ReviewCommentsState {
  /** Committed comments, keyed by task id. */
  byTask: Record<string, ReviewComment[]>;

  add: (c: Omit<ReviewComment, "id">) => string;
  update: (taskId: string, id: string, body: string) => void;
  remove: (taskId: string, id: string) => void;
  clear: (taskId: string) => void;
}

export const useReviewComments = create<ReviewCommentsState>((set) => ({
  byTask: {},

  add: (c) => {
    const id = crypto.randomUUID();
    set((s) => ({
      byTask: { ...s.byTask, [c.taskId]: [...(s.byTask[c.taskId] ?? []), { ...c, id }] },
    }));
    return id;
  },

  update: (taskId, id, body) =>
    set((s) => ({
      byTask: {
        ...s.byTask,
        [taskId]: (s.byTask[taskId] ?? []).map((c) => (c.id === id ? { ...c, body } : c)),
      },
    })),

  remove: (taskId, id) =>
    set((s) => ({
      byTask: { ...s.byTask, [taskId]: (s.byTask[taskId] ?? []).filter((c) => c.id !== id) },
    })),

  clear: (taskId) =>
    set((s) => {
      if (!s.byTask[taskId]?.length) return s;
      const next = { ...s.byTask };
      delete next[taskId];
      return { byTask: next };
    }),
}));

/** Stable empty array so the per-task selector doesn't return a fresh
 *  reference each render (see docs/gotchas.md — Zustand selector trap). */
const EMPTY: ReviewComment[] = [];

/** Subscribe to one task's pending comments. */
export function useTaskComments(taskId: string): ReviewComment[] {
  return useReviewComments((s) => s.byTask[taskId] ?? EMPTY);
}

/** Compose the batched comments into a single message for an agent. Groups
 *  by file, orders by line, and quotes the targeted source so the agent can
 *  locate each spot even if line numbers have since drifted.
 *
 *  Returns "" when there are no comments. */
export function composeCommentsMessage(comments: ReviewComment[]): string {
  if (!comments.length) return "";

  // Group by file, preserving first-seen file order; sort each file's
  // comments by start line (file-level comments — null line — float first).
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const arr = byFile.get(c.file) ?? [];
    arr.push(c);
    byFile.set(c.file, arr);
  }

  const lineOf = (c: ReviewComment) => c.startLine ?? -1;
  const blocks: string[] = [];

  for (const [file, list] of byFile) {
    list.sort((a, b) => lineOf(a) - lineOf(b));
    for (const c of list) {
      const loc =
        c.startLine == null
          ? file
          : c.endLine != null && c.endLine !== c.startLine
            ? `${file}:${c.startLine}-${c.endLine}`
            : `${file}:${c.startLine}`;

      let block = loc;
      if (c.quote.trim()) {
        // Fence the quoted source so multi-line snippets stay intact and the
        // agent reads them as a reference, not as instructions. Size the
        // fence longer than any backtick run inside the quote so a quoted
        // ``` line (e.g. from a markdown file) can't close the block early.
        const q = c.quote.replace(/\n+$/, "");
        const longest = (q.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
        const fence = "`".repeat(Math.max(3, longest + 1));
        block += `\n${fence}\n${q}\n${fence}`;
      }
      block += `\n${c.body.trim()}`;
      blocks.push(block);
    }
  }

  const intro =
    comments.length === 1
      ? "I reviewed your changes and left an inline comment:"
      : `I reviewed your changes and left ${comments.length} inline comments:`;

  return `${intro}\n\n${blocks.join("\n\n")}`;
}
