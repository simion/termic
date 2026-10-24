//! Secrets and roles: the data model behind the credential broker
//! (spec/credential-broker/plan.md). A secret points at a Keychain item and
//! never holds its value; a role is a set of secrets plus rules for what an
//! agent may do with them. One role per task, resolved at spawn.
//!
//! The value of a secret is only ever read by `broker`, on its way upstream.
//! Nothing here (and no Tauri command) returns one.

use serde::{Deserialize, Serialize};

/// How the Keychain item is stored, which is also where it is. gh uses a
/// generic password (`gh:github.com` / account); git's osxkeychain helper an
/// internet one. Both are in the file-based login keychain. `Protected` is a
/// generic password in the data protection keychain, only ever an item
/// Termic wrote (`broker/keychain.rs`).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum KeychainKind {
    #[default]
    Generic,
    Internet,
    Protected,
    /// A kind a newer Termic wrote. Parsed instead of failing the whole
    /// settings file (which falls back to defaults), never read.
    #[serde(other)]
    Unknown,
}

/// How a secret reaches the tools that use it (`broker/recipe.rs`). GitHub:
/// gh over its `http_unix_socket`, git through the MITM proxy with a
/// URL-scoped CA. API key: an env var placeholder, swapped in one header,
/// reached over a base-URL endpoint or the task's proxy.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Recipe {
    #[default]
    Github,
    ApiKey,
    /// A recipe a newer Termic wrote. Inert: no routes, so the broker never
    /// binds it. Re-saved as `unknown`, which beats losing every setting.
    #[serde(other)]
    Unknown,
}

impl Recipe {
    /// Hosts a recipe needs by default. Shown as chips; the user may trim.
    pub fn default_hosts(self) -> Vec<String> {
        match self {
            Recipe::Github => vec!["api.github.com".into(), "github.com".into(), "uploads.github.com".into()],
            Recipe::ApiKey | Recipe::Unknown => Vec::new(),
        }
    }
}

/// How an API key secret is handed to tools. Only read when `recipe` is
/// `api_key`.
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct ApiKeyCfg {
    /// The one header the real value goes into: `authorization`, `x-api-key`.
    pub header: String,
    /// Prefix before the value in that header (`Bearer`), empty for none.
    pub scheme: String,
    /// Env var the agent gets the placeholder in (`OPENAI_API_KEY`).
    pub env: String,
    /// Env var pointing the tool at the broker (`OPENAI_BASE_URL`); empty
    /// when the tool has no such knob. Needs `base_url`.
    pub base_url_env: String,
    /// The real base URL the env var would otherwise hold
    /// (`https://api.openai.com/v1`). Its host must be one of `hosts`.
    pub base_url: String,
}

/// Keychain service prefix for items Termic writes itself (a pasted API
/// key), as opposed to pointing at an item another tool owns.
pub const OWNED_SERVICE_PREFIX: &str = "termic:";
pub const OWNED_ACCOUNT: &str = "termic";

pub fn owned_service(id: &str) -> String { format!("{OWNED_SERVICE_PREFIX}{id}") }

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct SecretDef {
    pub id: String,
    /// Display name, also what `.termic.yaml` would request it by.
    pub name: String,
    pub kind: KeychainKind,
    /// Keychain service, e.g. `gh:github.com`.
    pub service: String,
    /// Keychain account. Always explicit: never gh's empty "active" slot, so
    /// `gh auth switch` on the host cannot change what agents get.
    pub account: String,
    pub recipe: Recipe,
    /// Hosts the real value may be sent to. Exact hostnames.
    pub hosts: Vec<String>,
    pub api: ApiKeyCfg,
}

impl SecretDef {
    /// Whether Termic wrote this item and so deletes it with the secret.
    pub fn is_owned(&self) -> bool {
        self.service == owned_service(&self.id) && self.account == OWNED_ACCOUNT
    }
}

/// Ids name Keychain items (`termic:<id>`) and spawn paths: keep them plain.
pub fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Env vars an API key secret may not claim: the cage's own wiring, the
/// loader, and the proxy and CA vars the broker sets itself.
fn env_reserved(name: &str) -> bool {
    let u = name.to_ascii_uppercase();
    const EXACT: &[&str] = &[
        "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "PWD", "TERM",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS",
    ];
    const PREFIX: &[&str] = &["DYLD_", "LD_", "TERMIC_", "GIT_", "GH_", "SANDBOX"];
    EXACT.contains(&u.as_str()) || PREFIX.iter().any(|p| u.starts_with(p))
}

fn env_name_ok(name: &str) -> bool {
    let mut b = name.bytes();
    b.next().is_some_and(|c| c.is_ascii_alphabetic() || c == b'_') && b.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Headers whose value the broker must never rewrite: framing, routing and
/// the proxy's own credentials.
fn header_reserved(name: &str) -> bool {
    ["host", "content-length", "transfer-encoding", "connection", "proxy-connection", "keep-alive",
        "upgrade", "te", "trailer", "proxy-authorization", "expect"]
        .iter().any(|h| name.eq_ignore_ascii_case(h))
}

/// RFC 9110 token characters, so the name cannot smuggle `:` or CRLF.
fn header_name_ok(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// A plain lowercase DNS name: what every host in secrets, rule sets and
/// allows must be, because the broker matches them against a lowercased
/// `Host` and a mismatch would miss the host's rules.
pub fn host_ok(h: &str) -> bool {
    !h.is_empty() && h.len() <= 253 && !h.starts_with(['.', '-']) && !h.ends_with('.')
        && h.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

/// The host of an `https://host[/path]` base URL, lowercased.
pub fn base_url_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let host = rest.split('/').next()?;
    let ok = !host.is_empty() && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    ok.then(|| host.to_ascii_lowercase())
}

fn validate_api_key(s: &SecretDef, out: &mut Vec<String>) {
    let a = &s.api;
    let n = &s.name;
    if !header_name_ok(&a.header) || header_reserved(&a.header) {
        out.push(format!("secret {n}: \"{}\" cannot carry a secret", a.header));
    }
    if !a.scheme.is_empty() && !header_name_ok(&a.scheme) {
        out.push(format!("secret {n}: the header prefix must be one word, like Bearer"));
    }
    for (what, v) in [("placeholder", &a.env), ("base URL", &a.base_url_env)] {
        if v.is_empty() && what == "base URL" { continue; }
        if !env_name_ok(v) {
            out.push(format!("secret {n}: the {what} env var must be a name like OPENAI_API_KEY"));
        } else if env_reserved(v) {
            out.push(format!("secret {n}: Termic sets {v} itself"));
        }
    }
    if !a.base_url_env.is_empty() && a.base_url_env.eq_ignore_ascii_case(&a.env) {
        out.push(format!("secret {n}: the placeholder and base URL need different env vars"));
    }
    match (a.base_url_env.is_empty(), a.base_url.trim().is_empty()) {
        (true, true) => {}
        (false, false) => match base_url_host(a.base_url.trim()) {
            None => out.push(format!("secret {n}: the base URL must look like https://api.example.com/v1")),
            Some(h) if !s.hosts.iter().any(|x| x.eq_ignore_ascii_case(&h)) => {
                out.push(format!("secret {n}: the base URL's host {h} is not one of its hosts"));
            }
            Some(_) => {}
        },
        _ => out.push(format!("secret {n}: a base URL env var and a base URL go together")),
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Effect {
    #[default]
    Allow,
    Deny,
}

/// One rule line. `methods` are HTTP verbs (`GET`, `POST`, ...), `*`, or the
/// pseudo-methods `QUERY` / `MUTATION` for `POST /graphql` bodies (then
/// `pattern` globs the mutation name, `*` for any), or `fetch` / `push` for
/// git (then `pattern` globs `owner/repo`). For HTTP `pattern` is a path glob:
/// `*` matches one segment, `**` any number.
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct Rule {
    pub effect: Effect,
    pub methods: Vec<String>,
    pub pattern: String,
    /// Free text shown beside the rule ("leave reviews").
    pub note: String,
    /// Kept in the list but skipped when judging, so a rule can be turned
    /// off without losing it. Omitted from settings while false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub disabled: bool,
}

/// The rules for one secret on one host. First match wins, else `fallback`.
/// An absent rule set takes the role's default (`Role::default_effect`).
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct RuleSet {
    pub secret: String,
    pub host: String,
    pub rules: Vec<Rule>,
    pub fallback: Effect,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct Role {
    pub id: String,
    pub name: String,
    /// One of the swatch names: blue, purple, teal, amber, pink.
    pub colour: String,
    pub description: String,
    /// Secret ids.
    pub secrets: Vec<String>,
    pub rule_sets: Vec<RuleSet>,
}

impl Role {
    /// What a (secret, host) with no rule set gets. A role with any deny
    /// fallback was written deny-by-default (the Reviewer template), so a host
    /// added later, or a set dropped by an edit, must not open up: it denies.
    /// A role with no deny fallback anywhere allows, as before.
    pub fn default_effect(&self) -> Effect {
        if self.rule_sets.iter().any(|s| s.fallback == Effect::Deny) { Effect::Deny } else { Effect::Allow }
    }
}

/// A one-off allow saved from the task's Secrets popover with the "this task"
/// scope. Checked before the role's rules.
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct TaskAllow {
    pub secret: String,
    pub host: String,
    pub rule: Rule,
}

/// The role a task's agent runs with, first match wins: the task's own pick,
/// the project's default, the agent's default, else none. `Some("")` on the
/// task is an explicit "No secrets" that overrides the defaults.
///
/// Gated on the Keychain block: an agent that can read the Keychain can read
/// the real token itself, so brokering for it would protect nothing.
pub fn resolve_role<'a>(
    task_role: Option<&str>,
    project_default: Option<&str>,
    agent_default: Option<&str>,
    keychain_blocked: bool,
    roles: &'a [Role],
) -> Option<&'a Role> {
    if !keychain_blocked {
        return None;
    }
    let id = task_role.or(project_default).or(agent_default)?;
    if id.is_empty() {
        return None;
    }
    roles.iter().find(|r| r.id == id)
}

/// Save-time checks. Returns the human-readable problems, empty when valid.
pub fn validate(secrets: &[SecretDef], roles: &[Role]) -> Vec<String> {
    let mut out = Vec::new();
    let mut names = std::collections::HashSet::new();
    for s in secrets {
        if !names.insert(s.name.trim()) {
            out.push(format!("two secrets are named {}", s.name.trim()));
        }
        if s.service.trim().is_empty() || s.account.trim().is_empty() {
            out.push(format!("secret {}: Keychain service and account are both required", s.name));
        }
        if s.hosts.is_empty() {
            out.push(format!("secret {}: needs at least one host", s.name));
        }
        if !id_ok(&s.id) {
            out.push(format!("secret {}: bad id", s.name));
        }
        if s.recipe == Recipe::Unknown || s.kind == KeychainKind::Unknown {
            out.push(format!("secret {}: saved by a newer Termic, remove it or update Termic", s.name));
        }
        for h in s.hosts.iter().filter(|h| !host_ok(h)) {
            out.push(format!("secret {}: \"{h}\" is not a host name like api.github.com", s.name));
        }
        // a protected item is one Termic wrote; nothing else lives there.
        if s.kind == KeychainKind::Protected && !s.is_owned() {
            out.push(format!("secret {}: only a value Termic stored can be in the protected Keychain", s.name));
        }
        if s.recipe == Recipe::ApiKey {
            validate_api_key(s, &mut out);
        }
    }
    for r in roles {
        validate_rule_sets(r, &mut out);
        // one secret per host per role, or the broker cannot tell which to use.
        let mut seen: std::collections::HashMap<&str, &str> = Default::default();
        let mut envs: std::collections::HashMap<String, &str> = Default::default();
        for sid in &r.secrets {
            let Some(s) = secrets.iter().find(|s| &s.id == sid) else {
                out.push(format!("role {}: unknown secret {sid}", r.name));
                continue;
            };
            for h in &s.hosts {
                if let Some(prev) = seen.insert(h.as_str(), s.name.as_str()) {
                    out.push(format!("role {}: {} and {} both reach {h}", r.name, prev, s.name));
                }
            }
            // two API keys on one env var: one would never reach its tool.
            if s.recipe == Recipe::ApiKey {
                for v in [&s.api.env, &s.api.base_url_env].into_iter().filter(|v| !v.is_empty()) {
                    if let Some(prev) = envs.insert(v.to_ascii_uppercase(), s.name.as_str()) {
                        out.push(format!("role {}: {} and {} both set {v}", r.name, prev, s.name));
                    }
                }
            }
        }
    }
    out
}

/// A rule must say what it matches: an empty method list matches nothing
/// (a DENY that looks real and is not), and an empty pattern matches every
/// path. Only QUERY ignores its pattern.
fn validate_rule_sets(r: &Role, out: &mut Vec<String>) {
    for set in &r.rule_sets {
        if !host_ok(&set.host) {
            out.push(format!("role {}: \"{}\" is not a host name like api.github.com", r.name, set.host));
        }
        for rule in &set.rules {
            let methods: Vec<&str> = rule.methods.iter().map(|m| m.trim()).filter(|m| !m.is_empty()).collect();
            if methods.is_empty() {
                out.push(format!("role {}: a rule on {} has no method", r.name, set.host));
            } else if rule.pattern.trim().is_empty() && !methods.iter().all(|m| m.eq_ignore_ascii_case("QUERY")) {
                out.push(format!("role {}: a rule on {} has no pattern", r.name, set.host));
            }
        }
    }
}

// ───────────────────────── allows from the popover ─────────────────────────

/// Input checks shared by both `broker_allow` scopes. The secret must exist
/// and the host must be one it may be sent to, or the rule could never match.
pub fn check_allow(secrets: &[SecretDef], secret: &str, host: &str, rule: &Rule) -> Result<(), String> {
    let s = secrets.iter().find(|s| s.id == secret).ok_or_else(|| format!("no such secret: {secret}"))?;
    if !s.hosts.iter().any(|h| h == host) {
        return Err(format!("secret {} is not bound to {host}", s.name));
    }
    if rule.effect != Effect::Allow {
        return Err("only allow rules can be saved from here".into());
    }
    if rule.methods.iter().all(|m| m.trim().is_empty()) || rule.pattern.trim().is_empty() {
        return Err("a rule needs a method and a pattern".into());
    }
    // the popover builds this rule from a blocked request, whose path the
    // agent controls. A `*` there would turn one click into a wildcard grant,
    // so only exact rules come in this way; wildcards are for the role editor.
    // `<...>` names a mutation the classifier could not read (`<unparsed>`):
    // allowing one by name would let any hidden mutation through.
    let exact = |v: &str| !v.contains('*') && !v.contains('?') && !v.contains(char::is_whitespace) && !v.starts_with('<');
    if rule.methods.len() != 1 || !exact(&rule.methods[0]) || !exact(&rule.pattern) {
        return Err("an allow from a blocked request must be one exact method and path".into());
    }
    Ok(())
}

/// Put `rule` first in the role's rule set for (secret, host), creating the
/// set when missing with the role's default as its fallback (the same as
/// having none, so one allow never opens the rest of a deny-by-default host). An identical
/// rule already in the set moves to the front rather than duplicating.
pub fn allow_on_role(role: &mut Role, secret: &str, host: &str, rule: Rule) {
    let idx = match role.rule_sets.iter().position(|rs| rs.secret == secret && rs.host == host) {
        Some(i) => i,
        None => {
            let fallback = role.default_effect();
            role.rule_sets.push(RuleSet { secret: secret.into(), host: host.into(), rules: Vec::new(), fallback });
            role.rule_sets.len() - 1
        }
    };
    let rules = &mut role.rule_sets[idx].rules;
    rules.retain(|r| r != &rule);
    rules.insert(0, rule);
}

/// The task-scoped twin of [`allow_on_role`]. Task allows are all checked
/// before the role's rules, so order among them does not matter.
pub fn allow_on_task(allows: &mut Vec<TaskAllow>, secret: &str, host: &str, rule: Rule) {
    let a = TaskAllow { secret: secret.into(), host: host.into(), rule };
    if !allows.contains(&a) {
        allows.push(a);
    }
}

// ───────────────────────────── gh accounts ─────────────────────────────

/// One login gh knows about, for the "Add GitHub secret" preset. Names only.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct GhAccount {
    pub host: String,
    pub user: String,
    /// gh's active login for the host (`user:`).
    pub active: bool,
}

/// gh's config dir, the way gh resolves it: `GH_CONFIG_DIR`, else
/// `$XDG_CONFIG_HOME/gh`, else `~/.config/gh` (gh uses that on macOS too,
/// not `~/Library`).
pub fn gh_config_dir(env: impl Fn(&str) -> Option<String>, home: Option<std::path::PathBuf>) -> Option<std::path::PathBuf> {
    let set = |k: &str| env(k).filter(|v| !v.is_empty());
    if let Some(d) = set("GH_CONFIG_DIR") {
        return Some(d.into());
    }
    if let Some(x) = set("XDG_CONFIG_HOME") {
        return Some(std::path::Path::new(&x).join("gh"));
    }
    home.map(|h| h.join(".config").join("gh"))
}

/// Accounts in gh's `hosts.yml`. Handles both layouts: the multi-account one
/// (`users:` map plus `user:` for the active login) and the older single
/// `user:`. The typed shape has no `oauth_token` field, so an
/// `--insecure-storage` token in the file is skipped by serde and never held.
pub fn gh_accounts_from_hosts_yml(text: &str) -> Result<Vec<GhAccount>, String> {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct HostEntry {
        user: Option<String>,
        users: Option<std::collections::BTreeMap<String, serde::de::IgnoredAny>>,
    }
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    // the parser's message can quote the file, and the file may hold a token.
    let hosts: std::collections::BTreeMap<String, Option<HostEntry>> =
        serde_yml::from_str(text).map_err(|_| "could not parse gh's hosts.yml".to_string())?;
    let mut out = Vec::new();
    for (host, entry) in hosts {
        let entry = entry.unwrap_or_default();
        let active = entry.user.filter(|u| !u.is_empty());
        let mut users: Vec<String> = entry.users.map(|m| m.into_keys().collect()).unwrap_or_default();
        if let Some(a) = &active {
            if !users.contains(a) {
                users.push(a.clone());
            }
        }
        for user in users {
            let is_active = active.as_deref() == Some(user.as_str());
            out.push(GhAccount { host: host.clone(), user, active: is_active });
        }
    }
    Ok(out)
}

// ───────────────────────── tokens outside the broker ─────────────────────────

/// A real-looking token sitting in an env the agent would inherit. `prefix`
/// is the token's type prefix (`ghp_`), never any of the value.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SecretExposure {
    /// `agent_env` (an agent's configured `env` / `docker_env`) or
    /// `process_env` (Termic's own, which caged spawns inherit).
    pub source: &'static str,
    pub agent_id: Option<String>,
    pub var_name: String,
    pub prefix: &'static str,
}

/// Longest first, so `sk-ant-` wins over `sk-`. GitHub tokens, then the
/// API keys an API key secret exists to keep out of an agent's env.
const TOKEN_PREFIXES: &[&str] = &["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "sk-ant-", "sk-proj-", "sk-"];

/// The token prefix `value` carries, if it looks like a real token: a known
/// prefix followed by at least 20 token characters. A placeholder,
/// `$(gh auth token)` or a bare `ghp_` does not count.
pub fn token_prefix(value: &str) -> Option<&'static str> {
    let v = value.trim();
    let p = TOKEN_PREFIXES.iter().find(|p| v.starts_with(**p))?;
    let rest = &v[p.len()..];
    (rest.len() >= 20 && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')).then_some(*p)
}

/// Every real-looking token in the agents' configured env and in `process`.
/// `agents` is (agent id, var, value).
pub fn scan_exposed<'a>(
    agents: impl IntoIterator<Item = (&'a str, &'a str, &'a str)>,
    process: impl IntoIterator<Item = (String, String)>,
) -> Vec<SecretExposure> {
    let mut out: Vec<SecretExposure> = agents
        .into_iter()
        .filter_map(|(id, k, v)| {
            token_prefix(v).map(|prefix| SecretExposure { source: "agent_env", agent_id: Some(id.into()), var_name: k.into(), prefix })
        })
        .collect();
    out.extend(process.into_iter().filter_map(|(k, v)| {
        token_prefix(&v).map(|prefix| SecretExposure { source: "process_env", agent_id: None, var_name: k, prefix })
    }));
    out.sort_by(|a, b| (a.source, &a.agent_id, &a.var_name).cmp(&(b.source, &b.agent_id, &b.var_name)));
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gh_secret(id: &str) -> SecretDef {
        SecretDef {
            id: id.into(), name: id.into(), service: "gh:github.com".into(), account: "alice".into(),
            hosts: Recipe::Github.default_hosts(), ..Default::default()
        }
    }

    fn openai(id: &str) -> SecretDef {
        SecretDef {
            id: id.into(), name: id.into(), service: owned_service(id), account: OWNED_ACCOUNT.into(),
            recipe: Recipe::ApiKey, hosts: vec!["api.openai.com".into()],
            api: ApiKeyCfg {
                header: "authorization".into(), scheme: "Bearer".into(), env: "OPENAI_API_KEY".into(),
                base_url_env: "OPENAI_BASE_URL".into(), base_url: "https://api.openai.com/v1".into(),
            },
            ..Default::default()
        }
    }

    #[test]
    fn api_key_secrets_validate() {
        let ok = openai("k1");
        assert!(ok.is_owned());
        assert!(validate(std::slice::from_ref(&ok), &[]).is_empty(), "{:?}", validate(std::slice::from_ref(&ok), &[]));
        // no base URL at all is fine (proxy delivery only)
        let mut bare = ok.clone();
        bare.api.base_url_env.clear();
        bare.api.base_url.clear();
        assert!(validate(&[bare], &[]).is_empty());

        let bad = |f: fn(&mut SecretDef), needle: &str| {
            let mut s = openai("k1");
            f(&mut s);
            let errs = validate(&[s], &[]);
            assert!(errs.iter().any(|e| e.contains(needle)), "{needle}: {errs:?}");
        };
        bad(|s| s.api.header = "Host".into(), "cannot carry");
        bad(|s| s.api.header = "x-key:\r\nevil".into(), "cannot carry");
        bad(|s| s.api.scheme = "Bearer x".into(), "one word");
        bad(|s| s.api.env = "1BAD".into(), "must be a name");
        bad(|s| s.api.env = "https_proxy".into(), "sets https_proxy itself");
        bad(|s| s.api.env = "DYLD_INSERT_LIBRARIES".into(), "itself");
        bad(|s| s.api.base_url_env = "OPENAI_API_KEY".into(), "different env vars");
        bad(|s| s.api.base_url = "http://api.openai.com/v1".into(), "must look like");
        bad(|s| s.api.base_url = "https://evil.example.net/v1".into(), "not one of its hosts");
        bad(|s| s.api.base_url.clear(), "go together");
        bad(|s| s.id = "../x".into(), "bad id");

        // one role, two keys on one env var
        let mut other = openai("k2");
        other.hosts = vec!["api.other.example".into()];
        other.api.base_url_env.clear();
        other.api.base_url.clear();
        let role = Role { id: "r".into(), name: "R".into(), secrets: vec!["k1".into(), "k2".into()], ..Default::default() };
        let errs = validate(&[openai("k1"), other], &[role]);
        assert!(errs.iter().any(|e| e.contains("both set OPENAI_API_KEY")), "{errs:?}");
    }

    #[test]
    fn protected_only_on_owned_items() {
        let mut gh_owned = gh_secret("g");
        gh_owned.service = owned_service("g");
        gh_owned.account = OWNED_ACCOUNT.into();
        for mut s in [openai("k"), gh_owned] {
            s.kind = KeychainKind::Protected;
            assert!(validate(&[s.clone()], &[]).is_empty(), "{:?}", validate(&[s.clone()], &[]));
            // pointing at someone else's item: not ours, so not protected.
            s.service = "gh:github.com".into();
            s.account = "alice".into();
            let errs = validate(&[s], &[]);
            assert!(errs.iter().any(|e| e.contains("protected Keychain")), "{errs:?}");
        }
        assert_eq!(serde_json::to_string(&KeychainKind::Protected).unwrap(), "\"protected\"");
    }

    #[test]
    fn base_url_hosts() {
        assert_eq!(base_url_host("https://API.openai.com/v1").as_deref(), Some("api.openai.com"));
        assert_eq!(base_url_host("https://api.anthropic.com").as_deref(), Some("api.anthropic.com"));
        assert_eq!(base_url_host("https://a.com:8443/x"), None);
        assert_eq!(base_url_host("https://user@a.com"), None);
        assert_eq!(base_url_host("http://a.com"), None);
    }

    fn allow(pattern: &str) -> Rule {
        Rule { effect: Effect::Allow, methods: vec!["POST".into()], pattern: pattern.into(), note: String::new(), disabled: false }
    }

    #[test]
    fn allow_on_role_creates_then_prepends() {
        let mut r = role("r");
        allow_on_role(&mut r, "s", "api.github.com", allow("/a"));
        assert_eq!(r.rule_sets.len(), 1);
        assert_eq!(r.rule_sets[0].fallback, Effect::Allow, "a new set must not deny what no set allowed");
        // an existing set keeps its fallback and gets the rule FIRST, ahead
        // of whatever deny is already there.
        r.rule_sets[0].fallback = Effect::Deny;
        r.rule_sets[0].rules.push(Rule { effect: Effect::Deny, methods: vec!["*".into()], pattern: "/**".into(), note: String::new(), disabled: false });
        allow_on_role(&mut r, "s", "api.github.com", allow("/b"));
        let rs = &r.rule_sets[0];
        assert_eq!(rs.fallback, Effect::Deny);
        assert_eq!(rs.rules.iter().map(|r| r.pattern.as_str()).collect::<Vec<_>>(), ["/b", "/a", "/**"]);
        // a repeat moves to the front instead of duplicating.
        allow_on_role(&mut r, "s", "api.github.com", allow("/a"));
        assert_eq!(r.rule_sets[0].rules.iter().map(|r| r.pattern.as_str()).collect::<Vec<_>>(), ["/a", "/b", "/**"]);
        // another host is its own set.
        allow_on_role(&mut r, "s", "github.com", allow("/c"));
        assert_eq!(r.rule_sets.len(), 2);
    }

    #[test]
    fn allow_on_task_dedups() {
        let mut v = Vec::new();
        allow_on_task(&mut v, "s", "api.github.com", allow("/a"));
        allow_on_task(&mut v, "s", "api.github.com", allow("/a"));
        allow_on_task(&mut v, "s", "api.github.com", allow("/b"));
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn check_allow_rejects_bad_input() {
        let secrets = [gh_secret("s")];
        assert!(check_allow(&secrets, "s", "api.github.com", &allow("/a")).is_ok());
        assert!(check_allow(&secrets, "nope", "api.github.com", &allow("/a")).is_err());
        assert!(check_allow(&secrets, "s", "evil.example", &allow("/a")).is_err(), "unbound host");
        let mut deny = allow("/a");
        deny.effect = Effect::Deny;
        assert!(check_allow(&secrets, "s", "api.github.com", &deny).is_err());
        assert!(check_allow(&secrets, "s", "api.github.com", &allow(" ")).is_err());
        let mut no_method = allow("/a");
        no_method.methods.clear();
        assert!(check_allow(&secrets, "s", "api.github.com", &no_method).is_err());
    }

    #[test]
    fn gh_hosts_single_account() {
        let y = "github.com:\n    user: alice\n    git_protocol: https\n";
        assert_eq!(
            gh_accounts_from_hosts_yml(y).unwrap(),
            [GhAccount { host: "github.com".into(), user: "alice".into(), active: true }]
        );
    }

    #[test]
    fn gh_hosts_multi_account_and_insecure_token_ignored() {
        // shape of gh >= 2.40 with two logins on one host and one on a GHE
        // host, where bob used --insecure-storage so his token sits in the file.
        let y = "\
github.com:
    git_protocol: https
    users:
        alice:
        bob:
            oauth_token: gho_0000000000000000000000000000000000
    user: bob
    oauth_token: gho_0000000000000000000000000000000000
ghe.acme.com:
    users:
        alice:
    user: alice
";
        let got = gh_accounts_from_hosts_yml(y).unwrap();
        let want = [
            GhAccount { host: "ghe.acme.com".into(), user: "alice".into(), active: true },
            GhAccount { host: "github.com".into(), user: "alice".into(), active: false },
            GhAccount { host: "github.com".into(), user: "bob".into(), active: true },
        ];
        assert_eq!(got, want);
        assert!(!format!("{got:?}").contains("gho_"));
        assert!(gh_accounts_from_hosts_yml("").unwrap().is_empty());
        let err = gh_accounts_from_hosts_yml("github.com: [gho_0000000000000000000000000000000000").unwrap_err();
        assert!(!err.contains("gho_"), "parse errors must not echo the file");
    }

    #[test]
    fn gh_config_dir_resolution() {
        let home = Some(std::path::PathBuf::from("/Users/alice"));
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
        };
        assert_eq!(gh_config_dir(env(&[]), home.clone()).unwrap(), std::path::Path::new("/Users/alice/.config/gh"));
        assert_eq!(gh_config_dir(env(&[("XDG_CONFIG_HOME", "/x")]), home.clone()).unwrap(), std::path::Path::new("/x/gh"));
        assert_eq!(
            gh_config_dir(env(&[("XDG_CONFIG_HOME", "/x"), ("GH_CONFIG_DIR", "/g")]), home.clone()).unwrap(),
            std::path::Path::new("/g")
        );
        assert_eq!(gh_config_dir(env(&[("GH_CONFIG_DIR", "")]), home).unwrap(), std::path::Path::new("/Users/alice/.config/gh"));
    }

    #[test]
    fn exposure_scan_reports_prefix_only() {
        let tok = "ghp_0123456789abcdefghij0123456789abcd";
        let pat = "github_pat_0123456789abcdefghij_0123456789";
        let agents = [
            ("claude", "GH_TOKEN", tok),
            ("claude", "EDITOR", "vim"),
            ("codex", "GITHUB_TOKEN", "$(gh auth token)"),
            ("codex", "X", "ghp_"),
            ("codex", "PAT", pat),
        ];
        let process = vec![("GITHUB_TOKEN".to_string(), format!(" {tok}\n")), ("HOME".to_string(), "/Users/alice".to_string())];
        let got = scan_exposed(agents, process);
        assert_eq!(got.len(), 3, "{got:?}");
        assert_eq!(got[0], SecretExposure { source: "agent_env", agent_id: Some("claude".into()), var_name: "GH_TOKEN".into(), prefix: "ghp_" });
        assert_eq!(got[1].prefix, "github_pat_");
        assert_eq!(got[2], SecretExposure { source: "process_env", agent_id: None, var_name: "GITHUB_TOKEN".into(), prefix: "ghp_" });
        let json = serde_json::to_string(&got).unwrap();
        assert!(!json.contains("0123456789"), "a value leaked: {json}");
    }

    fn role(id: &str) -> Role {
        Role { id: id.into(), name: id.into(), ..Default::default() }
    }

    #[test]
    fn precedence_task_then_project_then_agent() {
        let roles = vec![role("a"), role("b"), role("c")];
        let r = |t, p, g| resolve_role(t, p, g, true, &roles).map(|r| r.id.clone());
        assert_eq!(r(Some("a"), Some("b"), Some("c")), Some("a".into()));
        assert_eq!(r(None, Some("b"), Some("c")), Some("b".into()));
        assert_eq!(r(None, None, Some("c")), Some("c".into()));
        assert_eq!(r(None, None, None), None);
        // explicit "No secrets" on the task beats the defaults.
        assert_eq!(r(Some(""), Some("b"), Some("c")), None);
        // a dangling id resolves to nothing rather than another role.
        assert_eq!(r(Some("gone"), Some("b"), None), None);
    }

    #[test]
    fn no_keychain_block_no_role() {
        let roles = vec![role("a")];
        assert!(resolve_role(Some("a"), None, None, false, &roles).is_none());
    }

    #[test]
    fn popover_allow_refuses_wildcards() {
        let s = SecretDef {
            id: "x".into(), name: "x".into(), service: "gh:github.com".into(), account: "alice".into(),
            hosts: vec!["api.github.com".into()], ..Default::default()
        };
        let rule = |m: &[&str], p: &str| Rule { effect: Effect::Allow, methods: m.iter().map(|m| m.to_string()).collect(), pattern: p.into(), note: String::new(), disabled: false };
        let ok = |r: Rule| check_allow(std::slice::from_ref(&s), "x", "api.github.com", &r).is_ok();
        assert!(ok(rule(&["PUT"], "/repos/acme/widget/pulls/412/merge")));
        assert!(ok(rule(&["MUTATION"], "mergePullRequest")));
        assert!(!ok(rule(&["PUT"], "/repos/acme/**")), "agent-controlled path must not become a glob");
        assert!(!ok(rule(&["PUT"], "/repos/acme/*/pulls")));
        assert!(!ok(rule(&["*"], "/repos/acme/widget")));
        assert!(!ok(rule(&["GET", "PUT"], "/x")));
        assert!(!ok(rule(&["MUTATION"], "<unparsed>")), "a classifier sentinel is not a mutation name");
    }

    #[test]
    fn two_secrets_on_one_host_is_rejected() {
        let s = |id: &str| SecretDef {
            id: id.into(), name: id.into(), service: "gh:github.com".into(), account: id.into(),
            hosts: vec!["api.github.com".into()], ..Default::default()
        };
        let mut r = role("r");
        r.secrets = vec!["x".into(), "y".into()];
        let errs = validate(&[s("x"), s("y")], &[r]);
        assert_eq!(errs.len(), 1, "{errs:?}");
        assert!(errs[0].contains("api.github.com"));
        let mut dup = s("y");
        dup.name = "x".into();
        assert!(validate(&[s("x"), dup], &[]).iter().any(|e| e.contains("two secrets are named x")));
    }

    #[test]
    fn validate_refuses_bad_hosts_and_empty_rules() {
        let mut s = SecretDef {
            id: "x".into(), name: "x".into(), service: "gh:github.com".into(), account: "alice".into(),
            hosts: vec!["API.github.com".into()], ..Default::default()
        };
        assert!(validate(std::slice::from_ref(&s), &[]).iter().any(|e| e.contains("API.github.com")));
        for bad in ["*.github.com", "https://x", "x:443", ""] {
            s.hosts = vec![bad.into()];
            assert!(validate(std::slice::from_ref(&s), &[]).iter().any(|e| e.contains("not a host name")), "{bad}");
        }
        s.hosts = vec!["api.github.com".into()];
        let rule = |m: &[&str], p: &str| Rule { methods: m.iter().map(|m| m.to_string()).collect(), pattern: p.into(), ..Default::default() };
        let mut r = role("r");
        r.secrets = vec!["x".into()];
        let with = |rules: Vec<Rule>, host: &str| {
            let mut r = r.clone();
            r.rule_sets = vec![RuleSet { secret: "x".into(), host: host.into(), rules, fallback: Effect::Deny }];
            validate(std::slice::from_ref(&s), &[r])
        };
        assert!(with(vec![rule(&["GET"], "/**"), rule(&["QUERY"], "")], "api.github.com").is_empty());
        assert!(with(vec![rule(&[" "], "/x")], "api.github.com").iter().any(|e| e.contains("no method")));
        assert!(with(vec![rule(&["GET"], "  ")], "api.github.com").iter().any(|e| e.contains("no pattern")));
        assert!(with(vec![rule(&["GET"], "/x")], "API.github.com").iter().any(|e| e.contains("not a host name")));
    }

    #[test]
    fn unknown_variants_parse_and_fail_validation() {
        let s: SecretDef = serde_json::from_str(r#"{"id":"x","name":"x","service":"s","account":"a","hosts":["h.io"],"recipe":"aws","kind":"vault"}"#).unwrap();
        assert_eq!((s.recipe, s.kind), (Recipe::Unknown, KeychainKind::Unknown));
        assert!(validate(&[s], &[]).iter().any(|e| e.contains("newer Termic")));
    }

    #[test]
    fn missing_set_takes_the_role_default() {
        let mut r = role("r");
        assert_eq!(r.default_effect(), Effect::Allow);
        r.rule_sets.push(RuleSet { secret: "x".into(), host: "api.github.com".into(), rules: vec![], fallback: Effect::Deny });
        assert_eq!(r.default_effect(), Effect::Deny);
        allow_on_role(&mut r, "x", "uploads.github.com", allow("/a"));
        let set = r.rule_sets.iter().find(|s| s.host == "uploads.github.com").unwrap();
        assert_eq!(set.fallback, Effect::Deny, "one allow must not open a deny-by-default host");
    }

    #[test]
    fn exposure_scan_knows_api_keys() {
        assert_eq!(token_prefix("sk-ant-api03-0123456789abcdefghij_xyz"), Some("sk-ant-"));
        assert_eq!(token_prefix("sk-proj-0123456789abcdefghij-xyz"), Some("sk-proj-"));
        assert_eq!(token_prefix("sk-0123456789abcdefghijklmn"), Some("sk-"));
        assert_eq!(token_prefix("sk-short"), None);
    }
}
