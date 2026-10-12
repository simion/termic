import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../../wdio.conf.js";
import { archiveTask, clickByText, clickWhenVisible, openTask, requireTermicApi, snap, waitForAppShell, waitForText, waitForTextGone, waitVisible, controlConnect } from "../helpers";

const artifacts = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".e2e",
  "artifacts",
);

// Reference spec + harness smoke test. Both `it`s share ONE launched window
// (wdio runs a spec file's tests serially in one session): boot once, assert
// many. No fixed sleeps — every wait is a condition, so runs are deterministic.
describe("termic e2e pipeline", () => {
  it("renders the shell and exposes app state", async () => {
    await waitForAppShell();
    // The e2e build exposes window.__termic — read REAL store state, not DOM.
    await requireTermicApi();
    const projectNames = await browser.execute(
      () => window.__termic!.useApp.getState().projects.map((p: any) => p.name),
    );
    expect(projectNames).toContain("fixture-repo");
    await snap("dashboard.png");
  });

  it("navigates Dashboard -> History with a real click", async () => {
    // Self-establish the starting view: a prior spec/run may have left a task
    // active, so click Dashboard rather than assuming the app launched on it.
    await clickByText("Dashboard");
    await waitForText("HOME FOR YOUR CLI CODING AGENTS");
    await clickByText("History");
    await waitForTextGone("HOME FOR YOUR CLI CODING AGENTS");
    await snap("history.png");
  });
});

// The top bar teaches its shortcuts through tooltips, and every one of them
// is built from the LIVE binding, so a rebind can never leave a tooltip naming
// a key that does nothing. Cases: the palette button, the Prompts dropdown
// (⌥⌘P opens the searchable palette over the same list), and the right-panel
// toggle (⌥⌘B).
describe("top-bar tooltips name their shortcut", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  // Radix opens a tooltip on pointermove over the trigger; WebDriver's own
  // hover is unreliable here, so the event goes in directly.
  const hover = (selector: string) =>
    browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`no trigger for ${sel}`);
      el.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }),
      );
    }, selector);

  const tipText = () =>
    browser.execute(() =>
      [...document.querySelectorAll('[role="tooltip"]')]
        .map((t) => (t as HTMLElement).textContent ?? "")
        .join("|"),
    );

  const expectTip = async (selector: string, needle: string) => {
    await hover(selector);
    await browser.waitUntil(async () => (await tipText()).includes(needle), {
      timeout: 5_000,
      timeoutMsg: `tooltip for ${selector} never showed "${needle}"`,
    });
    // Leave, so the next trigger's tooltip is the only one on screen.
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      el?.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false, pointerType: "mouse" }));
    }, selector);
  };

  it("names the palette, prompt palette and right-panel bindings", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-bar-tips");
    // The keys as each platform writes them (lib/shortcuts.ts bindingText):
    // glyphs on macOS, Ctrl+... on Windows and Linux alike.
    const win = process.platform !== "darwin";
    await expectTip('[data-testid="command-palette-button"]', `Command palette (${win ? "Ctrl+Shift+P" : "\u21e7\u2318P"})`);
    await expectTip('[data-testid="prompts-menu"]', `Prompts (${win ? "Ctrl+Alt+P" : "\u2325\u2318P"})`);
    await expectTip('[data-testid="toggle-right-panel"]', `Toggle right panel (${win ? "Ctrl+Alt+B" : "\u2325\u2318B"})`);
  });
});

// P1: the command palette (⌘K). Cases: opens and lists commands; filtering
// narrows the list; running a command performs its action and closes the
// palette; Escape closes it.
describe("keyboard shortcuts sheet", () => {
  // The sheet is the only place a shortcut is discoverable, and it is
  // data-driven from SHORTCUT_DEFS: a key implemented in a CodeMirror keymap
  // and never registered there works for whoever already knew about it and
  // for nobody else. That is exactly what the five code-navigation keys were.
  const sheetText = async () => {
    await browser.execute(() => window.__termic!.useUI.getState().openShortcutsHelp?.());
    await waitVisible('input[placeholder*="Search shortcuts"]', 8_000);
    return await browser.execute(() => {
      const input = document.querySelector('input[placeholder*="Search shortcuts"]');
      return (input?.closest('[role="dialog"]') as HTMLElement | null)?.innerText ?? "";
    }) as string;
  };

  after(async () => {
    await browser.execute(() => window.__termic!.useUI.getState().closeShortcutsHelp?.());
  });

  it("lists the code-navigation keys", async () => {
    const text = await sheetText();
    for (const label of [
      "Go to definition", "Find usages", "Go to implementation",
      "Go to type definition", "File structure",
    ]) {
      // The label in the message, since expect() here takes no second arg.
      if (!text.includes(label)) throw new Error(`the sheet does not list "${label}"`);
    }
  });

  it("lists Back and Forward, which is what ⌘[ and ⌘] now mean", async () => {
    const text = await sheetText();
    expect(text).toContain("Back");
    expect(text).toContain("Forward");
    // And NOT the task switching they used to do: that moved to ⌥⌘↑ / ⌥⌘↓
    // permanently, and a sheet naming both would be describing two features.
    expect(text).not.toContain("Previous task");
  });

  it("lists double-Shift, with its mode, while the chord is unbound", async () => {
    // The gesture nobody guesses. Search everywhere's chord ships unbound, so
    // by default double-Shift is the row's only key, printed rather than
    // absent: a reader looking for "how do I open Search everywhere" finds it
    // in the same list.
    const text = await sheetText();
    expect(text).toContain("Search everywhere");
    const row = await browser.execute(() => {
      const el = document.querySelector('[data-shortcut-id="search-everywhere"]') as HTMLElement;
      return { text: el?.innerText ?? "", keys: el?.querySelectorAll("kbd").length ?? 0 };
    }) as { text: string; keys: number };
    // Two keycaps, both Shift, and the words that explain the missing button.
    // That text is the chosen MODE's label (default: the left Shift), not a
    // fixed "Double tap": the gesture is a setting, and this sheet prints what
    // it currently is.
    expect(row.keys).toBe(2);
    expect(row.text).toContain("Double left Shift");
  });

  it("follows the double-Shift mode, and drops the row when it is off", async () => {
    // With no chord recorded (the default), double-Shift is the only way in,
    // and a double tap has no key to rebind, so what Settings offers is WHEN
    // it applies. The sheet has to say the same thing:
    // printing "Double tap, left" to somebody who chose either Shift describes
    // a restriction they turned off, and printing the row at all when the
    // gesture is off tells them to press something inert.
    const setMode = (m: string) => browser.execute((mode) =>
      window.__termic!.usePrefs.getState().setDoubleShiftMode(mode as any), m);
    const rowText = () => browser.execute(() =>
      (document.querySelector('[data-shortcut-id="search-everywhere"]') as HTMLElement)?.innerText ?? "");

    try {
      await setMode("off");
      const off = await sheetText();
      expect(off).not.toContain("Search everywhere");
      expect(await browser.execute(() =>
        !!document.querySelector('[data-shortcut-id="search-everywhere"]'))).toBe(false);

      // Each mode's own label, the same string the Shortcuts page offers.
      await setMode("any");
      expect(await sheetText()).toContain("Search everywhere");
      expect(await rowText()).toContain("Double Shift");
      expect(await rowText()).not.toContain("left");

      await setMode("outside-terminal");
      await sheetText();
      expect(await rowText()).toContain("not in a terminal");
    } finally {
      await setMode("left");
    }
    await sheetText();
    expect(await rowText()).toContain("Double left Shift");
  });

  /** The keycaps of one sheet row, as printed. */
  const rowKeys = (id: string) => browser.execute((rid) =>
    [...(document.querySelector(`[data-shortcut-id="${rid}"]`)?.querySelectorAll("kbd") ?? [])]
      .map(k => (k as HTMLElement).innerText), id) as Promise<string[]>;
  const rowShown = (id: string) => browser.execute((rid) =>
    !!document.querySelector(`[data-shortcut-id="${rid}"]`), id);

  it("prints the recently-used-tabs gesture as recorded, and drops it when off", async () => {
    // The keys are the user's now, so the sheet has to print THEIR gesture:
    // a hardcoded ⌃⇥ would tell somebody who moved it to press a dead key.
    const mac = process.platform === "darwin";
    const original = await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      return { g: p.recentTabsGesture, mode: p.ctrlTabMode };
    });
    try {
      await browser.execute(() => {
        const p = window.__termic!.usePrefs.getState();
        p.setCtrlTabMode("on");
        p.setRecentTabsGesture({ hold: "alt", code: "Backquote" });
      });
      await sheetText();
      await browser.waitUntil(async () => (await rowKeys("recent-tabs")).includes("`"),
        { timeout: 5_000, timeoutMsg: "the sheet never printed the recorded gesture" });
      expect(await rowKeys("recent-tabs")).toEqual([mac ? "⌥" : "Alt", "`"]);

      await browser.execute(() => window.__termic!.usePrefs.getState().setCtrlTabMode("off"));
      await browser.waitUntil(async () => !(await rowShown("recent-tabs")),
        { timeout: 5_000, timeoutMsg: "the sheet kept a gesture that is switched off" });
    } finally {
      await browser.execute((o) => {
        const p = window.__termic!.usePrefs.getState();
        p.setRecentTabsGesture(o.g as any);
        p.setCtrlTabMode(o.mode as any);
      }, original);
    }
  });

  it("prints a recorded search chord beside the double-Shift mode, and drops the row only when both are off", async () => {
    const mac = process.platform === "darwin";
    const original = await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      return { mode: p.doubleShiftMode, chord: p.shortcuts["search-everywhere"] };
    });
    const rowText = () => browser.execute(() =>
      (document.querySelector('[data-shortcut-id="search-everywhere"]') as HTMLElement)?.innerText ?? "");
    try {
      await browser.execute(() => {
        const p = window.__termic!.usePrefs.getState();
        p.setDoubleShiftMode("left");
        p.setShortcut("search-everywhere", { cmd: true, shift: true, alt: false, key: "o" });
      });
      await sheetText();
      await browser.waitUntil(async () => (await rowKeys("search-everywhere")).includes("O"),
        { timeout: 5_000, timeoutMsg: "the sheet never printed the recorded chord" });
      // Chord AND mode: both open it, so both are printed.
      expect(await rowKeys("search-everywhere")).toEqual(mac ? ["⇧", "⌘", "O"] : ["Ctrl", "Shift", "O"]);
      expect(await rowText()).toContain("Double left Shift");

      // Double-Shift off, chord still there: the row stays, without the mode.
      await browser.execute(() => window.__termic!.usePrefs.getState().setDoubleShiftMode("off"));
      await browser.waitUntil(async () => !(await rowText()).includes("Double"),
        { timeout: 5_000, timeoutMsg: "the sheet kept printing a double-Shift mode that is off" });
      expect(await rowKeys("search-everywhere")).toEqual(mac ? ["⇧", "⌘", "O"] : ["Ctrl", "Shift", "O"]);

      // Both off: nothing opens it, so the sheet does not list it.
      await browser.execute(() => window.__termic!.usePrefs.getState().resetShortcut("search-everywhere"));
      await browser.waitUntil(async () => !(await rowShown("search-everywhere")),
        { timeout: 5_000, timeoutMsg: "the sheet listed a command with no way to open it" });
    } finally {
      await browser.execute((o) => {
        const p = window.__termic!.usePrefs.getState();
        p.setDoubleShiftMode(o.mode as any);
        if (o.chord) p.setShortcut("search-everywhere", o.chord as any);
        else p.resetShortcut("search-everywhere");
      }, original);
    }
  });

  it("gives the code-navigation keys a section of their own", async () => {
    // They were mixed into Navigation with tab and pane movement, which is
    // where a reader stops looking for them.
    const text = await sheetText();
    expect(text).toContain("Code navigation");
    // And the section is named after the feature, which follows the type
    // checking switch (off by default here).
    expect(text).not.toContain("Code intelligence");
  });

  it("prints a key for every row it shows", async () => {
    // A row with no glyphs is a shortcut somebody cleared, or a def with a
    // binding the glyph renderer cannot spell. Either way the row is useless.
    await browser.execute(() => window.__termic!.useUI.getState().openShortcutsHelp?.());
    await waitVisible('input[placeholder*="Search shortcuts"]', 8_000);
    const empty = await browser.execute(() => {
      const dialog = document.querySelector('input[placeholder*="Search shortcuts"]')!
        .closest('[role="dialog"]') as HTMLElement;
      // The rows of the LIST, by testid: matching on layout classes also
      // caught the dialog's own header, which has no key by design.
      return [...dialog.querySelectorAll('[data-testid="shortcut-row"]')]
        .filter(row => row.querySelectorAll("kbd").length === 0)
        .map(row => (row as HTMLElement).innerText);
    }) as string[];
    expect(empty).toEqual([]);
  });
});

describe("command palette", () => {
  let taskId!: string;
  after(async () => {
    await browser.execute(() => {
      window.__termic!.useUI.getState().closeCommandPalette?.();
      window.__termic!.useUI.getState().closeFileFinder?.();
    });
    if (taskId) await archiveTask(taskId);
  });

  const paletteOpen = () =>
    browser.execute(() => window.__termic!.useUI.getState().commandPaletteOpen);
  const open = () =>
    browser.execute(() =>
      window.__termic!.useUI.getState().openCommandPalette(),
    );
  const rowCount = () =>
    browser.execute(() => document.querySelectorAll("[data-row]").length);
  const setQuery = (q: string) =>
    browser.execute((query) => {
      const input = document.querySelector(
        'input[placeholder*="Type a command"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, q);

  it("opens and lists commands", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-palette");
    await open();
    // Appeared + visible → continue (fast client-side check).
    await waitVisible('input[placeholder*="Type a command"]', 8_000);
    expect(await rowCount()).toBeGreaterThan(1);
  });

  it("filters the command list by query", async () => {
    const all = await rowCount();
    await setQuery("File picker");
    await browser.waitUntil(async () => (await rowCount()) < all, {
      timeout: 5_000,
      timeoutMsg: "query did not narrow the list",
    });
    const hasFilePicker = await browser.execute(() =>
      [...document.querySelectorAll("[data-row]")].some((r) =>
        r.textContent?.includes("File picker"),
      ),
    );
    expect(hasFilePicker).toBe(true);
  });

  // Row order stays fixed by section (see `filtered` in CommandPalette.tsx),
  // but the highlight should jump to whichever row is the strongest match
  // even when that row isn't first. "upd" fuzzy-matches "Jump to next
  // waiting agent" (its own section sorts first) as well as the exact
  // substring "Check for updates" — the highlight belongs on the latter.
  it("jumps the highlight to the best match, not just row 0", async () => {
    await setQuery("upd");
    await browser.waitUntil(
      async () => {
        const activeText = await browser.execute(() => {
          const active = [...document.querySelectorAll("[data-row]")].find(
            (r) => (r as HTMLElement).style.background,
          );
          return active?.getAttribute("data-cmd-id") ?? "";
        });
        return activeText === "check-updates";
      },
      { timeout: 5_000, timeoutMsg: "highlight did not land on the best match" },
    );
    await setQuery("");
  });

  it("activating a command runs it and closes the palette", async () => {
    // Click the File picker command row. The palette's act() runs close()
    // synchronously then defers the effect via requestAnimationFrame — and rAF
    // is frozen while this window is occluded, so we assert the synchronous
    // run wiring (palette closes), not the deferred side effect.
    await browser.execute(() => {
      const btn = [...document.querySelectorAll("[data-row]")].find((r) =>
        r.textContent?.includes("File picker"),
      );
      if (!btn) throw new Error("File picker row not found");
      (btn as HTMLElement).click();
    });
    await browser.waitUntil(async () => (await paletteOpen()) === false, {
      timeout: 5_000,
      timeoutMsg: "activating a command did not close the palette",
    });
  });

  // The top-bar button is the discoverable half of ⇧⌘P. It toggles, so a
  // second click has to dismiss the palette rather than no-op.
  it("the top-bar button toggles the palette", async () => {
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeCommandPalette(),
    );
    await clickWhenVisible('[data-testid="command-palette-button"]');
    await browser.waitUntil(async () => (await paletteOpen()) === true, {
      timeout: 5_000,
      timeoutMsg: "clicking the palette button did not open the palette",
    });
    // The tooltip/aria label carries the live binding, so a rebind can't
    // leave the button naming a key that no longer opens anything.
    const ariaLabel = await browser.execute(() =>
      document
        .querySelector('[data-testid="command-palette-button"]')
        ?.getAttribute("aria-label"),
    );
    expect(ariaLabel).toBe(`Command palette (${process.platform !== "darwin" ? "Ctrl+Shift+P" : "\u21e7\u2318P"})`);
    await clickWhenVisible('[data-testid="command-palette-button"]');
    await browser.waitUntil(async () => (await paletteOpen()) === false, {
      timeout: 5_000,
      timeoutMsg: "clicking the palette button again did not close the palette",
    });
  });

  it("closes on Escape", async () => {
    // Clear any state the previous command left (its rAF-deferred effect can
    // open the file finder), then reopen and wait for the input to be visible.
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeFileFinder(),
    );
    await open();
    await waitVisible('input[placeholder*="Type a command"]', 8_000);
    await browser.execute(() => {
      const input = document.querySelector(
        'input[placeholder*="Type a command"]',
      )!;
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await browser.waitUntil(async () => (await paletteOpen()) === false, {
      timeout: 5_000,
      timeoutMsg: "Escape did not close the palette",
    });
    await snap("command-palette.png");
  });

  // The reopen case: run something, come back, and it is the first row. The
  // section is only meant to appear on an EMPTY query — while searching you
  // want the best match, not a pinned row pushing it down.
  const sectionLabels = () =>
    browser.execute(() =>
      [...document.querySelectorAll("[data-row]")]
        .map(r => r.parentElement?.querySelector("div")?.textContent ?? "")
        .filter(Boolean),
    ) as Promise<string[]>;

  const firstRowText = () =>
    browser.execute(() =>
      (document.querySelector('[data-row="0"]') as HTMLElement | null)?.innerText ?? "",
    ) as unknown as Promise<string>;

  it("puts the command you just ran in a Recent section on top", async () => {
    // Self-contained: run a command through the palette HERE rather than
    // leaning on an earlier case. The File-picker case defers its effect
    // through requestAnimationFrame, which is frozen while this window is
    // occluded and then fires late, reopening a dialog mid-assertion.
    // Recording happens synchronously in runCmd, so a row whose deferred
    // effect never lands still records — which is all this needs.
    await browser.execute(() => {
      const ui = window.__termic!.useUI.getState();
      ui.closeFileFinder?.(); ui.closeShortcutsHelp?.();
      localStorage.removeItem("commandPaletteRecent");
    });
    await open();
    await waitVisible('input[placeholder*="Type a command"]', 8_000);
    await browser.execute(() => {
      const btn = [...document.querySelectorAll("[data-row]")].find(r =>
        (r as HTMLElement).innerText.includes("Keyboard shortcuts"));
      if (!btn) throw new Error("Keyboard shortcuts row not found");
      (btn as HTMLElement).click();
    });
    await browser.waitUntil(async () => (await paletteOpen()) === false, {
      timeout: 5_000, timeoutMsg: "the command did not close the palette",
    });

    await browser.execute(() => window.__termic!.useUI.getState().closeShortcutsHelp?.());
    await open();
    await waitVisible('input[placeholder*="Type a command"]', 8_000);

    await browser.waitUntil(async () => (await firstRowText()).includes("Keyboard shortcuts"), {
      timeout: 5_000,
      timeoutMsg: "the just-run command was not the first row on reopen",
    });
    // The first row sits under the Recent header, not under Task/View.
    expect((await sectionLabels())[0]).toContain("Recent");
    // Lifted out of its home section rather than duplicated — the same command
    // twice makes the arrow keys feel broken.
    // Exact-ish match: "Keyboard shortcuts settings" is a DIFFERENT command
    // (the Settings deep link), so a bare substring count sees two rows and
    // reads as a dedupe failure when nothing is wrong.
    const dupes = await browser.execute(() =>
      [...document.querySelectorAll("[data-row]")]
        .map(r => (r as HTMLElement).innerText)
        .filter(t => t.includes("Keyboard shortcuts") && !t.includes("settings")).length);
    expect(dupes).toBe(1);
  });

  it("hides Recent as soon as you type", async () => {
    await setQuery("settings");
    await browser.waitUntil(
      async () => !(await sectionLabels()).some(l => l.startsWith("Recent")),
      { timeout: 5_000, timeoutMsg: "Recent survived a query" },
    );
    await setQuery("");
    await browser.waitUntil(
      async () => (await sectionLabels()).some(l => l.startsWith("Recent")),
      { timeout: 5_000, timeoutMsg: "Recent did not come back on an empty query" },
    );
  });

  it("forgets a recent command after an hour", async () => {
    // Age the stored entry past the TTL rather than waiting an hour. The expiry
    // rule itself is unit-tested against an injected clock
    // (lib/paletteRecent.test.ts); this only proves the palette consults it.
    await browser.execute(() => {
      const raw = localStorage.getItem("commandPaletteRecent");
      if (!raw) throw new Error("no recents were recorded");
      const aged = JSON.parse(raw).map((e: { id: string; at: number }) => ({
        ...e, at: e.at - 61 * 60 * 1000,
      }));
      localStorage.setItem("commandPaletteRecent", JSON.stringify(aged));
    });
    // Reopen: recents are re-read per open, so the stale entry drops out.
    await browser.execute(() => window.__termic!.useUI.getState().closeCommandPalette());
    await open();
    await waitVisible('input[placeholder*="Type a command"]', 8_000);
    await browser.waitUntil(
      async () => !(await sectionLabels()).some(l => l.startsWith("Recent")),
      { timeout: 5_000, timeoutMsg: "an expired recent was still shown" },
    );
    await browser.execute(() => {
      localStorage.removeItem("commandPaletteRecent");
      window.__termic!.useUI.getState().closeCommandPalette();
    });
  });
});

// P2: assorted dialogs/palettes open + close. Guards the wiring of the
// shortcuts help, prompt palette, and per-task broadcast dialog.
describe("dialogs & palettes open", () => {
  let taskId!: string;
  after(async () => {
    await browser.execute(() => {
      const ui = window.__termic!.useUI.getState();
      ui.closeShortcutsHelp?.();
      ui.closePromptPalette?.();
      ui.closeBroadcast?.();
    });
    if (taskId) await archiveTask(taskId);
  });

  const dialogPresent = () =>
    browser.execute(() => !!document.querySelector('[role="dialog"]'));
  const flag = (name: string) =>
    browser.execute(
      (n) => (window.__termic!.useUI.getState() as any)[n],
      name,
    );

  it("shortcuts help opens and closes", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() =>
      window.__termic!.useUI.getState().openShortcutsHelp(),
    );
    await browser.waitUntil(async () => (await flag("shortcutsHelpOpen")) === true, {
      timeout: 8_000,
      timeoutMsg: "shortcuts help never opened",
    });
    await waitVisible('[role="dialog"]');
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeShortcutsHelp(),
    );
    await browser.waitUntil(
      async () => (await flag("shortcutsHelpOpen")) === false,
      { timeout: 5_000, timeoutMsg: "shortcuts help never closed" },
    );
  });

  it("prompt palette opens", async () => {
    await browser.execute(() =>
      window.__termic!.useUI.getState().openPromptPalette(),
    );
    await browser.waitUntil(async () => (await flag("promptPaletteOpen")) === true, {
      timeout: 8_000,
      timeoutMsg: "prompt palette never opened",
    });
    await browser.execute(() =>
      window.__termic!.useUI.getState().closePromptPalette(),
    );
  });

  it("broadcast dialog opens for a task", async () => {
    taskId = await openTask("e2e-broadcast");
    await browser.execute(
      (id) => window.__termic!.useUI.getState().openBroadcast(id),
      taskId,
    );
    await waitVisible('[role="dialog"]', 8_000);
    await snap("dialogs-open.png");
  });
});

// P2: more dialogs — changelog, welcome, and the per-project Race dialog.
describe("more dialogs open", () => {
  after(async () => {
    await browser.execute(() => {
      const ui = window.__termic!.useUI.getState();
      ui.closeChangelog?.();
      ui.closeWelcome?.();
    });
  });

  const flag = (name: string) =>
    browser.execute((n) => (window.__termic!.useUI.getState() as any)[n], name);
  const dialogPresent = () =>
    browser.execute(() => !!document.querySelector('[role="dialog"]'));

  it("changelog opens and closes", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() => window.__termic!.useUI.getState().openChangelog());
    await browser.waitUntil(async () => (await flag("changelogOpen")) === true, {
      timeout: 8_000,
      timeoutMsg: "changelog never opened",
    });
    await browser.execute(() => window.__termic!.useUI.getState().closeChangelog());
    await browser.waitUntil(async () => (await flag("changelogOpen")) === false, {
      timeout: 5_000,
      timeoutMsg: "changelog never closed",
    });
  });

  it("welcome opens and closes", async () => {
    await browser.execute(() => window.__termic!.useUI.getState().openWelcome());
    await browser.waitUntil(async () => (await flag("welcomeOpen")) === true, {
      timeout: 8_000,
      timeoutMsg: "welcome never opened",
    });
    await waitVisible('[role="dialog"]');
    await browser.execute(() => window.__termic!.useUI.getState().closeWelcome());
    await browser.waitUntil(async () => (await flag("welcomeOpen")) === false, {
      timeout: 5_000,
      timeoutMsg: "welcome never closed",
    });
  });

  // The hooks step switches "Keep every agent hooked up" ON by default: it
  // installs the hook for every supported agent now and for any added later.
  // Default, not decision: the box shows checked, and unticking turns it off.
  it("turns hook auto-install on by default, and unticking turns it off", async () => {
    const autoOn = () => browser.execute(() => window.__termic!.invoke("agent_hooks_auto_get")) as unknown as Promise<boolean>;
    await browser.execute(async () => { await window.__termic!.invoke("agent_hooks_auto_set", { on: false }); });
    expect(await autoOn()).toBe(false);
    try {
      await browser.execute(() => window.__termic!.useUI.getState().openWelcome());
      await waitForText("Welcome to Termic");
      await clickWhenVisible('[aria-label="Step 3"]');
      await waitForText("Keep every agent hooked up");
      await browser.waitUntil(async () => await autoOn(), {
        timeout: 30_000, timeoutMsg: "arriving on the hooks step did not turn auto-install on",
      });
      await browser.waitUntil(
        () => browser.execute(() => (document.querySelector('[data-testid="welcome-hooks-auto"]') as HTMLInputElement | null)?.checked === true),
        { timeout: 5_000, timeoutMsg: "the box did not show auto-install on" },
      );
      await snap("welcome-hooks-default-on.png");
      await browser.execute(() => (document.querySelector('[data-testid="welcome-hooks-auto"]') as HTMLInputElement).click());
      await browser.waitUntil(async () => !(await autoOn()), {
        timeout: 10_000, timeoutMsg: "unticking the box did not turn auto-install off",
      });
    } finally {
      // Back to the profile's default, and nothing left installed: later
      // specs assert on hook state from a clean slate.
      await browser.execute(async () => {
        const t = window.__termic!;
        await t.invoke("agent_hooks_auto_set", { on: false });
        for (const a of t.useApp.getState().agents) {
          try { await t.invoke("agent_hooks_remove", { agentId: a.id }); } catch { /* unsupported */ }
        }
        await t.useApp.getState().refreshAgentHooks();
        t.useUI.getState().closeWelcome();
      });
    }
  });

  // The wizard opens on the LAYOUT step, and its last step is still the
  // project picker that carries Finish. Both halves matter: the step was
  // inserted at the front, which renumbers every other one, and an off-by-one
  // there shows the wrong body or strands the Finish button on a step nobody
  // reaches. Also the only place the worktree explanation is guaranteed to be
  // seen, which is why it goes first.
  it("opens on the layout step, and finishes on the last step that has content", async () => {
    await browser.execute(() => window.__termic!.useUI.getState().openWelcome());
    await waitForText("Welcome to Termic");
    await waitForText("is one piece of work inside it");
    // The distinction the step exists for, in the words a user needs: a
    // worktree is a folder, not a way of making a branch.
    await waitForText("Worktree");
    await waitForText("Main checkout");
    await snap("welcome-layout-step.png");

    // Jump to the last pip rather than clicking Next four times: the pips are
    // the thing the renumbering would break, and this asserts the count too.
    const pips = await browser.execute(() =>
      [...document.querySelectorAll('[aria-label^="Step "]')].map(
        el => el.getAttribute("aria-label")),
    );
    // FOUR, not five. The wizard opens with no repos directory set, so it
    // has nothing to suggest and drops the project picker rather than
    // showing a step whose only content is "nothing to suggest". The finish
    // button moves onto the step before it.
    expect(pips).toEqual(["Step 1", "Step 2", "Step 3", "Step 4"]);
    await clickWhenVisible('[aria-label="Step 4"]');
    await waitForText("Pick your theme");
    await waitForText("Get started");

    await browser.execute(() => window.__termic!.useUI.getState().closeWelcome());
    await browser.waitUntil(async () => (await flag("welcomeOpen")) === false, {
      timeout: 5_000,
      timeoutMsg: "welcome never closed",
    });
  });

  it("race dialog opens for a project", async () => {
    await browser.execute(() => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI.getState().openRace(proj.id);
    });
    await waitVisible('[role="dialog"]', 8_000);
    await snap("dialogs2.png");
    // Close it. The suite shares ONE app window on Windows (the whole run is
    // a single launch there, unlike the per-file relaunch macOS gets), so a
    // dialog left open outlives this file: it sat over `codenav.e2e.ts` and
    // swallowed the chip click, which read as "Terraform diagnostics never
    // arrived" four specs later with nothing in the log to connect them.
    await browser.execute(() => window.__termic!.useUI.getState().closeRace());
    // By its own text, not `[role="dialog"]`: earlier cases in this block
    // leave their dialogs open on purpose, so "no dialog at all" is false.
    await waitForTextGone("Start an agent race");
  });
});

// P1: windowless mode. Closing the window must send Termic to
// the menu bar WITHOUT killing agents, and must collapse every task pane to
// zero geometry — the only thing that actually pauses xterm's renderers, since
// a hidden NSWindow still reports full layout (docs/performance.md bear trap 2
// at window scope). Restoring goes through the CLI socket's unauthenticated
// `raise`, the same verb `termic open` and the single-instance handshake use.
//
// Cases: close goes windowless without killing the task; panes sit at zero
// geometry while windowless; agent output still flows while windowless
// (the whole point of a daemon); raise restores window + panes.
// macOS only: closing the window keeps the app running in the menu bar
// there. On Windows and Linux closing the window quits, by design (the close
// handler is macOS-only, docs/windows.md), so this suite would close the app
// under every later case.
(process.platform !== "darwin" ? describe.skip : describe)("windowless mode", () => {
  let taskId!: string;

  // Same constant wdio launches the app with, rather than a second hard-coded
  // copy of the path that could drift from it.
  const socketPath = path.join(dataDir, "termic.sock");

  /** Unauthenticated `raise` over the control socket (cli_server.rs handles it
   *  before the auth gate, so it works with the CLI setting off). */
  async function raiseOverSocket(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const c = controlConnect(socketPath);
      c.on("error", reject);
      c.on("connect", () => c.write(JSON.stringify({ id: "e2e", cmd: "raise" }) + "\n"));
      const t = setTimeout(() => { c.destroy(); reject(new Error("raise timed out")); }, 10_000);
      c.on("data", () => { clearTimeout(t); c.end(); resolve(); });
    });
  }

  const state = () =>
    browser.execute(() => {
      const t = window.__termic!;
      // Panes with NON-ZERO geometry: exactly what decides whether xterm keeps
      // its renderers running.
      const live = [...document.querySelectorAll(".xterm-screen")]
        .filter(e => e.getBoundingClientRect().width > 0).length;
      return {
        windowless: t.useUI.getState().windowless as boolean,
        livePanes: live,
        mounted: [...t.useApp.getState().mountedTasks].length as number,
      };
    });

  before(async () => {
    await waitForAppShell();
    // Belt and braces: the race case closes its own dialog now (it has to,
    // this describe is macOS-only and Windows runs the whole suite in ONE app
    // window), and a stacked close prompt should be covered by its own
    // styling rather than by accident here.
    await browser.execute(() => {
      const u = window.__termic!.useUI.getState();
      u.closeRace?.(); u.closeWelcome?.(); u.closeChangelog?.();
    });
    taskId = await openTask("bg-mode");
    // Wait for the PTY so there is a real terminal to collapse.
    await browser.waitUntil(
      async () => browser.execute(
        (id) => ((window.__termic!.useApp.getState().tabs[id] || []) as any[])
          .some(t => t.ptyId),
        taskId!,
      ),
      { timeout: 20_000, timeoutMsg: "task never spawned a PTY" },
    );
  });

  after(async () => {
    // Never leave the suite windowless. Later spec files launch their own
    // window, but a stuck Accessory policy would be a miserable debug, so a
    // failure here is REPORTED rather than swallowed - loud in this file beats
    // mysterious in the next one.
    await setCloseAction(null).catch(() => {});
    await raiseOverSocket();
    await browser.waitUntil(async () => (await state()).windowless === false, {
      timeout: 15_000,
      timeoutMsg: "teardown could not restore the window; later specs would run windowless",
    });
    if (taskId) await archiveTask(taskId);
  });

  /** Set the backend `close_action` so a case can pick prompt vs no-prompt. */
  const setCloseAction = (v: string | null) =>
    browser.execute(async (val) => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      await t.ipc.settingsSave({ ...s, close_action: val ?? undefined });
    }, v);

  const closeWindow = () =>
    browser.execute(() =>
      window.__termic!.invoke("plugin:window|close", { label: "main" }));

  const promptOpen = () =>
    browser.execute(() => window.__termic!.useUI.getState().closePromptOpen as boolean);

  it("asks before closing, and dismissing the prompt cancels the close", async () => {
    await setCloseAction("ask");
    const before = await state();
    expect(before.windowless).toBe(false);
    expect(before.livePanes).toBeGreaterThan(0);

    await closeWindow();
    await browser.waitUntil(async () => (await promptOpen()) === true, {
      timeout: 15_000, timeoutMsg: "close did not raise the prompt",
    });
    // The prompt is the branch's main new surface: capture it while it is up.
    await waitVisible('[data-testid="close-menubar"]');
    await snap("close-prompt.png");

    // Dismissal (Esc / click-away) must be HARMLESS: not a quit, and not even
    // going windowless. The window stays exactly as it was.
    await browser.execute(() => window.__termic!.useUI.getState().setClosePromptOpen(false));
    const after = await state();
    expect(after.windowless).toBe(false);
    expect(after.livePanes).toBeGreaterThan(0);
  });

  it("'Keep in Menu Bar' goes windowless without killing the task", async () => {
    await setCloseAction("ask");
    const before = await state();
    await closeWindow();
    await browser.waitUntil(async () => (await promptOpen()) === true, {
      timeout: 15_000, timeoutMsg: "close did not raise the prompt",
    });
    // CLICK THE REAL BUTTON. Invoking window_close_choice directly would keep
    // passing if the two onClick handlers were swapped - on a dialog where one
    // button SIGKILLs every running agent, the wiring is the thing to assert.
    await clickWhenVisible('[data-testid="close-menubar"]');

    await browser.waitUntil(async () => (await state()).windowless === true, {
      timeout: 15_000, timeoutMsg: "'Keep in Menu Bar' never windowless the app",
    });
    // The task must SURVIVE: unmounting would kill its PTY and the agent.
    expect((await state()).mounted).toBe(before.mounted);
    const alive = await browser.execute(
      (id) => ((window.__termic!.useApp.getState().tabs[id] || []) as any[])
        .some(t => t.ptyId),
      taskId!,
    );
    expect(alive).toBe(true);
  });

  /** Put the app in a known state, whatever the previous case left behind. */
  async function ensureWindowless(want: boolean) {
    if ((await state()).windowless === want) return;
    if (want) {
      await setCloseAction("menubar");
      await closeWindow();
    } else {
      await raiseOverSocket();
    }
    await browser.waitUntil(async () => (await state()).windowless === want, {
      timeout: 15_000, timeoutMsg: `could not reach windowless=${want}`,
    });
    await setCloseAction("ask");
  }

  it("collapses every task pane to zero geometry while windowless", async () => {
    await ensureWindowless(true);
    // Timers are clamped to 1Hz in a hidden webview, so give the layout a
    // generous window to settle rather than assuming one tick.
    await browser.waitUntil(async () => (await state()).livePanes === 0, {
      timeout: 15_000,
      timeoutMsg: "panes still had non-zero geometry while windowless — "
        + "xterm's renderers would keep drawing for an invisible window",
    });
  });

  it("keeps agent output flowing while windowless", async () => {
    await ensureWindowless(true);
    const at = () => browser.execute(
      (id) => {
        const tab = ((window.__termic!.useApp.getState().tabs[id] || []) as any[])
          .find(t => t.ptyId);
        return (tab?.lastOutputAt ?? 0) as number;
      }, taskId!);
    const before = await at();
    // Bytes through the real PTY. (workState deliberately NOT asserted: termic
    // gates the working indicator on a submit through its own input path, so a
    // raw ptyWrite never flips it — visible or hidden. See the e2e skill.)
    await browser.execute((id) => {
      const t = window.__termic!;
      const tab = ((t.useApp.getState().tabs[id] || []) as any[]).find(x => x.ptyId);
      return t.ipc.ptyWrite(tab.ptyId, [...new TextEncoder().encode("hello\r")]);
    }, taskId!);
    await browser.waitUntil(async () => (await at()) > before, {
      timeout: 20_000,
      timeoutMsg: "no PTY output reached the webview while windowless — "
        + "the daemon property is broken",
    });
    expect((await state()).windowless).toBe(true);
  });

  it("skips the prompt once 'Don't ask again' has been stored", async () => {
    await raiseOverSocket();
    await browser.waitUntil(async () => (await state()).windowless === false, {
      timeout: 15_000, timeoutMsg: "could not restore before the remembered-close case",
    });
    await setCloseAction("menubar");
    await closeWindow();
    await browser.waitUntil(async () => (await state()).windowless === true, {
      timeout: 15_000, timeoutMsg: "a remembered 'menubar' close did not go windowless",
    });
    expect(await promptOpen()).toBe(false);
    await setCloseAction("ask");
  });

  it("'Don't ask again' persists the choice from the dialog itself", async () => {
    await raiseOverSocket();
    await browser.waitUntil(async () => (await state()).windowless === false, {
      timeout: 15_000, timeoutMsg: "could not restore before the checkbox case",
    });
    await setCloseAction("ask");
    await closeWindow();
    await browser.waitUntil(async () => (await promptOpen()) === true, {
      timeout: 15_000, timeoutMsg: "close did not raise the prompt",
    });
    // Tick the real checkbox, then click the real button: this is the only
    // case that exercises checkbox -> window_close_choice(remember) -> disk.
    await clickWhenVisible('[data-testid="close-dont-ask"]');
    await clickWhenVisible('[data-testid="close-menubar"]');
    await browser.waitUntil(async () => (await state()).windowless === true, {
      timeout: 15_000, timeoutMsg: "checkbox path never went windowless",
    });
    const stored = await browser.execute(async () =>
      (await window.__termic!.ipc.settingsLoad()).close_action);
    expect(stored).toBe("menubar");
    await setCloseAction("ask");
  });

  // The case that would have caught the fireDone gate: the task is ACTIVE when
  // the window closes, so every focus-proxy check says "the user is watching"
  // even though there is no window. Drives a REAL submit through the input path
  // (a raw ptyWrite never arms work detection) and asserts the completion is
  // not swallowed.
  it("flags completion for the ACTIVE task while windowless", async () => {
    await raiseOverSocket();
    await browser.waitUntil(async () => (await state()).windowless === false, {
      timeout: 15_000, timeoutMsg: "could not restore before the completion case",
    });
    // Make the task and its agent tab active, so the proxy is maximally wrong.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      s.setActiveTask(id);
      const tab = (s.tabs[id] || []).find((t: any) => t.ptyId);
      s.setActiveTabId(id, tab.id);
      s.patchTab(id, tab.id, { unread: false, workState: undefined });
    }, taskId!);

    await setCloseAction("menubar");
    await closeWindow();
    await browser.waitUntil(async () => (await state()).windowless === true, {
      timeout: 15_000, timeoutMsg: "close did not go windowless",
    });

    // Armed submit, exactly as the real send path does (stamp lastInputAt).
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const tab = (s.tabs[id] || []).find((t: any) => t.ptyId);
      s.patchTab(id, tab.id, { lastInputAt: Date.now() });
      window.__termic!.ipc.ptyWrite(
        tab.ptyId, Array.from(new TextEncoder().encode("do something\r")));
    }, taskId!);

    // fakeagent goes spinner then back to the idle glyph; termic must turn that
    // into unread/done rather than silently idling it.
    await browser.waitUntil(
      async () => browser.execute((id) => {
        const tab = ((window.__termic!.useApp.getState().tabs[id] || []) as any[])
          .find(t => t.ptyId);
        return tab?.unread === true || tab?.workState === "done";
      }, taskId!),
      { timeout: 30_000,
        timeoutMsg: "an agent finishing while windowless left NO unread/done on "
          + "the active task - the completion was swallowed" },
    );
    await setCloseAction("ask");
  });

  it("surfaces the close behavior in Settings > General", async () => {
    await raiseOverSocket();
    await browser.waitUntil(async () => (await state()).windowless === false, {
      timeout: 15_000, timeoutMsg: "could not restore before the settings case",
    });
    // Flash-target the block so the screenshot lands on the right control.
    await browser.execute(() =>
      window.__termic!.useApp.getState()
        .openSettings("general", undefined, "close-action"));
    await waitVisible('[data-testid="close-action-select"]');
    // All three options must be reachable here: "Ask me each time" is the only
    // way back once "Don't ask again" has been ticked.
    const opts = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="close-action-select"] option')]
        .map(o => (o as HTMLOptionElement).value));
    expect(opts).toEqual(["ask", "menubar", "quit"]);
    await snap("close-action-setting.png");
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("raise restores the window and the panes", async () => {
    await raiseOverSocket();
    await browser.waitUntil(async () => {
      const s = await state();
      return s.windowless === false && s.livePanes > 0;
    }, { timeout: 15_000, timeoutMsg: "raise did not restore the window/panes" });
    await snap("windowless-restored.png");
  });
});

// P1: the History view (the archive). Its list is the one place in the app
// whose height is driven purely by how much the user has accumulated, so the
// cases here are about it staying INSIDE the window: the pane must be bounded
// no matter how many tasks are archived, and the overflow must be reachable by
// scrolling. Regression guard for the archive rendering taller than the window
// with no scrollbar (the root used `flex-1` inside MainArea's non-flex overlay,
// where it is inert, so the root sized to its content and the inner scroller
// never had anything to overflow).
describe("history view", () => {
  const created: string[] = [];

  after(async () => {
    // Hard-delete everything this block made: it archives by design, so leaving
    // them behind would grow the archive for every later run of the profile.
    for (const id of created) {
      await browser.execute(async (i) => {
        try { await window.__termic!.ipc.taskDelete(i); } catch { /* already gone */ }
      }, id);
    }
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    await clickByText("Dashboard");
  });

  /** Open a task, archive it immediately, and remember it for teardown. */
  async function archiveNew(name: string): Promise<void> {
    const id = await openTask(name, false);
    created.push(id);
    await archiveTask(id);
  }

  const openHistory = async () => {
    await clickByText("Dashboard");
    await clickByText("History");
    await waitVisible('[data-testid="history-list"]');
  };

  /** Geometry of the scroller + the overlay it must fit inside. */
  const listBox = () =>
    browser.execute(() => {
      const list = document.querySelector('[data-testid="history-list"]') as HTMLElement;
      const root = document.querySelector('[data-testid="history-root"]') as HTMLElement;
      return {
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
        scrollTop: list.scrollTop,
        overflowY: getComputedStyle(list).overflowY,
        bottom: Math.round(list.getBoundingClientRect().bottom),
        rootHeight: Math.round(root.getBoundingClientRect().height),
        parentHeight: Math.round((root.parentElement as HTMLElement).getBoundingClientRect().height),
        rows: document.querySelectorAll("[data-history-row]").length,
      };
    });

  it("fills its pane instead of sizing to the archive", async () => {
    await archiveNew("history-fills-pane");
    await openHistory();
    const box = await listBox();
    // The root taking the overlay's full height is the whole fix: sized to
    // content it would be a few rows tall and the list could never scroll.
    expect(box.rootHeight).toBe(box.parentHeight);
    expect(box.overflowY).toBe("auto");
    // And the scroller ends at or above the window's bottom edge - never past
    // it, which is what put rows out of reach.
    const winH = await browser.execute(() => window.innerHeight);
    expect(box.bottom).toBeLessThanOrEqual(winH);
  });

  it("scrolls to the last task when the archive is taller than the window", async () => {
    await openHistory();
    // Fill past the fold. Measure one row rather than guessing a row height, so
    // the case survives a density change in the list; group headers only add
    // height, so overshooting is safe and undershooting is impossible.
    const first = await listBox();
    const rowH = await browser.execute(() => {
      const r = document.querySelector("[data-history-row]") as HTMLElement;
      return r.getBoundingClientRect().height;
    });
    const need = Math.ceil(first.clientHeight / rowH) + 3 - first.rows;
    for (let i = 0; i < need; i++) await archiveNew(`history-scroll-${i}`);
    await openHistory();

    const box = await listBox();
    // Only when this run actually added rows. The profile is reused between
    // `make e2e` runs and every spec archives its tasks, so on a machine that
    // has run the suite a few times the archive is ALREADY taller than the
    // window, `need` comes out <= 0, and "more rows than before" is a
    // condition nothing in this test can satisfy. It failed that way at 29
    // rows against 29. What the case is actually about is the two assertions
    // below, which hold either way.
    if (need > 0) expect(box.rows).toBeGreaterThan(first.rows);
    expect(box.rows).toBeGreaterThanOrEqual(first.rows);
    // Content genuinely overflows, and the overflow lives in the SCROLLER (not
    // spilling out of the window).
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    const winH = await browser.execute(() => window.innerHeight);
    expect(box.bottom).toBeLessThanOrEqual(winH);

    // The last row starts out of view and comes into view after scrolling: the
    // user-facing outcome, not the CSS.
    const lastVisible = () =>
      browser.execute(() => {
        const list = document.querySelector('[data-testid="history-list"]') as HTMLElement;
        const rows = [...document.querySelectorAll("[data-history-row]")] as HTMLElement[];
        const last = rows[rows.length - 1].getBoundingClientRect();
        const view = list.getBoundingClientRect();
        return last.bottom <= view.bottom + 1 && last.top >= view.top - 1;
      });
    expect(await lastVisible()).toBe(false);
    await browser.execute(() => {
      const list = document.querySelector('[data-testid="history-list"]') as HTMLElement;
      list.scrollTop = list.scrollHeight;
    });
    await browser.waitUntil(async () => (await listBox()).scrollTop > 0, {
      timeout: 5_000, timeoutMsg: "history list did not scroll",
    });
    expect(await lastVisible()).toBe(true);
    await snap("history-scrolled.png");
  });

  it("filters the archive down and back without breaking the scroller", async () => {
    await openHistory();
    const all = await listBox();
    await browser.execute(() => {
      const input = document.querySelector(
        'input[placeholder="Filter tasks..."]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value",
      )!.set!;
      setter.call(input, "history-fills-pane");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.waitUntil(async () => (await listBox()).rows === 1, {
      timeout: 5_000, timeoutMsg: "filter did not narrow the archive",
    });
    // Filtered short, the pane still owns its full height - the bug's other
    // half was the container collapsing onto its content.
    const narrowed = await listBox();
    expect(narrowed.rootHeight).toBe(narrowed.parentHeight);

    await browser.execute(() => {
      const input = document.querySelector(
        'input[placeholder="Filter tasks..."]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value",
      )!.set!;
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.waitUntil(async () => (await listBox()).rows === all.rows, {
      timeout: 5_000, timeoutMsg: "clearing the filter did not restore the archive",
    });
  });
});
