//! End-to-end broker tests against a local fake upstream (a rustls server
//! with its own test CA). Nothing here touches the network.

use super::*;
use crate::secrets::{ApiKeyCfg, Effect, Recipe, Rule, RuleSet};
use std::io::{BufRead, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;

const REAL: &str = "gho_REALTOKEN";

/// A TLS server answering every request with `status`, reporting each
/// request it got (head + body) on `rx`.
struct Upstream {
    rx: mpsc::Receiver<String>,
    dials: Arc<AtomicUsize>,
    connector: Connector,
}

fn upstream(status: &'static str) -> Upstream {
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let mut ca_p = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_p.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    let ca_cert = ca_p.self_signed(&ca_key).unwrap();
    let issuer = rcgen::Issuer::new(ca_p, ca_key);
    let key = rcgen::KeyPair::generate().unwrap();
    let leaf = rcgen::CertificateParams::new(vec!["api.github.com".into(), "github.com".into(), "ghcr.io".into(), "api.openai.com".into()])
        .unwrap().signed_by(&key, &issuer).unwrap();
    let server = Arc::new(rustls::ServerConfig::builder_with_provider(mitm::provider())
        .with_safe_default_protocol_versions().unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![leaf.der().clone()], rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into()))
        .unwrap());
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca_cert.der().clone()).unwrap();
    let client = Arc::new(rustls::ClientConfig::builder_with_provider(mitm::provider())
        .with_safe_default_protocol_versions().unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth());

    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let Ok(s) = s else { continue };
            let (server, tx) = (server.clone(), tx.clone());
            std::thread::spawn(move || {
                let conn = rustls::ServerConnection::new(server).unwrap();
                let mut tls = BufReader::new(rustls::StreamOwned::new(conn, s));
                let mut req = String::new();
                loop {
                    let mut line = String::new();
                    if tls.read_line(&mut line).unwrap_or(0) == 0 { return; }
                    req.push_str(&line);
                    if line == "\r\n" { break; }
                }
                let cl = req.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()));
                if let Some(n) = cl {
                    let mut b = vec![0; n];
                    tls.read_exact(&mut b).unwrap();
                    req.push_str(&String::from_utf8_lossy(&b));
                }
                let _ = tx.send(req);
                let tls = tls.get_mut();
                let _ = tls.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").as_bytes());
                tls.conn.send_close_notify();
                let _ = tls.flush();
            });
        }
    });
    let dials = Arc::new(AtomicUsize::new(0));
    let d = dials.clone();
    let connector: Connector = Arc::new(move |host, _port| {
        d.fetch_add(1, Ordering::SeqCst);
        let tcp = TcpStream::connect(("127.0.0.1", port))?;
        let name = rustls::pki_types::ServerName::try_from(host.to_string()).unwrap();
        let conn = rustls::ClientConnection::new(client.clone(), name).map_err(std::io::Error::other)?;
        Ok(Box::new(rustls::StreamOwned::new(conn, tcp)) as Box<dyn mitm::Duplex>)
    });
    Upstream { rx, dials, connector }
}

fn secret() -> SecretDef {
    SecretDef {
        id: "gh".into(), name: "github-alice".into(), service: "gh:github.com".into(), account: "alice".into(),
        recipe: Recipe::Github, hosts: vec!["api.github.com".into(), "github.com".into()], ..Default::default()
    }
}

fn role(rule_sets: Vec<RuleSet>) -> Role {
    Role { id: "rev".into(), name: "Reviewer".into(), secrets: vec!["gh".into()], rule_sets, ..Default::default() }
}

fn reviewer() -> Role {
    let r = |effect, m: &[&str], p: &str| Rule { effect, methods: m.iter().map(|s| s.to_string()).collect(), pattern: p.into(), note: String::new(), disabled: false };
    role(vec![
        RuleSet { secret: "gh".into(), host: "api.github.com".into(), fallback: Effect::Deny, rules: vec![
            r(Effect::Allow, &["GET"], "/**"), r(Effect::Allow, &["QUERY"], ""), r(Effect::Deny, &["MUTATION"], "merge*"),
        ] },
        RuleSet { secret: "gh".into(), host: "github.com".into(), fallback: Effect::Allow, rules: vec![
            r(Effect::Deny, &["push"], "acme/*"),
        ] },
    ])
}

fn deps(up: &Upstream, peer_ok: bool) -> Deps {
    Deps {
        connector: up.connector.clone(),
        peer_ok: Arc::new(move |_, _| peer_ok),
        read_secret: Arc::new(|_| Ok(Arc::new(Secret::new(REAL.into())))),
        live: Arc::new(|_, _| None),
    }
}

fn start_for(task: &str, role: &Role, up: &Upstream, peer_ok: bool, proxy_port: Option<u16>, allow_all: bool) -> BrokerHandle {
    start_with(StartArgs {
        task_id: task, role, secrets: &[secret()], task_allows: &[],
        host_patterns: vec![], allow_all_hosts: allow_all, proxy_port,
        dir: new_spawn_dir().unwrap(),
    }, deps(up, peer_ok)).unwrap()
}

fn gh_token(h: &BrokerHandle) -> String {
    h.env.iter().find(|(k, _)| k == "GH_TOKEN").unwrap().1.clone()
}

/// Send `req` over the gh socket, return the whole response.
fn over_socket(h: &BrokerHandle, req: &str) -> String {
    let mut s = UnixStream::connect(h.socket_path.as_ref().unwrap()).unwrap();
    s.write_all(req.as_bytes()).unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    out
}

#[test]
fn socket_swaps_own_placeholder_only_in_authorization() {
    let up = upstream("200 OK");
    let h = start_for("t-swap", &role(vec![]), &up, true, None, false);
    let ph = gh_token(&h);
    assert!(ph.starts_with("termic_ph_") && ph.len() == "termic_ph_".len() + 32);
    let resp = over_socket(&h, &format!("GET /user HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token {ph}\r\nX-Echo: {ph}\r\nConnection: keep-alive\r\n\r\n"));
    assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
    let got = up.rx.recv().unwrap();
    assert!(got.contains(&format!("Authorization: token {REAL}\r\n")), "{got}");
    assert!(got.contains(&format!("X-Echo: {ph}\r\n")), "other headers keep the placeholder");
    assert!(got.contains("Connection: close\r\n") && !got.contains("keep-alive"));
    assert_eq!(counts("t-swap").used, 1);
    let ev = events("t-swap");
    assert_eq!(ev.used[0].methods, vec![("GET".to_string(), 1)]);
    // no event carries the real value
    assert!(!format!("{:?}", ev).contains(REAL));
}

#[test]
fn another_spawns_placeholder_is_not_swapped() {
    let up = upstream("401 Unauthorized");
    let h = start_for("t-other", &role(vec![]), &up, true, None, false);
    let other = placeholder();
    over_socket(&h, &format!("GET /user HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: Bearer {other}\r\n\r\n"));
    let got = up.rx.recv().unwrap();
    assert!(got.contains(&format!("Authorization: Bearer {other}")) && !got.contains(REAL));
    assert_eq!(counts("t-other").used, 0);
}

#[test]
fn placeholder_to_an_unbound_host_is_refused_and_flagged() {
    let up = upstream("200 OK");
    let h = start_for("t-unbound", &role(vec![]), &up, true, None, true);
    let ph = gh_token(&h);
    let resp = over_socket(&h, &format!("GET /x HTTP/1.1\r\nHost: ghcr.io\r\nAuthorization: Bearer {ph}\r\n\r\n"));
    assert!(resp.starts_with("HTTP/1.1 403") && resp.contains("placeholder-unbound-host"), "{resp}");
    // hidden in Basic, in another header, or in the URL: same
    use base64::Engine;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x:{ph}"));
    for req in [
        format!("GET /x HTTP/1.1\r\nHost: ghcr.io\r\nAuthorization: Basic {basic}\r\n\r\n"),
        format!("GET /x HTTP/1.1\r\nHost: ghcr.io\r\nX-Token: {ph}\r\n\r\n"),
        format!("GET /x?t={ph} HTTP/1.1\r\nHost: ghcr.io\r\n\r\n"),
    ] {
        assert!(over_socket(&h, &req).starts_with("HTTP/1.1 403"));
    }
    assert_eq!(up.dials.load(Ordering::SeqCst), 0, "never dialed");
    let ev = events("t-unbound");
    assert_eq!(ev.suspicious[0].kind, "placeholder_unbound_host");
    assert_eq!(counts("t-unbound").suspicious, 4);
}

#[test]
fn unbound_host_401_is_no_secret_and_off_list_is_refused() {
    let up = upstream("401 Unauthorized");
    let h = start_for("t-nosecret", &role(vec![]), &up, true, None, true);
    let resp = over_socket(&h, "GET /v2/ HTTP/1.1\r\nHost: ghcr.io\r\n\r\n");
    assert!(resp.starts_with("HTTP/1.1 401"), "{resp}");
    assert_eq!(events("t-nosecret").no_secret[0].host, "ghcr.io");

    let up2 = upstream("200 OK");
    let h2 = start_for("t-offlist", &role(vec![]), &up2, true, None, false);
    let resp = over_socket(&h2, "GET / HTTP/1.1\r\nHost: ghcr.io\r\n\r\n");
    assert!(resp.contains("blocked-by-allowlist"), "{resp}");
    assert_eq!(up2.dials.load(Ordering::SeqCst), 0);
}

#[test]
fn role_rules_block_with_the_role_name() {
    let up = upstream("200 OK");
    let h = start_for("t-rules", &reviewer(), &up, true, None, false);
    let ph = gh_token(&h);
    let resp = over_socket(&h, &format!("PUT /repos/acme/widget/pulls/412/merge HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token {ph}\r\nContent-Length: 0\r\n\r\n"));
    assert!(resp.contains("X-Termic-Secrets: blocked-by-role"), "{resp}");
    assert!(resp.contains("blocked by Termic role \"Reviewer\" (PUT /repos/acme/widget/pulls/412/merge)"), "{resp}");

    let body = r#"{"query":"mutation { mergePullRequest(input: {}) { clientMutationId } }"}"#;
    let resp = over_socket(&h, &format!("POST /graphql HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: bearer {ph}\r\nContent-Length: {}\r\n\r\n{body}", body.len()));
    assert!(resp.contains("(MUTATION mergePullRequest)"), "{resp}");
    assert_eq!(up.dials.load(Ordering::SeqCst), 0);

    // a query goes through, body intact
    let body = r#"{"query":"query { viewer { login } }"}"#;
    let resp = over_socket(&h, &format!("POST /graphql HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: bearer {ph}\r\nContent-Length: {}\r\n\r\n{body}", body.len()));
    assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
    assert!(up.rx.recv().unwrap().ends_with(body));

    let ev = events("t-rules");
    assert_eq!(ev.blocked.len(), 2);
    assert!(ev.blocked.iter().any(|b| b.method == "PUT" && b.path == "/repos/acme/widget/pulls/412/merge" && b.rule == "fallback DENY"));
    assert!(ev.blocked.iter().any(|b| b.method == "MUTATION" && b.path == "mergePullRequest"));
}

#[test]
fn oversized_graphql_is_refused() {
    let up = upstream("200 OK");
    let h = start_for("t-big", &reviewer(), &up, true, None, false);
    let ph = gh_token(&h);
    let resp = over_socket(&h, &format!("POST /graphql HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token {ph}\r\nContent-Length: {}\r\n\r\n", rules::MAX_GRAPHQL_BODY + 1));
    assert!(resp.starts_with("HTTP/1.1 413"), "{resp}");
}

#[test]
fn odd_paths_are_refused_before_rules() {
    let up = upstream("200 OK");
    let h = start_for("t-paths", &reviewer(), &up, true, None, false);
    let ph = gh_token(&h);
    let resp = over_socket(&h, &format!("PUT /repos/acme/widget/pulls/1/merge/%2e%2e HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token {ph}\r\n\r\n"));
    assert!(resp.starts_with("HTTP/1.1 400"), "{resp}");
    assert_eq!(up.dials.load(Ordering::SeqCst), 0);
    assert_eq!(counts("t-paths"), BrokerCounts { live: 1, roles: vec!["rev".into()], ..Default::default() }, "nothing recorded");
}

#[test]
fn pause_wrong_peer_and_keychain_errors_refuse() {
    let up = upstream("200 OK");
    let h = start_for("t-pause", &role(vec![]), &up, true, None, false);
    let ph = gh_token(&h);
    let req = format!("GET /user HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token {ph}\r\n\r\n");
    set_paused("t-pause", true);
    assert!(over_socket(&h, &req).contains("X-Termic-Secrets: paused"));
    assert!(counts("t-pause").paused);
    set_paused("t-pause", false);
    assert!(over_socket(&h, &req).starts_with("HTTP/1.1 200"));

    let h2 = start_for("t-peer", &role(vec![]), &up, false, None, false);
    assert!(over_socket(&h2, &req).contains("wrong-peer"));
    assert_eq!(events("t-peer").suspicious[0].kind, "wrong_peer");

    let mut d = deps(&up, true);
    d.read_secret = Arc::new(|_| Err(SecretStatus::Locked));
    let h3 = start_with(StartArgs {
        task_id: "t-locked", role: &role(vec![]), secrets: &[secret()], task_allows: &[],
        host_patterns: vec![], allow_all_hosts: false, proxy_port: None, dir: new_spawn_dir().unwrap(),
    }, d).unwrap();
    let resp = over_socket(&h3, &format!("GET /user HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token {}\r\n\r\n", gh_token(&h3)));
    assert!(resp.starts_with("HTTP/1.1 503") && resp.contains("locked"), "{resp}");
}

#[test]
fn drop_unlinks_the_socket_and_dir() {
    let up = upstream("200 OK");
    let h = start_for("t-drop", &role(vec![]), &up, true, None, false);
    let sock = h.socket_path.clone().unwrap();
    let dir = sock.parent().unwrap().to_path_buf();
    assert!(sock.as_os_str().len() < 104, "macOS socket path cap");
    assert!(std::fs::read_to_string(dir.join("gh/config.yml")).unwrap().contains(&format!("http_unix_socket: {}", sock.display())));
    assert!(is_brokered("t-drop"));
    drop(h);
    assert!(!sock.exists() && !dir.exists());
    assert!(!is_brokered("t-drop"));
}

#[test]
fn env_rendering() {
    let up = upstream("200 OK");
    let h = start_for("t-env", &role(vec![]), &up, true, Some(4242), false);
    let get = |k: &str| h.env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let ph = get("GH_TOKEN").unwrap();
    assert_eq!(get("GH_NO_UPDATE_NOTIFIER").as_deref(), Some("1"));
    assert!(get("GH_CONFIG_DIR").unwrap().ends_with("/gh"));
    assert_eq!(h.strip_env, vec!["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);
    // the cage writes only gh's config dir; the spawn dir (socket, CA) is read-only.
    assert_eq!(h.rw_paths.len(), 1);
    assert!(h.rw_paths[0].ends_with("/gh"));
    assert!(h.rw_paths[0].starts_with(&h.ro_paths[0]));
    // git config, env only, appended after whatever the user had
    let base: usize = std::env::var("GIT_CONFIG_COUNT").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    assert_eq!(get("GIT_CONFIG_COUNT"), Some((base + 6).to_string()));
    assert_eq!(get(&format!("GIT_CONFIG_KEY_{base}")).as_deref(), Some("credential.helper"));
    assert_eq!(get(&format!("GIT_CONFIG_VALUE_{base}")).as_deref(), Some(""));
    assert!(get(&format!("GIT_CONFIG_VALUE_{}", base + 1)).unwrap().contains(&ph));
    assert!(get(&format!("GIT_CONFIG_VALUE_{}", base + 3)).unwrap().starts_with("http://termic:"));
    assert!(get(&format!("GIT_CONFIG_VALUE_{}", base + 3)).unwrap().ends_with("@127.0.0.1:4242"));

    let env = render_env(None, Some(GitEnv { host: "github.com", placeholder: "termic_ph_x", ca_pem: Path::new("/d/ca.pem"), proxy_url: "http://p" }), 2);
    assert_eq!(env.last().unwrap(), &("GIT_CONFIG_COUNT".to_string(), "8".to_string()));
    assert_eq!(env[0], ("GIT_CONFIG_KEY_2".to_string(), "credential.helper".to_string()));
    assert!(env.iter().any(|(k, v)| k == "GIT_CONFIG_KEY_4" && v == "http.https://github.com/.sslCAInfo"));
    // url-scoped, so only the brokered host leaves the user's TLS backend.
    assert!(env.iter().any(|(k, v)| k == "GIT_CONFIG_KEY_7" && v == "http.https://github.com/.sslBackend"));
    assert!(env.iter().any(|(k, v)| k == "GIT_CONFIG_VALUE_7" && v == "openssl"));
    // no proxy, no git delivery
    let h2 = start_for("t-env2", &role(vec![]), &up, true, None, false);
    assert!(!h2.env.iter().any(|(k, _)| k.starts_with("GIT_CONFIG")));
    assert!(!h2.env.iter().any(|(k, _)| k == "HTTPS_PROXY"));
}

#[test]
fn auth_forms() {
    use base64::Engine;
    const TOKEN: Inject = Inject::Scheme(&["token", "bearer"]);
    const BASIC: Inject = Inject::BasicPassword;
    let noapi = ApiKeyCfg::default();
    let ph = "termic_ph_0123";
    assert_eq!(auth_form(Some("token termic_ph_0123"), ph, TOKEN, &noapi), Some(AuthForm::Scheme("token".into())));
    assert_eq!(auth_form(Some("Bearer termic_ph_0123"), ph, TOKEN, &noapi), Some(AuthForm::Scheme("Bearer".into())));
    let b = base64::engine::general_purpose::STANDARD.encode("x-access-token:termic_ph_0123");
    let form = auth_form(Some(&format!("Basic {b}")), ph, BASIC, &noapi).unwrap();
    assert_eq!(form, AuthForm::Basic("x-access-token".into()));
    let re = render_auth(&form, &Secret::new("REAL".into()));
    assert_eq!(decode_basic(&re).as_deref(), Some("x-access-token:REAL"), "Basic is re-encoded");
    // each delivery has one spot: gh's socket never swaps Basic, git never a scheme
    assert_eq!(auth_form(Some(&format!("Basic {b}")), ph, TOKEN, &noapi), None);
    assert_eq!(auth_form(Some("token termic_ph_0123"), ph, BASIC, &noapi), None);
    // the placeholder as the username is not the fixed spot
    let u = base64::engine::general_purpose::STANDARD.encode("termic_ph_0123:x");
    assert_eq!(auth_form(Some(&format!("Basic {u}")), ph, BASIC, &noapi), None);
    assert_eq!(auth_form(Some("token termic_ph_9999"), ph, TOKEN, &noapi), None);
    assert_eq!(auth_form(Some("Digest termic_ph_0123"), ph, TOKEN, &noapi), None);
}

#[test]
fn host_header_shapes() {
    assert_eq!(host_port(Some("API.github.com")), Some(("api.github.com".into(), 443)));
    assert_eq!(host_port(Some("github.com:8443")), Some(("github.com".into(), 8443)));
    assert_eq!(host_port(Some("evil.example/x")), None);
    assert_eq!(host_port(Some("a b")), None);
    assert_eq!(host_port(Some("")), None);
}

/// git through the task's proxy: CONNECT with this spawn's credentials is
/// MITM'd and the Basic password swapped; without them it is the ordinary
/// allow-list path.
#[test]
fn proxy_mitm_swaps_git_basic_password() {
    use base64::Engine;
    let up = upstream("200 OK");
    let proxy = crate::proxy::start(vec![], "t-mitm".into(), false).unwrap();
    let h = start_for("t-mitm", &reviewer(), &up, true, Some(proxy.port), false);
    proxy.attach_broker(h.mitm_ctx());
    let ph = gh_token(&h);
    let proxy_url = h.env.iter().find(|(_, v)| v.starts_with("http://termic:")).unwrap().1.clone();
    let creds = proxy_url.trim_start_matches("http://").split('@').next().unwrap().to_string();
    let proxy_auth = base64::engine::general_purpose::STANDARD.encode(creds);

    let ca = h.mitm_ctx().ca.as_ref().unwrap().der.clone();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca).unwrap();
    let cfg = Arc::new(rustls::ClientConfig::builder_with_provider(mitm::provider())
        .with_safe_default_protocol_versions().unwrap().with_root_certificates(roots).with_no_client_auth());

    let git = |path: &str| -> String {
        let mut tcp = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
        tcp.write_all(format!("CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nProxy-Authorization: Basic {proxy_auth}\r\n\r\n").as_bytes()).unwrap();
        let mut head = [0u8; 39];
        tcp.read_exact(&mut head).unwrap();
        assert_eq!(&head[..], b"HTTP/1.1 200 Connection Established\r\n\r\n");
        let conn = rustls::ClientConnection::new(cfg.clone(), "github.com".try_into().unwrap()).unwrap();
        let mut tls = rustls::StreamOwned::new(conn, tcp);
        let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{ph}"));
        tls.write_all(format!("GET {path} HTTP/1.1\r\nHost: github.com\r\nAuthorization: Basic {basic}\r\n\r\n").as_bytes()).unwrap();
        let mut out = Vec::new();
        let _ = tls.read_to_end(&mut out);
        String::from_utf8_lossy(&out).into_owned()
    };
    let resp = git("/cli/cli.git/info/refs?service=git-upload-pack");
    assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
    let got = up.rx.recv().unwrap();
    let real = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{REAL}"));
    assert!(got.contains(&format!("Authorization: Basic {real}")), "{got}");
    assert_eq!(events("t-mitm").used[0].methods, vec![("fetch".to_string(), 1)]);

    // the role denies pushes to acme/*
    let resp = git("/acme/widget.git/info/refs?service=git-receive-pack");
    assert!(resp.contains("blocked by Termic role \"Reviewer\" (push acme/widget)"), "{resp}");

    // no proxy credentials: not MITM'd, so the (empty) allow-list refuses it
    let mut tcp = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
    tcp.write_all(b"CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n").unwrap();
    let mut out = String::new();
    let _ = tcp.read_to_string(&mut out);
    assert!(out.starts_with("HTTP/1.1 403 Blocked by Termic sandbox"), "{out}");

    // a placeholder over plain HTTP through the proxy is refused
    let mut tcp = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
    tcp.write_all(format!("GET http://paste.example.net/ HTTP/1.1\r\nHost: paste.example.net\r\nAuthorization: Bearer {ph}\r\n\r\n").as_bytes()).unwrap();
    let mut out = String::new();
    let _ = tcp.read_to_string(&mut out);
    assert!(out.contains("placeholder-unbound-host"), "{out}");
}

#[test]
fn verb_tricks_cannot_slip_past_the_role() {
    let up = upstream("200 OK");
    let h = start_for("t-verbs", &reviewer(), &up, true, None, false);
    let ph = gh_token(&h);
    let send = |req: String| over_socket(&h, &req);
    // a GET to /graphql is judged as an unknown operation, not a plain GET.
    let r = send(format!("GET /graphql?query=mutation%7BmergePullRequest%7D HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token {ph}\r\n\r\n"));
    assert!(r.contains("blocked-by-role"), "{r}");
    // method overrides are refused before any rule.
    let r = send(format!("POST /repos/acme/widget/pulls/1/reviews HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token {ph}\r\nX-HTTP-Method-Override: PUT\r\nContent-Length: 0\r\n\r\n"));
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    let r = send(format!("POST /repos/acme/widget/pulls/1/reviews?_method=PUT HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token {ph}\r\nContent-Length: 0\r\n\r\n"));
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    assert_eq!(up.dials.load(Ordering::SeqCst), 0, "nothing reached upstream");
}

// ─── API key secrets ─────────────────────────────────────────────────

fn api_secret(header: &str, scheme: &str) -> SecretDef {
    SecretDef {
        id: "oa".into(), name: "openai".into(), service: crate::secrets::owned_service("oa"),
        account: crate::secrets::OWNED_ACCOUNT.into(), recipe: Recipe::ApiKey, hosts: vec!["api.openai.com".into()],
        api: ApiKeyCfg {
            header: header.into(), scheme: scheme.into(), env: "OPENAI_API_KEY".into(),
            base_url_env: "OPENAI_BASE_URL".into(), base_url: "https://api.openai.com/v1".into(),
        },
        ..Default::default()
    }
}

fn start_api(task: &str, secrets: &[SecretDef], up: &Upstream, proxy_port: Option<u16>) -> BrokerHandle {
    let role = Role { id: "dev".into(), name: "Dev".into(), secrets: secrets.iter().map(|s| s.id.clone()).collect(), ..Default::default() };
    start_with(StartArgs {
        task_id: task, role: &role, secrets, task_allows: &[], host_patterns: vec![], allow_all_hosts: false,
        proxy_port, dir: new_spawn_dir().unwrap(),
    }, deps(up, true)).unwrap()
}

fn env_of(h: &BrokerHandle, k: &str) -> Option<String> {
    h.env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone())
}

/// POST over the base-URL endpoint at `path` (relative to the base URL's
/// endpoint root, i.e. starting with the marker).
fn over_base_url(h: &BrokerHandle, target: &str, headers: &str) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", h.base_url_port.unwrap())).unwrap();
    s.write_all(format!("POST {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n{headers}Content-Length: 2\r\n\r\n{{}}").as_bytes()).unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    out
}

#[test]
fn base_url_swaps_the_configured_header_and_routes_by_path() {
    let up = upstream("200 OK");
    let h = start_api("t-base", &[api_secret("authorization", "Bearer")], &up, None);
    let ph = env_of(&h, "OPENAI_API_KEY").unwrap();
    let base = env_of(&h, "OPENAI_BASE_URL").unwrap();
    let port = h.base_url_port.unwrap();
    let prefix = format!("http://127.0.0.1:{port}/");
    assert!(base.starts_with(&prefix) && base.ends_with("/api.openai.com/v1"), "{base}");
    // the OpenAI SDK appends the endpoint to the base URL's path.
    let target = format!("{}/chat/completions", &base[prefix.len() - 1..]);
    let resp = over_base_url(&h, &target, &format!("Authorization: Bearer {ph}\r\nX-Echo: {ph}\r\n"));
    assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
    let got = up.rx.recv().unwrap();
    assert!(got.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"), "{got}");
    assert!(got.contains("Host: api.openai.com\r\n"), "{got}");
    assert!(got.contains(&format!("Authorization: Bearer {REAL}\r\n")), "{got}");
    assert!(got.contains(&format!("X-Echo: {ph}\r\n")), "only the one spot is swapped");
    assert_eq!(events("t-base").used[0].methods, vec![("POST".to_string(), 1)]);
    // no profile allowance without a port
    assert!(h.socket_path.is_none(), "an API key alone needs no gh socket");
    assert!(h.strip_env.contains(&"OPENAI_API_KEY".to_string()) && h.strip_env.contains(&"OPENAI_BASE_URL".to_string()));
}

#[test]
fn base_url_refuses_a_wrong_marker_and_unbound_hosts() {
    let up = upstream("200 OK");
    let h = start_api("t-base-bad", &[api_secret("authorization", "Bearer")], &up, None);
    let ph = env_of(&h, "OPENAI_API_KEY").unwrap();
    let auth = format!("Authorization: Bearer {ph}\r\n");
    let resp = over_base_url(&h, "/0123456789abcdef0123456789abcdef/api.openai.com/v1/x", &auth);
    assert!(resp.contains("403") && resp.contains("wrong-peer"), "{resp}");
    assert_eq!(events("t-base-bad").suspicious[0].kind, "wrong_peer");
    let base = env_of(&h, "OPENAI_BASE_URL").unwrap();
    let marker = base.split('/').nth(3).unwrap();
    // the endpoint is not a general forwarder: only bound hosts
    let resp = over_base_url(&h, &format!("/{marker}/paste.example.net/x"), &auth);
    assert!(resp.contains("403") && resp.contains("not-bound"), "{resp}");
    let resp = over_base_url(&h, &format!("/{marker}"), &auth);
    assert!(resp.contains("not-bound"), "{resp}");
    assert_eq!(up.dials.load(Ordering::SeqCst), 0, "nothing went upstream");
}

#[test]
fn api_key_header_without_a_scheme() {
    let up = upstream("200 OK");
    let h = start_api("t-xkey", &[api_secret("x-api-key", "")], &up, None);
    let ph = env_of(&h, "OPENAI_API_KEY").unwrap();
    let base = env_of(&h, "OPENAI_BASE_URL").unwrap();
    let marker = base.split('/').nth(3).unwrap();
    // the placeholder in Authorization is not this secret's spot
    over_base_url(&h, &format!("/{marker}/api.openai.com/v1/m"), &format!("Authorization: Bearer {ph}\r\n"));
    let got = up.rx.recv().unwrap();
    assert!(!got.contains(REAL), "{got}");
    over_base_url(&h, &format!("/{marker}/api.openai.com/v1/m"), &format!("x-api-key: {ph}\r\n"));
    let got = up.rx.recv().unwrap();
    assert!(got.contains(&format!("x-api-key: {REAL}\r\n")), "{got}");
    // two copies of the spot header: ambiguous, nothing is swapped
    over_base_url(&h, &format!("/{marker}/api.openai.com/v1/m"), &format!("x-api-key: {ph}\r\nX-API-Key: {ph}\r\n"));
    let got = up.rx.recv().unwrap();
    assert!(!got.contains(REAL), "{got}");
}

#[test]
fn env_proxy_mitms_only_its_own_credentials_and_hosts() {
    use base64::Engine;
    let up = upstream("200 OK");
    let proxy = crate::proxy::start(vec![], "t-envp".into(), false).unwrap();
    let mut gh = secret();
    gh.id = "gh".into();
    let h = start_api("t-envp", &[gh, api_secret("authorization", "Bearer")], &up, Some(proxy.port));
    proxy.attach_broker(h.mitm_ctx());
    let ph = env_of(&h, "OPENAI_API_KEY").unwrap();
    let https_proxy = env_of(&h, "HTTPS_PROXY").unwrap();
    assert_eq!(env_of(&h, "https_proxy").as_deref(), Some(https_proxy.as_str()));
    let bundle = env_of(&h, "SSL_CERT_FILE").unwrap();
    assert_eq!(env_of(&h, "REQUESTS_CA_BUNDLE").as_deref(), Some(bundle.as_str()));
    let pem = std::fs::read_to_string(&bundle).unwrap();
    let ca_pem = std::fs::read_to_string(env_of(&h, "NODE_EXTRA_CA_CERTS").unwrap()).unwrap();
    assert!(pem.ends_with(&ca_pem), "the bundle ends with this spawn's CA");
    let creds = |url: &str| base64::engine::general_purpose::STANDARD.encode(url.trim_start_matches("http://").split('@').next().unwrap());
    let env_auth = creds(&https_proxy);
    let git_url = h.env.iter().find(|(k, v)| k.starts_with("GIT_CONFIG_VALUE_") && v.starts_with("http://termic:")).unwrap().1.clone();
    let git_auth = creds(&git_url);
    assert_ne!(env_auth, git_auth, "git and HTTPS_PROXY carry different credentials");

    let ca = h.mitm_ctx().ca.as_ref().unwrap().der.clone();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca).unwrap();
    let cfg = Arc::new(rustls::ClientConfig::builder_with_provider(mitm::provider())
        .with_safe_default_protocol_versions().unwrap().with_root_certificates(roots).with_no_client_auth());
    // CONNECT; Some(response) when MITM'd, None when it was not.
    let connect = |host: &str, auth: &str| -> Option<String> {
        let mut tcp = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
        tcp.write_all(format!("CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\nProxy-Authorization: Basic {auth}\r\n\r\n").as_bytes()).unwrap();
        let mut head = [0u8; 12];
        tcp.read_exact(&mut head).unwrap();
        if &head[..] != b"HTTP/1.1 200" { return None; }
        let mut rest = [0u8; 27];
        tcp.read_exact(&mut rest).unwrap();
        let conn = rustls::ClientConnection::new(cfg.clone(), host.to_string().try_into().unwrap()).unwrap();
        let mut tls = rustls::StreamOwned::new(conn, tcp);
        tls.write_all(format!("GET /v1/models HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {ph}\r\n\r\n").as_bytes()).ok()?;
        let mut out = Vec::new();
        let _ = tls.read_to_end(&mut out);
        Some(String::from_utf8_lossy(&out).into_owned())
    };
    let resp = connect("api.openai.com", &env_auth).expect("env proxy MITMs its bound host");
    assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
    let got = up.rx.recv().unwrap();
    assert!(got.contains(&format!("Authorization: Bearer {REAL}\r\n")), "{got}");
    // git's credentials do not MITM the API key's host, and HTTPS_PROXY's do
    // not MITM github.com: each is refused like any off-list CONNECT.
    assert!(connect("api.openai.com", &git_auth).is_none());
    assert!(connect("github.com", &env_auth).is_none());
}

#[test]
fn api_key_without_a_proxy_or_base_url_still_gets_its_placeholder() {
    let up = upstream("200 OK");
    let mut s = api_secret("authorization", "Bearer");
    s.api.base_url_env.clear();
    s.api.base_url.clear();
    let h = start_api("t-bare", &[s], &up, None);
    assert!(env_of(&h, "OPENAI_API_KEY").unwrap().starts_with("termic_ph_"));
    assert!(h.base_url_port.is_none() && env_of(&h, "OPENAI_BASE_URL").is_none());
    assert!(env_of(&h, "HTTPS_PROXY").is_none(), "no proxy, no env proxy");
}

// ─── owned items ─────────────────────────────────────────────────────

#[test]
fn owned_github_secret_delivers_like_a_gh_login() {
    // a pasted token: account `termic`, not a GitHub username. Delivery only
    // looks at the recipe, so gh still gets its placeholder over the socket.
    let up = upstream("200 OK");
    let mut s = secret();
    s.service = crate::secrets::owned_service("gh");
    s.account = crate::secrets::OWNED_ACCOUNT.into();
    s.kind = crate::secrets::KeychainKind::Protected;
    assert!(s.is_owned() && crate::secrets::validate(std::slice::from_ref(&s), &[]).is_empty());
    let h = start_with(StartArgs {
        task_id: "t-owned-gh", role: &role(vec![]), secrets: &[s], task_allows: &[],
        host_patterns: vec![], allow_all_hosts: false, proxy_port: None,
        dir: new_spawn_dir().unwrap(),
    }, deps(&up, true)).unwrap();
    let ph = gh_token(&h);
    let resp = over_socket(&h, &format!("GET /user HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token {ph}\r\n\r\n"));
    assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
    assert!(up.rx.recv().unwrap().contains(&format!("Authorization: token {REAL}\r\n")));
}

#[test]
fn forget_unsaved_spares_a_saved_secret() {
    // the id is in settings: no Keychain call at all.
    assert!(!forget_unsaved(&[secret()], "gh"));
}

#[test]
fn a_secret_taken_off_the_live_role_is_revoked() {
    let up = upstream("200 OK");
    // the live role no longer lists the secret, and its rule sets went with it.
    let mut d = deps(&up, true);
    d.live = Arc::new(|_, _| Some((Role { id: "rev".into(), name: "Reviewer".into(), ..Default::default() }, vec![])));
    let h = start_with(StartArgs {
        task_id: "t-revoked", role: &reviewer(), secrets: &[secret()], task_allows: &[],
        host_patterns: vec![], allow_all_hosts: false, proxy_port: None, dir: new_spawn_dir().unwrap(),
    }, d).unwrap();
    let resp = over_socket(&h, &format!("GET /user HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token {}\r\n\r\n", gh_token(&h)));
    assert!(resp.contains("X-Termic-Secrets: secret-revoked"), "{resp}");
    assert_eq!(up.dials.load(Ordering::SeqCst), 0);
}

#[test]
fn echoing_and_pseudo_verb_methods_are_refused() {
    let up = upstream("200 OK");
    let h = start_for("t-trace", &reviewer(), &up, true, None, false);
    let ph = gh_token(&h);
    for m in ["TRACE", "TRACK", "QUERY", "push", "MUTATION"] {
        let resp = over_socket(&h, &format!("{m} /repos/acme/prod/pulls/1/merge HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token {ph}\r\n\r\n"));
        assert!(resp.starts_with("HTTP/1.1 405"), "{m}: {resp}");
    }
    assert_eq!(up.dials.load(Ordering::SeqCst), 0);
}

#[test]
fn blocked_rows_name_the_role_and_an_allow_clears_them() {
    let up = upstream("200 OK");
    let h = start_for("t-allowed", &reviewer(), &up, true, None, false);
    let resp = over_socket(&h, &format!("PUT /repos/acme/widget/pulls/9/merge HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token {}\r\nContent-Length: 0\r\n\r\n", gh_token(&h)));
    assert!(resp.contains("blocked-by-role"), "{resp}");
    let ev = events("t-allowed");
    assert_eq!(ev.blocked[0].role, "rev");
    assert_eq!(counts("t-allowed").roles, vec!["rev".to_string()]);
    clear_blocked("t-allowed", "gh", "api.github.com", "put", "/repos/acme/widget/pulls/9/merge");
    assert!(events("t-allowed").blocked.is_empty());
    // a new spawn of the same task keeps the running one's events.
    clear_events("t-allowed");
    assert_eq!(counts("t-allowed").live, 1);
}

#[test]
fn event_rows_are_capped() {
    for i in 0..(MAX_ROWS + 50) {
        record_blocked("t-cap", "rev", "gh", "api.github.com", "PUT", &format!("/repos/a/b/pulls/{i}/merge"), "fallback DENY");
    }
    record_blocked("t-cap", "rev", "gh", "api.github.com", "PUT", &"/x".repeat(10_000), "fallback DENY");
    let ev = events("t-cap");
    assert_eq!(ev.blocked.len(), MAX_ROWS);
    assert!(ev.blocked.iter().all(|b| b.path.len() <= MAX_FIELD + "…".len()));
}

#[test]
fn drop_does_not_hang_when_the_socket_was_unlinked() {
    let up = upstream("200 OK");
    let h = start_for("t-unlinked", &role(vec![]), &up, true, None, false);
    std::fs::remove_file(h.socket_path.as_ref().unwrap()).unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || { drop(h); let _ = tx.send(()); });
    rx.recv_timeout(std::time::Duration::from_secs(5)).expect("BrokerHandle drop hung after the socket was unlinked");
}
