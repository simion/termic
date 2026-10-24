import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { archiveTask, openTask, readClipboard, requireTermicApi, snap, waitForAppShell } from "../helpers";

// the markdown extensions (lib/markdown/extensions, docs/markdown.md) on the
// real preview: one synthetic doc exercising every one of them, rendered,
// then the interactive ones driven. Parsing edge cases are unit-tested in
// src/lib/markdown/extensions.test.ts; this is the DOM, CSS and hydrate
// side that only a real WebKit has (MathML, masks, scroll, open state).

const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");
const DOC = "md-extensions.md";
const SOURCE = readFileSync(path.join(process.cwd(), "e2e", "fixtures", "markdown-extensions.md"), "utf8");

declare global {
  interface Window {
    /** the on-screen `.markdown-body` of this spec's task. */
    __mdExt?: () => HTMLElement;
  }
}

describe("markdown extensions", () => {
  let taskId!: string;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    writeFileSync(path.join(fixture, DOC), SOURCE);
    taskId = await openTask("e2e-md-ext");
    await browser.execute((id, p) => {
      window.__mdExt = () => Array.from(document.querySelectorAll<HTMLElement>(`[data-task-id="${id}"] .markdown-body`))
        .find(el => el.getBoundingClientRect().width > 0)!;
      const app = window.__termic!.useApp.getState();
      app.bumpFsRevision(id);
      app.openPreviewTab(id, { type: "edit", path: p, title: p });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = app.tabs[id].find((t: any) => t.type === "edit" && t.path === p);
      app.persistTab(id, tab.id);
      app.setActiveTabId(id, tab.id);
      app.patchTab(id, tab.id, { mdView: "preview" });
    }, taskId, DOC);
    await browser.waitUntil(
      () => browser.execute(() => !!window.__mdExt?.()?.querySelector("dl")),
      { timeout: 15_000, timeoutMsg: `${DOC} preview never rendered` },
    );
  });

  after(async () => {
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch { /* best effort */ }
  });

  it("renders every extension", async () => {
    // math becomes MathML after a lazy import
    await browser.waitUntil(
      () => browser.execute(() => window.__mdExt!().querySelectorAll("math").length === 5),
      { timeout: 10_000, timeoutMsg: "math never rendered to MathML" },
    );
    const r = await browser.execute(() => {
      const host = window.__mdExt!();
      const all = (s: string) => Array.from(host.querySelectorAll<HTMLElement>(s));
      return {
        pairs: all(".front-matter .fm-pair").map(p => p.textContent),
        fmLine: host.querySelector(".front-matter")?.getAttribute("data-src-line"),
        hr: host.querySelectorAll("hr").length,
        alerts: all(".markdown-alert").map(a => a.className.replace("markdown-alert ", "")),
        alertBorders: all(".markdown-alert").map(a => getComputedStyle(a).borderLeftColor),
        alertIcon: getComputedStyle(host.querySelector(".markdown-alert-title")!, "::before").webkitMaskImage,
        codeLangs: all(".md-code-head").map(h => h.dataset.lang),
        codeHeadText: all(".md-code-head").map(h => h.textContent).join(""),
        headingLinks: all(".md-heading-link").map(b => b.parentElement!.tagName),
        mathError: all(".math-error").map(e => e.textContent),
        dollarsText: host.textContent!.includes("$5 and $10"),
        marks: all("mark").map(m => m.textContent),
        dts: all("dt").map(d => d.textContent),
        notes: all("ol.footnotes > li[data-src-line]").length,
        refs: all("sup a[data-fnref]").map(a => a.title),
        ids: host.querySelectorAll("[id]").length,
      };
    });
    expect(r.pairs).toEqual(["title Task snapshots", "status draft", "owner alice", "reviewers bob, carol"]);
    expect(r.fmLine).toBe("1");
    expect(r.hr).toBe(0);
    expect(r.alerts).toEqual(["markdown-alert-note", "markdown-alert-tip", "markdown-alert-important", "markdown-alert-warning", "markdown-alert-caution"]);
    expect(new Set(r.alertBorders).size).toBe(5); // one colour per type
    expect(r.alertIcon).toContain("data:image/svg+xml");
    expect(r.codeLangs).toEqual(["rust", ""]);
    expect(r.codeHeadText).toBe("");
    expect(r.headingLinks).toEqual(["H1", "H2", "H2", "H3"]);
    // the slug is made at click time, from the rendered page: each copies its own
    for (const [i, slug] of ["task-snapshots", "design", "latency-budget", "glossary"].entries()) {
      await browser.execute((i) => (window.__mdExt!().querySelectorAll<HTMLElement>(".md-heading-link")[i]).click(), i);
      await browser.waitUntil(() => readClipboard().trimEnd().endsWith(`#${slug}`), {
        timeout: 5_000, timeoutMsg: `heading link ${i} never copied #${slug}`,
      });
    }
    expect(r.mathError).toEqual(["\\frac{1"]);
    expect(r.dollarsText).toBe(true);
    expect(r.marks).toEqual(["just a manifest"]);
    expect(r.dts).toEqual(["Snapshot", "Manifest"]);
    expect(r.notes).toBe(2);
    expect(r.refs).toEqual(["Hashing kept up with disk reads on every machine tried.", "Measured over 20 runs on a 1 GB checkout."]);
    expect(r.ids).toBe(0);
    await snap("md-extensions.png");
  });

  it("a footnote reference jumps to its note and the back link returns", async () => {
    const flashed = await browser.execute(() => {
      const host = window.__mdExt!();
      host.querySelectorAll<HTMLElement>("sup a[data-fnref]")[1].click();
      const note = host.querySelector<HTMLElement>('li[data-fn="2"]')!;
      const atNote = note.classList.contains("md-flash");
      note.querySelector<HTMLElement>(".footnote-backref")!.click();
      return { atNote, atRef: host.querySelectorAll<HTMLElement>("sup a[data-fnref]")[1].classList.contains("md-flash") };
    });
    expect(flashed).toEqual({ atNote: true, atRef: true });
  });

  it("an open <details> stays open when the file changes under it", async () => {
    await browser.execute(() => { window.__mdExt!().querySelector("details")!.open = true; });
    writeFileSync(path.join(fixture, DOC), SOURCE.replace("# Task snapshots\n", "# Task snapshots\n\nA line the agent added.\n"));
    await browser.execute((id) => window.__termic!.useApp.getState().bumpFsRevision(id), taskId);
    await browser.waitUntil(
      () => browser.execute(() => window.__mdExt!().textContent!.includes("A line the agent added.")),
      { timeout: 10_000, timeoutMsg: "the preview never picked up the rewrite" },
    );
    expect(await browser.execute(() => window.__mdExt!().querySelector("details")!.open)).toBe(true);
    await snap("md-extensions-details-open.png");
  });
});
