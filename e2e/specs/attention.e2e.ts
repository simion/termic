// The needs-you panel (GH #468): a floating window that lists the tasks
// waiting on you, each with its question and a button per answer.
//
// A fake agent asks the way a real one does: Termic's attention OSC, then a
// numbered menu the screen reader understands. Answering from the panel has
// to reach that agent, which writes a marker file, and the panel goes away
// once nothing waits.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { archiveTask, openTask, requireTermicApi, snap, submitToAgent, waitForAgentReady, waitForAppShell } from "../helpers";

const isWindows = process.platform === "win32";

/** The panel's handle, found by its own page; WebDriver is left on it. */
async function panelHandle(): Promise<string | null> {
  for (const h of await browser.getWindowHandles()) {
    try {
      await browser.switchToWindow(h);
      if ((await browser.execute(() => location.href)).includes("attention.html")) return h;
    } catch { /* closing */ }
  }
  return null;
}

(isWindows ? describe.skip : describe)("the needs-you panel", () => {
  let taskId = "";
  let mainHandle = "";
  let dir = "";
  let marker = "";

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    mainHandle = await browser.getWindowHandle();
    dir = mkdtempSync(path.join(tmpdir(), "termic-e2e-ask-"));
    marker = path.join(dir, "picked");
    const agent = path.join(dir, "ask.sh");
    writeFileSync(agent, [
      "#!/bin/sh",
      "printf 'ask agent ready\\r\\n> '",
      "while IFS= read -r l; do",
      "  case \"$l\" in",
      "    *ask*) printf '\\033]777;notify;termic;agent needs your input\\007\\r\\nDo you want to proceed?\\r\\n\\342\\235\\257 1. Yes\\r\\n  2. No\\r\\n' ;;",
      `    *) printf 'picked\\r\\n> '; echo picked > '${marker}' ;;`,
      "  esac",
      "done",
      "",
    ].join("\n"));
    chmodSync(agent, 0o755);
    await browser.execute(async (cmd) => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      const fake = s.agents.find((a: any) => a.id === "fakeagent");
      const caps = { ...fake.capabilities, yolo_args: [], resume_args: [], session_id_args: [], resume_id_args: [], name_args: [] };
      s.agents = [...s.agents.filter((a: any) => a.id !== "askagent"), { ...fake, id: "askagent", display_name: "AskAgent", command: cmd, args: [], builtin: false, capabilities: caps }];
      await t.ipc.settingsSave(s);
      await t.useApp.getState().loadAll();
    }, agent);
    await browser.execute(() => window.__termic!.usePrefs.getState().setAttentionPanel(true));
  });

  after(async () => {
    await browser.switchToWindow(mainHandle).catch(() => {});
    await browser.execute(() => window.__termic!.usePrefs.getState().setAttentionPanel(false));
    if (taskId) await archiveTask(taskId);
    await browser.execute(async () => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      s.agents = s.agents.filter((a: any) => a.id !== "askagent");
      await t.ipc.settingsSave(s);
    });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("stays away while nothing waits", async () => {
    taskId = await openTask("e2e-ask", true, "askagent");
    await waitForAgentReady(taskId);
    expect(await panelHandle()).toBeNull();
    await browser.switchToWindow(mainHandle);
  });

  /** What the main window and WebDriver see, for a failure to say why. */
  const diagnose = async () => {
    await browser.switchToWindow(mainHandle).catch(() => {});
    const app = await browser.execute((id) => {
      const s = window.__termic!;
      const tabs = (s.useApp.getState().tabs[id] ?? []).map((t: any) => ({ type: t.type, unread: t.unread?.reason ?? null, work: t.workState ?? null }));
      return { pref: s.usePrefs.getState().attentionPanel, tabs, error: (window as any).__termicAttentionError ?? null };
    }, taskId).catch((e: unknown) => String(e));
    const pages: string[] = [];
    for (const h of await browser.getWindowHandles()) {
      try { await browser.switchToWindow(h); pages.push(await browser.execute(() => location.href)); } catch { pages.push("(gone)"); }
    }
    await browser.switchToWindow(mainHandle).catch(() => {});
    return JSON.stringify({ app, pages });
  };

  // Every case starts and ends on the main window: a failure that left
  // WebDriver on the panel took the next case down with it.
  afterEach(async () => { await browser.switchToWindow(mainHandle).catch(() => {}); });

  it("shows the waiting task's question, and answers it from there", async () => {
    await submitToAgent(taskId, "ask");
    let handle: string | null = null;
    await browser.waitUntil(async () => (handle = await panelHandle()) !== null, { timeout: 20_000 })
      .catch(async () => { throw new Error(`the panel never opened for a waiting task: ${await diagnose()}`); });
    await browser.waitUntil(
      () => browser.execute(() => document.querySelectorAll('[data-testid="attention-option"]').length === 2),
      { timeout: 10_000, timeoutMsg: "the panel never showed the question's two options" },
    );
    expect(await browser.execute((id) => !!document.querySelector(`[data-testid="attention-card-${id}"]`), taskId)).toBe(true);
    expect(await browser.execute(() => [...document.querySelectorAll('[data-testid="attention-option"]')].map(b => b.textContent))).toEqual(["Yes", "No"]);
    await snap("attention-panel.png");
    await browser.execute(() => (document.querySelector('[data-testid="attention-option"]') as HTMLElement).click());
    await browser.waitUntil(() => existsSync(marker), { timeout: 10_000, timeoutMsg: "the answer never reached the agent" });
    expect(readFileSync(marker, "utf8").trim()).toBe("picked");
    void handle;
    await browser.switchToWindow(mainHandle);
  });

  it("goes away once nothing waits", async () => {
    // The answer cleared the wait (as typing it would), so nothing waits and
    // the main window hides the panel; the handle can stay listed while
    // hidden, so a hidden page counts as gone.
    await browser.waitUntil(async () => !(await browser.execute((id) => (window.__termic!.useApp.getState().tabs[id] ?? [])
      .some((t: any) => t.unread?.reason === "attention"), taskId)), { timeout: 10_000, timeoutMsg: "the answer did not clear the wait" });
    await browser.waitUntil(async () => {
      const h = await panelHandle();
      const hidden = h === null || !(await browser.execute(() => document.visibilityState === "visible"));
      await browser.switchToWindow(mainHandle);
      return hidden;
    }, { timeout: 15_000, timeoutMsg: "the panel stayed up with nothing waiting" });
  });
});
