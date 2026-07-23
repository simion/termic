import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readdirSync, rmSync } from "node:fs";

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
const appBinary = path.join(repoRoot, "src-tauri", "target", "debug", "termic");
const dataDir = path.join(repoRoot, ".e2e", "profile");
const artifactsDir = path.join(repoRoot, ".e2e", "artifacts");

export const config: WebdriverIO.Config = {
  runner: "local",
  tsConfigPath: path.join(repoRoot, "e2e", "tsconfig.json"),

  specs: [path.join(repoRoot, "e2e", "specs", "**", "*.e2e.ts")],
  maxInstances: 1,

  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: appBinary },
    },
  ],

  services: [
    ["@wdio/tauri-service", { appBinaryPath: appBinary, driverProvider: "embedded" }],
  ],

  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
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
  },
};
