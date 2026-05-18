//! Resolve the user's login-shell PATH.
//!
//! GUI-launched .app bundles on macOS inherit a bare PATH from
//! launchd (`/usr/bin:/bin:/usr/sbin:/sbin`). User-installed CLIs
//! like `claude` (in `~/.local/bin`), `codex` (npm under nvm), or
//! anything from `/opt/homebrew/bin` are invisible to anything we
//! spawn — exactly the failure mode of "env: claude: No such file
//! or directory" after a brew install or self-update relaunch.
//!
//! Fix: shell out to `$SHELL -ilc 'printf %s "$PATH"'` once, cache
//! the result, and inject it into every PTY's env. `-l` runs the
//! login profile (`.zprofile`), `-i` runs the interactive rc
//! (`.zshrc`) — both are needed because dynamic PATH installers
//! (nvm, mise, fnm, asdf, bun) typically write to `.zshrc`.
//!
//! VS Code, Cursor, Zed, GitHub Desktop all do the same thing for
//! the same reason. See e.g. microsoft/vscode `shellEnv.ts`.
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

static RESOLVED_PATH: OnceLock<String> = OnceLock::new();

/// Return a PATH suitable for spawning user-installed CLIs.
/// Cached after the first call.
pub fn resolved_path() -> String {
    RESOLVED_PATH.get_or_init(resolve_inner).clone()
}

/// Trigger resolution off the main thread so the first PTY spawn
/// doesn't pay the shell-startup cost.
pub fn warm() {
    std::thread::spawn(|| {
        let _ = resolved_path();
    });
}

fn resolve_inner() -> String {
    let current = std::env::var("PATH").unwrap_or_default();

    // Launched from a real terminal: parent already passed its full
    // PATH, no need to round-trip through a shell. TERM_PROGRAM is
    // set by Terminal.app, iTerm2, Ghostty, WezTerm, Alacritty, etc.
    if std::env::var("TERM_PROGRAM").is_ok() {
        return current;
    }

    match probe_login_shell() {
        Some(p) if !p.is_empty() => p,
        _ => fallback_path(&current),
    }
}

fn probe_login_shell() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());

    let mut child = Command::new(&shell)
        .args(["-ilc", "printf %s \"$PATH\""])
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
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Shell probe failed or timed out. Union the bare PATH with the
/// well-known dev-tool locations. Misses dynamic shims (nvm picks
/// a node version per shell), but covers the common static
/// installers so at least `claude`, `codex`, `gemini` resolve.
fn fallback_path(current: &str) -> String {
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
