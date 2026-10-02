# Profiles

One termic, several fully separate instances. A **profile** owns its own
projects, tasks, settings and agent registry, and lives in its own window; two
profiles can be open on two monitors at once and neither can see the other's
work. Shipped in phase 1 of [#280](https://github.com/simion/termic/issues/280);
phase 2, a separate account per agent, shipped as
[#278](https://github.com/simion/termic/issues/278) and is documented in
[docs/agent-accounts.md](agent-accounts.md).

## The one rule everything follows

**The profile rides the DATA, not the call.**

Records are loaded from every profile and tagged in memory with the directory
they came from, so a by-id lookup needs no profile at all and a write goes back
where the record came from. Only LISTING and CREATION name a profile.

This is the second answer to the question, and the first one is worth knowing
because it looks obviously right and is not. Deriving the profile from the
calling window (`window: tauri::Window`, label `profile-<slug>`,
`profile_dir(&window)`) does not survive the call graph:

```
load_tasks_all()        99 call sites   (90 of them by-id lookups)
load_projects_all()     54
load_settings_inner()   45
```

None of the three caches, and a large minority of those sites are in
`cli_server.rs`, `mcp_server.rs`, file watchers and per-task background threads,
which have no window to take. Meanwhile a task id is a UUID, so it is already
unique across profiles and those 90 lookups do not care which profile a record
came from.

Consequences worth stating explicitly:

- **`load_tasks_all` / `load_projects_all`** span every profile and tag each
  record. This is what the port allocator needs: one process draws from one port
  space, so a per-profile view would hand two profiles the same block.
- **`load_tasks_in` / `load_projects_in`** are scoped, for anything that becomes
  a list in one window.
- **There is no bare `load_tasks`.** The split forces every call site to declare
  which it means, so leaking another profile's tasks into a window is something
  you have to type rather than something you get by forgetting.
- **`save_task(&t)` writes to `t.profile`.** `save_projects` groups a mixed list
  by tag, so the common load-all / edit-one / save shape cannot drag other
  profiles' projects into one directory.
- **The tag is `#[serde(skip)]`.** Nothing reaches disk, so there is no schema
  bump and an existing install's files stay byte-identical.
- **Which is exactly why a record arriving from a WINDOW has no tag.** serde
  fills in `ProfileId::default()`, i.e. `Root`, whatever window sent it. Any
  command that takes a whole record off the wire must therefore take the tag
  from the record ON DISK before saving it. `project_update` did not, and the
  result was silent cross-profile movement: the project was filed under the
  root profile, and because `save_projects` writes every profile's group, the
  profile it belonged to was rewritten as an empty list. A user who toggled one
  setting on a project in their second profile found that profile empty and the
  project sitting in the default one, on the next launch (the window that did
  it kept its own in-memory list until then). It is the only command shaped
  this way today; `settings_save` takes the window instead, and every other
  edit mutates a loaded record in place, which keeps the tag by construction.

A window is consulted in exactly two places, both of which genuinely cannot
resolve from a record: `projects_list` (which profile does this sidebar show)
and `project_add` (which profile does a new project join). Tasks never need it,
because a task's profile is its project's.

## Dormant until asked for

`profiles.json` does not exist until the first profile is created, and is
unlinked again when the last one goes. Its ABSENCE is the "this feature does not
exist yet" state, not a missing file to heal:

- No chip in the title bar, no name, no color. The footer's profile button is the
  whole surface, and it opens Settings to Profiles.
- Every path resolves exactly as it did before profiles existed.
- `localStorage` keys are unprefixed (see below).

Creating the FIRST profile also adopts the install that already exists, in the
same write: that is the moment the current setup becomes "a profile" and it
needs a name then, or the chip reads "Default" forever. Both entries land
together, so the registry is never seen naming one of two profiles.

## Data layout

```
~/Library/Application Support/termic/     (termic_dev in debug builds)
├── profiles.json          the registry. ABSENT while dormant.
├── settings.json          the ROOT profile's. Not moved.
├── projects.json          same
├── tasks/                 same
├── scratch/               same
├── profiles/
│   └── <slug>/            every profile EXCEPT the root one
│       ├── settings.json
│       ├── projects.json
│       ├── tasks/
│       └── scratch/
├── docker/ docker-agents/ docker-forge/ servers/ backups/   GLOBAL
├── cli-token / mcp-token                                    GLOBAL
```

```
~/termic/
├── tasks/                        the root profile, exactly as today
├── workspaces/                   pre-rename legacy
└── profiles/<slug>/tasks/<project>/<name>/
```

**The root profile IS the app data dir.** It has no directory of its own and no
slug on disk, which is what makes the feature migration-free.
`Registry::root_slug` names which profile owns it, and may be `None` once that
profile is deleted: nothing is promoted and nothing moves.

**One identifier, the slug, keyed the same way in both trees**, and it is also
the window label. Frozen at creation and never renamed, because CWD-resume
agents key sessions to the working directory and relocating a worktree would
orphan every conversation under it. The `profiles/` level namespaces slugs: a
profile called "tasks" or "workspaces" would otherwise land on the two
directories under `~/termic/` that already mean something.

**`global_dir()` vs `profile_dir(id)`.** `data_dir()` was renamed `global_dir()`
so a caller that wants machine-wide state has to say so: the CLI and MCP tokens,
the docker image and agent dirs, the downloaded LSP `servers/` cache, `backups/`,
and the sandbox's own deny rule, which must cover EVERY profile and is therefore
anchored at the root.

**App data does NOT move under `~/termic`.** The Seatbelt profile ends with a
last-match-wins `(deny file-read* (subpath <data_dir>))` protecting the CLI
token, while a worktree under `~/termic` must stay readable by the agent.
Nesting the denied dir inside the worktrees tree would put an allow and a deny
in one subtree.

## Where the profile shows

In the TITLE BAR, as a chip: accent tile, name in clear, and every profile
action behind it (switch, new, manage). It began in the sidebar footer and
moved up for three reasons that point the same way:

- the bar already carries the profile's accent as a wash from the left edge
  (`profileWashCss`), so the name sits INSIDE its own colour rather than being
  a second, disconnected use of it;
- the top-left is where the eye lands on a window, which is the entire job of a
  control that answers "which profile is this";
- it is present in every window whatever else is open, and the sidebar can be
  collapsed away.

The prior art is JetBrains, which puts the project name in this position over
this tint. The wash is deliberately weak and gone by the first third: the bar
carries the breadcrumb and the toolbar, and a solid accent behind them fights
every glyph on it.

The theme picker moved the other way, down to the sidebar footer, to make room.
It is a set-once preference and belongs with the other set-once affordances
rather than on the bar you drive agents from.

## Windows

One window per profile, 1:1, and switching IS opening a window. `profile_open`
focuses the window if it is up and builds it if it is not; from the user's side
that is one action, which is why the popover does not distinguish them.

`build_profile_window` is the single builder for every profile, extracted from
`setup` so the root window and a second profile's window cannot drift: same size
clamp, same cursor-monitor placement, same restore, same close behaviour.

**Every profile window needs a Tauri capability, and the label is how it gets
one.** Capabilities are scoped by window LABEL, and a window matching no entry
gets NO permissions at all, `core:event` included. A profile window then cannot
listen for events, so every PTY spawn in it fails with `event.listen not
allowed on window "profile-work"` and the window is inert.

`capabilities/default.json` therefore lists `profile-*` alongside `main`. This
shipped broken and is the sharpest example of why the root label matters: the
root profile keeps `main`, so the FIRST window worked and only the second one
was dead, which is the half nobody exercises until a real profile exists.
Nothing in the type system connects `window_label()` to a JSON file, so
`every_profile_window_is_covered_by_a_tauri_capability` (profiles.rs) is the
connection, derived from the real label builder and mutation-checked against
the file as it shipped.

**The root profile keeps the literal `main` label.** `tauri-plugin-window-state`
keys saved frames by label, so a pre-profiles install must find its geometry
where it left it, and the automation bridge hardcodes `main` besides. Other
profiles are `profile-<slug>`.

**Closing one window while others are up just closes that window.** The
close-action setting (menu bar / quit / ask) is about the LAST window going
away. A non-root profile destroys rather than hides, so the popover shows it
closed and reopening rebuilds it.

**Windowless is app-wide.** It gates the drop to `ActivationPolicy::Accessory`,
so hiding only `main` while another profile stayed visible would take the Dock
icon out from under a window the user can still see. `enter_windowless` hides
every profile window; `leave_windowless` restores the ones the user had up
(not a root they closed, see below) and focuses one.

**Launch restores what was open.** `Profile::open_at_quit` is set when a window
is built and cleared when the USER closes one; app quit does not clear it, which
is what makes restore work. Least recently focused first, so the window the user
was in ends up frontmost. Not under `feature = "e2e"`: the suite reuses one
window across spec files and asserts on handle counts.

**A closed root window is hidden, never destroyed, and that is the trap.** Its
webview is the app's, so `setup` always builds it, and a root the user closed
is still in `profile_windows`. Two bugs came from that. Building the hidden
root stamped `open_at_quit = true`, so a launch that correctly left main closed
wrote "main was open" and the NEXT launch (an update's relaunch) showed it;
`keep_root_closed_at_launch` puts the flag back. And `leave_windowless` showed
every profile window, so any dock click, `termic open`, second launch, deep
link or profile switch resurrected the closed root. `ROOT_PUT_AWAY` marks the
hide as the user's: `shown_profile_windows` leaves that root out of "which
windows come back" and "is this the last window", unless it is the only one
left. Reopening it from the profile menu (or a task or link that lives in it)
clears the mark and sets the flag again.

## Event routing

54 `.emit(` sites and zero `emit_to` before this. With one window a broadcast was
correct and free; with one per profile every profile's webview would receive
every other profile's PTY bytes, setup logs, grep hits and CLI requests.

Routing is derivable (task → project → profile → window), so nothing is tracked,
but the derivation must not touch disk on a hot path:

- **`pty*://` resolves at SPAWN and `grep-*://` at search start.** Their
  topics carry a PTY id and a per-keystroke search id, not a task id, so a
  lookup by topic could never find them. `pty_spawn` and `task_grep_start`
  already hold the task, take its label there and emit with `emit_to_window`,
  so the hottest path in the app does no disk IO per chunk. Until this was
  fixed every PTY flush missed and re-read every task file; see
  [performance.md](performance.md) bear trap 12.
- **Everything else goes through `emit_scoped`,** which parses the task id out
  of the TOPIC (`setup-done://<id>`, `script-output://<id>:<member>:<kind>`)
  and looks it up in a memo. A task never changes profile, so an entry is
  permanent. A miss is remembered too, and `save_task` seeds the entry for
  every task it writes, so a task created after a miss still resolves. An entry
  is dropped when its task is deleted, and the whole memo when the registry
  changes.
- **An unresolvable id BROADCASTS.** That is the pre-profiles behaviour, and a
  far better failure than an event reaching no window at all.
- **`docker-build://` and `termic://windowless` stay broadcasts.** One image and
  one activation policy per machine, so every window should hear them.

**Deep links are routed at queue time.** `deep_link_take_pending` was a
`std::mem::take`, so whichever webview drained first swallowed every queued URL
including another profile's; the queue is now keyed by target label. Rust still
does not parse these URLs beyond reading ONE query parameter, `project`, which
is the minimum needed to pick a window. Unresolvable goes to the most recently
focused open profile.

**The tray merges.** Each window computes attention from its own profile, so the
last writer would erase every other profile's rows, which is the opposite of
what the menu-bar item is for. `TRAY_ATTENTION` is keyed by window label; rows
group by profile then project, and the profile heading appears only when there
IS more than one, so a single-profile install's menu is unchanged. A tray click
raises the owning window before routing `termic://focus-task` to it.

## localStorage

Every profile window is a webview on the same origin, so localStorage is shared
whether we want it or not. `src/lib/profileScope.ts` namespaces the keys a
profile owns.

**The namespace is the window label, read synchronously** off the Tauri bridge.
That matters: stores read their keys at module-init, so an async
`profiles_list` would be a frame too late and every store would boot from the
wrong state.

**The root profile's keys are UNPREFIXED.** Its label is `main`, which maps to
the empty namespace, so an existing install reads its collapse state, folder
colors and prompt library from exactly the keys they are already in. No
migration, and nothing resets on the release that ships this.

Scoped: project/task/group collapse state, folder colors, `taskExpandMode`,
`hideInactiveProjects`, the status section's switch and folds
(`showStatusSection`, `statusBucketCollapsed`, `statusTaskExpanded`,
`statusGroupCollapsed`),
`newTaskLast*`, member modes, the prompt library.

**NOT scoped, on purpose:** theme, fonts, terminal and editor settings, shortcut
bindings. Those are machine-level (muscle memory does not change per identity)
and are shared by every window. `purgeProfileKeys(slug)` runs on delete, or a
recreated profile with the same slug inherits a dead one's state.

## Deleting, and backing out

**An open window is not a precondition.** Deleting closes it. It used to
refuse ("close the profile's window before deleting it"), which was a chore
invented for the user: they had just confirmed a dialog stating exactly what
would be removed, and the window they were sent to find might be on another
Space or another monitor. Worse, the banner saying so did not re-check, so
closing the window left the dialog still insisting it was open.

The dialog warns instead: the window closes and anything running in it stops.

What IS still refused is deleting the profile whose window is making the
request, and that is not a chore but an impossibility: it pulls the data dir
out from under the dialog that asked. Same rule `profile_close` already has.


These are two different operations and conflating them is a trap:

**`profile_delete`** is destructive and is REFUSED while the profile's window is
open. That is a precondition the user can act on rather than a race to handle,
and it means no PTY is running under the profile at the moment of deletion, so
live agents are never killed behind their back. Metadata is backed up first to
`backups/pre-profile-delete-<slug>-<ts>/`. Worktrees go through
`git worktree remove --force`, never `remove_dir_all`, or the user's own repo is
left with a dangling `.git/worktrees/` registration until someone runs
`git worktree prune`. Main checkouts are skipped and branches are never deleted.

**`profile_close`** closes a profile's window. It exists because the delete
dialog told you to close it and gave you no way to, and the window may be on
another Space or another monitor. It refuses to close the CALLING window, which
is the red button's job, and it clears `open_at_quit` so launch restore does not
bring back a window you deliberately closed.

**`profiles_disable`** stops using profiles and keeps every byte of data. It has
to exist: a delete is refused while the window is open, and the LAST remaining
profile is always the one whose window you are in, so "delete everything" could
never finish from inside the app. It unlinks `profiles.json` and touches nothing
else. Refused while more than one profile exists, because then what happens to
the other profiles' data is a real question the user has to answer.

`profile_delete_preview` supplies the counts the dialog needs (tasks, dirty,
unpushed, main checkouts, worktrees path, window open). Counts, not prose: they
are what make it a decision rather than a leap, and they are the same
information the user would otherwise have to open the profile to find.

## The CLI

`--profile <name>` is global on every verb, matching a slug OR a display name
case-insensitively: the user sees the name in the title bar and the slug on disk and
should not have to know which one the flag wants.

An unknown name is a `BadRequest` naming the profiles that do exist, **never a
fallback to another one** — the server already refuses to guess for an unknown
project, and guessing here would act on the wrong profile's data.

Omitted, a request routes by the `taskId` or `projectId` in its params, and a
request naming neither (`list_agents`, `list_prompts`) goes to the most recently
focused open window.

Two globals carry the value, each correct for its scope and wrong anywhere else:
a `OnceLock` in the CLI, which is a single-shot process with one `--profile` for
its whole run, and a thread-local in `cli_server`, where one connection is served
start to finish on its own thread and the target has to reach `rpc_target_label`
several frames down.

## Agent logins

Phase 1 does nothing here, and that is the whole story: **every profile shares
the one login each agent already has**, because it reads the same config dir and
the same credential store it always did. Nothing is copied, nothing syncs,
nothing can drift.

Agent hooks need no work either, and structurally so: a hook reports by printing
an OSC escape into `$TERMIC_PTY`, the PTY termic spawned for that task, so the
signal rides a stream already routed to one window. `agent_hooks.rs` has zero
`global_dir()` call sites, writing only into the agent's own config dir, so one
install serves every profile.

Profile creation must NOT offer to relocate a config dir. That is the one action
that would hand a new profile a logged-out agent, and it is not how the second
account arrives: the account switcher does that, by giving each account its own
agent config dir holding the credential and symlinking settings, skills,
commands and history back to the primary. See
[docs/agent-accounts.md](agent-accounts.md).

## Where the hard parts are tested

Two things about profiles cannot be tested the obvious way, and both are worth
knowing before changing them:

- **The tray merge and the emit fallback take no `AppHandle`.** They were
  untestable while they did (an `AppHandle` cannot be built off a running app),
  so the decisions are split into `merge_tray_rows` and `emit_target`. That
  puts them under `cargo test --workspace --lib`, which is the REQUIRED CI
  check, rather than the macOS-only e2e job. What is pinned: every window's
  rows survive the merge, registry order holds so the menu does not reshuffle
  between rebuilds, a profile heading appears only when there is more than one,
  a window the registry does not know still contributes its rows, and an
  unresolvable task event broadcasts rather than reaching nobody.
- **The destructive delete runs against a real repo.** `delete_profile_data`
  is split from the window precondition so `git worktree remove --force` can
  be driven against a real worktree: it removes the worktree, spares the main
  checkout, leaves no dangling registration in the parent repo, and writes its
  backup first. Both that and the deep-link resolver were mutation-checked,
  not trusted: breaking each one fails its test.

## Linux

`profiles.rs` contains no platform-specific code at all. Directories, slugs and
the registry are the whole model, and Tauri's multi-window API is
cross-platform, so nothing about profiles is macOS-shaped. The verification was
an audit of every `#[cfg]` in the paths profiles touch plus a real test run.

What IS macOS-only, and correctly gated:

- The Dock icon and `ActivationPolicy::Accessory` behind windowless mode. Linux
  has no Dock, so the setting reduces to hiding and restoring windows.
- Cursor-monitor placement and the window frame clamp, which use the same
  Tauri APIs on both platforms.

One Linux bug came out of the audit and is fixed: **the window close handler
was entirely inside `#[cfg(target_os = "macos")]`**, so on Linux
`Profile::open_at_quit` was never CLEARED when the user closed a window. Launch
restore would then reopen a profile the user had deliberately closed, and keep
doing it. A non-macOS handler now clears the flag; the macOS one additionally
does the activation-policy work that has no Linux equivalent.

`cargo test --workspace --lib` runs green on ubuntu 24.04, profile tests
included. See [agent-accounts.md](agent-accounts.md#linux) for the two
container-environment failures that are not Linux failures, and for the Linux
side of agent logins.

## Known gaps

- **The perf budget multiplies.** N profile windows is N webviews, N WebGL
  terminal renderers, N sets of mounted tasks. `make perf` measures one window.
  The multi-window idle budget is undecided, and so is whether a background
  profile's window should aggressively unmount (`display: none`, never
  `visibility: hidden`, applies per window as well as per pane).
- **Closing a window with running agents.** PTYs live in Rust and survive, so
  the tasks become unmounted-but-running and the menu-bar item is their only
  surface. How much Rust buffers for replay on reopen is unconfirmed.
- **`schema_version` forks.** Each profile's `settings.json` migrates
  independently, so migration code must tolerate profiles at different versions
  after a downgrade/upgrade cycle.
- **A migration saves to the file it read (GH #316).** `load_settings_in(id)`
  migrates on load and used to persist with `save_settings_inner`, which is the
  ROOT writer. A non-root profile that needed a migration therefore overwrote
  the root profile's `settings.json` with its own settings on every load (the
  root's accounts, default tasks path and the rest went with it) and never got
  the migration itself, so the next load did it again: one prompt in the second
  profile's window was enough. It saves with `save_settings_in(id, …)` now.
  Any new write inside a per-profile path has the same trap: `*_inner` means
  root, not "this profile".
- **Multiple windows per profile** is deferred. It needs Rust to become
  authoritative for UI state and forces either two WebGL terminals on one PTY or
  scrollback replay on every move.
- **A project can live in several profiles.** Decision 4 allows it; the
  tie-break is most recently focused. What "move this project to another
  profile" should do with its tasks is undecided.
