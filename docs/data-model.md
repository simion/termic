# Data model

## Directories

Three directories, different owners:
- `~/Library/Application Support/termic/` — app-owned: `projects.json`, `workspaces/`, `settings.json`. Path via `dirs::data_local_dir().join("termic")` in `lib.rs#data_dir()`.
- `~/Library/Application Support/com.simion.termic/` — tauri-plugin-window-state owned (window position/size). Path from `tauri.conf.json#identifier`.
- `~/.config/termic/themes/` — user-owned, hand-authored custom theme files ([docs/themes.md](themes.md)). `$XDG_CONFIG_HOME` respected; shared by release + dev builds (no `termic_dev` split). Path via `lib.rs#themes_dir_path()`.

## Entities

- **Project** (`projects.json`, single JSON array) — git repo path + scripts + `preview_url` template + `files_to_copy` globs + `default_cli`.
- **Workspace** (`workspaces/<uuid>.json`) — git worktree branched from project's `base_branch`. Worktrees live at `~/termic/workspaces/<project>/<name>/`. `is_repo_root=true` workspaces point at the project's live checkout (no worktree, archive skips `rm -rf`).
- **Settings** (`settings.json`) — `repos_dir`, `welcomed`, `agents[]` (claude/gemini/codex defaults + customs; each has `command`/`args`/`yolo_args`/`runtime_yolo_command`). Defaults seeded if `agents` is empty.
- **Tab** (per workspace, in `useApp`) — `terminal` (PTY running a CLI), `edit` (CodeMirror), `diff` (vs HEAD). PTYs die with the app.
