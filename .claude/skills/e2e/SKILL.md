---
name: drive-termic
description: Launch termic in dev mode and drive the live app via the localhost automation bridge - eval JS in the webview, read stores, click UI, take screenshots. Use to verify changes end-to-end in the real app.
---

# Drive termic (dev automation bridge)

The bridge (src-tauri/src/automation.rs) is a localhost HTTP server inside
DEBUG builds, armed only when `TERMIC_AUTOMATION=1`. It can eval JS in the
webview (with results), screenshot the window, and quit the app.

## Launch an isolated instance

Never drive the user's own session. Use a scratch profile + a different
port (both are first-class seams):

```sh
PROFILE=/tmp/termic-auto-profile
mkdir -p "$PROFILE"
echo '{"welcomed": true}' > "$PROFILE/settings.json"   # skip the welcome dialog
TERMIC_AUTOMATION=1 TERMIC_DATA_DIR="$PROFILE" PORT=1599 make dev   # run in background
```

Wait for readiness by polling the debug log (NOT sleeps):

```sh
LOG="$(python3 -c 'import tempfile;print(tempfile.gettempdir()+"/termic-debug.log")')"
grep "\[automation\] listening" "$LOG" | tail -1
# → [automation] listening on 127.0.0.1:PORT token=TOKEN
```

First build after a Rust change takes 1-2 min; the app window appears on
screen (it is a real GUI instance).

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

## Fake agent (no tokens burned)

Register `scripts/fake-agent.sh` as a custom agent in the scratch profile,
then spawn workspaces with `cli: "fakeagent"` - real PTY, real spawn args
(assert `--session-id` / `--resume` in its echo), zero cost:

```js
const defs = await __termic.ipc.agentsDefaults();
await __termic.ipc.agentsSave([...defs, {
  id: "fakeagent", display_name: "FakeAgent",
  command: "<repo>/scripts/fake-agent.sh", args: [], yolo_args: [],
  capabilities: {},
}]);
await __termic.useApp.getState().loadAll();
```

## Worked example (verified end to end)

A complete session that registered a fixture agent, created a workspace
through real IPC, spawned it hidden, asserted the spawn args, exercised
the PTY, and clicked UI - the reference shape for live feature tests:

```sh
# 1. Launch isolated (see above), grep the log line for PORT + TOKEN.
B=http://127.0.0.1:PORT; T=TOKEN

# 2. Register the fixture agent (clone a default - the Agent schema has
#    required fields like icon_id; never hand-write the object).
curl -s -X POST --data-binary '
const defs = await __termic.ipc.agentsDefaults();
const fake = JSON.parse(JSON.stringify(defs.find(a => a.id === "claude")));
fake.id = "fakeagent"; fake.display_name = "FakeAgent";
fake.command = "<ABS REPO PATH>/scripts/fake-agent.sh";
fake.args = []; fake.yolo_args = [];
await __termic.ipc.agentsSave([...defs, fake]);
await __termic.useApp.getState().loadAll();
return __termic.useApp.getState().agents.map(a => a.id);
' "$B/eval?t=$T"

# 3. Project + repo-root workspace via real IPC, then activate it.
curl -s -X POST --data-binary '
const p = await __termic.ipc.projectAdd("/tmp/some-fixture-repo");
const ws = await __termic.invoke("workspace_open_repo", { projectId: p.id, cli: "fakeagent", name: null });
await __termic.useApp.getState().loadAll();
__termic.useApp.getState().setActiveWorkspace(ws.id);
return ws.id;' "$B/eval?t=$T"

# 4. Assert the spawn (poll until hasPty; ~2-5s):
curl -s -X POST --data-binary '
const s = __termic.useApp.getState();
const ws = s.workspaces.find(w => !w.archived);
return (s.tabs[ws.id] ?? []).map(t => ({ cli: t.cli, hasPty: !!t.ptyId, sessionId: t.sessionId ?? null }));
' "$B/eval?t=$T"
# ...and the argv receipt in the debug log (proves resume flags):
grep "pty_spawn.*fake-agent" "$LOG" | tail -1
# → cmd=.../fake-agent.sh args=["--session-id", "<uuid>", "--name", "main"]

# 5. PTY round-trip (fake agent echoes stdin):
curl -s -X POST --data-binary '
const s = __termic.useApp.getState();
const ws = s.workspaces.find(w => !w.archived);
const tab = s.tabs[ws.id][0];
await __termic.ipc.ptyWrite(tab.ptyId, Array.from(new TextEncoder().encode("ping\r")));
await new Promise(r => setTimeout(r, 800));
return { gotOutput: !!__termic.useApp.getState().tabs[ws.id][0].lastOutputAt };
' "$B/eval?t=$T"

# 6. UI interaction by DOM + assertion:
curl -s -X POST --data-binary '
[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Git").click();
await new Promise(r => setTimeout(r, 600));
return document.body.innerText.includes("Working tree is clean");
' "$B/eval?t=$T"

# 7. Teardown: SIGTERM the dev.mjs node process (NOT /quit alone).
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
- TEARDOWN = `kill -TERM <dev.mjs pid>` (its sweep reaps the whole tree,
  including reparented orphans). `/quit` alone kills only the app; vite
  can survive and squat on the port.
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
- /screenshot additionally needs (a) the window actually visible and
  (b) Screen Recording permission granted to the dev binary (TCC prompts
  on first use; "could not create image" also means locked/asleep
  display). Prefer store/DOM assertions; screenshots are the garnish.
- The bridge refuses everything in release builds; do not try to use it
  against an installed termic.app.
