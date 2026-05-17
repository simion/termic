// macOS sandbox-exec (Seatbelt) wrapper for per-workspace agent isolation.
//
// Layered model:
//   1. Outer kernel sandbox via `sandbox-exec -f <profile.sb>` - blocks
//      writes outside the allowlist, blocks all network except a single
//      loopback hop to our local tinyproxy.
//   2. tinyproxy filters that loopback hop against a per-workspace
//      hostname allowlist (regex per line). Anything not allowed → 403.
//
// Both pieces live for the lifetime of the agent PTY: the profile is a
// fresh file under tempdir() with the workspace id, the proxy child is
// owned by the PTY slot and SIGKILL'd alongside it.
//
// Heavily inspired by github.com/simion/dpf_agents - same SBPL skeleton,
// same default deny set for secrets, same proxy-on-loopback approach.

use anyhow::{anyhow, Context, Result};
use std::collections::HashSet;
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use crate::{Project, Workspace};

/// One sandbox instance, scoped to a single PTY spawn. The proxy child
/// is owned here so dropping the bundle SIGKILLs it.
pub struct SandboxBundle {
    /// Absolute path to the rendered .sb profile under TMPDIR.
    pub profile_path: PathBuf,
    /// Filter file fed to tinyproxy via `--config`-generated text.
    pub filter_path: PathBuf,
    /// tinyproxy child. None when we couldn't start it - the caller
    /// downgrades to "filesystem sandbox + no network" rather than
    /// failing the spawn outright.
    pub proxy: Option<ProxyHandle>,
}

pub struct ProxyHandle {
    pub port: u16,
    pub child: Child,
    pub log_path: PathBuf,
}

impl Drop for ProxyHandle {
    fn drop(&mut self) {
        // tinyproxy doesn't have a clean shutdown handshake we need;
        // SIGKILL is fine and matches our PTY lifecycle.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Build a fully-rendered SBPL profile for one workspace. Substitutes
/// $HOME / $WORKSPACE in any user-supplied paths, dedupes against the
/// built-in RW list, applies built-in deny rules AFTER the broad
/// `file-read*` allow so they take precedence.
pub fn render_profile(
    workspace: &Workspace,
    project: &Project,
    proxy_port: u16,
) -> Result<String> {
    let home = dirs::home_dir()
        .ok_or_else(|| anyhow!("no home dir"))?
        .to_string_lossy()
        .into_owned();
    let workspace_path = canonicalize_or_keep(&workspace.path);
    let subst = |p: &str| -> String {
        let mut s = p.replace("$HOME", &home);
        s = s.replace("$WORKSPACE", &workspace_path);
        s
    };

    let mut rw: Vec<String> = builtin_rw_paths(&home, &workspace_path);
    for p in &project.sandbox_rw_paths {
        let s = subst(p);
        if !s.is_empty() { rw.push(s); }
    }
    dedupe(&mut rw);

    let mut deny: Vec<String> = builtin_deny_paths(&home);
    for p in &project.sandbox_deny_paths {
        let s = subst(p);
        if !s.is_empty() { deny.push(s); }
    }
    dedupe(&mut deny);

    let mut out = String::with_capacity(2048);
    out.push_str(SBPL_HEADER);

    out.push_str("\n;; --- Writable subpaths ---\n");
    for p in &rw {
        out.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", sbpl_escape(p)));
    }

    out.push_str("\n;; --- Deny carve-outs for secrets (applied AFTER the broad reads) ---\n");
    for p in &deny {
        out.push_str(&format!("(deny file-read*  (subpath \"{}\"))\n", sbpl_escape(p)));
        out.push_str(&format!("(deny file-write* (subpath \"{}\"))\n", sbpl_escape(p)));
    }

    out.push_str("\n;; --- Network: only loopback to our tinyproxy ---\n");
    out.push_str("(deny network*)\n");
    out.push_str("(allow network-outbound (literal \"/private/var/run/mDNSResponder\"))\n");
    out.push_str("(allow network-outbound (remote unix-socket))\n");
    out.push_str(&format!(
        "(allow network-outbound (remote ip \"localhost:{proxy_port}\"))\n"
    ));
    out.push_str("(allow network-bind     (local  ip \"localhost:*\"))\n");
    out.push_str("(allow network-inbound  (local  ip \"localhost:*\"))\n");

    Ok(out)
}

/// Built-in writable paths every sandboxed workspace gets. These are
/// the things agents legitimately need to write: their own config
/// directory, the workspace they're working in, TMPDIR. Adding more
/// goes through `Project.sandbox_rw_paths`.
fn builtin_rw_paths(home: &str, workspace_path: &str) -> Vec<String> {
    vec![
        workspace_path.to_string(),
        // macOS TMPDIR resolves into /private/var/folders/...; agents
        // touch it constantly (cache dirs, node_modules tarballs,
        // pip build artifacts).
        "/private/tmp".to_string(),
        "/private/var/folders".to_string(),
        // Agent state dirs.
        format!("{home}/.claude"),
        format!("{home}/.gemini"),
        format!("{home}/.codex"),
        format!("{home}/.config/claude"),
        format!("{home}/.config/gemini"),
        format!("{home}/.local/share/claude"),
        // Package manager caches - npm/pip/cargo all write here on
        // first install. Without these even a `git clone && npm i`
        // breaks in a sandboxed workspace.
        format!("{home}/.npm"),
        format!("{home}/.cache"),
        format!("{home}/.cargo/registry"),
        format!("{home}/Library/Caches"),
    ]
}

/// Hard-deny set for secret material. These ALWAYS apply, even if the
/// user listed them in `sandbox_rw_paths` - last-write-wins in SBPL
/// means the deny rules below cancel any prior allow.
fn builtin_deny_paths(home: &str) -> Vec<String> {
    vec![
        format!("{home}/.ssh"),
        format!("{home}/.aws"),
        format!("{home}/.gnupg"),
        format!("{home}/.netrc"),
        format!("{home}/.docker/config.json"),
        format!("{home}/.kube"),
        format!("{home}/.config/gh/hosts.yml"),
        format!("{home}/Library/Keychains"),
    ]
}

/// Default tinyproxy host allowlist for a workspace, keyed off the
/// agent it runs. We add the API endpoints for that agent's vendor
/// plus a baseline of stuff every dev needs (github + popular package
/// registries). Project's `sandbox_allowed_hosts` are appended on top.
pub fn render_filter(workspace: &Workspace, project: &Project) -> String {
    let mut hosts: Vec<String> = Vec::new();

    // Per-CLI vendor APIs.
    match workspace.cli.as_str() {
        "claude" => hosts.extend([
            r"^api\.anthropic\.com$".into(),
            r"^statsig\.anthropic\.com$".into(),
            r"^console\.anthropic\.com$".into(),
            r"^claude\.ai$".into(),
            r"^code\.claude\.com$".into(),
            r"^.+\.anthropic\.com$".into(),
            r"^.+\.claude\.ai$".into(),
        ]),
        "gemini" => hosts.extend([
            r"^generativelanguage\.googleapis\.com$".into(),
            r"^.+\.googleapis\.com$".into(),
            r"^oauth2\.googleapis\.com$".into(),
            r"^accounts\.google\.com$".into(),
            r"^cloudcode-pa\.googleapis\.com$".into(),
        ]),
        "codex" => hosts.extend([
            r"^api\.openai\.com$".into(),
            r"^chatgpt\.com$".into(),
            r"^.+\.openai\.com$".into(),
            r"^auth\.openai\.com$".into(),
            r"^cdn\.openai\.com$".into(),
        ]),
        _ => { /* custom agents: user must list hosts explicitly */ }
    }

    // Baseline that virtually every dev workflow needs.
    hosts.extend([
        // GitHub.
        r"^github\.com$".into(),
        r"^api\.github\.com$".into(),
        r"^codeload\.github\.com$".into(),
        r"^objects\.githubusercontent\.com$".into(),
        r"^raw\.githubusercontent\.com$".into(),
        r"^.+\.githubusercontent\.com$".into(),
        // Package registries.
        r"^registry\.npmjs\.org$".into(),
        r"^.+\.npmjs\.org$".into(),
        r"^pypi\.org$".into(),
        r"^files\.pythonhosted\.org$".into(),
        r"^.+\.pythonhosted\.org$".into(),
        r"^crates\.io$".into(),
        r"^static\.crates\.io$".into(),
        // CA/TLS lookups (OCSP, CRLs) - if we block these, every TLS
        // handshake the agent makes takes 5s waiting for validation
        // to time out.
        r"^.+\.letsencrypt\.org$".into(),
        r"^.+\.digicert\.com$".into(),
        r"^.+\.amazontrust\.com$".into(),
    ]);

    // Project-specific extras layered on top.
    hosts.extend(project.sandbox_allowed_hosts.iter().cloned());

    dedupe(&mut hosts);
    let mut out = String::from("# Generated by termic sandbox for workspace ");
    out.push_str(&workspace.id);
    out.push('\n');
    for h in &hosts {
        out.push_str(h);
        out.push('\n');
    }
    out
}

/// Spin up tinyproxy bound to a free loopback port, fed the workspace's
/// filter file. Returns the handle on success; on failure logs and
/// returns None so the caller can spawn anyway (with full network deny).
///
/// We invoke tinyproxy with a config-string built inline (passed via
/// `tinyproxy -d -c -`-style isn't supported, so we write a tiny
/// .conf file alongside the filter file in the same tempdir).
pub fn start_proxy(
    workspace_id: &str,
    filter_path: &Path,
    log_path: &Path,
) -> Option<ProxyHandle> {
    let port = match pick_free_port() {
        Some(p) => p,
        None => {
            eprintln!("[sandbox/{workspace_id}] no free port for tinyproxy");
            return None;
        }
    };
    let conf_path = std::env::temp_dir().join(format!("termic-proxy-{workspace_id}.conf"));
    let conf = format!(
        "User nobody\n\
         Group nobody\n\
         Port {port}\n\
         Listen 127.0.0.1\n\
         Timeout 600\n\
         DefaultErrorFile \"/dev/null\"\n\
         LogFile \"{}\"\n\
         LogLevel Warning\n\
         MaxClients 100\n\
         Filter \"{}\"\n\
         FilterURLs Off\n\
         FilterExtended On\n\
         FilterDefaultDeny Yes\n\
         FilterCaseSensitive No\n\
         ViaProxyName \"termic-sandbox\"\n",
        log_path.display(),
        filter_path.display(),
    );
    if let Err(e) = fs::write(&conf_path, conf) {
        eprintln!("[sandbox/{workspace_id}] failed to write tinyproxy conf: {e}");
        return None;
    }
    let child = match Command::new("tinyproxy")
        .arg("-d")             // don't daemonize - we want the PID
        .arg("-c")
        .arg(&conf_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[sandbox/{workspace_id}] failed to spawn tinyproxy: {e} (install: brew install tinyproxy)");
            return None;
        }
    };
    // Wait briefly for the port to come up. tinyproxy in -d mode is
    // ready in ~50ms in practice; we give it up to 2s.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Some(ProxyHandle { port, child, log_path: log_path.to_path_buf() });
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    eprintln!("[sandbox/{workspace_id}] tinyproxy didn't bind in time; killing");
    let mut child = child;
    let _ = child.kill();
    None
}

/// Provision the full sandbox bundle for one PTY spawn:
///   - Render + write the seatbelt profile.
///   - Render + write the tinyproxy filter file.
///   - Spawn tinyproxy on a free loopback port.
///
/// Profile/filter/log files live in tempdir under predictable names so
/// the user can `tail -f` them when something denies surprisingly.
pub fn provision(workspace: &Workspace, project: &Project) -> Result<SandboxBundle> {
    let tmp = std::env::temp_dir();
    let profile_path = tmp.join(format!("termic-sandbox-{}.sb", workspace.id));
    let filter_path  = tmp.join(format!("termic-proxy-{}.filter", workspace.id));
    let log_path     = tmp.join(format!("termic-proxy-{}.log", workspace.id));

    // tinyproxy first so we know the port. If it fails we still render
    // the profile against port 0 (network will be fully blocked - that's
    // a safe degraded state rather than a crash).
    let proxy = start_proxy(&workspace.id, &filter_path, &log_path);
    let port  = proxy.as_ref().map(|p| p.port).unwrap_or(0);

    fs::write(&filter_path, render_filter(workspace, project))
        .with_context(|| format!("write {}", filter_path.display()))?;
    let profile = render_profile(workspace, project, port)?;
    fs::write(&profile_path, &profile)
        .with_context(|| format!("write {}", profile_path.display()))?;

    Ok(SandboxBundle { profile_path, filter_path, proxy })
}

/// Wrap an agent command with `sandbox-exec -f <profile> env <vars>
/// <cmd> <args...>`. Returns the new (cmd, args) the PTY should spawn.
/// HTTP[S]_PROXY env is injected so HTTPS traffic actually goes through
/// our tinyproxy rather than being blocked by the kernel sandbox.
pub fn wrap_command(
    bundle: &SandboxBundle,
    original_cmd: &str,
    original_args: &[String],
) -> (String, Vec<String>) {
    let mut new_args: Vec<String> = Vec::new();
    new_args.push("-f".into());
    new_args.push(bundle.profile_path.to_string_lossy().into_owned());
    new_args.push("env".into());
    if let Some(proxy) = &bundle.proxy {
        let url = format!("http://127.0.0.1:{}", proxy.port);
        new_args.push(format!("http_proxy={url}"));
        new_args.push(format!("https_proxy={url}"));
        new_args.push(format!("HTTP_PROXY={url}"));
        new_args.push(format!("HTTPS_PROXY={url}"));
        new_args.push("no_proxy=localhost,127.0.0.1,::1".into());
        new_args.push("NO_PROXY=localhost,127.0.0.1,::1".into());
        // Node specifically: pre-23 versions ignore http_proxy unless
        // told. dpf_agents documents this same flag.
        new_args.push("NODE_OPTIONS=--use-env-proxy".into());
    }
    new_args.push(original_cmd.into());
    new_args.extend(original_args.iter().cloned());
    ("sandbox-exec".into(), new_args)
}

// ─── helpers ─────────────────────────────────────────────────────────

const SBPL_HEADER: &str = r#";; termic sandbox profile - generated; do not edit.
(version 1)
(deny default)

;; Process + IPC essentials (Node, Python, git, shells need these).
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow iokit-open)
(allow system-socket)

;; Filesystem: broad read, narrow write. Deny carve-outs come AFTER.
(allow file-read*)
(allow file-read-metadata)

;; macOS character devices the runtime expects to write.
(allow file-write-data
  (require-all (path "/dev/null") (vnode-type CHARACTER-DEVICE)))
(allow file-write-data
  (require-all (path "/dev/dtracehelper") (vnode-type CHARACTER-DEVICE)))
(allow file-ioctl (literal "/dev/dtracehelper"))
"#;

fn pick_free_port() -> Option<u16> {
    // Bind on 0 → OS hands us an ephemeral port; drop the socket
    // immediately so tinyproxy can grab it. Tiny race window between
    // our drop and tinyproxy's bind, accepted.
    TcpListener::bind("127.0.0.1:0").ok().and_then(|l| l.local_addr().ok().map(|a| a.port()))
}

/// Resolve symlinks so the SBPL rules match what the kernel sees.
/// Seatbelt evaluates the *canonical* path; a worktree symlinked
/// somewhere else would otherwise fail writes through the symlink.
fn canonicalize_or_keep(p: &str) -> String {
    fs::canonicalize(p)
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string())
}

fn dedupe(v: &mut Vec<String>) {
    let mut seen: HashSet<String> = HashSet::new();
    v.retain(|s| seen.insert(s.clone()));
}

fn sbpl_escape(s: &str) -> String {
    // SBPL strings don't allow embedded quotes/backslashes in practice;
    // the rendered path comes from canonicalize() so it's a normal
    // POSIX path. Defensive escape just in case.
    s.replace('\\', "\\\\").replace('"', "\\\"")
}
