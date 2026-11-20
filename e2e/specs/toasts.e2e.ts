// The bottom-right notification stack (src/components/ui/Toaster.tsx):
// a collapsed deck that fans out on hover, buttons, the X, slide-out
// removal, and timers that pause while the pointer is on the stack.
import { waitForAppShell, requireTermicApi, waitVisible, snap } from "../helpers.js";

const STACK = '[data-testid="toast-stack"]';
const CARD = '[data-testid="toast"]';

const push = (msg: string, kind: string, opts: Record<string, unknown> = {}) =>
  browser.execute((m, k, o) => {
    const w = window as any;
    w.__toastClicks ??= [];
    const withActions = (o as any).actionLabels
      ? { ...o, actions: (o as any).actionLabels.map((label: string) => ({ label, onClick: () => w.__toastClicks.push(label) })) }
      : o;
    return window.__termic!.useUI.getState().pushToast(m, k as any, withActions as any);
  }, msg, kind, opts);
const storeCount = () => browser.execute(() => window.__termic!.useUI.getState().toasts.length);
const domCount = () => browser.execute(s => document.querySelectorAll(s).length, CARD);
const clearAll = () => browser.execute(() => {
  window.__termic!.useUI.setState({ toasts: [] });
  for (const k of [...window.__termic!.usePrefs.getState().mutedNotices]) window.__termic!.usePrefs.getState().setNoticeMuted(k, false);
});
const muted = () => browser.execute(() => window.__termic!.usePrefs.getState().mutedNotices);
/** Radix opens a menu on pointerdown, which a bare click() never sends. */
const pointerOpen = (sel: string) => browser.execute(s => {
  const el = document.querySelector(s) as HTMLElement;
  const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as PointerEventInit;
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
}, sel);
/** Rendered geometry of each card, front (newest) first. */
const cards = () => browser.execute(s => [...document.querySelectorAll<HTMLElement>(s)]
  .map(el => {
    const r = el.getBoundingClientRect();
    return { text: el.innerText, top: Math.round(r.top), bottom: Math.round(r.bottom), z: Number(el.style.zIndex) };
  })
  .sort((a, b) => b.z - a.z), CARD);
/** Every card's slide and fan-out transitions have finished. */
const settled = () => browser.waitUntil(
  () => browser.execute(sel => [...document.querySelectorAll(sel)].every(el => el.getAnimations().length === 0), CARD),
  { timeout: 3_000, timeoutMsg: "the cards never stopped animating" },
);
const hover = (on: boolean) => browser.execute((sel, enter) => {
  const card = document.querySelector(sel)!;
  card.dispatchEvent(new MouseEvent(enter ? "mouseover" : "mouseout", {
    bubbles: true, relatedTarget: enter ? document.body : document.body,
  }));
}, CARD, on);

describe("notification stack", () => {
  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await clearAll();
  });
  afterEach(async () => {
    await clearAll();
  });

  it("slides a card in with its title, message and buttons", async () => {
    await push("feature/login was merged on GitHub.", "info", {
      title: "Pull request merged", sticky: true, actionLabels: ["Archive task"],
    });
    await waitVisible(CARD);
    // Settled on screen, not still off to the right.
    await browser.waitUntil(async () => {
      const r = await browser.execute(s => document.querySelector(s)!.getBoundingClientRect().right, CARD);
      return r <= (await browser.execute(() => window.innerWidth));
    }, { timeout: 3_000, timeoutMsg: "the card never slid into view" });
    const text = (await cards())[0].text;
    expect(text).toContain("Pull request merged");
    expect(text).toContain("feature/login was merged on GitHub.");
    expect(text).toContain("Archive task");
    expect(text).toContain("Dismiss");
    // Sticky: it waits for you, so there is no time left to show.
    expect(await browser.execute(() => !!document.querySelector('[data-testid="toast-countdown"]'))).toBe(false);
    await snap("toast-single.png");
  });

  it("an action runs its callback and dismisses the card", async () => {
    await push("Task archived.", "success", { sticky: true, actionLabels: ["Undo"] });
    await waitVisible(CARD);
    await browser.execute(() => { (window as any).__toastClicks = []; });
    await browser.execute(s => {
      [...document.querySelectorAll<HTMLButtonElement>(`${s} button`)].find(b => b.innerText === "Undo")!.click();
    }, CARD);
    expect(await browser.execute(() => (window as any).__toastClicks)).toEqual(["Undo"]);
    expect(await storeCount()).toBe(0);
    // It slides out, then leaves the DOM.
    await browser.waitUntil(async () => (await domCount()) === 0, { timeout: 2_000, timeoutMsg: "dismissed card never left the DOM" });
  });

  it("Dismiss dismisses a card", async () => {
    await push("Copied to clipboard.", "success", { sticky: true });
    await waitVisible(CARD);
    await browser.execute(() => (document.querySelector('[data-testid="toast-dismiss"]') as HTMLButtonElement).click());
    expect(await storeCount()).toBe(0);
    await browser.waitUntil(async () => (await domCount()) === 0, { timeout: 2_000, timeoutMsg: "card never left after Dismiss" });
  });

  it("stacks several notices as a deck, newest in front", async () => {
    await push("Agent finished in api-refactor.", "info", { sticky: true, title: "Done" });
    await push("Push rejected: the remote has newer commits.", "error", { sticky: true, title: "Push failed", actionLabels: ["Pull and retry"] });
    await push("Docker image rebuilt.", "success", { sticky: true });
    await browser.waitUntil(async () => (await domCount()) === 3, { timeout: 3_000 });
    await settled();
    const [front, second, third] = await cards();
    expect(front.text).toContain("Docker image rebuilt.");
    // The older cards peek out below the front one, each a little further.
    expect(second.bottom).toBeGreaterThan(front.bottom);
    expect(third.bottom).toBeGreaterThan(second.bottom);
    expect(second.top).toBeGreaterThanOrEqual(front.top);
    await snap("toast-stack-collapsed.png");
  });

  it("fans out on hover, and pauses the timers while it is open", async () => {
    await push("First notice.", "info", { ttlMs: 4_000 });
    await push("Second notice.", "warning", { ttlMs: 4_000, title: "Heads up" });
    await browser.waitUntil(async () => (await domCount()) === 2, { timeout: 3_000 });
    // React derives onMouseEnter/Leave from mouseover/mouseout; the macOS
    // e2e window is hidden, so a real pointer move never reaches it.
    // A timed card drains its countdown behind Dismiss; hovering freezes it.
    const playState = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>('[data-testid="toast-countdown"]')]
      .map(el => el.style.animationPlayState));
    expect(await playState()).toEqual(["running", "running"]);
    await hover(true);
    await browser.waitUntil(async () => !!(await browser.execute(s => document.querySelector(s)?.hasAttribute("data-expanded"), STACK)),
      { timeout: 2_000, timeoutMsg: "the stack never expanded on hover" });
    await settled();
    const [front, back] = await cards();
    // Expanded, the older card sits fully above the newer one.
    expect(back.bottom).toBeLessThanOrEqual(front.top);
    await snap("toast-stack-expanded.png");
    expect(await playState()).toEqual(["paused", "paused"]);
    // Well past both 4s timers, and nothing went while hovered.
    await browser.pause(4_500);
    expect(await storeCount()).toBe(2);
    await hover(false);
    await browser.waitUntil(async () => (await storeCount()) === 0,
      { timeout: 8_000, timeoutMsg: "timers never resumed after the pointer left" });
  });

  it("Dismiss > Don't show this again mutes that notice for good", async () => {
    await push("Archive \"fix-login\"?", "info", { title: "PR #42 merged", notice: "prMergedAsk", sticky: true, actionLabels: ["Archive"] });
    // The "..." shows on CSS :hover, which no synthetic event can set, so
    // wait for it to exist; the menu it opens is asserted visible below.
    await waitVisible(CARD);
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="toast-options"]')),
      { timeout: 3_000, timeoutMsg: "a mutable notice has no options button" });
    await snap("toast-merge-notice.png");
    await pointerOpen('[data-testid="toast-options"]');
    await waitVisible('[data-testid="toast-mute"]');
    await snap("toast-mute-menu.png");
    await browser.execute(() => (document.querySelector('[data-testid="toast-mute"]') as HTMLElement).click());
    await browser.waitUntil(async () => (await storeCount()) === 0, { timeout: 3_000, timeoutMsg: "muting did not dismiss the card" });
    expect(await muted()).toEqual(["prMergedAsk"]);
    // A muted notice is never pushed again; an unmuted kind still is.
    await push("Archive \"other\"?", "info", { notice: "prMergedAsk", sticky: true });
    expect(await storeCount()).toBe(0);
    await push("PR #43 opened", "info", { notice: "prOpened", sticky: true });
    expect(await storeCount()).toBe(1);
  });

  it("Settings > Notifications shows every notice as a sample with its switch", async () => {
    await browser.execute(() => window.__termic!.usePrefs.getState().setNoticeMuted("prOpened", true));
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("notifications"));
    await waitVisible('[data-testid="notice-prMergedAsk"]');
    for (const k of ["prMergedAsk", "prMergedAuto", "prOpened"]) {
      expect(await browser.execute(s => !!document.querySelector(s), `[data-testid="notice-${k}"]`)).toBe(true);
    }
    // The sample is the real card: same buttons as the live notice.
    expect(await browser.execute(() => (document.querySelector('[data-testid="notice-prMergedAsk"]') as HTMLElement).innerText))
      .toContain("Archive");
    await snap("settings-notices.png");
    // The muted one's switch is off; turning it on unmutes it.
    await browser.execute(() => (document.querySelector('[data-testid="notice-prOpened"] [role="switch"], [data-testid="notice-prOpened"] button') as HTMLElement).click());
    await browser.waitUntil(async () => !(await muted()).includes("prOpened"), { timeout: 3_000, timeoutMsg: "the switch did not unmute the notice" });
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });
});
