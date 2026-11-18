#!/usr/bin/env node
// Cap the Rust incremental compile cache. Cargo never prunes it: every
// configuration (build, check, test, the e2e feature) keeps its own copy of
// each crate's cache, and on a long-lived checkout `target/debug/incremental`
// reached 12 GB. It is pure cache, so dropping it costs one slower build of
// the app's own crates (dependencies live in deps/ and are not touched).
//
// Run from `make dev` and `make e2e`, and on its own as `make prune`.
// TERMIC_INCREMENTAL_CAP_GB overrides the cap (default 8).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "target");
const capBytes = Number(process.env.TERMIC_INCREMENTAL_CAP_GB ?? 8) * 1024 ** 3;

function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* raced a build */ } }
  }
  return total;
}

/** Every `<profile>/incremental` under target, sidecar targets included. */
function incrementalDirs(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === "incremental") out.push(p);
      else if (!["deps", "build", ".fingerprint", "bundle"].includes(e.name)) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

const gb = (n) => (n / 1024 ** 3).toFixed(1);
for (const dir of incrementalDirs(target)) {
  const size = dirSize(dir);
  if (size <= capBytes) continue;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`prune-target: dropped ${path.relative(process.cwd(), dir)} (${gb(size)} GB, cap ${gb(capBytes)} GB)`);
}
