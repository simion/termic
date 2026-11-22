//! Codex's hook TRUST store, which is the one thing that makes its hooks
//! different from every other agent termic installs into.
//!
//! Codex discovers `$CODEX_HOME/hooks.json` and reports the hooks in it as
//! `enabled: true` — and then does not run them. They are `untrusted` until the
//! user approves them, and an untrusted hook fires NOTHING, prints NOTHING and
//! logs NOTHING. All measured against codex-cli 0.153.0:
//!
//! ```text
//! hooks.json only            -> trustStatus "untrusted", hook does not run
//! + enabled = true           -> trustStatus "untrusted", hook does not run
//! + trusted_hash = <wrong>   -> trustStatus "modified",  hook does not run
//! + trusted_hash = <right>   -> trustStatus "trusted",   hook RUNS
//! ```
//!
//! So installing codex hooks means writing two files, not one: the hooks
//! themselves, and a trust entry per hook in `$CODEX_HOME/config.toml`:
//!
//! ```toml
//! [hooks.state."/Users/u/.codex/hooks.json:session_start:0:0"]
//! enabled = true
//! trusted_hash = "sha256:…"
//! ```
//!
//! The key is `<sourcePath>:<snake_case_event>:<groupIndex>:<handlerIndex>` and
//! the hash covers a normalized identity of the hook.
//!
//! **The hash is asked for, never computed.** It is not the sha256 of the
//! command, the handler, or the file — checked against all three, and against
//! six TOML shapes, none of which reproduce it. It is codex's own
//! serialisation of an internal struct, and reimplementing that here would mean
//! a codex patch release silently flipping every hook to `modified`: no error,
//! no log, just an agent that stops reporting. So the value comes from codex
//! itself, over the `hooks/list` method of `codex app-server`, which is part of
//! its generated protocol schema rather than a private detail.
//!
//! Removal needs no such call: the key BEGINS with the hooks file path, so
//! termic's own entries are identifiable by prefix alone.

use std::path::Path;
use std::process::Stdio;

use serde_json::Value;

/// How long to wait for `codex app-server` to answer `hooks/list`.
///
/// Generous because it is a cold process start (the app-server loads config,
/// plugins and the marketplace cache), and this runs on an explicit click, not
/// a hot path. Bounded because a hung install with no feedback is worse than a
/// failed one that says so.
const LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// One hook codex discovered in a file we wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredHook {
    /// `<sourcePath>:<snake_event>:<group>:<handler>` — the trust-store key.
    pub key: String,
    /// `sha256:…` over codex's normalized hook identity. Opaque here.
    pub hash: String,
    /// What codex thinks of it right now, for reporting rather than logic.
    pub trust_status: String,
}

/// Ask codex which hooks it sees, and keep only the ones that are OURS.
///
/// Ownership is decided the same way the rest of the installer decides it: by
/// the command's path prefix (`<config dir>/termic-hooks/`). A user's own hook
/// in the same file is never touched, never trusted, and never reported here.
/// `source_path` narrows it further to the exact file termic wrote, so a hook
/// with a coincidentally similar command in a project-level file cannot match.
pub fn discover_ours(
    codex_bin: &str,
    codex_home: &Path,
    source_path: &Path,
    command_prefix: &str,
    cwd: &Path,
) -> Result<Vec<DiscoveredHook>, String> {
    let raw = hooks_list(codex_bin, codex_home, cwd)?;
    filter_ours(&raw, source_path, command_prefix)
}

/// The ownership rule, split from the spawn so it can be tested against a
/// recorded response instead of a live codex. Every case it has to get right
/// is a shape question, not a process question.
pub(crate) fn filter_ours(
    raw: &Value,
    source_path: &Path,
    command_prefix: &str,
) -> Result<Vec<DiscoveredHook>, String> {
    let mut out = Vec::new();
    let entries = raw
        .get("result")
        .and_then(|r| r.get("data"))
        .and_then(Value::as_array)
        .ok_or_else(|| "hooks/list returned no data array".to_string())?;
    for entry in entries {
        let Some(hooks) = entry.get("hooks").and_then(Value::as_array) else { continue };
        for h in hooks {
            let (Some(key), Some(hash)) = (
                h.get("key").and_then(Value::as_str),
                h.get("currentHash").and_then(Value::as_str),
            ) else { continue };
            let same_file = h
                .get("sourcePath")
                .and_then(Value::as_str)
                .is_some_and(|p| same_path(Path::new(p), source_path));
            let ours = h
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|c| c.starts_with(command_prefix));
            if !(same_file && ours) {
                continue;
            }
            if out.iter().any(|d: &DiscoveredHook| d.key == key) {
                continue;
            }
            out.push(DiscoveredHook {
                key: key.to_string(),
                hash: hash.to_string(),
                trust_status: h
                    .get("trustStatus")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
            });
        }
    }
    Ok(out)
}

/// One `initialize` + one `hooks/list` over stdio, then kill the child.
///
/// The app-server is a long-lived JSON-RPC peer; termic wants one answer, so it
/// is spawned, asked, and dropped. Reading happens on a worker thread with a
/// join timeout rather than inline, because a child that never answers would
/// otherwise hang the install with the pipe still open.
fn hooks_list(codex_bin: &str, codex_home: &Path, cwd: &Path) -> Result<Value, String> {
    let mut child = crate::proc_ctl::command(codex_bin)
        .arg("app-server")
        // The LOGIN-shell PATH. Same trap `agent_usage` hit in a release
        // build: the GUI hands a packaged app
        // `/usr/bin:/bin:/usr/sbin:/sbin`, and codex lives in `~/.local/bin`.
        .env("PATH", crate::shell_env::resolved_path())
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start `{codex_bin} app-server`: {e}"))?;

    {
        use std::io::Write as _;
        let stdin = child.stdin.as_mut().ok_or("no stdin on codex app-server")?;
        let init = serde_json::json!({
            "id": 1, "method": "initialize",
            "params": { "clientInfo": { "name": "termic", "version": env!("CARGO_PKG_VERSION") } }
        });
        let list = serde_json::json!({
            "id": 2, "method": "hooks/list",
            "params": { "cwds": [cwd.to_string_lossy()] }
        });
        for msg in [init, list] {
            writeln!(stdin, "{msg}").map_err(|e| format!("write to codex app-server: {e}"))?;
        }
        stdin.flush().map_err(|e| format!("flush codex app-server: {e}"))?;
    }

    let stdout = child.stdout.take().ok_or("no stdout on codex app-server")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::BufRead as _;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            // Responses only. The app-server also streams notifications, which
            // have no `id` and are none of our business here.
            if v.get("id").and_then(Value::as_i64) == Some(2) {
                let _ = tx.send(v);
                return;
            }
        }
    });

    let answer = rx.recv_timeout(LIST_TIMEOUT);
    // Kill first, report second: an early return that left the child alive
    // would leak one app-server per failed install.
    let _ = child.kill();
    let _ = child.wait();
    answer.map_err(|_| {
        format!("`{codex_bin} app-server` did not answer hooks/list within {}s", LIST_TIMEOUT.as_secs())
    })
}

/// Are these the same file, allowing for symlinked path prefixes?
///
/// Codex reports the path it RESOLVED, and on macOS the two most likely homes
/// for a scratch config are symlinks: `/tmp` and `/var/folders/...` both live
/// under `/private`. A plain `==` then rejects termic's own hooks file as
/// somebody else's, the install reports "codex did not report the hooks termic
/// just wrote", and the only visible difference is a prefix nobody types.
/// Found exactly that way.
///
/// `canonicalize` needs the file to exist, which it does at every call site
/// (the hooks file was just written). When it fails, the raw comparison stands
/// rather than the paths being treated as equal: a missing file must not widen
/// the match.
fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Add (or refresh) a trust entry per hook, leaving the rest of `config.toml`
/// exactly as the user wrote it.
///
/// Rendered through `toml_edit` for the same reason `mcp_server`'s codex block
/// is: an apostrophe in a home directory is enough to make hand-built TOML
/// unparseable, and codex refuses the WHOLE file over one bad line, which would
/// take the user's model, provider and approval settings down with it.
///
/// Returns the config text to write. Callers do the writing, so this stays a
/// pure function and the tests need no filesystem.
pub fn with_trust(existing: &str, hooks: &[DiscoveredHook]) -> Result<String, String> {
    use toml_edit::{value, DocumentMut, Item, Table};

    let mut doc: DocumentMut = existing
        .parse()
        .map_err(|e| format!("config.toml is not valid TOML: {e}"))?;

    // `[hooks]` and `[hooks.state]` may not exist yet, and either may exist as
    // something that is not a table if the user typed `hooks = "x"`. Refuse in
    // that case rather than replacing it: their file, their mistake to fix, and
    // silently discarding it is how a config editor earns a bug report.
    let hooks_item = doc.entry("hooks").or_insert(Item::Table(Table::new()));
    let hooks_tbl = hooks_item
        .as_table_mut()
        .ok_or("config.toml has a `hooks` key that is not a table")?;
    hooks_tbl.set_implicit(true);
    let state_item = hooks_tbl.entry("state").or_insert(Item::Table(Table::new()));
    let state_tbl = state_item
        .as_table_mut()
        .ok_or("config.toml has a `hooks.state` key that is not a table")?;
    state_tbl.set_implicit(true);

    for h in hooks {
        let entry = state_tbl
            .entry(&h.key)
            .or_insert(Item::Table(Table::new()));
        let t = entry
            .as_table_mut()
            .ok_or_else(|| format!("config.toml has a hooks.state entry for {} that is not a table", h.key))?;
        t["enabled"] = value(true);
        t["trusted_hash"] = value(h.hash.clone());
    }
    Ok(doc.to_string())
}

/// Drop every trust entry whose key names `source_path`, which is exactly the
/// set termic wrote. Needs no call into codex: the key begins with the path.
///
/// Leaves `[hooks.state]` in place when it still holds someone else's entries,
/// and removes the now-empty tables when it does not, so an uninstall does not
/// leave scaffolding behind in a file the user reads.
pub fn without_trust(existing: &str, source_path: &Path) -> Result<String, String> {
    use toml_edit::DocumentMut;

    let mut doc: DocumentMut = existing
        .parse()
        .map_err(|e| format!("config.toml is not valid TOML: {e}"))?;

    // Both spellings, because the KEY carries whatever path codex resolved and
    // the caller passes the one termic wrote. On macOS those differ by a
    // `/private` prefix whenever the config dir sits under a symlink, and a
    // removal that matched only one would leave dead trust entries pointing at
    // hooks that no longer exist. See `same_path`.
    let mut prefixes = vec![format!("{}:", source_path.to_string_lossy())];
    if let Ok(real) = source_path.canonicalize() {
        let p = format!("{}:", real.to_string_lossy());
        if !prefixes.contains(&p) {
            prefixes.push(p);
        }
    }
    let Some(hooks_tbl) = doc.get_mut("hooks").and_then(|h| h.as_table_mut()) else {
        return Ok(doc.to_string());
    };
    if let Some(state_tbl) = hooks_tbl.get_mut("state").and_then(|s| s.as_table_mut()) {
        let doomed: Vec<String> = state_tbl
            .iter()
            .map(|(k, _)| k.to_string())
            .filter(|k| prefixes.iter().any(|p| k.starts_with(p)))
            .collect();
        for k in doomed {
            state_tbl.remove(&k);
        }
        if state_tbl.is_empty() {
            hooks_tbl.remove("state");
        }
    }
    if hooks_tbl.is_empty() {
        doc.remove("hooks");
    }
    Ok(doc.to_string())
}

/// Is there a trust entry for at least one hook from `source_path`?
///
/// Cheap on purpose: reads one file, spawns nothing. `status()` runs for every
/// agent whenever the Settings page mounts, so it cannot afford to ask codex.
///
/// What this catches is trust going MISSING: a user editing `config.toml`, a
/// `codex` that rewrote it, a half-finished install. What it cannot catch is a
/// trust entry whose hash has gone STALE, because only codex can say. That
/// case reads as installed here and shows up as an agent that quietly stops
/// reporting, which is why re-installing is the documented fix and why install
/// always re-asks for the hash rather than assuming the stored one still holds.
pub fn is_trusted_here(config_toml: &str, source_path: &Path) -> bool {
    let Ok(doc) = config_toml.parse::<toml_edit::DocumentMut>() else { return false };
    let mut prefixes = vec![format!("{}:", source_path.to_string_lossy())];
    if let Ok(real) = source_path.canonicalize() {
        prefixes.push(format!("{}:", real.to_string_lossy()));
    }
    doc.get("hooks")
        .and_then(|h| h.get("state"))
        .and_then(|s| s.as_table())
        .is_some_and(|state| {
            state.iter().any(|(k, v)| {
                prefixes.iter().any(|p| k.starts_with(p))
                    && v.get("trusted_hash")
                        .and_then(|h| h.as_str())
                        .is_some_and(|h| !h.is_empty())
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook(key: &str, hash: &str) -> DiscoveredHook {
        DiscoveredHook { key: key.into(), hash: hash.into(), trust_status: "untrusted".into() }
    }

    #[test]
    fn trust_is_added_without_disturbing_the_rest_of_the_config() {
        let existing = "model = \"gpt-5\"\n\n[tui]\ntheme = \"dark\"\n";
        let out = with_trust(
            existing,
            &[hook("/Users/u/.codex/hooks.json:session_start:0:0", "sha256:aa")],
        )
        .unwrap();
        assert!(out.contains("model = \"gpt-5\""), "the user's own keys survive");
        assert!(out.contains("[tui]"), "and their own tables");
        assert!(out.contains("enabled = true"));
        assert!(out.contains("trusted_hash = \"sha256:aa\""));
        // The key holds `:` and `/`, so it MUST come back quoted or codex reads
        // it as a nested table path and the trust never matches a hook.
        assert!(
            out.contains("[hooks.state.\"/Users/u/.codex/hooks.json:session_start:0:0\"]"),
            "key must be quoted, got:\n{out}"
        );
        assert!(out.parse::<toml_edit::DocumentMut>().is_ok());
    }

    #[test]
    fn re_trusting_updates_the_hash_rather_than_duplicating_the_entry() {
        // The hash changes whenever the hook body does, which is every schema
        // bump. A second entry for the same key is not valid TOML, so this is
        // the difference between a re-install working and codex refusing the
        // whole config.
        let once = with_trust("", &[hook("k:session_start:0:0", "sha256:old")]).unwrap();
        let twice = with_trust(&once, &[hook("k:session_start:0:0", "sha256:new")]).unwrap();
        assert!(twice.contains("sha256:new"));
        assert!(!twice.contains("sha256:old"));
        assert_eq!(twice.matches("[hooks.state.").count(), 1);
        assert!(twice.parse::<toml_edit::DocumentMut>().is_ok());
    }

    #[test]
    fn a_home_dir_with_an_apostrophe_still_produces_parseable_toml() {
        // The exact class of bug the mcp_server codex block was fixed for.
        let out = with_trust(
            "",
            &[hook("/Users/o'brien/.codex/hooks.json:stop:0:0", "sha256:bb")],
        )
        .unwrap();
        assert!(out.parse::<toml_edit::DocumentMut>().is_ok(), "got:\n{out}");
    }

    #[test]
    fn removal_drops_only_our_entries_and_cleans_up_after_itself() {
        let mine = "/Users/u/.codex/hooks.json";
        let start = with_trust(
            "",
            &[
                hook(&format!("{mine}:session_start:0:0"), "sha256:aa"),
                hook(&format!("{mine}:stop:1:0"), "sha256:bb"),
            ],
        )
        .unwrap();
        let out = without_trust(&start, Path::new(mine)).unwrap();
        assert!(!out.contains("hooks.state"), "empty tables must go too, got:\n{out}");
        assert!(out.parse::<toml_edit::DocumentMut>().is_ok());
    }

    #[test]
    fn removal_keeps_a_trust_entry_the_user_made_for_their_own_hook() {
        let mine = "/Users/u/.codex/hooks.json";
        let theirs = "/Users/u/.codex/mine.json";
        let start = with_trust(
            "",
            &[
                hook(&format!("{mine}:stop:0:0"), "sha256:aa"),
                hook(&format!("{theirs}:stop:0:0"), "sha256:cc"),
            ],
        )
        .unwrap();
        let out = without_trust(&start, Path::new(mine)).unwrap();
        assert!(out.contains("mine.json"), "someone else's trust is not ours to revoke");
        assert!(!out.contains("hooks.json:stop"), "ours goes, got:\n{out}");
        assert!(out.parse::<toml_edit::DocumentMut>().is_ok());
    }

    #[test]
    fn a_path_prefix_that_merely_starts_the_same_is_not_ours() {
        // `hooks.json` vs `hooks.json.bak`: the trailing `:` in the prefix is
        // what stops the second being swept up with the first.
        let start = with_trust(
            "",
            &[hook("/h/hooks.json.bak:stop:0:0", "sha256:dd")],
        )
        .unwrap();
        let out = without_trust(&start, Path::new("/h/hooks.json")).unwrap();
        assert!(out.contains("hooks.json.bak"), "got:\n{out}");
    }

    #[test]
    fn trust_presence_is_readable_without_asking_codex() {
        let mine = "/h/hooks.json";
        let cfg = with_trust("", &[hook(&format!("{mine}:stop:0:0"), "sha256:aa")]).unwrap();
        assert!(is_trusted_here(&cfg, Path::new(mine)));
        // Someone else's trust is not ours.
        assert!(!is_trusted_here(&cfg, Path::new("/h/other.json")));
        // A stripped config reads as untrusted, which is what makes the status
        // honest after a user edits config.toml by hand.
        let stripped = without_trust(&cfg, Path::new(mine)).unwrap();
        assert!(!is_trusted_here(&stripped, Path::new(mine)));
        // An entry with `enabled` but no hash is codex's `untrusted` state.
        assert!(!is_trusted_here(
            "[hooks.state.\"/h/hooks.json:stop:0:0\"]\nenabled = true\n",
            Path::new(mine)
        ));
        // And an unreadable config is not a trusted one.
        assert!(!is_trusted_here("= = =", Path::new(mine)));
    }

    #[test]
    fn an_unparseable_config_is_refused_rather_than_overwritten() {
        // Same call as mcp_server's: a config we cannot read is not a config we
        // may replace. Losing a user's model/provider settings to a hook
        // install would be a far worse bug than the install failing.
        assert!(with_trust("this is not = = toml", &[hook("k:stop:0:0", "sha256:aa")]).is_err());
        assert!(without_trust("this is not = = toml", Path::new("/h/hooks.json")).is_err());
    }

    #[test]
    fn a_hooks_key_that_is_not_a_table_is_refused_rather_than_clobbered() {
        assert!(with_trust("hooks = \"nope\"\n", &[hook("k:stop:0:0", "sha256:aa")]).is_err());
    }

    #[test]
    fn discovery_keeps_only_hooks_from_our_file_with_our_command_prefix() {
        let raw = serde_json::json!({
            "id": 2,
            "result": { "data": [ { "cwd": "/p", "warnings": [], "errors": [], "hooks": [
                // Ours.
                { "key": "/h/hooks.json:session_start:0:0", "currentHash": "sha256:aa",
                  "sourcePath": "/h/hooks.json", "trustStatus": "untrusted",
                  "command": "/h/termic-hooks/ready.sh" },
                // Right file, someone else's command.
                { "key": "/h/hooks.json:stop:1:0", "currentHash": "sha256:bb",
                  "sourcePath": "/h/hooks.json", "trustStatus": "untrusted",
                  "command": "/usr/local/bin/my-own-hook" },
                // Our command shape, but a file we did not write. A project
                // config copied from someone's dotfiles looks exactly like
                // this, and trusting it would be trusting a stranger's script.
                { "key": "/proj/.codex/hooks.json:stop:0:0", "currentHash": "sha256:cc",
                  "sourcePath": "/proj/.codex/hooks.json", "trustStatus": "untrusted",
                  "command": "/h/termic-hooks/done.sh" },
            ] } ] }
        });
        let picked = super::filter_ours(&raw, Path::new("/h/hooks.json"), "/h/termic-hooks/").unwrap();
        assert_eq!(picked.len(), 1);
        assert_eq!(picked[0].key, "/h/hooks.json:session_start:0:0");
        assert_eq!(picked[0].hash, "sha256:aa");
    }

    #[test]
    fn a_response_with_no_data_is_an_error_not_an_empty_install() {
        // Silently reporting "0 hooks trusted" would leave the user with an
        // install that looks complete and reports nothing.
        assert!(super::filter_ours(&serde_json::json!({"id": 2}), Path::new("/h"), "/h/").is_err());
    }
}
