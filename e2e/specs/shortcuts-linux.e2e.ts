// Shortcuts on Linux, pressed for real.
//
// Every other spec sends keys through WebDriver, which builds a KeyboardEvent
// in the page: it carries whatever modifiers the spec asked for, so it cannot
// see what WebKitGTK does to a real key. Two things it does broke shortcuts
// here and no synthetic key would have shown either:
//
//   * Super is never reported as a modifier. Super+J arrives as a bare "j"
//     with metaKey false, so the Windows convention (Win+J toggles the
//     terminal from inside a terminal, where Ctrl+J belongs to the shell) did
//     nothing, and the j was typed into the agent.
//   * Shift+Tab arrives as key "Unidentified" (X's ISO_Left_Tab keysym), so
//     Ctrl+Shift+Tab never walked backwards.
//
// So this spec presses keys through the X server with xdotool. Linux only,
// and only where xdotool can reach the window: an X display (Xvfb in CI,
// XWayland with GDK_BACKEND=x11 locally). Skipped everywhere else.
//
// What it cannot see: the desktop's own grabs. GNOME keeps Super+L, Super+D,
// Super+N, Super+P, Super+O and Super+1-9 for itself and those never reach
// any application. The display this runs on has no window manager, so every
// chord arrives. docs/shortcuts.md lists the ones a real desktop takes.

import { execFileSync } from "node:child_process";
import { archiveTask, openTask, requireTermicApi, snap, waitForAgentReady, waitForAppShell } from "../helpers";

const xdo = (...args: string[]): string =>
  execFileSync("xdotool", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Put text on the X clipboard. xclip stays alive afterwards to SERVE the
 *  selection (X has no clipboard of its own), holding any pipe it was given:
 *  with stdout or stderr piped, execFileSync waits for it forever. */
const putClipboard = (text: string): void => {
  execFileSync("xclip", ["-i", "-selection", "clipboard"], { input: text, stdio: ["pipe", "ignore", "ignore"] });
};

const canPress = (() => {
  if (process.platform !== "linux" || !process.env.DISPLAY) return false;
  // On a Wayland session GTK only uses X when told to.
  if (process.env.WAYLAND_DISPLAY && process.env.GDK_BACKEND !== "x11") return false;
  try { xdo("version"); return true; } catch { return false; }
})();

/** A binding's key as an X keysym name. */
const KEYSYM: Record<string, string> = {
  "[": "bracketleft", "]": "bracketright", ",": "comma", "=": "equal", "-": "minus",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
};
/** Function keys go by KEYCODE. Asked for "F12" by name, xdotool finds the
 *  keysym on a shifted level of the key (next to the VT-switch symbols) and
 *  adds Alt to reach it, which is a different chord. */
const F_KEYCODE: Record<string, string> = {
  F1: "67", F2: "68", F3: "69", F4: "70", F5: "71", F6: "72", F7: "73", F8: "74", F9: "75", F10: "76", F11: "95", F12: "96",
};
const keysym = (key: string) => (key === "1-9" ? "3" : F_KEYCODE[key] ?? KEYSYM[key] ?? key);

type Binding = { key: string; cmd: boolean; shift: boolean; alt: boolean };
type Seen = { key: string; code: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean };

/** Press a chord as a person does: modifiers down, the key, modifiers up. */
function press(mods: string[], key: string): void {
  for (const m of mods) xdo("keydown", m);
  xdo("key", key);
  for (const m of [...mods].reverse()) xdo("keyup", m);
}

/** Give the app's window the X input focus and click `selector`'s centre, so
 *  focus is where a user's click would have put it. */
async function clickFor(selector: string, notInside?: string): Promise<void> {
  const at = await browser.execute((sel, outside) => {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find(e => {
      if (outside && e.closest(outside)) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, selector, notInside ?? null) as { x: number; y: number } | null;
  if (!at) throw new Error(`clickFor: nothing visible matches ${selector}${notInside ? ` outside ${notInside}` : ""}`);
  const { win, x, y } = appWindow();
  xdo("windowfocus", win);
  xdo("mousemove", String(x + at.x), String(y + at.y), "click", "1");
}

/** The app's top-level X window and where it sits. GTK creates a few small
 *  helper windows under the same class, so take the biggest. */
function appWindow(): { win: string; x: number; y: number } {
  const ids = xdo("search", "--onlyvisible", "--class", "termic").split("\n").filter(Boolean);
  let best = { win: "", x: 0, y: 0, area: -1 };
  for (const win of ids) {
    const geo = Object.fromEntries(
      xdo("getwindowgeometry", "--shell", win).split("\n").map(l => l.split("=") as [string, string]),
    );
    const area = Number(geo.WIDTH) * Number(geo.HEIGHT);
    if (area > best.area) best = { win, x: Number(geo.X), y: Number(geo.Y), area };
  }
  if (!best.win) throw new Error("no visible X window with class termic");
  return best;
}

/** Stand in front of the app's own handler: record every keydown that
 *  bubbles out of the focused element, and stop it there, so the audit can
 *  press Ctrl+W forty times without closing anything. A key the terminal
 *  kept for the shell never gets this far, which is the thing measured. */
const intercept = (on: boolean) => browser.execute((enable) => {
  const w = window as unknown as { __keys?: Seen[]; __keyTrap?: (e: KeyboardEvent) => void };
  if (w.__keyTrap) document.removeEventListener("keydown", w.__keyTrap);
  w.__keyTrap = undefined;
  w.__keys = [];
  if (!enable) return;
  w.__keyTrap = (e: KeyboardEvent) => {
    if (["Control", "Shift", "Alt", "Meta", "Super", "OS"].includes(e.key)) return;
    w.__keys!.push({ key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey });
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  document.addEventListener("keydown", w.__keyTrap);
}, on);

const seen = () => browser.execute(
  () => (window as unknown as { __keys?: Seen[] }).__keys ?? [],
) as unknown as Promise<Seen[]>;

/** Bytes the page has written to any PTY since the last call. */
const ptyBytes = () => browser.execute(() => {
  const w = window as unknown as { __ptyOut?: number[] };
  const out = w.__ptyOut ?? [];
  w.__ptyOut = [];
  return out;
}) as unknown as Promise<number[]>;

(canPress ? describe : describe.skip)("shortcuts on Linux, with real keys", () => {
  let taskId = "";
  // Values can be null at runtime (search-everywhere ships unbound), which
  // the audit loops skip; the per-command cases only name bound ones.
  let bindings: Record<string, Binding> = {};
  const TERMINAL = ".xterm-screen";

  before(async function () {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-keys");
    await waitForAgentReady(taskId);
    bindings = await browser.execute(
      () => window.__termic!.usePrefs.getState().shortcuts,
    ) as unknown as Record<string, Binding>;
    // Watch what reaches a PTY: the proof that Super+J is not also a typed j.
    // At `fetch`, because that is where a Tauri command leaves the page on
    // Linux (`ipc://localhost/<command>`) and `__TAURI_INTERNALS__.invoke`
    // itself is neither writable nor configurable.
    await browser.execute(() => {
      const w = window as unknown as { __ptyOut?: number[] };
      w.__ptyOut = [];
      const real = window.fetch;
      window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        try {
          const url = String((input as Request).url ?? input);
          if (url.endsWith("/pty_write") && typeof init?.body === "string") {
            w.__ptyOut!.push(...(JSON.parse(init.body).data as number[]));
          }
        } catch { /* not ours to break */ }
        return real.call(this, input, init);
      } as typeof window.fetch;
    });
  });

  after(async () => {
    if (!canPress) return;
    await intercept(false);
    // Not optional here. The audit presses every chord in the table, and the
    // ones a terminal handles itself (split, new shell) take effect before
    // anything can stand in front of them, so this task ends with a pile of
    // panes and shells. Left behind, it failed tabs-layout's menu and split
    // cases whenever that file ran after this one, and archiving it here is
    // what fixed them (run both ways).
    if (taskId) await archiveTask(taskId);
  });

  it("a plain key typed in a terminal reaches the shell, and nothing else", async () => {
    // The control for everything below: the rig types into the PTY at all.
    await clickFor(TERMINAL);
    await ptyBytes();
    press([], "j");
    await browser.waitUntil(async () => (await ptyBytes()).includes(0x6a), {
      timeout: 5_000, timeoutMsg: "a real j never reached the PTY, so the rig is not typing into the terminal",
    });
  });

  it("Super+J toggles the terminal panel from inside a terminal, and types no j", async () => {
    const split = () => browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      return !!s.terminalSplit[id] && !s.terminalSplitCollapsed[id];
    }, taskId) as unknown as Promise<boolean>;
    await clickFor(TERMINAL);
    await ptyBytes();
    const was = await split();
    press(["Super_L"], "j");
    await browser.waitUntil(async () => (await split()) !== was, {
      timeout: 5_000, timeoutMsg: "Super+J did not toggle the terminal panel",
    });
    expect(await ptyBytes()).not.toContain(0x6a);
    await snap("shortcuts-linux-super-j.png");
    // And the release is seen: the next j is text again, not a shortcut.
    await clickFor(TERMINAL);
    await ptyBytes();
    const now = await split();
    press([], "j");
    await browser.waitUntil(async () => (await ptyBytes()).includes(0x6a), {
      timeout: 5_000, timeoutMsg: "after releasing Super, j was no longer typed",
    });
    expect(await split()).toBe(now);
  });

  it("Ctrl+J in a terminal stays the shell's", async () => {
    await clickFor(TERMINAL);
    await intercept(true);
    await ptyBytes();
    press(["Control_L"], "j");
    // Line feed to the PTY, and the app's handler never hears of it.
    await browser.waitUntil(async () => (await ptyBytes()).includes(0x0a), {
      timeout: 5_000, timeoutMsg: "Ctrl+J did not reach the PTY as a line feed",
    });
    expect(await seen()).toEqual([]);
    await intercept(false);
  });

  it("Shift+Tab is still Tab, so Ctrl+Shift+Tab can walk backwards", async () => {
    await clickFor(TERMINAL);
    // Capture phase, before the tab walk claims it: what the key IS.
    await browser.execute(() => {
      const w = window as unknown as { __tab?: { key: string; code: string } };
      w.__tab = undefined;
      window.addEventListener("keydown", function once(e) {
        if (e.code !== "Tab") return;
        w.__tab = { key: e.key, code: e.code };
        window.removeEventListener("keydown", once, true);
      }, true);
    });
    press(["Control_L", "Shift_L"], "Tab");
    const tab = await browser.waitUntil(
      () => browser.execute(() => (window as unknown as { __tab?: { key: string; code: string } }).__tab),
      { timeout: 5_000, timeoutMsg: "Ctrl+Shift+Tab never arrived" },
    ) as { key: string; code: string };
    // The reason isTabKey reads `code`. If WebKitGTK ever reports "Tab" here
    // this still passes, and the fallback is merely unused.
    expect(tab.code).toBe("Tab");
    expect(["Tab", "Unidentified"]).toContain(tab.key);
  });

  it("pastes into a terminal with Ctrl+Shift+V and with Super+Shift+V", async () => {
    // The clipboard is the X server's, set from outside the app, which is
    // what a paste from another program is.
    const setClipboard = (text: string) => putClipboard(text);
    for (const [cmdKey, text] of [["Control_L", "pasted-ctrl"], ["Super_L", "pasted-super"]] as const) {
      setClipboard(text);
      await clickFor(TERMINAL);
      await ptyBytes();
      press([cmdKey, "Shift_L"], "v");
      const want = [...Buffer.from(text)];
      let got: number[] = [];
      await browser.waitUntil(async () => {
        got = got.concat(await ptyBytes());
        // Bracketed paste may wrap it; the text itself must be in there.
        return Buffer.from(got).includes(Buffer.from(want));
      }, { timeout: 5_000, timeoutMsg: `${cmdKey}+Shift+V pasted nothing into the terminal` });
      // Not also typed as a literal v.
      expect(Buffer.from(got).toString()).not.toMatch(/^[vV]|[vV]$/);
    }
  });

  it("copies a terminal selection with Ctrl+Shift+C", async () => {
    putClipboard("not-yet-copied");
    // Select with a real drag across the fixture's banner line.
    const box = await browser.execute((sel) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top) };
    }, TERMINAL) as { x: number; y: number };
    const { win, x, y } = appWindow();
    xdo("windowfocus", win);
    xdo("mousemove", String(x + box.x + 12), String(y + box.y + 10));
    xdo("mousedown", "1");
    xdo("mousemove", String(x + box.x + 160), String(y + box.y + 10));
    xdo("mouseup", "1");
    press(["Control_L", "Shift_L"], "c");
    let clip = "";
    await browser.waitUntil(() => {
      clip = execFileSync("xclip", ["-o", "-selection", "clipboard"], { encoding: "utf8" });
      return clip !== "not-yet-copied" && clip.trim().length > 0;
    }, { timeout: 5_000, timeoutMsg: "Ctrl+Shift+C left the clipboard unchanged" });
    // The banner the fixture agent prints on its first line.
    expect("FAKE-AGENT ready").toContain(clip.trim().slice(0, 6));
  });

  it("types into the editor and saves with Ctrl+S", async () => {
    const original = await browser.execute(
      (id) => window.__termic!.ipc.taskFileRead(id, "README.md"), taskId,
    ) as unknown as string;
    const README = '[data-path="README.md"]';
    await browser.waitUntil(
      () => browser.execute((sel) => !!document.querySelector(sel), README),
      { timeout: 15_000, timeoutMsg: "README row never appeared in the file tree" },
    );
    await browser.execute((sel) => (document.querySelector(sel) as HTMLElement).click(), README);
    await browser.waitUntil(
      () => browser.execute(() => !!document.querySelector(".cm-content")),
      { timeout: 10_000, timeoutMsg: "the editor never opened README" },
    );
    try {
      await clickFor(".cm-content");
      press([], "q"); press([], "z"); press([], "q");
      await browser.waitUntil(
        () => browser.execute(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("qzq")),
        { timeout: 5_000, timeoutMsg: "keys typed into the editor never appeared in it" },
      );
      press(["Control_L"], "s");
      await browser.waitUntil(async () => {
        const disk = await browser.execute(
          (id) => window.__termic!.ipc.taskFileRead(id, "README.md"), taskId,
        ) as unknown as string;
        return disk.includes("qzq");
      }, { timeout: 5_000, timeoutMsg: "Ctrl+S in the editor did not write the file" });
      await snap("shortcuts-linux-editor-saved.png");
    } finally {
      // The fixture repo is shared by every spec.
      await browser.execute(
        (id, text) => window.__termic!.ipc.taskFileWrite(id, "README.md", text), taskId, original,
      );
    }
  });

  it("Shift+[ and Shift+] switch tabs, though the keys arrive as { and }", async () => {
    // Two scratch shells in the bottom split, and the focus in one of them:
    // previous / next tab then cycles those.
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      while ((window.__termic!.useApp.getState().bottomTabs[id] ?? []).length < 2) app.addBottomTab(id);
      const s = window.__termic!.useApp.getState();
      if (!s.terminalSplit[id] || s.terminalSplitCollapsed[id]) s.toggleBottomTerminal(id);
    }, taskId);
    const BOTTOM = "[data-bottom-split] .xterm-screen";
    const active = () => browser.execute(
      (id) => window.__termic!.useApp.getState().activeBottomTab[id] as string, taskId,
    ) as unknown as Promise<string>;
    await browser.waitUntil(
      () => browser.execute((sel) => !!document.querySelector(sel), BOTTOM),
      { timeout: 10_000, timeoutMsg: "the bottom split never showed a terminal" },
    );
    await clickFor(BOTTOM);
    const first = await active();
    press(["Control_L", "Shift_L"], "bracketright");
    await browser.waitUntil(async () => (await active()) !== first, {
      timeout: 5_000, timeoutMsg: "Ctrl+Shift+] did not move to the next tab",
    });
    await clickFor(BOTTOM);
    press(["Super_L", "Shift_L"], "bracketleft");
    await browser.waitUntil(async () => (await active()) === first, {
      timeout: 5_000, timeoutMsg: "Super+Shift+[ did not move back to the previous tab",
    });
  });

  /** The physical key a binding names, as `KeyboardEvent.code`. Attribution
   *  goes by this and not by arrival order: a chord the terminal swallows
   *  leaves nothing, and the next chord's event must not be counted as its. */
  const codeOf = (key: string): string => {
    if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (key === "1-9") return "Digit3";
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    return ({ "[": "BracketLeft", "]": "BracketRight", ",": "Comma", "=": "Equal", "-": "Minus" } as Record<string, string>)[key] ?? key;
  };

  /** `bindingMatches`, restated: the app's matcher is not on `__termic`, and
   *  this is the question the audit asks of each REAL event. */
  const wouldMatch = (e: Seen, b: Binding, superHeld: boolean): boolean => {
    if ((e.meta || e.ctrl || superHeld) !== b.cmd || e.shift !== b.shift || e.alt !== b.alt) return false;
    if (b.key === "1-9") return /^[1-9]$/.test(e.key);
    // Shift turns `[` into `{`; the matcher takes that back out (UNSHIFTED in
    // lib/shortcuts.ts). The real thing is exercised by the tab case below.
    const unshift = (k: string, shift: boolean) =>
      shift ? ({ "{": "[", "}": "]", "<": ",", "+": "=", "_": "-" } as Record<string, string>)[k] ?? k : k;
    const token = /^[a-zA-Z]$/.test(e.key) ? e.key.toLowerCase() : unshift(e.key, e.shift);
    return token === unshift(b.key, b.shift);
  };

  /** Press one binding's chord in the focused terminal and say what became
   *  of it: nothing bubbled out ("kept"), or the event that did. */
  async function pressBinding(b: Binding, cmdKey: "Super_L" | "Control_L"): Promise<Seen | null> {
    const mods = [cmdKey, ...(b.shift ? ["Shift_L"] : []), ...(b.alt ? ["Alt_L"] : [])];
    // Every time, not once before the loop: a chord the terminal handles
    // itself can move the focus (its find bar takes it), and every chord
    // after that would be measured from somewhere else.
    await clickFor(TERMINAL);
    await intercept(true);
    press(mods, keysym(b.key));
    const code = codeOf(b.key);
    try {
      return await browser.waitUntil(
        async () => (await seen()).find(e => e.code === code) ?? false,
        { timeout: 1_200, interval: 60 },
      ) as Seen;
    } catch { return null; }
  }

  it("every binding fires from inside a terminal with Super", async () => {
    await clickFor(TERMINAL);
    const kept: string[] = [];
    const unmatched: string[] = [];
    for (const [id, b] of Object.entries(bindings).sort()) {
      // A binding with no Cmd in it has no Super form, and an unbound one none at all.
      if (!b?.cmd) continue;
      const e = await pressBinding(b, "Super_L");
      if (!e) kept.push(id);
      else if (!wouldMatch(e, b, true)) unmatched.push(`${id} (arrived as key ${JSON.stringify(e.key)})`);
    }
    await intercept(false);
    console.log(`\nSuper+<binding> from a focused terminal:\n  kept by the terminal: ${kept.join(", ") || "none"}\n  arrived but would not match: ${unmatched.join(", ") || "none"}\n`);
    // Handled by the terminal itself before the app's handler, by design:
    // copy / paste, and Shift+F which is the terminal's own find there.
    const local = new Set(["terminal-copy", "terminal-paste", "find-in-files"]);
    expect(kept.filter(id => !local.has(id))).toEqual([]);
    expect(unmatched).toEqual([]);
  });

  it("with Ctrl, the terminal keeps the shell's letters and nothing arrives mangled", async () => {
    await clickFor(TERMINAL);
    const kept: string[] = [];
    const unmatched: string[] = [];
    for (const [id, b] of Object.entries(bindings).sort()) {
      if (!b?.cmd) continue;
      const e = await pressBinding(b, "Control_L");
      if (!e) kept.push(id);
      else if (!wouldMatch(e, b, false)) unmatched.push(`${id} (arrived as key ${JSON.stringify(e.key)})`);
    }
    await intercept(false);
    console.log(`\nCtrl+<binding> from a focused terminal:\n  kept by the terminal: ${kept.join(", ")}\n  arrived but would not match: ${unmatched.join(", ") || "none"}\n`);
    // The rule the terminal is written to (TerminalPane's PASS_TO_APP): a
    // plain Ctrl+letter is readline's. Ctrl+J, Ctrl+L, Ctrl+P, Ctrl+O and
    // Ctrl+B are all line editing, and taking them would break the prompt.
    // These are exactly the shortcuts Super exists for.
    for (const id of ["toggle-terminal", "focus-terminal", "file-finder", "task-finder", "toggle-left-sidebar"]) {
      expect(kept).toContain(id);
    }
    // And the other half of the rule: a chord with Shift or Alt on it is the
    // app's, every one of them (isAppChordInTerminal). Ctrl+Alt+Left used to
    // go to the PTY as an escape sequence. The terminal's own three stay.
    const own = new Set(["terminal-copy", "terminal-paste", "find-in-files"]);
    const shouldReach = Object.entries(bindings)
      .filter(([id, b]) => b.cmd && (b.shift || b.alt) && !own.has(id)).map(([id]) => id);
    expect(shouldReach.filter(id => kept.includes(id)).sort()).toEqual([]);
    expect(unmatched).toEqual([]);
  });
});

// ── Every shortcut does its job ─────────────────────────────────────────
//
// The audit above proves a chord REACHES the app. This proves what it then
// does: each shortcut is pressed for real and the state it exists to change
// is read back. Twice, because the two ways in are different code:
//
//   "super"  from inside a focused terminal, with Super. The hard case on
//            Linux: the terminal has to recognise the chord as not-text.
//   "ctrl"   with Ctrl, focus outside any terminal or editor.
//   "ctrl-in-terminal"
//            with Ctrl from inside a terminal, for the chords the terminal
//            gives up there: the ones that also carry Shift or Alt. On a
//            desktop that keeps the Super form for itself (GNOME takes
//            Super+Alt+arrows) this is the only way in from a terminal.
//
// A shortcut that needs a context this spec does not build (a language
// server, a git change selected in the panel) is listed in SKIPPED with the
// reason, and the last case fails if the table ever stops covering one.
type Mode = "super" | "ctrl" | "ctrl-in-terminal";
type Group = "task" | "tab" | "pane" | "bottom" | "leaves" | "chrome" | "settings" | "ui" | "zoom" | "tabs" | "menu" | "focus" | "cleared";

(canPress ? describe : describe.skip)("every shortcut does its job, with real keys", () => {
  let a = ""; // the task the keys are pressed in
  let b = ""; // a second one, for anything that moves between tasks
  let bindings: Record<string, Binding> = {};
  // The agent's terminal is the visible one that is not a bottom scratch
  // shell. Filtered in clickFor rather than with `:not([data-bottom-split] *)`,
  // which matched nothing in WebKitGTK.
  const MAIN = ".xterm-screen";
  const BOTTOM = "[data-bottom-split] .xterm-screen";
  const NEUTRAL = '[data-testid="projects-section-header"]';

  /** Everything a shortcut can change, by group. Compared before and after. */
  const snapshot = () => browser.execute((id) => {
    const t = window.__termic!;
    const app = t.useApp.getState() as any, ui = t.useUI.getState() as any, prefs = t.usePrefs.getState() as any;
    const cur = app.activeTaskId as string | null;
    const ae = document.activeElement as HTMLElement | null;
    return {
      task: cur,
      tab: `${cur}:${cur ? app.activeTab[cur] : ""}`,
      pane: JSON.stringify(app.activePaneId[id] ?? null),
      bottom: JSON.stringify([(app.bottomTabs[id] ?? []).length, app.activeBottomTab[id] ?? null, !!app.terminalSplit[id], !!app.terminalSplitCollapsed[id]]),
      leaves: String(document.querySelectorAll("[data-split-leaf]").length),
      chrome: JSON.stringify([app.compactSidebar, app.rightPanelHidden]),
      settings: String(!!app.view.settingsOpen),
      ui: JSON.stringify(Object.entries(ui).filter(([, v]) => v === null || ["boolean", "string", "number"].includes(typeof v)).sort()),
      zoom: String(prefs.uiScale),
      tabs: String((app.tabs[id] ?? []).length),
      menu: String(document.querySelectorAll('[role="menu"]').length),
      focus: !ae || ae === document.body ? "body"
        : `${ae.closest("[data-bottom-split]") ? "bottom" : ae.closest("[data-main-content]") ? "main" : "other"}:${ae.tagName}.${ae.className}`.slice(0, 80),
      cleared: String((window as any).__cleared ?? 0),
    } as Record<string, string | null>;
  }, a) as unknown as Promise<Record<Group, string | null>>;

  /** Back to a known place: nothing open, task `a` in front, one pane. */
  async function reset(): Promise<void> {
    xdo("key", "Escape");
    await browser.execute((id) => {
      const t = window.__termic!;
      const app = t.useApp.getState() as any, ui = t.useUI.getState() as any;
      for (const k of ["closeCommandPalette", "closeTaskFinder", "closePromptPalette", "closeProjectPicker", "closeFileFinder", "closeFindInFiles", "closeBroadcast", "closeCreatePr"]) {
        try { ui[k]?.(); } catch { /* not every closer exists under that name */ }
      }
      if (app.view.settingsOpen) app.closeSettings();
      if (app.activeTaskId !== id) app.setActiveTask(id);
      // Everything a case may have left behind, whether or not it passed:
      // extra tabs, the agent tab out of front, zoom, the two side panels.
      const tabs = app.tabs[id] ?? [];
      for (const tb of tabs.slice(1)) app.closeTab(id, tb.id);
      if (tabs[0] && app.activeTab[id] !== tabs[0].id) app.setActiveTabId(id, tabs[0].id);
      const prefs = t.usePrefs.getState() as any;
      if (prefs.uiScale !== 100) prefs.setUiScale(100);
      const now = t.useApp.getState() as any;
      if (now.compactSidebar) now.toggleCompactSidebar();
      if (now.rightPanelHidden) now.toggleRightPanel();
    }, a);
    await onePane();
    await browser.waitUntil(async () => {
      const s = await snapshot();
      return s.task === a && s.settings === "false" && s.menu === "0";
    }, { timeout: 5_000, timeoutMsg: "could not get back to a clean state between shortcuts" });
  }

  /** Where the keys are aimed, per mode. `where` lets a case ask for the
   *  bottom shell, which is what new-tab and close-tab act on there. */
  async function aim(mode: Mode, where: "main" | "bottom" | "neutral"): Promise<void> {
    if (mode === "ctrl" && where === "neutral") { await clickFor(NEUTRAL); return; }
    if (where === "neutral") where = "main";
    if (where === "bottom") await clickFor(BOTTOM);
    else await clickFor(MAIN, "[data-bottom-split]");
  }

  type Case = {
    id: string;
    group: Group;
    /** Which modes this case runs in. Default both. */
    modes?: Mode[];
    /** Focus target in each mode. Default: main terminal for super, neutral for ctrl. */
    where?: Partial<Record<Mode, "main" | "bottom" | "neutral">>;
    /** State the shortcut needs before the press. */
    setup?: (mode: Mode) => Promise<void>;
    /** Put back what the press changed, when `reset` alone does not. */
    undo?: () => Promise<void>;
    /** The key for a range binding. */
    key?: string;
  };

  const store = <T,>(fn: (id: string, other: string) => T | Promise<T>) =>
    browser.execute(fn as any, a, b) as unknown as Promise<T>;

  const ensureBottom = async (n: number) => {
    await browser.execute((id, want) => {
      const t = window.__termic!;
      while ((t.useApp.getState().bottomTabs[id] ?? []).length < want) t.useApp.getState().addBottomTab(id);
      const s = t.useApp.getState();
      if (!s.terminalSplit[id] || s.terminalSplitCollapsed[id]) s.toggleBottomTerminal(id);
    }, a, n);
    await browser.waitUntil(() => browser.execute((sel) => !!document.querySelector(sel), BOTTOM),
      { timeout: 10_000, timeoutMsg: "the bottom split never showed a terminal" });
  };
  /** A vertical split, with the LEFT (main) pane active, so "pane right" has
   *  somewhere to go. `toMain` false leaves the new right pane active. */
  const splitV = async (toMain: boolean) => {
    await browser.execute((id, main) => {
      const app = window.__termic!.useApp.getState() as any;
      app.splitPane(id, "v");
      if (!main) return;
      const walk = (n: any): any => !n ? null : n.isMain ? n : (walk(n.a) ?? walk(n.b) ?? (n.children ?? []).map(walk).find(Boolean) ?? null);
      const leaf = walk((window.__termic!.useApp.getState() as any).splitTree[id]);
      if (leaf?.id) (window.__termic!.useApp.getState() as any).setActivePaneId(id, leaf.id);
    }, a, toMain);
    await browser.waitUntil(async () => Number((await snapshot()).leaves) >= 2,
      { timeout: 5_000, timeoutMsg: "the split never produced a second pane" });
  };
  const openReadme = async () => {
    const README = '[data-path="README.md"]';
    await browser.waitUntil(() => browser.execute((sel) => !!document.querySelector(sel), README),
      { timeout: 15_000, timeoutMsg: "README row never appeared in the file tree" });
    await browser.execute((sel) => (document.querySelector(sel) as HTMLElement).click(), README);
    await browser.waitUntil(async () => Number((await snapshot()).tabs) >= 2,
      { timeout: 10_000, timeoutMsg: "opening README did not add a tab" });
  };
  const closeExtraTabs = () => store((id) => {
    const app = window.__termic!.useApp.getState() as any;
    for (const t of (app.tabs[id] ?? []).slice(1)) app.closeTab(id, t.id);
  });
  const onePane = () => store(async (id) => {
    const app = window.__termic!.useApp.getState() as any;
    for (let i = 0; i < 4; i++) {
      const leaves = [...document.querySelectorAll<HTMLElement>("[data-split-leaf]:not([data-main-content])")];
      if (!leaves.length) break;
      const pid = leaves[0].getAttribute("data-pane-id");
      if (pid) app.closePane(id, pid);
      await new Promise(r => requestAnimationFrame(() => r(null)));
    }
  });

  const CASES: Case[] = [
    // Navigation
    // No Cmd in these two (Alt+Up / Alt+Down), so there is no Super form,
    // and in a terminal Alt+Arrow is the shell's word movement on every
    // platform. Outside one only.
    { id: "sidebar-next", group: "task", modes: ["ctrl"], undo: reset },
    { id: "sidebar-prev", group: "task", modes: ["ctrl"], setup: async () => { await store((_, o) => window.__termic!.useApp.getState().setActiveTask(o)); }, undo: reset },
    { id: "task-next-arrow", group: "task", undo: reset },
    { id: "task-prev-arrow", group: "task", setup: async () => { await store((_, o) => window.__termic!.useApp.getState().setActiveTask(o)); }, undo: reset },
    { id: "jump-next-waiting", group: "task", undo: reset,
      setup: async () => { await store((_, o) => {
        const app = window.__termic!.useApp.getState() as any;
        const tab = (app.tabs[o] ?? []).find((t: any) => t.type === "terminal");
        app.markAttention(o, tab.id, "attention", "needs you");
      }); } },
    // Tabs
    { id: "tab-next", group: "bottom", modes: ["super"], where: { super: "bottom" }, setup: () => ensureBottom(2) },
    { id: "tab-prev", group: "bottom", modes: ["super"], where: { super: "bottom" }, setup: () => ensureBottom(2) },
    { id: "tab-next", group: "tab", modes: ["ctrl"], setup: openReadme, undo: closeExtraTabs },
    { id: "tab-prev", group: "tab", modes: ["ctrl"], setup: openReadme, undo: closeExtraTabs },
    // README in front leaves no agent terminal on screen, so the Super form
    // is pressed from a bottom shell.
    { id: "jump-to-tab", group: "tab", key: "1", where: { super: "bottom" },
      setup: async () => { await ensureBottom(1); await openReadme(); }, undo: closeExtraTabs },
    { id: "new-tab", group: "bottom", modes: ["super"], where: { super: "bottom" }, setup: () => ensureBottom(1) },
    { id: "new-tab", group: "menu", modes: ["ctrl"] },
    { id: "close-tab", group: "bottom", modes: ["super"], where: { super: "bottom" }, setup: () => ensureBottom(2) },
    { id: "close-tab", group: "tabs", modes: ["ctrl"], setup: openReadme, undo: closeExtraTabs },
    { id: "new-scratchpad", group: "tabs", undo: closeExtraTabs },
    // Terminal
    // With the panel already open and focus elsewhere, the first press only
    // moves focus into it (by design), so start from a hidden panel.
    { id: "toggle-terminal", group: "bottom", setup: async () => { await store((id) => {
      const s = window.__termic!.useApp.getState() as any;
      if (s.terminalSplit[id] && !s.terminalSplitCollapsed[id]) s.toggleTerminalSplitCollapsed(id);
    }); } },
    { id: "split-pane-right", group: "leaves", undo: onePane },
    { id: "split-pane-below", group: "leaves", undo: onePane },
    { id: "tab-next-arrow", group: "pane", undo: onePane, setup: () => splitV(true) },
    // Pane left needs focus in the RIGHT pane, and a fresh split's right pane
    // is a launcher with no terminal to press Super in. Same handler as pane
    // right, which is pressed from a terminal above.
    { id: "tab-prev-arrow", group: "pane", modes: ["ctrl"], undo: onePane, setup: () => splitV(false) },
    { id: "focus-terminal", group: "focus", where: { super: "bottom" }, setup: () => ensureBottom(1) },
    { id: "clear-terminal", group: "cleared", modes: ["super"] },
    // General
    { id: "command-palette", group: "ui" },
    { id: "new-task-quick", group: "ui" },
    { id: "task-finder", group: "ui" },
    { id: "file-finder", group: "ui" },
    { id: "find-in-files", group: "ui", modes: ["ctrl"] },
    { id: "broadcast", group: "ui" },
    { id: "prompt-palette", group: "ui" },
    { id: "open-settings", group: "settings" },
    { id: "toggle-left-sidebar", group: "chrome", undo: async () => { await store(() => { const s = window.__termic!.useApp.getState() as any; if (s.compactSidebar) s.toggleCompactSidebar(); }); } },
    { id: "toggle-right-sidebar", group: "chrome", undo: async () => { await store(() => { const s = window.__termic!.useApp.getState() as any; if (s.rightPanelHidden) s.toggleRightPanel(); }); } },
    { id: "zoom-in", group: "zoom", undo: async () => { await store(() => (window.__termic!.usePrefs.getState() as any).setUiScale(100)); } },
    { id: "zoom-out", group: "zoom", undo: async () => { await store(() => (window.__termic!.usePrefs.getState() as any).setUiScale(100)); } },
    { id: "zoom-reset", group: "zoom", setup: async () => { await store(() => (window.__termic!.usePrefs.getState() as any).nudgeUiScale(1)); } },
  ];

  /** Not driven here, and why. Each has its own coverage, named. */
  const SKIPPED: Record<string, string> = {
    "terminal-copy": "covered above with a real selection",
    "terminal-paste": "covered above with the X clipboard",
    "nav-back": "needs a jump trail or a folder listing to go back in (codenav.e2e.ts)",
    "nav-forward": "same as nav-back",
    "go-to-definition": "needs a language server (codenav.e2e.ts)",
    "find-usages": "needs a language server (codenav.e2e.ts)",
    "go-to-implementation": "needs a language server (codenav.e2e.ts)",
    "go-to-type-definition": "needs a language server (codenav.e2e.ts)",
    "file-structure": "needs a language server (codenav.e2e.ts)",
    "add-selection-to-agent": "needs a selection in an editor (editor.e2e.ts)",
    "create-pr": "needs a branch with a remote (git.e2e.ts)",
    "stage-file": "handled by the Git panel on its selected row (git.e2e.ts)",
    "discard-file": "handled by the Git panel on its selected row (git.e2e.ts)",
  };

  before(async function () {
    await waitForAppShell();
    await requireTermicApi();
    // Both OPENED, not just created: next / previous task walks the tasks
    // that are awake, and one that was never in front is not.
    b = await openTask("e2e-keys-b");
    await waitForAgentReady(b);
    a = await openTask("e2e-keys-a");
    await waitForAgentReady(a);
    bindings = await browser.execute(() => window.__termic!.usePrefs.getState().shortcuts) as unknown as Record<string, Binding>;
    // clear-terminal changes nothing a store can show; count its event.
    await browser.execute(() => {
      (window as any).__cleared = 0;
      window.addEventListener("termic-clear-focused", () => { (window as any).__cleared++; });
      // For a failure message: the last real key the page saw, and whether
      // anything claimed it by the time it finished bubbling.
      window.addEventListener("keydown", (e) => {
        if (["Control", "Shift", "Alt", "Meta", "Super", "OS"].includes(e.key)) return;
        const rec: any = { key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
        (window as any).__lastKey = rec;
        setTimeout(() => { rec.claimed = e.defaultPrevented; }, 0);
      }, true);
    });
  });

  after(async () => {
    if (!canPress) return;
    await reset().catch(() => {});
    await closeExtraTabs().catch(() => {});
    if (a) await archiveTask(a);
    if (b) await archiveTask(b);
  });

  const LABEL: Record<Mode, string> = {
    super: "Super, in a terminal", ctrl: "Ctrl, outside one", "ctrl-in-terminal": "Ctrl, in a terminal",
  };
  for (const mode of ["super", "ctrl", "ctrl-in-terminal"] as const) {
    for (const c of CASES) {
      // The in-terminal Ctrl form is pressed from wherever the Super form is.
      const as = mode === "ctrl-in-terminal" ? "super" : mode;
      if (c.modes && !c.modes.includes(as)) continue;
      it(`${c.id} (${LABEL[mode]}) changes ${c.group}`, async function () {
        const bnd = bindings[c.id];
        expect(bnd).toBeDefined();
        // Plain Ctrl+letter in a terminal is the shell's, by design; that
        // half is asserted in the audit above.
        if (mode === "ctrl-in-terminal" && !(bnd.shift || bnd.alt)) this.skip();
        await reset();
        await c.setup?.(mode);
        await aim(mode, c.where?.[as] ?? (as === "super" ? "main" : "neutral"));
        const before = await snapshot();
        const cmd = mode === "super" ? "Super_L" : "Control_L";
        const mods = [...(bnd.cmd ? [cmd] : []), ...(bnd.shift ? ["Shift_L"] : []), ...(bnd.alt ? ["Alt_L"] : [])];
        await browser.execute(() => { (window as any).__lastKey = null; });
        press(mods, c.key ?? keysym(bnd.key));
        let after = before;
        try {
          await browser.waitUntil(async () => (after = await snapshot())[c.group] !== before[c.group], { timeout: 4_000, interval: 80 });
        } catch {
          const moved = (Object.keys(before) as Group[]).filter(k => before[k] !== after[k]);
          const key = await browser.execute(() => JSON.stringify((window as any).__lastKey));
          throw new Error(`${c.id} did not change ${c.group} (${before[c.group]}). What did change: ${moved.join(", ") || "nothing"}. Last keydown: ${key}. Focus: ${before.focus}`);
        } finally {
          await c.undo?.().catch(() => {});
        }
      });
    }
  }

  it("leaves no shortcut out", () => {
    const covered = new Set([...CASES.map(c => c.id), ...Object.keys(SKIPPED)]);
    expect(Object.keys(bindings).filter(id => !covered.has(id)).sort()).toEqual([]);
  });
});
