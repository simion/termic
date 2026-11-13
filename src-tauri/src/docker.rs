// Docker sandbox mode (opt-in, experimental). Parallel to `sandbox.rs`,
// but the isolation boundary is a Docker container instead of macOS
// Seatbelt: the agent CLI runs inside `docker run` and can only touch the
// paths we bind-mount (the worktree, its parent `.git`, composition
// members, and a persistent per-agent config dir). Default-deny by
// construction.
//
// This module is PURE command construction + image/container lifecycle.
// No long-running daemon (consistent with the "no backend daemon" rule —
// we only shell out to the user's `docker`). `render_argv` is the single
// source of truth: the argv previewed in the UI and the argv actually
// spawned come from the same function, so they can never drift.
//
// Design: docs/docker-sandbox/design.md

use crate::sandbox::{canonicalize_or_keep, parent_git_dir_for_worktree, subst_path};
use crate::{global_dir, Task};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Tag prefix for every image we build. Cleanup and listing filter on this.
const IMAGE_REPO: &str = "termic-sandbox";
/// Label key stamped on every container we run, so cleanup can find them
/// robustly even if the `--name` was munged.
const LABEL_KEY: &str = "termic.task";

// ───────────────────────────── Mounts ──────────────────────────────────

/// Why a mount exists — surfaced per-row in the dialog so the user can
/// always answer "what can this container see, and why?". `Implicit`
/// mounts are added by termic; `User` mounts come from extra-args / the
/// editable mount list.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MountProvenance {
    Implicit,
    User,
}

/// A single bind mount: host path -> container path, with rw/ro and the
/// human explanation shown in the mount list + command-preview comment.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Mount {
    pub host: String,
    pub container: String,
    pub read_only: bool,
    pub provenance: MountProvenance,
    /// Plain-language reason shown in the dialog row and as the trailing
    /// `# comment` in the command preview.
    pub why: String,
    /// Load-bearing implicit mounts (worktree, parent `.git`) are shown
    /// but warn-on-remove rather than silently removable.
    pub load_bearing: bool,
}

impl Mount {
    fn implicit(host: String, container: String, read_only: bool, why: &str, load_bearing: bool) -> Self {
        Mount {
            host,
            container,
            read_only,
            provenance: MountProvenance::Implicit,
            why: why.to_string(),
            load_bearing,
        }
    }
}

/// Where a HOST path appears inside the (Linux) container.
///
/// Docker mode mounts the task at the same absolute path on both sides, so
/// the paths an agent prints, the images termic pastes, and the cwd-keyed
/// session ids are valid in both places. On macOS and Linux that is the
/// identity. On Windows it cannot be: a container target must start with
/// `/`, and `C:\Users\u\repo` is not a Linux path at all. There the
/// path maps to `/c/Users/u/repo` (the drive letter as the first segment,
/// Git Bash's convention), which stays stable per host path, so session
/// resume by cwd keeps working.
pub(crate) fn in_container(host: &str) -> String {
    if cfg!(windows) {
        windows_to_container(host)
    } else {
        host.to_string()
    }
}

/// For a git worktree (its `.git` is a `gitdir:` FILE), write a copy of
/// that file whose gitdir is the container-side path, and return where it
/// was written. `None` for a regular checkout or anything unreadable.
fn container_gitfile(task_path: &str) -> Option<String> {
    let dot_git = std::path::Path::new(task_path).join(".git");
    if !std::fs::metadata(&dot_git).ok()?.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let raw = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let abs = if std::path::Path::new(raw).is_absolute() {
        raw.to_string()
    } else {
        std::path::Path::new(task_path).join(raw).to_string_lossy().into_owned()
    };
    let dir = crate::global_dir().ok()?.join("docker-gitfiles");
    std::fs::create_dir_all(&dir).ok()?;
    // One file per worktree, named by a hash of its path, so concurrent tabs
    // of one task share it and two tasks never collide.
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    task_path.hash(&mut h);
    let out = dir.join(format!("{:016x}.git", h.finish()));
    std::fs::write(&out, format!("gitdir: {}\n", in_container(&canonicalize_or_keep(&abs)))).ok()?;
    Some(out.to_string_lossy().into_owned())
}

/// Pure half of `in_container`, tested on every platform.
pub(crate) fn windows_to_container(host: &str) -> String {
    // A verbatim `\\?\C:\...` prefix (fs::canonicalize output) carries
    // nothing the mapping needs.
    let h = host.strip_prefix(r"\\?\").unwrap_or(host);
    let b = h.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        let drive = (b[0] as char).to_ascii_lowercase();
        let rest = h[2..].replace('\\', "/");
        let rest = rest.trim_start_matches('/');
        return if rest.is_empty() { format!("/{drive}") } else { format!("/{drive}/{rest}") };
    }
    h.replace('\\', "/")
}

// ───────────────────────────── Spec ────────────────────────────────────

/// Everything needed to render one `docker run` invocation for a task
/// agent spawn. Produced by `build_spec`; rendered to argv by `render_argv`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DockerSpec {
    /// `termic-{taskId}` (stable, human-facing).
    pub container_name: String,
    /// `termic.task={taskId}` — what cleanup filters on.
    pub label: String,
    /// `termic-sandbox:{dockerfileHash}`.
    pub image: String,
    /// host -> container bind mounts (rw/ro), with provenance + why.
    pub mounts: Vec<Mount>,
    /// Working dir inside the container — MUST equal the host cwd (same
    /// absolute path) so the worktree `.git` pointer + session cwd-key line up.
    pub workdir: String,
    /// Things the user should know about this spec: a value that could not
    /// mean what it says inside a container, and what termic did about it.
    /// Surfaced by the command preview, which is the one place a person can
    /// see what a launch will actually do.
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Env injected via `-e` (TERM and config-dir relocation only — NEVER
    /// secrets; credentials arrive via the config-dir mount).
    pub env: Vec<(String, String)>,
    /// User-appended `docker run` args, inserted at a defined point.
    pub extra_args: Vec<String>,
}

// ─────────────────────── Per-agent config dir ──────────────────────────

/// How a given agent's persistent config dir is wired into the container.
/// `env_relocation` uses the agent's own relocation env var (cleanest —
/// folds even HOME-root dotfiles into the one mounted dir); the others are
/// direct dir mounts. NEVER mount the whole container HOME — it shadows
/// agent binaries baked into HOME at build time (grok in ~/.grok/bin, agy
/// in ~/.local/bin). See findings.md.
struct AgentConfig {
    /// Container path the config dir is mounted at.
    container_dir: String,
    /// `Some(VAR)` when the agent supports a config-dir relocation env var
    /// (claude `CLAUDE_CONFIG_DIR`, codex `CODEX_HOME`) — its value is
    /// always `container_dir`, so there is nothing else to store.
    relocation_env: Option<&'static str>,
    /// Extra container dirs to also mount from the same host config dir
    /// (e.g. agy needs `.antigravity` alongside `.gemini`; opencode splits
    /// its XDG config/data dirs).
    extra_dirs: Vec<String>,
}

/// Every agent this module has a CONFIRMED state dir for and mounts
/// unconditionally — no opt-in needed, because `agent_dirs::state_dirs`
/// only lists dirs `docs/docker-sandbox/findings.md` actually
/// verified. grok is the one exception still declined outright: binary +
/// skills + config all live under `~/.grok`, no clean relocation env.
///
/// omp is in despite the installer's default prefix: `omp.sh/install` puts the
/// binary in `$HOME/.local/bin` (measured 18.6.0), which is OUTSIDE the
/// mounted `~/.omp` tree, so the mount cannot shadow it.
pub const KNOWN_SAFE_AGENTS: &[&str] =
    &["claude", "codex", "copilot", "agy", "antigravity", "opencode", "pi", "omp", "muse", "cursor"];

/// Whether an agent OUTSIDE `KNOWN_SAFE_AGENTS` can even be offered the
/// opt-in "persist config in Docker mode" toggle at all. `false` for grok
/// specifically (see `agent_config`'s doc comment on why it's a permanent
/// exception) - `true` for everything else, including agents this module
/// has genuinely never heard of, since it can't rule those out.
pub fn persist_offerable(agent_id: &str) -> bool {
    // devin is grok's exact collision with a different layout: its binaries
    // live under `~/.local/share/devin/cli/_versions/` and its login
    // (`credentials.toml`) sits in the SAME tree, so the dir a user would
    // mount to keep the login is the one that shadows the binary.
    !matches!(agent_id, "grok" | "devin")
}

/// The agent id whose Docker SHAPE applies: an agent's own id, unless it is a
/// clone, in which case the agent it extends. Follows the chain (a clone of a
/// clone) with a hop cap, so a cycle in `extends` cannot spin here.
/// `base_agent_id` for callers that do not already hold the registry. Loads it
/// and returns an owned-by-'static id, since every base we care about is a
/// built-in name. Falls back to the id itself when the registry cannot be read,
/// which is the same answer `base_agent_id` gives for an unknown agent.
/// The built-ins `base_agent_id_str` can resolve a clone down to.
///
/// Hoisted out of that function so a test can see it: an id missing from here
/// resolves to "claude" SILENTLY, which for a clone means it is handed another
/// agent's config shape. `a_new_builtin_agent_is_registered_in_every_table_that_needs_it`
/// (agent_dirs.rs) is what makes that loud.
pub(crate) const BASE_BUILTINS: &[&str] = &[
    "claude", "codex", "copilot", "agy", "antigravity", "opencode", "pi", "omp", "grok", "gemini", "muse", "devin",
    "cursor",
];

/// Is this a base id `base_agent_id_str` actually knows, rather than one it
/// would quietly answer "claude" for?
/// Test-only: the exhaustiveness guard in `agent_dirs` asks this, and nothing
/// in the app does. Gated rather than left public so a dead-code warning is
/// never suppressed on a table this important.
#[cfg(test)]
pub(crate) fn base_agent_id_is_known(id: &str) -> bool {
    BASE_BUILTINS.contains(&id)
}

pub fn base_agent_id_str(id: &str) -> &'static str {
    const BUILTINS: &[&str] = BASE_BUILTINS;
    let agents = crate::load_settings_inner().agents;
    let base = base_agent_id(&agents, id);
    BUILTINS.iter().copied().find(|b| *b == base).unwrap_or("claude")
}

pub fn base_agent_id<'a>(agents: &'a [crate::Agent], id: &'a str) -> &'a str {
    let mut cur = id;
    for _ in 0..8 {
        let Some(a) = agents.iter().find(|a| a.id == cur) else { return cur };
        match a.extends.as_deref() {
            Some(parent) if !parent.is_empty() && parent != cur => cur = parent,
            _ => return cur,
        }
    }
    cur
}

/// Map an agent id to its config-dir wiring.
///
/// A `KNOWN_SAFE_AGENTS` id gets its confirmed dir from
/// `agent_dirs::state_dirs` (shared with Seatbelt's default allow-list —
/// see that module's doc comment) plus any user-added extras, mounted
/// unconditionally.
///
/// Anything else — including every custom agent a user adds — has NO
/// confirmed state dir, so nothing is mounted for it unless BOTH
/// `persist_enabled` is true AND the user has listed at least one extra
/// dir themselves (Settings → Docker Sandbox → "Per-agent config dirs").
/// This is opt-in on purpose: guessing a config dir for an unknown agent
/// risks the exact failure `agent_dirs.rs` documents for grok/agy — an
/// empty dir mounted over a path that ALSO holds a binary baked into the
/// image at build time silently shadows it, and there is no way to know
/// in advance whether a given path is safe for an agent this module has
/// never seen.
/// Takes `base_id` (WHAT the agent is), never the agent's own id. An agent id
/// answers a different question - WHERE its state is stored - and that one is
/// the caller's, via `agent_config_host_dir`. The two differ exactly for a
/// cloned agent: a clone of claude runs the claude binary and has claude's
/// config shape, but must keep its own folder, which is the whole reason to
/// clone an agent. Conflating them is what made clones unusable in Docker
/// mode: matching on the clone's own id fell through to the unknown-agent
/// path, so nothing was mounted, nothing was relocated, and the agent wrote
/// its login into the container's throwaway filesystem (into `/root`, which
/// the non-root container user cannot even write - the EACCES a user sees).
/// The parameter is deliberately named for what it must be, so a future
/// caller cannot pass the wrong id without noticing.
fn agent_config(base_id: &str, user_extra_dirs: &[String], persist_enabled: bool) -> Option<AgentConfig> {
    // grok is a PERMANENT exception, not merely "not yet known safe": its
    // binary lives at `~/.grok/bin` inside its own config dir, so the
    // opt-in path below would let a user type ".grok" as an extra dir and
    // silently shadow the binary the image just installed there — the
    // exact failure mode this whole opt-in gate exists to prevent, just
    // reachable through the front door instead of a guess. No warning
    // text can fully substitute for actually knowing this in advance, so
    // it's blocked outright rather than left to the opt-in + warning.
    // devin is the same case one level deeper: the credential lives in
    // `~/.local/share/devin` next to the versioned binaries the install script
    // unpacks there, so the only mount that keeps its login is the one that
    // hides its binary.
    if base_id == "grok" || base_id == "devin" {
        return None;
    }
    let sanitized: Vec<String> = user_extra_dirs.iter().filter_map(|d| sanitize_extra_dir(d)).collect();
    if KNOWN_SAFE_AGENTS.contains(&base_id) {
        let (first, rest) = crate::agent_dirs::state_dirs(base_id).split_first()?;
        // Shared with the hooks installer, which has to write into the same
        // relocated dir a clone actually uses. Two copies of this table would
        // put one account's hooks in the other account's config.
        let relocation_env = crate::agent_dirs::config_relocation_env(base_id);
        // `state_dirs` entries are home-relative names; `sanitized` entries
        // are already full container paths (they may point outside HOME).
        let extra_dirs = rest
            .iter()
            .map(|d| format!("{CONTAINER_HOME}/{d}"))
            .chain(sanitized.iter().cloned())
            .collect();
        return Some(AgentConfig {
            container_dir: format!("{CONTAINER_HOME}/{first}"),
            relocation_env,
            extra_dirs,
        });
    }
    if !persist_enabled {
        return None;
    }
    let (first, rest) = sanitized.split_first()?;
    Some(AgentConfig {
        container_dir: first.clone(),
        relocation_env: None,
        extra_dirs: rest.to_vec(),
    })
}

/// Reject anything that isn't a plain relative dotfile-style path before it
/// can become a mount TARGET inside the container. Without this, a stray
/// `../..` in a user-added extra dir would resolve outside `/root` (e.g.
/// `/root/../../etc` -> `/etc`), silently bind-mounting an agent's config
/// folder over an unrelated container path. Returns the trimmed, leading-
/// dot-stripped-of-slashes relative path, or `None` if it doesn't look
/// like one.
fn sanitize_extra_dir(d: &str) -> Option<String> {
    let d = d.trim();
    if d.is_empty() || d.contains("..") || d.contains('\0') {
        return None;
    }
    // An ABSOLUTE path is taken as the container path verbatim, so a
    // directory can be persisted anywhere, not only under the agent's home.
    // A bare name is still accepted and means what it always did - the
    // agent's home - because `.claude` reads better than `/root/.claude` and
    // is what every existing entry looks like.
    let container = if d.starts_with('/') {
        d.trim_end_matches('/').to_string()
    } else {
        format!("{CONTAINER_HOME}/{}", d.trim_start_matches("./").trim_end_matches('/'))
    };
    // `/` alone, or anything that normalised away to nothing.
    if container.is_empty() || container == CONTAINER_HOME { return None; }
    if !persist_target_allowed(&container) { return None; }
    Some(container)
}

/// Roots an empty persist mount must never land on or inside: shadowing any
/// of these with a fresh directory either breaks the container outright or
/// hides something privilege-relevant the image put there.
const PERSIST_FORBIDDEN_ROOTS: &[&str] = &[
    "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/proc", "/sys", "/dev", "/boot",
];

/// Roots a persist entry MAY live under. `/root` is the agent's home and the
/// common case; the rest are the conventional places a program keeps data it
/// would like to survive a restart. Anything else is refused rather than
/// guessed at - the cost of a wrong guess is a container that will not boot,
/// and the user can always pick a path under one of these.
const PERSIST_ALLOWED_ROOTS: &[&str] = &[
    "/root", "/home", "/opt", "/srv", "/mnt", "/data", "/workspace", "/var", "/tmp",
];

fn persist_target_allowed(container: &str) -> bool {
    let under = |root: &str| container == root || container.starts_with(&format!("{root}/"));
    if PERSIST_FORBIDDEN_ROOTS.iter().any(|r| under(r)) { return false; }
    // Never a bare root itself, even an allowed one: mounting over all of
    // `/var` or `/home` is not what anyone means by persisting a directory.
    if PERSIST_ALLOWED_ROOTS.iter().any(|r| container == *r) { return false; }
    PERSIST_ALLOWED_ROOTS.iter().any(|r| under(r))
}

/// HOME inside the container. Bare persist entries resolve against it.
pub const CONTAINER_HOME: &str = "/root";

/// Where a container path is stored on the host, under this agent's own
/// folder. The container path is MIRRORED (`/opt/cache` ->
/// `<agent>/opt/cache`) so two entries can never collide, and a leading dot
/// on a home-relative entry is dropped to keep the layout every existing
/// install already has (`.antigravity` -> `<agent>/antigravity`).
fn host_subpath_for(container: &str) -> String {
    let rel = container.strip_prefix(&format!("{CONTAINER_HOME}/"))
        .map(|r| r.strip_prefix('.').unwrap_or(r).to_string())
        .unwrap_or_else(|| container.trim_start_matches('/').to_string());
    rel
}

/// Container paths a task-level extra mount can never target: everything
/// under `/root` is already spoken for by the per-agent config dir wiring
/// (`agent_config`), and the rest are system dirs where an empty (or
/// unrelated) mount would either shadow something the image needs to boot
/// or reach for privilege-relevant files. This is a denylist of ROOTS -
/// checked by prefix, not exact match, so `/root/x` is rejected the same
/// as `/root` itself.
const UNSAFE_MOUNT_TARGET_ROOTS: &[&str] = &[
    "/root", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/proc", "/sys", "/dev", "/var", "/opt", "/boot",
];

/// Parse + validate one `host_path:container_path` entry from
/// `Task.docker_extra_mounts`. Unlike `sanitize_extra_dir` (a name relative
/// to an agent's own config dir), this is a full user-chosen pair with two
/// independent halves to check:
/// - host: `$HOME`/`~`/`$WORKSPACE` expanded, then must resolve to a
///   non-empty absolute path (relative host paths have no fixed base to
///   resolve against the way the config-dir helpers do).
/// - container: absolute, no `..`, and not under `UNSAFE_MOUNT_TARGET_ROOTS`
///   - the container half is a deliberate user choice (see docker.rs's
///   `Task.docker_extra_mounts` doc comment for why this isn't forced to
///   match the host path), so it needs its own real validation rather than
///   reusing the host half's.
/// Returns `(host, container)` or `None` for a malformed/unsafe entry -
/// callers drop those silently rather than surfacing a spawn-time error,
/// same as every other sandbox list parser in this file.
fn sanitize_extra_mount(raw: &str, home: &str, task_path: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    // Split at the LAST colon: the container half is a Linux path and never
    // contains one, while a Windows host half starts with a drive letter
    // (`C:\\data:/data`).
    let (host_raw, container_raw) = raw.rsplit_once(':')?;
    let host_raw = host_raw.trim();
    let container_raw = container_raw.trim();
    if host_raw.is_empty() || container_raw.is_empty() {
        return None;
    }
    let host = canonicalize_or_keep(&subst_path(host_raw, home, task_path));
    if host.is_empty() || !std::path::Path::new(&host).is_absolute() {
        return None;
    }
    if !container_raw.starts_with('/') || container_raw.contains("..") || container_raw.contains('\0') {
        return None;
    }
    let container = container_raw.trim_end_matches('/');
    if container.is_empty()
        || UNSAFE_MOUNT_TARGET_ROOTS.iter().any(|root| container == *root || container.starts_with(&format!("{root}/")))
    {
        return None;
    }
    Some((host, container.to_string()))
}

/// `p` with every symlink resolved, also when its tail does not exist yet:
/// Docker creates a missing bind source, so `<link to the data dir>/new`
/// has to resolve through the link. The deepest existing ancestor is
/// canonicalised and the rest appended, `..` popped lexically (nothing
/// below a non-existent component can be a symlink).
fn resolve_host(p: &Path) -> PathBuf {
    use std::path::Component;
    let parts: Vec<Component> = p.components().collect();
    for i in (1..=parts.len()).rev() {
        let head: PathBuf = parts[..i].iter().collect();
        if let Ok(mut out) = dunce::canonicalize(&head) {
            for c in &parts[i..] {
                match c {
                    Component::ParentDir => {
                        out.pop();
                    }
                    Component::Normal(n) => out.push(n),
                    _ => {}
                }
            }
            return out;
        }
    }
    p.to_path_buf()
}

/// Does a mount of `host` hand the container termic's data dir? That dir
/// holds the sync clone, every agent's Docker login (`docker-agents/`), the
/// forge logins and the CLI token, so neither it nor anything inside it is
/// a host side an extra mount may take.
fn host_in_data_dir(host: &Path, data: &Path) -> bool {
    resolve_host(host).starts_with(data)
}

/// The data dir, resolved the way `host_in_data_dir` compares it.
fn data_dir_resolved() -> Option<PathBuf> {
    global_dir().ok().map(|d| resolve_host(&d))
}

/// Save-time half of the data-dir refusal, for every list of extra mounts a
/// user can write (`Task`, `Project`, `Settings` defaults). `~`/`$HOME` are
/// expanded; an entry with `$WORKSPACE` is left to `build_spec`, which
/// knows the task path and skips the mount if it lands in the data dir.
/// Entries that do not parse are not this check's business.
pub fn refuse_data_dir_mounts(mounts: &[String]) -> Result<(), String> {
    let Some(data) = data_dir_resolved() else { return Ok(()) };
    let home = dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    for raw in mounts {
        let Some((host_raw, _)) = raw.trim().rsplit_once(':') else { continue };
        let host_raw = host_raw.trim();
        if host_raw.is_empty() || host_raw.contains("$WORKSPACE") {
            continue;
        }
        let host = subst_path(host_raw, &home, "");
        if Path::new(&host).is_absolute() && host_in_data_dir(Path::new(&host), &data) {
            return Err(format!(
                "\"{raw}\" isn't allowed: the host path is inside Termic's data folder ({}), which holds agent logins, the sync clone and the CLI token.",
                data.display()
            ));
        }
    }
    Ok(())
}

/// Host directory that persists an agent's login + sessions + MCP config
/// ACROSS every Docker task of that agent. The sameness of this path
/// IS the cross-task sharing. termic-owned, never the host's real
/// `~/.claude` (full isolation from the OS agent).
pub fn agent_config_host_dir(agent_id: &str) -> PathBuf {
    // `global_dir()` already respects the dev/prod (`termic_dev`/`termic`)
    // split, so dev and release don't share login state.
    let base = global_dir()
        .map(|d| d.join("docker-agents"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/termic-docker-agents"));
    base.join(agent_id)
}

/// Root of the SHARED config dirs (`Settings.docker_shared_config_dirs`,
/// seeded with gh + glab + az). Sibling of `docker-agents/`, not a child of it:
/// what lives here belongs to the user and is used by whichever agent
/// happens to be running, so it is keyed on nothing. Each entry sits at its
/// mirrored container path underneath (`/root/.config/gh` ->
/// `docker-forge/config/gh`). See `build_spec` step 4b for why the host's
/// real `~/.config/gh` is never the thing that gets mounted, and why this
/// is a list of named dirs rather than all of `/root/.config`.
pub fn forge_config_host_dir() -> PathBuf {
    // Same dev/prod split as `agent_config_host_dir` - a dev build must not
    // pick up (or clobber) the release build's forge login.
    global_dir()
        .map(|d| d.join("docker-forge"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/termic-docker-forge"))
}

/// The shared config dirs a fresh install starts with. gh and glab are the
/// forge CLIs `assets/Dockerfile.default` installs; `.azure` is there for
/// the user who adds `az` via the Dockerfile's editable region (the CLI is
/// a heavyweight Python install, kept out of the shipped image). All three
/// fall back to plaintext credentials inside their own config dir when no
/// OS keyring is reachable, which is the case inside the image (no dbus,
/// no keyring), so a login performed in one container is readable by the
/// next one.
///
/// This is a DEFAULT, not the whole list: `Settings.docker_shared_config_dirs`
/// is what `build_spec` actually reads, and a user can add anything else that
/// should be shared by every agent rather than copied per agent
/// (`.config/nvim`, a cloud CLI's config dir, and so on).
pub fn default_shared_config_dirs() -> Vec<String> {
    vec![".config/gh".to_string(), ".config/glab-cli".to_string(), ".azure".to_string()]
}

/// The config-dir env var for a shared dir, when its CLI has one. Keyed on
/// the dir's BASENAME rather than the full path, so someone who moves gh's
/// config somewhere else in the list still gets `GH_CONFIG_DIR` pointing at
/// wherever they put it. An entry with no known CLI just gets mounted, which
/// is all most tools need (they read `$HOME/.config/<name>` anyway).
fn shared_config_relocation_env(container: &str) -> Option<&'static str> {
    match container.rsplit('/').next()? {
        "gh" => Some("GH_CONFIG_DIR"),
        "glab-cli" => Some("GLAB_CONFIG_DIR"),
        ".azure" => Some("AZURE_CONFIG_DIR"),
        _ => None,
    }
}

// ────────────────────── Host git identity ──────────────────────────────

/// Where the generated identity file lands inside the container, given the
/// XDG root in effect. This is git's XDG global config, and every part of
/// that placement is load-bearing:
///
/// - It is read at the GLOBAL level, so the repo's own `.git/config` (the
///   parent `.git` is mounted, step 2) still outranks it. A repo that
///   deliberately sets its own `user.email` keeps it, per key, exactly as it
///   would on the host.
/// - It does NOT shadow the image's `/root/.gitconfig`, which carries
///   `safe.directory = *` (without which git refuses every command in the
///   bind-mounted worktree as "dubious ownership") and the gh/glab credential
///   helpers. Mounting the host's `~/.gitconfig` over that file, the obvious
///   reading of "give the container my git config", takes out both.
/// - `~/.gitconfig` wins over the XDG file for any key it sets, and it sets
///   no `user.*`, so ours applies.
///
/// The rejected alternative was `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env, which is
/// less code and wrong: env sits ABOVE repo-local, so it silently rewrites the
/// identity of every repo that configures its own. See docs/sandbox.md.
fn git_identity_container_path(xdg_config_home: &str) -> String {
    format!("{}/git/config", xdg_config_home.trim_end_matches('/'))
}

/// The identity the HOST would use for a commit in this directory, resolved
/// through git's full precedence chain rather than read out of `~/.gitconfig`:
/// an `[includeIf "gitdir:~/work/"]` block is how people keep a work identity
/// separate, and only a repo-scoped read sees it. That the read can therefore
/// return a repo-LOCAL value is fine, and inert: the container resolves that
/// same local config itself, from a level that outranks the file we write.
///
/// Absent keys come back `None` (`git config --get` exits non-zero), and a
/// host with no identity at all mounts nothing (except on Windows, where the
/// same file also carries `windows_container_git_config`).
///
/// `fallback` is read instead when `dir` is not a directory, which is not a
/// hypothetical: the SETTINGS-level command preview builds its spec from a
/// sample task whose path is a deliberate placeholder
/// (`sample_preview_task`), and that panel tells the reader "everything else,
/// the mounts, the environment and the hardening flags, is what a real launch
/// uses". Without the fallback this one mount would be the single line
/// missing from it, which is the opposite of what a preview is for. Answering
/// from the home dir is one notch less specific (no repo to resolve
/// `includeIf` or a repo-local override against) and that is exactly right for
/// a preview with no real task in play.
fn read_git_identity(
    dir: &std::path::Path,
    fallback: &std::path::Path,
) -> (Option<String>, Option<String>) {
    let probe = if dir.is_dir() { dir } else { fallback };
    let get = |key: &str| {
        crate::git(&["config", "--get", key], probe)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    (get("user.name"), get("user.email"))
}

/// Render the two-key global config, or `None` when there is no identity to
/// pass on. Values are quoted and escaped rather than interpolated raw: a name
/// containing `"`, `\`, `#`, or a trailing space is legal in git config and
/// would otherwise produce a file that parses as something else. A value
/// carrying a newline cannot be represented on one line at all, so it is
/// dropped rather than allowed to inject a second key.
fn git_identity_config(name: Option<&str>, email: Option<&str>) -> Option<String> {
    let quote = |v: &str| {
        (!v.contains('\n') && !v.contains('\r'))
            .then(|| format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\"")))
    };
    let name = name.and_then(quote);
    let email = email.and_then(quote);
    if name.is_none() && email.is_none() {
        return None;
    }
    let mut s = String::from(
        "# Written by termic from your host git identity, for the Docker sandbox.\n\
         # Global level: this repo's own .git/config still wins if it sets user.*\n\
         [user]\n",
    );
    if let Some(n) = name {
        s.push_str(&format!("\tname = {n}\n"));
    }
    if let Some(e) = email {
        s.push_str(&format!("\temail = {e}\n"));
    }
    Some(s)
}

/// Windows host: the git settings the container needs and cannot get from
/// the host's own config, appended to the same global-level file (so a
/// repo's own `.git/config` still wins, which `GIT_CONFIG_*` env would not
/// allow). `core.autocrlf`: Git for Windows turns it on in its SYSTEM
/// config, which the container never sees, so Linux git would report every
/// CRLF-checked-out file as modified. `gc`: the worktree metadata in
/// `<repo>/.git/worktrees` holds host paths the container cannot resolve,
/// and an automatic `git gc` there runs `worktree prune`, which could drop
/// the host's worktree record.
fn windows_container_git_config(autocrlf: Option<&str>) -> String {
    let mut s = String::from("[gc]\n\tauto = 0\n\tworktreePruneExpire = never\n");
    if let Some(v) = autocrlf.map(str::trim).filter(|v| matches!(*v, "true" | "false" | "input")) {
        s.push_str(&format!("[core]\n\tautocrlf = {v}\n"));
    }
    s
}

/// Stage the file on the host and return its path. One file per TASK, because
/// two tasks can legitimately resolve different identities (that is what
/// `includeIf` is for), and rewritten on every spawn so a changed host
/// identity is picked up by the next container without any cache to bust.
///
/// Written to a temp path and renamed, so a container starting for one tab can
/// never read the half-written file another tab's spawn is producing.
fn stage_git_identity(task_id: &str, contents: &str) -> Option<String> {
    let path = git_identity_path(task_id)?;
    let dir = path.parent()?.to_path_buf();
    std::fs::create_dir_all(&dir).ok()?;
    let stem = path.file_name()?.to_string_lossy().into_owned();
    let tmp = dir.join(format!(".{stem}.tmp"));
    std::fs::write(&tmp, contents).ok()?;
    std::fs::rename(&tmp, &path).ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// Host path of a task's staged identity file. `None` for an id with nothing
/// filename-safe in it, which is also the signal not to stage one at all:
/// task ids are uuids, so this is a guard, not a case that happens.
fn git_identity_path(task_id: &str) -> Option<PathBuf> {
    let stem: String = task_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    (!stem.is_empty()).then(|| docker_dir().join("gitconfig").join(stem))
}

// ──────────────────────────── build_spec ───────────────────────────────

/// Build the full `DockerSpec` for a task agent spawn. `cmd`/`args`
/// are the agent argv (unchanged from the Seatbelt path); `cwd` is the
/// host working dir (mounted + `-w` at the identical absolute path).
pub fn build_spec(
    task: &Task,
    agent_id: &str,
    image: &str,
    cwd: &str,
    extra_args: Vec<String>,
    spawn_env: &std::collections::HashMap<String, String>,
    agent_extra_dirs: &[String],
    agent_persist_enabled: bool,
    // The task's LIVE sandbox allow-list (`live_sandbox_lists` in
    // lib.rs: global Settings defaults + the task's own pinned paths +
    // the project's `.termic.yaml`, re-read fresh on every spawn) - the
    // exact same list Seatbelt's `sandbox::provision` reads. Docker mode
    // used to ignore this entirely, so switching a task from Seatbelt to
    // Docker silently dropped every extra allowed directory. Mounted rw
    // at its own resolved absolute path (same convention as the worktree
    // and composition members). `regex:`-prefixed entries are Seatbelt-
    // only (no literal path to mount) and are skipped.
    allowed_paths: &[String],
    // Task-level extra Docker mounts (`Task.docker_extra_mounts`), each
    // `host_path:container_path` - see that field's doc comment for why
    // these are a dedicated list rather than reusing `allowed_paths`.
    // Mainly for persisting something a fresh container otherwise loses on
    // every restart that `agent_config`'s built-in list doesn't cover (an
    // MCP server's own data dir, say).
    extra_mounts: &[String],
    // The PTY id this spawn is for. A task can host SEVERAL agent tabs
    // (TabBar.spawnTab), and each one gets its own container, so the
    // container's `--name` has to be unique per TAB, not per task. Keyed on
    // task id alone, tab B's spawn collided with tab A's live container on
    // `--name` and the pre-spawn label sweep tore A down mid-session
    // (GH #231). The task label below stays task-scoped on purpose: archive
    // and the Docker toggle DO want to reap every container of one task.
    pty_id: &str,
    // The agent whose config SHAPE applies - see `agent_config`. Equal to
    // `agent_id` for everything except a cloned agent.
    base_id: &str,
    // `Settings.docker_shared_config_dirs`: home-relative (or absolute)
    // container dirs mounted into EVERY container from one shared host dir
    // each, regardless of agent. See step 4b.
    shared_config_dirs: &[String],
    // The account this spawn runs as (GH #278), or `None` for the agent's
    // ordinary login. `Some` adds a segment to the HOST side of the config
    // mount so two accounts of one agent get two directories; `None` leaves
    // the path exactly as it was before accounts existed, which is what stops
    // an existing Docker login being orphaned by shipping this.
    account: Option<&str>,
) -> DockerSpec {
    let mut mounts: Vec<Mount> = Vec::new();

    // 1. The worktree itself, at the SAME absolute path inside the
    //    container (required for the worktree `.git` pointer + session
    //    cwd-key to resolve).
    let task_path = canonicalize_or_keep(&task.path);
    mounts.push(Mount::implicit(
        task_path.clone(),
        in_container(&task_path),
        false,
        "your code (the task)",
        true,
    ));
    // Windows: the worktree's `.git` FILE points at its gitdir with a host
    // path (`gitdir: C:/Users/u/repo/.git/worktrees/x`), which Linux git in
    // the container reads as relative and gives up on. Mount a corrected
    // copy over it, read-only, pointing at the same gitdir's container path.
    // The host file is never touched.
    if cfg!(windows) {
        if let Some(fixed) = container_gitfile(&task_path) {
            mounts.push(Mount::implicit(
                fixed,
                format!("{}/.git", in_container(&task_path)),
                true,
                "git worktree pointer, rewritten for the container's paths",
                true,
            ));
        }
    }

    // 2. Parent `.git` for a worktree (pointer file holds an absolute
    //    path into <parent>/.git/worktrees/<name>). Same-path mount or git
    //    breaks. Reuses the exact Seatbelt logic.
    if let Some(parent_git) = parent_git_dir_for_worktree(&task.path) {
        mounts.push(Mount::implicit(
            parent_git.clone(),
            in_container(&parent_git),
            false,
            "git metadata, required for worktrees to work",
            true,
        ));
    }

    // 3. Composition members (linked repos in a multi-repo task),
    //    each at its identical absolute path.
    for m in &task.composition {
        if m.path.is_empty() {
            continue;
        }
        let p = canonicalize_or_keep(&m.path);
        if p == task_path {
            continue; // host member == task wrapper, already mounted
        }
        mounts.push(Mount::implicit(
            p.clone(),
            in_container(&p),
            false,
            "linked repo in this task",
            true,
        ));
        if let Some(parent_git) = parent_git_dir_for_worktree(&m.path) {
            mounts.push(Mount::implicit(
                parent_git.clone(),
                in_container(&parent_git),
                false,
                "git metadata for a linked repo",
                true,
            ));
        }
    }

    // 3.5. The task's live sandbox allow-list - same source Seatbelt uses
    //    (`live_sandbox_lists`), unified so extra directories configured
    //    per-task, per-project, or via a repo's committed `.termic.yaml`
    //    aren't silently lost when a task runs in Docker instead.
    let home = dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    for raw in allowed_paths {
        let raw = raw.trim();
        // Seatbelt-only: a regex pattern has no literal path to mount.
        if raw.is_empty() || raw.starts_with("regex:") {
            continue;
        }
        let p = canonicalize_or_keep(&subst_path(raw, &home, &task_path));
        if p.is_empty() || mounts.iter().any(|m| m.host == p) {
            continue;
        }
        // Skip what isn't there. Seatbelt tolerates a stale entry in the
        // allow-list (it is just a rule that never matches), so these lists
        // accumulate paths from long-deleted projects - but `docker run -v`
        // does NOT: one missing host path fails the whole run with an opaque
        // daemon error, which would make EVERY Docker task in that config
        // unlaunchable because of a directory nobody has needed for months.
        if !std::path::Path::new(&p).exists() {
            continue;
        }
        mounts.push(Mount::implicit(
            p.clone(),
            in_container(&p),
            false,
            "extra allowed directory (from your sandbox config / .termic.yaml)",
            false,
        ));
    }

    // 3.6. Profile customizations (read-only mount so symlinked skills/personas resolve in container)
    let inherits_customizations = crate::load_projects_all()
        .into_iter()
        .find(|p| p.id == task.project_id)
        .map(|p| crate::effective_customization_mode(&p) == crate::customizations::CustomizationMode::Inherit)
        .unwrap_or(true);

    if inherits_customizations {
        if let Ok(pdir) = crate::profile_dir(&task.profile) {
            let skills_dir = crate::customizations::skills_dir(&pdir);
            if skills_dir.exists() {
                let p = canonicalize_or_keep(&skills_dir.to_string_lossy());
                if !mounts.iter().any(|m| m.host == p) {
                    mounts.push(Mount::implicit(
                        p.clone(),
                        in_container(&p),
                        true,
                        "profile skills",
                        false,
                    ));
                }
            }
            let agents_dir = crate::customizations::agents_dir(&pdir);
            if agents_dir.exists() {
                let p = canonicalize_or_keep(&agents_dir.to_string_lossy());
                if !mounts.iter().any(|m| m.host == p) {
                    mounts.push(Mount::implicit(
                        p.clone(),
                        in_container(&p),
                        true,
                        "profile personas",
                        false,
                    ));
                }
            }
            let mcp_json = crate::customizations::mcp_json_file(&pdir);
            if mcp_json.exists() {
                let p = canonicalize_or_keep(&mcp_json.to_string_lossy());
                if !mounts.iter().any(|m| m.host == p) {
                    mounts.push(Mount::implicit(
                        p.clone(),
                        in_container(&p),
                        true,
                        "profile MCP configuration",
                        false,
                    ));
                }
            }
        }
    }

    // 4. The persistent per-agent config dir (login + sessions + MCP +
    //    customizations), shared across all Docker tasks of this
    //    agent. rw. Plus relocation env if the agent supports it.
    let mut env: Vec<(String, String)> = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        // `render_argv` runs the container as the HOST user's own uid:gid
        // (see its `-u` flag) rather than root, so agents that refuse
        // `--dangerously-skip-permissions` under root (Claude Code) work in
        // Docker mode too. That uid has no matching /etc/passwd entry
        // inside the container, so HOME/USER don't auto-resolve the way
        // they do for root - every agent's config still lives under
        // `/root` (that's what `agent_config`/`agent_config_host_dir`
        // mount into), so HOME is pinned there explicitly rather than
        // moved to a uid-specific home directory.
        ("HOME".to_string(), "/root".to_string()),
        ("USER".to_string(), "agent".to_string()),
    ];
    let mut relocation: Option<(String, String)> = None;
    if let Some(cfg) = agent_config(base_id, agent_extra_dirs, agent_persist_enabled) {
        let host_cfg = match account {
            Some(a) => agent_config_host_dir(agent_id).join(crate::account_slug(a)),
            None => agent_config_host_dir(agent_id),
        }
        .to_string_lossy()
        .into_owned();
        // Create it OURSELVES, as the app user, before it becomes a `-v`
        // source. A missing bind-mount source is created by the daemon
        // instead, and who owns the result is the daemon's business: Docker
        // Desktop on macOS happens to map it to the host user, which is the
        // only reason this ever worked, while a Linux daemon creates it
        // ROOT-owned. The container runs as the host uid (`--user`), so a
        // root-owned config dir means the agent cannot write its own login or
        // transcripts into it - EACCES, and a login that never persists.
        let _ = std::fs::create_dir_all(&host_cfg);
        mounts.push(Mount::implicit(
            host_cfg.clone(),
            cfg.container_dir.clone(),
            false,
            "your Docker agent: login, MCP servers, settings, history (shared across all your Docker tasks)",
            false,
        ));
        // A NAMED account gets its own directory, which means its own
        // credential AND, without this, its own empty everything else: no
        // transcripts, so `--resume` answers "No conversation found"; no
        // settings.json, so no permissions and no termic status line. The host
        // solves that by making the account store a symlink farm back to the
        // primary config dir, but a host symlink is dangling inside a
        // container, so Docker gets the same sharing as MOUNTS instead.
        //
        // Each shared entry is bind-mounted from the PRIMARY Docker config dir
        // over the account dir already mounted above. Nested mounts are the
        // pattern `extra_dirs` below already uses, and the daemon applies them
        // by path depth, so the order here does not matter.
        if account.is_some() {
            let primary = agent_config_host_dir(agent_id);
            for name in crate::agent_dirs::shared_config_entries(base_id) {
                let src = primary.join(name);
                // Only what already EXISTS. A missing source is created by the
                // daemon, root-owned on Linux, and the agent then cannot write
                // its own transcripts into it.
                if !src.exists() {
                    continue;
                }
                mounts.push(Mount::implicit(
                    src.to_string_lossy().into_owned(),
                    format!("{}/{}", cfg.container_dir.trim_end_matches('/'), name),
                    false,
                    "shared with your other Docker accounts for this agent: settings, instructions and conversations",
                    false,
                ));
            }
        }
        for extra in &cfg.extra_dirs {
            // Extra dirs share the same host config dir subtree by name.
            //
            // Strip `/root/` (the container prefix), NOT `/root/.`. With the
            // dot in the pattern, an entry that does not begin with one -
            // `config/mytool`, which `sanitize_extra_dir` accepts - matched
            // nothing, so the "relative" name stayed `/root/config/mytool`,
            // and `Path::join` with an ABSOLUTE argument discards the base:
            // the host side silently became `/root/config/mytool` instead of
            // a path inside termic's own agent folder. On macOS that fails
            // the run outright; on Linux it bind-mounts a root-owned path.
            //
            // The separate leading-dot strip keeps the host layout it has
            // always had (`.antigravity` -> `<agent>/antigravity`), so this
            // fix does not orphan anyone's existing state.
            let sub = PathBuf::from(&host_cfg)
                .join(host_subpath_for(extra))
                .to_string_lossy()
                .into_owned();
            // Same reasoning as the config dir above: ours to create, not
            // the daemon's.
            let _ = std::fs::create_dir_all(&sub);
            mounts.push(Mount::implicit(
                sub,
                extra.clone(),
                false,
                "additional config dir for this agent",
                false,
            ));
        }
        if let Some(var) = cfg.relocation_env {
            env.push((var.to_string(), cfg.container_dir.clone()));
            relocation = Some((var.to_string(), cfg.container_dir.clone()));
        }
    }

    // 4b. SHARED config dirs: mounted into every container, for every agent,
    //    from one host directory each. `Settings.docker_shared_config_dirs`
    //    (Settings → Docker Sandbox → "Shared config dirs") owns the list;
    //    `default_shared_config_dirs` seeds it with `.config/gh`,
    //    `.config/glab-cli`, and `.azure`.
    //
    //    Shared rather than per-agent because the thing being persisted here
    //    belongs to the USER, not to an agent vendor: a GitHub token is the
    //    same token whichever agent pushes with it, and on the host every
    //    agent already reads one `~/.config/gh`. Per-agent copies would mean
    //    logging in again for each agent AND each clone of one, to end up
    //    holding the same credential in five places.
    //
    //    Note what this is NOT: a mount of the whole `/root/.config`. Nesting
    //    would work (Docker orders mounts by depth, so a per-agent
    //    `.config/opencode` still applies underneath a blanket mount), but an
    //    empty dir over the whole tree SHADOWS what the image put there at
    //    build time - `/root/.config/fish/completions/grok.fish` today, and
    //    whatever an unpinned installer drops there next. That is the exact
    //    failure `agent_dirs.rs` documents for grok, and it would also hand
    //    every agent every credential any other agent ever created, which is
    //    the opposite of the per-agent split above. One named dir at a time,
    //    each one a deliberate choice, is the whole point.
    //
    //    The host's real `~/.config/gh` is never what gets mounted, for three
    //    independent reasons: on macOS `gh` keeps the token in the Keychain
    //    (`hosts.yml` holds no `oauth_token` at all), so the mount would hand
    //    the container an unauthenticated gh; a container-side `gh auth
    //    logout` would take out the login `forge.rs` runs termic's own PR
    //    panel on; and Seatbelt hard-denies that same file (`sandbox.rs`), so
    //    mounting it here would make the container the looser of the two
    //    cages. These are termic's own directories, empty until someone logs
    //    in inside a container once.
    for raw in shared_config_dirs {
        // Same validator the per-agent extra dirs use: rejects `..`, `\0`,
        // and any target under a system root an empty mount could shadow.
        let Some(container) = sanitize_extra_dir(raw) else { continue };
        // Set the config-dir env even when the mount below is skipped: the
        // value is the same container path either way, and being explicit
        // survives an agent env block that sets its own XDG_CONFIG_HOME.
        // Pushed HERE, before the per-spawn overlay below, so a user who
        // deliberately sets GH_CONFIG_DIR for an agent still wins.
        if let Some(var) = shared_config_relocation_env(&container) {
            env.push((var.to_string(), container.clone()));
        }
        // A user who already mounted their own copy at this path (a
        // `.config/gh` entry in the agent's extra dirs) keeps it: an explicit
        // per-agent choice outranks this shared default, and two mounts on
        // one container path is not something to resolve by luck.
        if mounts.iter().any(|m| m.container == container) {
            continue;
        }
        // Host layout MIRRORS the container path (`/root/.config/gh` ->
        // `docker-forge/config/gh`), same convention as the per-agent extra
        // dirs, so two entries can never collide on the host side.
        let host = forge_config_host_dir()
            .join(host_subpath_for(&container))
            .to_string_lossy()
            .into_owned();
        // Ours to create, not the daemon's - same reasoning as the agent
        // config dir above (a root-owned dir on a Linux daemon means the
        // container cannot write the login it just performed).
        let _ = std::fs::create_dir_all(&host);
        mounts.push(Mount::implicit(
            host,
            container,
            false,
            "shared config dir (every agent, every task; log in once inside a container and it persists)",
            false,
        ));
    }

    // 4c. Attachments (`crate::attachments_dir`): files staged from a drop
    //    and images pasted into a terminal, mounted READ-ONLY at the
    //    IDENTICAL absolute path, same convention as the worktree.
    //
    //    Both gestures have the same problem: the file the user means lives
    //    somewhere the agent cannot reach. A dropped `~/Desktop/shot.png` is
    //    not mounted here and is hard-denied by Seatbelt, and an image paste
    //    cannot even reach the agent as text - xterm.js sends only bytes it
    //    was given down the PTY, and the agent inside the container is a
    //    Linux process whose own clipboard reader shells out to xclip /
    //    wl-paste with no route to the Mac's pasteboard. So termic copies (or
    //    writes) the file into one place all three cages can read and types
    //    THAT path. Same path on both sides means the frontend does not have
    //    to know which cage a task is in to know what to type.
    //
    //    Read-only: the app is the only writer.
    {
        let attachments = crate::attachments_dir().to_string_lossy().into_owned();
        if !attachments.is_empty() && !mounts.iter().any(|m| m.container == in_container(&attachments)) {
            mounts.push(Mount::implicit(
                attachments.clone(),
                in_container(&attachments),
                true,
                "files you drop or paste into the terminal (read-only)",
                false,
            ));
        }
    }

    // 4d. Your git identity, so a commit made inside the container is
    //    attributed to YOU rather than failing with "Please tell me who you
    //    are". The container has no `~/.gitconfig` of yours: the image bakes
    //    its own (safe.directory + the gh/glab credential helpers) and every
    //    other host dotfile stays on the host, so `user.name`/`user.email`
    //    are simply absent and every agent that tries to commit has to be
    //    told to run `git config` again, in every container, forever.
    //
    //    Mounted READ-ONLY at git's XDG global config path - see
    //    `git_identity_container_path` for why that exact location and not
    //    `/root/.gitconfig`, and why not `GIT_AUTHOR_*` env.
    //
    //    The XDG root follows the agent's own `XDG_CONFIG_HOME` when it sets
    //    one (`spawn_env`, applied below), because git will look wherever
    //    that points and a file at the default path would simply not be read.
    //    Re-asserting our own value instead would break a user who relocated
    //    it deliberately, which is a real thing to do here: opencode's config
    //    dir lives under `/root/.config`.
    let mut no_identity_warning = false;
    {
        let xdg = spawn_env
            .get("XDG_CONFIG_HOME")
            .map(|s| s.trim())
            .filter(|s| s.starts_with('/') && !s.contains(".."))
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{CONTAINER_HOME}/.config"));
        let container = git_identity_container_path(&xdg);
        let already_mounted = mounts.iter().any(|m| m.container == container);
        // `persist_target_allowed` is the same guard every other
        // user-influenced mount target gets: an `XDG_CONFIG_HOME` of `/etc`
        // must not turn into a mount over `/etc/git/config`. Checked BEFORE
        // the read below, so a spawn that will not mount anything does not
        // shell out to git for an answer it cannot use.
        if persist_target_allowed(&container) && !already_mounted {
            let (name, email) = read_git_identity(
                std::path::Path::new(&task_path),
                std::path::Path::new(&home),
            );
            let identity = git_identity_config(name.as_deref(), email.as_deref());
            no_identity_warning = identity.is_none();
            let windows_extra = cfg!(windows).then(|| {
                let autocrlf = crate::git(&["config", "--get", "core.autocrlf"], std::path::Path::new(&task_path)).ok();
                windows_container_git_config(autocrlf.as_deref())
            });
            let contents = match (identity, windows_extra) {
                (Some(i), Some(w)) => Some(format!("{i}{w}")),
                (Some(i), None) => Some(i),
                (None, Some(w)) => Some(format!("# Written by termic for the Docker sandbox.\n{w}")),
                (None, None) => None,
            };
            match contents {
                Some(contents) => {
                    if let Some(host) = stage_git_identity(&task.id, &contents) {
                        mounts.push(Mount::implicit(
                            host,
                            container,
                            true,
                            if cfg!(windows) {
                                "your git identity, plus the line-ending and gc settings a Windows checkout needs in the container"
                            } else {
                                "your git identity (name and email), so commits made in the container are yours"
                            },
                            false,
                        ));
                    }
                }
                // No identity: say so (no_identity_warning, set above) rather
                // than let the agent discover it. This is the one case the
                // feature cannot rescue, and it is silent otherwise: the
                // container simply has no identity, the agent's first commit
                // dies on "Please tell me who you are", and nothing anywhere
                // says termic looked and found none.
                None => {}
            }
        }
    }

    // 5. Task-level extra Docker mounts (Settings → Docker Sandbox has the
    //    per-AGENT equivalent; this is per-TASK, user-chosen host:container
    //    pairs). Runs LAST among the mount steps so it can dedupe against
    //    every mount already staged above, including the agent config dir
    //    step just above - a mount whose CONTAINER path collides with an
    //    already-claimed one is dropped rather than silently shadowing it.
    //    A host side in termic's data dir is dropped here too, not only at
    //    save: a value already on disk, or one with `$WORKSPACE`, never got
    //    the save-time check (`refuse_data_dir_mounts`).
    let data = data_dir_resolved();
    for raw in extra_mounts {
        let Some((host, container)) = sanitize_extra_mount(raw, &home, &task_path) else { continue };
        if data.as_deref().is_some_and(|d| host_in_data_dir(Path::new(&host), d)) {
            continue;
        }
        if mounts.iter().any(|m| m.host == host || m.container == container) {
            continue;
        }
        mounts.push(Mount::implicit(
            host,
            container,
            false,
            "extra mount for this task (persists across container restarts)",
            false,
        ));
    }

    // Per-spawn env overlay: TERMIC_* bookkeeping vars, the extra named
    // ports, and (this is the part that used to be silently dropped) the
    // agent's own configured env block from Settings -> Agents & Terminals
    // (`envForCli`, TerminalPane.tsx). The Seatbelt/unsandboxed spawn path
    // gets this exact same map via `cmd.env`; Docker mode was only ever
    // getting TERM/COLORTERM/relocation_env above, so a user's per-agent
    // env vars silently never reached the container. Appended LAST so it
    // wins on key collision, same precedence as the unsandboxed path -
    // last `-e KEY=VAL` for a given key wins with `docker run`. Deliberately
    // NOT the raw host env (unlike the unsandboxed path): Docker's own
    // isolation model relies on the mounted config dir for credentials
    // instead of inherited secrets, and this keeps that boundary intact.
    for (k, v) in spawn_env {
        env.push((k.clone(), v.clone()));
    }

    // The config-dir relocation var is termic's to set, so it is re-asserted
    // HERE, after the agent's own env block rather than before it.
    //
    // termic mounted that directory; a value pointing anywhere else cannot
    // work, because nothing else is mounted. A `CLAUDE_CONFIG_DIR` naming a
    // path on the Mac is the common case (it is right on the host, and people
    // set it to keep a cloned agent's login separate) and inside the container
    // it names a path that does not exist, whose parent is root-owned - so the
    // agent cannot even create it. The symptom is a login that reports success
    // and is gone a second later, plus "Transcript writes are failing
    // (permission denied - EACCES)", with the mounted directory sitting empty.
    //
    // A value that IS covered by a mount is left alone: that user arranged
    // somewhere real for it to go, and knows something we do not.
    let mut warnings: Vec<String> = Vec::new();
    if no_identity_warning {
        warnings.push(
            "No git identity found on this machine, so a commit made inside the container will fail with \"Please tell me who you are\". Set one with: git config --global user.name \"Your Name\" and git config --global user.email \"you@example.com\"."
                .to_string(),
        );
    }
    if let Some((var, want)) = relocation.clone() {
        if let Some(pos) = env.iter().rposition(|(k, _)| *k == var) {
            let have = env[pos].1.clone();
            let mounted = mounts.iter().any(|m| have == m.container
                || have.starts_with(&format!("{}/", m.container)));
            if have != want && !mounted {
                warnings.push(format!(
                    "{var} was set to {have}, which is not mounted in the container.                      Using {want} instead, which is where termic mounts this agent's                      config. Set it in the agent's Docker environment if you need a                      different path, and add a mount for it."
                ));
                env.push((var, want));
            }
        }
    }

    // Agent-hook wiring, termic's to set and re-asserted last so a user's own
    // Docker env block cannot shadow it.
    //
    // `cmd.env(...)` on the spawn sets the HOST process's environment, which
    // for a Docker task is the `docker run` CLI, not the container. Docker
    // forwards nothing, so both of the hook script's gates failed inside the
    // cage and every hook exited on its first line:
    //
    //     [ -n "$TERMIC_PTY" ] || exit 0
    //
    // That is why a sandboxed tab delivered ZERO hook OSCs while its
    // unsandboxed neighbours on the same agent delivered hundreds. Not the
    // transport, not the install, not permissions: the variables simply were
    // not there.
    //
    // TERMIC_PTY is the CONTAINER's address for the same terminal, not the
    // host path, which names a device the container has no entry for.
    // `/proc/1/fd/1` is the main process's stdout, which docker relays to the
    // pty termic is reading under `run -i -t`, and it needs no controlling
    // terminal (hooks have none). Measured in the real sandbox image.
    env.push(("TERMIC_PTY".to_string(), "/proc/1/fd/1".to_string()));
    env.push(("TERMIC_TASK_ID".to_string(), task.id.clone()));

    DockerSpec {
        warnings,
        // task id keeps the name recognisable in `docker ps`; the pty id
        // makes it unique per tab. Both are uuids, so the result is always
        // a legal container name.
        container_name: format!("termic-{}-{}", task.id, short_id(pty_id)),
        label: format!("{LABEL_KEY}={}", task.id),
        image: image.to_string(),
        mounts,
        workdir: in_container(&canonicalize_or_keep(cwd)),
        env,
        extra_args,
    }
}

/// Flag prefixes that would let a task's own `docker_extra_args` widen or
/// disable the cage the container is supposed to provide (root-equivalent
/// capabilities, host networking/PID/IPC namespaces, arbitrary extra bind
/// mounts, or swapping the entrypoint/user). Checked case-insensitively
/// against each argument on its own — these are argv elements, not a shell
/// string, so there's no injection risk, just a policy gate on which
/// `docker run` flags a task is allowed to add for itself.
const UNSAFE_EXTRA_ARG_PREFIXES: &[&str] = &[
    "--privileged",
    "--cap-add",
    "--network",
    "--net",
    "--pid",
    "--ipc",
    "--uts",
    "--userns",
    "--security-opt",
    "--device",
    "--volume",
    "-v",
    "--mount",
    "--entrypoint",
    "--user",
    "-u",
    "--cap-drop",
    "--pids-limit",
    // Siblings of flags already listed, and just as capable of widening the
    // boundary: `--volumes-from` mounts another container's volumes wholesale
    // (the `-v`/`--mount` hole through a different door), and
    // `--device-cgroup-rule` grants device access the way `--device` does.
    "--volumes-from",
    "--device-cgroup-rule",
];

/// Reject any `docker_extra_args` entry that could weaken the container
/// boundary `render_argv` builds. Returns the offending argument in the
/// error so the caller (`task_set_docker`) can surface it to the user.
pub fn validate_extra_args(args: &[String]) -> Result<(), String> {
    for a in args {
        let lower = a.to_ascii_lowercase();
        let flag = lower.split('=').next().unwrap_or(&lower);
        if UNSAFE_EXTRA_ARG_PREFIXES.iter().any(|p| flag == *p) {
            return Err(format!(
                "\"{a}\" isn't allowed in Docker extra args: it can widen or disable the container's isolation boundary."
            ));
        }
    }
    Ok(())
}

/// Command-level syntax check for `Task.docker_extra_mounts` entries, run at
/// save time (`task_set_docker`) so a malformed entry surfaces as an error to
/// the user instead of being silently dropped at spawn time the way
/// `sanitize_extra_mount` drops bad entries. Checks the same shape rules
/// `sanitize_extra_mount` enforces on the container half. The host half is
/// only checked for termic's data dir (`refuse_data_dir_mounts`): anything
/// else about it depends on the task path it is later resolved against.
pub fn validate_extra_mounts(mounts: &[String]) -> Result<(), String> {
    for raw in mounts {
        let raw_t = raw.trim();
        let Some((host_raw, container_raw)) = raw_t.rsplit_once(':') else {
            return Err(format!("\"{raw}\" isn't a valid mount: expected host_path:container_path."));
        };
        let host_raw = host_raw.trim();
        let container_raw = container_raw.trim();
        if host_raw.is_empty() || container_raw.is_empty() {
            return Err(format!("\"{raw}\" isn't a valid mount: both the host and container path are required."));
        }
        if !container_raw.starts_with('/') || container_raw.contains("..") || container_raw.contains('\0') {
            return Err(format!("\"{raw}\" isn't a valid mount: the container path must be an absolute path with no \"..\"."));
        }
        let container = container_raw.trim_end_matches('/');
        if container.is_empty()
            || UNSAFE_MOUNT_TARGET_ROOTS.iter().any(|root| container == *root || container.starts_with(&format!("{root}/")))
        {
            return Err(format!(
                "\"{raw}\" isn't allowed: {container} is reserved for the container's own config/system files."
            ));
        }
    }
    refuse_data_dir_mounts(mounts)
}

/// The `docker run --user` value: the HOST process's own uid:gid, so the
/// container's file access matches the host user that already owns every
/// bind-mounted path (worktree, agent config dir). `getuid`/`getgid` are
/// unix-only in `libc` (Windows has no uid concept); Docker sandbox mode is
/// currently exercised on macOS/Linux hosts only, so a Windows build falls
/// back to `0:0` (root) rather than failing to compile - this flag has no
/// meaning there yet.
#[cfg(unix)]
fn host_uid_gid() -> String {
    format!("{}:{}", unsafe { libc::getuid() }, unsafe { libc::getgid() })
}

/// Windows has no uid to mirror. Root would be the obvious stand-in, but
/// Claude Code refuses `--dangerously-skip-permissions` as root, and Docker
/// tasks run agents in exactly that mode (the container is the boundary),
/// so every Claude launch would fail. A fixed non-root id instead: the
/// image makes `/root` world-writable (Dockerfile.default) so any uid can
/// use it, and Docker Desktop's Windows bind mounts do not enforce
/// ownership.
#[cfg(not(unix))]
fn host_uid_gid() -> String {
    "1000:1000".to_string()
}

// ──────────────────────────── render_argv ──────────────────────────────

/// Render the spec to the exact argv we spawn. THE single source of truth:
/// the UI preview is just this output pretty-printed (see `render_preview`).
/// Spawned argv == previewed argv, always.
pub fn render_argv(spec: &DockerSpec, cmd: &str, args: &[String]) -> Vec<String> {
    let mut argv: Vec<String> = vec![
        "run".into(),
        "--rm".into(),
        "-i".into(),
        "-t".into(),
        "--name".into(),
        spec.container_name.clone(),
        "--label".into(),
        spec.label.clone(),
    ];
    for m in &spec.mounts {
        argv.push("-v".into());
        let suffix = if m.read_only { ":ro" } else { "" };
        argv.push(format!("{}:{}{}", m.host, m.container, suffix));
    }
    argv.push("-w".into());
    argv.push(spec.workdir.clone());
    for (k, v) in &spec.env {
        argv.push("-e".into());
        argv.push(format!("{k}={v}"));
    }
    // Harden the container itself: no Linux capabilities beyond the
    // agent's baseline needs, no privilege escalation via setuid
    // binaries, and a cap on forkbomb-style PID exhaustion. This is
    // orthogonal to the (currently unrestricted) network egress — see
    // the "Known gap" callout in docs/sandbox.md — but it meaningfully
    // narrows what a container-escape exploit can reach even so.
    argv.push("--cap-drop".into());
    argv.push("ALL".into());
    argv.push("--security-opt".into());
    argv.push("no-new-privileges:true".into());
    argv.push("--pids-limit".into());
    argv.push("512".into());
    // Run as the HOST user's own uid:gid, not root. Two reasons: (1) Claude
    // Code (and presumably others) refuse `--dangerously-skip-permissions`
    // under root, which broke every YOLO-auto-on Docker task; (2) the
    // worktree/git-metadata/agent-config-dir mounts are all bind-mounted
    // from paths this same host user already owns, so matching uid:gid
    // exactly means the container sees the identical ownership/permissions
    // the host process already has - no chown, no `--user`-vs-bind-mount
    // guessing. `Dockerfile.default` world-permissions `/root` (where every
    // agent's config/binaries live, `HOME` above) at build time so an
    // arbitrary runtime uid with no matching `/etc/passwd` entry can still
    // read/write it. `-u`/`--user` is in `UNSAFE_EXTRA_ARG_PREFIXES` so a
    // task can never override this from `docker_extra_args`.
    argv.push("--user".into());
    argv.push(host_uid_gid());
    argv.extend(spec.extra_args.iter().cloned());
    argv.push(spec.image.clone());
    argv.push(cmd.to_string());
    argv.extend(args.iter().cloned());
    argv
}

// ─────────────────────── Dockerfile storage ────────────────────────────

/// Directory holding the editable Dockerfile + build metadata.
fn docker_dir() -> PathBuf {
    global_dir()
        .map(|d| d.join("docker"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/termic-docker"))
}

/// Path to the user-editable Dockerfile (one generic file, all agents).
pub fn dockerfile_path() -> PathBuf {
    docker_dir().join("Dockerfile")
}

/// The shipped default Dockerfile (validated: builds + runs all agents).
/// Ship this as reset-to-default; the commented regions are the user's
/// customization surface.
pub const DEFAULT_DOCKERFILE: &str = include_str!("../assets/Dockerfile.default");

/// Which shipped default the saved Dockerfile was written FROM.
///
/// This file is the whole point of the mechanism. "Has the user customised
/// their Dockerfile" used to be answered by comparing their file to the
/// CURRENT default, which is a different question and gives the wrong answer
/// every time termic ships a new one: adding an agent to `Dockerfile.default`
/// instantly reported every untouched Dockerfile as customised, and the only
/// way out offered was "Reset to default" - which is exactly what someone who
/// HAD customised it must not click. Reported after Muse Code was added.
///
/// So provenance is stored rather than inferred. The file holds a generation
/// number and the default it came from; a saved Dockerfile still equal to its
/// recorded origin was never edited, whatever the current default says, and
/// can be upgraded in place.
fn dockerfile_origin_path() -> PathBuf {
    docker_dir().join("Dockerfile.origin")
}

/// Bump to force EVERY saved Dockerfile back to the shipped default on the
/// next launch, user edits included.
///
/// A blunt instrument, and deliberately: it exists for the release where the
/// shipped file changes in a way an old one cannot be left behind on (a broken
/// base image, a security fix, an agent install that must be present). It is
/// NOT how ordinary updates flow - those reach an unedited file through
/// `read_dockerfile` without touching a customised one.
///
/// Generation 1 is the introduction of this mechanism itself: every profile
/// predating it has an unknown origin, so there is no way to tell an edited
/// file from one merely written by an older termic, and the maintainer asked
/// for one clean sweep to a known-good state.
const DOCKERFILE_GENERATION: u32 = 1;

#[derive(Serialize, Deserialize, Default)]
struct DockerfileOrigin {
    /// `DOCKERFILE_GENERATION` at the time this file was written.
    generation: u32,
    /// The shipped default this Dockerfile was created from, verbatim. Stored
    /// whole rather than hashed so a future termic can DIFF against it and
    /// show the user what they changed.
    default_text: String,
}

fn read_origin() -> Option<DockerfileOrigin> {
    let raw = std::fs::read_to_string(dockerfile_origin_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_origin(default_text: &str) {
    let o = DockerfileOrigin {
        generation: DOCKERFILE_GENERATION,
        default_text: default_text.to_string(),
    };
    if let Ok(j) = serde_json::to_string_pretty(&o) {
        let _ = std::fs::create_dir_all(docker_dir());
        let _ = std::fs::write(dockerfile_origin_path(), j);
    }
}

/// True when the saved Dockerfile is the user's own work rather than a shipped
/// one. See `dockerfile_origin_path`.
pub fn dockerfile_is_customised() -> bool {
    let Ok(saved) = std::fs::read_to_string(dockerfile_path()) else { return false };
    match read_origin() {
        // Unedited iff it still matches the default it was created from.
        Some(o) => saved != o.default_text,
        // No provenance: a profile from before this existed. Fall back to the
        // old comparison, which is right for anyone who never edited theirs
        // and wrong only until the next generation sweep resets it anyway.
        None => saved != DEFAULT_DOCKERFILE,
    }
}

/// Read the current Dockerfile, falling back to (and persisting) the
/// shipped default on first run / missing file.
///
/// Also where an unedited Dockerfile picks up a NEW shipped default. Doing it
/// on read rather than in a migration keeps one code path: whoever asks for the
/// Dockerfile gets the current one, and a customised file is never touched.
pub fn read_dockerfile() -> String {
    let path = dockerfile_path();
    let saved = match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => s,
        _ => {
            let _ = write_dockerfile(DEFAULT_DOCKERFILE);
            return DEFAULT_DOCKERFILE.to_string();
        }
    };
    if saved == DEFAULT_DOCKERFILE {
        // Already current. Record provenance if this profile predates it, so
        // the next shipped default can flow in without a forced sweep.
        if read_origin().is_none() {
            write_origin(DEFAULT_DOCKERFILE);
        }
        return saved;
    }
    let origin = read_origin();
    let forced = origin.as_ref().map(|o| o.generation < DOCKERFILE_GENERATION).unwrap_or(true);
    let unedited = origin.as_ref().is_some_and(|o| saved == o.default_text);
    if forced || unedited {
        let _ = write_dockerfile(DEFAULT_DOCKERFILE);
        return DEFAULT_DOCKERFILE.to_string();
    }
    saved
}

/// Persist an edited Dockerfile.
///
/// Writing the shipped default (which is what "Reset to default" does) also
/// re-records provenance, so a reset returns the file to "not customised"
/// rather than leaving it permanently flagged.
pub fn write_dockerfile(contents: &str) -> Result<(), String> {
    let dir = docker_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("Dockerfile"), contents).map_err(|e| e.to_string())?;
    if contents == DEFAULT_DOCKERFILE {
        write_origin(DEFAULT_DOCKERFILE);
    }
    Ok(())
}

// ──────────────────────────── Image build ──────────────────────────────

/// Helper to construct a `Command` targeting the `docker` binary, configured
/// with the login-shell-resolved PATH and any `DOCKER_*` environment variables.
///
/// On macOS, GUI apps inherit a bare `/usr/bin:/bin:/usr/sbin:/sbin` PATH from
/// launchd, which misses `/usr/local/bin`, `/opt/homebrew/bin`, `~/.docker/bin`,
/// OrbStack, and custom DOCKER_HOST / DOCKER_CONTEXT settings in shell profiles.
pub fn docker_cmd() -> Command {
    let mut cmd = crate::proc_ctl::command("docker");
    let (path, inject) = crate::shell_env::spawn_env();
    cmd.env("PATH", path);
    for (k, v) in inject {
        if k.starts_with("DOCKER_") || k == "COLIMA_PROFILE" {
            cmd.env(k, v);
        }
    }
    cmd
}

/// Construct the `docker build` Command + the tag it will produce, writing
/// the Dockerfile to disk first. The caller drives execution (the command
/// layer streams its output line-by-line off a background thread; never on
/// the synchronous Tauri path). `no_cache` => `--no-cache --pull`.
/// The build arg the shipped Dockerfile declares just above its agent
/// installs. Passing a fresh value invalidates from that line down.
pub const AGENT_REFRESH_ARG: &str = "TERMIC_AGENT_REFRESH";

pub fn build_command(dockerfile: &str, no_cache: bool) -> Result<(Command, String), String> {
    let tag = image_tag(dockerfile);
    let dir = docker_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let df_path = dir.join("Dockerfile");
    std::fs::write(&df_path, dockerfile).map_err(|e| e.to_string())?;

    let mut cmd = docker_cmd();
    // --progress=plain so the streamed log is line-based (not a TTY redraw).
    cmd.args(["build", "--progress=plain", "-t", &tag, "-f"]);
    cmd.arg(&df_path);
    if no_cache {
        // "Update agents" only needs the AGENT layers re-run. Docker
        // invalidates a layer and everything after it, so `--no-cache` also
        // re-pulls the base image and re-runs the apt install - minutes of
        // work that almost never changed. When the Dockerfile declares the
        // refresh arg, bump it instead: the agent installs re-run (they are
        // unpinned, which is the whole reason this action exists) and the
        // expensive layers above stay cached.
        //
        // A Dockerfile that does NOT declare it falls back to `--no-cache`,
        // because the arg would be silently unconsumed - docker only warns -
        // and the user would get a fully cached build that updates nothing.
        // That covers anyone whose saved Dockerfile predates this.
        if dockerfile.contains(AGENT_REFRESH_ARG) {
            cmd.arg("--build-arg");
            cmd.arg(format!("{AGENT_REFRESH_ARG}={}", refresh_token()));
        } else {
            cmd.args(["--no-cache", "--pull"]);
        }
    }
    // Build context is the docker dir (lets users `COPY` baked skills etc.
    // from a path they control next to the Dockerfile).
    cmd.arg(&dir);
    Ok((cmd, tag))
}

/// A value that differs from the last one, so the layer below the arg is
/// invalidated. Seconds since the epoch: monotonic in practice and readable
/// in `docker history`, which beats a random number when someone is trying to
/// work out why a layer rebuilt.
fn refresh_token() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ─────────────────────── Image tag + availability ──────────────────────

/// Content-addressed image tag: `termic-sandbox:{hash}`. Editing the
/// Dockerfile changes the hash, so a stale build no longer matches —
/// surfaced as a "rebuild to apply" warning in Settings. DefaultHasher is
/// fixed-seed (stable across runs); a non-crypto hash is sufficient for
/// cache-keying (we only need "did the Dockerfile change?").
pub fn image_tag(dockerfile: &str) -> String {
    let mut h = DefaultHasher::new();
    dockerfile.hash(&mut h);
    format!("{IMAGE_REPO}:{:016x}", h.finish())
}

/// Result of `docker_check`: is the binary present, is the daemon up?
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct DockerStatus {
    /// `docker` binary resolvable on PATH.
    pub binary: bool,
    /// `docker info` succeeds (daemon reachable).
    pub daemon: bool,
    /// `docker --version` string, when available.
    pub version: Option<String>,
}

/// Probe for the `docker` binary + a running daemon. Cheap; no build.
pub fn check() -> DockerStatus {
    let version = docker_cmd()
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let binary = version.is_some();
    // Ready means a daemon that runs LINUX containers. Docker Desktop on
    // Windows can be switched to Windows containers, where `docker info`
    // still succeeds and then `FROM node:lts-bookworm` fails at build time
    // with an error that names neither mode. Everywhere else OSType is
    // always linux.
    let daemon = binary
        && docker_cmd()
            .args(["info", "--format", "{{.OSType}}"])
            .output()
            .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "linux")
            .unwrap_or(false);
    DockerStatus { binary, daemon, version }
}

/// Does an image with this tag already exist locally? (Drives dropdown
/// availability + the "not built / rebuild" Settings state.)
pub fn image_exists(tag: &str) -> bool {
    docker_cmd()
        .args(["image", "inspect", tag])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// File recording the tag of the last successful build. Lets us keep the
/// last-built image available in the dropdown even after the Dockerfile is
/// edited (the edit only takes effect on the next build).
fn last_built_file() -> PathBuf {
    docker_dir().join("last_built_tag")
}

/// File recording the LOCAL calendar date of the last successful build
/// (`YYYY-MM-DD`), independent of which tag it was. Drives the daily-rebuild
/// nudge: an agent CLI publishes new releases continuously, so an image
/// built yesterday can already be running a stale binary even though its
/// Dockerfile (and therefore its content-addressed tag) hasn't changed.
fn last_built_date_file() -> PathBuf {
    docker_dir().join("last_built_date")
}

/// Record a successfully built tag, and today's date as the build date.
pub fn record_built_tag(tag: &str) {
    let _ = std::fs::create_dir_all(docker_dir());
    let _ = std::fs::write(last_built_file(), tag);
    let _ = std::fs::write(last_built_date_file(), chrono::Local::now().date_naive().to_string());
}

/// The tag of the last successful build, if any.
pub fn last_built_tag() -> Option<String> {
    std::fs::read_to_string(last_built_file())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Parse a recorded build-date string (`YYYY-MM-DD`, possibly with
/// trailing whitespace from the file write). Split out from `last_built_date`
/// so the format is unit-testable without touching the filesystem.
fn parse_build_date(s: &str) -> Option<chrono::NaiveDate> {
    chrono::NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()
}

/// LOCAL calendar date (`YYYY-MM-DD`) any image was last successfully
/// built, if ever / parsable. Whether that counts as "due for a rebuild"
/// is a policy call (depends on `Settings.docker_rebuild_frequency`, which
/// this module knows nothing about) - left to the frontend, which prompts
/// the user rather than silently rebuilding. `None` covers both "never
/// built" (which `spawn_image_tag`'s own refusal already handles) and
/// "recorded but unparsable" (a version upgrade edge case, not a normal
/// path) identically - the caller should treat either as "definitely due".
pub fn last_built_date() -> Option<String> {
    std::fs::read_to_string(last_built_date_file())
        .ok()
        .and_then(|s| parse_build_date(&s))
        .map(|d| d.to_string())
}

/// Image state for the Settings Docker section + dropdown gating.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct DockerImageStatus {
    /// Content tag of the CURRENT (possibly-edited) Dockerfile.
    pub current_tag: String,
    /// Is the current Dockerfile's image built?
    pub current_built: bool,
    /// Tag of the last successful build (may differ from current_tag).
    pub last_built_tag: Option<String>,
    /// Does the last-built image still exist locally?
    pub last_built_exists: bool,
    /// Dockerfile edited since the last successful build (built image is
    /// stale). Drives the "rebuild to apply" warning in Settings.
    pub stale: bool,
    /// Is the current Dockerfile byte-identical to the shipped default?
    pub is_default: bool,
    /// Whether Docker mode should be offered in the task dropdown at
    /// all (a usable built image exists).
    pub available: bool,
    /// LOCAL calendar date (`YYYY-MM-DD`) of the last successful build, if
    /// any. Drives the rebuild-frequency nudge before an agent launch - see
    /// `Settings::docker_rebuild_frequency`.
    pub last_built_date: Option<String>,
}

/// Compute the current image status from the on-disk Dockerfile + docker.
pub fn image_status() -> DockerImageStatus {
    let dockerfile = read_dockerfile();
    let current_tag = image_tag(&dockerfile);
    let current_built = image_exists(&current_tag);
    let last = last_built_tag();
    let last_built_exists = last.as_deref().map(image_exists).unwrap_or(false);
    let stale = match &last {
        Some(t) => last_built_exists && *t != current_tag,
        None => false,
    };
    DockerImageStatus {
        current_tag,
        current_built,
        // Provenance, not a comparison against the CURRENT default: a new
        // shipped Dockerfile must not report every untouched one as edited.
        is_default: !dockerfile_is_customised(),
        // Dropdown availability: any usable built image (current OR the
        // last-built one we keep around after an edit).
        available: current_built || last_built_exists,
        last_built_tag: last,
        last_built_exists,
        stale,
        last_built_date: last_built_date(),
    }
}

/// The tag a spawn should actually run: prefer the current Dockerfile's
/// image; fall back to the last-built image (kept available after an edit).
/// `None` => nothing usable is built; the spawn must refuse.
pub fn spawn_image_tag() -> Option<String> {
    let dockerfile = read_dockerfile();
    let current = image_tag(&dockerfile);
    if image_exists(&current) {
        return Some(current);
    }
    last_built_tag().filter(|t| image_exists(t))
}

// ──────────────────────────── Cleanup ──────────────────────────────────

/// `docker rm -f` every container labeled for this task. Non-fatal.
pub fn cleanup_task(task_id: &str) {
    rm_by_filter(&format!("label={LABEL_KEY}={task_id}"));
    // The staged git identity file is per-task (step 4d in `build_spec`), so
    // an archived task's copy is dead weight. Regenerated on the next spawn
    // if the task comes back, so deleting it early costs nothing.
    if let Some(path) = git_identity_path(task_id) {
        let _ = std::fs::remove_file(path);
    }
}

/// First 8 chars of an id, for a readable-but-unique container name.
/// Falls back to the whole string when it is shorter than that.
fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

/// `docker rm -f` ONE container by name. Used when a PTY goes away: the
/// container is named per-PTY, so this cannot touch a sibling tab's.
///
/// Necessary because killing the PTY only kills the local `docker run`
/// CLIENT: it is attached in the foreground with no `-d`, so the container
/// keeps running server-side, and `--rm` only fires on the container's own
/// clean exit. Without this, closing a tab leaked its container - and since
/// every container of one agent mounts the SAME config dir, the leaked ones
/// keep running an agent that fights the live one over anything singleton in
/// there (Claude Code's Remote Control session, for instance, which reports
/// "another connection took over" and disconnects).
///
/// Off-thread at every call site: it shells out to the daemon.
pub fn rm_container(name: &str) {
    let _ = docker_cmd().args(["rm", "-f", name]).output();
}

/// `docker rm -f` every termic-labeled container (app quit). Non-fatal.
pub fn cleanup_all() {
    rm_by_filter(&format!("label={LABEL_KEY}"));
}

fn rm_by_filter(filter: &str) {
    let ids = docker_cmd()
        .args(["ps", "-aq", "--filter", filter])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    for id in ids.lines().filter(|l| !l.trim().is_empty()) {
        let _ = docker_cmd().args(["rm", "-f", id]).output();
    }
}

// ────────────────────── Activity monitor integration ──────────────────────
//
// The host pid tree procmon.rs walks is close to meaningless for a
// Docker-sandboxed agent: the pid it finds is the `docker run` client, which
// sits nearly idle no matter how busy the agent is, because the real work
// happens inside the daemon's VM, a process table the host cannot see into.
// So `merge_stats` runs AFTER a normal sample, replacing every row whose
// root carried a `docker_container` name with numbers from `docker stats`
// instead — one batched invocation for however many Docker tasks are live,
// not one per row.

use crate::procmon::{ProcRow, Snapshot};
use parking_lot::Mutex;
use std::collections::HashMap;

/// One container's live usage, as `docker stats --no-stream` reports it.
#[derive(Clone, Debug, PartialEq)]
struct ContainerStats {
    cpu_pct: f64,
    mem_bytes: u64,
    pids: u32,
}

/// cpu_pct history per row key, kept here because by the time `merge_stats`
/// sees a snapshot, procmon.rs's own sampler already built (and baked into
/// the row) a history using the wrong host-based numbers — this is the only
/// place that ever computes the right ones. Mirrors procmon.rs's `hist` but
/// scoped to Docker rows only. Cleared by `reset_history`, which lib.rs
/// calls alongside every `procmon::start`/`stop`/`stop_all`, so it costs
/// nothing while the Activity window is closed (same rule procmon.rs's
/// module doc holds itself to).
static HISTORY: std::sync::LazyLock<Mutex<HashMap<String, Vec<f64>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// Matches procmon.rs's own `HISTORY_LEN`; the sparklines are drawn from the
/// same session length regardless of which rows are Docker rows.
const HISTORY_LEN: usize = 90;

/// Forget every row's sparkline history. Call whenever a procmon session
/// starts or ends, so a closed-then-reopened Activity window (or a
/// long-since-exited Docker task) cannot leave rows behind forever.
pub fn reset_history() {
    HISTORY.lock().clear();
}

/// Overwrite every Docker row in `snap` with a fresh `docker stats` query.
/// `containers` maps a `Snapshot` row's `key` to its container `--name`,
/// built by lib.rs from the same `PtySlot`s the row itself came from.
/// Rows with no entry in `containers` (every non-Docker row) pass through
/// untouched. Blocking (shells out to `docker`) — callers MUST run this off
/// the IPC thread, same discipline as any other Docker command.
pub fn merge_stats(mut snap: Snapshot, containers: &HashMap<String, String>) -> Snapshot {
    if containers.is_empty() {
        return snap;
    }
    let names: Vec<String> = containers.values().cloned().collect();
    let stats = query_stats(&names);
    let mut hist = HISTORY.lock();
    for row in &mut snap.rows {
        let Some(name) = containers.get(&row.key) else { continue };
        apply(row, stats.get(name), &mut hist, HISTORY_LEN);
    }
    // Drop history for rows this snapshot no longer carries (task closed,
    // agent exited) — otherwise a long session accumulates one entry per
    // Docker PTY that ever existed.
    let live: std::collections::HashSet<&String> = containers.keys().collect();
    hist.retain(|k, _| live.contains(k));
    snap
}

fn apply(
    row: &mut ProcRow,
    stats: Option<&ContainerStats>,
    hist: &mut HashMap<String, Vec<f64>>,
    cap: usize,
) {
    row.is_docker = true;
    // A container's real process tree lives in the daemon's VM; the host
    // children we sampled are just the `docker` CLI itself, so showing them
    // would read as "the agent spawned nothing" every time.
    row.children.clear();
    let Some(s) = stats else {
        // Transient miss (container starting up, or `docker stats` failed) —
        // keep last known numbers rather than flashing the row to zero.
        return;
    };
    row.cpu_pct = Some(s.cpu_pct);
    row.mem_bytes = s.mem_bytes;
    row.rss_bytes = s.mem_bytes;
    row.proc_count = s.pids;
    row.alive = true;
    let h = hist.entry(row.key.clone()).or_default();
    h.push(s.cpu_pct);
    if h.len() > cap {
        let drop = h.len() - cap;
        h.drain(0..drop);
    }
    row.cpu_history = h.clone();
}

/// One `docker stats` invocation for every named container. Missing/gone
/// containers are silently absent from the result — an agent that exited
/// between the PTY snapshot and this call is not an error for the others.
fn query_stats(names: &[String]) -> HashMap<String, ContainerStats> {
    if names.is_empty() {
        return HashMap::new();
    }
    let out = docker_cmd()
        .arg("stats")
        .arg("--no-stream")
        .arg("--format")
        .arg("{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}")
        .args(names)
        .output();
    let Ok(out) = out else { return HashMap::new() };
    if !out.status.success() {
        return HashMap::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_stats_line)
        .collect()
}

fn parse_stats_line(line: &str) -> Option<(String, ContainerStats)> {
    let mut cols = line.split('\t');
    let name = cols.next()?.trim().to_string();
    let cpu_pct = cols.next()?.trim().trim_end_matches('%').parse::<f64>().ok()?;
    let mem_bytes = parse_mem_usage(cols.next()?.trim())?;
    let pids = cols.next()?.trim().parse::<u32>().unwrap_or(0);
    Some((name, ContainerStats { cpu_pct, mem_bytes, pids }))
}

/// `docker stats`' MemUsage column reads like "12.3MiB / 1.943GiB" — the
/// used half, before the slash, is what we want; the limit half is dropped
/// since the row already has its own "of what" context in the UI.
fn parse_mem_usage(s: &str) -> Option<u64> {
    parse_byte_size(s.split('/').next()?.trim())
}

fn parse_byte_size(s: &str) -> Option<u64> {
    let split = s.find(|c: char| !c.is_ascii_digit() && c != '.')?;
    let (num, unit) = s.split_at(split);
    let n: f64 = num.parse().ok()?;
    let mult = match unit.trim() {
        "B" => 1.0,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" => 1024.0_f64.powi(4),
        "KB" => 1_000.0,
        "MB" => 1_000_000.0,
        "GB" => 1_000_000_000.0,
        "TB" => 1_000_000_000_000.0,
        _ => return None,
    };
    Some((n * mult) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extra_args_rejects_cage_widening_flags() {
        for bad in [
            "--privileged",
            "--cap-add=ALL",
            "--network=host",
            "--net=host",
            "--pid=host",
            "-v",
            "--volume",
            "--mount",
            "--entrypoint",
            "--user=root",
            "-u",
        ] {
            let err = validate_extra_args(&[bad.to_string()]);
            assert!(err.is_err(), "expected {bad:?} to be rejected");
        }
    }

    #[test]
    fn extra_args_rejects_case_insensitively() {
        assert!(validate_extra_args(&["--Privileged".to_string()]).is_err());
    }

    #[test]
    fn extra_args_allows_benign_flags() {
        for ok in ["--memory", "4g", "--cpus=2", "--label=foo=bar"] {
            assert!(validate_extra_args(&[ok.to_string()]).is_ok(), "expected {ok:?} to be allowed");
        }
    }

    #[test]
    fn extra_args_checks_every_element() {
        let args = vec!["--memory".to_string(), "4g".to_string(), "--privileged".to_string()];
        assert!(validate_extra_args(&args).is_err());
    }

    #[test]
    fn parse_build_date_accepts_iso_date() {
        let d = parse_build_date("2026-08-19").expect("should parse");
        assert_eq!(d.to_string(), "2026-08-19");
    }

    #[test]
    fn parse_build_date_trims_whitespace() {
        assert!(parse_build_date("2026-08-19\n").is_some());
        assert!(parse_build_date("  2026-08-19  ").is_some());
    }

    #[test]
    fn parse_build_date_rejects_garbage() {
        for bad in ["", "not-a-date", "2026/08/19", "08-19-2026"] {
            assert!(parse_build_date(bad).is_none(), "expected {bad:?} to fail to parse");
        }
    }

    fn stub_task(id: &str, path: &str) -> Task {
        Task { id: id.to_string(), path: path.to_string(), ..Task::default() }
    }

    /// An Agent carrying only the two fields `base_agent_id` reads.
    fn stub_agent(id: &str, extends: Option<&str>) -> crate::Agent {
        let mut a = crate::default_agents().into_iter().next().unwrap();
        a.id = id.to_string();
        a.extends = extends.map(|s| s.to_string());
        a
    }

    #[test]
    fn a_host_path_config_dir_cannot_override_the_mounted_one() {
        // The real failure this prevents: CLAUDE_CONFIG_DIR set to a path on
        // the Mac (right on the host, and how people keep a cloned agent's
        // login separate) rides into the container, where that path does not
        // exist and its parent is root-owned. The agent then cannot write its
        // login or transcripts at all - EACCES - and the directory termic
        // mounted for it stays empty.
        let task = stub_task("t-env", "/tmp/termic-docker-test-does-not-exist");
        let mut env = std::collections::HashMap::new();
        env.insert("CLAUDE_CONFIG_DIR".to_string(), "/Users/me/.next-claude".to_string());
        let spec = with_scratch_data_dir(|| build_spec(&task, "next-claude", "img", &task.path,
            vec![], &env, &[], false, &[], &[], "pty-env000001", "claude", &[], None));

        // LAST value wins with `docker run -e`, so the last one is the one
        // that counts.
        let effective = spec.env.iter().rev()
            .find(|(k, _)| k == "CLAUDE_CONFIG_DIR").map(|(_, v)| v.clone()).unwrap();
        assert_eq!(effective, "/root/.claude");
        assert!(spec.warnings.iter().any(|w| w.contains("/Users/me/.next-claude")),
            "silently correcting it would be its own surprise: {:?}", spec.warnings);
    }

    #[test]
    fn a_config_dir_inside_a_mount_is_left_alone() {
        // Someone who pointed it at a path they actually mounted knows
        // something we do not; only unmounted paths are overridden.
        let task = stub_task("t-env2", "/tmp/termic-docker-test-does-not-exist");
        let mut env = std::collections::HashMap::new();
        env.insert("CLAUDE_CONFIG_DIR".to_string(), "/root/.claude/alt".to_string());
        let spec = with_scratch_data_dir(|| build_spec(&task, "claude", "img", &task.path,
            vec![], &env, &[], false, &[], &[], "pty-env000002", "claude", &[], None));
        let effective = spec.env.iter().rev()
            .find(|(k, _)| k == "CLAUDE_CONFIG_DIR").map(|(_, v)| v.clone()).unwrap();
        assert_eq!(effective, "/root/.claude/alt");
        // Narrowed to what this test MEANS: no warning about the config dir.
        // Asserting "no warnings at all" made it depend on the machine, since
        // `build_spec` also warns when the host has no global git identity.
        // Every developer box has one and a fresh CI runner does not, so this
        // passed everywhere except the place that gates merges.
        let about_config: Vec<&String> = spec.warnings.iter()
            .filter(|w| w.contains("CLAUDE_CONFIG_DIR") || w.contains(".claude"))
            .collect();
        assert!(about_config.is_empty(), "{about_config:?}");
    }

    #[test]
    fn a_cloned_agent_inherits_its_base_shape_but_keeps_its_own_folder() {
        // The whole point of cloning claude is a SEPARATE login (work vs
        // personal), which means: same config shape, different storage.
        // Resolving the shape on the clone's own id fell through to the
        // unknown-agent path - nothing mounted, no CLAUDE_CONFIG_DIR - so the
        // agent wrote its login to /root inside the container, where it both
        // vanishes on exit and is not writable by the non-root container user.
        let agents = vec![
            stub_agent("claude", None),
            stub_agent("next-claude", Some("claude")),
        ];
        assert_eq!(base_agent_id(&agents, "next-claude"), "claude");
        assert_eq!(base_agent_id(&agents, "claude"), "claude");
        // An agent that extends nothing, and one nobody has heard of.
        assert_eq!(base_agent_id(&agents, "stranger"), "stranger");

        let task = stub_task("t-clone", "/tmp/termic-docker-test-does-not-exist");
        let env = std::collections::HashMap::new();
        let spec = with_scratch_data_dir(|| build_spec(&task, "next-claude", "img", &task.path,
            vec![], &env, &[], false, &[], &[], "pty-clone0001", "claude", &[], None));

        // claude's shape: the config dir is mounted and relocated onto it, so
        // `.claude.json` (which lives at HOME root until relocated) is inside
        // the mount rather than in the throwaway layer.
        assert!(spec.mounts.iter().any(|m| m.container == "/root/.claude"),
            "a claude clone must get claude's config dir mounted");
        assert!(spec.env.iter().any(|(k, v)| k == "CLAUDE_CONFIG_DIR" && v == "/root/.claude"),
            "without the relocation var the login lands outside the mount");

        // ...but stored under the CLONE's own id, which is what keeps the two
        // logins apart. Mounting claude's own folder here would defeat the
        // reason the clone exists.
        let cfg_mount = spec.mounts.iter().find(|m| m.container == "/root/.claude").unwrap();
        assert!(cfg_mount.host.replace('\\', "/").ends_with("docker-agents/next-claude"), "{}", cfg_mount.host);
    }

    // ── the Docker credential realm, for the account switcher (GH #278) ──
    //
    // Docker mode keeps agent logins somewhere COMPLETELY separate from the
    // host: `<data>/docker-agents/<agent-id>`, bind-mounted at the container's
    // config dir. So an account switcher has two storage realms, not one, and
    // these pin what the Docker one actually does today rather than what the
    // design assumes about it.

    #[test]
    fn a_docker_login_is_keyed_by_agent_id_and_nothing_else() {
        // THE GAP. Two accounts of the SAME agent resolve to one host dir, so
        // in Docker mode they would share a login however the host side is
        // arranged. Whatever the switcher stores an account under, this level
        // has to grow it.
        with_scratch_data_dir(|| {
            assert_eq!(agent_config_host_dir("claude"), agent_config_host_dir("claude"));
            assert_ne!(agent_config_host_dir("claude"), agent_config_host_dir("next-claude"));
        });
    }

    #[test]
    fn the_docker_login_dir_is_termic_owned_never_the_real_home() {
        // Full isolation from the OS agent is the point: a Docker task must
        // never read or write the user's real ~/.claude.
        with_scratch_data_dir(|| {
            let d = agent_config_host_dir("claude");
            assert!(d.to_string_lossy().contains("docker-agents"), "{}", d.display());
            let home = std::env::var("HOME").unwrap_or_default();
            assert!(!d.starts_with(format!("{home}/.claude")), "{}", d.display());
        });
    }

    #[test]
    fn every_relocating_agent_gets_its_own_docker_dir_and_relocation_var() {
        // The switcher's Docker half only works for agents whose config dir
        // can be mounted AND pointed at. This walks the built-ins rather than
        // asserting claude alone, so an agent added later shows up here.
        with_scratch_data_dir(|| {
            for (agent, container) in [
                ("claude", "/root/.claude"),
                ("codex", "/root/.codex"),
            ] {
                let task = stub_task("t-realm", "/tmp/termic-docker-test-does-not-exist");
                let env = std::collections::HashMap::new();
                let spec = build_spec(&task, agent, "img", &task.path, vec![], &env,
                    &[], false, &[], &[], "pty-realm00001", agent, &[], None);
                let m = spec.mounts.iter().find(|m| m.container == container)
                    .unwrap_or_else(|| panic!("{agent}: no config mount at {container}"));
                assert!(m.host.replace('\\', "/").contains(&format!("docker-agents/{agent}")), "{agent}: {}", m.host);
                let var = crate::agent_dirs::config_relocation_env(agent)
                    .unwrap_or_else(|| panic!("{agent} should relocate"));
                assert!(spec.env.iter().any(|(k, v)| k == var && v == container),
                    "{agent}: {var} must point at the mount or the login lands in the throwaway layer");
            }
        });
    }

    #[test]
    fn no_mount_reaches_the_config_sync_clone() {
        // The sync clone (`<data>/sync`, config_sync.rs) holds the user's
        // whole setup and a remote they can push to. Docker mounts named
        // subfolders of the data dir only; this pins that no spec, for any
        // built-in agent with persistence on, mounts the clone or the data
        // dir above it. Anything added later that mounts the data dir has to
        // keep `sync/` out (docs/sandbox.md).
        with_scratch_data_dir(|| {
            let data = crate::global_dir().unwrap();
            let clone = data.join("sync");
            std::fs::create_dir_all(&clone).unwrap();
            let canon = |p: &std::path::Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
            let (data_c, clone_c) = (canon(&data), canon(&clone));
            for agent in ["claude", "codex", "agy", "opencode", "pi"] {
                let task = stub_task("t-sync", "/tmp/termic-docker-test-does-not-exist");
                let env = std::collections::HashMap::new();
                let spec = build_spec(&task, agent, "img", &task.path, vec![], &env,
                    &[".extra".to_string()], true, &[], &[], "pty-sync00001", agent, &[], None);
                for m in &spec.mounts {
                    let host = canon(std::path::Path::new(&m.host));
                    assert!(host != data_c, "{agent}: mounts the whole data dir");
                    assert!(!host.starts_with(&clone_c), "{agent}: mounts the sync clone: {}", m.host);
                }
            }
        });
    }

    #[test]
    fn an_agent_with_no_relocation_var_still_gets_its_dir_mounted() {
        // gemini-family and opencode have no relocation var, so the mount
        // alone has to carry the login: the agent writes to its default path
        // and that path IS the mount. Worth pinning, because it is the case
        // where the switcher cannot lean on an env var at all.
        with_scratch_data_dir(|| {
            let task = stub_task("t-noreloc", "/tmp/termic-docker-test-does-not-exist");
            let env = std::collections::HashMap::new();
            let spec = build_spec(&task, "agy", "img", &task.path, vec![], &env,
                &[], false, &[], &[], "pty-noreloc0001", "agy", &[], None);
            let m = spec.mounts.iter().find(|m| m.container == "/root/.gemini")
                .expect("agy's primary config dir must be mounted");
            assert!(m.host.replace('\\', "/").contains("docker-agents/agy"), "{}", m.host);
            assert!(crate::agent_dirs::config_relocation_env("agy").is_none());
        });
    }

    /// Point `global_dir()` at a scratch profile for the duration of a test.
    /// `build_spec` CREATES the agent config dir now, and `global_dir()` in a
    /// test otherwise resolves to the developer's REAL profile - so without
    /// this the suite silently made folders in
    /// `~/Library/Application Support/termic/docker-agents`. Debug-only seam,
    /// same one automation.rs uses.
    /// Delegates to the ONE process-wide lock in `crate::test_support`.
    /// This module used to hold its own, which serialized it against itself
    /// and raced every other module touching the same env var.

    fn with_scratch_data_dir<T>(f: impl FnOnce() -> T) -> T {
        crate::test_support::with_scratch_data_dir(|_| f())
    }

    #[test]
    fn the_agent_config_host_dir_exists_before_it_becomes_a_mount() {
        // A missing `-v` source is created by the DAEMON, and its ownership
        // is the daemon's business: Docker Desktop on macOS maps it to the
        // host user (which is the only reason this ever worked), a Linux
        // daemon creates it root-owned. The container runs as the host uid,
        // so a root-owned config dir means the agent cannot write its login
        // or its transcripts: EACCES, and a login that never sticks.
        with_scratch_data_dir(|| {
            let task = stub_task("t-mk", "/tmp/termic-docker-test-does-not-exist");
            let env = std::collections::HashMap::new();
            let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false,
                &[], &[], "pty-mkdir0001", "claude", &[], None);
            let cfg = spec.mounts.iter().find(|m| m.container == "/root/.claude").unwrap();
            assert!(std::path::Path::new(&cfg.host).is_dir(),
                "host config dir must exist before docker sees it: {}", cfg.host);
        });
    }

    #[test]
    fn a_clone_of_grok_stays_excluded() {
        // grok's exclusion is about its layout (binary inside its config
        // dir), so it has to follow the clone rather than the id.
        let agents = vec![stub_agent("grok", None), stub_agent("my-grok", Some("grok"))];
        assert_eq!(base_agent_id(&agents, "my-grok"), "grok");
        assert!(agent_config("grok", &[".grok".to_string()], true).is_none());
    }

    #[test]
    fn base_agent_id_survives_a_cycle() {
        // Hand-edited settings could point two agents at each other; the
        // resolver must not spin.
        let agents = vec![stub_agent("a", Some("b")), stub_agent("b", Some("a"))];
        let _ = base_agent_id(&agents, "a");
    }

    #[test]
    fn pi_persists_its_config_and_does_not_repeat_groks_mistake() {
        // pi keeps settings.json + trust.json under ~/.pi/agent/, so `.pi` is
        // the config dir. It qualifies for persistence ONLY because the image
        // installs it from npm (binary in the global prefix, outside HOME).
        // pi's own install.sh can drop the binary in ~/.pi/agent/bin, which
        // is precisely why grok is excluded - mounting a config dir over the
        // binary's own directory shadows the binary.
        assert!(KNOWN_SAFE_AGENTS.contains(&"pi"));
        assert_eq!(crate::agent_dirs::state_dirs("pi"), &[".pi"]);

        let task = stub_task("t-pi", "/tmp/termic-docker-test-does-not-exist");
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "pi", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-pi000001", "pi", &[], None);
        assert!(spec.mounts.iter().any(|m| m.container == "/root/.pi"),
            "pi's config dir must be mounted, or every Docker launch re-authenticates");
        // No relocation env var is claimed for pi: the docs describe no
        // single variable that moves the whole config dir (only the session
        // dir), so the mount IS the mechanism.
        assert!(!spec.env.iter().any(|(k, _)| k.starts_with("PI_")),
            "no PI_* var should be invented here without one in pi's docs");

        // grok stays excluded, deliberately. So does devin: the install
        // script unpacks versioned binaries into ~/.local/share/devin next to
        // credentials.toml, which is grok's shadowing collision one level
        // deeper.
        assert!(!KNOWN_SAFE_AGENTS.contains(&"grok"));
        assert!(!persist_offerable("grok"));
        assert!(!KNOWN_SAFE_AGENTS.contains(&"devin"));
        assert!(!persist_offerable("devin"));
        assert!(agent_config("devin", &[".config/devin".to_string()], true).is_none());
    }

    /// The hook wiring has to be IN the container, not merely on the host
    /// process. `cmd.env(...)` sets the `docker run` CLI's environment and
    /// docker forwards none of it, so both gates in the hook script failed and
    /// every sandboxed tab delivered zero OSCs while unsandboxed tabs on the
    /// same agent delivered hundreds.
    #[test]
    fn the_container_gets_the_hook_env_at_a_container_address() {
        let task = stub_task("t-hooks", "/tmp/termic-docker-test-does-not-exist");
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false,
                              &[], &[], "pty-hooks01", "claude", &[], None);
        let get = |k: &str| spec.env.iter().rev().find(|(a, _)| a == k).map(|(_, v)| v.clone());
        assert_eq!(get("TERMIC_TASK_ID"), Some(task.id.clone()));
        // NOT the host device path: the container has no entry for it, which
        // is the whole reason this exists.
        let pty = get("TERMIC_PTY").expect("TERMIC_PTY must reach the container");
        assert_eq!(pty, "/proc/1/fd/1");
        assert!(!pty.starts_with("/dev/tty"), "a host pty path is meaningless in the cage");
    }

    #[test]
    fn build_spec_names_the_container_per_pty_not_per_task() {
        // A task can host several agent tabs, each with its own container.
        // Keyed on task id alone, tab B's `--name` collided with tab A's live
        // container, and the task-scoped label sweep on spawn tore A down
        // mid-session (GH #231). The LABEL stays task-scoped on purpose:
        // archive and the Docker toggle do want to reap the whole task.
        let task = stub_task("task-1", "/tmp/termic-docker-test-does-not-exist");
        let env = std::collections::HashMap::new();
        let a = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "aaaaaaaa-1111-2222-3333-444444444444", "claude", &[], None);
        let b = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "bbbbbbbb-1111-2222-3333-444444444444", "claude", &[], None);
        assert_ne!(a.container_name, b.container_name,
            "two tabs of one task must not share a container name");
        assert!(a.container_name.starts_with("termic-task-1-"));
        assert_eq!(a.label, b.label, "the task label is shared, so archive reaps both");
        assert_eq!(a.label, "termic.task=task-1");
    }

    #[test]
    fn a_named_account_shares_the_agents_conversations_into_the_container() {
        // Switching a DOCKER task to a named account gave it a fresh config
        // dir and therefore a fresh everything: `--resume` answered "No
        // conversation found", and the same switch on the host worked, because
        // the host store is a symlink farm back to the primary dir. A host
        // symlink is dangling inside a container, so Docker shares the same
        // entries as bind MOUNTS instead.
        // `agent_config_host_dir` and `build_spec` both resolve through
        // `TERMIC_DATA_DIR`, so the path resolved here and the one resolved
        // inside `build_spec` must not be repointed mid-test. A scratch data
        // dir, or the seeding below lands in the developer's real one.
        with_scratch_data_dir(|| {
        let dir = std::env::temp_dir().join(format!("termic-docker-share-{}", uuid::Uuid::new_v4()));
        let primary = crate::docker::agent_config_host_dir("claude");
        // Only entries that EXIST are mounted, so seed one and check both
        // directions in a single spec.
        // Seed a couple of entries of BOTH kinds, so the parity loop below
        // covers a directory and a file rather than just one shape.
        std::fs::create_dir_all(primary.join("projects")).unwrap();
        std::fs::create_dir_all(primary.join("termic-hooks")).unwrap();
        std::fs::write(primary.join("settings.json"), b"{}").unwrap();
        std::fs::create_dir_all(&dir).unwrap();

        let task = stub_task("task-1", dir.to_str().unwrap());
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[],
                              "aaaaaaaa-1111-2222-3333-444444444444", "claude", &[], Some("Work"));

        let mounted_at = |c: &str| spec.mounts.iter().any(|m| m.container == c);
        assert!(mounted_at("/root/.claude/projects"),
            "the account's container must see the agent's conversations, or --resume finds nothing");

        // REALM PARITY, which is the rule this whole class of bug came from.
        // The host shares these entries by symlink and Docker by mount, and
        // three separate bugs were "implemented on the host, silently not in
        // the container": the adopted account relocating the mount, the hooks
        // never being installed, and `termic-hooks` missing so the shared
        // settings pointed at scripts that were not there.
        //
        // So: every shared entry that EXISTS in the primary dir must be
        // mounted. Adding one to `shared_config_entries` without Docker
        // honouring it now fails here rather than in a container weeks later.
        for name in crate::agent_dirs::shared_config_entries("claude") {
            if !primary.join(name).exists() {
                continue; // nothing to share yet; the mount is skipped by design
            }
            assert!(
                mounted_at(&format!("/root/.claude/{name}")),
                "{name} is shared on the host but not mounted into the container",
            );
        }
        // The account's own directory is still what the config dir points at,
        // so the CREDENTIAL stays per-account. That is the whole feature.
        assert!(spec.mounts.iter().any(|m| m.host.replace('\\', "/").ends_with("/claude/work") && m.container == "/root/.claude"),
            "the account keeps its own config dir: {:?}", spec.mounts);

        // Without an account nothing is overlaid: the primary dir IS the
        // config dir, and mounting its own children on top of it is noise.
        let plain = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[],
                               "aaaaaaaa-1111-2222-3333-444444444444", "claude", &[], None);
        assert!(!plain.mounts.iter().any(|m| m.container == "/root/.claude/projects"));
        let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn short_id_is_safe_for_ids_shorter_than_the_cut() {
        assert_eq!(short_id("aaaaaaaa-bbbb"), "aaaaaaaa");
        assert_eq!(short_id("abc"), "abc");
        assert_eq!(short_id(""), "");
    }

    #[test]
    fn build_spec_forwards_the_per_spawn_env_overlay() {
        // The per-agent env block from Settings -> Agents & Terminals
        // (envForCli) rides in as SpawnArgs.env, same as the Seatbelt path.
        // It used to be dropped entirely for Docker mode - only TERM /
        // COLORTERM / the agent's relocation var ever reached the container.
        let task = stub_task("t1", "/tmp/termic-docker-test-does-not-exist");
        let mut spawn_env = std::collections::HashMap::new();
        spawn_env.insert("MY_CUSTOM_VAR".to_string(), "hello".to_string());
        let spec = build_spec(&task, "claude", "termic-sandbox:abc", &task.path, vec![], &spawn_env, &[], false, &[], &[], "pty-aaaa1111", "claude", &[], None);
        assert!(spec.env.iter().any(|(k, v)| k == "MY_CUSTOM_VAR" && v == "hello"));
        assert!(spec.env.iter().any(|(k, _)| k == "TERM"));
    }

    #[test]
    fn build_spec_overlay_wins_on_key_collision() {
        // Appended AFTER the base TERM/COLORTERM, matching `docker run`'s
        // own last-`-e`-wins semantics for a duplicate key - and matching
        // the Seatbelt/unsandboxed path's "per-agent env wins" precedence.
        let task = stub_task("t2", "/tmp/termic-docker-test-does-not-exist-2");
        let mut spawn_env = std::collections::HashMap::new();
        spawn_env.insert("TERM".to_string(), "dumb".to_string());
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &spawn_env, &[], false, &[], &[], "pty-aaaa1111", "claude", &[], None);
        let term_values: Vec<&str> = spec.env.iter().filter(|(k, _)| k == "TERM").map(|(_, v)| v.as_str()).collect();
        assert_eq!(term_values, vec!["xterm-256color", "dumb"]);
    }

    /// `agent_config()` now derives its mount paths from
    /// `agent_dirs::state_dirs` instead of its own hardcoded table
    /// (dedup with Seatbelt's default allow-list, see agent_dirs.rs's
    /// module doc). Pins the exact container paths + relocation env
    /// every agent produced before that refactor, so a future edit to
    /// the shared table can't silently change what actually gets
    /// mounted into a running container.
    #[test]
    fn agent_config_mounts_match_the_pre_dedup_paths() {
        let task = stub_task("t3", "/tmp/termic-docker-test-does-not-exist-3");
        let env = std::collections::HashMap::new();
        let cases: &[(&str, &str, &[&str])] = &[
            ("claude", "/root/.claude", &[]),
            ("codex", "/root/.codex", &[]),
            ("copilot", "/root/.copilot", &[]),
            ("agy", "/root/.gemini", &["/root/.antigravity"]),
            ("opencode", "/root/.config/opencode", &["/root/.local/share/opencode"]),
        ];
        for (agent, primary, extras) in cases {
            let spec = build_spec(&task, agent, "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-aaaa1111", agent, &[], None);
            let mounted: Vec<&str> = spec.mounts.iter().map(|m| m.container.as_str()).collect();
            assert!(mounted.contains(primary), "{agent}: expected {primary} in {mounted:?}");
            for e in *extras {
                assert!(mounted.contains(e), "{agent}: expected {e} in {mounted:?}");
            }
        }
        // grok stays unsupported in Docker mode regardless of what
        // agent_dirs lists for Seatbelt's sake.
        let grok_spec = build_spec(&task, "grok", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-aaaa1111", "grok", &[], None);
        assert!(!grok_spec.mounts.iter().any(|m| m.container.contains("grok")));
    }

    #[test]
    fn relocation_env_value_always_matches_the_container_dir() {
        let task = stub_task("t4", "/tmp/termic-docker-test-does-not-exist-4");
        let env = std::collections::HashMap::new();
        for (agent, var) in [("claude", "CLAUDE_CONFIG_DIR"), ("codex", "CODEX_HOME")] {
            let spec = build_spec(&task, agent, "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-aaaa1111", agent, &[], None);
            let val = spec.env.iter().find(|(k, _)| k == var).map(|(_, v)| v.as_str());
            assert_eq!(val, Some(format!("/root/.{agent}").as_str()));
        }
    }

    #[test]
    fn a_bare_persist_entry_resolves_against_the_container_home() {
        // `.claude` reads better than `/root/.claude` and is what every
        // existing entry looks like, so a bare name still means HOME.
        assert_eq!(sanitize_extra_dir(".mytool"), Some("/root/.mytool".to_string()));
        assert_eq!(sanitize_extra_dir(".config/mytool"), Some("/root/.config/mytool".to_string()));
        assert_eq!(sanitize_extra_dir("./.mytool"), Some("/root/.mytool".to_string()));
        assert_eq!(sanitize_extra_dir("  .mytool  "), Some("/root/.mytool".to_string()));
        assert_eq!(sanitize_extra_dir(".mytool/"), Some("/root/.mytool".to_string()));
    }

    #[test]
    fn an_absolute_persist_entry_is_taken_verbatim() {
        // Persisting outside HOME is the point of accepting these: a cache or
        // a data dir an agent keeps somewhere else has the same "gone on every
        // restart" problem as its config.
        assert_eq!(sanitize_extra_dir("/opt/cache"), Some("/opt/cache".to_string()));
        assert_eq!(sanitize_extra_dir("/opt/cache/"), Some("/opt/cache".to_string()));
        assert_eq!(sanitize_extra_dir("/root/.claude"), Some("/root/.claude".to_string()));
    }

    /// The argv `build_command` produced, as plain strings.
    fn build_argv(dockerfile: &str, no_cache: bool) -> Vec<String> {
        // `build_command` writes the Dockerfile under `docker_dir()`, i.e.
        // under whatever `TERMIC_DATA_DIR` currently says, so it runs against
        // a scratch one (which also takes the lock the redirecting tests hold).
        with_scratch_data_dir(|| {
            let (cmd, _) = build_command(dockerfile, no_cache).unwrap();
            cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect()
        })
    }

    #[test]
    fn updating_agents_busts_only_the_agent_layers() {
        // `--no-cache` also re-pulls the base image and re-runs the apt
        // install, which is the slow half of the build and is not what
        // "update agents" is asking for. The shipped Dockerfile declares a
        // refresh arg above its agent installs; bumping that invalidates from
        // there down and leaves the expensive layers cached.
        let df = DEFAULT_DOCKERFILE;
        assert!(df.contains(AGENT_REFRESH_ARG), "the shipped Dockerfile must declare it");
        let argv = build_argv(df, true);
        assert!(argv.iter().any(|a| a.starts_with(&format!("{AGENT_REFRESH_ARG}="))), "{argv:?}");
        assert!(!argv.iter().any(|a| a == "--no-cache"), "{argv:?}");
    }

    #[test]
    fn a_dockerfile_without_the_arg_still_gets_a_real_no_cache_build() {
        // Anyone whose SAVED Dockerfile predates the arg would otherwise get a
        // fully cached build that updates nothing: docker only warns about an
        // unconsumed build-arg, it does not fail.
        let argv = build_argv("FROM node:lts-bookworm\nRUN echo hi\n", true);
        assert!(argv.iter().any(|a| a == "--no-cache"), "{argv:?}");
        assert!(argv.iter().any(|a| a == "--pull"), "{argv:?}");
        assert!(!argv.iter().any(|a| a.starts_with(AGENT_REFRESH_ARG)), "{argv:?}");
    }

    #[test]
    fn an_ordinary_build_busts_nothing() {
        let argv = build_argv(DEFAULT_DOCKERFILE, false);
        assert!(!argv.iter().any(|a| a == "--no-cache"), "{argv:?}");
        assert!(!argv.iter().any(|a| a.starts_with(AGENT_REFRESH_ARG)), "{argv:?}");
    }

    #[test]
    fn a_persist_entry_cannot_shadow_the_system() {
        // An empty dir mounted over these either stops the container booting
        // or hides something the image put there on purpose.
        for bad in ["/etc", "/etc/ssl", "/usr/bin", "/bin", "/lib/x", "/proc", "/dev/shm", "/boot"] {
            assert_eq!(sanitize_extra_dir(bad), None, "expected {bad:?} to be refused");
        }
        // Nor a bare root, even an allowed one: mounting over all of /var is
        // not what anyone means by persisting a directory.
        for bad in ["/var", "/home", "/opt", "/tmp"] {
            assert_eq!(sanitize_extra_dir(bad), None, "expected {bad:?} to be refused");
        }
        // But somewhere under them is exactly the point.
        assert_eq!(sanitize_extra_dir("/var/cache/mytool"), Some("/var/cache/mytool".to_string()));
        assert_eq!(sanitize_extra_dir("/data/models"), Some("/data/models".to_string()));
    }

    #[test]
    fn sanitize_extra_dir_still_rejects_escapes_and_nonsense() {
        // `..` stays banned however it is spelled: it is the one thing that
        // could resolve a mount TARGET somewhere neither side intended.
        for bad in ["", "   ", "/", "/root", "../../etc", ".foo/../../etc", "/opt/../etc"] {
            assert_eq!(sanitize_extra_dir(bad), None, "expected {bad:?} to be rejected");
        }
    }

    #[test]
    fn a_persist_entry_maps_to_a_collision_free_host_folder() {
        // The container path is mirrored under the agent's folder, so two
        // entries can never land on the same host dir...
        assert_eq!(host_subpath_for("/opt/cache"), "opt/cache");
        // ...and a home-relative entry keeps the dotless layout every existing
        // install already has on disk.
        assert_eq!(host_subpath_for("/root/.antigravity"), "antigravity");
        assert_eq!(host_subpath_for("/root/.config/opencode"), "config/opencode");
        assert_ne!(host_subpath_for("/opt/cache"), host_subpath_for("/root/.cache"));
    }

    #[test]
    fn render_argv_runs_as_the_host_uid_gid_with_home_pinned_to_root() {
        // Claude Code (and presumably others) refuse
        // --dangerously-skip-permissions under root - `render_argv` runs
        // the container as the HOST user's own uid:gid instead so YOLO
        // auto-on works in Docker mode too, matching ownership of every
        // bind-mounted path along the way. HOME/USER have to be pinned
        // explicitly since that uid has no /etc/passwd entry in the image.
        let task = stub_task("t13", "/tmp/termic-docker-test-does-not-exist-13");
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-aaaa1111", "claude", &[], None);
        let argv = render_argv(&spec, "claude", &[]);
        let user_idx = argv.iter().position(|a| a == "--user").expect("--user flag missing");
        assert_eq!(argv[user_idx + 1], host_uid_gid());
        assert!(spec.env.iter().any(|(k, v)| k == "HOME" && v == "/root"));
        assert!(spec.env.iter().any(|(k, _)| k == "USER"));
    }

    #[cfg(unix)] // unix host paths; the Windows form is tested below
    #[test]
    fn sanitize_extra_mount_accepts_a_valid_host_container_pair() {
        let got = sanitize_extra_mount("/tmp/mcp-data:/data/mcp", "/Users/x", "/tmp/task");
        assert_eq!(got, Some(("/tmp/mcp-data".to_string(), "/data/mcp".to_string())));
    }

    #[cfg(unix)] // unix host paths; the Windows form is tested below
    #[test]
    fn sanitize_extra_mount_expands_home_and_workspace_on_the_host_half() {
        let got = sanitize_extra_mount("$HOME/mcp-data:/data/mcp", "/Users/x", "/tmp/task");
        assert_eq!(got, Some(("/Users/x/mcp-data".to_string(), "/data/mcp".to_string())));
    }

    #[cfg(unix)] // unix host paths; the Windows form is tested below
    #[test]
    fn sanitize_extra_mount_trims_a_trailing_slash_on_the_container_half() {
        let got = sanitize_extra_mount("/tmp/mcp-data:/data/mcp/", "/Users/x", "/tmp/task");
        assert_eq!(got, Some(("/tmp/mcp-data".to_string(), "/data/mcp".to_string())));
    }

    #[test]
    fn sanitize_extra_mount_rejects_malformed_entries() {
        for bad in ["", "no-colon-here", "/only-host:", ":/only-container", "  :  "] {
            assert_eq!(sanitize_extra_mount(bad, "/Users/x", "/tmp/task"), None, "expected {bad:?} to be rejected");
        }
    }

    #[test]
    fn sanitize_extra_mount_rejects_a_relative_or_traversing_container_half() {
        for bad in ["/tmp/mcp-data:data/mcp", "/tmp/mcp-data:/data/../etc", "/tmp/mcp-data:/data/mcp\0"] {
            assert_eq!(sanitize_extra_mount(bad, "/Users/x", "/tmp/task"), None, "expected {bad:?} to be rejected");
        }
    }

    #[test]
    fn sanitize_extra_mount_rejects_denylisted_container_roots() {
        for root in ["/root", "/root/x", "/etc", "/etc/passwd", "/var", "/dev"] {
            let raw = format!("/tmp/mcp-data:{root}");
            assert_eq!(sanitize_extra_mount(&raw, "/Users/x", "/tmp/task"), None, "expected {root:?} to be rejected");
        }
    }

    #[test]
    fn the_forge_clis_get_a_shared_config_dir_and_their_relocation_env() {
        // One `gh auth login` has to cover every agent and every task, so
        // this mount is keyed on nothing - unlike everything else under
        // docker-agents/<agent>/.
        let task = stub_task("t-forge", "/tmp/termic-docker-test-does-not-exist-forge");
        let env = std::collections::HashMap::new();
        // Every assertion runs INSIDE the closure: the scratch data dir is a
        // tempdir that is deleted the moment it returns, and the whole point
        // of one of these is that the host path exists on disk by then.
        with_scratch_data_dir(|| {
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-forge001", "claude", &default_shared_config_dirs(), None);
        for (container, var) in [("/root/.config/gh", "GH_CONFIG_DIR"), ("/root/.config/glab-cli", "GLAB_CONFIG_DIR"), ("/root/.azure", "AZURE_CONFIG_DIR")] {
            let m = spec.mounts.iter().find(|m| m.container == container)
                .unwrap_or_else(|| panic!("{container} should be mounted"));
            assert!(!m.read_only, "a login has to be WRITTEN inside the container");
            assert!(m.host.contains("docker-forge"), "host side should live in the shared dir, got {}", m.host);
            // The source has to exist before it becomes a `-v`, or the daemon
            // creates it - root-owned on Linux, which is a login that can
            // never be written. Same reasoning as the agent config dir.
            assert!(std::path::Path::new(&m.host).is_dir(), "{} should exist already", m.host);
            assert!(spec.env.iter().any(|(k, v)| k == var && v == container), "{var} should point at {container}");
        }
        });
    }

    #[test]
    fn the_hosts_own_gh_credentials_are_never_mounted() {
        // Seatbelt hard-denies ~/.config/gh/hosts.yml; mounting it here would
        // make the container the looser of the two cages. It would also not
        // work on macOS, where the token lives in the Keychain rather than in
        // that file at all.
        let task = stub_task("t-forge2", "/tmp/termic-docker-test-does-not-exist-forge2");
        let env = std::collections::HashMap::new();
        let spec = with_scratch_data_dir(|| {
            build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-forge002", "claude", &default_shared_config_dirs(), None)
        });
        let home = dirs::home_dir().unwrap_or_default().to_string_lossy().into_owned();
        if home.is_empty() { return }
        for m in &spec.mounts {
            assert!(!m.host.starts_with(&format!("{home}/.config/gh")), "{} is the user's real gh login", m.host);
            assert!(!m.host.starts_with(&format!("{home}/.config/glab-cli")), "{} is the user's real glab login", m.host);
            // ~/.azure holds az tokens + PATs; it must stay a shared state
            // mount (if listed at all), never the live credential store.
            assert!(!m.host.starts_with(&format!("{home}/.azure")), "{} is the user's real az login", m.host);
        }
    }

    #[test]
    fn a_per_agent_gh_config_dir_wins_over_the_shared_one() {
        // Someone who deliberately listed `.config/gh` for one agent wants
        // that agent to hold its own token. An explicit choice outranks the
        // shared default, and two mounts on one container path must never
        // both be emitted.
        let task = stub_task("t-forge3", "/tmp/termic-docker-test-does-not-exist-forge3");
        let env = std::collections::HashMap::new();
        let extras = vec![".config/gh".to_string()];
        let spec = with_scratch_data_dir(|| {
            build_spec(&task, "copilot", "img", &task.path, vec![], &env, &extras, false, &[], &[], "pty-forge003", "copilot", &default_shared_config_dirs(), None)
        });
        let gh: Vec<&Mount> = spec.mounts.iter().filter(|m| m.container == "/root/.config/gh").collect();
        assert_eq!(gh.len(), 1, "exactly one mount per container path: {gh:?}");
        assert!(gh[0].host.contains("docker-agents"), "the agent's own dir should win, got {}", gh[0].host);
        // The env still names the same container path, so gh looks in the
        // directory that actually got mounted either way.
        assert!(spec.env.iter().any(|(k, v)| k == "GH_CONFIG_DIR" && v == "/root/.config/gh"));
        // glab is untouched by that opt-out and keeps the shared dir.
        let glab = spec.mounts.iter().find(|m| m.container == "/root/.config/glab-cli").unwrap();
        assert!(glab.host.contains("docker-forge"), "{}", glab.host);
    }

    #[test]
    fn attachments_are_mounted_read_only_at_the_same_path_both_sides() {
        // The frontend types ONE path string and does not know which cage the
        // task is in, so the container path has to equal the host path.
        // Read-only because the app is the only writer.
        //
        // NOT under the data dir, and that is the load-bearing part: Seatbelt
        // ends with a last-match-wins deny on the whole data dir (the CLI
        // token), so a pasted image there would be unreadable in the mode
        // most tasks run under. `attachments_dir` is in `$TMPDIR`, which
        // `builtin_runtime_paths` already allows.
        let task = stub_task("t-clip", "/tmp/termic-docker-test-does-not-exist-clip");
        let env = std::collections::HashMap::new();
        with_scratch_data_dir(|| {
            let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-clip0001", "claude", &[], None);
            let att = spec.mounts.iter().find(|m| m.host.ends_with("termic-attachments"))
                .expect("the attachments dir should be mounted");
            // The same path both sides (Linux container path on Windows), or
            // the path the frontend types is a lie.
            assert_eq!(in_container(&att.host), att.container, "the typed path must be the mounted one");
            assert!(att.read_only, "the container has no reason to write here");
            assert!(std::path::Path::new(&att.host).is_dir(), "{} should exist already", att.host);
            // Canonical, or the Seatbelt rule, the mount and the typed text
            // would each name a different string for the same directory.
            assert!(!att.host.starts_with("/var/folders"), "should be the resolved /private path: {}", att.host);
            // The pasted image dir sits underneath it, so one mount covers
            // both gestures.
            let clip = crate::clipboard_dir().unwrap();
            assert!(clip.starts_with(&att.host), "{clip:?} should live under {}", att.host);
        });
    }

    #[test]
    fn a_user_added_shared_dir_is_mounted_for_every_agent() {
        // The list is the user's, not a fixed pair of forge CLIs: anything
        // that should be shared rather than copied per agent goes in it. An
        // entry with no known CLI gets the mount and no relocation env,
        // which is all a tool that reads $HOME/.config/<name> needs.
        let task = stub_task("t-shared", "/tmp/termic-docker-test-does-not-exist-shared");
        let env = std::collections::HashMap::new();
        let dirs = vec![
            ".config/nvim".to_string(),
            "../escape".to_string(), // rejected by sanitize_extra_dir
            "/etc".to_string(),      // forbidden root
            String::new(),           // inert
        ];
        with_scratch_data_dir(|| {
            let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-shared01", "claude", &dirs, None);
            let nvim = spec.mounts.iter().find(|m| m.container == "/root/.config/nvim")
                .expect("a shared dir the user listed should be mounted");
            // Host layout mirrors the container path, so two entries with the
            // same basename (.config/gh vs some other gh) cannot collide.
            assert!(nvim.host.replace('\\', "/").ends_with("docker-forge/config/nvim"), "{}", nvim.host);
            assert!(std::path::Path::new(&nvim.host).is_dir(), "{} should exist already", nvim.host);
            assert!(!spec.env.iter().any(|(_, v)| v == "/root/.config/nvim"),
                "no relocation env should be invented for a CLI this module knows nothing about");
            // The three junk entries never became mounts.
            assert!(!spec.mounts.iter().any(|m| m.container.contains("escape") || m.container == "/etc"));
            // And an empty list is a real answer: the config dirs are a
            // DEFAULT, not a floor - a cleared field means no shared mounts.
            let none = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-shared02", "claude", &[], None);
            // The git identity file (step 4d) also lands under `/root/.config`
            // and is not a shared config dir: it is mounted for every task
            // regardless of this list, so it is exempt from the check.
            assert!(!none.mounts.iter().any(|m| m.container.replace('\\', "/").starts_with("/root/.config/")
                && m.container != "/root/.config/git/config"));
            assert!(!none.env.iter().any(|(k, _)| k == "GH_CONFIG_DIR"));
        });
    }

    #[test]
    fn the_shared_config_env_follows_the_dir_the_user_actually_listed() {
        // Keyed on the entry's basename, so moving gh's config elsewhere in
        // the list still points GH_CONFIG_DIR at wherever it landed rather
        // than at a path nothing is mounted on.
        let task = stub_task("t-shared2", "/tmp/termic-docker-test-does-not-exist-shared2");
        let env = std::collections::HashMap::new();
        let dirs = vec!["/opt/forge/gh".to_string()];
        with_scratch_data_dir(|| {
            let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-shared03", "claude", &dirs, None);
            assert!(spec.mounts.iter().any(|m| m.container == "/opt/forge/gh"));
            assert!(spec.env.iter().any(|(k, v)| k == "GH_CONFIG_DIR" && v == "/opt/forge/gh"));
        });
    }

    #[test]
    fn a_task_extra_mount_cannot_shadow_the_forge_config_dirs() {
        let task = stub_task("t-forge4", "/tmp/termic-docker-test-does-not-exist-forge4");
        let env = std::collections::HashMap::new();
        let extras = vec!["/tmp/whatever:/root/.config/gh".to_string()];
        let spec = with_scratch_data_dir(|| {
            build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &extras, "pty-forge004", "claude", &default_shared_config_dirs(), None)
        });
        let gh: Vec<&str> = spec.mounts.iter().filter(|m| m.container == "/root/.config/gh").map(|m| m.host.as_str()).collect();
        assert_eq!(gh.len(), 1, "{gh:?}");
        assert_ne!(gh[0], "/tmp/whatever");
    }

    #[cfg(unix)] // unix host paths; the Windows form is tested below
    #[test]
    fn task_extra_mounts_are_added_and_deduped_by_container_path() {
        let task = stub_task("t11", "/tmp/termic-docker-test-does-not-exist-11");
        let env = std::collections::HashMap::new();
        let extras = vec![
            "/tmp/mcp-data:/data/mcp".to_string(),
            "/tmp/other:/data/mcp".to_string(), // same container path - dropped
            "/etc:/data/unsafe".to_string(),    // denylisted host isn't the point; container is fine, host stays as-is
            "not-an-entry".to_string(),         // malformed - dropped
        ];
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &extras, "pty-aaaa1111", "claude", &[], None);
        let containers: Vec<&str> = spec.mounts.iter().map(|m| m.container.as_str()).collect();
        assert_eq!(containers.iter().filter(|c| **c == "/data/mcp").count(), 1, "{containers:?}");
        let mcp_mount = spec.mounts.iter().find(|m| m.container == "/data/mcp").unwrap();
        assert_eq!(mcp_mount.host, "/tmp/mcp-data");
    }

    /// `build_spec` with only `extras` as task-level mounts; the containers
    /// it kept.
    fn extra_containers(extras: &[String]) -> Vec<String> {
        let task = stub_task("t-data", "/tmp/termic-docker-test-does-not-exist-data");
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], extras, "pty-dddd0000", "claude", &[], None);
        spec.mounts.into_iter().map(|m| m.container).filter(|c| c.starts_with("/data/")).collect()
    }

    #[test]
    fn an_extra_mount_cannot_take_termics_data_dir_or_anything_in_it() {
        crate::test_support::with_scratch_data_dir(|dir| {
            std::fs::create_dir_all(dir.join("sync")).unwrap();
            let data = dir.to_string_lossy().into_owned();
            let refused = [
                format!("{data}:/data/a"),
                format!("{data}/:/data/b"),
                format!("{data}/sync:/data/c"),
                format!("{data}/not-yet/made:/data/d"),
                format!("{data}/sync/../docker-agents:/data/e"),
            ];
            for m in &refused {
                let err = validate_extra_mounts(std::slice::from_ref(m)).unwrap_err();
                assert!(err.contains("Termic's data folder"), "{m}: {err}");
                assert_eq!(refuse_data_dir_mounts(std::slice::from_ref(m)), Err(err));
            }
            // A sibling whose name only STARTS with the data dir's is not in it.
            let outside = tempfile::tempdir().unwrap();
            let ok = [format!("{data}-other:/data/y"), format!("{}:/data/z", outside.path().display())];
            assert_eq!(validate_extra_mounts(&ok), Ok(()));
            // A value already on disk never met the save check: spawn skips it.
            let all: Vec<String> = refused.iter().chain(&ok).cloned().collect();
            assert_eq!(extra_containers(&all), ["/data/y", "/data/z"]);
            // `$WORKSPACE` is the spawn's to resolve, so the save lets it by.
            assert_eq!(refuse_data_dir_mounts(&["$WORKSPACE/x:/data/w".into()]), Ok(()));
        });
    }

    #[cfg(unix)]
    #[test]
    fn an_extra_mount_cannot_reach_the_data_dir_through_a_symlink() {
        crate::test_support::with_scratch_data_dir(|dir| {
            let outside = tempfile::tempdir().unwrap();
            let link = outside.path().join("innocent");
            std::os::unix::fs::symlink(dir, &link).unwrap();
            let refused = [format!("{}:/data/a", link.display()), format!("{}/sync/new:/data/b", link.display())];
            for m in &refused {
                let err = validate_extra_mounts(std::slice::from_ref(m)).unwrap_err();
                assert!(err.contains("Termic's data folder"), "{m}: {err}");
            }
            assert!(extra_containers(&refused).is_empty());
            // The control: the same link pointed elsewhere is an ordinary mount.
            std::fs::remove_file(&link).unwrap();
            std::os::unix::fs::symlink(outside.path(), &link).unwrap();
            assert_eq!(validate_extra_mounts(&refused[..1]), Ok(()));
        });
    }

    #[test]
    fn task_extra_mounts_cannot_shadow_the_agent_config_dir_mount() {
        let task = stub_task("t12", "/tmp/termic-docker-test-does-not-exist-12");
        let env = std::collections::HashMap::new();
        let extras = vec!["/tmp/whatever:/root/.claude".to_string()];
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &extras, "pty-aaaa1111", "claude", &[], None);
        let claude_mounts: Vec<&str> = spec
            .mounts
            .iter()
            .filter(|m| m.container == "/root/.claude")
            .map(|m| m.host.as_str())
            .collect();
        assert_eq!(claude_mounts.len(), 1, "{claude_mounts:?}");
        assert_ne!(claude_mounts[0], "/tmp/whatever");
    }

    #[test]
    fn user_extra_dirs_are_mounted_alongside_the_builtin_ones() {
        // copilot is KNOWN_SAFE_AGENTS - its extras are always mounted
        // regardless of persist_enabled, which only gates non-builtin agents.
        let task = stub_task("t5", "/tmp/termic-docker-test-does-not-exist-5");
        let env = std::collections::HashMap::new();
        let extras = vec![".mytool".to_string(), "../escape".to_string(), "/etc".to_string()];
        let spec = build_spec(&task, "copilot", "img", &task.path, vec![], &env, &extras, false, &[], &[], "pty-aaaa1111", "copilot", &[], None);
        let mounted: Vec<&str> = spec.mounts.iter().map(|m| m.container.as_str()).collect();
        assert!(mounted.contains(&"/root/.copilot"), "{mounted:?}");
        assert!(mounted.contains(&"/root/.mytool"), "{mounted:?}");
        // The two unsafe entries never became mounts at all.
        assert!(!mounted.iter().any(|m| m.contains("escape") || *m == "/etc"), "{mounted:?}");
    }

    #[test]
    fn grok_stays_blocked_even_with_persist_enabled_and_extra_dirs() {
        // The one permanent exception: opting in can never resurrect grok,
        // because its binary lives inside its own config dir (~/.grok/bin)
        // and an opt-in mount would silently shadow it - see agent_config's
        // doc comment.
        let task = stub_task("t6", "/tmp/termic-docker-test-does-not-exist-6");
        let env = std::collections::HashMap::new();
        let extras = vec![".grok".to_string()];
        let spec = build_spec(&task, "grok", "img", &task.path, vec![], &env, &extras, true, &[], &[], "pty-aaaa1111", "grok", &[], None);
        assert!(!spec.mounts.iter().any(|m| m.container.contains("grok")));
        assert!(!persist_offerable("grok"));
    }

    #[test]
    fn custom_agent_extra_dirs_need_persist_enabled_to_mount() {
        let task = stub_task("t7", "/tmp/termic-docker-test-does-not-exist-7");
        let env = std::collections::HashMap::new();
        let extras = vec![".mytool".to_string()];
        // Off by default: an unrecognized agent id with extras configured
        // but the opt-in switch still off mounts nothing at all.
        let off = build_spec(&task, "my-custom-agent", "img", &task.path, vec![], &env, &extras, false, &[], &[], "pty-aaaa1111", "my-custom-agent", &[], None);
        assert!(off.mounts.iter().all(|m| !m.container.contains("mytool")));

        // Once opted in, the user's own dirs become the mount (there is no
        // confirmed built-in dir to fall back on for an agent this module
        // has never seen).
        let on = build_spec(&task, "my-custom-agent", "img", &task.path, vec![], &env, &extras, true, &[], &[], "pty-aaaa1111", "my-custom-agent", &[], None);
        let mounted: Vec<&str> = on.mounts.iter().map(|m| m.container.as_str()).collect();
        assert!(mounted.contains(&"/root/.mytool"), "{mounted:?}");
    }

    #[test]
    fn custom_agent_persist_enabled_with_no_dirs_mounts_nothing() {
        let task = stub_task("t8", "/tmp/termic-docker-test-does-not-exist-8");
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "my-custom-agent", "img", &task.path, vec![], &env, &[], true, &[], &[], "pty-aaaa1111", "my-custom-agent", &[], None);
        // Only the always-there worktree/.git mounts - no agent config dir.
        assert!(spec.mounts.iter().all(|m| !m.why.contains("Docker agent")));
    }

    #[test]
    fn live_allowed_paths_are_mounted_at_their_own_absolute_path() {
        // The task's live sandbox allow-list (lib.rs's live_sandbox_lists -
        // global Settings + task pin + .termic.yaml) used to be completely
        // invisible to Docker mode. It's now mounted the same way Seatbelt
        // allows it: at its own resolved path, unified across both engines.
        // A REAL directory: `docker run -v` cannot mount a path that is not
        // there, so only existing entries are staged (see the next case).
        let shared = tempfile::tempdir().unwrap();
        let shared_path = shared.path().to_string_lossy().into_owned();
        let task = stub_task("t9", "/tmp/termic-docker-test-does-not-exist-9");
        let env = std::collections::HashMap::new();
        let allowed = vec![shared_path.clone()];
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &allowed, &[], "pty-aaaa1111", "claude", &[], None);
        let mounted: Vec<String> = spec.mounts.iter().map(|m| m.container.clone()).collect();
        let canon = in_container(&canonicalize_or_keep(&shared_path));
        assert!(mounted.contains(&canon), "{mounted:?}");
    }

    /// A real repo with the identity set LOCALLY, so what these tests read is
    /// the fixture's and never the developer's own global git config.
    fn repo_with_local_identity(name: &str, email: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .output()
                .expect("git must be on PATH");
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q"]);
        git(&["config", "--local", "user.name", name]);
        git(&["config", "--local", "user.email", email]);
        dir
    }

    fn spec_for(task: &Task, env: &std::collections::HashMap<String, String>) -> DockerSpec {
        build_spec(task, "claude", "img", &task.path, vec![], env, &[], false, &[], &[],
            "pty-gitid001", "claude", &[], None)
    }

    #[test]
    fn the_identity_file_carries_only_the_keys_the_host_actually_has() {
        // Nothing to say means no file at all, so a host with no identity
        // gets no mount and no line in the preview explaining one.
        assert_eq!(git_identity_config(None, None), None);
        let only_name = git_identity_config(Some("Ada"), None).unwrap();
        assert!(only_name.contains("name = \"Ada\""), "{only_name}");
        assert!(!only_name.contains("email"), "{only_name}");
        // Quoted and escaped: `#` starts a comment in git config and a bare
        // quote would truncate the value, so a legal name has to survive
        // verbatim rather than land as something else.
        let odd = git_identity_config(Some("A \"B\" \\C #1"), Some("a@b.c")).unwrap();
        assert!(odd.contains("name = \"A \\\"B\\\" \\\\C #1\""), "{odd}");
        // A newline cannot be represented on one line, so it is dropped
        // rather than allowed to inject a second key.
        assert_eq!(git_identity_config(Some("x\ncore.pager = sh"), None), None);
    }

    #[test]
    fn the_host_git_identity_is_mounted_at_gits_global_level() {
        with_scratch_data_dir(|| {
            let repo = repo_with_local_identity("Ada Lovelace", "ada@example.com");
            let task = stub_task("t-git-id", &repo.path().to_string_lossy());
            let spec = spec_for(&task, &std::collections::HashMap::new());
            let m = spec.mounts.iter().find(|m| m.container == "/root/.config/git/config")
                .expect("the host identity must reach the container");
            assert!(m.read_only, "termic is the only writer of this file");
            let body = std::fs::read_to_string(&m.host).unwrap();
            assert!(body.contains("Ada Lovelace") && body.contains("ada@example.com"), "{body}");

            // NEVER over `/root/.gitconfig`. That file is the image's, and it
            // carries `safe.directory = *` (without which git refuses every
            // command in the bind-mounted worktree as "dubious ownership")
            // plus the gh/glab credential helpers that make `git push` work.
            // Shadowing it is the obvious reading of "mount my gitconfig" and
            // it breaks the container in two ways at once.
            assert!(!spec.mounts.iter().any(|m| m.container == "/root/.gitconfig"));

            // And never as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`/`GIT_CONFIG_*`
            // env, which is the tempting shortcut: those sit ABOVE repo-local
            // config, so they would silently rewrite the identity of every
            // repo that deliberately sets its own. The mounted file sits
            // below it instead, which is the whole point of this feature.
            assert!(!spec.env.iter().any(|(k, _)| k.starts_with("GIT_AUTHOR")
                || k.starts_with("GIT_COMMITTER") || k.starts_with("GIT_CONFIG")),
                "{:?}", spec.env);
        });
    }

    #[test]
    fn an_identity_reached_through_an_include_is_resolved() {
        // `[includeIf "gitdir:~/work/"]` is how people keep a work identity
        // separate from a personal one, and reading `~/.gitconfig` directly
        // would miss it entirely. The read is repo-scoped precisely so git
        // resolves the whole chain itself; a plain `include.path` exercises
        // that same include machinery without touching the developer's HOME.
        with_scratch_data_dir(|| {
            let repo = repo_with_local_identity("Personal", "personal@example.com");
            let included = repo.path().join("work-identity");
            std::fs::write(&included, "[user]\n\tname = Work Identity\n\temail = work@example.com\n").unwrap();
            let out = std::process::Command::new("git")
                .args(["config", "--local", "include.path", &included.to_string_lossy()])
                .current_dir(repo.path())
                .output()
                .unwrap();
            assert!(out.status.success());
            let task = stub_task("t-git-inc", &repo.path().to_string_lossy());
            let spec = spec_for(&task, &std::collections::HashMap::new());
            let m = spec.mounts.iter().find(|m| m.container == "/root/.config/git/config").unwrap();
            let body = std::fs::read_to_string(&m.host).unwrap();
            assert!(body.contains("work@example.com"), "the included identity is the one git resolves: {body}");
        });
    }

    #[test]
    fn a_gone_task_path_reads_the_identity_from_home_instead() {
        // The SETTINGS-level command preview builds from a sample task whose
        // path is a placeholder that does not exist, and it promises the
        // reader that everything but the worktree path is what a real launch
        // uses. A repo-scoped read against that path fails, so without this
        // fallback the git identity would be the one mount missing from the
        // one panel whose whole job is showing what gets mounted.
        let gone = std::path::Path::new("/tmp/termic-docker-test-does-not-exist-git");
        let home = repo_with_local_identity("Fallback Home", "fallback@example.com");
        let (name, email) = read_git_identity(gone, home.path());
        assert_eq!(name.as_deref(), Some("Fallback Home"));
        assert_eq!(email.as_deref(), Some("fallback@example.com"));

        // And when there is nothing to find in either place, there is nothing
        // to mount: no empty file, no half-answer.
        let nowhere = std::path::Path::new("/tmp/termic-docker-test-also-not-here-git");
        assert_eq!(read_git_identity(gone, nowhere), (None, None));
    }

    #[test]
    fn the_placeholder_preview_task_still_shows_the_identity_line() {
        // Same guarantee as above, asserted where it is actually made: the
        // spec the settings preview renders. Skipped on a machine with no git
        // identity at all, which is the one case where there is correctly
        // nothing to show (and which the warning below covers instead).
        let home = dirs::home_dir().unwrap_or_default();
        let (n, e) = read_git_identity(&home, &home);
        if n.is_none() && e.is_none() {
            return;
        }
        with_scratch_data_dir(|| {
            let task = stub_task("sample", "/path/to/your/task-worktree");
            let spec = spec_for(&task, &std::collections::HashMap::new());
            assert!(spec.mounts.iter().any(|m| m.container == "/root/.config/git/config"),
                "the settings preview must show this mount like every other one: {:?}", spec.mounts);
            // Same narrowing as `a_config_dir_inside_a_mount_is_left_alone`:
            // the no-identity warning is a property of the MACHINE, and this
            // test is about the mount. A runner without a git identity is a
            // legitimate environment, not a failure.
            let unrelated: Vec<&String> = spec.warnings.iter()
                .filter(|w| !w.contains("No git identity found"))
                .collect();
            assert!(unrelated.is_empty(), "{unrelated:?}");
        });
    }

    #[test]
    fn the_identity_follows_a_relocated_xdg_config_home_but_not_into_a_system_dir() {
        with_scratch_data_dir(|| {
            let repo = repo_with_local_identity("Ada", "ada@example.com");
            // An agent that relocates XDG_CONFIG_HOME (Settings -> Agents,
            // per-agent env) sends git looking somewhere else, and a file at
            // the default path would simply never be read. Follow the value
            // rather than re-asserting our own, which would break a
            // relocation someone chose on purpose.
            let task = stub_task("t-git-xdg", &repo.path().to_string_lossy());
            let mut env = std::collections::HashMap::new();
            env.insert("XDG_CONFIG_HOME".to_string(), "/root/.myconf".to_string());
            let spec = spec_for(&task, &env);
            assert!(spec.mounts.iter().any(|m| m.container == "/root/.myconf/git/config"),
                "{:?}", spec.mounts);

            // But it is still a user-supplied string landing in a mount
            // TARGET, so it gets the same guard every other one gets: an
            // `XDG_CONFIG_HOME` of `/etc` must not become a mount over
            // `/etc/git/config`.
            let mut hostile = std::collections::HashMap::new();
            hostile.insert("XDG_CONFIG_HOME".to_string(), "/etc".to_string());
            let spec = spec_for(&task, &hostile);
            assert!(!spec.mounts.iter().any(|m| m.container.ends_with("/git/config")),
                "{:?}", spec.mounts);
        });
    }

    /// Dockerfile provenance, all four scenarios in ONE test on purpose.
    ///
    /// `global_dir()` is chosen by `TERMIC_DATA_DIR`, which is process-wide, and
    /// cargo runs tests in parallel threads: four separate tests each setting
    /// it raced and read each other's Dockerfile. One sequential test is the
    /// honest fix; a mutex would only hide the sharing from the reader.
    #[test]
    fn muse_sessions_are_mounted_so_they_survive_a_container() {
        // A container is `--rm`, so anything muse writes outside a mount is
        // gone the moment the task stops, and `resume` has nothing to find.
        // Its sessions live under `.local/share/muse/sessions/`, which is the
        // SECOND state dir: the first becomes the primary config mount and the
        // rest are mounted alongside it, so both have to be listed or the one
        // that matters silently is not there.
        assert_eq!(
            crate::agent_dirs::state_dirs("muse"),
            &[".config/muse", ".local/share/muse"],
        );
        let cfg = agent_config("muse", &[], false).expect("muse is a known-safe agent");
        assert_eq!(cfg.container_dir, "/root/.config/muse");
        assert!(
            cfg.extra_dirs.contains(&"/root/.local/share/muse".to_string()),
            "sessions dir is not mounted: {:?}", cfg.extra_dirs,
        );
        // And it maps to a stable host path under termic's own agent folder,
        // which is what makes it persist ACROSS containers rather than merely
        // outliving one.
        assert_eq!(host_subpath_for("/root/.local/share/muse"), "local/share/muse");
    }

    #[test]
    fn dockerfile_provenance_survives_a_new_shipped_default() {
        // Through `with_scratch_data_dir`, which is the ONLY way to redirect
        // `TERMIC_DATA_DIR`. Setting it here directly took no lock, so this
        // test raced every other one that redirects it: another test's
        // scratch dir would land under this one's feet between a write and
        // the read that checks it, and `read_dockerfile` then answered with
        // the shipped default for a file it could no longer find. It failed
        // on CI and never on a developer's machine, because the window is a
        // function of how slow the other test's filesystem work is.
        //
        // The pid-named directory was the other half of the same mistake: two
        // concurrent runs on one machine share it. See test_support.rs.
        with_scratch_data_dir(|| {
        let old_default = "FROM node:lts-bookworm\n# an older shipped file\n";

        // 1. THE bug. `is_default` used to be `saved == DEFAULT_DOCKERFILE`, so
        //    shipping a new default reported every untouched Dockerfile as the
        //    user's own work and offered "Reset to default" as the only way
        //    out - the one button someone who HAD customised must not press.
        write_dockerfile(old_default).unwrap();
        write_origin(old_default);
        assert!(!dockerfile_is_customised(), "never edited, so not customised");
        assert_eq!(read_dockerfile(), DEFAULT_DOCKERFILE, "an unedited file upgrades in place");
        assert!(!dockerfile_is_customised(), "and is still not customised after it");

        // 2. An edited file is never overwritten, and keeps saying so.
        let mine = format!("{old_default}RUN npm install -g my-own-tool\n");
        write_origin(old_default);
        write_dockerfile(&mine).unwrap();
        assert!(dockerfile_is_customised());
        assert_eq!(read_dockerfile(), mine, "the user's edits survive an upgrade");
        assert!(dockerfile_is_customised());

        // 3. Reset clears the flag, or a customised file stays flagged forever.
        write_dockerfile(DEFAULT_DOCKERFILE).unwrap();
        assert!(!dockerfile_is_customised(), "a reset must not stay flagged");

        // 4. The blunt instrument: no provenance at all (a profile predating
        //    this) is swept, because nothing there distinguishes a user edit
        //    from an older termic's write.
        std::fs::remove_file(dockerfile_origin_path()).unwrap();
        write_dockerfile("FROM scratch\n# entirely mine\n").unwrap();
        let _ = std::fs::remove_file(dockerfile_origin_path());
        assert_eq!(read_dockerfile(), DEFAULT_DOCKERFILE, "swept to the shipped default");
        assert!(!dockerfile_is_customised());
        });
    }

    #[test]
    fn a_stale_allowed_path_is_skipped_instead_of_failing_the_whole_run() {
        // Seatbelt tolerates an allow-list entry whose directory is long
        // gone - it is just a rule that never matches - so these lists
        // accumulate paths from deleted projects. `docker run -v` does not:
        // one missing host path fails the entire run with an opaque daemon
        // error, which would make EVERY Docker task in that config
        // unlaunchable because of a directory nobody has needed for months.
        let gone = "/tmp/termic-docker-test-definitely-not-here-9f3a2b";
        assert!(!std::path::Path::new(gone).exists(), "fixture assumption");
        let task = stub_task("t9b", "/tmp/termic-docker-test-does-not-exist-9b");
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false,
            &[gone.to_string()], &[], "pty-aaaa1111", "claude", &[], None);
        assert!(!spec.mounts.iter().any(|m| m.host == gone),
            "a vanished allow-list entry must not become a -v flag");
    }

    #[test]
    fn live_allowed_paths_skip_regex_entries_and_dedupe_against_implicit_mounts() {
        let task = stub_task("t10", "/tmp/termic-docker-test-does-not-exist-10");
        let env = std::collections::HashMap::new();
        // A regex: entry (Seatbelt-only, no literal path) and the task's own
        // path (already mounted implicitly as step 1) should both be no-ops.
        let allowed = vec!["regex:^$HOME/\\.foo$".to_string(), task.path.clone()];
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &allowed, &[], "pty-aaaa1111", "claude", &[], None);
        let host_paths: Vec<&str> = spec.mounts.iter().map(|m| m.host.as_str()).collect();
        // No stray mount was added for either entry - just the one implicit
        // worktree mount already covering task.path.
        let task_path_count = host_paths.iter().filter(|p| **p == task.path).count();
        assert_eq!(task_path_count, 1, "{host_paths:?}");
        assert!(!host_paths.iter().any(|p| p.contains("regex:") || p.contains("\\.foo")), "{host_paths:?}");
    }

    // ── Activity monitor integration ──────────────────────────────────

    #[test]
    fn byte_size_parses_binary_and_decimal_units() {
        assert_eq!(parse_byte_size("12.3MiB"), Some((12.3 * 1024.0 * 1024.0) as u64));
        assert_eq!(parse_byte_size("1.943GiB"), Some((1.943 * 1024.0 * 1024.0 * 1024.0) as u64));
        assert_eq!(parse_byte_size("500B"), Some(500));
        assert_eq!(parse_byte_size("2GB"), Some(2_000_000_000));
        assert_eq!(parse_byte_size("garbage"), None);
    }

    #[test]
    fn mem_usage_takes_the_used_half_before_the_slash() {
        assert_eq!(parse_mem_usage("10MiB / 1.9GiB"), parse_byte_size("10MiB"));
    }

    #[test]
    fn stats_line_parses_dockers_actual_column_order() {
        let (name, s) = parse_stats_line("termic-abc123\t3.14%\t10MiB / 1.9GiB\t7")
            .expect("valid line");
        assert_eq!(name, "termic-abc123");
        assert!((s.cpu_pct - 3.14).abs() < 1e-9);
        assert_eq!(s.mem_bytes, parse_byte_size("10MiB").unwrap());
        assert_eq!(s.pids, 7);
    }

    #[test]
    fn stats_line_rejects_a_short_row() {
        assert!(parse_stats_line("termic-abc123\t3.14%").is_none());
    }

    fn stub_row(key: &str) -> ProcRow {
        ProcRow {
            key: key.to_string(),
            kind: "claude".into(),
            pty_id: Some(key.to_string()),
            task_id: None,
            tab_id: None,
            pid: 4242,
            label: "docker".into(),
            cpu_pct: Some(0.0),
            mem_bytes: 1234,
            rss_bytes: 1234,
            proc_count: 1,
            threads: 1,
            cpu_ms: 0,
            uptime_ms: 0,
            out_bps: None,
            alive: true,
            cpu_history: vec![],
            children: vec![crate::procmon::ChildRow {
                pid: 4242,
                label: "docker".into(),
                cpu_pct: Some(0.0),
                mem_bytes: 1234,
            }],
            is_docker: false,
        }
    }

    #[test]
    fn merge_stats_is_a_noop_with_no_docker_rows() {
        let snap = Snapshot {
            session: 1,
            unix_ms: 0.0,
            rows: vec![stub_row("pty:1")],
            sample_ms: 0.0,
            webkit_unavailable: false,
        };
        let out = merge_stats(snap, &HashMap::new());
        assert!(!out.rows[0].is_docker);
        assert_eq!(out.rows[0].mem_bytes, 1234);
    }

    #[test]
    fn apply_overwrites_row_and_clears_the_host_children() {
        let mut row = stub_row("pty:1");
        let mut hist = HashMap::new();
        let stats = ContainerStats { cpu_pct: 42.0, mem_bytes: 999, pids: 3 };
        apply(&mut row, Some(&stats), &mut hist, 90);
        assert!(row.is_docker);
        assert!(row.children.is_empty());
        assert_eq!(row.cpu_pct, Some(42.0));
        assert_eq!(row.mem_bytes, 999);
        assert_eq!(row.rss_bytes, 999);
        assert_eq!(row.proc_count, 3);
        assert_eq!(row.cpu_history, vec![42.0]);
    }

    #[test]
    fn apply_keeps_last_known_numbers_on_a_transient_miss() {
        let mut row = stub_row("pty:1");
        row.mem_bytes = 555;
        let mut hist = HashMap::new();
        apply(&mut row, None, &mut hist, 90);
        // Still marked as a Docker row (children cleared) even though this
        // particular tick could not reach the daemon.
        assert!(row.is_docker);
        assert!(row.children.is_empty());
        assert_eq!(row.mem_bytes, 555);
        assert!(row.cpu_history.is_empty());
    }

    #[test]
    fn apply_caps_history_at_the_configured_length() {
        let mut row = stub_row("pty:1");
        let mut hist = HashMap::new();
        for i in 0..5 {
            let stats = ContainerStats { cpu_pct: i as f64, mem_bytes: 1, pids: 1 };
            apply(&mut row, Some(&stats), &mut hist, 3);
        }
        assert_eq!(row.cpu_history, vec![2.0, 3.0, 4.0]);
    }

    #[test]
    fn windows_paths_map_to_a_stable_linux_path() {
        assert_eq!(windows_to_container(r"C:\Users\u\repo"), "/c/Users/u/repo");
        assert_eq!(windows_to_container(r"\\?\D:\wt\api"), "/d/wt/api");
        assert_eq!(windows_to_container("C:/Users/u"), "/c/Users/u");
        assert_eq!(windows_to_container(r"C:\"), "/c");
        // Already a POSIX path: unchanged.
        assert_eq!(windows_to_container("/root/.claude"), "/root/.claude");
    }

    #[test]
    fn a_windows_extra_mount_splits_at_the_last_colon() {
        // `C:\data:/data`: the drive colon must not be taken as the split.
        let host = std::env::temp_dir();
        let raw = format!("{}:/data/mcp", host.display());
        let got = sanitize_extra_mount(&raw, "/Users/x", "/tmp/task").expect("a valid pair");
        assert_eq!(got.1, "/data/mcp");
    }

    #[test]
    fn the_windows_git_settings_keep_repo_local_config_in_charge() {
        let c = windows_container_git_config(Some("true\n"));
        assert!(c.contains("[gc]") && c.contains("auto = 0") && c.contains("worktreePruneExpire = never"), "{c}");
        assert!(c.contains("autocrlf = true"), "{c}");
        // Anything that is not a real autocrlf value is dropped, not written.
        assert!(!windows_container_git_config(Some("yes\n[x]")).contains("autocrlf"));
    }
}
