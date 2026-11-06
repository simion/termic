// The e2e binary substitutes a fake OS adapter. These cases drive the real
// popover, IPC, native policy and (for automatic mode) real PTY hook bytes.
import { writeFileSync, rmSync, existsSync, mkdtempSync, constants, openSync, writeSync, closeSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { dataDir } from "../../wdio.conf.js";
import {
  waitForAppShell, requireTermicApi, clickWhenVisible, waitVisible, waitGone,
  setInputValue, snap, createWorktreeTask, archiveTask, waitForAgentReady,
  submitToAgent, dismissOverlays,
} from "../helpers.js";

const TRIGGER = '[data-testid="caffeinate-trigger"]';
const PANEL = '[data-testid="caffeinate-panel"]';
const STATUS = '[data-testid="caffeinate-status"]';
const APPLY = '[data-testid="caffeinate-apply"]';
const STOP = '[data-testid="caffeinate-stop"]';
const ERROR = '[data-testid="caffeinate-error"]';
const failureFile = path.join(dataDir, "e2e-caffeinate-fail");
const visibleRun = !!process.env.TERMIC_E2E_VISIBLE && process.env.TERMIC_E2E_VISIBLE !== "0";
const originalFooterOrder = ["caffeinate-trigger", "theme-picker", "sidebar-report-bug", "sidebar-contact", "sidebar-shortcuts", "open-activity", "sidebar-settings"];
const footerOrder = () => browser.execute(() => [...document.querySelectorAll('[data-testid="sidebar-footer"] button')].map(el => el.getAttribute("data-testid")));
const text = (selector: string) => browser.execute(s => document.querySelector(s)?.textContent ?? "", selector);
const mode = () => browser.execute(s => document.querySelector(s)?.getAttribute("data-mode"), TRIGGER);
const active = () => browser.execute(s => document.querySelector(s)?.getAttribute("data-active") === "true", TRIGGER);

async function capture(name: string): Promise<void> {
  await browser.waitUntil(async () => await browser.execute((s, paint) => {
    const panel = document.querySelector('[data-testid="caffeinate-panel"]');
    const apply = document.querySelector<HTMLButtonElement>(s);
    if (!panel || !apply || panel.getAttribute("aria-busy") === "true") return false;
    const popover = panel.closest('[data-state="open"]');
    if (!popover) return false;
    // Offscreen WebKit can park transitions. Visible capture runs check paint;
    // functional runs assert DOM controls and native state independently.
    if (paint && (getComputedStyle(popover).opacity !== "1"
      || popover.getAnimations().some(a => a.playState === "running" || a.pending))) return false;
    return panel.querySelectorAll('input[type="radio"]').length === 3
      && [...panel.querySelectorAll('input[type="radio"], input[type="checkbox"], button')].filter(el => !el.closest('details:not([open])')).every(el => {
        const style = getComputedStyle(el); const rect = el.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0
          && (el instanceof HTMLButtonElement && el.disabled || !!hit && (hit === el || el.contains(hit)));
      });
  }, APPLY, visibleRun));
  await browser.execute(s => document.querySelector<HTMLButtonElement>(s)!.focus(), APPLY);
  if (visibleRun) {
    // Retain both snapshots for visual inspection without waiting on rAF,
    // which WKWebView can park even in a visible but occluded window.
    await snap(name.replace(".png", "-initial.png"));
  }
  await snap(name);
}

async function open(): Promise<void> {
  const isOpen = await browser.execute(s => !!document.querySelector(s), PANEL);
  if (!isOpen) await clickWhenVisible(TRIGGER);
  await waitVisible(PANEL);
}
async function stop(): Promise<void> {
  await open();
  if (await mode() !== "off") await clickWhenVisible(STOP);
  await browser.waitUntil(async () => await mode() === "off" && !await active());
}

describe("caffeinate", () => {
  let task = "";
  let sidebarBefore: { compactSidebar: boolean; sidebarWidth: number } | undefined;
  before(async () => {
    await waitForAppShell(); await requireTermicApi();
    sidebarBefore = await browser.execute(() => {
      const { compactSidebar, sidebarWidth } = window.__termic!.useApp.getState();
      window.__termic!.useApp.setState({ compactSidebar: false });
      return { compactSidebar, sidebarWidth };
    });
    await waitVisible('[data-testid="sidebar-report-bug"]');
    await waitVisible('[data-testid="sidebar-contact"]');
    expect(await footerOrder()).toEqual(originalFooterOrder);
  });
  after(async () => {
    rmSync(failureFile, { force: true });
    await browser.execute(() => { try { localStorage.removeItem("caffeinateHours"); } catch { /* private mode */ } });
    await browser.execute(async () => { await window.__termic!.invoke("caffeinate_set", { request: { mode: "off" } }); });
    if (sidebarBefore) await browser.execute(value => window.__termic!.useApp.setState(value), sidebarBefore);
    if (task) await archiveTask(task);
    await dismissOverlays();
  });

  it("validates a duration, starts it, and keeps it running while editing", async () => {
    await open();
    await browser.waitUntil(async () => (await text(STATUS)).includes("Caffeinate is off"));
    await capture("caffeinate-off.png");
    await clickWhenVisible('[data-testid="caffeinate-choice-duration"]');
    await setInputValue('[data-testid="caffeinate-hours"]', "0");
    await clickWhenVisible(APPLY);
    await waitVisible(ERROR);
    expect(await text(ERROR)).toContain("greater than zero");
    expect(await active()).toBe(false);
    await setInputValue('[data-testid="caffeinate-hours"]', "2");
    await browser.execute(s => document.querySelector<HTMLElement>(s)!.focus(), APPLY);
    await clickWhenVisible(APPLY);
    await browser.waitUntil(active);
    expect(await mode()).toBe("duration");
    await waitVisible('[data-testid="caffeinate-current"]');
    expect(await text(STATUS)).toContain("Keeping awake");
    await browser.waitUntil(async () => await browser.execute(s => document.activeElement === document.querySelector(s), STATUS));
    await capture("caffeinate-duration.png");
    // Browsing radio options has no immediate Off action.
    await clickWhenVisible('[data-testid="caffeinate-choice-agents"]');
    expect(await mode()).toBe("duration");
    expect(await active()).toBe(true);
    await browser.execute(s => document.querySelector<HTMLElement>(s)!.focus(), STOP);
    await stop();
    await browser.waitUntil(async () => await browser.execute(s => document.activeElement === document.querySelector(s), STATUS));
  });

  it("offers 16 and 24 hours, explains pending changes, and restores the accepted choice", async () => {
    await open(); await clickWhenVisible('[data-testid="caffeinate-choice-duration"]');
    for (const hours of [1, 2, 4, 8, 16, 24, "indefinite"]) await waitVisible(`[data-testid="caffeinate-preset-${hours}"]`);
    await clickWhenVisible('[data-testid="caffeinate-preset-16"]');
    expect(await text(APPLY)).toBe("Keep awake for 16 hours");
    await clickWhenVisible(APPLY); await browser.waitUntil(active);
    await waitVisible('[data-testid="caffeinate-current"]');
    const before = await text(STATUS);
    await clickWhenVisible('[data-testid="caffeinate-preset-24"]');
    await waitVisible('[data-testid="caffeinate-pending"]');
    expect(await text(APPLY)).toBe("Keep awake for 24 hours");
    expect(await text(STATUS)).toBe(before);
    await clickWhenVisible(APPLY); await waitVisible('[data-testid="caffeinate-current"]');
    await browser.keys("Escape"); await waitGone(PANEL); await open();
    expect(await browser.execute(() => document.querySelector<HTMLInputElement>('[data-testid="caffeinate-hours"]')!.value)).toBe("24");
    expect(await browser.execute(() => document.querySelector('[data-testid="caffeinate-preset-24"]')!.getAttribute("aria-pressed"))).toBe("true");
    await capture("caffeinate-24-hours.png");
    await setInputValue('[data-testid="caffeinate-hours"]', "6");
    expect(await text(APPLY)).toBe("Keep awake for 6 hours");
    await waitVisible('[data-testid="caffeinate-pending"]');
    await capture("caffeinate-draft.png");
    await browser.keys("Escape"); await waitGone(PANEL); await open();
    expect(await browser.execute(() => document.querySelector<HTMLInputElement>('[data-testid="caffeinate-hours"]')!.value)).toBe("24");
    await waitVisible('[data-testid="caffeinate-current"]');
    expect(await browser.execute(s => [...document.querySelectorAll(`${s} button`)].map(el => el.textContent?.trim()).some(label => ["Start", "Stop", "Apply"].includes(label ?? "")), PANEL)).toBe(false);
    await stop();
  });

  it("runs until turned off from the ∞ preset, and says the computer stays awake with the display off", async () => {
    const DISPLAY = '[data-testid="caffeinate-display"]';
    const HINT = '[data-testid="caffeinate-display-hint"]';
    const DISPLAY_STATUS = '[data-testid="caffeinate-display-status"]';
    const native = () => browser.execute(async () => await window.__termic!.invoke("caffeinate_status") as { mode: string; display: boolean; deadline_ms: number | null });
    await open(); await clickWhenVisible('[data-testid="caffeinate-choice-duration"]');
    // Unchecked, the copy states the computer itself does not sleep.
    expect(await browser.execute(s => document.querySelector<HTMLInputElement>(s)!.checked, DISPLAY)).toBe(false);
    expect(await text(HINT)).toContain("your computer stays awake");
    await clickWhenVisible('[data-testid="caffeinate-preset-indefinite"]');
    expect(await text(APPLY)).toBe("Keep awake until turned off");
    await clickWhenVisible(APPLY);
    await browser.waitUntil(async () => await active() && await mode() === "indefinite");
    expect(await native()).toMatchObject({ mode: "indefinite", display: false, deadline_ms: null });
    expect(await text(STATUS)).toContain("Until you turn it off");
    expect(await browser.execute(s => document.querySelector(s)?.getAttribute("data-display"), DISPLAY_STATUS)).toBe("false");
    expect(await text(DISPLAY_STATUS)).toBe("The display can turn off. Your computer stays awake.");
    await capture("caffeinate-indefinite.png");

    // The display toggle alone is a pending change against the running session.
    await clickWhenVisible(DISPLAY);
    await waitVisible('[data-testid="caffeinate-pending"]');
    expect(await text(HINT)).toBe("The screen stays on too while caffeinate is active.");
    expect((await native()).display).toBe(false);
    await clickWhenVisible(APPLY); await waitVisible('[data-testid="caffeinate-current"]');
    await browser.waitUntil(async () => (await native()).display);
    expect(await text(DISPLAY_STATUS)).toBe("The display stays on.");
    await capture("caffeinate-indefinite-display.png");

    // Reopening restores both the ∞ preset and the display choice.
    await browser.keys("Escape"); await waitGone(PANEL); await open();
    expect(await browser.execute(() => document.querySelector('[data-testid="caffeinate-preset-indefinite"]')!.getAttribute("aria-pressed"))).toBe("true");
    expect(await browser.execute(s => document.querySelector<HTMLInputElement>(s)!.checked, DISPLAY)).toBe(true);
    await waitVisible('[data-testid="caffeinate-current"]');
    await stop();
    expect(await native()).toMatchObject({ mode: "off", display: false });
    expect(await browser.execute(s => !!document.querySelector(s), DISPLAY_STATUS)).toBe(false);
    // Off again, the next session offers the duration last started, not 2h.
    await browser.keys("Escape"); await waitGone(PANEL); await open();
    expect(await browser.execute(() => document.querySelector('[data-testid="caffeinate-preset-indefinite"]')!.getAttribute("aria-pressed"))).toBe("true");
    expect(await text(APPLY)).toBe("Keep awake until turned off");
  });

  it("validates an until deadline and replaces an active session", async () => {
    await open(); await clickWhenVisible('[data-testid="caffeinate-choice-until"]');
    await setInputValue('[data-testid="caffeinate-until"]', "2000-01-01T12:00");
    await clickWhenVisible(APPLY); await waitVisible(ERROR);
    expect(await text(ERROR)).toContain("future local time");
    const end = await browser.execute(() => {
      const date = new Date(Date.now() + 7_200_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
    });
    await setInputValue('[data-testid="caffeinate-until"]', end);
    await clickWhenVisible(APPLY);
    await browser.waitUntil(async () => await active() && await mode() === "until");
    await capture("caffeinate-until.png"); await stop();
  });

  it("expires in the native worker without a frontend countdown", async () => {
    await browser.execute(async () => {
      await window.__termic!.invoke("caffeinate_set", { request: { mode: "duration", duration_minutes: 0.04 } });
    });
    await browser.waitUntil(active);
    await browser.waitUntil(async () => await mode() === "off" && !await active(), { timeout: 8_000 });
  });

  it("surfaces acquisition failure instead of lighting the mug", async () => {
    writeFileSync(failureFile, "fixture failure\n");
    try {
      await open(); await clickWhenVisible('[data-testid="caffeinate-choice-duration"]');
      await setInputValue('[data-testid="caffeinate-hours"]', "1");
      await clickWhenVisible(APPLY); await waitVisible(ERROR);
      expect(await text(ERROR)).toContain("Simulated power adapter failure");
      expect(await active()).toBe(false);
      await capture("caffeinate-error.png");
      await stop();
    } finally { rmSync(failureFile, { force: true }); }
  });

  it("arms automatic mode and observes delegated work from real PTY bytes", async () => {
    await open(); await clickWhenVisible('[data-testid="caffeinate-choice-agents"]');
    await clickWhenVisible(APPLY);
    await browser.waitUntil(async () => await mode() === "agents");
    expect(await text(STATUS)).toContain("Automatic mode is on");
    expect(await text(STATUS)).toContain("Your computer can sleep until an agent starts working");
    await capture("caffeinate-armed.png");
    await browser.keys("Escape"); await waitGone(PANEL);
    task = await createWorktreeTask("caffeinate-fixture", "e2e/caffeinate-fixture");
    await waitForAgentReady(task);
    await submitToAgent(task, "#delegated 1 subagent fixture-child");
    await browser.waitUntil(active, { timeout: 10_000 });
    await open();
    await browser.waitUntil(async () => (await text(STATUS)).includes("1 agent working"));
    await capture("caffeinate-working.png");
    await stop();
  });

  it("sets up optional lid control and stops it with the session", async () => {
    await open(); await clickWhenVisible('[data-testid="caffeinate-choice-duration"]');
    await setInputValue('[data-testid="caffeinate-hours"]', "1");
    if (process.platform === "darwin") {
      // The feature-gated adapter changes its permission flag, never sudoers.
      await browser.execute(async () => { await window.__termic!.invoke("caffeinate_permission", { install: false }); });
    }
    await clickWhenVisible('[data-testid="caffeinate-lid"]');
    if (process.platform === "darwin") {
      await clickWhenVisible('[data-testid="caffeinate-setup"]');
      await browser.waitUntil(async () => await browser.execute(s => !(document.querySelector(s) as HTMLButtonElement)?.disabled, APPLY));
    }
    await clickWhenVisible(APPLY);
    await browser.waitUntil(async () => await browser.execute(() => document.querySelector('[data-testid="caffeinate-lid-status"]')?.getAttribute("data-active") === "true"));
    await capture("caffeinate-lid.png");
    await stop();
    await browser.waitUntil(async () => !await browser.execute(() => !!document.querySelector('[data-testid="caffeinate-lid-status"]')));
  });

  it("reports a restore that needs approval and finishes it from Restore normal sleep", async () => {
    // The fake adapter models a revoked macOS rule: the unattended restore
    // fails, and only the interactive one behind the button can clear it.
    const revoked = path.join(dataDir, "caffeinate-lid.needs-approval");
    try {
      await open(); await clickWhenVisible('[data-testid="caffeinate-choice-duration"]');
      await setInputValue('[data-testid="caffeinate-hours"]', "1");
      if (!await browser.execute(() => document.querySelector<HTMLInputElement>('[data-testid="caffeinate-lid"]')!.checked)) {
        await clickWhenVisible('[data-testid="caffeinate-lid"]');
      }
      await clickWhenVisible(APPLY);
      // Flaked once in a full local run and never alone: when it times out,
      // say what the panel showed (the lid row is gone if the guard failed to
      // start, and the error line says why).
      await browser.waitUntil(async () => await browser.execute(() => document.querySelector('[data-testid="caffeinate-lid-status"]')?.getAttribute("data-active") === "true"))
        .catch(async () => {
          const seen = await browser.execute((e) => ({
            lid: document.querySelector('[data-testid="caffeinate-lid-status"]')?.getAttribute("data-active") ?? "<no lid row>",
            error: document.querySelector(e)?.textContent ?? "",
            mode: document.querySelector('[data-testid="caffeinate-trigger"]')?.getAttribute("data-mode"),
          }), ERROR);
          throw new Error(`the lid guard never went active: ${JSON.stringify(seen)}`);
        });
      writeFileSync(revoked, "");
      await clickWhenVisible(STOP);
      await waitVisible('[data-testid="caffeinate-restore"]');
      expect(await text(ERROR)).toContain("Restore normal sleep");
      expect(existsSync(path.join(dataDir, "caffeinate-lid.json"))).toBe(true);
      await clickWhenVisible('[data-testid="caffeinate-restore"]');
      // Also flaked once in a full run: say what the panel and the journal
      // files looked like if the restore never cleared.
      await waitGone('[data-testid="caffeinate-restore"]').catch(async (e) => {
        const error = await text(ERROR);
        throw new Error(`${(e as Error).message}; error line: ${JSON.stringify(error)}; ` +
          `needs-approval file: ${existsSync(revoked)}; journal: ${existsSync(path.join(dataDir, "caffeinate-lid.json"))}`);
      });
      expect(existsSync(revoked)).toBe(false);
      expect(existsSync(path.join(dataDir, "caffeinate-lid.json"))).toBe(false);
    } finally { rmSync(revoked, { force: true }); }
  });

  it("expires while administrator authorization is still pending", async function () {
    if (process.platform !== "darwin") { this.skip(); return; }
    await stop();
    await browser.execute(async () => { await window.__termic!.invoke("caffeinate_permission", { install: false }); });
    await clickWhenVisible('[data-testid="caffeinate-choice-duration"]');
    const gate = path.join(dataDir, "e2e-caffeinate-permission-gate");
    rmSync(gate, { force: true });
    execFileSync("mkfifo", [gate]);
    try {
      await browser.execute(async () => {
        await window.__termic!.invoke("caffeinate_set", { request: { mode: "duration", duration_minutes: 0.08 } });
      });
      if (!await browser.execute(() => document.querySelector<HTMLInputElement>('[data-testid="caffeinate-lid"]')!.checked)) {
        await clickWhenVisible('[data-testid="caffeinate-lid"]');
      }
      await clickWhenVisible('[data-testid="caffeinate-setup"]');
      await browser.waitUntil(async () => await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="caffeinate-setup"]')?.disabled === true));
      await browser.waitUntil(async () => await mode() === "off" && !await active(), { timeout: 8_000 });
      expect(await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="caffeinate-setup"]')?.disabled)).toBe(true);
    } finally {
      // Never block cleanup if setup failed before opening the reader.
      let fd: number | undefined;
      try { fd = openSync(gate, constants.O_WRONLY | constants.O_NONBLOCK); writeSync(fd, "continue"); }
      catch { /* no pending reader */ }
      finally { if (fd != null) closeSync(fd); rmSync(gate, { force: true }); }
    }
    await waitGone('[data-testid="caffeinate-setup"]');
    await browser.keys("Escape"); await waitGone(PANEL);
  });

  it("keeps controls reachable in the compact rail and narrow expanded sidebar", async () => {
    await browser.keys("Escape"); await waitGone(PANEL);
    await browser.execute(() => window.__termic!.useApp.setState({ compactSidebar: true }));
    if (visibleRun) await browser.waitUntil(async () => await browser.execute(() => document.querySelector('[data-testid="sidebar-footer"]')!.getBoundingClientRect().width <= 56));
    await open(); await capture("caffeinate-compact.png");
    expect(await footerOrder()).toEqual(originalFooterOrder);
    await waitVisible('[data-testid="sidebar-report-bug"]');
    await waitVisible('[data-testid="sidebar-contact"]');
    await browser.keys("Escape"); await waitGone(PANEL);
    await browser.execute(() => window.__termic!.useApp.setState({ compactSidebar: false, sidebarWidth: 160 }));
    await open();
    await waitVisible('[data-testid="sidebar-report-bug"]');
    await waitVisible('[data-testid="sidebar-contact"]');
    if (visibleRun) await browser.waitUntil(async () => (await browser.execute(() => {
      const footer = document.querySelector('[data-testid="sidebar-footer"]')!;
      const bounds = footer.getBoundingClientRect();
      if (bounds.width < 158.5) return [{ name: 'resizing', left: bounds.left, right: bounds.right }];
      return [...footer.querySelectorAll('button')].map(el => {
        const rect = el.getBoundingClientRect();
        return { name: el.getAttribute('aria-label') ?? el.getAttribute('data-testid'), left: rect.left, right: rect.right, cssWidth: Number.parseFloat(getComputedStyle(el).width), footerLeft: bounds.left, footerRight: bounds.right };
      }).filter(rect => rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5 || rect.cssWidth < 19.5);
    })).length === 0, { timeout: 5_000, timeoutMsg: "footer controls overflow after the sidebar finishes resizing" });
    await capture("caffeinate-narrow.png");
    await browser.keys("Escape"); await waitGone(PANEL);
    await waitVisible('[data-testid="sidebar-shortcuts"]');
    await waitVisible('[data-testid="open-activity"]');
    await waitVisible('[data-testid="sidebar-settings"]');
    expect(await footerOrder()).toEqual(originalFooterOrder);
    await browser.execute(sidebarWidth => window.__termic!.useApp.setState({ sidebarWidth }), sidebarBefore!.sidebarWidth);
  });

  it("the guard restores its fake override after parent EOF, deadline expiry, quit and a termination signal", async () => {
    const dir = mkdtempSync(path.join(dataDir, "e2e-caffeinate-guard-"));
    const binary = process.env.TERMIC_E2E_BINARY || path.resolve(dataDir, "../../src-tauri/target/debug", process.platform === "win32" ? "termic.exe" : "termic");
    try {
      // Logout and shutdown send SIGTERM instead of closing the pipe, and a
      // quitting Termic says `quit`. Windows ends a session through
      // WM_ENDSESSION, which no spec can send.
      const endings: ("eof" | "deadline" | "quit" | "signal")[] = ["eof", "deadline", "quit", ...(process.platform === "win32" ? [] : ["signal" as const])];
      for (const ending of endings) {
        const journal = path.join(dir, `${ending}.json`);
        const child = spawn(binary, ["--termic-caffeinate-guard", journal], { stdio: ["pipe", "pipe", "pipe"] });
        const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`guard exit ${code}`))); });
        try {
          child.stdin.write(`${JSON.stringify({ wall: ending === "deadline" ? Date.now() + 2_000 : null, elapsed: null })}\n`);
          await browser.waitUntil(() => existsSync(journal), { timeout: 5_000 });
          if (ending === "eof") child.stdin.end();
          if (ending === "quit") child.stdin.end("quit\n");
          // Exit code 0, not death by signal: the guard caught it and restored.
          if (ending === "signal") child.kill("SIGTERM");
          await exited;
          expect(existsSync(journal)).toBe(false);
        } finally { if (child.exitCode == null) child.kill(); }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
