import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

declare global {
  interface Window {
    /** Every src the PDF embed has taken, recorded by the pdf-preview spec so
     *  "this tick changed nothing" is an observation, not a wait. */
    __pdfSrcLog?: string[];
  }
}

// Editor (CodeMirror 6), open/preview/persist. Cases: single-click opens a
// PREVIEW tab (italic, recyclable) with the file's real contents; double-click
// PERSISTS it. Saving has its own spec (editor-save.e2e.ts).
describe("editor open", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const readmeSel = '[data-path="README.md"]';
  const editTab = () =>
    browser.execute(
      (id) =>
        (window.__termic!.useApp.getState().tabs[id] ?? []).find(
          (t: any) => t.type === "edit" && t.path === "README.md",
        ),
      taskId,
    );

  it("opens a file as a preview tab and loads its content in CodeMirror", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-editor");

    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), readmeSel),
      { timeout: 15_000, timeoutMsg: "README row never appeared" },
    );
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, readmeSel);

    // A single click opens a *preview* edit tab.
    await browser.waitUntil(async () => (await editTab())?.preview === true, {
      timeout: 10_000,
      timeoutMsg: "single click did not open a preview edit tab",
    });

    // CodeMirror renders the real contents.
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          (document.querySelector(".cm-content")?.textContent ?? "").includes(
            "e2e fixture",
          ),
        ),
      { timeout: 10_000, timeoutMsg: "CodeMirror never showed the contents" },
    );
    await snap("editor.png");
  });

  it("persists the preview tab on double-click", async () => {
    const tab = await editTab();
    await browser.execute((id) => {
      document
        .querySelector(`[data-tab-id="${id}"]`)!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, (tab as any).id);

    await browser.waitUntil(async () => (await editTab())?.preview === false, {
      timeout: 5_000,
      timeoutMsg: "double-click did not persist the preview tab",
    });
  });

  // NOTE: editor search (⌘F) is keyboard-shortcut-only in CodeMirror and does
  // not route reliably across window-focus states in this harness (see the
  // environment-limited list in docs/plans/e2e-coverage.md), so it is a manual
  // check, not a spec.

  it("renders the markdown Preview", async () => {
    // README is a .md file → MarkdownPane. Switch to the Preview view and
    // assert the rendered markdown (the "# e2e fixture" heading becomes an h1).
    await browser.execute(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Preview",
      );
      if (!btn) throw new Error("Preview toggle not found");
      (btn as HTMLElement).click();
    });
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("h1")].some((h) =>
            h.textContent?.includes("fixture"),
          ),
        ),
      { timeout: 8_000, timeoutMsg: "markdown preview never rendered" },
    );
  });

  it("shows source and preview together in Split view", async () => {
    await browser.execute(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Split",
      );
      if (!btn) throw new Error("Split toggle not found");
      (btn as HTMLElement).click();
    });
    // Split shows both the CodeMirror source and the rendered markdown.
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !!document.querySelector(".cm-content") &&
            [...document.querySelectorAll("h1")].some((h) =>
              h.textContent?.includes("fixture"),
            ),
        ),
      { timeout: 8_000, timeoutMsg: "split view did not show both panes" },
    );
  });
});

// P0: editing a file and saving it. Guards the CodeMirror edit -> dirty dot ->
// Cmd+S -> taskFileWrite path (termic never auto-saves). Restores README on
// teardown so the fixture repo stays clean for the git specs.
describe("editor save", () => {
  let taskId: string | undefined;
  let original: string | undefined;

  after(async () => {
    if (taskId && original !== undefined) {
      await browser.execute(
        (id, content) => window.__termic!.ipc.taskFileWrite(id, "README.md", content),
        taskId,
        original,
      );
    }
    if (taskId) await archiveTask(taskId);
  });

  const editTab = (id: string) =>
    browser.execute(
      (t) =>
        (window.__termic!.useApp.getState().tabs[t] ?? []).find(
          (x: any) => x.type === "edit" && x.path === "README.md",
        ),
      id,
    );

  it("edits README, saves with Cmd+S, and writes it to disk", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-editor-save");
    original = await browser.execute(
      (id) => window.__termic!.ipc.taskFileRead(id, "README.md"),
      taskId,
    );

    // Open README in the editor.
    const readmeSel = '[data-path="README.md"]';
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), readmeSel),
      { timeout: 15_000, timeoutMsg: "README row never appeared" },
    );
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, readmeSel);
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          (document.querySelector(".cm-content")?.textContent ?? "").includes(
            "e2e fixture",
          ),
        ),
      { timeout: 10_000, timeoutMsg: "CodeMirror never loaded README" },
    );

    // Edit through CodeMirror's own view API (the e2e build exposes it on
    // .cm-editor). This flips the tab's dirty dot via the updateListener.
    await browser.execute(() => {
      const el = document.querySelector(".cm-editor") as unknown as {
        __cmView?: any;
      };
      const view = el?.__cmView;
      if (!view)
        throw new Error("CodeMirror e2e hook missing (build with make e2e)");
      view.dispatch({ changes: { from: view.state.doc.length, insert: "X" } });
    });
    await browser.waitUntil(
      async () => (await editTab(taskId!))?.dirty === true,
      { timeout: 5_000, timeoutMsg: "edit never marked the tab dirty" },
    );

    // Cmd+S (the editor's Mod-s keymap) saves and clears dirty.
    await browser.execute(() => {
      document
        .querySelector(".cm-content")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
        );
    });
    await browser.waitUntil(
      async () => (await editTab(taskId!))?.dirty === false,
      { timeout: 5_000, timeoutMsg: "Cmd+S never cleared the dirty flag" },
    );

    // The change is on disk.
    const saved = await browser.execute(
      (id) => window.__termic!.ipc.taskFileRead(id, "README.md"),
      taskId,
    );
    expect(saved).not.toBe(original);
    expect(saved).toContain("e2e fixture");

    await snap("editor-save.png");
  });
});

// P2: the editor handles non-markdown code files (CodeMirror language support).
// Writes a file, opens it, asserts CodeMirror renders it with syntax-highlight
// token spans — with no language extension a file renders as zero classed
// spans, so that assertion is what proves langForPath resolved the grammar.
// Git-cleans the files away.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

describe("code editor", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch {
      /* nothing */
    }
  });

  // Write `name`, open it from the tree, assert it loaded and is highlighted.
  const openHighlighted = async (name: string, source: string, marker: string) => {
    writeFileSync(path.join(fixture, name), source);
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );

    const sel = `[data-path="${name}"]`;
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), sel),
      { timeout: 10_000, timeoutMsg: `${name} never appeared in the tree` },
    );
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, sel);

    // CodeMirror renders the content...
    await browser.waitUntil(
      () =>
        browser.execute(
          (m) =>
            (document.querySelector(".cm-content")?.textContent ?? "").includes(m),
          marker,
        ),
      { timeout: 10_000, timeoutMsg: `CodeMirror never loaded ${name}` },
    );
    // ...with syntax-highlight token spans.
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.querySelectorAll(".cm-content .cm-line span[class]")
              .length > 0,
        ),
      { timeout: 8_000, timeoutMsg: `no syntax-highlight token spans for ${name}` },
    );
  };

  it("opens a code file with syntax highlighting", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-code");

    await openHighlighted(
      "hello.py",
      "def greet(name):\n    return f'hi {name}'\n",
      "greet",
    );
    await snap("code-editor.png");
  });

  it("highlights protobuf, including the proto3 syntax the legacy mode misses", async () => {
    await openHighlighted(
      "hello.proto",
      'syntax = "proto3";\n\n/* a block\n   comment */\nmessage Greeting {\n  oneof body {\n    string text = 1;\n    map<string, string> fields = 2;\n  }\n}\n',
      "Greeting",
    );

    // The `oneof` and the block comment land inside classed spans — with the
    // unpatched legacy mode both fall through as unstyled text.
    const styled = await browser.execute(() =>
      [...document.querySelectorAll(".cm-content .cm-line span[class]")].map(
        (s) => s.textContent ?? "",
      ),
    );
    expect(styled).toContain("oneof");
    expect(styled.some((t) => t.includes("a block"))).toBe(true);

    await snap("code-editor-proto.png");
  });

  it("highlights elixir", async () => {
    await openHighlighted(
      "hello.ex",
      'defmodule Greeter do\n  @greeting "hi"\n\n  def greet(name) do\n    name |> String.trim() |> then(&"#{@greeting} #{&1}")\n  end\nend\n',
      "Greeter",
    );

    const styled = await browser.execute(() =>
      [...document.querySelectorAll(".cm-content .cm-line span[class]")].map(
        (s) => s.textContent ?? "",
      ),
    );
    expect(styled).toContain("defmodule");

    await snap("code-editor-elixir.png");
  });
});

/** A real (if empty) 2-page PDF. Byte offsets are computed as the string is
 *  built, and every byte is ASCII, so the xref table is valid and WKWebView
 *  renders pages instead of an error view. */
function twoPagePdf(pad = ""): string {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
  ];
  let out = `%PDF-1.4\n%${pad}\n`;
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return out;
}

// P1: the PDF preview keeps the reader's place across a tab switch (issue
// #143). The scrolled-to page lives inside WKWebView's native PDF view, which
// exposes nothing to the DOM — no test here can read it. What these cases DO
// assert is the two mechanisms the page depends on, each of which is what
// actually broke:
//   1. a hidden PDF tab stays in the render tree (opacity 0), while every
//      other hidden tab still gets display:none — the perf invariant;
//   2. the <embed> URL is keyed on the file's fingerprint, so an agent-settle
//      tick that didn't touch the PDF can't reload it, and a real rewrite
//      still does.
// The page number itself is a manual check.
describe("pdf preview", () => {
  let taskId: string | undefined;
  const pdfName = "e2e-report.pdf";
  const pdfPath = path.join(fixture, pdfName);

  after(async () => {
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch {
      /* nothing */
    }
  });

  const tabsOf = () =>
    browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id] ?? [],
      taskId!,
    );
  /** Computed style + embed URL of a tab's content wrapper, whether it sits
   *  in main or in a split pane. */
  const paneInfo = (tabId: string) =>
    browser.execute((id) => {
      const el = document.querySelector(
        `[data-main-tab-id="${id}"], [data-split-leaf][data-tab-id="${id}"]`,
      ) as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      const embed = el.querySelector('embed[type="application/pdf"]');
      return {
        display: cs.display,
        opacity: cs.opacity,
        paneId: el.getAttribute("data-pane-id"),
        src: embed?.getAttribute("src") ?? null,
        // Stamped once, in the first case. A native PDF view restarts at
        // page 1 when its element is replaced, not only when the URL moves,
        // so "same src" is not enough: the stamp is how the later cases tell
        // the original element from an identical-looking replacement.
        probe: embed?.getAttribute("data-probe") ?? null,
      };
    }, tabId);

  let pdfTabId = "";
  let termTabId = "";
  let visibleSrc = "";

  it("opens a PDF from the file tree in a native embed", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-pdf");

    writeFileSync(pdfPath, twoPagePdf());
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );

    const sel = `[data-path="${pdfName}"]`;
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), sel),
      { timeout: 10_000, timeoutMsg: `${pdfName} never appeared in the tree` },
    );
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, sel);

    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !!document.querySelector('embed[type="application/pdf"][src^="taskpdf://"]'),
        ),
      { timeout: 10_000, timeoutMsg: "the PDF embed never rendered" },
    );

    const tabs = await tabsOf();
    pdfTabId = tabs.find((t: any) => t.type === "edit" && t.path === pdfName).id;
    termTabId = tabs.find((t: any) => t.type === "terminal").id;

    // Persist it: a single click opens a recyclable PREVIEW tab, which the
    // README click in the split case below would take over.
    await browser.execute((id) => {
      document
        .querySelector(`[data-tab-id="${id}"]`)!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, pdfTabId);
    await browser.waitUntil(
      async () => (await tabsOf()).find((t: any) => t.id === pdfTabId)?.preview === false,
      { timeout: 5_000, timeoutMsg: "the PDF tab never persisted" },
    );

    // The URL carries the file's fingerprint, NOT the fsRevision counter —
    // this is what stops a tick from a turn that never touched the PDF from
    // reloading it (and dropping the reader back to page 1).
    const fp = await browser.execute(
      (id, p) => window.__termic!.ipc.taskFileFp(id, p),
      taskId,
      pdfName,
    );
    const info = await paneInfo(pdfTabId);
    expect(info!.src).toBe(
      `taskpdf://localhost/${encodeURIComponent(taskId!)}/${encodeURIComponent(pdfName)}?v=${encodeURIComponent(fp)}`,
    );
    visibleSrc = info!.src!;

    // Mark this exact element so every later case can prove the native PDF
    // view was never rebuilt behind an identical URL.
    await browser.execute((id) => {
      document
        .querySelector(`[data-main-tab-id="${id}"] embed[type="application/pdf"]`)!
        .setAttribute("data-probe", "1");
    }, pdfTabId);
    await snap("pdf-preview.png");
  });

  it("keeps the hidden PDF in the render tree, and its URL untouched", async () => {
    await browser.execute(
      (id, tab) => window.__termic!.useApp.getState().setActiveTabId(id, tab),
      taskId,
      termTabId,
    );
    await browser.waitUntil(
      async () => (await paneInfo(termTabId))?.display !== "none",
      { timeout: 5_000, timeoutMsg: "the terminal tab never became visible" },
    );

    // display:none would tear the native PDF view down and rebuild it at
    // page 1. opacity 0 keeps it alive, invisible, and unclickable.
    const hidden = await paneInfo(pdfTabId);
    expect(hidden!.display).not.toBe("none");
    expect(hidden!.opacity).toBe("0");
    expect(hidden!.src).toBe(visibleSrc);
    expect(hidden!.probe).toBe("1"); // the same element, not a rebuilt one

    // The exemption must stay this narrow: a hidden TERMINAL still goes to
    // display:none, or xterm keeps running WebGL draws for a pane nobody can
    // see (docs/performance.md bear trap 2).
    await browser.execute(
      (id, tab) => window.__termic!.useApp.getState().setActiveTabId(id, tab),
      taskId,
      pdfTabId,
    );
    await browser.waitUntil(
      async () => (await paneInfo(termTabId))?.display === "none",
      { timeout: 5_000, timeoutMsg: "a hidden terminal tab kept its display" },
    );
    const back = await paneInfo(pdfTabId);
    expect(back!.src).toBe(visibleSrc);
    expect(back!.probe).toBe("1");
  });

  it("keeps it in the render tree when hidden inside a split pane too", async () => {
    // Move the PDF into a right-hand pane, then open a second tab in that
    // same pane — the newcomer becomes the pane's visible tab, so the PDF is
    // hidden by a pane switch rather than a main-tab switch.
    await browser.execute(
      (id, tab) => window.__termic!.useApp.getState().moveTabToSplit(id, tab, null, "right"),
      taskId,
      pdfTabId,
    );
    await browser.waitUntil(async () => !!(await paneInfo(pdfTabId))?.paneId, {
      timeout: 5_000,
      timeoutMsg: "the PDF tab never landed in a split pane",
    });
    const paneId = (await paneInfo(pdfTabId))!.paneId!;

    const readmeSel = '[data-path="README.md"]';
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, readmeSel);
    const readmeTabId = await browser.waitUntil(
      async () =>
        (await tabsOf()).find((t: any) => t.type === "edit" && t.path === "README.md")?.id,
      { timeout: 5_000, timeoutMsg: "README never opened" },
    );
    // A no-op when the click already opened it in the active (new) pane.
    await browser.execute(
      (id, tab, pane) => window.__termic!.useApp.getState().moveTabToPane(id, tab, pane),
      taskId,
      readmeTabId,
      paneId,
    );

    await browser.waitUntil(
      async () => (await paneInfo(pdfTabId))?.opacity === "0",
      { timeout: 5_000, timeoutMsg: "the PDF never became the pane's hidden tab" },
    );
    const hidden = await paneInfo(pdfTabId);
    expect(hidden!.display).not.toBe("none");
    expect(hidden!.src).toBe(visibleSrc);
    // Crossing main → pane must not remount the content either: the flat
    // content layer rewrites this wrapper's style and data attributes in
    // place, and the PDF view rides along.
    expect(hidden!.probe).toBe("1");
    await snap("pdf-preview-split.png");
  });

  it("ignores an agent turn that left the PDF alone, and reloads on one that didn't", async () => {
    // Both halves of the fingerprint rule, in one recorded sequence. A
    // "nothing changed" assertion can't be a wait (there is no event to wait
    // for, and asserting straight after the tick would pass before the pane
    // had even answered), so instead: record every reload the embed goes
    // through, then drive a tick that must produce no entry followed by one
    // that must. Waiting for the second entry proves the pane processed the
    // first tick too, which makes the log complete.
    //
    // A reload is EITHER the URL moving OR the element being replaced (both
    // restart the native PDF view at page 1), so the log records the element
    // as well as the src: a remount at an identical URL is the quieter way
    // to reintroduce the bug and would otherwise slip through.
    await browser.execute((id) => {
      const wrap = document.querySelector(
        `[data-main-tab-id="${id}"], [data-split-leaf][data-tab-id="${id}"]`,
      )!;
      const log: string[] = [];
      window.__pdfSrcLog = log;
      let seen: Element | null = null;
      const record = () => {
        const el = wrap.querySelector("embed");
        const src = el?.getAttribute("src");
        if (!el || !src) return;
        if (el !== seen) { seen = el; log.push(`mount:${src}`); }
        else if (src !== log[log.length - 1]) log.push(src);
      };
      record();
      new MutationObserver(record).observe(wrap, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src"],
      });
    }, pdfTabId);

    // A turn that never touched the PDF. fsRevision ticks for every agent
    // turn, so this is the common case, and reloading here is issue #143.
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );

    // A turn that regenerated it. New bytes must reach the screen; losing
    // the page here is the one time that's correct.
    writeFileSync(pdfPath, twoPagePdf("rewritten by the agent"));
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );
    await browser.waitUntil(
      async () => {
        const src = (await paneInfo(pdfTabId))?.src;
        return !!src && src !== visibleSrc;
      },
      { timeout: 10_000, timeoutMsg: "the rewritten PDF never reloaded" },
    );

    const fp = await browser.execute(
      (id, p) => window.__termic!.ipc.taskFileFp(id, p),
      taskId,
      pdfName,
    );
    const rewrittenSrc = `taskpdf://localhost/${encodeURIComponent(taskId!)}/${encodeURIComponent(pdfName)}?v=${encodeURIComponent(fp)}`;
    // Exactly two: the element already on screen, and the rewrite landing on
    // that same element. A URL carrying anything per-turn would have slipped
    // a third entry in; a teardown would have made the second a `mount:`.
    expect(await browser.execute(() => window.__pdfSrcLog ?? [])).toEqual([
      `mount:${visibleSrc}`,
      rewrittenSrc,
    ]);
  });
});
