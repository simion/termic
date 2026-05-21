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
  server: {
    port: devPort,
    strictPort: true,
    host: false,
    hmr: { protocol: "ws", host: "localhost", port: devPort + 1 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
