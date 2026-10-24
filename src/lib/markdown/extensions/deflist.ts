// definition lists via markdown-it-deflist:
//
//   Term
//   : Its definition.
//
// dl/dt/dd are in the base allowlist, so this is parsing and styling only.

import deflistPlugin from "markdown-it-deflist";
import type { MdExtension } from "../extension";

export const deflist: MdExtension = {
  name: "deflist",
  plugin(md) {
    md.use(deflistPlugin);
    // the plugin maps a term to [line, line], an empty range: srcLines would
    // stamp it with an end before its start. A term is exactly its one line.
    md.core.ruler.after("block", "deflist_lines", (state) => {
      for (const t of state.tokens) {
        if (t.type === "dt_open" && t.map && t.map[1] === t.map[0]) t.map = [t.map[0], t.map[0] + 1];
      }
    });
  },
};
