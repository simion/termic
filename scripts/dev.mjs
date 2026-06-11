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

// Follow the child: when `tauri dev` is gone, so are we - but NEVER
// leave its helpers behind, regardless of how it ended. Ctrl+C teardown,
// a crash, or the app quitting itself (Cmd+Q, the automation bridge's
// /quit) must all sweep: the CLI exiting does NOT take npm/vite with it,
// and an orphaned vite squats on the port until killed by hand.
child.on("exit", code => {
  cleanup();
  // Brief beat for signalled processes to die on their own, then SIGKILL
  // whatever from the teardown snapshot / live walk is still around.
  setTimeout(() => {
    killStragglers();
    process.exit(tearingDown ? 130 : (code ?? 0));
  }, tearingDown ? 400 : 150);
});
child.on("error", err => { cleanup(); console.error(err); process.exit(1); });

// We tear the dev stack down by WALKING THE TREE (ps snapshot, BFS over
// parent→child links) rather than killing a process group, because:
//   - under `make`/`npm` node is NOT the group leader, so `kill(-node.pid)`
//     is ESRCH (this was the bug in the first fix attempt); and
//   - newer tauri CLIs run the app in a DIFFERENT process group, so the
//     terminal's Ctrl+C never reaches it and it survives as an orphan
//     (the actual regression).
// Tree-walking sidesteps both: it finds tauri/cargo/app/vite by ppid no
// matter their groups, and it never backgrounds vite (no detach → no
// SIGTTIN stalls).
//
// Teardown targets are tracked in a ROLLING snapshot (pid → command),
// refreshed every few seconds and at signal time. A point-in-time walk
// is not enough: the helpers (npm/vite, the app) reparent to pid 1 the
// INSTANT the tauri CLI dies - on its exit, or even mid-Ctrl+C - and a
// fresh tree walk can no longer see them. Recording the command name
// alongside the pid means a pid recycled by the OS after our process
// died is never killed by mistake: kill only when the live command
// still matches what we recorded.
const known = new Map(); // pid → comm
let tearingDown = false;

function psTable() {
  const out = new Map();
  try {
    for (const line of execSync("ps -A -o pid=,ppid=,comm=").toString().trim().split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (m) out.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
    }
  } catch {}
  return out;
}

/**
 * Refresh `known`: prune entries whose pid is gone or recycled (live
 * command no longer matches the recorded one), then record every current
 * descendant. Pruning matters because `known` would otherwise accumulate
 * dead pids over an hours-long dev session, and `sweep` would signal
 * whatever unrelated process the OS recycled them onto. Pruning cannot
 * lose the reparented-to-pid-1 helpers this map exists for: those are
 * alive with an unchanged command, so they survive the comm check.
 */
const snapshotTree = () => {
  const table = psTable();
  for (const [pid, comm] of known) {
    const cur = table.get(pid);
    if (!cur || cur.comm !== comm) known.delete(pid);
  }
  const kids = new Map();
  for (const [pid, { ppid }] of table) {
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const stack = [process.pid];
  while (stack.length) {
    const p = stack.pop();
    for (const c of kids.get(p) || []) {
      known.set(c, table.get(c)?.comm ?? "");
      stack.push(c);
    }
  }
};
snapshotTree();
setInterval(snapshotTree, 3000).unref();

const sweep = (signal) => {
  snapshotTree();
  for (const pid of known.keys()) { try { process.kill(pid, signal); } catch {} }
};
const killStragglers = () => {
  snapshotTree();
  const table = psTable();
  for (const [pid, comm] of known) {
    const cur = table.get(pid);
    if (!cur || cur.comm !== comm) continue; // already gone, or pid recycled
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
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
