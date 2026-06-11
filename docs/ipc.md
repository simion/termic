# IPC

## Tauri commands

- **Workspaces**: `workspace_create` (async, streams setup via `setup-output://<ws_id>` + `setup-done://<ws_id>`), `workspace_archive`/`workspace_delete` (async, spawn_blocking), `workspace_open_repo`, `workspace_run_script_stream` + `workspace_stop_script` (PIDs in `RUNNING_SCRIPTS`, child has `process_group(0)` for clean SIGTERM tree-kill).
- **PTYs**: `pty_spawn`/`pty_write`/`pty_resize`/`pty_kill`. Emits `pty://<id>` (`PtyChunk { data: Vec<u8> }`) and `pty-exit://<id>` (`PtyExit { code: Option<i32> }`).
- **Scripts**: emit `script-output://<wsId>:<kind>` (`{ line }`) + `script-done://<wsId>:<kind>` (`{ code, success }`). `kind` in `setup`/`run`.
- **Settings/discovery**: `settings_load`/`settings_save`/`agents_save`/`discover_repos`/`detect_clis`/`list_monospace_fonts` (async + spawn_blocking + OnceLock cache — font-kit is 7s synchronous).
- **Misc**: `notify`, `open_path` (handles URLs via macOS `open`), `home_dir`, `path_exists`, `log_line`.

## Critical shapes (fail silently)

- `pty_spawn` payload is `{ args: SpawnArgs }`, NOT `SpawnArgs` at top level. Wrong shape → "invalid length 0, expected struct SpawnArgs".
- Listener payload is `ev.payload.data` / `ev.payload.line` — Rust emits structs, not bare arrays. Wrong unpack → blank terminals, no error.
- `workspace_run_script` takes `{ id, which }`. Forgetting `which` → silent no-op.

## Long-running IPC discipline

**Any IPC doing heavy IO MUST be `async fn` + `tauri::async_runtime::spawn_blocking`.** Synchronous commands run on the IPC handler thread = same thread driving WKWebView event loop in dev. `fs::remove_dir_all` on a 50k-inode `.venv` froze the entire Mac. Already applied to `workspace_archive`, `workspace_delete`, `list_monospace_fonts`. Pair with `useUI.setBusy("…")` overlay so the user knows a multi-second op is in flight.
