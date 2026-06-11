# Automation bridge (dev-only)

`src-tauri/src/automation.rs`. Agent-driven E2E against the LIVE app (tauri-driver has no macOS support). Armed only when debug build + `TERMIC_AUTOMATION=1`: localhost HTTP server, port+token printed to the debug log (`[automation] listening`).

## Routes

- `POST /eval` — body = async-function body, runs in the webview, returns `{ok, value}`. `window.__termic` exposes zustand stores + ipc wrappers (dev bundles only).
- `GET /screenshot`
- `POST /raise?on=1|0` — always-on-top + all-Spaces + fullscreen-auxiliary + app activation
- `POST /quit`
- `GET /info`

## Isolation

`TERMIC_DATA_DIR` (scratch profile) + `PORT` (parallel vite). `scripts/fake-agent.sh` registers as a custom agent so spawn/resume/queue flows are testable without burning real tokens.

## Rules (learned the hard way)

- Tear down by SIGTERM-ing dev.mjs (its sweep reaps the whole tree; `/quit` alone leaves vite on the port).
- Never touch `src-tauri/` while a driven instance runs — the watcher restart strands the old app process.
- Occluded/other-Space windows report `visibilityState=hidden` and FREEZE rAF. PTY spawns survive because TerminalPane's rAF gate has a timeout fallback — do not remove it.
- Prefer store/DOM assertions over screenshots (screenshots need Screen Recording TCC for the dev binary).
- Frontend edits: eval `location.reload()`.

## E2E skill

The full recipe (isolated launch, readiness polling, eval/assert examples, fake-agent registration, raise/screenshot, teardown) lives in the **`e2e` skill** (`.claude/skills/e2e/SKILL.md`). A persistent pre-seeded profile lives at `.e2e/` (gitignored): fixture repo + fakeagent already registered. Load the skill before verifying UI flows — don't improvise variants of its commands; the teardown rules are load-bearing.
