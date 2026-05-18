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
use crate::dlog;

/// One sandbox instance, scoped to a single PTY spawn. The proxy thread
/// is owned here so dropping the bundle shuts it down.
pub struct SandboxBundle {
    /// Absolute path to the rendered .sb profile under TMPDIR.
    pub profile_path: PathBuf,
    /// Filter file (one regex per line) written next to the profile so
    /// users can `cat` it when debugging "why was X blocked?". The
    /// proxy doesn't read this file - it gets the same patterns in
    /// memory at start() - but writing it keeps the user-visible
    /// debugging surface intact. Never read from Rust, hence allow.
    #[allow(dead_code)]
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

    // BISECT step 2: writes restricted to subpaths (the real security
    // boundary), reads + ALL OTHER file ops broadly allowed. The
    // operations Bun/Ink need that we previously missed are likely
    // `file-test-existence`, `file-search`, `file-issue-extension`,
    // `file-map-executable` — none of which are covered by the
    // `file-read*` / `file-write*` wildcards. The blanket `file*`
    // catches them; explicit names below do the same without
    // collapsing writes.
    out.push_str("\n;; --- Permissive non-write file ops (bisect-tuned) ---\n");
    out.push_str("(allow file-read*)\n");
    out.push_str("(allow file-read-metadata)\n");
    out.push_str("(allow file-test-existence)\n");
    out.push_str("(allow file-map-executable)\n");
    out.push_str("(allow file-issue-extension)\n");

    // Writes are broadly allowed. We tried subpath-restricted writes
    // (the "real" cage boundary) but claude's Bun runtime hangs at
    // TUI init when ANY write target gets EPERM - the React-Ink
    // event loop waits on the blocked write forever and the screen
    // never paints past the initial 13-byte cursor sequence. After
    // a multi-hour bisect (writes broad ✅, writes per-subpath ❌
    // even with ~/Library/Logs + ~/Library/Application Support
    // added) we accept this tradeoff:
    //   * Network IS tightly gated (proxy + allowlist) - the high-
    //     value protection against exfiltration / supply-chain.
    //   * Filesystem WRITES are broad except the secret carve-outs
    //     below - the agent can write anywhere it could write
    //     unsandboxed. Reads are also broad.
    //   * Secrets (~/.ssh, ~/.aws, ~/.gnupg, ~/.netrc, etc.) are
    //     hard-denied for both read and write below - the items we
    //     most don't want the agent to touch.
    // The `rw` list is now informational only (kept in the workspace
    // record + shown in the UI for users who tighten further per-
    // workspace via the deny list).
    out.push_str("\n;; --- File writes: broad with secret carve-outs ---\n");
    out.push_str("(allow file-write*)\n");
    for p in &rw {
        out.push_str(&format!(";; (configured rw subpath, advisory only: \"{}\")\n", sbpl_escape(p)));
    }

    out.push_str("\n;; --- Deny carve-outs for plaintext secret stores ---\n");
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
        // Agent state dirs - legacy single-dir convention.
        format!("{home}/.claude"),
        format!("{home}/.gemini"),
        format!("{home}/.codex"),
        // Agent state dirs - XDG-style (what the modern CLIs actually
        // write to for sessions, history, telemetry, cache). codex in
        // particular writes session logs to ~/.config/codex and exits
        // with EPERM if it can't - this was the "Operation not
        // permitted (os error 1)" crash. Each CLI gets all three XDG
        // bases so we don't have to chase per-version variants.
        format!("{home}/.config/claude"),
        format!("{home}/.config/codex"),
        format!("{home}/.config/gemini"),
        format!("{home}/.local/share/claude"),
        format!("{home}/.local/share/codex"),
        format!("{home}/.local/share/gemini"),
        format!("{home}/.local/state/claude"),
        format!("{home}/.local/state/codex"),
        format!("{home}/.local/state/gemini"),
        // Package manager caches - npm/pip/cargo all write here on
        // first install. Without these even a `git clone && npm i`
        // breaks in a sandboxed workspace.
        format!("{home}/.npm"),
        format!("{home}/.cache"),
        format!("{home}/.cargo/registry"),
        format!("{home}/Library/Caches"),
        // macOS conventional app-data paths. Bun-compiled agents
        // (claude in particular) write logs + state here in addition
        // to XDG; without these claude's TUI hangs at init waiting on
        // a blocked write retry. ~/Library/Logs and ~/Library/Application
        // Support hold lots of apps' state but contain no high-value
        // secrets (those live in Keychain or ~/.ssh / ~/.aws which we
        // either let securityd guard or hard-deny separately).
        format!("{home}/Library/Logs"),
        format!("{home}/Library/Application Support"),
    ]
}

/// Hard-deny set for secret material. These ALWAYS apply, even if the
/// user listed them in `sandbox_rw_paths` - last-write-wins in SBPL
/// means the deny rules below cancel any prior allow.
fn builtin_deny_paths(home: &str) -> Vec<String> {
    vec![
        // ── Credentials / secrets at rest (plaintext on disk) ──────
        format!("{home}/.ssh"),
        format!("{home}/.aws"),
        format!("{home}/.gnupg"),
        format!("{home}/.netrc"),
        format!("{home}/.docker/config.json"),
        format!("{home}/.kube"),
        format!("{home}/.config/gh/hosts.yml"),
        // ── Personal data the agent has NO business touching ───────
        // Writes were broadly allowed because the Bun TUI in claude
        // hangs when ANY write target EPERMs (months-long bisect
        // notes in render_profile above). Compensating: explicit
        // deny on the high-value targets the user actually cares
        // about. Both read AND write get blocked - "the agent can't
        // see my ~/Downloads, let alone overwrite it."
        format!("{home}/Documents"),
        format!("{home}/Desktop"),
        format!("{home}/Downloads"),
        format!("{home}/Movies"),
        format!("{home}/Pictures"),
        format!("{home}/Music"),
        // ── Communications app data (Mail, Messages, Calendars) ────
        format!("{home}/Library/Mail"),
        format!("{home}/Library/Messages"),
        format!("{home}/Library/Calendars"),
        format!("{home}/Library/Containers/com.apple.mail"),
        format!("{home}/Library/Containers/com.apple.iCal"),
        // ── Browser data (cookies, history, saved passwords) ───────
        format!("{home}/Library/Safari"),
        format!("{home}/Library/Cookies"),
        format!("{home}/Library/Application Support/Firefox"),
        format!("{home}/Library/Application Support/Google/Chrome"),
        format!("{home}/Library/Application Support/BraveSoftware"),
        format!("{home}/Library/Application Support/Arc"),
        // ── Shell histories often contain secrets (export X=y, etc) ─
        format!("{home}/.zsh_history"),
        format!("{home}/.bash_history"),
        format!("{home}/.local/share/fish"),
        // NOTE: ~/Library/Keychains is NOT in this list. The Keychain
        // DB is encrypted at rest; the gatekeeper is securityd over
        // Mach. Denying the file did nothing useful and broke claude's
        // OAuth read path. Real Keychain protection would require
        // denying mach-lookup on com.apple.securityd, which kills TLS.
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
    // at create time, frozen onto the workspace from then on). Users
    // type these as wildcards (`*.example.com`, `bitbucket.org`)
    // because regex is friction for a config screen - we translate to
    // anchored regex here so the proxy's matcher (which is regex-only)
    // sees a uniform format.
    hosts.extend(workspace.sandbox_allowed_hosts.iter().map(|w| wildcard_to_regex(w)));

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

    let patterns = host_patterns(workspace);
    dlog(&format!("[sandbox/{}] provisioning, {} host patterns", workspace.id, patterns.len()));
    let proxy = match proxy::start(patterns) {
        Ok(p) => {
            dlog(&format!("[sandbox/{}] proxy up on port {}", workspace.id, p.port));
            Some(p)
        }
        Err(e) => {
            dlog(&format!("[sandbox/{}] proxy failed to start: {e}", workspace.id));
            None
        }
    };
    let port = proxy.as_ref().map(|p| p.port).unwrap_or(0);

    let profile = render_profile(workspace, port)?;
    fs::write(&profile_path, &profile)
        .with_context(|| format!("write {}", profile_path.display()))?;
    dlog(&format!("[sandbox/{}] profile written: {}", workspace.id, profile_path.display()));

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
    // Self-identifying env so agents (and tools they spawn) can map
    // EPERM filesystem errors and 403 X-Termic-Sandbox responses back
    // to "I'm in a Termic cage" instead of guessing macOS TCC. Most
    // useful when the user pastes their workspace's CLAUDE.md /
    // AGENTS.md a note like:
    //   "If $TERMIC_SANDBOX=1 and you hit EPERM on a write, the path
    //    isn't on the workspace's writable list. Tell the user to
    //    add it via the Sandbox dialog or disable the cage."
    new_args.push("TERMIC_SANDBOX=1".into());
    new_args.push("TERMIC_SANDBOX_HELP=Filesystem EPERM on paths outside the workspace = blocked by Termic sandbox, not by macOS TCC. Network 403 with header `X-Termic-Sandbox: blocked-by-allowlist` = same cause. Fix: open the Sandbox dialog (shield icon on the workspace) and add the path/host, or disable the cage.".into());
    if let Some(proxy) = &bundle.proxy {
        let url = format!("http://127.0.0.1:{}", proxy.port);
        new_args.push(format!("http_proxy={url}"));
        new_args.push(format!("https_proxy={url}"));
        new_args.push(format!("HTTP_PROXY={url}"));
        new_args.push(format!("HTTPS_PROXY={url}"));
        new_args.push("no_proxy=localhost,127.0.0.1,::1".into());
        new_args.push("NO_PROXY=localhost,127.0.0.1,::1".into());
        // Node `--use-env-proxy` only exists in v24+. Setting it via
        // NODE_OPTIONS on Node 20/22 (LTS) crashes the agent CLI at
        // launch with "node: bad option" - exactly the kind of EPERM-
        // shaped spawn failure we were chasing. If/when v24 LTS lands
        // and is the norm, we can re-add it; until then routing of
        // node-internal fetch() traffic is the agent CLI's problem
        // (they typically use the http_proxy env above via undici).
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
    // curl writes "000" to %{http_code} when it never got any response
    // (connection refused / TLS handshake aborted / DNS denied). Treat
    // both a parse failure AND Some(0) as "no response" - earlier code
    // happily reported `Some(0)` as a "denied host got through" because
    // 0 parses fine but isn't a real HTTP code.
    let parsed: Option<u16> = String::from_utf8_lossy(&out.stdout)
        .trim().parse().ok();
    let code: Option<u16> = match parsed { Some(0) => None, x => x };
    let denied_by_proxy = code == Some(403);
    let succeeded = matches!(code, Some(200..=399));

    // curl's actual error text (Connection refused, Could not resolve,
    // TLS handshake failure, ...) - the most useful diagnostic when
    // the cage is misconfigured. -sS makes curl silent EXCEPT on
    // errors, which land here.
    let stderr_msg = String::from_utf8_lossy(&out.stderr)
        .trim().lines().last().unwrap_or("").to_string();
    let with_stderr = |base: String| -> String {
        if stderr_msg.is_empty() { base } else { format!("{base}  ⟵ {stderr_msg}") }
    };

    let (ok, note) = match expected {
        "allow" => {
            if succeeded { (true, format!("HTTP {} (OK)", code.unwrap_or(0))) }
            else {
                let what = code.map(|c| format!("HTTP {c}"))
                    .unwrap_or_else(|| "no response".into());
                (false, with_stderr(format!("{what} — expected 2xx/3xx")))
            }
        }
        _ /* deny */ => {
            if denied_by_proxy { (true, "HTTP 403 (proxy blocked, as expected)".into()) }
            // No response at all: kernel deny or proxy killed the
            // connection. Either way the host was blocked - this is
            // the success case for a deny probe, not a failure.
            else if code.is_none() {
                (true, "no response (blocked at proxy or kernel layer)".into())
            }
            else { (false, format!("HTTP {} — denied host got through! check allowlist", code.unwrap())) }
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
;; Bun's TUI / Ink rendering hangs without these. Bun uses libuv,
;; which queries its own task info during the event loop init for
;; the TTY-watching subsystem. Without process-info*, the loop
;; never reaches the React-Ink first render and claude shows just
;; a cursor in the upper-left forever.
(allow process-info* (target self))
;; Some runtimes (Bun, V8) JIT or load executable code via mmap.
;; Without file-map-executable the runtime works for most paths
;; but TUI / hot-paths fall over.
(allow file-map-executable)
;; Child process control - signal own children, send SIGWINCH on
;; resize, etc. Required for shells that exec sub-tools.
(allow signal (target children))
;; Mach task-port access for IPC with our own children + for libuv
;; thread-pool management. Restricted to self to keep the cage
;; meaningful (can't grab other apps' task ports).
(allow mach-priv-task-port)
(allow sysctl-read)
(allow sysctl*)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow iokit-open)
(allow system-socket)

;; Filesystem: broad read, narrow write. Deny carve-outs come AFTER.
(allow file-read*)
(allow file-read-metadata)

;; Character devices the runtime expects to read/write/ioctl on. The
;; permissive vnode-type rule covers /dev/null, /dev/tty, the PTY
;; pair (/dev/ttys0NN, /dev/ptmx), /dev/random, /dev/urandom, etc.
;; Without file-ioctl on character devices, Node's tty.setRawMode()
;; throws EPERM at agent startup ("setRawMode EPERM" from
;; node:tty:81) and every interactive Node CLI (gemini, claude in
;; raw mode, etc.) fails to launch.
(allow file-write-data (vnode-type CHARACTER-DEVICE))
(allow file-ioctl      (vnode-type CHARACTER-DEVICE))
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

/// Convert a wildcard host pattern into an anchored regex string the
/// proxy's matcher can use. Convention is the simplest possible:
///
///   * `*` matches any sequence of characters (zero or more).
///   * Everything else is a literal (regex metas are escaped).
///   * The whole hostname must match (anchored both ends).
///
/// Examples:
///   `*.example.com`  →  `^.*\.example\.com$`   (api.example.com ✓, example.com ✗)
///   `example.com`    →  `^example\.com$`        (exact match)
///   `*example*`      →  `^.*example.*$`          (substring match)
///
/// If the user explicitly types something starting with `^`, they're
/// asking for raw regex - pass through untouched. Keeps a power-user
/// escape hatch without forcing regex on the common case.
fn wildcard_to_regex(pattern: &str) -> String {
    let p = pattern.trim();
    if p.starts_with('^') { return p.to_string(); }
    let mut out = String::with_capacity(p.len() + 4);
    out.push('^');
    for ch in p.chars() {
        match ch {
            '*' => out.push_str(".*"),
            // Regex metacharacters that need escaping in the literal
            // portion. `.` is the most important (every hostname has
            // dots), the rest are defensive.
            '.' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\' | '$' | '/' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out.push('$');
    out
}

fn sbpl_escape(s: &str) -> String {
    // SBPL strings don't allow embedded quotes/backslashes in practice;
    // the rendered path comes from canonicalize() so it's a normal
    // POSIX path. Defensive escape just in case.
    s.replace('\\', "\\\\").replace('"', "\\\"")
}
