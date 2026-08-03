import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
