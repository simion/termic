import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readdirSync, rmSync } from "node:fs";

// End-to-end config for the termic app. WebdriverIO drives the REAL macOS
// WKWebView window via @wdio/tauri-service's embedded WebDriver provider
// (tauri-plugin-wdio, compiled in only by `--features e2e`). Build the app
// first with `npm run e2e:build`, then run `npm run test:e2e`.
//
// Stability rules baked in here (see docs/e2e-tests.md):
//   - no fixed sleeps anywhere; specs use browser.waitUntil / auto-retrying
//     expects only.
//   - one instance, specs run serially against a single launched window.
//   - a throwaway, isolated data profile so a run never touches the real
//     dev data (~/…/termic_dev). The Rust side honours TERMIC_DATA_DIR only
//     in debug builds, and `tauri build --debug` is a debug build.

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// The unbundled debug binary produced by `npm run e2e:build`
// (`tauri build --debug --no-bundle --features e2e`). It embeds the built
// frontend, so no vite dev server is needed at test time.
const appBinary = path.join(repoRoot, "src-tauri", "target", "debug", "termic");

// Isolated, disposable profile. Reuses the persistent e2e profile the
// `e2e` skill already seeds (welcomed=true + fixture repo), so the app
// boots straight into the main UI instead of onboarding.
const dataDir = path.join(repoRoot, ".e2e", "profile");
const artifactsDir = path.join(repoRoot, ".e2e", "artifacts");

export const config: WebdriverIO.Config = {
  runner: "local",
  tsConfigPath: path.join(repoRoot, "e2e", "tsconfig.json"),

  specs: [path.join(repoRoot, "e2e", "specs", "**", "*.e2e.ts")],

  // One window, serial specs: deterministic and simplest to reason about.
  maxInstances: 1,

  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: appBinary },
    },
  ],

  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: appBinary,
        // macOS WKWebView: drive the webview via the in-app embedded
        // WebDriver server (no external driver, no CrabNebula).
        driverProvider: "embedded",
      },
    ],
  ],

  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  mochaOpts: { ui: "bdd", timeout: 60_000 },

  // Poll conditions every 100ms (default is 500ms) so browser.waitUntil-based
  // waits fire almost the instant the condition is met — responsive, not
  // timeout-bound. NOTE: we deliberately do NOT use WebdriverIO's native
  // element visibility (waitForDisplayed/isDisplayed): on this offscreen
  // WKWebView it triggers Tauri window-state calls that time out (5s each).
  // The `visible()`/`waitVisible()` helpers do a fast client-side check instead.
  waitforTimeout: 15_000,
  waitforInterval: 100,

  onPrepare() {
    mkdirSync(artifactsDir, { recursive: true });
    // The app is launched as a child of this process and inherits env,
    // so point it at the throwaway profile before any session starts.
    process.env.TERMIC_DATA_DIR = dataDir;
    // Purge accumulated tasks so every run starts from a lean profile. Specs
    // create their own tasks; without this, archived tasks pile up across runs
    // and bloat loadAll/sidebar/History enough to make late specs flake
    // (the tab strip renders too slowly). Projects/agents/settings are kept.
    const tasksDir = path.join(dataDir, "tasks");
    try {
      for (const f of readdirSync(tasksDir)) {
        if (f.endsWith(".json")) rmSync(path.join(tasksDir, f), { force: true });
      }
    } catch {
      /* no tasks dir yet */
    }
  },
};
