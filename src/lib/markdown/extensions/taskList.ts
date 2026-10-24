// GitHub task lists: a list item starting `[ ]` / `[x]` / `[X]` renders a
// real checkbox. The <input> is a trusted tag (a document-written one is
// removed by claim) and carries its source line as a trusted attr, which the
// preview's delegated click turns into a toggleTask edit (lib/markdown/edit).
// Disabled when the preview cannot edit (HydrateCtx.canEdit).

import type { MdExtension } from "../extension";
import { NONCE, trustMark } from "../trust";

/** What the DocModel records per task item (model.ts `tasks`). */
export interface TaskItem {
  /** 1-based source line of the `[ ]` marker */
  line: number;
  checked: boolean;
  /** the item's first line of text, marker stripped */
  text: string;
}

const MARK = /^\[([ xX])\](?=[ \t]|$)/;

export const taskList: MdExtension = {
  name: "taskList",
  allow: { attrs: ["type", "checked"] },
  trusted: { tags: ["input"], attrs: ["data-task-line"] },
  plugin(md) {
    md.core.ruler.push("task_list", (state) => {
      const tokens = state.tokens;
      for (let i = 2; i < tokens.length; i++) {
        const inline = tokens[i];
        if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
        const m = MARK.exec(inline.content);
        const first = inline.children?.[0];
        // markdown-it joins the `[`, ` ` and `]` back into one text token
        // (text_join) before this rule, so the marker is all in the first one
        if (!m || !inline.map || first?.type !== "text" || !first.content.startsWith(m[0])) continue;
        const checked = m[1] !== " ";
        const line = inline.map[0] + 1;
        first.content = first.content.slice(m[0].length).replace(/^[ \t]+/, "");
        const box = new state.Token("html_inline", "", 0);
        box.content = `<input type="checkbox" class="task-list-item-checkbox"${checked ? " checked" : ""} data-task-line="${NONCE}${line}"${trustMark()}>`;
        inline.children!.unshift(box);
        const li = tokens[i - 2];
        li.attrJoin("class", checked ? "task-list-item task-list-item-done" : "task-list-item");
        const item: TaskItem = { line, checked, text: inline.content.slice(m[0].length).trim().split("\n")[0] };
        li.meta = { ...li.meta, task: item };
      }
    });
  },
  hydrate(host, cx) {
    if (cx.canEdit) return;
    for (const box of Array.from(host.querySelectorAll<HTMLInputElement>("input[data-task-line]"))) box.disabled = true;
  },
};
