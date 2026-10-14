import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { archiveTask, cliRpc, dismissOverlays, FILE_MANAGER_NAME, ensureActiveTask, openTask, requireTermicApi, snap, waitForAgentReady, waitForAppShell, waitVisible, rmTree } from "../helpers";

declare global {
  interface Window {
    /** Every src the PDF embed has taken, recorded by the pdf-preview spec so
     *  "this tick changed nothing" is an observation, not a wait. */
    __pdfSrcLog?: string[];
    /** The on-screen copy of `sel` in the md-split spec's task. Installed by
     *  that spec; every visited task stays mounted, so a bare query can land
     *  on a hidden one. */
    __mdShown?: (sel: string) => HTMLElement;
  }
}

// Editor (CodeMirror 6), open/preview/persist. Cases: single-click opens a
// PREVIEW tab (italic, recyclable) with the file's real contents; double-click
// PERSISTS it. Saving has its own spec (editor-save.e2e.ts).
describe("editor open", () => {
  let taskId!: string;
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
  // environment-limited list in docs/e2e-coverage.md), so it stays a
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

  it("lets the rendered markdown be selected like a web page", async () => {
    // The app chrome is user-select:none. The preview is a document, and
    // selecting a paragraph of it to paste elsewhere is the point.
    const selectable = await browser.execute(() => {
      const h = [...document.querySelectorAll(".markdown-body h1")]
        .find((el) => el.getBoundingClientRect().width > 0) as HTMLElement | undefined;
      if (!h) return "no heading";
      const cs = getComputedStyle(h);
      return cs.webkitUserSelect || cs.userSelect;
    });
    expect(selectable).toBe("text");
  });

  it("copies a selection as clean rich text, links and all", async () => {
    // What reaches the clipboard: the document's structure with none of the
    // theme's inline colours (see lib/markdownCopy.ts).
    const out = await browser.execute(() => {
      const host = [...document.querySelectorAll(".markdown-body")]
        .find((el) => el.getBoundingClientRect().width > 0) as HTMLElement | undefined;
      if (!host) return null;
      const probe = document.createElement("p");
      probe.innerHTML = 'See <strong>the <a href="https://example.com/x">docs</a></strong>';
      host.appendChild(probe);
      const range = document.createRange();
      range.selectNodeContents(probe);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      const dt = new DataTransfer();
      probe.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
      probe.remove();
      sel.removeAllRanges();
      return { html: dt.getData("text/html"), text: dt.getData("text/plain") };
    });
    expect(out).not.toBeNull();
    expect(out!.html).toBe('See <strong>the <a href="https://example.com/x">docs</a></strong>');
    expect(out!.text).toBe("See the docs");
  });

  it("sets the preview in GitHub's type: 14px, 1.5 leading, a 980px measure", async () => {
    const m = await browser.execute(() => {
      const host = [...document.querySelectorAll(".markdown-body")]
        .find((el) => el.getBoundingClientRect().width > 0) as HTMLElement;
      const cs = getComputedStyle(host);
      return { size: cs.fontSize, lh: cs.lineHeight, max: cs.maxWidth };
    });
    expect(m).toEqual({ size: "14px", lh: "21px", max: "980px" });
  });

  it("previews a markdown file outside the task, and follows its relative links", async () => {
    // ⌘-clicking an absolute path opens an EXTERNAL tab. A markdown one gets
    // the same preview shell, with links resolved against its own directory.
    const dir = mkdtempSync(path.join(tmpdir(), "termic-e2e-extmd-"));
    const main = path.join(dir, "notes.md");
    writeFileSync(main, "# External notes\n\nSee [the other one](other.md).\n");
    writeFileSync(path.join(dir, "other.md"), "# Other notes\n");
    await browser.execute((id, p) => {
      window.__termic!.useApp.getState().openPreviewTab(id, { type: "external", path: p, title: "notes.md" });
    }, taskId, main);
    const tabOf = (p: string) => browser.execute((id, q) =>
      (window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.type === "external" && t.path === q)?.id ?? null,
    taskId, p) as Promise<string | null>;
    await browser.waitUntil(async () => !!(await tabOf(main)), { timeout: 8_000, timeoutMsg: "external tab never opened" });
    await browser.execute((id, tabId) => {
      window.__termic!.useApp.getState().patchTab(id, tabId, { mdView: "preview" });
    }, taskId, (await tabOf(main))!);
    const shownHeading = (text: string) => browser.execute((id, t) =>
      [...document.querySelectorAll(`[data-task-id="${id}"] .markdown-body h1`)]
        .some((h) => h.getBoundingClientRect().width > 0 && h.textContent?.includes(t)), taskId, text);
    await browser.waitUntil(() => shownHeading("External notes"), {
      timeout: 10_000, timeoutMsg: "the external markdown never rendered as a preview",
    });
    await snap("external-markdown-preview");

    await browser.execute((id) => {
      const a = [...document.querySelectorAll(`[data-task-id="${id}"] .markdown-body a`)]
        .find((el) => el.getBoundingClientRect().width > 0 && el.textContent === "the other one") as HTMLElement;
      a.click();
    }, taskId);
    await browser.waitUntil(async () => !!(await tabOf(path.join(dir, "other.md"))), {
      timeout: 8_000, timeoutMsg: "a relative link in an external document did not open its sibling",
    });
    rmTree(dir, { bestEffort: true });
  });
});

// Cmd+click on a file path in a terminal is a deliberate "open THIS file", so
// it opens a PERMANENT tab: it neither lands in nor evicts the preview slot
// (the italic, recyclable tab every other single-click open uses). Driven
// through the real capture-phase opener: a shell prints the path at the top
// left of a cleared screen and the spec cmd+clicks that cell. Asserted on the
// italic title the user actually sees, not only on the store flag.
describe("terminal cmd+click opens a permanent tab", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const tabFor = (p: string) =>
    browser.execute(
      (id, path) => (window.__termic!.useApp.getState().tabs[id] ?? [])
        .find((t: any) => t.type === "edit" && t.path === path) ?? null,
      taskId, p,
    ) as Promise<any>;
  /** The tab title's font-style, as rendered: "italic" = preview. */
  const titleStyle = (tabId: string) =>
    browser.execute((id) => {
      const el = document.querySelector(`[data-tab-id="${id}"] .truncate`) as HTMLElement | null;
      return el ? getComputedStyle(el).fontStyle : null;
    }, tabId);
  /** Cmd+click the top-left cell of the task's visible terminal screen. */
  const cmdClickTopLeft = () =>
    browser.execute((id) => {
      const screen = [...document.querySelectorAll<HTMLElement>(`[data-task-id="${id}"] .xterm-screen`)]
        .find(el => el.getBoundingClientRect().width > 0);
      if (!screen) return false;
      const r = screen.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, button: 0, metaKey: true, clientX: r.left + 3, clientY: r.top + 3 };
      screen.dispatchEvent(new MouseEvent("mousedown", at));
      screen.dispatchEvent(new MouseEvent("mouseup", at));
      screen.dispatchEvent(new MouseEvent("click", at));
      return true;
    }, taskId);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-term-cmdclick", true, "shell");
    await browser.waitUntil(
      () => browser.execute((id) => !!(window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.type === "terminal")?.ptyId, taskId),
      { timeout: 20_000, timeoutMsg: "the shell never got a PTY" },
    );
    // `clear` homes the cursor, so the path prints at row 0, col 0.
    await browser.execute(async (id) => {
      const t = window.__termic!;
      const pty = (t.useApp.getState().tabs[id] ?? []).find((x: any) => x.type === "terminal").ptyId;
      const bytes = [...new TextEncoder().encode("clear; printf 'README.md\\n'\r")];
      await t.ipc.ptyWrite(pty, bytes);
    }, taskId);
  });

  it("opens a regular tab and leaves the preview slot's file alone", async () => {
    // Something already occupies the preview slot.
    await browser.execute((id) => window.__termic!.useApp.getState().openPreviewTab(id, {
      type: "edit", path: "e2e-preview-occupant.txt", title: "e2e-preview-occupant.txt",
    }), taskId);
    // Back to the terminal, then cmd+click the printed path. Retried until the
    // tab appears: the shell prints asynchronously, and a click on a blank
    // cell is a no-op, so repeating it is safe.
    await browser.waitUntil(async () => {
      await browser.execute((id) => {
        const s = window.__termic!.useApp.getState();
        const term = (s.tabs[id] ?? []).find((t: any) => t.type === "terminal");
        s.setActiveTabId(id, term.id);
      }, taskId);
      await cmdClickTopLeft();
      return !!(await tabFor("README.md"));
    }, { timeout: 15_000, interval: 500, timeoutMsg: "cmd+click on the printed path never opened it" });

    const readme = await tabFor("README.md");
    expect(readme.preview).toBe(false);
    await browser.waitUntil(async () => (await titleStyle(readme.id)) !== null, { timeout: 5_000 });
    expect(await titleStyle(readme.id)).toBe("normal");
    // The preview slot kept its file: nothing was evicted.
    const occupant = await tabFor("e2e-preview-occupant.txt");
    expect(occupant?.preview).toBe(true);
    expect(await titleStyle(occupant.id)).toBe("italic");
    await snap("terminal-cmdclick-permanent.png");
  });

  it("pins the file in place when it is the one already in the preview slot", async () => {
    // Close README, then make it the preview occupant. Retried until it
    // STAYS the preview: the case above clicks in a loop, and each click
    // resolves its path over IPC, so on a slow runner a late one can land
    // after this reopen and pin README again.
    await browser.waitUntil(async () => {
      const open = await tabFor("README.md");
      if (open) await browser.execute((id, tid) => window.__termic!.useApp.getState().closeTab(id, tid), taskId, open.id);
      await browser.execute((id) => window.__termic!.useApp.getState().openPreviewTab(id, {
        type: "edit", path: "README.md", title: "README.md",
      }), taskId);
      // A settle window against IPC still in flight from the case before: its
      // clicks resolve their paths over IPC, and a late one lands here and
      // pins README again. Nothing observable says "no more are coming".
      await browser.pause(500);
      return (await tabFor("README.md"))?.preview === true;
    }, { timeout: 15_000, interval: 100, timeoutMsg: "README never stayed in the preview slot" });
    const before = await tabFor("README.md");
    expect(before.preview).toBe(true);

    await browser.waitUntil(async () => {
      await browser.execute((id) => {
        const s = window.__termic!.useApp.getState();
        s.setActiveTabId(id, (s.tabs[id] ?? []).find((t: any) => t.type === "terminal").id);
      }, taskId);
      await cmdClickTopLeft();
      return (await tabFor("README.md"))?.preview === false;
    }, { timeout: 15_000, interval: 500, timeoutMsg: "cmd+click never pinned the previewed file" });
    // The SAME tab, pinned: no second README tab.
    expect((await tabFor("README.md")).id).toBe(before.id);
    const count = await browser.execute((id) => (window.__termic!.useApp.getState().tabs[id] ?? [])
      .filter((t: any) => t.type === "edit" && t.path === "README.md").length, taskId);
    expect(count).toBe(1);
    expect(await titleStyle(before.id)).toBe("normal");
  });
});

// P0: editing a file and saving it. Guards the CodeMirror edit -> dirty dot ->
// Cmd+S -> taskFileWrite path (termic never auto-saves). Restores README on
// teardown so the fixture repo stays clean for the git specs.
describe("editor save", () => {
  let taskId!: string;
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
          new KeyboardEvent("keydown", { key: "s", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, bubbles: true }),
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
  let taskId!: string;
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

  const tokenSpans = () =>
    browser.execute(
      () => document.querySelectorAll(".cm-content .cm-line span[class]").length,
    );

  // Open a file WITHOUT waiting for highlight tokens — for the plain-text
  // cases, where "no tokens" is the thing being asserted.
  const openPlain = async (name: string, source: string, marker: string) => {
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
    await browser.waitUntil(
      () =>
        browser.execute(
          (m) => (document.querySelector(".cm-content")?.textContent ?? "").includes(m),
          marker,
        ),
      { timeout: 10_000, timeoutMsg: `CodeMirror never loaded ${name}` },
    );
  };

  // The breadcrumb's language button, which is also what the palette's
  // "Set syntax…" row opens.
  const syntaxLabel = () =>
    browser.execute(
      (id) =>
        (
          document.querySelector(
            `[data-task-id="${id}"] [data-testid="syntax-button"]`,
          ) as HTMLElement | null
        )?.textContent ?? null,
      taskId,
    );

  // Issue #244. `@codemirror/legacy-modes` has no Makefile grammar, so this
  // one is hand-written (src/lib/makeMode.ts) and the tab-means-recipe rule
  // is the part worth guarding in the real editor.
  it("highlights a Makefile, which has no upstream grammar at all", async () => {
    await openHighlighted(
      "Makefile",
      "CARGO := cargo\n\n.PHONY: build\nbuild: ## comment\n\t@$(CARGO) build --release\n",
      "CARGO",
    );

    const styled = await browser.execute(() =>
      [...document.querySelectorAll(".cm-content .cm-line span[class]")].map(
        (s) => s.textContent ?? "",
      ),
    );
    // Two tokens the mode has to get right, and that every editor theme
    // colours: the special target, and the comment after the recipe's `:`.
    expect(styled).toContain(".PHONY");
    expect(styled.some((t) => t.includes("## comment"))).toBe(true);
    expect(await syntaxLabel()).toBe("Makefile");

    await snap("code-editor-makefile.png");
  });

  it("highlights Terraform blocks and values with the HCL grammar", async () => {
    await openHighlighted(
      "main.tf",
      '# Terraform fixture\nresource "example_service" "demo" {\n  name = "hello ${var.name}"\n  enabled = true\n  count = 2\n}\n',
      "example_service",
    );
    expect(await syntaxLabel()).toBe("HCL");
    const colors = await browser.execute((id) => {
      const content = document.querySelector(`[data-task-id="${id}"] .cm-content`)!;
      const spans = [...content.querySelectorAll(".cm-line span[class]")];
      return {
        plain: getComputedStyle(content).color,
        resource: spans.find(s => s.textContent === "resource")?.textContent,
        valueColors: ["true", "2"].map(text => {
          const span = spans.find(s => s.textContent === text);
          return span ? getComputedStyle(span).color : null;
        }),
        comment: spans.some(s => s.textContent?.includes("Terraform fixture")),
      };
    }, taskId);
    expect(colors.resource).toBe("resource");
    expect(colors.comment).toBe(true);
    for (const color of colors.valueColors) {
      expect(color).not.toBeNull();
      expect(color).not.toBe(colors.plain);
    }
    await snap("code-editor-terraform.png");
  });

  it("switches between Terraform variables, HCL and Terraform JSON", async () => {
    await openHighlighted("prod.auto.tfvars", 'region = "test-region"\nenabled = true\n', "test-region");
    expect(await syntaxLabel()).toBe("HCL");
    await openHighlighted("settings.hcl", 'locals {\n  greeting = "hello"\n}\n', "greeting");
    expect(await syntaxLabel()).toBe("HCL");
    await openHighlighted("main.tf.json", '{"locals": {"greeting": "hello"}}\n', "greeting");
    expect(await syntaxLabel()).toBe("JSON");
  });

  // The whole point of sourcing languages from @codemirror/language-data:
  // there is no PHP entry anywhere in termic, no import, no case in a switch.
  // Highlighting it proves the registry lookup, the async grammar load and the
  // compartment all reach CodeMirror on a language nobody here registered.
  it("highlights a language termic never registered", async () => {
    await openHighlighted(
      "hello.php",
      "<?php\nfunction greet(string $name): string {\n    return \"hi $name\";\n}\n",
      "greet",
    );

    const styled = await browser.execute(() =>
      [...document.querySelectorAll(".cm-content .cm-line span[class]")].map(
        (s) => s.textContent ?? "",
      ),
    );
    expect(styled).toContain("function");
    expect(await syntaxLabel()).toBe("PHP");

    await snap("code-editor-php.png");
  });

  // The two extensions this repo is mostly made of. They are the ones a
  // regression would be noticed on first and the ones the suite never opened
  // before the registry swap, which is how a broken .ts shipped once.
  it("highlights TypeScript and JavaScript", async () => {
    await openHighlighted(
      "hello.ts",
      "export const greet = (name: string): string => `hi ${name}`;\n",
      "greet",
    );
    expect(await syntaxLabel()).toBe("TypeScript");

    await openHighlighted(
      "hello.js",
      "export const greet = (name) => `hi ${name}`;\n",
      "greet",
    );
    expect(await syntaxLabel()).toBe("JavaScript");

    await openHighlighted(
      "App.tsx",
      "export const App = () => <div className=\"x\">hi</div>;\n",
      "App",
    );
    // The registry splits JSX/TSX out of TypeScript. Same grammar, own name.
    expect(await syntaxLabel()).toBe("TSX");
  });

  it("names the syntax it picked from the extension", async () => {
    await openHighlighted("typed.py", "x = 1\n", "x = 1");
    expect(await syntaxLabel()).toBe("Python");
  });

  it("guesses the syntax from the content when the name says nothing", async () => {
    // No extension at all: only the content can say this is JSON, and the
    // button must agree with what the buffer is actually highlighted as.
    await openHighlighted(
      "config-blob",
      '{\n  "name": "termic",\n  "port": 1420\n}\n',
      "termic",
    );
    expect(await syntaxLabel()).toBe("JSON");
  });

  it("overrides the guess when the user sets the syntax by hand", async () => {
    // One `key: value` line is not enough for the sniffer to call it YAML
    // (it wants at least two), and `.txt` claims nothing — so this starts
    // life as plain text, with no grammar and therefore no token spans.
    await openPlain("notes.txt", "server: 8080\n", "8080");
    expect(await syntaxLabel()).toBe("Plain Text");
    expect(await tokenSpans()).toBe(0);

    await browser.execute((id) => {
      (
        document.querySelector(
          `[data-task-id="${id}"] [data-testid="syntax-button"]`,
        ) as HTMLElement
      ).click();
    }, taskId);

    // Existence, not `waitForDisplayed`: the panel fades in via a CSS
    // animation, and animations are frozen while the window is occluded — a
    // visibility wait then times out on a palette that is perfectly usable.
    // The row's key is CodeMirror's registry NAME, which is also the label.
    const rowSel = '[data-testid="syntax-palette"] [data-lang="YAML"]';
    await browser.waitUntil(
      () => browser.execute((sel) => !!document.querySelector(sel), rowSel),
      { timeout: 8_000, timeoutMsg: "the syntax palette never listed YAML" },
    );
    await browser.execute((sel) => {
      (document.querySelector(sel) as HTMLElement).click();
    }, rowSel);

    await browser.waitUntil(async () => (await syntaxLabel()) === "YAML", {
      timeout: 5000,
      timeoutMsg: "the syntax button never switched to YAML",
    });
    // The pick must actually reach CodeMirror, not just the label: the
    // language compartment is reconfigured in place, so the buffer that had
    // no token spans at all now has them.
    await browser.waitUntil(async () => (await tokenSpans()) > 0, {
      timeout: 5000,
      timeoutMsg: "no syntax tokens after setting the syntax to YAML",
    });
    // …and the content survived the switch (a view REBUILD would also
    // produce tokens, while quietly discarding undo history and the cursor).
    const text = await browser.execute(
      () => document.querySelector(".cm-content")?.textContent ?? "",
    );
    expect(text).toContain("server: 8080");

    // Picking closes the palette. Radix defers the unmount until the closing
    // animation ends, and animations are frozen on an occluded window, so the
    // node itself can linger — `data-state` is the signal, not presence.
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const el = document.querySelector('[data-testid="syntax-palette"]');
          return !el || el.getAttribute("data-state") === "closed";
        }),
      { timeout: 8_000, timeoutMsg: "the syntax palette stayed open after a pick" },
    );
    await snap("code-editor-set-syntax.png");
  });

  it("soft-wraps long lines when word wrap is on, in place, and back", async () => {
    // A pref with no toolbar control: Settings and the palette flip it. The
    // compartment is reconfigured in place, so the buffer is never rebuilt.
    await openPlain("long-line.txt", `start ${"word ".repeat(400)}end\n`, "start");
    const wrapped = () => browser.execute((id) => {
      const c = [...document.querySelectorAll(`[data-task-id="${id}"] .cm-content`)]
        .find((el) => el.getBoundingClientRect().width > 0);
      return c?.classList.contains("cm-lineWrapping") ?? null;
    }, taskId);
    const setWrap = (v: boolean) => browser.execute((on) => window.__termic!.usePrefs.getState().setEditorWordWrap(on), v);
    try {
      await setWrap(false);
      expect(await wrapped()).toBe(false);
      await setWrap(true);
      await browser.waitUntil(async () => (await wrapped()) === true, {
        timeout: 5000, timeoutMsg: "word wrap never reached the open editor",
      });
      // Wrapped means no horizontal scroll left to do.
      const overflow = await browser.execute((id) => {
        const sc = [...document.querySelectorAll(`[data-task-id="${id}"] .cm-scroller`)]
          .find((el) => el.getBoundingClientRect().width > 0) as HTMLElement;
        return sc.scrollWidth - sc.clientWidth;
      }, taskId);
      expect(overflow).toBeLessThanOrEqual(1);
      await setWrap(false);
      await browser.waitUntil(async () => (await wrapped()) === false, {
        timeout: 5000, timeoutMsg: "turning word wrap off did not unwrap the editor",
      });
    } finally {
      await setWrap(false);
    }
  });

  // Issue #161. The gutter is `position: sticky` (z-index 200) inside the
  // scroller, so a long line slides UNDER the line numbers as you scroll right,
  // and a see-through gutter shows it. Nothing in the DOM says "overlap", so the
  // assertion is the property that caused it: the gutter must paint the same
  // surface its host does. Comparing the two (rather than just "not
  // transparent") also catches the opposite failure, a gutter opaque in some
  // color that doesn't match the pane, and holds under every palette.
  it("keeps the gutter opaque when a long line scrolls horizontally", async () => {
    await openHighlighted(
      "wide.py",
      `wide = "${"scroll ".repeat(400)}"\n`,
      "wide",
    );

    const scrolled = await browser.execute((id) => {
      // Every visited tab stays mounted (display:none) — the visible editor is
      // the one with a width.
      const el = [
        ...document.querySelectorAll(`[data-task-id="${id}"] .cm-scroller`),
      ].find((e) => (e as HTMLElement).clientWidth > 0) as HTMLElement | undefined;
      if (!el) throw new Error("no visible .cm-scroller");
      el.scrollLeft = el.scrollWidth;
      return el.scrollLeft;
    }, taskId!);
    // Without real overflow nothing ever slides under the gutter and the case
    // below would pass for the wrong reason.
    expect(scrolled).toBeGreaterThan(0);

    const [gutterBg, hostBg] = await browser.execute((id) => {
      const visible = (sel: string) =>
        [...document.querySelectorAll(`[data-task-id="${id}"] ${sel}`)].find(
          (e) => (e as HTMLElement).clientWidth > 0,
        ) as HTMLElement | undefined;
      const gutter = visible(".cm-gutters");
      const editor = visible(".cm-editor");
      if (!gutter || !editor) throw new Error("no visible editor/gutter");
      // Read alpha off the 4th rgba() component rather than pattern-matching a
      // trailing `, 0)`: opaque black computes to `rgb(0, 0, 0)` and would look
      // see-through to that shortcut.
      const opaque = (bg: string) => {
        const parts = bg.match(/^rgba?\(([^)]+)\)$/)?.[1].split(",").map(Number);
        return !!parts && (parts.length < 4 || parts[3] > 0);
      };
      // The editor's own surfaces are deliberately transparent, so the painted
      // background is the nearest ancestor that sets one.
      let host: HTMLElement | null = editor;
      let painted = "";
      while (host) {
        const bg = getComputedStyle(host).backgroundColor;
        if (opaque(bg)) {
          painted = bg;
          break;
        }
        host = host.parentElement;
      }
      if (!painted) throw new Error("no painted ancestor background");
      return [getComputedStyle(gutter).backgroundColor, painted];
    }, taskId!);
    expect(gutterBg).toBe(hostBg);

    await snap("code-editor-hscroll.png");
  });
  /** A file long enough that its end is far past anything CodeMirror parses
   *  for the first screen. 2400 lines of Python measured at ~940ms of plain
   *  text before this was fixed. */
  const deepFile = () => {
    const out: string[] = [];
    for (let i = 0; i < 400; i++) {
      out.push(`class Model${i}(Base):`);
      out.push(`    name: str = 'm${i}'`);
      out.push(`    def build(self, n: int) -> dict:`);
      out.push(`        return {'id': n, 'name': self.name}`);
      out.push("");
      out.push("");
    }
    return out.join("\n") + "\n";
  };

  it("colours the text it shows, even opening deep in a long file", async () => {
    // The bug this pins: CodeMirror parses from the START of the document, so
    // a view that opens at line 2300 (a restored scroll position, a
    // go-to-definition, a Find-in-Files hit) had its viewport a thousand lines
    // past anything parsed. The text painted plain and coloured in only when
    // the background parse caught up, which reads as the editor being broken
    // for half a second. It never reproduces at the top of a file, which is
    // where anyone debugging it looks first.
    //
    // Asserted as an INVARIANT, not a duration: at the first moment the
    // document has text on screen, that text is already coloured. A threshold
    // would be a timing test and would rot on a slower machine.
    writeFileSync(path.join(fixture, "deep.py"), deepFile());
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );
    await browser.execute((id) => {
      window.__termic!.useApp.getState().openPreviewTab(id, {
        type: "edit", path: "deep.py", title: "deep.py", revealAt: { line: 2300 },
      });
    }, taskId);
    await waitVisible(`[data-task-id="${taskId}"] .cm-editor`);

    // The parse, not the pixels. `syntaxTree(state).length` is how far the
    // grammar has got, and the highlight is derived from it, so "the tree
    // reaches the end of what is on screen" is the same statement as "what is
    // on screen is coloured" without racing a repaint.
    const measure = async () => await browser.execute((id) => {
      const dom = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as unknown as
        { __cmView?: { state: unknown; viewport: { from: number; to: number } } } | null;
      const view = dom?.__cmView;
      if (!view) return null;
      const tree = window.__termic!.cm.syntaxTree(view.state);
      return { tree: tree.length, from: view.viewport.from, to: view.viewport.to };
    }, taskId) as { tree: number; from: number; to: number } | null;

    // WAIT for the parse to cover the viewport rather than sampling once.
    // Parsing runs on a time budget (`forceParsing(view, viewport.to, 60)`),
    // so a loaded machine can need a second slice: a one-shot read measured
    // 3,001 characters against a 48,058-character viewport on a box running
    // three e2e suites at once, and failed a feature that works. The timeout
    // is what keeps this honest — a parse that never arrives still fails.
    const covered = await browser.waitUntil(
      async () => {
        const m = await measure();
        return m && m.tree >= m.from ? m : false;
      },
      { timeout: 15_000, timeoutMsg: "the parse never reached the visible text" },
    ) as { tree: number; from: number; to: number };

    // Really deep: without this the case would pass on a viewport at the top
    // of the file, which is the one place the bug never happened.
    expect(covered.from).toBeGreaterThan(10_000);
    // And the parse reached what is on screen. Deliberately measured against
    // the START of the viewport rather than its end: the last few lines can
    // still be parsing, and a viewport grows by a line or two once tokens
    // render and change the line heights. The difference that matters is
    // 48,000 characters wide, not 200.
    expect(covered.tree).toBeGreaterThanOrEqual(covered.from);
  });

});

// The syntax theme is configured independently per app mode (dark / light):
// a dark-optimized scheme reads as unusable on a light surface and vice versa,
// so `editorThemeId` was split into `editorThemeIdDark` + `editorThemeIdLight`
// (EditorPane picks one via `resolveTheme(themeMode)`).
//
// Two things can regress here and only one is visible from the prefs store, so
// both are asserted against the RENDERED tokens: the app mode must select the
// matching pref, and each pref must only reach its own mode. The old single
// pref passes the first check trivially (one value for both modes), so the
// case that actually pins the split is the last one: editing the dark pref
// while the app is light must change nothing on screen.
describe("editor theme per app mode", () => {
  let taskId!: string;
  let originals: { mode: string; dark: string; light: string } | undefined;

  after(async () => {
    if (originals) {
      await browser.execute((o) => {
        const p = window.__termic!.usePrefs.getState();
        p.setThemeMode(o.mode as any);
        p.setEditorThemeIdDark(o.dark);
        p.setEditorThemeIdLight(o.light);
      }, originals);
    }
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch {
      /* nothing */
    }
  });

  /** Computed colors of every highlighted token in the visible editor, in
   *  document order. A theme swap repaints the syntax layer, so this string
   *  changes; asserting the whole set (rather than one hand-picked span)
   *  means the case does not depend on which token a given theme colors. */
  const tokenColors = () =>
    browser.execute((id) => {
      const content = [
        ...document.querySelectorAll(`[data-task-id="${id}"] .cm-content`),
      ].find((e) => (e as HTMLElement).clientWidth > 0) as HTMLElement | undefined;
      if (!content) throw new Error("no visible .cm-content");
      const spans = [...content.querySelectorAll(".cm-line span[class]")];
      if (!spans.length) throw new Error("no highlighted token spans");
      return spans.map((s) => getComputedStyle(s).color).join("|");
    }, taskId!);

  /** Apply a prefs change and wait for CodeMirror's theme compartment to
   *  actually repaint (it reconfigures in an effect, so the DOM lags the
   *  store by a tick). Returns the new fingerprint. */
  const applyAndSettle = async (mutate: () => Promise<unknown>, before: string) => {
    await mutate();
    await browser.waitUntil(async () => (await tokenColors()) !== before, {
      timeout: 8_000,
      timeoutMsg: "editor tokens never repainted after the theme change",
    });
    return tokenColors();
  };

  let darkColors = "";
  let lightColors = "";

  it("paints the dark pref's theme while the app theme is dark", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-theme-mode");

    originals = await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      return {
        mode: p.themeMode,
        dark: p.editorThemeIdDark,
        light: p.editorThemeIdLight,
      };
    });

    // Two schemes that differ in every token color, so a mode/pref mix-up
    // cannot coincidentally produce the same paint.
    await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      p.setThemeMode("dark");
      p.setEditorThemeIdDark("github-dark");
      p.setEditorThemeIdLight("github-light");
    });

    const name = "theme-probe.py";
    writeFileSync(
      path.join(fixture, name),
      "def greet(name):\n    return f'hi {name}'\n",
    );
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
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            [
              ...document.querySelectorAll(`[data-task-id="${id}"] .cm-content`),
            ].some(
              (e) =>
                (e as HTMLElement).clientWidth > 0 &&
                (e.textContent ?? "").includes("greet") &&
                e.querySelectorAll(".cm-line span[class]").length > 0,
            ),
          taskId,
        ),
      { timeout: 10_000, timeoutMsg: "CodeMirror never highlighted the probe file" },
    );

    darkColors = await tokenColors();
    expect(darkColors.length).toBeGreaterThan(0);
    await snap("editor-theme-dark-mode.png");
  });

  it("switches to the light pref's theme when the app goes light", async () => {
    lightColors = await applyAndSettle(
      () =>
        browser.execute(() =>
          window.__termic!.usePrefs.getState().setThemeMode("light"),
        ),
      darkColors,
    );
    expect(lightColors).not.toBe(darkColors);
    await snap("editor-theme-light-mode.png");
  });

  it("repaints from the LIGHT pref while the app stays light", async () => {
    // Same app mode throughout: only the light pref moves, so this isolates
    // the light select from the mode flip above.
    const next = await applyAndSettle(
      () =>
        browser.execute(() =>
          window.__termic!.usePrefs.getState().setEditorThemeIdLight("xcode-light"),
        ),
      lightColors,
    );
    expect(next).not.toBe(lightColors);
    lightColors = next;
  });

  it("ignores the DARK pref while the app is light", async () => {
    // The regression the split exists to prevent. With one shared pref this
    // repaints the light editor in a dark scheme.
    await browser.execute(() =>
      window.__termic!.usePrefs.getState().setEditorThemeIdDark("aura"),
    );
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => window.__termic!.usePrefs.getState().editorThemeIdDark,
        )) === "aura",
      { timeout: 8_000, timeoutMsg: "editorThemeIdDark never took" },
    );
    // "Nothing happened" cannot be waited for, and reading straight back would
    // pass even if the repaint were merely one tick behind. So run a full
    // round trip on the LIGHT pref (each leg awaited to a real repaint) and
    // only then assert: by the time the second leg lands, the dark write is
    // many render ticks old, and the fingerprint is back to exactly where it
    // was before the dark pref moved.
    const detour = await applyAndSettle(
      () =>
        browser.execute(() =>
          window.__termic!.usePrefs.getState().setEditorThemeIdLight("github-light"),
        ),
      lightColors,
    );
    const stillLight = await applyAndSettle(
      () =>
        browser.execute(() =>
          window.__termic!.usePrefs.getState().setEditorThemeIdLight("xcode-light"),
        ),
      detour,
    );
    expect(stillLight).toBe(lightColors);

    // ...and flipping back to dark now shows the newly-picked dark theme, so
    // the write was not merely ignored everywhere.
    const backToDark = await applyAndSettle(
      () =>
        browser.execute(() =>
          window.__termic!.usePrefs.getState().setThemeMode("dark"),
        ),
      lightColors,
    );
    expect(backToDark).not.toBe(darkColors);
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
  let taskId!: string;
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
  let taskId!: string;
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
      listing.id as string,
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
      listing.id as string,
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
        key: "f", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, bubbles: true, cancelable: true,
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
          new KeyboardEvent("keydown", { key: k, [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, bubbles: true }),
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
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, bubbles: true }));
    });

    // The listing must not have moved.
    expect(((await activeTab()) as any).dirHistoryIndex).toBe(before);

    await browser.execute((id) => {
      window.__termic!.useApp.getState().toggleTerminalSplit(id);
    }, taskId);
  });

  it("does nothing at all when focus is in the right panel", async () => {
    // Cmd+[ means BACK, and nothing else. It used to switch tasks when no
    // listing claimed it, which is why this case exists at all: focus in the
    // file tree is not focus in the listing, so the listing must not walk, and
    // there is no longer anything for the key to fall through TO. Tasks have
    // Opt+Cmd+Up/Down, which also work inside a split; tabs have Shift+Cmd+[.
    const before = ((await activeTab()) as any).dirHistoryIndex as number;
    expect(before).toBeGreaterThan(0); // there IS a trail it could have walked

    // A second task, so "did not switch" is a real assertion rather than a
    // statement about there being nowhere to go.
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
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, bubbles: true }));
    });

    // Give anything that WOULD happen a chance to happen: the task switch was
    // asynchronous, so asserting immediately would pass against the old
    // behaviour too and prove nothing.
    await browser.pause(500);
    expect(
      await browser.execute(() => window.__termic!.useApp.getState().activeTaskId),
    ).toBe(taskId);
    const listing = await browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.type === "dir"),
      taskId,
    );
    expect((listing as any).dirHistoryIndex).toBe(before);

    await archiveTask(second);
    await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), taskId);
  });

  it("stops at the end of the trail instead of switching task", async () => {
    // The old fallback, now removed: every press walks the listing while it
    // has history, and the one after that does nothing. A key that quietly
    // changes what you are looking at once a history runs out is how people
    // lose their place.
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
          new KeyboardEvent("keydown", { key: "[", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, bubbles: true }),
        );
      });

    // Drain the trail. Every press has somewhere to go, and the task must not
    // change on any of them.
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

    // Trail exhausted. One more press changes nothing: same task, same folder.
    await back();
    await browser.pause(500);
    expect(
      await browser.execute(() => window.__termic!.useApp.getState().activeTaskId),
    ).toBe(taskId);
    expect(((await activeTab()) as any).dirHistoryIndex).toBe(0);

    // And Opt+Cmd+Down, which is what switching tasks is FOR, still does.
    await browser.execute(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, altKey: true, bubbles: true,
      }));
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => window.__termic!.useApp.getState().activeTaskId !== id,
          taskId,
        ),
      { timeout: 10_000, timeoutMsg: "Opt+Cmd+Down did not switch task either" },
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
      new KeyboardEvent("keydown", { key: "f", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, bubbles: true, cancelable: true }),
    );
  });

/** Type one character at a time, the way a person does: React sees N input
 *  events, and each re-runs the search. A single value assignment would skip
 *  every intermediate state. */
const typeFind = async (q: string, taskId?: string) => {
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
  // Every prefix runs its own search and paints its own marks, so a wait that
  // only COUNTS marks can be satisfied mid-word: "need" matches the same three
  // places "needle" does, and the reading then belongs to the prefix (this is
  // how the split-view ⌘F case failed on CI, asserting ["needle" x3] against
  // three "need"s). Hand control back only once no mark is still showing a
  // prefix. Zero marks passes on purpose: a query that stops matching is a
  // real case, and the callers that expect marks wait for their count next.
  // Whitespace-insensitive on purpose: markdown-it keeps the source newline of
  // a hard-wrapped paragraph inside the text node, so a mark for a phrase the
  // reader sees on one line reads "wrapped phrase\nspans".
  const norm = (t: string) => t.replace(/\s+/g, " ").toLowerCase();
  await browser.waitUntil(
    async () => (await readFind(taskId)).texts.every(t => norm(t) === norm(q)),
    { timeout: 8_000, timeoutMsg: `find marks never settled on the whole query "${q}"` },
  );
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
  let taskId!: string;
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
  let taskA!: string;
  let taskB!: string;
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
    const termId: string = await browser.execute((id) => {
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
      await typeFind("needle", taskA);
      const p = await waitFind((x) => x.texts.length === 3, "split preview never marked", taskA);
      expect(p.texts).toEqual(["needle", "needle", "needle"]);
      expect(p.parents).toEqual(["P", "P", "P"]);
      await pressInFind("Escape");
      await browser.waitUntil(async () => (await bars()).visible === 0,
        { timeout: 5_000, timeoutMsg: "find bar never closed" });
    });
  });
});

// Roadmap item 8 / GH #174: mark up code in the EDITOR for the agent. The
// surface is the review-comment component the diff pane already uses (GH #28),
// on purpose — the point is to queue several remarks and ship them as one
// instruction, not to fire a reference at the agent per selection. Cases cover
// both entry points (selection tooltip, ⇧⌘L), the queue accumulating across
// lines, and the batch actually landing in the agent's PTY.
describe("comment on an editor selection for the agent", () => {
  let taskId!: string;
  let editTabId: string | undefined;
  let agentTabId: string | undefined;
  const TASK = "e2e-send-ref";

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  /** The queued comments as the user sees them: one card pinned under each
   *  commented range, inside this task's editor.
   *
   *  textContent, not innerText, and presence rather than isDisplayed()
   *  throughout this spec: an occluded window freezes rAF, so CodeMirror never
   *  measures and its tooltip + widgets report a 0x0 box while being perfectly
   *  mounted and clickable. Layout is not what these cases are about. */
  const cards = () =>
    browser.execute((id) =>
      [...document.querySelectorAll(`[data-task-id="${id}"] .cm-editor .tc-comment-card`)]
        .map(el => el.textContent ?? ""),
      taskId!) as Promise<string[]>;

  /** Wait for `selector` to exist (see the note above about visibility). */
  const waitFor = (selector: string, msg: string) =>
    browser.waitUntil(() => browser.execute((s) => !!document.querySelector(s), selector),
      { timeout: 8_000, timeoutMsg: msg });

  const waitForGone = (selector: string, msg: string) =>
    browser.waitUntil(() => browser.execute((s) => !document.querySelector(s), selector),
      { timeout: 8_000, timeoutMsg: msg });

  /** Select whole lines `a`..`b` (1-based) and focus the editor, as a
   *  drag-select would leave it. */
  const selectLines = (a: number, b: number) =>
    browser.execute((id, from, to) => {
      const host = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as HTMLElement | null;
      const view = (host as unknown as { __cmView?: any } | null)?.__cmView;
      if (!view) throw new Error("CodeMirror e2e hook missing (build with make e2e)");
      const doc = view.state.doc;
      view.dispatch({ selection: { anchor: doc.line(from).from, head: doc.line(to).to } });
      // Focus the contentDOM, not view.focus(): the latter does not take in
      // this webview (same trick as the find-vs-editor cases above).
      (host!.querySelector(".cm-content") as HTMLElement).focus();
    }, taskId!, a, b);

  /** Type into the open composer and take one of its two exits. */
  const writeComment = async (body: string, action: "pending" | "send" = "pending") => {
    await waitFor(".tc-comment-textarea", "the comment composer never opened");
    // Every composer in this spec is opened on a selection, and the selection
    // alone is a legitimate message, so the body advertises itself as optional.
    expect(await browser.execute(() =>
      (document.querySelector(".tc-comment-textarea") as HTMLTextAreaElement).placeholder))
      .toBe("Add a comment (optional)");
    await browser.execute((text, sel) => {
      const ta = document.querySelector(".tc-comment-textarea") as HTMLTextAreaElement;
      ta.value = text;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      (document.querySelector(sel) as HTMLElement).click();
    }, body, action === "send" ? ".tc-comment-composer .tc-btn-send"
                               : ".tc-comment-composer .tc-btn-queue");
    await waitForGone(".tc-comment-textarea", "the composer never closed");
  };

  const activeTabId = () =>
    browser.execute((id) => window.__termic!.useApp.getState().activeTab[id], taskId!);

  /** Every agent terminal in the task. A send lands in one of these — which
   *  one is the sender's business (default agent, active tab), not this
   *  spec's, so cases assert membership rather than a captured id. */
  const agentTabIds = () =>
    browser.execute((id) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.__termic!.useApp.getState().tabs[id] ?? []).filter((t: any) => t.type === "terminal")
        .map((t: any) => t.id), taskId!) as Promise<string[]>;

  it("opens a file with a live agent alongside it", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask(TASK);
    // The batch has to land in a REAL agent PTY, so wait for the fixture agent
    // to come up rather than for a ptyId to merely exist.
    await waitForAgentReady(taskId);
    agentTabId = await activeTabId();

    editTabId = await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      app.openPreviewTab(id, { type: "edit", path: "README.md", title: "README.md" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = app.tabs[id].find((t: any) => t.type === "edit" && t.path === "README.md");
      app.persistTab(id, tab.id);
      app.setActiveTabId(id, tab.id);
      return tab.id as string;
    }, taskId);

    await browser.waitUntil(
      () => browser.execute((id) =>
        !!document.querySelector(`[data-task-id="${id}"] .cm-content`), taskId),
      { timeout: 10_000, timeoutMsg: "the editor never mounted" },
    );
    expect(await cards()).toEqual([]);
  });

  it("offers one quiet gutter icon on a selection, never the diff pill", async () => {
    expect(await browser.execute(() => !!document.querySelector(".tc-line-add-btn"))).toBe(false);

    await selectLines(1, 1);
    await waitFor(".tc-line-add-btn", "the gutter comment icon never appeared for a selection");
    // The editor is a reading/typing surface: no labelled pill following the
    // selection, and no hover button chasing the mouse down the gutter (that
    // pair stays on the diff, where reviewing IS the job).
    expect(await browser.execute(() => !!document.querySelector(".tc-add-comment-btn"))).toBe(false);
    // Same control the diff pane puts on a line — identical class, so
    // identical accent styling. Only the target and the wording differ.
    // No `title`: the browser's tooltip waits about a second, by which point
    // the selection this button belongs to is often gone. It carries its own,
    // shown on hover with no delay.
    expect(await browser.execute(() =>
      [...document.querySelectorAll(".tc-line-add-btn")].map(b => ({
        title: b.getAttribute("title"), label: b.getAttribute("aria-label"), cls: b.className,
      })))).toEqual([{ title: null, label: "Send selection to agent", cls: "tc-line-add-btn" }]);

    expect(await browser.execute(() => {
      const btn = document.querySelector(".tc-line-add-btn")!;
      btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      const shown = document.querySelector(".tc-instant-tip")?.textContent ?? null;
      btn.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
      return { shown, after: !!document.querySelector(".tc-instant-tip") };
    })).toEqual({ shown: "Send selection to agent", after: false });

    // The icon floats over the line numbers rather than opening a column, so
    // the code does not jump sideways the moment you select something.
    expect(await browser.execute((id) => {
      const host = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as HTMLElement;
      // Computed style, not a measured box: an occluded window reports 0x0 for
      // everything, which would pass this vacuously.
      return getComputedStyle(host.querySelector(".tc-comment-gutter")!).width;
    }, taskId!)).toBe("0px");
  });

  it("retracts the icon when the selection goes away", async () => {
    await browser.execute((id) => {
      const host = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as HTMLElement;
      (host as unknown as { __cmView: any }).__cmView.dispatch({ selection: { anchor: 0 } });
    }, taskId!);
    await waitForGone(".tc-line-add-btn", "the gutter icon outlived the selection");
  });

  it("queues the comment instead of sending it", async () => {
    await selectLines(1, 1);
    await waitFor(".tc-line-add-btn", "the gutter comment icon never appeared");
    await browser.execute(() => {
      // The button commits on mousedown so the editor can't clear the
      // selection first; .click() alone does nothing.
      document.querySelector(".tc-line-add-btn")!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await writeComment("rename this heading");

    const queued = await cards();
    expect(queued.length).toBe(1);
    expect(queued[0]).toContain("rename this heading");
    // Nothing was sent, and the editor keeps the stage: queueing must not
    // yank the user to the terminal.
    expect(await activeTabId()).toBe(editTabId);
  });

  it("queues a selection with nothing written about it", async () => {
    // The selection is the message. Requiring a body meant you had to invent
    // something to say before "look at this" could be queued at all.
    await selectLines(1, 2);
    await waitFor(".tc-line-add-btn", "the gutter comment icon never appeared");
    await browser.execute(() => {
      document.querySelector(".tc-line-add-btn")!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await waitFor(".tc-comment-composer .tc-btn-queue", "the composer never opened");
    // The code being sent is shown in the composer, so what lands in the agent
    // is on screen before you commit to it.
    expect(await browser.execute(() =>
      !!document.querySelector(".tc-comment-quote")?.textContent)).toBe(true);
    await browser.execute(() => {
      (document.querySelector(".tc-comment-composer .tc-btn-queue") as HTMLElement).click();
    });
    await waitForGone(".tc-comment-textarea", "an empty comment was refused instead of queued");

    expect((await cards()).join("\n")).toContain("Selection only");

    // Put the queue back to one card so the batch cases below stay readable.
    await browser.execute((id) => {
      const card = [...document.querySelectorAll(`[data-task-id="${id}"] .cm-editor .tc-comment-card`)]
        .find(el => (el.textContent ?? "").includes("Selection only"))!;
      (card.querySelector(".tc-icon-btn-danger") as HTMLElement).click();
    }, taskId!);
    await browser.waitUntil(async () => (await cards()).length === 1,
      { timeout: 8_000, timeoutMsg: "the bodyless comment was never removed" });
  });

  it("sends one comment straight out, without queueing it", async () => {
    const before = (await cards()).length;
    await selectLines(1, 1);
    await waitFor(".tc-line-add-btn", "the gutter comment icon never appeared");
    await browser.execute(() => {
      document.querySelector(".tc-line-add-btn")!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    // Both exits are offered, the accent one being Send.
    await waitFor(".tc-comment-composer .tc-btn-send", "the composer has no Send button");
    expect(await browser.execute(() => ({
      send: document.querySelector(".tc-comment-composer .tc-btn-send")!.textContent,
      queue: document.querySelector(".tc-comment-composer .tc-btn-queue")!.textContent,
      icon: !!document.querySelector(".tc-comment-composer .tc-btn-send svg"),
    }))).toEqual({ send: "Send", queue: "Add to pending", icon: true });

    await writeComment("explain this heading", "send");

    // Sending hands the stage to the agent, the way the pending bar does.
    await browser.waitUntil(
      async () => (await agentTabIds()).includes((await activeTabId()) as string),
      { timeout: 8_000, timeoutMsg: "sending never switched to the agent" },
    );

    // It reached the agent with the CODE, not just a line reference...
    await browser.waitUntil(
      async () => {
        const logs = await cliRpc({ cmd: "logs", task: TASK });
        return logs.ok && logs.data.data.includes("explain this heading")
          && logs.data.data.includes("# e2e fixture");
      },
      { timeout: 30_000, timeoutMsg: "the instant send never reached the agent's PTY" },
    );
    // ...and it never joined the queue.
    expect((await cards()).length).toBe(before);

    // The cases below carry on in the editor.
    await browser.execute((id, tab) =>
      window.__termic!.useApp.getState().setActiveTabId(id, tab), taskId!, editTabId);
  });

  it("stacks a second comment from the keyboard route", async () => {
    await selectLines(1, 2);
    await browser.execute(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "l", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, shiftKey: true, bubbles: true,
      }));
    });
    await writeComment("and mention the fixture");

    // Both are held — the whole point of the queue.
    const queued = await cards();
    expect(queued.length).toBe(2);
    expect(queued.join("\n")).toContain("and mention the fixture");
    expect(queued.join("\n")).toContain("rename this heading");
  });

  it("ignores the shortcut when nothing is selected", async () => {
    await browser.execute((id) => {
      const host = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as HTMLElement;
      (host as unknown as { __cmView: any }).__cmView.dispatch({ selection: { anchor: 0 } });
      (host.querySelector(".cm-content") as HTMLElement).focus();
    }, taskId!);
    await browser.execute(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "l", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, shiftKey: true, bubbles: true,
      }));
    });
    expect(await browser.execute(() => !!document.querySelector(".tc-comment-textarea"))).toBe(false);
    expect((await cards()).length).toBe(2);
  });

  it("keeps queued comments on their code when lines are inserted above", async () => {
    // Two lines at the very top. The comments were made on line 1 and lines
    // 1-2, so their code is now on 3 and 3-4 — the stored line numbers have to
    // follow it, or the batch points the agent at the wrong place.
    await browser.execute((id) => {
      const host = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as HTMLElement;
      (host as unknown as { __cmView: any }).__cmView.dispatch({
        changes: { from: 0, insert: "inserted A\ninserted B\n" },
      });
    }, taskId!);

    // The cards label themselves from the STORED range, so this also proves
    // the mapped anchors made it back to the store (debounced, hence waitUntil).
    await browser.waitUntil(
      async () => {
        const text = (await cards()).join("\n");
        return text.includes("line 3") && text.includes("lines 3");
      },
      { timeout: 8_000, timeoutMsg: "the queued comments never followed their code" },
    );
  });

  it("sends the whole batch to the agent in one message", async () => {
    // The pending-comments bar lives on the terminal footer strip, so switch
    // to the agent the way a user would before sending.
    await browser.execute((id, tab) =>
      window.__termic!.useApp.getState().setActiveTabId(id, tab), taskId!, agentTabId);
    // The pill carries the count; opening it reveals the batch + Send.
    await waitFor('[data-testid="review-comments-pill"]', "the pending-comments pill never appeared");
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="review-comments-pill"]')!.textContent))
      .toContain("2 pending comments");
    // Open and send in ONE step that retries the open. Activating the agent
    // tab queues a terminal focus on the next frame (TerminalPane's "refit +
    // focus" effect), and a Radix popover dismisses when focus leaves it. So
    // when that frame lands after the click, the popover opens and is closed
    // again before Send can be found: "the Send button never appeared",
    // roughly one run in three, on a popover that opens fine by hand (nobody
    // clicks within a frame of switching tabs). Confirmed by doing it on
    // purpose: focusing the terminal's textarea with the popover open flips
    // the pill back to data-state="closed".
    //
    // The focus happens once per activation, so re-opening a closed pill is
    // enough. Send is clicked in the same script that finds it, or the same
    // focus could close the popover between the two round trips.
    await browser.waitUntil(
      () => browser.execute(() => {
        const send = document.querySelector('[data-testid="review-comments-send"]') as HTMLElement | null;
        if (send) { send.click(); return true; }
        const pill = document.querySelector('[data-testid="review-comments-pill"]') as HTMLElement | null;
        if (pill?.getAttribute("data-state") === "closed") pill.click();
        return false;
      }),
      { timeout: 8_000, timeoutMsg: "the Send button never appeared" },
    );

    // One message carrying BOTH comments, read from the agent's own PTY ring
    // (xterm renders to a canvas, so this is the only place the bytes show).
    await browser.waitUntil(
      async () => {
        const logs = await cliRpc({ cmd: "logs", task: TASK });
        if (!logs.ok) return false;
        const out = logs.data.data as string;
        // Both bodies, both SHIFTED line attributions (the comments were made
        // on 1 and 1-2 before two lines were inserted above them), one message.
        return out.includes("rename this heading") && out.includes("and mention the fixture")
          && out.includes("README.md:3") && out.includes("README.md:3-4");
      },
      { timeout: 30_000, timeoutMsg: "the batch never reached the agent's PTY" },
    );
    // Nothing here is a review: these comments were made on a file the user
    // was reading, not on the agent's diff. Telling the agent "I reviewed your
    // changes" would credit it with code it may never have written.
    const log = await cliRpc({ cmd: "logs", task: TASK });
    expect(log.data.data as string).not.toContain("I reviewed your changes");
    // Sent means drained: the cards and the pill are gone.
    await browser.waitUntil(async () => (await cards()).length === 0,
      { timeout: 8_000, timeoutMsg: "the queue was never cleared after sending" });
    expect(await browser.execute(() =>
      !!document.querySelector('[data-testid="review-comments-pill"]'))).toBe(false);
    await snap("editor-selection-comments.png");
  });
});

// Cursor-line inline git blame (VS Code's `git.blame.editorDecoration`).
//
// The three regressions worth catching are all "shows the WRONG thing" rather
// than "crashes": annotating every line (a performance regression, see
// inlineBlameExt.ts on height-relevant decorations), keeping an author on a
// line the user just edited, and the pref/palette toggle not reaching the live
// view. The unit spec (src/components/task/inlineBlameExt.test.ts) covers the
// line-mapping algebra against a fake payload; this one runs REAL `git blame`.
//
// It blames the seeded README, which is committed as "init fixture" by `e2e`,
// and it MUTATES NOTHING. Committing a nicer multi-line fixture was the obvious
// alternative and is a trap twice over: the spec then fails its own second run
// with "nothing to commit", and one extra commit in the shared fixture history
// is enough to break `git.e2e.ts`'s first-parent case (verified, not guessed).
// The README is a single line, so the cursor is armed by COLUMN rather than by
// moving to another line, which is the same code path.
// Indentation is read off the file, not assumed: the editor hard-coded two
// spaces for everything, which is wrong for most of what an agent writes.
describe("indentation, detected per file", () => {
  let taskId!: string;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-indent");
  });

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  /** Open a file we wrote into the task, and read back what CodeMirror
   *  decided one level of indentation is. */
  const indentOf = async (name: string, body: string) => {
    const root = await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.path as string,
      taskId,
    ) as string;
    writeFileSync(path.join(root, name), body);
    await browser.execute((id, p) => {
      window.__termic!.useApp.getState().openPreviewTab(id, { type: "edit", path: p, title: p });
    }, taskId, name);
    await waitVisible(`[data-task-id="${taskId}"] .cm-editor`);
    return await browser.waitUntil(async () => {
      const got = await browser.execute((id) => {
        const dom = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as
          (HTMLElement & { __cmView?: any }) | null;
        const view = dom?.__cmView;
        if (!view) return null;
        // The two halves CodeMirror keeps separately: what Tab inserts, and
        // how wide an existing tab renders.
        return { unit: view.state.facet(window.__termic!.cm.indentUnit), tab: view.state.tabSize };
      }, taskId) as { unit: string; tab: number } | null;
      return got && got.unit !== undefined ? got : false;
    }, { timeout: 10_000, timeoutMsg: `${name} never reported its indentation` }) as
      { unit: string; tab: number };
  };

  it("reads four spaces off a Python file", async () => {
    const py = "def sync(x: int) -> None:\n    if x:\n        print(x)\n    return None\n";
    const got = await indentOf("indent_demo.py", py);
    expect(got.unit).toBe("    ");
    expect(got.tab).toBe(4);
  });

  it("reads tabs off a Go file, where they are the format", async () => {
    const go = "package main\n\nfunc main() {\n\tif true {\n\t\tprintln(1)\n\t}\n}\n";
    const got = await indentOf("indent_demo.go", go);
    expect(got.unit).toBe("\t");
  });

  it("keeps two spaces for a file that uses them", async () => {
    const ts = "export function f(x: number) {\n  if (x) {\n    return x;\n  }\n  return 0;\n}\n";
    const got = await indentOf("indent_demo.ts", ts);
    expect(got.unit).toBe("  ");
    expect(got.tab).toBe(2);
  });
});

describe("inline git blame", () => {
  let taskId!: string;

  let gitViewBefore: string | null | undefined;

  // The fixture README: "# e2e fixture", committed by scripts/e2e-seed.mjs.
  const AUTHOR = "e2e";
  const SUBJECT = "init fixture";

  after(async () => {
    // The window is REUSED across spec files, and RightPanel's tab is component
    // state, so "Show in History" leaves the panel parked on Git for every
    // later spec. files.e2e.ts waits on file-tree rows and hung for 15s×12 on
    // a panel that was showing the commit graph. Put the tab back by clicking
    // it, the same way a user would.
    await browser.execute(() => {
      const tab = Array.from(document.querySelectorAll("button"))
        .find(b => b.textContent?.trim() === "All files");
      (tab as HTMLElement | undefined)?.click();
    });
    // "Show in History" switches the Git panel's sub-view and that choice is
    // PERSISTED (`gitPanelView` in localStorage), which outlives both the app
    // instance and the .e2e fixture. Put it back, or every later spec file runs
    // with the Git tab parked on the Graph.
    await browser.execute((v) => {
      if (v === null) localStorage.removeItem("gitPanelView");
      else localStorage.setItem("gitPanelView", v);
    }, gitViewBefore ?? null);
    // Back to the app DEFAULT (off), not to whatever this machine happened to
    // have. Prefs live in localStorage, which outlives the .e2e fixture and is
    // shared with every later spec file, so "restore what I found" quietly
    // leaves blame enabled for the rest of the suite on any machine where it was
    // already on. Later specs then run with an extra `git blame` per opened
    // file, which is not the app they mean to test.
    await browser.execute(() =>
      window.__termic!.usePrefs.getState().setInlineBlame(false),
    );
    // And close what the cases here opened. "toggles from the command palette"
    // clicks a command and the palette stays up, which is a dialog left on
    // screen for every later spec file in a REUSED window. files.e2e's file
    // finder then had two other dialogs above its own in the document, and its
    // top-result assertion was reading one of them.
    await dismissOverlays();
    if (taskId) await archiveTask(taskId);
  });

  /** The blame annotations VISIBLE in the active task's editor.
   *
   *  Visibility is part of the assertion, not a detail: a .md tab defaults to
   *  the markdown Preview, whose editor stays mounted behind it, and an earlier
   *  version of this spec passed entirely against that hidden editor. A rect
   *  check is what makes it about what the reader sees. */
  const annotations = () =>
    browser.execute((id) =>
      Array.from(
        document.querySelectorAll(
          `[data-task-id="${id}"] .cm-editor .cm-inline-blame`,
        ),
      )
        .filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((el) => el.textContent ?? ""),
      taskId,
    );

  /** Put the cursor at a document offset through CodeMirror's own API (the
   *  `__cmView` handle the e2e build exposes), for the same reason the save
   *  spec does: synthetic key events don't route to a contenteditable
   *  reliably in WKWebView. The annotation is still asserted from the DOM.
   *
   *  Offset, not line: blame is deliberately not fetched while the cursor is
   *  still at position 0 (a file nobody has looked at), and the fixture README
   *  has only one real line to be on. */
  const cursorTo = (offset: number) =>
    browser.execute((id, n) => {
      const dom = document.querySelector(
        `[data-task-id="${id}"] .cm-editor`,
      ) as (HTMLElement & { __cmView?: any }) | null;
      const view = dom?.__cmView;
      if (!view) throw new Error("no CodeMirror view on the active task");
      view.dispatch({ selection: { anchor: n } });
    }, taskId, offset);

  const waitForOneAnnotation = async (msg: string) => {
    await browser.waitUntil(async () => (await annotations()).length === 1, {
      timeout: 10_000,
      timeoutMsg: msg,
    });
    return (await annotations())[0];
  };

  it("annotates the cursor's line with the commit that last touched it", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-blame");
    await browser.execute(() =>
      window.__termic!.usePrefs.getState().setInlineBlame(true),
    );
    gitViewBefore = await browser.execute(() => localStorage.getItem("gitPanelView"));

    const sel = '[data-path="README.md"]';
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), sel),
      { timeout: 15_000, timeoutMsg: "README row never appeared" },
    );
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, sel);
    // Every visited task stays mounted, so both of these are scoped to THIS
    // task: an unscoped `.cm-content` can match a hidden earlier task's editor,
    // which is 0x0 and never becomes visible.
    await browser.waitUntil(
      () =>
        browser.execute((id) =>
          (
            document.querySelector(`[data-task-id="${id}"] .cm-content`)
              ?.textContent ?? ""
          ).includes("e2e fixture"),
          taskId,
        ),
      { timeout: 10_000, timeoutMsg: "CodeMirror never loaded README" },
    );

    // A .md tab can come up in the markdown Preview (the pref, or whatever an
    // earlier case left behind), which leaves the editor mounted but hidden.
    // Blame annotates the editor, so put the editor on screen.
    await browser.execute((id) => {
      const scope = document.querySelector(`[data-task-id="${id}"]`) ?? document;
      const btn = Array.from(scope.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Editor",
      );
      if (!btn) throw new Error("Editor toggle not found");
      (btn as HTMLElement).click();
    }, taskId);
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const el = document.querySelector(
            `[data-task-id="${id}"] .cm-content`,
          ) as HTMLElement | null;
          return !!el && el.getBoundingClientRect().height > 0;
        }, taskId),
      { timeout: 8_000, timeoutMsg: "the source editor never became visible" },
    );

    // Nothing yet: blame is deliberately not fetched until the cursor leaves
    // the start of the document, so opening a file never waits on git.
    expect(await annotations()).toEqual([]);

    await cursorTo(3);
    const text = await waitForOneAnnotation(
      "no blame annotation on the cursor line",
    );
    // Real git output: the fixture's first commit, by its seeded author.
    expect(text).toContain(AUTHOR);
    expect(text).toContain(SUBJECT);
    await snap("inline-blame.png");
  });

  it("annotates one line at a time", async () => {
    await cursorTo(5);
    await browser.waitUntil(
      async () => {
        const a = await annotations();
        return a.length === 1 && a[0].includes(SUBJECT);
      },
      { timeout: 8_000, timeoutMsg: "annotation did not follow the cursor" },
    );
    // Exactly one: a blame column on every line is the shape this feature
    // deliberately does not have. The phantom line a trailing newline creates
    // must not carry one either (it belongs to no commit and never will).
    expect((await annotations()).length).toBe(1);
  });

  it("leaves a blank line alone", async () => {
    // The widget is anchored at `line.to`, which on an empty line is column 0:
    // it lands where the code would start and reads as broken indentation,
    // sharing its spot with the caret. There is also nothing to attribute.
    await cursorTo(3);
    await waitForOneAnnotation("no annotation to start from");
    const blankAt = await browser.execute((id) => {
      const dom = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as
        (HTMLElement & { __cmView?: any }) | null;
      const view = dom!.__cmView;
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: "\n\n" }, selection: { anchor: end + 1 } });
      return view.state.selection.main.head as number;
    }, taskId) as number;
    expect(blankAt).toBeGreaterThan(0);
    await browser.waitUntil(async () => (await annotations()).length === 0, {
      timeout: 8_000,
      timeoutMsg: "a blank line was annotated",
    });
  });

  it("gets out of the way while typing, and returns at the end of the line", async () => {
    // Two things this pins. It HIDES on a change, because an annotation that
    // shuffles along beside the caret on every keystroke is what people mean
    // by intrusive. And when it returns it is anchored past the text: a plugin
    // owns its decorations, so nothing maps them through an edit for us, and
    // unmapped the widget kept its pre-edit offset and rendered inside the
    // word being typed ("StorePag" + the annotation + "e").
    await cursorTo(3);
    await waitForOneAnnotation("no annotation to start from");

    // Type somewhere ELSE, so the annotated line stays committed and keeps its
    // author. Editing the annotated line is the case below.
    await browser.execute((id) => {
      const dom = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as
        (HTMLElement & { __cmView?: any }) | null;
      const view = dom!.__cmView;
      view.dispatch({ changes: { from: view.state.doc.length, insert: "trailing" } });
    }, taskId);
    await browser.waitUntil(async () => (await annotations()).length === 0, {
      timeout: 4_000,
      timeoutMsg: "the annotation stayed up while the document was changing",
    });
    await browser.waitUntil(async () => (await annotations()).length === 1, {
      timeout: 8_000,
      timeoutMsg: "the annotation never came back after typing stopped",
    });

    // Measured in the DOM: "renders in the wrong place" is exactly the class
    // of bug a state assertion cannot see.
    const placed = await browser.execute((id) => {
      const editor = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as HTMLElement;
      const widget = editor.querySelector(".cm-inline-blame") as HTMLElement | null;
      if (!widget) return { ok: false, why: "no annotation" };
      const line = widget.closest(".cm-line") as HTMLElement | null;
      if (!line) return { ok: false, why: "annotation outside a line" };
      const wLeft = widget.getBoundingClientRect().left;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let worst = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (widget.contains(n)) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        worst = Math.max(worst, range.getBoundingClientRect().right);
      }
      return { ok: worst <= wLeft + 1, why: `text ends at ${worst}, widget starts at ${wLeft}` };
    }, taskId) as { ok: boolean; why: string };
    if (!placed.ok) throw new Error(`the annotation is not at the end of the line: ${placed.why}`);
  });

  it("stops attributing a line once it is edited, and says nothing instead", async () => {
    // Two rules at once. An edited line must never keep its old author, which
    // would be a confident lie. And what replaces it is NOTHING: "Not
    // committed yet" beside your own caret, on a line you just wrote, is the
    // noise that made this feature feel intrusive.
    await cursorTo(3);
    await waitForOneAnnotation("no annotation before the edit");

    await browser.execute((id) => {
      const dom = document.querySelector(
        `[data-task-id="${id}"] .cm-editor`,
      ) as (HTMLElement & { __cmView?: any }) | null;
      dom!.__cmView.dispatch({ changes: { from: 2, insert: "edited " } });
    }, taskId);

    await browser.waitUntil(async () => (await annotations()).length === 0, {
      timeout: 8_000,
      timeoutMsg: "an edited line kept an annotation",
    });
  });

  it("disappears when the pref is off and comes back when it is on", async () => {
    await browser.execute(() =>
      window.__termic!.usePrefs.getState().setInlineBlame(false),
    );
    await browser.waitUntil(async () => (await annotations()).length === 0, {
      timeout: 8_000,
      timeoutMsg: "annotation survived turning the pref off",
    });

    // Back on with the cursor already parked on a line: the annotation must
    // appear without waiting for the next keystroke.
    await browser.execute(() =>
      window.__termic!.usePrefs.getState().setInlineBlame(true),
    );
    await waitForOneAnnotation(
      "annotation did not return when the pref went back on",
    );
  });

  it("opens a hover card with the commit, and its two actions work", async () => {
    await cursorTo(3);
    await waitForOneAnnotation("no annotation to hover");

    // Rest the pointer on the annotation. WebDriver's own hover is unreliable
    // over a contenteditable, so the pointer events go in directly; the DELAY
    // is the extension's own timer, which is what this waits out.
    await browser.execute((id) => {
      const el = document.querySelector(
        `[data-task-id="${id}"] .cm-editor .cm-inline-blame`,
      ) as HTMLElement;
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    }, taskId);

    const cardText = () =>
      browser.execute(() => {
        const el = document.querySelector(".cm-blame-card") as HTMLElement | null;
        return el ? el.innerText : "";
      });
    await browser.waitUntil(async () => (await cardText()).includes(SUBJECT), {
      timeout: 8_000,
      timeoutMsg: "the hover card never appeared with the commit",
    });
    const text = await cardText();
    expect(text).toContain(AUTHOR);
    expect(text).toContain("ago");
    await snap("inline-blame-card.png");

    // "Show in History" must reach the right panel: Git tab, Graph view, that
    // commit selected. This is the cross-panel wiring, so assert the outcome in
    // the panel rather than the store request that asks for it.
    await browser.execute(() => {
      const btn = Array.from(
        document.querySelectorAll(".cm-blame-card button"),
      ).find((b) => (b as HTMLElement).innerText.includes("Show in History"));
      (btn as HTMLElement).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    // The Graph is on screen AND the BLAMED commit is the expanded row. Scoped
    // to the row that actually carries the expanded detail, not to the first row
    // in the list: the two are only the same commit by luck, and asserting on
    // row one would pass while the reveal half did nothing.
    await browser.waitUntil(
      () =>
        browser.execute((subject) => {
          const panel = document.querySelector('[data-testid="history-panel"]');
          if (!panel) return false;
          const expanded = Array.from(
            panel.querySelectorAll('[data-testid="history-commit"][data-sha]'),
          ).filter(r => r.querySelector('[data-testid="history-commit-detail"]'));
          if (expanded.length !== 1) return false;
          return (expanded[0] as HTMLElement).innerText.includes(subject);
        }, SUBJECT),
      { timeout: 10_000, timeoutMsg: "Show in History did not expand the blamed commit in the Graph" },
    );

    // "Open diff" opens the commit-scoped diff tab for this file.
    await cursorTo(3);
    await waitForOneAnnotation("annotation gone after the History jump");
    await browser.execute((id) => {
      const el = document.querySelector(
        `[data-task-id="${id}"] .cm-editor .cm-inline-blame`,
      ) as HTMLElement;
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    }, taskId);
    await browser.waitUntil(async () => (await cardText()).includes(SUBJECT), {
      timeout: 8_000, timeoutMsg: "the card did not reopen",
    });
    await browser.execute(() => {
      const btn = Array.from(
        document.querySelectorAll(".cm-blame-card button"),
      ).find((b) => (b as HTMLElement).innerText.includes("Open diff"));
      (btn as HTMLElement).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    // A real tab, not the preview slot: the README tab the annotation was
    // hovered in has to survive, or the button closes the file to show its
    // history.
    await browser.waitUntil(
      async () =>
        !!(await browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) =>
                t.type === "diff" && String(t.scope ?? "").startsWith("commit:") && !t.preview,
            ),
          taskId,
        )),
      { timeout: 10_000, timeoutMsg: "Open diff did not open a commit-scoped diff tab" },
    );
    // Open diff must not recycle the preview tab and close the file being read.
    const readmeStillOpen = await browser.execute(
      (id) =>
        (window.__termic!.useApp.getState().tabs[id] ?? []).some(
          (t: any) => t.type === "edit" && t.path === "README.md",
        ),
      taskId,
    );
    expect(readmeStillOpen).toBe(true);
  });

  it("does not react to a click on the annotation", async () => {
    const before = await browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length,
      taskId,
    );
    await browser.execute((id) => {
      const el = document.querySelector(
        `[data-task-id="${id}"] .cm-editor .cm-inline-blame`,
      ) as HTMLElement | null;
      el?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, taskId);
    const after = await browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length,
      taskId,
    );
    expect(after).toBe(before);
  });

  it("toggles from the command palette", async () => {
    const before = await browser.execute(
      () => window.__termic!.usePrefs.getState().inlineBlame,
    );
    await browser.execute(() =>
      window.__termic!.useUI.getState().openCommandPalette(),
    );
    const rowSel = '[data-cmd-id="toggle-inline-blame"]';
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), rowSel),
      { timeout: 8_000, timeoutMsg: "the palette never offered the blame toggle" },
    );
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, rowSel);

    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => window.__termic!.usePrefs.getState().inlineBlame,
        )) !== before,
      { timeout: 8_000, timeoutMsg: "the palette command did not flip the pref" },
    );
    // Drop the Recent entry this click just recorded: recents live in
    // localStorage, which is shared with every other spec file, and app.e2e.ts
    // asserts on that list. The pref itself is reset in `after`.
    await browser.execute(() => {
      const raw = localStorage.getItem("commandPaletteRecent");
      if (!raw) return;
      try {
        const kept = (JSON.parse(raw) as { id: string }[]).filter(
          (r) => r.id !== "toggle-inline-blame",
        );
        localStorage.setItem("commandPaletteRecent", JSON.stringify(kept));
      } catch {
        localStorage.removeItem("commandPaletteRecent");
      }
    });
  });
});

// GH #247: an SVG used to open as a read-only picture, so changing one meant
// opening it somewhere else and losing the preview. It now gets the same
// source / preview / split shell markdown has (SourcePreviewShell), with the
// preview fed by the editor's LIVE buffer rather than the file on disk.
describe("svg source/preview toggle", () => {
  let taskId!: string;
  let tabId!: string;
  const SVG = "e2e-icon.svg";
  // Deliberately carries a `#hex` fill and a non-Latin1 label: both are
  // ordinary in an SVG and both break a naive data URL (see svgDataUrl).
  const SVG_SRC =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + '<rect width="32" height="32" fill="#2f81f7"/><text y="20">café</text></svg>';

  /** The shell's current mode, read off the visible pane of THIS task. Every
   *  visited task stays mounted, so an unscoped query can match a hidden copy. */
  const mode = () => browser.execute((id) => {
    const root = document.querySelector(`[data-task-id="${id}"]`);
    const el = Array.from(root?.querySelectorAll("[data-testid='source-preview-shell']") ?? [])
      .find((n) => n.getBoundingClientRect().width > 0);
    return el?.getAttribute("data-view") ?? null;
  }, taskId);

  /** `src` of the rendered picture, or null when it isn't on screen. */
  const previewSrc = () => browser.execute((id) => {
    const root = document.querySelector(`[data-task-id="${id}"]`);
    const img = Array.from(root?.querySelectorAll("[data-testid='svg-preview']") ?? [])
      .find((n) => n.getBoundingClientRect().width > 0) as HTMLImageElement | undefined;
    return img?.src ?? null;
  }, taskId);

  /** Is the CodeMirror source pane laid out? */
  const editorShown = () => browser.execute((id) => {
    const root = document.querySelector(`[data-task-id="${id}"]`);
    return Array.from(root?.querySelectorAll(".cm-editor") ?? [])
      .some((n) => n.getBoundingClientRect().width > 0);
  }, taskId);

  const clickMode = (m: string) => browser.execute((id, want) => {
    const root = document.querySelector(`[data-task-id="${id}"]`);
    const btn = Array.from(root?.querySelectorAll(`[data-view-btn="${want}"]`) ?? [])
      .find((n) => n.getBoundingClientRect().width > 0) as HTMLElement | undefined;
    btn?.click();
  }, taskId, m);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    writeFileSync(path.join(fixture, SVG), SVG_SRC);
    taskId = await openTask("e2e-svg");
    tabId = await browser.execute((id, p) => {
      const app = window.__termic!.useApp.getState();
      app.openPreviewTab(id, { type: "edit", path: p, title: p });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = app.tabs[id].find((t: any) => t.type === "edit" && t.path === p);
      app.persistTab(id, tab.id);
      return tab.id;
    }, taskId, SVG);
  });

  after(async () => {
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch {
      /* nothing */
    }
  });

  it("opens showing the rendered picture, not the source", async () => {
    // The default stays "preview" so clicking an .svg in the file tree still
    // shows the image, which is what it has always done.
    await browser.waitUntil(async () => (await previewSrc())?.startsWith("data:image/svg+xml") === true,
      { timeout: 15_000, timeoutMsg: "the svg preview never rendered" });
    expect(await mode()).toBe("preview");
    expect(await editorShown()).toBe(false);
  });

  it("switches to the editable source", async () => {
    await clickMode("source");
    await browser.waitUntil(async () => await editorShown(),
      { timeout: 10_000, timeoutMsg: "the source pane never appeared" });
    expect(await mode()).toBe("source");
    // It is the real file, not a placeholder.
    const text = await browser.execute((id) => {
      const root = document.querySelector(`[data-task-id="${id}"]`);
      const cm = Array.from(root?.querySelectorAll(".cm-content") ?? [])
        .find((n) => n.getBoundingClientRect().width > 0) as HTMLElement | undefined;
      return cm?.textContent ?? "";
    }, taskId);
    expect(text).toContain("viewBox");
  });

  it("shows both panes in split", async () => {
    await clickMode("split");
    await browser.waitUntil(
      async () => await editorShown() && (await previewSrc()) !== null,
      { timeout: 10_000, timeoutMsg: "split never showed both panes" },
    );
    expect(await mode()).toBe("split");
  });

  it("re-renders the picture from unsaved edits", async () => {
    // The payoff of feeding the preview from the buffer instead of disk: this
    // never touches taskFileWrite, so a disk-backed preview could not move.
    const before = await previewSrc();
    await browser.execute((id, t) => {
      window.__termic!.useApp.getState().setActiveTabId(id, t);
    }, taskId, tabId);
    // Through CodeMirror's own view API, the same hook the save spec uses. A
    // synthetic beforeinput does NOT produce a transaction here (see the
    // "keyboard into CodeMirror" caveat in docs/e2e-coverage.md), and without
    // a transaction there is no onContent and nothing to assert.
    await browser.execute((id) => {
      const root = document.querySelector(`[data-task-id="${id}"]`)!;
      const el = Array.from(root.querySelectorAll(".cm-editor"))
        .find((n) => n.getBoundingClientRect().width > 0) as unknown as { __cmView?: any };
      const view = el?.__cmView;
      if (!view) throw new Error("CodeMirror e2e hook missing (build with make e2e)");
      view.dispatch({ changes: { from: view.state.doc.length, insert: "<!-- edited -->" } });
    }, taskId);
    await browser.waitUntil(async () => {
      const now = await previewSrc();
      return !!now && now !== before && decodeURIComponent(now).includes("edited");
    }, { timeout: 10_000, timeoutMsg: "the preview never picked up the unsaved edit" });
    // Nothing was saved: the picture moved off the buffer alone.
    expect(await browser.execute((id, p) => window.__termic!.ipc.taskFileRead(id, p), taskId, SVG))
      .not.toContain("edited");
  });

  it("goes back to the picture, and remembers the last mode for the next svg", async () => {
    await clickMode("preview");
    await browser.waitUntil(async () => await mode() === "preview" && !(await editorShown()),
      { timeout: 10_000, timeoutMsg: "never returned to the preview" });
    // Toggling writes the global default too, so the next .svg opens the same
    // way (same contract as markdownDefaultView).
    expect(await browser.execute(() => localStorage.getItem("svgDefaultView"))).toBe("preview");
  });
});

// An agent's report is usually one self-contained .html file. It gets the
// same source / preview / split shell as markdown and SVG, rendered in an
// `<iframe sandbox="" srcdoc>`. That frame is the security boundary (an
// untrusted document must never run script in the app's origin, which can
// call every Tauri command), so these cases pin it from the only side a test
// can see, the parent. The frame's origin is opaque, so neither the app nor
// WebDriver (whose frame switching goes through contentDocument) can look
// inside it: that is the property, not a gap in the spec. What renders inside
// was measured with a standalone WKWebView probe; see docs/sandbox.md
// ("HTML preview").
describe("html preview", () => {
  let taskId!: string;
  let tabId!: string;
  let remoteImagesBefore = false;
  const HTML = "e2e-report.html";
  // The remote image sits in a rule that matches nothing, so the banner has a
  // reference to report and the webview never fetches it, blocked or not.
  const HTML_SRC = "<!DOCTYPE html><html><head><title>Report</title>"
    + "<style>h1{color:#2f81f7}.never-matched{background:url(https://example.com/x.png)}</style>"
    + "</head><body><h1>e2e report</h1><p>café</p></body></html>";
  const SCRIPT_MARK = "termic-e2e-script-ran";

  /** The visible preview frame of THIS task, read from the parent. */
  const frame = () => browser.execute((id) => {
    const root = document.querySelector(`[data-task-id="${id}"]`);
    const f = Array.from(root?.querySelectorAll("[data-testid='html-preview']") ?? [])
      .find((n) => n.getBoundingClientRect().width > 0) as HTMLIFrameElement | undefined;
    if (!f) return null;
    const srcdoc = f.getAttribute("srcdoc") ?? "";
    return {
      sandbox: f.getAttribute("sandbox"),
      srcdoc,
      // The narrowing policy the pane prepends, or null if it is not first.
      policy: /^<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(srcdoc)?.[1] ?? null,
      opaque: f.contentDocument === null,
    };
  }, taskId);

  const mode = () => browser.execute((id) => {
    const root = document.querySelector(`[data-task-id="${id}"]`);
    const el = Array.from(root?.querySelectorAll("[data-testid='source-preview-shell']") ?? [])
      .find((n) => n.getBoundingClientRect().width > 0);
    return el?.getAttribute("data-view") ?? null;
  }, taskId);

  const editorShown = () => browser.execute((id) => {
    const root = document.querySelector(`[data-task-id="${id}"]`);
    return Array.from(root?.querySelectorAll(".cm-editor") ?? [])
      .some((n) => n.getBoundingClientRect().width > 0);
  }, taskId);

  const clickMode = (m: string) => browser.execute((id, want) => {
    const root = document.querySelector(`[data-task-id="${id}"]`);
    const btn = Array.from(root?.querySelectorAll(`[data-view-btn="${want}"]`) ?? [])
      .find((n) => n.getBoundingClientRect().width > 0) as HTMLElement | undefined;
    btn?.click();
  }, taskId, m);

  /** The visible "Show images" button of this task's blocked-images banner. */
  const showImagesButton = () => browser.execute((id) => {
    const root = document.querySelector(`[data-task-id="${id}"]`);
    return Array.from(root?.querySelectorAll("button") ?? [])
      .some((b) => b.textContent?.trim() === "Show images" && b.getBoundingClientRect().width > 0);
  }, taskId);

  const messages = () => browser.execute(() =>
    (window as unknown as { __htmlE2e?: { msgs: string[] } }).__htmlE2e?.msgs ?? []);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    remoteImagesBefore = await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      const was = p.loadRemoteImages;
      // Both are the defaults on a fresh profile; set them so a previous run
      // or spec cannot decide what this one sees.
      p.setLoadRemoteImages(false);
      p.setHtmlDefaultView("preview");
      return was;
    });
    writeFileSync(path.join(fixture, HTML), HTML_SRC);
    taskId = await openTask("e2e-html");
    tabId = await browser.execute((id, p) => {
      const app = window.__termic!.useApp.getState();
      app.openPreviewTab(id, { type: "edit", path: p, title: p });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = app.tabs[id].find((t: any) => t.type === "edit" && t.path === p);
      app.persistTab(id, tab.id);
      return tab.id;
    }, taskId, HTML);
  });

  after(async () => {
    await browser.execute((was) => window.__termic!.usePrefs.getState().setLoadRemoteImages(was), remoteImagesBefore);
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch {
      /* nothing */
    }
  });

  it("opens on the rendered page, in a frame the app cannot reach into", async () => {
    await browser.waitUntil(async () => (await frame())?.srcdoc.includes("e2e report") === true,
      { timeout: 15_000, timeoutMsg: "the html preview never rendered" });
    const f = (await frame())!;
    expect(await mode()).toBe("preview");
    expect(await editorShown()).toBe(false);
    // Exactly empty. Every token re-enables something, and allow-scripts with
    // allow-same-origin together would hand the document the IPC bridge.
    expect(f.sandbox).toBe("");
    // Opaque origin: the parent gets no document, so neither does the frame
    // get this one.
    expect(f.opaque).toBe(true);
    // The narrowing policy is the FIRST thing in the srcdoc (a CSP meta that
    // lands in <body> is ignored), and remote images are off by default.
    expect(f.policy).toContain("default-src 'none'");
    expect(f.policy).toMatch(/img-src data:(;|$)/);
    await snap("html-preview");
  });

  it("never lets a script in the document reach the app", async () => {
    await browser.execute((id, tid) => {
      const w = window as unknown as { __htmlE2e?: { msgs: string[]; loads: number } };
      const state = { msgs: [] as string[], loads: 0 };
      w.__htmlE2e = state;
      window.addEventListener("message", (e) => { state.msgs.push(String(e.data)); });
      const pane = document.querySelector(`[data-task-id="${id}"] [data-main-tab-id="${tid}"]`)!;
      pane.querySelector("[data-testid='html-preview']")!.addEventListener("load", () => { state.loads++; });
    }, taskId, tabId);
    // An unsaved edit through CodeMirror's own view API (the svg spec explains
    // why not synthetic input). The editor is mounted but hidden in preview
    // mode, so it is found by tab, not by visibility.
    await browser.execute((id, tid, mark) => {
      const el = document.querySelector(`[data-task-id="${id}"] [data-main-tab-id="${tid}"] .cm-editor`) as unknown as { __cmView?: any } | null;
      const view = el?.__cmView;
      if (!view) throw new Error("CodeMirror e2e hook missing (build with make e2e)");
      view.dispatch({ changes: { from: view.state.doc.length, insert: `<script>parent.postMessage("${mark}", "*")</script>` } });
    }, taskId, tabId, SCRIPT_MARK);
    // The new srcdoc carries the script and the frame finished loading it, so
    // anything its script posted during parsing is already queued.
    await browser.waitUntil(async () => {
      const f = await frame();
      const loads = await browser.execute(() =>
        (window as unknown as { __htmlE2e?: { loads: number } }).__htmlE2e?.loads ?? 0);
      return !!f && f.srcdoc.includes(SCRIPT_MARK) && loads > 0;
    }, { timeout: 10_000, timeoutMsg: "the preview never reloaded with the edited document" });
    // Messages to this window are delivered in order, so a sentinel posted now
    // lands after anything the document's script could have sent.
    await browser.execute(() => window.postMessage("termic-e2e-sentinel", "*"));
    await browser.waitUntil(async () => (await messages()).includes("termic-e2e-sentinel"),
      { timeout: 10_000, timeoutMsg: "the sentinel message never arrived" });
    expect(await messages()).not.toContain(SCRIPT_MARK);
    // Fed from the live buffer: nothing was saved.
    expect(await browser.execute((id, p) => window.__termic!.ipc.taskFileRead(id, p), taskId, HTML))
      .not.toContain(SCRIPT_MARK);
  });

  it("blocks remote images until they are unblocked for this document", async () => {
    await browser.waitUntil(async () => await showImagesButton(),
      { timeout: 10_000, timeoutMsg: "no blocked-images banner for a document with a remote image" });
    expect((await frame())!.policy).not.toContain("https:");
    await browser.execute((id) => {
      const root = document.querySelector(`[data-task-id="${id}"]`);
      (Array.from(root?.querySelectorAll("button") ?? [])
        .find((b) => b.textContent?.trim() === "Show images" && b.getBoundingClientRect().width > 0) as HTMLElement | undefined)
        ?.click();
    }, taskId);
    await browser.waitUntil(async () => (await frame())?.policy?.includes("img-src data: https:") === true,
      { timeout: 10_000, timeoutMsg: "Show images never allowed https: images in the preview's policy" });
    expect(await showImagesButton()).toBe(false);
    // For this document only: the global pref is untouched.
    expect(await browser.execute(() => window.__termic!.usePrefs.getState().loadRemoteImages)).toBe(false);
  });

  it("switches between source, split and preview, and remembers the last mode", async () => {
    await clickMode("source");
    await browser.waitUntil(async () => await editorShown() && await mode() === "source",
      { timeout: 10_000, timeoutMsg: "the source pane never appeared" });
    expect(await browser.execute(() => localStorage.getItem("htmlDefaultView"))).toBe("source");

    await clickMode("split");
    await browser.waitUntil(async () => await editorShown() && (await frame()) !== null,
      { timeout: 10_000, timeoutMsg: "split never showed both panes" });
    expect(await mode()).toBe("split");

    await clickMode("preview");
    await browser.waitUntil(async () => await mode() === "preview" && !(await editorShown()),
      { timeout: 10_000, timeoutMsg: "never returned to the preview" });
    expect(await browser.execute(() => localStorage.getItem("htmlDefaultView"))).toBe("preview");
  });

  it("provides an open-in-browser button in the header and in the preview toolbar", async () => {
    const hasHeaderBtn = await browser.execute((id) => {
      const root = document.querySelector(`[data-task-id="${id}"]`);
      return !!root?.querySelector('[data-testid="breadcrumb-open-browser"]');
    }, taskId);
    expect(hasHeaderBtn).toBe(true);

    const hasToolbarBtn = await browser.execute((id) => {
      const root = document.querySelector(`[data-task-id="${id}"]`);
      return !!root?.querySelector('[data-testid="html-open-browser-btn"]');
    }, taskId);
    expect(hasToolbarBtn).toBe(true);
  });
});

// A file the editor cannot show is a WRONG-VIEWER state, not a failure: it
// gets a calm centered notice offering "Open in default app" and "Reveal in
// Finder" rather than red text with no way out. Two files qualify, binary
// and over the read cap, and the ORDER between them is load-bearing: a big
// archive is both, and only "binary" leads anywhere useful, so Rust sniffs
// for binary before it looks at the size. Cases: the notice replaces the red
// error and carries both buttons; a too-large text file gets the same notice
// naming its size; a big binary reports binary rather than too-large;
// recycling the preview tab onto a real text file clears it; a GENUINE
// failure (missing file) still gets the red raw error, because offering
// "Open in default app" for a file that would not read is offering a button
// that fails again.
//
// NEITHER button is ever clicked here. "Open in default app" would launch
// whatever app is registered for the fixture's extension on the runner, with
// nothing in the suite able to close it, and "Reveal in Finder" would steal
// focus from the window WebdriverIO is driving. Presence + labels is the
// contract worth pinning; the actions themselves are the same helpers the
// path context menu has always used.
describe("unviewable file notice", () => {
  let taskId!: string;
  const binName = "e2e-blob.bin";
  const binPath = path.join(fixture, binName);
  // Past the 2 MB cap task_file_read enforces, by enough that a rounding
  // change in the notice's size can never make this test ambiguous.
  const bigName = "e2e-huge.txt";
  const bigBinName = "e2e-huge.bin";
  const NOTICE = '[data-testid="unviewable-file-notice"]';

  after(async () => {
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch {
      /* nothing */
    }
  });

  /** Visible text of the whole editor pane for `tab`, main or split. */
  const paneText = (tabId: string) =>
    browser.execute((id) => {
      const el = document.querySelector(
        `[data-main-tab-id="${id}"], [data-split-leaf][data-tab-id="${id}"]`,
      ) as HTMLElement | null;
      return el?.innerText ?? "";
    }, tabId);

  const editTabFor = (rel: string) =>
    browser.execute(
      (id, p) =>
        (window.__termic!.useApp.getState().tabs[id] ?? []).find(
          (t: any) => t.type === "edit" && t.path === p,
        ),
      taskId,
      rel,
    );

  it("shows a friendly notice with both OS actions instead of a red error", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-binary");

    // Bytes that can never be valid UTF-8 (a lone 0xFF), written inline
    // rather than committed: the suite keeps no binary fixtures (see the PDF
    // case above, which builds its own PDF the same way).
    writeFileSync(binPath, Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02, 0xff]));
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );

    const sel = `[data-path="${binName}"]`;
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), sel),
      { timeout: 10_000, timeoutMsg: `${binName} never appeared in the tree` },
    );
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, sel);

    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), NOTICE),
      { timeout: 10_000, timeoutMsg: "the binary-file notice never rendered" },
    );

    const tab = await editTabFor(binName);
    const text = await paneText(tab.id);
    // The copy the user reads, and the two ways out.
    expect(text).toContain("This looks like a binary file, so the editor can't show it.");
    expect(text).toContain("Open in default app");
    expect(text).toContain(`Reveal in ${FILE_MANAGER_NAME}`);
    // Neither the raw Rust message nor the old red framing survives.
    expect(text).not.toContain("UTF-8");
    expect(text).not.toContain("Error:");

    // Nothing in the pane is painted with the error token. Resolved through a
    // probe element rather than string-matching the CSS var, so this holds in
    // any theme (the var is a hex, the computed color an rgb()).
    const reds = await browser.execute((sel2) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--color-err)";
      document.body.appendChild(probe);
      const err = getComputedStyle(probe).color;
      probe.remove();
      const pane = document.querySelector(sel2) as HTMLElement;
      return [...pane.querySelectorAll("*")]
        .filter((el) => (el as HTMLElement).innerText?.trim())
        .filter((el) => getComputedStyle(el).color === err).length;
    }, NOTICE);
    expect(reds).toBe(0);

    await snap("unviewable-file-notice");
  });

  /** Click the tree row for `rel` (writing it first) and wait for the notice
   *  to say `expected`.
   *
   *  Waiting on the notice EXISTING would be a race and a silent one: the
   *  preview tab recycles in place, so the previous case's notice is still
   *  mounted while the new file is being read, the wait would return on it
   *  immediately, and the assertions would run against the copy for the
   *  wrong file. Waiting for the text to become what this case is about is
   *  the only condition that cannot pass early. */
  const openAndExpectNotice = async (rel: string, contents: Buffer | string, expected: string) => {
    writeFileSync(path.join(fixture, rel), contents);
    await browser.execute((id) => window.__termic!.useApp.getState().bumpFsRevision(id), taskId);
    const sel = `[data-path="${rel}"]`;
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), sel),
      { timeout: 10_000, timeoutMsg: `${rel} never appeared in the tree` },
    );
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, sel);
    let text = "";
    await browser.waitUntil(
      async () => {
        const tab = await editTabFor(rel);
        if (!tab) return false;
        text = await paneText(tab.id);
        return text.includes(expected);
      },
      { timeout: 15_000, timeoutMsg: `the notice for ${rel} never said ${JSON.stringify(expected)}` },
    );
    // It is the notice pane, not a red error that happens to contain the copy.
    expect(await browser.execute((s) => !!document.querySelector(s), NOTICE)).toBe(true);
    return text;
  };

  it("gives a file past the read cap the same notice, naming its size", async () => {
    // 3 MB of plain ASCII: decodable, so the ONLY thing wrong with it is the
    // size, which is what separates this from the case above.
    const text = await openAndExpectNotice(
      bigName,
      "a".repeat(3_000_000),
      "This file is too large for the editor to show (3.0 MB).",
    );
    expect(text).toContain("Open in default app");
    expect(text).toContain(`Reveal in ${FILE_MANAGER_NAME}`);
    // Same as the binary case: no raw message, no red framing.
    expect(text).not.toContain("bytes)");
    expect(text).not.toContain("Error:");
  });

  it("calls a big binary binary, not too large", async () => {
    // Both true of this file. Checking the size first would send an archive
    // to "too large", which tells the user nothing they can act on, instead
    // of to "open it in the app that can read it".
    const blob = Buffer.alloc(3_000_000, 0x61);
    blob.writeUInt8(0xff, 0);
    blob.writeUInt8(0xfe, 1);
    const text = await openAndExpectNotice(
      bigBinName,
      blob,
      "This looks like a binary file, so the editor can't show it.",
    );
    expect(text).not.toContain("too large");
  });

  it("clears the notice when the preview tab recycles onto a text file", async () => {
    // Same mounted EditorPane, new tab.path: a stale notice would render on
    // top of the next file's contents.
    const sel = '[data-path="README.md"]';
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), sel),
      { timeout: 10_000, timeoutMsg: "README row never appeared" },
    );
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, sel);

    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !document.querySelector('[data-testid="unviewable-file-notice"]') &&
            (document.querySelector(".cm-content")?.textContent ?? "").includes(
              "e2e fixture",
            ),
        ),
      { timeout: 10_000, timeoutMsg: "the notice outlived the file it described" },
    );
  });

  it("keeps a genuine read failure as a raw error, with no buttons", async () => {
    const missing = "e2e-not-here.txt";
    await browser.execute(
      (id, p) =>
        window.__termic!.useApp.getState().openPreviewTab(id, {
          type: "edit",
          path: p,
          title: p,
        }),
      taskId,
      missing,
    );

    const tab = await browser.waitUntil(
      async () => (await editTabFor(missing)) ?? false,
      { timeout: 10_000, timeoutMsg: "the missing-file tab never opened" },
    );
    await browser.waitUntil(
      async () => (await paneText((tab as any).id)).includes("Error:"),
      { timeout: 10_000, timeoutMsg: "a missing file did not report an error" },
    );

    const text = await paneText((tab as any).id);
    expect(text).not.toContain("Open in default app");
    const notice = await browser.execute(
      (s) => !!document.querySelector(s),
      NOTICE,
    );
    expect(notice).toBe(false);
  });
});

// Markdown split view: the preview scrolls in step with the source, and a
// selection in the RENDERED text takes a review comment the way an editor
// selection does. Scroll events are dispatched by hand after each scrollTop
// write: an occluded window may never deliver them on its own, and what is
// under test is the sync, not WebKit's event cadence.
describe("markdown split: scroll sync and preview comments", () => {
  let taskId!: string;
  const NAME = "e2e-long.md";
  const SECTIONS = 40;
  // line 1 title, line 2 blank, then 5 lines per section:
  // heading, blank, two paragraph lines, blank.
  const headingLine = (i: number) => 3 + (i - 1) * 5;
  const source = () => {
    let s = "# Long doc\n\n";
    for (let i = 1; i <= SECTIONS; i++) s += `## Section ${i}\n\nParagraph ${i} first line\nand its second line.\n\n`;
    return s;
  };

  after(async () => {
    if (taskId) await archiveTask(taskId);
    rmSync(path.join(fixture, NAME), { force: true });
  });

  /** Which section heading sits at the top of the preview viewport. */
  const previewTopSection = () =>
    browser.execute(() => {
      const host = window.__mdShown!(".markdown-body");
      const top = host.parentElement!.getBoundingClientRect().top;
      const at = Array.from(host.querySelectorAll("h2")).filter(h => h.getBoundingClientRect().top <= top + 4).pop();
      return at ? Number(at.textContent!.replace(/\D+/g, "")) : 0;
    });

  it("opens a long markdown file in split view", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-md-split");
    writeFileSync(path.join(fixture, NAME), source());
    await browser.execute((id, name) => {
      window.__mdShown = (sel) => Array.from(document.querySelector(`[data-task-id="${id}"]`)!.querySelectorAll<HTMLElement>(sel))
        .find(el => el.getBoundingClientRect().width > 0)!;
      const app = window.__termic!.useApp.getState();
      app.bumpFsRevision(id);
      app.openPreviewTab(id, { type: "edit", path: name, title: name });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = app.tabs[id].find((t: any) => t.type === "edit" && t.path === name);
      app.persistTab(id, tab.id);
      app.setActiveTabId(id, tab.id);
      app.patchTab(id, tab.id, { mdView: "split" });
    }, taskId, NAME);
    await browser.waitUntil(
      () => browser.execute(() => window.__mdShown!(".markdown-body")?.querySelectorAll("h2").length === 40),
      { timeout: 10_000, timeoutMsg: "the split preview never rendered the long doc" },
    );
    // every rendered block knows its source lines
    expect(await browser.execute(() =>
      Array.from(window.__mdShown!(".markdown-body").querySelectorAll("h2")).slice(0, 2).map(h => h.getAttribute("data-src-line")),
    )).toEqual([String(headingLine(1)), String(headingLine(2))]);
  });

  it("follows the editor when the source scrolls", async () => {
    await browser.waitUntil(async () => {
      await browser.execute((line) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const view = (window.__mdShown!(".cm-editor") as unknown as { __cmView: any }).__cmView;
        const sd = view.scrollDOM as HTMLElement;
        const offset = view.documentTop - sd.getBoundingClientRect().top + sd.scrollTop;
        sd.scrollTop = view.lineBlockAt(view.state.doc.line(line).from).top + offset;
        sd.dispatchEvent(new Event("scroll"));
      }, headingLine(20));
      return (await previewTopSection()) === 20;
    }, { timeout: 8_000, timeoutMsg: "the preview did not follow the editor to section 20" });
    await snap("md-split-scroll-sync.png");
  });

  it("moves the editor when the preview scrolls", async () => {
    // retried: a scroll event can coalesce with the echo of the editor-driven
    // scroll above and be read as that echo, which is the guard doing its job.
    await browser.waitUntil(async () => {
      const line = await browser.execute(() => {
        const host = window.__mdShown!(".markdown-body");
        const scroller = host.parentElement!;
        const h = host.querySelectorAll("h2")[29];
        scroller.scrollTop += h.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        scroller.dispatchEvent(new Event("scroll"));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const view = (window.__mdShown!(".cm-editor") as unknown as { __cmView: any }).__cmView;
        const y = view.scrollDOM.getBoundingClientRect().top - view.documentTop + 1;
        return view.state.doc.lineAt(view.lineBlockAtHeight(y).from).number as number;
      });
      return Math.abs(line - headingLine(30)) <= 1;
    }, { timeout: 8_000, timeoutMsg: "the editor did not follow the preview to section 30" });
  });

  // the editor's own boxes (commentBoxes), scoped to the preview
  const composer = ".markdown-body .tc-comment-composer";
  const card = ".markdown-body .tc-comment-card";
  const has = (sel: string) => browser.execute((s) => !!document.querySelector(s), sel);
  const clickButton = (scope: string, label: string) =>
    browser.execute((sc, l) => {
      (Array.from(document.querySelectorAll(`${sc} button`)).find(b => b.textContent === l) as HTMLElement).click();
    }, scope, label);
  const commentedBlocks = () =>
    browser.execute(() => window.__mdShown!(".markdown-body").querySelectorAll("[data-tc-commented]").length);
  /** The highlighted quote text, whitespace runs collapsed. */
  const quotedText = () =>
    browser.execute(() => Array.from(window.__mdShown!(".markdown-body").querySelectorAll("mark.tc-md-quote"))
      .map(m => m.textContent).join("").replace(/\s+/g, " "));
  /** Select `phrase` (whitespace-elastic, so it can cross the source's hard
   *  wrap) inside the paragraph starting `para`, and release the mouse.
   *
   *  Blurs first, which is what the mousedown of a real drag does. The split
   *  opens with the EDITOR focused, and a focused CodeMirror owns the window
   *  selection: the next time its viewport redraws it writes its own caret
   *  back, which collapses a selection made anywhere else. The scroll-sync
   *  cases above leave that viewport still settling, so without the blur the
   *  pill came up and was gone again before the next command, or never came
   *  up at all (measured: focused editor + a viewport move collapses the
   *  preview selection every time, blurred it survives every time). */
  const selectInParagraph = (para: string, phrase: string) =>
    browser.execute((pa, ph) => {
      (document.activeElement as HTMLElement | null)?.blur();
      const host = window.__mdShown!(".markdown-body");
      const p = Array.from(host.querySelectorAll("p")).find(x => x.textContent!.startsWith(pa))!;
      const node = p.firstChild as Text;
      const m = new RegExp(ph.split(" ").join("\\s+")).exec(node.nodeValue!)!;
      const r = document.createRange();
      r.setStart(node, m.index);
      r.setEnd(node, m.index + m[0].length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      host.parentElement!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, para, phrase);
  const openComposerFromPill = async (select: () => Promise<unknown>) => {
    await select();
    try {
      await browser.waitUntil(() => has('[data-testid="md-add-comment"]'), { timeout: 5_000 });
    } catch {
      const state = await browser.execute(() => ({
        selection: String(window.getSelection()),
        active: (document.activeElement as HTMLElement | null)?.className?.toString(),
        windowFocused: document.hasFocus(),
      }));
      throw new Error(`no comment pill over the preview selection: ${JSON.stringify(state)}`);
    }
    // commits on mousedown so the selection is still there to read
    await browser.execute(() => document.querySelector('[data-testid="md-add-comment"]')!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    await browser.waitUntil(() => has(`${composer} textarea`),
      { timeout: 5_000, timeoutMsg: "the preview composer never opened" });
  };

  it("offers a comment on part of a rendered paragraph, quoting just that part", async () => {
    // crosses the source's hard wrap ("first line\nand its second line.")
    await openComposerFromPill(() => selectInParagraph("Paragraph 30 ", "line and its second"));
    // the SOURCE lines the selection spans, and the selection as the quote,
    // not the whole paragraph
    expect(await browser.execute((c) => document.querySelector(c)!.textContent, composer))
      .toContain(`${NAME} · lines ${headingLine(30) + 2}–${headingLine(30) + 3}`);
    expect(await browser.execute((c) => document.querySelector(`${c} .tc-comment-quote`)!.textContent!.replace(/\s+/g, " "), composer))
      .toBe("line and its second");
    // opening the composer clears the selection, so the quote stays lit
    expect(await quotedText()).toBe("line and its second");
    // ready to type: the slot is in the document before the composer focuses
    const focused = (c: string) => browser.execute((sel) => document.activeElement === document.querySelector(`${sel} textarea`), c);
    await browser.waitUntil(() => focused(composer), { timeout: 2_000, timeoutMsg: "the composer opened without focus" });
    await snap("md-preview-composer.png");
    // a rebuild of the rendered document (here an edit at the end of the
    // source) must not take the caret out of the composer
    await browser.execute(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (window.__mdShown!(".cm-editor") as unknown as { __cmView: any }).__cmView;
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nTrailing rebuild marker.\n" } });
    });
    await browser.waitUntil(
      () => browser.execute(() => window.__mdShown!(".markdown-body").textContent!.includes("Trailing rebuild marker")),
      { timeout: 5_000, timeoutMsg: "the preview never re-rendered the edit" },
    );
    expect(await focused(composer)).toBe(true);
  });

  it("sizes the comment box to its text, with no scrollbars, zoomed in too", async () => {
    // measured, not looked at: overflow is what draws the scrollbars
    const overflow = () => browser.execute((c) => {
      const ta = document.querySelector(`${c} textarea`) as HTMLTextAreaElement;
      ta.value = "first line of a comment\nand a second";
      ta.dispatchEvent(new Event("input"));
      // height must fit exactly; width is allowed a rounding pixel at a
      // fractional zoom, so what matters there is that it cannot scroll
      const cs = getComputedStyle(ta);
      return {
        y: ta.scrollHeight - ta.clientHeight, overflowX: cs.overflowX, overflowY: cs.overflowY,
        // not asserted: the box's geometry, so a failure says whether the
        // composer was squeezed
        box: { w: ta.clientWidth, h: ta.clientHeight, scroll: ta.scrollHeight, win: window.innerWidth, dpr: devicePixelRatio },
      };
    }, composer);
    // the panes are what the zoom squeezes: on a small screen (Windows CI's
    // is 1024x768) the sidebar and right panel leave the preview a few px
    // wide at 150, and two short lines then wrap past the box's cap. The
    // case is about the box fitting its text, so it gets the room.
    const chrome = (hide: boolean) => browser.execute((h) => {
      const app = window.__termic!.useApp.getState();
      const was = { compact: app.compactSidebar, hidden: app.rightPanelHidden };
      if (app.compactSidebar !== h) app.toggleCompactSidebar();
      if (app.rightPanelHidden !== h) app.toggleRightPanel();
      return was;
    }, hide);
    const was = await chrome(true);
    try {
      for (const zoom of [100, 150]) {
        await browser.execute((z) => window.__termic!.usePrefs.getState().setUiScale(z), zoom);
        const { box, ...got } = await overflow();
        if (got.y !== 0 || got.overflowY !== "hidden") console.log(`comment box at ${zoom}: ${JSON.stringify(box)}`);
        expect({ zoom, ...got }).toEqual({ zoom, y: 0, overflowX: "hidden", overflowY: "hidden" });
      }
    } finally {
      await browser.execute(() => window.__termic!.usePrefs.getState().setUiScale(100));
      await browser.execute((w) => {
        const app = window.__termic!.useApp.getState();
        if (app.compactSidebar !== w.compact) app.toggleCompactSidebar();
        if (app.rightPanelHidden !== w.hidden) app.toggleRightPanel();
      }, was);
      await browser.execute((c) => { (document.querySelector(`${c} textarea`) as HTMLTextAreaElement).value = ""; }, composer);
    }
  });

  it("queues it, with a card in the preview and only the quoted text marked", async () => {
    await browser.execute((c) => {
      const ta = document.querySelector(`${c} textarea`) as HTMLTextAreaElement;
      ta.value = "tighten this";
    }, composer);
    await clickButton(composer, "Add to pending");
    await browser.waitUntil(() => has(card), { timeout: 5_000, timeoutMsg: "no comment card in the preview" });
    expect(await has(composer)).toBe(false);
    expect(await browser.execute((c) => document.querySelector(c)!.textContent, card)).toContain("tighten this");
    // survives the rebuild above, and highlights the text, not the paragraph
    expect(await quotedText()).toBe("line and its second");
    expect(await commentedBlocks()).toBe(0);
    await snap("md-preview-comment-card.png");
  });

  it("shows the same comment beside its source in the editor", async () => {
    await browser.waitUntil(
      () => browser.execute((id) =>
        Array.from(document.querySelectorAll(`[data-task-id="${id}"] .cm-editor .tc-comment-card`))
          .some(c => c.textContent?.includes("tighten this")), taskId),
      { timeout: 5_000, timeoutMsg: "the editor never showed the preview's comment" },
    );
  });

  it("edits it in place from the preview card", async () => {
    await clickButton(card, "Edit");
    await browser.waitUntil(() => has(`${composer} textarea`), { timeout: 5_000, timeoutMsg: "edit never opened the composer" });
    // the card it is editing steps aside while the composer is open
    expect(await has(card)).toBe(false);
    await browser.execute((c) => {
      const ta = document.querySelector(`${c} textarea`) as HTMLTextAreaElement;
      ta.value = "tighten this more";
    }, composer);
    await clickButton(composer, "Update");
    await browser.waitUntil(
      () => browser.execute((c) => document.querySelector(c)?.textContent?.includes("tighten this more") ?? false, card),
      { timeout: 5_000, timeoutMsg: "the edited body never reached the card" },
    );
  });

  it("deletes it from the preview card", async () => {
    await clickButton(card, "Delete");
    await browser.waitUntil(async () => !(await has(card)) && (await quotedText()) === "",
      { timeout: 5_000, timeoutMsg: "the deleted comment stayed on the preview" });
  });

  it("narrows a selection inside one source line to that line", async () => {
    // paragraph 32 is lines 160-161; "second line" is all on 161
    await openComposerFromPill(() => selectInParagraph("Paragraph 32 ", "second line"));
    const label = await browser.execute((c) => document.querySelector(`${c} .tc-comment-loc`)!.textContent, composer);
    expect(label).toBe(`${NAME} · line ${headingLine(32) + 3}`);
    await clickButton(composer, "Cancel");
    await browser.waitUntil(async () => !(await has(composer)) && (await quotedText()) === "",
      { timeout: 5_000, timeoutMsg: "cancelling left the composer or its highlight behind" });
  });

  it("keeps the preview's place when switching from preview to split", async () => {
    const setView = (v: string) => browser.execute((id, name, mode) => {
      const app = window.__termic!.useApp.getState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = app.tabs[id].find((t: any) => t.type === "edit" && t.path === name);
      app.patchTab(id, tab.id, { mdView: mode });
    }, taskId, NAME, v);
    await setView("preview");
    // read down to section 10 in the preview alone, while the hidden editor
    // is still wherever the split left it
    await browser.waitUntil(async () => {
      await browser.execute(() => {
        const host = window.__mdShown!(".markdown-body");
        const scroller = host.parentElement!;
        const h = host.querySelectorAll("h2")[9];
        scroller.scrollTop += h.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      });
      return (await previewTopSection()) === 10;
    }, { timeout: 5_000, timeoutMsg: "could not scroll the preview to section 10" });
    await setView("split");
    // the pane the reader was looking at leads; the editor follows it
    await browser.waitUntil(
      () => browser.execute(() => !!window.__mdShown!(".cm-editor")),
      { timeout: 5_000, timeoutMsg: "split never showed the editor" },
    );
    await browser.waitUntil(async () => {
      const line = await browser.execute(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const view = (window.__mdShown!(".cm-editor") as unknown as { __cmView: any }).__cmView;
        const y = view.scrollDOM.getBoundingClientRect().top - view.documentTop + 1;
        return view.state.doc.lineAt(view.lineBlockAtHeight(y).from).number as number;
      });
      return Math.abs(line - headingLine(10)) <= 1;
    // A miss here was a race, not slowness: WebKitGTK can give the editor
    // its height one ResizeObserver delivery late, and the first sync used
    // to be spent on the delivery where it had none (markdownScrollSync.ts).
    }, { timeout: 5_000, timeoutMsg: "the editor did not follow the preview to section 10" });
    // and the preview did not get dragged to the editor's old place instead
    expect(await previewTopSection()).toBe(10);
  });
});
