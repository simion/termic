# Plan: rename "Workspace" to "Task" (+ data migration)

Status: IMPLEMENTED (uncommitted). Rename applied across Rust + TS + docs + file
moves; Phase 0 migration (`migrate_workspaces_to_tasks` in lib.rs) + JS LS shim
(`src/lib/lsMigration.ts`). The top-level **Space** layer remains deferred (see end).

> **REVISION (supersedes the worktree-move design below).** The migration is now
> **METADATA-ONLY**. It renames the metadata dir `workspaces/` → `tasks/` and the
> `is_repo_root` field, but it does NOT move worktree directories or rewrite each
> task's `path`, and it does NOT run `git worktree repair`. Reason: CWD-resume
> agents (Claude Code's `--continue`) resume the most recent session **by working
> directory**, so relocating a worktree would silently orphan its history. Existing
> worktrees stay under `~/APP_DIR/workspaces/…`; new worktrees are created under
> `~/APP_DIR/tasks/…` (`worktrees_base()`) and the old root empties out lazily.
> Everything below about "MOVE worktree root", "git worktree repair", and
> "prefix-rewrite the path" is retained for history but is NO LONGER done.

## Goal

Rework termic's vocabulary to match a browser-workspaces / Arc-spaces mental model,
inspired by super.engineering (ex-Superconductor). Today termic conflates the
"unit of work" with the word "workspace". We are retiring "workspace" as the unit
name (renaming the unit to **Task**) and reserving a future top-level grouping
layer called **Space** (Arc-style). "workspace" leaves the vocabulary entirely,
so nobody reads the new top layer as "the old workspace moved up a level".

### Target model

```
Space                          (Arc-style colored group of projects) -- DEFERRED, build later
└─ Project                     (a git repo, or a plain folder)
   ├─ Task · main checkout      the repo's original checkout (git or non-git); always present, hideable, not deletable
   └─ Task · worktree feat/x    an isolated git worktree (git projects only); create/remove freely
```

- **Task** is the single noun for the unit of work (was "Workspace").
- A Task's location is explicit and surfaced in the UI:
  - `main checkout` for the repo-root checkout (`is_repo_root == true` today).
  - `worktree · <branch>` for an isolated git worktree.
  - `folder` for a non-git plain folder (future / experimental).
- The word "worktree" stays visible in the UI **on purpose**: worktrees only
  exist in git projects, so surfacing it explains why isolation is or is not
  available. A plain folder shows no worktree option (hint: "Initialize Git to
  run tasks in isolated worktrees").
- The top **Space** layer (colored, horizontally scrollable groups of projects)
  is DEFERRED. This plan only renames the unit and migrates data.

### Naming rationale (decided)

- Unit noun = `Task`. Rejected: `Session` (collides with agent/terminal/chat
  sessions and the existing resume UI); `Worktree` (lies for repo-root and
  non-git cases, leaks git jargon).
- Repo-root location label = `main checkout`. Rejected: `main worktree` (git's
  official term, but collides with the `main` branch and confuses people);
  `primary worktree` (super.engineering's term, but non-standard / invented).
- "worktree" is reserved for actual `git worktree add` checkouts only.

### Terminology map (super.engineering vs termic)

| Concept | super.engineering | termic (old) | termic (new) |
|---|---|---|---|
| Colored group of projects | Workspace | (none) | Space (deferred) |
| A repo or folder | Project | Project | Project |
| Unit of work | (task) worktree | Workspace | **Task** |
| Isolated branch location | task worktree | worktree workspace | **Task · worktree `<branch>`** |
| Repo-root location | primary worktree | repo-root workspace (`is_repo_root`) | **Task · main checkout** |

## Scope / impact

Rough reference counts at planning time:

- `src/` : ~1,238 `workspace` references across ~81 files; ~1,350 `wsId` / `ws`
  identifiers.
- `src-tauri/src/` : ~750 `workspace` references.
- ~40 IPC commands named `workspace_*`.

This is a large mechanical change. It must be staged with a green build (TS +
Rust) at each gate. It is NOT a blind global sed: the tokens `ws` / `workspace`
collide with unrelated words (WebSocket, "views", "shows", "rows"), so the
rename is identifier-scoped and compiler-driven.

## Config / persistence: three layers

Config keys are hardcoded string literals. They fall into three layers with very
different risk profiles:

| Layer | Examples | Handling |
|---|---|---|
| A. In-memory code | `Workspace` type, `wsId`, `workspaces[]`, `WorkspaceView.tsx` | Full rename. Compiler-checked, atomic. |
| B. IPC command names (JS invoke string <-> Rust fn) | `invoke("workspace_create")` <-> `fn workspace_create` | Full rename. Both sides change in the same commit. NOT compiler-checked, so a grep-parity audit is mandatory (see Verification). |
| C. Persisted on disk / localStorage | `<data>/termic/workspaces/<uuid>.json`, `~/termic/workspaces/<proj>/<name>/` (live git worktrees), serde field `is_repo_root`, LS key `"workspaceExpandMode"` | Migrated on disk by a one-time startup migration (Phase 0). See below. |

### Safety anchor

**Entity UUIDs never change.** We rename labels and containers, not identities.
Every `<uuid>.json`, every localStorage record keyed by a UUID, keeps working.
Only human-readable container names and field names change.

## Disk inventory (what is named "workspaces")

Two independent trees, both called `workspaces`, plus in-file references.
Paths use `APP_DIR` = `termic` (release) / `termic_dev` (dev).

| # | Path | Contents | Operation |
|---|---|---|---|
| 1 | `<data_local_dir>/termic/workspaces/<uuid>.json` | metadata, one file per task | rename dir -> `tasks/`, then rewrite each JSON |
| 2 | `~/termic/workspaces/<project>/<name>/` | live git worktrees | rename dir -> `tasks/`, then `git worktree repair` |
| 3 | `<uuid>.json` field `"path"` | absolute worktree path (`.../workspaces/...`) | prefix-rewrite the root segment -> `tasks` |
| 4 | `<uuid>.json` key `"is_repo_root"` | field name | rename key -> `is_main_checkout` (serde `alias` reads old) |
| 5 | `settings.json#repos_dir`, `projects.json` root paths | user repo locations | rewrite ONLY if a path contains our `.../termic/workspaces/...` segment (verify; likely none) |
| 6 | WKWebView localStorage: `"workspaceExpandMode"`, records keyed by wsId | JS prefs | JS startup shim: copy old key -> new; UUID-keyed records unchanged |

Relevant code (planning references, verify at impl time):

- `src-tauri/src/lib.rs`
  - `APP_DIR` const (~L530); `data_dir()` (~L532); `workspaces_dir()` (~L552,
    metadata dir); worktree root (~L558, `home/APP_DIR/workspaces`).
  - `struct Workspace` (~L217); field `path` = worktree absolute path; field
    `is_repo_root`; `archived` / `archived_at`.
  - `workspace_archive_sync` (~L3559): runs archive script, removes the worktree
    dir (`fs::remove_dir_all`), marks `archived=true` in JSON. For
    `is_repo_root`, archive skips worktree removal (it shares the host checkout).
- `src/store/prefs.ts`, `src/store/app.ts`: localStorage key constants.
- `src/lib/ipc.ts`: `workspace_*` invoke wrappers.

## Phase 0: data migration (atomic + prune-on-corruption)

Runs once on Rust startup, BEFORE `load_workspaces()`, gated by a
`schema_version` integer in `settings.json`. A JS localStorage shim runs on app
startup for layer C's LS keys.

### Guiding principle (decided)

**App stability beats data preservation.** If a record is missing, unparseable,
unrepairable, or otherwise questionable, PRUNE it rather than carry corruption.
Better to lose a broken task than break the app for the user. Everything pruned
is logged (recoverable audit), never silently dropped.

### Atomicity model

True single-syscall atomicity across "rename two dir trees + rewrite N JSONs +
run git" is impossible. Instead we guarantee the four properties that matter, via
stage -> verify -> single-pointer-flip, plus a hard no-delete-before-verify
invariant:

1. **No data loss, ever.** The old copy is never removed until the new copy is
   written and verified.
2. **Atomic metadata commit.** The app's source of truth is the metadata dir. We
   build a fresh `tasks.tmp/`, validate it, then `rename(tasks.tmp -> tasks)` in
   one syscall. Readers see all-old or all-new, never partial.
3. **Crash-safe / resumable.** A fsync'd journal + idempotent steps + the
   `schema_version` marker written LAST mean any interruption rolls forward
   cleanly on next launch.
4. **Clean by construction.** Broken tasks never enter `tasks.tmp/`, so the
   committed set has zero corrupt entries.

Dir layout during migration:

```
workspaces/      OLD metadata: read-only during migration, deleted only AFTER commit
tasks.tmp/       staging: built fresh, validated; discarded on crash
tasks/           committed via one atomic rename(tasks.tmp -> tasks)
```

### Algorithm

```
0. GUARD: if settings.schema_version >= TASKS_MIGRATION -> skip.
1. BACKUP metadata dir + settings.json + projects.json
   -> <data>/termic/backups/pre-tasks-<ts>/   (small, cheap; the safety net)
2. JOURNAL intent (fsync) so an interrupted run is resumable, not ambiguous.
3. MOVE worktree root: fs::rename(~/termic/workspaces -> ~/termic/tasks).
   - Single atomic syscall on-volume.
   - On failure (e.g. EXDEV cross-volume): copy -> verify -> only then delete old.
   - If this step fails entirely: ABORT. Nothing else touched; old state intact.
4. CLASSIFY + REPAIR each task; build tasks.tmp/ from survivors only:
      main checkout (is_repo_root)          -> KEEP (field rename; no dir, no repair)
      active worktree, dir present + repair  -> KEEP (rewrite path + fields)
          repair = git -C <projectRoot> worktree repair <newWorktreePath>
      active worktree, dir MISSING/repair FAILS -> PRUNE (log to pruned.jsonl)
      repo gone / unrepairable               -> PRUNE
      metadata JSON won't parse              -> PRUNE (move to quarantine/)
      archived + well-formed                 -> KEEP (dir-less by design = history)
      archived + malformed                   -> PRUNE
5. VALIDATE every file in tasks.tmp/ parses.
6. COMMIT: rename(tasks.tmp -> tasks).   <-- the single flip point
7. CLEANUP: delete old workspaces/ metadata; write schema_version; clear journal.
8. JS SHIM (app startup): migrate LS keys "workspace*" (copy old value -> new key,
   delete old). UUID-keyed records need no change.
```

### git worktree repair mechanics (the one dangerous op)

A linked worktree has two pointers:

- worktree -> repo: the worktree's `.git` file (`gitdir: <repo>/.git/worktrees/<id>`).
  The repo does not move, so this STAYS VALID.
- repo -> worktree: `<repo>/.git/worktrees/<id>/gitdir` points at the OLD worktree
  path. After the move this is STALE.

Fix: `git -C <projectRoot> worktree repair <newWorktreePath>` rewrites the
repo-side pointer. Per-repo error isolation: if one repo fails, prune that task
and continue; never abort the whole migration for one bad repo.

### Serde compatibility for renamed fields

Rust struct fields get the new code name plus an alias so old files still read:

```rust
pub struct Task {                       // was: struct Workspace
    #[serde(alias = "is_repo_root")]    // read old-format files pre-migration
    pub is_main_checkout: bool,         // write new name post-migration
    // ...
}
```

### Failure modes

| Scenario | Handling |
|---|---|
| Crash mid-migration | Marker written last + idempotent steps -> next launch rolls forward |
| Cross-volume `~/termic` | fs::rename EXDEV -> copy-verify-delete fallback (still no loss) |
| Locked / dirty worktree | Files move with the dir; dirty state preserved; repair fixes pointers |
| Repo deleted before migration | repair fails -> PRUNE the task |
| Worktree dir missing (active) | PRUNE the task |
| Unparseable metadata | PRUNE -> quarantine/ |
| Archived (dir-less by design) | KEEP if well-formed; PRUNE if malformed |
| Concurrent launch | single-instance assumption + lockfile during migration |
| Partial old-format reads post-migration | serde `alias` tolerates both |

### Rollback

The `backups/pre-tasks-<ts>/` copy restores metadata/settings/projects instantly.
The two dir renames reverse with `fs::rename` back + `git worktree repair`. The
`schema_version` guard lets a restored profile re-migrate cleanly.

### Runtime defense in depth

Independent of migration, the task-load path should skip any record it cannot
parse or resolve (log + drop) rather than crash. This backstops the
stability-over-preservation principle for anything the migration missed.

## Code rename mapping

| Old | New |
|---|---|
| `Workspace` (TS type / Rust struct) | `Task` |
| `workspaces` (arrays / maps / state) | `tasks` |
| `wsId`, `ws` | `taskId`, `task` |
| `mountedWorkspaces` | `mountedTasks` |
| `WorkspaceView`, `NewWorkspaceDialog`, `WorkspaceSandboxDialog`, ... (files + components) | `TaskView`, `NewTaskDialog`, `TaskSandboxDialog`, ... |
| `workspace_*` (IPC commands + Rust fns) | `task_*` |
| `is_repo_root` (code id) | `is_main_checkout` / `isMainCheckout` (serde alias `is_repo_root`) |
| `CreateWorkspaceArgs`, `WorkspaceMember`, `WorkspaceChanges`, ... | `CreateTaskArgs`, `TaskMember`, `TaskChanges`, ... |
| LS constant `LS_WS_EXPAND_MODE` (value `"workspaceExpandMode"`) | `LS_TASK_EXPAND_MODE`; value migrated by JS shim |

Persisted STRINGS (dir names, serde field wire names before migration, LS key
values) are handled by Phase 0, not by find/replace.

## Label / UI copy changes

- "Workspace" -> "Task" everywhere user-facing (buttons, menus, dialogs,
  tooltips, empty states, settings labels).
- "New Workspace" -> "New Task"; "Archive Workspace" -> "Archive Task"; etc.
- Add explicit location chips on each Task row / header:
  - `main checkout` (repo-root task) with a distinct icon; also its context-menu
    action "Hide main checkout" (was repo-root hide).
  - `worktree · <branch>` for isolated worktrees.
- New Task creation flow:
  - git project: choose "New worktree" (name a branch) or "Use main checkout".
  - non-git project: no worktree option; hint "Initialize Git to run tasks in
    isolated worktrees".
- Respect the repo copy rule: NO em dashes in any user-visible string. Use
  commas / parentheses / colons.
- Audit: History view, Dashboard, command palette entries, shortcut labels
  (`docs/shortcuts.md`), notifications (`useAttentionNotifier`).

## Execution phases (staged, green build between each)

- Phase 0: data migration (above), shipped in the SAME release as the rename;
  runs before first task-load.
- Phase 1: Rust `lib.rs` -- rename struct/fields (serde-pinned/aliased), command
  fns, keep `"workspaces"` path literals as they will be produced by migration
  (or switch to `"tasks"` in lockstep with Phase 0). Gate: `cargo build` green.
- Phase 2: `src/lib/ipc.ts` -- rename wrapper fns + command-name strings to match
  Phase 1 exactly.
- Phase 3: `src/lib/types.ts` -- `Workspace` -> `Task`, field names aligned with
  Rust serde.
- Phase 4: `src/store/app.ts` (+ `prefs.ts`) -- `workspaces` -> `tasks`,
  `wsId` -> `taskId`; LS key constant renames with pinned/migrated values.
  Gate: `tsc` green.
- Phase 5: components / hooks -- rename files + identifiers + props.
- Phase 6: user-facing copy + location chips + create flow (label changes).
- Phase 7: docs -- `data-model.md`, `ipc.md`, `shortcuts.md`, `ui.md`,
  `CLAUDE.md`.
- Phase 8: verification (below).

## Verification

- `tsc -b` clean; `cargo build` clean; unit tests (`src/store/app.test.ts`,
  `src/lib/agents.test.ts`, etc.) updated and green.
- Grep audit:
  - no stray `workspace` / `wsId` / `Workspace` in code (allow the pinned
    persisted string literals only, with comments explaining why).
  - IPC parity: every `task_*` invoke string in `ipc.ts` has a matching Rust
    `#[tauri::command]` and vice versa (layer B safety net).
- Migration tests in a temp `TERMIC_DATA_DIR` fixture set:
  - fresh install (no-op), N active worktrees, main-checkout tasks, archived
    tasks, custom / cross-volume repos location, a dirty worktree, a repo deleted
    before migration, re-run-after-crash (marker absent, journal present).
  - real-git integration: assert `git -C <movedWorktree> status` works and the
    app lists every surviving task; assert broken ones are pruned + logged.
- Smoke (e2e only if explicitly requested; see CLAUDE.md): create Task ->
  split -> archive -> resume; create main-checkout Task; verify History intact.

## Open items to verify at implementation time

- Where "auto-created host repos" live under `~/termic/`. Confirm they are NOT
  nested under `~/termic/workspaces/`; if they are, moving the tree also moves
  the repo and both git pointers shift (still repairable, but changes the repair
  call and ordering).
- Whether `repos_dir` or any `projects.json` path contains our `workspaces`
  segment (row 5).
- Exact archive cleanup: confirm archived non-root tasks always have their
  worktree dir removed (so "dir missing" for archived == expected, not
  corruption).
- Whether to also rename the `~/termic/workspaces` -> `~/termic/tasks` worktree
  root, or only the metadata dir. Current plan: rename both. The worktree-root
  rename is the only step needing `git worktree repair`.

## Deferred (future work, not this plan)

- The top-level **Space** layer (colored, horizontally scrollable groups of
  projects), plus per-Space accent/chrome colors and action routing. Tracked
  separately once the Task rename lands.
