# Tech debt: scheduled removals

The standing index of **temporary / removable scaffolding** — code that exists
only to bridge users across a change and should be deleted once it has served
its purpose. Each entry records what it is, why it's safe to keep running until
then, and exactly what to delete. Add new migrations / shims here so a future
maintainer has one place to look for "what can I rip out yet."

Related: [docs/data-model.md](data-model.md) (data dirs). The original
workspace→task rename design lived in `docs/plans/workspace-to-task-rename.md`
(deleted once shipped; see git history if you need the decision log). The
layer above Project shipped as [docs/profiles.md](profiles.md).

| # | Item | Introduced | Safe to remove | Status |
|---|---|---|---|---|
| 1 | `workspace` → `task` migration (schema v1) | v0.19.0 | a few minor releases after v0.19 | active |
| 2 | `migrate_legacy_members()` (multi-repo) | pre-v0.19 | independent (likely already) | active |
| 3 | `LEGACY_IDS` (pre-registry language ids) | v0.28.x | a few minor releases | active |
| 4 | `atlasPageVersionGuard` (GH #314) | v1.6.x | `@xterm/addon-webgl` 0.20.0 stable | active |
| 5 | `migrate_task_roles_seeded` (role seeding) | v1.22.x | a few minor releases | active |

---

## 1. `workspace` → `task` migration (schema v1)

One-time, on-disk migration that upgrades a profile written by the pre-rename
build (the "workspace" era) to the current "task" layout. Once every
realistically-active install has launched a migrated build at least once, all
of it can be deleted. This is the map for that purge, plus the record of why
it is safe to leave running until then.

### What it migrates

The rename touched three things a user has persisted on disk:

1. **Metadata dir** `<data>/workspaces/` → `<data>/tasks/` (per-task JSON files).
2. **Renamed persisted fields**: `Workspace.is_repo_root` → `Task.is_main_checkout`,
   `Project.workspaces_path` → `Project.tasks_path`.
3. **Renamed localStorage keys** (frontend prefs) + five renamed shortcut IDs.

It is **metadata-only**: git worktree directories are never moved and
`Task.path` is never rewritten (CWD-resume agents like Claude Code resume by
working directory, so relocating a worktree would orphan its history). New
worktrees are created under `~/APP_DIR/tasks/`; pre-existing ones stay under
`~/APP_DIR/workspaces/` and age out as the user archives them.

### Complexity: low, and well-contained

| Surface | Where | ~LOC | Role |
|---|---|---|---|
| `migrate_workspaces_to_tasks()` | `src-tauri/src/lib.rs` | ~145 | The migration itself (backup → classify → validate → atomic rename → stamp). Single call site in `.setup()`. |
| Migration helpers | `lib.rs` | ~80 | `MigrationLock` + `acquire_migration_lock`, `stamp_schema_version`, `migration_timestamp`, `log_migration`, `log_prune`, `copy_dir_all` (migration-only). |
| `repoint_task_bases()` | `lib.rs` | ~14 | Self-heals `Project.tasks_path` prefix `workspaces/` → `tasks/` on every `load_projects()`. |
| `schema_version` gate | `lib.rs` | ~4 | `Settings.schema_version` field + `const TASKS_SCHEMA_VERSION = 1` + the guard. |
| serde read aliases | `lib.rs` | 2 | `#[serde(alias = "is_repo_root")]`, `#[serde(alias = "workspaces_path")]`. |
| Legacy-dir archive tidy | `lib.rs` | ~45 | `prune_empty_worktree_ancestors` + `remove_dir_if_empty_ignoring_hidden`: on archive, empty-only rmdir up the tree so the legacy `~/APP_DIR/workspaces/` root disappears once its last task is gone. |
| Frontend LS migration | `src/lib/lsMigration.ts` | 68 | Renames 4 localStorage keys + remaps 5 shortcut IDs. Side-effect import, first line of `src/main.tsx`. |

Total temporary surface ≈ **320 LOC**, gated behind one `schema_version` check
and one call site. There is no state machine, no multi-step version ladder
(it's a single v0 → v1 hop), and nothing else in the app depends on the
migration types.

### Why it is safe to keep running (the invariants)

- **Idempotent + gated.** `migrate_workspaces_to_tasks()` returns immediately
  when `settings.schema_version >= 1`, so it's a no-op on every launch after
  the first. A fresh install just stamps the version.
- **Runs before anything reads.** Called synchronously in Tauri `.setup()`
  before the window exists, so the frontend only ever sees the migrated
  `tasks/` layout.
- **Crash-safe.** Order is: backup to `backups/pre-tasks-<ts>/` → build
  `tasks.tmp/` → validate every staged file parses → **single atomic
  `rename(tasks.tmp → tasks)`** → delete `workspaces/` → **stamp
  `schema_version` LAST**. A crash anywhere re-runs cleanly from the intact
  `workspaces/`. A Drop-guarded lockfile (steals stale locks >5 min) blocks
  concurrent runs.
- **Non-destructive.** Every task that can be *read* is migrated, even if its
  worktree dir is missing at migration time (e.g. an unmounted external
  volume) — a real orphan just shows in the list to be archived. Only
  genuinely unreadable/corrupt JSON is skipped, and it is still in the backup.
- **No field can be dropped.** Every persisted struct is `#[serde(default)]`
  with **no `#[serde(deny_unknown_fields)]` anywhere**, and the only
  serialized-name changes are the two aliased renames above plus the new
  defaulted `schema_version`. Re-serialization preserves everything else
  verbatim.

### Purge checklist (when it's time)

**When is it safe?** The app is fully on-device (no telemetry), and a user can
upgrade across many versions in one jump, so keep this for a comfortable window
— suggested: **remove no earlier than a few minor releases after v0.19**, once
it's implausible anyone is still on a pre-rename build. Bump
`TASKS_SCHEMA_VERSION` only if a *future* migration is added; do not reuse this
machinery for an unrelated change without renaming it.

Delete, in `src-tauri/src/lib.rs` unless noted:

- [ ] `migrate_workspaces_to_tasks()` and its `.setup()` call site.
- [ ] Helpers used only by it: `MigrationLock`, `acquire_migration_lock`,
      `stamp_schema_version`, `migration_timestamp`, `log_migration`,
      `log_prune`, `copy_dir_all`. (Confirm no new callers crept in first —
      grep each.)
- [ ] `repoint_task_bases()` and its call in `load_projects()`.
- [ ] `#[serde(alias = "is_repo_root")]` on `Task.is_main_checkout` and
      `#[serde(alias = "workspaces_path")]` on `Project.tasks_path`.
- [ ] `Settings.schema_version` field + `const TASKS_SCHEMA_VERSION`.
- [ ] `src/lib/lsMigration.ts` + its import in `src/main.tsx`.
- [ ] `prune_empty_worktree_ancestors` + `remove_dir_if_empty_ignoring_hidden`
      and the call in `task_archive_sync`. **Caveat:** these are generic
      empty-dir tidiers — removing them also drops the "clean up an emptied
      `tasks/<project>/` folder on archive" behavior. If that tidiness is
      still wanted for the *new* layout, keep a trimmed version scoped to
      `tasks/` instead of deleting outright.
- [ ] Entry 1 in this doc (and, if this is the last entry, the whole doc + its
      `## Docs` link in `CLAUDE.md`).

**Keep (permanent — NOT scaffolding):**

- The `TERMIC_WORKSPACE_NAME` env var and `{WORKSPACE_NAME|SLUG|ID|PATH}` /
  `$WORKSPACE` placeholders (and the `$CONDUCTOR_*` aliases) — a permanent
  compat contract with user-authored `.termic.yaml` scripts and resume-arg
  overrides. Renaming these would break users' own scripts, so they stay
  regardless of how old the rename gets.
- `Task.path` as the single source of truth for a worktree's location — the
  permanent correct design, not a shim.

---

## 2. `migrate_legacy_members()` (multi-repo members)

A **separate, older** load-time migration that normalizes multi-repo member
records inside `load_projects()`. It predates the workspace→task rename and is
**not** gated by `schema_version`, so it has its own, independent (and likely
earlier) lifetime — listed here only so it isn't forgotten.

- [ ] `migrate_legacy_members()` + its call in `load_projects()`
      (`src-tauri/src/lib.rs`). Assess separately: safe to remove once no
      active profile predates the release that introduced multi-repo members.

---

## Verifying a clean removal (applies to any entry)

Two checks reproduce the confidence from the original migration audit:

1. **Field parity** — diff persisted struct fields against the last pre-purge
   commit; the only differences should be the aliases you're removing:
   ```sh
   git show <pre-purge>:src-tauri/src/lib.rs | awk '/pub struct Task \{/,/^}/' \
     | grep -oE 'pub [a-z_]+:' | sort > /tmp/a
   awk '/pub struct Task \{/,/^}/' src-tauri/src/lib.rs \
     | grep -oE 'pub [a-z_]+:' | sort > /tmp/b
   diff /tmp/a /tmp/b
   ```
2. **Fixture run** — before removing, a throwaway `#[test]` can point
   `TERMIC_DATA_DIR` (honored in debug builds) at a hand-built `workspaces/`
   profile with old-format JSON and assert the migrated `tasks/` output. Don't
   commit it: it mutates a process-global env var and flakes the parallel
   suite. (This is exactly how the v1 migration was verified.)

---

## 3. `LEGACY_IDS` (pre-registry language ids)

`src/lib/languages.ts` holds a frozen ~25-entry map from termic's old
lower-case language ids (`json`, `cpp`, `properties`) to CodeMirror registry
names (`JSON`, `C++`, `Properties files`), applied by `normalizeLanguageId`.

### Why it exists

Language ids became registry names when the hand-maintained catalog was
replaced by `@codemirror/language-data`. Almost nothing carried the old ids
across a relaunch, because a file's language is re-derived from its path every
time it opens. The exception is a **scratchpad** (GH #244): a pad has no
filename, so its manual "Set syntax" pick is written to the scratch index and
is the one place an old id can still reach a running build. Without the map, a
pad someone set to JSON on a build between 0029565 and the swap comes back
plain.

### Safe to remove when

Every realistically-active install has opened its pads at least once on a build
that rewrites the pick (any build after the swap writes the new name back on
the next manual pick, but NOT automatically), or simply once the cost of a pad
losing its highlight is acceptable. A few minor releases.

### What to delete

1. `LEGACY_IDS` and `normalizeLanguageId` in `src/lib/languages.ts`, and its
   call sites (`languageLabel`, `effectiveLanguageId`, and in
   `src/lib/languageExts.ts` `isKnownLanguage` / `langForId`).
2. The legacy-id cases in `src/lib/languages.test.ts` and
   `src/lib/languageExts.test.ts`.
3. The note on `ScratchTab.syntax` in `src/lib/types.ts`.

Nothing on the Rust side changes: `ScratchRecord.syntax` is an opaque `String`.

---

## 4. `atlasPageVersionGuard` (GH #314)

**What it is.** `src/lib/atlasPageVersionGuard.ts` gives every xterm WebGL
glyph-atlas page a version drawn from one process-wide monotonic counter,
because xterm 0.19.0 uses a per-page counter starting at 0 as though it were a
page identity. The consequence is that a merged atlas page inherits a texture
unit's cached version and the unit keeps drawing the previous page's bitmap:
every cell renders a fragment of some other glyph. Full mechanism in the
module header and in [gotchas.md](gotchas.md).

**Why it is safe to keep running.** It is additive and inert: every reach-in is
optional-chained, the `defineProperty` is in a try/catch, and it adds no
per-frame work (new pages arrive through the public
`onAddTextureAtlasCanvas` event). It does not change how often textures upload,
because a page's version already moved on every glyph rasterized into it. If
xterm renames something the guard no-ops and we are back to the bug, not
somewhere worse.

**Safe to remove when** we ship `@xterm/addon-webgl` 0.20.0 or later.
Upstream xtermjs/xterm.js#6038 is this bug, closed 2026-07-21, and the fix in
0.20.0-beta.300 is the same approach: `public static nextVersion` on
`AtlasPage`, with every `version++` replaced by
`version = ++AtlasPage.nextVersion`. As of writing, npm `latest` for
`@xterm/addon-webgl` is still 0.19.0 and 0.20.0 exists only as a beta, so the
guard is load-bearing today. **Do not upgrade to the beta just to drop this**:
the guard costs nothing and a beta of the whole xterm suite costs a lot more
than one module.

The same release also replaces the never-reset `_requestClearModel` flag with a
monotonic `_pageLayoutVersion`, which is the second bug recorded in
[performance.md](performance.md) bear trap 11. That one is pure upstream and
needs nothing from us.

### Purge checklist

- [ ] `src/lib/atlasPageVersionGuard.ts` and `src/lib/atlasPageVersionGuard.test.ts`.
- [ ] Both `guardAtlasPageVersions(a)` calls in `src/lib/terminalRenderer.ts`
      (the attach path and the `onChangeTextureAtlas` microtask), plus the import.
- [ ] The `atlas page version guard wiring (#314)` describe block and the
      `guardSpy` mock in `src/lib/terminalRenderer.test.ts`. Keep the fake's
      `onChangeTextureAtlas` callback recording: the scratch-canvas guard hangs
      off the same event and still needs it.
- [ ] `_pages` and `onAddTextureAtlasCanvas` in the `WEBGL_REACH_INS` table in
      `src/lib/xtermInternals.test.ts`, and `atlasPageVersionGuard` from the
      `_charAtlas` entry beside `atlasCanvasGuard`.
- [ ] The GH #314 bullet in [gotchas.md](gotchas.md) becomes history: rewrite it
      to say which xterm version fixed it rather than deleting it, since the
      symptom is the thing a future reader will search for.
- [ ] Re-verify before deleting: the bug needs ~16 atlas pages to appear, so a
      quick check is not enough. See "Verifying a clean removal" above.

---

## 5. `migrate_task_roles_seeded` (defaults seed, tasks own)

**What it is.** `migrate_task_roles_seeded` / `seed_unset_roles` in
`src-tauri/src/lib.rs`, run once at launch and stamped with
`Settings.task_roles_seeded_migrated` on the root profile. A task with no
Secrets role used to follow its project's default, then its agent's, at
every spawn. Once defaults only seed a task at creation, such a task would
have dropped to No secrets, so the migration writes down what it resolved
to (project default, else the default of `task.cli`, else `""`), ignoring
the Keychain gate, which still applies at spawn.

**Why it is safe to keep running.** One pass, then a marker check per
launch. A failed task write leaves the marker off and the next launch
retries; a task already holding a role is never touched.

**Safe to remove when** every realistically-active install has launched a
build with it once. A few minor releases after it ships.

### Purge checklist

- [ ] `migrate_task_roles_seeded`, `seed_unset_roles` and their call in the
      setup hook (`lib.rs`), and the `role_seed_migration_writes_todays_resolution`
      test. Keep `seeded_role`: the create paths use it.
- [ ] `Settings.task_roles_seeded_migrated`, its entry in
      `config_sync.rs` `SETTINGS_LOCAL` and in the config_sync test's
      `Settings` literal. `#[serde(default)]` lets an old file with the field
      still load.
- [ ] Its row in the table above.
