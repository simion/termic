import { waitForAppShell, requireTermicApi, artifact } from "../helpers";

// P2: preference setters persist to the prefs store. Cases: global default
// sandbox toggle, editor font, terminal font. Each restores its original.
describe("preferences", () => {
  const orig: Record<string, unknown> = {};
  const get = (k: string) =>
    browser.execute((key) => (window.__termic!.usePrefs.getState() as any)[key], k);

  after(async () => {
    await browser.execute((o) => {
      const p = window.__termic!.usePrefs.getState();
      if ("globalDefaultSandbox" in o)
        p.setGlobalDefaultSandbox(o.globalDefaultSandbox);
      if ("editorFontId" in o) p.setEditorFontId(o.editorFontId);
      if ("terminalFontId" in o) p.setTerminalFontId(o.terminalFontId);
    }, orig);
  });

  it("toggles the global default sandbox pref", async () => {
    await waitForAppShell();
    await requireTermicApi();
    orig.globalDefaultSandbox = await get("globalDefaultSandbox");
    await browser.execute(
      (v) => window.__termic!.usePrefs.getState().setGlobalDefaultSandbox(!v),
      orig.globalDefaultSandbox,
    );
    await browser.waitUntil(
      async () => (await get("globalDefaultSandbox")) !== orig.globalDefaultSandbox,
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
    await browser.saveScreenshot(artifact("prefs.png"));
  });
});
