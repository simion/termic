import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell, waitGone, waitVisible } from "../helpers";

// Find in terminal (TerminalFindBar): every match is highlighted as soon as
// the query changes, the current one is marked apart, and a count says where
// you are. Same bar in an agent/shell tab and in the footer shell.
//
// Terminal text is on a WebGL canvas, but the search addon's highlights are
// real DOM decorations (`.xterm-find-result-decoration`), so those are what is
// counted. The current match is a SEPARATE decoration drawn over its plain
// one, told apart by its outline (`activeMatchBorder`): addon-search 0.16
// never applies its own `xterm-find-active-result-decoration` class, it passes
// `false` for it unconditionally. So N matches are N plain + 1 outlined.
describe("find in terminal", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  // Prints "mark" three times. The command line itself reads `m\x61rk`, so the
  // echo of what was typed never counts as a match.
  const PRINT_THREE = `printf 'm\\x61rk\\n%.0s' 1 2 3`;
  const MAIN = "find-shell";
  const mainScope = () => `[data-task-id="${taskId}"] [data-main-tab-id="${MAIN}"]`;
  const bottomScope = () => `[data-task-id="${taskId}"] [data-bottom-split]`;

  /** Dispatch to the scope's visible xterm textarea, the path a real key
   *  takes. keyup matters: xterm latches on keydown and drops the next input
   *  until it sees one. */
  const key = (scope: string, init: KeyboardEventInit) =>
    browser.execute((sel, k) => {
      const ta = [...document.querySelectorAll<HTMLTextAreaElement>(`${sel} .xterm-helper-textarea`)]
        .find(el => (el.closest(".xterm") ?? el).getBoundingClientRect().width > 0);
      if (!ta) throw new Error(`no visible terminal in ${sel}`);
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...k }));
      ta.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, ...k }));
    }, scope, init as any);

  const typeInTerminal = (scope: string, text: string) =>
    browser.execute((sel, t) => {
      const ta = [...document.querySelectorAll<HTMLTextAreaElement>(`${sel} .xterm-helper-textarea`)]
        .find(el => (el.closest(".xterm") ?? el).getBoundingClientRect().width > 0);
      if (!ta) throw new Error(`no visible terminal in ${sel}`);
      ta.focus();
      ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: t, bubbles: true }));
    }, scope, text);

  const run = async (scope: string, line: string) => {
    await typeInTerminal(scope, line);
    await key(scope, { key: "Enter", code: "Enter", keyCode: 13, which: 13 } as KeyboardEventInit);
  };

  /** Get the fixture's three lines on screen with find open on "mark".
   *
   *  Retried, in BOTH terminals: a line typed before the shell is listening is
   *  lost, and neither terminal has a store field that says its prompt is
   *  ready (the agent tab's `lastOutputAt` only proves the shell wrote
   *  something, which on a slow runner is its first prompt paint and not yet
   *  a shell reading stdin). `clear` wipes screen AND scrollback, so a slow
   *  first attempt cannot double the count. This is what failed on CI while
   *  passing here: the count read "No results" because the command never ran.
   */
  const showFixture = async (scope: string) => {
    await openFind(scope);
    await waitVisible(`${scope} [data-testid="terminal-find"]`);
    await setQuery(scope, "mark");
    await browser.waitUntil(async () => {
      if ((await state(scope)).label?.endsWith("of 3")) return true;
      await findKey(scope, { key: "Escape" });
      await waitGone(`${scope} [data-testid="terminal-find"]`);
      await run(scope, `clear; ${PRINT_THREE}`);
      await openFind(scope);
      await setQuery(scope, "mark");
      // A bounded wait on the condition itself, not a sleep: the addon
      // re-searches 200ms after output lands.
      return browser.waitUntil(
        async () => (await state(scope)).label?.endsWith("of 3") ?? false,
        { timeout: 3_000, interval: 100 },
      ).then(() => true, () => false);
    }, { timeout: 40_000, interval: 100, timeoutMsg: `${scope} never printed the fixture` });
  };

  // ⌘F on macOS; Ctrl+Alt+F elsewhere, since plain Ctrl+F is the shell's and
  // Ctrl+Shift+F is find-in-files (isTerminalFindCombo).
  const openFind = (scope: string) => key(scope, process.platform === "darwin"
    ? { key: "f", code: "KeyF", metaKey: true }
    : { key: "f", code: "KeyF", ctrlKey: true, altKey: true });

  /** Set the find input the way typing does (React tracks the native setter). */
  const setQuery = (scope: string, q: string) =>
    browser.execute((sel, v) => {
      const input = document.querySelector<HTMLInputElement>(`${sel} [data-testid="terminal-find"] input`);
      if (!input) throw new Error("find input not found");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, scope, q);

  const findKey = (scope: string, init: KeyboardEventInit) =>
    browser.execute((sel, k) => {
      const input = document.querySelector<HTMLInputElement>(`${sel} [data-testid="terminal-find"] input`)!;
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...k }));
    }, scope, init as any);

  const state = (scope: string) =>
    browser.execute((sel) => {
      const decos = [...document.querySelectorAll<HTMLElement>(`${sel} .xterm-find-result-decoration`)];
      return {
        label: document.querySelector(`${sel} [data-testid="terminal-find-count"]`)?.textContent ?? null,
        all: decos.filter(d => !d.style.outline).length,
        active: decos.filter(d => !!d.style.outline).length,
      };
    }, scope);

  /** `label` is exact, or a RegExp where the position is not the point. */
  const waitState = (scope: string, want: { label: string | RegExp | null; all: number; active: number }, msg: string) =>
    browser.waitUntil(async () => {
      const s = await state(scope);
      const labelOk = want.label instanceof RegExp ? want.label.test(s.label ?? "") : s.label === want.label;
      return labelOk && s.all === want.all && s.active === want.active;
    }, { timeout: 10_000, timeoutMsg: msg }).catch(async (e) => {
      throw new Error(`${e.message}: saw ${JSON.stringify(await state(scope))}`);
    });

  const currentIndex = async (scope: string) =>
    Number(/^(\d+) of/.exec((await state(scope)).label ?? "")?.[1] ?? NaN);

  it("highlights every match as you type and marks the current one", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-terminal-find");
    await browser.execute((id, t) => {
      window.__termic!.useApp.getState().addTab(id, { id: t, type: "terminal", cli: "shell", title: t } as any);
    }, taskId, MAIN);
    await browser.waitUntil(async () => !!(await browser.execute(
      (id, t) => (window.__termic!.useApp.getState().tabs[id] ?? []).find((x: any) => x.id === t)?.lastOutputAt,
      taskId, MAIN,
    )), { timeout: 20_000, timeoutMsg: "the shell never drew a prompt" });

    await run(mainScope(), PRINT_THREE);
    await showFixture(mainScope());
    // All three at once, one of them current. Output that lands after the
    // query is picked up too, so this holds even if printf was slow.
    await waitState(mainScope(), { label: /^[123] of 3$/, all: 3, active: 1 }, "not every match was highlighted");
    await snap("terminal-find.png");
  });

  it("Enter and Shift+Enter move the current match, the rest stay lit", async () => {
    // Wait for PTY output to settle before asserting keyboard navigation.
    // lastOutputAt includes a trailing update for output bursts, and the
    // search addon may refresh its matches after parsed output.
    await browser.waitUntil(async () => browser.execute((id, tabId) => {
      const tab = (window.__termic!.useApp.getState().tabs[id] ?? [])
        .find((t: { id: string; lastOutputAt?: number | null }) => t.id === tabId);
      return !!tab?.lastOutputAt && Date.now() - tab.lastOutputAt > 750;
    }, taskId, MAIN), { timeout: 10_000, timeoutMsg: "terminal output did not settle before find navigation" });
    const start = await currentIndex(mainScope());
    const next = (start % 3) + 1;
    await findKey(mainScope(), { key: "Enter" });
    await waitState(mainScope(), { label: `${next} of 3`, all: 3, active: 1 }, "Enter did not advance");
    await findKey(mainScope(), { key: "Enter", shiftKey: true });
    await waitState(mainScope(), { label: `${start} of 3`, all: 3, active: 1 }, "Shift+Enter did not go back");
  });

  it("no match and an empty query both clear the highlights", async () => {
    await setQuery(mainScope(), "markzz");
    await waitState(mainScope(), { label: "No results", all: 0, active: 0 }, "a query with no match left highlights");
    await setQuery(mainScope(), "mark");
    await waitState(mainScope(), { label: /^[123] of 3$/, all: 3, active: 1 }, "matches did not come back");
    await setQuery(mainScope(), "");
    await waitState(mainScope(), { label: null, all: 0, active: 0 }, "an empty query left highlights");
  });

  it("Escape clears the highlights, and reopening lights them again at once", async () => {
    await setQuery(mainScope(), "mark");
    await waitState(mainScope(), { label: /^[123] of 3$/, all: 3, active: 1 }, "matches did not come back");
    await findKey(mainScope(), { key: "Escape" });
    await waitGone(`${mainScope()} [data-testid="terminal-find"]`);
    await waitState(mainScope(), { label: null, all: 0, active: 0 }, "closing find left highlights behind");

    await openFind(mainScope());
    await waitVisible(`${mainScope()} [data-testid="terminal-find"]`);
    expect(await browser.execute(
      (sel) => document.querySelector<HTMLInputElement>(`${sel} [data-testid="terminal-find"] input`)?.value,
      mainScope(),
    )).toBe("mark");
    await waitState(mainScope(), { label: /^[123] of 3$/, all: 3, active: 1 }, "a kept query was not highlighted on reopen");
    await findKey(mainScope(), { key: "Escape" });
    await waitGone(`${mainScope()} [data-testid="terminal-find"]`);
  });

  it("the footer shell has the same find", async () => {
    await browser.execute((id) => window.__termic!.useApp.getState().toggleTerminalSplit(id), taskId);
    await browser.waitUntil(async () => browser.execute((sel) =>
      [...document.querySelectorAll(`${sel} .xterm-helper-textarea`)]
        .some(el => (el.closest(".xterm") ?? el).getBoundingClientRect().width > 0), bottomScope()),
    { timeout: 20_000, timeoutMsg: "the footer shell never rendered" });

    await run(bottomScope(), PRINT_THREE);
    await showFixture(bottomScope());
    await waitState(bottomScope(), { label: /^[123] of 3$/, all: 3, active: 1 }, "the footer shell's matches were not highlighted");
    // Its own bar: the main tab's stays closed.
    expect(await browser.execute((sel) => !!document.querySelector(`${sel} [data-testid="terminal-find"]`), mainScope())).toBe(false);
    await findKey(bottomScope(), { key: "Escape" });
    await waitState(bottomScope(), { label: null, all: 0, active: 0 }, "closing the footer's find left highlights");
  });

  // Focus is nearly always in a terminal, so find-in-files has to work from
  // one. Off macOS its key, Ctrl+Shift+F, used to be the terminal's own find,
  // which left find-in-files unreachable by keyboard from an agent tab.
  it("the find-in-files key from a terminal opens Find in files, not the terminal's find", async () => {
    await key(mainScope(), process.platform === "darwin"
      ? { key: "f", code: "KeyF", metaKey: true, shiftKey: true }
      : { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true });
    try {
      await browser.waitUntil(
        () => browser.execute((id) => window.__termic!.useUI.getState().findInFilesTaskId === id, taskId),
        { timeout: 8_000, timeoutMsg: "the find-in-files key in a terminal did not open Find in files" },
      );
      expect(await browser.execute((sel) => !!document.querySelector(`${sel} [data-testid="terminal-find"]`), mainScope())).toBe(false);
    } finally {
      await browser.execute(() => window.__termic!.useUI.setState({ findInFilesTaskId: null }));
    }
  });
});
