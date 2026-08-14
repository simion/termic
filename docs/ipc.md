# IPC

## Tauri commands

- **Tasks**: `task_create` (async, streams setup via `setup-output://<ws_id>` + `setup-done://<ws_id>`), `task_archive`/`task_delete` (async, spawn_blocking), `task_open_repo`, `task_run_script_stream` + `task_stop_script` (PIDs in `RUNNING_SCRIPTS`, child has `process_group(0)` for clean SIGTERM tree-kill).
- **PTYs**: `pty_spawn`/`pty_write`/`pty_resize`/`pty_kill`. Emits `pty://<id>` (`PtyChunk { data: Vec<u8> }`) and `pty-exit://<id>` (`PtyExit { code: Option<i32> }`). `SpawnArgs.role` (`{ task_id, kind: "agent"|"aux", is_default }`) is the CLI attach/logs identity and allocates the 256 KiB output ring; it is deliberately separate from `task_id`, which doubles as the sandbox trigger (the aux shell carries a role but never a task_id).
- **Scripts**: emit `script-output://<wsId>:<kind>` (`{ line }`) + `script-done://<wsId>:<kind>` (`{ code, success }`). `kind` in `setup`/`run`.
- **Settings/discovery**: `settings_load`/`settings_save`/`agents_save`/`discover_repos`/`detect_clis`/`list_monospace_fonts`/`list_font_families` (async + spawn_blocking + OnceLock cache — font-kit is 7s synchronous). `list_font_families` is the unfiltered family list (installed-ness checks); `list_monospace_fonts` is the `is_monospace()` subset (picker extras) — the latter trusts the post-table isFixedPitch bit, so it misses real monospace fonts with sloppy metadata.
- **Files**: `workspace_file_read` (text, 2 MB cap) / `workspace_file_write`, `workspace_file_read_base64` (async + spawn_blocking; images only by extension whitelist, 10 MB cap, takes `known_fp` and returns `{ unchanged, mime?, data?, fp }` for the markdown preview's data: URLs — `unchanged: true` skips the read+encode when `known_fp` still matches, the fast path for agent-settle revalidation storms), `workspace_path_stat` (`{ exists, is_dir }`, tolerates a missing leaf so link-existence checks don't error — also accepts a path that's exactly a composition member's own root, via `resolve_workspace_git_path_ex`). `task_file_fp` is the same resolution with no read at all: it returns just the `mtime:len` fingerprint, so the PDF pane can tell a real rewrite from an agent-settle tick without pulling a 20 MB file through the IPC it doesn't need (the bytes go over the `taskpdf:` scheme). All of them are member-aware (`resolve_workspace_git_path`) and worktree-contained (`safe_workspace_path` for an existing target, `check_workspace_path_existence` when the target may legitimately be missing); both file reads run through `read_capped_file` (TOCTOU-safe: fstat on the open handle, not a separate path stat).
- **Misc**: `notify`, `open_path` (handles URLs via macOS `open`), `home_dir`, `path_exists`, `log_line`.

## `termic://` deep links (GH #192)

A public integration surface: an external system (ticket tracker, internal dashboard, shell alias) opens Termic on a **pre-filled New Task dialog**.

```
termic://new?project=web&worktree=1&name=fix-login&p=Fix%20the%20login%20bug
```

| param | meaning |
| --- | --- |
| `project` | **required.** Registered project, by id or by name (case-insensitive). |
| `name` | task name (max 200 chars) |
| `prompt` / `p` | first message, pre-filled into the dialog (max 8000 chars) |
| `agent` / `cli` | agent id to pre-select; ignored if this install doesn't offer it |
| `mode` | `worktree` or `main`. `worktree=1` is the shorthand. |
| `base` | "Branch from" ref |

**The link never creates anything.** It only fills the form; a human presses Create. That is the whole security model for accepting a `prompt` from an untrusted cross-application channel (any web page can navigate to a URL scheme), and it is why an unregistered `project` is a hard error rather than a fallback to "the first project" or a silent project add. Do not add an auto-create or skip-confirmation option.

Where the pieces live:

- **Scheme registration**: `tauri.conf.json` → `plugins.deep-link.desktop.schemes`. The bundler turns this into `CFBundleURLTypes`; it merges with the hand-written `src-tauri/Info.plist` rather than replacing it. **Deep links only work from a bundled `.app`** — not under `npm run tauri:dev`, so test with `make beta` or `tauri build`.
- **Rust** (`lib.rs`) is a pipe, not a parser: every arriving URL lands in `PENDING_DEEP_LINKS` and the webview gets a payload-free nudge (`termic://deep-link`). The queue exists because macOS delivers the launch URL while the webview is still booting; the webview always reads through `deep_link_take_pending`, which drains atomically, so a link is never handled twice.
- **Parsing + validation** is entirely in `src/lib/deepLink.ts`, because the check that matters (is this a *registered* project?) needs the webview store. `initDeepLinks()` is chained off `loadAll()` in `App.tsx` for the same reason.
- **Second instance**: on Windows/Linux a link spawns a fresh process, which the single-instance preflight kills. It hands the URL over first via the control socket's unauthenticated `open_url` verb (proto v11), which raises and queues in one request. macOS never gets here (LaunchServices routes to the running app).

## Critical shapes (fail silently)

- `pty_spawn` payload is `{ args: SpawnArgs }`, NOT `SpawnArgs` at top level. Wrong shape → "invalid length 0, expected struct SpawnArgs".
- Listener payload is `ev.payload.data` / `ev.payload.line` — Rust emits structs, not bare arrays. Wrong unpack → blank terminals, no error.
- `task_run_script` takes `{ id, which }`. Forgetting `which` → silent no-op.

## Long-running IPC discipline

**Any IPC doing heavy IO MUST be `async fn` + `tauri::async_runtime::spawn_blocking`.** Synchronous commands run on the IPC handler thread = same thread driving WKWebView event loop in dev. `fs::remove_dir_all` on a 50k-inode `.venv` froze the entire Mac. Already applied to `task_archive`, `task_delete`, `list_monospace_fonts`. Pair with `useUI.setBusy("…")` overlay so the user knows a multi-second op is in flight.
