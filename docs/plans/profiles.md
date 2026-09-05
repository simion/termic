# Profiles (Chrome-style, one window per profile)

Status: approved 2026-09-05 by the maintainer in
[#278](https://github.com/simion/termic/issues/278). Ready to implement.

**Phase 1 of two.** Phase 2 is multiple accounts per agent
([agent-credentials.md](agent-credentials.md)), a separate delivery that
lands after this one and changes nothing here. Phase 1 ships profiles on the
single shared login every agent already has.

This doc replaces `docs/ideas/spaces.md`, deleted in the same commit. Spaces
proposed a filter with a window attached: one data set, one `settings.json`,
a Space overriding a short list of fields and nothing else. That model was
rejected. What is being built is real isolation, the way Chrome does it, and
the sections below carry forward everything from the Spaces write-up that is
true of ANY multi-window design, because the window count is where most of
the cost lives and that part was never Spaces-specific.

## The idea

A **Profile** is a fully isolated termic instance: its own projects, tasks,
settings, agents and config, running in its own window.

```
Profile "Work"      own window, own projects + tasks + settings + agents
Profile "Personal"  own window, own projects + tasks + settings + agents
```

The point is two windows on two monitors, live at the same time, that cannot
see each other's projects. Not a sidebar filter, and not serial switching
inside one window: the parallel case is the use case
([#278](https://github.com/simion/termic/issues/278)).

## Settled

Recorded from the maintainer's comments on #278. These are decisions, not
options.

1. **One window per profile.** v1 is strictly 1:1. Multiple windows sharing
   one profile is deferred, see "Deferred" below.
2. **Everything is profile-scoped.** Settings, projects, tasks, agents,
   config, all of it. This is the difference from Spaces and it is the
   whole feature.
3. **Phase 1 changes nothing about logins.** The agents registry is scoped,
   but an agent's LOGIN is not termic state: it lives in the CLI's own config
   dir and the OS credential store. Every profile running `claude` is
   therefore the same account, already logged in, exactly as today. Phase 2
   gives a profile its own accounts by giving it its own agent config dir,
   holding the credential and nothing else, with settings, skills, commands
   and conversation history symlinked back so none of it is duplicated. That
   is phase 2's problem entirely. See
   [agent-credentials.md](agent-credentials.md).
4. **The termic CLI and MCP address the profile that owns the project.** A
   project determines its profile, a profile determines its window. If the
   same project is in two or more profiles, take Chrome's rule and use the
   most recently focused window.

## Deferred

- **Multiple windows per one profile.** Not in v1. It needs a
  Rust-authoritative sync layer (see "Window model"), and it is the one part
  of the Chrome analogy that costs a rewrite rather than a feature.
- **Multiple accounts per agent, and switching between them.** Settled in
  the same thread, but it is **phase 2 and a completely separate delivery**.
  Nothing in this doc waits on it and nothing in it changes this doc's data
  model. Phase 1 ships profiles with the single shared login every agent
  already has. See [agent-credentials.md](agent-credentials.md).

## Window model: one window per profile

1:1 profile-to-window is a consequence of how termic holds state, not a
compromise. The Zustand store is the live source of truth and it is
per-webview. A second window is a second WKWebView with a second JS runtime;
there is no shared store across two windows without promoting Rust to be
authoritative for UI state (tab selection, mounted tasks, panel layout, live
titles) and turning every store write into an IPC round-trip. That is a
rewrite of the store layer, not a feature on top of it.

It also breaks at the terminal. A task's xterm.js buffer, WebGL context and
scrollback live in one webview's DOM. The same task open in two windows
means either two WebGL terminals drawing one PTY, straight into the idle
GPU budget ([performance.md](../performance.md) bear trap 2), or tearing
down and replaying scrollback whenever the task moves. PTY output routing in
Rust would need "which windows subscribe to this pty id" instead of "the
window".

Profile-per-window has none of this: two profiles are two disjoint data
sets, each window's store owns its profile completely, and task ownership is
**derivable** rather than tracked (task to project to profile to window).
No mount registry, no "which window has task T" bookkeeping.

Window labels must be stable and distinct (`profile-<slug>`), because
`tauri-plugin-window-state` keys by label and every profile would otherwise
fight over one saved frame.

## Process model

One process, one webview window per profile. Not separate OS processes.
Settled; the rest of this doc assumes it.

Everything stateful on the Rust side is already keyed per-task, not
per-window: the PTY registry, the per-task CONNECT proxy threads, sandbox
provisioning, and the port allocator (`task_port_intervals` and its stray
buffer). None of them ask which window a task belongs to, and the sandbox
cages the agent process rather than the app. Two profiles are two disjoint
sets of task ids in registries that were never window-aware. Two processes
would mean two PTY hosts and two port allocators racing over one port space.

One process also keeps the singletons singleton: one Dock icon, one updater,
one CLI socket and token store, one menu-bar item. And it keeps "move this
task to another profile" possible later as a metadata move, since the
worktree itself never has to move.

Crash containment is the only argument the other way and it is weak. A Rust
panic takes down the shared PTY host either way, since the PTYs are its
children. A webview crash is already contained without help: WKWebView runs
each webview in its own WebKit content process.

## Scope

Profile-scoped, per decision 2:

- **Projects** (`projects.json`), project groups, and the **tasks** they own
  (`tasks/<uuid>.json`).
- **`settings.json` in full**, including `repos_dir` / worktrees base,
  default agent, default sandbox mode and YOLO, notification prefs, prompt
  library, theme selection.
- **The agents registry** (`settings.agents[]`), including customs, enabled
  flags, args and per-agent env. This is what lets a profile point an agent
  at a different account, and lets a client profile ban an agent outright.
- **Window state**, keyed by the `profile-<slug>` label.

Global, and it must stay global:

- **Rust-baked sandbox invariants**: the secrets deny-list,
  `builtin_rw_paths`, per-CLI hostname filters. A profile picks among modes
  and never weakens the floor, otherwise the laxest profile is the one that
  gets exploited. The security boundary is the sandbox, never the profile.
- **Custom theme files** (`~/.config/termic/themes/*.json`). User-authored
  assets; profiles pick from the shared set, they do not fork it.
- **Keyboard shortcuts.** Muscle memory does not change per identity.
- **Update channel and the update banner.** One binary, one update, rendered
  in every window off shared Rust state.
- **The CLI control socket and its token.** One socket, Rust routes by
  profile.
- **Agent logins.** Not ours to scope: they live in the agent's own config
  dir and the OS credential store, and termic does not relocate either. See
  "Agent logins across profiles".

### Profile creation seeds, it never blanks

The strongest argument against this feature is the first run: a new profile
starts empty, so a user who wanted a second window gets a second
installation and configures their agents twice. That argument is answered by
construction rather than dismissed:

- Agent DETECTION is a machine fact. Binary paths are identical in every
  profile and irritating to re-detect, so a new profile's registry is seeded
  from a shared detection pass, not presented blank.
- Agent LOGINS are not termic state (decision 3). A new profile's `claude`
  is already logged in, because the config dir and credential store it reads
  are the same ones. Profile creation must NOT offer to relocate a config
  dir: that is the one action that would hand a new profile a logged-out
  agent, and it is not how the second account arrives (phase 2 does that).

If creating a profile ever presents a blank settings screen, the model has
drifted and this is the section it drifted from.

## Agent logins across profiles

Phase 1 does nothing here, deliberately, and that is the whole story:
**every profile shares the one login each agent already has.** A user who
opens a second profile finds `claude` logged in, because it is reading the
same config dir and the same credential store it always did. Nothing is
copied, nothing is synced, nothing can drift.

The two facts that make that free are worth writing down, because they are
also what phase 2 builds on:

- **A login is not termic data.** claude keeps its token in the macOS
  Keychain and its displayed identity (`oauthAccount`) in `.claude.json`;
  codex, grok and gemini keep a JSON file under their own home; opencode
  keeps rows in SQLite. termic stores none of it.
- **Nothing in phase 1 relocates a config dir.** Phase 2 does, but only as a
  container for the credential, with history symlinked back so no
  conversation ever moves. Until then there is one config dir per agent, the
  one it already had.

Phase 2 layers accounts on top without disturbing any of it. It gives each
profile its own agent config dir, because the credential store is keyed by
that path and there is no other way to hold two live accounts, and then
symlinks `settings.json`, `CLAUDE.md`, `skills/`, `commands/`, `agents/`,
`projects/` and `history.jsonl` straight back to the primary. Claude's
settings writer follows symlinks and writes through to the target, so there
is one copy of every setting and one conversation history, shared by every
profile. Nothing in this doc's data model gains a credential field. See
[agent-credentials.md](agent-credentials.md).

## Data layout

Two different things are called "the termic dir" and profiles treat them
differently.

### App data: the default profile stays exactly where it is

```
~/Library/Application Support/termic/     (termic_dev in debug builds)
├── profiles.json          NEW. the registry: slug, name, accent, order,
│                          last_focused_at, and which slug owns the root
│                          (see "Deleting a profile"). Read by every window.
├── settings.json          the DEFAULT profile's. Not moved.
├── projects.json          same
├── tasks/                 same
├── scratch/               same
├── profiles/
│   └── <slug>/            every profile EXCEPT the default
│       ├── settings.json
│       ├── projects.json
│       ├── tasks/
│       └── scratch/
├── docker/                global: the Dockerfile and image are machine facts
├── docker-agents/<agent>/ global in phase 1 (an agent login is OS-level)
├── docker-forge/{gh,glab} global: one gh / glab login per machine
└── backups/               global
```

**One identifier, the slug, keyed the same way in both trees.** The data dir
is `<data>/profiles/<slug>/` and the worktrees base is
`~/termic/profiles/<slug>/tasks`, so the two halves of a profile are the same
word in both places and can be correlated by eye in a terminal. There is no
separate opaque id: the slug is frozen at creation and survives every rename
(see the worktrees section for why nothing may move afterwards), which is
exactly the property an id exists to provide. It is also the window label
(`profile-<slug>`), which `tauri-plugin-window-state` keys by and therefore
needs stable and distinct.

**The default profile is the existing directory, and nothing moves.** Same
rule the workspace-to-task migration followed, for the same reason: a
migration that relocates working data is a risk with no user-visible payoff.
Someone who never creates a second profile has an identical install, and
`profiles.json` is absent until the first one is created.

The default profile has no directory of its own and needs no slug on disk:
it is the root. Rejected: hoisting everything into `profiles/default/`. That
is a full migration, it invalidates every path in
[data-model.md](../data-model.md),
the `TERMIC_DATA_DIR` automation seam and `scripts/e2e-seed.mjs`, and it buys
symmetry and nothing else.

**How Rust knows which profile a command means.** This is the biggest
mechanical change in phase 1 and it needs deciding before any of it is
written. Passing a slug through every command signature is invasive and
silently forgettable. Derive it from the CALLING WINDOW instead: commands take
`window: tauri::Window`, the `profile-<slug>` label maps to a profile, and
`profile_dir(&window)` replaces `data_dir()`. Then **delete `data_dir()`**
rather than leaving it working: a caller that forgets the window must be a
compile error, not a silent write into the default profile's `projects.json`.

`localStorage` is the other half of the same problem and is listed under
"Costs and gaps": all windows share one webview origin, so anything not keyed
by task UUID needs a `profile:<slug>:` prefix.

### Worktrees: `~/termic/profiles/<slug>/tasks`

The default profile keeps writing `~/termic/tasks/<project>/<name>/`,
unchanged and unmoved. A NEW profile is seeded with
`~/termic/profiles/<slug>/tasks` as its tasks path, editable like any other:

```
~/termic/
├── tasks/                        the default profile, exactly as today
│   └── <project>/<name>/
├── workspaces/                   pre-rename legacy, still emptying out
└── profiles/
    └── <slug>/
        └── tasks/
            └── <project>/<name>/
```

Why the `profiles/` level rather than `~/termic/<slug>/tasks`: it namespaces
the slugs. A profile named "tasks" or "workspaces" would otherwise land on
the two directories that already mean something, and a profile named after a
project would read as one. It also mirrors the app data layout, so there is
one mental model for both.

Why `tasks` stays as the leaf: the setting is a BASE, and every base resolves
`<base>/<project>/<name>`. Keeping the segment means the existing tasks path
setting, its per-project override and `expand_home` all keep their exact
meaning, and the only thing that changed is the default value a new profile
is seeded with.

**The slug is captured at creation and never changes.** Store it on the
profile record. Renaming a profile renames the profile, not the directory,
for the same reason nothing else here moves: CWD-resume agents key sessions
to the working directory, so a rename that relocated worktrees would silently
orphan every conversation under it. Slugs are lowercased, filesystem-safe,
and deduped with a numeric suffix at creation time.

Existing worktrees never move, and a profile's tasks path applies to NEW
tasks only.

### Why the app data does NOT move under `~/termic`

Tempting for symmetry, and it would break the sandbox. The Seatbelt profile
ends with a last-match-wins `(deny file-read* (subpath <data_dir>))` that
protects the CLI token, while a task's worktree under `~/termic` must stay
readable and writable by the agent. Nesting the denied data dir inside the
worktrees tree puts an allow and a deny in the same subtree and makes the
failure mode "the agent cannot read its own worktree" the moment someone
points a tasks path at the wrong place. Data stays in
`dirs::data_local_dir()`; `~/termic` stays the place worktrees live.

## The profile indicator: a strip above the sidebar footer

Two states, and the first one is "this feature does not exist yet".

### No profiles created: nothing new, just an entry point

The app looks exactly as it does today. The sidebar footer gains one icon
button for profiles, in the slot freed below, and that is the whole surface:
it opens Settings to Profiles, where the first one is created. Same rule as
the data layout, where `profiles.json` does not exist until someone makes a
profile. Anyone who never uses the feature never sees a strip, a name, or a
color.

### Profiles exist: a strip of its own, above the footer

Once there is more than one profile, a dedicated full-width strip appears
directly ABOVE the footer row, at the bottom of the sidebar, carrying the
accent tile and **the profile name in clear**. Not an icon, not a truncated
pill in a row of icon buttons: the name is the point, and it is what tells
you which window you are typing into.

```
expanded:
┌──────────────────────────────────────────────┐
│  (project list)                              │
├──────────────────────────────────────────────┤
│ ██  Work                                   ▾ │  <- new strip, name in clear
├──────────────────────────────────────────────┤
│ bug  mail  keys  activity               ⚙   │  <- footer, unchanged except
└──────────────────────────────────────────────┘     Add project is gone

compact rail (56px):
   ┌────┐
   │ ██ │   accent tile + monogram, no name
   ├────┤
   │ …  │   footer stack
   │ ⚙  │
   └────┘
```

**Clicking the strip opens the profile popover**: every profile, with the
open ones marked. Clicking one focuses its window if it is open and LAUNCHES
it if it is not, which is the same action either way from the user's side.
Plus "New profile..." and "Manage profiles". Switching is opening a window,
per the one window per profile rule, and this popover is the only place that
distinction has to be explained.

### The footer loses Add project

`FolderPlus` in the footer duplicates "Add project (repo)" in the PROJECTS
header (`Sidebar.tsx`), which is where the action belongs, next to the list
it acts on. Delete the footer copy. The footer keeps the support cluster
(bug, contact, shortcuts, activity) and Settings stays at the absolute right
edge, where the gear is reflexively reached for.

### Mechanics worth writing down before someone re-derives them

- **Reuse `--bottom-bar-h`** (36px, Tailwind `h-9`, the shared height for
  every bottom bar in the app) for the strip. It is one more bar of the same
  kind, not a new metric.
- **Do NOT hardcode the offset for `UpdateCard`.** It floats absolutely at
  `bottom-[var(--bottom-bar-h)]` today so it clears the footer at any scroll
  position. With a strip below it, wrap strip and footer in ONE positioned
  container and anchor the card to that container's top edge, rather than
  keeping an arithmetic `calc()` in sync by hand. The strip is conditional,
  so the arithmetic version is wrong half the time.
- **Compact mode**: tile plus monogram, no name, matching the rail's rule of
  identity over controls.
- **Tint the strip with the profile accent.** It is the largest always-on
  surface the accent gets, and the accent is what people actually read.

### Naming the profile that already exists

Creating the FIRST new profile turns the current install into "a profile",
and it needs a name and a color at that moment or the strip reads "Default"
forever. The New Profile wizard asks for both, for the existing profile and
the new one, exactly like Chrome does on first split.

## New profile: a wizard, not the welcome dialog

A new profile opens its own window and runs a **New Profile** wizard. It is
NOT `WelcomeDialog`: `welcomed` is a one-time onboarding flag and stays
global, so first-run setup must never replay just because someone made a
second profile. Reuse the step components, drop the machine-level steps.

`WelcomeDialog` today is four steps: repos dir + CLI detection, agent hooks,
theme, project picker. For a profile, two of those are already answered:

1. **Identity.** Name and accent color. New, and it is the whole point.
2. **Tasks path.** Prefilled `~/termic/<slug>/tasks`, editable.
3. **Projects.** The same picker, re-running discovery against the tasks path
   above. A profile with no projects is a legitimate end state, so this step
   can be skipped.

Dropped from the flow, deliberately: CLI detection (binary paths are machine
facts, and the new profile's registry is SEEDED from the shared detection
pass, per "Profile creation seeds, it never blanks"), agent hooks (installed
into the agent's own config dir, which phase 1 shares), and theme (global;
only the accent is per profile).

## Deleting a profile

The dangerous operation, because a profile owns worktrees and worktrees hold
uncommitted work. Termic already has the right shape for this and it should
be reused rather than reinvented: archive is recoverable, `task_delete` and
`delete_task_file` are the hard path, and a main checkout is never removed.

**Preconditions.** The profile's window must be closed first, and the delete
is refused while it is open. One window per profile makes that a rule the
user can act on rather than a race to handle, and it means no PTY is running
under the profile at the moment of deletion. Live agents in that window are
therefore the user's decision, made before the dialog appears, not something
the delete kills behind their back.

**What the dialog must say before it is confirmable.** Counts, not prose:
how many tasks, how many of those have uncommitted changes, and how many
carry branches with unpushed commits. That is the only information that makes
this a decision rather than a leap, and it is the same information the user
would otherwise have to open the profile to find.

**The dialog asks, it never assumes.** One choice, presented explicitly,
with the safe option preselected:

```
Delete profile "Work"?

  6 tasks   ·   2 with uncommitted changes   ·   3 unpushed branches

  (•) Keep the worktrees on disk
      ~/termic/profiles/work/tasks/ is left untouched.

  ( ) Delete the worktrees too
      Removes 6 worktrees. Branches are kept.

  [ ] I understand 2 tasks have uncommitted changes      <- only shown for
                                                            the second option
                                                            when the count > 0
                        [ Cancel ]  [ Delete profile ]
```

The checkbox appears only where it is load-bearing: choosing to delete
worktrees when some hold uncommitted work. Everywhere else it is noise, and a
confirmation people always dismiss stops being a confirmation. No type-the-
name gate: the counts plus a preselected safe option carry the weight, and
this app does not use that pattern anywhere else.

**The two scopes behind that choice:**

1. **Remove the profile, keep the worktrees.** Deletes
   `<data>/profiles/<slug>/` and the profile's entry in `profiles.json`.
   Leaves every directory under `~/termic/profiles/<slug>/tasks/` exactly
   where it is, still registered with its parent repo. Nothing of the user's
   work can be lost, and the trees can be re-adopted by hand or by a future
   import.
2. **Remove the profile and its worktrees.** Each worktree goes through
   `git worktree remove --force` against its source repo, exactly as
   `task_archive` does, NEVER `remove_dir_all`. A blind recursive delete
   leaves a dangling registration in the parent repo's `.git/worktrees/`
   until someone runs `git worktree prune`, and the parent repo is the user's
   own, not ours to leave dirty.

**Rules that hold in both scopes:**

- **Branches are never deleted.** Archive asks separately (`delete_branch`),
  and a bulk profile delete is the worst possible place to answer that
  question on the user's behalf.
- **A main-checkout task is never touched.** `is_main_checkout` points at the
  user's live repository, which termic did not create and must not remove.
  Same reason archive already skips `git worktree remove` for them.
- **Registered projects are only registrations.** Deleting a profile removes
  its `projects.json`, never a single byte of the repositories it named.
- **Back up the metadata first**, to `backups/pre-profile-delete-<slug>-<ts>/`,
  following the precedent the task migration set. It is a few JSON files, it
  costs nothing, and it makes the cheap half of a mistake recoverable.
  Worktrees are not backed up: they are large, and scope 1 already keeps them.
- **Prune `profile:<slug>:` localStorage keys** in the same operation, or a
  recreated profile with the same slug inherits a dead profile's collapse
  state and folder colors.
- **Prune the saved window frame** for the `profile-<slug>` label, for the
  same reason.

### Deleting the profile that lives at the root

The default profile has no directory of its own: its data IS the root, which
is what makes existing installs migration-free. That asymmetry surfaces here,
and the answer is not to forbid the delete.

`profiles.json` names which slug owns the root. Deleting that profile removes
the four root entries it owns (`settings.json`, `projects.json`, `tasks/`,
`scratch/`) and clears that field. The root then holds only genuinely global
state (`profiles.json`, `docker/`, `docker-agents/`, `docker-forge/`,
`backups/`) and every remaining profile lives under `profiles/<slug>/`.
Nothing is promoted, nothing is moved, and the resolver's rule stays one
line: the profile flagged as root uses the root paths, everyone else uses
their own directory, and there may be no root profile at all.

**Deleting the last profile** returns the app to its pre-profiles state: the
strip disappears, `profiles.json` goes away, and the footer shows the profile
icon again. A user can therefore fully back out of the feature, which is the
property that makes trying it cheap.

### After deletion

A `termic://` link or a CLI command naming the deleted profile fails and says
so. It must not fall back to another profile, for the same reason
`find_project` treats an unknown project as an error rather than picking the
first one.

## Costs and gaps

- **localStorage is not per-profile and never will be for free.** All
  profile windows share one webview origin, so everything in localStorage is
  silently global: project-group collapse state and folder colors,
  `taskExpandMode` / `collapsedTasks`, the `newTaskLast*` keys, the prompt
  library, and anything else not keyed by task UUID (UUID-keyed entries are
  fine, UUIDs are disjoint across profiles). This needs a `profile:<slug>:`
  key namespace or a move to the per-profile data dir on disk. It is the
  single biggest hidden cost of the feature and it should be the first thing
  built, not the last.
- **`schema_version` forks.** Each profile's `settings.json` migrates
  independently, so migration code must tolerate profiles sitting at
  different versions after a downgrade / upgrade cycle.
- **The menu-bar item legitimately sees every profile at once.** Knowing an
  agent needs you in the other window is why it exists
  (`build_tray_menu` / `tray_set_attention` in `src-tauri/src/lib.rs`, fed
  by `src/lib/trayAttention.ts`). Each window computes from its OWN profile
  now, so unlike the Spaces design the payloads are disjoint and Rust needs
  a merge: N windows pushing partial sets into one menu. Group rows by
  profile so the menu reads as "which window is this in". Clicking a row
  emits `termic://focus-task`, which every window currently receives
  (`src/lib/windowlessMode.ts`); it must become an `emit_to` against the
  owning window, which must also be raised.
- **`enter_windowless` / `leave_windowless` hardcode
  `app.get_webview_window("main")`,** and `WINDOWLESS` is a single
  `AtomicBool`. With `profile-<slug>` labels, windowless is true only when NO
  window is up. That flag gates the activation-policy drop to Accessory and
  the menu-bar item is the only way back, so a one-window check would drop
  the Dock icon while another profile is still visible.
- **Deep links have a real race.** `deep_link_take_pending` is a
  `std::mem::take` and the nudge is a payload-free broadcast, so with N
  windows whichever webview drains first swallows every queued URL,
  including ones meant for another profile. Rust must resolve the target to
  its profile, hand the URL to that window alone, and raise it. Note
  `queue_deep_link` calls `leave_windowless` before anything is resolved, so
  the raise has to move after the routing decision. If the owning profile's
  window is not open, open it and then deliver.
- **The CLI needs profile addressing.** "The running app" stops being one
  namespace. Minimum: `--profile <name>` on every command, plus a default
  rule when it is omitted. Decision 4 settles the ambiguous case for a
  project that exists in several profiles (most recently focused window),
  but a command that names nothing still needs a rule, and the existing code
  refuses to guess elsewhere (`find_project` in `src-tauri/src/cli_server.rs`
  treats an unknown project as an error rather than falling back to the
  first one).
- **Cmd+N is taken.** It is "New task..." (`src/lib/shortcuts.ts`), so it is
  not free for Chrome's new-window convention. The profile switcher needs
  another home: a Dock icon menu (works with no window focused) plus a
  command-palette entry is the cheap answer.
- **Global UI on per-window webviews.** The update banner renders in every
  window off shared Rust state. The settings dialog splits into a
  per-profile section and a global section, which is where the scope table
  above becomes literal UI. A clicked notification must focus the owning
  profile's window, so the notifier carries a profile id.
- **The perf budget multiplies.** N profile windows means N webviews, N
  WebGL terminal renderers, N sets of mounted tasks. `make perf` measures
  one window today. Decide the multi-window idle budget, and whether a
  background profile's window should aggressively unmount, remembering that
  `display: none` (never `visibility: hidden`) discipline applies per
  window, not just per pane.
- **Closing a window with running agents.** PTYs live in Rust and survive,
  so the tasks become unmounted-but-running and the menu-bar item is their
  only surface. Reopening needs scrollback from somewhere, and how much Rust
  buffers for replay is unconfirmed.

## Migration

- **The default profile is the existing data dir, moved nothing.**
  `profiles/<id>/{projects.json,tasks/,settings.json}` subdirs are created
  only for NEW profiles. Anyone who never creates a second profile notices
  nothing.
- **Worktrees never move.** Same reason the workspace to task migration
  refused to: CWD-resume agents (`claude --continue`) key sessions to the
  working directory, and relocating a worktree silently orphans its history.
  A profile's `repos_dir` applies to new tasks only.
- **Existing `Project.group` values** are a plausible seed for initial
  profiles, and this needs deciding either way.

## Open questions

- Profile switcher UX: Dock icon menu, command palette, both? (Cmd+N is
  out.)
- Launch restore: every profile that was open, or only the last focused
  one? Interacts with the `profile-<slug>` window labels.
- Is a project in exactly one profile? Decision 4 explicitly allows it in
  several, which makes the switcher's "move this project" action a copy
  rather than a move, and needs a rule for what happens to its tasks.
- The shape of "move this task to another profile", if built: the same
  process makes it possible, but it needs a UI and a rule for the live PTY
  mid-move.

## What was considered and dropped

**Spaces (a filter with a window).** The immediately preceding design, in
`docs/ideas/spaces.md` until this commit. A Space was a named, colored group
of projects with its own window, everything global unless the Space
explicitly overrode a short list (env map, `repos_dir`, default agent,
default sandbox mode, accent color). It was cheaper: one `settings.json`,
one migration path, one namespace for the CLI and deep links, no
localStorage namespacing. It was dropped because it is a view rather than a
boundary, and the ask was the boundary. Its own docs had to say "this is not
a security boundary" and "the personal project is still in the store in the
work window, merely not shown", which is exactly the property that makes it
the wrong answer for someone who wants work and personal genuinely apart.

**Single-window, Arc-style switching.** Considered in the #278 thread as the
cheaper shape of the same idea. Rejected for the reason the requester gave:
work and personal open on two monitors is the use case, and swiping between
them in one window makes that serial again.

**Multiple windows per profile, Chrome-style.** Deferred rather than
rejected outright, but see "Window model": it forces either two WebGL
terminals on one PTY or scrollback replay on every move, and it needs a
task-to-window ownership registry that one-window-per-profile makes
derivable instead.

**`TERMIC_PROFILE` injected into every PTY as a CLI default.** Designed in
full once, and it carries a trap worth remembering if it is proposed again:
tmux's server is machine-global, so whichever pane starts it captures that
value and every later pane in any context inherits it. `pty_spawn`'s env
overlay does not help, because it fixes the direct child, not a server that
outlives it.

**Routing deep links by last-focused window, in general.** Rejected as a
GENERAL rule: focus is not where a link points, and the existing code
refuses to guess (`parseOpen` names ambiguous candidates rather than picking
one). Decision 4 applies it narrowly, to the one case where a project is
genuinely in several profiles and there is nothing else to go on.
