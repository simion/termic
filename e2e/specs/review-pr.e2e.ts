// Review a PR: the dialog, the "Code review" tag in the prompt library that
// feeds it, and the `termic review` / MCP `task_review` verbs that make the
// same task.
//
// What this fixture cannot do is fetch a real pull request: its remote is a
// local bare repo, which is not a forge (git.e2e.ts "start a task from an
// issue" says the same). So the cases drive everything up to the forge call
// and assert that the forge's refusal surfaces as a sentence and leaves no
// task behind. The PR half of the prompt, the parser and the default-prompt
// rule are unit-tested (src/lib/prReview.test.ts, cli_server.rs `review_*`).

import {
  archiveTask, clickByText, clickWhenVisible, dismissOverlays, requireTermicApi, runCli,
  setInputValue, snap, waitForAppShell, waitForText, waitGone, waitVisible,
} from "../helpers.js";
import { dataDir } from "../../wdio.conf.js";

const DIALOG = '[data-testid="review-pr-dialog"]';
const INPUT = '[data-testid="review-pr-input"]';
const START = '[data-testid="review-pr-start"]';

const fixtureId = () => browser.execute(() =>
  window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo")?.id as string);
const openDialog = async () => {
  const id = await fixtureId();
  await browser.execute((i) => window.__termic!.useUI.getState().openReviewPr(i), id);
  await waitVisible(DIALOG);
};
const closeDialog = async () => {
  await browser.execute(() => window.__termic!.useUI.getState().closeReviewPr());
  await waitGone(DIALOG);
};
const startDisabled = () => browser.execute((s) => (document.querySelector(s) as HTMLButtonElement).disabled, START);
const promptIds = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="review-pr-prompt"]')].map(b => b.getAttribute("data-prompt-id")));
const reviewTasks = () => browser.execute(() =>
  window.__termic!.useApp.getState().tasks.filter((t: any) => !t.archived && t.name.startsWith("review-pr-")).length);

describe("review a PR: labels in the prompt library", () => {
  const made: string[] = [];
  const row = (id: string) => `[data-prompt-id="${id}"]`;
  const labelsOn = (id: string) => browser.execute((sel) =>
    [...document.querySelectorAll(`${sel} [data-testid="prompt-label"]`)].map(e => e.getAttribute("data-label")), row(id));
  const libLabels = (id: string) => browser.execute((i) =>
    (window.__termic!.usePromptLibrary.getState() as any).prompts.find((p: any) => p.id === i)?.labels as string[], id);
  /** Type a label into a row's (or the editor's) add field and press Enter. */
  const addLabel = async (scope: string, label: string) => {
    // the "+ Label" button is out of sight until its row is hovered: pressed
    // the way a hovering user would, since WebDriver will not click it
    await browser.execute((s) => (document.querySelector(`${s} [data-testid="prompt-label-add"]`) as HTMLElement).click(), scope);
    await waitVisible(`${scope} [data-testid="prompt-label-input"]`);
    await setInputValue(`${scope} [data-testid="prompt-label-input"]`, label);
    await browser.execute((s) => {
      const el = document.querySelector(`${s} [data-testid="prompt-label-input"]`) as HTMLInputElement;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, scope);
  };
  const filterTo = (label: string | null) => browser.execute((l) => {
    const btn = [...document.querySelectorAll('[data-testid="prompt-label-filter"] button')]
      .find(b => b.getAttribute("data-label") === (l ?? "")) as HTMLElement;
    btn.click();
  }, label);
  const shownIds = () => browser.execute(() =>
    [...document.querySelectorAll("[data-prompt-id]")].map(e => e.getAttribute("data-prompt-id")));

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("prompts"));
    await waitVisible('[data-testid="prompt-label-filter"]');
  });

  after(async () => {
    await browser.execute((ids) => {
      const s = window.__termic!.usePromptLibrary.getState() as any;
      for (const id of ids) s.deletePrompt(id);
      s.setLabels("builtin:review", ["code-review"]);
      s.setLabels("builtin:deep-review", ["code-review"]);
      s.setFilterLabel(null);
    }, made);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("labels Review and Deep review Code review out of the box, and filters by it", async () => {
    expect(await labelsOn("builtin:review")).toEqual(["code-review"]);
    expect(await labelsOn("builtin:deep-review")).toEqual(["code-review"]);
    expect(await labelsOn("builtin:commit")).toEqual([]);
    await filterTo("code-review");
    await browser.waitUntil(async () => (await shownIds()).length === 2, { timeout: 5_000, timeoutMsg: "the Code review filter did not narrow the list" });
    expect(new Set(await shownIds())).toEqual(new Set(["builtin:review", "builtin:deep-review"]));
    await snap("review-pr-01-prompt-labels.png");
    await filterTo(null);
  });

  it("New prompt under a label filter makes a prompt with that label: as many review prompts as wanted", async () => {
    await filterTo("code-review");
    await browser.waitUntil(async () => (await shownIds()).length === 2, { timeout: 5_000, timeoutMsg: "filter did not apply" });
    await clickByText("New prompt");
    const id = await browser.waitUntil(async () => {
      const ids = await browser.execute(() => (window.__termic!.usePromptLibrary.getState() as any).prompts.map((p: any) => p.id as string)) as string[];
      return ids.find(x => !x.startsWith("builtin:") && !made.includes(x)) ?? false;
    }, { timeout: 5_000, timeoutMsg: "no new prompt" }) as string;
    made.push(id);
    expect(await libLabels(id)).toEqual(["code-review"]);
    // give it a title and body so closing the editor keeps it
    await browser.execute((i) => (window.__termic!.usePromptLibrary.getState() as any)
      .updatePrompt(i, { title: "Deep review", body: "Run the deep-review skill on this PR." }), id);
    // The editor shows its labels and takes another.
    await waitVisible('[data-testid="prompt-editor-labels"] [data-testid="prompt-label"][data-label="code-review"]');
    await addLabel('[data-testid="prompt-editor-labels"]', "Team standards");
    await browser.waitUntil(async () => (await libLabels(id)).includes("Team standards"),
      { timeout: 5_000, timeoutMsg: "the editor did not add the label" });
    await snap("review-pr-02-editor-labels.png");
    await browser.keys("Escape");
    await browser.waitUntil(async () => (await shownIds()).length === 3, { timeout: 5_000, timeoutMsg: "the new review prompt is not under the filter" });
    await filterTo(null);
  });

  it("adds a label of the user's own on a row, and removes it again", async () => {
    const id = await browser.execute(() =>
      (window.__termic!.usePromptLibrary.getState() as any).addPrompt({ title: "Perf pass", body: "Look for slow paths." })) as string;
    made.push(id);
    await waitVisible(row(id));
    await addLabel(row(id), "performance");
    await browser.waitUntil(async () => (await labelsOn(id)).includes("performance"), { timeout: 5_000, timeoutMsg: "the row did not take the label" });
    // A new label becomes a filter of its own.
    await filterTo("performance");
    await browser.waitUntil(async () => (await shownIds()).join() === id, { timeout: 5_000, timeoutMsg: "the new label's filter did not narrow to it" });
    await filterTo(null);
    // Any spelling of code review is the built-in label, not a look-alike.
    await addLabel(row(id), "Code Review");
    await browser.waitUntil(async () => (await labelsOn(id)).includes("code-review"), { timeout: 5_000, timeoutMsg: "Code Review was not the built-in label" });
    await browser.execute((sel) => {
      const chip = document.querySelector(`${sel} [data-testid="prompt-label"][data-label="performance"] [data-testid="prompt-label-remove"]`) as HTMLElement;
      chip.click();
    }, row(id));
    await browser.waitUntil(async () => (await labelsOn(id)).join() === "code-review", { timeout: 5_000, timeoutMsg: "removing the label did not take" });
  });

  it("offers exactly the Code review prompts in the dialog, and links back to them", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await openDialog();
    const ids = await promptIds();
    expect(new Set(ids)).toEqual(new Set(["builtin:review", "builtin:deep-review", ...made]));
    await setInputValue(INPUT, "42");
    // The link opens Settings, Prompts on the review prompts, with the
    // dialog stepped aside rather than closed.
    await clickWhenVisible('[data-testid="review-pr-manage-prompts"]');
    await waitGone(DIALOG);
    await waitVisible('[data-testid="prompt-label-filter"] [data-label="code-review"][aria-pressed="true"]');
    expect(await browser.execute(() => window.__termic!.useUI.getState().reviewPrProjectId)).toBe(await fixtureId());
    const id = await browser.execute(() => {
      const s = window.__termic!.usePromptLibrary.getState() as any;
      const i = s.addPrompt({ title: "Made from the dialog", body: "Check the migrations." }) as string;
      s.addLabel(i, "code-review");
      return i;
    }) as string;
    made.push(id);
    await filterTo(null);
    // Closing Settings brings the dialog back as it was, on the new prompt.
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await waitVisible(DIALOG);
    expect(await browser.execute((s) => (document.querySelector(s) as HTMLInputElement).value, INPUT)).toBe("42");
    await browser.waitUntil(async () => (await browser.execute((i) =>
      document.querySelector(`[data-testid="review-pr-prompt"][data-prompt-id="${i}"]`)?.getAttribute("aria-checked"), id)) === "true",
      { timeout: 5_000, timeoutMsg: "the prompt made in Settings was not picked" });
    expect(await browser.execute(() => (document.querySelector('[data-testid="review-pr-text"]') as HTMLTextAreaElement)?.value)).toBe("Check the migrations.");
    await snap("review-pr-02b-back-from-settings.png");
    await closeDialog();
  });

  it("says where to label one when nothing is, and cannot start", async () => {
    await browser.execute((ids) => {
      const s = window.__termic!.usePromptLibrary.getState() as any;
      for (const p of ["builtin:review", "builtin:deep-review", ...ids]) s.removeLabel(p, "code-review");
    }, made);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await openDialog();
    await waitVisible('[data-testid="review-pr-no-prompts"]');
    await setInputValue(INPUT, "12");
    expect(await startDisabled()).toBe(true);
    await clickByText("Label one Code review in Settings, Prompts");
    await waitGone(DIALOG);
    await waitVisible('[data-testid="prompt-label-empty"]');
    await browser.execute((ids) => {
      const s = window.__termic!.usePromptLibrary.getState() as any;
      for (const p of ["builtin:review", "builtin:deep-review", ...ids]) s.addLabel(p, "code-review");
      s.setFilterLabel(null);
    }, made);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await waitVisible(DIALOG);
    await closeDialog();
  });
});

describe("review a PR: the dialog", () => {
  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    await browser.execute(() => localStorage.removeItem("reviewPrLast"));
  });

  afterEach(async () => {
    await browser.execute(() => window.__termic!.useUI.getState().closeReviewPr());
  });

  it("opens from the command palette, focused on the PR box, worktree chosen", async () => {
    await browser.execute(() => window.__termic!.useUI.getState().openCommandPalette());
    // Searched for, as a user would: the unfiltered list is long and this
    // row sits below the fold.
    await setInputValue('input[placeholder="Type a command or search…"]', "review a pull");
    const row = '[data-cmd-id="review-pr"]';
    await waitVisible(row);
    expect(await browser.execute((s) => document.querySelector(s)?.textContent ?? "", row)).toContain("Review a pull request");
    await clickWhenVisible(row);
    await waitVisible(DIALOG);
    await browser.waitUntil(
      () => browser.execute((s) => document.activeElement === document.querySelector(s), INPUT),
      { timeout: 5_000, timeoutMsg: "the PR box did not take focus" },
    );
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="review-pr-where-worktree"]')?.getAttribute("aria-checked"))).toBe("true");
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="review-pr-where-main"]')?.getAttribute("aria-checked"))).toBe("false");
    // A prompt and an agent are already chosen: only the PR is missing.
    expect(await browser.execute(() => !!document.querySelector('[data-testid="review-pr-prompt"][aria-checked="true"]'))).toBe(true);
    // The New Task picker: one pill picked.
    expect(await browser.execute(() =>
      document.querySelectorAll('[data-testid="review-pr-agents"] [aria-checked="true"]').length)).toBe(1);
    // The palette handed over: it is closed, not stacked under the dialog.
    expect(await browser.execute(() => window.__termic!.useUI.getState().commandPaletteOpen)).toBe(false);
    expect(await startDisabled()).toBe(true);
    await snap("review-pr-03-dialog.png");
  });

  it("shows the picked prompt as an editable initial prompt, and leaves the library alone", async () => {
    await openDialog();
    const text = () => browser.execute(() => (document.querySelector('[data-testid="review-pr-text"]') as HTMLTextAreaElement).value);
    const body = (id: string) => browser.execute((i) =>
      (window.__termic!.usePromptLibrary.getState() as any).prompts.find((p: any) => p.id === i)?.body as string, id);
    await clickWhenVisible('[data-testid="review-pr-prompt"][data-prompt-id="builtin:review"]');
    expect(await text()).toBe(await body("builtin:review"));
    // Picking another prompt shows ITS text.
    await clickWhenVisible('[data-testid="review-pr-prompt"][data-prompt-id="builtin:deep-review"]');
    await browser.waitUntil(async () => (await text()) === (await body("builtin:deep-review")),
      { timeout: 5_000, timeoutMsg: "the prompt box did not follow the pick" });
    // An edit is this review's only: the library keeps its text, and Reset
    // brings the saved prompt back.
    const saved = await body("builtin:deep-review");
    await setInputValue('[data-testid="review-pr-text"]', "Only look at the migrations.");
    await waitVisible('[data-testid="review-pr-text-reset"]');
    expect(await body("builtin:deep-review")).toBe(saved);
    await snap("review-pr-06-edited-prompt.png");
    await clickWhenVisible('[data-testid="review-pr-text-reset"]');
    await browser.waitUntil(async () => (await text()) === saved,
      { timeout: 5_000, timeoutMsg: "Reset did not restore the saved prompt" });
    // An empty prompt cannot start a review.
    await setInputValue(INPUT, "9");
    expect(await startDisabled()).toBe(false);
    await setInputValue('[data-testid="review-pr-text"]', "  ");
    expect(await startDisabled()).toBe(true);
    await clickWhenVisible('[data-testid="review-pr-prompt"][data-prompt-id="builtin:review"]');
  });

  it("reads a number or a link, and says so when it is neither", async () => {
    await openDialog();
    await setInputValue(INPUT, "not a pr");
    await waitVisible('[data-testid="review-pr-hint"]');
    expect(await startDisabled()).toBe(true);
    // which hint is up names the cause: unparsed, wrong repo, or an existing
    // review task to reuse.
    const hint = () => browser.execute((i) => ({
      input: (document.querySelector(i) as HTMLInputElement | null)?.value ?? null,
      hints: Array.from(document.querySelectorAll('[data-testid="review-pr-hint"]')).map(h => h.textContent),
    }), INPUT);
    for (const ok of ["42", "#42", "https://github.com/acme/web/pull/42"]) {
      await setInputValue(INPUT, ok);
      await browser.waitUntil(async () => (await hint()).hints.length === 0,
        { timeout: 15_000, timeoutMsg: `hint never cleared: ${JSON.stringify(await hint())}` });
      expect(await startDisabled()).toBe(false);
    }
  });

  it("is reachable from the project's + menu", async () => {
    const id = await fixtureId();
    await browser.execute((i) => window.__termic!.useApp.getState().setProjectCollapsed(i, false), id);
    const trigger = `[data-testid="project-new-task-${id}"], [data-testid="project-empty-new-task-${id}"]`;
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    // On top when used lately, else folded under More.
    await waitVisible('[role="menu"]');
    await browser.waitUntil(() => browser.execute(() => {
      if (document.querySelector('[role="menu"] [data-testid="project-review-pr"]')) return true;
      const el = document.querySelector('[data-testid="launcher-more"]') as HTMLElement | null;
      if (el && el.getAttribute("data-state") !== "open") {
        const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as any;
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.click();
      }
      return false;
    }), { timeoutMsg: "Review a pull request is in neither the menu nor More" });
    expect(await browser.execute(() =>
      document.querySelector('[role="menu"] [data-testid="project-review-pr"]')?.textContent ?? "")).toContain("Review a pull request");
    await snap("review-pr-04-project-menu.png");
    // Not clicked through: the item opens the dialog one animation frame
    // later (like Start a race beside it, so the menu's focus teardown cannot
    // steal the dialog's focus), and a hidden e2e window runs animation
    // frames only some of the time. Opening the dialog is the palette case's.
    await browser.keys("Escape");
    await dismissOverlays();
  });

  it("remembers main checkout and the prompt for next time", async () => {
    await openDialog();
    await clickWhenVisible('[data-testid="review-pr-where-main"]');
    await clickWhenVisible('[data-testid="review-pr-prompt"][data-prompt-id="builtin:deep-review"]');
    // The choice is remembered when a review is started; the fixture's PR
    // fetch fails, which is fine, the choice is written before it.
    await setInputValue(INPUT, "7");
    await clickWhenVisible(START);
    await waitVisible('[data-testid="review-pr-error"]');
    await closeDialog();
    await openDialog();
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="review-pr-where-main"]')?.getAttribute("aria-checked"))).toBe("true");
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="review-pr-prompt"][aria-checked="true"]')?.getAttribute("data-prompt-id"))).toBe("builtin:deep-review");
    await clickWhenVisible('[data-testid="review-pr-where-worktree"]');
  });

  it("reports a PR the forge cannot answer for, stays open, and makes nothing", async () => {
    const before = await reviewTasks();
    await openDialog();
    await setInputValue(INPUT, "123");
    // Enter starts it, like the button.
    await browser.execute((s) => (document.querySelector(s) as HTMLElement).focus(), INPUT);
    await browser.keys("Enter");
    await waitVisible('[data-testid="review-pr-error"]');
    const msg = await browser.execute(() => document.querySelector('[data-testid="review-pr-error"]')?.textContent ?? "");
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toMatch(/^Error:/);
    expect(await browser.execute((s) => !!document.querySelector(s), DIALOG)).toBe(true);
    expect(await reviewTasks()).toBe(before);
    // The box is still editable and the button usable for a retry.
    expect(await startDisabled()).toBe(false);
    await snap("review-pr-05-forge-error.png");
  });
});

describe("review a PR: termic review and MCP task_review", () => {
  let strays: string[] = [];

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
  });

  after(async () => {
    for (const id of strays) await archiveTask(id);
  });

  it("refuses something that is not a PR before touching the app", () => {
    expect(() => runCli(["--no-launch", "review", "abc", "--project", "fixture-repo"], { TERMIC_DATA_DIR: dataDir }))
      .toThrow(/is not a pull request/);
  });

  it("lists which prompts are tagged, so a script can pick one", () => {
    const out = runCli(["--no-launch", "--json", "prompts"], { TERMIC_DATA_DIR: dataDir });
    const tagged = (JSON.parse(out).prompts as any[]).filter(p => p.review).map(p => p.id);
    expect(tagged).toContain("builtin:review");
    expect(tagged).toContain("builtin:deep-review");
  });

  it("asks the forge, and a repo that is not on one is an error with no task left behind", async () => {
    const before = await reviewTasks();
    let err = "";
    try {
      runCli(["--no-launch", "review", "#5", "--project", "fixture-repo", "--agent", "fakeagent"], { TERMIC_DATA_DIR: dataDir });
    } catch (e: any) { err = String(e.message); }
    expect(err).toContain("exit 1");
    expect(await reviewTasks()).toBe(before);
    strays = await browser.execute(() => window.__termic!.useApp.getState().tasks
      .filter((t: any) => !t.archived && t.name.startsWith("review-pr-")).map((t: any) => t.id as string));
  });
});
