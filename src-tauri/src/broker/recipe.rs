//! What each `Recipe` is, as data: how its tools reach the broker, where
//! the placeholder may be swapped, which env it must strip, and which
//! request classifiers its rules need. `mod.rs` reads this table for routing
//! and injection, but still renders the per-delivery env itself
//! (`render_env`: gh's `GH_TOKEN` / `GH_CONFIG_DIR`, git's credential helper
//! as `x-access-token`) and branches on `Recipe::ApiKey` for its env vars.
//! `When::Host` names a fixed host, so GHE (a per-secret API host) needs it
//! to become something resolved per secret first.

use crate::secrets::{base_url_host, Recipe, SecretDef};

/// How a tool's traffic reaches the broker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Delivery {
    /// gh's `http_unix_socket`: a per-spawn socket + `GH_CONFIG_DIR`.
    GhSocket,
    /// git pointed at the task's proxy with this spawn's proxy credentials,
    /// MITM'd with the per-spawn CA via a URL-scoped `sslCAInfo`.
    GitProxy,
    /// The tool's base-URL env var points at a per-spawn plaintext loopback
    /// endpoint (`http://127.0.0.1:<port>/<marker>/<host>/...`). No CA, so
    /// it reaches Go/Rust clients the MITM cannot.
    BaseUrl,
    /// `HTTPS_PROXY` with this spawn's env-proxy credentials plus the CA env
    /// vars curl, Python and Node read. Go on macOS ignores those vars.
    EnvProxy,
}

impl Delivery {
    /// Whether this delivery terminates TLS on the task's proxy, and so
    /// needs the per-spawn CA and (in EnforceFs) a proxy of its own.
    pub(crate) fn is_mitm(self) -> bool {
        matches!(self, Delivery::GitProxy | Delivery::EnvProxy)
    }
}

/// The one spot a delivery's placeholder may be swapped for the real value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Inject {
    /// `Authorization: <scheme> <ph>`, scheme any of these (case-insensitive).
    Scheme(&'static [&'static str]),
    /// The password of `Authorization: Basic`, re-encoded with the real one.
    BasicPassword,
    /// The secret's own `ApiKeyCfg`: `<header>: [<scheme> ]<ph>`.
    ApiKeyHeader,
}

/// When a route turns on for a secret.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum When {
    /// The secret is bound to this host.
    Host(&'static str),
    /// The secret is bound to any host.
    AnyHost,
    /// The secret has a base URL env var whose host it is bound to.
    BaseUrl,
}

/// One delivery of a recipe. While it is on, the tool may reach any of the
/// secret's bound hosts over it.
#[derive(Debug)]
pub(crate) struct Route {
    pub delivery: Delivery,
    pub when: When,
    pub inject: Inject,
}

impl Route {
    pub(crate) fn active(&self, s: &SecretDef) -> bool {
        let bound = |h: &str| s.hosts.iter().any(|x| x.eq_ignore_ascii_case(h));
        match self.when {
            When::Host(h) => bound(h),
            When::AnyHost => !s.hosts.is_empty(),
            When::BaseUrl => !s.api.base_url_env.is_empty() && base_url_host(s.api.base_url.trim()).is_some_and(|h| bound(&h)),
        }
    }

    /// The host a `When::Host` route serves, for env that names it.
    pub(crate) fn host(&self) -> Option<&'static str> {
        match self.when { When::Host(h) => Some(h), _ => None }
    }
}

/// Request shapes the recipe's rules can name beyond HTTP verb + path.
#[derive(Debug, Default)]
pub(crate) struct Classify {
    /// `POST /graphql` as `QUERY` / `MUTATION <name>`.
    pub graphql: bool,
    /// git smart-HTTP as `fetch` / `push <owner/repo>`.
    pub git: bool,
}

#[derive(Debug)]
pub(crate) struct Spec {
    pub routes: &'static [Route],
    /// Env vars that could carry a real token in from Termic's own
    /// environment. Stripped from every spawn holding this recipe (an API
    /// key also strips its own env vars, see `strip_env`).
    pub strip_env: &'static [&'static str],
    pub classify: Classify,
}

static GITHUB: Spec = Spec {
    routes: &[
        Route { delivery: Delivery::GhSocket, when: When::Host("api.github.com"), inject: Inject::Scheme(&["token", "bearer"]) },
        Route { delivery: Delivery::GitProxy, when: When::Host("github.com"), inject: Inject::BasicPassword },
    ],
    strip_env: &["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"],
    classify: Classify { graphql: true, git: true },
};

static API_KEY: Spec = Spec {
    routes: &[
        Route { delivery: Delivery::BaseUrl, when: When::BaseUrl, inject: Inject::ApiKeyHeader },
        Route { delivery: Delivery::EnvProxy, when: When::AnyHost, inject: Inject::ApiKeyHeader },
    ],
    strip_env: &[],
    classify: Classify { graphql: false, git: false },
};

/// A recipe from a newer Termic: no routes, so nothing is ever delivered.
static INERT: Spec = Spec { routes: &[], strip_env: &[], classify: Classify { graphql: false, git: false } };

pub(crate) fn spec(r: Recipe) -> &'static Spec {
    match r {
        Recipe::Github => &GITHUB,
        Recipe::ApiKey => &API_KEY,
        Recipe::Unknown => &INERT,
    }
}

impl Spec {
    pub(crate) fn route(&self, d: Delivery) -> Option<&'static Route> {
        self.routes.iter().find(|r| r.delivery == d)
    }
}

/// Every env var a secret must strip: the recipe's, plus an API key's own
/// (Termic's env may hold the real `OPENAI_API_KEY`).
pub(crate) fn strip_env(s: &SecretDef) -> impl Iterator<Item = String> + '_ {
    let own = match s.recipe {
        Recipe::ApiKey => vec![s.api.env.clone(), s.api.base_url_env.clone()],
        Recipe::Github | Recipe::Unknown => Vec::new(),
    };
    spec(s.recipe).strip_env.iter().map(|k| k.to_string()).chain(own.into_iter().filter(|k| !k.is_empty()))
}
