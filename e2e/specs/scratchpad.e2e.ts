import { rmSync } from "node:fs";
import path from "node:path";
import {
  archiveTask, cliRpc, ensureActiveTask, openTask, requireTermicApi, snap, waitForAppShell, waitVisible,
} from "../helpers";

/** The seeded repo every spec shares (scripts/e2e-seed.mjs). */
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

// Scratchpads (GH #244): Sublime-style untitled buffers scoped to one task.
//
// The rule everything here checks: a pad is an unsaved buffer that happens to
// survive restarts. ⌘S does NOT write to the scratch store, it PROMOTES the
// pad into the project; closing one asks; Discard is the only thing that
// deletes it.

/** The task's scratch tabs, straight from the store. */
const pads = (taskId: string) =>
  browser.execute(
    (id) => (window.__termic!.useApp.getState().tabs[id] ?? [])
      .filter((t: any) => t.type === "scratch")
      .map((t: any) => ({ id: t.id, scratchId: t.scratchId, title: t.title, dirty: t.dirty, type: t.type })),
    taskId,
  );

const tabById = (taskId: string, tabId: string) =>
  browser.execute(
    (id, tid) => (window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.id === tid),
    taskId, tabId,
  );

/** Type into the pad's CodeMirror through the view API the e2e build exposes.
 *  Synthetic key events don't route to a contenteditable reliably in
 *  WKWebView, so the editor's own API is the honest input path here. */
async function typeInPad(text: string) {
  await browser.execute((t) => {
    const el = document.querySelector(".cm-editor") as unknown as { __cmView?: any };
    const view = el?.__cmView;
    if (!view) throw new Error("CodeMirror e2e hook missing (build with make e2e)");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } });
  }, text);
}

/** Click a button in the dialog whose text contains `title`. Scoped to that
 *  dialog: dialogs stack, and a bare [role="dialog"] can grab a stale one. */
async function clickInDialog(title: string, testId: string) {
  await browser.waitUntil(
    () => browser.execute((t) => [...document.querySelectorAll('[role="dialog"]')]
      .some(d => (d.textContent ?? "").includes(t)), title),
    { timeout: 10_000, timeoutMsg: `dialog "${title}" never appeared` },
  );
  await browser.execute((t, sel) => {
    const dlg = [...document.querySelectorAll('[role="dialog"]')]
      .find(d => (d.textContent ?? "").includes(t));
    (dlg!.querySelector(`[data-testid="${sel}"]`) as HTMLElement).click();
  }, title, testId);
}

describe("scratchpads", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
    // The promote case writes notes/from-scratchpad.json into the shared
    // fixture repo. The seed heals TRACKED files only, by design, so an
    // untracked file left here survives into the next run and the git spec's
    // "Working tree is clean" boots red for a reason that has nothing to do
    // with git. Untracked dirt is the spec's to clean.
    rmSync(path.join(fixture, "notes"), { recursive: true, force: true, maxRetries: 10 });
  });

  it("opens from the + menu as an untitled, permanently-dirty tab", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-scratchpad");

    // Open the "+" menu the way ⌘T does: TabBar listens for this event, so
    // the spec does not depend on where the button sits in the strip.
    await browser.execute((id) => {
      window.dispatchEvent(new CustomEvent("termic-new-tab-menu", { detail: { taskId: id } }));
    }, taskId);
    // The "+" menu is a Radix dropdown; its rows are portalled.
    await browser.waitUntil(
      () => browser.execute(() => !!document.querySelector('[data-testid="new-scratchpad"]')),
      { timeout: 10_000, timeoutMsg: "the + menu never offered Scratchpad" },
    );
    await browser.execute(() => {
      (document.querySelector('[data-testid="new-scratchpad"]') as HTMLElement).click();
    });

    await browser.waitUntil(async () => (await pads(taskId)).length === 1, {
      timeout: 10_000, timeoutMsg: "no scratchpad tab appeared",
    });
    const [pad] = await pads(taskId);
    expect(pad.title).toBe("Untitled");
    // The dot is honest: nothing has been saved anywhere the user chose.
    expect(pad.dirty).toBe(true);
    await snap("scratchpad-new.png");
  });

  it("builds its title from the buffer and sniffs the syntax", async () => {
    await ensureActiveTask(taskId);
    await browser.waitUntil(
      () => browser.execute(() => !!(document.querySelector(".cm-editor") as any)?.__cmView),
      { timeout: 10_000, timeoutMsg: "the pad's editor never mounted" },
    );
    await typeInPad("# Fix\n\nthe resume race\n- then ship it");

    // Debounced (~500ms) and bailed when unchanged — hence a condition, not a
    // sleep. Several lines are folded in until the cap: a jotted note's first
    // line is routinely one word, and a pill reading "Fix" would not tell two
    // pads apart. Blank lines vanish and the heading/bullet marks are stripped
    // per line, because a pill can least afford the punctuation.
    await browser.waitUntil(
      async () => (await pads(taskId))[0]?.title === "Fix the resume race then ship it",
      { timeout: 10_000, timeoutMsg: "the title never followed the buffer" },
    );

    // Replace the buffer with JSON. With no path to go on, the content
    // sniffer is the only thing that CAN name the syntax, and the button is
    // where the user sees its answer. (The title honestly becomes "{" here —
    // that is the first line with anything on it.)
    await typeInPad('{\n  "fix": "the resume race",\n  "then": "ship it"\n}');
    await browser.waitUntil(
      () => browser.execute((id) => (
        document.querySelector(`[data-task-id="${id}"] [data-testid="syntax-button"]`)?.textContent ?? ""
      ).toUpperCase().includes("JSON"), taskId),
      { timeout: 10_000, timeoutMsg: "the syntax button never named JSON" },
    );
    // Leaving markdown swaps the markdown shell for the plain editor, which
    // REMOUNTS it, and the button names JSON before the new view exists. That
    // view focuses itself on load; if the next case has opened the syntax
    // picker by then, the focus leaves the non-modal dialog and Radix closes
    // it. Measured: the view landed ~25ms after the button changed, and a
    // picker opened in that gap was gone 500ms later with focus in
    // cm-content. Wait for the new view, and for the focus it takes.
    await browser.waitUntil(
      () => browser.execute((id) => {
        const root = document.querySelector(`[data-task-id="${id}"]`);
        return !!(root?.querySelector(".cm-editor") as { __cmView?: unknown } | null)?.__cmView
          && !!document.activeElement?.closest(".cm-editor");
      }, taskId),
      { timeout: 10_000, timeoutMsg: "the JSON pad's editor never remounted and took focus" },
    );
  });

  it("takes a manual syntax pick and persists it in the index", async () => {
    await ensureActiveTask(taskId);
    // The picker is the ONLY way to name a pad's language when the sniffer
    // has nothing to go on, so it has to accept a scratch tab: it used to
    // filter to `type === "edit"` and silently no-op here.
    // Click until the picker is actually open, and read that from the STORE
    // rather than the DOM. A click that lands while React is mid-commit on
    // this pane is simply lost, and waiting on the dialog instead used to
    // spend the whole timeout on a picker nothing had opened. The store flag
    // is the thing the button sets, so it cannot be confused by a closing
    // palette an earlier spec file left mounted (animations are frozen while
    // the window is occluded, so those husks outlive their close).
    await browser.waitUntil(
      () => browser.execute((id) => {
        if (window.__termic!.useUI.getState().syntaxPaletteFor) return true;
        const btn = document.querySelector(
          `[data-task-id="${id}"] [data-testid="syntax-button"]`,
        ) as HTMLElement | null;
        btn?.click();
        return false;
      }, taskId),
      { timeout: 10_000, interval: 250, timeoutMsg: "the syntax button never opened the picker" },
    );
    // The list arrives with the languageExts chunk, so the rows are a beat
    // behind the dialog. Wait for the row, not for the frame around it.
    const markdownRow = '[data-testid="syntax-palette"] [data-lang="Markdown"]';
    await waitVisible(markdownRow);
    // Pick until the pick TAKES, for the reason the button above is clicked
    // until the picker opens: the rows are re-rendered when the languageExts
    // chunk lands, and a click on a row that is being replaced is lost. One
    // click and a wait failed a full run with "the manual pick never reached
    // the syntax button", on a picker that was open with the row in it. Each
    // pass re-opens the picker if the lost click's dialog has gone, then
    // clicks the row that is there now. Keyed by CodeMirror's registry NAME,
    // which is also the label.
    await browser.waitUntil(
      () => browser.execute((id, sel) => {
        const btn = document.querySelector(
          `[data-task-id="${id}"] [data-testid="syntax-button"]`,
        ) as HTMLElement | null;
        if ((btn?.textContent ?? "").toLowerCase().includes("markdown")) return true;
        const row = document.querySelector(sel) as HTMLElement | null;
        if (row) row.click();
        else if (!window.__termic!.useUI.getState().syntaxPaletteFor) btn?.click();
        return false;
      }, taskId, markdownRow),
      { timeout: 10_000, interval: 250, timeoutMsg: "the manual pick never reached the syntax button" },
    );

    // Picking Markdown also earns the pad the source / preview / split shell
    // a `.md` file gets: the pad has no extension, so the pick is how you say
    // "this is a document", and the toggle is most of what that buys you.
    await browser.waitUntil(
      () => browser.execute((id) => !!document.querySelector(
        `[data-task-id="${id}"] [data-testid="source-preview-shell"]`), taskId),
      { timeout: 10_000, timeoutMsg: "a markdown pad never got the preview shell" },
    );
    // The preview renders from the LIVE buffer, not from disk: there is no
    // file yet, so nothing else could feed it.
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? []).find((t: any) => t.type === "scratch");
      app.patchTab(id, tab.id, { mdView: "preview" });
    }, taskId);
    await browser.waitUntil(
      () => browser.execute((id) => (
        document.querySelector(`[data-task-id="${id}"] [data-testid="source-preview-shell"]`) as HTMLElement | null
      )?.innerText?.includes("the resume race") ?? false, taskId),
      { timeout: 10_000, timeoutMsg: "the markdown preview never rendered the buffer" },
    );
    // Back to source, so the ⌘S case below types into a visible editor.
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? []).find((t: any) => t.type === "scratch");
      app.patchTab(id, tab.id, { mdView: "source" });
    }, taskId);

    // Persisted in the scratch index, unlike an edit tab's session-only pick:
    // a pad has no extension to re-derive it from after a relaunch. Stored as
    // the registry NAME, which is what the index holds from now on (a pad
    // written by an older build still says "markdown"; normalizeLanguageId
    // translates it on read, see docs/tech-debt.md).
    const pad = (await pads(taskId))[0];
    await browser.waitUntil(
      async () => {
        const listed = await browser.execute(
          (id) => window.__termic!.ipc.scratchList(id), taskId,
        ) as { id: string; syntax?: string }[];
        return listed.find(r => r.id === pad.scratchId)?.syntax === "Markdown";
      },
      { timeout: 10_000, timeoutMsg: "the manual pick never reached the scratch index" },
    );
  });

  it("Cancel on close keeps both the tab and the pad", async () => {
    await ensureActiveTask(taskId);
    const [pad] = await pads(taskId);
    // The strip's × — the real close path, shared with the pane × and ⌘W.
    await browser.execute((tid) => {
      (document.querySelector(`[data-tab-id="${tid}"] button[title="Close tab"]`) as HTMLElement).click();
    }, pad.id);

    await clickInDialog("Close this scratchpad?", "scratch-close-cancel");
    expect((await pads(taskId)).length).toBe(1);
  });

  it("Cmd+S promotes it into the project and the tab becomes a real file", async () => {
    await ensureActiveTask(taskId);
    const [pad] = await pads(taskId);

    await browser.execute(() => {
      document.querySelector(".cm-content")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, bubbles: true }),
      );
    });
    await browser.waitUntil(
      () => browser.execute(() => !!document.querySelector('[data-testid="scratch-save-path"]')),
      { timeout: 10_000, timeoutMsg: "Cmd+S never opened the save picker" },
    );

    // Name it ourselves rather than trusting the prefilled slug: the point of
    // the picker is that the user chooses the place.
    await browser.execute(() => {
      const el = document.querySelector('[data-testid="scratch-save-path"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, "notes/from-scratchpad.json");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.execute(() => {
      (document.querySelector('[data-testid="scratch-save-confirm"]') as HTMLElement).click();
    });

    // The pad is gone, and the SAME tab is now an ordinary edit tab on the
    // path the user picked.
    await browser.waitUntil(async () => (await pads(taskId)).length === 0, {
      timeout: 10_000, timeoutMsg: "the pad never stopped being a pad",
    });
    const tab = await tabById(taskId, pad.id) as any;
    expect(tab.type).toBe("edit");
    expect(tab.path).toBe("notes/from-scratchpad.json");
    // The one path that ends a pad's permanent dirty state.
    expect(tab.dirty).toBe(false);

    // It is really on disk, inside the worktree, with the buffer's contents.
    const onDisk = await browser.execute(
      (id) => window.__termic!.ipc.taskFileRead(id, "notes/from-scratchpad.json"),
      taskId,
    );
    expect(onDisk).toContain("the resume race");

    // ...and git can see it, which is the whole reason pads are stored
    // outside the worktree until this moment.
    await browser.waitUntil(
      async () => {
        const status = await browser.execute(
          (id) => window.__termic!.ipc.taskGitStatus(id), taskId,
        ) as any;
        return JSON.stringify(status).includes("from-scratchpad.json");
      },
      { timeout: 10_000, timeoutMsg: "the promoted file never showed up in git status" },
    );
    await snap("scratchpad-promoted.png");
  });

  it("a bulk close asks about every pad, and Cancel spares that one", async () => {
    await ensureActiveTask(taskId);
    // Three pads, closed as a set through the tab context menu's own
    // "Close others" — the shared bulk path behind it and "Close to the
    // right". The clicked tab always survives both, so the agent tab is the
    // one right-clicked and all three pads are in the set.
    for (let i = 0; i < 3; i++) {
      await browser.execute(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "n", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, altKey: true, bubbles: true,
        }));
      });
      await browser.waitUntil(async () => (await pads(taskId)).length === i + 1, {
        timeout: 10_000, timeoutMsg: `pad ${i + 1} never appeared`,
      });
    }
    const before = await pads(taskId);
    const agentTabId = await browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? [])
        .find((t: any) => t.type === "terminal")?.id as string,
      taskId,
    ) as string;

    // Dispatched, not gestured: a WebDriver right-click does not reach
    // Radix's onContextMenu in this WKWebView (see tabs-layout.e2e.ts).
    await browser.execute((tid) => {
      const el = document.querySelector(`[data-tab-id="${tid}"]`) as HTMLElement;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2,
        clientX: r.left + 10, clientY: r.top + 10,
      }));
    }, agentTabId);
    await browser.waitUntil(
      () => browser.execute(() => [...document.querySelectorAll('[role="menu"]')]
        .some(m => (m as HTMLElement).innerText.includes("Close others"))),
      { timeout: 8_000, timeoutMsg: "the tab context menu never opened" },
    );
    await browser.execute(() => {
      const menu = [...document.querySelectorAll('[role="menu"]')]
        .find(m => (m as HTMLElement).innerText.includes("Close others")) as HTMLElement;
      const row = [...menu.children]
        .find(el => (el as HTMLElement).innerText?.trim().startsWith("Close others")) as HTMLElement;
      row.click();
    });

    // ONE prompt per pad, in strip order: discard, cancel, discard. A single
    // click must never decide the fate of three unsaved notes.
    await clickInDialog("Close this scratchpad?", "scratch-close-discard");
    await clickInDialog("Close this scratchpad?", "scratch-close-cancel");
    await clickInDialog("Close this scratchpad?", "scratch-close-discard");

    await browser.waitUntil(async () => (await pads(taskId)).length === 1, {
      timeout: 10_000, timeoutMsg: "the bulk close did not leave exactly the spared pad",
    });
    // Cancel spared THAT pad; the rest of the set still closed.
    expect((await pads(taskId))[0].scratchId).toBe(before[1].scratchId);
    const listed = await browser.execute(
      (id) => window.__termic!.ipc.scratchList(id), taskId,
    ) as { id: string }[];
    expect(listed.map(r => r.id)).toEqual([before[1].scratchId]);

    // Clear the survivor so the next case starts from an empty strip.
    await browser.execute((tid) => {
      (document.querySelector(`[data-tab-id="${tid}"] button[title="Close tab"]`) as HTMLElement).click();
    }, before[1].id);
    await clickInDialog("Close this scratchpad?", "scratch-close-discard");
    await browser.waitUntil(async () => (await pads(taskId)).length === 0, {
      timeout: 10_000, timeoutMsg: "the spared pad never closed",
    });
  });

  it("Discard on close deletes the pad for good", async () => {
    await ensureActiveTask(taskId);
    // A fresh pad, straight through the shortcut path this time.
    await browser.execute(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "n", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, altKey: true, bubbles: true,
      }));
    });
    await browser.waitUntil(async () => (await pads(taskId)).length === 1, {
      timeout: 10_000, timeoutMsg: "the shortcut never created a scratchpad",
    });
    const [pad] = await pads(taskId);

    await browser.execute((tid) => {
      (document.querySelector(`[data-tab-id="${tid}"] button[title="Close tab"]`) as HTMLElement).click();
    }, pad.id);
    await clickInDialog("Close this scratchpad?", "scratch-close-discard");

    await browser.waitUntil(async () => (await pads(taskId)).length === 0, {
      timeout: 10_000, timeoutMsg: "Discard never closed the tab",
    });
    // Gone from the index too, so a relaunch does not bring it back.
    const listed = await browser.execute(
      (id) => window.__termic!.ipc.scratchList(id), taskId,
    ) as any[];
    expect(listed.some(r => r.id === pad.scratchId)).toBe(false);
  });
});

// `termic scratchpad` over the real control socket: an agent writes notes the human
// reads. The pad opens without taking focus, and a write to an OPEN pad lands
// in its editor at once rather than behind it on disk.
describe("scratchpads from the CLI", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  // The pad is the active tab when this is read, so the laid-out editor in
  // this task is its editor.
  const editorText = (_padTabId: string) => browser.execute((id) => {
    const ed = [...document.querySelectorAll(`[data-task-id="${id}"] .cm-editor`)]
      .find((el) => el.getBoundingClientRect().width > 0) as (HTMLElement & { __cmView?: any }) | undefined;
    return ed?.__cmView?.state.doc.toString() ?? null;
  }, taskId) as Promise<string | null>;

  it("creates a titled pad without stealing focus, and lists it", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-scratchpad-cli");
    const activeBefore = await browser.execute((id) => window.__termic!.useApp.getState().activeTab[id], taskId);

    const r = await cliRpc({ cmd: "pad_new", task: taskId, title: "Findings", content: "# Findings\n" });
    expect(r.ok).toBe(true);
    expect(r.data.kind).toBe("pad");
    const padId = r.data.pads[0].id as string;
    expect(r.data.pads[0]).toMatchObject({ title: "Findings", open: true });

    await browser.waitUntil(async () => (await pads(taskId)).some((p: any) => p.scratchId === padId), {
      timeout: 10_000, timeoutMsg: "pad_new never opened a tab",
    });
    const activeAfter = await browser.execute((id) => window.__termic!.useApp.getState().activeTab[id], taskId);
    expect(activeAfter).toBe(activeBefore);

    const l = await cliRpc({ cmd: "pad_list", task: taskId });
    expect(l.data.pads.map((p: any) => p.id)).toContain(padId);
  });

  it("rings the pad's tab when an agent changes it behind your back, until you look", async () => {
    const [pad] = (await pads(taskId)).filter((p: any) => p.title === "Findings");
    // The visible tab strip's copy of the pill (every visited task stays
    // mounted, so scope to this task and a laid-out element).
    const ring = () => browser.execute((id, tid) => {
      const pill = [...document.querySelectorAll(`[data-task-id="${id}"] [data-tab-id="${tid}"]`)]
        .find((el) => el.getBoundingClientRect().width > 0);
      return !!pill?.querySelector('[data-testid="pad-unseen"]');
    }, taskId, pad.id) as Promise<boolean>;
    // Created by the agent while another tab was in front: ringed.
    await browser.waitUntil(ring, { timeout: 5_000, timeoutMsg: "a pad the agent created was not marked unseen" });
    await snap("scratchpad-unseen-ring.png");

    // Looking at it clears the ring: a real click on the pill.
    await browser.execute((id, tid) => {
      const pill = [...document.querySelectorAll(`[data-task-id="${id}"] [data-tab-id="${tid}"]`)]
        .find((el) => el.getBoundingClientRect().width > 0) as HTMLElement;
      pill.click();
    }, taskId, pad.id);
    await browser.waitUntil(async () => !(await ring()), { timeout: 5_000, timeoutMsg: "showing the pad did not clear its ring" });

    // Away on another tab, the agent appends: the ring is back.
    const ids = await browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).map((t: any) => t.id as string), taskId,
    ) as string[];
    const other = ids.find((t) => t !== pad.id)!;
    await browser.execute((id, t) => window.__termic!.useApp.getState().setActiveTabId(id, t), taskId, other);
    const w = await cliRpc({ cmd: "pad_write", task: taskId, pad: pad.scratchId, content: "- more\n", append: true });
    expect(w.ok).toBe(true);
    await browser.waitUntil(ring, { timeout: 5_000, timeoutMsg: "an append while you were elsewhere did not ring the pad" });
    // No cleanup for the next case: it seeds its own content now. Left as a
    // reset of THIS case's append so the pad is in a known state either way.
    await cliRpc({ cmd: "pad_write", task: taskId, pad: pad.scratchId, content: "# Findings\n" });
  });

  it("writes into the OPEN pad live, and reads back the human's edits", async () => {
    const [pad] = (await pads(taskId)).filter((p: any) => p.title === "Findings");
    // SEEDED HERE, not inherited. This used to assert on content the previous
    // case put back on its way out, so the case failed on the Linux runner
    // saying "the editor never loaded the seeded text" when the truth was that
    // a different case had not finished leaving it there. A case that depends
    // on its neighbour's cleanup reports its neighbour's timing as its own bug.
    const w0 = await cliRpc({ cmd: "pad_write", task: taskId, pad: pad.scratchId, content: "# Findings\n" });
    expect(w0.ok).toBe(true);
    await browser.execute((id, tid) => window.__termic!.useApp.getState().setActiveTabId(id, tid), taskId, pad.id);
    // The last thing the editor actually held, so the failure says WHICH of
    // the two happened: null is "no CodeMirror on screen yet", a mount too
    // slow, and anything else is content that arrived wrong. Those want
    // different fixes and one message covered both.
    let seen: string | null = null;
    await browser.waitUntil(
      async () => (seen = await editorText(pad.id)) === "# Findings\n",
      {
        timeout: 10_000,
        timeoutMsg: `the pad's editor never loaded the seeded text (held: ${JSON.stringify(seen)})`,
      },
    );

    const w = await cliRpc({ cmd: "pad_write", task: taskId, pad: "findings", content: "- first result\n", append: true });
    expect(w.ok).toBe(true);
    await browser.waitUntil(async () => (await editorText(pad.id)) === "# Findings\n- first result\n", {
      timeout: 5_000, timeoutMsg: "an append to an open pad did not show in its editor",
    });
    await snap("scratchpad-cli-live-write.png");

    // The human types; a read sees it before any flush could have run.
    await browser.execute((id, t) => {
      const ed = [...document.querySelectorAll(`[data-task-id="${id}"] .cm-editor`)]
        .find((el) => el.getBoundingClientRect().width > 0) as (HTMLElement & { __cmView?: any });
      const view = ed.__cmView;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } });
    }, taskId, "# Findings\n- first result\n- my note\n");
    const rd = await cliRpc({ cmd: "pad_read", task: taskId, pad: pad.scratchId });
    expect(rd.data.content).toBe("# Findings\n- first result\n- my note\n");

    // A replace is on disk too, for whoever reads the closed pad later.
    await cliRpc({ cmd: "pad_write", task: taskId, pad: pad.scratchId, content: "replaced\n" });
    await browser.waitUntil(async () => (await editorText(pad.id)) === "replaced\n", {
      timeout: 5_000, timeoutMsg: "a replace did not reach the open editor",
    });
    // Waited for, not read once. A write to an OPEN pad does not touch the
    // file: scratchCli's writePad hands the text to the live editor and
    // returns, and the disk copy is that editor's own flush, still in flight
    // when the CLI replies. It must also land AFTER the flush of the edit
    // above: scratch_write runs on a blocking pool, and before EditorPane
    // chained its flushes the older text could land last and stay there for
    // good, which is how this failed on a Linux runner.
    await browser.waitUntil(
      async () => (await browser.execute((id, sid) => window.__termic!.ipc.scratchRead(id, sid), taskId, pad.scratchId)) === "replaced\n",
      { timeout: 8_000, timeoutMsg: "the replace never reached the file behind the open editor" },
    );
  });

  // Picking Markdown swaps EditorPane for MarkdownPane, which mounts a new
  // CodeMirror that reads the file before it can take writes. A write in that
  // gap used to go to disk behind the new editor's back: the editor showed
  // the old text, and its next flush wrote the old text over the append. The
  // "writes into the OPEN pad live" case above tripped on it about one run in
  // six, because a `# Findings` pad sniffs as Markdown. This lands the write in
  // the gap on purpose.
  it("a write during the Markdown remount reaches the editor and survives its flush", async () => {
    const r = await cliRpc({ cmd: "pad_new", task: taskId, title: "Remount", content: "plain notes\n" });
    const scratchId = r.data.pads[0].id as string;
    let tabId = "";
    await browser.waitUntil(async () => {
      tabId = (await pads(taskId)).find((p: any) => p.scratchId === scratchId)?.id ?? "";
      return !!tabId;
    }, { timeout: 10_000, timeoutMsg: "pad_new never opened a tab" });
    await browser.execute((id, tid) => window.__termic!.useApp.getState().setActiveTabId(id, tid), taskId, tabId);
    await browser.waitUntil(async () => (await editorText(tabId)) === "plain notes\n", {
      timeout: 10_000, timeoutMsg: "the pad's editor never loaded",
    });

    await browser.execute(async (id, tid, sid) => {
      const t = window.__termic!;
      t.useApp.getState().patchTab(id, tid, { syntax: "Markdown" });
      await t.padHandler({ taskId: id, op: "write", pad: sid, content: "- appended\n", append: true });
    }, taskId, tabId, scratchId);

    const want = "plain notes\n- appended\n";
    await browser.waitUntil(async () => (await editorText(tabId)) === want, {
      timeout: 5_000, timeoutMsg: "the write made during the remount never reached the editor",
    });
    // The editor's own flush must not put the pre-write text back.
    await browser.execute((id) => {
      const ed = [...document.querySelectorAll(`[data-task-id="${id}"] .cm-editor`)]
        .find((el) => el.getBoundingClientRect().width > 0) as (HTMLElement & { __cmView?: any });
      const view = ed.__cmView;
      view.dispatch({ changes: { from: view.state.doc.length, insert: "- typed\n" } });
    }, taskId);
    // Read the FILE, not `pad_read`: that returns the open buffer, which is
    // right whatever the flush did.
    await browser.waitUntil(async () =>
      (await browser.execute((id, sid) => window.__termic!.ipc.scratchRead(id, sid), taskId, scratchId)) === `${want}- typed\n`, {
      timeout: 5_000, timeoutMsg: "the pad's file lost the write made during the remount",
    });
  });

  it("refuses an unknown pad by name", async () => {
    const r = await cliRpc({ cmd: "pad_read", task: taskId, pad: "no-such-pad" });
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain("no-such-pad");
  });
});

// `termic scratchpad rm` and `clear` over the real control socket: an agent
// tidies up the notes it wrote. Removing is the one pad verb that takes
// something away from the human, so these assert on what they can see (the
// tab strip) as well as on what the CLI is told.
describe("removing scratchpads from the CLI", () => {
  let taskId!: string;
  let otherId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
    if (otherId) await archiveTask(otherId);
  });

  const padIds = async (id: string) =>
    ((await cliRpc({ cmd: "pad_list", task: id })).data.pads as any[]).map(p => p.id as string);
  const newPad = async (id: string, title: string, content: string) =>
    (await cliRpc({ cmd: "pad_new", task: id, title, content })).data.pads[0].id as string;

  it("removes an open pad: its tab goes, the list drops it, and the rest stay", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-scratchpad-rm");
    const gone = await newPad(taskId, "Throwaway", "delete me\n");
    const kept = await newPad(taskId, "Keeper", "keep me\n");
    await browser.waitUntil(async () => (await pads(taskId)).length === 2, {
      timeout: 10_000, timeoutMsg: "the two pads never opened as tabs",
    });

    // By title, case-insensitively, the same selector read and write take.
    const r = await cliRpc({ cmd: "pad_remove", task: taskId, pad: "throwaway" });
    expect(r.ok).toBe(true);
    expect(r.data.kind).toBe("pad");
    expect(r.data.pads.map((p: any) => p.id)).toEqual([gone]);

    await browser.waitUntil(async () => (await pads(taskId)).map((p: any) => p.scratchId).join() === kept, {
      timeout: 10_000, timeoutMsg: "the removed pad's tab is still in the strip",
    });
    expect(await padIds(taskId)).toEqual([kept]);
  });

  it("does not come back: the closing editor does not write the pad back to disk", async () => {
    // The failure this guards: delete the file while an editor still holds
    // the buffer, and its last flush recreates the note a moment later. A
    // further write to ANOTHER pad drives the same disk path, after which the
    // removed pad is still nowhere: not in the index, not readable.
    const [kept] = await padIds(taskId);
    expect((await cliRpc({ cmd: "pad_write", task: taskId, pad: kept, content: "more\n", append: true })).ok).toBe(true);
    expect(await padIds(taskId)).toEqual([kept]);
    const r = await cliRpc({ cmd: "pad_read", task: taskId, pad: "Throwaway" });
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain("Throwaway");
  });

  it("refuses a pad that is not there, and removes nothing", async () => {
    const before = await padIds(taskId);
    const r = await cliRpc({ cmd: "pad_remove", task: taskId, pad: "no-such-pad" });
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain("no-such-pad");
    expect(await padIds(taskId)).toEqual(before);
  });

  it("clear removes every pad of that task and no other task's", async () => {
    otherId = await openTask("e2e-scratchpad-rm-other", false);
    const theirs = await newPad(otherId, "Theirs", "not yours\n");
    await newPad(taskId, "Second", "two\n");
    const mine = await padIds(taskId);
    expect(mine.length).toBe(2);

    const r = await cliRpc({ cmd: "pad_clear", task: taskId });
    expect(r.ok).toBe(true);
    expect((r.data.pads as any[]).map(p => p.id).sort()).toEqual([...mine].sort());

    await browser.waitUntil(async () => (await pads(taskId)).length === 0, {
      timeout: 10_000, timeoutMsg: "clear left pad tabs in the strip",
    });
    expect(await padIds(taskId)).toEqual([]);
    expect(await padIds(otherId)).toEqual([theirs]);

    // Nothing left is an answer, not an error.
    const again = await cliRpc({ cmd: "pad_clear", task: taskId });
    expect(again.ok).toBe(true);
    expect(again.data.pads).toEqual([]);
  });
});
