#!/usr/bin/env node
// Launches `tauri dev` with a PORT-driven `devUrl` override so the
// frontend port is set in ONE place (the PORT env var) and both Vite
// (via vite.config.ts) and Tauri agree.
//
// Passes the override as a temp JSON file rather than an inline string —
// some Tauri 2 builds only apply build.devUrl from file-based overrides,
// not from inline JSON strings.

import { spawn, execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// TERMIC_TAURI_BIN is a test seam (scripts/dev.signals.test.mjs); real runs
// use the bundled tauri CLI.
const TAURI_BIN = process.env.TERMIC_TAURI_BIN || resolve(__dirname, "../node_modules/.bin/tauri");

const port = Number(process.env.PORT) || 1420;
const devUrl = `http://localhost:${port}/`;

const tmpConf = resolve(tmpdir(), `termic-dev-override-${port}.json`);
writeFileSync(tmpConf, JSON.stringify({ build: { devUrl } }));

const child = spawn(TAURI_BIN, ["dev", "--config", tmpConf, ...process.argv.slice(2)], {
  // OWN SESSION (detached) + no stdin. This is the actual Ctrl+C fix:
  // tauri's dev runner calls tcsetpgrp() to foreground transient process
  // groups on OUR terminal (cargo during builds) and never restores it -
  // the tty's foreground group ends up EMPTY, so the ^C keypress turns
  // into a SIGINT delivered to nobody and the whole stack survives
  // (reproduced: pty fg pgid pointed at a dead group while every process
  // sat in make's group). A child in its own session CANNOT retarget our
  // terminal's foreground group (it's not its controlling tty), so make +
  // node keep the foreground and SIGINT always reaches the handler below.
  // stdout/stderr still inherit the tty (colors + progress bars intact);
  // stdin is /dev/null - vite's interactive keys don't work under
  // `make dev`, which is the accepted cost.
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, PORT: String(port) },
});

let cleaned = false;
const cleanup = () => { if (!cleaned) { cleaned = true; try { unlinkSync(tmpConf); } catch {} } };

// Follow the child: when `tauri dev` (and its cargo/app/vite subtree) is
// gone, so are we. EXCEPT mid-teardown: the CLI dying must not let us
// exit before the straggler kill below has run - the app outlives the
// CLI by design of the bug we're fixing.
child.on("exit", code => {
  cleanup();
  if (!tearingDown) process.exit(code ?? 0);
  // Brief beat for SIGINT'd processes to die on their own, then SIGKILL
  // whatever from the teardown snapshot is still around and leave.
  setTimeout(() => { killStragglers(); process.exit(130); }, 400);
});
child.on("error", err => { cleanup(); console.error(err); process.exit(1); });

// Every pid below `root` in the process tree, from a single `ps` snapshot
// (BFS over parent→child links). We tear the dev stack down by WALKING THE
// TREE rather than killing a process group, because:
//   - under `make`/`npm` node is NOT the group leader, so `kill(-node.pid)`
//     is ESRCH (this was the bug in the first fix attempt); and
//   - newer tauri CLIs run the app in a DIFFERENT process group, so the
//     terminal's Ctrl+C never reaches it and it survives as an orphan
//     (the actual regression).
// Tree-walking sidesteps both: it finds tauri/cargo/app/vite by ppid no
// matter their groups, and it never backgrounds vite (no detach → no
// SIGTTIN stalls).
function descendants(root) {
  const out = [];
  try {
    const kids = new Map();
    for (const line of execSync("ps -A -o pid=,ppid=").toString().trim().split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(pid);
    }
    const stack = [root];
    while (stack.length) {
      const p = stack.pop();
      for (const c of kids.get(p) || []) { out.push(c); stack.push(c); }
    }
  } catch {}
  return out;
}
// Teardown targets are SNAPSHOTTED at signal time: once the tauri CLI
// dies, cargo/the app reparent to pid 1 and a fresh tree walk from our
// pid can no longer see them - killing only live-walk results would
// orphan exactly the processes we're after. Union of snapshot + current
// walk covers both the reparented and the freshly spawned.
const teardownPids = new Set();
let tearingDown = false;

const sweep = (signal) => {
  const targets = descendants(process.pid);
  for (const pid of targets) teardownPids.add(pid);
  for (const pid of targets) { try { process.kill(pid, signal); } catch {} }
};
const killStragglers = () => {
  const targets = new Set([...teardownPids, ...descendants(process.pid)]);
  for (const pid of targets) { try { process.kill(pid, "SIGKILL"); } catch {} }
};

// Ctrl+C handling. The OLD bug: the handler called process.exit() straight
// away, so node died and ABANDONED the tauri/cargo/app subtree. It looked
// fine only because the terminal also delivers SIGINT to the foreground
// group — until npm 11 / a newer tauri CLI changed that propagation and the
// app started surviving Ctrl+C as an orphan.
let signals = 0;
const onSignal = (signal) => {
  cleanup();
  tearingDown = true;
  // Impatient second Ctrl+C → hard-kill the whole subtree now.
  if (++signals >= 2) { killStragglers(); process.exit(130); return; }
  // Graceful first pass: deliver the signal to the entire subtree (the
  // terminal's ^C never reaches it - see the spawn comment), then wait for
  // child "exit" (whose handler runs killStragglers). If the CLI itself
  // hangs past the grace window, escalate to SIGKILL from here instead.
  sweep(signal);
  // Grace window before the hard kill (overridable for the signals test).
  const graceMs = Number(process.env.TERMIC_KILL_GRACE_MS) || 5000;
  setTimeout(() => { killStragglers(); process.exit(130); }, graceMs).unref();
};
process.on("SIGINT",  () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
