#!/usr/bin/env node
// Launches `tauri dev` with a PORT-driven `devUrl` override so the
// frontend port is set in ONE place (the PORT env var) and both Vite
// (via vite.config.ts) and Tauri agree.
//
// Passes the override as a temp JSON file rather than an inline string —
// some Tauri 2 builds only apply build.devUrl from file-based overrides,
// not from inline JSON strings.

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAURI_BIN = resolve(__dirname, "../node_modules/.bin/tauri");

const port = Number(process.env.PORT) || 1420;
const devUrl = `http://localhost:${port}/`;

const tmpConf = resolve(tmpdir(), `termic-dev-override-${port}.json`);
writeFileSync(tmpConf, JSON.stringify({ build: { devUrl } }));

const child = spawn(TAURI_BIN, ["dev", "--config", tmpConf, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, PORT: String(port) },
});

const cleanup = () => { try { unlinkSync(tmpConf); } catch {} };
child.on("exit", code => { cleanup(); process.exit(code ?? 0); });
child.on("error", err => { cleanup(); console.error(err); process.exit(1); });
process.on("SIGINT",  () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });
