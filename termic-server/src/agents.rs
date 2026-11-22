//! The agents a task can run, and how a PTY spawns one.
//!
//! Agents are launched through the user's login shell so PATH is what an
//! interactive login on the box has: ssh runs commands with a minimal PATH,
//! and agents installed by npm, nvm, bun or ~/.local/bin are invisible to
//! it. The argv is passed as positional parameters (`exec "$@"`), never
//! pasted into shell code, so no user text is ever parsed by a shell.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Command, Stdio};

/// Built-in agents: id -> argv. "shell" is special: the login shell itself.
pub const BUILTIN: &[(&str, &[&str])] = &[
    ("claude", &["claude"]),
    ("codex", &["codex"]),
    ("gemini", &["gemini"]),
    ("opencode", &["opencode"]),
    ("shell", &[]),
];

pub const DEFAULT_AGENT: &str = "claude";

/// The agent table: built-ins, then `agents.json` (`{"id": ["argv", ...]}`)
/// overriding or adding. A malformed file is ignored (and logged), so a
/// typo there never takes the server down.
pub fn table(dir: &Path) -> BTreeMap<String, Vec<String>> {
    let mut t: BTreeMap<String, Vec<String>> = BUILTIN.iter().map(|(id, argv)| (id.to_string(), argv.iter().map(|s| s.to_string()).collect())).collect();
    let p = dir.join("agents.json");
    if let Ok(text) = std::fs::read_to_string(&p) {
        match serde_json::from_str::<BTreeMap<String, Vec<String>>>(&text) {
            Ok(extra) => {
                for (id, argv) in extra {
                    if valid_id(&id) && (!argv.is_empty() || id == "shell") {
                        t.insert(id, argv);
                    }
                }
            }
            Err(e) => crate::util::log(&format!("agents.json ignored: {e}")),
        }
    }
    t
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The user's login shell: $SHELL if it is an absolute executable path,
/// else /bin/sh.
pub fn login_shell() -> String {
    match std::env::var("SHELL") {
        Ok(s) if s.starts_with('/') && Path::new(&s).exists() => s,
        _ => "/bin/sh".into(),
    }
}

fn shell_name(shell: &str) -> &str {
    shell.rsplit('/').next().unwrap_or(shell)
}

/// The full argv a PTY runs for `argv` under `shell`.
///
/// bash and zsh run as an interactive login (`-lic`): Ubuntu's .bashrc,
/// where nvm puts node agents on PATH, returns early for non-interactive
/// shells. The program is "$@" (fish: $argv), so arguments stay data.
/// Shells we do not know get /bin/sh's syntax via /bin/sh itself.
pub fn wrap(shell: &str, argv: &[String]) -> Vec<String> {
    let (sh, flags, script) = match shell_name(shell) {
        "bash" | "zsh" | "ksh" | "mksh" => (shell.to_string(), "-lic", "exec \"$@\""),
        "sh" | "dash" | "ash" => (shell.to_string(), "-lc", "exec \"$@\""),
        "fish" => (shell.to_string(), "-lc", "exec $argv"),
        _ => ("/bin/sh".to_string(), "-lc", "exec \"$@\""),
    };
    let mut out = vec![sh, flags.to_string(), script.to_string()];
    // fish puts every argument in $argv; sh-likes take the first as $0.
    if shell_name(&out[0]) != "fish" {
        out.push("termic".into());
    }
    out.extend(argv.iter().cloned());
    out
}

/// The argv for a task's agent: the table's, plus resume flags, plus the
/// task's own args. "shell" is the login shell as a login shell.
pub fn agent_argv(table: &BTreeMap<String, Vec<String>>, agent: &str, task_args: &[String], resume: bool) -> Result<Vec<String>, String> {
    let shell = login_shell();
    if agent == "shell" && table.get("shell").is_none_or(|a| a.is_empty()) {
        return Ok(vec![shell, "-l".into()]);
    }
    let base = table.get(agent).ok_or_else(|| format!("unknown agent \"{agent}\" (see `termic agents`)"))?;
    let mut argv = base.clone();
    if resume {
        argv.extend(resume_args(agent).iter().map(|s| s.to_string()));
    }
    argv.extend(task_args.iter().cloned());
    Ok(wrap(&shell, &argv))
}

/// What continues an agent's last session in this directory.
pub fn resume_args(agent: &str) -> &'static [&'static str] {
    match agent {
        "claude" => &["--continue"],
        "codex" => &["resume", "--last"],
        "opencode" => &["--continue"],
        _ => &[],
    }
}

/// The key that stops an agent's current turn.
pub use termic_proto::interrupt_key;

/// Whether the agent's program is found by the login shell. "shell" always
/// is. The program name is passed as "$1", never interpolated.
pub fn installed(table: &BTreeMap<String, Vec<String>>, agent: &str) -> bool {
    let Some(argv) = table.get(agent) else { return false };
    let Some(prog) = argv.first() else { return agent == "shell" };
    if prog.starts_with('/') {
        return is_executable(Path::new(prog));
    }
    let shell = login_shell();
    let mut full = wrap(&shell, &["sh".to_string(), "-c".to_string(), "command -v \"$1\" >/dev/null 2>&1".to_string(), "sh".to_string(), prog.clone()]);
    let prog0 = full.remove(0);
    Command::new(prog0)
        .args(full)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn wrap_passes_argv_as_data_not_code() {
        let evil = s(&["claude", "$(rm -rf ~)", "a'b\"c", "; echo pwned"]);
        let w = wrap("/bin/bash", &evil);
        assert_eq!(w[..4], s(&["/bin/bash", "-lic", "exec \"$@\"", "termic"])[..]);
        assert_eq!(&w[4..], &evil[..]);
        let f = wrap("/usr/bin/fish", &evil);
        assert_eq!(f[..3], s(&["/usr/bin/fish", "-lc", "exec $argv"])[..]);
        assert_eq!(&f[3..], &evil[..]);
        let u = wrap("/usr/bin/nu", &evil);
        assert_eq!(u[0], "/bin/sh");
    }

    #[test]
    fn wrapped_argv_reaches_the_program_unchanged() {
        // Run the real thing: sh prints each argument on its own line.
        let tricky = s(&["printf", "%s\\n", "$(echo no)", "a b", "'q'", "*"]);
        let mut w = wrap("/bin/sh", &tricky);
        let prog = w.remove(0);
        let out = Command::new(prog).args(w).current_dir("/").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "$(echo no)\na b\n'q'\n*\n");
    }

    #[test]
    fn agent_argv_adds_resume_and_task_args() {
        let t: BTreeMap<String, Vec<String>> = BUILTIN.iter().map(|(id, a)| (id.to_string(), a.iter().map(|x| x.to_string()).collect())).collect();
        let a = agent_argv(&t, "claude", &s(&["--model", "opus"]), true).unwrap();
        assert!(a.ends_with(&s(&["claude", "--continue", "--model", "opus"])));
        let a = agent_argv(&t, "gemini", &[], true).unwrap();
        assert!(a.ends_with(&s(&["gemini"])));
        assert!(agent_argv(&t, "nope", &[], false).is_err());
        let sh = agent_argv(&t, "shell", &[], false).unwrap();
        assert_eq!(sh.last().unwrap(), "-l");
    }

    #[test]
    fn agents_json_overrides_and_adds_but_skips_bad_ids() {
        let d = std::env::temp_dir().join(format!("ts-agents-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("agents.json"), r#"{"claude":["/opt/claude","--x"],"fake":["/tmp/f.sh"],"../bad":["x"],"empty":[]}"#).unwrap();
        let t = table(&d);
        assert_eq!(t["claude"], s(&["/opt/claude", "--x"]));
        assert_eq!(t["fake"], s(&["/tmp/f.sh"]));
        assert!(!t.contains_key("../bad") && !t.contains_key("empty"));
        assert!(t.contains_key("codex"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn interrupt_keys_per_agent() {
        assert_eq!(interrupt_key("claude"), b"\x1b");
        assert_eq!(interrupt_key("shell"), b"\x03");
    }
}
