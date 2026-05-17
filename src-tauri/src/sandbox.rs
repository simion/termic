// macOS sandbox-exec (Seatbelt) wrapper for per-workspace agent isolation.
//
// ⚠ sandbox-exec is Apple-deprecated. The binary still works on macOS 15
//   and there's no replacement on the horizon, but Apple reserves the
//   right to remove it. If/when that lands, the alternative is the
//   Endpoint Security framework (kext-replacement) which requires
//   notarized + entitled binaries and a much heavier integration. Don't
//   pre-port - we'd be guessing at the future API. Flag if it breaks on
//   a macOS release; current macOS minimum is 12.0 (tauri.conf.json).
//
// Built-in defaults (builtin_rw_paths / builtin_deny_paths / per-CLI
// host blocks in render_filter) are evaluated fresh at every spawn, so
// updates to these in NEW versions of Termic reach EVERY existing
// workspace automatically - they're not seeded onto the saved Workspace
// record. The Project's `sandbox_*` arrays are user-owned EXTRAS only.
// This is the explicit contract: never seed defaults onto a Project at
// create time; always grow built-ins in code.
//
// Layered model:
//   1. Outer kernel sandbox via `sandbox-exec -f <profile.sb>` - blocks
//      writes outside the allowlist, blocks all network except a single
//      loopback hop to our in-process CONNECT proxy.
//   2. The native Rust proxy (see `crate::proxy`) filters that loopback
//      hop against a per-workspace hostname allowlist (regex per line).
//      Anything not allowed → 403.
//
// Both pieces live for the lifetime of the agent PTY: the profile is a
// fresh file under tempdir() with the workspace id; the proxy is an
// in-process thread that gets torn down when the SandboxBundle drops.
//
// We used to shell out to tinyproxy here, which meant every user had
// to `brew install tinyproxy` (or have a bundled binary that wouldn't
// satisfy Gatekeeper without re-signing). The native proxy is ~300 LoC
// of std-only Rust, removes the dep, and makes the eventual Linux port
// trivial because there's no platform-specific binary to bundle.

use anyhow::{anyhow, Context, Result};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use crate::Workspace;
use crate::proxy;

/// One sandbox instance, scoped to a single PTY spawn. The proxy thread
/// is owned here so dropping the bundle shuts it down.
pub struct SandboxBundle {
    /// Absolute path to the rendered .sb profile under TMPDIR.
    pub profile_path: PathBuf,
    /// Filter file (one regex per line) written next to the profile so
    /// users can `cat` it when debugging "why was X blocked?". The
    /// proxy doesn't read this file - it gets the same patterns in
    /// memory at start() - but writing it keeps the user-visible
    /// debugging surface intact.
    pub filter_path: PathBuf,
    /// Native proxy handle. None only when start() failed (bad regex,
    /// EMFILE, etc.) - the caller downgrades to "filesystem sandbox +
    /// no network" rather than failing the spawn outright.
    pub proxy: Option<proxy::ProxyHandle>,
}

/// Build a fully-rendered SBPL profile for one workspace. Substitutes
/// $HOME / $WORKSPACE in any user-supplied paths, dedupes against the
/// built-in RW list, applies built-in deny rules AFTER the broad
/// `file-read*` allow so they take precedence. Reads extras from the
/// workspace's own frozen-at-creation arrays - project edits don't
/// reach back into already-created workspaces.
pub fn render_profile(workspace: &Workspace, proxy_port: u16) -> Result<String> {
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
    for p in &workspace.sandbox_rw_paths {
        let s = subst(p);
        if !s.is_empty() { rw.push(s); }
    }
    dedupe(&mut rw);

    let mut deny: Vec<String> = builtin_deny_paths(&home);
    for p in &workspace.sandbox_deny_paths {
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

    out.push_str("\n;; --- Network: only loopback to our in-process proxy ---\n");
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

/// Default host allowlist (regex per line) for a workspace, keyed off
/// the agent it runs. We add the API endpoints for that agent's vendor
/// plus a baseline of stuff every dev needs (github + popular package
/// registries). Workspace's own `sandbox_allowed_hosts` are appended.
/// The output is the file contents (with leading comment); use
/// `host_patterns` if you just want the regexes for feeding to the
/// proxy.
pub fn render_filter(workspace: &Workspace) -> String {
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

    // Workspace-specific extras layered on top (seeded from project
    // at create time, frozen onto the workspace from then on).
    hosts.extend(workspace.sandbox_allowed_hosts.iter().cloned());

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

/// Extract just the host regex patterns from a workspace's allowlist.
/// Same default set as `render_filter` (which keeps the on-disk debug
/// file), minus the comment header - this is what we feed to the
/// in-process proxy at start time.
pub fn host_patterns(workspace: &Workspace) -> Vec<String> {
    render_filter(workspace)
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.to_string())
        .collect()
}

/// Provision the full sandbox bundle for one PTY spawn:
///   - Render + write the seatbelt profile.
///   - Render + write the host allowlist (for user debugging only).
///   - Start the in-process CONNECT proxy on a free loopback port.
///
/// Profile/filter files live in tempdir under predictable names so the
/// user can inspect them when something denies surprisingly.
pub fn provision(workspace: &Workspace) -> Result<SandboxBundle> {
    let tmp = std::env::temp_dir();
    let profile_path = tmp.join(format!("termic-sandbox-{}.sb", workspace.id));
    let filter_path  = tmp.join(format!("termic-proxy-{}.filter", workspace.id));

    // Filter file is purely for the user's `cat` benefit now; the proxy
    // gets its patterns from memory below. Best-effort write.
    let _ = fs::write(&filter_path, render_filter(workspace));

    let proxy = match proxy::start(host_patterns(workspace)) {
        Ok(p) => Some(p),
        Err(e) => {
            eprintln!("[sandbox/{}] proxy failed to start: {e}", workspace.id);
            None
        }
    };
    let port = proxy.as_ref().map(|p| p.port).unwrap_or(0);

    let profile = render_profile(workspace, port)?;
    fs::write(&profile_path, &profile)
        .with_context(|| format!("write {}", profile_path.display()))?;

    Ok(SandboxBundle { profile_path, filter_path, proxy })
}

/// Wrap an agent command with `sandbox-exec -f <profile> env <vars>
/// <cmd> <args...>`. Returns the new (cmd, args) the PTY should spawn.
/// HTTP[S]_PROXY env is injected so HTTPS traffic actually goes through
/// our in-process proxy rather than being blocked by the kernel sandbox.
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

/// Result of one curl probe inside the workspace's sandbox.
#[derive(serde::Serialize, Clone)]
pub struct ProbeResult {
    pub host: String,
    pub expected: &'static str,   // "allow" | "deny"
    pub ok: bool,                 // did the actual outcome match `expected`?
    pub http_code: Option<u16>,
    pub note: String,             // human-readable summary
}

/// End-to-end self-test for a workspace's sandbox: runs `curl` inside
/// the cage against one host we expect to succeed (vendor API) and one
/// we expect to fail (a non-listed host). Confirms both the seatbelt
/// profile AND host allowlist are doing their jobs. Use from the
/// WorkspaceSandboxDialog "Test" button so users don't have to take
/// the cage on faith.
pub fn run_self_test(workspace: &Workspace) -> Vec<ProbeResult> {
    // Provision a fresh ephemeral bundle just for the test. We can't
    // reuse the live agent's bundle (race), and this way the user
    // can run the test even with no agent running. Bundle's Drop
    // tears down the proxy thread when this function returns.
    let bundle = match provision(workspace) {
        Ok(b) => b,
        Err(e) => return vec![
            ProbeResult {
                host: "—".into(), expected: "allow", ok: false,
                http_code: None, note: format!("could not provision sandbox: {e}"),
            },
        ],
    };

    // Pick an allowed host that's in the per-CLI baseline so the test
    // matches what the actual agent would experience. github.com is
    // in the baseline for every CLI.
    let allowed = "https://api.github.com";
    // A host that nothing in our baseline allows. example.com is a
    // standards-blessed reserved domain - safe to ping, won't match
    // any of our regexes.
    let denied  = "https://example.com";

    vec![
        probe(&bundle, allowed, "allow"),
        probe(&bundle, denied,  "deny"),
    ]
}

fn probe(bundle: &SandboxBundle, url: &str, expected: &'static str) -> ProbeResult {
    let proxy_url = bundle.proxy.as_ref().map(|p| format!("http://127.0.0.1:{}", p.port));
    // Run via sandbox-exec so the seatbelt + proxy combo is what we're
    // actually testing. 5s timeout - curl with a denied host should
    // hang on the proxy's 403 (instant) or get killed quickly anyway.
    let mut cmd = Command::new("sandbox-exec");
    cmd.arg("-f").arg(&bundle.profile_path).arg("env");
    if let Some(ref pu) = proxy_url {
        cmd.arg(format!("http_proxy={pu}"));
        cmd.arg(format!("https_proxy={pu}"));
        cmd.arg(format!("HTTP_PROXY={pu}"));
        cmd.arg(format!("HTTPS_PROXY={pu}"));
    }
    cmd.arg("curl")
        .arg("-sS")                       // silent except errors
        .arg("--max-time").arg("5")
        .arg("-o").arg("/dev/null")
        .arg("-w").arg("%{http_code}\n")
        .arg(url);

    let out = match cmd.output() {
        Ok(o) => o,
        Err(e) => return ProbeResult {
            host: url.into(), expected, ok: false, http_code: None,
            note: format!("spawn failed: {e}"),
        },
    };
    let code: Option<u16> = String::from_utf8_lossy(&out.stdout)
        .trim().parse().ok();
    let denied_by_proxy = code == Some(403);
    let succeeded = matches!(code, Some(200..=399));

    let (ok, note) = match expected {
        "allow" => {
            if succeeded { (true, format!("HTTP {} (OK)", code.unwrap_or(0))) }
            else { (false, format!("HTTP {} — expected 2xx/3xx; check proxy is up", code.map(|c| c.to_string()).unwrap_or_else(|| "no response".into()))) }
        }
        _ /* deny */ => {
            if denied_by_proxy { (true, "HTTP 403 (proxy blocked, as expected)".into()) }
            else if code.is_none() && !out.status.success() {
                (true, "blocked (curl couldn't connect — denied at the proxy or kernel layer)".into())
            }
            else { (false, format!("HTTP {} — denied host got through! check allowlist", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()))) }
        }
    };
    ProbeResult { host: url.into(), expected, ok, http_code: code, note }
}

/// Query macOS `log` for recent sandbox denials touching a workspace.
/// Filters by:
///   - subsystem/sender: sandboxd / kernel (where Seatbelt logs land)
///   - last N minutes
///   - eventMessage containing the workspace path (so users only see
///     denials caused by their own agent, not noise from other apps)
/// Returns lines in newest-first order. Empty Vec on any failure -
/// debugging shouldn't itself fail.
pub fn recent_denials(workspace_path: &str, minutes: u32) -> Vec<String> {
    let predicate = format!(
        "(sender == \"kernel\" OR sender == \"sandboxd\") AND eventMessage CONTAINS \"deny\" AND eventMessage CONTAINS \"{}\"",
        // The path goes inside a quoted literal in the predicate; we
        // escape both backslashes and embedded double-quotes
        // defensively. macOS paths don't contain quotes in practice
        // but it costs nothing to be safe.
        workspace_path.replace('\\', "\\\\").replace('"', "\\\""),
    );
    let last_arg = format!("{}m", minutes);
    let out = Command::new("log")
        .args(["show", "--predicate", &predicate, "--last", &last_arg, "--style", "compact"])
        .output();
    let Ok(out) = out else { return Vec::new(); };
    if !out.status.success() { return Vec::new(); }
    let text = String::from_utf8_lossy(&out.stdout);
    // `log show` prints a banner header and a "Filtering the log data
    // using ..." preamble that we don't want. Keep only lines that
    // mention "deny" - that filter is the actual data row.
    let mut lines: Vec<String> = text
        .lines()
        .filter(|l| l.contains("deny"))
        .map(|l| l.to_string())
        .collect();
    lines.reverse();        // newest first
    lines.truncate(50);     // cap to keep the IPC payload tiny
    lines
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
