//! Resolve the user's login-shell environment.
//!
//! GUI-launched .app bundles on macOS inherit a bare env from launchd:
//! a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) and none of the
//! variables the user exports from their shell rc. So anything we spawn
//! directly (the agent CLIs, scratch terminals, setup/run scripts) is
//! missing the user's real world:
//!   - PATH — `claude`/`codex` in `~/.local/bin`, nvm/bun shims, etc.
//!     are invisible ("env: claude: No such file or directory", #13/#16).
//!   - EDITOR/VISUAL — Claude Code's Ctrl+G opens the wrong editor (#17).
//!   - LANG, GPG_TTY, tool tokens, … — anything else the rc exports.
//!
//! Fix: shell out to `$SHELL -ilc env` ONCE, cache it, diff it against
//! our own (bare) env, and inject the delta into everything we spawn.
//! `-l` runs the login profile (`.zprofile`), `-i` runs the interactive
//! rc (`.zshrc`) — both are needed because dynamic installers (nvm,
//! mise, fnm, asdf, bun) typically write to `.zshrc`. Diffing against
//! our own env drops inherited launchd noise (XPC_SERVICE_NAME, …) for
//! free: unchanged keys aren't in the delta.
//!
//! VS Code, Cursor, Zed, GitHub Desktop all do the same thing for the
//! same reason. See e.g. microsoft/vscode `shellEnv.ts`.
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

static RESOLVED_ENV: OnceLock<LoginEnv> = OnceLock::new();
static RESOLVED_SHELL: OnceLock<String> = OnceLock::new();

/// The resolved login-shell environment, cached after the first probe.
#[derive(Default, Clone)]
struct LoginEnv {
    /// PATH suitable for finding user-installed CLIs (login-shell PATH,
    /// or a best-effort fallback if the probe failed). Kept as its own
    /// field because PATH has fallback logic the other vars don't.
    path: String,
    /// Every OTHER variable the login shell exports that our bare env
    /// doesn't already have with the same value — the delta to inject
    /// into spawned children. Excludes PATH (use `path`) and the
    /// terminal-identity / bookkeeping vars we manage ourselves.
    inject: Vec<(String, String)>,
}

fn resolved() -> &'static LoginEnv {
    RESOLVED_ENV.get_or_init(resolve_inner)
}

/// Return a PATH suitable for spawning user-installed CLIs.
/// Cached after the first call.
pub fn resolved_path() -> String {
    resolved().path.clone()
}

/// The user's login-shell environment MINUS PATH and the vars we manage
/// ourselves — i.e. EDITOR/VISUAL/LANG/GPG_TTY/tool-tokens/etc. that the
/// rc exports but a GUI-launched `.app` never inherits. Inject these
/// (alongside `resolved_path()`) into anything we spawn so the agent,
/// scratch terminal, and scripts all see the same environment the user's
/// own terminal would (#17, and the general class behind #13/#16).
/// Cached after the first call.
pub fn login_env() -> Vec<(String, String)> {
    resolved().inject.clone()
}

/// Absolute path to the user's preferred login shell, used to spawn
/// interactive terminals (scratch shells, custom-command tabs).
///
/// Preference order: the account's configured login shell (from the
/// passwd database, like Terminal.app / iTerm use), then `$SHELL`, then
/// the first of zsh → bash → fish → sh present on this machine. The
/// passwd shell comes FIRST on purpose: `$SHELL` is frozen at login by
/// launchd for GUI apps, so after a `chsh` it stays stale until the user
/// logs out (they'd report "I switched to bash but terminals still open
/// zsh"). The passwd entry reflects `chsh` immediately. termic also used
/// to hard-code `zsh`, locking out users without it (issue #13). Cached
/// after the first call.
pub fn login_shell() -> String {
    RESOLVED_SHELL
        .get_or_init(|| {
            let preferred = passwd_shell().or_else(|| std::env::var("SHELL").ok());
            pick_shell(preferred, |p| std::path::Path::new(p).exists())
        })
        .clone()
}

/// The current user's login shell from the passwd database
/// (`getpwuid(getuid())->pw_shell`). Reflects `chsh` without needing a
/// re-login, unlike `$SHELL`. `None` if unavailable or empty.
#[cfg(unix)]
fn passwd_shell() -> Option<String> {
    use std::ffi::CStr;
    // SAFETY: getpwuid returns a pointer into a static buffer owned by
    // libc; we copy pw_shell out immediately and never retain the
    // pointer. Called once (cached), so the static-buffer reuse that
    // makes getpwuid non-reentrant doesn't matter here.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() {
            return None;
        }
        let s = CStr::from_ptr((*pw).pw_shell).to_str().ok()?.to_string();
        (!s.is_empty()).then_some(s)
    }
}

#[cfg(not(unix))]
fn passwd_shell() -> Option<String> {
    None
}

/// Pure shell-selection logic, factored out for testability. `exists`
/// is the disk probe (real `Path::exists` in production, a stub in
/// tests). Prefers the given `preferred` shell when set and present,
/// else the first known-good interpreter found, else `/bin/sh` as a
/// last resort (POSIX guarantees it).
fn pick_shell(preferred: Option<String>, exists: impl Fn(&str) -> bool) -> String {
    if let Some(s) = preferred {
        if !s.is_empty() && exists(&s) {
            return s;
        }
    }
    const CANDIDATES: &[&str] = &[
        "/bin/zsh",
        "/usr/bin/zsh",
        "/bin/bash",
        "/usr/bin/bash",
        "/opt/homebrew/bin/bash",
        "/opt/homebrew/bin/fish",
        "/usr/local/bin/fish",
        "/usr/bin/fish",
        "/bin/sh",
    ];
    for cand in CANDIDATES {
        if exists(cand) {
            return (*cand).to_string();
        }
    }
    "/bin/sh".to_string()
}

/// Trigger resolution off the main thread so the first PTY spawn
/// doesn't pay the shell-startup cost.
pub fn warm() {
    std::thread::spawn(|| {
        let _ = resolved_path();
    });
}

fn resolve_inner() -> LoginEnv {
    let current: HashMap<String, String> = std::env::vars().collect();
    let bare_path = current.get("PATH").cloned().unwrap_or_default();
    // TERM_PROGRAM (set by Terminal.app, iTerm2, Ghostty, WezTerm, …) means
    // we were launched from a real terminal, so the inherited env is the
    // user's live session.
    let from_terminal = std::env::var("TERM_PROGRAM").is_ok();

    // ALWAYS probe the login shell for the env delta. We used to skip this
    // entirely for terminal launches, trusting the inherited env — but that
    // session can be stale (e.g. `export EDITOR` added to the rc AFTER the
    // terminal/dev-server was started), so the agent never saw it (#17).
    // Re-reading the rc here picks it up regardless of launch staleness.
    let probed = probe_login_shell().filter(|v| !v.is_empty());

    // PATH: a terminal launch already inherited the full login PATH (and may
    // carry session-specific additions), so keep it. A GUI launch gets a bare
    // launchd PATH → use the probed one, or the static fallback.
    let path = if from_terminal && !bare_path.is_empty() {
        bare_path.clone()
    } else {
        probed
            .as_ref()
            .and_then(|p| p.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.clone()))
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| fallback_path(&bare_path))
    };

    // Inject the rc delta. From a terminal the session is authoritative, so
    // only FILL gaps (never override a var the user set in that session);
    // from a GUI launch the bare env has no authority, so also override
    // differing values (e.g. launchd's LANG=C → your rc's en_US.UTF-8).
    let inject = match &probed {
        Some(p) => select_injected(p, &current, from_terminal),
        None => Vec::new(),
    };

    LoginEnv { path, inject }
}

/// From the probed login env, keep only what's worth injecting into a
/// child: drop PATH (handled separately, with fallback), drop the vars we
/// manage ourselves or that are pure shell bookkeeping, and decide per the
/// `fill_only` flag whether to touch a var our own env already carries:
///   - `fill_only` (terminal launch): only add vars MISSING from our env;
///     never override a value the live session already set.
///   - otherwise (GUI launch): also override vars whose value DIFFERS, so a
///     bare launchd value (LANG=C, no EDITOR) loses to the rc's. Unchanged
///     vars (incl. inherited launchd noise like XPC_SERVICE_NAME) are
///     dropped either way. Pure for testing.
fn select_injected(
    probed: &[(String, String)],
    current: &HashMap<String, String>,
    fill_only: bool,
) -> Vec<(String, String)> {
    probed
        .iter()
        .filter(|(k, v)| {
            if k == "PATH" || is_managed(k) {
                return false;
            }
            match current.get(k.as_str()) {
                None => true,                        // missing → always add
                Some(cur) => !fill_only && cur != v, // present → override only outside fill_only
            }
        })
        .cloned()
        .collect()
}

/// Vars we must NOT carry from the probed login env: ones we set ourselves
/// per spawn (terminal identity), pure shell-session bookkeeping, and
/// per-shell activation state that would be wrong to FREEZE at startup and
/// force onto every task.
///
/// The venv/conda group is the important one: if the user's rc auto-activates
/// an environment, the one-time probe captures its `VIRTUAL_ENV` / `CONDA_*`,
/// and injecting that into every agent + setup/run script would point
/// `python`/`pip` at that single startup-time env regardless of the
/// task's own — a frozen-activation footgun. PATH already carries the
/// right bin dirs; we just drop the activation pointers so each task's
/// own activation (or lack of one) wins.
fn is_managed(key: &str) -> bool {
    matches!(
        key,
        "TERM" | "TERM_PROGRAM" | "TERM_PROGRAM_VERSION" | "COLORTERM" | "COLORFGBG"
            | "SHLVL" | "_" | "PWD" | "OLDPWD"
            | "VIRTUAL_ENV" | "VIRTUAL_ENV_PROMPT"
            | "CONDA_PREFIX" | "CONDA_DEFAULT_ENV" | "CONDA_PROMPT_MODIFIER" | "CONDA_SHLVL"
    )
}

fn probe_login_shell() -> Option<Vec<(String, String)>> {
    // Probe the SAME shell we spawn terminals with — the account login
    // shell (reflects `chsh`), then `$SHELL`, then a last-resort scan. No
    // hardcoded zsh/bash here: whatever the user's shell is, we ask it.
    let shell = login_shell();

    let mut child = Command::new(&shell)
        // `env` dumps the whole exported environment in one round-trip.
        .args(["-ilc", "env"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // Interactive shells print MOTDs and complain about non-tty
        // stdin. Drop it on the floor.
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // Heavy rc files (oh-my-zsh + 30 plugins) can take a couple
    // seconds. Cap at 3s — past that, the user's setup is hostile
    // enough that we'd rather fall back than block app startup.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(parse_env_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Parse `env`'s `KEY=VALUE` lines into pairs. Split out so the line
/// handling is unit-testable without spawning a shell. Only lines whose
/// key is a valid shell identifier are kept, which skips MOTD banner
/// junk and the trailing lines of any multi-line value (rare, and we'd
/// rather drop one than inject a garbage key). Values keep everything
/// after the first `=`, so `FOO=a=b` round-trips correctly.
fn parse_env_output(stdout: &str) -> Vec<(String, String)> {
    stdout
        .lines()
        .filter_map(|line| {
            let (k, v) = line.split_once('=')?;
            is_env_key(k).then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

/// A POSIX-ish env var name: leading letter/underscore, then
/// alphanumerics/underscores.
fn is_env_key(k: &str) -> bool {
    let mut chars = k.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Shell probe failed or timed out. Union the bare PATH with the
/// well-known dev-tool locations. Misses dynamic shims (nvm picks
/// a node version per shell), but covers the common static
/// installers so at least `claude`, `codex`, `gemini` resolve.
pub(crate) fn fallback_path(current: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let extras: Vec<String> = vec![
        "/opt/homebrew/bin".into(),
        "/opt/homebrew/sbin".into(),
        "/usr/local/bin".into(),
        "/usr/local/sbin".into(),
        format!("{home}/.local/bin"),
        format!("{home}/.bun/bin"),
        format!("{home}/.deno/bin"),
        format!("{home}/.cargo/bin"),
        format!("{home}/.volta/bin"),
        format!("{home}/.npm-global/bin"),
        format!("{home}/n/bin"),
    ];

    let mut seen: std::collections::HashSet<String> =
        current.split(':').map(String::from).collect();
    let mut out = current.to_string();
    for p in extras {
        if seen.insert(p.clone()) {
            if !out.is_empty() {
                out.push(':');
            }
            out.push_str(&p);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_path_adds_homebrew_when_missing() {
        let result = fallback_path("/usr/bin:/bin");
        assert!(result.contains("/opt/homebrew/bin"), "must add homebrew bin");
    }

    #[test]
    fn fallback_path_does_not_duplicate_existing_entry() {
        let result = fallback_path("/usr/bin:/opt/homebrew/bin:/bin");
        let count = result.split(':').filter(|s| *s == "/opt/homebrew/bin").count();
        assert_eq!(count, 1, "homebrew bin must appear exactly once");
    }

    #[test]
    fn fallback_path_preserves_original_entries_first() {
        let result = fallback_path("/usr/bin:/bin");
        assert!(result.starts_with("/usr/bin:/bin"), "original path must be at the start");
    }

    #[test]
    fn fallback_path_empty_current_path() {
        let result = fallback_path("");
        assert!(result.contains("/opt/homebrew/bin"), "must add extras even for empty path");
        assert!(!result.starts_with(':'), "must not start with colon");
    }

    #[test]
    fn fallback_path_adds_private_tmp_equiv_via_cargo_bin() {
        // ~/.cargo/bin is always added (for rustup installs).
        let home = std::env::var("HOME").unwrap_or_default();
        let result = fallback_path("/usr/bin");
        if !home.is_empty() {
            assert!(result.contains(&format!("{home}/.cargo/bin")),
                "must add cargo bin dir");
        }
    }

    #[test]
    fn fallback_path_all_entries_nonempty() {
        let result = fallback_path("/usr/bin:/bin");
        for entry in result.split(':') {
            assert!(!entry.is_empty(), "no empty PATH entries allowed, got: {:?}", result);
        }
    }

    #[test]
    fn pick_shell_honors_existing_shell_var() {
        let got = pick_shell(Some("/usr/bin/fish".into()), |p| p == "/usr/bin/fish");
        assert_eq!(got, "/usr/bin/fish", "must use $SHELL when it exists");
    }

    #[test]
    fn pick_shell_skips_shell_var_that_does_not_exist() {
        // $SHELL points at zsh, but this machine doesn't have it (the
        // exact #13 scenario). Fall through to the first present cand.
        let got = pick_shell(Some("/bin/zsh".into()), |p| p == "/bin/bash");
        assert_eq!(got, "/bin/bash", "missing $SHELL must fall through to a real shell");
    }

    #[test]
    fn pick_shell_falls_back_when_shell_var_unset() {
        let got = pick_shell(None, |p| p == "/opt/homebrew/bin/fish");
        assert_eq!(got, "/opt/homebrew/bin/fish");
    }

    #[test]
    fn pick_shell_ignores_empty_shell_var() {
        let got = pick_shell(Some(String::new()), |p| p == "/bin/bash");
        assert_eq!(got, "/bin/bash", "empty $SHELL must be treated as unset");
    }

    #[test]
    fn pick_shell_last_resort_is_bin_sh() {
        // Nothing exists on disk — still return a POSIX-guaranteed path
        // rather than an empty string the spawner can't use.
        let got = pick_shell(None, |_| false);
        assert_eq!(got, "/bin/sh");
    }

    #[test]
    fn pick_shell_prefers_zsh_when_several_present() {
        let got = pick_shell(None, |_| true);
        assert_eq!(got, "/bin/zsh", "zsh is first in the candidate list");
    }

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn parse_env_output_basic_pairs() {
        let v = parse_env_output("PATH=/usr/bin:/bin\nEDITOR=nvim\nLANG=en_US.UTF-8");
        assert_eq!(v, vec![
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("EDITOR".into(), "nvim".into()),
            ("LANG".into(), "en_US.UTF-8".into()),
        ]);
    }

    #[test]
    fn parse_env_output_value_may_contain_equals() {
        // Only the FIRST '=' splits; the rest is value (e.g. a base64 token).
        let v = parse_env_output("FOO=a=b=c");
        assert_eq!(v, vec![("FOO".into(), "a=b=c".into())]);
    }

    #[test]
    fn parse_env_output_skips_motd_and_continuation_junk() {
        // A banner line and a multi-line value's tail have no valid KEY=.
        let v = parse_env_output("Welcome to your shell!\nEDITOR=nvim\n  some wrapped text");
        assert_eq!(v, vec![("EDITOR".into(), "nvim".into())]);
    }

    #[test]
    fn parse_env_output_preserves_spaces_in_value() {
        let v = parse_env_output("EDITOR=emacsclient -nw");
        assert_eq!(v, vec![("EDITOR".into(), "emacsclient -nw".into())]);
    }

    #[test]
    fn is_env_key_accepts_valid_and_rejects_junk() {
        assert!(is_env_key("EDITOR"));
        assert!(is_env_key("_FOO9"));
        assert!(!is_env_key(""));        // empty
        assert!(!is_env_key("9LIVES"));  // leading digit
        assert!(!is_env_key("a b"));     // space
        assert!(!is_env_key("Welcome to")); // banner text
    }

    #[test]
    fn select_injected_keeps_new_var() {
        // EDITOR isn't in our bare env → it's part of the delta to inject.
        let probed = vec![("EDITOR".into(), "nvim".into())];
        let got = select_injected(&probed, &map(&[("HOME", "/Users/x")]), false);
        assert_eq!(got, vec![("EDITOR".to_string(), "nvim".to_string())]);
    }

    #[test]
    fn select_injected_drops_unchanged_var() {
        // Inherited launchd noise (same value in our env) must NOT inject.
        let probed = vec![("XPC_SERVICE_NAME".into(), "app.termic".into())];
        let got = select_injected(&probed, &map(&[("XPC_SERVICE_NAME", "app.termic")]), false);
        assert!(got.is_empty());
    }

    #[test]
    fn select_injected_gui_overrides_changed_var() {
        // GUI launch (fill_only=false): rc's LANG beats launchd's LANG=C.
        let probed = vec![("LANG".into(), "en_US.UTF-8".into())];
        let got = select_injected(&probed, &map(&[("LANG", "C")]), false);
        assert_eq!(got, vec![("LANG".to_string(), "en_US.UTF-8".to_string())]);
    }

    #[test]
    fn select_injected_fill_only_does_not_override_session_var() {
        // Terminal launch (fill_only=true): the live session's EDITOR wins;
        // we must NOT clobber it with the rc default.
        let probed = vec![("EDITOR".into(), "nano".into())];
        let got = select_injected(&probed, &map(&[("EDITOR", "vim")]), true);
        assert!(got.is_empty(), "fill_only must not override a present var");
    }

    #[test]
    fn select_injected_fill_only_still_adds_missing_var() {
        // The #17 fix: EDITOR added to the rc AFTER a stale terminal opened
        // is missing from the inherited env, so fill_only still injects it.
        let probed = vec![("EDITOR".into(), "nano".into())];
        let got = select_injected(&probed, &HashMap::new(), true);
        assert_eq!(got, vec![("EDITOR".to_string(), "nano".to_string())]);
    }

    #[test]
    fn select_injected_drops_frozen_venv_activation() {
        // An rc-activated venv/conda must NOT be frozen + injected into every
        // task; PATH carries the bin dir, the activation pointers don't.
        let probed = vec![
            ("VIRTUAL_ENV".into(), "/Users/x/.venv".into()),
            ("CONDA_PREFIX".into(), "/opt/conda".into()),
            ("CONDA_DEFAULT_ENV".into(), "base".into()),
            ("EDITOR".into(), "nvim".into()),
        ];
        let got = select_injected(&probed, &HashMap::new(), false);
        assert_eq!(got, vec![("EDITOR".to_string(), "nvim".to_string())]);
    }

    #[test]
    fn select_injected_excludes_path_and_managed_vars() {
        // PATH is handled by resolved_path(); TERM/SHLVL/PWD are ours.
        let probed = vec![
            ("PATH".into(), "/opt/homebrew/bin".into()),
            ("TERM".into(), "xterm".into()),
            ("SHLVL".into(), "2".into()),
            ("PWD".into(), "/somewhere".into()),
            ("EDITOR".into(), "nvim".into()),
        ];
        let got = select_injected(&probed, &HashMap::new(), false);
        assert_eq!(got, vec![("EDITOR".to_string(), "nvim".to_string())]);
    }
}
