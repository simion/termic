import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { archiveTask, ensureActiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

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

  // NOTE: CodeMirror's OWN ⌘F search panel is keyboard-shortcut-only and does
  // not route reliably across window-focus states in this harness (see the
  // environment-limited list in docs/plans/e2e-coverage.md), so it stays a
  // manual check. The markdown preview's ⌘F is a plain window listener and IS
  // covered — see "find in markdown preview" at the bottom of this file.

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

// P1 (issue #151): a directory link in a rendered markdown file opens a
// GitHub-style folder listing in the PREVIEW TAB, instead of only nudging the
// sidebar tree. Cases: the link recycles the preview tab (no second tab) and
// expands the same folder in the tree; the folder's README renders under the
// listing; a folder row navigates in place; the up button climbs back; a file
// row opens as an ordinary edit tab; a folder with no README shows the list
// alone with no error.
describe("directory links", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch {
      /* nothing */
    }
  });

  const activeTab = () =>
    browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      return (s.tabs[id] ?? []).find((t: any) => t.id === s.activeTab[id]);
    }, taskId);
  const tabCount = () =>
    browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length,
      taskId,
    );
  // Listing rows carry data-dir-entry; the sidebar tree uses data-path, so the
  // two never collide. Every query is scoped to THIS task: each visited task
  // stays mounted, so an unscoped selector can win a hidden copy.
  const scope = () => `[data-task-id="${taskId}"]`;
  const rows = () =>
    browser.execute(
      (s) =>
        [...document.querySelectorAll(`${s} [data-testid="dir-listing"] [data-dir-entry]`)].map(
          (e) => e.getAttribute("data-dir-entry"),
        ),
      scope(),
    );
  const clickEntry = (name: string) =>
    browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).click(),
      `${scope()} [data-dir-entry="${name}"]`,
    );
  // The tab flips to type "dir" the moment the link is clicked, but the pane
  // reads the folder over IPC — so wait for the rows too, not just the state.
  const atDir = async (rel: string, expected: string[]) => {
    await browser.waitUntil(
      async () => {
        const t = (await activeTab()) as any;
        return t?.type === "dir" && t?.path === rel;
      },
      { timeout: 10_000, timeoutMsg: `the listing never landed on ${rel}` },
    );
    await browser.waitUntil(
      async () => (await rows()).length === expected.length,
      { timeout: 10_000, timeoutMsg: `${rel} never listed ${expected.length} rows` },
    );
    expect(await rows()).toEqual(expected);
  };

  it("opens a folder listing in the preview tab and expands the tree", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-dirlinks");

    // A folder with a README and a sub-folder without one, plus a markdown
    // file that links to it. Written straight to disk (taskFileWrite does not
    // mkdir -p), then an fs tick makes the tree and the pane re-read.
    mkdirSync(path.join(fixture, "e2e-docs", "plans"), { recursive: true });
    // The README carries its own links: clicking one must obey the LISTING's
    // rules (pin before opening a file, navigate in place for a folder), not
    // the generic markdown-tab rules.
    writeFileSync(
      path.join(fixture, "e2e-docs", "README.md"),
      "# docs index\n\n- [into plans](plans)\n- [the guide](guide.md)\n",
    );
    writeFileSync(path.join(fixture, "e2e-docs", "guide.md"), "# guide\n");
    writeFileSync(path.join(fixture, "e2e-docs", "plans", "roadmap.md"), "# roadmap\n");
    writeFileSync(path.join(fixture, "e2e-dirlinks.md"), "# links\n\n[the docs](e2e-docs)\n");
    // A NON-markdown file, so one case can put a tab on screen that owns no
    // MarkdownPreview of its own. Outside e2e-docs so it can't disturb the
    // row assertions.
    writeFileSync(path.join(fixture, "e2e-dirlinks-note.txt"), "plain text\n");
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );

    const mdSel = '[data-path="e2e-dirlinks.md"]';
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), mdSel),
      { timeout: 10_000, timeoutMsg: "the linking markdown file never appeared in the tree" },
    );
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, mdSel);

    // Show the rendered view (the default view is a persisted pref, so don't
    // assume this tab already opened in Preview).
    await browser.execute((id) => {
      const btn = [...document.querySelectorAll(`[data-task-id="${id}"] button`)].find(
        (b) => b.textContent?.trim() === "Preview",
      );
      if (!btn) throw new Error("Preview toggle not found");
      (btn as HTMLElement).click();
    }, taskId);
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("a")].some((a) => a.textContent?.trim() === "the docs"),
        ),
      { timeout: 10_000, timeoutMsg: "the directory link never rendered" },
    );

    const before = await tabCount();
    await browser.execute(() => {
      const a = [...document.querySelectorAll("a")].find(
        (x) => x.textContent?.trim() === "the docs",
      );
      (a as HTMLElement).click();
    });

    // Folders first, then files, each by name.
    await atDir("e2e-docs", ["plans", "guide.md", "README.md"]);
    // Recycled the preview slot rather than opening a second tab.
    expect(await tabCount()).toBe(before);

    // The sidebar tree expanded the same folder, so its children are visible.
    await browser.waitUntil(
      () =>
        browser.execute(() => !!document.querySelector('[data-path="e2e-docs/guide.md"]')),
      { timeout: 10_000, timeoutMsg: "the file tree never expanded the linked folder" },
    );
    await snap("dir-listing.png");
  });

  it("renders the folder's README under the listing", async () => {
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          (document.querySelector('[data-testid="dir-readme"]')?.textContent ?? "").includes(
            "docs index",
          ),
        ),
      { timeout: 10_000, timeoutMsg: "the folder README never rendered" },
    );
  });

  it("navigates into a sub-folder in the same tab, README-less and error-free", async () => {
    const before = (await activeTab()) as any;
    await clickEntry("plans");
    await atDir("e2e-docs/plans", ["roadmap.md"]);

    // Same tab object, not a new one.
    expect(((await activeTab()) as any).id).toBe(before.id);
    // No README here — the listing stands alone, with nothing reported wrong.
    expect(
      await browser.execute(() => !!document.querySelector('[data-testid="dir-readme"]')),
    ).toBe(false);
    expect(
      await browser.execute(() =>
        (document.querySelector('[data-testid="dir-listing"]')!.parentElement!.textContent ?? "")
          .includes("Couldn't read this folder"),
      ),
    ).toBe(false);
  });

  it("climbs back out with the up button", async () => {
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, `${scope()} [data-testid="dir-up"]`);
    await atDir("e2e-docs", ["plans", "guide.md", "README.md"]);
  });

  it("keeps the listing when a file row is clicked, opening the file alongside it", async () => {
    // The dead end this fixes: the listing WAS the preview tab, so a file
    // recycled it away and the folder you were browsing was simply gone.
    const listing = (await activeTab()) as any;
    expect(listing.preview).toBe(true);
    const before = await tabCount();

    await clickEntry("guide.md");
    await browser.waitUntil(
      async () => {
        const t = (await activeTab()) as any;
        return t?.type === "edit" && t?.path === "e2e-docs/guide.md";
      },
      { timeout: 10_000, timeoutMsg: "a file row did not open an edit tab" },
    );

    // One tab more, and the listing is still there — now pinned, so it is no
    // longer the slot the next file will recycle.
    expect(await tabCount()).toBe(before + 1);
    const survivor = await browser.execute(
      (id, lid) => (window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.id === lid),
      taskId,
      listing.id,
    );
    expect(survivor).toMatchObject({ type: "dir", path: "e2e-docs", preview: false });
  });

  it("navigates in place when a link INSIDE the README points at a folder", async () => {
    // Regression: the README renders through MarkdownPreview, whose default
    // folder handling recycles the preview slot. Inside a listing that resets
    // the back trail (unpinned) or strands the listing in another tab
    // (pinned, which it now is) - the exact failure navigateDirTab exists to
    // prevent. The previous case left an editor active, so re-select the
    // listing first.
    const listingId = await browser.execute(
      (id) =>
        (window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.type === "dir")!.id,
      taskId,
    );
    await browser.execute((tid) => {
      (document.querySelector(`[data-tab-id="${tid}"]`) as HTMLElement).click();
    }, listingId);
    await atDir("e2e-docs", ["plans", "guide.md", "README.md"]);

    const before = (await activeTab()) as any;
    const beforeCount = await tabCount();
    await browser.execute((s) => {
      const a = [...document.querySelectorAll(`${s} a`)].find(
        (x) => x.textContent?.trim() === "into plans",
      );
      if (!a) throw new Error("the README folder link never rendered");
      (a as HTMLElement).click();
    }, scope());

    await atDir("e2e-docs/plans", ["roadmap.md"]);
    const after = (await activeTab()) as any;
    expect(after.id).toBe(before.id);            // same tab, not a recycled slot
    expect(await tabCount()).toBe(beforeCount);
    // The trail GREW rather than being reset, so Cmd+[ still goes back.
    expect(after.dirHistoryIndex).toBe(before.dirHistoryIndex + 1);

    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, `${scope()} [data-testid="dir-up"]`);
    await atDir("e2e-docs", ["plans", "guide.md", "README.md"]);
  });

  it("keeps the listing when a link INSIDE the README points at a file", async () => {
    const listing = (await activeTab()) as any;

    await browser.execute((s) => {
      const a = [...document.querySelectorAll(`${s} a`)].find(
        (x) => x.textContent?.trim() === "the guide",
      );
      if (!a) throw new Error("the README file link never rendered");
      (a as HTMLElement).click();
    }, scope());

    await browser.waitUntil(
      async () => {
        const t = (await activeTab()) as any;
        return t?.type === "edit" && t?.path === "e2e-docs/guide.md";
      },
      { timeout: 10_000, timeoutMsg: "the README file link never opened an editor" },
    );
    // The listing survived, exactly as a file ROW click leaves it.
    const survivor = await browser.execute(
      (id, lid) => (window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.id === lid),
      taskId,
      listing.id,
    );
    expect(survivor).toMatchObject({ type: "dir", path: "e2e-docs", preview: false });

    // Back to the listing for the cases that follow.
    await browser.execute((tid) => {
      (document.querySelector(`[data-tab-id="${tid}"]`) as HTMLElement).click();
    }, listing.id);
    await atDir("e2e-docs", ["plans", "guide.md", "README.md"]);
  });

  it("navigates the pinned listing in place, without spawning another tab", async () => {
    // A pinned tab is no longer the preview slot, so a folder row that went
    // through the preview-tab path would strand it on the old folder and put
    // the new listing somewhere else.
    const listingId = ((await activeTab()) as any).id;
    const before = await tabCount();
    await clickEntry("plans");
    await atDir("e2e-docs/plans", ["roadmap.md"]);
    expect(await tabCount()).toBe(before);
    const after = (await activeTab()) as any;
    expect(after.id).toBe(listingId);
    expect(after.preview).toBe(false);
  });

  it("does not let a hidden listing's README swallow Cmd+F", async () => {
    // MarkdownPreview arms a CAPTURE-phase window listener for Cmd+F while it
    // believes it is visible. A listing has no source/preview toggle, so if
    // tab visibility isn't threaded in it is visible forever, and a listing
    // parked on a background tab eats Cmd+F for the whole app.
    const listingId = ((await activeTab()) as any).id;
    // The listing must be on a folder that HAS a README, or there is no
    // MarkdownPreview mounted to claim anything and the case proves nothing.
    await browser.execute((sel) => {
      (document.querySelector(sel) as HTMLElement).click();
    }, `${scope()} [data-testid="dir-up"]`);
    await atDir("e2e-docs", ["plans", "guide.md", "README.md"]);
    await browser.waitUntil(
      () =>
        browser.execute(
          (s2) => !!document.querySelector(`${s2} [data-testid="dir-readme"]`),
          scope(),
        ),
      { timeout: 10_000, timeoutMsg: "the README never rendered before the Cmd+F probe" },
    );

    // Close every markdown edit tab first. MarkdownPane gates its preview on
    // the VIEW MODE, not tab visibility, so a background .md tab left in
    // Preview/Split claims the key too - a separate, pre-existing quirk that
    // would mask what this case is actually testing.
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      for (const t of app.tabs[id] ?? []) {
        if (t.type === "edit" && /\.(md|markdown|mdx)$/i.test((t as any).path)) {
          app.closeTab(id, t.id);
        }
      }
    }, taskId);

    // Put a plain-text file on screen: an editor tab that owns no preview.
    const noteSel = '[data-path="e2e-dirlinks-note.txt"]';
    await browser.waitUntil(
      () => browser.execute((sel) => !!document.querySelector(sel), noteSel),
      { timeout: 10_000, timeoutMsg: "the .txt never appeared in the tree" },
    );
    await browser.execute((sel) => {
      (document.querySelector(sel) as HTMLElement).click();
    }, noteSel);
    await browser.waitUntil(
      async () => ((await activeTab()) as any)?.path === "e2e-dirlinks-note.txt",
      { timeout: 10_000, timeoutMsg: "the .txt never became the active tab" },
    );

    // A preview that claims the key calls preventDefault on it. Nothing else
    // binds plain Cmd+F at the window (find-in-files is Shift+Cmd+F, and
    // CodeMirror's search keymap lives on the editor's own DOM), so
    // defaultPrevented is exactly "some MarkdownPreview took it".
    const claimed = await browser.execute(() => {
      const ev = new KeyboardEvent("keydown", {
        key: "f", metaKey: true, bubbles: true, cancelable: true,
      });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(claimed).toBe(false);

    // Back to the listing, and back down into plans, so the trail the next
    // case walks ends ... -> e2e-docs -> e2e-docs/plans as it expects.
    await browser.execute((tid) => {
      (document.querySelector(`[data-tab-id="${tid}"]`) as HTMLElement).click();
    }, listingId);
    await atDir("e2e-docs", ["plans", "guide.md", "README.md"]);
    await clickEntry("plans");
    await atDir("e2e-docs/plans", ["roadmap.md"]);
  });

  it("walks the folder trail with Cmd+[ and Cmd+]", async () => {
    // The listing sits at e2e-docs/plans with e2e-docs behind it.
    const cmdBracket = (key: string) =>
      browser.execute((k) => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true }),
        );
      }, key);

    await cmdBracket("[");
    await atDir("e2e-docs", ["plans", "guide.md", "README.md"]);

    await cmdBracket("]");
    await atDir("e2e-docs/plans", ["roadmap.md"]);
  });

  it("does not claim Cmd+[ when focus is in the bottom terminal", async () => {
    // Regression: the listing used to be read off the MAIN pane regardless of
    // where focus was, so a listing nobody was looking at swallowed the key
    // and task switching silently stopped working while the drawer had focus.
    const before = ((await activeTab()) as any).dirHistoryIndex as number;
    expect(before).toBeGreaterThan(0); // there IS a trail it could have walked

    await browser.execute((id) => {
      window.__termic!.useApp.getState().toggleTerminalSplit(id);
    }, taskId);
    await browser.waitUntil(
      () => browser.execute(() => !!document.querySelector("[data-bottom-split]")),
      { timeout: 10_000, timeoutMsg: "the bottom split never opened" },
    );
    // Park focus inside the drawer. tabIndex makes the container itself a
    // focus target without depending on a terminal having spawned yet.
    await browser.execute(() => {
      const el = document.querySelector("[data-bottom-split]") as HTMLElement;
      el.setAttribute("tabindex", "-1");
      el.focus();
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          () => !!document.activeElement?.closest("[data-bottom-split]"),
        ),
      { timeout: 5_000, timeoutMsg: "focus never landed in the bottom split" },
    );

    await browser.execute(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", metaKey: true, bubbles: true }));
    });

    // The listing must not have moved.
    expect(((await activeTab()) as any).dirHistoryIndex).toBe(before);

    await browser.execute((id) => {
      window.__termic!.useApp.getState().toggleTerminalSplit(id);
    }, taskId);
  });

  it("hands Cmd+[ to task switching when focus is in the right panel", async () => {
    // The other half of the conditional claim: a listing the user is not
    // driving must not eat the key. Focus in the file tree (or any dialog /
    // sidebar) means the keyboard belongs to that, so Cmd+[ has to reach the
    // task switcher even though the main pane still shows a listing.
    const before = ((await activeTab()) as any).dirHistoryIndex as number;
    expect(before).toBeGreaterThan(0); // there IS a trail it could have walked

    const second = await openTask("e2e-dirlinks-focus");
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length > 0,
          second,
        ),
      { timeout: 15_000, timeoutMsg: "the second task never materialised its tabs" },
    );
    await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), taskId);
    await browser.waitUntil(
      async () => ((await activeTab()) as any)?.type === "dir",
      { timeout: 10_000, timeoutMsg: "never returned to the listing tab" },
    );

    // Park focus on a file-tree row in the right panel.
    await browser.execute(() => {
      const row = document.querySelector('[data-path="e2e-docs"]') as HTMLElement;
      if (!row) throw new Error("no file-tree row to focus");
      row.setAttribute("tabindex", "-1");
      row.focus();
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !!document.activeElement &&
            document.activeElement !== document.body &&
            !document.activeElement.closest("[data-main-content]"),
        ),
      { timeout: 5_000, timeoutMsg: "focus never left the main pane" },
    );

    await browser.execute(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", metaKey: true, bubbles: true }));
    });

    // Task switched, and the listing did NOT walk.
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => window.__termic!.useApp.getState().activeTaskId !== id,
          taskId,
        ),
      { timeout: 10_000, timeoutMsg: "Cmd+[ was swallowed by a listing nobody was driving" },
    );
    const listing = await browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.type === "dir"),
      taskId,
    );
    expect((listing as any).dirHistoryIndex).toBe(before);

    await archiveTask(second);
    await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), taskId);
  });

  it("falls through to task switching once the trail runs out", async () => {
    // The whole point of the conditional claim: at the END of the trail the
    // key must reach the task switcher rather than being swallowed.

    // A second task to switch TO. It only counts as switchable once it has
    // mounted and materialised its tabs, so wait for that before switching back.
    const second = await openTask("e2e-dirlinks-2");
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length > 0,
          second,
        ),
      { timeout: 15_000, timeoutMsg: "the second task never materialised its tabs" },
    );
    await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), taskId);
    await browser.waitUntil(
      async () => ((await activeTab()) as any)?.type === "dir",
      { timeout: 10_000, timeoutMsg: "never returned to the listing tab" },
    );

    const back = () =>
      browser.execute(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "[", metaKey: true, bubbles: true }),
        );
      });

    // Drain the trail: every press so far has somewhere to go, so the task
    // must NOT change while the listing still has history behind it.
    let steps = ((await activeTab()) as any).dirHistoryIndex as number;
    expect(steps).toBeGreaterThan(0);
    while (steps > 0) {
      await back();
      await browser.waitUntil(
        async () => ((await activeTab()) as any)?.dirHistoryIndex === steps - 1,
        { timeout: 10_000, timeoutMsg: `back never stepped to ${steps - 1}` },
      );
      expect(
        await browser.execute(() => window.__termic!.useApp.getState().activeTaskId),
      ).toBe(taskId);
      steps--;
    }

    // Trail exhausted — this one falls through and switches task.
    await back();
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => window.__termic!.useApp.getState().activeTaskId !== id,
          taskId,
        ),
      { timeout: 10_000, timeoutMsg: "Cmd+[ was swallowed instead of switching task" },
    );

    await archiveTask(second);
    await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), taskId);
  });
});

// ── find in markdown preview (⌘F) ────────────────────────────────────────────
// The money assertion is never "something is highlighted" but "the highlighted
// text IS the query", read out of the real DOM. Matches are wrapped in <mark>,
// so what these assert is what the engine paints.
//
// This is deliberate: the previous implementation used the CSS Custom Highlight
// API, and in WKWebView that registry stayed perfectly correct while the paint
// landed on unrelated <code> elements. A spec that read the registry passed
// while the feature was visibly broken, so nothing here reads it.
//
// ⌘F is dispatched as a synthetic window keydown: unlike CodeMirror's keymap
// (see the NOTE in "editor open" above) the preview's handler is a plain window
// listener, so it routes reliably here.

/** Prose hits, plus code/bold/link that do NOT contain the query — the shape
 *  that exposed the old bug, where code spans lit up instead of the matches. */
const findDoc = [
  "# find doc", "",
  "needle alpha here", "",
  "prose with `inlineCode` inside", "",
  "needle beta here", "",
  "**bold text** and [a link](https://example.com)", "",
  "```", "fenced block contents", "```", "",
  "needle gamma here", "",
  // Hard-wrapped on purpose: one rendered line, a literal newline in the DOM.
  "a paragraph whose wrapped phrase", "spans two source lines", "",
  // Literal dot vs any-char, for the regex-escaping case.
  "a.b and axb", "",
].join("\n");

const FIND_INPUT = 'input[placeholder="Find in preview"]';

type FindPaint = {
  /** textContent of every <mark>, in document order. */
  texts: string[];
  /** Tag of each mark's parent, so "wrapped the whole code span" is visible. */
  parents: string[];
  /** Text of the current (solid) match's containing element, so an off-by-N
   *  active match shows up rather than just "something is orange". */
  currentContext: string[];
  counter: string;
  /** Resolved background of a plain vs the current match. Structure alone
   *  can't tell you the rules in index.css still exist: delete them and the
   *  marks silently fall back to the UA yellow with every other assertion here
   *  still green. These two must differ, and neither may be transparent. */
  markBg: string;
  currentBg: string;
};

/** Scope to ONE task's subtree wherever a task id is known. Unscoped, this
 *  picks "the first laid-out preview in the document", which quietly means the
 *  Changelog dialog's portal-mounted one whenever that is open. */
const readFind = (taskId?: string) =>
  browser.execute((inputSel, id): FindPaint => {
    const shown = (el: Element) => el.getBoundingClientRect().width > 0;
    const root = id ? document.querySelector(`[data-task-id="${id}"]`) ?? document : document;
    const hostEl = Array.from(root.querySelectorAll(".markdown-body")).find(shown);
    const marks = hostEl ? Array.from(hostEl.querySelectorAll("mark.md-find")) : [];
    const bar = Array.from(root.querySelectorAll(inputSel)).find(shown)?.parentElement;
    const bg = (m: Element | undefined) => m ? getComputedStyle(m).backgroundColor : "";
    return {
      texts: marks.map((m) => m.textContent ?? ""),
      parents: marks.map((m) => m.parentElement?.tagName ?? "?"),
      currentContext: marks.filter((m) => m.classList.contains("md-find-current"))
        .map((m) => m.parentElement?.textContent ?? ""),
      counter: Array.from(bar?.querySelectorAll("span") ?? [])
        .map((s) => s.textContent?.trim() ?? "")
        .find((t) => /^\d+\/\d+$/.test(t)) ?? "",
      markBg: bg(marks.find((m) => !m.classList.contains("md-find-current"))),
      currentBg: bg(marks.find((m) => m.classList.contains("md-find-current"))),
    };
  }, FIND_INPUT, taskId ?? "");

/** Poll until `ok` holds, then hand back that reading. Required, not hygiene:
 *  the re-mark is debounced (FIND_DEBOUNCE_MS) so the DOM trails the keystroke,
 *  and the counter renders from React state on top of that. */
const waitFind = async (ok: (p: FindPaint) => boolean, msg: string, taskId?: string) => {
  let last: FindPaint = {
    texts: [], parents: [], currentContext: [], counter: "", markBg: "", currentBg: "",
  };
  await browser.waitUntil(async () => { last = await readFind(taskId); return ok(last); },
    { timeout: 8_000, timeoutMsg: msg });
  return last;
};

const pressCmdF = () =>
  browser.execute(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true }),
    );
  });

/** Type one character at a time, the way a person does: React sees N input
 *  events, and each re-runs the search. A single value assignment would skip
 *  every intermediate state. */
const typeFind = async (q: string) => {
  for (let i = 1; i <= q.length; i++) {
    await browser.execute((v, inputSel) => {
      const shown = (el: Element) => el.getBoundingClientRect().width > 0;
      const el = Array.from(document.querySelectorAll(inputSel)).find(shown) as HTMLInputElement;
      if (!el) throw new Error("no visible find bar to type into");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, q.slice(0, i), FIND_INPUT);
  }
};

const pressInFind = (key: string, shift = false) =>
  browser.execute((k, sh, inputSel) => {
    const shown = (el: Element) => el.getBoundingClientRect().width > 0;
    const el = Array.from(document.querySelectorAll(inputSel)).find(shown) as HTMLInputElement;
    if (!el) throw new Error("no visible find bar to key into");
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, shiftKey: sh, bubbles: true, cancelable: true }),
    );
  }, key, shift, FIND_INPUT);

const findBarCount = () =>
  browser.execute((inputSel) => {
    const shown = (el: Element) => el.getBoundingClientRect().width > 0;
    return Array.from(document.querySelectorAll(inputSel)).filter(shown).length;
  }, FIND_INPUT);

describe("find in markdown preview", () => {
  let taskId: string | undefined;
  const DOC = "find-doc.md";

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    writeFileSync(path.join(fixture, DOC), findDoc);
    taskId = await openTask("e2e-find");
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
        .some((h) => h.getBoundingClientRect().width > 0
          && (h as HTMLElement).textContent?.includes("needle gamma")), taskId),
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

  it("marks exactly the searched text, never the code spans around it", async () => {
    await pressCmdF();
    await browser.waitUntil(async () => (await findBarCount()) === 1,
      { timeout: 8_000, timeoutMsg: "find bar never opened" });
    await typeFind("needle");

    const p = await waitFind((x) => x.counter === "1/3", "never settled on 3 matches", taskId);
    // Three prose hits. The old bug marked the code/fenced spans instead, so
    // asserting the TEXT (not a count) is what makes this case load-bearing.
    expect(p.texts).toEqual(["needle", "needle", "needle"]);
    expect(p.parents).toEqual(["P", "P", "P"]);
    expect(p.currentContext[0]).toContain("alpha"); // first occurrence
    // The rules in index.css are still doing something, and the current match
    // is distinguishable from the rest.
    expect(p.markBg).not.toBe(p.currentBg);
    for (const c of [p.markBg, p.currentBg]) {
      expect(c).not.toBe("rgba(0, 0, 0, 0)");
      expect(c).toBeTruthy();
    }
    await snap("preview-find.png");
  });

  it("steps forward and back in step with the counter, wrapping at both ends", async () => {
    // Re-establish the precondition rather than inheriting it: one failure
    // above should not cascade into a misleading failure here. Retyping the
    // query already on screen must not cost the reader their next Enter, which
    // is exactly what flushFind's "did the result set change" check protects.
    await typeFind("needle");
    await waitFind((x) => x.counter === "1/3", "search never settled before stepping", taskId);

    await pressInFind("Enter");
    let p = await waitFind((x) => x.counter === "2/3", "never stepped to 2/3", taskId);
    expect(p.currentContext[0]).toContain("beta");

    await pressInFind("Enter");
    await pressInFind("Enter"); // 3/3 -> wraps to 1/3
    p = await waitFind((x) => x.counter === "1/3", "never wrapped forward to 1/3", taskId);
    expect(p.currentContext[0]).toContain("alpha");

    await pressInFind("Enter", true); // back past the start -> wraps to 3/3
    p = await waitFind((x) => x.counter === "3/3", "never wrapped back to 3/3", taskId);
    expect(p.currentContext[0]).toContain("gamma");
    // Exactly one match is ever the current one.
    expect(p.currentContext).toHaveLength(1);
  });

  it("replaces the previous run on a second search instead of stacking on it", async () => {
    await typeFind("fenced");
    // Wait on THIS query's marks, never on a count the previous query also had:
    // the re-mark is debounced, so a stale reading can satisfy a loose predicate.
    const p = await waitFind((x) => x.texts.join("|") === "fenced",
      "second search never replaced the first", taskId);
    expect(p.counter).toBe("1/1");         // the needles are gone, not still lit
  });

  it("matches inside a code span when the query is actually there", async () => {
    await typeFind("inlineCode");
    const p = await waitFind((x) => x.texts.join("|") === "inlineCode",
      "code-span match never landed", taskId);
    expect(p.parents).toEqual(["CODE"]);
  });

  // markdown-it runs with breaks:false, so a hard-wrapped paragraph carries the
  // source newline into the text node while rendering as one line. Searching
  // the phrase the reader plainly sees must not come back empty.
  it("matches a phrase that the markdown source hard-wrapped", async () => {
    await typeFind("wrapped phrase spans");
    const p = await waitFind((x) => x.texts.join("|").startsWith("wrapped phrase"),
      "hard-wrapped phrase never matched", taskId);
    expect(p.texts).toEqual(["wrapped phrase\nspans"]);
    expect(p.parents).toEqual(["P"]);
    expect(p.counter).toBe("1/1");
  });

  it("treats a regex metacharacter in the query as literal text", async () => {
    await typeFind("a.b");
    // "axb" is present in the doc and must NOT match a literal ".".
    const p = await waitFind((x) => x.texts.join("|") === "a.b",
      "metacharacter search never settled on the literal match", taskId);
    expect(p.counter).toBe("1/1");
  });

  it("drops every mark when the query stops matching", async () => {
    await typeFind("zzz-no-such-text");
    const p = await waitFind((x) => x.counter === "0/0", "never went to zero matches", taskId);
    expect(p.texts).toEqual([]);
  });

  it("restores the document when find closes", async () => {
    await typeFind("needle");
    await waitFind((x) => x.texts.length === 3, "search never settled before closing", taskId);

    await pressInFind("Escape");
    await browser.waitUntil(async () => (await findBarCount()) === 0,
      { timeout: 5_000, timeoutMsg: "find bar never closed" });

    const after = await browser.execute(() => {
      const shown = (el: Element) => el.getBoundingClientRect().width > 0;
      const h = Array.from(document.querySelectorAll(".markdown-body")).find(shown) as HTMLElement;
      return {
        marks: h.querySelectorAll("mark").length,
        // The prose is one text node again, not the three splitText left.
        text: h.textContent?.includes("needle alpha here") ?? false,
        // Formatting the marks were wrapped around survived.
        code: !!h.querySelector("code"),
      };
    });
    expect(after).toEqual({ marks: 0, text: true, code: true });
  });

  it("re-marks against the rebuilt DOM when a theme flip replaces it", async () => {
    const original = await browser.execute(() => window.__termic!.usePrefs.getState().themeMode);
    await pressCmdF();
    await browser.waitUntil(async () => (await findBarCount()) === 1,
      { timeout: 8_000, timeoutMsg: "find bar never reopened" });
    await typeFind("needle");
    await waitFind((x) => x.texts.length === 3, "search never settled before the flip", taskId);

    // A theme flip re-runs the render effect, which replaces host.innerHTML and
    // takes every <mark> with it. Force a real change: flipping to the theme
    // already in effect rebuilds nothing and this case would test nothing.
    const setTheme = async (mode: string, cls: string) => {
      await browser.execute((m) => window.__termic!.usePrefs.getState().setThemeMode(m), mode);
      await browser.waitUntil(
        () => browser.execute((c) => document.documentElement.classList.contains(c), cls),
        { timeout: 8_000, timeoutMsg: `theme never became ${mode}` },
      );
    };
    await setTheme("dark", "dark");
    await setTheme("light", "light");

    const p = await waitFind((x) => x.texts.length === 3,
      "matches never came back after the rebuild", taskId);
    expect(p.texts).toEqual(["needle", "needle", "needle"]);
    expect(p.parents).toEqual(["P", "P", "P"]);
    expect(p.counter).toBe("1/3");

    if (original) {
      await browser.execute((m) => window.__termic!.usePrefs.getState().setThemeMode(m), original);
    }
  });
});

// ── who owns ⌘F ──────────────────────────────────────────────────────────────
// Every visited task and every open markdown tab keeps its MarkdownPreview
// mounted, each with its own capture-phase window keydown listener that stops
// propagation. These are the cases where more than one of them believed the
// keystroke was theirs. Marks are per-preview now, so this is purely about the
// keystroke — no shared registry left to fight over.

describe("⌘F ownership across previews", () => {
  let taskA: string | undefined;
  let taskB: string | undefined;
  let tabA = "";
  const DOC = "own-a.md";
  const DOC_B = "own-b.md";

  const openMdPreview = async (taskId: string, name: string, marker: string) => {
    const tabId = await browser.execute((id, p) => {
      const app = window.__termic!.useApp.getState();
      app.openPreviewTab(id, { type: "edit", path: p, title: p });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = app.tabs[id].find((t: any) => t.type === "edit" && t.path === p);
      app.persistTab(id, tab.id);
      app.patchTab(id, tab.id, { mdView: "preview" });
      return tab.id as string;
    }, taskId, name);
    // Scoped to THIS task's subtree and to what is laid out: the same document
    // can be open in more than one task, and a hidden copy's textContent
    // matches just as happily as the one we're waiting for.
    await browser.waitUntil(
      () => browser.execute((id, m) => Array.from(
        document.querySelectorAll(`[data-task-id="${id}"] .markdown-body`))
        .some((h) => h.getBoundingClientRect().width > 0
          && (h as HTMLElement).textContent?.includes(m)), taskId, marker),
      { timeout: 15_000, timeoutMsg: `${name} preview never rendered in ${taskId}` },
    );
    return tabId;
  };

  /** Find bars in the whole document, and which task each belongs to. */
  const bars = () =>
    browser.execute((inputSel) => {
      const shown = (el: Element) => el.getBoundingClientRect().width > 0;
      const inputs = Array.from(document.querySelectorAll(inputSel));
      return {
        total: inputs.length,
        visible: inputs.filter(shown).length,
        taskIds: inputs.map((i) => i.closest("[data-task-id]")?.getAttribute("data-task-id") ?? ""),
      };
    }, FIND_INPUT);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    writeFileSync(path.join(fixture, DOC), "# own a\n\nneedle alpha\n\nneedle beta\n\nneedle gamma\n");
    writeFileSync(path.join(fixture, DOC_B), "# own b\n\nneedle zulu\n\nneedle yankee\n");
    taskA = await openTask("e2e-own-a");
    await ensureActiveTask(taskA);
    tabA = await openMdPreview(taskA, DOC, "needle gamma");
  });

  after(async () => {
    if (taskA) await archiveTask(taskA);
    if (taskB) await archiveTask(taskB);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch {
      /* nothing */
    }
  });

  it("does not open find in a task that is merely mounted behind the active one", async () => {
    taskB = await openTask("e2e-own-b");
    await ensureActiveTask(taskB);
    await openMdPreview(taskB, DOC_B, "needle zulu");
    // Back to A. B stays mounted (display:none), preview and all.
    await ensureActiveTask(taskA!);

    await pressCmdF();
    await browser.waitUntil(async () => (await bars()).visible === 1,
      { timeout: 8_000, timeoutMsg: "find bar never opened" });

    const b = await bars();
    expect(b.total).toBe(1);          // not "1 visible out of 2"
    expect(b.taskIds).toEqual([taskA]);

    await typeFind("needle");
    const p = await waitFind((x) => x.texts.length === 3, "task A's search never settled", taskA);
    expect(p.texts).toHaveLength(3);  // doc A's three, not doc B's two
    expect(p.currentContext[0]).toContain("alpha");
  });

  it("leaves ⌘F to the focused split pane instead of the visible preview", async () => {
    await pressInFind("Escape");
    await browser.waitUntil(async () => (await bars()).visible === 0,
      { timeout: 5_000, timeoutMsg: "find bar never closed" });

    // Terminal into its own pane, and focus that pane. The preview is still on
    // screen in main, but the keyboard now belongs to the terminal.
    const termId = await browser.execute((id) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = window.__termic!.useApp.getState().tabs[id].find((x: any) => x.type === "terminal");
      return t.id as string;
    }, taskA);
    await browser.execute((id, t) => window.__termic!.useApp.getState().moveTabToSplit(id, t, null, "right"),
      taskA, termId);
    // Read the new leaf's id from the STORE: the split tree is committed before
    // React has re-rendered the pane's data-pane-id into the DOM.
    const paneId: string = await browser.waitUntil(
      () => browser.execute((id, t) => {
        const tree = window.__termic!.useApp.getState().splitTree[id];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const leaves: any[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const walk = (n: any) => { if (n.type === "pane") leaves.push(n); else { walk(n.a); walk(n.b); } };
        if (tree) walk(tree);
        return leaves.find((l) => (l.tabIds ?? []).includes(t))?.id ?? "";
      }, taskA, termId),
      { timeout: 5_000, timeoutMsg: "the terminal never landed in its own split pane" },
    );
    await browser.execute((id, p) => window.__termic!.useApp.getState().setActivePaneId(id, p),
      taskA, paneId);

    await pressCmdF();
    // The assertion is an absence, so wait on the state that would have
    // produced a bar instead: the preview is on screen and the pane is focused.
    await browser.waitUntil(
      () => browser.execute((id, p) => {
        const shown = (el: Element) => el.getBoundingClientRect().width > 0;
        return window.__termic!.useApp.getState().activePaneId[id] === p
          && !!Array.from(document.querySelectorAll(".markdown-body")).find(shown);
      }, taskA, paneId),
      { timeout: 5_000, timeoutMsg: "the split pane never took focus with the preview on screen" },
    );
    expect((await bars()).total).toBe(0);

    // Back to a plain single-pane layout for the case below.
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const term = app.tabs[id].find((t: any) => t.type === "terminal");
      app.moveTabToMain(id, term.id);
    }, taskA);
    await browser.waitUntil(
      () => browser.execute((id) => !window.__termic!.useApp.getState().splitTree[id], taskA),
      { timeout: 5_000, timeoutMsg: "the split never collapsed back to a single pane" },
    );
  });

  it("stands down while a modal is open, and takes ⌘F back on close", async () => {
    // The case above collapsed the split by moving the terminal back to main,
    // which made IT the active main tab. Put the reader in the markdown tab.
    await browser.execute((id, t) => window.__termic!.useApp.getState().setActiveTabId(id, t),
      taskA, tabA);
    // A modal owns the keyboard and the tab underneath stays `active`. The
    // preview's listener checks the focus trap rather than any per-dialog store
    // flag, so this covers Settings and every other dialog too. Asserted without
    // the changelog body rendering: it's fetched over the network and may never
    // arrive here.
    await browser.execute(() => window.__termic!.useUI.getState().openChangelog());
    // Wait for the TRAP to hold focus, not merely for the node to exist: the
    // preview checks activeElement, so the dialog being in the DOM is not yet
    // the state under test. (Radix moves focus a frame or two after mount.)
    await browser.waitUntil(
      () => browser.execute(() =>
        !!(document.activeElement as HTMLElement | null)?.closest?.('[role="dialog"]')),
      { timeout: 5_000, timeoutMsg: "the changelog dialog never took focus" },
    );

    await pressCmdF();
    // Assert on OWNERSHIP, not on "no bar anywhere": when the changelog body
    // has loaded, the dialog's own preview legitimately opens one, and its bar
    // lives in a portal with no [data-task-id] ancestor. What must not happen
    // is the tab underneath claiming the key.
    expect((await bars()).taskIds.filter((id) => id === taskA)).toEqual([]);

    await browser.execute(() => window.__termic!.useUI.getState().closeChangelog());
    // Wait for the trap to RELEASE focus, not for the node to leave the DOM.
    // The dialog's exit animation is rAF-driven and rAF is throttled on an
    // occluded window, so the element can outlive its own close here — which
    // is exactly why the preview tests activeElement rather than the DOM.
    await browser.waitUntil(
      () => browser.execute(() =>
        !(document.activeElement as HTMLElement | null)?.closest?.('[role="dialog"]')),
      { timeout: 5_000, timeoutMsg: "the changelog dialog never released focus" },
    );

    await pressCmdF();
    await browser.waitUntil(
      async () => (await bars()).taskIds.includes(taskA!),
      { timeout: 5_000, timeoutMsg: "the tab never got ⌘F back" });
    await typeFind("needle");
    await waitFind((x) => x.texts.length === 3, "the tab never searched again", taskA);
  });

  // Settings is a hand-rolled overlay, not a Radix dialog: it traps no focus and
  // autofocuses nothing, so activeElement stays out in the tab underneath and
  // the focus-trap probe alone cannot see it. Without the store check the
  // preview claims ⌘F and opens a bar *beneath* the z-40 backdrop, with the
  // keyboard in an invisible input.
  it("stands down while the Settings overlay is open", async () => {
    await pressInFind("Escape");
    await browser.waitUntil(async () => (await bars()).visible === 0,
      { timeout: 5_000, timeoutMsg: "find bar never closed" });

    await browser.execute(() => window.__termic!.useApp.getState().openSettings());
    await browser.waitUntil(
      () => browser.execute(() => window.__termic!.useApp.getState().view.settingsOpen === true
        && !!document.querySelector('[role="dialog"][aria-label="Settings"]')),
      { timeout: 5_000, timeoutMsg: "settings never opened" },
    );

    await pressCmdF();
    // Absence assertion, so wait on the state that would have produced a bar:
    // settings up, and the markdown tab still the active one underneath.
    await browser.waitUntil(
      () => browser.execute((id, t) => window.__termic!.useApp.getState().activeTab[id] === t,
        taskA!, tabA),
      { timeout: 5_000, timeoutMsg: "the markdown tab was not the active one under settings" },
    );
    expect((await bars()).taskIds.filter((id) => id === taskA)).toEqual([]);

    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await browser.waitUntil(
      () => browser.execute(() => window.__termic!.useApp.getState().view.settingsOpen !== true),
      { timeout: 5_000, timeoutMsg: "settings never closed" },
    );
    await pressCmdF();
    await browser.waitUntil(async () => (await bars()).taskIds.includes(taskA!),
      { timeout: 5_000, timeoutMsg: "the tab never got ⌘F back after settings" });
    await pressInFind("Escape");
  });

  // The preview keeps its own <mark>s, so a tab recycled onto another file must
  // drop them: the sole reason the render effect reads findOpenRef rather than
  // the findOpen STATE, which still says "open" in that same commit.
  it("drops its marks when the tab is recycled onto a different file", async () => {
    await browser.execute((id, t) => window.__termic!.useApp.getState().setActiveTabId(id, t),
      taskA, tabA);
    await pressCmdF();
    await browser.waitUntil(async () => (await bars()).visible === 1,
      { timeout: 8_000, timeoutMsg: "find bar never opened" });
    await typeFind("needle");
    await waitFind((x) => x.texts.length === 3, "search never settled before the swap", taskA);

    // Same tab, different file: what a single-click in the file tree does.
    await browser.execute((id, t, p) => {
      const app = window.__termic!.useApp.getState();
      app.patchTab(id, t, { path: p, title: p, mdView: "preview" });
    }, taskA, tabA, DOC_B);
    await browser.waitUntil(
      () => browser.execute((id, m) => Array.from(
        document.querySelectorAll(`[data-task-id="${id}"] .markdown-body`))
        .some((h) => h.getBoundingClientRect().width > 0
          && (h as HTMLElement).textContent?.includes(m)), taskA, "needle zulu"),
      { timeout: 10_000, timeoutMsg: "the tab never re-rendered onto doc B" },
    );

    // The bar closed with the swap and nothing is left painted over doc B.
    await browser.waitUntil(async () => (await bars()).visible === 0,
      { timeout: 5_000, timeoutMsg: "find stayed open across the file swap" });
    expect((await readFind(taskA)).texts).toEqual([]);

    // Put the tab back so later runs of this file start where they expect.
    await browser.execute((id, t, p) => {
      window.__termic!.useApp.getState().patchTab(id, t, { path: p, title: p, mdView: "preview" });
    }, taskA, tabA, DOC);
  });

  // Split view is the one layout where two things on screen both want ⌘F, and
  // it is the case the reporter hit. CodeMirror's keymap only binds while the
  // EditorView has focus, so the preview must yield whenever the caret is in
  // the editor and claim it only once the reader clicks into the preview.
  describe("split view (editor beside preview)", () => {
    before(async () => {
      await browser.execute((id, t) => {
        const app = window.__termic!.useApp.getState();
        app.setActiveTabId(id, t);
        app.patchTab(id, t, { mdView: "split" });
      }, taskA, tabA);
      await browser.waitUntil(
        () => browser.execute((id) => {
          const shown = (el: Element) => el.getBoundingClientRect().width > 0;
          const root = document.querySelector(`[data-task-id="${id}"]`);
          return !!root && !!Array.from(root.querySelectorAll(".cm-editor")).find(shown)
            && !!Array.from(root.querySelectorAll(".markdown-body")).find(shown);
        }, taskA),
        { timeout: 10_000, timeoutMsg: "split view never showed both panes" },
      );
    });

    after(async () => {
      await browser.execute((id, t) => {
        window.__termic!.useApp.getState().patchTab(id, t, { mdView: "preview" });
      }, taskA, tabA);
    });

    it("yields ⌘F to the editor while the caret is in it", async () => {
      await browser.execute((id) => {
        const shown = (el: Element) => el.getBoundingClientRect().width > 0;
        const root = document.querySelector(`[data-task-id="${id}"]`)!;
        (Array.from(root.querySelectorAll(".cm-content")).find(shown) as HTMLElement).focus();
      }, taskA);
      await browser.waitUntil(
        () => browser.execute(() => !!document.activeElement?.closest(".cm-editor")),
        { timeout: 5_000, timeoutMsg: "the editor never took focus" },
      );

      await pressCmdF();
      // The preview must not have opened a bar. CodeMirror's own panel is a
      // different widget entirely, so scope to the preview's placeholder.
      expect((await bars()).total).toBe(0);
    });

    it("claims ⌘F once the reader clicks into the preview", async () => {
      // The real click path: the scroller's onMouseDown focuses the container,
      // which is the only thing that makes contains(activeElement) meaningful
      // in WKWebView (it won't focus non-editable content on its own).
      //
      // The precondition is "focus ARRIVED in the preview", not "focus left the
      // editor" — those differ, and the weaker one flakes: focus passes through
      // <body> on the way, and ⌘F correctly stands down there. So retry the
      // mousedown until the container actually holds it.
      await browser.waitUntil(
        () => browser.execute((id) => {
          const shown = (el: Element) => el.getBoundingClientRect().width > 0;
          const root = document.querySelector(`[data-task-id="${id}"]`)!;
          const host = Array.from(root.querySelectorAll(".markdown-body")).find(shown)!;
          host.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          const ae = document.activeElement;
          // The container is the focusable ancestor of the host; <body> is an
          // ancestor too, hence excluding it explicitly.
          return !!ae && ae !== document.body && ae.contains(host);
        }, taskA),
        { timeout: 5_000, timeoutMsg: "the preview container never took focus" },
      );

      await pressCmdF();
      await browser.waitUntil(async () => (await bars()).visible === 1,
        { timeout: 8_000, timeoutMsg: "the preview never claimed ⌘F after the click" });
      await typeFind("needle");
      const p = await waitFind((x) => x.texts.length === 3, "split preview never marked", taskA);
      expect(p.texts).toEqual(["needle", "needle", "needle"]);
      expect(p.parents).toEqual(["P", "P", "P"]);
      await pressInFind("Escape");
      await browser.waitUntil(async () => (await bars()).visible === 0,
        { timeout: 5_000, timeoutMsg: "find bar never closed" });
    });
  });
});
