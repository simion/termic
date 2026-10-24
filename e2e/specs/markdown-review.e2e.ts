import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

// The preview toolbar's review menu (Aa), the outline rail and the gutter's
// edit pencil (docs/ui.md "Review menu"). Every control is asserted by its
// computed effect on the rendered preview, never by a screenshot. The prefs
// are global and persist in the e2e profile, so the spec resets them on both
// ends.

const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");
const DOC = "e2e-md-review.md";
const filler = (n: number) => Array.from({ length: 6 }, (_, i) =>
  `Paragraph ${n}.${i} of filler so the preview has somewhere to scroll, long enough to wrap at the measure.`).join("\n\n");
const SOURCE = [
  "# Review doc",
  "",
  filler(1),
  "",
  "## Second section",
  "",
  filler(2),
  "",
  "### Third, nested",
  "",
  "#### Too deep for the outline",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  filler(3),
  "",
  "## Last section",
  "",
  // room below, so every heading above can scroll to the top
  filler(4),
  "",
  filler(5),
  "",
  "The end.",
  "",
].join("\n");
const lineOf = (text: string) => String(SOURCE.split("\n").indexOf(text) + 1);
const H = {
  first: lineOf("# Review doc"), second: lineOf("## Second section"),
  third: lineOf("### Third, nested"), last: lineOf("## Last section"),
};

declare global {
  interface Window {
    /** this spec's on-screen preview pieces (every visited task stays
     *  mounted, so a bare query can land on a hidden copy) */
    __mdReview?: {
      host(): HTMLElement;
      shown(sel: string): HTMLElement | undefined;
      click(sel: string): void;
    };
  }
}

describe("markdown review menu", () => {
  let taskId!: string;

  const resetPrefs = () => browser.execute(() => {
    const p = window.__termic!.usePrefs.getState();
    p.setMarkdownReader({ measure: "readable", wide: "full", size: 16, font: "sans", leading: "normal", lineNumbers: "hover" });
    p.setMarkdownOutline(false);
    p.setMarkdownOutlineSplit(false);
    p.setMarkdownSavePreviewEdits(true);
  });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    writeFileSync(path.join(fixture, DOC), SOURCE);
    taskId = await openTask("e2e-md-review");
    await resetPrefs();
    await browser.execute((id, p) => {
      const scope = () => document.querySelector(`[data-task-id="${id}"]`)!;
      const shown = (sel: string) => Array.from(scope().querySelectorAll<HTMLElement>(sel))
        .find(el => el.getBoundingClientRect().width > 0);
      window.__mdReview = {
        host: () => shown(".markdown-body")!,
        shown,
        // the popover is portaled to <body>, the toolbar lives in the task
        click: (sel) => (shown(sel) ?? document.querySelector<HTMLElement>(sel))!.click(),
      };
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
      () => browser.execute(() => window.__mdReview!.shown(".markdown-body")?.textContent?.includes("The end.") ?? false),
      { timeout: 15_000, timeoutMsg: `${DOC} preview never rendered` },
    );
  });

  after(async () => {
    await resetPrefs();
    if (taskId) await archiveTask(taskId);
    rmSync(path.join(fixture, DOC), { force: true });
  });

  const panelOpen = () => browser.execute(() => !!document.querySelector('[data-testid="md-review-panel"]'));
  const openMenu = async () => {
    if (await panelOpen()) return;
    await browser.execute(() => window.__mdReview!.click('[data-testid="md-review-menu"]'));
    await browser.waitUntil(panelOpen, { timeout: 5_000, timeoutMsg: "the review menu never opened" });
  };
  /** Escape, sent where Radix listens (it bubbles to the document) */
  const closeMenu = async () => {
    await browser.execute(() => (document.activeElement ?? document.body)
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await browser.waitUntil(async () => !(await panelOpen()), { timeout: 5_000, timeoutMsg: "Escape left the menu open" });
  };
  const pick = (id: string) => browser.execute((s) => window.__mdReview!.click(`[data-testid="md-review-${s}"]`), id);
  const checked = (id: string) => browser.execute((s) =>
    document.querySelector(`[data-testid="md-review-${s}"]`)?.getAttribute("aria-checked") ?? null, id);
  /** computed styles of the first paragraph and the wide table wrapper */
  const geometry = () => browser.execute(() => {
    const host = window.__mdReview!.host();
    const p = getComputedStyle(host.querySelector(":scope > p")!);
    const wide = getComputedStyle(host.querySelector(":scope > .md-wide")!);
    const hs = getComputedStyle(host);
    return {
      pMax: p.maxWidth, wideMax: wide.maxWidth,
      size: hs.fontSize, family: hs.fontFamily, lineHeight: parseFloat(p.lineHeight), pSize: parseFloat(p.fontSize),
    };
  });

  it("opens from Aa on the defaults, and Escape closes it", async () => {
    await openMenu();
    expect(await checked("measure-readable")).toBe("true");
    expect(await checked("wide-full")).toBe("true");
    expect(await checked("font-sans")).toBe("true");
    expect(await checked("leading-normal")).toBe("true");
    expect(await checked("ln-hover")).toBe("true");
    expect(await checked("outline")).toBe("false");
    expect(await checked("save")).toBe("true");
    expect(await browser.execute(() => document.querySelector('[data-testid="md-review-size"]')?.textContent)).toBe("16px");
    // each font option is drawn in its own face
    expect(await browser.execute(() =>
      getComputedStyle(document.querySelector('[data-testid="md-review-font-serif"]')!).fontFamily)).toMatch(/^ui-serif/);
    await snap("md-review-menu.png");
    await closeMenu();
  });

  it("is disabled in Editor view", async () => {
    const setView = (v: string) => browser.execute((id, p, view) => {
      const app = window.__termic!.useApp.getState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = app.tabs[id].find((t: any) => t.type === "edit" && t.path === p);
      app.patchTab(id, tab.id, { mdView: view });
    }, taskId, DOC, v);
    const disabled = () => browser.execute(() =>
      ["md-review-menu", "md-outline-toggle"].map(id =>
        window.__mdReview!.shown(`[data-testid="${id}"]`)?.hasAttribute("disabled") ?? null));
    await setView("source");
    await browser.waitUntil(async () => (await disabled()).every(Boolean), { timeout: 5_000, timeoutMsg: "Aa / outline still enabled in Editor view" });
    await setView("preview");
    await browser.waitUntil(async () => (await disabled()).every(d => d === false), { timeout: 5_000, timeoutMsg: "Aa / outline still disabled in Preview" });
  });

  it("text width and wide content set the measure and the breakout cap", async () => {
    await openMenu();
    const base = await geometry();
    const readable = parseFloat(base.pMax);
    expect(base.wideMax).toBe("100%");
    await pick("measure-narrow");
    await browser.waitUntil(async () => parseFloat((await geometry()).pMax) < readable, { timeout: 5_000, timeoutMsg: "Narrow did not narrow the measure" });
    expect(parseFloat((await geometry()).pMax) / readable).toBeCloseTo(60 / 72, 2);
    await pick("measure-readable");
    await pick("wide-text");
    await browser.waitUntil(async () => (await geometry()).wideMax === base.pMax, { timeout: 5_000, timeoutMsg: "Text did not cap wide content at the measure" });
    await pick("wide-wide");
    await browser.waitUntil(async () => (await geometry()).wideMax !== base.pMax, { timeout: 5_000, timeoutMsg: "Wide did not widen the cap" });
    expect(parseFloat((await geometry()).wideMax) / readable).toBeCloseTo(120 / 72, 2);
    await pick("measure-full");
    await browser.waitUntil(async () => (await geometry()).pMax === "100%", { timeout: 5_000, timeoutMsg: "Full did not lift the measure" });
    expect((await geometry()).wideMax).toBe("100%");
    await pick("measure-readable");
    await pick("wide-full");
  });

  it("size steps between 12 and 24, font and line spacing restyle the preview", async () => {
    await openMenu();
    await pick("size-up");
    await pick("size-up");
    await browser.waitUntil(async () => (await geometry()).size === "18px", { timeout: 5_000, timeoutMsg: "two steps up did not give 18px" });
    expect(await browser.execute(() => document.querySelector('[data-testid="md-review-size"]')?.textContent)).toBe("18px");
    await browser.execute(() => window.__termic!.usePrefs.getState().setMarkdownReader({ size: 24 }));
    await browser.waitUntil(
      () => browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="md-review-size-up"]')?.disabled ?? false),
      { timeout: 5_000, timeoutMsg: "+ still enabled at 24px" },
    );
    await pick("size-down");
    await browser.waitUntil(async () => (await geometry()).size === "23px", { timeout: 5_000, timeoutMsg: "a step down from 24 did not give 23px" });
    await browser.execute(() => window.__termic!.usePrefs.getState().setMarkdownReader({ size: 16 }));

    await pick("font-serif");
    await browser.waitUntil(async () => /^ui-serif/.test((await geometry()).family), { timeout: 5_000, timeoutMsg: "Serif did not reach the preview" });
    await pick("font-mono");
    await browser.waitUntil(async () => /^ui-monospace/.test((await geometry()).family), { timeout: 5_000, timeoutMsg: "Mono did not reach the preview" });
    await pick("font-sans");

    await pick("leading-relaxed");
    await browser.waitUntil(async () => {
      const g = await geometry();
      return Math.abs(g.lineHeight - g.pSize * 1.8) < 0.5;
    }, { timeout: 5_000, timeoutMsg: "Relaxed is not 1.8" });
    await pick("leading-compact");
    await browser.waitUntil(async () => {
      const g = await geometry();
      return Math.abs(g.lineHeight - g.pSize * 1.4) < 0.5;
    }, { timeout: 5_000, timeoutMsg: "Compact is not 1.4" });
    await pick("leading-normal");
  });

  const gutter = () => browser.execute(() => {
    const host = window.__mdReview!.host();
    return {
      cls: Array.from(host.classList).filter(c => c.startsWith("md-ln-")),
      labels: host.parentElement!.querySelectorAll(".md-gl").length,
    };
  });

  it("line numbers: Always numbers every block unhovered, Off none", async () => {
    await openMenu();
    await pick("ln-always");
    await browser.waitUntil(async () => {
      const g = await gutter();
      return g.cls.join() === "md-ln-always" && g.labels > 10;
    }, { timeout: 5_000, timeoutMsg: "Always did not number the blocks" });
    await snap("md-review-line-numbers-always.png");
    await pick("ln-off");
    await browser.waitUntil(async () => {
      const g = await gutter();
      return g.cls.join() === "md-ln-off" && g.labels === 0;
    }, { timeout: 5_000, timeoutMsg: "Off left numbers up" });
    await pick("ln-hover");
    await browser.waitUntil(async () => (await gutter()).cls.join() === "md-ln-hover", { timeout: 5_000, timeoutMsg: "back to Hover failed" });
  });

  const outline = () => browser.execute(() => {
    const rail = window.__mdReview!.shown('[data-testid="md-outline"]');
    if (!rail) return null;
    return Array.from(rail.querySelectorAll<HTMLElement>("[data-outline-line]")).map(b => ({
      line: b.dataset.outlineLine, current: b.getAttribute("aria-current") === "location",
    }));
  });

  it("the toolbar button and the menu switch toggle the same outline", async () => {
    await closeMenu();
    await browser.execute(() => window.__mdReview!.click('[data-testid="md-outline-toggle"]'));
    await browser.waitUntil(async () => (await outline()) !== null, { timeout: 5_000, timeoutMsg: "the toolbar button did not open the outline" });
    // h1-h3 only, each with its source line
    expect((await outline())!.map(o => o.line)).toEqual([H.first, H.second, H.third, H.last]);
    await openMenu();
    expect(await checked("outline")).toBe("true");
    await pick("outline");
    await browser.waitUntil(async () => (await outline()) === null, { timeout: 5_000, timeoutMsg: "the menu switch did not close the outline" });
    await pick("outline");
    await browser.waitUntil(async () => (await outline()) !== null, { timeout: 5_000, timeoutMsg: "the menu switch did not reopen the outline" });
  });

  it("an outline click scrolls to its heading and highlights it, the last at the bottom", async () => {
    await closeMenu();
    await browser.execute((l) => window.__mdReview!.click(`[data-outline-line="${l}"]`), H.third);
    await browser.waitUntil(async () => {
      const top = await browser.execute((l) => {
        const host = window.__mdReview!.host();
        const h = host.querySelector<HTMLElement>(`h3[data-src-line="${l}"]`)!;
        return h.getBoundingClientRect().top - host.parentElement!.getBoundingClientRect().top;
      }, H.third);
      return Math.abs(top) < 40;
    }, { timeout: 5_000, timeoutMsg: "the h3 did not scroll to the top" });
    await browser.waitUntil(async () => (await outline())?.find(o => o.current)?.line === H.third,
      { timeout: 5_000, timeoutMsg: "the clicked heading is not the current one" });
    await snap("md-review-outline.png");
    await browser.execute(() => {
      const s = window.__mdReview!.host().parentElement!;
      s.scrollTop = s.scrollHeight;
    });
    await browser.waitUntil(async () => (await outline())?.find(o => o.current)?.line === H.last,
      { timeout: 5_000, timeoutMsg: "the bottom did not make the last heading current" });
    await browser.execute(() => { window.__mdReview!.host().parentElement!.scrollTop = 0; });
    await browser.waitUntil(async () => (await outline())?.find(o => o.current)?.line === H.first,
      { timeout: 5_000, timeoutMsg: "the top did not make the first heading current" });
  });

  it("the gutter pencil opens the block editor on its block", async () => {
    // hover the paragraph at line 3 until its number carries the pencil (the
    // edit target arrives once the hidden editor has loaded the file)
    await browser.waitUntil(() => browser.execute(() => {
      const host = window.__mdReview!.host();
      host.querySelector(':scope > p[data-src-line="3"]')!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      // a number's buttons are built when the pointer first reaches it
      host.parentElement!.querySelector(".md-gl")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      return !!host.parentElement!.querySelector('.md-gl [data-act="edit"]');
    }), { timeout: 10_000, timeoutMsg: "no pencil on the hovered number" });
    await browser.execute(() => window.__mdReview!.host().parentElement!.querySelector<HTMLElement>('.md-gl [data-act="edit"]')!.click());
    await browser.waitUntil(
      () => browser.execute(() => {
        const host = window.__mdReview!.host();
        const ed = host.querySelector(".tc-block-editor .cm-content");
        return !!ed && ed.textContent!.startsWith("Paragraph 1.0")
          && (host.querySelector(':scope > p[data-src-line="3"]') as HTMLElement).hidden;
      }),
      { timeout: 5_000, timeoutMsg: "the pencil did not open the block editor on line 3" },
    );
    // Cancel: nothing written
    const before = readFileSync(path.join(fixture, DOC), "utf8");
    await browser.execute(() => window.__mdReview!.host()
      .querySelector<HTMLElement>(".tc-block-editor-foot .tc-btn-ghost")!.click());
    await browser.waitUntil(() => browser.execute(() => !window.__mdReview!.host().querySelector(".tc-block-editor")),
      { timeout: 5_000, timeoutMsg: "Cancel left the block editor open" });
    expect(readFileSync(path.join(fixture, DOC), "utf8")).toBe(before);
  });

  it("split view has its own outline switch, off by default", async () => {
    const setView = (v: string) => browser.execute((id, v) => {
      const app = window.__termic!.useApp.getState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = app.tabs[id].find((t: any) => t.type === "edit" && t.path === "e2e-md-review.md");
      app.patchTab(id, tab.id, { mdView: v });
    }, taskId, v);
    // the preview-only outline is on from the cases above
    expect(await outline()).not.toBeNull();
    await setView("split");
    await browser.waitUntil(async () => (await outline()) === null, { timeout: 5_000, timeoutMsg: "split view showed the outline by default" });
    await browser.execute(() => window.__mdReview!.click('[data-testid="md-outline-toggle"]'));
    await browser.waitUntil(async () => (await outline()) !== null, { timeout: 5_000, timeoutMsg: "the toggle did not open the outline in split" });
    expect(await browser.execute(() => localStorage.getItem("markdownOutlineSplit"))).toBe("1");
    await browser.execute(() => window.__mdReview!.click('[data-testid="md-outline-toggle"]'));
    await browser.waitUntil(async () => (await outline()) === null, { timeout: 5_000, timeoutMsg: "the toggle did not close the outline in split" });
    await setView("preview");
    // preview-only kept its own switch
    await browser.waitUntil(async () => (await outline()) !== null, { timeout: 5_000, timeoutMsg: "preview-only lost its outline" });
  });

  it("persists every change, and Reset puts all of it back", async () => {
    await openMenu();
    await pick("measure-wide");
    await pick("font-serif");
    await pick("save");
    await browser.waitUntil(async () => (await checked("save")) === "false", { timeout: 5_000, timeoutMsg: "Save edits did not switch off" });
    const stored = await browser.execute(() => ({
      reader: JSON.parse(localStorage.getItem("markdownReader") ?? "null"),
      outline: localStorage.getItem("markdownOutline"),
      save: localStorage.getItem("markdownSavePreviewEdits"),
    }));
    expect(stored.reader).toMatchObject({ measure: "wide", font: "serif" });
    expect([stored.outline, stored.save]).toEqual(["1", "0"]);

    await pick("reset");
    await browser.waitUntil(async () => (await checked("measure-readable")) === "true", { timeout: 5_000, timeoutMsg: "Reset left the measure" });
    expect(await checked("font-sans")).toBe("true");
    expect(await checked("outline")).toBe("false");
    expect(await checked("save")).toBe("true");
    await browser.waitUntil(async () => (await outline()) === null, { timeout: 5_000, timeoutMsg: "Reset left the outline open" });
    expect(await browser.execute(() => JSON.parse(localStorage.getItem("markdownReader") ?? "null")))
      .toEqual({ measure: "readable", wide: "full", size: 16, font: "sans", leading: "normal", lineNumbers: "hover" });
  });
});
