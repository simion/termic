import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveTask, ensureActiveTask, mouseDrag, openTask, requireTermicApi, snap, waitForAgentReady, waitForAppShell, waitVisible, waitGone,
} from "../helpers";

// Code intelligence (GH #174), driven end to end against a real language server
// over real stdio framing — `e2e/fixtures/fake-lsp.mjs`, which is as demanding
// as the servers that bit the design: it refuses to answer until the client
// replies to a `workspace/configuration` request with an array of the right
// LENGTH, and it rejects an `initialize` with no `workspaceFolders`.
//
// That is the point of testing it here rather than in a unit test. The CM
// client answers every server request with -32601 and sends only `rootUri`, so
// a diagnostic appearing in the editor is proof the Rust host intercepted the
// request and patched the handshake. A unit test of either half in isolation
// would have passed all the way through the failure this prevents.

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "..", "fixtures", "fake-lsp.mjs");

/** Install the fake server at `dest` the way the platform runs a repo-local
 *  server: the script itself (shebang + exec bit) on unix, a `.cmd` launcher
 *  on Windows, which cannot execute an extensionless script (termic looks up
 *  `<dest>.cmd` there, as it does npm's own shims). Returns what to delete. */
function installFakeServer(dest: string): string {
  if (process.platform === "win32") {
    const cmd = `${dest}.cmd`;
    writeFileSync(cmd, `@node "${fakeServer}" %*\r\n`);
    return cmd;
  }
  copyFileSync(fakeServer, dest);
  chmodSync(dest, 0o755);
  return dest;
}

/** The checkout the task reads: a main-checkout task runs in the repo root. */
const taskPath = (taskId: string) =>
  browser.execute(
    (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.path as string,
    taskId,
  );

/** Open the chip's popover and press one of its actions. The chip no longer
 *  arms on click: it opens the same popover Search Everywhere shows, so both
 *  surfaces ask the identical question. */
const chipAction = async (testid: string) => {
  await browser.execute(() => {
    (document.querySelector('[data-testid="code-intel-chip"]') as HTMLElement).click();
  });
  await waitVisible(`[data-testid="${testid}"]`, 10_000);
  await browser.execute((id) => {
    (document.querySelector(`[data-testid="${id}"]`) as HTMLElement)
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  }, testid);
};

/** ⌘-click the first occurrence of `word` in this task's editor. */
const modClickWord = (taskId: string, word: string) =>
  browser.execute((id, w) => {
    const dom = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as HTMLElement;
    const view = (dom as unknown as { __cmView?: any }).__cmView;
    if (!view) throw new Error("no CodeMirror view (build with make e2e)");
    const at = view.state.doc.toString().indexOf(w);
    if (at < 0) throw new Error(`no ${w} in the buffer`);
    const coords = view.coordsAtPos(at + 1);
    const content = dom.querySelector(".cm-content") as HTMLElement;
    content.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, cancelable: true, button: 0, [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true,
      clientX: Math.round(coords.left + 1), clientY: Math.round((coords.top + coords.bottom) / 2),
    }));
  }, taskId, word);

const setCodeNavPref = (on: boolean) =>
  browser.execute((v) => window.__termic!.usePrefs.getState().setCodeIntelligence(v), on);

/** Type checking is OPT-IN (prefs.codeIntelDiagnostics, default off), so every
 *  case below that reads a red underline has to ask for one first. Navigation
 *  itself does not depend on this. */
const setTypeChecking = (on: boolean) =>
  browser.execute((v) => window.__termic!.usePrefs.getState().setCodeIntelDiagnostics(v), on);

/** Arm one checkout for one server. A grant is per (checkout, language): a
 *  repo with Python and JavaScript in it is two servers and two decisions. */
const armGrant = (root: string, taskId: string, server = "typescript") =>
  browser.execute((r, id, sv) => {
    const { useCodeIntel, grantKey } = (window as any).__termic.codeIntel;
    useCodeIntel.getState().arm(grantKey(r, sv), id);
  }, root, taskId, server);

/** Is this checkout armed for this server? */
const isArmed = (root: string, server = "typescript") =>
  browser.execute((r, sv) => {
    const { useCodeIntel, grantKey } = (window as any).__termic.codeIntel;
    return (useCodeIntel.getState().grants[grantKey(r, sv)] ?? []).length > 0;
  }, root, server) as Promise<boolean>;

const clearGrants = () =>
  browser.execute(() => window.__termic!.useCodeIntel.setState({ grants: {} }));

/** The host's own account of a server, for a failure message.
 *
 *  A red underline that never arrives has three causes that look identical on
 *  screen: the binary was never resolved, it was resolved and would not start,
 *  or it started and answered nothing. `lspStatus` separates the last two
 *  (host.ts writes `starting`, then `failed` with the process's own words),
 *  `lsp_offer` says which executable the resolver found, and `lsp_list` says
 *  whether anything is alive on this checkout. On a CI runner nobody can
 *  attach to, the assertion message is the only place that answer can arrive:
 *  the Windows job spent two runs on "never became visible" alone. */
const lspWhy = (root: string, server: string) =>
  browser.execute(async (r, sv) => {
    const t = window.__termic!;
    const { useLspStatus, statusKey } = t.lspStatus as {
      useLspStatus: { getState(): { byKey: Record<string, unknown> } };
      statusKey: (root: string, server: string) => string;
    };
    const said = async (fn: () => Promise<unknown>) => {
      try { return await fn(); } catch (e) { return `threw: ${String(e)}`; }
    };
    const servers = await said(() => t.invoke("lsp_list") as Promise<unknown>);
    return JSON.stringify({
      status: useLspStatus.getState().byKey[statusKey(r, sv)] ?? null,
      offer: await said(() => t.invoke("lsp_offer", { root: r, language: sv }) as Promise<unknown>),
      here: Array.isArray(servers) ? servers.filter((s: { root: string }) => s.root === r) : servers,
    });
  }, root, server);

/** Wait for a diagnostic in this task, and say WHY if none comes.
 *
 *  Longer than the 15s default on purpose. This waits on a PROCESS starting,
 *  and the first `.cmd` shim around node on a Windows runner took 6.8s from
 *  `sent initialize` to its first byte, against 0.24s for every spawn after it
 *  (termic-debug.log, run 36390843154). wdio.conf.ts now warms that path
 *  before the suite, but a cold image loader on a shared runner is not
 *  something a spec should be betting a case on either way.
 *
 *  75s, because the warm-up did not hold: a later Windows run (36416742549)
 *  measured 40.4s from `sent initialize` to the first byte, with the same 22
 *  specs' later servers at 0.14 to 0.27s each. The budget has to clear the
 *  CLIENT's handshake timeout (60s, lib/lsp/host.ts) or a pass here would only
 *  mean this wait gave up before the client did, which is how that run read:
 *  the 40s wait expired 133ms before the server answered. Costs nothing when
 *  the server is warm, because it waits on the element, not on the clock.
 *  docs/lsp.md rule 22 has what is and is not known about the 40s. */
const waitLintRange = async (taskId: string, root: string, server: string) => {
  try {
    await waitVisible(`[data-task-id="${taskId}"] .cm-lintRange-error`, 75_000);
  } catch (e) {
    throw new Error(`${(e as Error).message}\nhost says: ${await lspWhy(root, server)}`);
  }
};

const openFile = (taskId: string, rel: string) =>
  browser.execute((id, p) => {
    window.__termic!.useApp.getState().openPreviewTab(id, { type: "edit", path: p, title: p });
  }, taskId, rel);

/** Open a file and wait until the pane has SETTLED on its language.
 *
 *  The pane resolves a path to a grammar asynchronously (the registry
 *  code-splits ~150 of them) and writes the answer to `syntaxAuto`, so a tab
 *  reads as Plain Text for a beat after it opens — and the chip only exists
 *  for a language something can answer for. Waiting on `.cm-editor` alone
 *  asserts against that beat.
 *
 *  `expectEditor` is false for markdown: a `.md` file opens in the preview
 *  shell, whose default view is the RENDERED side, so there is no CodeMirror
 *  to wait for and waiting for one times out. The language still settles. */
/** Wait for a VISIBLE editor in this task.
 *
 *  Not `waitVisible`: that checks the first match, and a task with several
 *  editor tabs open keeps the inactive ones mounted at `display: none`. The
 *  first `.cm-editor` in the DOM is then a hidden tab, and the wait times out
 *  while the file is on screen. */
async function waitEditorVisible(taskId: string, timeout = 15_000) {
  await browser.waitUntil(
    () => browser.execute((id) =>
      [...document.querySelectorAll(`[data-task-id="${id}"] .cm-editor`)]
        .some(el => el.getBoundingClientRect().width > 0 && (el as any).__cmView), taskId),
    { timeout, timeoutMsg: `no visible editor in task ${taskId}` },
  );
}

async function openSettled(
  taskId: string, rel: string, language: string, expectEditor = true,
) {
  await ensureActiveTask(taskId);
  await openFile(taskId, rel);
  if (expectEditor) await waitEditorVisible(taskId);
  await browser.waitUntil(
    () => browser.execute((id, lang) => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? []).find((t: any) => t.id === app.activeTab[id]);
      return !!tab && tab.type === "edit" && (tab.syntax ?? tab.syntaxAuto) === lang;
    }, taskId, language),
    { timeout: 15_000, timeoutMsg: `${rel} never settled on ${language}` },
  );
}

describe("Terraform code intelligence", () => {
  let taskId = "";
  let root = "";
  const files = ["tf-nav.tf", "tf-nav.auto.tfvars", "tf-nav.hcl", "tf-nav.tf.json"];

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("lsp-terraform");
    root = await taskPath(taskId);
    mkdirSync(path.join(root, "bin"), { recursive: true });
    installFakeServer(path.join(root, "bin", "terraform-ls"));
    writeFileSync(path.join(root, files[0]), 'variable "Store" {\n  default = "demo"\n}\n');
    writeFileSync(path.join(root, files[1]), 'Store = "demo"\n');
    writeFileSync(path.join(root, files[2]), 'locals {\n  store = "demo"\n}\n');
    writeFileSync(path.join(root, files[3]), '{"variable":{"Store":{"default":"demo"}}}\n');
    rmSync(path.join(root, ".fake-lsp.json"), { force: true });
    await clearGrants();
    await setCodeNavPref(true);
    await setTypeChecking(true);
    await browser.execute(() => window.__termic!.usePrefs.getState().setConfirmBeforeCodeIntel(false));
  });

  after(async () => {
    await clearGrants();
    if (root) {
      await browser.execute(async (r) => {
        const t = window.__termic!;
        const servers = await t.invoke("lsp_list") as Array<{ id: string; root: string; language: string }>;
        for (const s of servers.filter(s => s.root === r && s.language === "terraform"))
          await t.invoke("lsp_stop", { id: s.id });
      }, root);
      for (const rel of [...files, "bin/terraform-ls", "bin/terraform-ls.cmd", ".fake-lsp.json"])
        rmSync(path.join(root, rel), { force: true });
    }
    await setTypeChecking(false);
    await browser.execute(() => window.__termic!.usePrefs.getState().setConfirmBeforeCodeIntel(true));
    if (taskId) await archiveTask(taskId);
  });

  it("offers Terraform navigation without starting the server", async () => {
    await openSettled(taskId, files[0], "HCL");
    await waitVisible('[data-testid="code-intel-chip"]');
    expect(existsSync(path.join(root, ".fake-lsp.json"))).toBe(false);
    const catalog = await browser.execute(async () => await window.__termic!.invoke("lsp_catalog")) as
      Array<{ language: string; servers: Array<{ name: string }> }>;
    expect(catalog.find(c => c.language === "terraform")?.servers[0].name).toBe("terraform-ls");
    // The offer must name the FIXTURE's binary, not a download. The resolver
    // looks for `bin/terraform-ls` in the checkout, which on Windows means
    // `bin\terraform-ls.cmd` through PATHEXT; a miss there arms the grant
    // anyway and then starts nothing, which reads on screen as a server that
    // came up and said nothing. Asserted here so it says so instead.
    const offer = await browser.execute(async (r) =>
      await window.__termic!.invoke("lsp_offer", { root: r, language: "terraform" }),
    root) as { exe: string | null };
    if (!offer.exe?.includes("terraform-ls"))
      throw new Error(`terraform-ls not resolved under ${root}: offer ${JSON.stringify(offer)}`);
  });

  it("serves .tf and .tfvars through one grant with their own protocol ids", async () => {
    await chipAction("code-intel-turn-on-for-this-task");
    await waitLintRange(taskId, root, "terraform");
    expect(await isArmed(root, "terraform")).toBe(true);
    await openSettled(taskId, files[1], "HCL");
    await waitLintRange(taskId, root, "terraform");
    const seen = JSON.parse(readFileSync(path.join(root, ".fake-lsp.json"), "utf8"));
    expect(seen.opened).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: expect.stringContaining(files[0]), languageId: "terraform" }),
      expect.objectContaining({ uri: expect.stringContaining(files[1]), languageId: "terraform-vars" }),
    ]));
    const count = await browser.execute(async (r) => {
      const servers = await window.__termic!.invoke("lsp_list") as Array<{ root: string; language: string }>;
      return servers.filter(s => s.root === r && s.language === "terraform").length;
    }, root);
    expect(count).toBe(1);
    await snap("terraform-code-intelligence.png");
  });

  it("does not send unrelated HCL or JSON to the Terraform server", async () => {
    for (const [file, language] of [[files[2], "HCL"], [files[3], "JSON"]]) {
      await openSettled(taskId, file, language);
      await waitGone('[data-testid="code-intel-chip"]');
      // The transcript only exists if the server ran. Without this the case
      // reports `ENOENT .fake-lsp.json`, which names the symptom of the case
      // before it and says nothing about this one.
      const transcript = path.join(root, ".fake-lsp.json");
      if (!existsSync(transcript))
        throw new Error(`no server transcript, so nothing was sent anywhere: ${await lspWhy(root, "terraform")}`);
      const seen = JSON.parse(readFileSync(transcript, "utf8"));
      expect(seen.opened.some((d: { uri: string }) => d.uri.endsWith(file))).toBe(false);
    }
  });
});

describe("code intelligence", () => {
  let taskId = "";
  let root = "";

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("lsp-nav");
    root = await taskPath(taskId) as string;
    // The server is resolved from the CHECKOUT first, on purpose: a repo
    // pinning its own toolchain must be the one driven. That is also the hook
    // this spec needs — no production build flag, no test-only language.
    const bin = path.join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    installFakeServer(path.join(bin, "tsgo"));
    writeFileSync(path.join(root, "navme.ts"), "export const answer = 42;\n");
    // A SECOND file with the same basename, which the fixture reports one
    // usage in: two files called navme.ts is what makes the popup's row
    // labels have something to disambiguate.
    mkdirSync(path.join(root, "nested"), { recursive: true });
    writeFileSync(path.join(root, "nested", "navme.ts"), "export const answer = 7;\n");
    rmSync(path.join(root, ".fake-lsp.json"), { force: true });
    // Most cases below read a diagnostic to prove the pipe is live, and type
    // checking ships OFF (navigation is the feature; a checker's opinion about
    // code you are reading is opt-in). One case turns it back off to assert
    // that default; everything else runs with it on.
    await setTypeChecking(true);
    await ensureActiveTask(taskId);
  });

  after(async () => {
    // NEVER sweep a path built from an empty root. `root` is assigned in
    // `before()`, and mocha runs `after()` even when `before()` threw, so a
    // flaky task spawn left every `path.join(root, …)` below resolving
    // RELATIVE TO THE WDIO PROCESS CWD, which is this repo. That made the
    // teardown `rm -rf node_modules` in the developer's own checkout.
    if (!root) return;
    // Everything this file wrote into the SHARED fixture repo goes back.
    // Leaving it dirty is not a tidiness issue: git.e2e asserts a clean
    // working tree, and a repo with changes gives sidebar rows an extra badge,
    // which broke two layout specs by 10px in a way that looked nothing like
    // "codenav left files behind".
    // Every file any case in this file writes, swept from ONE place. Two of
    // them (lonely.ts, Makefile) were removed only on the last line of their
    // case body, so any earlier throw left them in the shared fixture repo and
    // failed git.e2e's clean-tree assertion on the NEXT run.
    for (const rel of [
      "navme.ts", "navback.ts", "helper.py", "lonely.ts", "Makefile", ".fake-lsp.json",
    ]) {
      rmSync(path.join(root, rel), { force: true });
    }
    rmSync(path.join(root, "nested"), { recursive: true, force: true, maxRetries: 10 });
    rmSync(path.join(root, "node_modules"), { recursive: true, force: true, maxRetries: 10 });
    // Never hand the next spec file a standing confirm: one is on screen at a
    // time, and an unanswered one blocks the whole window.
    await browser.execute(() => window.__termic!.useUI.getState().resolveConfirm(false));
    // Leave the disclosure armed for the next run: this spec asserts on it.
    await browser.execute(() => window.__termic!.usePrefs.getState().setConfirmBeforeCodeIntel(true));
    // And the two prefs this file turns ON, back to their shipped defaults.
    // They persist to localStorage in the SHARED profile, so leaving them set
    // ran every later spec file (and every later run) with type checking on.
    await browser.execute(() => {
      window.__termic!.usePrefs.getState().setCodeIntelDiagnostics(false);
      window.__termic!.usePrefs.getState().setCodeIntelligence(true);
    });
    await clearGrants();
    if (taskId) await archiveTask(taskId);
  });

  it("offers the chip on the editor itself, with no setting to find first", async () => {
    // One click from an open editor, which is the whole point: the feature
    // used to be gated behind a Settings toggle nobody found.
    await setCodeNavPref(true);
    await openSettled(taskId, "navme.ts", "TypeScript");
    await waitVisible('[data-testid="code-intel-chip"]');
    // Offering it starts nothing: no server exists until a checkout is armed.
    const servers = await browser.execute(async () => await window.__termic!.invoke("lsp_list"));
    expect(servers).toEqual([]);
  });

  it("hides the chip entirely for someone who turns the feature off", async () => {
    await setCodeNavPref(false);
    await openSettled(taskId, "navme.ts", "TypeScript");
    const chips = await browser.execute(
      () => document.querySelectorAll('[data-testid="code-intel-chip"]').length,
    );
    expect(chips).toBe(0);
    await setCodeNavPref(true);
  });

  it("shows it only for a language something can serve", async () => {
    await openSettled(taskId, "navme.ts", "TypeScript");
    await waitVisible('[data-testid="code-intel-chip"]');
    // A README has no server wired for it, so the chip is absent rather than
    // present-and-useless.
    await openSettled(taskId, "README.md", "Markdown", false);
    await waitGone('[data-testid="code-intel-chip"]');
    await openSettled(taskId, "navme.ts", "TypeScript");
    await waitVisible('[data-testid="code-intel-chip"]');
  });

  it("states the memory cost, the unit, and that the grant lapses", async () => {
    await openSettled(taskId, "navme.ts", "TypeScript");
    await waitVisible('[data-testid="code-intel-chip"]');
    // A user cannot consent to a cost nobody showed them, and this is the
    // moment of consent. All three facts, at the point of decision.
    await chipAction("code-intel-turn-on-for-this-task");
    // The CONFIRM dialog, by its own testid: this window is shared by every
    // spec file, and a palette another file left open (animations are frozen
    // while occluded, so they outlive their close) is also a [role="dialog"].
    await waitVisible('[data-testid="confirm-ok"]');
    const text = await browser.execute(() => {
      const ok = document.querySelector('[data-testid="confirm-ok"]');
      return (ok?.closest('[role="dialog"]') as HTMLElement | null)?.innerText ?? "";
    }) as string;
    // "code intelligence" and not "code navigation": this file runs with type
    // checking ON (see `before`), and the feature's name follows that switch.
    // The case below pins the other half.
    expect(text.toLowerCase()).toContain("code intelligence");
    // A number per language, not "may use significant memory".
    expect(text).toMatch(/\d+\s?(MB|GB)/);
    // The unit is the checkout, which is the part nobody guesses.
    expect(text.toLowerCase()).toContain("checkout");
    // And that it ends with the work that motivated it.
    expect(text.toLowerCase()).toMatch(/closed or archived/);
    await snap("code-nav-consent.png");
    // Cancel: refusing must leave nothing running. Only one confirm is on
    // screen at a time, so leaving this one standing would block every later
    // spec file's prompts, not just this case.
    await browser.execute(() => {
      (document.querySelector('[data-testid="confirm-cancel"]') as HTMLElement).click();
    });
    await waitGone('[data-testid="confirm-ok"]');
    const servers = await browser.execute(async () => await window.__termic!.invoke("lsp_list"));
    expect(servers).toEqual([]);
  });

  it("asks once, then arms in a single click", async () => {
    // The cost is real and per checkout, so nobody should meet it by surprise
    // — but someone who has read it once and turns navigation on in every
    // repo should not read it again. Same shape as archiving a task.
    await browser.execute(() => window.__termic!.useCodeIntel.setState({ grants: {} }));
    await browser.execute(() => window.__termic!.usePrefs.getState().setConfirmBeforeCodeIntel(true));
    await openSettled(taskId, "navme.ts", "TypeScript");
    await waitVisible('[data-testid="code-intel-chip"]');
    await chipAction("code-intel-turn-on-for-this-task");
    await waitVisible('[data-testid="confirm-ok"]');
    // Tick "don't show this again", then go through with it.
    await browser.execute(() => {
      const box = document.querySelector('[data-testid="confirm-show-every-time"]') as HTMLElement | null;
      box?.click();
      (document.querySelector('[data-testid="confirm-ok"]') as HTMLElement).click();
    });
    await waitGone('[data-testid="confirm-ok"]');
    expect(await isArmed(root)).toBe(true);

    // A second checkout (here, the same one re-armed) is now one click with no
    // dialog at all.
    await browser.execute((r, id) => {
      const { useCodeIntel, grantKey } = (window as any).__termic.codeIntel;
      useCodeIntel.getState().release(grantKey(r, "typescript"), id);
    }, root, taskId);
    await chipAction("code-intel-turn-on-for-this-task");
    await browser.waitUntil(() => isArmed(root), {
      timeout: 5_000, timeoutMsg: "the second arm did not go through",
    });
    const dialogs = await browser.execute(() =>
      document.querySelectorAll('[data-testid="confirm-ok"]').length);
    expect(dialogs).toBe(0);
  });

  it("treats each language in one repo as its own decision", async () => {
    // The Django case: Python and the JavaScript in its templates are two
    // servers with two memory bills, so agreeing to one must not start the
    // other. A per-checkout grant would have.
    await browser.execute(() => window.__termic!.useCodeIntel.setState({ grants: {} }));
    writeFileSync(path.join(root, "helper.py"), "def helper(x):\n    return x\n");
    await openSettled(taskId, "helper.py", "Python");
    await waitVisible('[data-testid="code-intel-chip"]');
    await armGrant(root, taskId, "python");
    expect(await isArmed(root, "python")).toBe(true);
    // TypeScript in the same checkout is still unarmed, and its chip still
    // reads as an offer rather than as on.
    expect(await isArmed(root, "typescript")).toBe(false);
    await openSettled(taskId, "navme.ts", "TypeScript");
    // The label is the same either way (colour and the dot carry the state),
    // so the tooltip heading is what says which one this is: an OFFER for
    // TypeScript, not a running server.
    await waitVisible('[data-testid="code-intel-chip"]');
    // The panel the chip opens names the language it is about. One surface:
    // there is no hover tooltip beside it any more, because two things to read
    // for one decision is one too many.
    await browser.execute(() => {
      (document.querySelector('[data-testid="code-intel-chip"]') as HTMLElement).click();
    });
    await browser.waitUntil(async () => ((await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="code-intel-panel"]')]
        .map(t => (t as HTMLElement).innerText).join(" "))) as string)
      .includes("TypeScript"), {
      timeout: 5_000,
      timeoutMsg: "the panel never named TypeScript",
    });
    // Closed again, so the next case starts from a clean window.
    await browser.keys(["Escape"]);
    // And no TypeScript server is running for it. `waitUntil`, not a bare
    // read: a server from an earlier case is inside its reap grace, and the
    // point here is that nothing STARTS one, not that one cannot still be
    // shutting down.
    await browser.waitUntil(async () => {
      const servers = await browser.execute(async () =>
        await window.__termic!.invoke("lsp_list")) as any[];
      return !servers.some(s => s.language === "typescript");
    }, { timeout: 10_000, timeoutMsg: "a TypeScript server ran for an unarmed language" });
    // Leave nothing running for the next case, and WAIT for it: stopping is a
    // request, and a server that was still starting when the request landed
    // would otherwise turn up afterwards and be counted by the case that
    // asserts one server per checkout.
    await browser.execute(() => window.__termic!.useCodeIntel.setState({ grants: {} }));
    await browser.waitUntil(async () => {
      const left = await browser.execute(async () => {
        const servers: any[] = await window.__termic!.invoke("lsp_list");
        for (const s of servers) await window.__termic!.invoke("lsp_stop", { id: s.id });
        return servers.length;
      }) as number;
      return left === 0;
    }, { timeout: 15_000, timeoutMsg: "a server outlived the case that started it" });
    rmSync(path.join(root, "helper.py"), { force: true });
  });

  it("drives a real server once the checkout is armed", async () => {
    await openSettled(taskId, "navme.ts", "TypeScript");
    await armGrant(root, taskId);
    // The observable end of the pipe: a diagnostic the server pushed, rendered
    // by the `lintGutter()` EditorPane has had mounted with no source since the
    // day it was written.
    await waitVisible(`[data-task-id="${taskId}"] .cm-lintRange`, 30_000);

    const seen = JSON.parse(readFileSync(path.join(root, ".fake-lsp.json"), "utf8"));
    // 1. The handshake carried BOTH roots. The CM client sends only rootUri;
    //    a server that reads only workspaceFolders (ruby-lsp) would otherwise
    //    index nothing, silently.
    expect(seen.initialize.workspaceFolders[0].uri).toContain(root.split(/[\\/]/).pop());
    expect(seen.initialize.rootUri).toContain("file://");
    // 2. The server→client request was answered, with the right ARITY. This
    //    is the reply the CM client would have sent -32601 to, and the one ty
    //    asserts the length of before it will do anything.
    expect(seen.configReply).toEqual([null, null]);
    // 3. The document was synced with the LSP's own languageId, not
    //    CodeMirror's registry name ("TypeScript").
    expect(seen.opened[0].languageId).toBe("typescript");
    expect(seen.opened[0].uri).toContain("navme.ts");
  });

  it("spawns the server at the checkout, not wherever termic was launched", async () => {
    // A wrong cwd is not cosmetic: it is what makes a server index the user's
    // whole home directory. The fixture writes its log relative to its OWN
    // cwd, so WHERE that file landed is the assertion.
    //
    // Both halves, because only the pair says anything. Asserting it exists
    // under the checkout duplicates the case above (which reads the same file);
    // asserting it does NOT exist where termic itself was launched is the part
    // that fails if the child inherits the app's cwd, and nothing else covers
    // it.
    expect(existsSync(path.join(root, ".fake-lsp.json"))).toBe(true);
    expect(existsSync(path.join(process.cwd(), ".fake-lsp.json"))).toBe(false);
  });

  it("shares one server between tasks on the same checkout", async () => {
    const second = await openTask("lsp-nav-2");
    const secondRoot = await taskPath(second) as string;
    expect(secondRoot).toBe(root);   // both are main-checkout tasks
    await armGrant(root, second);
    await openSettled(second, "navme.ts", "TypeScript");
    await waitVisible(`[data-task-id="${second}"] .cm-lintRange`, 30_000);
    // One index, not two. At rust-analyzer's ~3 GB the difference between
    // these two numbers is the whole reason the unit is the checkout.
    const servers = await browser.execute(async () =>
      await window.__termic!.invoke("lsp_list")) as any[];
    if (servers.length !== 1) {
      throw new Error(`expected one server, saw: ${JSON.stringify(servers.map(s => ({ l: s.language, r: s.root })))}`);
    }
    expect(servers[0].root).toBe(root);
    await archiveTask(second);
    await ensureActiveTask(taskId);
  });

  it("lists the server in Activity, where it can be stopped", async () => {
    // These are the first thing termic runs that can cost more than every
    // agent in the window combined, so they are sampled like everything else
    // rather than described in a settings pane.
    //
    // Starts its OWN server. It used to assert on whatever the previous case
    // had left running inside its 1.5s reap grace, so reordering the file — or
    // that case reaping a beat sooner — would have failed it for a reason
    // having nothing to do with Activity.
    await armGrant(root, taskId);
    await openSettled(taskId, "navme.ts", "TypeScript");
    await browser.waitUntil(async () =>
      ((await browser.execute(async () =>
        await window.__termic!.invoke("lsp_list"))) as any[]).length >= 1,
      { timeout: 30_000, timeoutMsg: "no server for Activity to list" });
    const rows = await browser.execute(async () => {
      const t = window.__termic!;
      const first: any = await t.invoke("procmon_start");
      await t.invoke("procmon_stop", { session: first.session });
      return first.rows;
    }) as any[];
    const server = rows.find(r => r.kind === "lsp");
    // Asserted before it is dereferenced: `server.pid` on undefined throws a
    // raw TypeError instead of reporting which expectation failed.
    if (!server) throw new Error(`no lsp row in Activity: ${JSON.stringify(rows.map(r => r.kind))}`);
    expect(server.pid).toBeGreaterThan(1);
    // No taskId: it belongs to the checkout, and filing it under one task
    // would misrepresent what stopping it costs.
    expect(server.taskId ?? null).toBeNull();
  });

  it("says what the server is doing while it cannot answer yet", async () => {
    // A server that is starting or indexing returns nothing to a hover, which
    // is indistinguishable from a broken feature unless the UI says so. The
    // chip shows a pulsing dot instead of its compass, and the detail is in
    // the tooltip: a label that changed on every percentage would reflow the
    // path bar under the reader.
    await openSettled(taskId, "navme.ts", "TypeScript");
    await armGrant(root, taskId);
    await waitVisible('[data-testid="code-intel-chip"]');
    // The tooltip is a real one (Radix), not a `title` attribute, so reading
    // it means opening it. Radix opens on focus as well as hover, and focus is
    // the one a spec can drive reliably.
    // One surface now: what the server is doing lives in the panel the chip
    // OPENS, not in a hover tooltip beside it. Opened once and then read
    // repeatedly, because the panel re-renders from the same store the phases
    // are written to.
    await browser.execute(() => {
      (document.querySelector('[data-testid="code-intel-chip"]') as HTMLElement).click();
    });
    await waitVisible('[data-testid="code-intel-panel"]', 10_000);
    const chip = async () => {
      return await browser.execute(() => {
        const el = document.querySelector('[data-testid="code-intel-chip"]') as HTMLElement | null;
        const tip = [...document.querySelectorAll('[data-testid="code-intel-panel"]')]
          .filter(t => t.getBoundingClientRect().width > 0)
          .map(t => (t as HTMLElement).innerText)
          .join(" ");
        return {
          text: el?.innerText ?? "",
          tip,
          busy: !!el?.querySelector('[data-testid="code-intel-busy"]'),
        };
      }) as { text: string; tip: string; busy: boolean };
    };
    const setPhase = (phase: string, extra: Record<string, unknown> = {}) =>
      browser.execute((r, ph, ex) => {
        const { useLspStatus, statusKey } = (window as any).__termic.lspStatus;
        useLspStatus.getState().set(statusKey(r, "typescript"), { phase: ph, ...(ex as object) });
      }, root, phase, extra);

    // Driven through the store the client writes to: a real server races
    // through these far too fast to catch, and what is under test is that the
    // chip renders each one.
    await setPhase("starting");
    await browser.waitUntil(async () => (await chip()).busy, {
      timeout: 5_000, timeoutMsg: "the chip never showed it was busy",
    });
    await browser.waitUntil(async () => (await chip()).tip.includes("incomplete"), {
      timeout: 5_000, timeoutMsg: "the tooltip never explained the wait",
    });

    await setPhase("indexing", { message: "Loading crate graph", percent: 42 });
    await browser.waitUntil(async () => (await chip()).tip.includes("Loading crate graph 42%"), {
      timeout: 5_000, timeoutMsg: "the tooltip never showed the server's own progress",
    });
    const indexing = await chip();
    expect(indexing.busy).toBe(true);
    // The label holds still; the detail is in the tooltip.
    expect(indexing.text).toContain("Code intelligence");

    await setPhase("ready");
    await browser.waitUntil(async () => !(await chip()).busy, {
      timeout: 5_000, timeoutMsg: "the dot never stopped pulsing",
    });
    const ready = await chip();
    expect(ready.text).toContain("Code intelligence");
    // Nothing to explain once it works, and the tooltip names the server that
    // is answering rather than leaving the reader to guess.
    expect(ready.tip).not.toContain("incomplete");
    expect(ready.tip).toContain("TypeScript 7");
  });

  it("completes from the server, not just from words already in the buffer", async () => {
    // The gap this closes: `basicSetup` ships a local word scraper, so the
    // popup was never empty and the feature looked wired when it was not. It
    // could offer `StorePage` because that word was on screen, and could never
    // offer `.objects` on it. The fixture answers with a label that appears
    // nowhere in the file, which only the server can be the source of.
    await openSettled(taskId, "navme.ts", "TypeScript");
    await armGrant(root, taskId);
    await waitVisible(`[data-task-id="${taskId}"] .cm-lintRange`, 30_000);

    await browser.execute((id) => {
      const dom = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as
        (HTMLElement & { __cmView?: any }) | null;
      const view = dom!.__cmView;
      view.focus();
      // Type a trigger character at the end of the buffer, the way a person
      // reaches for a member.
      const at = view.state.doc.length;
      view.dispatch({ changes: { from: at, insert: "\nanswer." }, selection: { anchor: at + 8 } });
    }, taskId);
    await browser.execute(() => {
      const { startCompletion } = (window as any).__termic.cm;
      const dom = document.querySelector(".cm-editor") as (HTMLElement & { __cmView?: any });
      startCompletion(dom.__cmView);
    });

    await browser.waitUntil(async () => {
      const labels = await browser.execute(() =>
        [...document.querySelectorAll(".cm-tooltip-autocomplete li")]
          .map(li => (li as HTMLElement).innerText)) as string[];
      return labels.some(l => l.includes("fakeLspOnlySymbol"));
    }, { timeout: 15_000, timeoutMsg: "the server's completion never reached the popup" });

    await browser.keys("Escape");
  });

  it("goes to the definition on a modified click, and lists usages when already there", async () => {
    // IntelliJ's gesture, and the half people miss when they leave it:
    // ⌘-clicking the DEFINITION is not a no-op, it answers "who uses this".
    // The fixture puts the definition at line 1, columns 13-19, so a click
    // inside that range is "already there" and a click elsewhere is a usage.
    await openSettled(taskId, "navme.ts", "TypeScript");
    await armGrant(root, taskId);
    await waitVisible(`[data-task-id="${taskId}"] .cm-lintRange`, 30_000);

    /** Drive the gesture at a document offset. A synthesised mousedown with
     *  real client coordinates, because the handler reads them from the event
     *  the way a pointer would deliver them. */
    const modClickAt = (offset: number) =>
      browser.execute((id, at) => {
        const dom = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as
          (HTMLElement & { __cmView?: any }) | null;
        const view = dom!.__cmView;
        const rect = view.coordsAtPos(at);
        view.contentDOM.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true, cancelable: true, [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, button: 0,
          clientX: rect.left + 1, clientY: (rect.top + rect.bottom) / 2,
        }));
      }, taskId, offset);

    // navme.ts is `export const answer = 42;`, so `answer` spans offsets
    // 13-19 — which is exactly the range the fixture calls the definition.
    // Clicking INSIDE it is "you are already there": usages.
    await modClickAt(15);
    await browser.waitUntil(async () => await browser.execute((id) =>
      !!document.querySelector(`[data-task-id="${id}"] .cm-lsp-usages`), taskId), {
      timeout: 10_000,
      timeoutMsg: "clicking the definition did not list its usages",
    });
    const rows = await browser.execute((id) =>
      document.querySelectorAll(`[data-task-id="${id}"] .cm-lsp-usages-row`).length, taskId) as number;
    expect(rows).toBeGreaterThan(0);

    // The fixture reports the first location TWICE, the way a real server does
    // when a reference comes from both the open document and the index. Three
    // usages, three rows: the popup used to list four, so four usages read as
    // eight with the same line numbers twice over.
    expect(rows).toBe(3);

    // And each row says WHICH file. Two files here are called navme.ts, so
    // every row pays for a path; with one file they would all stay on the bare
    // name (`lib/lsp/usageLabels.ts` decides, and is unit-tested).
    const labels = await browser.execute((id) =>
      [...document.querySelectorAll(`[data-task-id="${id}"] .cm-lsp-usages-file`)]
        .map(el => (el as HTMLElement).textContent), taskId) as string[];
    expect(labels).toEqual(["navme.ts", "navme.ts", "nested/navme.ts"]);

    // Clicking somewhere that is NOT the definition jumps there instead of
    // opening the panel again.
    await browser.execute((id) => {
      const dom = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as HTMLElement;
      dom.querySelector(".cm-content")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }, taskId);
    await browser.waitUntil(async () => await browser.execute((id) =>
      !document.querySelector(`[data-task-id="${id}"] .cm-lsp-usages`), taskId), {
      timeout: 5_000, timeoutMsg: "the usages popup would not close",
    });
    // Offset 2 is inside `export`, outside the definition's range, so the
    // fixture's answer is a place to go rather than a list.
    await modClickAt(2);
    await browser.waitUntil(async () => {
      const head = await browser.execute((id) => {
        const dom = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as
          (HTMLElement & { __cmView?: any }) | null;
        return dom!.__cmView.state.selection.main.head as number;
      }, taskId) as number;
      // The fixture's definition starts at line 1 column 14 (0-based 13).
      return head === 13;
    }, { timeout: 10_000, timeoutMsg: "the click did not jump to the definition" });
  });

  it("goes back to where you came from", async () => {
    // Following a definition is a one-way trip without this, and reading
    // unfamiliar code is a sequence of trips you need to come back from.
    //
    // Its own file, with the departure on a DIFFERENT LINE from the target:
    // the history records places, not offsets, so a jump within one line is
    // deliberately not a jump (Back must not mean "one column left").
    writeFileSync(path.join(root, "navback.ts"),
      "export const answer = 42;\n\nconst a = 1;\nconst b = answer;\n");
    await openSettled(taskId, "navback.ts", "TypeScript");
    await armGrant(root, taskId);
    await waitEditorVisible(taskId);

    const head = () => browser.execute((id) => {
      // The VISIBLE editor: inactive tabs stay mounted at display:none, and
      // the first one in the DOM is often a hidden tab.
      // Visible AND driveable: a diff view is also a `.cm-editor`, and it
      // carries no `__cmView`, so width alone picks the wrong element.
      const dom = [...document.querySelectorAll(`[data-task-id="${id}"] .cm-editor`)]
        .find(el => el.getBoundingClientRect().width > 0
          && (el as any).__cmView) as (HTMLElement & { __cmView?: any });
      return dom.__cmView.state.selection.main.head as number;
    }, taskId) as Promise<number>;

    /** CodeMirror binds on the content element's keydown, and WebDriver's own
     *  key events do not route a modified chord into a contenteditable in
     *  WKWebView. Dispatching there is the honest input path for a keymap. */
    const pressInEditor = (key: string, mods: Record<string, boolean> = {}) =>
      browser.execute((id, k, m) => {
        const dom = [...document.querySelectorAll(`[data-task-id="${id}"] .cm-editor`)]
          .find(el => el.getBoundingClientRect().width > 0 && (el as any).__cmView) as HTMLElement;
        const content = dom.querySelector(".cm-content") as HTMLElement;
        content.focus();
        content.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...(m as object) }));
      }, taskId, key, mods);

    // Stand on the last line, then jump to the definition (line 1).
    await browser.execute((id) => {
      const dom = [...document.querySelectorAll(`[data-task-id="${id}"] .cm-editor`)]
        .find(el => el.getBoundingClientRect().width > 0
          && (el as any).__cmView) as (HTMLElement & { __cmView?: any });
      const view = dom.__cmView;
      view.dispatch({ selection: { anchor: view.state.doc.line(4).from + 10 } });
    }, taskId);
    const startedAt = await head();
    await pressInEditor("F12");
    await browser.waitUntil(async () => (await head()) === 13, {
      timeout: 10_000, timeoutMsg: "F12 did not jump to the definition",
    });

    // Back returns to the CALL SITE, not to the previous definition. ⌘[ is
    // IntelliJ's key; it is Previous Task app-wide and claimed CONDITIONALLY
    // here, the same way a folder listing already claims it (issue #151).
    await pressInEditor("[", { [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true });
    await browser.waitUntil(async () => Math.abs((await head()) - startedAt) <= 1, {
      timeout: 10_000,
      timeoutMsg: "Back did not return to where the jump started",
    });

    // And Forward retraces it.
    await pressInEditor("]", { [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true });
    await browser.waitUntil(async () => (await head()) === 13, {
      timeout: 10_000, timeoutMsg: "Forward did not retrace the jump",
    });
    rmSync(path.join(root, "navback.ts"), { force: true });
  });

  it("lists what is in the file, filtered as you type", async () => {
    // IntelliJ's ⌘F12. Opening an unfamiliar file and scrolling to learn what
    // is in it is the slowest thing a reader does.
    await openSettled(taskId, "navme.ts", "TypeScript");
    await armGrant(root, taskId);
    await waitVisible(`[data-task-id="${taskId}"] .cm-lintRange`, 30_000);
    await browser.execute((id) => {
      const dom = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as HTMLElement;
      const content = dom.querySelector(".cm-content") as HTMLElement;
      content.focus();
      content.dispatchEvent(new KeyboardEvent("keydown", {
        key: "F12", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, bubbles: true, cancelable: true,
      }));
    }, taskId);
    await waitVisible(`[data-task-id="${taskId}"] .cm-lsp-outline`, 10_000);
    const names = await browser.execute((id) =>
      [...document.querySelectorAll(`[data-task-id="${id}"] .cm-lsp-outline-name`)]
        .map(el => (el as HTMLElement).textContent), taskId) as string[];
    // The fixture answers with a class containing a method: both, nested.
    expect(names).toContain("FakeClass");
    expect(names).toContain("fakeMethod");
    await browser.execute((id) => {
      const input = document.querySelector(`[data-task-id="${id}"] .cm-lsp-outline-input`) as HTMLElement;
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }, taskId);
  });

  /** Close it and wait for the state, not the node (see the comment inside). */
  const closeSearchEverywhere = async () => {
    await browser.execute(() => window.__termic!.useUI.getState().closeSearchEverywhere());
    await browser.waitUntil(async () => await browser.execute(() =>
      window.__termic!.useUI.getState().searchEverywhereTaskId === null), {
      timeout: 5_000, timeoutMsg: "Search Everywhere would not close",
    });
  };

  // The gesture has no chord to rebind, so someone whose typing keeps opening
  // it (two taps of the key that starts every capital) needs an off switch,
  // and off has to mean the keystrokes do nothing rather than the dialog
  // opening and closing again.
  it("obeys the double-Shift mode: off, left-only, either", async () => {
    await ensureActiveTask(taskId);
    const doubleShift = (location = 1) => browser.execute((loc) => {
      for (const _ of [0, 1]) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", location: loc, bubbles: true }));
      }
    }, location);
    const open = () => browser.execute(() =>
      window.__termic!.useUI.getState().searchEverywhereTaskId !== null);

    const setMode = (m: string) => browser.execute((mode) =>
      window.__termic!.usePrefs.getState().setDoubleShiftMode(mode as any), m);

    try {
      // Off: neither Shift does anything. Nothing to wait FOR, so the gesture
      // is dispatched twice over and the state read after both.
      await setMode("off");
      await doubleShift(1);
      await doubleShift(1);
      expect(await open()).toBe(false);

      // Left-only (the default): the right Shift stays inert...
      await setMode("left");
      await doubleShift(2);
      await doubleShift(2);
      expect(await open()).toBe(false);
      // ...and the left one opens it.
      await doubleShift(1);
      await browser.waitUntil(async () => (await open()) as boolean,
        { timeout: 5_000, timeoutMsg: "the left Shift did not open it" });
      await closeSearchEverywhere();

      // Either: the right Shift works too, which is JetBrains' own behaviour.
      await setMode("any");
      await doubleShift(2);
      await browser.waitUntil(async () => (await open()) as boolean,
        { timeout: 5_000, timeoutMsg: "the right Shift did not open it in any mode" });
      await closeSearchEverywhere();
    } finally {
      await setMode("left");
    }
  });

  // The optional chord (unbound by default). It has to work from where people
  // are, which is a focused terminal: xterm takes every key it is not told to
  // let go of, so this is TerminalPane's PASS_TO_APP being exercised, and with
  // double-Shift off the chord is the only way the dialog can have opened.
  it("opens Search Everywhere on a recorded chord, from a focused terminal, with double-Shift off", async () => {
    await ensureActiveTask(taskId);
    // The cases above leave an EDITOR tab in front (navme.ts), and an editor
    // tab hides the agent's terminal. Bring the agent tab forward and wait
    // until its terminal is actually laid out, or there is nothing to focus.
    await waitForAgentReady(taskId);
    const previousTab = await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const prev = s.activeTab[id] as string | undefined;
      const agent = (s.tabs[id] ?? []).find((t: any) => t.type === "terminal" && !t.paneId);
      if (!agent) throw new Error(`task ${id} has no agent terminal tab`);
      s.setActiveTabId(id, agent.id);
      return prev ?? null;
    }, taskId);
    await browser.waitUntil(() => browser.execute((id) => {
      const host = document.querySelector(`[data-task-id="${id}"]`);
      return !!host && [...host.querySelectorAll(".xterm-helper-textarea")].some(el => {
        const r = (el.closest(".xterm") ?? el).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    }, taskId), { timeout: 10_000, timeoutMsg: "the agent terminal never became visible" });
    const mac = process.platform === "darwin";
    const original = await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      return { mode: p.doubleShiftMode, chord: p.shortcuts["search-everywhere"] };
    });
    try {
      await browser.execute(() => {
        const p = window.__termic!.usePrefs.getState();
        p.setDoubleShiftMode("off");
        p.setShortcut("search-everywhere", { cmd: true, shift: true, alt: false, key: "o" });
      });
      await browser.execute((id, isMac) => {
        const host = document.querySelector(`[data-task-id="${id}"]`);
        if (!host) throw new Error(`task ${id} is not mounted`);
        const ta = [...host.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea")]
          .find(el => {
            const r = (el.closest(".xterm") ?? el).getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
        if (!ta) throw new Error(`no visible terminal in ${id}`);
        ta.focus();
        // keyCode too: xterm's own handler switches on it, and an event it
        // could not read would prove nothing about what it let through.
        const k = {
          bubbles: true, cancelable: true, key: "O", code: "KeyO", keyCode: 79, which: 79,
          metaKey: isMac, ctrlKey: !isMac, shiftKey: true,
        };
        ta.dispatchEvent(new KeyboardEvent("keydown", k));
        ta.dispatchEvent(new KeyboardEvent("keyup", k));
      }, taskId, mac);
      await browser.waitUntil(async () => await browser.execute(() =>
        window.__termic!.useUI.getState().searchEverywhereTaskId !== null), {
        timeout: 5_000, timeoutMsg: "the recorded chord did not open Search Everywhere from the terminal",
      });
      await closeSearchEverywhere();
    } finally {
      await browser.execute((o) => {
        const p = window.__termic!.usePrefs.getState();
        p.setDoubleShiftMode(o.mode as any);
        if (o.chord) p.setShortcut("search-everywhere", o.chord as any);
        else p.resetShortcut("search-everywhere");
      }, original);
      // Put back whatever tab was in front, so the cases after this one see
      // the task the way the cases before it left it.
      if (previousTab) {
        await browser.execute((id, tab) =>
          window.__termic!.useApp.getState().setActiveTabId(id, tab), taskId, previousTab);
      }
    }
  });

  it("opens Search Everywhere on double-Shift, files first and symbols when armed", async () => {
    // Most people never turn code intelligence on, so this dialog has to be
    // useful without it: files always, symbols merged in when a checkout is
    // armed. ⌘P is deliberately untouched.
    await ensureActiveTask(taskId);
    // location 1 = the LEFT Shift, the only one that fires this.
    const doubleShift = () => browser.execute(() => {
      for (const _ of [0, 1]) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", location: 1, bubbles: true }));
      }
    });

    // With nothing armed: the dialog still opens, and offers to add symbols.
    await browser.execute(() => window.__termic!.useCodeIntel.setState({ grants: {} }));
    await doubleShift();
    // The INPUT, not the dialog itself: the panel fades in, and CSS
    // animations are frozen while the window is occluded (which the harness
    // always is), so the animated element never reports a non-zero opacity.
    // A child's computed opacity is its own, so it reads as visible.
    await waitVisible('[data-testid="search-everywhere-input"]');
    await browser.execute(() => {
      const input = document.querySelector('[data-testid="search-everywhere-input"]') as HTMLInputElement;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "navme");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.waitUntil(async () => await browser.execute(() =>
      document.querySelectorAll('[data-testid="se-file-row"]').length > 0), {
      timeout: 10_000, timeoutMsg: "no file results with code intelligence off",
    });
    // The discovery point for someone who has never turned it on. It arrives
    // after one IPC probe per language, so it is waited for rather than read
    // once.
    // Two shapes, one meaning. When a file of that language is focused the
    // offer is a row you can press Enter on; with no editor to take a language
    // from it is a button in the footer beside every other servable language.
    // The spec cares that the offer EXISTS, not which of the two it is.
    await browser.waitUntil(async () => await browser.execute(() =>
      !!document.querySelector(
        '[data-testid="se-arm-typescript"], [data-testid="se-offer-row"][data-server="typescript"]',
      )), {
      timeout: 10_000,
      timeoutMsg: "the dialog never offered to add symbols",
    });

    // Closed, asserted on STATE rather than removal: Radix defers a dialog's
    // unmount until its close animation ends, and animations are frozen while
    // the window is occluded, so the node outlives the close forever here.
    await closeSearchEverywhere();

    // Armed: the server's symbols appear too. The fixture answers with a name
    // that is in no file, so only the server can be its source.
    await armGrant(root, taskId);
    await openSettled(taskId, "navme.ts", "TypeScript");
    await waitVisible(`[data-task-id="${taskId}"] .cm-lintRange`, 30_000);
    await doubleShift();
    await waitVisible('[data-testid="search-everywhere-input"]');
    await browser.execute(() => {
      const input = document.querySelector('[data-testid="search-everywhere-input"]') as HTMLInputElement;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "fake");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.waitUntil(async () => {
      const names = await browser.execute(() =>
        [...document.querySelectorAll('[data-testid="se-symbol-row"]')]
          .map(el => (el as HTMLElement).innerText)) as string[];
      return names.some(n => n.includes("fakeWorkspaceSymbol"));
    }, { timeout: 15_000, timeoutMsg: "the server's symbols never reached the dialog" });
    await closeSearchEverywhere();
  });

  it("turns off means off now, not in three minutes", async () => {
    // The grace period exists so a tab bounce does not pay for a re-index. An
    // explicit "off" is a decision, and the usual reason for it is that the
    // environment changed underneath the server (a package installed, a branch
    // switched). Handing back the cached client there would be the same
    // process with the same stale view of the project, and the feature would
    // look broken for a reason the user cannot see.
    await openSettled(taskId, "navme.ts", "TypeScript");
    await waitVisible('[data-testid="code-intel-chip"]');
    await armGrant(root, taskId);
    await browser.waitUntil(async () =>
      ((await browser.execute(async () =>
        await window.__termic!.invoke("lsp_list"))) as any[]).length === 1,
      { timeout: 30_000, timeoutMsg: "no server to turn off" });

    // Through the CHIP, which is the path a person takes: its popover is the
    // same one Search Everywhere opens, so "off" means the same in both.
    await chipAction("code-intel-turn-off");
    // Immediately: no reap grace, however short the test build makes it.
    await browser.waitUntil(async () =>
      ((await browser.execute(async () =>
        await window.__termic!.invoke("lsp_list"))) as any[]).length === 0,
      { timeout: 3_000, timeoutMsg: "the server survived being turned off" });
    expect(await isArmed(root)).toBe(false);
  });

  it("reaps the server a grace period after its last editor closes", async () => {
    // The memory story in one case: a server outlives a tab bounce, and does
    // not outlive the reader walking away. (The grace is 1.5s in the e2e
    // build, 3 minutes in a real one.)
    await openSettled(taskId, "navme.ts", "TypeScript");
    await armGrant(root, taskId);
    await waitVisible(`[data-task-id="${taskId}"] .cm-lintRange`, 30_000);
    const running = async () =>
      ((await browser.execute(async () => await window.__termic!.invoke("lsp_list"))) as any[]).length;
    expect(await running()).toBe(1);

    // Close EVERY editor on this checkout: earlier cases in this file leave
    // their own tabs open, and one editor still holding the client is exactly
    // what the refcount is for.
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      for (const tab of (app.tabs[id] ?? []).filter((t: any) => t.type === "edit" || t.type === "external")) {
        app.closeTab(id, tab.id);
      }
    }, taskId);
    await browser.waitUntil(async () => (await running()) === 0, {
      timeout: 15_000,
      timeoutMsg: "the server outlived its last editor",
    });
    // The GRANT survives: the checkout is still armed, so reopening a file
    // starts a server again without asking. That is the difference between the
    // grant (which lapses with the task) and the process (which lapses with
    // the editors).
    expect(await isArmed(root)).toBe(true);
  });

  it("says No usages rather than nothing when a symbol has none", async () => {
    // ⌘-clicking a definition asks "who calls this". An empty answer is the
    // one people most need to see (nobody calls the function you were about
    // to change), and it used to render as silence, which is indistinguishable
    // from the feature being broken.
    // `lonely` sits at columns 13-19 of line 10, which is where the fixture
    // says its definition is: clicking it is therefore "you are already at the
    // definition", which is the branch that asks for callers.
    const lonely = "export const answer = 42;\n".repeat(9) + "export const lonely = 1;\n";
    writeFileSync(path.join(root, "lonely.ts"), lonely);
    await armGrant(root, taskId);
    await openSettled(taskId, "lonely.ts", "TypeScript");
    // Line 10 (0-based 9) is the one the fixture answers with no references.
    await modClickWord(taskId, "lonely");
    await waitVisible(`[data-task-id="${taskId}"] .cm-lsp-usages`, 15_000);
    const head = await browser.execute((id) =>
      (document.querySelector(`[data-task-id="${id}"] .cm-lsp-usages-count`) as HTMLElement)?.innerText ?? "",
      taskId) as string;
    expect(head).toBe("No usages");
    // Header only: no empty scroll box pretending there is a list to read.
    const rows = await browser.execute((id) =>
      document.querySelectorAll(`[data-task-id="${id}"] .cm-lsp-usages-row`).length, taskId) as number;
    expect(rows).toBe(0);
    rmSync(path.join(root, "lonely.ts"), { force: true });
  });

  it("resizes the usages list from its corner and remembers the size", async () => {
    // A long relative path and a long line of code cannot both fit in the
    // default box, and the list is useless while both are ellipsized. So the
    // corner drags, the next popup opens at that size, and every row carries
    // its full path as a tooltip for the label that still does not fit.
    await browser.execute(() => { try { localStorage.removeItem("usagesPopupSize"); } catch { /* */ } });
    await armGrant(root, taskId);
    await openSettled(taskId, "navme.ts", "TypeScript");
    const popup = `[data-task-id="${taskId}"] .cm-lsp-usages`;
    const closePopup = async () => {
      await browser.execute((id) => {
        document.querySelector(`[data-task-id="${id}"] .cm-content`)!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }, taskId);
      await waitGone(popup, 5_000);
    };
    const box = () => browser.execute((sel) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height) };
    }, popup) as Promise<{ width: number; height: number }>;

    await modClickWord(taskId, "answer");
    await waitVisible(popup, 15_000);

    // Rows: the tooltip is the absolute path and line, not the short label.
    const titles = await browser.execute((sel) =>
      [...document.querySelectorAll(`${sel} .cm-lsp-usages-row`)].map(el => (el as HTMLElement).title), popup) as string[];
    expect(titles.length).toBe(3);
    for (const t of titles) expect(t).toMatch(/^(\/|[A-Za-z]:\\).*navme\.ts:\d+$/);
    expect(titles[2]).toMatch(/[\\/]nested[\\/]navme\.ts:/);
    const footerTitle = await browser.execute((sel) =>
      (document.querySelector(`${sel} .cm-lsp-usages-footer`) as HTMLElement).title, popup) as string;
    expect(footerTitle).toMatch(/^(\/|[A-Za-z]:\\).*navme\.ts$/);

    // Height assertions are relative to the room actually below the popup.
    // CodeMirror already shrinks a tooltip to the space under its anchor, and
    // the CI runner's window is short enough that the popup opens flush with
    // its bottom edge: "drag 60px taller" then has nowhere to go and is
    // correctly clamped. So shrink first (always possible above the minimum),
    // then grow back by less than was taken, which must fit.
    const roomBelow = () => browser.execute((sel) =>
      Math.round(window.innerHeight - document.querySelector(sel)!.getBoundingClientRect().top - 8), popup) as Promise<number>;
    // Whatever holds focus before the drag must still hold it after: the grip
    // prevents the mousedown default. (The synthetic ⌘-click that opened the
    // popup does not focus the editor on every runner, so "the editor has
    // focus" would test the harness, not the grip.)
    const focusMark = () => browser.execute(() => {
      const ae = document.activeElement as HTMLElement | null;
      return ae ? `${ae.tagName}.${ae.className}` : "none";
    }) as Promise<string>;
    const focusBefore = await focusMark();
    const before = await box();
    await mouseDrag(`${popup} .cm-lsp-usages-grip`, 120, -30);
    const after = await box();
    expect(after.width).toBe(before.width + 120);
    expect(after.height).toBe(Math.max(120, before.height - 30));
    const grown = Math.min(after.height + 20, await roomBelow());
    await mouseDrag(`${popup} .cm-lsp-usages-grip`, 0, 20);
    expect((await box()).height).toBe(Math.max(120, grown));
    await snap("usages-resized");

    // Dragging did not move focus, so the list's keyboard stays where it was.
    expect(await focusMark()).toBe(focusBefore);

    // Smaller than the minimum clamps instead of collapsing the list.
    await mouseDrag(`${popup} .cm-lsp-usages-grip`, -2000, -2000);
    const tiny = await box();
    expect(tiny.width).toBe(320);
    await mouseDrag(`${popup} .cm-lsp-usages-grip`, after.width - tiny.width, 0);
    const widened = await box();
    expect(widened.width).toBe(after.width);

    // The next popup opens at the remembered width. Height is a cap, so three
    // rows keep their natural height rather than filling a tall box.
    await closePopup();
    await modClickWord(taskId, "answer");
    await waitVisible(popup, 15_000);
    const reopened = await box();
    expect(reopened.width).toBe(after.width);
    expect(reopened.height).toBeLessThanOrEqual(before.height + 1);
    await closePopup();
    await browser.execute(() => { try { localStorage.removeItem("usagesPopupSize"); } catch { /* */ } });
  });

  it("answers a modified click even with no server running", async () => {
    // Silence was the old behaviour: ⌘-click with the checkout unarmed did
    // nothing at all, which reads as a broken editor rather than an unarmed
    // feature. Now the click offers the thing it needs.
    await clearGrants();
    await openSettled(taskId, "navme.ts", "TypeScript");
    await modClickWord(taskId, "answer");
    await waitVisible(`[data-task-id="${taskId}"] .cm-lsp-navhint`, 10_000);
    const text = await browser.execute((id) =>
      (document.querySelector(`[data-task-id="${id}"] .cm-lsp-navhint`) as HTMLElement)?.innerText ?? "",
      taskId) as string;
    expect(text).toContain("off for this project");

    // And the offer is the same act as the chip: pressing it arms THIS
    // checkout for THIS language.
    await browser.execute((id) => {
      const btn = document.querySelector(
        `[data-task-id="${id}"] .cm-lsp-navhint-action`,
      ) as HTMLElement;
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    }, taskId);
    await browser.waitUntil(async () => await isArmed(root), {
      timeout: 10_000, timeoutMsg: "the hint's offer did not arm the checkout",
    });
    // And it gets out of the way. Leaving "Code intelligence is off for this
    // project" on screen after the server has started says the button did
    // nothing, which is the one thing it definitely did not do.
    await waitGone(`[data-task-id="${taskId}"] .cm-lsp-navhint`, 10_000);
  });

  it("says so plainly for a language nothing can serve", async () => {
    // A Makefile is never going to have go-to-definition, and the honest
    // answer stops the reader trying.
    writeFileSync(path.join(root, "Makefile"), "build:\n\t@echo hi\n");
    // A Makefile DOES open in CodeMirror (it is not a preview shell like
    // markdown), so wait for the editor: the click needs a view.
    await openSettled(taskId, "Makefile", "Makefile");
    await modClickWord(taskId, "build");
    await waitVisible(`[data-task-id="${taskId}"] .cm-lsp-navhint`, 10_000);
    const text = await browser.execute((id) =>
      (document.querySelector(`[data-task-id="${id}"] .cm-lsp-navhint`) as HTMLElement)?.innerText ?? "",
      taskId) as string;
    expect(text).toContain("No code navigation");
    rmSync(path.join(root, "Makefile"), { force: true });
  });

  it("ships with type checking off, and navigation working anyway", async () => {
    // The reversal the Django and WXT screenshots argued for: a checker's
    // complaint about a third-party widget's types, or about a framework's
    // generated globals, is noise on code you are only reading. Definition,
    // usages and hover come from the same server and are unaffected.
    await setTypeChecking(false);
    await openSettled(taskId, "navme.ts", "TypeScript");
    await armGrant(root, taskId);
    // WAIT for the server to be answering before asserting absence. The first
    // version called waitGone straight after arming, and waitGone returns on
    // the first poll where the selector is missing: that was before the server
    // had even spawned, so deleting the whole diagnostics gate kept it green.
    // A live server is the precondition for "and yet no squiggle".
    await browser.waitUntil(async () =>
      ((await browser.execute(async () =>
        await window.__termic!.invoke("lsp_list"))) as any[]).length >= 1,
      { timeout: 30_000, timeoutMsg: "no server to prove anything about" });
    // Its outline answers, so the pipe is live and it is not just slow.
    await browser.execute((id) => {
      const dom = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as HTMLElement;
      const content = dom.querySelector(".cm-content") as HTMLElement;
      content.focus();
      content.dispatchEvent(new KeyboardEvent("keydown", {
        key: "F12", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, bubbles: true, cancelable: true,
      }));
    }, taskId);
    await waitVisible(`[data-task-id="${taskId}"] .cm-lsp-outline`, 15_000);
    await browser.keys(["Escape"]);
    // NOW the absence means something: the fake server publishes a diagnostic
    // on every open, and the pref is the only reason it is not on screen.
    await waitGone(`[data-task-id="${taskId}"] .cm-lintRange`, 10_000);
    // And the same server is answering questions the whole time: the outline
    // is a live request, so this fails if "off" quietly meant "no server".
    await browser.execute((id) => {
      const dom = document.querySelector(`[data-task-id="${id}"] .cm-editor`) as HTMLElement;
      const content = dom.querySelector(".cm-content") as HTMLElement;
      content.focus();
      content.dispatchEvent(new KeyboardEvent("keydown", {
        key: "F12", [/^(mac|darwin)/i.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, bubbles: true, cancelable: true,
      }));
    }, taskId);
    await waitVisible(`[data-task-id="${taskId}"] .cm-lsp-outline`, 10_000);

    // And the feature is CALLED what it currently does. With the checker off
    // this is navigation, and a chip promising "intelligence" sends the reader
    // looking for a half they have not switched on (lib/lsp/featureName.ts).
    const chipText = async () => await browser.execute(() =>
      (document.querySelector('[data-testid="code-intel-chip"]') as HTMLElement | null)
        ?.innerText ?? "") as string;
    await browser.waitUntil(async () => (await chipText()).includes("Code navigation"), {
      timeout: 5_000,
      timeoutMsg: "the chip did not follow the switch to Code navigation",
    });

    await setTypeChecking(true);
    await browser.waitUntil(async () => (await chipText()).includes("Code intelligence"), {
      timeout: 5_000,
      timeoutMsg: "the chip did not go back to the fuller name",
    });
  });

  it("stops the server when the grant is dropped", async () => {
    await openSettled(taskId, "navme.ts", "TypeScript");
    await armGrant(root, taskId);
    await waitVisible(`[data-task-id="${taskId}"] .cm-lintRange`, 30_000);
    await browser.execute(async () => {
      const servers: any[] = await window.__termic!.invoke("lsp_list");
      for (const s of servers) await window.__termic!.invoke("lsp_stop", { id: s.id });
    });
    await clearGrants();
    await browser.waitUntil(
      async () => ((await browser.execute(async () =>
        await window.__termic!.invoke("lsp_list"))) as any[]).length === 0,
      { timeout: 8_000, timeoutMsg: "the language server never stopped" },
    );
    // And the editor drops back to what it was: no diagnostics, no client.
    await waitGone(`[data-task-id="${taskId}"] .cm-lintRange`, 10_000);
  });
  it("kills a previous page load's servers, and spares this page's", async () => {
    // The leak this closes was found on a dev machine, not in a test: six live
    // tsgo processes on one checkout, spawned across an afternoon of reloads.
    // The map that keeps one server per (checkout, language) lives in the
    // WEBVIEW, so a reload (⌘R, an HMR reload, a renderer crash) abandons the
    // processes it was tracking. Their Channel died with the page, so nothing
    // can ever send to them again; they just hold their index.
    //
    // Simulating the reload itself would end this spec's session, so this
    // drives the sweep the way a fresh page does: ask the host to reap
    // everything NOT stamped with a given page id.
    // Start from nothing. The case before this one stops the server through
    // the IPC directly, behind the host's back, so the webview is still
    // holding a client for a dead process; arming now would hand this case
    // that client and spawn nothing. Closing the editors releases it, and the
    // idle reap (1.5s in the e2e build) drops the entry for good.
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      for (const tab of (app.tabs[id] ?? []).filter((t: any) => t.type === "edit")) {
        app.closeTab(id, tab.id);
      }
    }, taskId);
    // Wait for the reap to have HAPPENED rather than for the time it usually
    // takes. The thing that has to happen is WEBVIEW-side: the entry holding
    // the client for the dead process has to go, or arming below is handed
    // that client and spawns nothing ("no server to reap"). The host's
    // `lsp_list` is the wrong question, and asking it cost this case on both
    // runners: the process was already gone while the entry was still there.
    // `__termicLspClients` is that map, put on globalThis by lib/lsp/host.ts
    // precisely so there is one of it.
    await browser.waitUntil(
      () => browser.execute(() =>
        ((globalThis as unknown as { __termicLspClients?: Map<string, unknown> }).__termicLspClients?.size ?? 0) === 0),
      { timeout: 15_000, timeoutMsg: "the idle reap never released the abandoned client" },
    );

    await armGrant(root, taskId);
    await openSettled(taskId, "navme.ts", "TypeScript");
    const running = async () =>
      ((await browser.execute(async () => await window.__termic!.invoke("lsp_list"))) as any[]).length;
    // The process list, not a squiggle: this case is about process
    // bookkeeping, and an earlier case in this file leaves type checking off,
    // so waiting for a diagnostic would be waiting for something the pref is
    // suppressing.
    await browser.waitUntil(async () => (await running()) === 1, {
      timeout: 30_000,
      timeoutMsg: "no server to reap",
    });

    // This page's own id: the server it started must survive, or every reap
    // would take the live server with it.
    const mine = await browser.execute(() => window.__termic!.lspPageId) as string;
    expect(mine).toBeTruthy();
    const spared = await browser.execute(
      async (page) => await window.__termic!.invoke("lsp_reap_foreign", { page }), mine,
    );
    expect(spared).toBe(0);
    expect(await running()).toBe(1);

    // Now a DIFFERENT page id, which is what the next page load sends. The
    // server this page started is an orphan from that page's point of view.
    const killed = await browser.execute(
      async () => await window.__termic!.invoke("lsp_reap_foreign", { page: "a-later-page" }),
    );
    expect(killed).toBe(1);
    await browser.waitUntil(async () => (await running()) === 0, {
      timeout: 10_000,
      timeoutMsg: "the orphaned server was dropped from the list but never died",
    });

    // The grant is untouched: reaping is about processes nobody can reach,
    // not about what the user agreed to.
    expect(await isArmed(root)).toBe(true);
    await clearGrants();
    // LAST in this file on purpose. Reaping a server the current page IS
    // using leaves that page holding a client for a dead process, which no
    // real reap can do (it only ever kills servers from an earlier page
    // load, which this page's map never knew about). Any case after this one
    // would arm the checkout, get handed the dead client, and fail for a
    // reason that has nothing to do with what it tests.
  });
});
