//! Role rules: what an agent may do with a secret on a host. A request is
//! classified once (plain HTTP, a GraphQL query / mutation, a git fetch /
//! push), then each rule set is walked first match wins.

use crate::secrets::{Effect, Role, Rule, TaskAllow};

/// What a request does, for rule matching.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Op {
    Http,
    /// `POST /graphql`. Empty `mutations` = a query.
    Graphql { mutations: Vec<String> },
    Git { push: bool, repo: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Verdict {
    Allow,
    /// `rule` is the human-readable rule that denied it, `what` the request
    /// as the 403 names it (`PUT /x`, `MUTATION mergePullRequest`, `push a/b`).
    Deny { rule: String, verb: String, target: String },
}

/// GraphQL bodies are buffered (and refused past this) only to classify them.
pub(crate) const MAX_GRAPHQL_BODY: usize = 1 << 20;

/// Any method: GitHub may run a `GET /graphql?query=...`, and judging that
/// as plain HTTP would let `ALLOW GET /**` through to a mutation.
pub(crate) fn is_graphql(path: &str) -> bool {
    path.eq_ignore_ascii_case("/graphql")
}

/// The path rules see: no trailing slash (`/merge/` must not dodge a
/// `/merge` rule). Case is handled by `glob`, which ignores it, because
/// GitHub resolves owner and repo case-insensitively.
pub(crate) fn rule_path(path: &str) -> &str {
    let t = path.trim_end_matches('/');
    if t.is_empty() { "/" } else { t }
}

/// git smart-HTTP: `info/refs?service=git-upload-pack` and `git-upload-pack`
/// are fetch, the `receive-pack` pair is push. The repo is the path before.
pub(crate) fn classify_git(path: &str, query: &str) -> Option<Op> {
    let (repo, push) = if let Some(r) = path.strip_suffix("/info/refs") {
        // every `service=` counts: a server may honour the last one where we
        // read the first, so any receive-pack makes it a push.
        let svcs: Vec<&str> = query.split('&').filter_map(|kv| kv.strip_prefix("service=")).collect();
        if svcs.is_empty() || svcs.iter().any(|s| !matches!(*s, "git-upload-pack" | "git-receive-pack")) { return None; }
        (r, svcs.contains(&"git-receive-pack"))
    } else if let Some(r) = path.strip_suffix("/git-upload-pack") {
        (r, false)
    } else {
        (path.strip_suffix("/git-receive-pack")?, true)
    };
    let repo = repo.trim_start_matches('/');
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    Some(Op::Git { push, repo: repo.to_string() })
}

/// Classify a GraphQL request body. Anything that does not parse is
/// treated as an unknown mutation, so only a rule allowing every mutation
/// lets it through.
pub(crate) fn classify_graphql(body: &[u8]) -> Op {
    let unknown = || Op::Graphql { mutations: vec!["<unparsed>".into()] };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) else { return unknown() };
    // a JSON array is a batch: the union of its operations.
    let docs: Vec<&serde_json::Value> = match &v {
        serde_json::Value::Array(a) => a.iter().collect(),
        o => vec![o],
    };
    let mut names = Vec::new();
    for d in docs {
        let Some(q) = d.get("query").and_then(|q| q.as_str()) else { return unknown() };
        match graphql::mutation_fields(q) {
            Some(n) => names.extend(n),
            None => return unknown(),
        }
    }
    Op::Graphql { mutations: names }
}

/// What a rule can match a request by: what it does (`sem`: `QUERY`,
/// `MUTATION <name>`, `fetch|push <repo>`, or for plain HTTP its verb and
/// path) and, for GraphQL and git, the HTTP request carrying it (`http`).
struct Subject<'a> { sem: (&'a str, &'a str), http: Option<(&'a str, &'a str)> }

fn subjects<'a>(method: &'a str, path: &'a str, op: &'a Op) -> Vec<Subject<'a>> {
    let http = Some((method, path));
    match op {
        Op::Http => vec![Subject { sem: (method, path), http: None }],
        Op::Graphql { mutations } if mutations.is_empty() => vec![Subject { sem: ("QUERY", ""), http }],
        // every mutation field is judged on its own; one deny denies all.
        Op::Graphql { mutations } => mutations.iter().map(|m| Subject { sem: ("MUTATION", m.as_str()), http }).collect(),
        Op::Git { push, repo } => vec![Subject { sem: (if *push { "push" } else { "fetch" }, repo.as_str()), http }],
    }
}

pub(crate) const PSEUDO: [&str; 4] = ["QUERY", "MUTATION", "fetch", "push"];

/// Asymmetric on purpose, so a rule can only ever be read the strict way:
/// - an ALLOW matches only what the request does, and its `*` method means
///   any HTTP verb, never QUERY / MUTATION / fetch / push. So `ALLOW POST
///   /**` or `ALLOW * /**` cannot let a mutation or a push through.
/// - a DENY matches what it does OR the HTTP request carrying it, and its
///   `*` matches everything. So `DENY POST /graphql` still stops GraphQL.
fn rule_matches(rule: &Rule, sub: &Subject) -> bool {
    let hit = |(verb, target): (&str, &str)| {
        let pseudo = PSEUDO.iter().any(|p| p.eq_ignore_ascii_case(verb));
        let verb_ok = rule.methods.iter().any(|m| {
            (m == "*" && (rule.effect == Effect::Deny || !pseudo)) || m.eq_ignore_ascii_case(verb)
        });
        // QUERY carries no name, so its pattern is not consulted.
        verb_ok && (verb.eq_ignore_ascii_case("QUERY") || glob(&rule.pattern, target))
    };
    hit(sub.sem) || (rule.effect == Effect::Deny && sub.http.is_some_and(hit))
}

pub(crate) fn describe(rule: &Rule) -> String {
    let effect = match rule.effect { Effect::Allow => "ALLOW", Effect::Deny => "DENY" };
    let mut s = format!("{effect} {} {}", rule.methods.join(", "), rule.pattern).trim_end().to_string();
    if !rule.note.trim().is_empty() { s.push_str(&format!(" ({})", rule.note.trim())); }
    s
}

/// Judge one request. Task allows first, then the role's rule set for this
/// (secret, host), first match wins, then its fallback. No rule set takes
/// the role's default (`Role::default_effect`): deny on a role written
/// deny-by-default, so a host it has no rules for never opens up.
pub(crate) fn evaluate(secret: &str, host: &str, method: &str, path: &str, op: &Op, role: &Role, allows: &[TaskAllow]) -> Verdict {
    let set = role.rule_sets.iter().find(|s| s.secret == secret && s.host.eq_ignore_ascii_case(host));
    for sub in subjects(method, path, op) {
        // a mutation the classifier could not name (`<unparsed>`, `<empty>`,
        // ...) may hide any mutation, so a named DENY cannot be trusted to
        // catch it: only an allow on EVERY mutation lets it through, never a
        // fallback or a task allow.
        let unnamed = sub.sem.0.eq_ignore_ascii_case("MUTATION") && sub.sem.1.starts_with('<');
        if !unnamed && allows.iter().any(|a| a.secret == secret && a.host.eq_ignore_ascii_case(host) && a.rule.effect == Effect::Allow && rule_matches(&a.rule, &sub)) {
            continue;
        }
        let (effect, text) = match set {
            None => (role.default_effect(), format!("no rules for {host}: role denies by default")),
            Some(set) => {
                let hit = set.rules.iter().find(|r| {
                    !r.disabled && rule_matches(r, &sub) && (!unnamed || r.effect == Effect::Deny || matches!(r.pattern.trim(), "" | "*" | "**"))
                });
                match (hit, unnamed) {
                    (Some(r), _) => (r.effect, describe(r)),
                    (None, true) => (Effect::Deny, "an unnamed mutation needs ALLOW MUTATION *".to_string()),
                    (None, false) => (set.fallback, format!("fallback {}", match set.fallback { Effect::Allow => "ALLOW", Effect::Deny => "DENY" })),
                }
            }
        };
        if effect == Effect::Deny {
            let (verb, target) = sub.sem;
            return Verdict::Deny { rule: text, verb: verb.to_string(), target: target.to_string() };
        }
    }
    Verdict::Allow
}

/// Path glob: `*` matches within one `/` segment, a `**` segment any number
/// of segments. Leading slashes are ignored, an empty pattern matches all.
pub(crate) fn glob(pattern: &str, s: &str) -> bool {
    let p = pattern.trim();
    if p.is_empty() { return true; }
    let ps: Vec<&str> = p.trim_start_matches('/').split('/').collect();
    let ss: Vec<&str> = s.trim_start_matches('/').split('/').collect();
    segs(&ps, &ss)
}

fn segs(p: &[&str], s: &[&str]) -> bool {
    match p.split_first() {
        None => s.is_empty(),
        Some((&"**", rest)) => (0..=s.len()).any(|i| segs(rest, &s[i..])),
        Some((first, rest)) => !s.is_empty() && seg(first.as_bytes(), s[0].as_bytes()) && segs(rest, &s[1..]),
    }
}

/// `*` wildcard within one segment.
fn seg(p: &[u8], s: &[u8]) -> bool {
    match p.split_first() {
        None => s.is_empty(),
        Some((b'*', rest)) => (0..=s.len()).any(|i| seg(rest, &s[i..])),
        Some((c, rest)) => s.first().is_some_and(|b| b.eq_ignore_ascii_case(c)) && seg(rest, &s[1..]),
    }
}

/// Just enough of GraphQL to name the top-level fields of every mutation in
/// a document, through aliases, inline fragments and named fragment spreads
/// (any of which could otherwise hide `mergePullRequest`).
mod graphql {
    use std::collections::HashMap;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Tok<'a> { Name(&'a str), P(u8), Spread, Value }

    fn lex(src: &str) -> Option<Vec<Tok<'_>>> {
        let b = src.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            let c = b[i];
            match c {
                b' ' | b'\t' | b'\n' | b'\r' | b',' => i += 1,
                0xEF if b[i..].starts_with(&[0xEF, 0xBB, 0xBF]) => i += 3,
                // GraphQL ends a comment at either line terminator; stopping
                // only at `\n` would hide `# x\rmutation {...}` from the rules.
                b'#' => while i < b.len() && b[i] != b'\n' && b[i] != b'\r' { i += 1 },
                b'"' if b[i..].starts_with(b"\"\"\"") => {
                    i += 3;
                    loop {
                        if i >= b.len() { return None; }
                        if b[i..].starts_with(b"\\\"\"\"") { i += 4; continue; }
                        if b[i..].starts_with(b"\"\"\"") { i += 3; break; }
                        i += 1;
                    }
                    out.push(Tok::Value);
                }
                b'"' => {
                    i += 1;
                    loop {
                        match b.get(i) {
                            None | Some(b'\n') | Some(b'\r') => return None,
                            Some(b'\\') => i += 2,
                            Some(b'"') => { i += 1; break; }
                            _ => i += 1,
                        }
                    }
                    out.push(Tok::Value);
                }
                b'.' if b[i..].starts_with(b"...") => { i += 3; out.push(Tok::Spread); }
                b'{' | b'}' | b'(' | b')' | b'[' | b']' | b':' | b'=' | b'@' | b'$' | b'!' | b'|' | b'&' => {
                    i += 1;
                    out.push(Tok::P(c));
                }
                b'_' | b'a'..=b'z' | b'A'..=b'Z' => {
                    let st = i;
                    while i < b.len() && (b[i] == b'_' || b[i].is_ascii_alphanumeric()) { i += 1; }
                    out.push(Tok::Name(&src[st..i]));
                }
                b'-' | b'0'..=b'9' => {
                    i += 1;
                    while i < b.len() && (b[i].is_ascii_alphanumeric() || matches!(b[i], b'.' | b'+' | b'-')) { i += 1; }
                    out.push(Tok::Value);
                }
                _ => return None,
            }
        }
        Some(out)
    }

    enum Sel<'a> { Field(&'a str), Spread(&'a str), Inline(Vec<Sel<'a>>) }

    /// Selection sets nest no deeper than this; past it the document is
    /// unparsed (an unknown mutation). Recursion on a hostile body would
    /// otherwise overflow the thread's stack and abort the whole app.
    const MAX_DEPTH: usize = 64;
    /// Selections `expand` may visit across all fragment spreads. Depth is
    /// capped at 8, but breadth is not: 8 fragments each spreading the next
    /// 50 times is 50^8 visits from a ~400 byte body.
    const MAX_VISITS: usize = 10_000;

    struct Parser<'a> { t: Vec<Tok<'a>>, i: usize, depth: usize }

    impl<'a> Parser<'a> {
        fn peek(&self) -> Option<Tok<'a>> { self.t.get(self.i).copied() }
        fn next(&mut self) -> Option<Tok<'a>> { let t = self.peek(); self.i += 1; t }
        fn eat(&mut self, t: Tok<'a>) -> bool { if self.peek() == Some(t) { self.i += 1; true } else { false } }
        fn name(&mut self) -> Option<&'a str> { match self.next()? { Tok::Name(n) => Some(n), _ => None } }

        /// Skip a balanced `(`...`)` or `[`...`]` or `{`...`}` group starting here.
        fn skip_group(&mut self, open: u8, close: u8) -> Option<()> {
            if !self.eat(Tok::P(open)) { return None; }
            let mut depth = 1;
            while depth > 0 {
                match self.next()? {
                    Tok::P(c) if c == open => depth += 1,
                    Tok::P(c) if c == close => depth -= 1,
                    _ => {}
                }
            }
            Some(())
        }

        fn directives(&mut self) -> Option<()> {
            while self.eat(Tok::P(b'@')) {
                self.name()?;
                if self.peek() == Some(Tok::P(b'(')) { self.skip_group(b'(', b')')?; }
            }
            Some(())
        }

        fn selection_set(&mut self) -> Option<Vec<Sel<'a>>> {
            if self.depth >= MAX_DEPTH { return None; }
            self.depth += 1;
            let r = self.selection_set_inner();
            self.depth -= 1;
            r
        }

        fn selection_set_inner(&mut self) -> Option<Vec<Sel<'a>>> {
            if !self.eat(Tok::P(b'{')) { return None; }
            let mut out = Vec::new();
            loop {
                match self.next()? {
                    Tok::P(b'}') => return Some(out),
                    Tok::Spread => match self.peek()? {
                        Tok::Name("on") => {
                            self.i += 1;
                            self.name()?;
                            self.directives()?;
                            out.push(Sel::Inline(self.selection_set()?));
                        }
                        Tok::Name(n) => {
                            self.i += 1;
                            self.directives()?;
                            out.push(Sel::Spread(n));
                        }
                        _ => {
                            self.directives()?;
                            out.push(Sel::Inline(self.selection_set()?));
                        }
                    },
                    Tok::Name(a) => {
                        // `alias: field`, the field is what runs.
                        let n = if self.eat(Tok::P(b':')) { self.name()? } else { a };
                        if self.peek() == Some(Tok::P(b'(')) { self.skip_group(b'(', b')')?; }
                        self.directives()?;
                        if self.peek() == Some(Tok::P(b'{')) { self.skip_group(b'{', b'}')?; }
                        out.push(Sel::Field(n));
                    }
                    _ => return None,
                }
            }
        }
    }

    /// Top-level field names of every non-query operation in `src`. Empty
    /// for a query-only document, None when it does not parse or holds no
    /// operation.
    pub(super) fn mutation_fields(src: &str) -> Option<Vec<String>> {
        let mut p = Parser { t: lex(src)?, i: 0, depth: 0 };
        let mut ops: Vec<Vec<Sel>> = Vec::new();
        let mut frags: HashMap<&str, Vec<Sel>> = HashMap::new();
        let mut any_op = false;
        while let Some(t) = p.peek() {
            match t {
                Tok::P(b'{') => { p.selection_set()?; any_op = true; }
                Tok::Name("query") | Tok::Name("mutation") | Tok::Name("subscription") => {
                    p.i += 1;
                    if let Some(Tok::Name(_)) = p.peek() { p.i += 1; }
                    if p.peek() == Some(Tok::P(b'(')) { p.skip_group(b'(', b')')?; }
                    p.directives()?;
                    let sels = p.selection_set()?;
                    any_op = true;
                    // a subscription runs like a mutation as far as rules go.
                    if t != Tok::Name("query") { ops.push(sels); }
                }
                Tok::Name("fragment") => {
                    p.i += 1;
                    let n = p.name()?;
                    if p.name()? != "on" { return None; }
                    p.name()?;
                    p.directives()?;
                    frags.insert(n, p.selection_set()?);
                }
                _ => return None,
            }
        }
        // nothing that runs: not a query we can vouch for, so unparsed.
        if !any_op { return None; }
        let mut out = Vec::new();
        let mut budget = MAX_VISITS;
        for sels in &ops {
            if !expand(sels, &frags, 0, &mut budget, &mut out) {
                // too big to judge: an unknown mutation, which only an allow
                // on every mutation lets through.
                return None;
            }
        }
        if !ops.is_empty() && out.is_empty() { out.push("<empty>".into()); }
        out.sort();
        out.dedup();
        Some(out)
    }

    /// False once `budget` runs out.
    fn expand(sels: &[Sel], frags: &HashMap<&str, Vec<Sel>>, depth: u8, budget: &mut usize, out: &mut Vec<String>) -> bool {
        for s in sels {
            if *budget == 0 { return false; }
            *budget -= 1;
            let ok = match s {
                Sel::Field(n) => { out.push(n.to_string()); true }
                Sel::Inline(inner) => expand(inner, frags, depth, budget, out),
                // past the depth cap or naming no fragment: unjudgeable, so the
                // whole document is unparsed rather than one opaque name.
                Sel::Spread(n) => match frags.get(n) {
                    Some(inner) if depth < 8 => expand(inner, frags, depth + 1, budget, out),
                    _ => false,
                },
            };
            if !ok { return false; }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::RuleSet;

    fn rule(effect: Effect, methods: &[&str], pattern: &str) -> Rule {
        Rule { effect, methods: methods.iter().map(|m| m.to_string()).collect(), pattern: pattern.into(), note: String::new(), disabled: false }
    }

    fn reviewer() -> Role {
        Role {
            id: "r".into(), name: "Reviewer".into(),
            rule_sets: vec![
                RuleSet {
                    secret: "gh".into(), host: "api.github.com".into(), fallback: Effect::Deny,
                    rules: vec![
                        rule(Effect::Allow, &["GET", "HEAD"], "/**"),
                        rule(Effect::Allow, &["QUERY"], ""),
                        rule(Effect::Deny, &["MUTATION"], "merge*"),
                        rule(Effect::Allow, &["MUTATION"], "addPullRequestReview*"),
                    ],
                },
                RuleSet {
                    secret: "gh".into(), host: "github.com".into(), fallback: Effect::Deny,
                    rules: vec![rule(Effect::Allow, &["fetch"], "**"), rule(Effect::Allow, &["push"], "acme/*")],
                },
            ],
            ..Default::default()
        }
    }

    fn judge(host: &str, method: &str, path: &str, op: &Op) -> Verdict {
        evaluate("gh", host, method, path, op, &reviewer(), &[])
    }

    #[test]
    fn a_disabled_rule_is_skipped() {
        let mut r = reviewer();
        // the Reviewer's first rule allows every GET; off, the fallback denies.
        r.rule_sets[0].rules[0].disabled = true;
        assert!(matches!(evaluate("gh", "api.github.com", "GET", "/user", &Op::Http, &r, &[]), Verdict::Deny { .. }));
        r.rule_sets[0].rules[0].disabled = false;
        assert!(matches!(evaluate("gh", "api.github.com", "GET", "/user", &Op::Http, &r, &[]), Verdict::Allow));
    }

    #[test]
    fn glob_semantics() {
        assert!(glob("/repos/*/*/pulls", "/repos/acme/widget/pulls"));
        assert!(!glob("/repos/*/pulls", "/repos/acme/widget/pulls"));
        assert!(glob("/repos/**", "/repos/acme/widget/pulls/1/merge"));
        assert!(glob("/repos/**", "/repos"));
        assert!(glob("/**/merge", "/repos/a/b/pulls/1/merge"));
        assert!(!glob("/**/merge", "/repos/a/b/pulls/1/merged"));
        assert!(glob("merge*", "mergePullRequest"));
        assert!(!glob("merge*", "unmerge"));
        assert!(glob("acme/*", "acme/widget"));
        assert!(!glob("acme/*", "acme/widget/extra"));
        assert!(glob("", "anything/at/all"));
        assert!(glob("*", "user") && !glob("*", "a/b"));
        // GitHub resolves owner/repo case-insensitively, so rules must too.
        assert!(glob("/repos/acme/prod/**", "/repos/ACME/Prod/pulls/1/merge"));
        assert!(glob("acme/prod", "Acme/PROD"));
    }

    #[test]
    fn an_http_allow_does_not_allow_a_mutation() {
        let mut r = reviewer();
        r.rule_sets[0].rules.insert(0, rule(Effect::Allow, &["POST"], "/**"));
        let m = classify_graphql(br#"{"query":"mutation { mergePullRequest(input: {}) { x } }"}"#);
        assert!(matches!(evaluate("gh", "api.github.com", "POST", "/graphql", &m, &r, &[]), Verdict::Deny { .. }));
    }

    #[test]
    fn wildcard_allow_is_http_only_but_wildcard_deny_is_everything() {
        let m = classify_graphql(br#"{"query":"mutation { mergePullRequest(input: {}) { x } }"}"#);
        let push = classify_git("/acme/w.git/git-receive-pack", "").unwrap();
        let set = |rules: Vec<Rule>, fallback| Role { rule_sets: vec![
            RuleSet { secret: "gh".into(), host: "api.github.com".into(), fallback, rules: rules.clone() },
            RuleSet { secret: "gh".into(), host: "github.com".into(), fallback, rules },
        ], ..Default::default() };
        let deny = |r: &Role, host, method, path, op: &Op| matches!(evaluate("gh", host, method, path, op, r, &[]), Verdict::Deny { .. });
        // ALLOW * /** then fallback deny: REST passes, a mutation and a push do not.
        let r = set(vec![rule(Effect::Allow, &["*"], "/**")], Effect::Deny);
        assert!(!deny(&r, "api.github.com", "DELETE", "/repos/a/b", &Op::Http));
        assert!(deny(&r, "api.github.com", "POST", "/graphql", &m));
        assert!(deny(&r, "github.com", "POST", "/acme/w.git/git-receive-pack", &push));
        // DENY POST /graphql still stops GraphQL ahead of a broad allow.
        let r = set(vec![rule(Effect::Deny, &["POST"], "/graphql"), rule(Effect::Allow, &["MUTATION"], "*")], Effect::Allow);
        assert!(deny(&r, "api.github.com", "POST", "/graphql", &m));
        // DENY * matches pseudo verbs too.
        let r = set(vec![rule(Effect::Deny, &["*"], "**")], Effect::Allow);
        assert!(deny(&r, "github.com", "POST", "/acme/w.git/git-receive-pack", &push));
    }

    #[test]
    fn normalisation_cannot_dodge_a_deny() {
        assert_eq!(rule_path("/repos/a/b/pulls/1/merge/"), "/repos/a/b/pulls/1/merge");
        assert_eq!(rule_path("/"), "/");
        assert!(is_graphql("/GraphQL"));
        // a doubled service= is a push if any of them is receive-pack.
        assert_eq!(classify_git("/acme/w/info/refs", "service=git-upload-pack&service=git-receive-pack"),
            Some(Op::Git { push: true, repo: "acme/w".into() }));
        assert_eq!(classify_git("/acme/w/info/refs", "service=git-upload-pack&service=other"), None);
        // upper-case owner hits the deny, not the fallback.
        let push = classify_git("/OTHER/Thing.git/git-receive-pack", "").unwrap();
        let mut r = reviewer();
        r.rule_sets[1].rules.insert(0, rule(Effect::Deny, &["push"], "other/thing"));
        r.rule_sets[1].fallback = Effect::Allow;
        assert!(matches!(evaluate("gh", "github.com", "POST", "/OTHER/Thing.git/git-receive-pack", &push, &r, &[]), Verdict::Deny { .. }));
    }

    #[test]
    fn http_rules_first_match_then_fallback() {
        assert_eq!(judge("api.github.com", "GET", "/repos/acme/widget", &Op::Http), Verdict::Allow);
        match judge("api.github.com", "PUT", "/repos/acme/widget/pulls/412/merge", &Op::Http) {
            Verdict::Deny { rule, verb, target } => {
                assert_eq!(rule, "fallback DENY");
                assert_eq!((verb.as_str(), target.as_str()), ("PUT", "/repos/acme/widget/pulls/412/merge"));
            }
            v => panic!("{v:?}"),
        }
        // no rule set for the host: the Reviewer is deny-by-default, so denied
        // (missing_rule_set_takes_the_role_default covers an allow role).
        assert!(matches!(judge("uploads.github.com", "POST", "/x", &Op::Http), Verdict::Deny { .. }));
    }

    #[test]
    fn graphql_queries_and_mutations() {
        let q = classify_graphql(br#"{"query":"query { viewer { login } }"}"#);
        assert_eq!(q, Op::Graphql { mutations: vec![] });
        assert_eq!(judge("api.github.com", "POST", "/graphql", &q), Verdict::Allow);

        let m = classify_graphql(br#"{"query":"mutation M($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }","variables":{"id":"x"}}"#);
        assert_eq!(m, Op::Graphql { mutations: vec!["mergePullRequest".into()] });
        match judge("api.github.com", "POST", "/graphql", &m) {
            Verdict::Deny { rule, verb, target } => {
                assert_eq!(rule, "DENY MUTATION merge*");
                assert_eq!((verb.as_str(), target.as_str()), ("MUTATION", "mergePullRequest"));
            }
            v => panic!("{v:?}"),
        }
        let ok = classify_graphql(br#"{"query":"mutation { addPullRequestReview(input: {}) { clientMutationId } }"}"#);
        assert_eq!(judge("api.github.com", "POST", "/graphql", &ok), Verdict::Allow);
    }

    #[test]
    fn graphql_cannot_hide_a_mutation() {
        // alias
        let a = classify_graphql(br#"{"query":"mutation { review: mergePullRequest(input: {}) { x } }"}"#);
        assert_eq!(a, Op::Graphql { mutations: vec!["mergePullRequest".into()] });
        // named fragment on Mutation, and an inline one
        let f = classify_graphql(br#"{"query":"mutation { ...F } fragment F on Mutation { mergePullRequest(input: {}) { x } }"}"#);
        assert_eq!(f, Op::Graphql { mutations: vec!["mergePullRequest".into()] });
        let i = classify_graphql(br#"{"query":"mutation { ... on Mutation { mergePullRequest(input: {}) { x } } }"}"#);
        assert_eq!(i, Op::Graphql { mutations: vec!["mergePullRequest".into()] });
        // a query named first does not mask a mutation later in the doc
        let two = classify_graphql(br#"{"query":"query A { viewer { login } } mutation B { mergePullRequest(input: {}) { x } }","operationName":"A"}"#);
        assert_eq!(two, Op::Graphql { mutations: vec!["mergePullRequest".into()] });
        // braces inside strings do not end the selection set
        let s = classify_graphql(br#"{"query":"mutation { addComment(input: {body: \"} mergePullRequest {\"}) { x } }"}"#);
        assert_eq!(s, Op::Graphql { mutations: vec!["addComment".into()] });
        // garbage is an unknown mutation, which the fallback denies
        let g = classify_graphql(b"not json");
        assert!(matches!(judge("api.github.com", "POST", "/graphql", &g), Verdict::Deny { .. }));
        let g2 = classify_graphql(br#"{"query":"mutation { %%% }"}"#);
        assert_eq!(g2, Op::Graphql { mutations: vec!["<unparsed>".into()] });
        // `\r` ends a comment, as it does for GitHub
        let cr = classify_graphql(br##"{"query":"# x\rmutation { mergePullRequest(input: {}) { x } }"}"##);
        assert_eq!(cr, Op::Graphql { mutations: vec!["mergePullRequest".into()] });
        // a document with no operation is not a query
        for q in [r#"{"query":""}"#, r##"{"query":"# only a comment"}"##] {
            assert_eq!(classify_graphql(q.as_bytes()), Op::Graphql { mutations: vec!["<unparsed>".into()] }, "{q}");
        }
    }

    #[test]
    fn git_fetch_and_push() {
        assert_eq!(classify_git("/acme/widget.git/info/refs", "service=git-upload-pack"),
            Some(Op::Git { push: false, repo: "acme/widget".into() }));
        assert_eq!(classify_git("/acme/widget/git-receive-pack", ""),
            Some(Op::Git { push: true, repo: "acme/widget".into() }));
        assert_eq!(classify_git("/acme/widget.git/info/refs", "service=git-receive-pack"),
            Some(Op::Git { push: true, repo: "acme/widget".into() }));
        assert_eq!(classify_git("/acme/widget/pulls", ""), None);

        let fetch = classify_git("/other/thing.git/git-upload-pack", "").unwrap();
        assert_eq!(judge("github.com", "POST", "/other/thing.git/git-upload-pack", &fetch), Verdict::Allow);
        let push_ok = classify_git("/acme/widget.git/git-receive-pack", "").unwrap();
        assert_eq!(judge("github.com", "POST", "/acme/widget.git/git-receive-pack", &push_ok), Verdict::Allow);
        let push_no = classify_git("/other/thing.git/git-receive-pack", "").unwrap();
        match judge("github.com", "POST", "/other/thing.git/git-receive-pack", &push_no) {
            Verdict::Deny { verb, target, .. } => assert_eq!((verb.as_str(), target.as_str()), ("push", "other/thing")),
            v => panic!("{v:?}"),
        }
    }

    #[test]
    fn task_allow_beats_role_deny() {
        let allows = vec![TaskAllow { secret: "gh".into(), host: "api.github.com".into(), rule: rule(Effect::Allow, &["PUT"], "/repos/acme/*/pulls/*/merge") }];
        let v = evaluate("gh", "api.github.com", "PUT", "/repos/acme/widget/pulls/1/merge", &Op::Http, &reviewer(), &allows);
        assert_eq!(v, Verdict::Allow);
        // another secret's allow does not apply: it has no set, so it takes
        // the deny-by-default role's default.
        let v = evaluate("other", "api.github.com", "PUT", "/repos/acme/widget/pulls/1/merge", &Op::Http, &reviewer(), &allows);
        assert!(matches!(v, Verdict::Deny { .. }), "{v:?}");
    }

    #[test]
    fn missing_rule_set_takes_the_role_default() {
        // the Reviewer is deny-by-default, so a host it has no set for denies.
        assert!(matches!(judge("uploads.github.com", "POST", "/x", &Op::Http), Verdict::Deny { rule, .. } if rule.contains("denies by default")));
        // a role with no deny fallback anywhere still allows.
        let open = Role { id: "m".into(), ..Default::default() };
        assert_eq!(evaluate("gh", "uploads.github.com", "POST", "/x", &Op::Http, &open, &[]), Verdict::Allow);
        // a set whose host differs only in case is still found.
        let mut r = reviewer();
        r.rule_sets[0].host = "API.github.com".into();
        assert!(matches!(evaluate("gh", "api.github.com", "PUT", "/x", &Op::Http, &r, &[]), Verdict::Deny { rule, .. } if rule.contains("fallback")));
    }

    #[test]
    fn graphql_nesting_is_bounded() {
        // deep inline fragments must not recurse the stack away.
        let deep = format!("mutation {{ {} }}", "... { ".repeat(200_000));
        assert_eq!(classify_graphql(serde_json::json!({ "query": deep }).to_string().as_bytes()), Op::Graphql { mutations: vec!["<unparsed>".into()] });
        // a fan-out of fragment spreads stops at the visit budget.
        let mut q = String::from("mutation { ...f0 }");
        for i in 0..8 {
            q.push_str(&format!(" fragment f{i} on M {{ {} }}", format!("...f{} ", i + 1).repeat(50)));
        }
        q.push_str(" fragment f8 on M { mergePullRequest }");
        assert_eq!(classify_graphql(serde_json::json!({ "query": q }).to_string().as_bytes()), Op::Graphql { mutations: vec!["<unparsed>".into()] });
    }

    #[test]
    fn an_unnamed_mutation_ignores_an_allow_fallback() {
        // allow everything but merges: a body the classifier cannot name must
        // not slip past the named deny on the fallback.
        let r = Role { id: "m".into(), rule_sets: vec![RuleSet {
            secret: "gh".into(), host: "api.github.com".into(), fallback: Effect::Allow,
            rules: vec![rule(Effect::Deny, &["MUTATION"], "mergePullRequest")],
        }], ..Default::default() };
        let unparsed = Op::Graphql { mutations: vec!["<unparsed>".into()] };
        assert!(matches!(evaluate("gh", "api.github.com", "POST", "/graphql", &unparsed, &r, &[]), Verdict::Deny { .. }));
        // an unknown fragment makes the whole document unparsed.
        assert_eq!(classify_graphql(br#"{"query":"mutation { ...nope }"}"#), unparsed);
        // only an allow on every mutation opens it.
        let mut open = r.clone();
        open.rule_sets[0].rules.push(rule(Effect::Allow, &["MUTATION"], "*"));
        assert_eq!(evaluate("gh", "api.github.com", "POST", "/graphql", &unparsed, &open, &[]), Verdict::Allow);
        // a named mutation still takes the fallback.
        let named = Op::Graphql { mutations: vec!["addComment".into()] };
        assert_eq!(evaluate("gh", "api.github.com", "POST", "/graphql", &named, &r, &[]), Verdict::Allow);
    }
}
