// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { clipboardHtmlForRange } from "./markdownCopy";

function host(html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "markdown-body";
  el.innerHTML = html;
  document.body.replaceChildren(el);
  return el;
}

function rangeOver(start: Node, startOff: number, end: Node, endOff: number): Range {
  const r = document.createRange();
  r.setStart(start, startOff);
  r.setEnd(end, endOff);
  return r;
}

function selectAll(el: HTMLElement): Range {
  const r = document.createRange();
  r.selectNodeContents(el);
  return r;
}

describe("clipboardHtmlForRange", () => {
  it("keeps links, emphasis and code, and drops classes and styles", () => {
    const h = host('<p class="x" style="color:red">See <strong>the <a class="l" href="https://example.com/a">docs</a></strong> and <code style="background:#000">npm test</code>.</p>');
    expect(clipboardHtmlForRange(selectAll(h), h))
      .toBe('<p>See <strong>the <a href="https://example.com/a">docs</a></strong> and <code>npm test</code>.</p>');
  });

  it("re-wraps list items in their list so the paste keeps its bullets", () => {
    const h = host("<ul><li>one</li><li>two</li><li>three</li></ul>");
    const lis = h.querySelectorAll("li");
    const html = clipboardHtmlForRange(rangeOver(lis[0].firstChild!, 1, lis[1].firstChild!, 2), h);
    expect(html).toBe("<ul><li>ne</li><li>tw</li></ul>");
  });

  it("keeps a task list's checkboxes and their state, not our line stamp", () => {
    const h = host('<ul><li class="task-list-item task-list-item-done" data-src-line="3"><input type="checkbox" class="task-list-item-checkbox" checked="" disabled="" data-task-line="3">done</li></ul>');
    expect(clipboardHtmlForRange(selectAll(h), h))
      .toBe('<ul><li><input type="checkbox" checked="" disabled="">done</li></ul>');
  });

  it("does not wrap words selected inside one paragraph in a new block", () => {
    const h = host("<h2>Heading</h2><p>some words here</p>");
    const t = h.querySelector("p")!.firstChild!;
    expect(clipboardHtmlForRange(rangeOver(t, 5, t, 10), h)).toBe("words");
  });

  it("keeps lines from a code block monospace", () => {
    const h = host('<pre><code class="language-ts">const a = 1;\nconst b = 2;\n</code></pre>');
    const t = h.querySelector("code")!.firstChild!;
    expect(clipboardHtmlForRange(rangeOver(t, 0, t, 12), h)).toBe("<pre><code>const a = 1;</code></pre>");
  });

  it("drops the breakout wrapper around a table, keeping the table", () => {
    const h = host('<p>a</p><div class="md-wide"><table><tbody><tr><td>x</td></tr></tbody></table></div><p>b</p>');
    expect(clipboardHtmlForRange(selectAll(h), h))
      .toBe("<p>a</p><table><tbody><tr><td>x</td></tr></tbody></table><p>b</p>");
  });

  it("keeps table structure for selected rows", () => {
    const h = host("<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>");
    const tds = h.querySelectorAll("td");
    const html = clipboardHtmlForRange(rangeOver(tds[0].firstChild!, 0, tds[3].firstChild!, 1), h);
    expect(html).toBe("<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>");
  });

  it("unwraps relative links, find and comment-quote highlights, keeping their text", () => {
    const h = host('<p><a href="docs/setup.md">setup</a> and <mark class="md-find md-find-current">match</mark> <mark class="tc-md-quote">quoted</mark></p>');
    expect(clipboardHtmlForRange(selectAll(h), h)).toBe("<p>setup and match quoted</p>");
  });

  it("drops review-comment cards the selection crosses", () => {
    const h = host('<p>before</p><div data-tc-slot=""><div>lines 1 Edit Delete</div></div><p>after</p>');
    expect(clipboardHtmlForRange(selectAll(h), h)).toBe("<p>before</p><p>after</p>");
  });

  it("drops local and blocked images but keeps remote ones", () => {
    const h = host('<p><img src="data:image/png;base64,AAAA" alt="a"><img data-md-remote-src="https://x.test/b.png" alt="b"><img src="https://x.test/c.png" alt="c" title="t"></p>');
    expect(clipboardHtmlForRange(selectAll(h), h)).toBe('<p><img src="https://x.test/c.png" alt="c"></p>');
  });
});
