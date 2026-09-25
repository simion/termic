import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "../../wdio.conf.js";
import { archiveTask, clickWhenVisible, dismissOverlays, openTask, pointerDrag, requireTermicApi, snap, waitForAppShell, waitForText, waitForTextGone, waitVisible } from "../helpers";

/** Click the [role="switch"] in the settings row whose label matches exactly.
 *  Toggle rows are label + switch inside one .justify-between wrapper
 *  (Controls.tsx / AppearanceSection.tsx, same markup). */
const clickToggleByLabel = (label: string) =>
  browser.execute((lbl) => {
    const labelEl = [...document.querySelectorAll("div")].find(
      (d) => d.textContent?.trim() === lbl,
    );
    const sw = labelEl
      ?.closest(".justify-between")
      ?.querySelector('[role="switch"]') as HTMLElement | null;
    if (!sw) throw new Error("toggle switch not found for: " + lbl);
    sw.click();
  }, label);

/** aria-checked of the switch in the settings row with this exact label. */
const ariaCheckedFor = (label: string) =>
  browser.execute((lbl) => {
    const labelEl = [...document.querySelectorAll("div")].find(
      (d) => d.textContent?.trim() === lbl,
    );
    return labelEl?.closest(".justify-between")
      ?.querySelector('[role="switch"]')?.getAttribute("aria-checked");
  }, label);

/** Click a segment of the renderer picker. Keyed off `data-renderer`, whose
 *  values are the pref values themselves, so copy edits to the visible labels
 *  cannot break the test the way matching on label text would. */
const selectRendererByValue = (value: "webgl" | "canvas" | "dom") =>
  browser.execute((v) => {
    const btn = document.querySelector(`[data-renderer="${v}"]`) as HTMLElement | null;
    if (!btn) throw new Error("renderer segment not found: " + v);
    btn.click();
  }, value);

// Settings/preferences subsystem. Guards that a real toggle in the Settings
// overlay flips the pref in the prefs store and the control reflects it.
describe("settings", () => {
  // The `workingIndicator` row, renamed when the marks got one switch
  // each (Settings -> Notifications, "Agent status marks").
  const LABEL = "Working";
  let original: boolean | undefined;

  after(async () => {
    // Restore the pref so repeated runs start from the same state (prefs
    // persist to the profile's settings.json).
    if (original === undefined) return;
    await browser.execute((v) => {
      window.__termic!.usePrefs.getState().setWorkingIndicator(v);
    }, original);
  });

  // Each switch draws the mark it governs, and the order is the model: every
  // mid-turn mark hangs off Working, so a user who turns that off does not
  // get a quieter ring in its place. The rows were four paragraphs
  // describing small circles before, which is the hardest way to answer
  // "which dot is that".
  it("shows one switch per mark, each drawing its own mark", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() =>
      window.__termic!.useApp.getState().openSettings("notifications"),
    );
    await waitForText("Agent status marks");

    const marks = await browser.execute(() => {
      const head = [...document.querySelectorAll("div")]
        .find(d => d.textContent?.trim() === "Agent status marks");
      const rows = head?.parentElement?.querySelectorAll('[data-testid="work-badge"]');
      return [...(rows ?? [])].map(el => (el as HTMLElement).dataset.workState);
    });
    expect(marks).toEqual(["working", "delegated", "partial", "done", "attention"]);
    await snap("settings-work-marks.png");
  });

  it("toggles a preference and it lands in the prefs store", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // Open Settings -> Notifications, where the indicator toggles live since
    // General was split into per-domain pages.
    await browser.execute(() =>
      window.__termic!.useApp.getState().openSettings("notifications"),
    );
    await waitForText(LABEL);

    original = await browser.execute(
      () => window.__termic!.usePrefs.getState().workingIndicator,
    );

    // Click the actual toggle switch in that setting's row.
    await clickToggleByLabel(LABEL);

    // The prefs store must reflect the flip (poll, don't sleep).
    await browser.waitUntil(
      () =>
        browser.execute(
          (orig) =>
            window.__termic!.usePrefs.getState().workingIndicator !== orig,
          original,
        ),
      { timeout: 8_000, timeoutMsg: "workingIndicator pref never changed" },
    );

    // ...and the switch's aria-checked must agree with the new store value.
    const now = await browser.execute(
      () => window.__termic!.usePrefs.getState().workingIndicator,
    );
    const checked = await browser.execute((lbl) => {
      const labelEl = [...document.querySelectorAll("div")].find(
        (d) => d.textContent?.trim() === lbl,
      );
      return labelEl
        ?.closest(".justify-between")
        ?.querySelector('[role="switch"]')
        ?.getAttribute("aria-checked");
    }, LABEL);
    expect(checked).toBe(String(now));

    await snap("settings.png");
  });
});

// The settings rail. General used to be an 18-block scroll; it is now split
// into General / Tasks / Notifications / Sandbox / CLI, with two settings
// rehomed into Appearance and Agents & Terminals. These cases pin each page
// to a control that lives ONLY there, so a section landing on the wrong rail
// item fails here instead of in a bug report.
describe("settings rail", () => {
  /** Snapshot for the GPU-toggle case below. The case restores in its own
   *  finally (so the NEXT case in this file never sees a flipped pref: the
   *  preview case asserts a canvas mounts, and the DOM renderer creates
   *  none); this after() is the backstop for the shared profile when the
   *  whole run dies mid-case. Same discipline as the signal-inspector
   *  snapshot. */
  let gpuOriginal: "webgl" | "canvas" | "dom" | undefined;
  /** Same discipline for the two editor-theme prefs: the case below writes
   *  both, and later specs in the run read the editor. */
  let editorThemeOriginals: { dark: string; light: string } | undefined;

  after(async () => {
    if (gpuOriginal !== undefined) {
      await browser.execute((v) => {
        window.__termic!.usePrefs.getState().setTerminalRenderer(v);
      }, gpuOriginal);
    }
    if (editorThemeOriginals) {
      await browser.execute((o) => {
        const p = window.__termic!.usePrefs.getState();
        p.setEditorThemeIdDark(o.dark);
        p.setEditorThemeIdLight(o.light);
      }, editorThemeOriginals);
    }
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  /** Click a rail item by its label. Not clickByText: the CLI item carries an
   *  "exp" badge inside the button, so its textContent is "CLIexp". Scoped to
   *  the settings rail, since the app's own sidebar is an <aside> too and sits
   *  in the DOM behind the overlay. */
  const clickRail = (label: string) =>
    browser.execute((l) => {
      const el = [
        ...document.querySelectorAll('[data-testid="settings-rail"] button'),
      ].find((b) => b.querySelector("span")?.textContent?.trim() === l);
      if (!el) throw new Error(`no rail item: ${l}`);
      (el as HTMLElement).click();
    }, label);

  /** Appearance's sub-tab strip (Editor / Terminal / Interface). */
  const clickAppearanceTab = (id: string) =>
    browser.execute((t) => {
      const el = document.querySelector(`[data-appearance-tab="${t}"]`);
      if (!el) throw new Error(`no appearance tab: ${t}`);
      (el as HTMLElement).click();
    }, id);

  /** Visible text of the content pane only, so a negative assertion can't be
   *  satisfied (or defeated) by the sidebar behind the overlay. */
  const paneText = () =>
    browser.execute(
      () =>
        (document.querySelector('[data-testid="settings-pane"]') as HTMLElement | null)
          ?.innerText ?? "",
    );

  // Rail order, top to bottom, each pinned to a control that lives ONLY on
  // that page. Band order is meaningful (opened-by-choice, set-once, then the
  // perimeter — see docs/ui.md), so the sequence is asserted, not just the
  // membership.
  const pages: Array<[string, string, string]> = [
    ["general", "General", "Repos directory"],
    ["appearance", "Appearance", "Terminal font"],
    ["agents", "Agents & Terminals", "Copy on select"],
    ["tasks", "Tasks", "Branch prefix"],
    ["notifications", "Notifications", "Desktop notifications"],
    ["prompts", "Prompts", "Prompts"],
    ["shortcuts", "Shortcuts", "Shortcuts"],
    // GH #280. Sits in the same band as Shortcuts, and its marker is the
    // DORMANT copy: the fixture profile has no profiles, which is the state
    // this page has to be reachable in (the sidebar footer lands here, and it
    // is where the first profile is made).
    ["profiles", "Profiles", "You have one setup, and no profiles yet."],
    ["sandbox", "Sandbox", "Global sandbox defaults"],
    // Marker has to be above the master toggle: everything else on this
    // page renders only once Docker sandboxing is enabled, and the fixture
    // profile leaves it off.
    ["docker", "Docker Sandbox", "Enable Docker sandbox"],
    ["cli", "CLI & MCP", "Enable CLI"],
  ];

  describe("choosing a language server", () => {
    // The Django lesson made concrete: the fix for a server answering badly is
    // a DIFFERENT server, and until now the resolution order was ours alone.
    // This drives the picker the way a person does, and asserts the two things
    // that make it real: the choice is remembered, and it reaches the code
    // that resolves a binary.
    const openServers = async () => {
      // This describe can run first, so the shell and the bridge are not
      // somebody else's precondition.
      await waitForAppShell();
      await requireTermicApi();
      await browser.execute(() => window.__termic!.useApp.getState().openSettings("appearance"));
      // The tab control, not a label from one particular tab: Appearance
      // remembers which sub-tab was last open, so waiting for "Terminal font"
      // waits for a tab this page may not be showing.
      await waitVisible('[data-appearance-tab="editor"]');
      await browser.execute(() =>
        (document.querySelector('[data-appearance-tab="editor"]') as HTMLElement).click());
      await waitVisible('[data-testid="code-intel-settings"]');
      // TOGGLE, so clicking blindly closes it for the case that follows. The
      // list is collapsed by default and stays open once expanded, so this
      // clicks only when the catalog is not already on screen.
      const listed = async () => await browser.execute(() =>
        !!document.querySelector('[data-testid="lsp-catalog-python"]')) as boolean;
      if (!await listed()) {
        await browser.execute(() => {
          const el = document.querySelector('[data-testid="lsp-servers-toggle"]') as HTMLElement;
          el?.click();
        });
      }
      await waitVisible('[data-testid="lsp-catalog-python"]');
    };

    const chosen = () => browser.execute(() =>
      window.__termic!.usePrefs.getState().codeIntelServers) as Promise<Record<string, string>>;

    after(async () => {
      await browser.execute(() =>
        window.__termic!.usePrefs.getState().setCodeIntelServer("python", null));
    });

    it("starts on Automatic, which is termic's own order", async () => {
      await openServers();
      expect(await chosen()).toEqual({});
      const autoChecked = await browser.execute(() =>
        (document.querySelector('[data-testid="lsp-pick-python-auto"]') as HTMLInputElement)
          ?.checked);
      expect(autoChecked).toBe(true);
    });

    it("remembers a pick, and the resolver is told about it", async () => {
      await openServers();
      await browser.execute(() =>
        (document.querySelector('[data-testid="lsp-pick-python-ty"]') as HTMLElement).click());
      await browser.waitUntil(async () => (await chosen()).python === "ty", {
        timeout: 5_000, timeoutMsg: "the pick was not remembered",
      });

      // The half that matters: what the app asks Rust for. `lsp_offer`
      // answers about the process that would ACTUALLY start, so a pick that
      // never reached it would leave the chip naming one server while another
      // ran (rule 1 in docs/lsp.md).
      const offered = await browser.execute(async () =>
        await window.__termic!.invoke("lsp_offer", {
          root: window.__termic!.useApp.getState().projects[0]?.root_path,
          language: "python",
          preferred: "ty",
        })) as { exe: string | null };
      // Only assert the shape: whether ty is installed is this machine's
      // business, and a spec that needs it installed is a spec that fails on
      // somebody else's laptop.
      expect(offered).toHaveProperty("exe");
    });

    it("goes back to Automatic", async () => {
      await openServers();
      await browser.execute(() =>
        (document.querySelector('[data-testid="lsp-pick-python-auto"]') as HTMLElement).click());
      await browser.waitUntil(async () => (await chosen()).python === undefined, {
        timeout: 5_000, timeoutMsg: "clearing the pick did not stick",
      });
    });

    it("runs a command of your own, ahead of everything termic ships", async () => {
      // The escape hatch: a server we do not ship (pyright, jedi, a wrapper
      // script). It is the reason the catalog can stay a closed set.
      await openServers();
      // A REAL focus/blur. React maps onBlur to `focusout`, so a synthetic
      // "blur" event reaches nothing; the field commits on blur rather than
      // per keystroke because each write stops the running server.
      await browser.execute(() => {
        const el = document.querySelector('[data-testid="lsp-command-python"]') as HTMLInputElement;
        el.focus();
        el.value = "pyright-langserver --stdio";
        el.blur();
      });
      await browser.waitUntil(async () => {
        const cmds = await browser.execute(() =>
          window.__termic!.usePrefs.getState().codeIntelCommands) as Record<string, string>;
        return cmds.python === "pyright-langserver --stdio";
      }, { timeout: 5_000, timeoutMsg: "the command was not remembered" });

      // And it reaches resolution: lsp_offer answers about the process that
      // would actually start, so the command has to come back as the exe.
      const offered = await browser.execute(async () =>
        await window.__termic!.invoke("lsp_offer", {
          root: window.__termic!.useApp.getState().projects[0]?.root_path,
          language: "python",
          custom: "/usr/bin/true --stdio",
        })) as { exe: string | null };
      expect(offered.exe).toBe("/usr/bin/true");

      // Clearing it goes back to the servers above.
      await browser.execute(() => {
        const el = document.querySelector('[data-testid="lsp-command-python"]') as HTMLInputElement;
        el.focus();
        el.value = "";
        el.blur();
      });
      await browser.waitUntil(async () => {
        const cmds = await browser.execute(() =>
          window.__termic!.usePrefs.getState().codeIntelCommands) as Record<string, string>;
        return cmds.python === undefined;
      }, { timeout: 5_000, timeoutMsg: "clearing the command did not stick" });
    });

    it("lets a project override what the machine is set to", async () => {
      // "This repo needs pyright" is a narrower statement than "on this
      // machine I like zuban", so it wins. Driven through the IPC rather than
      // the Repository page's form, which is a separate surface with its own
      // debounce: what this asserts is the precedence, not the form.
      const project = await browser.execute(() =>
        window.__termic!.useApp.getState().projects[0]) as any;
      await browser.execute(async (p) => {
        await window.__termic!.ipc.projectUpdate({ ...p, code_intel_servers: { python: "ty" } });
        await window.__termic!.useApp.getState().loadAll();
      }, project);

      await browser.execute(() =>
        window.__termic!.usePrefs.getState().setCodeIntelServer("python", "zuban"));
      const stored = await browser.execute(() =>
        window.__termic!.useApp.getState().projects[0]?.code_intel_servers) as Record<string, string>;
      expect(stored.python).toBe("ty");
      // The precedence itself is unit-tested (`serverChoice.test.ts`), which
      // is where it belongs: it is a pure function over these two records, and
      // driving it from here would test the same thing through a window.
      const machine = await browser.execute(() =>
        window.__termic!.usePrefs.getState().codeIntelServers) as Record<string, string>;
      expect(machine.python).toBe("zuban");

      await browser.execute(async (p) => {
        await window.__termic!.ipc.projectUpdate({ ...p, code_intel_servers: {} });
        await window.__termic!.useApp.getState().loadAll();
      }, project);
      await browser.execute(() =>
        window.__termic!.usePrefs.getState().setCodeIntelServer("python", null));
    });

    it("offers no choice for a language with only one server", async () => {
      // A radio group of one asks the reader to decide something already
      // decided. Rust and Go have exactly one server each.
      await openServers();
      const radios = await browser.execute(() =>
        document.querySelectorAll('[data-testid="lsp-catalog-rust"] input[type="radio"]').length);
      expect(radios).toBe(0);
    });
  });

  it("lists every page in band order", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("general"));
    await waitForText("Repos directory");

    const ids = await browser.execute(() =>
      [...document.querySelectorAll("[data-rail-item]")].map((b) =>
        b.getAttribute("data-rail-item"),
      ),
    );
    expect(ids).toEqual(pages.map(([id]) => id));
  });

  it("opens each page from the rail", async () => {
    for (const [, label, marker] of pages) {
      await clickRail(label);
      await waitForText(marker);
    }
    await snap("settings-rail.png");
  });

  // The version footer. It reads `useUpdate.currentVersion`, which resolves
  // asynchronously from `getVersion()` at boot, so the failure this catches is
  // a footer that renders "Termic " with nothing after it, or one pushed off
  // the bottom by a long project list.
  it("prints the running version at the foot of the rail", async () => {
    await waitForAppShell();
    // The store resolves it asynchronously, so wait for the text rather than
    // reading once. The regex is the assertion: "Termic " on its own is the
    // bug, and it is what an unresolved read renders.
    await browser.waitUntil(
      async () =>
        /^Termic \d+\.\d+\.\d+/.test(
          await browser.execute(
            () => document.querySelector('[data-testid="settings-version"]')?.textContent ?? "",
          ),
        ),
      { timeout: 8_000, timeoutMsg: "the settings rail never printed a version" },
    );
  });

  // The same action the command palette offers, on the row where the user is
  // already looking at their version number.
  it("checks for updates from the version row and reports the outcome", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("general"));
    await waitVisible('[data-testid="settings-check-updates"]');

    // Icon-only control: the accessible name is the only name it has, so it is
    // worth pinning. Losing it leaves a button nobody can identify.
    const label = await browser.execute(() =>
      document.querySelector('[data-testid="settings-check-updates"]')!.getAttribute("aria-label"));
    expect(label).toBe("Check for updates");

    await clickWhenVisible('[data-testid="settings-check-updates"]');

    // Every outcome reports: available, up to date, or the check failed. Which
    // one depends on what the updater can reach from this machine, so the
    // assertion is that the user is TOLD, not which answer they got. A silent
    // button is the regression worth catching.
    await browser.waitUntil(
      async () => {
        const txt = await browser.execute(() => document.body.innerText);
        return /Update available|You're up to date|Update check failed/.test(txt);
      },
      { timeout: 20_000, timeoutMsg: "checking for updates reported nothing to the user" },
    );

    // The spinner stops and the control comes back, so a second check is
    // possible without reopening settings.
    await browser.waitUntil(
      async () => !(await browser.execute(() =>
        (document.querySelector('[data-testid="settings-check-updates"]') as HTMLButtonElement).disabled)),
      { timeout: 20_000, timeoutMsg: "the check-for-updates button never re-enabled" },
    );

    // Let the toast go before handing the window to the next test. It is an
    // overlay, and an overlay left up is how an earlier spec breaks a later
    // one: the next case in this file waits on an agent row becoming VISIBLE,
    // and a toast sitting over it fails that while the row is perfectly
    // present. This case passed alone and took that one down in a full suite.
    await browser.waitUntil(
      async () => !(await browser.execute(() =>
        /Update available|You're up to date|Update check failed/.test(document.body.innerText))),
      { timeout: 20_000, timeoutMsg: "the update toast never cleared" },
    );
    await dismissOverlays();
  });

  // A rail entry whose tab id has no route in Settings.tsx renders an empty
  // pane: the click "works", the page is blank. Walk the rail from the DOM
  // (not a hard-coded list) so a future entry is covered the day it is added.
  it("routes every rail entry to a non-empty page", async () => {
    const ids: string[] = await browser.execute(() =>
      [...document.querySelectorAll("[data-rail-item]")].map(
        (b) => b.getAttribute("data-rail-item") as string,
      ),
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      await browser.execute((t) => {
        (document.querySelector(`[data-rail-item="${t}"]`) as HTMLElement).click();
      }, id);
      await browser.waitUntil(
        async () => ((await paneText()).trim().length ?? 0) > 40,
        { timeout: 8_000, timeoutMsg: `rail item "${id}" rendered an empty pane` },
      );
    }
  });

  // The CLI graduated in 0.26.0. Inverted rather than deleted: docs/ui.md ties
  // the badge to being off by default, so a badge reappearing next to a
  // setting we now ship enabled is a real contradiction to catch. The MCP
  // section sharing this page IS off by default and badged, so the check is
  // per-title (and the rail item), never page-wide text. The badge is
  // CSS-uppercased, so assertions read the node's textContent, not innerText.
  it("badges the MCP section, never the graduated CLI", async () => {
    await clickRail("CLI & MCP");
    await waitForText("Enable CLI");
    await waitForText("MCP endpoint");
    const titles: { title: string; badge: string | null }[] = await browser.execute(() =>
      [...document.querySelectorAll("h1")].map((h) => ({
        title: h.textContent ?? "",
        badge: h.parentElement?.querySelector("span")?.textContent ?? null,
      })),
    );
    expect(titles.find((t) => t.title === "MCP endpoint")?.badge).toBe("Experimental");
    expect(titles.find((t) => t.title === "Termic CLI")?.badge ?? null).toBe(null);
    const railText = await browser.execute(
      () => (document.querySelector('[data-rail-item="cli"]') as HTMLElement)?.textContent ?? "",
    );
    expect(railText.toLowerCase()).not.toContain("exp");
  });

  it("shows the live URL and registration commands that carry no secret", async () => {
    // The seeded profile enables the endpoint, so the section must show
    // the real bound URL (mcp_status reads the live handle) plus a
    // registration command per client.
    await clickRail("CLI & MCP");
    await waitForText("Connect a client");
    await browser.waitUntil(
      async () => (await paneText()).includes("http://127.0.0.1:"),
      { timeout: 8_000, timeoutMsg: "the bound MCP URL never rendered" },
    );
    const pane = await paneText();
    // One rule for both clients: a helper command that reads the token
    // file at connect time. A token is minted on every bind, so anything
    // that pasted the VALUE would stop working after a restart.
    expect(pane).toContain("[mcp_servers.termic]");      // codex, TOML
    expect(pane).toContain("claude mcp add-json");        // claude, its own CLI
    expect(pane).toContain("headersHelper");
    expect(pane).toContain("http_headers_helper");
    expect(pane).toContain("mcp_2026_07_28");
    expect(pane).not.toContain("--bearer-token-env-var");
    // And the one-click path exists, so the blocks are the fallback.
    expect(pane).toContain("Add to Codex");
    expect(pane).toContain("Add to Claude Code");
    expect(pane).toContain("claude mcp add");
    // One credential path for both clients: the custom header, which is
    // what lets codex's headers helper carry it at all (it refuses
    // Authorization as reserved).
    expect(pane).toContain("X-Termic-Token");
    // The shell setup reads the token file, so the file stays the one
    // durable copy.
    expect(pane).toContain("mcp-token");
    // And the token VALUE never renders, only its path (the copy
    // affordance fetches it straight to the clipboard).
    const token = readFileSync(path.join(dataDir, "mcp-token"), "utf8").trim();
    expect(pane).not.toContain(token);
  });

  it("documents that agents in tasks can drive the CLI", async () => {
    // Task PTYs carry TERMIC_CLI / TERMIC_TASK_ID (lib.rs), so an unsandboxed
    // agent can spawn sibling tasks. The page has to say so: it is the least
    // guessable thing the CLI does.
    await clickRail("CLI & MCP");
    await waitForText("Agents can drive it too");
    const pane = await paneText();
    expect(pane).toContain("$TERMIC_CLI");
    expect(pane).toContain("enforced sandbox");
  });

  it("lets the getting-started commands be selected for copying", async () => {
    // index.css turns selection off app-wide, so these copy-me commands have to
    // opt back in. Read off the command text, not the `data-selectable`
    // attribute, so only losing selectability fails.
    await clickRail("CLI & MCP");
    await waitForText("Getting started");
    const selectable = await browser.execute(() => {
      const cmd = [
        ...document.querySelectorAll('[data-testid="settings-pane"] span'),
      ].find((s) => s.textContent?.includes("fix the login redirect"));
      if (!cmd) throw new Error("no getting-started command line");
      // WKWebView only resolves the prefixed longhand.
      return getComputedStyle(cmd).getPropertyValue("-webkit-user-select");
    });
    expect(selectable).toBe("text");
  });

  it("keeps General short: task, sandbox and notification settings moved off it", async () => {
    await clickRail("General");
    await waitForText("Repos directory");
    const pane = await paneText();
    for (const gone of ["Branch prefix", "Desktop notifications", "Sandbox new tasks by default", "Enable CLI"]) {
      expect(pane).not.toContain(gone);
    }
  });

  // The language picker (i18n). Switching applies live through i18next, so
  // the assertions are on what the pane renders and on <html lang>, not on
  // the pref blob alone.
  describe("language picker", () => {
    after(async () => {
      // Leave the profile on "system" for every spec that follows in the
      // run: their markers ("Repos directory", rail labels) are English
      // copy, and the fixture box resolves system to English.
      await browser.execute(() => {
        window.__termic!.usePrefs.getState().setLanguage("system");
      });
    });

    it("switches the UI to Simplified Chinese and back, live", async () => {
      await waitForAppShell();
      await requireTermicApi();
      await browser.execute(() => window.__termic!.useApp.getState().openSettings("general"));
      await waitVisible('[data-testid="language-select"]');

      // Deterministic start: WKWebView localStorage outlives the throwaway
      // profile (it lives in the app container), so a previous run's pick
      // may still be there. "system" is the no-pick default and the state
      // the after() hook restores.
      await browser.execute(() => window.__termic!.usePrefs.getState().setLanguage("system"));
      const initial = await browser.execute(() =>
        (document.querySelector('[data-testid="language-select"]') as HTMLSelectElement).value);
      expect(initial).toBe("system");

      const pick = (v: string) =>
        browser.execute((val) => {
          const sel = document.querySelector('[data-testid="language-select"]') as HTMLSelectElement;
          sel.value = val;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }, v);

      await pick("zh-CN");
      // The picker's own block re-renders in Chinese, live, no reload.
      await waitForText("语言");
      expect(await browser.execute(() => document.documentElement.lang)).toBe("zh-CN");
      expect(await browser.execute(() => window.__termic!.usePrefs.getState().language)).toBe("zh-CN");
      await snap("settings-language-zh.png");

      await pick("en");
      await waitForText("Language");
      expect(await browser.execute(() => document.documentElement.lang)).toBe("en");
    });
  });

  it("rehomes task expand behavior to Appearance and copy on select to Agents & Terminals", async () => {
    await clickRail("Appearance");
    await clickAppearanceTab("interface");
    await waitForText("Task expand behavior");
    await clickRail("Agents & Terminals");
    await waitForText("Copy on select");
  });

  // Appearance carries three sub-tabs. Terminal leads (the embedded terminal
  // is the product), which is why the live preview is click-armed: see the
  // pty case below.
  it("splits Appearance into Terminal, Editor and Interface", async () => {
    await clickRail("Appearance");
    await waitForText("Terminal font");

    const ids = await browser.execute(() =>
      [...document.querySelectorAll("[data-appearance-tab]")].map((b) =>
        b.getAttribute("data-appearance-tab"),
      ),
    );
    expect(ids).toEqual(["terminal", "editor", "interface"]);

    // Landing tab is Terminal, and the editor controls are not on it.
    const terminalPane = await paneText();
    expect(terminalPane).toContain("Terminal scrollback");
    expect(terminalPane).not.toContain("Code ligatures");

    await clickAppearanceTab("editor");
    await waitForText("Code ligatures");
    const editorPane = await paneText();
    expect(editorPane).toContain("Editor font");
    expect(editorPane).not.toContain("Terminal scrollback");

    await clickAppearanceTab("interface");
    await waitForText("UI zoom");
    const interfacePane = await paneText();
    expect(interfacePane).toContain("Dim inactive split panes");
    expect(interfacePane).not.toContain("Terminal font");
  });

  // GH #312: off by default, since every row in the compact rail already
  // carries an instant Tip, so the overlay slide-in is a preference to
  // restore, not something the rail needs for icons to stay legible.
  it("gates the compact sidebar's hover reveal, off by default", async () => {
    const LABEL = "Hover to reveal the collapsed sidebar";
    let original: boolean | undefined;
    try {
      await clickRail("Appearance");
      await clickAppearanceTab("interface");
      await waitForText(LABEL);

      original = await browser.execute(
        () => window.__termic!.usePrefs.getState().sidebarHoverReveal,
      );
      expect(original).toBe(false);

      await clickToggleByLabel(LABEL);
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () => window.__termic!.usePrefs.getState().sidebarHoverReveal,
          )) === true,
        { timeout: 8_000, timeoutMsg: "sidebarHoverReveal pref never flipped on" },
      );
      expect(await ariaCheckedFor(LABEL)).toBe("true");
    } finally {
      if (original !== undefined) {
        await browser.execute((v) => {
          window.__termic!.usePrefs.getState().setSidebarHoverReveal(v);
        }, original);
      }
    }
  });

  // GH #140: the renderer control used to be hidden behind !IS_MAC, forcing
  // Mac users to hand-edit localStorage to escape WebGL. It is now a three-way
  // picker (webgl / canvas / dom) on every platform. The suite runs on macOS,
  // so asserting the control exists IS the regression guard for the exposure.
  //
  // Canvas is the case worth driving through the real <select>: it is the only
  // value the legacy boolean could not express, so a regression that dropped
  // the enum back to a toggle would still pass a webgl <-> dom test.
  it("exposes the three-way renderer picker on the Terminal tab and it lands in prefs", async () => {
    // Explicitly select the Terminal sub-tab: a click on the rail item is a
    // no-op when Appearance is already open, and the previous case leaves it
    // on Interface.
    await clickRail("Appearance");
    await clickAppearanceTab("terminal");
    await waitForText("Terminal renderer");

    const original = await browser.execute(
      () => window.__termic!.usePrefs.getState().terminalRenderer,
    );
    gpuOriginal = original;
    const pref = () =>
      browser.execute(() => window.__termic!.usePrefs.getState().terminalRenderer);

    // The finally puts the pref back through the setter even when an assertion
    // mid-case throws, so the next case (which asserts a canvas mounts in the
    // preview) never runs on the DOM renderer, which creates none.
    try {
      // All three values must be reachable from the control. Guards against a
      // regression that drops the picker back to a two-state toggle, which a
      // webgl <-> dom test alone would still pass.
      const options = await browser.execute(() =>
        [...document.querySelectorAll("[data-renderer]")].map(
          (b) => (b as HTMLElement).dataset.renderer,
        ),
      );
      expect(options).toEqual(["webgl", "canvas", "dom"]);

      // canvas: the value the legacy boolean could not express at all.
      await selectRendererByValue("canvas");
      await browser.waitUntil(async () => (await pref()) === "canvas", {
        timeout: 8_000,
        timeoutMsg: "terminalRenderer never became canvas",
      });
      // The legacy boolean is a second view of the same setting, so it has to
      // follow: a drift here means the toggle and the mounted renderer disagree.
      expect(
        await browser.execute(() => window.__termic!.usePrefs.getState().terminalGpuEnabled),
      ).toBe(false);

      // dom: the other non-default, and the one the old toggle's "off" meant.
      await selectRendererByValue("dom");
      await browser.waitUntil(async () => (await pref()) === "dom", {
        timeout: 8_000,
        timeoutMsg: "terminalRenderer never became dom",
      });
      expect(
        await browser.execute(() => window.__termic!.usePrefs.getState().terminalGpuEnabled),
      ).toBe(false);

      await selectRendererByValue("webgl");
      await browser.waitUntil(async () => (await pref()) === "webgl", {
        timeout: 8_000,
        timeoutMsg: "terminalRenderer never went back to webgl",
      });
      expect(
        await browser.execute(() => window.__termic!.usePrefs.getState().terminalGpuEnabled),
      ).toBe(true);
    } finally {
      await browser.execute((v) => {
        window.__termic!.usePrefs.getState().setTerminalRenderer(v);
      }, original);
    }
  });

  it("does not spawn the preview pty until the preview is armed", async () => {
    // TerminalPreview is a real AuxTerminal. Terminal being the landing tab
    // must not mean a settings visit forks a shell in $HOME, so a fresh open
    // shows the placeholder and mounts nothing.
    await clickRail("General");
    await clickRail("Appearance");
    await waitForText("Terminal font");
    const canvasesOnArrival = await browser.execute(
      () =>
        document.querySelectorAll('[data-testid="settings-pane"] canvas').length,
    );
    expect(canvasesOnArrival).toBe(0);

    await browser.execute(() => {
      const btn = document.querySelector('[data-testid="terminal-preview-start"]');
      if (!btn) throw new Error("preview placeholder missing on the landing tab");
      (btn as HTMLElement).click();
    });
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document.querySelectorAll('[data-testid="settings-pane"] canvas')
              .length,
        )) > 0,
      { timeout: 10_000, timeoutMsg: "terminal preview never mounted after arming" },
    );

    // Armed stays armed for this Appearance session: leaving and returning to
    // the tab mounts the preview straight away, no second click.
    await clickAppearanceTab("editor");
    await waitForText("Code ligatures");
    await clickAppearanceTab("terminal");
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document.querySelectorAll('[data-testid="settings-pane"] canvas')
              .length,
        )) > 0,
      { timeout: 10_000, timeoutMsg: "preview did not re-mount when armed" },
    );
    // Leave on Editor so the preview pty is torn down for the next case.
    await clickAppearanceTab("editor");
  });

  it("still deep-links the remote-images row on General", async () => {
    // The markdown preview's blocked-images banner opens Settings with this
    // highlight; the row has to be on the page the link targets.
    await browser.execute(() =>
      window.__termic!.useApp.getState().openSettings("general", undefined, "load-remote-images"),
    );
    await waitForText("Load remote images in markdown preview");
    const found = await browser.execute(
      () => !!document.getElementById("setting-load-remote-images"),
    );
    expect(found).toBe(true);
  });

  // The syntax theme is per app mode now (dark and light are separate prefs).
  // The rendered result is pinned in editor.e2e.ts; this is the control side:
  // Appearance -> Editor must offer BOTH selects, and each must write only its
  // own pref. A single-select regression fails on the second half.
  it("offers a dark and a light editor theme, each writing its own pref", async () => {
    await clickRail("Appearance");
    await clickAppearanceTab("editor");
    await waitForText("Editor theme (dark)");
    const pane = await paneText();
    expect(pane).toContain("Editor theme (dark)");
    expect(pane).toContain("Editor theme (light)");

    const before = await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      return { dark: p.editorThemeIdDark, light: p.editorThemeIdLight };
    });
    editorThemeOriginals = before;

    /** The <select> in the row whose label matches, driven through a real
     *  change event so React's onChange runs (setting .value alone does not). */
    const pickTheme = (label: string, id: string) =>
      browser.execute(
        (lbl, val) => {
          const labelEl = [
            ...document.querySelectorAll('[data-testid="settings-pane"] div'),
          ].find((d) => d.textContent?.trim() === lbl);
          const sel = labelEl
            ?.closest(".justify-between")
            ?.querySelector("select") as HTMLSelectElement | null;
          if (!sel) throw new Error("no select for: " + lbl);
          const setter = Object.getOwnPropertyDescriptor(
            HTMLSelectElement.prototype,
            "value",
          )!.set!;
          setter.call(sel, val);
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        },
        label,
        id,
      );

    await pickTheme("Editor theme (light)", "github-light");
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => window.__termic!.usePrefs.getState().editorThemeIdLight,
        )) === "github-light",
      { timeout: 8_000, timeoutMsg: "editorThemeIdLight never took" },
    );
    // The light pick must not have dragged the dark pref along with it.
    const darkAfterLight = await browser.execute(
      () => window.__termic!.usePrefs.getState().editorThemeIdDark,
    );
    expect(darkAfterLight).toBe(before.dark);

    await pickTheme("Editor theme (dark)", "github-dark");
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => window.__termic!.usePrefs.getState().editorThemeIdDark,
        )) === "github-dark",
      { timeout: 8_000, timeoutMsg: "editorThemeIdDark never took" },
    );
    const lightAfterDark = await browser.execute(
      () => window.__termic!.usePrefs.getState().editorThemeIdLight,
    );
    expect(lightAfterDark).toBe("github-light");
  });

  // WKWebView paints its own bevelled gradient over a <select> no matter what
  // background/border CSS the element carries, which read as a stray system
  // widget on the light theme's flat panels. The reset is a bare-element rule
  // in index.css, so it is one deletion away from coming back on every select
  // at once; assert it on every select the settings pane renders.
  it("strips the native chrome from every settings select", async () => {
    await clickRail("Appearance");
    await clickAppearanceTab("editor");
    await waitForText("Editor font");

    const selects = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="settings-pane"] select')].map(
        (s) => {
          const cs = getComputedStyle(s);
          return {
            appearance: cs.appearance,
            webkit: cs.webkitAppearance,
            image: cs.backgroundImage,
            padRight: parseFloat(cs.paddingRight),
          };
        },
      ),
    );
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) {
      expect(s.appearance).toBe("none");
      expect(s.webkit).toBe("none");
      // appearance:none drops the native arrow too, so the rule repaints one.
      expect(s.image).toContain("svg");
      // ...and the instance has to reserve room for it, or the longest option
      // label runs under the chevron. `pr-8` is 32px at 100% UI zoom; assert
      // the property (clears the 14px glyph + its 0.6em inset) not the class.
      expect(s.padRight).toBeGreaterThanOrEqual(24);
    }
    await snap("settings-select-chrome.png");
  });
});

// Getting INTO settings, and back out. Every entry point in the app funnels
// through openSettings (store/app.ts), and each one names a tab: a tab id that
// no longer routes anywhere opens a blank pane rather than failing loudly, so
// these cases exercise the payloads the real call sites send.
describe("settings navigation", () => {
  const paneText = () =>
    browser.execute(
      () =>
        (document.querySelector('[data-testid="settings-pane"]') as HTMLElement | null)
          ?.innerText ?? "",
    );
  const settingsOpen = () =>
    browser.execute(() => !!window.__termic!.useApp.getState().view.settingsOpen);

  after(async () => {
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("opens on General with no tab argument (gear, Cmd+comma, dashboard)", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await browser.execute(() => window.__termic!.useApp.getState().openSettings());
    await waitForText("Repos directory");
    expect(await settingsOpen()).toBe(true);
  });

  it("opens a project's settings from the rail's Projects list", async () => {
    const projectId = await browser.execute(
      () => window.__termic!.useApp.getState().projects[0]?.id,
    );
    await browser.execute(
      (id) => window.__termic!.useApp.getState().openSettings("repositories", id),
      projectId,
    );
    // Sub-tab label of a single-repo project; the page title is an editable
    // input, so its text is a value, not innerText.
    await waitForText("Scripts & run");
  });

  it("shows the empty state when a repositories link carries no project", async () => {
    await browser.execute(() =>
      window.__termic!.useApp.getState().openSettings("repositories"),
    );
    await waitForText("Pick a project on the left");
  });

  it("exposes one command-palette row per settings page", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await browser.execute(() => window.__termic!.useUI.getState().openCommandPalette());
    await waitVisible('input[placeholder*="Type a command"]', 8_000);
    await browser.execute(() => {
      const input = document.querySelector(
        'input[placeholder*="Type a command"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "settings");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The palette's deep links must keep pace with the rail: one row per page
    // (Prompts and Shortcuts are labelled without the word "settings", and the
    // per-project rows vary, so assert the ones that carry it).
    const labels: string[] = await browser.execute(() =>
      [...document.querySelectorAll("[data-row]")].map((r) => r.textContent ?? ""),
    );
    for (const needle of [
      "General settings",
      "Appearance settings",
      "Task settings",
      "Notification settings",
      "Sandbox settings",
      "CLI & MCP settings",
    ]) {
      expect(labels.some((l) => l.includes(needle))).toBe(true);
    }
    await browser.execute(() => window.__termic!.useUI.getState().closeCommandPalette?.());
  });

  it("closes and reopens on General", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("sandbox"));
    await waitForText("Global sandbox defaults");
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await browser.waitUntil(async () => (await settingsOpen()) === false, {
      timeout: 5_000,
      timeoutMsg: "settings never closed",
    });
    await browser.execute(() => window.__termic!.useApp.getState().openSettings());
    await waitForText("Repos directory");
    expect(await paneText()).not.toContain("Global sandbox defaults");
  });
});

// P2: preference setters persist to the prefs store. Cases: global default
// sandbox toggle, editor font, terminal font. Each restores its original.
describe("preferences", () => {
  const orig: Record<string, unknown> = {};
  const get = (k: string) =>
    browser.execute((key) => (window.__termic!.usePrefs.getState() as any)[key], k);

  after(async () => {
    await browser.execute((o) => {
      const p = window.__termic!.usePrefs.getState();
      if ("globalDefaultSandboxKind" in o)
        p.setGlobalDefaultSandboxKind(o.globalDefaultSandboxKind);
      if ("editorFontId" in o) p.setEditorFontId(o.editorFontId);
      if ("terminalFontId" in o) p.setTerminalFontId(o.terminalFontId);
    }, orig);
  });

  // Docker sandboxing turned this from a boolean into a three-way choice
  // (`globalDefaultSandboxKind`: a SandboxMode, or "docker"), so the pref a
  // new task inherits is now a KIND, not on/off. Flip to a value that is
  // never the current one so the assertion holds whatever it starts at.
  it("switches the global default sandbox kind", async () => {
    await waitForAppShell();
    await requireTermicApi();
    orig.globalDefaultSandboxKind = await get("globalDefaultSandboxKind");
    await browser.execute(
      (v) => window.__termic!.usePrefs.getState()
        .setGlobalDefaultSandboxKind(v === "off" ? "enforce" : "off"),
      orig.globalDefaultSandboxKind,
    );
    await browser.waitUntil(
      async () => (await get("globalDefaultSandboxKind")) !== orig.globalDefaultSandboxKind,
      { timeout: 5_000, timeoutMsg: "sandbox default never changed" },
    );
  });

  it("sets the editor font", async () => {
    orig.editorFontId = await get("editorFontId");
    await browser.execute(() =>
      window.__termic!.usePrefs.getState().setEditorFontId("jetbrains-mono"),
    );
    await browser.waitUntil(
      async () => (await get("editorFontId")) === "jetbrains-mono",
      { timeout: 5_000, timeoutMsg: "editor font never applied" },
    );
  });

  it("sets the terminal font", async () => {
    orig.terminalFontId = await get("terminalFontId");
    await browser.execute(() =>
      window.__termic!.usePrefs.getState().setTerminalFontId("jetbrains-mono"),
    );
    await browser.waitUntil(
      async () => (await get("terminalFontId")) === "jetbrains-mono",
      { timeout: 5_000, timeoutMsg: "terminal font never applied" },
    );
    await snap("prefs.png");
  });
});

// P1: the archive confirmation prefs. Unticking "Show this every time" in the
// archive dialog is otherwise a one-way door, so Settings → Tasks is the ONLY
// way back and both halves of the stored answer have to be visible and
// reversible there.
describe("archive confirmation settings", () => {
  const CONFIRM_LABEL = "Confirm before archiving a task";
  const BRANCH_LABEL = "Delete the branch when archiving";
  let orig: { confirm: boolean; deleteBranch: boolean } | undefined;

  const prefs = () =>
    browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      return { confirm: p.confirmBeforeArchiveTask, deleteBranch: p.archiveDeleteBranch };
    });

  const ariaChecked = (label: string) =>
    browser.execute((lbl) => {
      const labelEl = [...document.querySelectorAll("div")].find(
        (d) => d.textContent?.trim() === lbl,
      );
      return labelEl?.closest(".justify-between")
        ?.querySelector('[role="switch"]')?.getAttribute("aria-checked");
    }, label);

  after(async () => {
    // The profile is shared with every later spec; a leaked opt-out would make
    // their archives skip the dialog.
    if (orig) {
      await browser.execute((o) => {
        const p = window.__termic!.usePrefs.getState();
        p.setConfirmBeforeArchiveTask(o.confirm);
        p.setArchiveDeleteBranch(o.deleteBranch);
      }, orig);
    }
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("shows the branch toggle while the confirmation is on", async () => {
    await waitForAppShell();
    await requireTermicApi();
    orig = await prefs();

    await browser.execute(() => {
      window.__termic!.usePrefs.getState().setConfirmBeforeArchiveTask(true);
      window.__termic!.useApp.getState().openSettings("tasks");
    });
    await waitForText(CONFIRM_LABEL);
    // The branch toggle used to be hidden here. It seeds the dialog's checkbox
    // now, so hiding it left someone who deletes branches every time re-ticking
    // the box on every archive with no way to change the default.
    await waitForText(BRANCH_LABEL);
    expect(await ariaChecked(CONFIRM_LABEL)).toBe("true");
  });

  it("keeps the branch toggle when archiving stops asking", async () => {
    // The state the dialog's opt-out leaves behind.
    await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      p.setConfirmBeforeArchiveTask(false);
      p.setArchiveDeleteBranch(true);
    });
    await waitForText(BRANCH_LABEL);
    expect(await ariaChecked(CONFIRM_LABEL)).toBe("false");
    expect(await ariaChecked(BRANCH_LABEL)).toBe("true");
  });

  it("flips the remembered branch answer", async () => {
    const before = (await prefs()).deleteBranch;
    await clickToggleByLabel(BRANCH_LABEL);

    await browser.waitUntil(async () => (await prefs()).deleteBranch !== before,
      { timeout: 5_000, timeoutMsg: "archiveDeleteBranch never changed" });
    // Flipping one must not disturb the other: they answer different questions.
    expect((await prefs()).confirm).toBe(false);
    expect(await ariaChecked(BRANCH_LABEL)).toBe(String(!before));
    await snap("archive-settings.png");
  });

  it("turns the confirmation back on with the branch toggle still there", async () => {
    const branchBefore = (await prefs()).deleteBranch;
    await clickToggleByLabel(CONFIRM_LABEL);

    await browser.waitUntil(async () => (await prefs()).confirm === true,
      { timeout: 5_000, timeoutMsg: "confirmBeforeArchiveTask never came back on" });
    expect(await ariaChecked(CONFIRM_LABEL)).toBe("true");
    // Both stay reachable, and turning confirmation on does not silently
    // rewrite the branch answer the dialog is about to be seeded with.
    await waitForText(BRANCH_LABEL);
    expect(await ariaChecked(BRANCH_LABEL)).toBe(String(branchBefore));
  });
});

// P2: the branch-as-task-name toggle (GH #260). What the pref DOES is pinned
// in task.e2e.ts; what matters here is that Settings -> Tasks can reach it,
// since it is app-wide and the sidebar offers no other way in.
describe("task name source setting (GH #260)", () => {
  const LABEL = "Use the branch name as the task name";
  let original = false;

  const pref = () =>
    browser.execute(() => window.__termic!.usePrefs.getState().useBranchAsTaskName);

  after(async () => {
    // Shared profile: a leaked "on" would relabel every later spec's rows.
    await browser.execute((v) => {
      window.__termic!.usePrefs.getState().setUseBranchAsTaskName(v);
    }, original);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("ships off, next to the branch prefix it belongs with", async () => {
    await waitForAppShell();
    await requireTermicApi();
    original = await pref();
    await browser.execute((v) => {
      window.__termic!.usePrefs.getState().setUseBranchAsTaskName(v);
      window.__termic!.useApp.getState().openSettings("tasks");
    }, false);
    await waitForText(LABEL);
    await waitForText("Branch prefix");
    expect(await ariaCheckedFor(LABEL)).toBe("false");
  });

  it("turns on from the toggle and back off again", async () => {
    await clickToggleByLabel(LABEL);
    await browser.waitUntil(async () => (await pref()) === true,
      { timeout: 5_000, timeoutMsg: "useBranchAsTaskName never turned on" });
    expect(await ariaCheckedFor(LABEL)).toBe("true");

    await clickToggleByLabel(LABEL);
    await browser.waitUntil(async () => (await pref()) === false,
      { timeout: 5_000, timeoutMsg: "useBranchAsTaskName never turned back off" });
    expect(await ariaCheckedFor(LABEL)).toBe("false");
  });
});

// P1: per-task sandbox. Enable enforce mode then turn it off via taskSetSandbox
// (killLive=false so the running PTY isn't disrupted) and assert the task's
// sandbox mode follows.
describe("task sandbox", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) {
      await browser.execute(async (id) => {
        await window.__termic!.ipc.taskSetSandbox(id, "off", [], [], false);
        await window.__termic!.useApp.getState().loadAll();
      }, taskId);
      await archiveTask(taskId);
    }
  });

  const mode = () =>
    browser.execute(
      (id) =>
        window.__termic!.useApp
          .getState()
          .tasks.find((t: any) => t.id === id)?.sandbox_mode,
      taskId,
    );

  it("enables enforce mode", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-sandbox");
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskSetSandbox(id, "enforce", [], [], false);
      await window.__termic!.useApp.getState().loadAll();
    }, taskId);
    await browser.waitUntil(async () => (await mode()) === "enforce", {
      timeout: 8_000,
      timeoutMsg: "sandbox never became enforce",
    });
  });

  it("turns the sandbox off", async () => {
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskSetSandbox(id, "off", [], [], false);
      await window.__termic!.useApp.getState().loadAll();
    }, taskId);
    await browser.waitUntil(async () => (await mode()) === "off", {
      timeout: 8_000,
      timeoutMsg: "sandbox never turned off",
    });
    await snap("sandbox.png");
  });
});

// P1: the signal inspector (Settings → Agents & Terminals). Editing an agent's
// work-done patterns used to be guesswork — the strings you must match are OSC
// titles, termic consumes them, and nothing ever showed them to you. These
// cases drive the real panel: observed titles show up, unmatched ones are
// visible (they're the ones worth patterning), clicking + writes an ESCAPED
// pattern into the agent, and a labelled capture proposes a generalized one.
describe("agent signal inspector", () => {
  const AGENT = "fakeagent";
  /** fakeagent ships with claude-shaped signals, and other specs depend on
   *  them. Snapshot and restore rather than clearing: an earlier version of
   *  this teardown wiped them, which silently rewrote the shared .e2e profile
   *  and made the "adds a pattern" case pass locally (empty list) while
   *  failing on CI's fresh seed. Never leave the fixture altered. */
  let originalSignals: unknown;

  const clickRail = (label: string) =>
    browser.execute((l) => {
      const el = [
        ...document.querySelectorAll('[data-testid="settings-rail"] button'),
      ].find((b) => b.querySelector("span")?.textContent?.trim() === l);
      if (!el) throw new Error(`no rail item: ${l}`);
      (el as HTMLElement).click();
    }, label);

  /** Feed the buffer directly. The module is the same one TerminalPane calls
   *  on every OSC title, so this exercises the real path without needing a
   *  live agent to cooperate on a timer. */
  const feed = (titles: string[]) =>
    browser.execute((a, ts) => {
      const m = window.__termic!.signalLog;
      m.resetSignalLog(a);
      for (const t of ts) m.recordTitle(a, t, null);
    }, AGENT, titles);

  /** Text of the fakeagent card ONLY. Every agent card renders the same
   *  labels, so an unscoped read would happily pass on claude's panel. */
  const cardText = () =>
    browser.execute(
      (a) =>
        (document.querySelector(`[data-agent-card="${a}"]`) as HTMLElement | null)
          ?.innerText ?? "",
      AGENT,
    );

  /** Click a button by exact label, scoped to the fakeagent card. */
  const clickInCard = (label: string) =>
    browser.execute(
      (a, l) => {
        const card = document.querySelector(`[data-agent-card="${a}"]`);
        if (!card) throw new Error(`no card for ${a}`);
        const el = [...card.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === l,
        );
        if (!el) throw new Error(`no "${l}" button in the ${a} card`);
        (el as HTMLElement).click();
      },
      AGENT,
      label,
    );

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() => window.__termic!.useApp.getState().openSettings());
    originalSignals = await browser.execute(
      (a) =>
        window.__termic!.useApp
          .getState()
          .agents.find((ag: any) => ag.id === a)?.capabilities?.signals ?? null,
      AGENT,
    );
    await clickRail("Agents & Terminals");
    // The page is a pill strip plus the ACTIVE agent's card — only one card is
    // mounted at a time, so select fakeagent before touching anything.
    await browser.execute((a) => {
      const pill = document.querySelector(`[data-agent-id="${a}"]`) as HTMLElement | null;
      if (!pill) throw new Error(`no agent pill for ${a}`);
      pill.click();
    }, AGENT);
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          (a) => !!document.querySelector(`[data-agent-card="${a}"]`),
          AGENT,
        )) as boolean,
      { timeout: 8_000, timeoutMsg: "fakeagent card never mounted" },
    );
  });

  after(async () => {
    // The page debounces its write by 500ms and shows "Saved" once it lands.
    // Restoring before that fires gets undone by the pending save: the profile
    // then keeps the pattern these cases added, which is exactly the drift the
    // snapshot/restore above exists to prevent.
    await browser.waitUntil(
      () => browser.execute(() => document.body.innerText.includes("Saved")),
      { timeout: 8_000, timeoutMsg: "the agents page never confirmed its save" },
    );
    await browser.execute(async (a, orig) => {
      window.__termic!.signalLog.resetSignalLog(a);
      // Put the agent back EXACTLY as found (see originalSignals above).
      const app = window.__termic!.useApp.getState();
      const agents = app.agents.map((ag: any) =>
        ag.id === a ? { ...ag, capabilities: { ...ag.capabilities, signals: orig } } : ag);
      await window.__termic!.ipc.agentsSave(agents);
      await app.loadAll();
    }, AGENT, originalSignals);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("shows observed titles with counts, marked unmatched", async () => {
    await feed(["⠋ demo", "⠋ demo", "⠙ demo", "✳ demo", "Compiling project"]);
    await clickInCard("Show what this agent is emitting…");
    await browser.waitUntil(async () => (await cardText()).includes("⠋ demo"), {
      timeout: 8_000,
      timeoutMsg: "observed titles never rendered",
    });
    const text = await cardText();
    // The count is what makes a spinner readable at all: one row, not 50.
    expect(text).toContain("⠙ demo");
    expect(text).toContain("✳ demo");

    // Live match preview, read off data-live-class rather than the card's
    // text. The "+ Busy" / "+ Done" buttons on every row carry those exact
    // words, so a text assertion passes even when nothing classifies — which
    // is precisely how the first version of this case passed against a
    // profile whose patterns had been wiped.
    const classes = (await browser.execute(
      (a) =>
        [...document.querySelectorAll(`[data-agent-card="${a}"] [data-live-class]`)].map(
          (td) => [
            (td.parentElement as HTMLElement).innerText.split("\n")[0],
            (td as HTMLElement).dataset.liveClass,
          ],
        ),
      AGENT,
    )) as [string, string][];
    const classOf = (t: string) => classes.find(([title]) => title === t)?.[1];

    // fakeagent mirrors claude: spinner glyph = busy, ✳ = idle.
    expect(classOf("⠋ demo")).toBe("busy");
    expect(classOf("⠙ demo")).toBe("busy");
    expect(classOf("✳ demo")).toBe("idle");
    // A title matching neither. These are the rows worth patterning.
    expect(classOf("Compiling project")).toBe("none");
    expect(text).toContain("unmatched");
  });

  // The inspector exists to show what the agent ACTUALLY emitted, so a title
  // the layout swallows is worse than useless. Text assertions can't see CSS
  // truncation (innerText still holds the full string), so this reads the
  // rendered geometry: the column had collapsed to an ellipsis under
  // `max-w-0`, and every text-based assertion above sailed through it.
  it("shows the whole title, never an ellipsis", async () => {
    const cells = (await browser.execute(
      (a) =>
        [...document.querySelectorAll(`[data-agent-card="${a}"] [data-live-class]`)].map(
          (td) => {
            const cell = (td.parentElement as HTMLElement).firstElementChild as HTMLElement;
            return {
              text: cell.innerText.trim(),
              width: Math.round(cell.getBoundingClientRect().width),
              // > clientWidth means content is being clipped out of view.
              overflow: cell.scrollWidth - cell.clientWidth,
            };
          },
        ),
      AGENT,
    )) as { text: string; width: number; overflow: number }[];

    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.overflow).toBeLessThanOrEqual(1); // sub-pixel rounding only
      expect(c.width).toBeGreaterThan(80);
    }
    // ...and the titles themselves are still there, whole.
    expect(cells.some((c) => c.text === "Compiling project")).toBe(true);
  });

  it("offers a copy button per observed title", async () => {
    const copyButtons = await browser.execute(
      (a) =>
        [...document.querySelectorAll(`[data-agent-card="${a}"] button`)].filter(
          (b) => b.getAttribute("title") === "Copy this title",
        ).length,
      AGENT,
    );
    const rows = await browser.execute(
      (a) =>
        document.querySelectorAll(`[data-agent-card="${a}"] [data-live-class]`).length,
      AGENT,
    );
    expect(copyButtons).toBe(rows);
  });

  it("writes an ESCAPED pattern into the agent when a row is added", async () => {
    // A title full of regex metacharacters: inserting it raw would either fail
    // to compile or match something else entirely.
    await feed(["Working (2/3)... [x]"]);
    await browser.waitUntil(async () => (await cardText()).includes("Working (2/3)"), {
      timeout: 8_000,
      timeoutMsg: "metachar title never rendered",
    });
    await clickInCard("Busy");

    const busy = await browser.waitUntil(
      async () =>
        (await browser.execute(
          (a) =>
            window.__termic!.useApp
              .getState()
              .agents.find((ag: any) => ag.id === a)?.capabilities?.signals?.busy,
          AGENT,
        )) as string[] | undefined,
      { timeout: 8_000, timeoutMsg: "pattern never reached the agent" },
    );
    const added = "Working \\(2/3\\)\\.\\.\\. \\[x\\]";
    // APPENDED, not replacing: fakeagent ships with a busy pattern, and
    // clobbering a user's existing rules would be a real bug. Asserting the
    // whole array equals just the new entry is what hid this — it only held
    // because a prior teardown had emptied the list.
    expect(busy).toContain(added);
    expect(busy!.length).toBeGreaterThan(1);
    expect(busy![busy!.length - 1]).toBe(added);
    // It compiles, and it matches the exact title it came from.
    expect(new RegExp(added).test("Working (2/3)... [x]")).toBe(true);
  });

  it("proposes a generalized pattern from a captured turn", async () => {
    // Drive a full labelled turn through the same entry points TerminalPane
    // uses: start → submit → spinner frames → done with a resting title.
    await browser.execute((a) => {
      const m = window.__termic!.signalLog;
      m.resetSignalLog(a);
      m.startCapture(a);
      m.recordTitle(a, "✳ demo", null); // at rest, BEFORE the prompt
      m.noteSubmit(a);
      for (const g of ["⠋", "⠙", "⠹", "⠸"]) m.recordTitle(a, `${g} demo`, null);
      m.recordTitle(a, "✳ demo", null);
      m.noteDone(a, "✳ demo");
    }, AGENT);

    await browser.waitUntil(
      async () => (await cardText()).includes("Suggested from that turn"),
      { timeout: 8_000, timeoutMsg: "proposals never rendered" },
    );
    const text = await cardText();
    // The spinner class, not four literals.
    expect(text).toContain("covers the spinner");
    // And it explains what it threw away: the busy titles share "demo" with the
    // idle title, and busy > idle means saving that would wedge the agent as
    // permanently working. A silently missing suggestion reads as a bug.
    expect(text).toContain("Skipped");
    await snap("signal-inspector.png");
  });
});

// P1: default tasks path — Settings → Tasks decides where every project's task
// worktrees are created, and a project's own "Tasks path" overrides it. One
// rule at both levels: a FULL path (`/…`, `~/…`) is a fixed root that holds a
// folder per project, a RELATIVE path resolves inside each project's own
// directory. Cases assert where a created worktree actually LANDS on disk,
// plus the placeholder that tells the user before they create anything.
//
// Everything runs against a throwaway repo + throwaway roots under $TMPDIR, so
// the shared fixture-repo and the profile's real tasks tree are never touched.
describe("default tasks path", () => {
  let repoDir = "";        // throwaway git repo, added as a project
  let absRoot = "";        // throwaway absolute tasks root
  let projectId = "";
  let projectRoot = "";    // canonical: projectAdd resolves symlinks
  let projectDirName = "";
  let seededPath = "";     // whatever the profile carried in, restored in after()
  const createdTasks: string[] = [];

  /** Write the global default tasks path, preserving the rest of Settings
   *  (settings_save round-trips the whole object). */
  const setDefaultPath = (p: string) =>
    browser.execute(async (v) => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      await t.ipc.settingsSave({ ...s, default_tasks_path: v });
    }, p);

  /** Write the project's own override through the same command the Repository
   *  page debounces into. */
  const setProjectTasksPath = (value: string) =>
    browser.execute(async (id, v) => {
      const t = window.__termic!;
      const p = t.useApp.getState().projects.find((x: any) => x.id === id);
      await t.ipc.projectUpdate({ ...p, tasks_path: v });
      await t.useApp.getState().loadAll();
    }, projectId, value);

  /** Create a shell (token-free) worktree task and remember it for teardown. */
  const createTask = async (name: string) => {
    const task = await browser.execute(async (pid, n) => {
      const t = await window.__termic!.ipc.taskCreate({
        project_id: pid, name: n, cli: "shell", base_branch: "main",
      });
      await window.__termic!.useApp.getState().loadAll();
      return t;
    }, projectId, name);
    createdTasks.push((task as any).id);
    return task as any;
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    repoDir = mkdtempSync(path.join(os.tmpdir(), "e2e-wtloc-"));
    absRoot = mkdtempSync(path.join(os.tmpdir(), "e2e-wtroot-"));
    // `-b main` explicitly: the create calls below branch from "main", and a
    // host whose git defaults to `master` would otherwise fail the base ref.
    execSync(
      `git -C "${repoDir}" init -q -b main && git -C "${repoDir}" ` +
      `-c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
    const snapshot = await browser.execute(async (d) => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      const project = await t.ipc.projectAdd(d);
      await t.useApp.getState().loadAll();
      return { project, defaultPath: s.default_tasks_path ?? "" };
    }, repoDir);
    projectId = (snapshot as any).project.id;
    projectRoot = (snapshot as any).project.root_path;
    projectDirName = path.basename(projectRoot);
    seededPath = (snapshot as any).defaultPath;
  });

  after(async () => {
    for (const id of createdTasks) {
      await browser.execute(async (i) => {
        await window.__termic!.ipc.taskArchive(i, true); // deleteBranch
        await window.__termic!.useApp.getState().loadAll();
      }, id);
    }
    await setDefaultPath(seededPath);
    if (projectId) {
      await browser.execute(async (id) => {
        await window.__termic!.ipc.projectRemove(id);
        await window.__termic!.useApp.getState().loadAll();
      }, projectId);
    }
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(absRoot, { recursive: true, force: true });
  });

  // The setting is REQUIRED, so a loaded profile always carries a real value
  // rather than an empty "unset" the UI would have to paper over. Shape, not
  // an exact string: the app dir differs between the dev and release builds.
  it("ships a real default tasks path rather than an empty setting", () => {
    expect(seededPath).toMatch(/^~\/[^/]+\/tasks$/);
  });

  // Adding a project used to bake the resolved default into `tasks_path`,
  // which would pin every new project and make the global setting a no-op for
  // it. The field is an override now, so it starts empty and the project's
  // effective root is composed from the global value at read time.
  it("leaves a new project's tasks path empty so the global setting applies", async () => {
    const stored = await browser.execute(
      (id) => window.__termic!.useApp.getState().projects.find((p: any) => p.id === id)?.tasks_path,
      projectId,
    );
    expect(stored).toBe("");
    await setDefaultPath(absRoot);
    const derived = await browser.execute(
      (id) => window.__termic!.ipc.projectTasksPathDefault(id), projectId,
    );
    expect(derived).toBe(path.join(absRoot, projectDirName));
  });

  it("puts tasks under a full path, one folder per project", async () => {
    await setDefaultPath(absRoot);
    const task = await createTask("wtloc-abs");
    expect(task.path).toBe(path.join(absRoot, projectDirName, "wtloc-abs"));
    expect(existsSync(task.path)).toBe(true);
  });

  // The relative half of the rule: the path hangs off the repo itself and does
  // NOT get the project name appended (that would nest it twice).
  it("puts tasks inside the project directory for a relative path", async () => {
    await setDefaultPath("worktrees");
    const task = await createTask("wtloc-rel");
    expect(task.path).toBe(path.join(projectRoot, "worktrees", "wtloc-rel"));
    expect(existsSync(task.path)).toBe(true);
  });

  it("lets a project's own tasks path override the default", async () => {
    await setDefaultPath(absRoot);
    await setProjectTasksPath("mywt");
    const task = await createTask("wtloc-override");
    expect(task.path).toBe(path.join(projectRoot, "mywt", "wtloc-override"));
    expect(existsSync(task.path)).toBe(true);
    await setProjectTasksPath("");
  });

  // The per-project half: the field is EMPTY and shows the global-derived path
  // greyed out, so "no value here" still tells the user where tasks go.
  it("shows the default tasks path as the project field's placeholder", async () => {
    await setDefaultPath(absRoot);
    await setProjectTasksPath("");
    await browser.execute(
      (id) => window.__termic!.useApp.getState().openSettings("repositories", id), projectId,
    );
    await waitVisible('[data-repo-tab="advanced"]');
    await browser.execute(() =>
      (document.querySelector('[data-repo-tab="advanced"]') as HTMLElement).click(),
    );
    await waitVisible('[data-testid="project-tasks-path-input"]');
    // Poll: the placeholder arrives from an async IPC after the field mounts.
    await browser.waitUntil(
      () =>
        browser.execute(
          (want) =>
            (document.querySelector(
              '[data-testid="project-tasks-path-input"]',
            ) as HTMLInputElement).placeholder === want,
          path.join(absRoot, projectDirName),
        ),
      { timeout: 8_000, timeoutMsg: "tasks path placeholder never showed the default" },
    );
    const value = await browser.execute(
      () => (document.querySelector(
        '[data-testid="project-tasks-path-input"]',
      ) as HTMLInputElement).value,
    );
    expect(value).toBe("");
    await snap("default-tasks-path-placeholder.png");
  });

  // The per-project field autosaves (no Save button), so the guard has to be
  // in the debounced write, not a disabled control: typing a repo-swallowing
  // override must leave projects.json untouched, and recovering must resume
  // saving. Drives the real input, since the whole point is the save path.
  it("does not persist a repo-swallowing project override", async () => {
    await setProjectTasksPath("");
    await browser.execute(
      (id) => window.__termic!.useApp.getState().openSettings("repositories", id), projectId,
    );
    await waitVisible('[data-repo-tab="advanced"]');
    await browser.execute(() =>
      (document.querySelector('[data-repo-tab="advanced"]') as HTMLElement).click(),
    );
    await waitVisible('[data-testid="project-tasks-path-input"]');

    const typeOverride = (value: string) =>
      browser.execute((v) => {
        const input = document.querySelector(
          '[data-testid="project-tasks-path-input"]',
        ) as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value",
        )!.set!;
        setter.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    const stored = () =>
      browser.execute(
        (id) => window.__termic!.useApp.getState()
          .projects.find((p: any) => p.id === id)?.tasks_path ?? null,
        projectId,
      );

    await typeOverride(".");
    await waitVisible('[data-testid="project-tasks-path-conflict"]');
    // Inverted wait, not a sleep: the save debounce is 500ms, so if the guard
    // were absent this would resolve well inside the window. Timing out IS the
    // pass, and it stays bounded.
    await expect(
      browser.waitUntil(async () => (await stored()) === ".", { timeout: 2_500 }),
    ).rejects.toThrow();
    expect(await stored()).toBe("");

    // Recovering resumes the autosave, so the guard skips writes, not the form.
    await typeOverride("recovered-wt");
    await browser.waitUntil(async () => (await stored()) === "recovered-wt", {
      timeout: 8_000, timeoutMsg: "a valid override never resumed autosaving",
    });
    await setProjectTasksPath("");
  });

  // The global field itself: it carries a REAL value (not a placeholder), and
  // the preview under it flips between the two halves of the rule as you type.
  // Emptying it is a validation error, since the setting is required.
  it("previews where tasks go as the default tasks path is typed", async () => {
    await setDefaultPath(absRoot);
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("tasks"));
    await waitVisible('[data-testid="default-tasks-path-input"]');

    const field = () =>
      browser.execute(() => {
        const el = document.querySelector(
          '[data-testid="default-tasks-path-input"]',
        ) as HTMLInputElement;
        return { value: el.value, placeholder: el.placeholder };
      });
    const type = (value: string) =>
      browser.execute((v) => {
        const input = document.querySelector(
          '[data-testid="default-tasks-path-input"]',
        ) as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value",
        )!.set!;
        setter.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    const preview = () =>
      browser.execute(
        () => (document.querySelector(
          '[data-testid="default-tasks-path-preview"]',
        ) as HTMLElement | null)?.textContent ?? "",
      );
    const conflict = () =>
      browser.execute(
        () => (document.querySelector(
          '[data-testid="default-tasks-path-conflict"]',
        ) as HTMLElement | null)?.textContent ?? "",
      );
    /** The section's own save button, found by text so it can't collide with
     *  the other Save buttons on this page (symlink paths). */
    const saveDisabled = () =>
      browser.execute(() => {
        const btn = [...document.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === "Save tasks path",
        ) as HTMLButtonElement | undefined;
        if (!btn) throw new Error("no 'Save tasks path' button");
        return btn.disabled;
      });

    // The saved path is the field's VALUE. Nothing is hidden in a placeholder.
    const initial = (await field()) as { value: string; placeholder: string };
    expect(initial.value).toBe(absRoot);
    expect(initial.placeholder).toBe("");

    await type("/vol/work");
    await browser.waitUntil(async () => (await preview()) === "/vol/work/<project>/<task>", {
      timeout: 5_000, timeoutMsg: "absolute path preview never updated",
    });

    await type("worktrees");
    await browser.waitUntil(async () => (await preview()) === "<project>/worktrees/<task>", {
      timeout: 5_000, timeoutMsg: "relative path preview never updated",
    });

    // A path that would land on the repo itself is refused HERE, not deferred
    // to the next task create: the error names the projects and the save is
    // blocked. `.` resolves to every project's own root.
    await type(".");
    await browser.waitUntil(
      async () =>
        (await conflict()).includes("inside the repo itself") && (await saveDisabled()),
      { timeout: 8_000, timeoutMsg: "a repo-swallowing tasks path was not rejected on save" },
    );
    // ...and a good value clears it again. Deliberately NOT `absRoot`: that is
    // already the saved value, so the button would stay disabled for "nothing
    // to save" and the assertion could not tell that apart from "still blocked".
    await type(`${absRoot}/nested`);
    await browser.waitUntil(async () => (await conflict()) === "" && !(await saveDisabled()), {
      timeout: 8_000, timeoutMsg: "a valid tasks path stayed blocked",
    });

    // Required: emptying it drops the preview and blocks the save.
    await type("");
    await browser.waitUntil(
      async () => (await preview()) === "" && (await saveDisabled()),
      { timeout: 5_000, timeoutMsg: "an empty required path was still saveable" },
    );
    await snap("default-tasks-path-settings.png");
  });

  // GH #271: the task port range. The field is validated BEFORE it is saved,
  // because a bad range is silently ignored by the allocator (Rust falls back
  // to the default rather than leave the app unable to create a task), so a UI
  // that accepted one would have the user believe a range that is not in use.
  it("validates the task port range and persists a saved one", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("tasks"));
    await waitVisible('[data-testid="task-port-min-input"]');

    const type = (testid: string, value: string) =>
      browser.execute((id, v) => {
        const input = document.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value",
        )!.set!;
        setter.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, testid, value);
    const setRange = async (min: string, max: string) => {
      await type("task-port-min-input", min);
      await type("task-port-max-input", max);
    };
    const err = () =>
      browser.execute(
        () => (document.querySelector(
          '[data-testid="task-port-range-error"]',
        ) as HTMLElement | null)?.textContent ?? "",
      );
    const hint = () =>
      browser.execute(
        () => (document.querySelector(
          '[data-testid="task-port-range-hint"]',
        ) as HTMLElement | null)?.textContent ?? "",
      );
    const saveDisabled = () =>
      browser.execute(() => {
        const btn = [...document.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === "Save port range",
        ) as HTMLButtonElement | undefined;
        if (!btn) throw new Error("no 'Save port range' button");
        return btn.disabled;
      });
    const save = () =>
      browser.execute(() => {
        const btn = [...document.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === "Save port range",
        ) as HTMLButtonElement;
        btn.click();
      });
    const stored = () =>
      browser.execute(async () => {
        const s = await window.__termic!.invoke("settings_load") as
          { task_port_min?: number; task_port_max?: number };
        return [s.task_port_min ?? 0, s.task_port_max ?? 0];
      });

    // The field shows the range in force, not an empty box over a hidden
    // default: an unset pair reads as the 18100-65535 the allocator uses.
    const shown = await browser.execute(() => [
      (document.querySelector('[data-testid="task-port-min-input"]') as HTMLInputElement).value,
      (document.querySelector('[data-testid="task-port-max-input"]') as HTMLInputElement).value,
    ]);
    expect(shown).toEqual(["18100", "65535"]);

    // Each distinct mistake names itself, and each blocks the save.
    for (const [min, max, needle] of [
      ["80", "4000", "1024"],
      ["4000", "3000", "above the lowest"],
      ["3000", "3003", "at least 6 ports"],
    ] as const) {
      await setRange(min, max);
      await browser.waitUntil(
        async () => (await err()).includes(needle) && (await saveDisabled()),
        { timeout: 5_000, timeoutMsg: `port range ${min}-${max} was not rejected as "${needle}"` },
      );
    }

    // A valid range clears the error, and the hint says how many tasks fit.
    await setRange("3000", "4000");
    await browser.waitUntil(
      async () => (await err()) === "" && (await hint()).includes("166 tasks"),
      { timeout: 5_000, timeoutMsg: "a valid port range stayed rejected" },
    );
    await save();
    await browser.waitUntil(
      async () => {
        const [lo, hi] = await stored() as number[];
        return lo === 3000 && hi === 4000;
      },
      { timeout: 8_000, timeoutMsg: "the saved port range never reached settings.json" },
    );
    await snap("task-port-range-settings.png");

    // Put the default back: this profile is shared with every later spec, and
    // a 3000-4000 range would follow them into every task they create.
    await setRange("18100", "65535");
    await browser.waitUntil(async () => !(await saveDisabled()), {
      timeout: 5_000, timeoutMsg: "restoring the default range stayed blocked",
    });
    await save();
    await browser.waitUntil(
      async () => {
        const [lo, hi] = await stored() as number[];
        return lo === 18100 && hi === 65535;
      },
      { timeout: 8_000, timeoutMsg: "the default port range never went back" },
    );
  });
});

// P2: the two reorder drags inside Settings (pointer-based, see
// helpers.pointerDrag). Prompts reorder by their grip handle and persist to
// localStorage; agent pills reorder within their kind and persist through
// agentsSave. Both snapshot their order up front and put it back in teardown:
// this profile is shared with every other spec, and a drifted order outlives
// the run (see the signal-inspector note above).
// P2: how double-Shift is chosen. It is the one shortcut with no chord, so
// the Shortcuts page cannot offer to rebind it; what it offers instead is when
// the gesture applies, from off to either Shift anywhere.
describe("double-Shift mode", () => {
  const SELECT = '[data-testid="double-shift-mode"]';
  let original = "left";

  const pref = () =>
    browser.execute(() => window.__termic!.usePrefs.getState().doubleShiftMode);

  const choose = (mode: string) =>
    browser.execute((sel, m) => {
      const el = document.querySelector(sel) as HTMLSelectElement;
      const set = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype, "value")!.set!;
      set.call(el, m);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, SELECT, mode);

  after(async () => {
    await browser.execute((v) => {
      window.__termic!.usePrefs.getState().setDoubleShiftMode(v as any);
    }, original);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("sits on the double-Shift row, defaulting to the left Shift", async () => {
    await waitForAppShell();
    await requireTermicApi();
    original = await pref() as string;
    await browser.execute(() => {
      window.__termic!.usePrefs.getState().setDoubleShiftMode("left");
      window.__termic!.useApp.getState().openSettings("shortcuts");
    });
    await waitVisible(SELECT);
    // On the fixed row itself, not a block of its own somewhere else on the
    // page: that row is where a reader goes to ask about this gesture.
    expect(await browser.execute((sel) => {
      const el = document.querySelector(sel);
      return !!el?.closest('[data-testid="fixed-shortcut-row"]');
    }, SELECT)).toBe(true);
    expect(await browser.execute((sel) =>
      (document.querySelector(sel) as HTMLSelectElement).value, SELECT)).toBe("left");
  });

  it("offers exactly the four modes, each naming the whole gesture", async () => {
    const opts = await browser.execute((sel) =>
      [...(document.querySelector(sel) as HTMLSelectElement).options]
        .map(o => ({ value: o.value, label: o.textContent ?? "" })), SELECT);
    expect(opts.map(o => o.value)).toEqual(["off", "left", "outside-terminal", "any"]);
    // Every label except Off says which keys: the row prints no gesture of its
    // own beside the select, so an option reading "Left Shift only" would
    // leave "only what?" unanswered.
    expect(opts.map(o => o.label)).toEqual([
      "Off", "Double left Shift", "Double Shift, not in a terminal", "Double Shift",
    ]);
  });

  it("prints no second name for the gesture beside the select", async () => {
    // It used to read "Double tap, left" next to a select saying "Left Shift
    // only": the same gesture, named twice, in two vocabularies.
    const row = await browser.execute((sel) =>
      (document.querySelector(sel)?.closest('[data-testid="fixed-shortcut-row"]') as HTMLElement)
        ?.innerText ?? "", SELECT);
    expect(row).not.toContain("Double tap");
  });

  it("writes each choice to the pref", async () => {
    for (const mode of ["off", "any", "outside-terminal", "left"]) {
      await choose(mode);
      await browser.waitUntil(async () => (await pref()) === mode, {
        timeout: 5_000,
        timeoutMsg: `double-Shift mode never became ${mode}`,
      });
    }
  });
});

// P2: the per-project code navigation tab. It used to sit at the tail of
// Scripts & run, a tab about setup/run/archive scripts that also carries a
// personal/.termic.yaml storage strip the code-nav settings deliberately do
// not use. Its own tab is where it belongs, and the tab has to actually carry
// the controls rather than just exist.
describe("per-project code navigation tab", () => {
  let projectId!: string;

  const clickRepoTab = (id: string) =>
    browser.execute((t) => {
      const btn = document.querySelector(`[data-repo-tab="${t}"]`) as HTMLElement | null;
      if (!btn) throw new Error("no repo sub-tab: " + t);
      btn.click();
    }, id);

  const tabText = () =>
    browser.execute(() =>
      [...document.querySelectorAll("[data-repo-tab]")].map(b => b.textContent?.trim() ?? ""));

  /** Put the project's code-nav fields back to shipped defaults. The .e2e
   *  profile outlives the run, so a case that arms auto start leaves it armed
   *  for the NEXT run of this file (and for any later spec reading the same
   *  project), which is how this spec first failed on its own second run. */
  const resetCodeNav = () =>
    browser.execute(async (id) => {
      const app = window.__termic!.useApp.getState();
      const p = { ...app.projects.find((x: any) => x.id === id) } as any;
      p.code_intel_auto = "off";
      delete p.code_intel_languages;
      await window.__termic!.ipc.projectUpdate(p);
      await app.loadAll();
    }, projectId);

  after(async () => {
    if (projectId) await resetCodeNav();
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("offers the tab, named after the feature", async () => {
    await waitForAppShell();
    await requireTermicApi();
    projectId = await browser.execute(() =>
      window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo").id,
    ) as string;
    await resetCodeNav();
    await browser.execute(
      (id) => window.__termic!.useApp.getState().openSettings("repositories", id), projectId,
    );
    await waitVisible('[data-repo-tab="codenav"]');
    // The label follows lib/lsp/featureName.ts, which renames the whole
    // feature once diagnostics are on, so assert it is one of the two rather
    // than pinning whichever the profile happens to have set.
    const labels = await tabText();
    expect(labels.some(l => l === "Code navigation" || l === "Code intelligence")).toBe(true);
  });

  it("carries the arming modes under a heading of their own", async () => {
    await clickRepoTab("codenav");
    // The radios used to follow the language checkboxes with no heading at
    // all, leaving three hints to explain what was being chosen between.
    await waitForText("Auto start");
    const body = await browser.execute(() =>
      document.querySelector('[data-repo-tab="codenav"]')?.closest("div")?.parentElement?.textContent ?? "");
    for (const mode of ["Off", "Main checkout only", "Main checkout and worktrees"]) {
      expect(body).toContain(mode);
    }
  });

  // The languages belong to auto start: they say what runs WITHOUT being
  // asked, so with nothing running by itself there is nothing to narrow.
  it("shows the language list only once something starts automatically", async () => {
    await waitForTextGone("start on their own");
    await clickWhenVisible('[data-testid="code-nav-auto-main"]');
    await waitForText("start on their own");
  });

  // Going back to Off must not leave a stored list behind: it is off screen
  // from here on, and a list that outlives its own UI is state nothing on the
  // page can explain.
  it("drops a narrowed list when auto start goes back off", async () => {
    // Seed BOTH halves through the store rather than leaning on the previous
    // case's debounced save, which had not necessarily landed yet: a
    // projectUpdate built from a stale copy would have written its own value
    // straight back over it.
    await browser.execute(async (id) => {
      const app = window.__termic!.useApp.getState();
      const p = app.projects.find((x: any) => x.id === id);
      await window.__termic!.ipc.projectUpdate({
        ...p, code_intel_auto: "main", code_intel_languages: ["python"],
      });
      await app.loadAll();
    }, projectId);
    // Re-enter the tab so the form re-seeds from the store.
    await clickRepoTab("scripts");
    await clickRepoTab("codenav");
    await waitForText("start on their own");

    await clickWhenVisible('[data-testid="code-nav-auto-off"]');
    await browser.waitUntil(async () => !(await browser.execute(
      (id) => window.__termic!.useApp.getState().projects
        .find((x: any) => x.id === id)?.code_intel_languages?.length,
      projectId,
    )), { timeout: 8_000, timeoutMsg: "the narrowed list survived turning auto start off" });
    await waitForTextGone("start on their own");
  });

  it("no longer leaves any of it on the scripts tab", async () => {
    await clickRepoTab("scripts");
    await waitForTextGone("Auto start");
  });

  it("no longer leaves Spotlight on the scripts tab", async () => {
    await clickRepoTab("scripts");
    await waitForTextGone("Enable spotlight for this project");
  });
});

// Spotlight mirrors a task's git changes onto the main checkout, so it moved
// off Scripts & run (where the code-nav split had originally left it, per the
// regression this test used to guard) onto the Git tab, alongside the other
// git-workflow settings (branch/remote, PR merge behavior, comment watching).
describe("per-project Git tab", () => {
  let projectId!: string;

  const clickRepoTab = (id: string) =>
    browser.execute((t) => {
      const btn = document.querySelector(`[data-repo-tab="${t}"]`) as HTMLElement | null;
      if (!btn) throw new Error("no repo sub-tab: " + t);
      btn.click();
    }, id);

  after(async () => {
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("carries the git workflow settings and Spotlight, not the scripts tab", async () => {
    await waitForAppShell();
    await requireTermicApi();
    projectId = await browser.execute(() =>
      window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo").id,
    ) as string;
    await browser.execute(
      (id) => window.__termic!.useApp.getState().openSettings("repositories", id), projectId,
    );
    await waitVisible('[data-repo-tab="git"]');
    await clickRepoTab("git");
    for (const text of [
      "Branch new tasks from", "Remote", "When a pull request merges",
      "Watch PR comments", "Act on comments from", "Enable spotlight for this project",
    ]) {
      await waitForText(text);
    }
  });
});

describe("settings reorder drags", () => {
  after(async () => {
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  describe("prompt library", () => {
    let original: string[] = [];

    const domOrder = () =>
      browser.execute(
        () =>
          [...document.querySelectorAll("[data-prompt-id]")].map(
            (e) => (e as HTMLElement).dataset.promptId as string,
          ),
      );
    const grip = (id: string) => `[data-prompt-id="${id}"] [title="Drag to reorder"]`;

    before(async () => {
      await waitForAppShell();
      await requireTermicApi();
      await dismissOverlays();
      await browser.execute(() =>
        window.__termic!.useApp.getState().openSettings("prompts"),
      );
      await waitVisible("[data-prompt-id]");
      original = (await browser.execute(() =>
        window.__termic!.usePromptLibrary.getState().prompts.map((p: any) => p.id as string),
      )) as string[];
    });

    after(async () => {
      // Put the library back exactly as found (the order lives in the
      // profile's localStorage, so a drift would leak into later runs).
      await browser.execute((ids) => {
        // Re-read the store each pass: every reorder rewrites the list, so a
        // snapshot taken once would compute the second index against a list
        // that no longer exists.
        for (let to = 0; to < ids.length; to++) {
          const st = window.__termic!.usePromptLibrary.getState();
          const from = st.prompts.findIndex((p: any) => p.id === ids[to]);
          if (from !== to && from >= 0) st.reorderPrompts(from, to);
        }
      }, original);
    });

    it("reorders prompts by dragging the grip handle", async () => {
      const before = (await domOrder()) as string[];
      expect(before.length).toBeGreaterThan(1);

      // Carry the second prompt above the first.
      await pointerDrag(grip(before[1]), `[data-prompt-id="${before[0]}"]`, { land: "top" });
      await browser.waitUntil(
        async () => ((await domOrder()) as string[])[0] === before[1],
        { timeout: 8_000, timeoutMsg: "dragging the grip did not reorder the prompts" },
      );
      // A reorder, not a duplication or a drop.
      const after = (await domOrder()) as string[];
      expect(after.length).toBe(before.length);
      expect(after[1]).toBe(before[0]);
      // ...and it reached the store that persists it, not just the DOM.
      const stored = (await browser.execute(() =>
        window.__termic!.usePromptLibrary.getState().prompts.map((p: any) => p.id as string),
      )) as string[];
      expect(stored[0]).toBe(before[1]);
      await snap("prompt-reorder.png");
    });

    it("a grip click without movement leaves the order alone", async () => {
      const before = (await domOrder()) as string[];
      await browser.execute((sel) => {
        const el = document.querySelector(sel) as HTMLElement;
        const opts = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" } as any;
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
      }, grip(before[1]));
      expect(await domOrder()).toEqual(before);
    });
  });

  describe("agent pills", () => {
    let original: string[] = [];

    const agentIds = () =>
      browser.execute(() =>
        window
          .__termic!.useApp.getState()
          .agents.map((a: any) => a.id as string),
      );
    const pill = (id: string) => `[data-agent-id="${id}"]`;

    /** The page debounces its write by 500ms and shows "Saved" when it lands.
     *  Restoring before that fires would be undone by the pending save — which
     *  is how an earlier version of this spec left the shared profile with the
     *  pills still swapped. */
    const waitForSaved = () =>
      browser.waitUntil(
        () =>
          browser.execute(() =>
            document.body.innerText.includes("Saved"),
          ),
        { timeout: 8_000, timeoutMsg: "the agents page never confirmed its save" },
      );

    before(async () => {
      await waitForAppShell();
      await requireTermicApi();
      await dismissOverlays();
      await browser.execute(() =>
        window.__termic!.useApp.getState().openSettings("agents"),
      );
      await waitVisible('[data-agent-id][data-kind="agent"]');
      original = (await agentIds()) as string[];
    });

    after(async () => {
      // Restore the exact order and persist it, so the shared profile ends the
      // run byte-identical to how it started. The drag's own debounced save
      // must have landed first (see waitForSaved), or it would overwrite this.
      await browser.execute(async (ids) => {
        const app = window.__termic!.useApp.getState();
        const byId = new Map(app.agents.map((a: any) => [a.id, a]));
        const restored = ids.map((i) => byId.get(i)).filter(Boolean);
        // Keep anything that appeared since the snapshot rather than deleting
        // it — this file is shared, and a dropped agent would outlive the run.
        const extras = app.agents.filter((a: any) => !ids.includes(a.id));
        await window.__termic!.ipc.agentsSave([...restored, ...extras]);
        await window.__termic!.useApp.getState().loadAll();
      }, original);
    });

    it("reorders agent pills within their kind", async () => {
      const kindOrder = (await browser.execute(() =>
        [...document.querySelectorAll('[data-agent-id][data-kind="agent"]')].map(
          (e) => (e as HTMLElement).dataset.agentId as string,
        ),
      )) as string[];
      expect(kindOrder.length).toBeGreaterThan(1);

      // The strip is horizontal: to move left, land on the target's left edge.
      await pointerDrag(pill(kindOrder[1]), pill(kindOrder[0]), { land: "left" });
      await browser.waitUntil(
        async () => {
          const ids = (await agentIds()) as string[];
          return ids.indexOf(kindOrder[1]) < ids.indexOf(kindOrder[0]);
        },
        { timeout: 8_000, timeoutMsg: "dragging an agent pill did not reorder the strip" },
      );
      // Every agent is still there — a move, not a drop.
      expect(((await agentIds()) as string[]).slice().sort()).toEqual(original.slice().sort());
      // The reorder is persisted, not just in memory.
      await waitForSaved();
      await snap("agent-reorder.png");
    });
  });
});

// Every built-in agent ships as DATA (`default_agents()` in lib.rs) but needs
// two hand-written frontend pieces to look like itself: a `case` in
// `CliIcon` and an entry in `CLI_BRAND_COLOR`. Miss either and the agent still
// works, so nothing fails, it just draws the generic terminal chevron in an
// untinted grey. That is the exact seam a new built-in is added through, so
// this walks the registry rather than naming agents: adding one to Rust and
// forgetting its icon fails here.
describe("every built-in agent renders as itself", () => {
  const builtinIds = () =>
    browser.execute(() =>
      window.__termic!.useApp.getState().agents
        .filter((a: any) => a.builtin && (a.kind ?? "agent") === "agent")
        .map((a: any) => a.id as string),
    ) as Promise<string[]>;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    await browser.execute(() =>
      window.__termic!.useApp.getState().openSettings("agents"),
    );
    await waitVisible('[data-agent-id][data-kind="agent"]');
  });

  after(async () => {
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("gives each one a pill with its own brand mark, not the fallback glyph", async () => {
    const ids = await builtinIds();
    // The seeded profile's settings.json predates several built-ins, so this
    // also proves load_settings_inner still merges new ones in on upgrade
    // rather than only seeding them on a fresh install.
    expect(ids.length).toBeGreaterThan(1);

    const missing = (await browser.execute(
      (wanted: string[]) =>
        wanted.filter((id) => !document.querySelector(`[data-agent-id="${id}"]`)),
      ids,
    )) as string[];
    expect(missing).toEqual([]);

    // `data-cli-icon="fallback"` is set only by CliIcon's default branch, so
    // its presence inside a pill IS the missing-case bug.
    const fallbacks = (await browser.execute(
      (wanted: string[]) =>
        wanted.filter((id) => !!document.querySelector(
          `[data-agent-id="${id}"] [data-cli-icon="fallback"]`)),
      ids,
    )) as string[];
    expect(fallbacks).toEqual([]);

    // And the tint: an id with no CLI_BRAND_COLOR entry falls back to
    // fg-dim, which is what an unstyled brand icon looks like.
    const untinted = (await browser.execute(
      (wanted: string[]) =>
        wanted.filter((id) => {
          const el = document.querySelector(`[data-agent-id="${id}"] [data-icon-id]`);
          return !el || !(el as HTMLElement).className.includes(`--color-cli-${id}`);
        }),
      ids,
    )) as string[];
    expect(untinted).toEqual([]);
  });

  it("mounts the picked agent's card with the command it will actually spawn", async () => {
    const ids = await builtinIds();
    // Walk them all: only the ACTIVE agent's card is mounted, so a built-in
    // whose card throws on a field the others do not set is invisible until
    // someone clicks it.
    for (const id of ids) {
      await browser.execute((a) => {
        const p = document.querySelector(`[data-agent-id="${a}"]`) as HTMLElement | null;
        if (!p) throw new Error(`no agent pill for ${a}`);
        p.click();
      }, id);
      await browser.waitUntil(
        async () => (await browser.execute(
          (a) => !!document.querySelector(`[data-agent-card="${a}"]`), id,
        )) as boolean,
        { timeout: 8_000, timeoutMsg: `the ${id} card never mounted` },
      );
      // The card is the only place the spawn command is editable, so what it
      // must show is the registry's own value. Matched against the store
      // rather than a hardcoded string, so this stays true for an agent
      // whose display name and binary differ (Antigravity / `agy`).
      const shown = (await browser.execute((a) => {
        const app = window.__termic!.useApp.getState();
        const want = app.agents.find((x: any) => x.id === a)?.command ?? "";
        const card = document.querySelector(`[data-agent-card="${a}"]`) as HTMLElement | null;
        const values = [...(card?.querySelectorAll("input") ?? [])]
          .map((i) => (i as HTMLInputElement).value);
        return { want, hasCommandField: !!card?.innerText.includes("Command"), values };
      }, id)) as { want: string; hasCommandField: boolean; values: string[] };
      // Compared as objects carrying `id`, so a failure inside the loop says
      // WHICH built-in broke. A bare boolean assertion here reports only
      // "expected false to be true" and leaves you rerunning to find out.
      expect({ id, command: shown.want.length > 0 }).toEqual({ id, command: true });
      expect({ id, commandField: shown.hasCommandField }).toEqual({ id, commandField: true });
      expect({ id, shows: shown.values.includes(shown.want) })
        .toEqual({ id, shows: true });
    }
  });
});

// A project's Default CLI is a stored agent id, and the agent registry it
// names is edited on another page entirely (reordered, renamed, removed). The
// three tests here pin the contract between the two: the settings control
// shows what is SAVED (a <select> whose value matches no <option> gets
// silently re-pointed at the first one by React, which made the page claim a
// default the project was never set to), and a registry edit either leaves the
// saved value alone or carries it along.
describe("project default CLI vs the agent registry", () => {
  let projectId: string;
  let originalDefault = "";
  let originalAgents: string[] = [];

  const agentIds = () =>
    browser.execute(() =>
      window.__termic!.useApp.getState().agents.map((a: any) => a.id as string),
    ) as Promise<string[]>;

  const storedDefault = () =>
    browser.execute(
      (id) => window.__termic!.useApp.getState()
        .projects.find((p: any) => p.id === id)?.default_cli ?? null,
      projectId,
    ) as Promise<string | null>;

  const setDefault = (cli: string) =>
    browser.execute(async (id, value) => {
      const app = window.__termic!.useApp.getState();
      const p = app.projects.find((x: any) => x.id === id);
      await window.__termic!.ipc.projectUpdate({ ...p, default_cli: value });
      await window.__termic!.useApp.getState().loadAll();
    }, projectId, cli);

  /** Open the project page's More sub-tab, where Default CLI lives. */
  const openMore = async () => {
    await browser.execute(
      (id) => window.__termic!.useApp.getState().openSettings("repositories", id),
      projectId,
    );
    await waitVisible('[data-repo-tab="advanced"]');
    await clickWhenVisible('[data-repo-tab="advanced"]');
    await browser.waitUntil(
      async () => (await browser.execute(
        () => document.body.innerText.includes("Default CLI"),
      )) as boolean,
      { timeout: 8_000, timeoutMsg: "the More tab never rendered Default CLI" },
    );
  };

  /** The Default CLI <select> is the only one on the page offering "shell". */
  const cliSelect = () =>
    browser.execute(() => {
      const sel = [...document.querySelectorAll("select")].find(
        (s) => [...(s as HTMLSelectElement).options].some((o) => o.value === "shell"),
      ) as HTMLSelectElement | undefined;
      return sel
        ? { value: sel.value, label: sel.selectedOptions[0]?.textContent ?? "" }
        : null;
    }) as Promise<{ value: string; label: string } | null>;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    projectId = (await browser.execute(() =>
      window.__termic!.useApp.getState()
        .projects.find((p: any) => p.name === "fixture-repo").id as string,
    )) as string;
    originalDefault = (await storedDefault()) ?? "claude";
    originalAgents = await agentIds();
  });

  after(async () => {
    // Leave the project page on its landing sub-tab and shut the overlay:
    // RepositorySection keeps its sub-tab while the same project stays
    // selected, so a spec that opens this project next would otherwise find
    // itself on More instead of Scripts.
    await browser.execute(() => {
      (document.querySelector('[data-repo-tab="scripts"]') as HTMLElement | null)?.click();
      window.__termic!.useApp.getState().closeSettings();
    });
    // Shared profile: put both sides back, registry order included.
    await browser.execute(async (ids, id, def) => {
      const app = window.__termic!.useApp.getState();
      const byId = new Map(app.agents.map((a: any) => [a.id, a]));
      const restored = ids
        .filter((i: string) => !i.startsWith("rename"))
        .map((i: string) => byId.get(i))
        .filter(Boolean);
      await window.__termic!.ipc.agentsSave(restored);
      const p = window.__termic!.useApp.getState().projects.find((x: any) => x.id === id);
      await window.__termic!.ipc.projectUpdate({ ...p, default_cli: def });
      await window.__termic!.useApp.getState().loadAll();
    }, originalAgents, projectId, originalDefault);
  });

  it("shows the saved agent even when the registry no longer offers it", async () => {
    await setDefault("ghost-agent");
    await openMore();
    const sel = await cliSelect();
    expect(sel?.value).toBe("ghost-agent");
    expect(sel?.label).toContain("not in your agents list");
    // Reading the page must not have rewritten what it was reading.
    expect(await storedDefault()).toBe("ghost-agent");
  });

  it("keeps the saved default when the agent strip is reordered", async () => {
    const ids = await agentIds();
    const last = ids[ids.length - 1];
    await setDefault(last);

    await browser.execute(() => window.__termic!.useApp.getState().openSettings("agents"));
    await waitVisible('[data-agent-id][data-kind="agent"]');
    const strip = (await browser.execute(() =>
      [...document.querySelectorAll('[data-agent-id][data-kind="agent"]')].map(
        (e) => (e as HTMLElement).dataset.agentId as string,
      ),
    )) as string[];
    await pointerDrag(
      `[data-agent-id="${strip[strip.length - 1]}"]`,
      `[data-agent-id="${strip[0]}"]`,
      { land: "left" },
    );
    await browser.waitUntil(
      async () => (await agentIds())[0] === strip[strip.length - 1],
      { timeout: 8_000, timeoutMsg: "the drag never reordered the strip" },
    );

    expect(await storedDefault()).toBe(last);
    await openMore();
    expect((await cliSelect())?.value).toBe(last);
  });

  it("carries the default along when its agent is renamed", async () => {
    // A custom agent, since built-ins can't be renamed (their id is fixed).
    await browser.execute(async () => {
      const app = window.__termic!.useApp.getState();
      const fresh = {
        id: "rename-me", display_name: "Rename me", command: "true", args: [],
        icon_id: "lucide:terminal", color: "#9aa0a6", builtin: false,
        capabilities: { yolo_args: [], runtime_yolo_command: "" },
        sandbox_allowed_paths: [],
      };
      // Drop any leftover from an interrupted earlier run: the commit is a
      // no-op when the id it would mint is already taken, so a stray
      // "renamed-agent" in the shared profile would quietly pass this test.
      const keep = app.agents.filter((a: any) => !a.id.startsWith("rename"));
      await window.__termic!.ipc.agentsSave([...keep, fresh]);
      await window.__termic!.useApp.getState().loadAll();
    });
    await setDefault("rename-me");

    await browser.execute(() => window.__termic!.useApp.getState().openSettings("agents"));
    await waitVisible('[data-agent-id="rename-me"]');
    await clickWhenVisible('[data-agent-id="rename-me"]');
    await waitVisible('[data-agent-card="rename-me"] input');
    // The card's name input is what mints the id: type a new name, blur.
    await browser.execute(() => {
      const input = document.querySelector(
        '[data-agent-card="rename-me"] input',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value",
      )!.set!;
      setter.call(input, "Renamed agent");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Blur in a separate round trip: the commit reads the name off the
    // re-rendered card, so blurring inside the same tick as the input event
    // would commit the name the card still had. Focus immediately before it,
    // too: blur() fires nothing on an element that does not have focus.
    await browser.waitUntil(
      async () => (await browser.execute(() => (document.querySelector(
        '[data-agent-card="rename-me"] input',
      ) as HTMLInputElement | null)?.value === "Renamed agent")) as boolean,
      { timeout: 4_000, timeoutMsg: "the agent name input never took the new name" },
    );
    const blurred = await browser.execute(() => {
      const input = document.querySelector(
        '[data-agent-card="rename-me"] input',
      ) as HTMLInputElement;
      input.focus();
      const focused = document.activeElement === input;
      input.blur();
      return focused;
    });
    expect(blurred).toBe(true);

    // The registry keeps the new id (the repoint must not reload the page's
    // own un-saved edit out from under it) ...
    await browser.waitUntil(
      async () => ((await agentIds()) as string[]).includes("renamed-agent"),
      { timeout: 8_000, timeoutMsg: "the rename never reached the registry" },
    );
    // ... and the project that was pinned to the old id follows it.
    await browser.waitUntil(
      async () => (await storedDefault()) === "renamed-agent",
      { timeout: 8_000, timeoutMsg: "the project default did not follow the rename" },
    );
    // Let the page's own debounced write land before after() restores the
    // registry, or the pending save would put the renamed agent back on disk
    // for whatever spec runs next (the agent-pill spec above hit this too).
    await browser.waitUntil(
      async () => (await browser.execute(
        () => document.body.innerText.includes("Saved"),
      )) as boolean,
      { timeout: 8_000, timeoutMsg: "the agents page never confirmed its save" },
    );

    await openMore();
    const sel = await cliSelect();
    expect(sel?.value).toBe("renamed-agent");
    expect(sel?.label).toBe("Renamed agent");
  });
});

// Extra named ports (GH #196): the Repo Settings field writes the personal
// (projects.json) list — the fixture repo has no .termic.yaml, so the
// storage target auto-defaults to Personal — and flags invalid/reserved
// names inline. Port ALLOCATION from this list is covered in task.e2e.ts.
describe("extra named ports settings", () => {
  let projectId: string;

  const typePorts = (value: string) =>
    browser.execute((v) => {
      const input = document.querySelector(
        '[data-testid="extra-named-ports-input"]',
      ) as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value",
      )!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  const stored = () =>
    browser.execute(
      (id) => window.__termic!.useApp.getState()
        .projects.find((p: any) => p.id === id)?.extra_named_ports ?? null,
      projectId,
    );

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    projectId = await browser.execute(() =>
      window.__termic!.useApp.getState()
        .projects.find((p: any) => p.name === "fixture-repo").id as string,
    );
  });

  after(async () => {
    // Reset the personal list so later spec files see a clean project.
    await browser.execute(async (id) => {
      const t = window.__termic!;
      const p = t.useApp.getState().projects.find((x: any) => x.id === id);
      await t.ipc.projectUpdate({ ...p, extra_named_ports: [] });
      await t.useApp.getState().loadAll();
    }, projectId);
  });

  it("persists typed names to the personal list", async () => {
    await browser.execute(
      (id) => window.__termic!.useApp.getState().openSettings("repositories", id),
      projectId,
    );
    await waitVisible('[data-testid="extra-named-ports-input"]');
    await typePorts("API_PORT\nDB_PORT");
    // The field autosaves (500ms debounce) into projects.json.
    await browser.waitUntil(
      async () => JSON.stringify(await stored()) === JSON.stringify(["API_PORT", "DB_PORT"]),
      { timeout: 8_000, timeoutMsg: "typed port names never autosaved to the project" },
    );
    await snap("extra-named-ports.png");
  });

  it("warns on invalid and reserved names and keeps them out of the saved list", async () => {
    await typePorts("API_PORT\n2BAD\nPATH");
    await waitVisible('[data-testid="extra-named-ports-warning"]');
    const warning = await browser.execute(
      () => document.querySelector('[data-testid="extra-named-ports-warning"]')!.textContent,
    );
    expect(warning).toContain("2BAD");
    expect(warning).toContain("PATH");
    // The raw lines still save (the freeze at task create drops them);
    // the warning is the user-facing signal. Valid name stays present.
    await browser.waitUntil(
      async () => ((await stored()) ?? []).includes("API_PORT"),
      { timeout: 8_000, timeoutMsg: "valid name missing from the saved list" },
    );
    await snap("extra-named-ports-warning.png");
  });
});

// Which browser opens preview URLs and terminal links (GH #245).
//
// The e2e binary RECORDS the argv instead of launching anything (see
// `open_external_url` / `open_url_default` in lib.rs): a suite that actually
// opened Chrome would put a browser window over the window under test on every
// run, and on CI there is no browser to open. The log is therefore the only
// surface that can show which browser was chosen — the visible outcome of this
// feature happens outside the app.
//
// `<default>` in the log means the OS-default path, i.e. the byte-identical
// code path that shipped before this setting existed.
describe("preview browser (GH #245)", () => {
  const browserLog = path.join(process.cwd(), ".e2e", "profile", "e2e-browser.log");
  const URL_WITH_QUERY = "http://localhost:4173/?a=1&b=2";
  let projectId!: string;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    projectId = await browser.execute(
      () => window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo").id,
    );
    // Close Settings before touching the project. RepositorySection holds a
    // DRAFT of the whole project and debounce-saves it; left mounted from an
    // earlier describe, that pending write lands on top of the project this
    // spec just wrote and silently reverts preview_browser. It presented as
    // "the project override is ignored" on roughly one run in three.
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  after(async () => {
    rmSync(browserLog, { force: true });
    // Leave the profile as we found it: the global setting is shared with
    // every later spec file, and a stray browser command would redirect
    // their link opens too.
    await browser.execute(async () => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      await t.ipc.settingsSave({ ...s, preview_browser: "" });
      t.useApp.setState({ previewBrowser: "" });
    });
    await setProjectBrowser(undefined);
    // Close the Settings overlay this describe opened. The window is REUSED
    // across spec files, and an overlay left up covers the drop point of
    // every pointer drag in the next file: tabs-layout lost 8 tests to it,
    // none of which mention settings or browsers. See the e2e skill, "Drags".
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await dismissOverlays();
  });

  /** Recorded opens, newest last. Missing file = nothing opened yet. */
  const opens = async (): Promise<string[][]> => {
    try {
      return readFileSync(browserLog, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const clearLog = () => rmSync(browserLog, { force: true });

  /** The argv of the most recent open, waited for rather than slept on. The
   *  LAST line, not the first: an open from the previous case can still be
   *  landing when this one clears the log, and reading [0] would then assert
   *  against the wrong case's argv. */
  const nextOpen = async (): Promise<string[]> => {
    await browser.waitUntil(async () => (await opens()).length > 0, {
      timeout: 8_000, timeoutMsg: "nothing was recorded as opened",
    });
    const all = await opens();
    return all[all.length - 1];
  };

  const setGlobalBrowser = (cmd: string) =>
    browser.execute(async (c) => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      await t.ipc.settingsSave({ ...s, preview_browser: c });
      t.useApp.setState({ previewBrowser: c });
    }, cmd);

  const setProjectBrowser = (cmd: string | undefined) =>
    browser.execute(async (id, c, unset) => {
      const t = window.__termic!;
      const proj = t.useApp.getState().projects.find((p: any) => p.id === id);
      const next = { ...proj };
      if (unset) delete next.preview_browser; else next.preview_browser = c;
      await t.ipc.projectUpdate(next);
      await t.useApp.getState().loadAll();
    }, projectId, cmd ?? "", cmd === undefined).then(async () => {
      // Confirm the value survived. See the closeSettings note above: a
      // clobbered write is invisible until an assertion fails much later.
      await browser.waitUntil(async () => {
        const got = await browser.execute(
          (id) => window.__termic!.useApp.getState().projects.find((p: any) => p.id === id)?.preview_browser,
          projectId,
        );
        return cmd === undefined ? got === undefined || got === null : got === cmd;
      }, { timeout: 5_000, timeoutMsg: `project preview_browser never became ${JSON.stringify(cmd)}` });
    });

  /** Open a URL through the very helper both preview buttons and the two
   *  terminal link openers delegate to, so this exercises the real resolution
   *  path rather than a spec-local reimplementation of it. */
  const openThroughApp = (url: string) =>
    browser.execute(async (id, u) => {
      const t = window.__termic!;
      const st = t.useApp.getState();
      const proj = st.projects.find((p: any) => p.id === id);
      await t.previewBrowser.openWebUrlForProject(u, st.previewBrowser, proj);
    }, projectId, url);

  it("uses the OS default when no browser is configured", async () => {
    await setGlobalBrowser("");
    await setProjectBrowser(undefined);
    clearLog();
    await openThroughApp(URL_WITH_QUERY);
    expect(await nextOpen()).toEqual(["<default>", URL_WITH_QUERY]);
  });

  it("uses the app-wide browser command, with the URL appended", async () => {
    await setGlobalBrowser('open -a "Google Chrome"');
    await setProjectBrowser(undefined);
    clearLog();
    await openThroughApp(URL_WITH_QUERY);
    // Three argv entries: the quoted app name stays ONE argument, and the
    // query string is not split on its `&`.
    expect(await nextOpen()).toEqual(["open", "-a", "Google Chrome", URL_WITH_QUERY]);
  });

  it("lets a project override the app-wide browser", async () => {
    await setGlobalBrowser('open -a "Google Chrome"');
    await setProjectBrowser("firefox -P work");
    clearLog();
    await openThroughApp(URL_WITH_QUERY);
    expect(await nextOpen()).toEqual(["firefox", "-P", "work", URL_WITH_QUERY]);
  });

  it("lets a project force the OS default despite an app-wide browser", async () => {
    // The state a plain string could not express: empty on the project means
    // "system default here", NOT "inherit the global".
    await setGlobalBrowser('open -a "Google Chrome"');
    await setProjectBrowser("");
    clearLog();
    await openThroughApp(URL_WITH_QUERY);
    expect(await nextOpen()).toEqual(["<default>", URL_WITH_QUERY]);
  });

  it("falls back to the OS default rather than leaving the link dead", async () => {
    // An unparseable template (unterminated quote). A link that silently does
    // nothing is the exact complaint this feature exists to fix, so a broken
    // command must still open the page somewhere.
    await setGlobalBrowser('open -a "Google Chrome');
    await setProjectBrowser(undefined);
    clearLog();
    await openThroughApp(URL_WITH_QUERY);
    expect(await nextOpen()).toEqual(["<default>", URL_WITH_QUERY]);
  });

  it("substitutes {url} instead of appending it", async () => {
    await setGlobalBrowser("mybrowser {url} --tail");
    await setProjectBrowser(undefined);
    clearLog();
    await openThroughApp(URL_WITH_QUERY);
    expect(await nextOpen()).toEqual(["mybrowser", URL_WITH_QUERY, "--tail"]);
  });

  it("saves a browser command from the General settings page", async () => {
    await setGlobalBrowser("");
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("general"));
    await waitVisible('[data-testid="general-browser-input"]');
    await browser.execute(() => {
      const el = document.querySelector('[data-testid="general-browser-input"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, "open -a Safari");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickWhenVisible('[data-testid="general-browser-save"]');
    // Persisted to settings.json...
    await browser.waitUntil(
      async () => (await browser.execute(async () =>
        (await window.__termic!.ipc.settingsLoad()).preview_browser)) === "open -a Safari",
      { timeout: 8_000, timeoutMsg: "the browser command never reached settings.json" },
    );
    // ...and written through to the store, which is what terminal link
    // clicks read. Without this an open tab keeps using the old browser
    // until the app restarts.
    expect(await browser.execute(() => window.__termic!.useApp.getState().previewBrowser))
      .toBe("open -a Safari");
    await snap("preview-browser-general.png");
  });

  it("rejects a launcher that is not installed", async () => {
    await browser.execute(() => {
      const el = document.querySelector('[data-testid="general-browser-input"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, "termic-no-such-browser-xyz");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Debounced validation (400ms), waited for as a condition.
    await waitVisible('[data-testid="general-browser-error"]');
    const msg = await browser.execute(
      () => document.querySelector('[data-testid="general-browser-error"]')!.textContent,
    );
    expect(msg).toContain("termic-no-such-browser-xyz");
    await snap("preview-browser-invalid.png");
  });
});

// Docker Sandbox → Command preview.
//
// The task sandbox dialog has had a per-task preview since Docker mode
// shipped; this is the same answer while you are still CONFIGURING the image,
// before any task is on Docker. It matters because it is rendered by Rust
// through the very `build_spec` / `render_argv` a real spawn uses, against a
// placeholder task, so it cannot drift into a comforting fiction. The agent's
// own command is appended, so the tail of the argv is what runs in the
// container.
//
// Needs no Docker daemon: an unbuilt image renders as a placeholder tag and
// everything else (mounts, env, hardening flags) is computed, not probed.
describe("docker command preview", () => {
  let wasEnabled: boolean | null = null;

  const setEnabled = (v: boolean) => browser.execute(async (on) => {
    const t = window.__termic!;
    const s = await t.ipc.settingsLoad();
    await t.ipc.settingsSave({ ...s, docker_sandbox_enabled: on });
  }, v);

  after(async () => {
    // Restore the fixture: leaving Docker on would put Docker UI in front of
    // every later spec that opens a sandbox dialog.
    if (wasEnabled !== null) await setEnabled(wasEnabled);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("renders the real docker run argv, agent command included", async () => {
    await waitForAppShell();
    await requireTermicApi();
    wasEnabled = await browser.execute(async () =>
      (await window.__termic!.ipc.settingsLoad()).docker_sandbox_enabled ?? false) as boolean;
    await setEnabled(true);

    await browser.execute(() => window.__termic!.useApp.getState().openSettings("docker"));
    await waitForText("Enable Docker sandbox");
    // By test id, not text: the toggle's textContent carries its hint line
    // too, so an exact-text match never hits it.
    await clickWhenVisible('[data-testid="docker-preview-toggle"]');

    const argv = await browser.waitUntil(async () => {
      const t = await browser.execute(() =>
        document.querySelector('[data-testid="docker-preview-argv"]')?.textContent ?? "");
      return t && t.trim() ? t : false;
    }, { timeoutMsg: "the command preview never rendered" }) as string;

    // The shape a reader is checking for: it is a `docker run`, the container
    // is hardened, and the agent's own command is on the end. Asserting the
    // whole argv would pin every flag and break on any unrelated addition.
    expect(argv).toContain("docker");
    expect(argv).toContain("run");
    expect(argv).toContain("--cap-drop");
    // The placeholder worktree, proving this is the task-less variant rather
    // than a real task's paths leaking into a settings page.
    expect(argv).toContain("/path/to/your/task-worktree");
  });

  it("mounts the Dockerfile editor only while its section is open", async () => {
    // Collapsed by default, and not merely hidden: CodeMirror plus a dynamic
    // import of the dockerfile grammar used to mount on every visit to this
    // page for a section most visits never open. The reopen half matters as
    // much as the collapse - the init effect bails when a view already
    // exists, so a destroy that did not clear the ref would leave the second
    // open with an empty box and no way back short of leaving the page.
    const editors = () => browser.execute(() =>
      document.querySelectorAll(".cm-content").length);
    expect(await editors()).toBe(0);

    // One control, in the Image row: it answers "is this still the shipped
    // file?" and opens the editor directly underneath. There used to be a
    // second toggle in a section further down, which is exactly the split
    // this replaced.
    await clickWhenVisible('[data-testid="docker-dockerfile-status"]');
    await browser.waitUntil(async () => (await editors()) > 0,
      { timeoutMsg: "the Dockerfile editor never mounted after expanding" });
    // Its real content, not an empty box swapped in a tick later.
    const text = await browser.execute(() =>
      document.querySelector(".cm-content")?.textContent ?? "");
    expect(text).toContain("FROM");

    await clickWhenVisible('[data-testid="docker-dockerfile-status"]');
    await browser.waitUntil(async () => (await editors()) === 0,
      { timeoutMsg: "the editor stayed mounted after collapsing" });

    await clickWhenVisible('[data-testid="docker-dockerfile-status"]');
    await browser.waitUntil(async () => (await editors()) > 0,
      { timeoutMsg: "the editor did not come back on a second open" });
    await clickWhenVisible('[data-testid="docker-dockerfile-status"]');
  });

  it("wires the shared gh / glab login into every container", async () => {
    // The forge CLIs are only useful if their config dir survives `--rm`,
    // and the preview is the one place that claim is checkable without
    // running a container. Asserted through the real argv rather than the
    // Rust unit test alone, because the mount has to reach the spawn path,
    // not just build_spec.
    const argv = await browser.execute(() =>
      document.querySelector('[data-testid="docker-preview-argv"]')?.textContent ?? "");
    expect(argv).toContain("/root/.config/gh");
    expect(argv).toContain("/root/.config/glab-cli");
    expect(argv).toContain("GH_CONFIG_DIR=/root/.config/gh");
    expect(argv).toContain("GLAB_CONFIG_DIR=/root/.config/glab-cli");
    // Shared, not per-agent: the host side is docker-forge, never the
    // docker-agents/<agent> tree the config-dir mounts use.
    expect(argv).toContain("docker-forge");
    // And never the user's own gh login, which on macOS is a Keychain entry
    // anyway (so the mount would hand the container an unauthenticated gh)
    // and which Seatbelt hard-denies.
    expect(argv).not.toContain("/.config/gh:/root/.config/gh");
  });

  it("re-renders for the agent picked, not just the first one", async () => {
    const agents = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="docker-preview-agent"] option')]
        .map(o => (o as HTMLOptionElement).value)
        .filter(Boolean));
    // Nothing to switch between on a profile with a single agent; the
    // picker's own behaviour is what this case exists for.
    if (agents.length < 1) return;

    const first = await browser.execute(() =>
      document.querySelector('[data-testid="docker-preview-argv"]')?.textContent ?? "");
    await browser.execute((id) => {
      const sel = document.querySelector('[data-testid="docker-preview-agent"]') as HTMLSelectElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
      setter.call(sel, id);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, agents[agents.length - 1]);

    // Either the argv changes (different agent command / config mount) or it
    // legitimately matches; what must NOT happen is the panel going blank.
    await browser.waitUntil(async () => {
      const t = await browser.execute(() =>
        document.querySelector('[data-testid="docker-preview-argv"]')?.textContent ?? "");
      return !!t && t.trim().length > 0;
    }, { timeoutMsg: "the preview blanked after switching agent" });

    expect(first.trim().length).toBeGreaterThan(0);
  });
});


// Agent hooks (#269): the one place termic writes into a file the USER owns.
// The install/remove round trip is asserted against the file on disk, because
// a writer that eats someone's hand-written hooks is the failure that matters
// and no badge would show it.
//
// `TERMIC_E2E_AGENT_HOME` (wdio.conf.ts, honoured only by the e2e-feature
// binary) points that write at the throwaway profile, so a run never touches
// the developer's real ~/.claude/settings.json.
describe("agent hooks", () => {
  const settingsPath = `${dataDir}/.claude/settings.json`;
  const scriptDir = `${dataDir}/.claude/termic-hooks`;
  // Deliberately not alphabetical, and with a hook of the user's own: both are
  // things a careless writer destroys.
  const userConfig = `{
  "model": "opus",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/my-own-hook"
          }
        ]
      }
    ]
  },
  "alwaysThinkingEnabled": true
}
`;

  // The Agent hooks block renders NOTHING unless a supported agent CLI is
  // actually on PATH (`present.filter(supported)` in AgentHooksBlock), and CI
  // installs none: no claude, no grok, no agy, no opencode. The fixture's
  // `fakeagent` cannot stand in, because it is deliberately not one of the four
  // and the row test below asserts it is absent.
  //
  // So the spec was asserting on whatever the runner happened to have, and
  // failed with `text never appeared: Agent hooks` whenever it had nothing.
  // Same message every time, but not every run, which reads as flake and is
  // really an environment dependency.
  //
  // Seed the detection this block reads instead. Detection itself is covered by
  // its own specs; what is under test here is what the block DOES with a
  // detected, supported agent, and that must not depend on the machine.
  let savedClis: unknown;
  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    savedClis = await browser.execute(() => window.__termic!.useApp.getState().detectedClis);
  });
  // Put it back: the store is shared with every spec after this one, and a
  // claude that does not exist would make them assert against a phantom agent.
  after(async () => {
    await browser.execute((prev) => {
      window.__termic!.useApp.setState({ detectedClis: prev as never });
    }, savedClis);
  });

  it("merges into the user's config and restores it byte-for-byte", async () => {
    await waitForAppShell();
    await requireTermicApi();
    mkdirSync(`${dataDir}/.claude`, { recursive: true });
    writeFileSync(settingsPath, userConfig);

    const after = await browser.execute(async () =>
      await window.__termic!.invoke("agent_hooks_install", { agentId: "claude" }));
    expect((after as { host: { installed: boolean } }).host.installed).toBe(true);

    const merged = JSON.parse(readFileSync(settingsPath, "utf8"));
    // Ours landed...
    expect(merged.hooks.PermissionRequest[0].hooks[0].command).toContain("termic-hooks");
    // ...and nothing of theirs moved.
    expect(merged.hooks.Stop[0].hooks[0].command).toBe("/usr/local/bin/my-own-hook");
    expect(merged.model).toBe("opus");
    expect(merged.alwaysThinkingEnabled).toBe(true);
    // The usage status line lands in the same write (GH #277). It is claimed
    // only because this fixture leaves the slot empty; a user with their own
    // status line keeps it, which `merge_statusline`'s Rust tests cover.
    expect(merged.statusLine.command).toContain("termic-hooks");
    expect(merged.statusLine.type).toBe("command");
    // Key ORDER survives too: serde_json sorts by default, which silently
    // rewrites a config the user hand-ordered. The user's own three keep both
    // their order and their position, and ours is APPENDED after them rather
    // than sorted into the middle of a config they hand-wrote.
    expect(Object.keys(merged)).toEqual([
      "model", "hooks", "alwaysThinkingEnabled", "statusLine",
    ]);

    // The script is executable, or claude cannot run it and the hook is inert.
    // One script per signal, named for what it reports. claude registers only
    // attention, since its terminal already gets working and done right.
    expect(existsSync(`${scriptDir}/attention.sh`)).toBe(true);
    expect(statSync(`${scriptDir}/attention.sh`).mode & 0o111).toBeGreaterThan(0);

    await browser.execute(async () =>
      await window.__termic!.invoke("agent_hooks_remove", { agentId: "claude" }));

    // Byte for byte, statusLine included: removal has to hand back a slot it
    // borrowed, or uninstalling leaves a config pointing at a script that is
    // no longer there.
    expect(readFileSync(settingsPath, "utf8")).toBe(userConfig);
    expect(existsSync(scriptDir)).toBe(false);
    rmSync(`${dataDir}/.claude`, { recursive: true, force: true });
  });

  it("installs into devin's config.json and restores it byte-for-byte", async () => {
    // devin is the one agent whose settings_rel is `config.json` rather than
    // `settings.json`: same claude-shaped `hooks` merge, different file. The
    // user's own keys (here `devin.org_id`) must survive the round trip.
    const devinDir = `${dataDir}/.config/devin`;
    const devinConfig = `${devinDir}/config.json`;
    const devinScripts = `${devinDir}/termic-hooks`;
    const userDevinConfig = `{
  "devin": { "org_id": "org-e2e" },
  "theme_mode": "dark"
}
`;
    mkdirSync(devinDir, { recursive: true });
    writeFileSync(devinConfig, userDevinConfig);

    const after = await browser.execute(async () =>
      await window.__termic!.invoke("agent_hooks_install", { agentId: "devin" }));
    expect((after as { host: { installed: boolean } }).host.installed).toBe(true);

    const merged = JSON.parse(readFileSync(devinConfig, "utf8"));
    expect(merged.hooks.SessionStart[0].hooks[0].command).toContain("termic-hooks");
    expect(merged.hooks.PermissionRequest[0].hooks[0].command).toContain("termic-hooks");
    expect(merged.devin.org_id).toBe("org-e2e");
    expect(merged.theme_mode).toBe("dark");
    expect(existsSync(`${devinScripts}/ready.sh`)).toBe(true);

    await browser.execute(async () =>
      await window.__termic!.invoke("agent_hooks_remove", { agentId: "devin" }));
    expect(readFileSync(devinConfig, "utf8")).toBe(userDevinConfig);
    expect(existsSync(devinScripts)).toBe(false);
    rmSync(devinDir, { recursive: true, force: true });
  });

  it("refuses a malformed config rather than clobbering it", async () => {
    mkdirSync(`${dataDir}/.claude`, { recursive: true });
    writeFileSync(settingsPath, "{ this is not json");

    const err = await browser.execute(async () => {
      try {
        await window.__termic!.invoke("agent_hooks_install", { agentId: "claude" });
        return null;
      } catch (e) { return String(e); }
    });
    expect(err).toBeTruthy();
    // Untouched: a config we could not parse is a config we must not rewrite.
    expect(readFileSync(settingsPath, "utf8")).toBe("{ this is not json");
    rmSync(`${dataDir}/.claude`, { recursive: true, force: true });
  });

  it("shows an honest per-agent row instead of pretending every agent is wired", async () => {
    // Agents, not Notifications: it writes into an agent's own config and
    // changes how that agent reports state, so it belongs where agents are
    // configured. Notifications keeps a pointer, since its indicators are
    // downstream of what this decides.
    await browser.execute(() =>
      window.__termic!.useApp.getState().openSettings("agents"));
    // Reproduce the CI condition first, so this spec verifies its own
    // mechanism on any machine. With no supported agent detected the block
    // renders nothing (`present.filter(supported)` is empty), which is exactly
    // the state that made this fail on a runner with no agent CLI installed
    // while passing on every developer laptop that has claude.
    // Re-applied on every poll, for the same reason the seed below is: the
    // startup `refreshClis()` spawns a login shell to resolve PATH and lands
    // whenever it lands, so a single clear before this wait is simply
    // overwritten by a detection that finished a moment later. Clearing once
    // and waiting passed on a warm machine and failed on a cold runner, which
    // is the only place the detection is slow enough to land inside the wait.
    await browser.waitUntil(async () => {
      await browser.execute(() => window.__termic!.useApp.setState({ detectedClis: {} }));
      return await browser.execute(() => !document.body.innerText.includes("Agent hooks"));
    }, { timeout: 15_000, timeoutMsg: "the hooks block never went away with no agent detected" });
    // Seeded on every poll, not once. `refreshClis()` is fired at startup and
    // resolves asynchronously - it spawns a login shell to resolve PATH, which
    // is slow on a cold runner - and lands with `set({ detectedClis })`, so a
    // single seed before this point is simply overwritten by a detection that
    // finds nothing. Re-applying until the block renders survives whichever
    // async writer wins, and costs nothing once it has.
    await browser.waitUntil(
      () => browser.execute(() => {
        const store = window.__termic!.useApp;
        if (!store.getState().detectedClis.claude?.found) {
          store.setState({
            detectedClis: {
              claude: { name: "claude", found: true, path: "/usr/bin/claude", version: "e2e" },
            },
          });
        }
        return document.body.innerText.includes("Agent hooks");
      }),
      { timeout: 20_000, timeoutMsg: "Agent hooks block never rendered with a seeded agent" },
    );
    // Collapsed by default: expanded, this pushed the per-agent tabs (the
    // reason anyone opens the page) below the fold behind two paragraphs of
    // protocol detail.
    await browser.execute(() =>
      (document.querySelector('[data-testid="agent-hooks-toggle"]') as HTMLElement | null)?.click());
    // Only agents that can actually be wired get a row. An agent the installer
    // cannot help ("not supported yet", "not needed, its terminal already
    // reports this") is a row you can do nothing with, and there were more of
    // those than real ones. fakeagent is seeded and detected and is NOT one of
    // the four, so it must be absent rather than present-and-useless.
    await waitVisible('[data-testid="agent-hooks-toggle"][aria-expanded="true"]');
    const rows = await browser.execute(() => document.body.innerText);
    expect(rows).not.toContain("not supported yet");
    // The collapsed row's coverage summary. `5 of 5` and `3 of 5` are the same
    // dim grey sentence apart from one digit, so the state is carried by
    // colour and an icon and pinned here as `data-state` rather than by
    // asserting a class name. On a scratch profile nothing is installed, which
    // is the third state and deliberately NOT a warning: an untouched install
    // has done nothing wrong, so it gets the invitation and no icon.
    const summary = await browser.execute(() => {
      const el = document.querySelector('[data-testid="agent-hooks-summary"]');
      return el ? { state: el.getAttribute("data-state"), text: el.textContent, icons: el.querySelectorAll("svg").length } : null;
    });
    expect(summary).not.toBeNull();
    expect(summary!.state).toBe("none");
    expect(summary!.text).toContain("Let agents report their own state");
    expect(summary!.icons).toBe(0);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });
});

// Cloning an agent, end to end through the real UI and the real save path.
//
// A clone used to be a full COPY taken once, which is a snapshot that rots:
// when a vendor renames a flag the built-in entry moves with the app and every
// clone keeps the old value forever. It had already happened, a clone carrying
// the parent's literal $HOME/.claude sandbox paths while its own config lived
// elsewhere, so the cage denied it its own login.
//
// Only the FUNCTIONAL half is asserted here: what gets stored, what resolves,
// and what the two buttons do. The banner, the badge and the placeholders are
// wording, and a spec that pinned those would break on every copy edit while
// catching nothing.
describe("cloned agents inherit rather than copy", () => {
  let cloneId: string | null = null;

  const agentIds = () => browser.execute(() =>
    window.__termic!.useApp.getState().agents.map((a: { id: string }) => a.id));
  const record = (id: string) => browser.execute((i) =>
    window.__termic!.useApp.getState().agents.find((a: { id: string }) => a.id === i) ?? null, id);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("agents"));
    await waitVisible('[data-agent-id][data-kind="agent"]');
  });

  after(async () => {
    // The profile is shared across this file, so a clone left behind would
    // outlive the run and show up in someone else's assertions.
    if (!cloneId) return;
    await browser.execute(async (id) => {
      const app = window.__termic!.useApp.getState();
      await window.__termic!.ipc.agentsSave(
        app.agents.filter((a: { id: string }) => a.id !== id));
      await window.__termic!.useApp.getState().loadAll();
    }, cloneId);
  });

  it("stores ONLY identity, so every other field resolves through the parent", async () => {
    const before = (await agentIds()) as string[];
    await browser.execute(() => {
      const card = document.querySelector('[data-agent-card="claude"]');
      (card?.querySelector('[data-testid="clone-agent"]') as HTMLElement | null)?.click();
    });
    await browser.waitUntil(async () => ((await agentIds()) as string[]).length > before.length, {
      timeout: 10_000, timeoutMsg: "cloning claude never added an agent",
    });
    cloneId = ((await agentIds()) as string[]).find(i => !before.includes(i))!;

    const stored = await record(cloneId) as Record<string, unknown>;
    expect(stored.extends).toBe("claude");
    // The whole point: a snapshot is NOT taken. These stay empty and are
    // answered by the parent at read time.
    expect(stored.command).toBe("");
    expect(stored.args).toEqual([]);
    expect(stored.icon_id).toBe("");
    expect(stored.sandbox_allowed_paths ?? []).toEqual([]);

    // And the inheritance is VISIBLE, which is the half a user notices: the
    // clone's pill draws its parent's brand icon even though its own
    // `icon_id` is empty. Reported as "the icon was lost" when this read the
    // field raw.
    const iconOf = (id: string) => browser.execute((i) => (document.querySelector(
      `[data-agent-id="${i}"] [data-icon-id]`) as HTMLElement | null)?.dataset.iconId ?? null, id);
    await browser.waitUntil(async () => (await iconOf(cloneId!)) !== null,
      { timeout: 10_000, timeoutMsg: "the clone never appeared in the agent strip" });
    expect(await iconOf(cloneId!)).toBe(await iconOf("claude"));
  });

  it("keeps an override, and follows the parent on every field it did not", async () => {
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      const next = app.agents.map((a: { id: string }) =>
        a.id === id ? { ...a, args: ["--mine"] } : a);
      return window.__termic!.ipc.agentsSave(next).then(() => app.loadAll());
    }, cloneId!);

    const stored = await record(cloneId!) as Record<string, unknown>;
    expect(stored.args).toEqual(["--mine"]);
    // Overriding ONE field must not freeze the rest, which is the same rot one
    // level down: `command` stays empty, so it still resolves to the parent.
    expect(stored.command).toBe("");
    // Still visibly a claude agent.
    const iconOf = (id: string) => browser.execute((i) => (document.querySelector(
      `[data-agent-id="${i}"] [data-icon-id]`) as HTMLElement | null)?.dataset.iconId ?? null, id);
    expect(await iconOf(cloneId!)).toBe(await iconOf("claude"));
  });

  it("the reset button clears every override and keeps identity", async () => {
    // The agents panel keeps its OWN loaded copy of the registry, so the
    // previous test's write through ipc.agentsSave is invisible to it until it
    // remounts. Navigating away and back is the remount; without it the reset
    // button never renders (overrideCount is stale at 0) and the failure reads
    // as "reset did nothing".
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("general"));
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("agents"));
    await waitVisible('[data-agent-id][data-kind="agent"]');

    // Only the SELECTED agent renders a card, so the clone's pill has to be
    // clicked first. Without that the button simply is not in the DOM, which
    // looks exactly like a reset that did nothing.
    await browser.execute((id) => {
      (document.querySelector(`[data-agent-id="${id}"]`) as HTMLElement | null)?.click();
    }, cloneId!);
    await waitVisible(`[data-agent-card="${cloneId}"] [data-testid="reset-overrides"]`);
    await browser.execute((id) => {
      const card = document.querySelector(`[data-agent-card="${id}"]`);
      (card?.querySelector('[data-testid="reset-overrides"]') as HTMLElement | null)?.click();
    }, cloneId!);

    await browser.waitUntil(async () => {
      const a = await record(cloneId!) as Record<string, unknown> | null;
      return !!a && (a.args as unknown[]).length === 0;
    }, { timeout: 10_000, timeoutMsg: "reset never cleared the override" });

    const after = await record(cloneId!) as Record<string, unknown>;
    // Identity survives: this is the escape hatch for a clone made before
    // agents inherited, not a way to delete it.
    expect(after.id).toBe(cloneId);
    expect(after.extends).toBe("claude");
    expect(after.args).toEqual([]);
    expect(after.command).toBe("");
  });
});


// "Install hooks for every agent": one switch, visible without expanding the
// block, persisted in settings.json, and wiring every supported agent on PATH.
// The seeded fake clones (fakeclaude, fakegrok, ...) are on PATH everywhere
// because their command is an absolute script path, so this does not depend
// on what the runner has installed. Installs land in the throwaway profile
// (`TERMIC_E2E_AGENT_HOME`), never a real config.
describe("install hooks for every agent", () => {
  const status = (id: string) => browser.execute(async (a) =>
    (await window.__termic!.invoke("agent_hooks_status", { agentId: a })).host.installed as boolean, id);
  const removeAll = () => browser.execute(async () => {
    const t = window.__termic!;
    await t.invoke("agent_hooks_auto_set", { on: false });
    for (const a of t.useApp.getState().agents) {
      try { await t.invoke("agent_hooks_remove", { agentId: a.id }); } catch { /* unsupported */ }
    }
    await t.useApp.getState().refreshAgentHooks();
  });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await removeAll();
  });
  after(async () => {
    await removeAll();
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await dismissOverlays();
  });

  it("wires every supported agent from one switch, without expanding the block", async () => {
    expect(await status("fakegrok")).toBe(false);
    expect(await status("fakeclaude")).toBe(false);
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("agents"));
    await waitVisible('[data-testid="agent-hooks-auto"] [role="switch"]');
    // Collapsed: the switch is reachable without opening the list.
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="agent-hooks-toggle"]')?.getAttribute("aria-expanded"))).toBe("false");
    await clickWhenVisible('[data-testid="agent-hooks-auto"] [role="switch"]');
    await browser.waitUntil(async () => (await status("fakegrok")) && (await status("fakeclaude")),
      { timeout: 30_000, timeoutMsg: "turning the switch on did not install hooks for every agent" });
    // An agent that is not a hooks target (the plain fixture agent) is left alone.
    expect(await status("fakeagent")).toBe(false);
    // Persisted, not a view state.
    expect(await browser.execute(() => window.__termic!.invoke("agent_hooks_auto_get"))).toBe(true);
    const notInstalled = () => browser.execute(async () => {
      const t = window.__termic!;
      const found = t.useApp.getState().detectedClis as Record<string, { found: boolean }>;
      const out: string[] = [];
      for (const a of t.useApp.getState().agents) {
        if (!found[a.id]?.found) continue;
        // codex hooks only count once codex itself has TRUSTED them, which
        // takes a real `codex app-server` to compute the hashes. A runner with
        // no codex installed can never get there, so a codex-based agent is
        // not part of what this case can assert (its trust path has its own
        // ignored live test, codex_hooks_install_is_trusted_by_codex...).
        if ((a.extends ?? a.id) === "codex") continue;
        const st = await t.invoke("agent_hooks_status", { agentId: a.id });
        if (st.supported && !st.host.installed) out.push(`${a.id}: ${st.host.error ?? "not installed"}`);
      }
      return out;
    });
    let missing: string[] = [];
    await browser.waitUntil(async () => (missing = await notInstalled()).length === 0,
      { timeout: 30_000, timeoutMsg: `not every detected agent got hooks: ${JSON.stringify(missing)}` })
      .catch(() => { throw new Error(`not every detected agent got hooks: ${JSON.stringify(missing)}`); });
    // And the block says so, without a reload. Any count past zero: codex's
    // row depends on a real codex being installed (see above), so "complete"
    // is machine-dependent while "installed" is not.
    await browser.waitUntil(async () => await browser.execute(() =>
      document.querySelector('[data-testid="agent-hooks-summary"]')?.getAttribute("data-state") !== "none"),
      { timeout: 10_000, timeoutMsg: "the summary never showed the installed hooks" });
    await snap("agent-hooks-install-all.png");
  });

  it("re-wires an agent whose hooks went missing on the next sync", async () => {
    // The "new agent" case, driven the way it happens: an agent with no hooks
    // while the setting is on gets them on the next sync (boot, or the page).
    await browser.execute(async () => {
      await window.__termic!.invoke("agent_hooks_remove", { agentId: "fakegrok" });
    });
    expect(await status("fakegrok")).toBe(false);
    const wired = await browser.execute(() => window.__termic!.invoke("agent_hooks_sync")) as string[];
    // Asserted on the agent's STATUS, not on which id the sync names: a clone
    // that relocates nothing shares its base's config dir, so the sync wires
    // it through whichever of the two it reaches first (`grok` here).
    expect(wired.length).toBeGreaterThan(0);
    expect(await status("fakegrok")).toBe(true);
  });

  it("keeps what is installed when turned off", async () => {
    await clickWhenVisible('[data-testid="agent-hooks-auto"] [role="switch"]');
    await browser.waitUntil(async () =>
      (await browser.execute(() => window.__termic!.invoke("agent_hooks_auto_get"))) === false,
      { timeout: 10_000, timeoutMsg: "the switch never turned off" });
    expect(await status("fakegrok")).toBe(true);
    // And a sync with it off installs nothing new.
    await browser.execute(async () => {
      await window.__termic!.invoke("agent_hooks_remove", { agentId: "fakegrok" });
    });
    await browser.execute(() => window.__termic!.invoke("agent_hooks_sync"));
    expect(await status("fakegrok")).toBe(false);
  });
});
