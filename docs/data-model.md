# Data model

## Directories

Three directories, different owners:
- `~/Library/Application Support/termic/` — app-owned: `projects.json`, `tasks/`, `settings.json`. Path via `dirs::data_local_dir().join("termic")` in `lib.rs#data_dir()`.
- `~/Library/Application Support/com.simion.termic/` — tauri-plugin-window-state owned (window position/size). Path from `tauri.conf.json#identifier`.
- `~/.config/termic/themes/` — user-owned, hand-authored custom theme files ([docs/themes.md](themes.md)). `$XDG_CONFIG_HOME` respected; shared by release + dev builds (no `termic_dev` split). Path via `lib.rs#themes_dir_path()`.

## Entities

- **Project** (`projects.json`, single JSON array) — git repo path + scripts + `preview_url` template + `files_to_copy` globs + `default_cli` + optional `group` label (UI-only collapsible folder in the sidebar; no filesystem effect; a group exists iff ≥1 project carries the label. All group reads go through `groupOf()` in `src/lib/projectGroups.ts`, THE normalization point: trim + ALL-CAPS, so mixed-case labels on disk converge to one group. Collapse state + folder color live in `localStorage` keyed by normalized name, pruned when a group disappears).
- **Task** (`tasks/<uuid>.json`) — git worktree branched from project's `base_branch`. Worktrees live at `~/termic/tasks/<project>/<name>/`. `is_main_checkout=true` tasks point at the project's live checkout (no worktree, archive skips `rm -rf`).
- **Settings** (`settings.json`) — `repos_dir`, `welcomed`, `agents[]` (claude/gemini/codex defaults + customs; each has `command`/`args`/`yolo_args`/`runtime_yolo_command`). Defaults seeded if `agents` is empty. `schema_version` gates one-time on-disk migrations.
- **Tab** (per task, in `useApp`) — `terminal` (PTY running a CLI), `edit` (CodeMirror), `diff` (vs HEAD). PTYs die with the app.

## Migrations

The "Task" entity was called "Workspace" before, on disk and in code. A one-time
startup migration (`migrate_workspaces_to_tasks` in `lib.rs`, gated by
`settings.schema_version`) renames the metadata dir `workspaces/` → `tasks/` and
rewrites the `is_repo_root` field to `is_main_checkout` (serde `alias` still reads
the old name). It is **metadata-only**: it deliberately does NOT move worktree
directories or rewrite each task's `path`. CWD-resume agents (Claude Code's
`--continue`) resume the most recent session by working directory, so relocating a
worktree would silently orphan its history. Existing worktrees stay under
`~/termic/workspaces/…`; NEW worktrees are created under `~/termic/tasks/…`
(`worktrees_base()`), and the two roots coexist while the old one empties out
lazily as tasks are archived/recreated. The metadata rename is atomic (stage in
`tasks.tmp/`, then one `rename` into place), guarded by a `tasks-migration.lock`,
backs up to `backups/pre-tasks-<ts>/`, and prunes-on-corruption (an unparseable
record, or an active worktree whose dir was deleted externally, is dropped +
logged to `tasks-migration.log`, never carried forward). The JS half
(`src/lib/lsMigration.ts`) renames the persisted `localStorage` pref keys
(`workspaceExpandMode` → `taskExpandMode`, `collapsedWorkspaces` → `collapsedTasks`,
plus the two `newWorkspaceLast*` keys); everything else in `localStorage` is keyed
by task UUID, which never changes.
