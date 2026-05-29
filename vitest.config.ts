// Vitest config kept separate from vite.config.ts so test runs don't pull in
// the React / Tailwind / Tauri dev plugins. The frontend has no UI test
// harness by design (it's verified empirically in-app); these tests cover the
// pure decision logic only — fuzzy matching, context-picker ranking +
// insertion formatting, terminal target resolution, and the @-word-boundary
// check. Node environment is enough: none of the tested functions touch the DOM.
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
