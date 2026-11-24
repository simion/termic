import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { createConnection, createServer } from "node:net";

// End-to-end config for the termic app. WebdriverIO drives the REAL macOS
// WKWebView window via @wdio/tauri-service's embedded WebDriver provider
// (tauri-plugin-wdio-webdriver, compiled in only by `--features e2e`). Build
// the app first with `npm run e2e:build`, then run `npm run test:e2e`.
//
// SERIAL by design. Parallel (maxInstances > 1) is NOT usable with this stack:
// the tauri-service spawns each app from the launcher with the launcher's env,
// differing only by WebDriver port — so per-worker TERMIC_DATA_DIR (isolated
// profiles for the fixture-mutating specs) can't be injected without an
// invasive, flake-prone app-side port→datadir mapping. Stability wins.

// an enforcing Termic cage denies what the app under test needs (its WebKit
// storage, the spawn base, ~/.config/termic), so a caged run takes ~40 min and
// fails about 19 spec files for reasons that are not regressions. Refuse it up
// front. Same test as termic-cli's cage_refused: monitor mode denies nothing.
// Workers never see this: onPrepare scrubs TERMIC_* before they spawn.
if (process.env.TERMIC_SANDBOX === "1" && process.env.TERMIC_SANDBOX_MODE !== "monitor") {
  throw new Error("e2e cannot run inside a sandboxed Termic task: the cage denies the app's "
    + "WebKit storage, spawn dir and config. Run `make e2e` from an unsandboxed shell.");
}

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
// TERMIC_E2E_BINARY points the suite at a binary built somewhere else, which is
// how it runs beside a live `make dev`: both write target/debug/termic, so
// build the e2e one with CARGO_TARGET_DIR set and name the result here.
const appBinary = process.env.TERMIC_E2E_BINARY
  || path.join(repoRoot, "src-tauri", "target", "debug", process.platform === "win32" ? "termic.exe" : "termic");
/** Exported so specs that need the control socket agree with the launcher. */
export const dataDir = path.join(repoRoot, ".e2e", "profile");
/** Where `TERMIC_E2E_TIMING=1` writes per-test durations. */
const timingLog = path.join(repoRoot, ".e2e", "timings.txt");
const artifactsDir = path.join(repoRoot, ".e2e", "artifacts");

/** The macOS runner's WebKit freeze: see "The macOS CI freeze" in
 *  docs/e2e-tests.md. A spec file that hit it is rerun once in a fresh app. */
const macCi = process.platform === "darwin" && !!process.env.CI;

/** Whether the page still answers a trivial script within `ms`. */
async function pageAnswers(ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([browser.execute(() => true).then(() => true, () => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every pid matching `pattern` (pgrep -f), or none. */
function pids(pattern: string): string[] {
  try { return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; }
}

/** The e2e build's own window-state file (`window_state_filename` in lib.rs),
 *  under the app config dir tauri's window-state plugin writes to. */
const windowStateFile = path.join(
  process.platform === "darwin"
    ? path.join(homedir(), "Library", "Application Support")
    : process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
  "com.simion.termic",
  ".window-state-e2e.json",
);

/** Ask the app to quit over its control socket (`termic quit`). Resolves
 *  once the request is answered or refused; never throws. */
function quitApp(): Promise<void> {
  return new Promise(resolve => {
    try {
      const token = readFileSync(path.join(dataDir, "cli-token"), "utf8").trim();
      const c = createConnection(path.join(dataDir, "termic.sock"));
      const done = () => { clearTimeout(t); c.destroy(); resolve(); };
      const t = setTimeout(done, 5_000);
      c.on("connect", () => c.write(JSON.stringify({ id: "e2e-quit", token, cmd: "quit", commit: true }) + "\n"));
      c.on("data", done);
      c.on("error", done);
      c.on("close", done);
    } catch { resolve(); }
  });
}

export const config: WebdriverIO.Config = {
  runner: "local",
  tsConfigPath: path.join(repoRoot, "e2e", "tsconfig.json"),

  // TERMIC_E2E_SPECS=git,editor runs just those files: a CI job started by
  // hand on a branch can then repeat the specs it is chasing, not all 49.
  specs: process.env.TERMIC_E2E_SPECS
    ? process.env.TERMIC_E2E_SPECS.split(",").map(n => path.join(repoRoot, "e2e", "specs", `${n.trim()}.e2e.ts`))
    : [path.join(repoRoot, "e2e", "specs", "**", "*.e2e.ts")],
  // Specs for features a platform does not have: Touch ID for sudo is
  // macOS only.
  exclude: [
    ...(process.platform === "darwin" ? [] : ["sudo-touchid"]),
    // Stages the README's screenshots and asserts nothing about features;
    // run on purpose with TERMIC_E2E_README_SHOTS=1 (see the spec's header).
    ...(process.env.TERMIC_E2E_README_SHOTS ? [] : ["readme-shots"]),
  ].map(n => path.join(repoRoot, "e2e", "specs", `${n}.e2e.ts`)),
  maxInstances: 1,

  // `tauri:options` is a VENDOR capability extension that the embedded
  // WebDriver reads, and WebdriverIO's capability type does not know it. The
  // cast is the whole reason this file was never typechecked cleanly, so it is
  // narrowed to the one entry rather than loosening the config's type.
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: appBinary },
    } as WebdriverIO.Capabilities,
  ],

  services: [
    ["@wdio/tauri-service", { appBinaryPath: appBinary, driverProvider: "embedded" }],
  ],

  framework: "mocha",
  reporters: ["spec"],
  // "silent" silences the wdio LOGGER only (the spec reporter's ✓/✗ + summary
  // is unaffected). Kills two streams of noise this stack emits and we can't
  // otherwise disable: the false "tauri-driver not found" diagnostic (we use
  // the embedded provider) and the afterSession "Failed to clear mock store"
  // stack trace (we don't use the mock plugin; restoreAllMocks runs anyway).
  logLevel: "silent",
  mochaOpts: { ui: "bdd", timeout: 60_000 },

  // Poll conditions every 100ms (default 500) so browser.waitUntil-based waits
  // fire the instant the condition is met. NOTE: we deliberately do NOT use
  // WebdriverIO's native element visibility (waitForDisplayed/isDisplayed): on
  // this offscreen WKWebView it triggers Tauri window-state calls that time out
  // 5s each. The waitVisible()/clickWhenVisible() helpers do a fast client-side
  // check instead.
  waitforTimeout: 15_000,
  waitforInterval: 100,

  // A fresh app for every spec file, on macOS and Linux. The embedded driver
  // starts the app ONCE in onPrepare and reuses it for every file; it
  // relaunches only one that no longer answers (onWorkerStart). So without
  // this the whole suite ran in one process for 30 minutes, every file
  // inheriting the windows, webviews and state of the ones before it, and on
  // the macOS runner that long-lived app is what WebKit's display-refresh
  // freeze needed (docs/e2e-tests.md).
  //
  // `termic quit` first, the same teardown as Cmd-Q, and SIGKILL only for an
  // app that will not go: a hard kill can drop the localStorage write a
  // spec's cleanup just made. From here, not the worker's `after` hook: the
  // session is already deleted, so the exit cannot fail the file.
  //
  // Not on Windows, which keeps one app for the run (it never froze there).
  // After a clean quit the relaunched app's WebDriver did not come up within
  // 60s (2 runs of 2), and taskkill /F instead lost a pref a spec's cleanup
  // had just written, so the next file booted with it.
  async onWorkerEnd() {
    if (process.platform === "win32") return;
    await quitApp();
    for (let i = 0; i < 100 && pids(appBinary).length; i++) await new Promise(r => setTimeout(r, 100));
    if (pids(appBinary).length) console.log("[e2e] the app did not quit within 10s, killing it");
    for (const pid of pids(appBinary)) {
      try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
    }
    // Gone before the next file's health check, or it finds the dying one.
    for (let i = 0; i < 100 && pids(appBinary).length; i++) await new Promise(r => setTimeout(r, 100));
    // The clean quit saved the window's frame, and the next app would restore
    // it: a file that left the window 200000px wide handed that to the next.
    rmSync(windowStateFile, { force: true });
  },
  async onPrepare() {
    mkdirSync(artifactsDir, { recursive: true });
    // The first file's app, too, starts from the default frame: a frame an
    // earlier run left (200000px wide in the one seen) failed that file.
    rmSync(windowStateFile, { force: true });
    // a run launched from an agent tab inherits that tab's TERMIC_* (task,
    // tab, pty, sandbox mode). They describe the outer app, not the one under
    // test, and the app and every termic-cli a spec runs would act on them.
    // First, so the sets below survive it; TERMIC_E2E_* are this suite's own
    // knobs and stay.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("TERMIC_") && !k.startsWith("TERMIC_E2E_")) delete process.env[k];
    }
    // The termic-server builds the app installs from (TERMIC_SERVER_BIN_DIR,
    // which the loop above just dropped): remote.e2e.ts's real-box cases name
    // theirs; otherwise .e2e/server-bin, empty unless the upgrade case stages
    // one, so no run installs whatever a local release build left behind.
    process.env.TERMIC_SERVER_BIN_DIR = process.env.TERMIC_E2E_SERVER_BIN_DIR ?? path.join(repoRoot, ".e2e", "server-bin");
    // remote.e2e.ts's local-server cases: a stand-in for ssh that serves the
    // host termic-e2e-local from a real termic-server built into the debug
    // target (and passes any other host to the real ssh). Not on Windows,
    // where termic-server does not run.
    if (process.platform !== "win32") {
      process.env.TERMIC_SSH_BIN = path.join(repoRoot, "e2e", "fixtures", "fake-ssh.sh");
      process.env.TERMIC_E2E_LOCAL_BOX ??= path.join(repoRoot, ".e2e", "local-box");
      process.env.TERMIC_E2E_SERVER_DIR ??= path.join(repoRoot, "src-tauri", "target", "debug");
    }
    // the embedded WebDriver defaults to 4445 for every run, so two agents
    // running e2e at once drive each other's app. A free port per run; the
    // tauri-service's own onPrepare reads it, and runs after this one.
    if (!process.env.TAURI_WEBDRIVER_PORT) {
      process.env.TAURI_WEBDRIVER_PORT = String(await new Promise<number>((resolve, reject) => {
        const s = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
          const { port } = s.address() as { port: number };
          s.close(() => resolve(port));
        });
      }));
    }
    // The app is launched as a child of this process and inherits env, so
    // point it at the throwaway profile (seeded by scripts/e2e-seed.mjs).
    process.env.TERMIC_DATA_DIR = dataDir;
    // LAN sharing (peers.e2e.ts) binds loopback only and skips mDNS in this
    // run: on the real network it would raise macOS's Local Network prompt
    // on the developer's machine and Windows's firewall prompt on CI, for a
    // spec whose second machine is a fake in this process. Debug builds only
    // (src-tauri/src/peers.rs, Node::start).
    process.env.TERMIC_PEER_LOOPBACK = "1";
    // a run launched from inside an agent tab inherits that agent's relocated
    // login (agent_dirs.rs), and the app passes it to every fixture agent: they
    // would read the developer's real login store, and the adopted-account
    // case in credentials.e2e.ts sees a relocation that is not the app's.
    // XDG_DATA_HOME is re-set below on Linux, after this.
    for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CURSOR_CONFIG_DIR", "GEMINI_CLI_HOME", "GROK_HOME", "XDG_DATA_HOME"]) delete process.env[k];
    // Windows: WebView2 keeps its profile (localStorage, so every pref) in a
    // folder named after the app identifier, NOT under TERMIC_DATA_DIR, and
    // runs one browser process per folder. Left alone, a run shares both with
    // the developer's installed Termic: specs write prefs into the real app,
    // and the webview is never created at all when the two builds ask for
    // different browser arguments (measured: the suite timed out in its first
    // `before` beside an installed build without `--disable-lcd-text`).
    if (process.platform === "win32") {
      process.env.WEBVIEW2_USER_DATA_FOLDER = path.join(dataDir, "webview2");
    }
    // Linux: the same hole, found the same way. WebKitGTK keeps localStorage
    // under $XDG_DATA_HOME/<app identifier>, keyed by ORIGIN, and every built
    // binary serves the app from the same origin. So a run read the
    // developer's installed Termic's prefs (a right panel they had hidden
    // failed every file-tree spec from the first one) and wrote its own back
    // into the real app. Give the run its own XDG homes. Children inherit
    // them, which is also what keeps a desktop-entry spec out of the real
    // ~/.local/share/applications.
    if (process.platform === "linux") {
      process.env.XDG_DATA_HOME = path.join(dataDir, "xdg-data");
      process.env.XDG_CACHE_HOME = path.join(dataDir, "xdg-cache");
      mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
      mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true });
    }
    // Agent-hook installs write into an agent's own config dir. Point that at
    // the throwaway profile so a run can exercise install/remove without
    // touching the developer's real ~/.claude/settings.json. Honoured only by
    // the `e2e`-feature binary (agent_hooks::host_config_dir).
    process.env.TERMIC_E2E_AGENT_HOME = dataDir;
    // Ghostty / Warp theme import reads this instead of the real home, so a
    // run sees theme-import.e2e.ts's fixtures and not the developer's own
    // themes, with `<home>/bundled` standing in for Ghostty's bundled dir.
    // termic's own themes dir is NOT redirected (see the spec's header for
    // why). Honoured only by the `e2e`-feature binary (theme_import.rs).
    process.env.TERMIC_E2E_THEME_HOME = path.join(dataDir, "theme-home");
    // Touch ID for sudo offer: `perl` stands in for sudo, eligibility is
    // forced and the enable script is a stub (sudo_touchid.rs). Honoured only
    // by the `e2e`-feature binary.
    process.env.TERMIC_E2E_FAKE_SUDO = "1";
    // A token-shaped var in the app's own environment, for the "Kept out of
    // agents" list (secrets-settings.e2e.ts). Synthetic: the shape is a
    // GitHub classic token, the characters spell out that it is not one.
    process.env.TERMIC_E2E_FAKE_PAT = "ghp_" + "e2eFakeTokenNotReal0".repeat(2);
    // Purge accumulated tasks so every run starts lean (specs create their own;
    // archived tasks otherwise pile up across runs and bloat loadAll/sidebar).
    try {
      for (const f of readdirSync(path.join(dataDir, "tasks"))) {
        if (f.endsWith(".json"))
          rmSync(path.join(dataDir, "tasks", f), { force: true });
      }
    } catch {
      /* no tasks dir yet */
    }
    // Scratchpads (GH #244) live in the SAME profile, keyed by task id. The
    // task records above are being purged, so their pads are orphaned by
    // definition; leaving them behind means specs eventually start seeing
    // each other's notes in a strip they expected to be empty.
    rmSync(path.join(dataDir, "scratch"), { recursive: true, force: true });
    seedArchive();
    warmTheLoader();
    if (process.env.TERMIC_E2E_TIMING) rmSync(timingLog, { force: true });
  },

  /** Per-test durations, opt-in with `TERMIC_E2E_TIMING=1`.
   *
   *  The spec reporter prints pass/fail and a per-FILE total, which is
   *  enough to know a file is slow and useless for knowing why. Guessing
   *  which case costs the minutes is how you end up optimising a 300ms
   *  sleep in a seven minute file. Off by default: it writes a file and
   *  nobody needs it on a normal run. */
  // TERMIC_E2E_WINDOW=WxH sizes the window before a spec file runs, so a
  // run on a big desktop can reproduce a CI runner's small screen.
  async before() {
    const want = process.env.TERMIC_E2E_WINDOW?.match(/^(\d+)x(\d+)$/);
    if (want) await browser.setWindowSize(Number(want[1]), Number(want[2]));
    const vp = await browser.execute(() => `${window.innerWidth}x${window.innerHeight} on ${screen.width}x${screen.height}`);
    console.log(`[e2e] viewport ${vp}`);
  },
  // Windows only: a page whose window is not the foreground one gets no
  // focus/blur events from el.focus()/el.blur(), so every blur-commit case
  // fails. Seen once late in a CI run (four specs, cases passing between);
  // what took the foreground is not established, so say when it happens,
  // and take it back so the cases after it test the app, not the desktop.
  async beforeTest(test) {
    if (process.platform !== "win32") return;
    const focused = await browser.execute(() => document.hasFocus()).catch(() => null);
    if (focused !== false) return;
    // Take the foreground back rather than let every focus-dependent case
    // after it fail: whatever stole it is not ours, and a case that needs
    // focus is testing the app, not the runner's desktop.
    const thief = foregroundWindow();
    const how = bringAppToFront();
    if (how.includes("left alone")) { console.log(`[e2e] page lost focus before "${test.title}" to ${thief}; ${how}`); return; }
    const back = await browser.waitUntil(() => browser.execute(() => document.hasFocus()), { timeout: 3_000, interval: 100 })
      .then(() => true, () => false);
    console.log(`[e2e] page lost focus before "${test.title}" to ${thief}; ${how}; focus ${back ? "restored" : "NOT restored"}`);
  },
  async afterTest(test, _context, result) {
    // Opt-in failure capture (`TERMIC_E2E_FAIL_CAPTURE=1`, set by the Windows
    // workflow): a screenshot and the visible text of the window at the
    // moment a case failed, into the artifacts dir CI uploads. On a runner
    // nobody can look at, it is the only record of what the screen showed.
    const failed = !(result as { passed?: boolean }).passed;
    // A failure that left the page unable to answer at all is the freeze.
    const frozen = failed && !(await pageAnswers(5_000));
    if (process.env.TERMIC_E2E_FAIL_CAPTURE && failed) {
      const slug = `${test.parent} ${test.title}`.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 120);
      try { await browser.saveScreenshot(path.join(artifactsDir, `FAIL-${slug}.png`)); } catch { /* no display */ }
      // The whole screen on macOS too: a system prompt (Keychain, a privacy
      // ask) sits outside the webview, and it is what can stop every app
      // after it from answering the driver.
      if (process.platform === "darwin") {
        try { execFileSync("screencapture", ["-x", path.join(artifactsDir, `FAIL-${slug}-screen.png`)], { timeout: 10_000 }); } catch { /* no permission */ }
      }
      if (process.platform === "win32") {
        const focused = await browser.execute(() => document.hasFocus()).catch(() => null);
        writeFileSync(path.join(artifactsDir, `FAIL-${slug}-focus.txt`), `hasFocus=${focused}\nforeground=${foregroundWindow()}\n`);
      }
      if (!frozen) {
        try {
          const text = await browser.execute(() => document.body?.innerText?.slice(0, 20_000) ?? "");
          writeFileSync(path.join(artifactsDir, `FAIL-${slug}.txt`), String(text));
        } catch { /* app gone */ }
      } else if (process.platform === "darwin") {
        // Frozen: every thread of the app and of WebKit's WebContent and GPU
        // processes, since the thread that would log why is the stuck one.
        for (const [tag, pattern] of [["app", appBinary], ["webkit", "com.apple.WebKit.(WebContent|GPU)"]]) {
          for (const pid of pids(pattern)) {
            try { execFileSync("sample", [pid, "2", "-file", path.join(artifactsDir, `FAIL-${slug}-sample-${tag}-${pid}.txt`)], { timeout: 30_000, stdio: "ignore" }); } catch { /* gone */ }
          }
        }
      }
    }
    // A frozen app on the macOS runner never comes back, and each case left
    // would wait out its full 60s on it. Killing it fails them in a second.
    // Not retried: the freeze it was built for needed one app living through
    // the whole suite, which onWorkerEnd now prevents, so a freeze here is
    // news (docs/e2e-tests.md).
    if (macCi && frozen) {
      console.log(`[e2e] app frozen after "${test.title}", killing it`);
      for (const pid of pids(appBinary)) {
        try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
      }
    }
    if (!process.env.TERMIC_E2E_TIMING) return;
    const ms = (result as { duration?: number }).duration ?? 0;
    appendFileSync(timingLog, `${String(ms).padStart(7)}  ${test.parent} > ${test.title}\n`);
  },
};

/** Title and process of the Windows foreground window, for a lost-focus report. */
function foregroundWindow(): string {
  const ps = `Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
'@
$h = [Fg]::GetForegroundWindow(); $s = New-Object Text.StringBuilder 512
[void][Fg]::GetWindowText($h, $s, 512); $p = 0; [void][Fg]::GetWindowThreadProcessId($h, [ref]$p)
"$s | pid $p $((Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName)"`;
  try {
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 15_000, encoding: "utf8" }).trim();
  } catch (e) { return `unknown (${String(e).slice(0, 200)})`; }
}

/** Put the app's window back in the foreground (Windows). The Alt tap is
 *  what makes it work from a background process: Windows refuses
 *  SetForegroundWindow to a process that did not receive the last input
 *  event, and a synthetic key press counts as one. */
function bringAppToFront(): string {
  const exe = path.resolve(appBinary).replace(/'/g, "''");
  const ps = `Add-Type @'
using System; using System.Runtime.InteropServices;
public class Fr {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
'@
$exe = '${exe}'
$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.Path -eq $exe -or $_.Path -eq "$exe.exe") } | Select-Object -First 1
if (-not $p) { "no app window"; exit }
# Focus that went to one of the app's OWN windows (the Activity window a
# spec opened) is the spec's business: leave it, and never tap Alt into it.
$fp = 0; [void][Fr]::GetWindowThreadProcessId([Fr]::GetForegroundWindow(), [ref]$fp)
$fg = Get-Process -Id $fp -ErrorAction SilentlyContinue
if ($fg -and ($fg.Path -eq $exe -or $fg.Path -eq "$exe.exe")) { "foreground is the app's own window, left alone"; exit }
[Fr]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [Fr]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][Fr]::ShowWindow($p.MainWindowHandle, 9)
"SetForegroundWindow=$([Fr]::SetForegroundWindow($p.MainWindowHandle))"`;
  try {
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 15_000, encoding: "utf8" }).trim();
  } catch (e) { return `bringAppToFront failed (${String(e).slice(0, 200)})`; }
}

/** Pay the cold-start cost of `cmd.exe` + `node` before anything is timed.
 *
 *  Windows only, and measured: the FIRST language server the suite starts is
 *  a `.cmd` shim around node, and it took 6.8s from `sent initialize` to the
 *  server's first byte (termic-debug.log, run 36390843154). Every later spawn
 *  in the same run took 0.24s. Nothing about the second one is different
 *  except that the image loader and Defender have already seen cmd.exe and
 *  node.exe, so the first case to need a server pays for all of them and
 *  races its own wait; the two Terraform cases have failed that race twice
 *  and passed it twice.
 *
 *  Warming it here moves that one-off cost outside every timeout in the
 *  suite. Best effort: a runner without node on PATH would not be running
 *  this file at all, and if the probe fails the suite is no worse off. */
function warmTheLoader(): void {
  if (process.platform !== "win32") return;
  try {
    execFileSync("cmd.exe", ["/c", "node", "-e", "0"], { stdio: "ignore", timeout: 60_000 });
  } catch {
    /* the first real spawn pays it instead, exactly as before */
  }
}

/** Archived task records, written straight to disk before the run.
 *
 *  `app.e2e.ts` needs a History list taller than its own pane, and it used to
 *  build one by creating and archiving tasks through the app, one IPC round
 *  trip each, roughly twenty of them. On a freshly seeded profile that is
 *  minutes of a window sitting on the History screen doing nothing visible,
 *  and it only ever looked fast because runs used to inherit the archive the
 *  previous run left behind: with enough of those the loop created nothing
 *  and the case asserted nothing.
 *
 *  Records, not worktrees. An archived task has no working directory by
 *  definition (archiving deletes it), so a JSON file is the whole truth and
 *  `path` points at something that is allowed not to exist. Only the fields
 *  without a serde default are required; everything else is Task::default.
 *
 *  Written here rather than in `scripts/e2e-seed.mjs` because the sweep above
 *  runs on every `test:e2e`, including the ones that skip the seed script,
 *  and would delete them.
 */
function seedArchive() {
  const projects = path.join(dataDir, "projects.json");
  let projectId = "";
  try {
    const list = JSON.parse(readFileSync(projects, "utf8")) as { id: string; name: string }[];
    projectId = list.find(p => p.name === "fixture-repo")?.id ?? "";
  } catch { /* no profile yet: the seed script has not run, nothing to attach to */ }
  if (!projectId) return;
  const when = new Date("2026-01-01T00:00:00Z").toISOString();
  for (let i = 0; i < 30; i++) {
    const n = String(i).padStart(2, "0");
    const id = `aaaaaaaa-0000-4000-8000-${n.padStart(12, "0")}`;
    writeFileSync(path.join(dataDir, "tasks", `${id}.json`), JSON.stringify({
      id,
      project_id: projectId,
      name: `seeded archive ${n}`,
      branch: `seeded/archive-${n}`,
      base_branch: "origin/main",
      // Archived, so this directory is gone by construction.
      path: path.join(dataDir, "tasks", "gone", `archive-${n}`),
      cli: "fakeagent",
      port: 60000 + i,
      created: when,
      archived: true,
      archived_at: when,
      is_main_checkout: false,
    }, null, 2));
  }
}
