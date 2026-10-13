import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveTask, clickWhenVisible, ensureActiveTask, keysIn, openTask, requireTermicApi, snap, waitForAppShell, waitVisible } from "../helpers";
import { dataDir } from "../../wdio.conf.js";

// Ghostty and Warp themes show up in the theme picker beside native ones,
// with the chrome derived from their terminal palette (theme_import.rs reads
// them, customTheme.ts's deriveChrome fills the `ui` keys). The fixtures
// are synthetic: the classic Monokai palette, retyped in each format.
//
// Only the Ghostty / Warp roots are redirected (TERMIC_E2E_THEME_HOME).
// termic's own themes dir is the real one, as for every other spec: the
// e2e binary shares localStorage with an installed Termic, and a themes dir
// missing the user's active theme makes startup reset it to Claude, in the
// installed app too. So the fixtures carry an `E2E` prefix, which keeps the
// copies a pick writes off any real copy, and `after` removes exactly those.
const home = path.join(dataDir, "theme-home");
const themesDir = path.join(
  process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config"),
  "termic/themes",
);
const COPIES = ["ghostty-e2e-monokai-classic", "ghostty-e2e-monokai-light", "warp-e2e-monokai", "ghostty-aaa-e2e-early"];
/** localStorage this spec writes, restored in `after` (shared, see above). */
const SAVED_KEYS = ["commandPaletteThemeFilter", "commandPaletteThemeRecent"];

const GHOSTTY_MONOKAI = `# classic monokai
palette = 0=#272822
palette = 1=#f92672
palette = 2=#a6e22e
palette = 3=#e6db74
palette = 4=#66d9ef
palette = 5=#ae81ff
palette = 6=#a1efe4
palette = 7=#f8f8f2
palette = 8=#75715e
palette = 9=#f92672
palette = 10=#a6e22e
palette = 11=#f4bf75
palette = 12=#66d9ef
palette = 13=#ae81ff
palette = 14=#a1efe4
palette = 15=#f9f8f5
background = 272822
foreground = f8f8f2
cursor-color = f8f8f0
selection-background = 49483e
selection-foreground = f8f8f2
`;

// the same hues on a light background, to exercise the light derivation
const GHOSTTY_MONOKAI_LIGHT = GHOSTTY_MONOKAI
  .replace("background = 272822", "background = fafaf8")
  .replace("foreground = f8f8f2", "foreground = 272822")
  .replace("palette = 3=#e6db74", "palette = 3=#998f2f");

const WARP_MONOKAI = `name: E2E Monokai Warp
accent: '#fd971f'
background: '#272822'
foreground: '#f8f8f2'
details: darker
terminal_colors:
  normal:
    black: '#272822'
    red: '#f92672'
    green: '#a6e22e'
    yellow: '#e6db74'
    blue: '#66d9ef'
    magenta: '#ae81ff'
    cyan: '#a1efe4'
    white: '#f8f8f2'
  bright:
    black: '#75715e'
    red: '#f92672'
    green: '#a6e22e'
    yellow: '#f4bf75'
    blue: '#66d9ef'
    magenta: '#ae81ff'
    cyan: '#a1efe4'
    white: '#f9f8f5'
`;

const write = (rel: string, body: string) => {
  const p = path.join(home, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
};

/** The palette's import list, as the store sanitized it. */
const loadImports = () =>
  browser.execute(async () => {
    const p = window.__termic!.usePrefs;
    await p.getState().loadImportedThemes();
    return p.getState().importedThemes.map((t: { id: string; name: string; colorScheme: string }) => ({ id: t.id, name: t.name, scheme: t.colorScheme }));
  }) as unknown as Promise<Array<{ id: string; name: string; scheme: string }>>;

const themeMode = () => browser.execute(() => window.__termic!.usePrefs.getState().themeMode);

/** The native copy picking an import writes (themes_save_import). */
const copyPath = (stem: string) => path.join(themesDir, `${stem}.json`);

/** Pick an import the way the palette commits one, then reload. A runtime
 *  theme switch leaves every `transition-colors` element on its old colour
 *  in this window (docs/gotchas.md, and it does the same for the built-in
 *  Light theme), so a screenshot taken right after the switch shows a mix of
 *  two themes. The reload also proves the pick survives as the native copy.
 *  Loads the import list first: after a reload the store starts empty. */
const pickAndReload = async (id: string, taskId: string) => {
  await loadImports();
  await browser.execute((i) => window.__termic!.usePrefs.getState().pickImportedTheme(i as `custom:${string}`), id);
  await browser.refresh();
  await waitForAppShell();
  await requireTermicApi();
  await ensureActiveTask(taskId);
  await waitVisible(`[data-task-id="${taskId}"]`);
};

const INPUT = 'input[placeholder*="Pick a theme"]';

/** Open the theme list the way a user does, from the sidebar icon. */
const openList = async () => {
  await clickWhenVisible('[data-testid="theme-picker"]');
  await waitVisible(INPUT);
};

/** A real key into the list's input. Never a bare `browser.keys`: the input
 *  autofocuses through rAF, which is frozen while the window is occluded, and
 *  the key would land in the agent's terminal instead (see keysIn). */
const key = (k: string) => keysIn(INPUT, k);

const closeList = async () => {
  await browser.keys("Escape");
  await browser.keys("Escape");
  await browser.waitUntil(() => browser.execute(() => !window.__termic!.useUI.getState().commandPaletteOpen));
};

/** The highlighted row's command id (`theme:<mode>`). */
const activeId = () => browser.execute(() =>
  [...document.querySelectorAll("[data-row]")].find(r => (r as HTMLElement).style.background)?.getAttribute("data-cmd-id"));

const listed = (mode: string) =>
  browser.execute((m) => !!document.querySelector(`[data-cmd-id="theme:${m}"]`), mode);

/** Section headers in render order, and each section's row labels. */
const sections = () => browser.execute(() =>
  [...new Set([...document.querySelectorAll("[data-row]")].map(r => r.parentElement!))].map(g => ({
    title: g.firstElementChild!.textContent!.trim(),
    labels: [...g.querySelectorAll("[data-row] span.truncate")].map(e => e.textContent!.trim()),
  }))) as unknown as Promise<Array<{ title: string; labels: string[] }>>;

/** Presses a filter button. It acts on mousedown (so the input keeps
 *  focus), which a scripted `.click()` never fires. */
const filter = async (f: "dark" | "light" | "all") => {
  const sel = `[data-testid="theme-filter-${f}"]`;
  await waitVisible(sel);
  await browser.execute((s) => {
    document.querySelector(s)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  }, sel);
};

const cssVar = (name: string) =>
  browser.execute((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

describe("theme import (Ghostty / Warp)", () => {
  let taskId = "";
  let original = "";
  let saved: Record<string, string | null> = {};

  before(async () => {
    rmSync(home, { recursive: true, force: true });
    for (const c of COPIES) rmSync(copyPath(c), { force: true });
    write(".config/ghostty/themes/E2E Monokai Classic", GHOSTTY_MONOKAI);
    write(".config/ghostty/themes/E2E Monokai Light", GHOSTTY_MONOKAI_LIGHT);
    // not a theme: no colors, must not list
    write(".config/ghostty/themes/README", "these are my themes\n");
    // sorts ahead of every built-in dark theme, so its arrival shifts rows
    write(".config/ghostty/themes/AAA E2E Early", GHOSTTY_MONOKAI);
    // nested, the way a cloned warpdotdev/themes repo lays them out
    write(".warp/themes/standard/e2e-monokai.yaml", WARP_MONOKAI);
    write(".warp/themes/standard/broken.yaml", ": not [ yaml");
    // Ghostty's bundled catalog (the e2e build reads <home>/bundled for it):
    // all of it lists, and a user theme of the same name shadows the bundled one
    write("bundled/E2E Monokai Bundled", GHOSTTY_MONOKAI);
    write("bundled/E2E Monokai Classic", GHOSTTY_MONOKAI.replace("background = 272822", "background = 000000"));
    await waitForAppShell();
    await requireTermicApi();
    original = await themeMode();
    // a run killed mid-spec never reaches `after`, so the shared prefs can
    // still name a copy this hook just deleted: the list cannot open on a
    // theme it does not hold, and restoring it would restore nothing
    if (COPIES.some(c => original === `custom:${c}`)) {
      original = "claude";
      await browser.execute(() => window.__termic!.usePrefs.getState().setThemeMode("claude"));
    }
    // the list's saved toggle and recents would leak in from earlier runs;
    // saved first, since they are the user's own
    saved = await browser.execute((keys) => {
      const out: Record<string, string | null> = {};
      for (const k of keys) { out[k] = localStorage.getItem(k); localStorage.removeItem(k); }
      return out;
    }, SAVED_KEYS);
    taskId = await openTask("theme-import");
  });

  after(async () => {
    await browser.execute((m, s) => {
      window.__termic!.usePrefs.getState().setThemeMode(m as any);
      for (const [k, v] of Object.entries(s)) {
        if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
      }
    }, original, saved);
    if (taskId) await archiveTask(taskId);
    rmSync(home, { recursive: true, force: true });
    for (const c of COPIES) rmSync(copyPath(c), { force: true });
  });

  it("lists Ghostty and Warp themes, skipping files that are not themes", async () => {
    const themes = await loadImports();
    const byId = Object.fromEntries(themes.map(t => [t.id, t]));
    expect(byId["custom:ghostty:e2e-monokai-classic"]?.name).toBe("E2E Monokai Classic");
    expect(byId["custom:ghostty:e2e-monokai-light"]?.scheme).toBe("light");
    expect(byId["custom:warp:e2e-monokai"]?.name).toBe("E2E Monokai Warp");
    expect(byId["custom:ghostty:readme"]).toBeUndefined();
    expect(themes.some(t => t.id.includes("broken"))).toBe(false);
  });

  it("lists the bundled Ghostty catalog, shadowed by the user's own", async () => {
    const ids = (await loadImports()).map(t => t.id);
    expect(ids).toContain("custom:ghostty:e2e-monokai-bundled");
    expect(ids.filter(i => i === "custom:ghostty:e2e-monokai-classic")).toHaveLength(1);
  });

  it("opens the theme list from the sidebar icon, on the current theme", async () => {
    await openList();
    // the imports arrive after the list opens: that must not move the
    // highlight (and so the live preview) off the current theme
    await waitVisible('[data-cmd-id="theme:custom:warp:e2e-monokai"]');
    const active = await activeId();
    const previewed = await themeMode();
    // the source is a tag beside the plain name
    const warpRow = await browser.execute(() =>
      (document.querySelector('[data-cmd-id="theme:custom:warp:e2e-monokai"]') as HTMLElement).innerText);
    await snap("theme-import-palette-list.png");
    await closeList();
    expect(active).toBe(`theme:${original}`);
    expect(previewed).toBe(original);
    expect(warpRow).toMatch(/E2E Monokai Warp\s+Warp/);
    expect(await themeMode()).toBe(original);
  });

  it("opens on the current theme's scheme and cycles the filter with Tab", async () => {
    await openList();
    await waitVisible('[data-cmd-id="theme:custom:warp:e2e-monokai"]');
    // dark theme current: the light ones stay out of the arrow path
    const darkOnly = { light: await listed("custom:ghostty:e2e-monokai-light"), titles: (await sections()).map(g => g.title) };
    await key("Tab");
    await waitVisible('[data-cmd-id="theme:custom:ghostty:e2e-monokai-light"]');
    const lightOnly = {
      dark: await listed(original),
      titles: (await sections()).map(g => g.title),
      active: await activeId(),
    };
    await key("Tab");
    await waitVisible(`[data-cmd-id="theme:${original}"]`);
    const all = (await sections()).map(g => g.title);
    await closeList();
    expect(darkOnly).toEqual({ light: false, titles: ["System", "Dark"] });
    expect(lightOnly.dark).toBe(false);
    expect(lightOnly.titles).toEqual(["System", "Light"]);
    // switching lands on the new scheme's first theme, not System, which
    // would preview whatever the OS is set to
    expect(lightOnly.active).not.toBe("theme:auto");
    expect(all).toEqual(["System", "Dark", "Light"]);
    expect(await browser.execute(() => localStorage.getItem("commandPaletteThemeFilter"))).toBe("all");
    expect(await themeMode()).toBe(original);
  });

  it("sorts each section by name", async () => {
    await openList();
    await filter("all");
    await waitVisible('[data-cmd-id="theme:custom:ghostty:e2e-monokai-light"]');
    const groups = await sections();
    await closeList();
    for (const g of groups.filter(g => g.title !== "System")) {
      expect(g.labels).toEqual([...g.labels].sort((a, b) => a.localeCompare(b)));
    }
  });

  it("keeps a saved filter unless it would hide the current theme", async () => {
    await browser.execute(() => localStorage.setItem("commandPaletteThemeFilter", "light"));
    await openList();
    await waitVisible(`[data-cmd-id="theme:${original}"]`);
    const opened = { active: await activeId(), light: await listed("light") };
    await closeList();
    expect(opened).toEqual({ active: `theme:${original}`, light: false });
    // skipped for that opening only: the saved choice stays
    expect(await browser.execute(() => localStorage.getItem("commandPaletteThemeFilter"))).toBe("light");
    await browser.execute(() => localStorage.removeItem("commandPaletteThemeFilter"));
  });

  it("arrows through a filtered theme list, previewing each match", async () => {
    await openList();
    await waitVisible('[data-cmd-id="theme:custom:warp:e2e-monokai"]');
    await key("e2e monokai");
    await browser.waitUntil(() => browser.execute(() => !document.querySelector('[data-cmd-id="theme:claude"]')));
    const first = await activeId();
    // each move previews the row, and the store write re-renders the list;
    // that must not snap the highlight back to the best match, so read it
    // once the preview has landed
    const step = async (from: string | null | undefined) => {
      await key("ArrowDown");
      await browser.waitUntil(async () => {
        const id = await activeId();
        return id !== from && (await themeMode()) === id?.slice("theme:".length);
      });
      return activeId();
    };
    const second = await step(first);
    const previewed = await themeMode();
    const third = await step(second);
    await closeList();
    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
    expect(previewed).toBe(second!.slice("theme:".length));
    expect(await themeMode()).toBe(original);
  });

  it("shows the current theme above the list and jumps back to it", async () => {
    const CHIP = '[data-testid="theme-current"]';
    const chip = () => browser.execute((s) => document.querySelector(s)?.textContent?.trim(), CHIP);
    const rowLabel = (m: string) => browser.execute((mm) =>
      document.querySelector(`[data-cmd-id="theme:${mm}"] span.truncate`)?.textContent?.trim(), m);
    // the highlighted row sits inside the list's scroll viewport
    const activeInView = () => browser.execute(() => {
      const row = [...document.querySelectorAll("[data-row]")].find(r => (r as HTMLElement).style.background);
      const list = row?.closest(".overflow-y-auto");
      if (!row || !list) return false;
      const r = row.getBoundingClientRect(), l = list.getBoundingClientRect();
      return r.top >= l.top - 1 && r.bottom <= l.bottom + 1;
    });

    await openList();
    await waitVisible('[data-cmd-id="theme:custom:warp:e2e-monokai"]');
    await waitVisible(CHIP);
    // a short name must render whole, not clipped to an ellipsis by the input
    const clipped = () => browser.execute((s) => {
      const span = document.querySelector(`${s} span`) as HTMLElement;
      return span.scrollWidth > span.clientWidth;
    }, CHIP);
    const opened = { chip: await chip(), label: await rowLabel(original), inView: await activeInView(), clipped: await clipped() };

    // wander off: a query that hides it, and a previewed row
    await key("e2e monokai");
    await browser.waitUntil(() => browser.execute(() => !document.querySelector('[data-cmd-id="theme:claude"]')));
    await key("ArrowDown");
    await browser.waitUntil(async () => (await themeMode()) !== original);
    const wandered = await chip();
    await snap("theme-current-chip.png");

    // the chip acts on mousedown (so the input keeps focus), which a
    // scripted `.click()` never fires
    await browser.execute((s) => {
      document.querySelector(s)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    }, CHIP);
    await browser.waitUntil(async () => (await activeId()) === `theme:${original}`);
    const back = {
      query: await browser.execute((s) => (document.querySelector(s) as HTMLInputElement).value, INPUT),
      previewed: await themeMode(),
      inView: await activeInView(),
    };
    await closeList();

    expect(opened.chip).toBeTruthy();
    expect(opened.chip).toBe(opened.label);
    expect(opened.inView).toBe(true);
    expect(opened.clipped).toBe(false);
    // the chip follows the committed theme, not the preview
    expect(wandered).toBe(opened.chip);
    expect(back).toEqual({ query: "", previewed: original, inView: true });
    expect(await themeMode()).toBe(original);
  });

  it("applies a Ghostty theme as a native copy with derived chrome", async () => {
    await pickAndReload("custom:ghostty:e2e-monokai-classic", taskId);
    expect(await themeMode()).toBe("custom:ghostty-e2e-monokai-classic");
    expect(existsSync(copyPath("ghostty-e2e-monokai-classic"))).toBe(true);
    // #272822 is the user's copy, the bundled one of the same name is #000000
    await browser.waitUntil(async () => (await cssVar("--color-bg")) === "#272822");
    expect(await cssVar("--color-err")).toBe("#f92672");
    // derived surfaces: 4% of the way from bg #272822 toward fg #f8f8f2
    expect(await cssVar("--color-bg-1")).toBe("#2f302a");
    await snap("theme-import-ghostty-monokai.png");
  });

  it("keeps the pick when the Ghostty file goes away", async () => {
    rmSync(path.join(home, ".config/ghostty/themes/E2E Monokai Classic"));
    await browser.refresh();
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() => window.__termic!.usePrefs.getState().loadCustomThemes());
    expect(await themeMode()).toBe("custom:ghostty-e2e-monokai-classic");
    expect(await cssVar("--color-bg")).toBe("#272822");
    // the bundled "E2E Monokai Classic" (#000000) is no longer shadowed and
    // lists again, but the palette shows the copy in its place, not both
    expect((await loadImports()).map(t => t.id)).toContain("custom:ghostty:e2e-monokai-classic");
    await browser.execute(() => window.__termic!.useUI.getState().openCommandPalette("theme"));
    await waitVisible('[data-cmd-id="theme:custom:ghostty-e2e-monokai-classic"]');
    await waitVisible('[data-cmd-id="theme:custom:warp:e2e-monokai"]');
    const listed = await browser.execute(() => !!document.querySelector('[data-cmd-id="theme:custom:ghostty:e2e-monokai-classic"]'));
    await browser.keys("Escape");
    await browser.keys("Escape");
    await browser.waitUntil(() => browser.execute(() => !window.__termic!.useUI.getState().commandPaletteOpen));
    expect(listed).toBe(false);
    expect(await cssVar("--color-bg")).toBe("#272822");
  });

  it("uses the Warp accent instead of deriving one", async () => {
    await pickAndReload("custom:warp:e2e-monokai", taskId);
    await browser.waitUntil(async () => (await cssVar("--color-accent")) === "#fd971f");
    await snap("theme-import-warp-monokai.png");
  });

  it("derives a light chrome from a light background", async () => {
    await pickAndReload("custom:ghostty:e2e-monokai-light", taskId);
    await browser.waitUntil(async () => (await cssVar("--color-bg")) === "#fafaf8");
    expect(await browser.execute(() => document.documentElement.style.colorScheme)).toBe("light");
    await snap("theme-import-ghostty-monokai-light.png");
  });

  it("pins the last committed theme above the list", async () => {
    await openList();
    await filter("all");
    await clickWhenVisible('[data-cmd-id="theme:dark"]');
    await browser.waitUntil(() => browser.execute(() => !window.__termic!.useUI.getState().commandPaletteOpen));
    await openList();
    await waitVisible('[data-cmd-id="theme:dark"]');
    const first = (await sections())[0];
    const row0 = await browser.execute(() => document.querySelector('[data-row="0"]')?.getAttribute("data-cmd-id"));
    await closeList();
    expect(first.title).toBe("Recent");
    expect(row0).toBe("theme:dark");
    expect(await themeMode()).toBe("dark");
  });

  it("keeps the highlight on the current theme when imports sort in ahead of it", async () => {
    // Matrix sorts late among the dark themes and the "AAA" import first, so
    // the imports landing after the list opens move Matrix's row down: the
    // highlight (and so the preview) must follow the theme, not the index
    await browser.execute(() => {
      const p = window.__termic!.usePrefs;
      p.getState().setThemeMode("matrix");
      p.setState({ importedThemes: [] });
    });
    await openList();
    await waitVisible('[data-cmd-id="theme:custom:ghostty:aaa-e2e-early"]');
    const active = await activeId();
    const previewed = await themeMode();
    await closeList();
    expect(active).toBe("theme:matrix");
    expect(previewed).toBe("matrix");
    expect(await themeMode()).toBe("matrix");
  });

  it("commits an import with Enter, applying nothing else on the way", async () => {
    await openList();
    await waitVisible('[data-cmd-id="theme:custom:ghostty:aaa-e2e-early"]');
    // arrowed to, not typed: on an empty query the Recent section is up, and
    // closing drops it, which shifts every row under the highlight
    for (let i = 0; i < 30 && (await activeId()) !== "theme:custom:ghostty:aaa-e2e-early"; i++) {
      await key("ArrowUp");
    }
    expect(await activeId()).toBe("theme:custom:ghostty:aaa-e2e-early");
    await browser.waitUntil(async () => (await themeMode()) === "custom:ghostty:aaa-e2e-early");
    // a preview is not persisted: quitting here would reopen on Matrix
    expect(await browser.execute(() => localStorage.getItem("themeMode"))).toBe("matrix");
    await browser.execute(() => {
      const w = window as unknown as { __trail: string[]; __unsub: () => void };
      w.__trail = [];
      w.__unsub = window.__termic!.usePrefs.subscribe((s, prev) => {
        if (s.themeMode !== prev.themeMode) w.__trail.push(s.themeMode);
      });
    });
    await key("Enter");
    await browser.waitUntil(async () => (await themeMode()) === "custom:ghostty-aaa-e2e-early");
    const trail = await browser.execute(() => {
      const w = window as unknown as { __trail: string[]; __unsub: () => void };
      w.__unsub();
      return w.__trail;
    });
    expect(trail).toEqual(["custom:ghostty-aaa-e2e-early"]);
    expect(existsSync(copyPath("ghostty-aaa-e2e-early"))).toBe(true);
    expect(await browser.execute(() => localStorage.getItem("themeMode"))).toBe("custom:ghostty-aaa-e2e-early");
    expect(await browser.execute(() => JSON.parse(localStorage.getItem("commandPaletteThemeRecent") ?? "[]")[0]))
      .toBe("custom:ghostty-aaa-e2e-early");
  });
});
