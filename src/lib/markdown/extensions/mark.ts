// `==highlight==` as <mark>, via markdown-it-mark. <mark> is already in the
// base allowlist (a document can write one); the find and comment-quote
// overlays are marks too, told apart by their classes.

import markPlugin from "markdown-it-mark";
import type { MdExtension } from "../extension";

export const mark: MdExtension = {
  name: "mark",
  plugin(md) {
    md.use(markPlugin);
  },
};
