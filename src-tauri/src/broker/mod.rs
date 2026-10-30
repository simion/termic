//! Credential broker (docs/sandbox.md "Credential broker"). Swaps a per-spawn
//! placeholder for the real secret on the way to a bound host, so a caged
//! agent can USE a credential without ever holding it.
//!
//! Which tools reach it, how, and where each may have its placeholder
//! swapped is per recipe, in `recipe.rs`. Four deliveries, one request
//! path (`serve`):
//!   - gh's `http_unix_socket`: plaintext HTTP on a per-spawn socket, the
//!     broker dials TLS upstream (`socket.rs`).
//!   - git through the task's CONNECT proxy: a CONNECT to a bound host that
//!     carries this spawn's git proxy credentials is terminated with a leaf
//!     from a per-spawn CA git trusts for that URL only (`mitm.rs`, proxy.rs).
//!   - a base-URL env var (`OPENAI_BASE_URL`) at a per-spawn loopback
//!     endpoint, plaintext in, TLS upstream (`baseurl.rs`).
//!   - `HTTPS_PROXY` carrying a second set of proxy credentials, MITM'd like
//!     git, for curl / Python / Node that read the CA env vars.
//!
//! The real value is read from the Keychain (`keychain.rs`) only on the way
//! to a bound host, and only into the one header each recipe allows. It is
//! never logged, stored in an event, or returned by a command.

use crate::secrets::{ApiKeyCfg, Recipe, Role, SecretDef, TaskAllow};
use anyhow::{bail, Result};
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

#[cfg(unix)]
mod accept;
#[cfg(unix)]
mod baseurl;
mod http;
mod keychain;
mod mitm;
mod recipe;
mod rules;
#[cfg(unix)]
mod socket;

use http::HttpError;
use keychain::Secret;
use mitm::Connector;
pub(crate) use recipe::Delivery;
use recipe::{Inject, Route};
use rules::{Op, Verdict};

const PROXY_USER: &str = "termic";

/// Idle limits on a client connection (every delivery), so a stuck or
/// non-reading peer cannot pin a broker thread. The read side only waits
/// while the client is sending its request (one per connection; a slow
/// upstream blocks the broker's upstream write, not this read), so it is
/// short: a peer that connects and stalls frees its slot quickly.
pub(crate) const CLIENT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
pub(crate) const CLIENT_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Everything one agent spawn needs to use its role. Dropping it stops the
/// gh socket listener, unlinks the socket and forgets the placeholders.
pub struct BrokerHandle {
    pub task_id: String,
    /// Env the caged agent gets (`GH_TOKEN`, `GH_CONFIG_DIR`,
    /// `GIT_CONFIG_COUNT/KEY/VALUE`, ...). Placeholders only.
    pub env: Vec<(String, String)>,
    /// Env vars that must NOT reach the agent (real tokens inherited from
    /// Termic's own environment).
    pub strip_env: Vec<String>,
    /// Read+write paths the cage must allow: gh's config dir only.
    pub rw_paths: Vec<String>,
    /// Read-only paths: the spawn dir (CA pem, bundle). Not writable, so the
    /// agent cannot unlink the gh socket or swap the CA its tools trust.
    pub ro_paths: Vec<String>,
    /// The gh unix socket the cage must be allowed to connect to.
    pub socket_path: Option<PathBuf>,
    /// The loopback port of the base-URL endpoint the cage must reach.
    pub base_url_port: Option<u16>,
    spawn: Arc<Spawn>,
    #[cfg(unix)]
    listener: Option<socket::Listener>,
    #[cfg(unix)]
    base_url: Option<baseurl::Listener>,
    dir: PathBuf,
}

impl BrokerHandle {
    /// What the task's proxy needs to MITM this spawn's git traffic.
    pub(crate) fn mitm_ctx(&self) -> Arc<Spawn> { self.spawn.clone() }
}

impl Drop for BrokerHandle {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            drop(self.listener.take());
            drop(self.base_url.take());
        }
        let _ = std::fs::remove_dir_all(&self.dir);
        live_add(&self.task_id, &self.spawn, false);
    }
}

/// What a spawn's broker is set up with.
pub struct StartArgs<'a> {
    pub task_id: &'a str,
    pub role: &'a Role,
    /// All secrets in settings; the broker picks the role's.
    pub secrets: &'a [SecretDef],
    pub task_allows: &'a [TaskAllow],
    /// The task's network allow-list regexes (Enforce). Non-bound hosts on
    /// the gh socket are only forwarded when they match. Empty + `allow_all`
    /// for EnforceFs.
    pub host_patterns: Vec<String>,
    pub allow_all_hosts: bool,
    /// The task's MITM-capable proxy port, when one runs.
    pub proxy_port: Option<u16>,
    /// Per-spawn scratch dir (gh config, CA pem).
    pub dir: PathBuf,
}

pub fn start(args: StartArgs<'_>, profile: crate::profiles::ProfileId) -> Result<BrokerHandle> {
    start_with(args, Deps::system(profile))
}

/// Whether a role needs a MITM delivery (and so, in EnforceFs, a proxy).
pub(crate) fn role_wants_mitm(role: &Role, secrets: &[SecretDef]) -> bool {
    role_bindings(role, secrets).any(|s| active_routes(s).any(|r| r.delivery.is_mitm()))
}

/// The recipe routes a secret turns on.
fn active_routes(s: &SecretDef) -> impl Iterator<Item = &'static Route> + '_ {
    recipe::spec(s.recipe).routes.iter().filter(move |r| r.active(s))
}

fn role_bindings<'a>(role: &'a Role, secrets: &'a [SecretDef]) -> impl Iterator<Item = &'a SecretDef> {
    role.secrets.iter().filter_map(|id| secrets.iter().find(|s| &s.id == id))
        .filter(|s| !s.hosts.is_empty() && s.recipe != Recipe::Unknown)
}

fn covers(s: &SecretDef, host: &str) -> bool {
    s.hosts.iter().any(|h| h.eq_ignore_ascii_case(host))
}

/// Where every spawn dir lives, `/private/tmp/termic-<uid>`: the
/// canonical form, because Seatbelt matches resolved paths. Every caged
/// profile denies it and re-opens only its own spawn's dir.
#[cfg(unix)]
pub fn spawn_base_dir() -> Option<PathBuf> {
    // SAFETY: getuid cannot fail.
    let uid = unsafe { libc::getuid() };
    let root = if cfg!(target_os = "macos") { "/private/tmp" } else { "/tmp" };
    Some(PathBuf::from(format!("{root}/termic-{uid}")))
}

#[cfg(not(unix))]
pub fn spawn_base_dir() -> Option<PathBuf> { None }

/// A fresh per-spawn dir, `<spawn_base_dir>/<12 hex>` (mode 0700). Short
/// on purpose: the gh socket lives in it and macOS caps a socket path at
/// 104 bytes.
#[cfg(unix)]
pub fn new_spawn_dir() -> Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    // SAFETY: getuid cannot fail.
    let uid = unsafe { libc::getuid() };
    let Some(base) = spawn_base_dir() else { bail!("no spawn dir on this OS") };
    if let Err(e) = std::fs::DirBuilder::new().mode(0o700).create(&base) {
        if e.kind() != std::io::ErrorKind::AlreadyExists { return Err(e.into()); }
    }
    // /tmp is shared: refuse a dir someone else made or a symlink.
    let m = std::fs::symlink_metadata(&base)?;
    if !m.is_dir() || m.uid() != uid { bail!("{} is not a directory owned by this user", base.display()); }
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700))?;
    let dir = base.join(&random_hex()[..12]);
    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    Ok(dir)
}

#[cfg(not(unix))]
pub fn new_spawn_dir() -> Result<PathBuf> {
    bail!("the credential broker needs macOS")
}

fn random_hex() -> String { uuid::Uuid::new_v4().simple().to_string() }

/// `termic_ph_` + 32 hex chars, minted per spawn.
fn placeholder() -> String { format!("termic_ph_{}", random_hex()) }

// ─── spawn state ─────────────────────────────────────────────────────

/// One secret this spawn may use, and the placeholder that stands for it.
struct Binding {
    secret: SecretDef,
    placeholder: String,
}

/// Seams for tests: dialing upstream, the peer check, the Keychain, and the
/// live rule lookup.
#[derive(Clone)]
pub(crate) struct Deps {
    pub(crate) connector: Connector,
    pub(crate) peer_ok: PeerCheck,
    pub(crate) read_secret: SecretReader,
    pub(crate) live: LiveRules,
    /// Where `stale` reads the role and secrets as they are now. None in
    /// tests, which never report stale.
    pub(crate) profile: Option<crate::profiles::ProfileId>,
}

type PeerCheck = Arc<dyn Fn(&str, u32) -> bool + Send + Sync>;
type SecretReader = Arc<dyn Fn(&SecretDef) -> Result<Arc<Secret>, SecretStatus> + Send + Sync>;
type LiveRules = Arc<dyn Fn(&str, &str) -> Option<(Role, Vec<TaskAllow>)> + Send + Sync>;

impl Deps {
    fn system(profile: crate::profiles::ProfileId) -> Self {
        Deps {
            connector: mitm::system_connector(),
            peer_ok: Arc::new(crate::sandbox::pid_in_task),
            read_secret: Arc::new(keychain::read),
            profile: Some(profile.clone()),
            live: Arc::new(move |task, role| live_rules(&profile, task, role)),
        }
    }
}

/// The role and task allows as they are NOW, so edits apply to the next
/// request without a restart.
// ponytail: the task's own file plus a settings parse per brokered request.
// gh and git make a handful per command; cache with a short TTL if that
// ever shows up in a profile.
/// Never None: a role that is gone (deleted, or settings unreadable, which
/// load as defaults) comes back empty, so every secret reads as revoked
/// rather than falling back to what the spawn started with. A task that is
/// gone has no allows. `None` from the seam only means "no live source",
/// which tests use.
fn live_rules(profile: &crate::profiles::ProfileId, task_id: &str, role_id: &str) -> Option<(Role, Vec<TaskAllow>)> {
    let allows = crate::load_task_in(profile, task_id).map(|t| t.secret_allows).unwrap_or_default();
    let role = crate::load_settings_in(profile).roles.into_iter().find(|r| r.id == role_id)
        .unwrap_or_else(|| Role { id: role_id.to_string(), name: "(deleted)".into(), ..Default::default() });
    Some((role, allows))
}

/// One agent spawn's broker state, shared by the socket listener and the
/// task's proxy.
pub(crate) struct Spawn {
    pub(crate) task_id: String,
    /// Spawn-time role and allows, used only when the live seam has no
    /// source (tests). The system lookup never returns empty: a deleted role
    /// reads as one with no secrets, so it revokes.
    role: Role,
    allows: Vec<TaskAllow>,
    bindings: Vec<Binding>,
    hosts: Vec<Regex>,
    allow_all: bool,
    /// `Proxy-Authorization` git sends on CONNECT; only a CONNECT carrying
    /// it is ever MITM'd, so other tools through the same proxy never see
    /// Termic's CA.
    proxy_auth: String,
    /// The same for `HTTPS_PROXY` (env-proxy delivery). Separate from git's
    /// so a CONNECT is MITM'd only for the delivery that asked: a Go tool
    /// on `HTTPS_PROXY` would fail TLS against a host only git's route binds.
    env_proxy_auth: String,
    /// First path segment of the base-URL endpoint. The endpoint is TCP, so
    /// there is no peer pid; knowing this spawn's URL is the check.
    base_marker: String,
    ca: Option<mitm::Ca>,
    pub(crate) deps: Deps,
}

impl Spawn {
    fn binding_for(&self, host: &str) -> Option<&Binding> {
        self.bindings.iter().find(|b| covers(&b.secret, host))
    }

    /// The binding that turns a delivery on, and its route.
    fn route(&self, d: Delivery) -> Option<(&Binding, &'static Route)> {
        self.bindings.iter().find_map(|b| active_routes(&b.secret).find(|r| r.delivery == d).map(|r| (b, r)))
    }

    /// The binding for `host` when it reaches the broker over `d`.
    fn binding_via(&self, host: &str, d: Delivery) -> Option<&Binding> {
        self.binding_for(host).filter(|b| active_routes(&b.secret).any(|r| r.delivery == d))
    }

    fn host_allowed(&self, host: &str) -> bool {
        self.allow_all || self.hosts.iter().any(|r| r.is_match(host))
    }

    /// The first spot an own placeholder appears where its secret is not
    /// bound to `host`. Basic credentials are decoded first, so base64
    /// cannot hide one.
    fn stray<'a>(&self, host: &str, target: &str, headers: impl Iterator<Item = (&'a str, &'a [u8])> + Clone) -> Option<String> {
        for b in self.bindings.iter().filter(|b| !covers(&b.secret, host)) {
            if target.contains(&b.placeholder) { return Some("request target".into()); }
            for (k, v) in headers.clone() {
                if header_texts(k, v).iter().any(|t| t.contains(&b.placeholder)) { return Some(format!("{k} header")); }
            }
        }
        None
    }

    /// Which MITM delivery a CONNECT is, if any: this spawn's git or
    /// env-proxy credentials, for a host bound over that delivery.
    pub(crate) fn mitm_delivery(&self, host: &str, port: u16, proxy_auth: Option<&str>) -> Option<Delivery> {
        if port != 443 || self.ca.is_none() { return None; }
        let a = proxy_auth?.trim();
        [(Delivery::GitProxy, &self.proxy_auth), (Delivery::EnvProxy, &self.env_proxy_auth)]
            .into_iter()
            .find(|(d, want)| ct_eq(a, want) && self.binding_via(host, *d).is_some())
            .map(|(d, _)| d)
    }

    /// Terminate TLS on an accepted CONNECT and serve the request inside.
    /// The caller has already answered `200 Connection Established`.
    pub(crate) fn serve_mitm(&self, tcp: std::net::TcpStream, host: &str, d: Delivery) -> Result<()> {
        let Some(ca) = &self.ca else { bail!("no CA for this spawn") };
        let _ = tcp.set_read_timeout(Some(CLIENT_READ_TIMEOUT));
        let _ = tcp.set_write_timeout(Some(CLIENT_WRITE_TIMEOUT));
        let tls = mitm::accept(ca, host, tcp)?;
        let mut r = BufReader::new(tls);
        serve(self, &mut r, Via::Mitm(host, d));
        let tls = r.get_mut();
        tls.conn.send_close_notify();
        let _ = tls.flush();
        Ok(())
    }

    /// A plain-HTTP proxy request carrying one of this spawn's placeholders
    /// is refused and recorded: the broker only ever substitutes over TLS
    /// it dialed itself. Returns true when it refused.
    pub(crate) fn refuse_plain_http(&self, host: &str, target: &str, header_block: &str, w: &mut dyn Write) -> bool {
        let lines: Vec<(&str, &[u8])> = header_block.split("\r\n")
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim(), v.trim().as_bytes()))
            .collect();
        // nothing is bound over plain HTTP, so check against no host.
        let hit = self.bindings.iter().any(|b| {
            target.contains(&b.placeholder)
                || lines.iter().any(|(k, v)| header_texts(k, v).iter().any(|t| t.contains(&b.placeholder)))
        });
        if !hit { return false; }
        record_suspicious(&self.task_id, "placeholder_unbound_host", host, "plain http request");
        let _ = http::respond(w, 403, "Forbidden", &[("X-Termic-Secrets", "placeholder-unbound-host")],
            &format!("Refused by Termic: a Termic secret placeholder was sent to {host} over plain HTTP.\n"));
        true
    }
}

/// Equal without an early exit, for credentials compared on every request.
fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A header value as text, plus its decoded Basic credentials.
fn header_texts(name: &str, v: &[u8]) -> Vec<String> {
    let s = String::from_utf8_lossy(v).into_owned();
    let mut out = Vec::new();
    if name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("proxy-authorization") {
        if let Some(d) = decode_basic(&s) { out.push(d); }
    }
    out.push(s);
    out
}

fn decode_basic(v: &str) -> Option<String> {
    use base64::Engine;
    let (scheme, rest) = v.trim().split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") { return None; }
    let d = base64::engine::general_purpose::STANDARD.decode(rest.trim()).ok()?;
    String::from_utf8(d).ok()
}

/// Where the placeholder sits in the request, i.e. the one spot its
/// delivery allows it to be swapped (`recipe::Inject`). `Value` is an API
/// key header, with the prefix as the client wrote it.
#[derive(Debug, PartialEq, Eq)]
enum AuthForm { Scheme(String), Basic(String), Value(Option<String>) }

/// The header an inject spot lives in.
fn spot_header(inject: Inject, api: &ApiKeyCfg) -> &str {
    match inject {
        Inject::Scheme(_) | Inject::BasicPassword => "authorization",
        Inject::ApiKeyHeader => &api.header,
    }
}

/// `value` is the spot header's value (`spot_header`), present once.
fn auth_form(value: Option<&str>, placeholder: &str, inject: Inject, api: &ApiKeyCfg) -> Option<AuthForm> {
    let v = value?;
    match inject {
        Inject::ApiKeyHeader => {
            let v = v.trim();
            if api.scheme.is_empty() { return (v == placeholder).then_some(AuthForm::Value(None)); }
            let (scheme, rest) = v.split_once(' ')?;
            (scheme.eq_ignore_ascii_case(&api.scheme) && rest.trim() == placeholder)
                .then(|| AuthForm::Value(Some(scheme.to_string())))
        }
        Inject::Scheme(schemes) => {
            let (scheme, rest) = v.split_once(' ')?;
            (schemes.iter().any(|s| scheme.eq_ignore_ascii_case(s)) && rest.trim() == placeholder)
                .then(|| AuthForm::Scheme(scheme.to_string()))
        }
        Inject::BasicPassword => {
            let (user, pass) = decode_basic(v)?.split_once(':').map(|(u, p)| (u.to_string(), p.to_string()))?;
            (pass == placeholder).then_some(AuthForm::Basic(user))
        }
    }
}

fn render_auth(form: &AuthForm, real: &Secret) -> String {
    use base64::Engine;
    match form {
        AuthForm::Scheme(s) => format!("{s} {}", real.expose()),
        AuthForm::Basic(user) => format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{}", real.expose()))),
        AuthForm::Value(None) => real.expose().to_string(),
        AuthForm::Value(Some(s)) => format!("{s} {}", real.expose()),
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Via<'a> { Socket, Mitm(&'a str, Delivery), BaseUrl }

impl Via<'_> {
    fn delivery(&self) -> Delivery {
        match self { Via::Socket => Delivery::GhSocket, Via::Mitm(_, d) => *d, Via::BaseUrl => Delivery::BaseUrl }
    }
}

/// Why a base-URL request was refused before it reached a host.
enum BaseUrlRefusal { Marker, NotBound(String) }

impl Spawn {
    /// `/<marker>/<host>/rest` -> host, with the target cut to `/rest` and
    /// `Host` set to the host. The host must be bound over the base-URL
    /// delivery, so the endpoint is never a general forwarder.
    fn base_url_target(&self, head: &mut http::Head) -> Result<String, BaseUrlRefusal> {
        let t = head.target.strip_prefix('/').unwrap_or("");
        let (marker, rest) = t.split_once('/').unwrap_or((t, ""));
        if !ct_eq(marker, &self.base_marker) { return Err(BaseUrlRefusal::Marker); }
        let cut = rest.find(['/', '?']).unwrap_or(rest.len());
        let host = rest[..cut].to_ascii_lowercase();
        let ok = !host.is_empty() && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
        if !ok || self.binding_via(&host, Delivery::BaseUrl).is_none() { return Err(BaseUrlRefusal::NotBound(host)); }
        let path = &rest[cut..];
        head.target = match path.chars().next() { None => "/".into(), Some('?') => format!("/{path}"), _ => path.to_string() };
        for (k, v) in head.headers.iter_mut() {
            if k.eq_ignore_ascii_case("host") { *v = host.clone().into_bytes(); }
        }
        Ok(host)
    }
}

/// `Host` as (lowercase host, port). Only plain DNS names and IPv4: the
/// broker never needs anything else, and a strict shape keeps odd hosts
/// out of the bound-host check.
fn host_port(v: Option<&str>) -> Option<(String, u16)> {
    let v = v?;
    let (h, p) = match v.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().ok()?),
        None => (v, 443),
    };
    let ok = !h.is_empty() && h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    ok.then(|| (h.to_ascii_lowercase(), p))
}

/// One request, start to finish. Never logs a header value.
pub(crate) fn serve<S: Read + Write>(sp: &Spawn, r: &mut BufReader<S>, via: Via) {
    let refuse = |r: &mut BufReader<S>, code: u16, reason: &str, kind: &str, body: String| {
        let _ = http::respond(r.get_mut(), code, reason, &[("X-Termic-Secrets", kind)], &body);
    };
    let mut head = match http::read_head(r) {
        Ok(h) => h,
        Err(HttpError::Reject(c, why)) => return refuse(r, c, why, "bad-request", format!("{why}\n")),
        Err(HttpError::Io(_)) => return,
    };
    let (host, port) = if let Via::BaseUrl = via {
        match sp.base_url_target(&mut head) {
            Ok(h) => (h, 443),
            Err(BaseUrlRefusal::Marker) => {
                record_suspicious(&sp.task_id, "wrong_peer", "", "base-URL request without this agent's endpoint path");
                return refuse(r, 403, "Forbidden", "wrong-peer", "Refused by Termic: this endpoint belongs to another task's agent.\n".into());
            }
            Err(BaseUrlRefusal::NotBound(h)) => return refuse(r, 403, "Forbidden", "not-bound",
                format!("Refused by Termic: no secret of this task is bound to {h} over its base URL.\n")),
        }
    } else {
        let Some(hp) = host_port(head.one("host")) else {
            return refuse(r, 400, "Bad Request", "bad-request", "Bad Host header\n".into());
        };
        hp
    };
    if let Via::Mitm(tunnel, _) = via {
        // the tunnel is always :443 (`mitm_delivery`); a Host naming another
        // port must not move the real token there.
        if !host.eq_ignore_ascii_case(tunnel) || port != 443 {
            return refuse(r, 400, "Bad Request", "bad-request", "Host does not match the CONNECT target\n".into());
        }
    }
    if is_paused(&sp.task_id) {
        return refuse(r, 403, "Forbidden", "paused",
            "Refused by Termic: secrets are paused for this task. Resume them from the task's Secrets popover.\n".into());
    }
    let headers = head.headers.iter().map(|(k, v)| (k.as_str(), v.as_slice()));
    if let Some(spot) = sp.stray(&host, &head.target, headers) {
        record_suspicious(&sp.task_id, "placeholder_unbound_host", &host, &spot);
        return refuse(r, 403, "Forbidden", "placeholder-unbound-host",
            format!("Refused by Termic: a Termic secret placeholder was sent to {host}, which that secret is not bound to.\n"));
    }

    let Some(b) = sp.binding_for(&host) else {
        // not a bound host: a plain forward, under the task's allow-list.
        if !sp.host_allowed(&host) {
            crate::proxy::incr_network_deny(&sp.task_id, &host);
            let _ = http::respond(r.get_mut(), 403, "Blocked by Termic sandbox", &[("X-Termic-Sandbox", "blocked-by-allowlist")],
                &format!("Blocked by Termic sandbox.\n\nHost: {host}\nThis task's allowed-hosts list does NOT permit traffic to this host.\n"));
            return;
        }
        if forward(sp, r, &head, &host, port, None, None) == Some(401) {
            record_no_secret(&sp.task_id, &host);
        }
        return;
    };

    let (role, allows) = (sp.deps.live)(&sp.task_id, &sp.role.id).unwrap_or_else(|| (sp.role.clone(), sp.allows.clone()));
    let sid = b.secret.id.as_str();
    // the binding was fixed at spawn, the role is read live: a secret taken
    // off the role (or deleted, which takes it off) is revoked now, not at
    // the next restart. Its rule sets went with it, so judging it would allow.
    if !role.secrets.iter().any(|s| s == sid) {
        return refuse(r, 403, "Forbidden", "secret-revoked",
            format!("Refused by Termic: secret \"{}\" is no longer in role \"{}\".\n", b.secret.name, role.name));
    }
    let spec = recipe::spec(b.secret.recipe);
    let mut buffered = None;
    // TRACE / TRACK echo the request, swapped header included; CONNECT has no
    // business on an origin. A method spelled like a pseudo-verb (`QUERY`,
    // `push`) would be judged as that verb, so it is refused too.
    let m = head.method.as_str();
    if ["TRACE", "TRACK", "CONNECT"].iter().chain(rules::PSEUDO.iter()).any(|x| m.eq_ignore_ascii_case(x)) {
        return refuse(r, 405, "Method Not Allowed", "bad-request", format!("Termic refuses {m} on brokered hosts\n"));
    }
    // method overrides would have upstream run a different verb than the
    // one the rules judged.
    let overridden = head.headers.iter().any(|(k, _)| {
        ["x-http-method-override", "x-http-method", "x-method-override"].iter().any(|h| k.eq_ignore_ascii_case(h))
    }) || head.query().split('&').any(|kv| kv.starts_with("_method="));
    if overridden {
        return refuse(r, 400, "Bad Request", "bad-request", "Termic refuses HTTP method overrides on brokered hosts\n".into());
    }
    let path = rules::rule_path(head.path());
    let git = spec.classify.git.then(|| rules::classify_git(path, head.query())).flatten();
    let graphql = spec.classify.graphql && rules::is_graphql(path);
    let op = if let Some(g) = git {
        g
    } else if graphql && !head.method.eq_ignore_ascii_case("POST") {
        // only POST bodies are classified; anything else is an unknown op.
        rules::Op::Graphql { mutations: vec!["<non-post graphql>".into()] }
    } else if graphql && has_rules(&role, &allows, sid, &host) {
        match buffer_body(r, &head.body) {
            Ok((raw, data)) => { buffered = Some(raw); rules::classify_graphql(&data) }
            Err(HttpError::Reject(c, why)) => return refuse(r, c, why, "bad-request",
                format!("{why}: Termic reads GraphQL bodies up to 1 MiB to apply the task's role\n")),
            Err(HttpError::Io(_)) => return,
        }
    } else {
        Op::Http
    };
    if let Verdict::Deny { rule, verb, target } = rules::evaluate(sid, &host, &head.method, path, &op, &role, &allows) {
        record_blocked(&sp.task_id, &sp.role.id, sid, &host, &verb, &target, &rule);
        return refuse(r, 403, "Forbidden", "blocked-by-role",
            format!("blocked by Termic role \"{}\" ({verb} {target})\n", role.name));
    }

    let inject = spec.route(via.delivery()).map(|r| r.inject);
    let spot = inject.map(|i| spot_header(i, &b.secret.api));
    // the spot header exactly once, or nothing is swapped.
    let value = spot.filter(|h| head.headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case(h)).count() == 1)
        .and_then(|h| head.one(h));
    let auth = match inject.and_then(|i| auth_form(value, &b.placeholder, i, &b.secret.api)) {
        Some(form) => match (sp.deps.read_secret)(&b.secret) {
            Ok(real) => Some((spot.unwrap_or("authorization"), render_auth(&form, &real))),
            Err(st) => {
                let what = match &st {
                    SecretStatus::Locked => "the Keychain is locked".to_string(),
                    SecretStatus::Missing => "the Keychain item is missing".to_string(),
                    SecretStatus::Denied => "Keychain access was denied".to_string(),
                    SecretStatus::Error(e) => e.clone(),
                    SecretStatus::Readable => "unknown".to_string(),
                };
                crate::dlog(&format!("[broker/{}] secret {} unreadable: {what}", sp.task_id, b.secret.name));
                return refuse(r, 503, "Service Unavailable", "keychain-unreadable",
                    format!("Termic could not read secret \"{}\": {what}.\n", b.secret.name));
            }
        },
        None => None,
    };
    let verb = match &op { Op::Git { push: true, .. } => "push".to_string(), Op::Git { .. } => "fetch".to_string(), _ => head.method.clone() };
    let used = auth.is_some();
    forward(sp, r, &head, &host, port, auth.as_ref().map(|(h, v)| (*h, v.as_str())), buffered);
    if used { record_used(&sp.task_id, &sp.role.id, sid, &host, &verb); }
}

fn has_rules(role: &Role, allows: &[TaskAllow], secret: &str, host: &str) -> bool {
    role.rule_sets.iter().any(|s| s.secret == secret && s.host.eq_ignore_ascii_case(host))
        || allows.iter().any(|a| a.secret == secret && a.host.eq_ignore_ascii_case(host))
}

/// Read a body to classify it, keeping the raw framing to send on.
fn buffer_body<R: std::io::BufRead>(r: &mut R, body: &http::Body) -> Result<(Vec<u8>, Vec<u8>), HttpError> {
    let too_big = HttpError::Reject(413, "Payload Too Large");
    if let http::Body::Length(n) = body {
        if *n as usize > rules::MAX_GRAPHQL_BODY { return Err(too_big); }
    }
    let (mut raw, mut data) = (Vec::new(), Vec::new());
    let cap = rules::MAX_GRAPHQL_BODY;
    http::walk_body(r, body,
        &mut |b| { if raw.len() + b.len() > cap + 64 * 1024 { return Err(HttpError::Reject(413, "Payload Too Large")); } raw.extend_from_slice(b); Ok(()) },
        &mut |b| { if data.len() + b.len() > cap { return Err(HttpError::Reject(413, "Payload Too Large")); } data.extend_from_slice(b); Ok(()) })?;
    Ok((raw, data))
}

/// Dial upstream, send the head (+ body), stream the response back.
/// Returns the upstream status.
/// `auth` is (header, value) replacing that header's value.
fn forward<S: Read + Write>(sp: &Spawn, r: &mut BufReader<S>, head: &http::Head, host: &str, port: u16, auth: Option<(&str, &str)>, buffered: Option<Vec<u8>>) -> Option<u16> {
    let mut up = match (sp.deps.connector)(host, port) {
        Ok(u) => u,
        Err(e) => {
            crate::dlog(&format!("[broker/{}] upstream {host}:{port} failed: {e}", sp.task_id));
            let _ = http::respond(r.get_mut(), 502, "Bad Gateway", &[("X-Termic-Secrets", "upstream-failed")],
                &format!("Termic could not reach {host}: {e}\n"));
            return None;
        }
    };
    let sent = (|| -> Result<(), HttpError> {
        up.write_all(&http::serialize(head, auth))?;
        match &buffered {
            Some(b) => up.write_all(b)?,
            None => http::walk_body(r, &head.body, &mut |b| up.write_all(b).map_err(HttpError::from), &mut |_| Ok(()))?,
        }
        up.flush()?;
        Ok(())
    })();
    match sent {
        Ok(()) => {}
        Err(HttpError::Reject(c, why)) => {
            let _ = http::respond(r.get_mut(), c, why, &[("X-Termic-Secrets", "bad-request")], &format!("{why}\n"));
            return None;
        }
        // upstream may have answered early (a 401 before a push body); relay it.
        Err(HttpError::Io(_)) => {}
    }
    http::relay_response(&mut up, r.get_mut())
}

// ─── env for the caged agent ─────────────────────────────────────────

struct GitEnv<'a> { host: &'a str, placeholder: &'a str, ca_pem: &'a Path, proxy_url: &'a str }

/// The agent's env: placeholders and pointers only. `git_base` is how many
/// `GIT_CONFIG_*` entries the inherited env already has; ours append.
fn render_env(gh: Option<(&str, &Path)>, git: Option<GitEnv>, git_base: usize) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some((ph, dir)) = gh {
        env.push(("GH_TOKEN".into(), ph.to_string()));
        env.push(("GH_CONFIG_DIR".into(), dir.to_string_lossy().into_owned()));
        env.push(("GH_NO_UPDATE_NOTIFIER".into(), "1".into()));
    }
    if let Some(g) = git {
        let url = format!("https://{}/", g.host);
        let kv = [
            // reset every inherited helper, so the osxkeychain one (which the
            // cage cannot reach anyway) is never asked.
            ("credential.helper".to_string(), String::new()),
            (format!("credential.https://{}.helper", g.host),
                format!("!f() {{ test \"$1\" = get && printf 'username=x-access-token\\npassword=%s\\n' {}; }}; f", g.placeholder)),
            (format!("http.{url}.sslCAInfo"), g.ca_pem.to_string_lossy().into_owned()),
            (format!("http.{url}.proxy"), g.proxy_url.to_string()),
            // send the proxy credentials up front instead of waiting for a 407.
            (format!("http.{url}.proxyAuthMethod"), "basic".into()),
            // this leg only has to trust the spawn CA in sslCAInfo, and the
            // broker verifies the real upstream with the platform verifier,
            // so the host keeps Apple's trust either way. Scoped to this URL,
            // so every other host keeps the user's backend.
            (format!("http.{url}.sslBackend"), "openssl".into()),
        ];
        for (i, (k, v)) in kv.iter().enumerate() {
            env.push((format!("GIT_CONFIG_KEY_{}", git_base + i), k.clone()));
            env.push((format!("GIT_CONFIG_VALUE_{}", git_base + i), v.clone()));
        }
        env.push(("GIT_CONFIG_COUNT".into(), (git_base + kv.len()).to_string()));
    }
    env
}

/// An API key's env: the placeholder, and its base-URL var aimed at this
/// spawn's endpoint (`base` is (port, marker)) when that route is on.
fn api_key_env(b: &Binding, base: Option<(u16, &str)>) -> Vec<(String, String)> {
    let a = &b.secret.api;
    let mut env = vec![(a.env.clone(), b.placeholder.clone())];
    let on = recipe::spec(b.secret.recipe).route(Delivery::BaseUrl).is_some_and(|r| r.active(&b.secret));
    if let (true, Some((port, marker))) = (on, base) {
        // https://api.openai.com/v1 -> http://127.0.0.1:<port>/<marker>/api.openai.com/v1
        let real = a.base_url.trim().trim_end_matches('/');
        let rest = real.strip_prefix("https://").unwrap_or(real);
        env.push((a.base_url_env.clone(), format!("http://127.0.0.1:{port}/{marker}/{rest}")));
    }
    env
}

/// `HTTPS_PROXY` with the env-proxy credentials, and the CA where curl,
/// Python and Node look for one. `SSL_CERT_FILE` and friends REPLACE the
/// trust store, so they get `bundle` (the trust they had + this spawn's CA);
/// Node's var adds, so it gets `node_ca` (any extra certs it had + the CA).
fn env_proxy_env(proxy_url: &str, bundle: &Path, node_ca: &Path) -> Vec<(String, String)> {
    let p = |k: &str, v: &str| (k.to_string(), v.to_string());
    let bundle = bundle.to_string_lossy();
    vec![
        p("HTTPS_PROXY", proxy_url), p("https_proxy", proxy_url),
        // the base-URL endpoint is loopback; never send it through the proxy.
        p("NO_PROXY", "localhost,127.0.0.1,::1"), p("no_proxy", "localhost,127.0.0.1,::1"),
        p("SSL_CERT_FILE", &bundle), p("REQUESTS_CA_BUNDLE", &bundle), p("CURL_CA_BUNDLE", &bundle),
        p("NODE_EXTRA_CA_CERTS", &node_ca.to_string_lossy()),
    ]
}

/// What `SSL_CERT_FILE` would have meant without us: macOS's roots bundle.
const SYSTEM_ROOTS: &str = "/etc/ssl/cert.pem";

/// A CA file the agent would have used, from Termic's env or the login
/// shell's (a GUI launch has no rc exports). A corporate CA lives here, and
/// overriding it with system roots alone would break every proxied host.
fn inherited_pem(vars: &[&str]) -> Option<Vec<u8>> {
    let (_, inject) = crate::shell_env::spawn_env();
    vars.iter().find_map(|k| {
        let v = std::env::var(k).ok().or_else(|| inject.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()))?;
        std::fs::read(v.trim()).ok().filter(|b| !b.is_empty())
    })
}

/// `base` followed by `pem`, with a newline between.
fn concat_pem(mut base: Vec<u8>, pem: &str) -> Vec<u8> {
    if !base.is_empty() && !base.ends_with(b"\n") { base.push(b'\n'); }
    base.extend_from_slice(pem.as_bytes());
    base
}

fn proxy_basic(marker: &str) -> String {
    use base64::Engine;
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{PROXY_USER}:{marker}")))
}

pub(crate) fn start_with(args: StartArgs<'_>, deps: Deps) -> Result<BrokerHandle> {
    // the caller made the dir; a failed start must not leave it behind.
    let dir = args.dir.clone();
    start_inner(args, deps).inspect_err(|_| { let _ = std::fs::remove_dir_all(&dir); })
}

fn start_inner(args: StartArgs<'_>, deps: Deps) -> Result<BrokerHandle> {
    let bindings: Vec<Binding> = role_bindings(args.role, args.secrets)
        .map(|s| Binding { secret: s.clone(), placeholder: placeholder() })
        .collect();
    if bindings.is_empty() { bail!("role {} has no usable secrets", args.role.name); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&args.dir)?;
        std::fs::set_permissions(&args.dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    bail!("the credential broker needs macOS");

    let mut bound: Vec<String> = bindings.iter().flat_map(|b| b.secret.hosts.iter().map(|h| h.to_ascii_lowercase())).collect();
    bound.sort();
    bound.dedup();
    let wants = |d: Delivery| bindings.iter().any(|b| active_routes(&b.secret).any(|r| r.delivery == d));
    let (wants_git, wants_env_proxy, wants_base) = (wants(Delivery::GitProxy), wants(Delivery::EnvProxy), wants(Delivery::BaseUrl));
    // one CA per spawn, shared by both MITM deliveries; each has its own
    // proxy credentials so a CONNECT is only MITM'd for the one that asked.
    let mitm_port = args.proxy_port.filter(|_| wants_git || wants_env_proxy);
    let mut strip_env: Vec<String> = Vec::new();
    for k in bindings.iter().flat_map(|b| recipe::strip_env(&b.secret)) {
        if !strip_env.contains(&k) { strip_env.push(k); }
    }
    let ca = match mitm_port { Some(_) => Some(mitm::Ca::mint(&bound)?), None => None };
    let (git_marker, env_marker, base_marker) = (random_hex(), random_hex(), random_hex());
    let ca_pem = args.dir.join("ca.pem");
    let bundle = args.dir.join("ca-bundle.pem");
    let node_ca = args.dir.join("node-ca.pem");
    if let Some(ca) = &ca {
        std::fs::write(&ca_pem, &ca.pem)?;
        if wants_env_proxy {
            let base = inherited_pem(&["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"])
                .unwrap_or_else(|| std::fs::read(SYSTEM_ROOTS).unwrap_or_default());
            std::fs::write(&bundle, concat_pem(base, &ca.pem))?;
            let extra = inherited_pem(&["NODE_EXTRA_CA_CERTS"]).unwrap_or_default();
            std::fs::write(&node_ca, concat_pem(extra, &ca.pem))?;
        }
    }
    let spawn = Arc::new(Spawn {
        task_id: args.task_id.to_string(),
        role: args.role.clone(),
        allows: args.task_allows.to_vec(),
        hosts: args.host_patterns.iter().filter_map(|p| Regex::new(p).ok()).collect(),
        allow_all: args.allow_all_hosts,
        proxy_auth: proxy_basic(&git_marker),
        env_proxy_auth: proxy_basic(&env_marker),
        base_marker: base_marker.clone(),
        ca,
        deps,
        bindings,
    });

    let gh = spawn.route(Delivery::GhSocket).map(|(b, _)| b);
    let gh_dir = args.dir.join("gh");
    let socket_path = gh.map(|_| args.dir.join("gh.sock"));
    #[cfg(unix)]
    let listener = match &socket_path {
        Some(p) => {
            std::fs::create_dir_all(&gh_dir)?;
            std::fs::write(gh_dir.join("config.yml"), format!("http_unix_socket: {}\n", p.display()))?;
            Some(socket::listen(spawn.clone(), p)?)
        }
        None => None,
    };
    #[cfg(unix)]
    let base_url = if wants_base { Some(baseurl::listen(spawn.clone())?) } else { None };
    #[cfg(unix)]
    let base_url_port = base_url.as_ref().map(|l| l.port);
    #[cfg(not(unix))]
    let base_url_port: Option<u16> = None;

    let proxy_url = |marker: &str| mitm_port.map(|p| format!("http://{PROXY_USER}:{marker}@127.0.0.1:{p}"));
    let git_url = proxy_url(&git_marker).filter(|_| wants_git);
    let git = spawn.route(Delivery::GitProxy).zip(git_url.as_deref())
        .and_then(|((b, r), url)| Some(GitEnv { host: r.host()?, placeholder: &b.placeholder, ca_pem: &ca_pem, proxy_url: url }));
    let git_base = std::env::var("GIT_CONFIG_COUNT").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    let mut env = render_env(gh.map(|b| (b.placeholder.as_str(), gh_dir.as_path())), git, git_base);
    for b in spawn.bindings.iter().filter(|b| b.secret.recipe == Recipe::ApiKey) {
        env.extend(api_key_env(b, base_url_port.map(|p| (p, base_marker.as_str()))));
    }
    if let Some(url) = proxy_url(&env_marker).filter(|_| wants_env_proxy) {
        env.extend(env_proxy_env(&url, &bundle, &node_ca));
    }

    live_add(args.task_id, &spawn, true);
    Ok(BrokerHandle {
        task_id: args.task_id.to_string(),
        env,
        strip_env,
        rw_paths: if socket_path.is_some() { vec![gh_dir.to_string_lossy().into_owned()] } else { Vec::new() },
        ro_paths: vec![args.dir.to_string_lossy().into_owned()],
        socket_path,
        base_url_port,
        spawn,
        #[cfg(unix)]
        listener,
        #[cfg(unix)]
        base_url,
        dir: args.dir,
    })
}

// ─── Keychain probe ──────────────────────────────────────────────────

/// Status of a secret's Keychain item. Never carries the value.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "status", content = "detail")]
pub enum SecretStatus {
    Readable,
    Locked,
    Missing,
    Denied,
    Error(String),
}

/// Read the item once and report whether it worked. The first read of an
/// item may show macOS's "Termic wants to access" prompt.
pub fn probe(s: &SecretDef) -> SecretStatus {
    match keychain::read_fresh(s) {
        Ok(_) => SecretStatus::Readable,
        Err(st) => st,
    }
}

/// Save a pasted value as the Termic-owned item for secret `id`, returning
/// the store it landed in. Write-only: no command reads it back.
pub fn store_owned(id: &str, name: &str, value: &str) -> Result<crate::secrets::KeychainKind, String> {
    if !crate::secrets::id_ok(id) { return Err("bad secret id".into()); }
    keychain::store(id, name, value)
}

/// Delete the Termic-owned item of a removed secret, from both stores.
pub fn forget_owned(id: &str) {
    if crate::secrets::id_ok(id) { keychain::forget(id); }
}

/// Delete the owned item for `id` unless a saved secret still uses it: the
/// add dialog's cleanup when the store worked and the settings save did
/// not. Returns whether it deleted.
pub fn forget_unsaved(saved: &[SecretDef], id: &str) -> bool {
    if saved.iter().any(|s| s.id == id) { return false; }
    forget_owned(id);
    true
}

pub fn protected_available() -> bool { keychain::protected_available() }

// ─── event tracker ───────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Default)]
pub struct UsedEntry {
    /// The role the spawn that used it was running (its spawn-time id).
    pub role: String,
    pub secret: String,
    pub host: String,
    /// "GET" -> 38, "POST" -> 6, or "fetch"/"push" for git.
    pub methods: Vec<(String, u64)>,
    pub last_seen_unix_ms: u128,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct BlockedEntry {
    /// The role that denied it: the spawn's, which a role-scoped Allow must
    /// land on, whatever the task's saved role is now.
    pub role: String,
    pub secret: String,
    pub host: String,
    pub method: String,
    pub path: String,
    /// Which rule denied it, human-readable ("DENY * everything else").
    pub rule: String,
    pub count: u64,
    pub last_seen_unix_ms: u128,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct NoSecretEntry {
    pub host: String,
    pub count: u64,
    pub last_seen_unix_ms: u128,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct SuspiciousEntry {
    /// `placeholder_unbound_host` | `keychain_denied` | `wrong_peer`
    pub kind: String,
    pub host: String,
    pub detail: String,
    pub count: u64,
    pub last_seen_unix_ms: u128,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct BrokerEvents {
    pub used: Vec<UsedEntry>,
    pub blocked: Vec<BlockedEntry>,
    pub no_secret: Vec<NoSecretEntry>,
    pub suspicious: Vec<SuspiciousEntry>,
}

#[derive(Clone, Debug, Serialize, Default, PartialEq, Eq)]
pub struct BrokerCounts {
    pub blocked: u64,
    pub suspicious: u64,
    pub no_secret: u64,
    pub used: u64,
    pub paused: bool,
    /// Live agent spawns of this task holding a broker.
    pub live: u64,
    /// The roles those spawns run, distinct and sorted: what is enforced
    /// now, which can differ from the task's saved role until a restart.
    pub roles: Vec<String>,
    /// A live spawn's role now binds different secrets than it started
    /// with. Bindings are set up at spawn, so that edit needs a restart.
    pub stale: bool,
}

/// Per-task events, same shape as proxy.rs's DENY_TRACKER. Keyed so a
/// repeat bumps a count instead of adding a row. No header values, ever.
/// Keys hold agent-chosen strings (paths, hosts), so each map is capped at
/// `MAX_ROWS` (oldest evicted) and every string truncated.
#[derive(Default)]
struct TaskEvents {
    used: HashMap<(String, String, String), UsedEntry>,
    blocked: HashMap<(String, String, String, String, String), BlockedEntry>,
    no_secret: HashMap<String, NoSecretEntry>,
    /// one row per (kind, host); `detail` is the latest.
    suspicious: HashMap<(String, String), SuspiciousEntry>,
}

impl TaskEvents {
    fn is_empty(&self) -> bool {
        self.used.is_empty() && self.blocked.is_empty() && self.no_secret.is_empty() && self.suspicious.is_empty()
    }

    fn snapshot(&self) -> BrokerEvents {
        fn sorted<T: Clone>(m: impl Iterator<Item = T>, at: impl Fn(&T) -> u128) -> Vec<T> {
            let mut v: Vec<T> = m.collect();
            v.sort_by_key(|e| std::cmp::Reverse(at(e)));
            v
        }
        BrokerEvents {
            used: sorted(self.used.values().cloned(), |e| e.last_seen_unix_ms),
            blocked: sorted(self.blocked.values().cloned(), |e| e.last_seen_unix_ms),
            no_secret: sorted(self.no_secret.values().cloned(), |e| e.last_seen_unix_ms),
            suspicious: sorted(self.suspicious.values().cloned(), |e| e.last_seen_unix_ms),
        }
    }
}

static EVENTS: OnceLock<Mutex<HashMap<String, TaskEvents>>> = OnceLock::new();
static PAUSED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
/// task -> each live brokered spawn.
static LIVE: OnceLock<Mutex<HashMap<String, Vec<Arc<Spawn>>>>> = OnceLock::new();

const MAX_ROWS: usize = 200;
/// Longest path / host / detail kept in an event row.
const MAX_FIELD: usize = 512;

fn clip(s: &str) -> String {
    if s.len() <= MAX_FIELD { return s.to_string(); }
    let mut end = MAX_FIELD;
    while !s.is_char_boundary(end) { end -= 1; }
    format!("{}…", &s[..end])
}

/// Drop the least recently seen row once a map is past `MAX_ROWS`.
fn cap<K: Clone + Eq + std::hash::Hash, V>(m: &mut HashMap<K, V>, at: impl Fn(&V) -> u128) {
    while m.len() > MAX_ROWS {
        let Some(k) = m.iter().min_by_key(|(_, v)| at(v)).map(|(k, _)| k.clone()) else { break };
        m.remove(&k);
    }
}

fn with_events<T>(task_id: &str, f: impl FnOnce(&mut TaskEvents) -> T) -> T {
    let mut g = EVENTS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    f(g.entry(task_id.to_string()).or_default())
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn record_used(task_id: &str, role: &str, secret: &str, host: &str, method: &str) {
    let host = clip(host);
    with_events(task_id, |e| {
        let u = e.used.entry((role.into(), secret.into(), host.clone()))
            .or_insert_with(|| UsedEntry { role: role.into(), secret: secret.into(), host, ..Default::default() });
        match u.methods.iter_mut().find(|(m, _)| m == method) {
            Some((_, n)) => *n += 1,
            None => u.methods.push((clip(method), 1)),
        }
        u.last_seen_unix_ms = now_ms();
        cap(&mut e.used, |u| u.last_seen_unix_ms);
    })
}

fn record_blocked(task_id: &str, role: &str, secret: &str, host: &str, method: &str, path: &str, rule: &str) {
    let (host, method, path) = (clip(host), clip(method), clip(path));
    with_events(task_id, |e| {
        let b = e.blocked.entry((role.into(), secret.into(), host.clone(), method.clone(), path.clone())).or_insert_with(|| BlockedEntry {
            role: role.into(), secret: secret.into(), host, method, path, ..Default::default()
        });
        b.rule = clip(rule);
        b.count += 1;
        b.last_seen_unix_ms = now_ms();
        cap(&mut e.blocked, |b| b.last_seen_unix_ms);
    })
}

fn record_no_secret(task_id: &str, host: &str) {
    let host = clip(host);
    with_events(task_id, |e| {
        let n = e.no_secret.entry(host.clone()).or_insert_with(|| NoSecretEntry { host, ..Default::default() });
        n.count += 1;
        n.last_seen_unix_ms = now_ms();
        cap(&mut e.no_secret, |n| n.last_seen_unix_ms);
    })
}

pub(crate) fn record_suspicious(task_id: &str, kind: &str, host: &str, detail: &str) {
    crate::dlog(&format!("[broker/{task_id}] SUSPICIOUS {kind} host={host} {detail}"));
    let host = clip(host);
    with_events(task_id, |e| {
        let s = e.suspicious.entry((kind.into(), host.clone())).or_insert_with(|| SuspiciousEntry { kind: kind.into(), host, ..Default::default() });
        s.detail = clip(detail);
        s.count += 1;
        s.last_seen_unix_ms = now_ms();
        cap(&mut e.suspicious, |s| s.last_seen_unix_ms);
    })
}

/// A spawn of `task_id` started (`up`) or ended.
fn live_add(task_id: &str, spawn: &Arc<Spawn>, up: bool) {
    let mut g = LIVE.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    let spawns = g.entry(task_id.to_string()).or_default();
    if up {
        spawns.push(spawn.clone());
    } else if let Some(i) = spawns.iter().position(|s| Arc::ptr_eq(s, spawn)) {
        spawns.swap_remove(i);
    }
    if spawns.is_empty() { g.remove(task_id); }
}

/// Whether `role` as saved now would bind other secrets than `sp` started
/// with: one added, swapped, or edited in a way the spawn baked in (hosts,
/// Keychain item, delivery). Rules are read live, so they never count. A
/// role that is gone is not stale: it already revokes everything live.
fn bindings_changed(sp: &Spawn, roles: &[Role], secrets: &[SecretDef]) -> bool {
    let Some(role) = roles.iter().find(|r| r.id == sp.role.id) else { return false };
    // the display name is not baked into anything.
    let key = |defs: Vec<&SecretDef>| {
        let mut v: Vec<SecretDef> = defs.into_iter().map(|s| SecretDef { name: String::new(), ..s.clone() }).collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    };
    key(role_bindings(role, secrets).collect()) != key(sp.bindings.iter().map(|b| &b.secret).collect())
}

fn stale(spawns: &[Arc<Spawn>]) -> bool {
    // ponytail: one settings parse per poll while a brokered agent is live
    // (the chip polls every 2s, live_rules already parses per request).
    // every spawn of a task shares its profile.
    let Some(p) = spawns.iter().find_map(|sp| sp.deps.profile.as_ref()) else { return false };
    let s = crate::load_settings_in(p);
    spawns.iter().any(|sp| bindings_changed(sp, &s.roles, &s.secrets))
}

fn is_paused(task_id: &str) -> bool {
    PAUSED.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner()).contains(task_id)
}

/// Whether any live agent spawn of the task holds a broker.
pub fn is_brokered(task_id: &str) -> bool {
    LIVE.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner()).contains_key(task_id)
}

pub fn events(task_id: &str) -> BrokerEvents {
    EVENTS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
        .get(task_id).map(TaskEvents::snapshot).unwrap_or_default()
}

pub fn counts(task_id: &str) -> BrokerCounts {
    let mut c = EVENTS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
        .get(task_id)
        .map(|e| BrokerCounts {
            blocked: e.blocked.values().map(|b| b.count).sum(),
            suspicious: e.suspicious.values().map(|s| s.count).sum(),
            no_secret: e.no_secret.values().map(|n| n.count).sum(),
            used: e.used.values().flat_map(|u| u.methods.iter().map(|(_, n)| *n)).sum(),
            ..Default::default()
        })
        .unwrap_or_default();
    c.paused = is_paused(task_id);
    let spawns = LIVE.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
        .get(task_id).cloned().unwrap_or_default();
    c.live = spawns.len() as u64;
    c.roles = spawns.iter().map(|s| s.role.id.clone()).collect();
    c.roles.sort();
    c.roles.dedup();
    // outside the lock: it reads settings from disk.
    c.stale = stale(&spawns);
    c
}

/// Every task with any event, for the Settings -> Secrets Activity tab.
pub fn all_events() -> Vec<(String, BrokerEvents)> {
    let g = EVENTS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    let mut out: Vec<(String, BrokerEvents)> = g.iter().filter(|(_, e)| !e.is_empty()).map(|(t, e)| (t.clone(), e.snapshot())).collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Forget the task's events, unless one of its agents still holds a broker:
/// a second tab or a restart must not erase what a running agent did.
pub fn clear_events(task_id: &str) {
    if is_brokered(task_id) { return; }
    if let Some(m) = EVENTS.get() {
        m.lock().unwrap_or_else(|e| e.into_inner()).remove(task_id);
    }
}

/// Drop the blocked rows an Allow just covered, from any role, so the row
/// (and the chip's count) does not come back on the next poll.
pub fn clear_blocked(task_id: &str, secret: &str, host: &str, method: &str, path: &str) {
    if let Some(m) = EVENTS.get() {
        if let Some(e) = m.lock().unwrap_or_else(|e| e.into_inner()).get_mut(task_id) {
            e.blocked.retain(|(_, s, h, mt, p), _| !(s == secret && h == host && mt.eq_ignore_ascii_case(method) && p == path));
        }
    }
}

/// Pause: every brokered request of the task is refused until resumed. Live.
pub fn set_paused(task_id: &str, paused: bool) {
    let mut g = PAUSED.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    if paused { g.insert(task_id.to_string()); } else { g.remove(task_id); }
}

/// Record a Keychain access the cage denied (fed from the sandbox path-deny
/// stream), shown as Suspicious.
pub fn record_keychain_denied(task_id: &str, path: &str) {
    record_suspicious(task_id, "keychain_denied", "", path);
}

/// A started broker with no network or Keychain behind it, for other
/// modules' tests.
#[cfg(test)]
pub(crate) fn test_handle(task_id: &str, proxy_port: Option<u16>) -> BrokerHandle {
    let deps = Deps {
        connector: Arc::new(|_, _| Err(std::io::Error::other("offline"))),
        peer_ok: Arc::new(|_, _| true),
        read_secret: Arc::new(|_| Err(SecretStatus::Missing)),
        live: Arc::new(|_, _| None),
        profile: None,
    };
    let s = SecretDef { id: "gh".into(), name: "gh".into(), service: "gh:github.com".into(), account: "alice".into(),
        hosts: crate::secrets::Recipe::Github.default_hosts(), ..Default::default() };
    let role = Role { id: "r".into(), name: "r".into(), secrets: vec!["gh".into()], ..Default::default() };
    start_with(StartArgs {
        task_id, role: &role, secrets: &[s], task_allows: &[], host_patterns: vec![], allow_all_hosts: false,
        proxy_port, dir: new_spawn_dir().unwrap(),
    }, deps).unwrap()
}

#[cfg(all(test, unix))]
mod tests;
