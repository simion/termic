import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { execSync } from "node:child_process";

// Tauri dev runs us via `tauri dev`. The default port is 1420; set the
// PORT env var to run on another port (`PORT=1430 npm run tauri:dev`) —
// the npm script feeds the same PORT to Tauri's devUrl. HMR rides on
// port+1. strictPort stays true — a silent fallback port would just
// leave Tauri loading a blank window.
const devPort = Number(process.env.PORT) || 1420;

// Surface which branch a dev window is running so multiple `tauri:dev`
// instances (one per worktree) are distinguishable in the DEV/E2E pill
// (UpdaterBanner.tsx). Setting process.env here (rather than a `define`)
// lets Vite's normal VITE_-prefix pickup expose it as
// import.meta.env.VITE_GIT_BRANCH, the same mechanism as VITE_MOCK_UPDATE.
if (!process.env.VITE_GIT_BRANCH) {
  try {
    process.env.VITE_GIT_BRANCH = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: __dirname,
      // Silence git's own stderr. Building from a source archive with no
      // .git would otherwise print "fatal: not a git repository" on every
      // start, which reads like a build failure when it is the expected
      // fallback below.
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    // Not a git checkout (e.g. a release build's source archive), leave unset.
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  clearScreen: false,
  build: {
    // The main chunk (~2.6 MB: react + xterm/webgl + radix + app code) is all
    // genuinely needed at startup, and it loads from disk via Tauri's asset
    // protocol, not a network. Heavy optional deps (mermaid + its d3/katex
    // tree, CodeMirror's EditorPane, markdown-it) are already lazy chunks.
    // Splitting the main chunk further buys nothing but lazy-load flicker,
    // so raise the warning limit instead of chasing it.
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      // Two windows, two entries. `activity.html` is the process monitor's
      // own window (src-tauri/src/procmon.rs): keeping it a separate entry
      // is what stops its webview from loading xterm, WebGL and CodeMirror
      // just to draw a table of CPU numbers. Listing `index` explicitly is
      // required - naming any input replaces Vite's implicit default.
      input: {
        index: path.resolve(__dirname, "index.html"),
        activity: path.resolve(__dirname, "activity.html"),
        // The needs-you panel (GH #468), as small as Activity and for the
        // same reason: an always-on-top window should not carry xterm.
        attention: path.resolve(__dirname, "attention.html"),
      },
    },
  },
  server: {
    port: devPort,
    strictPort: true,
    // Explicit IPv4: `host: false` (localhost) binds whichever address
    // the resolver lists first, and on Windows that is often ::1 only -
    // while the tauri CLI's readiness probe connects to 127.0.0.1, so
    // `tauri dev` waits forever on a ready server (measured: netstat
    // showed the probe parked in SYN_SENT against a ::1-only listener).
    // The webview still loads via `localhost`: the browser falls back
    // from ::1 to 127.0.0.1 when the first address refuses.
    host: "127.0.0.1",
    // Same story for HMR: `localhost` would bind ::1-only while the
    // webview dials 127.0.0.1, and the vite client's reconnect storm
    // takes the webview down (measured: "WebSocket closed without
    // opened" until the window died).
    hmr: { protocol: "ws", host: "127.0.0.1", port: devPort + 1 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
