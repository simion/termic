// repo_config.rs — the repo-root `.termic.yaml`.
//
// `.termic.yaml` is committed to the repo and shared by the termic GUI
// and (phase 2) the standalone `termic` CLI. It owns repo-shared
// behavior config: setup/run/archive scripts, the preview URL template,
// files-to-copy globs, and the agent sandbox allow-lists.
//
// SECURITY: termic always reads/writes `.termic.yaml` at the project's
// `root_path` (the user's main checkout), never a per-workspace
// worktree. That path is OUTSIDE every per-workspace sandbox, so a
// caged agent cannot write the config that gates its own sandbox.
// See `repo_config_for` in lib.rs.
//
// Plain serde round-trip via `serde_yml` — read into `RepoConfig`,
// write back. Hand-written comments are not preserved across a write.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const FILE_NAME: &str = ".termic.yaml";

/// Which sandbox allow-list a write targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AllowKind {
    Host,
    Path,
}

// ───────────────────────────── schema ─────────────────────────────

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RepoConfig {
    pub version: u32,
    pub scripts: RepoScripts,
    pub sandbox: RepoSandbox,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RepoScripts {
    pub setup: String,
    pub run: String,
    pub archive: String,
    /// Preview URL template — same `$PORT` / `$TERMIC_PORT` expansion
    /// as the project's legacy `preview_url`.
    pub preview_url: String,
    /// Globs copied from the repo root into each new workspace worktree.
    #[serde(deserialize_with = "de_vec")]
    pub files_to_copy: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RepoSandbox {
    /// New workspaces of this repo start sandboxed when true.
    pub enabled_by_default: bool,
    /// Extra allowed-host regexes for the per-workspace network proxy,
    /// on top of the built-in per-CLI + package-registry allow-list.
    #[serde(deserialize_with = "de_vec")]
    pub allowed_hosts: Vec<String>,
    /// Extra writable paths, on top of the built-in defaults. `$HOME`
    /// and `$WORKSPACE` tokens are expanded at spawn time.
    #[serde(deserialize_with = "de_vec")]
    pub allowed_paths: Vec<String>,
}

/// Deserialize a list that may be written as YAML null (`key:` with no
/// value) into an empty `Vec`. Plain `#[serde(default)]` only covers an
/// absent key, not an explicit null.
fn de_vec<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<Vec<String>>::deserialize(d)?.unwrap_or_default())
}

// ───────────────────────────── load ─────────────────────────────

/// Read `<repo_root>/.termic.yaml`. `Ok(None)` = file absent (fine —
/// the project falls back to legacy `projects.json` fields). `Err` =
/// the file exists but is malformed; callers surface that to the user.
pub fn load(repo_root: &Path) -> Result<Option<RepoConfig>> {
    let path = repo_root.join(FILE_NAME);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let cfg: RepoConfig =
        serde_yml::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    Ok(Some(cfg))
}

/// Best-effort load for the spawn hot path — never fails, yields an
/// empty config when the file is missing or malformed.
pub fn load_or_default(repo_root: &Path) -> RepoConfig {
    load(repo_root).ok().flatten().unwrap_or_default()
}

// ───────────────────────────── write ─────────────────────────────

/// Write `cfg` to `<repo_root>/.termic.yaml`.
pub fn save(repo_root: &Path, cfg: &RepoConfig) -> Result<()> {
    let mut cfg = cfg.clone();
    if cfg.version == 0 {
        cfg.version = 1;
    }
    let raw = serde_yml::to_string(&cfg).context("serialize .termic.yaml")?;
    let text = indent_block_sequences(&raw);
    let path = repo_root.join(FILE_NAME);
    std::fs::write(&path, text).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

/// serde_yml places block-sequence items at the same indentation as their
/// parent key. This post-processor indents them by parent_indent + 2 so
/// the output looks like:
///
/// ```yaml
/// allowed_hosts:
///   - api.example.com
/// ```
///
/// instead of:
///
/// ```yaml
/// allowed_hosts:
/// - api.example.com
/// ```
fn indent_block_sequences(yaml: &str) -> String {
    let mut result: Vec<String> = Vec::new();
    for line in yaml.lines() {
        let trimmed = line.trim_start();
        let raw_indent = line.len() - trimmed.len();
        if trimmed.starts_with("- ") || trimmed == "-" {
            // Find the most-recent non-sequence-item line to determine
            // the parent key's indentation.
            let parent_indent = result
                .iter()
                .rev()
                .find(|l| {
                    let t = l.trim_start();
                    !t.starts_with("- ") && t != "-" && !t.is_empty()
                })
                .map(|l| l.len() - l.trim_start().len())
                .unwrap_or(0);
            let target = parent_indent + 2;
            let extra = target.saturating_sub(raw_indent);
            result.push(format!("{}{}", " ".repeat(extra), line));
        } else {
            result.push(line.to_string());
        }
    }
    let mut out = result.join("\n");
    if yaml.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Write a fresh `.termic.yaml` if the repo has none. No-op when one
/// already exists. Returns `true` if a file was created.
pub fn scaffold(repo_root: &Path) -> Result<bool> {
    if repo_root.join(FILE_NAME).exists() {
        return Ok(false);
    }
    save(repo_root, &RepoConfig::default())?;
    Ok(true)
}

/// Append `value` to the repo's `.termic.yaml` sandbox allow-list,
/// creating the file if absent. No-op if already present.
pub fn add_allowed(repo_root: &Path, kind: AllowKind, value: &str) -> Result<()> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(());
    }
    let mut cfg = load_or_default(repo_root);
    let list = match kind {
        AllowKind::Host => &mut cfg.sandbox.allowed_hosts,
        AllowKind::Path => &mut cfg.sandbox.allowed_paths,
    };
    if list.iter().any(|v| v == value) {
        return Ok(());
    }
    list.push(value.to_string());
    save(repo_root, &cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let cfg = RepoConfig {
            scripts: RepoScripts {
                setup: "npm install\nnpm test".into(),
                run: "npm run dev".into(),
                files_to_copy: vec![".env".into(), ".env.local".into()],
                ..Default::default()
            },
            ..Default::default()
        };
        save(p, &cfg).unwrap();
        let reloaded = load(p).unwrap().unwrap();
        assert_eq!(reloaded.scripts.setup, "npm install\nnpm test");
        assert_eq!(reloaded.scripts.run, "npm run dev");
        assert_eq!(reloaded.scripts.files_to_copy, vec![".env", ".env.local"]);
    }

    #[test]
    fn add_allowed_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        add_allowed(p, AllowKind::Host, "api.example.com").unwrap();
        add_allowed(p, AllowKind::Host, "api.example.com").unwrap();
        add_allowed(p, AllowKind::Path, "$HOME/.cache").unwrap();
        let cfg = load(p).unwrap().unwrap();
        assert_eq!(cfg.sandbox.allowed_hosts, vec!["api.example.com"]);
        assert_eq!(cfg.sandbox.allowed_paths, vec!["$HOME/.cache"]);
    }
}
