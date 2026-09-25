// `termic tab` part 2 (GH #138): tab ids end to end, over the REAL
// control socket.
//
// This spec is the coverage docs/plans/cli.md mandates part 2 to start
// with: `PtyRole.tab_id` is set in TerminalPane's spawn call and read by
// Rust's find_tab_pty, a thread no unit suite can see whole. Every case
// here keys on "a tab opened by `termic tab` is addressable by the id
// that command returned": if the field is dropped, misspelled, or wired
// to the wrong id, `logs --tab` below stops resolving and this file goes
// red, instead of the failure surfacing as a mystery in some future
// user's script.
//
// The socket speaks the wire protocol directly (the app.e2e.ts raise
// precedent) with the per-boot token from the profile dir, so the whole
// server path runs: auth, task resolution, the selector resolver, the
// webview RPCs.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";
import { dataDir } from "../../wdio.conf.js";
import { archiveTask, cliRpc as rpc, openTask, requireTermicApi, runCli, waitForAppShell, waitForClisDetected } from "../helpers.js";

/**
 * Poll a tab's live PTY (spawn is async), through BOTH sides that have to
 * agree before the cases below can address it.
 *
 * The store's `ptyId` is not sufficient on its own: it lands as soon as the
 * frontend's spawn call resolves, while `logs --tab` / `send --tab` resolve
 * the id on the RUST side through the PTY-role registry. The two are not
 * synchronized, so gating only on the store let a `logs --tab` fire into the
 * gap and come back `ok: false` — an intermittent that only showed up in a
 * loaded full-suite run and never in isolation.
 *
 * So wait for what the next test actually needs: the CLI resolving that id.
 */
async function waitForTabPty(taskId: string, tabId: string, taskName: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (tid, tab) =>
          (window.__termic!.useApp.getState().tabs[tid] ?? []).some(
            (t: any) => t.id === tab && t.ptyId,
          ),
        taskId,
        tabId,
      ),
    { timeout: 20_000, timeoutMsg: `tab ${tabId} never got a PTY in the store` },
  );
  await browser.waitUntil(
    async () => (await rpc({ cmd: "logs", task: taskName, tab: tabId })).ok === true,
    {
      timeout: 20_000,
      interval: 250,
      timeoutMsg: `the CLI never resolved tab ${tabId} to a PTY`,
    },
  );
}

describe("termic tab: ids are addressable end to end (GH #138 part 2)", () => {
  let taskId: string;
  let secondTabId: string;

  // The task carries three live agent tabs by the end; leaving it in
  // the shared profile makes it the ACTIVE task of every later spec
  // file's launch, whose hidden mounted strip then wins unscoped
  // queries (helpers trap #2) and broke tabs-layout/files wholesale.
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("cli-tabs");
    await browser.waitUntil(
      () =>
        browser.execute(
          tid =>
            (window.__termic!.useApp.getState().tabs[tid] ?? []).some(
              (t: any) => t.ptyId,
            ),
          taskId,
        ),
      { timeout: 20_000, timeoutMsg: "default agent PTY never spawned" },
    );
    // The tab verbs below hydrate the agent registry INLINE when PATH
    // detection has not landed yet, and that probe (one login shell per
    // configured agent) takes seconds — long enough on a slow shell to blow
    // the CLI's own 10s "did the UI answer?" deadline and fail four cases
    // that have nothing to do with detection. Wait for the pass the app
    // already started at launch instead of racing it.
    await waitForClisDetected();
  });

  it("opens a second agent tab and returns its stable id", async () => {
    const r = await rpc({
      cmd: "tab",
      task: "cli-tabs",
      kind: { tab: "agent", id: "fakeagent" },
    });
    expect(r.ok).toBe(true);
    secondTabId = r.data.tab_id;
    expect(secondTabId).toBeTruthy();
    // The id is the STORE's id for a real tab, not something invented
    // on the way out.
    const inStore = await browser.execute(
      (tid, tab) =>
        (window.__termic!.useApp.getState().tabs[tid] ?? []).some(
          (t: any) => t.id === tab,
        ),
      taskId,
      secondTabId,
    );
    expect(inStore).toBe(true);
    await waitForTabPty(taskId, secondTabId, "cli-tabs");
  });

  it("logs --tab resolves that id to that tab's own PTY", async () => {
    // THE tab_id assertion: find_tab_pty resolves the returned id via
    // PtyRole.tab_id, with no default-tab fallback to hide a broken
    // thread behind.
    // Polled: a live PTY is not yet a printed banner, and the fake agent
    // takes longer to start under Git Bash on Windows than bash on macOS.
    let r: any;
    await browser.waitUntil(async () => {
      r = await rpc({ cmd: "logs", task: "cli-tabs", tab: secondTabId });
      return r.ok && String(r.data?.data ?? "").includes("FAKE-AGENT ready");
    }, { timeout: 15_000, timeoutMsg: "the tab's own PTY never showed the agent's banner" });
    expect(r.ok).toBe(true);
    expect(r.data.source).toBe("agent");
    expect(r.data.data).toContain("FAKE-AGENT ready");
  });

  it("send --tab delivers to the targeted tab, not the default", async () => {
    const marker = `MARKER-${Date.now()}`;
    const r = await rpc({
      cmd: "send",
      task: "cli-tabs",
      prompt: marker,
      tab: secondTabId,
    });
    expect(r.ok).toBe(true);
    // The fake agent echoes each prompt line; the echo must land in the
    // TARGETED tab's ring and only there.
    await browser.waitUntil(
      async () => {
        const logs = await rpc({ cmd: "logs", task: "cli-tabs", tab: secondTabId });
        return logs.ok && logs.data.data.includes(`FAKE-AGENT echo: ${marker}`);
      },
      { timeout: 20_000, timeoutMsg: "the prompt never reached the targeted tab" },
    );
    const dflt = await rpc({ cmd: "logs", task: "cli-tabs" });
    expect(dflt.ok).toBe(true);
    expect(dflt.data.data).not.toContain(marker);
  });

  it("status lists the strip with the same ids and 1-based indices", async () => {
    // status's tab list is the --tab contract surface: what it prints
    // is what selectors mean.
    await browser.waitUntil(
      async () => {
        const r = await rpc({ cmd: "status", task: "cli-tabs" });
        return r.ok && Array.isArray(r.data.task.tabs) && r.data.task.tabs.length >= 2;
      },
      { timeout: 10_000, timeoutMsg: "status never listed the strip" },
    );
    const r = await rpc({ cmd: "status", task: "cli-tabs" });
    const tabs = r.data.task.tabs;
    expect(tabs.map((t: any) => t.index)).toEqual(tabs.map((_: any, i: number) => i + 1));
    expect(tabs.some((t: any) => t.id === secondTabId)).toBe(true);
    expect(tabs.filter((t: any) => t.is_default).length).toBe(1);
    expect(tabs.every((t: any) => t.kind === "agent")).toBe(true);
  });

  it("tab -p opens a tab and confirms delivery into exactly that tab", async () => {
    const marker = `MARKER-P-${Date.now()}`;
    const r = await rpc({
      cmd: "tab",
      task: "cli-tabs",
      kind: { tab: "agent", id: "fakeagent" },
      prompt: marker,
    });
    expect(r.ok).toBe(true);
    const newId: string = r.data.tab_id;
    expect(r.data.prompt.mode).toBeTruthy();
    // The rode-along prompt is injected in the BACKGROUND, after a settle beat
    // that lets the agent finish booting. Wait for that through the STORE
    // (`lastInputAt` is stamped the moment the write lands) rather than by
    // polling `logs`: every `logs` call is a round trip through the CLI socket
    // AND back into the webview, and doing that ~10x/s across the delivery
    // window starved the write itself — `pty_write` is a synchronous command,
    // so it queues behind that traffic on the main thread and the injection
    // sat unresolved for the whole 40s.
    await browser.waitUntil(
      () =>
        browser.execute(
          (tid, tab) =>
            (window.__termic!.useApp.getState().tabs[tid] ?? []).some(
              (t: any) => t.id === tab && !!t.lastInputAt,
            ),
          taskId,
          newId,
        ),
      { timeout: 40_000, interval: 500, timeoutMsg: "tab -p's prompt was never injected" },
    );
    // …and it landed in the NEW tab's ring, not somewhere else.
    await browser.waitUntil(
      async () => {
        const logs = await rpc({ cmd: "logs", task: "cli-tabs", tab: newId });
        return logs.ok && logs.data.data.includes(`FAKE-AGENT echo: ${marker}`);
      },
      { timeout: 20_000, interval: 500, timeoutMsg: "tab -p's prompt never reached the new tab" },
    );
  });

  it("selector misses are typed errors, ambiguity names the candidates", async () => {
    const miss = await rpc({ cmd: "logs", task: "cli-tabs", tab: "99" });
    expect(miss.ok).toBe(false);
    expect(miss.error.code).toBe("not_found");
    // Three fakeagent tabs by now: a title selector must refuse with the
    // candidates listed, never guess one.
    const ambiguous = await rpc({ cmd: "logs", task: "cli-tabs", tab: "fakeagent" });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error.code).toBe("ambiguous");
    expect(ambiguous.error.message).toContain(secondTabId);
  });
});

// `termic tab close` (GH #185) over the REAL socket. The thread no unit
// suite can see whole: the selector resolves in Rust, the PTY is stopped
// in Rust, and the tab is dropped by the WEBVIEW's store, and the reply
// is only honest if all three agreed. The unit suites stub the webview on
// one side and the PTY manager on the other, so a broken `close_tab`
// handler registration, a `notify_tab_detach` wired to the wrong role
// field, or a stop that misses the tab's PTY all pass there and fail here.
// GH #331: a title set through the CLI is a selector. Opened with
// `tab --title`, the tab answers to that name on every tab verb, keeps it
// while the agent retitles itself (fake-agent drives its OSC title the
// moment it starts), and `tab --tab X --title Y` renames an open tab, or
// with "" gives it back its automatic title.
describe("termic tab --title: a title you set is a selector (GH #331)", () => {
  const TASK = "cli-titles";
  let taskId: string;
  let alpha: string;
  let beta: string;

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask(TASK);
    await waitForClisDetected();
  });

  const storeTab = (tab: string) =>
    browser.execute(
      (tid, id) => {
        const t = (window.__termic!.useApp.getState().tabs[tid] ?? []).find((x: any) => x.id === id);
        return t ? { title: t.title, customTitle: !!t.customTitle, liveTitle: t.liveTitle ?? null } : null;
      },
      taskId,
      tab,
    );
  /** What the tab strip pill actually shows. */
  const pillText = (tab: string) =>
    browser.execute(
      (tid, id) => document.querySelector(`[data-task-id="${tid}"] [data-tab-id="${id}"]`)?.textContent ?? null,
      taskId,
      tab,
    );
  const tabCount = () =>
    browser.execute((tid) => (window.__termic!.useApp.getState().tabs[tid] ?? []).length, taskId);

  it("opens two agent tabs by name and addresses each by it", async () => {
    const a = await rpc({ cmd: "tab", task: TASK, kind: { tab: "agent", id: "fakeagent" }, title: "alpha-worker" });
    expect(a.ok).toBe(true);
    expect(a.data.title).toBe("alpha-worker");
    alpha = a.data.tab_id;
    const b = await rpc({ cmd: "tab", task: TASK, kind: { tab: "agent", id: "fakeagent" }, title: " beta-worker " });
    expect(b.ok).toBe(true);
    expect(b.data.title).toBe("beta-worker");
    beta = b.data.tab_id;
    await waitForTabPty(taskId, alpha, TASK);
    await waitForTabPty(taskId, beta, TASK);

    // Two tabs of the SAME agent: without titles `--tab fakeagent` is
    // ambiguous and neither is reachable by name.
    for (const sel of ["alpha-worker", "BETA-WORKER"]) {
      const r = await rpc({ cmd: "logs", task: TASK, tab: sel });
      expect(r.ok).toBe(true);
      expect(r.data.source).toBe("agent");
    }
    expect((await rpc({ cmd: "logs", task: TASK, tab: "fakeagent" })).ok).toBe(false);
    // And each name belongs to the tab it was given to: `status` lists the
    // strip as the resolver sees it (the webview's report can trail a beat).
    await browser.waitUntil(
      async () => {
        const st = await rpc({ cmd: "status", task: TASK });
        const byId = new Map((st.data?.task?.tabs ?? []).map((t: any) => [t.id, t.title]));
        return byId.get(alpha) === "alpha-worker" && byId.get(beta) === "beta-worker";
      },
      { timeout: 10_000, timeoutMsg: "status never listed the titles against their tabs" },
    );
  });

  it("keeps the name while the agent retitles itself", async () => {
    // A locked tab drops the agent's OSC title outright (setTabLiveTitle
    // bails on customTitle), so the named tab itself can never show that
    // the agent DID retitle. An untitled control tab of the same agent can:
    // once its live title lands, fake-agent has emitted, and the named tabs
    // opened before it have been through the same start.
    const control = await rpc({ cmd: "tab", task: TASK, kind: { tab: "agent", id: "fakeagent" } });
    expect(control.ok).toBe(true);
    await browser.waitUntil(async () => !!(await storeTab(control.data.tab_id))?.liveTitle, {
      timeout: 20_000,
      timeoutMsg: "fake-agent never set its OSC title on the untitled control tab",
    });
    for (const [id, name] of [[alpha, "alpha-worker"], [beta, "beta-worker"]]) {
      expect(await storeTab(id)).toMatchObject({ title: name, customTitle: true, liveTitle: null });
      expect(await pillText(id)).toContain(name);
    }
  });

  it("refuses a title already in use, or one --tab would read as a position", async () => {
    const before = await tabCount();
    const dup = await rpc({ cmd: "tab", task: TASK, kind: { tab: "shell" }, title: "Alpha-Worker" });
    expect(dup.ok).toBe(false);
    expect(dup.error.code).toBe("conflict");
    const num = await rpc({ cmd: "tab", task: TASK, kind: { tab: "shell" }, title: "2" });
    expect(num.ok).toBe(false);
    expect(num.error.code).toBe("bad_request");
    expect(await tabCount()).toBe(before);
  });

  it("renames an open tab through the real CLI, and the old name stops resolving", async () => {
    const stdout = runCli(
      ["--no-launch", "tab", TASK, "--tab", "alpha-worker", "--title", "reviewer"],
      { TERMIC_DATA_DIR: dataDir },
    );
    expect(stdout).toContain('Renamed tab');
    expect(stdout).toContain('"reviewer"');
    expect(await storeTab(alpha)).toMatchObject({ title: "reviewer", customTitle: true });
    await browser.waitUntil(async () => (await rpc({ cmd: "logs", task: TASK, tab: "reviewer" })).ok === true, {
      timeout: 10_000,
      timeoutMsg: "the new title never resolved",
    });
    expect((await rpc({ cmd: "logs", task: TASK, tab: "alpha-worker" })).ok).toBe(false);
    expect(await pillText(alpha)).toContain("reviewer");
  });

  it("renames by position too, and refuses another tab's name", async () => {
    const clash = await rpc({ cmd: "tab_rename", task: TASK, tab: beta, title: "reviewer" });
    expect(clash.ok).toBe(false);
    expect(clash.error.code).toBe("conflict");
    const status = await rpc({ cmd: "status", task: TASK });
    const idx = status.data.task.tabs.find((t: any) => t.id === beta).index;
    const r = await rpc({ cmd: "tab_rename", task: TASK, tab: String(idx), title: "tester" });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ tab_id: beta, title: "tester" });
  });

  it("\"\" gives the tab back its automatic title", async () => {
    const r = await rpc({ cmd: "tab_rename", task: TASK, tab: "reviewer", title: "" });
    expect(r.ok).toBe(true);
    expect(r.data.title).not.toBe("reviewer");
    const t = await storeTab(alpha);
    expect(t).toMatchObject({ customTitle: false, title: r.data.title });
    // The pill follows the agent's own title again.
    await browser.waitUntil(async () => !(await pillText(alpha))?.includes("reviewer"), {
      timeout: 5_000,
      timeoutMsg: "the pill still shows the cleared name",
    });
    await browser.waitUntil(async () => (await rpc({ cmd: "logs", task: TASK, tab: "reviewer" })).ok === false, {
      timeout: 10_000,
      timeoutMsg: "the cleared name still resolves",
    });
  });
});

describe("termic tab close: one tab, not the task (GH #185)", () => {
  let taskId: string;
  let secondTabId: string;
  let defaultTabId: string;

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("cli-tab-close");
    await browser.waitUntil(
      () =>
        browser.execute(
          tid =>
            (window.__termic!.useApp.getState().tabs[tid] ?? []).some((t: any) => t.ptyId),
          taskId,
        ),
      { timeout: 20_000, timeoutMsg: "default agent PTY never spawned" },
    );
    defaultTabId = await browser.execute(
      tid =>
        (window.__termic!.useApp.getState().tabs[tid] ?? []).find((t: any) => t.is_default)?.id,
      taskId,
    );
    expect(defaultTabId).toBeTruthy();
    const r = await rpc({
      cmd: "tab",
      task: "cli-tab-close",
      kind: { tab: "agent", id: "fakeagent" },
    });
    expect(r.ok).toBe(true);
    secondTabId = r.data.tab_id;
    await waitForTabPty(taskId, secondTabId, "cli-tab-close");
  });

  it("refuses the default tab without --yes, and closes nothing", async () => {
    // The guard exists because the default tab is what an unqualified
    // send/wait/attach resolves to. A refusal that had already killed the
    // PTY on its way to saying no would be the worst of both.
    const r = await rpc({ cmd: "tab_close", task: "cli-tab-close", tab: defaultTabId });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("unsupported");
    expect(r.error.message).toContain("--yes");
    const alive = await rpc({ cmd: "logs", task: "cli-tab-close", tab: defaultTabId });
    expect(alive.ok).toBe(true);
  });

  it("refuses a selector that matches no tab", async () => {
    const r = await rpc({ cmd: "tab_close", task: "cli-tab-close", tab: "99" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("not_found");
  });

  it("closes a secondary tab and leaves the task and its other tabs running", async () => {
    const r = await rpc({ cmd: "tab_close", task: "cli-tab-close", tab: secondTabId });
    expect(r.ok).toBe(true);
    expect(r.data.tab_id).toBe(secondTabId);
    expect(r.data.was_default).toBe(false);
    expect(r.data.killed_pty).toBe(true);

    // Gone from the strip the GUI renders...
    await browser.waitUntil(
      async () =>
        !(await browser.execute(
          (tid, tab) =>
            (window.__termic!.useApp.getState().tabs[tid] ?? []).some((t: any) => t.id === tab),
          taskId,
          secondTabId,
        )),
      { timeout: 10_000, timeoutMsg: "the closed tab is still in the store's strip" },
    );
    // ...and its id stops resolving, which is what proves the PTY went
    // rather than the tab merely being hidden.
    await browser.waitUntil(
      async () => (await rpc({ cmd: "logs", task: "cli-tab-close", tab: secondTabId })).ok === false,
      { timeout: 10_000, timeoutMsg: "the closed tab's id still resolves to a PTY" },
    );
    // The task itself is untouched. This is the entire difference from
    // `archive`, which would have taken the orchestrator's own session.
    const still = await rpc({ cmd: "logs", task: "cli-tab-close", tab: defaultTabId });
    expect(still.ok).toBe(true);
    const mounted = await browser.execute(
      tid => window.__termic!.useApp.getState().mountedTasks.has(tid),
      taskId,
    );
    expect(mounted).toBe(true);
  });

  it("closes a shell tab, which no other CLI verb can touch", async () => {
    // Shell tabs are write-only from the CLI (driving an uncaged terminal
    // remotely is the risk), but `tab --shell` can OPEN one, so close has
    // to reach it or the litter is unsweepable. Only agent tabs carry a
    // PtyRole, so this also exercises the path where the WEBVIEW is the
    // only side that can report the process died.
    const opened = await rpc({ cmd: "tab", task: "cli-tab-close", kind: { tab: "shell" } });
    expect(opened.ok).toBe(true);
    const shellTabId: string = opened.data.tab_id;
    await browser.waitUntil(
      () =>
        browser.execute(
          (tid, tab) =>
            (window.__termic!.useApp.getState().tabs[tid] ?? []).some(
              (t: any) => t.id === tab && t.ptyId,
            ),
          taskId,
          shellTabId,
        ),
      { timeout: 20_000, timeoutMsg: "the shell tab never got a PTY" },
    );

    // It is genuinely unreachable by the driving verbs...
    const driven = await rpc({ cmd: "logs", task: "cli-tab-close", tab: shellTabId });
    expect(driven.ok).toBe(false);
    expect(driven.error.code).toBe("unsupported");
    // ...and still closable.
    const r = await rpc({ cmd: "tab_close", task: "cli-tab-close", tab: shellTabId });
    expect(r.ok).toBe(true);
    expect(r.data.tab_kind).toBe("shell");
    expect(r.data.killed_pty).toBe(true);
    await browser.waitUntil(
      async () =>
        !(await browser.execute(
          (tid, tab) =>
            (window.__termic!.useApp.getState().tabs[tid] ?? []).some((t: any) => t.id === tab),
          taskId,
          shellTabId,
        )),
      { timeout: 10_000, timeoutMsg: "the closed shell tab is still in the strip" },
    );
  });

  it("leaves a Resume entry, so a closed agent is not lost for good", async () => {
    // syncDurableTabs has just forgotten the secondary tab; closedTabs is
    // the only place its session id survives, and it is what the "+"
    // menu's Resume section reads.
    const entries = await browser.execute(
      tid => window.__termic!.useApp.getState().closedTabs[tid] ?? [],
      taskId,
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].cli).toBe("fakeagent");
  });

  it("--yes takes the default tab, and says it comes back", async () => {
    // Last, because closing the default tab is also the last main tab
    // here, which puts the task to sleep.
    const r = await rpc({
      cmd: "tab_close",
      task: "cli-tab-close",
      tab: defaultTabId,
      yes: true,
    });
    expect(r.ok).toBe(true);
    expect(r.data.was_default).toBe(true);
    expect(r.data.killed_pty).toBe(true);
    await browser.waitUntil(
      async () =>
        !(await browser.execute(
          (tid, tab) =>
            (window.__termic!.useApp.getState().tabs[tid] ?? []).some((t: any) => t.id === tab),
          taskId,
          defaultTabId,
        )),
      { timeout: 10_000, timeoutMsg: "the default tab is still in the store's strip" },
    );
    // Durable: closing the default tab ends the agent for now, not for
    // good, so the task still carries it and will reopen it.
    const durable = await browser.execute(
      tid =>
        (window.__termic!.useApp.getState().tasks.find((t: any) => t.id === tid)?.persisted_tabs
          ?? []).map((t: any) => t.id),
      taskId,
    );
    expect(durable).toContain(defaultTabId);
  });
});

// `termic rename` (GH #153) over the REAL socket: the whole server path
// (auth, resolve_task_arg, the conflict pre-check, the rename_task
// webview RPC, the post-write disk re-read) in one thread. The unit
// suites stub the webview; this is the one place a broken RPC handler
// registration or a stale-reply regression surfaces.
describe("termic rename: label only, over the real socket (GH #153)", () => {
  let taskId: string;
  let otherId: string;

  after(async () => {
    if (taskId) await archiveTask(taskId);
    if (otherId) await archiveTask(otherId);
  });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("cli-rename", false);
    otherId = await openTask("cli-rename-other", false);
  });

  it("renames by explicit name; the reply and the store carry the new label", async () => {
    const r = await rpc({ cmd: "rename", task: "cli-rename", name: "PR 42 - retitled" });
    expect(r.ok).toBe(true);
    expect(r.data.kind).toBe("rename");
    expect(r.data.old_name).toBe("cli-rename");
    // The reply is the post-write re-read, so this pins "reply reflects
    // what was persisted" against the real disk, not a stub mirror.
    expect(r.data.task.name).toBe("PR 42 - retitled");
    const inStore = await browser.execute(
      (i) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === i)?.name,
      taskId,
    );
    expect(inStore).toBe("PR 42 - retitled");
  });

  it("refuses a same-project duplicate with a typed conflict", async () => {
    // Resolve by id, not by the name case 1 just set: ids also exercise
    // the resolver's id arm, and a case-1 failure then reports as ITS
    // assertion instead of a misleading not_found here.
    const r = await rpc({ cmd: "rename", task: taskId, name: "cli-rename-other" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("conflict");
    expect(r.error.message).toContain("cli-rename-other");
  });
});

// `termic new --from` / `--resume` (GH #169): adopt a worktree some outside
// script created, over the real socket. The full server thread runs: project
// resolution from the worktree's own repo (repo_worktrees), the import RPC
// into the webview, Rust's worktree validation, and the mount. The --resume
// SEEDING is pinned by unit suites on both sides (cli_server.rs, agents.test,
// cliTab.integration.test); here we pin the wiring plus the typed refusals a
// script would hit.
describe("termic new --from: adopt an existing worktree (GH #169)", () => {
  let repoRoot: string;
  let wtPath: string;
  let adoptedId: string | undefined;

  const git = (args: string, cwd: string) => execSync(`git ${args}`, { cwd, stdio: "pipe" });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    repoRoot = await browser.execute(
      () =>
        window.__termic!.useApp
          .getState()
          .projects.find((p: any) => p.name === "fixture-repo").root_path as string,
    );
    // The issue's shape: a worktree termic did NOT create, parked outside
    // every registered project root.
    wtPath = path.join(dataDir, "..", "adopt-me-wt");
    git(`worktree add -b adopt-me ${JSON.stringify(wtPath)}`, repoRoot);
  });

  after(async () => {
    // Archive removes the worktree dir; the prune + branch delete put the
    // fixture repo back exactly as seeded for later spec files. The prune
    // only drops OUR stale registration: the dir is already gone, unlike
    // the seeded sbcheck worktree, which stays intact.
    if (adoptedId) await archiveTask(adoptedId);
    try { git(`worktree remove --force ${JSON.stringify(wtPath)}`, repoRoot); } catch { /* archived */ }
    try { git("worktree prune", repoRoot); } catch { /* best-effort */ }
    try { git("branch -D adopt-me", repoRoot); } catch { /* best-effort */ }
  });

  it("adopts the worktree with --resume, seeding the session end to end", async () => {
    // fakeagent mirrors claude's registry entry, resume_id_args included,
    // so the WHOLE thread runs for real at zero tokens: socket → import →
    // agent_session_ids seed → mount → the default tab picks the id up.
    const r = await rpc({
      cmd: "new", name: "", from: wtPath, agent: "fakeagent", resume: "SESSION-EXT",
    });
    expect(r.ok).toBe(true);
    adoptedId = r.data.task.id;
    expect(r.data.task.name).toBe("adopt-me");
    expect(r.data.task.branch).toBe("adopt-me");
    expect(fs.realpathSync.native(r.data.task.path)).toBe(fs.realpathSync.native(wtPath));
    // The seed landed on the task and on the mounted default tab: this is
    // what the first spawn's `--resume {UUID}` expands from.
    const seeded = await browser.execute(id => {
      const s = window.__termic!.useApp.getState();
      const task = s.tasks.find((t: any) => t.id === id);
      const tab = (s.tabs[id!] ?? []).find((t: any) => t.is_default);
      return {
        sessionIds: task?.agent_session_ids,
        resumable: task?.has_resumable_history,
        tabSession: tab?.sessionId,
      };
    }, adoptedId);
    expect(seeded.sessionIds?.fakeagent).toBe("SESSION-EXT");
    // Deliberately false: the seed is per-cli, and the task-wide flag
    // would make OTHER agents' first tabs cwd-resume unrelated sessions.
    expect(seeded.resumable).toBe(false);
    expect(seeded.tabSession).toBe("SESSION-EXT");
  });

  it("--resume also seeds a plain create (no --from)", async () => {
    // GH #169 follow-up: the session field rides every create path, not
    // just import. A fresh worktree create carries the seed the same way.
    const r = await rpc({
      cmd: "new", name: "resume-create", mode: "worktree",
      agent: "fakeagent", resume: "SESSION-CREATE", project: "fixture-repo",
    });
    expect(r.ok).toBe(true);
    try {
      const seeded = await browser.execute(
        id =>
          window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)
            ?.agent_session_ids,
        r.data.task.id,
      );
      expect(seeded?.fakeagent).toBe("SESSION-CREATE");
    } finally {
      await archiveTask(r.data.task.id);
    }
  });

  it("a DERIVED name colliding with a live task auto-bumps past it", async () => {
    // A detached worktree derives its name from the dir basename, here
    // "adopt-me", colliding with the live task adopted above. Derived
    // names auto-bump past live twins (the GH #153 unique_task_name
    // rule); only a caller-TYPED name refuses as a conflict.
    const dupPath = path.join(dataDir, "..", "adopt-me");
    git(`worktree add --detach ${JSON.stringify(dupPath)}`, repoRoot);
    let bumpedId: string | undefined;
    try {
      const r = await rpc({ cmd: "new", name: "", from: dupPath, agent: "fakeagent" });
      expect(r.ok).toBe(true);
      bumpedId = r.data.task.id;
      expect(r.data.task.name).toBe("adopt-me-2");

      // The TYPED spelling of the same collision stays a typed conflict.
      const typed = await rpc({ cmd: "new", name: "adopt-me", from: dupPath, agent: "fakeagent" });
      expect(typed.ok).toBe(false);
      expect(typed.error.code).toBe("conflict");
      expect(typed.error.message).toContain("already");
    } finally {
      if (bumpedId) await archiveTask(bumpedId);
      try { git(`worktree remove --force ${JSON.stringify(dupPath)}`, repoRoot); } catch { /* best-effort */ }
      try { git("worktree prune", repoRoot); } catch { /* best-effort */ }
    }
  });

  it("re-adopting the same worktree is a clean error, not a second task", async () => {
    const r = await rpc({ cmd: "new", name: "", from: wtPath, agent: "fakeagent" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("conflict");
    expect(r.error.message).toContain("already open as a task");
  });

  it("a plain directory (no git anywhere above it) is refused", async () => {
    // NOT a dir inside the termic checkout: rev-parse would find THAT repo
    // and shift the error to unregistered-project, an environment accident.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "termic-e2e-plain-"));
    try {
      const r = await rpc({ cmd: "new", name: "", from: plain, agent: "fakeagent" });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("bad_request");
      expect(r.error.message).toContain("not a git worktree");
    } finally {
      fs.rmSync(plain, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  it("tab --resume seeds the NEW tab's own session id", async () => {
    const r = await rpc({
      cmd: "tab",
      task: "adopt-me",
      kind: { tab: "agent", id: "fakeagent" },
      resume: "SESSION-TAB",
    });
    expect(r.ok).toBe(true);
    const tabSession = await browser.execute(
      (id, tab) =>
        (window.__termic!.useApp.getState().tabs[id!] ?? []).find((t: any) => t.id === tab)
          ?.sessionId,
      adoptedId,
      r.data.tab_id as string,
    );
    expect(tabSession).toBe("SESSION-TAB");
  });

  it("--resume refuses an agent with no id-resume support, naming the gate", async () => {
    // An agent with no resume_id_args: a seeded id would be silently ignored
    // at spawn, so the server must refuse instead. Same gate on both verbs.
    //
    // A FIXTURE agent now (`fakenoresume`), because no built-in is an example
    // any more: agy was the last, until its hook learned to report its
    // conversation id and it gained `--conversation <id>`. The gate is keyed
    // on the capability, so the fixture is the honest subject.
    //
    // This used to use codex, which stopped being an example of the gate the
    // moment codex learned to resume by id: it now reports the id of the
    // session it started over its own hook, so `--resume` on codex is a real
    // request rather than one that could only be dropped on the floor. agy is
    // the built-in that still cannot, and the gate is keyed on
    // `resume_id_args` being empty rather than on any agent name, so this
    // needs an agent that has none, not a rename.
    const viaNew = await rpc({
      cmd: "new", name: "", from: wtPath, agent: "fakenoresume", resume: "SESSION-X",
    });
    expect(viaNew.ok).toBe(false);
    expect(viaNew.error.code).toBe("unsupported");
    expect(viaNew.error.message).toContain("cannot resume a session by id");

    const viaTab = await rpc({
      cmd: "tab",
      task: "adopt-me",
      kind: { tab: "agent", id: "fakenoresume" },
      resume: "SESSION-X",
    });
    expect(viaTab.ok).toBe(false);
    expect(viaTab.error.code).toBe("unsupported");
    expect(viaTab.error.message).toContain("cannot resume a session by id");
  });
});

// Phase 4: the prompt library over the REAL socket. The whole chain runs
// in one thread no unit suite sees end to end: auth -> the list_prompts
// webview RPC (the LIVE store, so edits made moments ago count) -> the
// Rust selector resolver -> body substitution into the confirmed
// delivery path -> the fake agent's PTY. The unit suites stub the
// webview on one side and the store on the other; this is where a
// broken registration or a shape drift between them surfaces.
describe("termic prompts + -P: prompt library access (Phase 4)", () => {
  let taskId: string;
  let customId: string;

  after(async () => {
    // Leave the profile as found (the settings reorder spec's rule):
    // delete exactly the prompt THIS spec minted, never a sweep of
    // every custom prompt (a seeded or sibling-spec prompt is not ours
    // to destroy).
    if (customId) {
      await browser.execute(
        (id: string) => window.__termic!.usePromptLibrary.getState().deletePrompt(id),
        customId,
      );
    }
    if (taskId) await archiveTask(taskId);
    // If the fail-fast case ever regresses, `new` creates the doomed
    // task BEFORE rejecting the selector; archive it so one red test
    // does not become cross-spec pollution. A miss is a harmless
    // ok:false reply.
    await rpc({ cmd: "archive", task: "cli-prompts-doomed" });
  });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
  });

  it("prompts lists the shipped library: ids and flags, no bodies", async () => {
    const r = await rpc({ cmd: "prompts" });
    expect(r.ok).toBe(true);
    const review = r.data.prompts.find((p: any) => p.id === "builtin:review");
    expect(review).toBeTruthy();
    expect(review.builtin).toBe(true);
    expect(review.enabled).toBe(true);
    // The list omits bodies; `show` is the body surface.
    expect(review.body).toBeUndefined();
  });

  it("show resolves ids and live titles, including disabled prompts", async () => {
    // Mint a custom prompt through the store's own action: the CLI must
    // see it immediately (fire-time resolution against the live store).
    customId = (await browser.execute(() =>
      window.__termic!.usePromptLibrary.getState().addPrompt({
        title: "E2E handoff", body: "E2E-BODY-LINE",
      }),
    )) as string;
    const byId = await rpc({ cmd: "prompts", selector: customId });
    expect(byId.ok).toBe(true);
    expect(byId.data.prompts[0].body).toBe("E2E-BODY-LINE");
    // Case-insensitive exact title resolves to the same identity.
    const byTitle = await rpc({ cmd: "prompts", selector: "e2e HANDOFF" });
    expect(byTitle.ok).toBe(true);
    expect(byTitle.data.prompts[0].id).toBe(customId);
    // Disabled = hidden from the dropdown, not dead: still resolvable.
    await browser.execute(
      (id: string) => window.__termic!.usePromptLibrary.getState().toggleEnabled(id),
      customId,
    );
    const disabled = await rpc({ cmd: "prompts", selector: customId });
    expect(disabled.ok).toBe(true);
    expect(disabled.data.prompts[0].enabled).toBe(false);
    // A miss is a typed error pointing at discovery.
    const miss = await rpc({ cmd: "prompts", selector: "no-such-prompt" });
    expect(miss.ok).toBe(false);
    expect(miss.error.code).toBe("not_found");
    expect(miss.error.message).toContain("termic prompts");
  });

  it("send -P composes the library body with the -p text into the agent", async () => {
    // Guard the cross-`it` dependency: if the show case failed before
    // minting the prompt, prompt_ref: undefined would be DROPPED by
    // JSON.stringify and this would degrade into a passing plain send
    // that then dies on the wrong assertion 20s later.
    expect(customId).toBeTruthy();
    taskId = await openTask("cli-prompts");
    await browser.waitUntil(
      () =>
        browser.execute(
          tid =>
            (window.__termic!.useApp.getState().tabs[tid] ?? []).some(
              (t: any) => t.ptyId,
            ),
          taskId,
        ),
      { timeout: 20_000, timeoutMsg: "default agent PTY never spawned" },
    );
    await browser.waitUntil(
      async () => (await rpc({ cmd: "logs", task: "cli-prompts" })).ok === true,
      { timeout: 20_000, interval: 250, timeoutMsg: "the CLI never resolved the default tab" },
    );
    const marker = `MARKER-LIB-${Date.now()}`;
    const r = await rpc({
      cmd: "send", task: "cli-prompts", prompt: marker, prompt_ref: customId,
    });
    expect(r.ok).toBe(true);
    // Both halves of the composition reach the SAME agent: the library
    // body line and the literal text behind it.
    await browser.waitUntil(
      async () => {
        const logs = await rpc({ cmd: "logs", task: "cli-prompts" });
        return (
          logs.ok
          && logs.data.data.includes("E2E-BODY-LINE")
          && logs.data.data.includes(marker)
        );
      },
      { timeout: 20_000, timeoutMsg: "the composed prompt never reached the agent" },
    );
  });

  it("a bad -P fails fast: typed error, no task created", async () => {
    const r = await rpc({
      cmd: "new", name: "cli-prompts-doomed", project: "fixture-repo",
      prompt_ref: "no-such-prompt",
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("not_found");
    const list = await rpc({ cmd: "list" });
    expect(list.ok).toBe(true);
    expect(list.data.tasks.some((t: any) => t.name === "cli-prompts-doomed")).toBe(false);
  });
});

// `termic new --base` (GH report against 1.3.2). The bug was a SWALLOWED
// failure, not a ref-syntax problem: an unresolvable base fell back to the
// main checkout's HEAD, so the create exited 0, the summary line echoed the
// ref the caller asked for, and the worktree quietly held different code.
// Reported by someone driving four PR reviews, one worktree each: the agent
// spent its first minutes reviewing an unrelated branch and said so
// confidently.
//
// Over the REAL socket, because that is the surface the report is against and
// the resolution happens in Rust behind it.
describe("termic new --base resolves or refuses (GH report, 1.3.2)", () => {
  const gitIn = (cwd: string, args: string) =>
    execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();

  let fixture = "";
  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    fixture = await browser.execute(() =>
      (window.__termic!.useApp.getState().projects
        .find((p: any) => p.name === "fixture-repo") as any).root_path);
  });

  it("refuses an unresolvable base, and creates nothing", async () => {
    const before = gitIn(fixture, "rev-parse HEAD");
    const r = await rpc({
      cmd: "new", name: "base-garbage", mode: "worktree",
      agent: "fakeagent", project: "fixture-repo", base: "this-ref-does-not-exist",
    });
    // Exit non-zero, which for the socket is ok:false. The report's own note
    // applies to the shell: `termic ... | sed`; $? reports sed, not termic.
    expect(r.ok).toBe(false);
    expect(String(r.error?.message ?? "")).toContain("this-ref-does-not-exist");

    // No task...
    const tasks = await browser.execute(() =>
      window.__termic!.useApp.getState().tasks.map((t: any) => t.name));
    expect(tasks).not.toContain("base-garbage");
    // ...and no branch left behind in the fixture.
    expect(gitIn(fixture, "branch --list base-garbage")).toBe("");
    expect(gitIn(fixture, "rev-parse HEAD")).toBe(before);
  });

  it("resolves a bare name that exists only as origin/<name>", async () => {
    // The common case, not an edge one: `gh pr view <n> --json headRefName`
    // returns a BARE name, and a branch outside remote.origin.fetch exists
    // only under refs/remotes. `git rev-parse --verify <name>` fails on it.
    //
    // The base is deliberately NOT the main checkout's HEAD, or this test
    // passes for the wrong reason against the very bug it is about.
    const head = gitIn(fixture, "rev-parse HEAD");
    let tip = "";
    try {
      gitIn(fixture, "branch e2e-remote-only");
      // Give the branch its own commit, push it, then delete it locally so
      // the name survives only as refs/remotes/origin/e2e-remote-only.
      gitIn(fixture, "checkout -q e2e-remote-only");
      gitIn(fixture, "-c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m \"remote-only tip\"");
      tip = gitIn(fixture, "rev-parse HEAD");
      gitIn(fixture, "push -q origin e2e-remote-only");
      gitIn(fixture, "checkout -q main");
      gitIn(fixture, "branch -q -D e2e-remote-only");
      expect(tip).not.toBe(gitIn(fixture, "rev-parse HEAD"));

      const r = await rpc({
        cmd: "new", name: "base-dwim", mode: "worktree",
        agent: "fakeagent", project: "fixture-repo", base: "e2e-remote-only",
      });
      expect(r.ok).toBe(true);
      // THE assertion: the worktree's HEAD is the base's commit, not the main
      // checkout's. Asserting only that the create succeeded would pass with
      // the bug present.
      expect(gitIn(r.data.task.path, "rev-parse HEAD")).toBe(tip);
      await archiveTask(r.data.task.id);
    } finally {
      try { gitIn(fixture, "checkout -q main"); } catch { /* already there */ }
      try { gitIn(fixture, "push -q origin --delete e2e-remote-only"); } catch { /* gone */ }
      try { gitIn(fixture, "branch -q -D e2e-remote-only"); } catch { /* gone */ }
      try { gitIn(fixture, "reset -q --hard " + head); } catch { /* fine */ }
    }
  });
});

describe("termic new --checkout: an existing branch into a new worktree", () => {
  const gitIn = (cwd: string, args: string) =>
    execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
  const BRANCH = "e2e-cli-colleague/fix";

  let fixture = "";
  let tip = "";
  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    fixture = await browser.execute(() =>
      (window.__termic!.useApp.getState().projects
        .find((p: any) => p.name === "fixture-repo") as any).root_path);
    // A commit of its own, pushed straight to the remote without ever being
    // a local branch or touching the main checkout: exactly a colleague's
    // branch, as far as this repo can tell.
    tip = gitIn(fixture, `-c user.email=e2e@termic.dev -c user.name=e2e commit-tree "HEAD^{tree}" -p HEAD -m "colleague work"`);
    gitIn(fixture, `push -q origin ${tip}:refs/heads/${BRANCH}`);
  });
  after(async () => {
    await browser.execute(async (name) => {
      const t = window.__termic!;
      for (const task of t.useApp.getState().tasks) {
        if (task.name === name && !task.archived) await t.ipc.taskArchive(task.id, true);
      }
      await t.useApp.getState().loadAll();
    }, BRANCH);
    for (const args of [
      "worktree prune",
      `branch -q -D ${BRANCH}`,
      `update-ref -d refs/remotes/origin/${BRANCH}`,
      `push -q origin --delete ${BRANCH}`,
    ]) {
      try { gitIn(fixture, args); } catch { /* already gone */ }
    }
  });

  it("checks out a remote-only branch, naming the task after it", async () => {
    const r = await rpc({
      cmd: "new", name: "", checkout: `origin/${BRANCH}`,
      agent: "fakeagent", project: "fixture-repo",
    });
    expect(r.ok).toBe(true);
    expect(r.data.task.name).toBe(BRANCH);
    expect(r.data.task.branch).toBe(BRANCH);
    // On the colleague's commit, not the main checkout's: asserting only that
    // the create succeeded would pass with a fresh branch cut from main.
    expect(gitIn(r.data.task.path, "rev-parse HEAD")).toBe(tip);
    expect(tip).not.toBe(gitIn(fixture, "rev-parse HEAD"));
    expect(gitIn(fixture, `rev-parse --abbrev-ref ${BRANCH}@{upstream}`)).toBe(`origin/${BRANCH}`);
  });

  it("refuses a checkout into the main checkout, and creates nothing", async () => {
    const r = await rpc({
      cmd: "new", name: "checkout-main", checkout: BRANCH, mode: "main",
      agent: "fakeagent", project: "fixture-repo",
    });
    expect(r.ok).toBe(false);
    expect(String(r.error?.message ?? "")).toContain("checkout");
    const tasks = await browser.execute(() =>
      window.__termic!.useApp.getState().tasks.map((t: any) => t.name));
    expect(tasks).not.toContain("checkout-main");
  });
});

describe("termic new task parameters (GH #287)", () => {
  let taskId = "";

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await waitForClisDetected();
  });

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("persists --arg/--model and passes them to the default agent", async () => {
    const name = `cli-task-args-${Date.now()}`;
    // `runCli` resolves the sidecar this machine actually built (the universal
    // one only exists when both macOS rustup targets are installed) and
    // reports a failure in plain text. Spawning it directly threw Node's own
    // error, whose self-referencing `error` property made wdio's serializer
    // die with "Converting circular structure to JSON" - so the real reason,
    // a binary that was never staged under that name, never reached the log.
    const stdout = runCli([
      "--no-launch", "--json", "new", name,
      "--agent", "fakeagent", "--project", "fixture-repo", "--worktree", "--open",
      "--arg=--reasoning-effort", "--arg=low", "--model", "worker",
    ], { TERMIC_DATA_DIR: dataDir });
    const created = JSON.parse(stdout);
    taskId = created.task.id;
    expect(created.task.agent_args).toEqual([
      "--reasoning-effort", "low", "--model", "worker",
    ]);

    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "tasks", `${taskId}.json`), "utf8"));
    expect(stored.agent_args).toEqual(created.task.agent_args);

    await browser.waitUntil(async () => {
      const logs = await rpc({ cmd: "logs", task: taskId });
      return logs.ok && String(logs.data?.data ?? "").includes(
        "--reasoning-effort low --model worker",
      );
    }, {
      timeout: 20_000,
      interval: 250,
      timeoutMsg: "the fake agent never received the task-specific argv",
    });
  });
});
