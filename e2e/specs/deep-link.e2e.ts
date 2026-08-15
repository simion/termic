import {
  archiveTask,
  requireTermicApi,
  snap,
  waitForAppShell,
  waitVisible,
} from "../helpers";

// `termic://` deep links (GH #192). An external system opens Termic on a New
// Task dialog that is already filled in; the user reviews it and confirms.
//
// WebDriver cannot ask macOS to open a URL scheme (that half is
// LaunchServices, outside the app), so these specs hand `handleDeepLink` the
// same raw URL string Rust queues. Everything downstream of that — parse,
// project resolution, dialog seeding, create, prompt delivery — is the real
// code path.
//
// The load-bearing case is `does NOT create anything on its own`: the entire
// security argument for accepting a prompt from an untrusted URL is that a
// human sees it and presses Create. If that ever regresses, any web page
// could feed an agent instructions the user never read.

/** The New Task dialog, found by its name input rather than a bare
 *  [role="dialog"] (dialogs stack, and a closing one can linger). */
const NAME_INPUT = '[role="dialog"] input[placeholder="fix login bug"]';

/** Fire a raw termic:// URL at the app the way Rust's queue drain would. */
async function openLink(url: string): Promise<void> {
  await browser.execute((u) => window.__termic!.deepLink.handleDeepLink(u), url);
}

/** The dialog's seeded state, read off the DOM the user is looking at. */
async function dialogState(): Promise<{
  open: boolean;
  name: string;
  prompt: string;
  mode: string | null;
}> {
  return browser.execute((sel) => {
    const dlg = document.querySelector(sel)?.closest('[role="dialog"]');
    if (!dlg) return { open: false, name: "", prompt: "", mode: null };
    const name = (dlg.querySelector(sel.replace('[role="dialog"] ', "")) as HTMLInputElement)?.value ?? "";
    const prompt = (dlg.querySelector("textarea") as HTMLTextAreaElement)?.value ?? "";
    // The task-type toggle marks its active pill with the accent background.
    const active = [...dlg.querySelectorAll("button")].find(
      (b) =>
        ["Main checkout", "Worktree"].includes(b.textContent?.trim() ?? "")
        && b.className.includes("accent-deep"),
    );
    return { open: true, name, prompt, mode: active?.textContent?.trim() ?? null };
  }, NAME_INPUT);
}

async function closeDialog(): Promise<void> {
  await browser.execute(() => window.__termic!.useUI.getState().closeNewTask());
}

describe("termic:// deep links", () => {
  let projectName: string;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    projectName = await browser.execute(
      () =>
        window.__termic!.useApp.getState().projects
          .find((p: any) => p.name === "fixture-repo")!.name as string,
    );
  });

  afterEach(async () => {
    await closeDialog();
  });

  it("opens the New Task dialog pre-filled from the URL", async () => {
    await openLink(
      `termic://new?project=${projectName}&name=from-a-link`
        + `&prompt=${encodeURIComponent("summarized ticket body")}`,
    );
    await waitVisible(NAME_INPUT);

    const s = await dialogState();
    expect(s.name).toBe("from-a-link");
    expect(s.prompt).toBe("summarized ticket body");
    await snap("deep-link-prefilled");
  });

  // THE security property. A link is an untrusted cross-application channel:
  // it may fill the form, it may never submit it.
  it("does NOT create anything on its own", async () => {
    const before = await browser.execute(
      () => window.__termic!.useApp.getState().tasks.length as number,
    );
    await openLink(`termic://new?project=${projectName}&name=never-created&p=do-something`);
    await waitVisible(NAME_INPUT);

    // Give the app room to misbehave: settle the store, then re-read. A
    // create would have to round-trip IPC + loadAll, so a same-tick read
    // could pass even on a regression.
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    const after = await browser.execute(
      () => window.__termic!.useApp.getState().tasks as any[],
    );
    expect(after.length).toBe(before);
    expect(after.some((t: any) => t.name === "never-created")).toBe(false);
  });

  it("seeds the task type when the link asks for a worktree", async () => {
    await openLink(`termic://new?project=${projectName}&worktree=1&name=wt-link`);
    await waitVisible(NAME_INPUT);
    expect((await dialogState()).mode).toBe("Worktree");
  });

  it("seeds the main checkout when the link asks for one", async () => {
    await openLink(`termic://new?project=${projectName}&mode=main&name=main-link`);
    await waitVisible(NAME_INPUT);
    expect((await dialogState()).mode).toBe("Main checkout");
  });

  // A second link while the dialog is ALREADY up for the same project. The
  // window raises either way, so if the form doesn't re-seed the user is
  // looking at the FIRST ticket's name and prompt while believing they are
  // looking at the second — the worst possible failure for a flow whose whole
  // safety argument is "a human read what is on screen before pressing
  // Create". Nothing else about the link changes, which is why the store
  // stamps every open with a nonce.
  it("re-seeds when a second link arrives for the same project", async () => {
    await openLink(
      `termic://new?project=${projectName}&name=first-ticket`
        + `&prompt=${encodeURIComponent("first body")}`,
    );
    await waitVisible(NAME_INPUT);
    expect((await dialogState()).name).toBe("first-ticket");

    await openLink(
      `termic://new?project=${projectName}&name=second-ticket`
        + `&prompt=${encodeURIComponent("second body")}&worktree=1`,
    );
    await browser.waitUntil(
      async () => (await dialogState()).name === "second-ticket",
      { timeout: 5_000, timeoutMsg: "the second link left the first link's name on screen" },
    );
    const s = await dialogState();
    expect(s.prompt).toBe("second body");
    // Every seeded field follows, not just the name.
    expect(s.mode).toBe("Worktree");
  });

  it("warns when the link's base branch has no ref in the repo", async () => {
    // Not a refusal: create fetches the base first, so a branch that exists
    // only on an unfetched remote is legitimate. What was wrong was the
    // SILENCE — the failure landed seconds later as a git error with nothing
    // tying it back to the URL.
    await openLink(`termic://new?project=${projectName}&worktree=1&base=no-such-branch&name=bad-base`);
    await waitVisible(NAME_INPUT);
    await waitVisible('[data-testid="base-unknown"]');
    const warning = await browser.execute(() =>
      (document.querySelector('[data-testid="base-unknown"]') as HTMLElement).innerText);
    expect(warning).toContain("no-such-branch");

    // A base that DOES resolve stays quiet.
    await closeDialog();
    await openLink(`termic://new?project=${projectName}&worktree=1&base=main&name=good-base`);
    await waitVisible(NAME_INPUT);
    await browser.waitUntil(
      async () =>
        browser.execute(() => !document.querySelector('[data-testid="base-unknown"]')),
      { timeout: 5_000, timeoutMsg: "a real branch was flagged as unknown" },
    );
  });

  it("says so when the link's agent isn't installed here", async () => {
    await closeDialog();
    await openLink(`termic://new?project=${projectName}&agent=doesnotexist&name=missing-agent`);
    await waitVisible(NAME_INPUT);
    await waitVisible('[data-testid="agent-unknown"]');
    const warning = await browser.execute(() =>
      (document.querySelector('[data-testid="agent-unknown"]') as HTMLElement).innerText);
    expect(warning).toContain("doesnotexist");
    // Still a usable dialog: the fallback pick stands, nothing is blocked.
    expect((await dialogState()).name).toBe("missing-agent");
  });

  it("refuses a worktree value it cannot read, instead of silently flipping the task type", async () => {
    await closeDialog();
    await openLink(`termic://new?project=${projectName}&worktree=sideways&name=typo-link`);
    // No dialog at all — same treatment `mode=sideways` already got.
    await browser.waitUntil(
      async () => !(await dialogState()).open,
      { timeout: 5_000, timeoutMsg: "an unreadable worktree value still opened the dialog" },
    );
  });

  it("leaves the prompt editable before the user confirms", async () => {
    await openLink(`termic://new?project=${projectName}&p=${encodeURIComponent("original text")}`);
    await waitVisible(NAME_INPUT);
    await browser.execute(() => {
      const ta = document
        .querySelector('[role="dialog"] input[placeholder="fix login bug"]')
        ?.closest('[role="dialog"]')
        ?.querySelector("textarea") as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(ta, "edited by the user");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect((await dialogState()).prompt).toBe("edited by the user");
  });

  it("accepts a prompt at the cap and rejects one past it", async () => {
    const cap = await browser.execute(
      () => window.__termic!.deepLink.MAX_PROMPT_CHARS as number,
    );
    // Exactly at the cap still opens, fully seeded.
    await openLink(`termic://new?project=${projectName}&p=${"x".repeat(cap)}`);
    await waitVisible(NAME_INPUT);
    expect((await dialogState()).prompt).toHaveLength(cap);
    await closeDialog();

    // One over: rejected outright, and it SAYS so. Rejecting beats
    // truncating — half a prompt is worse than none, because the user
    // would have to notice the missing tail themselves.
    await browser.execute(() => window.__termic!.useUI.setState({ toasts: [] }));
    await openLink(`termic://new?project=${projectName}&p=${"x".repeat(cap + 1)}`);
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const t = window.__termic!.useUI.getState().toasts;
          return ((t[t.length - 1]?.msg as string) ?? "").includes("Prompt is too long");
        }),
      { timeout: 5_000, timeoutMsg: "an over-cap prompt did not report why it was refused" },
    );
    expect((await dialogState()).open).toBe(false);
  });
});

describe("termic:// deep links — rejected links", () => {
  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
  });

  /** Latest toast text, which is where a rejected link reports itself. */
  const lastToast = async (): Promise<string> =>
    browser.execute(() => {
      const t = window.__termic!.useUI.getState().toasts;
      return (t[t.length - 1]?.msg as string) ?? "";
    });

  const expectRejected = async (url: string, needle: string) => {
    await browser.execute(() => window.__termic!.useUI.setState({ toasts: [] }));
    await browser.execute((u) => window.__termic!.deepLink.handleDeepLink(u), url);
    await browser.waitUntil(async () => (await lastToast()).includes(needle), {
      timeout: 5_000,
      timeoutMsg: `expected a toast containing "${needle}", got "${await lastToast()}"`,
    });
    // Nothing opened: a rejected link must be inert, not half-applied.
    const open = await browser.execute(
      () => window.__termic!.useUI.getState().newTaskProjectId !== null,
    );
    expect(open).toBe(false);
  };

  // A link naming a project the user never registered must fail loudly. The
  // dangerous alternatives are silently adding the repo, or falling back to
  // "the first project" and aiming an agent at the wrong codebase.
  it("refuses an unregistered project instead of guessing one", async () => {
    await expectRejected("termic://new?project=not-a-real-project", "No project named");
  });

  it("refuses a link with no project", async () => {
    await expectRejected("termic://new", "needs a project");
  });

  it("refuses an unknown action rather than defaulting to new", async () => {
    await expectRejected("termic://archive?project=fixture-repo", "Unknown termic:// action");
  });

  it("refuses an open link for a task that does not exist", async () => {
    await expectRejected("termic://open?task=no-such-task", "No open task named");
  });

  it("refuses a foreign scheme", async () => {
    await expectRejected("https://evil.example/new?project=fixture-repo", "Unsupported scheme");
  });
});

// `termic://open` is the other half of the PM loop: the same ticket button
// that created the task links back to it later, using the name it supplied.
// Navigation only, so unlike `new` it acts immediately with no dialog.
describe("termic://open", () => {
  let taskId: string;
  const NAME = "e2e-open-target";

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    // Create the target through the app's own IPC (fast, no wizard).
    taskId = await browser.execute(async (name) => {
      const t = window.__termic!;
      const proj = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
      const task = await t.invoke("task_open_repo", {
        projectId: proj.id, cli: "shell", name, sandbox: null,
      });
      await t.useApp.getState().loadAll();
      return task.id as string;
    }, NAME);
    // Park somewhere else so "it selected the task" means something.
    await browser.execute(() => window.__termic!.useApp.getState().setActiveTask(null));
  });

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const activeTask = async (): Promise<string | null> =>
    browser.execute(() => window.__termic!.useApp.getState().activeTaskId ?? null);

  it("selects the task by name, with no dialog to confirm", async () => {
    await browser.execute(
      (n) => window.__termic!.deepLink.handleDeepLink(`termic://open?project=fixture-repo&task=${n}`),
      NAME,
    );
    await browser.waitUntil(async () => (await activeTask()) === taskId, {
      timeout: 10_000,
      timeoutMsg: "termic://open never selected the task",
    });
    // Navigation changes nothing, so nothing should be asking for confirmation.
    const dialogOpen = await browser.execute(
      () => window.__termic!.useUI.getState().newTaskProjectId !== null,
    );
    expect(dialogOpen).toBe(false);
    await snap("deep-link-open");
  });

  it("selects the task by id too", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().setActiveTask(null));
    await browser.execute(
      (id) => window.__termic!.deepLink.handleDeepLink(`termic://open?task=${id}`),
      taskId,
    );
    await browser.waitUntil(async () => (await activeTask()) === taskId, {
      timeout: 10_000,
      timeoutMsg: "termic://open did not resolve a task id",
    });
  });

  // A link that lands while the New Task dialog is up must not leave the user
  // stranded behind a modal on a task they cannot see.
  it("closes a stale New Task dialog on its way through", async () => {
    await browser.execute(() => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI.getState().openNewTask(proj.id);
      window.__termic!.useApp.getState().setActiveTask(null);
    });
    await waitVisible(NAME_INPUT);

    await browser.execute(
      (id) => window.__termic!.deepLink.handleDeepLink(`termic://open?task=${id}`),
      taskId,
    );
    await browser.waitUntil(
      async () =>
        (await activeTask()) === taskId
        && (await browser.execute(
          () => window.__termic!.useUI.getState().newTaskProjectId === null,
        )),
      { timeout: 10_000, timeoutMsg: "open left the New Task dialog up" },
    );
  });
});

// The full round trip: a link fills the dialog, the user presses Create, and
// the task exists with the CLI the link asked for. Kept separate because it
// creates real state and has to clean up after itself.
describe("termic:// deep link → create", () => {
  let taskId: string | undefined;

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("creates the task the link described once the user confirms", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // `shell` keeps this token-free: a Terminal task has no agent to type a
    // first message into, which is exactly what `canPrompt` gates on.
    await browser.execute(() =>
      window.__termic!.deepLink.handleDeepLink(
        "termic://new?project=fixture-repo&mode=main&agent=shell&name=e2e-deep-link",
      ),
    );
    await waitVisible(NAME_INPUT);

    await browser.execute(() => {
      const dlg = document
        .querySelector('input[placeholder="fix login bug"]')
        ?.closest('[role="dialog"]');
      const btn = [...(dlg?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent?.trim() === "Create",
      );
      (btn as HTMLElement).click();
    });

    await browser.waitUntil(
      () =>
        browser.execute(() =>
          window.__termic!.useApp.getState().tasks
            .some((t: any) => t.name === "e2e-deep-link" && !t.archived),
        ),
      { timeout: 15_000, timeoutMsg: "the confirmed deep link never created its task" },
    );
    taskId = await browser.execute(
      () =>
        window.__termic!.useApp.getState().tasks
          .find((t: any) => t.name === "e2e-deep-link" && !t.archived)?.id,
    );
    await snap("deep-link-created");
  });
});
