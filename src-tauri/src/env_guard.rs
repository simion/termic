//! Env vars Termic keeps out of agent tabs (Settings > Secrets, "Kept out of
//! agents"). Termic launched from a shell inherits that shell's exports, and
//! every agent it spawns would inherit them in turn: a `GITHUB_TOKEN` meant
//! for the user's own `gh` ends up readable by a caged agent.
//!
//! A var is on the list when its name is built in, its value looks like a
//! token (`secrets::token_prefix`), or the user added it. Listed vars are
//! kept from caged agents; a rule with `all` keeps one from every agent.
//! Pass-through (`Agent.pass_env`) and the agent's own login var always win.
//! Agent tabs only: terminals and scripts see everything, and Docker spawns
//! never get host env to begin with.

use serde::{Deserialize, Serialize};

use crate::secrets::token_prefix;

/// The user's choice about one name: one they added, or a scope change on a
/// built-in or detected one.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub name: String,
    /// Keep it from uncaged agents too, not just caged ones.
    #[serde(default)]
    pub all: bool,
}

/// Credentials with no recognisable value shape, so only the name gives them
/// away. Tokens with a known prefix are caught under any name.
pub const BUILTIN: &[&str] = &[
    "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
    "GITLAB_TOKEN", "GL_TOKEN",
    "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "AZURE_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS",
    "NPM_TOKEN", "HF_TOKEN", "DOCKER_PASSWORD",
];

/// The vars an agent reads for its OWN login. Never kept from that agent,
/// or a user who signs in through the env would get a broken agent.
// ponytail: claude/codex/gemini are documented; the rest is each CLI's usual
// key var, unmeasured. A miss means that agent needs a pass-through.
pub fn own_login(base: &str) -> &'static [&'static str] {
    match base {
        "claude" => &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
        "codex" => &["OPENAI_API_KEY", "CODEX_API_KEY"],
        "gemini" => &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        "copilot" => &["COPILOT_GITHUB_TOKEN"],
        "grok" => &["XAI_API_KEY"],
        "cursor" => &["CURSOR_API_KEY"],
        // multi-provider CLIs read whichever provider key is set
        "opencode" | "pi" | "omp" => &["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"],
        _ => &[],
    }
}

/// One spawn's decision, built once per agent spawn.
pub struct Guard {
    rules: Vec<Rule>,
    keep: Vec<String>,
    caged: bool,
}

impl Guard {
    /// `pass` is the agent's `pass_env`, `own` its `own_login`.
    pub fn new(rules: &[Rule], pass: &[String], own: &[&str], caged: bool) -> Self {
        let keep = pass.iter().cloned().chain(own.iter().map(|s| s.to_string())).collect();
        Guard { rules: rules.to_vec(), keep, caged }
    }

    pub fn keeps_out(&self, name: &str, value: &str) -> bool {
        if self.keep.iter().any(|k| k == name) {
            return false;
        }
        let rule = self.rules.iter().find(|r| r.name == name);
        let listed = rule.is_some() || BUILTIN.contains(&name) || token_prefix(value).is_some();
        listed && (self.caged || rule.is_some_and(|r| r.all))
    }
}

/// One row of the Secrets page card. Names only, never any of the value.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct KeptOut {
    pub name: String,
    /// `builtin`, `detected` (the value looks like a token) or `added`.
    pub reason: &'static str,
    /// Set in Termic's own environment right now.
    pub set: bool,
    pub all: bool,
    /// The Add secret preset a detected token fits, if any.
    pub preset: Option<&'static str>,
    /// Agent ids that read this var for their own login, so always get it.
    pub own_login_of: Vec<String>,
}

fn preset_for(prefix: &str) -> &'static str {
    match prefix {
        "sk-ant-" => "anthropic",
        p if p.starts_with("sk-") => "openai",
        _ => "github",
    }
}

/// Every listed var: the ones set in `env`, plus every rule's name whether
/// set or not. `agents` is (agent id, its own login vars).
pub fn list(rules: &[Rule], agents: &[(String, &[&str])], env: impl IntoIterator<Item = (String, String)>) -> Vec<KeptOut> {
    let row = |name: &str, value: Option<&str>| -> Option<KeptOut> {
        let rule = rules.iter().find(|r| r.name == name);
        let prefix = value.and_then(token_prefix);
        let reason = if BUILTIN.contains(&name) { "builtin" } else if prefix.is_some() { "detected" } else if rule.is_some() { "added" } else { return None };
        Some(KeptOut {
            name: name.to_string(),
            reason,
            set: value.is_some(),
            all: rule.is_some_and(|r| r.all),
            preset: prefix.map(preset_for),
            own_login_of: agents.iter().filter(|(_, own)| own.contains(&name)).map(|(id, _)| id.clone()).collect(),
        })
    };
    let mut out: Vec<KeptOut> = env.into_iter().filter_map(|(k, v)| row(&k, Some(&v))).collect();
    for r in rules {
        if !out.iter().any(|o| o.name == r.name) {
            out.extend(row(&r.name, None));
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// A rule list fit to save: valid names, no duplicates.
pub fn validate(rules: &[Rule]) -> Result<(), String> {
    for (i, r) in rules.iter().enumerate() {
        if !crate::secrets::env_name_ok(&r.name) || r.name.len() > 128 {
            return Err(format!("{:?} is not an environment variable name", r.name));
        }
        if rules[..i].iter().any(|x| x.name == r.name) {
            return Err(format!("{} is listed twice", r.name));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOK: &str = "ghp_0123456789abcdefghij0123456789abcd";

    fn rule(name: &str, all: bool) -> Rule {
        Rule { name: name.into(), all }
    }

    #[test]
    fn caged_keeps_out_listed_and_detected() {
        let g = Guard::new(&[], &[], &[], true);
        assert!(g.keeps_out("GITHUB_TOKEN", "anything"), "built-in name");
        assert!(g.keeps_out("MY_PAT", TOK), "detected by value");
        assert!(!g.keeps_out("EDITOR", "vim"));
        assert!(!g.keeps_out("MY_PAT", "ghp_"), "a bare prefix is not a token");
    }

    #[test]
    fn uncaged_keeps_out_only_all_rules() {
        let rules = [rule("STRIPE_SECRET_KEY", true), rule("GITHUB_TOKEN", false)];
        let g = Guard::new(&rules, &[], &[], false);
        assert!(g.keeps_out("STRIPE_SECRET_KEY", "x"));
        assert!(!g.keeps_out("GITHUB_TOKEN", TOK), "caged-only rule");
        assert!(!g.keeps_out("AWS_SECRET_ACCESS_KEY", "x"), "built-in defaults to caged");
        let all = [rule("AWS_SECRET_ACCESS_KEY", true)];
        assert!(Guard::new(&all, &[], &[], false).keeps_out("AWS_SECRET_ACCESS_KEY", "x"));
    }

    #[test]
    fn pass_through_and_own_login_win() {
        let rules = [rule("GITHUB_TOKEN", true)];
        let g = Guard::new(&rules, &["GITHUB_TOKEN".into()], own_login("claude"), true);
        assert!(!g.keeps_out("GITHUB_TOKEN", TOK), "passed through");
        assert!(!g.keeps_out("ANTHROPIC_API_KEY", "sk-ant-api03-0123456789abcdefghij_xyz"), "claude's own login");
        let codex = Guard::new(&[], &[], own_login("codex"), true);
        assert!(codex.keeps_out("ANTHROPIC_API_KEY", "sk-ant-api03-0123456789abcdefghij_xyz"), "not codex's login");
    }

    #[test]
    fn list_names_only_and_includes_unset_rules() {
        let env = vec![
            ("GITHUB_TOKEN".to_string(), TOK.to_string()),
            ("MY_KEY".to_string(), "sk-proj-0123456789abcdefghij-xyz".to_string()),
            ("HOME".to_string(), "/Users/alice".to_string()),
        ];
        let rules = [rule("STRIPE_SECRET_KEY", true), rule("GITHUB_TOKEN", true)];
        let codex_own: &[&str] = own_login("codex");
        let agents = vec![("codex".to_string(), codex_own)];
        let got = list(&rules, &agents, env);
        let names: Vec<&str> = got.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["GITHUB_TOKEN", "MY_KEY", "STRIPE_SECRET_KEY"]);
        assert_eq!((got[0].reason, got[0].all, got[0].preset), ("builtin", true, Some("github")));
        assert_eq!((got[1].reason, got[1].preset), ("detected", Some("openai")));
        assert_eq!((got[2].reason, got[2].set), ("added", false));
        let json = serde_json::to_string(&got).unwrap();
        assert!(!json.contains("0123456789"), "a value leaked: {json}");
    }

    #[test]
    fn validate_refuses_bad_and_duplicate_names() {
        assert!(validate(&[rule("STRIPE_SECRET_KEY", true)]).is_ok());
        assert!(validate(&[rule("1BAD", true)]).is_err());
        assert!(validate(&[rule("A B", true)]).is_err());
        assert!(validate(&[rule("X", true), rule("X", false)]).is_err());
    }
}
