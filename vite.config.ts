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
    // The main chunk (~2.3 MB: react + xterm/webgl + radix + app code) is all
    // genuinely needed at startup, and it loads from disk via Tauri's asset
    // protocol, not a network. Heavy optional deps (mermaid + its d3/katex
    // tree, CodeMirror's EditorPane, markdown-it) are already lazy chunks.
    // Splitting the main chunk further buys nothing but lazy-load flicker,
    // so raise the warning limit instead of chasing it.
    chunkSizeWarningLimit: 2500,
  },
  server: {
    port: devPort,
    strictPort: true,
    host: false,
    hmr: { protocol: "ws", host: "localhost", port: devPort + 1 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
