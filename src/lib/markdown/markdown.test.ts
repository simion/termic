// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { ALLOWED_ATTR, ALLOWED_TAGS, claim, EXTENSIONS, inputCannotFetch, renderDoc } from "./engine";
import { createClaim, trustMark, TRUST_MARK } from "./trust";
import { applyDocEdit, taskChange, toggleTask } from "./edit";

// DOMPurify under happy-dom unwraps the FIRST element of its input and lets
// the rest through unsanitized (a test-env quirk, WebKit sanitizes), so docs
// open with a sacrificial line and claim() is tested on what the sanitizer
// would have passed anyway.
function render(src: string) {
  const host = document.createElement("div");
  const doc = renderDoc(`x\n\n${src}`);
  host.innerHTML = doc.html;
  claim(host);
  return { host, model: doc.model };
}

describe("engine allowlist", () => {
  it("composes exactly the pre-extension lists", () => {
    expect(new Set(ALLOWED_TAGS)).toEqual(new Set([
      "p", "br", "hr", "div", "span", "blockquote",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "em", "strong", "s", "del", "ins", "mark", "sub", "sup", "kbd",
      "ul", "ol", "li", "dl", "dt", "dd",
      "pre", "code", "a", "img",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td",
      "details", "summary",
      "input",
    ]));
    expect(new Set(ALLOWED_ATTR)).toEqual(new Set([
      "href", "src", "alt", "title", "align",
      "width", "height", "class", "colspan", "rowspan", "start",
      "data-mermaid", "data-src-line", "data-src-end",
      "type", "checked", "data-task-line", TRUST_MARK,
      "data-fn", "data-fnref",
    ]));
  });

  it("no input leaves the sanitizer able to fetch: src dropped, type only checkbox", () => {
    // tested directly: happy-dom's DOMPurify does not sanitize past the first element
    const keeps = (tag: string, attrName: string, attrValue: string) => {
      const data = { attrName, attrValue, keepAttr: true } as Parameters<typeof inputCannotFetch>[1];
      inputCannotFetch.call(null as never, document.createElement(tag), data, {} as never);
      return data.keepAttr;
    };
    expect(keeps("input", "src", "https://evil.example/beacon")).toBe(false);
    expect(keeps("input", "type", "image")).toBe(false);
    expect(keeps("input", "type", " IMAGE ")).toBe(false);
    expect(keeps("input", "type", "checkbox")).toBe(true);
    expect(keeps("input", "checked", "")).toBe(true);
    // everything else is the allowlist's business, img src included
    expect(keeps("img", "src", "https://example.com/a.png")).toBe(true);
    expect(keeps("ol", "type", "a")).toBe(true);
  });

  it("allows every trusted attr and tag, or ours could not survive the sanitizer", () => {
    for (const e of EXTENSIONS) {
      for (const a of e.trusted?.attrs ?? []) expect(ALLOWED_ATTR).toContain(a);
      for (const t of e.trusted?.tags ?? []) expect(ALLOWED_TAGS).toContain(t);
    }
  });
});

describe("trust", () => {
  it("a document cannot forge any registered trusted attr or tag", () => {
    const attrs = EXTENSIONS.flatMap(e => e.trusted?.attrs ?? []);
    const tags = EXTENSIONS.flatMap(e => e.trusted?.tags ?? []);
    expect(attrs.length).toBeGreaterThan(0);
    const forged = attrs.map(a => `${a}="7"`).join(" ");
    const { host } = render([
      `<div ${forged} ${TRUST_MARK}="guess"><span ${forged}>forged</span></div>`,
      ...tags.map(t => `<${t} ${TRUST_MARK}="guess"></${t}>`),
      "",
    ].join("\n"));
    const div = host.querySelector("div")!;
    for (const a of attrs) {
      // an html_block renders verbatim, so nothing of ours is on the div either
      expect(div.hasAttribute(a)).toBe(false);
      expect(div.querySelector("span")!.hasAttribute(a)).toBe(false);
    }
    for (const t of tags) expect(host.querySelector(t)).toBeNull();
    expect(host.querySelector(`[${TRUST_MARK}]`)).toBeNull();
  });

  it("keeps our stamps, unwrapped to the bare value", () => {
    const { host } = render("# Title\n\npara\n");
    const h = host.querySelector("h1")!;
    expect([h.getAttribute("data-src-line"), h.getAttribute("data-src-end")]).toEqual(["3", "3"]);
  });

  it("trusted tags: ours survive with the mark stripped, a document's are removed", () => {
    const c = createClaim({ attrs: [], tags: ["input"] });
    const host = document.createElement("div");
    host.innerHTML = `<input id="ours"${trustMark()}><input id="forged" ${TRUST_MARK}="nope"><input id="bare">`
      + `<span ${TRUST_MARK}="x">t</span>`;
    c(host);
    expect(Array.from(host.querySelectorAll("input")).map(i => i.id)).toEqual(["ours"]);
    expect(host.querySelector(`[${TRUST_MARK}]`)).toBeNull();
  });

  it("strips UI-chrome markers a document wrote", () => {
    const { host } = render(`<span data-tc-slot data-tc-commented class="tc-x keep">t</span>\n`);
    const s = host.querySelector("span")!;
    expect(s.hasAttribute("data-tc-slot") || s.hasAttribute("data-tc-commented")).toBe(false);
    expect(s.className).toBe("keep");
  });
});

describe("model", () => {
  const SRC = [
    "# Usage",       // 3 (after the sacrificial "x" + blank)
    "",
    "- one",         // 5
    "- two",         // 6
    "",
    "## Usage 1",    // 8
    "",
    "### Usage *x*", // 10
    "",
    "## Usage",      // 12
    "",
    "```ts",         // 14
    "a",
    "```",           // 16
  ].join("\n");

  it("blocks carry the same line ranges as the DOM stamps", () => {
    const { host, model } = render(SRC);
    const dom = Array.from(host.querySelectorAll<HTMLElement>("[data-src-line]"))
      .map(el => [Number(el.dataset.srcLine), Number(el.dataset.srcEnd)]);
    // [0] is the sacrificial paragraph happy-dom unwraps
    expect(model.blocks.slice(1).map(b => [b.startLine, b.endLine])).toEqual(dom);
    expect(model.blocks.map(b => b.kind)).toEqual([
      "paragraph", "heading", "bullet_list", "list_item", "list_item",
      "heading", "heading", "heading", "fence",
    ]);
    expect(model.blocks.find(b => b.kind === "fence")).toMatchObject({ tag: "code", startLine: 14, endLine: 16, depth: 0 });
    expect(model.blocks[3].depth).toBe(1); // list_item inside bullet_list
  });

  it("headings: rendered text, GitHub slugs with duplicate handling", () => {
    const { model } = render(SRC);
    expect(model.headings).toEqual([
      { level: 1, text: "Usage", slug: "usage", line: 3 },
      { level: 2, text: "Usage 1", slug: "usage-1", line: 8 },
      { level: 3, text: "Usage x", slug: "usage-x", line: 10 },
      { level: 2, text: "Usage", slug: "usage-2", line: 12 },
    ]);
  });

  it("CRLF documents number lines the same", () => {
    expect(render(SRC.replace(/\n/g, "\r\n")).model).toEqual(render(SRC).model);
  });
});

describe("breakout", () => {
  const SRC = [
    "| a | b |",            // 3
    "|---|---|",
    "| 1 | 2 |",            // 5
    "",
    "```ts",                // 7
    "x",
    "```",
    "",
    "```mermaid",           // 11
    "graph LR",
    "```",
    "",
    "![one](a.png) ![two](b.png)", // 15
    "",
    "text and ![img](c.png)",      // 17
    "",
    "    indented code",    // 19
    "",
    "- item",               // 21
    "",
    "  ```",
    "  nested",
    "  ```",
  ].join("\n");
  const wrappers = (host: HTMLElement) => Array.from(host.children).filter(el => el.classList.contains("md-wide"));

  it("wraps top-level tables, fences, mermaid and image-only paragraphs, nothing else", () => {
    const { host } = render(SRC);
    const inner = wrappers(host).map(w => {
      expect(w.children).toHaveLength(1);
      return w.firstElementChild!.tagName;
    });
    expect(inner).toEqual(["TABLE", "PRE", "DIV", "P", "PRE"]);
    // a mixed paragraph and a fence inside a list item stay in the flow
    expect(host.querySelector("li .md-wide")).toBeNull();
    expect(Array.from(host.children).filter(el => el.tagName === "P").map(p => p.textContent?.trim())).toContain("text and");
  });

  it("keeps the line stamps on the block inside, none on the wrapper", () => {
    const { host } = render(SRC);
    for (const w of wrappers(host)) {
      expect(w.hasAttribute("data-src-line")).toBe(false);
      expect((w.firstElementChild as HTMLElement).dataset.srcLine).toMatch(/^\d+$/);
    }
    expect(wrappers(host).map(w => Number((w.firstElementChild as HTMLElement).dataset.srcLine)))
      .toEqual([3, 7, 11, 15, 19]);
  });

  it("gives a diagram the fill wrapper, so it takes the wide width and centers", () => {
    const { host } = render(SRC);
    const fill = wrappers(host).filter(w => w.classList.contains("md-wide-fill"));
    expect(fill.map(w => w.firstElementChild!.className)).toEqual(["mermaid-block"]);
  });

  it("adds nothing to the model", () => {
    const blocks = render(SRC).model.blocks;
    expect(blocks.every(b => b.kind !== "html_block")).toBe(true);
  });
});

describe("applyDocEdit", () => {
  const text = "a\nb\nc\n";

  it("replaces the line range", () => {
    expect(applyDocEdit(text, { fromLine: 2, toLine: 3, expect: "b\nc", insert: "B" })).toEqual({ ok: true, text: "a\nB\n" });
    expect(applyDocEdit(text, { fromLine: 1, toLine: 1, expect: "a", insert: "x\ny" })).toEqual({ ok: true, text: "x\ny\nb\nc\n" });
    // the empty line after the trailing newline is line 4
    expect(applyDocEdit(text, { fromLine: 4, toLine: 4, expect: "", insert: "d" })).toEqual({ ok: true, text: "a\nb\nc\nd" });
  });

  it("refuses when the lines moved under it", () => {
    expect(applyDocEdit(text, { fromLine: 2, toLine: 2, expect: "c", insert: "x" })).toEqual({ ok: false, reason: "conflict" });
  });

  it("refuses a range outside the document", () => {
    for (const [fromLine, toLine] of [[0, 1], [2, 1], [1, 5], [1.5, 2]]) {
      expect(applyDocEdit(text, { fromLine, toLine, expect: "", insert: "" })).toEqual({ ok: false, reason: "range" });
    }
  });

  it("CRLF: compares without \\r and writes the document's separator back", () => {
    const crlf = "a\r\nb\r\nc\r\n";
    expect(applyDocEdit(crlf, { fromLine: 2, toLine: 3, expect: "b\nc", insert: "x\ny" })).toEqual({ ok: true, text: "a\r\nx\r\ny\r\n" });
  });
});

describe("taskList", () => {
  it("renders a trusted checkbox per task item, with its source line", () => {
    const { host, model } = render("- [ ] one\n- [x] two\n  * [X] nested\n- not a task\n- [ ]\n");
    const boxes = Array.from(host.querySelectorAll<HTMLInputElement>("input"));
    expect(boxes.map(b => [b.dataset.taskLine, b.checked])).toEqual([["3", false], ["4", true], ["5", true], ["7", false]]);
    expect(boxes.every(b => b.type === "checkbox" && !b.hasAttribute(TRUST_MARK))).toBe(true);
    const items = Array.from(host.querySelectorAll("li"));
    expect(items[0].className).toBe("task-list-item");
    expect(items[1].className).toBe("task-list-item task-list-item-done");
    expect(items[3].className).toBe("");
    expect(items[0].textContent).toBe("one");
    expect(model.tasks).toEqual([
      { line: 3, checked: false, text: "one" },
      { line: 4, checked: true, text: "two" },
      { line: 5, checked: true, text: "nested" },
      { line: 7, checked: false, text: "" },
    ]);
  });

  it("needs the marker first and whitespace after it", () => {
    const { host } = render("- [ ]x\n- text [ ] later\n1. [x] ordered\n");
    expect(Array.from(host.querySelectorAll("input"), b => b.dataset.taskLine)).toEqual(["5"]);
  });

  it("a document's own <input> is removed, even one forging the line", () => {
    const { host } = render('<p><input type="checkbox" data-task-line="3" checked></p>\n\n- [ ] real\n');
    expect(Array.from(host.querySelectorAll("input"), b => b.dataset.taskLine)).toEqual(["5"]);
  });
});

describe("toggleTask", () => {
  const doc = [
    "- [ ] dash", "* [x] star", "+ [X] plus", "1. [ ] ordered", "2) [x] paren",
    "    - [ ] indented", "> - [ ] quoted", "- [ ]", "- not a task", "- [ ]x", "text [ ] x",
  ].join("\n");
  const flip = (line: number) => toggleTask(doc, line)?.insert ?? null;

  it("ticks and unticks every marker style, keeping the rest of the line", () => {
    expect(flip(1)).toBe("- [x] dash");
    expect(flip(2)).toBe("* [ ] star");
    expect(flip(3)).toBe("+ [ ] plus");
    expect(flip(4)).toBe("1. [x] ordered");
    expect(flip(5)).toBe("2) [ ] paren");
    expect(flip(6)).toBe("    - [x] indented");
    expect(flip(7)).toBe("> - [x] quoted");
    expect(flip(8)).toBe("- [x]");
  });

  it("expects exactly the line it read", () => {
    expect(toggleTask(doc, 4)).toEqual({ fromLine: 4, toLine: 4, expect: "1. [ ] ordered", insert: "1. [x] ordered" });
    expect(toggleTask("a\r\n- [ ] b\r\n", 2)).toEqual({ fromLine: 2, toLine: 2, expect: "- [ ] b", insert: "- [x] b" });
  });

  it("refuses a line that does not look like a task", () => {
    for (const line of [0, 9, 10, 11, 12, 99]) expect(toggleTask(doc, line)).toBeNull();
    for (const l of ["> [ ] quote only", "[ ] bare", "-[ ] tight", "- - - - - - - - - - no bracket"]) expect(toggleTask(l, 1)).toBeNull();
  });

  it("ticks a task nested under a list marker or a quote inside a list", () => {
    expect(toggleTask("- > - [ ] x", 1)?.insert).toBe("- > - [x] x");
    expect(toggleTask("1. - [x] y", 1)?.insert).toBe("1. - [ ] y");
    expect(toggleTask("- - [ ] z", 1)?.insert).toBe("- - [x] z");
  });

  it("stays linear on a long line of markers that never reaches a bracket", () => {
    expect(toggleTask("- ".repeat(100_000) + "x", 1)).toBeNull();
    expect(toggleTask(" > -".repeat(100_000), 1)).toBeNull();
  });
});

describe("taskChange", () => {
  const rendered = "# T\n\n- [ ] a\n- [ ] b\n";
  it("is toggleTask when the buffer is the rendered copy", () => {
    expect(taskChange(rendered, rendered, 4)).toEqual(toggleTask(rendered, 4));
  });

  it("follows the line onto a buffer that moved ahead, keeping the rendered line as expect", () => {
    const live = "# T\n\nintro\n\n- [ ] a\n- [ ] b\n";
    expect(taskChange(rendered, live, 4)).toEqual({ fromLine: 6, toLine: 6, expect: "- [ ] b", insert: "- [x] b" });
  });

  it("refuses when the line itself changed, or cannot be followed", () => {
    expect(taskChange(rendered, rendered.replace("- [ ] b", "- [x] b"), 4)).toBeNull();
    // an identical twin shifted onto the number is not this box
    expect(taskChange("- [ ] t\n- [ ] u\n- [ ] t\n", "- [ ] t\n", 1)).toBeNull();
  });
});
