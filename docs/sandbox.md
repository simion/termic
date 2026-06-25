# Sandbox

`src-tauri/src/sandbox.rs` + `WorkspaceSandboxDialog`. Per-workspace macOS sandbox-exec (Seatbelt) + per-workspace in-process HTTPS CONNECT proxy (`src-tauri/src/proxy.rs`).

## Scope

ONLY the agent CLI's PTY is sandboxed. AuxTerminal, setup script, run script, and archive script run unsandboxed by design — they're user-authored shell needing full reach. The carve-out is enforced by not passing `workspace_id` in `pty_spawn` / routing scripts through `run_script` which never calls `sandbox::provision`.

## Modes (`SandboxMode`)

Four states, set per-workspace at create + editable later. `Enforce` is the full cage and is intentionally never weakened.

- **Off** — no cage.
- **Monitor** — allow everything, LOG every file op + network request.
- **Enforce** — full cage: seatbelt FS allow-list **and** network pinned to the loopback proxy.
- **EnforceFs** (serialized `"enforce-fs"`, UI "ENFORCING (FS)") — the **filesystem cage only**. Identical FS allow-list to `Enforce`, but the network sandbox is OFF: `render_profile` emits `(allow network*)` and `provision` starts **no proxy** (so `wrap_command` injects no `http_proxy`). For users who want write/read isolation but unrestricted egress (their own egress controls, VPN, non-HTTP traffic). UI consequence: every network surface is hidden in this mode (host allow-list field in both dialogs, "Blocked hosts" section + "+ domains" copy in the footer activity popover) — only FS rows show. YOLO auto-on (the FS seatbelt is still the real boundary), accent-colored shield.

## Layered model

1. `sandbox-exec -f <profile.sb>` — kernel seatbelt. Profile rendered to `$TMPDIR/termic-sandbox-<wsId>.sb`. Allows broad `file-read*`, narrow `file-write*` on workspace + agent dirs + caches. Secrets (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.docker/config.json`, `~/.kube`, `~/.config/gh/hosts.yml`, Keychains) ALWAYS denied. `(deny network*)` except loopback to the proxy — UNLESS `EnforceFs`, which emits `(allow network*)` instead.
2. Per-workspace **in-process CONNECT proxy** on an OS-assigned port (Rust thread inside Tauri binary). Regex hostname allowlist per CLI: claude→anthropic, gemini→google, codex→openai + baseline (github, npmjs, pypi, crates.io, CA OCSP) + workspace extras. Non-matching → HTTP 403. Stopped via `SandboxBundle::Drop` on PTY teardown. **Not started in `EnforceFs`** (no network sandbox).

## Key behaviors

- **Pinning**: `Workspace.sandbox_enabled` captured at create time. Edit later via `workspace_set_sandbox`, which persists AND SIGKILLs every live PTY (otherwise the running process holds the old profile). `WorkspaceSandboxDialog` warns before save.
- **YOLO interaction**: when `ws.sandbox_enabled`, spawn args always include `yolo_args` regardless of global YOLO toggle — the seatbelt is the real boundary. Toolbar `Zap`: OFF→gray, ON+sandboxed→green, ON+unsandboxed→red+pulsing+warning tooltip. Code in `UnifiedBar.tsx`.
- **Default sets** baked into Rust (`builtin_rw_paths`/`builtin_deny_paths`, per-CLI `render_filter` in `sandbox.rs`). Project `sandbox_*` fields are extras only, seeded at workspace creation.
- **Recent denies**: `workspace_recent_denials(id, minutes?)` shells to `log show` filtered to workspace path + "deny". Surfaced in sandbox dialog under lazy `<details>`.

## Do NOT

- Sandbox AuxTerminal, setup, run, or archive scripts.
- Expose `workspace_set_sandbox` without SIGKILLing live PTYs by default. `kill_live=false` is an explicit escape hatch with a warning — don't make it the default.
