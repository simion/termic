import {
  archiveTask, clearLanguagePref, clickWhenVisible, ensureActiveTask, openTask,
  rawI18nKeysOnScreen, requireTermicApi, snap, waitForAppShell, waitForText, waitVisible,
} from "../helpers";

// Translation keys must not reach the screen as text (GH #330).
//
// `useTranslation("panels")` binds `t`, but `<Trans>` does not inherit it:
// with no `t={t}` and no `ns=`, it looks the key up in the default namespace,
// misses, and renders the key. Thirteen call sites shipped that way. Two were
// caught, by specs that happened to assert on the exact sentence; the PR card
// told people "pr.cliMissingBody" and the clone dialog dropped its whole
// destination line, because the `<code>` that carries it lives inside the
// translation, so a missed key takes the element and its testid with it.
//
// The static half of this guard is src/locales/transNamespace.test.ts, which
// reads every call site including the ones no spec opens. This is the other
// half: what the app actually PAINTS, for the surfaces a user opens first,
// in both shipped languages. `rawI18nKeysOnScreen` asks i18next whether each
// dotted token on screen is one of its keys, so nothing here depends on a
// regex guessing what a key looks like.
describe("no untranslated keys on screen", () => {
  let taskId!: string;

  /** Every settings page (the `settingsTab` union in store/app.ts), since
   *  each one is its own wall of copy. "repositories" wants a repo id and
   *  renders a picker without one, which is still worth reading. */
  const SETTINGS_TABS = [
    "general", "agents", "appearance", "tasks", "sandbox", "docker",
    "cli", "notifications", "prompts", "repositories", "shortcuts", "profiles",
  ];

  /** Nothing on screen is one of i18next's own keys. The failing screenshot
   *  is captured before the assertion, since "which surface" is most of the
   *  answer and the key alone does not say where it was drawn. */
  const expectClean = async (where: string) => {
    const keys = await rawI18nKeysOnScreen();
    if (keys.length) {
      await snap(`i18n-raw-keys-${where}.png`);
      throw new Error(`${where} renders translation keys instead of text: ${keys.join(", ")}`);
    }
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-i18n");
    await ensureActiveTask(taskId);
  });

  after(async () => {
    // Leave the language the way every other spec expects to find it: their
    // markers are English copy. Cleared rather than set to "system", or the
    // stored pref would beat the e2e build's English default (GH #338).
    await clearLanguagePref();
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    // Self-clean like every other spec: the whole suite shares one data dir
    // (wdio.conf.ts), so this task outlives the window it was made in. Not
    // hygiene, load-bearing: without it `tabs-layout.e2e.ts` lost 8 cases,
    // and archiving here (alone, no other change) put them back.
    if (taskId) await archiveTask(taskId);
  });

  it("would notice a key that reached the screen", async () => {
    // The control. Every assertion below is "we found nothing", which is also
    // what a detector that can no longer see anything reports: a renamed
    // namespace, a changed `__termic` shape, an innerText that stops
    // returning the panels. Plant the exact string the PR card shipped and
    // require the detector to name it.
    await browser.execute(() => {
      const probe = document.createElement("div");
      probe.id = "i18n-probe";
      probe.textContent = "pr.cliMissingBody";
      document.body.append(probe);
    });
    const seen = await rawI18nKeysOnScreen();
    await browser.execute(() => document.getElementById("i18n-probe")?.remove());
    expect(seen).toContain("pr.cliMissingBody");
  });

  it("keeps the main window and its panels free of keys", async () => {
    await expectClean("main-window");
  });

  it("keeps every settings page free of keys", async () => {
    for (const tab of SETTINGS_TABS) {
      await browser.execute((t) => window.__termic!.useApp.getState().openSettings(t), tab);
      // Settings renders its pages lazily; wait for the rail to paint this
      // one before reading the text, or an empty pane passes for free.
      await browser.waitUntil(
        async () => (await browser.execute(() =>
          document.querySelector('[data-testid="settings-pane"]')?.textContent?.length ?? 0)) > 40,
        { timeout: 10_000, timeoutMsg: `settings page ${tab} never painted` },
      );
      await expectClean(`settings-${tab}`);
    }
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("keeps the new-task dialog free of keys, including its CLI hints", async () => {
    const projectId = await browser.execute((id) =>
      window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.project_id, taskId) as string;
    await browser.execute((id) => window.__termic!.useUI.getState().openNewTask(id), projectId);
    await waitVisible('[data-testid="new-task-name"]');
    await expectClean("new-task");
    await browser.keys(["Escape"]);
  });

  it("keeps the new-project dialog free of keys, clone mode included", async () => {
    // Clone mode is where the bug bit: its destination line is a <Trans>
    // whose <code> element comes from the translation.
    await browser.execute(() => window.__termic!.useUI.getState().openNewProject());
    await waitVisible('[data-testid="project-mode-clone"]');
    await expectClean("new-project");
    await clickWhenVisible('[data-testid="project-mode-clone"]');
    await waitVisible('[data-testid="clone-url"]');
    await expectClean("new-project-clone");
    await browser.keys(["Escape"]);
  });

  it("keeps them clean in Chinese too", async () => {
    // A key missing from zh-CN falls back to English rather than rendering
    // raw, so this is not the same assertion twice: it covers the Chinese
    // catalog's own structure (plurals, interpolation) reaching the screen.
    await browser.execute(() => window.__termic!.usePrefs.getState().setLanguage("zh-CN"));
    await browser.waitUntil(
      async () => (await browser.execute(() => document.documentElement.lang)) === "zh-CN",
      { timeout: 10_000, timeoutMsg: "the UI never switched to Chinese" },
    );
    await expectClean("main-window-zh");

    await browser.execute(() => window.__termic!.useApp.getState().openSettings("general"));
    await waitForText("语言");
    await expectClean("settings-general-zh");
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());

    await browser.execute(() => window.__termic!.usePrefs.getState().setLanguage("en"));
    await browser.waitUntil(
      async () => (await browser.execute(() => document.documentElement.lang)) === "en",
      { timeout: 10_000, timeoutMsg: "the UI never switched back to English" },
    );
  });

  it("draws the shortcut rows themselves in Chinese", async () => {
    // The rows are the surface this file used to miss: their labels and hints
    // are keyed by shortcut id (lib/shortcutCopy.ts, `settings:shortcuts.defs.*`)
    // and built at render time rather than written where they print, so a row
    // without an entry draws its key and no English assertion can see it. The
    // page's own chrome was already covered by the pass above.
    //
    // Both the row labels and the mode select's options, since those two come
    // from different tables in that module.
    const shortcutsPage = async () => {
      await browser.execute(() => window.__termic!.useApp.getState().openSettings("shortcuts"));
      // The two fixed rows carry the page's own testids, and they exist in
      // either language: the Reset all button's label does not.
      await waitVisible('[data-testid="fixed-shortcut-row"]');
      return await browser.execute(() =>
        (document.querySelector('[data-testid="settings-pane"]') as HTMLElement)?.innerText ?? "") as string;
    };

    const english = await shortcutsPage();
    expect(english).toContain("Previous sidebar row");
    await snap("settings-shortcuts-en.png");

    await browser.execute(() => window.__termic!.usePrefs.getState().setLanguage("zh-CN"));
    await browser.waitUntil(
      async () => (await browser.execute(() => document.documentElement.lang)) === "zh-CN",
      { timeout: 10_000, timeoutMsg: "the UI never switched to Chinese" },
    );

    const text = await shortcutsPage();
    // One row from each end of the table: the first group's first row, and a
    // Git row, which is the group a filter or a missing entry would drop last.
    expect(text).toContain("上一个侧边栏条目");
    expect(text).toContain("丢弃所选文件的改动");
    // And not the English it would fall back to: a zh-CN gap resolves to the
    // en string (lib/i18n.ts, fallbackLng), which is exactly what a passing
    // "no raw keys" assertion would let through.
    expect(text).not.toContain("Discard selected file");
    await expectClean("settings-shortcuts-zh");
    await snap("settings-shortcuts-zh.png");

    // The gesture with no chord carries a select instead of a recorder, and
    // its options are the other half of the module's copy.
    const modes = await browser.execute(() =>
      [...(document.querySelector('[data-testid="double-shift-mode"]') as HTMLSelectElement).options]
        .map(o => o.textContent ?? ""));
    expect(modes).toEqual(["关闭", "双击左 Shift", "双击 Shift（终端内除外）", "双击 Shift"]);

    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await browser.execute(() => window.__termic!.usePrefs.getState().setLanguage("en"));
    await browser.waitUntil(
      async () => (await browser.execute(() => document.documentElement.lang)) === "en",
      { timeout: 10_000, timeoutMsg: "the UI never switched back to English" },
    );
  });
});
