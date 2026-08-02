import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { archiveTask, dismissOverlays, ensureActiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

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
  let taskId: string | undefined;
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
  let taskId: string | undefined;
  after(async () => {
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeFileFinder(),
    );
    if (taskId) await archiveTask(taskId);
  });

  it("opens and lists the repo's files", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-finder");
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
});

// P1: find-in-files (⇧⌘F) streams git-grep results. Cases: opens with an
// input; a query that matches the fixture README returns a result row.
describe("find in files", () => {
  let taskId: string | undefined;
  after(async () => {
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeFindInFiles(),
    );
    if (taskId) await archiveTask(taskId);
  });

  const inputSel = 'input[placeholder^="Find in"]';

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

  it("returns a match for a query present in the repo", async () => {
    // "fixture" is in the committed README ("# e2e fixture").
    await browser.execute((s) => {
      const input = document.querySelector(s) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "fixture");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, inputSel);

    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("[data-row]")].some((r) =>
            r.textContent?.toLowerCase().includes("readme"),
          ),
        ),
      { timeout: 10_000, timeoutMsg: "no result row for the query" },
    );
    await snap("find-in-files.png");
  });
});

// P1: the file tree. Guards expanding/collapsing a folder. Creates a throwaway
// nested file so there's a folder to toggle, then git-cleans it away.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

describe("file tree", () => {
  let taskId: string | undefined;
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
});

// P2: double-clicking a file row hands it to the OS default app (GH #147).
// Cases: a binary the editor can't render (.blend) and a text file the editor
// CAN render (.scad) both fire the external open — that is the whole point of
// the branch choice, since restricting it to unreadable files would have
// missed .scad, where the user wants OpenSCAD rather than the source again.
// Plus the negative: an ordinary single click must NOT launch anything.
//
// SCOPE, and why the clicks below are synthetic. WebDriver cannot express a
// double-click in this WKWebView: a driven `doubleClick()` emits two `click`
// events with `detail: 0` and NO `dblclick` at all (measured). So no spec can
// prove the OS-level gesture arrives; these dispatch the click the handler
// actually reads (`detail: 2`) and cover everything downstream of it — the
// branch, the path handed to the backend, and the single-click regression.
// The gesture itself is a manual check.
//
// The e2e binary records the open instead of running it (see
// `open_file_external` in lib.rs): the suite must not launch Blender, and the
// reveal fallback would pop a Finder window over the window under test.
describe("open a file in its default app", () => {
  let taskId: string | undefined;
  const openedLog = path.join(process.cwd(), ".e2e", "profile", "e2e-opened.log");

  after(async () => {
    rmSync(openedLog, { force: true });
    rmSync(path.join(fixture, "e2e-model.blend"), { force: true });
    rmSync(path.join(fixture, "e2e-part.scad"), { force: true });
    rmSync(path.join(fixture, "e2e-shot.png"), { force: true });
    if (taskId) await archiveTask(taskId);
  });

  const opened = () => {
    try {
      return readFileSync(openedLog, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];   // not written yet — the caller is inside a waitUntil
    }
  };

  // `detail` is the UA's click count; 2 is the second click of a pair, which
  // is what FileTree reads instead of a dblclick handler (see the comment on
  // its onClick for why).
  const clickRowWithDetail = (rel: string, detail: number) =>
    browser.execute(
      (sel, d) => {
        const el = document.querySelector(sel) as HTMLElement;
        if (!el) throw new Error(`no row ${sel}`);
        el.dispatchEvent(new MouseEvent("click", { detail: d, bubbles: true, cancelable: true }));
      },
      `[data-path="${rel}"]`,
      detail,
    );

  const doubleClickRow = async (rel: string) => {
    rmSync(openedLog, { force: true });
    await clickRowWithDetail(rel, 2);
    await browser.waitUntil(() => opened().length > 0, {
      timeout: 8_000,
      timeoutMsg: `double-clicking ${rel} never reached open_file_external`,
    });
    return opened();
  };

  it("opens a binary the editor cannot render", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // Written BEFORE the task opens, at the repo root, so the tree picks them
    // up on its initial load rather than through a mid-run refresh.
    writeFileSync(path.join(fixture, "e2e-model.blend"), Buffer.from([0x00, 0xff, 0x00]));
    writeFileSync(path.join(fixture, "e2e-part.scad"), "cube([1,1,1]);\n");
    // A 1x1 PNG: the third routing class, the one with its OWN in-app viewer
    // (previewPaths → PreviewPane) rather than the editor.
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

    // .blend is not valid UTF-8, so a single click only ever gets the "it
    // looks binary" editor message. The case with no in-app answer at all.
    const paths = await doubleClickRow("e2e-model.blend");
    expect(paths.some((p) => p.endsWith("/e2e-model.blend"))).toBe(true);
    // Absolute, not task-relative: the backend shells out with no task context.
    expect(paths[paths.length - 1].startsWith("/")).toBe(true);
    await snap("file-open-default-app.png");
  });

  it("opens a text file the editor renders perfectly well", async () => {
    // .scad is plain text — the editor shows it fine, and that is exactly why
    // "only for files the editor can't render" was the wrong rule.
    const paths = await doubleClickRow("e2e-part.scad");
    expect(paths.some((p) => p.endsWith("/e2e-part.scad"))).toBe(true);
  });

  it("opens an image that has its own in-app viewer", async () => {
    // A PNG already previews inside the app, so this is the case where the
    // external open is a genuine ADDITION rather than the only way to see the
    // file. It must still fire: "the app can show it" is not a reason to keep
    // the user from opening it in a real image editor.
    const paths = await doubleClickRow("e2e-shot.png");
    expect(paths.some((p) => p.endsWith("/e2e-shot.png"))).toBe(true);
  });

  it("still routes a single click to the in-app preview pane", async () => {
    // The other half of the PNG case: single click must NOT launch anything,
    // it must open the tab the preview pane renders (previewPaths routes on
    // extension, so the tab is an "edit" tab that PreviewPane picks up).
    rmSync(openedLog, { force: true });
    await clickRowWithDetail("e2e-shot.png", 1);
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) => t.type === "edit" && t.path === "e2e-shot.png",
            ),
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "a single click no longer opens the image tab" },
    );
    expect(opened()).toEqual([]);
  });

  it("opens the editor tab on a single click, launching nothing", async () => {
    // The other half of the branch: single click keeps its old job, and must
    // NOT hand the file to the OS. A regression here would launch an app on
    // every click in the tree.
    rmSync(openedLog, { force: true });
    await clickRowWithDetail("e2e-part.scad", 1);
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) => t.type === "edit" && t.path === "e2e-part.scad",
            ),
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "a single click no longer opens the editor tab" },
    );
    expect(opened()).toEqual([]);
  });
});
