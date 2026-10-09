import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { archiveTask, dismissOverlays, ensureActiveTask, openTask, requireTermicApi, snap, waitForAppShell, rmTree } from "../helpers";

// The seeded fixture repo every spec in this file works against.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

declare global {
  interface Window {
    /** Installed by the drag spec so its guard and its drag aim at one pixel. */
    __dropPoint?: (host: HTMLElement) => { x: number; y: number };
  }
}

// P2: dragging a file row onto a terminal types its path at the prompt (GH
// #136) — the in-app twin of dragging a file in from Finder. Cases: a drag
// onto the terminal sends the task-relative path to the PTY and does NOT open
// the file; a drag released outside any terminal types nothing; a plain click
// (no movement) still opens the file.
//
// The gesture is pointer-based, not HTML5 DnD (WKWebView's native drag is
// unreliable and Tauri intercepts it for file drops), so the spec can drive it
// with synthetic pointer events through the app's real handlers.
describe("drag a file onto a terminal", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const outputAt = () =>
    browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const tabs = s.tabs[id] ?? [];
      const tab = tabs.find((t: any) => t.id === s.activeTab[id]) ?? tabs[0];
      return (tab?.lastOutputAt ?? 0) as number;
    }, taskId);

  const editorTabs = () =>
    browser.execute(
      (id) =>
        (window.__termic!.useApp.getState().tabs[id] ?? [])
          .filter((t: any) => t.type === "edit")
          .map((t: any) => t.path as string),
      taskId,
    );

  // "ok" when the terminal is the topmost element at the drop point; otherwise
  // the class/tag of whatever is covering it (a dialog backdrop or row).
  const topOfTerminal = () =>
    browser.execute(() => {
      const host = document.querySelector("[data-terminal-host]") as HTMLElement | null;
      if (!host) return "no terminal";
      const p = window.__dropPoint!(host);
      const hit = document.elementFromPoint(p.x, p.y) as HTMLElement | null;
      if (!hit) return "nothing";
      return hit.closest("[data-terminal-host]") ? "ok" : hit.className || hit.tagName;
    });

  // Drop near the terminal's bottom-RIGHT, not its center: dialogs are
  // centered, and a palette left open by another spec (specs can share the
  // window) would sit exactly over the middle and eat the drop. Installed on
  // `window` so the guard above and the drag below aim at the same pixel.
  const installDropPoint = () =>
    browser.execute(() => {
      window.__dropPoint = (host: HTMLElement) => {
        const r = host.getBoundingClientRect();
        return { x: r.right - 60, y: r.bottom - 60 };
      };
    });

  // Press the row, move to (x, y), release there. `to` picks the release
  // point from the terminal's own rect so the drop hit test is real.
  const dragRowTo = (row: string, to: "terminal" | "sidebar") =>
    browser.execute(
      (sel, where) => {
        const el = document.querySelector(sel) as HTMLElement;
        const host = document.querySelector("[data-terminal-host]") as HTMLElement;
        const from = el.getBoundingClientRect();
        const target =
          where === "terminal"
            ? window.__dropPoint!(host)
            : { x: from.left + 4, y: from.top + from.height + 60 };
        const at = (type: string, x: number, y: number, node: EventTarget) =>
          node.dispatchEvent(
            new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }),
          );
        at("pointerdown", from.left + 20, from.top + 10, el);
        // Two moves: the first crosses the drag threshold, the second lands.
        at("pointermove", from.left + 60, from.top + 10, window);
        at("pointermove", target.x, target.y, window);
        const highlighted = !!document.querySelector(".termic-drop-target");
        const ghost = !!document.querySelector(".termic-drag-ghost");
        at("pointerup", target.x, target.y, window);
        return {
          highlighted,
          ghost,
          clearedAfterDrop: !document.querySelector(".termic-drop-target"),
          ghostGone: !document.querySelector(".termic-drag-ghost"),
        };
      },
      `[data-path="${row}"]`,
      to,
    );

  it("sends the task-relative path to the terminal", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-drop");

    // The row to drag, and a live terminal to drop it on.
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !!document.querySelector('[data-path="README.md"]') &&
            !!document.querySelector("[data-terminal-host]"),
        ),
      { timeout: 15_000, timeoutMsg: "tree row + terminal never both appeared" },
    );
    // The window is reused across spec files: an earlier one may have left a
    // dialog backdrop over the terminal, or switched to another task.
    await dismissOverlays();
    await ensureActiveTask(taskId);
    await installDropPoint();
    // The drop is hit-tested with elementFromPoint, so the terminal must be
    // the topmost thing at the release point — a dialog backdrop would eat it.
    // (This describe runs FIRST in the file for that reason: on an occluded
    // window a closing Radix overlay can linger, see the e2e skill.) Dismiss
    // whatever might be up, then wait for the hit test to actually resolve.
    await browser
      .waitUntil(async () => (await topOfTerminal()) === "ok", { timeout: 8_000 })
      .catch(async () => {
        throw new Error(`something is covering the terminal: ${await topOfTerminal()}`);
      });
    // The PTY must be up, or the drop is a no-op by design.
    await browser.waitUntil(async () => (await outputAt()) > 0, {
      timeout: 15_000,
      timeoutMsg: "the agent PTY never produced output",
    });
    const before = await outputAt();

    const drag = await dragRowTo("README.md", "terminal");
    // Mid-drag the gesture is visible: ghost on the cursor, target outlined.
    expect(drag.ghost).toBe(true);
    expect(drag.highlighted).toBe(true);
    // ...and both are gone once it lands.
    expect(drag.clearedAfterDrop).toBe(true);
    expect(drag.ghostGone).toBe(true);

    // The path reached the PTY: the agent echoes what was typed, so fresh
    // output is the observable proof (terminal text lives on a WebGL canvas,
    // never in the DOM).
    await browser.waitUntil(async () => (await outputAt()) > before, {
      timeout: 10_000,
      timeoutMsg: "the dropped path never reached the PTY",
    });
    // A drag is not a click: the file must NOT have opened in an editor tab.
    expect(await editorTabs()).not.toContain("README.md");
    await snap("file-drop-terminal.png");
  });

  it("types nothing when released outside a terminal", async () => {
    const before = await outputAt();
    const drag = await dragRowTo("README.md", "sidebar");
    expect(drag.highlighted).toBe(false);
    expect(await outputAt()).toBe(before);
    expect(await editorTabs()).not.toContain("README.md");
  });

  it("still opens the file on a plain click", async () => {
    await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).click(),
      '[data-path="README.md"]',
    );
    await browser.waitUntil(async () => (await editorTabs()).includes("README.md"), {
      timeout: 8_000,
      timeoutMsg: "clicking the row no longer opens the file",
    });
  });
});

// P1: the file finder (⌘P). Cases: opens and lists the repo's files; selecting
// a result opens an editor tab for that file.
describe("file finder", () => {
  let taskId!: string;
  // The focus cases need a plain (non-markdown) file, and this spec has to
  // bring its own: a name another spec happens to leave behind is there on a
  // second local run and missing on CI's fresh checkout, which is exactly how
  // these cases passed here and failed there. Stamped so a leftover from an
  // earlier run cannot satisfy them either, and removed in `after`.
  const PLAIN = `finder-focus-${Date.now()}.txt`;
  after(async () => {
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeFileFinder(),
    );
    rmSync(path.join(fixture, PLAIN), { force: true });
    if (taskId) await archiveTask(taskId);
  });

  it("opens and lists the repo's files", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-finder");
    writeFileSync(path.join(fixture, PLAIN), "focus probe\n");
    await browser.execute(
      (id) => window.__termic!.useUI.getState().openFileFinder(id),
      taskId,
    );
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("[data-row]")].some((r) =>
            r.textContent?.includes("README"),
          ),
        ),
      { timeout: 8_000, timeoutMsg: "file finder never listed README" },
    );
  });

  it("selecting a result opens an editor tab", async () => {
    await browser.execute(() => {
      const row = [...document.querySelectorAll("[data-row]")].find((r) =>
        r.textContent?.includes("README"),
      );
      if (!row) throw new Error("README row not found");
      (row as HTMLElement).click();
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) => t.type === "edit" && t.path === "README.md",
            ),
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "selecting a file did not open an editor tab" },
    );
    await snap("file-finder.png");
  });

  // ⌘P then ⌘F: the file you just picked is where your keys go. Picking used
  // to leave focus on whatever had it before the dialog (the agent's
  // terminal), so the next ⌘F opened find-in-terminal instead of the file's.
  // Driven with the terminal focused first, since that is the real starting
  // point and the one Radix hands focus back to on close.
  // Every step below addresses the OPEN dialog, never "the dialog". A closed
  // one can sit in the DOM indefinitely: Radix defers the unmount until the
  // close animation ends, and animations are frozen while the window is
  // occluded, which it always is on a machine somebody is using. So after
  // editor.e2e this spec ran with three `[role="dialog"]` nodes on screen (a
  // closed syntax palette, a closed command palette, and this finder), and the
  // two unscoped selectors here both picked the wrong one: the query was typed
  // into the command palette's input, and the unfiltered finder's first row was
  // then read as a ranking failure for README.md. `data-state` is the signal,
  // not presence, which editor.e2e's own syntax case already says.
  const OPEN_DIALOG = '[role="dialog"]:not([data-state="closed"])';
  const pickWithEnter = async (name: string) => {
    await browser.execute(
      (id) => window.__termic!.useUI.getState().openFileFinder(id),
      taskId,
    );
    await browser.waitUntil(
      () => browser.execute((open, n) =>
        [...document.querySelectorAll(`${open} [data-row]`)].some((r) => r.textContent?.includes(n)),
        OPEN_DIALOG, name),
      { timeout: 8_000, timeoutMsg: `file finder never listed ${name}` },
    );
    await browser.execute((open, n) => {
      const el = document.querySelector<HTMLInputElement>(`${open} input[placeholder]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, n);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, OPEN_DIALOG, name);
    try {
      await browser.waitUntil(
        () => browser.execute((open, n) =>
          document.querySelector(`${open} [data-row]`)?.textContent?.includes(n) ?? false,
          OPEN_DIALOG, name),
        { timeout: 8_000, timeoutMsg: `${name} never became the top result` },
      );
    } catch (e) {
      // Say WHAT ranked above it, and in WHICH dialog. "never became the top
      // result" on its own sent one investigation into the ranking code when
      // the answer was that the query had been typed somewhere else entirely.
      const rows = await browser.execute(() =>
        [...document.querySelectorAll('[role="dialog"]')].map((d) => ({
          dialog: d.getAttribute("data-testid") ?? d.getAttribute("aria-label") ?? "(unlabelled)",
          state: d.getAttribute("data-state") ?? "(none)",
          rows: [...d.querySelectorAll("[data-row]")].slice(0, 5)
            .map((r) => (r as HTMLElement).innerText.trim().replace(/\s+/g, " ")),
        })));
      throw new Error(`${(e as Error).message}\ndialogs on screen: ${JSON.stringify(rows)}`);
    }
    await browser.execute((open) => {
      const d = document.querySelector(open) as HTMLElement;
      d.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }, OPEN_DIALOG);
  };

  const focusTerminal = () =>
    browser.execute((id) => {
      const ta = [...document.querySelectorAll<HTMLTextAreaElement>(`[data-task-id="${id}"] .xterm-helper-textarea`)]
        .find((el) => (el.closest(".xterm") ?? el).getBoundingClientRect().width > 0);
      if (!ta) throw new Error("no visible terminal to start from");
      ta.focus();
      return document.activeElement === ta;
    }, taskId);

  const editorFocusedFor = (path: string) =>
    browser.execute((id, p) => {
      const tab = (window.__termic!.useApp.getState().tabs[id] ?? [])
        .find((t: any) => t.type === "edit" && t.path === p) as any;
      if (!tab) return "no tab";
      const ae = document.activeElement;
      if (!ae?.closest(`[data-main-tab-id="${tab.id}"]`)) return `focus is on ${ae?.className || ae?.tagName}`;
      return ae.classList.contains("cm-content") ? "editor" : `inside the tab, on ${ae.className || ae.tagName}`;
    }, taskId, path);

  it("focuses the editor of the file it opens, from a terminal", async () => {
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const agent = (s.tabs[id] ?? []).find((t: any) => t.type === "terminal");
      if (agent) s.setActiveTabId(id, agent.id);
    }, taskId);
    await browser.waitUntil(focusTerminal, { timeout: 20_000, timeoutMsg: "the terminal never took focus" });

    await pickWithEnter(PLAIN);
    await browser.waitUntil(async () => (await editorFocusedFor(PLAIN)) === "editor", {
      timeout: 8_000,
      timeoutMsg: "the picked file's editor did not get focus",
    }).catch(async (e) => { throw new Error(`${e.message}: ${await editorFocusedFor(PLAIN)}`); });
  });

  // A markdown file opens in MarkdownPane, which mounts the editor itself and
  // used to pass it no `active` at all, so neither half could take focus.
  for (const mode of ["source", "preview"] as const) {
    it(`focuses a markdown file opened in ${mode} view`, async () => {
      const before = await browser.execute(() => window.__termic!.usePrefs.getState().markdownDefaultView);
      try {
        await browser.execute((id, m) => {
          const s = window.__termic!.useApp.getState();
          const open = (s.tabs[id] ?? []).find((t: any) => t.type === "edit" && t.path === "README.md") as any;
          if (open) s.closeTab(id, open.id);
          window.__termic!.usePrefs.getState().setMarkdownDefaultView(m);
          const agent = (s.tabs[id] ?? []).find((t: any) => t.type === "terminal");
          if (agent) s.setActiveTabId(id, agent.id);
        }, taskId, mode);
        await browser.waitUntil(focusTerminal, { timeout: 20_000, timeoutMsg: "the terminal never took focus" });

        await pickWithEnter("README.md");
        const where = () => browser.execute((id) => {
          const tab = (window.__termic!.useApp.getState().tabs[id] ?? [])
            .find((t: any) => t.type === "edit" && t.path === "README.md") as any;
          const ae = document.activeElement;
          if (!tab || !ae?.closest(`[data-main-tab-id="${tab.id}"]`)) return `outside: ${ae?.tagName}`;
          if (ae.classList.contains("cm-content")) return "editor";
          return ae.closest('[data-testid="source-preview-shell"] > div:last-child > div:last-child') ? "preview" : `tab: ${ae.tagName}`;
        }, taskId);
        const want = mode === "source" ? "editor" : "preview";
        await browser.waitUntil(async () => (await where()) === want, { timeout: 8_000, timeoutMsg: `focus did not land in the ${want}` })
          .catch(async (e) => { throw new Error(`${e.message}: ${await where()}`); });
      } finally {
        await browser.execute((v) => window.__termic!.usePrefs.getState().setMarkdownDefaultView(v), before);
      }
    });
  }

  it("focuses an already-open file's editor too", async () => {
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const agent = (s.tabs[id] ?? []).find((t: any) => t.type === "terminal");
      if (agent) s.setActiveTabId(id, agent.id);
    }, taskId);
    await browser.waitUntil(focusTerminal, { timeout: 20_000, timeoutMsg: "the terminal never took focus" });

    await pickWithEnter(PLAIN);
    await browser.waitUntil(async () => (await editorFocusedFor(PLAIN)) === "editor", {
      timeout: 8_000,
      timeoutMsg: "re-picking an open file did not focus its editor",
    }).catch(async (e) => { throw new Error(`${e.message}: ${await editorFocusedFor(PLAIN)}`); });
  });
});

// P1: find-in-files (⇧⌘F) streams results from ripgrep, or git grep where rg
// isn't installed (GH #181). Cases: opens with an input; the dialog names the
// backend that actually ran and offers the install hint only on the fallback;
// a query that matches the fixture README returns a result row with the match
// highlighted; the regexp toggle switches literal → pattern; Aa drops the
// case folding.
describe("find in files", () => {
  let taskId!: string;
  after(async () => {
    await browser.execute(() => {
      window.__termic!.useUI.getState().closeFindInFiles();
      // The e2e profile is shared across spec files: leave the prefs off.
      window.__termic!.usePrefs.getState().setFindInFilesRegex(false);
      window.__termic!.usePrefs.getState().setFindInFilesMatchCase(false);
    });
    if (taskId) await archiveTask(taskId);
  });

  const inputSel = 'input[placeholder^="Find in"]';

  const type = (text: string) =>
    browser.execute((s, v) => {
      const input = document.querySelector(s) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, inputSel, text);

  // Scoped to THIS dialog's list. The file finder, command palette, project
  // picker and prompt palette all render `data-row` too, and a closed Radix
  // dialog's content stays in the DOM (the file finder's README row survives
  // `closeFileFinder()`), so a document-wide count silently satisfies the
  // positive cases and defeats the negative ones.
  const readmeRows = () =>
    browser.execute(() =>
      [...document.querySelectorAll('[data-testid="fif-results"] [data-row]')].filter((r) =>
        r.textContent?.toLowerCase().includes("readme"),
      ).length,
    );

  const clickToggle = (testId: string) =>
    browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).click(),
      `[data-testid="${testId}"]`,
    );

  it("opens with a query input", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-fif");
    await browser.execute(
      (id) => window.__termic!.useUI.getState().openFindInFiles(id),
      taskId,
    );
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), inputSel),
      { timeout: 8_000, timeoutMsg: "find-in-files never opened" },
    );
  });

  // Which backend runs depends on the machine (CI runners and dev Macs
  // differ), and it's fixed for the life of the process, so the invariant
  // worth pinning is agreement: the dialog must describe the backend that
  // actually ran, and the "install rg" nudge must never appear to someone
  // who already has it.
  it("names the backend it searched with", async () => {
    const backend = await browser.execute(async () => {
      const info = (await window.__termic!.invoke("task_find_backend")) as {
        backend: string;
        settled: boolean;
      };
      return info.backend;
    });
    expect(["ripgrep", "git-grep"]).toContain(backend);

    const wanted = backend === "ripgrep" ? "ripgrep" : "git grep";
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelector('[data-testid="fif-status"]')?.textContent ?? "",
        )).includes(wanted),
      { timeout: 10_000, timeoutMsg: `status line never named ${wanted}` },
    );

    const hasHint = await browser.execute(
      () => !!document.querySelector('[data-testid="fif-rg-hint"]'),
    );
    expect(hasHint).toBe(backend === "git-grep");
  });

  it("returns a match for a query present in the repo", async () => {
    // "fixture" is in the committed README ("# e2e fixture").
    await type("fixture");

    await browser.waitUntil(async () => (await readmeRows()) > 0, {
      timeout: 10_000,
      timeoutMsg: "no result row for the query",
    });
    await snap("find-in-files.png");
  });

  // The match ranges come from ripgrep itself and from a JS re-match on the
  // git grep fallback. Either way the row has to paint the hit, so this
  // guards the seam without caring which side produced it.
  it("highlights the matched text inside the row", async () => {
    const marks = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="fif-results"] [data-row] b')]
        .map((b) => b.textContent?.toLowerCase() ?? ""),
    );
    expect(marks).toContain("fixture");
  });

  // "^# e2e" only matches the committed README as a pattern; as a literal
  // string (the default -F mode) it matches nothing.
  it("finds nothing for a pattern while the regexp toggle is off", async () => {
    await type("^# e2e");
    await browser.waitUntil(async () => (await readmeRows()) === 0, {
      timeout: 10_000,
      timeoutMsg: "the literal search matched a pattern it should not",
    });
  });

  it("matches the pattern once the regexp toggle is on", async () => {
    await clickToggle("fif-regex");
    expect(
      await browser.execute(() =>
        window.__termic!.usePrefs.getState().findInFilesRegex,
      ),
    ).toBe(true);

    await browser.waitUntil(async () => (await readmeRows()) > 0, {
      timeout: 10_000,
      timeoutMsg: "no result row for the pattern in regexp mode",
    });
    await snap("find-in-files-regex.png");
  });

  // The README holds "# e2e fixture" in lower case, so "Fixture" is the
  // query that separates the two case modes.
  it("matches a differently-cased query while Aa is off", async () => {
    await clickToggle("fif-regex");
    await type("Fixture");
    await browser.waitUntil(async () => (await readmeRows()) > 0, {
      timeout: 10_000,
      timeoutMsg: "case-insensitive search missed a differently-cased query",
    });
  });

  it("drops the match once Aa is on", async () => {
    await clickToggle("fif-case");
    expect(
      await browser.execute(() =>
        window.__termic!.usePrefs.getState().findInFilesMatchCase,
      ),
    ).toBe(true);

    await browser.waitUntil(async () => (await readmeRows()) === 0, {
      timeout: 10_000,
      timeoutMsg: "case-sensitive search still matched the wrong case",
    });
    await snap("find-in-files-case.png");
  });
});

// P1: the file tree. Guards expanding/collapsing a folder. Creates a throwaway
// nested file so there's a folder to toggle, then git-cleans it away.

describe("file tree", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
    execSync(`git -C "${fixture}" clean -fd`);
  });

  const rowExists = (p: string) =>
    browser.execute((sel) => !!document.querySelector(sel), `[data-path="${p}"]`);
  const clickRow = (p: string) =>
    browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).click(),
      `[data-path="${p}"]`,
    );

  it("expands and collapses a folder", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-tree");

    // Create a nested file on disk → a folder appears in the tree; force a
    // re-read (taskFileWrite doesn't mkdir -p, so write it directly).
    mkdirSync(path.join(fixture, "e2e-subdir"), { recursive: true });
    writeFileSync(path.join(fixture, "e2e-subdir", "note.txt"), "hi\n");
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );

    await browser.waitUntil(() => rowExists("e2e-subdir"), {
      timeout: 10_000,
      timeoutMsg: "the new folder never appeared in the tree",
    });

    // Expand → the child file becomes visible.
    await clickRow("e2e-subdir");
    await browser.waitUntil(() => rowExists("e2e-subdir/note.txt"), {
      timeout: 8_000,
      timeoutMsg: "expanding the folder did not reveal its child",
    });

    // Collapse → the child is hidden again.
    await clickRow("e2e-subdir");
    await browser.waitUntil(
      async () => (await rowExists("e2e-subdir/note.txt")) === false,
      { timeout: 8_000, timeoutMsg: "collapsing the folder did not hide its child" },
    );
    await snap("file-tree.png");
  });

  // Re-expanding an already-opened folder must re-read it from disk, so a file
  // created while it was collapsed shows up on reopen WITHOUT any global tree
  // reload (bumpFsRevision). Guards the on-demand per-dir refresh: before it,
  // a re-expand served the stale cache and the new file stayed hidden.
  it("re-expanding a folder re-reads only that dir from disk", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-tree"));

    // A fresh folder with a single child, surfaced via a one-time root reload.
    mkdirSync(path.join(fixture, "e2e-refresh"), { recursive: true });
    writeFileSync(path.join(fixture, "e2e-refresh", "one.txt"), "1\n");
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );
    await browser.waitUntil(() => rowExists("e2e-refresh"), {
      timeout: 10_000,
      timeoutMsg: "the new folder never appeared in the tree",
    });

    // First expand caches + shows the initial child.
    await clickRow("e2e-refresh");
    await browser.waitUntil(() => rowExists("e2e-refresh/one.txt"), {
      timeout: 8_000,
      timeoutMsg: "expanding the folder did not reveal its first child",
    });
    // Collapse (the children cache is kept).
    await clickRow("e2e-refresh");
    await browser.waitUntil(
      async () => (await rowExists("e2e-refresh/one.txt")) === false,
      { timeout: 8_000, timeoutMsg: "collapsing the folder did not hide its child" },
    );

    // Add a SECOND file on disk — deliberately with NO bumpFsRevision, so the
    // ONLY thing that can surface it is the re-expand re-reading this dir.
    writeFileSync(path.join(fixture, "e2e-refresh", "two.txt"), "2\n");

    // Re-expand → the on-demand refresh picks up the new file.
    await clickRow("e2e-refresh");
    await browser.waitUntil(() => rowExists("e2e-refresh/two.txt"), {
      timeout: 8_000,
      timeoutMsg: "re-expanding the folder did not re-read it from disk",
    });
    // The original child is still there too (a refresh, not a replace).
    expect(await rowExists("e2e-refresh/one.txt")).toBe(true);
  });

  // GH #159: a directory read that fails must not leave the row showing
  // "Loading…" forever. Two halves of the same invariant, both driven by
  // chmod 000 (read_dir fails with EACCES, deterministically):
  //   - a failure on a settle reload keeps the listing the tree already had,
  //     instead of dropping the key and rendering a spinner with nothing coming,
  //   - a failure on first expand says so and offers a retry.
  /**
   * Make a leftover chmod-000 directory writable again, then remove it.
   *
   * These two cases restore the mode in a `finally`, which covers a failed
   * assertion but NOT a killed process: interrupt a run here and the fixture
   * repo keeps a directory nobody can read or delete. Every later run then
   * fails somewhere else entirely, in another spec's teardown, on
   * `git clean -fd: permission denied` — a leftover that costs half an hour to
   * connect back to this test.
   */
  const resetUnreadable = (dir: string) => {
    if (!existsSync(dir)) return;
    try { execSync(`chmod -R u+rwx "${dir}"`); } catch { /* already readable */ }
    rmTree(dir, { bestEffort: true });
  };

  it("keeps a folder's contents when a settle reload cannot read it", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-tree"));

    const dir = path.join(fixture, "e2e-unreadable");
    resetUnreadable(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "kid.txt"), "k\n");
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );
    await browser.waitUntil(() => rowExists("e2e-unreadable"), {
      timeout: 10_000,
      timeoutMsg: "the new folder never appeared in the tree",
    });

    await clickRow("e2e-unreadable");
    await browser.waitUntil(() => rowExists("e2e-unreadable/kid.txt"), {
      timeout: 8_000,
      timeoutMsg: "expanding the folder did not reveal its child",
    });

    // The folder becomes unreadable, then an agent settles. Before the fix the
    // reload dropped the failed key from the whole-map replace and the row
    // went to a permanent "Loading…". The sibling file is what makes this bite:
    // the reload skips the whole update when nothing it re-read changed, so the
    // root listing has to differ for the merge to be exercised at all.
    execSync(`chmod 000 "${dir}"`);
    writeFileSync(path.join(fixture, "e2e-unreadable-sibling.txt"), "s\n");
    try {
      await browser.execute(
        (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
        taskId,
      );
      // The sibling landing proves the reload ran and updated the tree.
      await browser.waitUntil(() => rowExists("e2e-unreadable-sibling.txt"), {
        timeout: 10_000,
        timeoutMsg: "the settle reload never landed",
      });
      // The unreadable folder kept the listing it already had.
      expect(await rowExists("e2e-unreadable/kid.txt")).toBe(true);
    } finally {
      execSync(`chmod 755 "${dir}"`);
    }
    rmTree(dir, { bestEffort: true });
    rmSync(path.join(fixture, "e2e-unreadable-sibling.txt"), { force: true });
  });

  // `chmod 000` does not make a folder unreadable on Windows.
  (process.platform === "win32" ? it.skip : it)("offers a retry when a folder cannot be read at all", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-tree"));

    const dir = path.join(fixture, "e2e-denied");
    resetUnreadable(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "kid.txt"), "k\n");
    execSync(`chmod 000 "${dir}"`);
    try {
      await browser.execute(
        (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
        taskId,
      );
      await browser.waitUntil(() => rowExists("e2e-denied"), {
        timeout: 10_000,
        timeoutMsg: "the new folder never appeared in the tree",
      });

      // Expand: the read fails (once, then the automatic retry), so the row
      // says so instead of spinning.
      await clickRow("e2e-denied");
      const errorRow = () =>
        browser.execute(
          () => !!document.querySelector('[data-testid="dir-read-failed"][data-dir="e2e-denied"]'),
        );
      await browser.waitUntil(errorRow, {
        timeout: 10_000,
        timeoutMsg: "an unreadable folder never showed its retry row",
      });

      // And it says WHAT failed, not just that something did (GH #250): the
      // headline names the errno and the raw message names the path.
      const reason = await browser.execute(
        () => {
          const el = document.querySelector('[data-testid="dir-read-failed"][data-dir="e2e-denied"]') as HTMLElement;
          return { short: el.dataset.reason, title: el.title };
        },
      );
      expect(reason.short).toBe("Permission denied");
      expect(reason.title).toContain("e2e-denied");
      expect(reason.title).toContain("os error 13");

      // Make it readable and click Retry: the contents arrive, no collapse
      // and re-expand needed.
      execSync(`chmod 755 "${dir}"`);
      await browser.execute(() =>
        (document.querySelector('[data-testid="dir-read-failed"][data-dir="e2e-denied"]') as HTMLElement).click(),
      );
      await browser.waitUntil(() => rowExists("e2e-denied/kid.txt"), {
        timeout: 8_000,
        timeoutMsg: "Retry did not load the folder once it was readable again",
      });
    } finally {
      execSync(`chmod 755 "${dir}"`);
      rmTree(dir, { bestEffort: true });
    }
  });

  // A folder that is a symlink OUT of the task reads as a directory but can
  // never be listed: safe_task_path canonicalizes and rejects it. Retrying is
  // hopeless, so the row has to say why (GH #250). This is also the shape a
  // permanently-stuck folder takes in a real repo (a linked vendor dir, a
  // shared cache), which is the leading suspect for that report.
  it("says a folder links outside the task instead of offering a pointless retry", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-tree"));

    const outside = path.join(fixture, "..", "e2e-outside-target");
    const link = path.join(fixture, "e2e-escaped");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "secret.txt"), "s\n");
    // From Node rather than `ln -s`: Git Bash's ln copies the folder unless
    // told otherwise, and a copy escapes nothing. A junction on Windows
    // needs no privilege, unlike a directory symlink.
    try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* none */ } }
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      await browser.execute(
        (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
        taskId,
      );
      await browser.waitUntil(() => rowExists("e2e-escaped"), {
        timeout: 10_000,
        timeoutMsg: "the symlinked folder never appeared in the tree",
      });

      await clickRow("e2e-escaped");
      await browser.waitUntil(
        () =>
          browser.execute(
            () => !!document.querySelector('[data-testid="dir-read-failed"][data-dir="e2e-escaped"]'),
          ),
        { timeout: 10_000, timeoutMsg: "the escaping folder never showed its error row" },
      );
      const reason = await browser.execute(
        () => {
          const el = document.querySelector('[data-testid="dir-read-failed"][data-dir="e2e-escaped"]') as HTMLElement;
          return { short: el.dataset.reason, title: el.title };
        },
      );
      expect(reason.short).toBe("This folder links outside the task");
      expect(reason.title).toContain("path escapes task");
      expect(reason.title).toContain("e2e-outside-target");
    } finally {
      // A directory symlink is a directory to Windows: unlink refuses it
      // (EISDIR / EPERM) and rmdir removes the link without its target.
      try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* gone */ } }
      rmTree(outside, { bestEffort: true });
    }
  });

  // Clicking an image in the tree must render the picture, not an empty pane:
  // the tab routes to PreviewPane (previewKindForPath) and the bytes arrive as
  // base64 over taskFileReadBase64. The fixture's committed shot.png is the
  // subject (scripts/e2e-seed.mjs).
  it("previews an image clicked in the tree", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-tree"));
    await ensureActiveTask(taskId);

    await browser.waitUntil(() => rowExists("shot.png"), {
      timeout: 10_000,
      timeoutMsg: "shot.png never appeared in the tree",
    });
    await clickRow("shot.png");

    // The tab opened as an edit tab...
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) => t.type === "edit" && t.path === "shot.png",
            ),
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "clicking the image never opened a tab" },
    );

    // ...and it renders a real, decoded image rather than an empty pane.
    await browser.waitUntil(
      async () => {
        const r = await browser.execute((id) => {
          const pane = document.querySelector(`[data-task-id="${id}"]`);
          const img = pane?.querySelector('img[src^="data:image/"]') as HTMLImageElement | null;
          if (!img) return { found: false, w: 0, h: 0 };
          return { found: true, w: img.naturalWidth, h: img.naturalHeight };
        }, taskId);
        return r.found && r.w > 0 && r.h > 0;
      },
      { timeout: 10_000, timeoutMsg: "the image preview never rendered decoded pixels" },
    );
    await snap("image-preview.png");
  });
});

// P2: the file row's right-click menu hands the file to the OS (GH #147).
// Cases: the two OS actions lead the menu in the agreed order; a binary the
// editor can't render (.blend), a text file it CAN render (.scad) and an image
// with its own in-app viewer (.png) all open externally; a folder offers no
// "Open in default app"; and double-click still PINS rather than launching.
//
// The .scad case is the one that settled the design discussion: it is plain
// text, so the editor renders it perfectly, yet the user still wants OpenSCAD.
// No "is this file renderable" heuristic can express that, which is why this
// lives on an explicit menu entry rather than a gesture.
//
// The e2e binary records opens to a log instead of running them (see
// `open_file_external` in lib.rs): the suite must not launch Blender, and the
// reveal fallback would pop a Finder window over the window under test.
describe("open a file in its default app", () => {
  let taskId!: string;
  const openedLog = path.join(process.cwd(), ".e2e", "profile", "e2e-opened.log");

  after(async () => {
    rmSync(openedLog, { force: true });
    for (const f of ["e2e-model.blend", "e2e-part.scad", "e2e-shot.png"]) {
      rmSync(path.join(fixture, f), { force: true });
    }
    rmSync(path.join(fixture, "e2e-open-dir"), { force: true, recursive: true });
    if (taskId) await archiveTask(taskId);
  });

  const opened = () => {
    try {
      return readFileSync(openedLog, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];   // not written yet — the caller is inside a waitUntil
    }
  };

  // Dispatched, not driven: a WebDriver right-click does not reach Radix's
  // onContextMenu in this WKWebView (measured), the same class of gap as its
  // double-click. A `contextmenu` MouseEvent goes through the real Radix
  // trigger, so everything from the menu opening downwards is genuinely
  // exercised — which the gesture-based version could never claim.
  const openRowMenu = async (rel: string) => {
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (!el) throw new Error(`no row ${sel}`);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, button: 2,
          clientX: r.left + 10, clientY: r.top + 10,
        }),
      );
    }, `[data-path="${rel}"]`);
    await browser.waitUntil(async () => (await menuItems()).length > 0, {
      timeout: 8_000,
      timeoutMsg: `the context menu never opened for ${rel}`,
    });
  };

  // Scoped to the menu that holds the path items, never a bare [role="menu"]:
  // menus stack, and a closing one can linger in the DOM (see the e2e skill).
  //
  // Labels come from innerText, one line per item, NOT from a [role="menuitem"]
  // query: ContextMenuItem passes role={undefined} for plain items (it only
  // sets a role for the radio variant), so the ARIA selector matches nothing.
  const menuItems = () =>
    browser.execute(() => {
      const menu = [...document.querySelectorAll('[role="menu"]')].find((m) =>
        (m as HTMLElement).innerText.includes("Copy path"),
      ) as HTMLElement | undefined;
      if (!menu) return [] as string[];
      return menu.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
    });

  const clickMenuItem = (label: string) =>
    browser.execute((text) => {
      const menu = [...document.querySelectorAll('[role="menu"]')].find((m) =>
        (m as HTMLElement).innerText.includes("Copy path"),
      ) as HTMLElement | undefined;
      if (!menu) throw new Error("the path context menu is not open");
      // Deepest element whose own text is exactly the label, so a wrapper that
      // happens to contain it doesn't get clicked instead.
      const item = [...menu.querySelectorAll("*")]
        .reverse()
        .find((i) => (i as HTMLElement).innerText?.trim() === text) as HTMLElement | undefined;
      if (!item) throw new Error(`no menu item "${text}"`);
      item.click();
    }, label);

  const openExternally = async (rel: string) => {
    rmSync(openedLog, { force: true });
    await openRowMenu(rel);
    await clickMenuItem("Open in default app");
    await browser.waitUntil(() => opened().length > 0, {
      timeout: 8_000,
      timeoutMsg: `"Open in default app" on ${rel} never reached the backend`,
    });
    return opened();
  };

  it("leads the menu with the two OS actions, in order", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // Written BEFORE the task opens, at the repo root, so the tree picks them
    // up on its initial load rather than through a mid-run refresh.
    writeFileSync(path.join(fixture, "e2e-model.blend"), Buffer.from([0x00, 0xff, 0x00]));
    writeFileSync(path.join(fixture, "e2e-part.scad"), "cube([1,1,1]);\n");
    // This describe's own folder, so the dir case does not depend on one that
    // another describe creates in a different task.
    mkdirSync(path.join(fixture, "e2e-open-dir"), { recursive: true });
    // A 1x1 PNG: the routing class with its OWN in-app viewer (previewPaths).
    writeFileSync(
      path.join(fixture, "e2e-shot.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    taskId = await openTask("e2e-open");
    await dismissOverlays();
    await ensureActiveTask(taskId);
    await browser.waitUntil(
      () => browser.execute(() => !!document.querySelector('[data-path="e2e-model.blend"]')),
      { timeout: 15_000, timeoutMsg: "the .blend row never appeared in the tree" },
    );

    await openRowMenu("e2e-model.blend");
    const items = await menuItems();
    expect(items[0]).toBe("Open in default app");
    expect(items[1]).toMatch(/^Reveal in /);
    await snap("file-context-menu.png");
    await browser.keys(["Escape"]);
  });

  it("opens a binary the editor cannot render", async () => {
    // .blend is not valid UTF-8, so clicking it only ever gets the "it looks
    // binary" editor message. The case with no in-app answer at all.
    const paths = (await openExternally("e2e-model.blend")).map((p: string) => p.replace(/\\/g, "/"));
    expect(paths.some((p) => p.endsWith("/e2e-model.blend"))).toBe(true);
    // Absolute, not task-relative: the backend shells out with no task context.
    expect(/^(\/|[A-Za-z]:\/)/.test(paths[paths.length - 1])).toBe(true);
  });

  it("opens a text file the editor renders perfectly well", async () => {
    const paths = (await openExternally("e2e-part.scad")).map((p: string) => p.replace(/\\/g, "/"));
    expect(paths.some((p) => p.endsWith("/e2e-part.scad"))).toBe(true);
  });

  it("opens an image that has its own in-app viewer", async () => {
    // A PNG already previews in the app, so the external open is an ADDITION
    // here. "termic can show it" is not a reason to withhold the real editor.
    const paths = (await openExternally("e2e-shot.png")).map((p: string) => p.replace(/\\/g, "/"));
    expect(paths.some((p) => p.endsWith("/e2e-shot.png"))).toBe(true);
  });

  it("offers no default-app entry for a folder", async () => {
    // `openPath` on a directory already means "open it in the file manager",
    // so a folder would otherwise show the same action twice.
    await openRowMenu("e2e-open-dir");
    const items = await menuItems();
    expect(items).not.toContain("Open in default app");
    expect(items[0]).toMatch(/^Open in /);   // the file-manager entry leads
    await browser.keys(["Escape"]);
  });

  it("keeps double-click as pin, launching nothing", async () => {
    // The convention Simion flagged: single click previews, double click keeps
    // the tab. A regression here would launch an app from a gesture that every
    // major editor uses for pinning.
    rmSync(openedLog, { force: true });
    const previewTabs = () =>
      browser.execute(
        (id) =>
          (window.__termic!.useApp.getState().tabs[id] ?? [])
            .filter((t: any) => t.type === "edit" && t.path === "e2e-part.scad").length,
        taskId,
      );
    await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).click(),
      '[data-path="e2e-part.scad"]',
    );
    // Wait for the tab before the second click: onDoubleClick looks the tab up
    // in the `tabs` array from its own render, so firing both in one
    // synchronous block would hand it a stale list and pin nothing. A real
    // user's two clicks are separated by a re-render; this reproduces that.
    await browser.waitUntil(async () => (await previewTabs()) > 0, {
      timeout: 8_000,
      timeoutMsg: "the first click never opened a preview tab",
    });
    await browser.execute(
      (sel) =>
        (document.querySelector(sel) as HTMLElement).dispatchEvent(
          new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
        ),
      '[data-path="e2e-part.scad"]',
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) => t.type === "edit" && t.path === "e2e-part.scad" && !t.preview,
            ),
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "double-click no longer pins the preview tab" },
    );
    expect(opened()).toEqual([]);
  });
});

// P1: pin folders in the tree for quick access. The row context menu and the
// row's hover pin mark a folder; a collapsible Pinned section over the tree
// same reveal an editor breadcrumb uses: expand ancestors, scroll, ring
// highlight). Pins live on the PROJECT as task-relative paths, so every task
// jumps to it (the rows are inside the tree). Pins are per project, so every
// task
// of fixture-repo sees the same rows. Cases: menu-pin + section-row jump; the row
// pin toggles without expanding; unpin from the chip's own menu; a rename
// follows the pin; a delete keeps it on purpose; pins are shared across the
// project's tasks in pin order.
describe("pin folders for quick access", () => {
  let taskId!: string;
  let task2Id!: string;

  after(async () => {
    if (taskId) await archiveTask(taskId);
    if (task2Id) await archiveTask(task2Id);
    // Pins survive the tasks (they are project state), so the next describe
    // would inherit this one's pins. Clear both the store and the stored
    // JSON — the store only writes through on an action, and the next app
    // launch reads the JSON back.
    await browser.execute(() => {
      window.__termic!.usePinnedFolders.setState({ byProject: {} });
      const doomed = Object.keys(localStorage).filter((k) => k.endsWith("pinnedFolders"));
      for (const k of doomed) localStorage.removeItem(k);
    });
    rmTree(path.join(fixture, "e2e-pins"), { bestEffort: true });
    for (const d of ["e2e-pin-rowdir", "e2e-pin-renameme", "e2e-pin-renamed-ok", "e2e-pin-doomed", "e2e-pin-alpha", "e2e-pin-beta"]) {
      rmSync(path.join(fixture, d), { force: true, recursive: true });
    }
    execSync(`git -C "${fixture}" clean -fd`);
  });

  const rowExists = (p: string) =>
    browser.execute((sel) => !!document.querySelector(sel), `[data-path="${p}"]`);
  const clickRow = (p: string) =>
    browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).click(),
      `[data-path="${p}"]`,
    );
  const pinRowSel = (rel: string) => `[data-testid="pinned-row"][data-pin-path="${rel}"]`;
  const pinRowExists = (rel: string) =>
    browser.execute((sel) => !!document.querySelector(sel), pinRowSel(rel));
  const clickPinRow = (rel: string) =>
    browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).click(),
      pinRowSel(rel),
    );

  // Pin setup through the store, NOT the menu: the menu path is case 1's
  // subject; everything after only needs the pin to exist.
  const pinViaStore = (rel: string) =>
    browser.execute((r) => {
      const proj = window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.usePinnedFolders.getState().pin(proj.id, r);
    }, rel);

  // Same dispatched right-click the default-app describe uses (a WebDriver
  // right-click never reaches Radix's onContextMenu in this WKWebView). The
  // row menu is found by its Copy path items, the pinned-row menu by its unpin item
  // — menus are scoped by content, never a bare [role="menu"] (they stack,
  // and a closing one lingers).
  const openContextMenu = async (sel: string, marker: string) => {
    await browser.execute(
      (s) => {
        const el = document.querySelector(s) as HTMLElement;
        if (!el) throw new Error(`no element ${s}`);
        const r = el.getBoundingClientRect();
        el.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true, cancelable: true, button: 2,
            clientX: r.left + 10, clientY: r.top + 10,
          }),
        );
      },
      sel,
    );
    await browser.waitUntil(
      () =>
        browser.execute((mk) => {
          const menu = [...document.querySelectorAll('[role="menu"]')].find((m) =>
            (m as HTMLElement).innerText.includes(mk),
          );
          return !!menu;
        }, marker),
      { timeout: 8_000, timeoutMsg: `the context menu (${marker}) never opened for ${sel}` },
    );
  };

  const clickMenuItem = (marker: string, label: string) =>
    browser.execute((mk, text) => {
      const menu = [...document.querySelectorAll('[role="menu"]')].find((m) =>
        (m as HTMLElement).innerText.includes(mk),
      ) as HTMLElement | undefined;
      if (!menu) throw new Error(`the ${mk} menu is not open`);
      const item = [...menu.querySelectorAll("*")]
        .reverse()
        .find((i) => (i as HTMLElement).innerText?.trim() === text) as HTMLElement | undefined;
      if (!item) throw new Error(`no menu item "${text}" in the ${mk} menu`);
      item.click();
    }, marker, label);

  const openRowMenu = (rel: string) => openContextMenu(`[data-path="${rel}"]`, "Copy path");

  it("pins a folder from the context menu and the section row jumps back to it", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-pins");
    await dismissOverlays();
    await ensureActiveTask(taskId);

    // A nested folder three levels down, so the jump has real ancestors to
    // re-expand (a root-level pin proves nothing about expansion).
    mkdirSync(path.join(fixture, "e2e-pins", "outer", "inner"), { recursive: true });
    writeFileSync(path.join(fixture, "e2e-pins", "outer", "inner", "note.txt"), "hi\n");
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );

    // Walk down to the target: expand e2e-pins, then outer.
    await browser.waitUntil(() => rowExists("e2e-pins"), {
      timeout: 10_000, timeoutMsg: "the e2e-pins folder never appeared in the tree",
    });
    await clickRow("e2e-pins");
    await browser.waitUntil(() => rowExists("e2e-pins/outer"), {
      timeout: 8_000, timeoutMsg: "expanding e2e-pins never revealed outer",
    });
    await clickRow("e2e-pins/outer");
    await browser.waitUntil(() => rowExists("e2e-pins/outer/inner"), {
      timeout: 8_000, timeoutMsg: "expanding outer never revealed inner",
    });

    await openRowMenu("e2e-pins/outer/inner");
    await clickMenuItem("Copy path", "Pin folder");
    await browser.waitUntil(() => pinRowExists("e2e-pins/outer/inner"), {
      timeout: 8_000, timeoutMsg: "pinning never produced a section row",
    });
    await snap("pinned-section.png");

    // Collapse both ancestors, then jump: the section row must re-expand
    // the whole path and highlight the folder, or it is not quick access.
    await clickRow("e2e-pins/outer");
    await clickRow("e2e-pins");
    await browser.waitUntil(
      async () => (await rowExists("e2e-pins/outer")) === false,
      { timeout: 8_000, timeoutMsg: "collapsing the ancestors never hid inner" },
    );
    await clickPinRow("e2e-pins/outer/inner");
    await browser.waitUntil(() => rowExists("e2e-pins/outer/inner"), {
      timeout: 8_000, timeoutMsg: "clicking the section row never re-expanded the path",
    });
    // The reveal ring is the visible "you are here": box-shadow, while it
    // lasts (1.6s), so poll rather than assert once.
    await browser.waitUntil(
      () =>
        browser.execute((sel) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          return !!el && getComputedStyle(el).boxShadow !== "none";
        }, `[data-path="e2e-pins/outer/inner"]`),
      { timeout: 8_000, timeoutMsg: "the revealed folder never got the reveal highlight" },
    );
    await snap("pinned-reveal.png");
  });

  it("the row's pin toggle marks without expanding", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-pins"));
    await ensureActiveTask(taskId);

    // At the fixture ROOT, so the row renders no matter what an earlier case
    // left expanded: this case is about the toggle, not about tree state.
    mkdirSync(path.join(fixture, "e2e-pin-rowdir"), { recursive: true });
    writeFileSync(path.join(fixture, "e2e-pin-rowdir", "kid.txt"), "k\n");
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          () => !!document.querySelector('[data-testid="pin-folder"][data-path="e2e-pin-rowdir"]'),
        ),
      { timeout: 10_000, timeoutMsg: "the folder row (with its pin toggle) never appeared" },
    );

    const pinToggle = () =>
      browser.execute(
        () => (document.querySelector('[data-testid="pin-folder"][data-path="e2e-pin-rowdir"]') as HTMLElement).click(),
      );
    await pinToggle();
    await browser.waitUntil(() => pinRowExists("e2e-pin-rowdir"), {
      timeout: 8_000, timeoutMsg: "the pin toggle never produced a section row",
    });
    const pinned = await browser.execute(
      () =>
        document.querySelector('[data-testid="pin-folder"][data-path="e2e-pin-rowdir"]')
          ?.getAttribute("data-pinned"),
    );
    expect(pinned).toBe("true");
    // The toggle is not an expand: the folder must stay collapsed. Its child
    // is on disk, so an accidental toggle() would have revealed it.
    expect(await rowExists("e2e-pin-rowdir/kid.txt")).toBe(false);

    await pinToggle();
    await browser.waitUntil(
      async () => (await pinRowExists("e2e-pin-rowdir")) === false,
      { timeout: 8_000, timeoutMsg: "toggling again never removed the section row" },
    );
  });

  it("a pinned row's context menu unpins", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-pins"));
    await pinViaStore("e2e-pin-menudir");
    await browser.waitUntil(() => pinRowExists("e2e-pin-menudir"), {
      timeout: 8_000, timeoutMsg: "the seeded pin never produced a section row",
    });

    await openContextMenu(pinRowSel("e2e-pin-menudir"), "Unpin folder");
    await clickMenuItem("Unpin folder", "Unpin folder");
    await browser.waitUntil(
      async () => (await pinRowExists("e2e-pin-menudir")) === false,
      { timeout: 8_000, timeoutMsg: "the pinned row menu's unpin never removed the row" },
    );
  });

  it("the section folds to its header and back", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-pins"));
    await pinViaStore("e2e-pin-fold");
    await browser.waitUntil(() => pinRowExists("e2e-pin-fold"), {
      timeout: 8_000, timeoutMsg: "the seeded pin never produced a section row",
    });

    const header = () =>
      browser.execute(() => {
        const el = document.querySelector('[data-testid="pinned-section-header"]') as HTMLElement | null;
        return el ? el.getAttribute("data-collapsed") : null;
      });
    const rowCount = () =>
      browser.execute(() => document.querySelectorAll('[data-testid="pinned-row"]').length);

    // Pins from earlier cases in this describe are still in the record (only
    // the last case clears the slate), so assert on THIS pin's row, never on
    // an exact section size.
    await browser.execute(() =>
      (document.querySelector('[data-testid="pinned-section-header"]') as HTMLElement).click(),
    );
    await browser.waitUntil(
      async () => (await header()) === "true" && (await rowCount()) === 0,
      { timeout: 8_000, timeoutMsg: "folding the section never hid its rows" },
    );

    await browser.execute(() =>
      (document.querySelector('[data-testid="pinned-section-header"]') as HTMLElement).click(),
    );
    await browser.waitUntil(
      async () => (await header()) === "false" && (await pinRowExists("e2e-pin-fold")),
      { timeout: 8_000, timeoutMsg: "unfolding the section never brought its rows back" },
    );
  });

  it("renaming the folder follows the pin", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-pins"));
    await ensureActiveTask(taskId);
    // The folder must EXIST for its row to render (the pin alone only makes a
    // section row, and this case drives the tree row's context menu).
    mkdirSync(path.join(fixture, "e2e-pin-renameme"), { recursive: true });
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );
    await browser.waitUntil(() => rowExists("e2e-pin-renameme"), {
      timeout: 10_000, timeoutMsg: "the renameme folder never appeared in the tree",
    });
    await pinViaStore("e2e-pin-renameme");
    await browser.waitUntil(() => pinRowExists("e2e-pin-renameme"), {
      timeout: 8_000, timeoutMsg: "the seeded pin never produced a section row",
    });

    await openRowMenu("e2e-pin-renameme");
    await clickMenuItem("Copy path", "Rename");
    // The row swaps to an inline input that the component focuses; address it
    // by focus, since it carries no test id. The draft starts at the CURRENT
    // folder name — the full `e2e-pin-renameme`, not its last segment.
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const ae = document.activeElement;
          return !!ae && ae.tagName === "INPUT" && (ae as HTMLInputElement).value === "e2e-pin-renameme";
        }),
      { timeout: 8_000, timeoutMsg: "the rename input never took focus" },
    );
    await browser.execute(() => {
      const input = document.activeElement as HTMLInputElement;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "e2e-pin-renamed-ok");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await browser.waitUntil(() => pinRowExists("e2e-pin-renamed-ok"), {
      timeout: 8_000, timeoutMsg: "the pinned row never followed the rename",
    });
    expect(await pinRowExists("e2e-pin-renameme")).toBe(false);
    expect(await pinRowExists("e2e-pin-renamed-ok")).toBe(true);
  });

  it("deleting the folder keeps the pin", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-pins"));
    await ensureActiveTask(taskId);
    mkdirSync(path.join(fixture, "e2e-pin-doomed"), { recursive: true });
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );
    await browser.waitUntil(() => rowExists("e2e-pin-doomed"), {
      timeout: 10_000, timeoutMsg: "the doomed folder never appeared in the tree",
    });
    await pinViaStore("e2e-pin-doomed");

    await openRowMenu("e2e-pin-doomed");
    await clickMenuItem("Copy path", "Remove");
    // The confirm dialog, scoped by its title (dialogs stack; a closing one
    // lingers in the DOM).
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll('[role="dialog"]')].some((d) =>
            (d as HTMLElement).innerText.includes("Delete e2e-pin-doomed?"),
          ),
        ),
      { timeout: 8_000, timeoutMsg: "the delete confirm never opened" },
    );
    await browser.execute(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
        (d as HTMLElement).innerText.includes("Delete e2e-pin-doomed?"),
      ) as HTMLElement;
      const btn = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Delete");
      if (!btn) throw new Error("no Delete button in the confirm dialog");
      (btn as HTMLElement).click();
    });
    await browser.waitUntil(
      async () => (await rowExists("e2e-pin-doomed")) === false,
      { timeout: 8_000, timeoutMsg: "the folder was never deleted" },
    );
    // The pin is kept ON PURPOSE: build dirs come straight back, and a row
    // for a missing folder reveal-no-ops silently.
    expect(await pinRowExists("e2e-pin-doomed")).toBe(true);
    // Clicking it must be a quiet no-op, not a crash: the tree is still there.
    await clickPinRow("e2e-pin-doomed");
    expect(await rowExists("e2e-pins")).toBe(true);
    await snap("pinned-deleted-kept.png");
  });

  it("pins are shared across the project's tasks, in pin order", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-pins"));
    await ensureActiveTask(taskId);
    // Leftovers from the cases above would sit ahead of these in insertion
    // order; clear the slate so the exact order is assertable.
    await browser.execute(() => window.__termic!.usePinnedFolders.setState({ byProject: {} }));
    await pinViaStore("e2e-pin-alpha");
    await pinViaStore("e2e-pin-beta");
    const pinOrder = () =>
      browser.execute(() =>
        [...document.querySelectorAll('[data-testid="pinned-row"]')].map((c) =>
          c.getAttribute("data-pin-path"),
        ),
      );
    await browser.waitUntil(async () => (await pinOrder()).length === 2, {
      timeout: 8_000, timeoutMsg: "the slate was never cleared to exactly two rows",
    });
    expect(await pinOrder()).toEqual(["e2e-pin-alpha", "e2e-pin-beta"]);

    // A second task of the SAME project must show the same pins: that is
    // the entire point of project-scoped pins.
    task2Id = await openTask("e2e-pins-2");
    await ensureActiveTask(task2Id);
    await browser.waitUntil(async () => (await pinOrder()).length === 2, {
      timeout: 8_000, timeoutMsg: "the second task never showed the project's pins",
    });
    expect(await pinOrder()).toEqual(["e2e-pin-alpha", "e2e-pin-beta"]);
  });
});
