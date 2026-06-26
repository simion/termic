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
// Design: docs/plans/docker-sandbox/design.md

use crate::sandbox::{canonicalize_or_keep, parent_git_dir_for_worktree};
use crate::{data_dir, Workspace};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::Command;

/// Tag prefix for every image we build. Cleanup and listing filter on this.
const IMAGE_REPO: &str = "termic-sandbox";
/// Label key stamped on every container we run, so cleanup can find them
/// robustly even if the `--name` was munged.
const LABEL_KEY: &str = "termic.workspace";

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

// ───────────────────────────── Spec ────────────────────────────────────

/// Everything needed to render one `docker run` invocation for a workspace
/// agent spawn. Produced by `build_spec`; rendered to argv by `render_argv`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DockerSpec {
    /// `termic-{workspaceId}` (stable, human-facing).
    pub container_name: String,
    /// `termic.workspace={workspaceId}` — what cleanup filters on.
    pub label: String,
    /// `termic-sandbox:{dockerfileHash}`.
    pub image: String,
    /// host -> container bind mounts (rw/ro), with provenance + why.
    pub mounts: Vec<Mount>,
    /// Working dir inside the container — MUST equal the host cwd (same
    /// absolute path) so the worktree `.git` pointer + session cwd-key line up.
    pub workdir: String,
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
    container_dir: &'static str,
    /// `Some((VAR, value))` when the agent supports a config-dir relocation
    /// env var (claude `CLAUDE_CONFIG_DIR`, codex `CODEX_HOME`).
    relocation_env: Option<(&'static str, &'static str)>,
    /// Extra container dirs to also mount from the same host config dir
    /// (e.g. agy needs `.antigravity` alongside `.gemini`).
    extra_dirs: &'static [&'static str],
}

/// Map an agent id to its config-dir wiring. Returns `None` for agents we
/// don't yet support in Docker mode (grok is the Phase-1 outlier: binary +
/// skills + config all live under ~/.grok, no clean relocation env).
fn agent_config(agent_id: &str) -> Option<AgentConfig> {
    Some(match agent_id {
        "claude" => AgentConfig {
            container_dir: "/root/.claude",
            relocation_env: Some(("CLAUDE_CONFIG_DIR", "/root/.claude")),
            extra_dirs: &[],
        },
        "codex" => AgentConfig {
            container_dir: "/root/.codex",
            relocation_env: Some(("CODEX_HOME", "/root/.codex")),
            extra_dirs: &[],
        },
        "gemini" => AgentConfig {
            container_dir: "/root/.gemini",
            relocation_env: None,
            extra_dirs: &[],
        },
        "copilot" => AgentConfig {
            container_dir: "/root/.copilot",
            relocation_env: None,
            extra_dirs: &[],
        },
        // agy shares the `.gemini` config shape + its own `.antigravity`.
        // Its binary lives in ~/.local/bin — do NOT mount ~/.local.
        "agy" | "antigravity" => AgentConfig {
            container_dir: "/root/.gemini",
            relocation_env: None,
            extra_dirs: &["/root/.antigravity"],
        },
        // grok deferred from Phase 1 (see design.md "outlier").
        _ => return None,
    })
}

/// Host directory that persists an agent's login + sessions + MCP config
/// ACROSS every Docker workspace of that agent. The sameness of this path
/// IS the cross-workspace sharing. termic-owned, never the host's real
/// `~/.claude` (full isolation from the OS agent).
pub fn agent_config_host_dir(agent_id: &str) -> PathBuf {
    // `data_dir()` already respects the dev/prod (`termic_dev`/`termic`)
    // split, so dev and release don't share login state.
    let base = data_dir()
        .map(|d| d.join("docker-agents"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/termic-docker-agents"));
    base.join(agent_id)
}

// ──────────────────────────── build_spec ───────────────────────────────

/// Build the full `DockerSpec` for a workspace agent spawn. `cmd`/`args`
/// are the agent argv (unchanged from the Seatbelt path); `cwd` is the
/// host working dir (mounted + `-w` at the identical absolute path).
pub fn build_spec(
    ws: &Workspace,
    agent_id: &str,
    image: &str,
    cwd: &str,
    extra_args: Vec<String>,
) -> DockerSpec {
    let mut mounts: Vec<Mount> = Vec::new();

    // 1. The worktree itself, at the SAME absolute path inside the
    //    container (required for the worktree `.git` pointer + session
    //    cwd-key to resolve).
    let ws_path = canonicalize_or_keep(&ws.path);
    mounts.push(Mount::implicit(
        ws_path.clone(),
        ws_path.clone(),
        false,
        "your code (the workspace)",
        true,
    ));

    // 2. Parent `.git` for a worktree (pointer file holds an absolute
    //    path into <parent>/.git/worktrees/<name>). Same-path mount or git
    //    breaks. Reuses the exact Seatbelt logic.
    if let Some(parent_git) = parent_git_dir_for_worktree(&ws.path) {
        mounts.push(Mount::implicit(
            parent_git.clone(),
            parent_git,
            false,
            "git metadata, required for worktrees to work",
            true,
        ));
    }

    // 3. Composition members (linked repos in a multi-repo workspace),
    //    each at its identical absolute path.
    for m in &ws.composition {
        if m.path.is_empty() {
            continue;
        }
        let p = canonicalize_or_keep(&m.path);
        if p == ws_path {
            continue; // host member == workspace wrapper, already mounted
        }
        mounts.push(Mount::implicit(
            p.clone(),
            p,
            false,
            "linked repo in this workspace",
            true,
        ));
        if let Some(parent_git) = parent_git_dir_for_worktree(&m.path) {
            mounts.push(Mount::implicit(
                parent_git.clone(),
                parent_git,
                false,
                "git metadata for a linked repo",
                true,
            ));
        }
    }

    // 4. The persistent per-agent config dir (login + sessions + MCP +
    //    customizations), shared across all Docker workspaces of this
    //    agent. rw. Plus relocation env if the agent supports it.
    let mut env: Vec<(String, String)> = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
    ];
    if let Some(cfg) = agent_config(agent_id) {
        let host_cfg = agent_config_host_dir(agent_id).to_string_lossy().into_owned();
        mounts.push(Mount::implicit(
            host_cfg.clone(),
            cfg.container_dir.to_string(),
            false,
            "your Docker agent: login, MCP servers, settings, history (shared across all your Docker workspaces)",
            false,
        ));
        for extra in cfg.extra_dirs {
            // Extra dirs share the same host config dir subtree by name.
            let sub = PathBuf::from(&host_cfg)
                .join(extra.trim_start_matches("/root/."))
                .to_string_lossy()
                .into_owned();
            mounts.push(Mount::implicit(
                sub,
                extra.to_string(),
                false,
                "additional config dir for this agent",
                false,
            ));
        }
        if let Some((var, val)) = cfg.relocation_env {
            env.push((var.to_string(), val.to_string()));
        }
    }

    DockerSpec {
        container_name: format!("termic-{}", ws.id),
        label: format!("{LABEL_KEY}={}", ws.id),
        image: image.to_string(),
        mounts,
        workdir: canonicalize_or_keep(cwd),
        env,
        extra_args,
    }
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
    argv.extend(spec.extra_args.iter().cloned());
    argv.push(spec.image.clone());
    argv.push(cmd.to_string());
    argv.extend(args.iter().cloned());
    argv
}

/// Pretty-print the argv for the dialog's command-preview pane: multi-line,
/// one flag/mount per line with `\` continuations, copy-paste-runnable, and
/// a trailing `# why` comment on each mount line. Display sugar only — the
/// spawned argv comes from `render_argv`, unchanged.
pub fn render_preview(spec: &DockerSpec, cmd: &str, args: &[String]) -> String {
    let mut lines: Vec<String> = vec!["docker run --rm -it \\".into()];
    lines.push(format!("  --name {} \\", spec.container_name));
    lines.push(format!("  --label {} \\", spec.label));
    for m in &spec.mounts {
        let suffix = if m.read_only { ":ro" } else { "" };
        lines.push(format!(
            "  -v {}:{}{} \\{}",
            m.host,
            m.container,
            suffix,
            format!("   # {}", m.why),
        ));
    }
    lines.push(format!("  -w {} \\", spec.workdir));
    for (k, v) in &spec.env {
        lines.push(format!("  -e {k}={v} \\"));
    }
    for ea in &spec.extra_args {
        lines.push(format!("  {ea} \\"));
    }
    lines.push(format!("  {} \\", spec.image));
    let agent_line = if args.is_empty() {
        cmd.to_string()
    } else {
        format!("{cmd} {}", args.join(" "))
    };
    lines.push(format!("  {agent_line}"));
    lines.join("\n")
}

// ─────────────────────── Dockerfile storage ────────────────────────────

/// Directory holding the editable Dockerfile + build metadata.
fn docker_dir() -> PathBuf {
    data_dir()
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

/// Read the current Dockerfile, falling back to (and persisting) the
/// shipped default on first run / missing file.
pub fn read_dockerfile() -> String {
    let path = dockerfile_path();
    match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => s,
        _ => {
            let _ = write_dockerfile(DEFAULT_DOCKERFILE);
            DEFAULT_DOCKERFILE.to_string()
        }
    }
}

/// Persist an edited Dockerfile.
pub fn write_dockerfile(contents: &str) -> Result<(), String> {
    let dir = docker_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("Dockerfile"), contents).map_err(|e| e.to_string())
}

// ──────────────────────────── Image build ──────────────────────────────

/// Build the image from the given Dockerfile. Blocking + IO-heavy — the
/// command layer MUST run this on a background thread (never on the
/// synchronous Tauri command path, which would freeze the webview). The
/// spawn path NEVER calls this; build is an explicit Settings action.
///
/// `no_cache` => `--no-cache --pull` ("Update agents": refresh the LTS base
/// and re-fetch the unpinned agents). Returns the built tag on success, or
/// the combined build log on failure.
pub fn build_image(dockerfile: &str, no_cache: bool) -> Result<String, String> {
    let (mut cmd, tag) = build_command(dockerfile, no_cache)?;
    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "docker binary not found".to_string()
        } else {
            e.to_string()
        }
    })?;
    if output.status.success() {
        Ok(tag)
    } else {
        let mut log = String::from_utf8_lossy(&output.stdout).into_owned();
        log.push_str(&String::from_utf8_lossy(&output.stderr));
        Err(log)
    }
}

/// Construct the `docker build` Command + the tag it will produce, writing
/// the Dockerfile to disk first. The caller drives execution (the command
/// layer streams its output line-by-line off a background thread; never on
/// the synchronous Tauri path). `no_cache` => `--no-cache --pull`.
pub fn build_command(dockerfile: &str, no_cache: bool) -> Result<(Command, String), String> {
    let tag = image_tag(dockerfile);
    let dir = docker_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let df_path = dir.join("Dockerfile");
    std::fs::write(&df_path, dockerfile).map_err(|e| e.to_string())?;

    let mut cmd = Command::new("docker");
    // --progress=plain so the streamed log is line-based (not a TTY redraw).
    cmd.args(["build", "--progress=plain", "-t", &tag, "-f"]);
    cmd.arg(&df_path);
    if no_cache {
        cmd.args(["--no-cache", "--pull"]);
    }
    // Build context is the docker dir (lets users `COPY` baked skills etc.
    // from a path they control next to the Dockerfile).
    cmd.arg(&dir);
    Ok((cmd, tag))
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
    let version = Command::new("docker")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let binary = version.is_some();
    let daemon = binary
        && Command::new("docker")
            .arg("info")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    DockerStatus { binary, daemon, version }
}

/// Does an image with this tag already exist locally? (Drives dropdown
/// availability + the "not built / rebuild" Settings state.)
pub fn image_exists(tag: &str) -> bool {
    Command::new("docker")
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

/// Record a successfully built tag.
pub fn record_built_tag(tag: &str) {
    let _ = std::fs::create_dir_all(docker_dir());
    let _ = std::fs::write(last_built_file(), tag);
}

/// The tag of the last successful build, if any.
pub fn last_built_tag() -> Option<String> {
    std::fs::read_to_string(last_built_file())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
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
    /// Whether Docker mode should be offered in the workspace dropdown at
    /// all (a usable built image exists).
    pub available: bool,
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
        is_default: dockerfile == DEFAULT_DOCKERFILE,
        // Dropdown availability: any usable built image (current OR the
        // last-built one we keep around after an edit).
        available: current_built || last_built_exists,
        last_built_tag: last,
        last_built_exists,
        stale,
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

/// `docker rm -f` every container labeled for this workspace. Non-fatal.
pub fn cleanup_workspace(ws_id: &str) {
    rm_by_filter(&format!("label={LABEL_KEY}={ws_id}"));
}

/// `docker rm -f` every termic-labeled container (app quit). Non-fatal.
pub fn cleanup_all() {
    rm_by_filter(&format!("label={LABEL_KEY}"));
}

fn rm_by_filter(filter: &str) {
    let ids = Command::new("docker")
        .args(["ps", "-aq", "--filter", filter])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    for id in ids.lines().filter(|l| !l.trim().is_empty()) {
        let _ = Command::new("docker").args(["rm", "-f", id]).output();
    }
}
