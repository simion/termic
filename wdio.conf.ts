import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

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

export const config: WebdriverIO.Config = {
  runner: "local",
  tsConfigPath: path.join(repoRoot, "e2e", "tsconfig.json"),

  specs: [path.join(repoRoot, "e2e", "specs", "**", "*.e2e.ts")],
  // Specs for features a platform does not have: Touch ID for sudo is
  // macOS only.
  exclude: [
    ...(process.platform === "darwin" ? [] : ["sudo-touchid"]),
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

  onPrepare() {
    mkdirSync(artifactsDir, { recursive: true });
    // The app is launched as a child of this process and inherits env, so
    // point it at the throwaway profile (seeded by scripts/e2e-seed.mjs).
    process.env.TERMIC_DATA_DIR = dataDir;
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
  async afterTest(test, _context, result) {
    // Opt-in failure capture (`TERMIC_E2E_FAIL_CAPTURE=1`, set by the Windows
    // workflow): a screenshot and the visible text of the window at the
    // moment a case failed, into the artifacts dir CI uploads. On a runner
    // nobody can look at, it is the only record of what the screen showed.
    if (process.env.TERMIC_E2E_FAIL_CAPTURE && !(result as { passed?: boolean }).passed) {
      const slug = `${test.parent} ${test.title}`.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 120);
      try { await browser.saveScreenshot(path.join(artifactsDir, `FAIL-${slug}.png`)); } catch { /* no display */ }
      try {
        const text = await browser.execute(() => document.body?.innerText?.slice(0, 20_000) ?? "");
        writeFileSync(path.join(artifactsDir, `FAIL-${slug}.txt`), String(text));
      } catch { /* app gone */ }
    }
    if (!process.env.TERMIC_E2E_TIMING) return;
    const ms = (result as { duration?: number }).duration ?? 0;
    appendFileSync(timingLog, `${String(ms).padStart(7)}  ${test.parent} > ${test.title}\n`);
  },
};

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
