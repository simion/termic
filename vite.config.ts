import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Tauri dev runs us via `tauri dev`. The default port is 1420; set the
// PORT env var to run on another port (`PORT=1430 npm run tauri:dev`) —
// the npm script feeds the same PORT to Tauri's devUrl. HMR rides on
// port+1. strictPort stays true — a silent fallback port would just
// leave Tauri loading a blank window.
const devPort = Number(process.env.PORT) || 1420;

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
