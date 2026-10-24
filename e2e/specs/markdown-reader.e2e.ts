import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

// The markdown preview as a reading surface: wide content breaking out of the
// text measure, the hover line-number gutter, the selection's line chip on the
// toolbar, and go to line (⌘G). Geometry is asserted as numbers, measured off
// the rendered boxes, never off a screenshot.

const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");
const DOC = "reader-doc.md";
const wideHead = Array.from({ length: 24 }, (_, i) => `column-heading-${i}`);
const READER_DOC = [
  "# Reader doc",                                   // 1
  "",
  "First paragraph that the source",                // 3
  "hard-wraps across three",
  "source lines.",                                  // 5
  "",
  "- item one",                                     // 7
  "- item two",                                     // 8
  "",
  "| a | b |",                                      // 10
  "|---|---|",
  "| 1 | 2 |",                                      // 12
  "",
  `| ${wideHead.join(" | ")} |`,                    // 14
  `|${wideHead.map(() => "---").join("|")}|`,
  `| ${wideHead.map((_, i) => `cell-${i}`).join(" | ")} |`, // 16
  "",
  "Last paragraph.",                                // 18
  "",
].join("\n");

describe("markdown reader", () => {
  let taskId!: string;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    writeFileSync(path.join(fixture, DOC), READER_DOC);
    taskId = await openTask("e2e-reader");
    await browser.execute((id, p) => {
      const app = window.__termic!.useApp.getState();
      app.openPreviewTab(id, { type: "edit", path: p, title: p });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = app.tabs[id].find((t: any) => t.type === "edit" && t.path === p);
      app.persistTab(id, tab.id);
      app.patchTab(id, tab.id, { mdView: "preview" });
    }, taskId, DOC);
    await browser.waitUntil(
      () => browser.execute((id) => Array.from(
        document.querySelectorAll(`[data-task-id="${id}"] .markdown-body`))
        .some((h) => h.getBoundingClientRect().width > 0 && (h as HTMLElement).textContent?.includes("Last paragraph")), taskId),
      { timeout: 15_000, timeoutMsg: `${DOC} preview never rendered` },
    );
  });

  after(async () => {
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch {
      /* nothing */
    }
  });

  it("lines a narrow table up with the prose and lets a wide one out, scrolling inside its own box", async () => {
    const m = await browser.execute((id) => {
      const host = Array.from(document.querySelectorAll<HTMLElement>(`[data-task-id="${id}"] .markdown-body`))
        .find(h => h.getBoundingClientRect().width > 0)!;
      const p = host.querySelector(":scope > p")!.getBoundingClientRect();
      const [narrow, wide] = Array.from(host.querySelectorAll<HTMLElement>(":scope > .md-wide"));
      const nt = narrow.querySelector("table")!, wt = wide.querySelector("table")!;
      const cs = getComputedStyle(host);
      const contentRight = host.getBoundingClientRect().right - parseFloat(cs.paddingRight);
      const scroller = host.parentElement!;
      return {
        narrowLeft: Math.round(nt.getBoundingClientRect().left), pLeft: Math.round(p.left),
        narrowStamped: nt.dataset.srcLine, wideStamped: wt.dataset.srcLine,
        wideWidth: wide.getBoundingClientRect().width, pWidth: p.width,
        wideRight: wide.getBoundingClientRect().right, contentRight,
        contentWidth: host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        tableScrolls: wt.scrollWidth > wt.clientWidth,
        pageScrolls: scroller.scrollWidth > scroller.clientWidth,
      };
    }, taskId);
    expect(m.narrowLeft).toBe(m.pLeft);
    expect([m.narrowStamped, m.wideStamped]).toEqual(["10", "14"]);
    // a pane no wider than the measure (Windows CI) leaves no room to break
    // out: the prose already fills the column, so the table just fills it too
    if (m.contentWidth > m.pWidth + 1) expect(m.wideWidth).toBeGreaterThan(m.pWidth);
    else expect(Math.abs(m.wideWidth - m.contentWidth)).toBeLessThanOrEqual(1);
    expect(m.wideRight).toBeLessThanOrEqual(m.contentRight + 1);
    expect(m.tableScrolls).toBe(true);
    expect(m.pageScrolls).toBe(false);
    await snap("md-reader-breakout.png");
  });

  /** Hover `sel` (the n-th match) in the visible preview; returns the gutter's labels. */
  const hover = (sel: string, n = 0) =>
    browser.execute((id, s, i) => {
      const host = Array.from(document.querySelectorAll<HTMLElement>(`[data-task-id="${id}"] .markdown-body`))
        .find(h => h.getBoundingClientRect().width > 0)!;
      const el = s === "host" ? host : host.querySelectorAll<HTMLElement>(s)[i];
      el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      const labels = Array.from(host.parentElement!.querySelectorAll<HTMLElement>(".md-gl"));
      return labels.map(l => ({
        num: l.querySelector(".md-gl-num")?.textContent, more: l.querySelector(".md-gl-more")?.textContent,
        right: l.getBoundingClientRect().right, colLeft: el.closest(".markdown-body > *")?.getBoundingClientRect().left ?? 0,
      }));
    }, taskId, sel, n);

  it("numbers the block under the pointer, the item and not the list, beside its column", async () => {
    const [li] = await hover("li", 1);
    expect(li.num).toBe("8");
    expect(li.right).toBeLessThan(li.colLeft);
    const [p] = await hover(":scope > p", 0);
    expect(p.num).toBe("3");
    // the range opens on hovering the number
    expect(p.more).toBe("-5");
  });

  it("keeps the number while the pointer crosses the padding toward it", async () => {
    await hover(":scope > p", 0);
    const labels = await hover("host");
    expect(labels.map(l => l.num)).toEqual(["3"]);
    await snap("md-reader-gutter.png");
  });

  it("copies the block's reference when its number is clicked", async () => {
    await hover("tr", 1);
    await browser.execute((id) => {
      const lab = document.querySelector<HTMLElement>(`[data-task-id="${id}"] .md-gl`)!;
      lab.click();
    }, taskId);
    await browser.waitUntil(
      () => browser.execute(() => document.body.textContent?.includes("Copied reader-doc.md:12") ?? false),
      { timeout: 5_000, timeoutMsg: "no copy toast for reader-doc.md:12" },
    );
  });

  it("shows a selection's source lines on the toolbar", async () => {
    await browser.execute((id) => {
      const host = Array.from(document.querySelectorAll<HTMLElement>(`[data-task-id="${id}"] .markdown-body`))
        .find(h => h.getBoundingClientRect().width > 0)!;
      const p = host.querySelector(":scope > p")!.firstChild!;
      const r = document.createRange();
      // "hard-wraps across three", source line 4
      const at = p.textContent!.indexOf("hard-wraps");
      r.setStart(p, at);
      r.setEnd(p, at + "hard-wraps across".length);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(r);
    }, taskId);
    await browser.waitUntil(
      () => browser.execute((id) => document.querySelector(`[data-task-id="${id}"] [data-testid="md-line-chip"]`)?.textContent === "L4", taskId),
      { timeout: 5_000, timeoutMsg: "line chip never read L4" },
    );
    await snap("md-reader-chip.png");
    await browser.execute(() => window.getSelection()!.removeAllRanges());
    await browser.waitUntil(
      () => browser.execute((id) => !document.querySelector(`[data-task-id="${id}"] [data-testid="md-line-chip"]`), taskId),
      { timeout: 5_000, timeoutMsg: "line chip outlived its selection" },
    );
  });

  const pressGoTo = () =>
    browser.execute((id) => {
      const host = Array.from(document.querySelectorAll<HTMLElement>(`[data-task-id="${id}"] .markdown-body`))
        .find(h => h.getBoundingClientRect().width > 0)!;
      host.closest<HTMLElement>("[tabindex]")!.focus();
      const mac = /^(mac|darwin)/i.test(navigator.platform);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", [mac ? "metaKey" : "ctrlKey"]: true, bubbles: true, cancelable: true }));
    }, taskId);
  const typeGoTo = (v: string, key = "Enter") =>
    browser.execute((id, val, k) => {
      const input = document.querySelector<HTMLInputElement>(`[data-task-id="${id}"] [data-testid="md-goto"] input`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    }, taskId, v, key);
  const gotoBar = () =>
    browser.execute((id) => document.querySelector(`[data-task-id="${id}"] [data-testid="md-goto"]`)?.textContent ?? null, taskId);

  it("goes to a line: the innermost block holding it, flashed", async () => {
    await pressGoTo();
    await browser.waitUntil(async () => (await gotoBar()) !== null, { timeout: 5_000, timeoutMsg: "go to line never opened" });
    await typeGoTo("16");
    await browser.waitUntil(
      () => browser.execute((id) => document.querySelector<HTMLElement>(`[data-task-id="${id}"] .md-flash`)?.dataset.srcLine === "16", taskId),
      { timeout: 5_000, timeoutMsg: "line 16's row never flashed" },
    );
    expect(await gotoBar()).toBeNull();
  });

  it("lands on the next block from a blank line, and says so past the end", async () => {
    await pressGoTo();
    await browser.waitUntil(async () => (await gotoBar()) !== null, { timeout: 5_000, timeoutMsg: "go to line never opened" });
    await typeGoTo("99");
    await browser.waitUntil(async () => (await gotoBar())?.includes("18") ?? false,
      { timeout: 5_000, timeoutMsg: "past-the-end hint never showed the last line" });
    await typeGoTo("6");
    await browser.waitUntil(
      () => browser.execute((id) => Array.from(document.querySelectorAll<HTMLElement>(`[data-task-id="${id}"] .md-flash`))
        .some(el => el.dataset.srcLine === "7"), taskId),
      { timeout: 5_000, timeoutMsg: "blank line 6 did not land on the list item at 7" },
    );
  });

  it("closes on Escape without jumping", async () => {
    await pressGoTo();
    await browser.waitUntil(async () => (await gotoBar()) !== null, { timeout: 5_000, timeoutMsg: "go to line never opened" });
    await typeGoTo("1", "Escape");
    await browser.waitUntil(async () => (await gotoBar()) === null, { timeout: 5_000, timeoutMsg: "Escape left the bar open" });
  });
});
