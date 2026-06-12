---
name: e2e
description: Launch termic in dev mode and drive the live app via the localhost automation bridge - eval JS in the webview, read stores, click UI, take screenshots. Use when the user asks to verify/test something in the running app, AND proactively before declaring done on changes that impact UI flows (workspace create/archive, PTY spawn/resume, tabs, sidebar, dialogs, settings).
---

# Drive termic (dev automation bridge)

The bridge (src-tauri/src/automation.rs) is a localhost HTTP server inside
DEBUG builds, armed only when `TERMIC_AUTOMATION=1`. It can eval JS in the
webview (with results), screenshot the window, and quit the app.

## Launch (persistent E2E profile - seed once, reuse forever)

Never drive the user's own session. The repo keeps a gitignored
persistent profile at `.e2e/` so the seeding (fixture repo + fake agent)
happened ONCE and every later run reuses it:

```
.e2e/profile/        TERMIC_DATA_DIR: settings.json, projects.json, workspaces/
.e2e/fixture-repo/   tiny git repo, registered as project "fixture-repo"
```

Recreate only if `.e2e/` is missing:

```sh
mkdir -p .e2e/profile && echo '{"welcomed": true}' > .e2e/profile/settings.json
git init -q .e2e/fixture-repo && (cd .e2e/fixture-repo && echo "# e2e fixture" > README.md \
  && git add . && git -c user.email=e2e@termic.dev -c user.name=e2e commit -qm "init fixture")
```

Launch with FIXED automation port + token so every command below is
copy-paste (no grepping for random values):

```sh
TERMIC_AUTOMATION=1 TERMIC_AUTOMATION_PORT=45901 \
TERMIC_AUTOMATION_TOKEN=e2e-local-$(id -u) \
TERMIC_DATA_DIR="$PWD/.e2e/profile" PORT=1599 make dev   # run in background
B=http://127.0.0.1:45901; T=e2e-local-$(id -u)
```

Wait for readiness by polling the log (NOT sleeps) - the listening line
goes to BOTH the debug log and the dev stdout:

```sh
LOG="$(python3 -c 'import tempfile;print(tempfile.gettempdir()+"/termic-debug.log")')"
grep "\[automation\] listening on 127.0.0.1:45901" "$LOG" | tail -1
```

First build after a Rust change takes 1-2 min; the app window appears on
screen (it is a real GUI instance - usually unfocused/behind; `POST
/raise?on=1` floats it for the user to watch).

## Drive it

All requests carry the token: `?t=TOKEN` or `X-Automation-Token: TOKEN`.

```sh
BASE=http://127.0.0.1:PORT
curl -s "$BASE/info?t=TOKEN"                          # version, pid, data dir, window rect
curl -s -X POST --data-binary 'return 1+1' "$BASE/eval?t=TOKEN"
curl -s "$BASE/screenshot?t=TOKEN" -o /tmp/termic.png  # then Read the png
curl -s -X POST "$BASE/quit?t=TOKEN"                   # teardown
```

`/eval` bodies are the BODY OF AN ASYNC FUNCTION - `return` produces the
response value (JSON: `{ok, value}`). `window.__termic` (dev-only, main.tsx)
exposes the app's internals:

- `__termic.useApp / useUI / usePrefs` - the zustand stores (`.getState()`)
- `__termic.ipc` - every wrapper from src/lib/ipc.ts
- `__termic.invoke` - raw Tauri invoke

Examples:

```js
// Read state
return __termic.useApp.getState().workspaces.map(w => w.name);

// Drive real flows through the app's own IPC
const p = await __termic.ipc.projectAdd("/path/to/repo");
const ws = await __termic.invoke("workspace_open_repo", { projectId: p.id, cli: "fakeagent", name: null });
await __termic.useApp.getState().loadAll();
__termic.useApp.getState().setActiveWorkspace(ws.id);
return ws.id;

// Click UI by DOM (semantic clicks; the whole app is one webview)
[...document.querySelectorAll("button")].find(b => b.textContent === "Git").click();
return document.body.textContent.includes("No uncommitted changes");
```

## Seeding (already done in the committed-profile flow; idempotent)

The persistent profile already contains the `fakeagent` agent
(`scripts/fake-agent.sh` - real PTY, echoes its argv + stdin, zero
tokens) and the `fixture-repo` project. This eval re-seeds ONLY what is
missing, so it is safe to run unconditionally as step 1 of any session:

```js
await __termic.useApp.getState().loadAll();
const st = __termic.useApp.getState();
if (!st.agents.some(a => a.id === "fakeagent")) {
  const defs = await __termic.ipc.agentsDefaults();
  // Clone a default - the Agent schema has required fields (icon_id...);
  // never hand-write the object.
  const fake = JSON.parse(JSON.stringify(defs.find(a => a.id === "claude")));
  fake.id = "fakeagent"; fake.display_name = "FakeAgent";
  fake.command = "<ABS REPO PATH>/scripts/fake-agent.sh";
  fake.args = []; fake.yolo_args = [];
  await __termic.ipc.agentsSave([...(st.agents.length ? st.agents : defs), fake]);
}
// NOTE: project root_path is CANONICALIZED on add (symlinks resolved),
// so match by name, not by the path you passed in.
if (!st.projects.some(p => p.name === "fixture-repo")) {
  await __termic.ipc.projectAdd("<ABS REPO PATH>/.e2e/fixture-repo");
}
await __termic.useApp.getState().loadAll();
return __termic.useApp.getState().projects.map(p => p.name);
```

## Worked example (verified end to end, 2026-06-11)

The complete reference flow, run live against the persistent profile:
seed check, workspace reuse-or-create through real IPC, spawn assert,
argv receipt, PTY round-trip, UI click. Every step's assertion shape is
exactly what worked.

```sh
# 1. Launch (see above). B/T are the fixed base URL + token.
curl -s "$B/info?t=$T"   # sanity: data_dir must be .../.e2e/profile

# 2. Seed-if-missing (the eval from "Seeding" above). No-op on reuse.

# 3. Repo-root workspace: REUSE if one is live, create otherwise.
#    (Repo-root = no worktree, archive never rm -rfs; ideal fixture.)
curl -s -X POST --data-binary '
const st = __termic.useApp.getState();
const proj = st.projects.find(p => p.name === "fixture-repo");
let ws = st.workspaces.find(w => !w.archived && w.project_id === proj.id);
if (!ws) {
  ws = await __termic.invoke("workspace_open_repo", { projectId: proj.id, cli: "fakeagent", name: null });
  await __termic.useApp.getState().loadAll();
}
__termic.useApp.getState().setActiveWorkspace(ws.id);
return { wsId: ws.id, isRepoRoot: ws.is_repo_root };' "$B/eval?t=$T"

# 4. Assert the spawn (poll until hasPty; usually first try, ~2-5s max):
curl -s -X POST --data-binary '
const s = __termic.useApp.getState();
const ws = s.workspaces.find(w => !w.archived);
return (s.tabs[ws.id] ?? []).map(t => ({ cli: t.cli, hasPty: !!t.ptyId, sessionId: t.sessionId ?? null }));
' "$B/eval?t=$T"
# ...and the argv receipt in the debug log (proves resume flags). The log
# write can land a beat AFTER hasPty flips - re-grep before concluding:
grep "pty_spawn.*fake-agent" "$LOG" | tail -1
# → [pty_spawn] sandbox=OFF cmd=.../fake-agent.sh args=["--session-id", "<uuid>", "--name", "main"]

# 5. PTY round-trip (fake agent echoes stdin). Assert via lastOutputAt,
#    NOT innerText - xterm renders on a WebGL canvas, so terminal content
#    NEVER appears in the DOM (see operational rules).
curl -s -X POST --data-binary '
const s = __termic.useApp.getState();
const ws = s.workspaces.find(w => !w.archived);
const tab = s.tabs[ws.id][0];
await __termic.ipc.ptyWrite(tab.ptyId, Array.from(new TextEncoder().encode("ping\r")));
await new Promise(r => setTimeout(r, 800));
return { gotOutput: !!__termic.useApp.getState().tabs[ws.id][0].lastOutputAt };
' "$B/eval?t=$T"

# 6. UI interaction by DOM + assertion (non-terminal UI IS in the DOM):
curl -s -X POST --data-binary '
[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Git").click();
await new Promise(r => setTimeout(r, 600));
return document.body.innerText.includes("Working tree is clean");
' "$B/eval?t=$T"

# 7. Teardown: SIGTERM the dev.mjs node process (NOT /quit alone).
#    Leave the workspace in place - the next run reuses it via step 3.
kill -TERM "$(ps aux | grep '[n]ode scripts/dev.mjs' | awk '{print $2}')"
```

## Production impact: none (verified)

- `window.__termic` is behind `import.meta.env.DEV` - confirmed absent
  from the built bundle (`grep __termic dist/assets/*.js` finds only
  unrelated pre-existing strings).
- `automation.rs` arms only when `cfg!(debug_assertions) && TERMIC_AUTOMATION=1`;
  in release builds `armed()` is constant-false, `start()` returns
  immediately (no thread, no socket) and the `automation_result` command
  rejects.
- The one production-visible change is the TerminalPane rAF fallback,
  which FIXES a real stall (spawn waited forever when the window was
  occluded) at the cost of one setTimeout per spawn.

## Hard-won operational rules (each cost a debugging cycle)

- Check `ps aux | grep target/debug/termic` BEFORE launching: never reuse
  or kill an instance you did not start. Verify ownership before any kill
  via `ps -E -p PID | grep TERMIC_DATA_DIR`.
- TEARDOWN = `kill -TERM <dev.mjs pid>` (its sweep USUALLY reaps the whole
  tree, including reparented orphans). `/quit` alone kills only the app;
  vite can survive and squat on the port. CAVEAT: if a SECOND termic runs
  (your own session alongside the e2e one), `grep dev.mjs` matches both
  pids and the sweep may still leave the app child (`target/debug/termic`)
  alive. Discriminate ownership by ENV, not by guessing: `ps -E -p PID |
  grep -o 'TERMIC_AUTOMATION_PORT=45901'` (or `TERMIC_DATA_DIR=.../.e2e`)
  matches ONLY your e2e processes. After SIGTERM, re-`ps` and `kill -KILL`
  any surviving e2e-owned app child; never touch a pid without the e2e env.
- NEVER edit src-tauri/ while a driven instance runs: tauri-dev's watcher
  rebuilds and RESTARTS the app, stranding the old app process and
  invalidating the bridge. For Rust changes: tear down, rebuild, relaunch.
  Frontend changes: eval `location.reload()` re-applies the bundle
  in-place (HMR does not hot-apply store/effect changes).
- The driven window usually reports `document.visibilityState ===
  "hidden"` (occluded / other Space / Stage Manager) and rAF is FROZEN
  there. PTY spawns still work (TerminalPane has a timeout fallback on
  its rAF gate - do not remove it), and eval/IPC/stores all work hidden.
  `POST /raise?on=1` floats the window (always-on-top + all-Spaces +
  fullscreen-auxiliary + app activation) but may still not unhide it on
  every setup; do not block on visibility for state-level assertions.
- TERMINAL CONTENT IS NOT IN THE DOM. xterm renders to a WebGL canvas;
  `document.body.innerText` will never contain PTY output, no matter how
  long you wait. Assert terminal activity via `tab.lastOutputAt`, the
  store, or the debug-log argv receipt. All OTHER app UI (sidebar, tabs,
  dialogs, Git panel) is normal DOM and innerText-assertable.
- TO TEST PURE FRONTEND LOGIC NOT REACHABLE VIA STORES/IPC/CLICKS (input
  handlers, IME/WebKit input quirks, parsers, formatters): in dev, vite
  serves the source tree, so `const m = await import("/src/lib/foo.ts")`
  inside an /eval pulls the REAL production module into the live WKWebView.
  You then drive it against real DOM events in the actual engine - the
  only way to catch WebKit-specific behavior that happy-dom unit tests
  cannot. Verified pattern (the CJK-IME fix, PR #30): build a real
  `<textarea class="xterm-helper-textarea">`, `setupImeReplacementBridge`
  onto it with a capturing `write`, dispatch the exact WebKit
  `new InputEvent("input",{inputType,data})` sequence, and assert the
  reconstructed bytes. Run the buggy path (bridge off) as a negative
  control so a pass proves the fix, not just that code ran. NOTE: xterm's
  own listener on the REAL terminal textarea also fires (full wired path:
  textarea -> bridge -> real `ipc.ptyWrite` -> PTY -> fake-agent echo ->
  `lastOutputAt` advances); use a FRESH detached textarea when you want to
  capture only your handler's output in isolation.
- Paths round-trip canonicalized: `projectAdd("/Users/x/r/termic/...")`
  stores `root_path` with symlinks resolved (`/Users/x/Work/Repos/...`).
  Idempotence checks must match by `name` (or endsWith), never by the
  path you passed in.
- /screenshot additionally needs (a) the window actually visible and
  (b) Screen Recording permission granted to the dev binary (TCC prompts
  on first use; "could not create image" also means locked/asleep
  display). Prefer store/DOM assertions; screenshots are the garnish.
  Verified failure mode: `screencapture failed (Screen Recording
  permission?)` until the user grants it to the terminal app once in
  System Settings → Privacy & Security → Screen Recording.
- The bridge refuses everything in release builds; do not try to use it
  against an installed termic.app.
