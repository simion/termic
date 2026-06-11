#!/usr/bin/env node
// Regression test for the `make run` Ctrl+C bug: dev.mjs must tear down the
// ENTIRE tauri/cargo/app/vite subtree on SIGINT, even when
//   (a) node is not the process-group leader (it isn't, under make/npm), and
//   (b) the app ignores the signal and/or lives in a different group
//       (newer tauri CLIs run it that way → the terminal's Ctrl+C misses it).
//
// We stand in a fake `tauri` that spawns a stubborn grandchild which traps
// (ignores) SIGINT/SIGTERM. The only thing that can reap it is dev.mjs's
// tree-walking SIGKILL escalation. Run: `node scripts/dev.signals.test.mjs`.

import { spawn, execSync } from "node:child_process";
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEV = resolve(__dirname, "dev.mjs");
const TAG = `TERMICSIGTEST_${process.pid}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// pids whose command line carries our unique tag (the fake tauri + app).
function tagged() {
  try {
    return execSync(`ps -A -o pid=,command=`)
      .toString().split("\n")
      .filter(l => l.includes(TAG) && !l.includes("grep"))
      .map(l => Number(l.trim().split(/\s+/)[0]))
      .filter(Boolean);
  } catch { return []; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function run({ stubborn, cliDies = false }) {
  const dir = mkdtempSync(join(tmpdir(), "termic-sigtest-"));
  // Grandchild "app": optionally ignores INT/TERM (worst case). Tagged via $0.
  const app = join(dir, `${TAG}_app.sh`);
  writeFileSync(app, `#!/bin/bash\n${stubborn ? "trap '' INT TERM\n" : ""}while true; do sleep 0.2; done\n`);
  chmodSync(app, 0o755);
  // Fake tauri CLI: spawns the app and waits. Two flavors:
  //   - default: ignores signals itself, so teardown can't rely on it
  //     forwarding anything;
  //   - cliDies: exits the moment SIGINT lands (the REAL tauri CLI does
  //     this) - the app reparents to pid 1, which is exactly the case the
  //     snapshot-based straggler kill exists for. A fresh tree walk after
  //     the CLI's death can't see the app anymore.
  const tauri = join(dir, `${TAG}_tauri.sh`);
  writeFileSync(tauri, cliDies
    ? `#!/bin/bash\ntrap 'exit 0' INT TERM\n"${app}" &\nwhile true; do sleep 0.2; done\n`
    : `#!/bin/bash\ntrap '' INT TERM\n"${app}" &\nwhile true; do sleep 0.2; done\n`);
  chmodSync(tauri, 0o755);

  // Spawn dev.mjs NON-detached so node shares our process group (i.e. is NOT
  // the group leader) — exactly the make/npm situation the fix must handle.
  const node = spawn(process.execPath, [DEV], {
    stdio: "ignore",
    env: { ...process.env, TERMIC_TAURI_BIN: tauri, PORT: "15999", TERMIC_KILL_GRACE_MS: "800" },
  });
  let nodeExited = false;
  node.on("exit", () => { nodeExited = true; });

  await sleep(1500);                       // let the tree spin up
  const before = tagged();
  process.kill(node.pid, "SIGINT");        // the Ctrl+C under test
  await sleep(2500);                       // > grace (800ms) + slack
  const after = tagged().filter(alive);

  rmSync(dir, { recursive: true, force: true });
  return { before, after, nodeExited, nodePid: node.pid, nodeAlive: alive(node.pid) };
}

let failed = false;
const CASES = [
  { stubborn: false, cliDies: false, label: "app honors SIGINT (graceful)" },
  { stubborn: true,  cliDies: false, label: "app ignores SIGINT (force SIGKILL escalation)" },
  { stubborn: true,  cliDies: true,  label: "CLI dies on SIGINT, app reparents to pid 1 (snapshot kill)" },
];
for (const { stubborn, cliDies, label } of CASES) {
  const r = await run({ stubborn, cliDies });
  const treeDown = r.after.length === 0;
  const ok = r.before.length >= 2 && treeDown && r.nodeExited && !r.nodeAlive;
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  console.log(`  spawned ${r.before.length} tagged procs; survivors after Ctrl+C: [${r.after.join(", ")}]; node exited=${r.nodeExited}`);
  if (!ok) {
    failed = true;
    // Leave nothing running if we failed mid-way.
    for (const pid of r.after) { try { process.kill(pid, "SIGKILL"); } catch {} }
    if (r.nodeAlive) { try { process.kill(r.nodePid, "SIGKILL"); } catch {} }
  }
}
console.log(failed ? "\nSIGNALS TEST FAILED" : "\nSIGNALS TEST PASSED");
process.exit(failed ? 1 : 0);
