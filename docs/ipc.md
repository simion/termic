# IPC

## Tauri commands

- **Tasks**: `task_create` (async, streams setup via `setup-output://<ws_id>` + `setup-done://<ws_id>`), `task_archive`/`task_delete` (async, spawn_blocking), `task_open_repo`, `task_run_script_stream` + `task_stop_script` (PIDs in `RUNNING_SCRIPTS`, child has `process_group(0)` for clean SIGTERM tree-kill).
- **PTYs**: `pty_spawn`/`pty_write`/`pty_resize`/`pty_kill`. Emits `pty://<id>` (`PtyChunk { data: Vec<u8> }`) and `pty-exit://<id>` (`PtyExit { code: Option<i32> }`).
- **Scripts**: emit `script-output://<wsId>:<kind>` (`{ line }`) + `script-done://<wsId>:<kind>` (`{ code, success }`). `kind` in `setup`/`run`.
- **Settings/discovery**: `settings_load`/`settings_save`/`agents_save`/`discover_repos`/`detect_clis`/`list_monospace_fonts`/`list_font_families` (async + spawn_blocking + OnceLock cache — font-kit is 7s synchronous). `list_font_families` is the unfiltered family list (installed-ness checks); `list_monospace_fonts` is the `is_monospace()` subset (picker extras) — the latter trusts the post-table isFixedPitch bit, so it misses real monospace fonts with sloppy metadata.
- **Files**: `workspace_file_read` (text, 2 MB cap) / `workspace_file_write`, `workspace_file_read_base64` (async + spawn_blocking; images only by extension whitelist, 10 MB cap, takes `known_fp` and returns `{ unchanged, mime?, data?, fp }` for the markdown preview's data: URLs — `unchanged: true` skips the read+encode when `known_fp` still matches, the fast path for agent-settle revalidation storms), `workspace_path_stat` (`{ exists, is_dir }`, tolerates a missing leaf so link-existence checks don't error — also accepts a path that's exactly a composition member's own root, via `resolve_workspace_git_path_ex`). All four are member-aware (`resolve_workspace_git_path`) and worktree-contained (`safe_workspace_path` for an existing target, `check_workspace_path_existence` when the target may legitimately be missing); both file reads run through `read_capped_file` (TOCTOU-safe: fstat on the open handle, not a separate path stat).
- **Misc**: `notify`, `open_path` (handles URLs via macOS `open`), `home_dir`, `path_exists`, `log_line`.

## Critical shapes (fail silently)

- `pty_spawn` payload is `{ args: SpawnArgs }`, NOT `SpawnArgs` at top level. Wrong shape → "invalid length 0, expected struct SpawnArgs".
- Listener payload is `ev.payload.data` / `ev.payload.line` — Rust emits structs, not bare arrays. Wrong unpack → blank terminals, no error.
- `task_run_script` takes `{ id, which }`. Forgetting `which` → silent no-op.

## Long-running IPC discipline

**Any IPC doing heavy IO MUST be `async fn` + `tauri::async_runtime::spawn_blocking`.** Synchronous commands run on the IPC handler thread = same thread driving WKWebView event loop in dev. `fs::remove_dir_all` on a 50k-inode `.venv` froze the entire Mac. Already applied to `task_archive`, `task_delete`, `list_monospace_fonts`. Pair with `useUI.setBusy("…")` overlay so the user knows a multi-second op is in flight.
