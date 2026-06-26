# Docker sandbox (design + Phase 1 plan)

Status: proposed, not started. Opt-in, experimental.

A second, more brutal sandboxing mode that runs the agent CLI inside a
Docker container instead of macOS Seatbelt. The container is the isolation
boundary: the agent can only touch the paths we mount (the repo / worktree),
everything else is installed-in-the-image-but-not-mounted. Cross-platform
for free, and a structurally stronger model than the Seatbelt path
allowlist (default-deny by construction instead of allowlist-minus-denies).

Related: the host-toolchain friction in
[#49](https://github.com/simion/termic/issues/49) is exactly the kind of
thing this sidesteps (the agent gets the image's toolchain, never the
host's).

## Validated by experiment (2026-06-25)

A real spike (Docker 29 / would be OrbStack in prod) confirmed the load-
bearing assumptions before any app code:

- **One generic image runs all six agents.** `node:lts-bookworm` base
  (current Node LTS, verified v24.18.0; always >=22 for Copilot) + npm
  globals for claude/codex/gemini/copilot + official curl installers for
  grok and agy. All six resolve on PATH and report versions (claude 2.1.191,
  codex 0.142.2, gemini 0.47.0, copilot 1.0.65, grok 0.2.64, agy 1.0.12).
  Agents unpinned; upgrade via rebuild-no-cache. Working Dockerfile under
  "Default Dockerfile" below.
- **Worktree git works with the parent `.git` mounted at the matching
  absolute path** - and ONLY then. Mounting just the worktree gives
  `fatal: not a git repository: <parent>/.git/worktrees/<name>` (the
  pointer file is absolute). With both mounted at identical paths,
  `status` / `log` / `commit` all work and the commit lands on the host.
- **macOS file ownership is a non-issue.** The container runs as root
  (uid 0) but files it writes appear host-side owned by the host user
  (Docker Desktop / OrbStack remap via the file-sharing layer). No `--user`
  or chown needed on macOS. (Native Linux would need uid mapping; that is a
  later-phase concern.)
- **One image gotcha:** git refuses the bind-mounted worktree with "dubious
  ownership" until `git config --global --add safe.directory '*'`. Baked
  into the default Dockerfile.
- Image size ~2.8GB (base + 6 agents). `node:lts-slim` is an obvious trim.

## Phase 1 scope

Deliberately minimal. Get a working, trustworthy filesystem cage and good
UX around the Dockerfile + the exact command we run. Nothing else.

### In scope

- **Opt-in, global experimental flag.** A Settings toggle
  `docker_sandbox_enabled`. While off, no Docker UI appears anywhere and
  Docker is never invoked. This is the master switch.
- **Per-workspace, mutually exclusive with Seatbelt.** A workspace uses
  *either* the Seatbelt sandbox (`sandbox_mode`) *or* Docker
  (`docker_sandbox_enabled` on the workspace), never both. The user picks
  per workspace.
- **Filesystem isolation only.** Mount the worktree (and its parent `.git`,
  and any composition members). Nothing else. No network controls at all in
  Phase 1: the container gets default bridge networking with full egress.
- **No tokens; `/login` persists.** No OneCLI/Infisical/proxy, and
  explicitly **no env/OAuth token auth** (investigated, rejected - see
  "Auth"). The user runs `/login` inside the cage once, and it persists
  across container teardown via a single persistent, rw, per-agent
  config-dir mount. That same mount also persists sessions/resume and MCP
  logins. The cage protects the host filesystem, not secrets: if the
  agent's work exposes it to prod/service credentials, it sees them, fine.
- **We do not care which Docker the user has.** OrbStack, Docker Desktop,
  colima, plain `docker` CLI: all fine. We shell out to `docker`. If the
  `docker` binary is missing or the daemon is not running and the user
  selects Docker mode, we tell them plainly and refuse to spawn.
- **One generic Dockerfile for all agents.** A single editable Dockerfile,
  shared across every agent (claude/gemini/codex/...), shipped with a
  sensible default that installs all supported agents + a base toolchain.
  Builds one image; the per-workspace agent is just the command run inside
  it. Editable in Settings as a first-class, prominent surface, not buried.
- **See + customize the mounts, with total transparency.** The mount list
  is shown and editable per workspace. Defaults are computed (worktree +
  parent `.git` + members + the persistent agent config-dir mount).
  Crucially,
  **every implicit mount is surfaced with what it is, why we add it, and
  rw/ro** - nothing is mounted behind the user's back. Implicit vs
  user-added is visually distinct. Paired with the command preview, the
  user can always answer "what can this container see, and why?" See
  "Mount transparency" below.
- **Explain how it works, in the dialog.** The model (container isolation,
  Docker agent separate from the OS agent, log in once, login + MCPs +
  history shared across all Docker workspaces, resume unchanged) must be
  spelled out in plain language inside the popup itself, always visible, not
  in external docs or a hidden tooltip. See "How it works, explained IN the
  dialog".
- **Preview the exact command.** Before spawning, show the literal
  `docker run --rm -it --name termic-{workspace} ...` argv we will execute,
  **multi-line and nicely formatted** (one flag/mount per line, `\`
  continuations, copy-paste-runnable). No hidden flags. What you see is what
  runs. See "Command preview formatting".
- **Extra-args customization only.** The user may append extra `docker run`
  args (e.g. `--memory`, `-e FOO=bar`, an extra `-v`). They are inserted
  into the fixed command at a defined point. We do NOT offer full command
  override in Phase 1 (override means the user owns the mounts, the
  worktree `.git` correctness, the working dir, etc. - too easy to break;
  deferred).
- **A distinct Docker indicator.** A Docker (whale) glyph on the workspace,
  separate from the Seatbelt shield, so it is obvious at a glance which cage
  a workspace is in.
- **Reliable cleanup.** Stable container naming + label so we can always
  find and remove our containers: on agent exit (`--rm`), on workspace
  archive, and on app quit. No orphaned containers.

### Out of scope (later phases)

- Any network controls / egress policy / host allowlist inside the cage.
- OneCLI / Infisical / any credential broker so the agent never sees secrets.
- Full `docker run` command override (vs extra-args).
- Brokered DB access (Teleport/Boundary) for secretless MySQL/Postgres.
- Linux/Windows wiring as the cross-platform isolation story (Docker mode
  is inherently portable, but Phase 1 targets macOS + OrbStack first).
- Per-agent images. Phase 1 ships **one generic Dockerfile/image for all
  agents** (see below); per-agent images are a possible later refinement.
- Live/persisted skills/MCP customization beyond Dockerfile-baked (decided
  against a managed overlay; see "Persisting customizations").
- **Home dir profiles** (tool persistence across workspaces). Design locked
  below; implementation is Phase 2.

## UX

### Settings (global, experimental section)

A new "Docker sandbox (experimental)" section, only meaningful when
`docker_sandbox_enabled` is on:

- Master toggle `docker_sandbox_enabled`.
- **Dockerfile editor.** A code editor (CodeMirror) showing the current
  Dockerfile, with Save + "Reset to default". Below it: image build status
  (last build result, a Rebuild button, build log on demand).
- A live `docker` availability indicator (binary found? daemon up?), driven
  by a `docker_check` command.

### Per-workspace (the existing sandbox dialog, extended)

The shield/sandbox dialog gains a top-level choice when
`docker_sandbox_enabled` is on:

- **Cage: `Seatbelt` | `Docker`** (mutually exclusive). Picking Docker
  hides the Seatbelt mode selector and shows: the **how-it-works explainer**
  (below), the **Mounts** list, **Extra args**, and the **Command preview**.

#### How it works, explained IN the dialog (hard requirement)

The model (isolation, login-once, shared persistence, resume) is genuinely
new to users, so the dialog must teach it inline - not in external docs, not
a tooltip you have to hunt for. A short, always-visible explainer panel at
the top of the Docker view, plain language, no jargon. Target copy:

> **Docker sandbox**
> This agent runs inside a Docker container. It can only touch the files
> listed below. Everything else on your Mac is invisible to it.
>
> **It is a separate agent from your normal one.** Your Docker claude has
> its own login, MCP servers, settings, and chat history, kept apart from
> the claude you run outside Docker.
>
> **Log in once.** The first time, run `/login` inside the agent. Your
> login, MCP servers, and history are saved and **shared across all your
> Docker workspaces** for this agent, so you set it up only once.
>
> **Your conversations resume** the same way they do today.

Rules for this panel:

- Always visible while Docker is selected (not behind a "?" or "Learn more").
- Adapts to the agent name (claude / codex / gemini / ...), not hardcoded.
- No em dashes in the shipped copy (house style); the above is illustrative.
- The three load-bearing ideas must each be stated outright: (1) only the
  mounted paths are visible, (2) Docker agent is separate from the OS agent,
  (3) one login is saved and shared across Docker workspaces.
- Pair it with the per-row "why" in the mount list and the command preview
  so the abstract explainer and the concrete mounts reinforce each other.

The first-run case deserves a nudge: when the shared config dir is still
empty (no login yet), surface a one-line hint near the terminal or dialog,
e.g. "Run /login inside the agent to sign in. You only need to do this once
for all Docker workspaces."

#### Mount transparency (hard requirement)

Nothing is mounted invisibly. Every mount termic adds implicitly is shown
in the list, never hidden behind "and some other stuff." Each row states:

- **host path -> container path** and **rw/ro**.
- **Provenance**: is it termic-implicit or user-added? Visually distinct
  (e.g. implicit rows badged "auto", user rows plain/removable).
- **Why it exists**, in plain language, per row. Examples:
  - worktree -> "your code (the workspace)"
  - parent `.git` -> "git metadata, required for worktrees to work"
  - composition member -> "linked repo in this workspace"
  - config dir (rw) -> "your Docker agent: login, MCP servers, settings,
    history. Saved and shared across all your Docker workspaces."
- **Removability**: implicit mounts that are load-bearing (worktree, parent
  `.git`) are shown but not silently removable - if the user removes one,
  warn what breaks (e.g. "git will fail inside the container"). Convenience
  mounts (credentials) are removable with a clear consequence note
  ("the agent will start unauthenticated").

The command preview is the second half of this contract: the literal argv
makes every `-v`, `-w`, `-e`, and flag visible. Preview + annotated mount
list together mean the user can always answer "what can this container see,
and why?" without reading our source. Implicit-but-unexplained is a bug.

#### Command preview formatting (hard requirement)

NOT one unreadable wrapped line. Render it **multi-line, one argument group
per line**, shell-style with `\` continuations so it is both human-readable
and copy-paste-runnable. Group and order consistently: command, then name/
label, then mounts (one `-v` per line), then workdir/env, then extra-args,
then image, then the agent argv last. Optionally a trailing `# comment` per
mount line tying it back to the "why" from the mount list. Example:

```
docker run --rm -it \
  --name termic-acme-api \
  --label termic.workspace=acme-api \
  -v /Users/x/r/acme-api:/Users/x/r/acme-api \                     # your code (the workspace)
  -v /Users/x/r/acme/.git:/Users/x/r/acme/.git \                   # git metadata (worktree needs it)
  -v /Users/x/.termic/docker-agents/claude:/home/agent/.claude \  # your Docker claude: login, MCPs, history (shared across Docker workspaces)
  -e CLAUDE_CONFIG_DIR=/home/agent/.claude \
  -w /Users/x/r/acme-api \
  -e TERM=xterm-256color \
  --memory 4g \                                                   # (your extra arg)
  termic-sandbox:9f2a1c \
  claude --session-id 1f3e...
```

Inline `# comments` are display sugar in the preview pane; the copyable
form stays valid (comments are legal in a shell line). One flag per line is
the rule - never collapse mounts onto a shared line. This is the same
`render_argv` output, just pretty-printed for the pane; the spawned argv is
unchanged.

### Workspace row

A whale glyph when the workspace is in Docker mode (parallel to the shield
glyph for Seatbelt). See [docs/shortcuts.md](../../shortcuts.md) for the glyph
rendering conventions if the indicator needs a tooltip/affordance.

## Architecture

### New Rust module: `src-tauri/src/docker.rs`

Parallel to `sandbox.rs`. Pure command construction + lifecycle; no
long-running daemon (consistent with the "no backend daemon" rule - we only
shell out to the user's `docker`).

```rust
pub struct DockerSpec {
    pub container_name: String,        // termic-{workspaceId}  (stable)
    pub label: String,                 // termic.workspace={workspaceId}
    pub image: String,                 // termic-sandbox:{dockerfileHash}
    pub mounts: Vec<Mount>,            // host -> container, rw/ro
    pub workdir: String,               // == cwd, same abs path as host
    pub extra_args: Vec<String>,       // user-supplied, validated
    pub env: Vec<(String, String)>,    // TERM, etc (no secrets)
}

pub fn build_spec(ws: &Workspace, settings: &Settings, cmd: &str, args: &[String], cwd: &str) -> DockerSpec;
pub fn render_argv(spec: &DockerSpec, cmd: &str, args: &[String]) -> Vec<String>;  // the preview == the real thing
pub fn ensure_image(dockerfile: &str) -> Result<String, DockerError>;   // build if tag missing; returns image tag
pub fn check() -> DockerStatus;        // binary present? daemon up? version
pub fn cleanup_workspace(ws_id: &str); // docker rm -f by label
pub fn cleanup_all();                  // docker rm -f all termic.* labels
```

`render_argv` is the single source of truth: the preview shown in the UI
and the argv actually spawned are produced by the same function. They can
never drift.

### The spawned command

One `docker run` per agent PTY spawn (matches `--rm` semantics). Example:

```
docker run --rm -it
  --name termic-{workspaceId}
  --label termic.workspace={workspaceId}
  -w /Users/x/r/proj-wt
  -v /Users/x/r/proj-wt:/Users/x/r/proj-wt
  -v /Users/x/r/proj/.git:/Users/x/r/proj/.git
  -v /Users/x/.claude:/root/.claude
  -e TERM=xterm-256color
  {extra_args...}
  termic-sandbox:{hash}
  claude {args...}
```

Key invariants:

- **Mount at identical absolute paths.** The worktree and its parent `.git`
  must appear inside the container at the *same absolute path* as on the
  host. A git worktree's `.git` is a pointer file holding an absolute path
  into `<parent>/.git/worktrees/<name>`; if the paths differ inside the
  container, git breaks. `cwd` (`-w`) must also match. Reuse the existing
  `parent_git_dir_for_worktree` logic from `sandbox.rs`.
- **`--rm`** so a clean exit auto-removes the container. Cleanup-by-label
  (below) is the belt-and-suspenders for crashes/kills where `--rm` never
  fires.
- **Stable `--name` + `--label`.** Name `termic-{workspaceId}` for humans;
  the label is what cleanup filters on (robust against name munging).
- **No secrets in `-e`.** Env is TERM and similar only. Credentials arrive
  via a mount (below), never baked into the previewed argv as plaintext.

### Integration points (grounded in current code)

| Concern | File:line today | Change |
| --- | --- | --- |
| PTY spawn branch | `lib.rs:896-933` (`pty_spawn`) | Before the Seatbelt `sandbox::provision` / `wrap_command`, branch: if `ws.docker_sandbox_enabled && settings.docker_sandbox_enabled`, build via `docker::build_spec` + `render_argv` and spawn that argv instead. |
| Skip PID ancestry | `lib.rs:1013-1015` | Docker isolates by namespace, not PID ancestry. Skip `sandbox::register_root_pid`. |
| Seatbelt provision (reference) | `sandbox.rs:1546-1648` | Mirror shape in `docker.rs`. |
| Workspace struct | `lib.rs:205-319` | Add `docker_sandbox_enabled: bool`, `docker_mounts: Vec<Mount>`, `docker_extra_args: Vec<String>`. |
| Mutual exclusivity | `lib.rs:372` (`effective_sandbox_mode`) | When `docker_sandbox_enabled`, force Seatbelt path off; the two never co-apply. |
| Per-workspace setter | `lib.rs:3242` (`workspace_set_sandbox`) | Extend (or add a sibling `workspace_set_docker`) to persist docker fields; on disable/change, `docker::cleanup_workspace`. |
| Settings struct | `lib.rs:5904-5924` | Add `docker_sandbox_enabled: bool`, `docker_dockerfile: String` (or a path), build cache metadata. |
| TS types | `types.ts:124-202`, `types.ts:350-363` | Mirror the new Workspace + Settings fields. |
| Archive cleanup | `lib.rs:3374-3522` (`workspace_archive_sync`) | After `spotlight_stop_for_ws` (~3377), call `docker::cleanup_workspace(&id)` (non-fatal). |
| App quit cleanup | `lib.rs:6903-6956` (`cleanup_children`, `RunEvent::Exit`) | Add `docker::cleanup_all()` (non-fatal) alongside the existing PTY SIGKILL. |
| New commands | - | `docker_check`, `docker_build_image`, `docker_preview_command`, `docker_get_dockerfile`, `docker_set_dockerfile`. |
| Settings UI | `settings/Settings.tsx` | New Docker section + Dockerfile editor. |
| Workspace dialog | `dialogs/WorkspaceSandboxDialog.tsx` | Cage selector + mounts + extra-args + preview. |

### Threat-model boundary (unchanged, maps cleanly)

The existing rule is "only the agent CLI PTY is sandboxed; aux terminal /
setup / run / archive scripts are not" (CLAUDE.md). Docker mode keeps this
exactly: only the agent PTY runs via `docker run`. Aux terminals, the
run/setup/archive scripts, the editor, and the file tree all stay native on
the host. The bind mount means the host filesystem is the source of truth,
so the editor and file tree need zero changes, and "running the code"
continues to happen on the host as today.

## Auth: in-cage `/login` must persist

**The cage protects the host filesystem, not secrets.** Hiding credentials
from the agent is an explicit non-goal. If the agent's work exposes it to
prod/service credentials, it sees them, and that is fine. No broker, no
"agent never sees secrets" in Phase 1.

**Rejected: env/OAuth token auth.** We investigated authenticating each
agent via an environment token instead of a mount (claude
`CLAUDE_CODE_OAUTH_TOKEN` from `setup-token`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `XAI_API_KEY`, copilot `COPILOT_GITHUB_TOKEN`, agy
`ANTIGRAVITY_TOKEN`). **Decided against it / will not use it.** Two reasons:
it does not actually solve resume (sessions still need a mount, below), and
for several agents the token path is an API key that silently switches
billing from the user's subscription to pay-per-use API, which is a footgun.

**The requirement instead: the user runs `/login` inside the cage once, and
that login persists** across container teardown and re-spawn. The mechanism
is a single **persistent, read-write, per-agent config-dir mount**. The
agent writes its login token into its config dir (on Linux there is no
Keychain, so it is a plain file under the config dir); because that dir is
bind-mounted from a host-side persistent location, the token survives the
ephemeral `--rm` container and the next spawn reuses it. Log in once, stays
logged in.

macOS note: we cannot pre-seed from the host login because the host agent
keeps its credential in the macOS Keychain, not a file - so there is nothing
to copy in. The Linux-container agent simply does its own `/login` the first
time, and that is what we persist.

### Full isolation: docker-agent config is separate from OS-agent config

Hard rule: **we mount NOTHING from the host's real agent config.** Not
`~/.claude`, and especially not `~/.claude.json` - that file embeds
host-specific state (MCP server launch commands with host paths, project
history) that points at scripts/dirs absent in the container, so sharing it
would actively break the agent. The docker agent is a clean, separate
identity from the OS agent.

Model: a **fresh termic-managed dir per agent, empty at first**, e.g.
`~/.termic/docker-agents/{agent}/`. The user runs `/login` **once per agent,
inside docker**; the token lands in that dir and is **reused by every docker
workspace** running that agent. Docker logins are distinct from OS logins by
design; we only persist + reuse the docker ones. Scope: **global per agent**
(one login, all workspaces), matching how concurrent host agents already
share one config dir today. The dir is the resume store and MCP-login store
too, so one mount covers login + resume + MCP auth.

### Per-agent config-dir mapping (validated 2026-06-25)

**Never mount the whole container HOME (`/root`).** Proven failure: it
shadows agent binaries baked into HOME at build time - grok lives in
`~/.grok/bin`, agy in `~/.local/bin` - so an empty home mount makes them
vanish. Mount only the specific config dir, and prefer the agent's own
config-dir **relocation env var** where one exists (cleanest: it folds even
HOME-root dotfiles like `~/.claude.json` into the one mounted dir).

| Agent | Strategy | Container target | Notes |
| --- | --- | --- | --- |
| claude | env `CLAUDE_CONFIG_DIR` | the mounted dir | Verified: folds `.claude.json` + `projects/` + `sessions/` in; no stray HOME file. |
| codex | env `CODEX_HOME` | the mounted dir | Verified: relocates all sqlite state; no stray `~/.codex`. |
| gemini | direct dir mount | `/root/.gemini` | No binary there (binary in `/usr/local/bin`). |
| copilot | direct dir mount | `/root/.copilot` | Skip `~/.cache/copilot` (regenerable pkg cache). |
| agy | direct dir mount | `/root/.gemini` (+ `/root/.antigravity`) | Binary in `~/.local/bin` - do NOT mount `~/.local`. Shares `.gemini` shape with gemini. |
| grok | **outlier - special** | `/root/.grok` | Binary + bundled skills + config all live in `~/.grok`; can't mount over it. No clean home-relocate env (config is "discovered per dir"; only `GROK_WORKSPACE_BUNDLED_SKILLS_DIR` is relocatable). Needs: relocate binary to `/usr/local/bin` in the image + seed bundled skills/config into the mounted dir on first run, OR mount only grok's writable state subdirs. May be deferred from Phase 1. |

- Mount the **directory**, rw - never a lone token file (atomic
  write-tmp-then-`rename()` breaks across a single-file bind mount:
  EXDEV / "device busy"). The relocation-env approach sidesteps this
  entirely by keeping everything in one dir.
- **Do NOT alias `Agent.sandbox_allowed_paths` (`lib.rs:6081`)** - Seatbelt
  RW allow-list, different semantics. The docker config-dir mapping is its
  own per-agent field.
- Container HOME stays writable; we mount only the config dir(s) into it.

### The actual shared mount (cross-workspace persistence)

This is the concrete mechanism that makes login + MCPs + sessions persist
and be **shared across all docker workspaces** of an agent: **every** such
workspace mounts the **same single host dir** into its container. The host
path does not vary by workspace - that sameness *is* the sharing.

```
# claude (uses CLAUDE_CONFIG_DIR relocation)
docker run ... \
  -e CLAUDE_CONFIG_DIR=/home/agent/.claude \
  -v ~/.termic/docker-agents/claude:/home/agent/.claude \   # SAME host dir for every claude workspace
  ...

# codex (uses CODEX_HOME relocation)
  -e CODEX_HOME=/home/agent/.codex \
  -v ~/.termic/docker-agents/codex:/home/agent/.codex \      # SAME host dir for every codex workspace

# gemini / copilot / agy (direct dir mount, no relocation env)
  -v ~/.termic/docker-agents/gemini:/root/.gemini \          # SAME host dir for every gemini workspace
```

- The host side (`~/.termic/docker-agents/{agent}/`) is created once,
  per agent, and reused by every workspace. Workspace A logs in / adds an
  MCP; workspace B (same agent) sees it immediately on next spawn.
- It does **not** vary per workspace or per project - global per agent.
- Sessions stay separated inside that shared dir because they are cwd-keyed
  (`projects/<worktree-path>/`) and each worktree path is unique; termic's
  explicit per-workspace `--session-id` resolves any ambiguity.
- It is a **termic-owned dir, never the host's real `~/.claude`** - full
  isolation from the OS agent (see the isolation rule above).

## Sessions and resume

termic's resume is core (per-workspace `--session-id <uuid>` to mint,
`--resume <uuid>` to pick up; see the agent registry capabilities). It must
keep working in Docker mode.

Verified fact (host inspection, 2026-06-25): claude stores session
transcripts under `~/.claude/projects/<munged-cwd-path>/<uuid>.jsonl`,
**keyed by absolute cwd**. The other agents follow the same shape under
their own config dirs. Two consequences:

1. **Resume needs the session store to persist.** With `--rm` and no config
   mount, the transcript written in-container vanishes on exit and
   `--resume <uuid>` finds nothing. Persistence is mandatory for resume to
   work at all - it is not free.
2. **The cwd key must match.** Because we mount the worktree at the
   **same absolute path** inside the container (required anyway for the
   worktree `.git`, see "The spawned command"), the cwd key the agent
   computes inside the cage matches the host's - so the persisted
   `projects/<cwd>/` lines up across spawns.

Mechanism: **the very same persistent rw config-dir mount from the Auth
section carries the sessions.** No separate mount. A global-per-agent config
dir naturally segregates sessions by workspace because they are cwd-keyed,
and each worktree has a unique path. So: one persistent config-dir mount
gives login persistence AND resume in one move.

**Reuse termic's existing UUID resume verbatim - do not invent a new one.**
Docker mode passes the same `--session-id <uuid>` (mint) / `--resume <uuid>`
(resume) args from `workspace.agent_session_ids`, exactly as the Seatbelt
path does. The explicit per-workspace UUID is what makes a *shared global*
config dir safe across many workspaces (cwd-keying + explicit id, no
"resume last in cwd" guessing).

**Cross-cage caveat:** the docker config dir is a separate store from the OS
one, so a workspace's session history does NOT cross the Seatbelt <-> Docker
boundary. The mint-vs-resume decision must therefore be **cage-aware**: the
first docker spawn of a workspace must *mint* (`--session-id`) even if an OS
session UUID already exists, otherwise `--resume` points at a transcript
that lives only in the OS store and fails. Track "minted in docker?" per
(workspace, cage) - e.g. by presence of the session file in the docker
config dir, or a per-cage spawn flag.

Open verification (spike): confirm `--session-id` mint then `--resume`
survives a container teardown with the config dir mounted, for claude
first, then per agent (each may key/store sessions slightly differently).

## Persisting customizations: skills, MCPs, settings

This turns out to be a **feature, not a hard problem**, because the
persistent global-per-agent config dir (from "Auth") already carries
everything the agent records about itself. There are two persistence layers
and they divide cleanly:

**1. Static / image-level -> the Dockerfile.** System tools, CLI deps, and
MCP server **executables** that aren't fetchable at runtime: baked via
`RUN` / `COPY`. Versioned, reproducible, shareable, no mounts.

**2. Agent-level user config -> the persistent config dir.** Everything the
agent writes about itself, created *inside* the running container and
impossible to bake into an image: `/login` tokens, **MCP registrations +
their OAuth logins** (`claude mcp add ...`), agent-managed skills, settings,
memory, and session history. Because the config dir is global-per-agent and
persistent, all of this **persists AND is shared across every docker
workspace** for that agent. Configure claude once inside docker - add your
MCPs, log in, set your preferences - and it is there in every future docker
workspace. One setup, everywhere.

The one nuance for MCP servers: an MCP has two halves. The **registration +
auth** persists in the config dir for free (cross-workspace). The MCP server
**executable** must still be runnable in the container - an `npx` / `uvx`
server just works (Phase 1 has open egress and Node/npm in the image), but a
system-binary MCP server wants a line in the Dockerfile. So: registrations
are automatic and durable; only an exotic server binary needs the image.

This is why the config-dir mount MUST be a **directory**, rw. It is at once
the `/login` persistence, the resume store, the MCP-registration store, and
the user-customization layer - all isolated from the OS agent.

Caveats to document for users:

- It is a **separate identity from the OS agent** (by design - see "Auth").
  A docker login / MCP setup is independent of the host agent's; configure
  docker once, separately. No clobbering across the boundary, but also no
  automatic carryover from your OS agent setup.
- **OS-keychain-backed tokens won't persist** - a Linux container has no
  macOS Keychain, so only file-based token stores under the config dir
  survive. Most MCP OAuth implementations write a token file; flag any that
  don't as known-not-persistable.
- Reproducible/shareable setup (not a personal login) still belongs in the
  **Dockerfile**, so a teammate gets it from the image rather than your
  local config dir.

Rejected: a separate home-overlay dir or named Docker volume purely for
persistence. Unnecessary - the config-dir mount already persists all runtime
state; a second overlay would only collide with it.

### Where users add customizations (guidance to surface in-product)

The Dockerfile we ship should be **self-documenting** with clearly marked,
commented regions so the user knows exactly where each thing goes, e.g.:

```dockerfile
# ── Base: agents + toolchain (managed by termic; edit with care) ──
...
# ── Add MCP servers here (installed into the image) ──
# RUN npm i -g @some/mcp-server
# ── Add CLI tools / system packages here ──
# RUN apt-get install -y ...
# ── Add baked-in skills here (COPY from a path you control) ──
# COPY my-skills/ /root/.claude/skills/
```

Plus a short in-UI note next to the Dockerfile editor stating the split:
"Install tools, MCP servers, and baked skills here. Personal logins (agent
auth, MCP OAuth) are NOT set up here - just run the agent and log in once;
those persist via your mounted config directory."

## Home dir profiles (tool persistence across workspaces)

**Phase 2. Design locked here; not built in Phase 1.**

The persistent config-dir mount covers login, MCPs, and sessions. It does
not cover user-installed tools: anything you `pip install --user`,
`cargo install`, add to `.bashrc`, etc. is lost when the `--rm` container
exits. Home dir profiles close this gap.

A **profile** is a named, host-side directory
(`~/.termic/profiles/{name}/`) whose subdirectories are selectively
bind-mounted into the container's HOME, surviving teardown and shared
across any workspaces that reference it. Install a tool once; it is there
on every subsequent spawn of every workspace using that profile.

### What a profile persists

Profiles target user-space locations under HOME:

| Mount target | What lands here |
| --- | --- |
| `~/.local/lib/` | `pip install --user`, pipx, custom libs |
| `~/.local/bin/` | user-installed binaries (see seeding below) |
| `~/.local/share/` | app data, some tool state |
| `~/.config/` | tool configs (git, nvim, ripgrep, etc.) |
| shell dotfiles (`.bashrc`, `.zshrc`, `.profile`) | aliases, PATH, env |

System packages (`apt install`, `npm install -g` to `/usr/local/`) are NOT
persisted by profiles - they belong in the Dockerfile. Profiles are the
user-space complement to the Dockerfile's system layer: volatile user
installs live in the profile, reproducible shared installs go in the image.

### Profile seeding (solving the agy conflict)

The general rule from findings.md is "never mount the whole HOME" - an
empty overlay breaks binaries baked into HOME at image build time (notably
`agy` in `~/.local/bin`). The same risk applies to individual subdirs if
they are mounted empty over non-empty image content.

**Solution: profile seeding.** On first use of a profile (or when the
image hash has changed since the last seed), termic runs a short-lived
init container before the main spawn:

```
docker run --rm \
  -v ~/.termic/profiles/{name}:/profile \
  termic-sandbox:{hash} \
  sh -c 'cp -a ~/.local/bin/. /profile/.local/bin/ 2>/dev/null; cp -a ...'
```

This copies the image's existing content into the empty profile directories
so the bind mount never shadows built-in binaries. Subsequent runs mount the
now-populated profile on top of the image. User installs accumulate in the
profile alongside the seeded content. Re-seeding on image rebuild merges
new image content into the profile without clobbering user additions.

Seeding is skipped when the profile already contains content and the image
hash matches the stored seed-hash.

### Cross-workspace sharing

A profile is referenced by **name**, not by workspace ID. Multiple
workspaces declare the same profile and mount the same host-side directory:

```
Workspace A (profile: python-dev) ─┐
                                    ├─> ~/.termic/profiles/python-dev/
Workspace B (profile: python-dev) ─┘
```

Install a package in workspace A; it is available in workspace B on next
spawn. This is the right model for environment personas ("data science",
"Rust toolchain", "frontend") that should be consistent across workspaces.

Profiles are per-agent (parallel to the config-dir design): a profile
named "python-dev" for claude is a distinct host directory from one for
codex. The config-dir mount is always present alongside profile mounts and
does not overlap.

### Concrete mounts

```
docker run ... \
  # profile mounts (one per selected subdir, provenance "profile: python-dev")
  -v ~/.termic/profiles/python-dev/.local/lib:/root/.local/lib \    # user libs
  -v ~/.termic/profiles/python-dev/.local/bin:/root/.local/bin \    # user bins (seeded)
  -v ~/.termic/profiles/python-dev/.config:/root/.config \          # tool configs
  -v ~/.termic/profiles/python-dev/bashrc:/root/.bashrc \           # shell env
  # config dir (always present, separate from profile)
  -e CLAUDE_CONFIG_DIR=/home/agent/.claude \
  -v ~/.termic/docker-agents/claude:/home/agent/.claude \
  # worktree mounts (as today)
  -v /Users/x/r/proj:/Users/x/r/proj \
  -v /Users/x/r/proj/.git:/Users/x/r/proj/.git \
  ...
```

Profile mounts appear in the mount list annotated with "profile: {name}"
provenance (distinct from the auto-implicit worktree mounts and the
user-added mounts). Each row shows the persisted host path, the container
target, and rw.

### UI surface

- **Profile selector** in the workspace Docker dialog, below the mount
  list. Options: "None (ephemeral)" | named profiles | "New profile...".
- Selecting a profile inserts its mounts into the list with the "profile"
  badge and updates the command preview.
- **Profile management** in Settings (alongside the Dockerfile editor):
  create, rename, delete, inspect disk usage, force re-seed.
- On image rebuild: nudge "Profile {name} was seeded from the previous
  image. Re-seed to pick up new built-in content?" with a single action.

## Image build lifecycle

- One generic, editable Dockerfile stored in the app data dir, shared by
  all agents (default installs every supported agent + base toolchain). One
  Dockerfile -> one image, reused by every workspace regardless of agent.
- Base is `node:lts-bookworm` (always current Node LTS, >=22 for Copilot).
- Image tag is content-addressed: `termic-sandbox:{sha256(dockerfile)[:12]}`.
  `ensure_image` builds (with cache) only when the tag is absent, so editing
  the Dockerfile triggers a rebuild on next spawn; an unchanged Dockerfile
  is a no-op.
- Build is surfaced in Settings (status + Rebuild + log). First build is
  large/slow (~2.8GB: agents + toolchain); communicate that.
- If `docker` is unavailable at build/spawn time, fail loudly and do not
  fall back to running unsandboxed.

### Upgrading agents (unpinned + rebuild-no-cache)

Agents are deliberately **not pinned** (`npm i -g <pkg>` latest, curl
installers latest). The catch: the content-hash tag and Docker's layer cache
both mean a normal rebuild of an *unchanged* Dockerfile reuses the old agent
versions - nothing re-fetches. So upgrading needs an explicit cache-bypass.

- **"Update agents" = `docker build --no-cache --pull`.** One click in
  Settings. `--pull` refreshes the LTS base; `--no-cache` re-runs the
  install layers, fetching the latest agents (and Node LTS) in one shot. No
  pinning, no per-version bumping. (Validated: a `--pull` rebuild moved
  codex 0.142.1 -> 0.142.2 with no Dockerfile change.)
- **Disable in-agent auto-update** in the image (env/config flags) so the
  running version is exactly what the image ships - no ephemeral half-update
  inside a `--rm` container, no drift. termic owns the version via rebuild.
- Surface the image's agent versions in Settings so "Update agents" has a
  visible before/after.

### Keeping the shipped default in sync (drift handling)

Problem: termic ships a default Dockerfile; the user edits it; later we ship
a newer default (new agent, base bump, fix). The user's copy is now stale,
and we must not clobber their edits. Approach:

- **Managed region + user regions, by sentinel markers.** The default is
  split: a termic-managed block (base, agents, `safe.directory`) between
  `# >>> termic managed (do not edit) >>>` / `# <<< termic managed <<<`
  markers, and the user-editable regions below (the "add MCP / tools /
  skills here" blocks). On app update we **regenerate only the managed
  block in place**, preserving everything in the user regions. Drift-free
  updates while keeping a single editable file.
- **Version stamp.** A `# termic-dockerfile-version: N` header lets us detect
  a stale managed block and re-render it. If the user never touched the file
  (matches a prior shipped default verbatim), silently update; no prompt.
- **If the user edited inside the managed block** (markers moved/altered),
  do not silently overwrite - **notify**: "termic's base Dockerfile changed
  (e.g. added agent X). [Update managed section] [Keep mine] [View diff]",
  backing up their file first.
- **"Restore default"** is always available as the nuclear option (full
  reset to the current shipped default), and every overwrite/restore writes
  a timestamped backup so it is reversible.

### Default Dockerfile (validated)

This builds and runs all six agents today (see "Validated by experiment").
Ship it as the reset-to-default; the commented regions are the user's
customization surface.

Agents are UNPINNED (always latest). Upgrade = rebuild without cache
(`docker build --no-cache --pull`); the full file lives at
[Dockerfile](Dockerfile).

```dockerfile
# ── Base: current Node LTS (always >=22, satisfies Copilot) ────────────
FROM node:lts-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates ripgrep less openssh-client \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:${PATH}"

# Bind-mounted worktrees are owned by a different uid; without this git
# refuses every op with "dubious ownership".
RUN git config --global --add safe.directory '*'

# Agents: one per line, each preceded by its source / docs page
# (can't comment inside a `\`-continued RUN).
# https://www.npmjs.com/package/@anthropic-ai/claude-code
RUN npm install -g @anthropic-ai/claude-code
# https://www.npmjs.com/package/@openai/codex
RUN npm install -g @openai/codex
# https://www.npmjs.com/package/@google/gemini-cli
RUN npm install -g @google/gemini-cli
# https://www.npmjs.com/package/@github/copilot
RUN npm install -g @github/copilot
# grok -> ~/.grok/bin   https://docs.x.ai/build/cli
RUN curl -fsSL https://x.ai/cli/install.sh | bash
# agy -> ~/.local/bin   https://antigravity.google/docs/cli-install
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

# ── Add MCP servers here ──   # RUN npm install -g @some/mcp-server
# ── Add CLI tools here ──     # RUN apt-get update && apt-get install -y <pkg>
# ── Add baked skills here ──  # COPY my-skills/ /root/.claude/skills/

WORKDIR /workspace
CMD ["bash"]
```

## Cleanup (must be airtight)

Three layers, all filtering on the `termic.workspace` label:

1. **`--rm`** removes the container on normal agent exit.
2. **Archive** (`workspace_archive_sync`): `docker rm -f` containers
   labeled for that workspace, before/while tearing down the worktree.
3. **App quit** (`cleanup_children` on `RunEvent::Exit`): `docker rm -f` all
   `termic.*`-labeled containers.

Because the name is stable (`termic-{workspaceId}`) and labeled, a
re-spawn after an unclean shutdown can also `docker rm -f` a stale
same-named container first to avoid name conflicts.

## Open questions / decisions to lock

- **UID mapping.** Files written by the container should not appear
  host-side as `root`. OrbStack maps this reasonably; plain Docker may need
  `--user $(id -u):$(id -g)` plus a writable HOME in the image. Default to
  matching host uid; verify the agent CLIs still run and can write their
  config dir. (Spike.)
- **One container per workspace vs per PTY.** Phase 1 assumes per-spawn
  `docker run` with a stable per-workspace name. If a workspace can host
  multiple concurrent agent PTYs, names collide; either suffix the name per
  PTY (label stays per-workspace) or move to one long-lived container +
  `docker exec`. Decide during the spike.
- **Worktree `.git` mount** was the main correctness risk - **resolved by
  the 2026-06-25 spike**: works with `{worktree, parent .git}` at matching
  abs paths + `safe.directory '*'` baked into the image. macOS ownership
  remap confirmed. Remaining: confirm an MCP OAuth login survives a restart.
- **Extra-args validation.** Reject args that would break the cage
  (e.g. `--privileged`, `--network host`, `-v` onto `/`)? Or trust the
  user since this is opt-in/experimental and the preview shows everything?
  Lean trust + preview for Phase 1, revisit.

## Task breakdown (Phase 1)

1. ~~Spike: worktree `.git` mount + image builds all agents + macOS
   ownership~~ **DONE (2026-06-25).** Remaining spike bits: (a) enumerate
   per-agent config/`/login`-token + session locations (dir vs HOME-root
   dotfile); (b) confirm an in-cage `/login` persists across teardown via
   the rw config-dir mount; (c) confirm `--session-id` mint then `--resume`
   survives teardown. claude first, then per agent.
2. `docker.rs`: `check`, `build_spec`, `render_argv`, `ensure_image`,
   `cleanup_workspace`, `cleanup_all`.
3. Data model: Workspace + Settings fields (Rust + TS), persistence/migration.
4. `pty_spawn` branch + skip PID registration for Docker.
5. Cleanup wiring: archive + app-quit + stale-name pre-removal on spawn.
6. Commands: `docker_check`, build, dockerfile get/set, command preview.
7. UI: Settings Docker section + Dockerfile editor; workspace dialog cage
   selector + mounts + extra-args + live preview; whale indicator glyph.
8. Ship the validated default Dockerfile (above) + reset-to-default.
9. e2e pass (use the `e2e` skill) on: enable flag, pick Docker for a
   workspace, preview matches spawn, agent runs, archive cleans up, quit
   cleans up.
