import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

declare global {
  interface Window {
    /** The on-screen copy of `sel` in this spec's task (every visited task
     *  stays mounted, so a bare query can land on a hidden one). */
    __mdEditShown?: (sel: string) => HTMLElement | undefined;
  }
}

const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");
const NAME = "e2e-md-edit.md";
const SOURCE = [
  "# Plan",
  "",
  "A paragraph to edit.",
  "",
  "- [ ] first",
  "- [ ] second",
  "",
].join("\n");

// Edits made ON the rendered preview (docs/markdown.md, "Edits"): task
// checkboxes and the block editor, both written through the editor buffer
// with the save-preview-edits policy (on by default).
describe("markdown preview edits", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
    rmSync(path.join(fixture, NAME), { force: true });
  });

  const disk = () => readFileSync(path.join(fixture, NAME), "utf8");
  const tab = () =>
    browser.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (id, name) => (window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.type === "edit" && t.path === name),
      taskId, NAME,
    );
  /** the tab's own editor (not the block editor, which is a .cm-editor too):
   *  its text, or append to it */
  const mainCm = (append?: string) =>
    browser.execute((ins) => {
      const dom = Array.from(document.querySelectorAll(".cm-editor"))
        .find(el => !el.closest(".markdown-body") && el.getBoundingClientRect().width > 0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (dom as unknown as { __cmView?: any })?.__cmView;
      if (!view) throw new Error("CodeMirror e2e hook missing (build with make e2e)");
      if (ins) view.dispatch({ changes: { from: view.state.doc.length, insert: ins } });
      return view.state.doc.toString() as string;
    }, append ?? "");
  const box = (line: number) => `input[data-task-line="${line}"]`;
  /** double-click the heading and type `text` into its block editor */
  const openHeadingEditor = async (text: string) => {
    await browser.execute(() => window.__mdEditShown!(".markdown-body h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await browser.waitUntil(() => browser.execute(() => !!window.__mdEditShown!(".tc-block-editor")), { timeout: 5_000, timeoutMsg: "no block editor on the heading" });
    await browser.execute((text) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = (window.__mdEditShown!(".tc-block-editor .cm-editor") as unknown as { __cmView: any }).__cmView;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    }, text);
  };
  const mod = process.platform === "darwin" ? "metaKey" : "ctrlKey";

  it("opens a markdown file in split view with live checkboxes", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-md-edit");
    writeFileSync(path.join(fixture, NAME), SOURCE);
    await browser.execute((id, name) => {
      window.__mdEditShown = (sel) => Array.from(document.querySelector(`[data-task-id="${id}"]`)!.querySelectorAll<HTMLElement>(sel))
        .find(el => el.getBoundingClientRect().width > 0);
      const app = window.__termic!.useApp.getState();
      app.bumpFsRevision(id);
      app.openPreviewTab(id, { type: "edit", path: name, title: name });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = app.tabs[id].find((x: any) => x.type === "edit" && x.path === name);
      app.persistTab(id, t.id);
      app.setActiveTabId(id, t.id);
      app.patchTab(id, t.id, { mdView: "split" });
    }, taskId, NAME);
    await browser.waitUntil(
      () => browser.execute((s) => !!window.__mdEditShown!(s), box(5)),
      { timeout: 10_000, timeoutMsg: "the preview never rendered the task list" },
    );
    expect(await browser.execute((s) => (window.__mdEditShown!(s) as HTMLInputElement).disabled, box(5))).toBe(false);
    await snap("md-edit-task-list.png");
  });

  it("a checkbox on a clean buffer is written to disk at once", async () => {
    await browser.execute((s) => window.__mdEditShown!(s)!.click(), box(5));
    await browser.waitUntil(() => disk().includes("- [x] first"), {
      timeout: 5_000, timeoutMsg: "the tick never reached the file",
    });
    await browser.waitUntil(async () => (await tab())?.dirty === false, {
      timeout: 5_000, timeoutMsg: "the save never cleared the dirty dot",
    });
    expect(await browser.execute((s) => (window.__mdEditShown!(s) as HTMLInputElement).checked, box(5))).toBe(true);
  });

  it("a checkbox on a dirty buffer stays in the buffer, and ⌘Z / ⌘S from the preview reach the editor", async () => {
    // unsaved typing at the end of the file
    await mainCm("tail\n");
    await browser.waitUntil(async () => (await tab())?.dirty === true, { timeout: 5_000, timeoutMsg: "typing never dirtied the tab" });
    await browser.execute((s) => window.__mdEditShown!(s)!.click(), box(6));
    await browser.waitUntil(
      async () => (await mainCm()).includes("- [x] second"),
      { timeout: 5_000, timeoutMsg: "the tick never reached the buffer" },
    );
    expect(disk()).toContain("- [ ] second");
    expect((await tab())?.dirty).toBe(true);

    const key = (k: string, shift = false) => browser.execute((m, k, shift) => {
      window.__mdEditShown!(".markdown-body")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, [m]: true, bubbles: true }));
    }, mod, k, shift);
    await key("z");
    await browser.waitUntil(
      async () => (await mainCm()).includes("- [ ] second"),
      { timeout: 5_000, timeoutMsg: "⌘Z in the preview did not undo the tick" },
    );
    await key("s");
    await browser.waitUntil(() => disk().includes("tail"), { timeout: 5_000, timeoutMsg: "⌘S in the preview did not save" });
    expect((await tab())?.dirty).toBe(false);
  });

  it("double-clicking a block edits its source in place and saves it", async () => {
    await browser.execute(() => {
      const p = Array.from(window.__mdEditShown!(".markdown-body")!.querySelectorAll("p")).find(el => el.textContent === "A paragraph to edit.")!;
      p.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await browser.waitUntil(() => browser.execute(() => !!window.__mdEditShown!(".tc-block-editor")), {
      timeout: 5_000, timeoutMsg: "the block editor never opened",
    });
    const seeded = await browser.execute(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.__mdEditShown!(".tc-block-editor .cm-editor") as unknown as { __cmView: any }).__cmView.state.doc.toString());
    expect(seeded).toBe("A paragraph to edit.");
    // it sits in the text column it replaced, not pinned to the pane's left
    const edges = await browser.execute(() => {
      const r = (el: Element) => el.getBoundingClientRect();
      const ed = r(window.__mdEditShown!(".tc-block-editor")!), h1 = r(window.__mdEditShown!(".markdown-body h1")!);
      return { left: Math.round(ed.left - h1.left), right: Math.round(ed.right - h1.right) };
    });
    expect(edges).toEqual({ left: 0, right: 0 });
    await snap("md-edit-block-editor.png");
    await browser.execute(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = (window.__mdEditShown!(".tc-block-editor .cm-editor") as unknown as { __cmView: any }).__cmView;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "An *edited* paragraph." } });
      Array.from(window.__mdEditShown!(".tc-block-editor")!.querySelectorAll("button")).find(b => b.textContent === "Save")!.click();
    });
    await browser.waitUntil(() => disk().includes("An *edited* paragraph."), { timeout: 5_000, timeoutMsg: "the block edit never reached the file" });
    expect(await browser.execute(() => !window.__mdEditShown!(".tc-block-editor")
      && !!window.__mdEditShown!(".markdown-body em"))).toBe(true);
  });

  it("an agent rewriting the block under the editor shows the conflict, and Use mine wins", async () => {
    await openHeadingEditor("# Mine");
    // the agent: write the file and tick the settle revision, which reloads
    // a clean buffer silently
    writeFileSync(path.join(fixture, NAME), disk().replace("# Plan", "# Theirs"));
    await browser.execute((id) => window.__termic!.useApp.getState().bumpFsRevision(id), taskId);
    await browser.waitUntil(
      () => browser.execute(() => window.__mdEditShown!(".tc-block-editor-conflict")?.hidden === false),
      { timeout: 8_000, timeoutMsg: "the conflict bar never showed" },
    );
    await snap("md-edit-block-conflict.png");
    await browser.execute(() =>
      Array.from(window.__mdEditShown!(".tc-block-editor")!.querySelectorAll("button")).find(b => b.textContent === "Use mine")!.click());
    await browser.waitUntil(() => disk().startsWith("# Mine\n"), { timeout: 5_000, timeoutMsg: "Use mine never reached the file" });
    expect(disk()).not.toContain("Theirs");
  });

  it("an agent change reaching past the block loses it: Copy mine, and the file is untouched", async () => {
    await openHeadingEditor("# Yours");
    // a line added above AND the heading rewritten: the old line numbers now
    // hold the agent's text, so writing there would clobber it
    const theirs = disk().replace("# Mine\n", "intro from the agent\n\n# Theirs again\n");
    writeFileSync(path.join(fixture, NAME), theirs);
    await browser.execute((id) => window.__termic!.useApp.getState().bumpFsRevision(id), taskId);
    await browser.waitUntil(
      () => browser.execute(() => Array.from(window.__mdEditShown!(".tc-block-editor")?.querySelectorAll("button") ?? [])
        .some(b => b.textContent === "Copy mine")),
      { timeout: 8_000, timeoutMsg: "the lost bar never offered Copy mine" },
    );
    await snap("md-edit-block-lost.png");
    await browser.execute(() =>
      Array.from(window.__mdEditShown!(".tc-block-editor")!.querySelectorAll("button")).find(b => b.textContent === "Copy mine")!.click());
    await browser.waitUntil(() => browser.execute(() => !window.__mdEditShown!(".tc-block-editor")),
      { timeout: 5_000, timeoutMsg: "Copy mine did not close the editor" });
    expect(disk()).toBe(theirs);
  });

  it("a checkbox never saves over an agent's write the buffer has not seen", async () => {
    // mid-turn: the file moves on and nothing settles, so the clean buffer
    // is behind it. A save of that buffer would silently undo the agent.
    const theirs = disk() + "agent line\n";
    writeFileSync(path.join(fixture, NAME), theirs);
    const second = await browser.execute(() =>
      Array.from(window.__mdEditShown!(".markdown-body")!.querySelectorAll<HTMLInputElement>("input[data-task-line]"))
        .find(b => b.closest("li")?.textContent?.includes("second"))!.dataset.taskLine!);
    await browser.execute((s) => window.__mdEditShown!(s)!.click(), box(Number(second)));
    await browser.waitUntil(
      () => browser.execute((id) => (document.querySelector(`[data-task-id="${id}"]`)?.textContent ?? "").includes("This file changed on disk"), taskId),
      { timeout: 5_000, timeoutMsg: "the changed-on-disk banner never showed" },
    );
    expect(disk()).toBe(theirs);
    expect(await mainCm()).toContain("- [x] second");
    expect((await tab())?.dirty).toBe(true);
    // Reload takes the agent's file and drops the tick
    await browser.execute((id) => Array.from(document.querySelector(`[data-task-id="${id}"]`)!.querySelectorAll("button"))
      .find(b => b.textContent === "Reload")!.click(), taskId);
    await browser.waitUntil(async () => (await mainCm()).includes("agent line"), { timeout: 5_000, timeoutMsg: "Reload never took the file" });
    expect((await tab())?.dirty).toBe(false);
  });

  const previewKey = (k: string) => browser.execute((m, k) => {
    window.__mdEditShown!(".markdown-body")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, [m]: true, bubbles: true }));
  }, mod, k);
  const lineOf = (text: string) => browser.execute((text) =>
    Number(Array.from(window.__mdEditShown!(".markdown-body")!.querySelectorAll<HTMLInputElement>("input[data-task-line]"))
      .find(b => b.closest("li")?.textContent?.includes(text))!.dataset.taskLine), text);

  it("⌘Z in the preview after an auto-saved tick unticks the file too, not just the buffer", async () => {
    const was = disk().includes("- [x] first");
    await browser.execute((s) => window.__mdEditShown!(s)!.click(), box(await lineOf("first")));
    const ticked = was ? "- [ ] first" : "- [x] first", back = was ? "- [x] first" : "- [ ] first";
    await browser.waitUntil(() => disk().includes(ticked), { timeout: 5_000, timeoutMsg: "the tick never reached the file" });
    await previewKey("z");
    await browser.waitUntil(() => disk().includes(back), { timeout: 5_000, timeoutMsg: "⌘Z in the preview left the file ticked" });
    await browser.waitUntil(async () => (await tab())?.dirty === false, { timeout: 5_000, timeoutMsg: "the undo save never cleared the dirty dot" });
  });

  it("⌘S refuses to write over a file that moved on, and Keep mine lets the next save win", async () => {
    await mainCm("my typing\n");
    await browser.waitUntil(async () => (await tab())?.dirty === true, { timeout: 5_000, timeoutMsg: "typing never dirtied the tab" });
    const theirs = disk() + "agent two\n";
    writeFileSync(path.join(fixture, NAME), theirs);
    await previewKey("s");
    const banner = () => browser.execute((id) => (document.querySelector(`[data-task-id="${id}"]`)?.textContent ?? "").includes("This file changed on disk"), taskId);
    await browser.waitUntil(banner, { timeout: 5_000, timeoutMsg: "⌘S over a newer file showed no banner" });
    expect(disk()).toBe(theirs);
    expect((await tab())?.dirty).toBe(true);
    await browser.execute((id) => Array.from(document.querySelector(`[data-task-id="${id}"]`)!.querySelectorAll("button"))
      .find(b => b.textContent === "Keep mine")!.click(), taskId);
    await browser.waitUntil(async () => !(await banner()), { timeout: 5_000, timeoutMsg: "Keep mine left the banner up" });
    await previewKey("s");
    await browser.waitUntil(() => disk().includes("my typing"), { timeout: 5_000, timeoutMsg: "the save after Keep mine never wrote" });
    expect(disk()).not.toContain("agent two");
    expect(disk()).toBe(await mainCm());
    expect((await tab())?.dirty).toBe(false);
  });
});
