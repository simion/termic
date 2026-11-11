//! MCP endpoint, Phase A (docs/ideas/mcp.md): a loopback HTTP listener
//! serving the stateless MCP revision (2026-07-28) to OUTSIDE clients
//! (Claude Desktop, `claude mcp add`). One full-scope credential, the
//! per-bind `mcp-token` file; no scoped/per-task tokens yet (Phase B).
//!
//! Dispatch is the CLI server's: tool calls build a `proto::Command`
//! and go through `cli_server::dispatch_authenticated`, so MCP is a
//! presentation of the same verbs, never a second implementation.
//!
//! Threat model (mcp.md "Phase A threat model") — loopback TCP keeps
//! only the token of the socket's three gates, so this file compensates
//! from day one:
//!   - own credential: `mcp-token` (0600, 244 bits), NEVER `cli-token`,
//!     never in the app process env (pty_spawn copies that env into
//!     every child), never in any PTY overlay;
//!   - constant-time token compare + backoff on auth failures;
//!   - any request carrying an Origin header is refused outright, a
//!     Host outside the loopback names is refused too (the rebinding
//!     case, which arrives same-origin and so carries no Origin), no
//!     CORS header is ever emitted, and OPTIONS (preflight) is never
//!     answered usefully;
//!   - peer identification is never attempted (telemetry-only logs).
//!
//! Lifecycle: bind-on-enable, live both ways. Unlike the CLI socket
//! (always bound, setting gates verbs) there is no auto-launch dead end
//! here, so Off = not bound. The bound port is preferred across
//! enable/disable cycles and restarts so pasted client configs survive.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use termic_proto as proto;
use termic_proto::{Command, Request};

use crate::cli_server::{self, CliHost};
use crate::dlog;

/// Credential file, alongside `cli-token` (independent VALUE, same
/// custody rules). Rewritten on every bind; removed on disable.
pub(crate) const MCP_TOKEN_FILE: &str = "mcp-token";
/// Advertisement file: the full endpoint URL, one line. The port is not
/// a secret (0644); the token is the whole boundary.
pub(crate) const MCP_PORT_FILE: &str = "mcp-port";
/// The non-reserved header both clients' helpers emit. Named once: the
/// server parses it, the settings page shows it, and the one-click
/// installer writes it.
pub(crate) const MCP_TOKEN_HEADER: &str = "X-Termic-Token";
/// The task the calling agent runs in, sent by the headers helper Termic
/// installs (it reads `$TERMIC_TASK_ID` from the AGENT's environment, since
/// the client runs the helper as its own child). It gives MCP what the CLI
/// gets from its env: `task_new` groups under the caller, and the verbs the
/// CLI aims at "your own task" do the same here. Caller-asserted, exactly
/// like the CLI's env var, so it only ever DEFAULTS a target the token
/// holder could name explicitly anyway; it grants nothing.
pub(crate) const MCP_TASK_HEADER: &str = "X-Termic-Task";

const MAX_BODY: usize = 4 * 1024 * 1024;
/// Cap on the request line + headers together, enforced pre-auth (the
/// body has MAX_BODY; without this the head is an unauthenticated
/// memory hole). 16 KB fits every real client's headers with room.
const MAX_HEAD: usize = 16 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Write side of the same idea: a peer that stops draining must not hold a
/// thread. Longer than the read side, because a legitimate client reading a
/// megabyte-scale diff over loopback is still slower than sending a request.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// Cap on the self-connect that unblocks `accept()` during teardown.
/// Loopback answers in microseconds; this only bounds the pathological
/// case, because the caller is the main thread.
const SHUTDOWN_POKE_TIMEOUT: Duration = Duration::from_millis(500);
/// Accept-loop error handling: pause briefly, and stop entirely if the
/// listener is wedged, rather than spinning on a permanent failure.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
const MAX_ACCEPT_FAILURES: u32 = 64;
/// Connections being served at once. Every local uid can reach this
/// port, and a socket that never finishes its request holds a thread
/// for the whole read timeout, so an unauthenticated peer could open
/// them until the app runs out of threads. Well past what a handful of
/// clients use, and refusals are cheap.
const MAX_CONNECTIONS: usize = 64;
/// How long a re-enable waits for the previous listener to release the
/// port before settling for whatever it can get.
const PORT_RELEASE_WAIT: Duration = Duration::from_millis(250);

#[cfg(not(test))]
const BACKOFF_STEP: Duration = Duration::from_millis(100);
#[cfg(not(test))]
const BACKOFF_MAX: Duration = Duration::from_secs(2);
#[cfg(test)]
const BACKOFF_STEP: Duration = Duration::from_millis(2);
#[cfg(test)]
const BACKOFF_MAX: Duration = Duration::from_millis(20);

// ───────────────────────────── auth ──────────────────────────────────

/// Constant-time equality. The CLI socket's compare is deliberately
/// plain (`auth_gate`'s comment: peer-uid + 0600 file carry it); here
/// the token is the ONLY gate on a port every local process can reach,
/// so timing must not narrow a guess. XOR-fold, no early exit; length
/// mismatch folds in rather than returning.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    // An empty `b` would make the index below `b[0]` on an empty slice
    // and panic. Unreachable while the token is always 64 hex chars,
    // but this is a pre-auth path: a panic here kills the connection
    // thread with no response at all, so it fails closed instead.
    if b.is_empty() {
        return a.is_empty();
    }
    // Fold the length difference to a single bit BEFORE narrowing. As
    // `(a.len() ^ b.len()) as u8` it lost the high bits, so any length
    // differing by a multiple of 256 folded in as zero and the modular
    // index below did the rest: the 64-char token repeated five times
    // (320 ^ 64 = 256) compared equal.
    let mut diff = u8::from(a.len() != b.len());
    for i in 0..a.len() {
        diff |= a[i] ^ b[i % b.len()];
    }
    diff == 0
}

/// Auth-failure backoff: linear ramp, capped, reset on success. Slept
/// BEFORE the 401 is written so a guesser pays per attempt.
///
/// One counter for the whole endpoint, deliberately, not one per peer. It
/// only ever delays the FAILURE path, so a caller holding the real token
/// waits for nobody. Per-peer would have to key on the peer address, which
/// an unauthenticated local caller picks afresh for every connection: the
/// map would grow without bound on precisely the path this exists to make
/// expensive. Sharing one counter across a single user's own tooling costs
/// nothing worth having.
struct Backoff {
    failures: u32,
}

impl Backoff {
    fn delay(&mut self) -> Duration {
        self.failures = self.failures.saturating_add(1);
        BACKOFF_STEP
            .saturating_mul(self.failures)
            .min(BACKOFF_MAX)
    }
    fn reset(&mut self) {
        self.failures = 0;
    }
}

// ───────────────────────────── server ────────────────────────────────

/// Everything a connection thread needs. `enabled` is re-read per
/// request (the cli_enabled discipline) so a disable applies even in
/// the unbind race window; injectable so tests need no settings file.
pub(crate) struct McpServer {
    /// Set when THIS listener is torn down. A connection accepted before
    /// a disable can still be parked in read_request for the read
    /// timeout; without this it would wake into a re-enabled setting and
    /// serve a request authenticated by the revoked token it captured.
    /// Off means off for connections already open, not only new ones.
    retired: Arc<AtomicBool>,
    token: String,
    /// Where `tools/call` dispatches: the CLI server's own verb
    /// handlers, so MCP never grows a second implementation.
    host: Arc<dyn CliHost>,
    enabled: Box<dyn Fn() -> bool + Send + Sync>,
    /// Bound somewhere other machines can reach (Settings
    /// "mcp_bind_address" is not loopback). Fixed for the life of a
    /// listener: changing the address rebinds.
    lan: bool,
    backoff: Mutex<Backoff>,
}

impl McpServer {
    pub(crate) fn new(
        token: String,
        host: Arc<dyn CliHost>,
        enabled: Box<dyn Fn() -> bool + Send + Sync>,
        retired: Arc<AtomicBool>,
    ) -> Self {
        McpServer { retired, token, host, enabled, lan: false, backoff: Mutex::new(Backoff { failures: 0 }) }
    }
}

/// What going quiet removes: the port file, so nothing says an endpoint
/// is listening. The TOKEN stays. It changes only when the user asks
/// (`mcp_regenerate_token`), because a client on another machine holds a
/// pasted copy, and a token that rotated by itself broke that client on
/// every restart.
fn revoke_advertisement(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(MCP_PORT_FILE));
}

/// The credential a new listener serves: the one on disk when it is one
/// this server wrote, a fresh one otherwise (first enable, or a file
/// someone damaged).
fn token_for_bind(dir: &Path) -> String {
    token_from_file(dir).unwrap_or_else(cli_server::mint_token)
}

/// Drop the endpoint's advertised state after its listener dies on its
/// own, so mcp_status stops reporting a live URL for a listener that is
/// gone and the next save can rebind instead of taking the no-op arm.
fn clear_after_listener_death(port: u16, shutdown: &Arc<AtomicBool>) {
    // try_lock, never lock: a re-enable holds this mutex while waiting
    // for THIS thread to finish, so blocking here would trade a bounded
    // wait for a deadlock. Failing to clear is harmless; the listener is
    // gone either way and the next toggle rebinds.
    let Ok(mut st) = state().try_lock() else { return };
    // Identity, not port number. A rebind deliberately reuses the same
    // port, so comparing numbers could revoke the files of the LIVE
    // listener that replaced us, leaving it running with no credential
    // and reported dead.
    let ours = st
        .handle
        .as_ref()
        .is_some_and(|h| Arc::ptr_eq(&h.shutdown, shutdown));
    if !ours {
        return;
    }
    st.handle = None;
    st.last_port = Some(port);
    if let Ok(dir) = crate::global_dir() {
        revoke_advertisement(&dir);
    }
}

fn serve_listener(listener: TcpListener, server: Arc<McpServer>, shutdown: Arc<AtomicBool>) {
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    // Consecutive accept() failures, so a persistent one (EMFILE with
    // every connection spawning a thread and every tab holding a pty fd)
    // cannot spin this loop at 100% CPU. Same shape as the CLI server's
    // accept loop; the brief sleep is on the ERROR path only, not a
    // steady-state poll.
    let mut failures = 0u32;
    let live = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    for stream in listener.incoming() {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        let stream = match stream {
            Ok(s) => {
                failures = 0;
                s
            }
            Err(e) => {
                failures += 1;
                if failures > MAX_ACCEPT_FAILURES {
                    dlog(&format!("[mcp] giving up after {failures} accept errors: {e}"));
                    // Leaving the handle and the advertisement files
                    // behind would have mcp_status report a live URL for
                    // a listener that is gone, and the next save with
                    // the setting still on would take the (true, true)
                    // no-op, so the endpoint could never come back
                    // without an off/on cycle.
                    clear_after_listener_death(port, &shutdown);
                    break;
                }
                std::thread::sleep(ACCEPT_BACKOFF);
                continue;
            }
        };
        // Counted BEFORE the thread exists, so the cap bounds threads
        // rather than trailing them.
        if live.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            live.fetch_sub(1, Ordering::SeqCst);
            // Answering costs one write and tells an honest client to
            // back off; a flooder is closed either way.
            // On the accept thread, so a peer that never drains must not
            // stall every later connection behind this one write.
            let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
            let _ = respond(stream, 503, b"");
            continue;
        }
        let server = server.clone();
        let live_for_conn = live.clone();
        std::thread::spawn(move || {
            let _ = handle_conn(stream, &server);
            live_for_conn.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

// ───────────────────────────── http ──────────────────────────────────

struct HttpRequest {
    method: String,
    path: String,
    /// Bearer value from Authorization, if the header parsed.
    bearer: Option<String>,
    /// Any Origin header at all (value irrelevant: presence = browser).
    has_origin: bool,
    /// The spec's `Mcp-Method` header, verbatim.
    mcp_method: Option<String>,
    /// `MCP-Protocol-Version`, required on every POST and required to
    /// equal the `_meta` protocol version.
    protocol_version: Option<String>,
    /// `Mcp-Name`, required for `tools/call` (and resources/read and
    /// prompts/get, which this server does not serve).
    mcp_name: Option<String>,
    /// `X-Termic-Token`, the alternative credential carrier. Codex
    /// refuses to let its per-server `http_headers_helper` emit
    /// `Authorization` ("returned a reserved header"), and its only
    /// bearer mechanism reads an environment variable, which would
    /// force every user to edit a shell profile to use an MCP server.
    /// A non-reserved header lets that helper read the 0600 file at
    /// connect time instead: no env var, no shell edit, and no copy of
    /// the credential in any client config.
    termic_token: Option<String>,
    /// `X-Termic-Task` (MCP_TASK_HEADER): the caller's own task id, empty
    /// when the helper ran outside a Termic task.
    termic_task: Option<String>,
    /// `Host`, checked against the loopback names: the DNS-rebinding
    /// stop, since a rebound page's request is same-origin and so
    /// carries no `Origin` to reject.
    host: Option<String>,
    body: Vec<u8>,
}

/// Read one request off the stream. Only reading races the 10s clock;
/// a long tool call responds after this returns and is unaffected.
fn read_request(stream: &TcpStream) -> std::io::Result<Result<HttpRequest, u16>> {
    // The head phase is byte-capped: this runs pre-auth for any local
    // process, and MAX_BODY only bounds the body, so without this a
    // peer STREAMING an endless header line (the read timeout fires on
    // stall, not on flowing data) balloons read_line's buffer until
    // macOS kills the app and every live PTY with it. A line that hits
    // the cap without its newline is answered 431.
    let mut head = BufReader::new(stream.try_clone()?).take(MAX_HEAD as u64);
    let mut line = String::new();
    head.read_line(&mut line)?;
    if !line.ends_with('\n') && head.limit() == 0 {
        return Ok(Err(431));
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let path = target.split('?').next().unwrap_or("").to_string();

    let mut content_len = 0usize;
    let mut bearer = None;
    let mut has_origin = false;
    let mut mcp_method = None;
    let mut protocol_version = None;
    let mut mcp_name = None;
    let mut host = None;
    let mut termic_token = None;
    let mut termic_task = None;
    let mut chunked = false;
    let mut bad_length = false;
    loop {
        let mut h = String::new();
        head.read_line(&mut h)?;
        if !h.ends_with('\n') && head.limit() == 0 {
            return Ok(Err(431));
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            let k = k.trim().to_ascii_lowercase();
            let v = v.trim();
            match k.as_str() {
                "content-length" => match v.parse::<usize>() {
                    Ok(n) => content_len = n,
                    // Silently reading it as 0 produced "-32700 parse
                    // error", pointing the client at its JSON instead of
                    // its framing.
                    Err(_) => bad_length = true,
                },
                "authorization" => {
                    // Scheme is case-insensitive per RFC 9110. Compare
                    // BYTES: a str slice at 7 panics mid-char when the
                    // value opens with multi-byte UTF-8, and this runs
                    // pre-auth. A matched ASCII prefix makes byte 7 a
                    // char boundary, so the value slice below is safe.
                    let b = v.as_bytes();
                    if b.len() >= 7 && b[..7].eq_ignore_ascii_case(b"bearer ") {
                        bearer = Some(v[7..].trim().to_string());
                    } else {
                        // Wrong scheme: keep Some("") so it fails the
                        // compare instead of reading as "missing".
                        bearer = Some(String::new());
                    }
                }
                "origin" => has_origin = true,
                "mcp-method" => mcp_method = Some(v.to_string()),
                "mcp-protocol-version" => protocol_version = Some(v.to_string()),
                "mcp-name" => mcp_name = Some(v.to_string()),
                // eq_ignore_ascii_case, not a lowercased constant: `k` is
                // already lowered once above, and building a String from the
                // constant here would allocate on EVERY header line of every
                // request just to reach the arms below it.
                _ if k.eq_ignore_ascii_case(MCP_TOKEN_HEADER) => {
                    termic_token = Some(v.to_string())
                }
                _ if k.eq_ignore_ascii_case(MCP_TASK_HEADER) => {
                    termic_task = Some(v.trim().to_string()).filter(|v| !v.is_empty())
                }
                "host" => host = Some(v.to_string()),
                "transfer-encoding" => chunked = v.to_ascii_lowercase().contains("chunked"),
                _ => {}
            }
        }
    }
    // A chunked (or unparseable-Content-Length) body would otherwise be
    // read as zero bytes and answered "parse error", which names the
    // wrong fault. This server does not decode chunked; say so.
    if chunked || bad_length {
        return Ok(Err(411));
    }
    if content_len > MAX_BODY {
        // Answered without draining the oversized body, so the unread
        // bytes usually make the close an RST and the client sees a
        // connection reset rather than this status. Same accepted
        // trade-off as the 431 path above: draining megabytes to be
        // polite to an abuse path is worse than the reset.
        return Ok(Err(413));
    }
    // The body cap is enforced above; the head Take comes off so the
    // body read is bounded by content_len alone.
    //
    // Grown from the bytes that actually arrive, never allocated from the
    // DECLARED length: this still runs pre-auth, so trusting Content-Length
    // would let MAX_CONNECTIONS peers claim MAX_BODY apiece and pin
    // hundreds of megabytes for the whole read timeout without ever
    // sending a byte or a credential.
    let reader = head.into_inner();
    let mut body = Vec::new();
    reader.take(content_len as u64).read_to_end(&mut body)?;
    if body.len() != content_len {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "body shorter than Content-Length",
        ));
    }
    Ok(Ok(HttpRequest {
        method,
        path,
        bearer,
        has_origin,
        mcp_method,
        protocol_version,
        mcp_name,
        host,
        termic_token,
        termic_task,
        body,
    }))
}

fn handle_conn(stream: TcpStream, server: &McpServer) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    // Both directions, as the CLI server's sockets do. A peer that stops
    // READING parks this thread inside write_all otherwise, and a big
    // response (task_diff with `full`) is megabytes: MAX_CONNECTIONS such
    // peers would wedge the endpoint for good, turning the connection cap
    // from a protection into the ceiling it was meant to defend.
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();

    let req = match read_request(&stream)? {
        Ok(r) => r,
        Err(status) => return respond(stream, status, b""),
    };

    // The gauntlet, in order; every refusal is minimal-disclosure.
    // 1. Surface: exactly POST /mcp. OPTIONS lands here too - the CORS
    //    preflight a browser is forced into (Authorization + Mcp-Method
    //    make every real request non-simple) is never answered, and no
    //    response anywhere carries an Access-Control-* header.
    if req.path != "/mcp" {
        return respond(stream, 404, b"");
    }
    if req.method != "POST" {
        return respond(stream, 405, b"");
    }
    // 2. Browser JS: an Origin header means a cross-origin caller.
    //    Refused before auth so a drive-by probe learns nothing about
    //    token validity, and refused even WITH a valid token so an
    //    exfiltrated token is still useless from a page.
    if req.has_origin {
        return respond(stream, 403, b"");
    }
    // 2b. DNS rebinding: a page on a hostname that resolves to 127.0.0.1
    //    reaches us same-origin, so it sends no Origin and gate 2 never
    //    fires. The bearer token still holds the boundary (such a page
    //    cannot read the 0600 file), but the spec asks for this check
    //    and it makes the layering above actually independent.
    if let Some(h) = req.host.as_deref() {
        if !host_allowed(h, server.lan) {
            return respond(stream, 403, b"");
        }
    }
    // 3. Setting, re-read per request: merged is not live, and the
    //    unbind on disable races in-flight connections. The retired
    //    check is the half the setting cannot cover: a quick off/on
    //    leaves the setting true again while this worker still holds
    //    the previous listener's revoked token.
    //
    //    After the surface gates on purpose. "Off" unbinds the listener,
    //    so nothing reaches here at all in the steady state; this gate
    //    covers the window between the setting flipping and the unbind
    //    landing. Ordering it first would only change which refusal a
    //    caller sees inside that window, and answering 403 for a path
    //    this server does not serve would be its own small lie.
    if server.retired.load(Ordering::SeqCst) || !(server.enabled)() {
        return respond(stream, 403, b"");
    }
    // 4. The token. Missing, malformed, wrong, or the CLI's token all
    //    take the identical path: backoff, then a bare 401.
    // Either carrier is the same credential and the same check. The
    // custom header is if anything the safer of the two against browser
    // JS: it cannot be set cross-origin without a preflight, and this
    // server never answers one.
    let presented = req
        .termic_token
        .as_deref()
        .or(req.bearer.as_deref())
        .unwrap_or("");
    if !ct_eq(presented.as_bytes(), server.token.as_bytes()) {
        let delay = server.backoff.lock().unwrap().delay();
        std::thread::sleep(delay);
        // Peer addr is telemetry only, never a gate (mcp.md).
        dlog(&format!("[mcp] auth failure from {peer}"));
        return respond(stream, 401, b"");
    }
    server.backoff.lock().unwrap().reset();

    let (status, body) = rpc_response(server, &req);
    respond(stream, status, &body)
}

/// Is this `Host` one of the loopback spellings we answer to? The port
/// is irrelevant (we only ever bound one), so only the host part is
/// compared; a bracketed IPv6 literal keeps its brackets.
fn host_is_loopback(host: &str) -> bool {
    matches!(host_name(host), "127.0.0.1" | "localhost" | "::1")
}

/// The host part of a `Host` header, without port or IPv6 brackets.
fn host_name(host: &str) -> &str {
    match host.strip_prefix('[') {
        // [::1]:port -> ::1
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(""),
    }
}

/// Gate 2b with the bind address folded in. A device on the network
/// reaches us by this machine's address, so off loopback any IP LITERAL
/// is answered, and nothing else is. That keeps the rebinding defence
/// whole: the attack needs a hostname the attacker's DNS controls, and a
/// literal address is never resolved. The cost is that `machine.local`
/// is refused; clients are given the address.
fn host_allowed(host: &str, lan: bool) -> bool {
    host_is_loopback(host) || (lan && host_name(host).parse::<std::net::IpAddr>().is_ok())
}

/// This machine's address on the network other devices would use, for the
/// URL Settings shows. Connecting a UDP socket sends nothing; it only makes
/// the OS pick the outbound interface (192.0.2.1 is TEST-NET-1, reserved
/// for documentation). `None` with no route, i.e. no network.
pub(crate) fn lan_ip() -> Option<std::net::IpAddr> {
    let s = std::net::UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    s.connect(("192.0.2.1", 9)).ok()?;
    s.local_addr().ok().map(|a| a.ip()).filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
}

fn respond(mut stream: TcpStream, status: u16, body: &[u8]) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        503 => "Service Unavailable",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    // A 401 MUST carry a challenge (RFC 9110), and we were sending none.
    // It is a constant, identical for a missing, wrong or CLI token, so
    // it still says nothing about which failed.
    //
    // It does NOT stop a client probing for OAuth. Measured against
    // claude 2.1.238 with a stub returning 401 both ways: it fetches
    // /.well-known/oauth-* and posts /register either way, which is why
    // a stale token there reads as "Dynamic Client Registration
    // rejected (HTTP 404)" rather than as an auth failure. That
    // confusion is the client's flow, not something this server can
    // suppress; the defence against it is not having stale tokens,
    // which is what minting per bind plus a file-reading helper buys.
    let challenge = if status == 401 { "WWW-Authenticate: Bearer\r\n" } else { "" };
    // No Access-Control-* header exists in this file, by design.
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n{challenge}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

// ───────────────────────────── json-rpc ──────────────────────────────

/// The one revision this server implements (mcp.md "Traps": pin the
/// string; the boundary never depends on spec churn). There is no
/// legacy era here by decision: a handshake-based client is refused
/// with an error that names what it would need to speak.
const SPEC_REVISION: &str = "2026-07-28";

/// Spec error codes. The -32020..-32099 sub-range belongs to the spec,
/// and a code outside its table must never be emitted from it.
const HEADER_MISMATCH: i64 = -32020;
const VERSION_MISMATCH: i64 = -32022;

/// Reserved `_meta` keys. The `io.modelcontextprotocol/` prefix is not
/// decoration: bare `protocolVersion` is a different key, and no client
/// sends it.
const META_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";

/// Answer one authenticated POST body: the stateless core. No handshake
/// and no sessions; each request carries everything (identity came from
/// the bearer token at the HTTP layer).
fn rpc_response(server: &McpServer, req: &HttpRequest) -> (u16, Vec<u8>) {
    let parsed: serde_json::Value = match serde_json::from_slice(&req.body) {
        Ok(v) => v,
        Err(_) => return rpc_error(serde_json::Value::Null, 400, -32700, "parse error"),
    };
    // Batching died with the session-bound revisions; one request per
    // POST is the stateless shape.
    if parsed.is_array() {
        return rpc_error(serde_json::Value::Null, 400, -32600, "batch requests are not supported");
    }
    // The envelope, checked before any verb runs. The headers above are
    // validated strictly, and a body that gets the version or the id shape
    // wrong is malformed in the same way: it is not a request for a method,
    // so it must not reach one. Notifications carry no id, which is why
    // absent is allowed and a wrong TYPE is not.
    if !parsed.is_object() {
        return rpc_error(serde_json::Value::Null, 400, -32600, "request must be a JSON-RPC object");
    }
    if parsed.get("jsonrpc").and_then(|v| v.as_str()) != Some("2.0") {
        return rpc_error(serde_json::Value::Null, 400, -32600, "jsonrpc must be \"2.0\"");
    }
    if let Some(id) = parsed.get("id") {
        if !(id.is_string() || id.is_number() || id.is_null()) {
            return rpc_error(serde_json::Value::Null, 400, -32600, "id must be a string, number, or null");
        }
    }
    let Some(method) = parsed.get("method").and_then(|m| m.as_str()).map(str::to_string) else {
        return rpc_error(serde_json::Value::Null, 400, -32600, "method must be a string");
    };
    let params = parsed.get("params").cloned().unwrap_or(serde_json::json!({}));

    // A handshake-based client opens with `initialize`. It has no
    // fall-forward path, so this reply is the only diagnostic its user
    // will ever see: name the revision here rather than failing it on a
    // missing header further down.
    if method == "initialize" {
        let id = parsed.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let requested = params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or("(unstated)");
        // Only an actually-unsupported version is a version error. A
        // caller naming the revision we DO serve gets told the real
        // fault instead: this revision has no handshake, so `initialize`
        // is not one of its methods. Answering "unsupported version
        // 2026-07-28, supported: 2026-07-28" reads as a server bug and
        // sends the reader hunting in the wrong place.
        if requested == SPEC_REVISION {
            return rpc_error_with_data(
                id,
                404,
                -32601,
                "initialize is not part of protocol revision 2026-07-28, which negotiates per request and has no handshake",
                serde_json::json!({ "supported": [SPEC_REVISION] }),
            );
        }
        return version_error(id, requested);
    }

    // Notifications carry no id and get no response body. This revision
    // defines no header requirements for them, so they are swallowed
    // ahead of the header gates.
    let Some(id) = parsed.get("id").cloned() else {
        if method.starts_with("notifications/") {
            return (202, Vec::new());
        }
        return rpc_error(serde_json::Value::Null, 400, -32600, "request has no id");
    };

    // Standard headers mirror body fields so intermediaries can route
    // without parsing; missing and mismatched are the same fault.
    if method.is_empty() || req.mcp_method.as_deref() != Some(method.as_str()) {
        return rpc_error(id, 400, HEADER_MISMATCH, "Mcp-Method header missing or does not match method");
    }
    let meta = params.get("_meta");
    let body_version = meta.and_then(|m| m.get(META_VERSION)).and_then(|v| v.as_str());
    match (req.protocol_version.as_deref(), body_version) {
        (None, _) => {
            return rpc_error(id, 400, HEADER_MISMATCH, "MCP-Protocol-Version header is required");
        }
        (Some(h), Some(b)) if h != b => {
            let m = format!(
                "Header mismatch: MCP-Protocol-Version header value '{h}' does not match body value '{b}'"
            );
            return rpc_error(id, 400, HEADER_MISMATCH, &m);
        }
        _ => {}
    }
    // Required per-request `_meta` fields. Absent is malformed params,
    // NOT a header fault: the header was there, the body was not.
    let Some(version) = body_version else {
        return rpc_error(id, 400, -32602, &format!("params._meta.{META_VERSION} is required"));
    };
    if meta.and_then(|m| m.get(META_CAPABILITIES)).is_none() {
        return rpc_error(id, 400, -32602, &format!("params._meta.{META_CAPABILITIES} is required"));
    }
    if version != SPEC_REVISION {
        return version_error(id, version);
    }
    // `Mcp-Name` mirrors params.name; tools/call is the only method on
    // this surface that carries one.
    if method == "tools/call" {
        let body_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
        match req.mcp_name.as_deref().map(decode_header_value) {
            None => {
                return rpc_error(id, 400, HEADER_MISMATCH, "Mcp-Name header is required for tools/call");
            }
            Some(h) if h != body_name => {
                let m = format!(
                    "Header mismatch: Mcp-Name header value '{h}' does not match body value '{body_name}'"
                );
                return rpc_error(id, 400, HEADER_MISMATCH, &m);
            }
            Some(_) => {}
        }
    }

    match method.as_str() {
        // serverInfo rides in the result's _meta, never in the body:
        // the final revision moved it, and SDK v2 rejects the older
        // body shape outright.
        // Field name is `supportedVersions`: a client reads the version
        // list from it to choose one, so `versions` left codex unable to
        // negotiate and it gave up after discover.
        "server/discover" => rpc_result(
            id,
            with_cache_hints(serde_json::json!({
                "supportedVersions": [SPEC_REVISION],
                "capabilities": { "tools": {} },
                // DiscoverResult's optional guidance for the model. It is
                // the only place this server can say WHO the caller
                // probably is, since no call carries a task identity.
                // Plus the paired machines and what each is for, so an
                // orchestrator knows "the laptop does Windows builds"
                // without calling peer_list first.
                "instructions": format!(
                    "{MCP_INSTRUCTIONS}{}",
                    server.host.peers().map(|n| n.instructions()).unwrap_or_default()
                ),
            })),
        ),
        "tools/list" => tools_list(id),
        "tools/call" => tools_call(server, id, &params, req.termic_task.as_deref()),
        // A method this server does not implement is 404 at the HTTP
        // layer; the JSON-RPC body is what separates it from a 404 out
        // of something that is not an MCP endpoint at all.
        _ => rpc_error(id, 404, -32601, &format!("unknown method \"{method}\"")),
    }
}

/// Guidance for the model, returned by `server/discover` (the 2026-07-28
/// `DiscoverResult.instructions`). The CLI says the same in its own verbs
/// (`agent_overview!` in termic-cli/src/lib.rs): keep the two in step. The
/// point is the first sentence: an agent that does not realise it is running
/// INSIDE a Termic task never thinks to start siblings or report back.
const MCP_INSTRUCTIONS: &str = "Termic runs coding agents side by side, each in its own task (a git worktree, or the project's main checkout, with its own terminal), listed in the app's sidebar. If your environment has TERMIC_TASK_ID, you are one of those agents, running INSIDE a Termic task right now, and these tools drive the app around you. From there you can: launch new tasks with their own agents (task_new; in your project they join your task's group in the sidebar, in another they are linked to your task instead; you name the group for the batch of work with task_group); prompt another task's agent (task_send; it is typed at once, even into a busy agent mid-turn, and queue=true waits for that turn to end instead) and read what it produced (task_log, task_result); open another agent tab in a task (task_tab); retitle your own task (task_rename); label your tab with what you are working on, shown on the task's sidebar row (task_prop, e.g. ticket=ABC-1; pass your TERMIC_TAB_ID as tab); and keep notes, plans, findings, logs and reports the user should READ in scratchpads (scratchpad_new, scratchpad_write): a tab in your task that updates live and stays out of git, so use one instead of dropping temporary .md files into the repo. A multi-repo project holds several repos, possibly many (project_list shows each project's type and members): task_new worktrees only the members you name in members (none without it). Coordinate by prompting each other rather than blocking: end a prompt with how the other agent should report back to you (a task_send to your task id), and ask for that report every time it finishes or gets stuck, follow-up work included, until a human tells it to stop. Sign every prompt you send another agent, first line and last: [message from agent:<your agent> task:<your task name> id:<your TERMIC_TASK_ID>] ... -- agent:<your agent> task:<your task name> id:<your TERMIC_TASK_ID>, with the values written out (there is no shell here to fill them in; TERMIC_TASK holds your task name). A prompt that arrives WITH that header came from another agent, not the user: the id is where to reply. Report back there every time you finish or get stuck, follow-up work included, and stop only when a human tells you to. When Termic set this client up, it tells the server which task you run in, so task_rename, task_group, task_tab and task_prop default to your own task, exactly like the CLI; name other tasks explicitly. If this machine is paired with others on its network (peer_list), task_new, task_send, task_wait, task_result and task_list take peer:<machine> to run THERE, and peer_call runs any other tool there: put peer:<this machine's name> in your signature and ask for the reply as a task_send with peer:<this machine> back to your task id; a prompt whose header carries peer:<machine> came from that machine, so answer it, or ask it for help when stuck, with task_send peer:<machine> to the id in that header. Without TERMIC_TASK_ID you are driving Termic from outside it.";

/// UnsupportedProtocolVersionError. The `supported` list has to be
/// machine-readable in `data`: that is what a client retries from, and
/// a human-readable message alone strands it.
fn version_error(id: serde_json::Value, requested: &str) -> (u16, Vec<u8>) {
    rpc_error_with_data(
        id,
        400,
        VERSION_MISMATCH,
        "Unsupported protocol version",
        serde_json::json!({ "supported": [SPEC_REVISION], "requested": requested }),
    )
}

/// A header value that cannot ride as plain ASCII arrives base64'd
/// behind the spec's `=?base64?...?=` sentinel, and must be decoded
/// before it is compared to the body.
fn decode_header_value(v: &str) -> String {
    use base64::Engine as _;
    let Some(inner) = v.strip_prefix("=?base64?").and_then(|r| r.strip_suffix("?=")) else {
        return v.to_string();
    };
    base64::engine::general_purpose::STANDARD
        .decode(inner)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_else(|| v.to_string())
}

fn server_info() -> serde_json::Value {
    serde_json::json!({ "name": "termic", "version": env!("CARGO_PKG_VERSION") })
}

/// The ONE place the result envelope is encoded: `resultType` as a
/// top-level result field (not metadata, and `complete` is the only kind
/// this surface produces, there being no partial or streamed results
/// here) plus the namespaced serverInfo in `_meta`, the one key a server
/// is asked to stamp. A second copy would ship the old shape from
/// whichever path a revision change missed.
fn rpc_result(id: serde_json::Value, mut result: serde_json::Value) -> (u16, Vec<u8>) {
    if let Some(obj) = result.as_object_mut() {
        obj.insert("resultType".into(), "complete".into());
        let mut meta = serde_json::Map::new();
        meta.insert(META_SERVER_INFO.into(), server_info());
        obj.insert("_meta".into(), serde_json::Value::Object(meta));
    }
    let frame = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result });
    (200, frame.to_string().into_bytes())
}

/// Caching hints, which the spec REQUIRES on every `resultType: "complete"`
/// result of server/discover and tools/list. They are top-level result
/// fields, NOT `_meta` keys. `public` is correct while every caller sees
/// the same surface; scoped tokens (Phase B2) filter tools/list per token
/// and must switch it to `private`, or a shared cache would hand one
/// caller another's surface.
fn with_cache_hints(mut result: serde_json::Value) -> serde_json::Value {
    if let Some(obj) = result.as_object_mut() {
        obj.insert("ttlMs".into(), TOOLS_TTL_MS.into());
        obj.insert("cacheScope".into(), "public".into());
    }
    result
}

fn rpc_error(id: serde_json::Value, status: u16, code: i64, message: &str) -> (u16, Vec<u8>) {
    rpc_error_frame(id, status, code, message, None)
}

/// An error carrying machine-readable `data`, which is what a client
/// acts on when the message alone leaves it nowhere to go.
fn rpc_error_with_data(
    id: serde_json::Value,
    status: u16,
    code: i64,
    message: &str,
    data: serde_json::Value,
) -> (u16, Vec<u8>) {
    rpc_error_frame(id, status, code, message, Some(data))
}

fn rpc_error_frame(
    id: serde_json::Value,
    status: u16,
    code: i64,
    message: &str,
    data: Option<serde_json::Value>,
) -> (u16, Vec<u8>) {
    let mut err = serde_json::json!({ "code": code, "message": message });
    if let Some(d) = data {
        err["data"] = d;
    }
    let frame = serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": err });
    (status, frame.to_string().into_bytes())
}

// ───────────────────────────── tool registry ─────────────────────────

/// Cap on every wait-shaped tool (`task_wait`, and `task_new` /
/// `task_send` with wait). Bounded POSTs by design: callers loop, the
/// server never holds an hour-long request (mcp.md).
pub(crate) const MCP_WAIT_CAP_MS: u64 = 300_000;

/// tools/list result ttl hint: the surface only changes with the app
/// binary, so clients may cache generously (blunts the context cost).
const TOOLS_TTL_MS: u64 = 3_600_000;

type Args = serde_json::Map<String, serde_json::Value>;

/// The `cli_verb` of a tool that presents a GLOBAL flag rather than a verb
/// (peer_call is `--peer` on every verb). The parity test checks it against
/// machine_help's global flags.
const GLOBAL_PEER_FLAG: &str = "--peer";

struct ParamDef {
    name: &'static str,
    /// JSON Schema primitive: "string" | "boolean" | "integer".
    json_type: &'static str,
    required: bool,
    description: &'static str,
    /// The flag or positional in `machine_help()` this maps to (parity
    /// test); None for MCP-only params.
    #[cfg_attr(not(test), allow(dead_code))] // parity test only
    cli_flag: Option<&'static str>,
}

struct ToolDef {
    name: &'static str,
    /// The `machine_help()` command this presents (parity test).
    #[cfg_attr(not(test), allow(dead_code))] // parity test only
    cli_verb: &'static str,
    description: &'static str,
    params: &'static [ParamDef],
    /// Well-behaved clients confirm destructiveHint'd calls; the CLI
    /// confirms these same verbs client-side. Possession of the
    /// full-scope token is the consent model here (`--yes` equivalent).
    destructive: bool,
    read_only: bool,
    build: fn(&Args) -> Result<Command, String>,
}

fn arg_str(a: &Args, k: &str) -> Result<Option<String>, String> {
    match a.get(k) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("\"{k}\" must be a string")),
    }
}

fn need_str(a: &Args, k: &str) -> Result<String, String> {
    arg_str(a, k)?.ok_or_else(|| format!("\"{k}\" is required"))
}

fn arg_bool(a: &Args, k: &str) -> Result<bool, String> {
    match a.get(k) {
        None | Some(serde_json::Value::Null) => Ok(false),
        Some(serde_json::Value::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("\"{k}\" must be a boolean")),
    }
}

fn arg_opt_bool(a: &Args, k: &str) -> Result<Option<bool>, String> {
    match a.get(k) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(format!("\"{k}\" must be a boolean")),
    }
}

fn arg_str_list(a: &Args, k: &str) -> Result<Vec<String>, String> {
    match a.get(k) {
        None | Some(serde_json::Value::Null) => Ok(Vec::new()),
        Some(serde_json::Value::Array(xs)) => xs
            .iter()
            .map(|x| x.as_str().map(str::to_string).ok_or_else(|| format!("\"{k}\" must be an array of strings")))
            .collect(),
        Some(_) => Err(format!("\"{k}\" must be an array of strings")),
    }
}

fn arg_u64(a: &Args, k: &str) -> Result<Option<u64>, String> {
    match a.get(k) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => v.as_u64().map(Some).ok_or_else(|| format!("\"{k}\" must be a non-negative integer")),
    }
}

/// Shared param blurbs. Unlike the CLI there is no cwd fallback on this
/// surface (an outside client has no meaningful cwd), so `task` is
/// required wherever the CLI would have inferred it.
/// On the five verbs an orchestrator uses across machines: run the call on
/// a paired machine (peer_list) instead of here, as `peer_call` would. Only
/// these five, not every tool: each copy is schema in every client's
/// context, and `peer_call` reaches the rest.
const P_PEER: ParamDef = ParamDef {
    name: "peer",
    json_type: "string",
    required: false,
    description: "Run it on this paired machine (peer_list) instead.",
    cli_flag: Some("--peer"),
};
const PEER_PARAM_TOOLS: &[&str] = &["task_list", "task_new", "task_send", "task_wait", "task_result"];

const P_TASK: ParamDef = ParamDef {
    name: "task",
    json_type: "string",
    required: true,
    description: "Task name or id.",
    cli_flag: Some("task"),
};
/// `task` on the tools that default to the caller's own task.
const P_TASK_SELF: ParamDef = ParamDef {
    name: "task",
    json_type: "string",
    required: false,
    description: "Task name or id. Omitted: your own task.",
    cli_flag: Some("task"),
};
const P_LIBRARY: ParamDef = ParamDef {
    name: "library",
    json_type: "string",
    required: false,
    description: "Prompt-library selector (see the prompts tool): a prompt id like builtin:review, or its exact title. Delivers that prompt's body; with prompt too, the body, a blank line, then prompt.",
    cli_flag: Some("--library"),
};
/// The scratchpad verbs take the task as `--task`, not a positional.
const P_PAD_TASK: ParamDef = ParamDef {
    name: "task",
    json_type: "string",
    required: false,
    description: "Task name or id. Omitted: your own task.",
    cli_flag: Some("--task"),
};
const P_SCHEDULE_TASK: ParamDef = ParamDef {
    name: "task",
    json_type: "string",
    required: false,
    description: "Task name or id. Omitted: your own task.",
    cli_flag: Some("task"),
};
const P_SCOPE: ParamDef = ParamDef {
    name: "scope",
    json_type: "string",
    required: false,
    description: "Target scope: 'task' (default), 'project', 'profile', or 'global'.",
    cli_flag: Some("--scope"),
};
const P_PROJECT: ParamDef = ParamDef {
    name: "project",
    json_type: "string",
    required: false,
    description: "Project name, to disambiguate same-named tasks.",
    cli_flag: Some("--project"),
};
const P_WAIT: ParamDef = ParamDef {
    name: "wait",
    json_type: "boolean",
    required: false,
    description: "Wait for the delivered prompt's turn to settle before returning.",
    cli_flag: Some("--wait"),
};
/// Targets ONE tab instead of the task's default. Same selector rules
/// the CLI uses: a tab id (as task_tab returns and task_status lists), a
/// 1-based strip index, or a title.
const P_TAB: ParamDef = ParamDef {
    name: "tab",
    json_type: "string",
    required: false,
    description: "Target one tab instead of the task's default: a tab id, a 1-based strip index, or a title. Omitted means the default tab.",
    cli_flag: Some("--tab"),
};
const P_TIMEOUT: ParamDef = ParamDef {
    name: "timeoutMs",
    json_type: "integer",
    required: false,
    description: "Wait budget in milliseconds, capped server-side at 300000. On timeout the task keeps running; call task_wait again to keep waiting.",
    cli_flag: Some("--timeout"),
};

/// The Phase A surface: full scope, registry order = wire order
/// (deterministic tool lists are a spec requirement). No attach (a TTY
/// stream is not a tool call), no quit. Every other CLI verb is either
/// here or in the test's EXCLUDED list with its reason.
const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "task_list",
        cli_verb: "list",
        description: "List tasks with work state and diff stats. Optionally filter to one project.",
        params: &[ParamDef {
            name: "project",
            json_type: "string",
            required: false,
            description: "Only this project's tasks.",
            cli_flag: Some("--project"),
        }, P_PEER],
        destructive: false,
        read_only: true,
        build: |a| Ok(Command::List { project: arg_str(a, "project")?, quiet: false }),
    },
    ToolDef {
        name: "task_status",
        cli_verb: "status",
        description: "One task in depth: state, branch, diff stat, tabs.",
        params: &[P_TASK, P_PROJECT],
        destructive: false,
        read_only: true,
        build: |a| Ok(Command::Status {
            task: Some(need_str(a, "task")?),
            project: arg_str(a, "project")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "task_new",
        cli_verb: "new",
        description: "Create a task, optionally spawn its agent with a first prompt, optionally wait for that prompt's turn to settle. With no mode, the app's last-used mode is applied, which may be the main checkout rather than a worktree: pass mode explicitly to be sure.",
        params: &[
            ParamDef { name: "name", json_type: "string", required: true, description: "Task (and branch) name.", cli_flag: Some("name") },
            ParamDef { name: "project", json_type: "string", required: false, description: "Project to create in (required when more than one is registered).", cli_flag: Some("--project") },
            ParamDef { name: "prompt", json_type: "string", required: false, description: "First prompt for the agent. From an agent: sign it as task_send says and ask for a report back (a task_send to your task id) every time it finishes or gets stuck, until a human tells it to stop.", cli_flag: Some("--prompt") },
            ParamDef { name: "agent", json_type: "string", required: false, description: "Agent CLI id (see the project's registry); default is the project's.", cli_flag: Some("--agent") },
            // The CLI splits this into --worktree/--main; the wire field
            // is one string, and a tool enum beats two mutually
            // exclusive booleans, so this param is MCP-shaped (no 1:1
            // CLI flag to assert against).
            ParamDef { name: "mode", json_type: "string", required: false, description: "\"worktree\" for a task on its own git worktree and branch, or \"main\" to work in the project's main checkout. Omitted means the app's last-used mode, so pass it when the answer matters.", cli_flag: None },
            ParamDef { name: "base", json_type: "string", required: false, description: "Base branch for a worktree task.", cli_flag: Some("--base") },
            ParamDef { name: "checkout", json_type: "string", required: false, description: "Existing branch to check out instead of creating one (local, or on the remote: fetched and tracked). Implies worktree mode.", cli_flag: Some("--checkout") },
            // Defaults to the caller's task (MCP_TASK_HEADER), the way the
            // CLI reads $TERMIC_TASK_ID; explicit to group under another.
            ParamDef { name: "parentTask", json_type: "string", required: false, description: "Group under this task instead of your own (the default when you run inside Termic).", cli_flag: None },
            ParamDef { name: "noGroup", json_type: "boolean", required: false, description: "Keep the new task out of your task group.", cli_flag: Some("--no-group") },
            P_LIBRARY,
            ParamDef { name: "model", json_type: "string", required: false, description: "Model for the new task's agent (appended after args, so it wins).", cli_flag: Some("--model") },
            ParamDef { name: "args", json_type: "array", required: false, description: "Extra argv for the new task's agent, one element per entry.", cli_flag: Some("--arg") },
            ParamDef { name: "from", json_type: "string", required: false, description: "Absolute path of an EXISTING registered git worktree to adopt as the task instead of creating one (no setup script runs; excludes mode and base).", cli_flag: Some("--from") },
            ParamDef { name: "resume", json_type: "string", required: false, description: "Session id the agent resumes on its first spawn (agents with id-resume support only).", cli_flag: Some("--resume") },
            ParamDef { name: "members", json_type: "array", required: false, description: "Multi-repo projects: member repos to include, by name. Each gets a worktree on the task branch; with mode \"main\", its live checkout is linked.", cli_flag: Some("--member") },
            ParamDef { name: "sandbox", json_type: "string", required: false, description: "off, monitor, enforce or enforce-fs; default the project's. enforce and enforce-fs deny the new agent this control plane, so it can never report back: ask it for a file in its worktree instead.", cli_flag: Some("--sandbox") },
            ParamDef { name: "yolo", json_type: "boolean", required: false, description: "Skip the agent's permission prompts (its YOLO flag). Unattended tasks need this or an enforcing sandbox, or they stop at the first prompt.", cli_flag: Some("--yolo") },
            ParamDef { name: "account", json_type: "string", required: false, description: "Agent account (Settings > Agents > credentials) the new task's agent runs on. Only when the user explicitly asked for a specific account; otherwise leave it out and the agent's default is used.", cli_flag: Some("--account") },
            ParamDef { name: "open", json_type: "boolean", required: false, description: "Select the new task in the window and raise it.", cli_flag: Some("--open") },
            P_WAIT,
            P_TIMEOUT,
            P_PEER,
        ],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::New {
            name: need_str(a, "name")?,
            prompt: arg_str(a, "prompt")?,
            prompt_ref: arg_str(a, "library")?,
            agent: arg_str(a, "agent")?,
            agent_args: proto::compose_task_agent_args(&arg_str_list(a, "args")?, arg_str(a, "model")?.as_deref()),
            mode: arg_str(a, "mode")?,
            base: arg_str(a, "base")?,
            checkout: arg_str(a, "checkout")?,
            from: arg_str(a, "from")?,
            resume: arg_str(a, "resume")?,
            sandbox: arg_str(a, "sandbox")?,
            yolo: arg_bool(a, "yolo")?,
            account: arg_str(a, "account")?,
            project: arg_str(a, "project")?,
            open: arg_bool(a, "open")?,
            wait: arg_bool(a, "wait")?,
            timeout_ms: arg_u64(a, "timeoutMs")?,
            cwd: None,
            // --no-group wins over the caller default AND an explicit parent.
            parent_task: if arg_bool(a, "noGroup")? { None } else { arg_str(a, "parentTask")? },
            pr: None,
            members: arg_str_list(a, "members")?,
        }),
    },
    ToolDef {
        name: "task_review",
        cli_verb: "review",
        description: "Review a pull request in a new task named review-pr-<n>: its branch checked out, an agent started on its details plus a code-review library prompt (the first tagged \"Code review\" unless library names one).",
        params: &[
            ParamDef { name: "pr", json_type: "string", required: true, description: "PR number or link.", cli_flag: Some("pr") },
            ParamDef { name: "project", json_type: "string", required: false, description: "Project the PR belongs to.", cli_flag: Some("--project") },
            ParamDef { name: "library", json_type: "string", required: false, description: "Review prompt id or title.", cli_flag: Some("--library") },
            ParamDef { name: "prompt", json_type: "string", required: false, description: "Text added after it.", cli_flag: Some("--prompt") },
            ParamDef { name: "agent", json_type: "string", required: false, description: "Agent CLI id.", cli_flag: Some("--agent") },
            ParamDef { name: "main", json_type: "boolean", required: false, description: "Use the main checkout, not a worktree.", cli_flag: Some("--main") },
            ParamDef { name: "noGroup", json_type: "boolean", required: false, description: "Keep it out of your task group.", cli_flag: Some("--no-group") },
            ParamDef { name: "sandbox", json_type: "string", required: false, description: "off, monitor, enforce or enforce-fs.", cli_flag: Some("--sandbox") },
            ParamDef { name: "yolo", json_type: "boolean", required: false, description: "The agent's YOLO flag.", cli_flag: Some("--yolo") },
            ParamDef { name: "open", json_type: "boolean", required: false, description: "Select and raise it.", cli_flag: Some("--open") },
            P_WAIT,
            P_TIMEOUT,
        ],
        destructive: false,
        read_only: false,
        build: |a| {
            // A number is accepted as well as the string the schema names:
            // an agent that read "PR 123" will pass 123.
            let pr = match a.get("pr") {
                Some(serde_json::Value::Number(n)) => n.as_u64().filter(|n| *n > 0),
                Some(serde_json::Value::String(s)) => proto::parse_pr_ref(s),
                None | Some(serde_json::Value::Null) => return Err("\"pr\" is required".into()),
                Some(_) => None,
            }
            .ok_or_else(|| "\"pr\" must be a pull request number or link".to_string())?;
            Ok(Command::New {
                name: String::new(),
                prompt: arg_str(a, "prompt")?,
                prompt_ref: arg_str(a, "library")?,
                agent: arg_str(a, "agent")?,
                agent_args: Vec::new(),
                mode: Some(if arg_bool(a, "main")? { "main" } else { "worktree" }.to_string()),
                base: None,
                checkout: None,
                from: None,
                resume: None,
                sandbox: arg_str(a, "sandbox")?,
                yolo: arg_bool(a, "yolo")?,
                account: None,
                project: arg_str(a, "project")?,
                open: arg_bool(a, "open")?,
                wait: arg_bool(a, "wait")?,
                timeout_ms: arg_u64(a, "timeoutMs")?,
                cwd: None,
                // Filled with the caller's task by with_caller_defaults.
                parent_task: if arg_bool(a, "noGroup")? { None } else { arg_str(a, "parentTask")? },
                pr: Some(pr),
                members: Vec::new(),
            })
        },
    },
    ToolDef {
        name: "task_send",
        cli_verb: "send",
        description: "Prompt the task's running agent, typed at once even mid-turn (queue waits for the turn to end; not while it waits on its subagents). With no agent running, resume restores the last session and fresh spawns a new one. Agent to agent: sign the prompt as the server instructions say ([message from agent:<you> task:<your task name> id:<your task id>] first, the same after -- last).",
        params: &[
            ParamDef { name: "task", json_type: "string", required: false, description: "Task name or id. Required unless here.", cli_flag: Some("task") },
            P_PROJECT,
            ParamDef { name: "here", json_type: "boolean", required: false, description: "Target your own task instead of naming one.", cli_flag: Some("--here") },
            ParamDef { name: "prompt", json_type: "string", required: false, description: "The prompt to deliver (required unless library).", cli_flag: Some("--prompt") },
            P_LIBRARY,
            ParamDef { name: "resume", json_type: "boolean", required: false, description: "No agent running: restore the last session, then deliver.", cli_flag: Some("--resume") },
            ParamDef { name: "fresh", json_type: "boolean", required: false, description: "No agent running: spawn a fresh agent, then deliver. Refused alongside tab, which targets something already open.", cli_flag: Some("--fresh") },
            P_TAB,
            ParamDef { name: "queue", json_type: "boolean", required: false, description: "Wait for the agent's turn to end instead of typing it in at once. For work that should not interrupt the turn in progress.", cli_flag: Some("--queue") },
            P_WAIT,
            P_TIMEOUT,
            P_PEER,
        ],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::Send {
            task: Some(need_str(a, "task")?),
            project: arg_str(a, "project")?,
            prompt: {
                let p = arg_str(a, "prompt")?.unwrap_or_default();
                if p.trim().is_empty() && arg_str(a, "library")?.is_none() {
                    return Err("\"prompt\" is required (or give \"library\")".into());
                }
                p
            },
            prompt_ref: arg_str(a, "library")?,
            resume: arg_bool(a, "resume")?,
            fresh: arg_bool(a, "fresh")?,
            wait: arg_bool(a, "wait")?,
            timeout_ms: arg_u64(a, "timeoutMs")?,
            tab: arg_str(a, "tab")?,
            // Immediate unless asked to queue; a legacy `now` is the default
            // now. resume/fresh spawn, so there is no turn to skip.
            now: !arg_bool(a, "queue")? && !arg_bool(a, "resume")? && !arg_bool(a, "fresh")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "task_wait",
        cli_verb: "wait",
        description: "Block until the task's agent is quiescent (settled turn, empty queue) or the timeout expires, whichever is first; returns {outcome, state}. Bounded: loop on outcome \"timeout\" to keep waiting. Settle detection is heuristic.",
        params: &[P_TASK, P_PROJECT, P_TAB, P_TIMEOUT, P_PEER],
        destructive: false,
        read_only: true,
        build: |a| Ok(Command::Wait {
            task: Some(need_str(a, "task")?),
            project: arg_str(a, "project")?,
            timeout_ms: arg_u64(a, "timeoutMs")?,
            tab: arg_str(a, "tab")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "task_result",
        cli_verb: "result",
        description: "The agent's last message, read from its session transcript.",
        params: &[P_TASK, P_PROJECT, P_PEER],
        destructive: false,
        read_only: true,
        build: |a| Ok(Command::LastResult {
            task: Some(need_str(a, "task")?),
            project: arg_str(a, "project")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "task_log",
        cli_verb: "logs",
        description: "Recent terminal output of the task's agent (or aux shell).",
        params: &[
            P_TASK,
            P_PROJECT,
            ParamDef { name: "shell", json_type: "boolean", required: false, description: "Read the aux terminal instead of the agent.", cli_flag: Some("--shell") },
            ParamDef { name: "lastBytes", json_type: "integer", required: false, description: "Cap the tail to this many bytes.", cli_flag: Some("--bytes") },
            P_TAB,
        ],
        destructive: false,
        read_only: true,
        build: |a| Ok(Command::Logs {
            task: Some(need_str(a, "task")?),
            project: arg_str(a, "project")?,
            shell: arg_bool(a, "shell")?,
            tab: arg_str(a, "tab")?,
            last_bytes: arg_u64(a, "lastBytes")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "task_diff",
        cli_verb: "diff",
        description: "Diff summary vs the base branch (counts and commits; full patch on request).",
        params: &[
            P_TASK,
            P_PROJECT,
            ParamDef { name: "full", json_type: "boolean", required: false, description: "Include the full unified diff text.", cli_flag: Some("--full") },
        ],
        destructive: false,
        read_only: true,
        build: |a| Ok(Command::Diff {
            task: Some(need_str(a, "task")?),
            project: arg_str(a, "project")?,
            full: arg_bool(a, "full")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "task_open",
        cli_verb: "open",
        description: "Raise the Termic window and select the task.",
        params: &[P_TASK, P_PROJECT],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::Open {
            task: Some(need_str(a, "task")?),
            project: arg_str(a, "project")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "task_rename",
        cli_verb: "rename",
        description: "Rename a task's sidebar label (branch and worktree keep their names).",
        params: &[
            P_TASK_SELF,
            P_PROJECT,
            ParamDef { name: "name", json_type: "string", required: true, description: "The new display name.", cli_flag: Some("name") },
        ],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::Rename {
            task: Some(need_str(a, "task")?),
            project: arg_str(a, "project")?,
            name: need_str(a, "name")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "task_group",
        cli_verb: "group",
        description: "Show, name or recolour a task's sidebar group (tasks you create join yours), or move a task in or out. Name it for the batch of work. An ungrouped task founds its group.",
        params: &[
            P_TASK_SELF,
            P_PROJECT,
            ParamDef { name: "name", json_type: "string", required: false, description: "Group name; \"\" follows the lead task's name.", cli_flag: Some("--name") },
            ParamDef { name: "color", json_type: "string", required: false, description: "red, orange, yellow, green, teal, blue, purple or pink.", cli_flag: Some("--color") },
            ParamDef { name: "join", json_type: "string", required: false, description: "Move it into this task's group (same project).", cli_flag: Some("--join") },
            ParamDef { name: "leave", json_type: "boolean", required: false, description: "Take it out of its group.", cli_flag: Some("--leave") },
        ],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::Group {
            task: Some(need_str(a, "task")?),
            project: arg_str(a, "project")?,
            name: arg_str(a, "name")?,
            color: arg_str(a, "color")?,
            cwd: None,
            // Filled in by `tools_call` from the task header: it is who is
            // asking, not an argument a caller passes.
            caller_task: None,
            join: arg_str(a, "join")?,
            leave: arg_bool(a, "leave")?,
        }),
    },
    // Scratchpads: the place for an agent's temporary output. The CLI's
    // `scratchpad` verbs, same wire commands, same "your own task" default.
    ToolDef {
        name: "scratchpad_new",
        cli_verb: "scratchpad new",
        description: "Create a scratchpad: a note that lives with the task but OUTSIDE the worktree, shown to the user as a tab that updates live. Use it for plans, findings, logs, reports and any other temporary output meant to be READ rather than committed, instead of writing throwaway .md files into the repo (nothing here reaches git). Returns the pad id, the stable selector.",
        params: &[
            P_PAD_TASK,
            P_PROJECT,
            P_SCOPE,
            ParamDef { name: "title", json_type: "string", required: false, description: "A fixed tab title (else it is named after its first line).", cli_flag: Some("--title") },
            ParamDef { name: "content", json_type: "string", required: false, description: "Initial text.", cli_flag: Some("--content") },
        ],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::PadNew {
            task: arg_str(a, "task")?,
            project: arg_str(a, "project")?,
            scope: arg_str(a, "scope")?,
            title: arg_str(a, "title")?,
            content: arg_str(a, "content")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "scratchpad_write",
        cli_verb: "scratchpad write",
        description: "Replace a scratchpad's text, or append to it (append suits progress logs). An open pad updates in place, so the user watches it fill.",
        params: &[
            ParamDef { name: "pad", json_type: "string", required: true, description: "Pad id, or its exact title (case-insensitive).", cli_flag: Some("pad") },
            P_PAD_TASK,
            P_PROJECT,
            P_SCOPE,
            ParamDef { name: "content", json_type: "string", required: true, description: "The text.", cli_flag: Some("--content") },
            ParamDef { name: "append", json_type: "boolean", required: false, description: "Add to the end instead of replacing.", cli_flag: Some("--append") },
        ],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::PadWrite {
            task: arg_str(a, "task")?,
            project: arg_str(a, "project")?,
            scope: arg_str(a, "scope")?,
            pad: need_str(a, "pad")?,
            content: need_str(a, "content")?,
            append: arg_bool(a, "append")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "scratchpad_read",
        cli_verb: "scratchpad read",
        description: "Read a scratchpad's text as the window shows it, including edits the user has not paused on yet (a user may leave you notes there).",
        params: &[
            ParamDef { name: "pad", json_type: "string", required: true, description: "Pad id, or its exact title (case-insensitive).", cli_flag: Some("pad") },
            P_PAD_TASK,
            P_PROJECT,
            P_SCOPE,
        ],
        destructive: false,
        read_only: true,
        build: |a| Ok(Command::PadRead {
            task: arg_str(a, "task")?,
            project: arg_str(a, "project")?,
            scope: arg_str(a, "scope")?,
            pad: need_str(a, "pad")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "scratchpad_list",
        cli_verb: "scratchpad list",
        description: "List a task's scratchpads: id, title, and whether each is open in the window.",
        params: &[P_PAD_TASK, P_PROJECT, P_SCOPE],
        destructive: false,
        read_only: true,
        build: |a| Ok(Command::PadList {
            task: arg_str(a, "task")?,
            project: arg_str(a, "project")?,
            scope: arg_str(a, "scope")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "scratchpad_remove",
        cli_verb: "scratchpad rm",
        description: "Delete one scratchpad for good (no undo). Only pads you created or were asked to remove.",
        params: &[
            ParamDef { name: "pad", json_type: "string", required: true, description: "Pad id, or its exact title (case-insensitive).", cli_flag: Some("pad") },
            P_PAD_TASK,
            P_PROJECT,
            P_SCOPE,
        ],
        destructive: true,
        read_only: false,
        build: |a| Ok(Command::PadRemove {
            task: arg_str(a, "task")?,
            project: arg_str(a, "project")?,
            scope: arg_str(a, "scope")?,
            pad: need_str(a, "pad")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "scratchpad_clear",
        cli_verb: "scratchpad clear",
        description: "Delete every scratchpad in the target for good (no undo). A shared scope holds the user's notes: only when asked.",
        params: &[P_PAD_TASK, P_PROJECT, P_SCOPE],
        destructive: true,
        read_only: false,
        build: |a| Ok(Command::PadClear {
            task: arg_str(a, "task")?,
            project: arg_str(a, "project")?,
            scope: arg_str(a, "scope")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "task_apply",
        cli_verb: "apply",
        description: "Bring the task worktree's cumulative diff into the project's main checkout as uncommitted changes.",
        params: &[P_TASK, P_PROJECT],
        destructive: true,
        read_only: false,
        build: |a| Ok(Command::Apply {
            task: need_str(a, "task")?,
            project: arg_str(a, "project")?,
        }),
    },
    ToolDef {
        name: "task_archive",
        cli_verb: "archive",
        description: "Archive a task. Live agent processes are killed first.",
        params: &[P_TASK, P_PROJECT],
        destructive: true,
        read_only: false,
        build: |a| Ok(Command::Archive {
            task: need_str(a, "task")?,
            project: arg_str(a, "project")?,
        }),
    },
    ToolDef {
        name: "task_tab",
        cli_verb: "tab",
        description: "Open a tab inside a running task (the app's \"+\" menu as a tool), optionally delivering a first prompt to it. Returns the new tab's id, which is the stable selector other tools take. With `tab`, renames an open tab instead.",
        params: &[
            P_TASK_SELF,
            P_PROJECT,
            // The kind is explicit rather than free text because the
            // kinds differ in sandbox, resume and YOLO behaviour, and a
            // typo must not land the caller in the wrong semantics.
            ParamDef { name: "kind", json_type: "string", required: false, description: "When opening: \"agent\" (needs agentId), \"terminal\" (needs agentId naming a terminal entry), \"shell\" for a plain login shell, or \"default\" for another tab of whatever the task already runs.", cli_flag: None },
            ParamDef { name: "agentId", json_type: "string", required: false, description: "Registry id for the agent and terminal kinds; see task_agents. Ignored by the other kinds.", cli_flag: Some("--agent") },
            ParamDef { name: "prompt", json_type: "string", required: false, description: "Deliver this prompt into the tab just opened (agent kinds only). From an agent: sign it as task_send says and ask for a report back (a task_send to your task id) every time it finishes or gets stuck, until a human tells it to stop.", cli_flag: Some("--prompt") },
            ParamDef { name: "model", json_type: "string", required: false, description: "Model override for this tab only. Requires agent kind; passed after args.", cli_flag: Some("--model") },
            ParamDef { name: "args", json_type: "array", required: false, description: "Additional argv strings for this tab only, such as provider-specific reasoning settings. Requires agent kind.", cli_flag: Some("--arg") },
            P_LIBRARY,
            ParamDef { name: "resume", json_type: "string", required: false, description: "Session id the new agent tab resumes (agents with id-resume support only).", cli_flag: Some("--resume") },
            P_WAIT,
            P_TIMEOUT,
            ParamDef { name: "title", json_type: "string", required: false, description: "The tab's title; the agent retitling itself does not replace it, so it works as a selector. Unique in the task, not a bare number. \"\" = the automatic title.", cli_flag: Some("--title") },
            ParamDef { name: "tab", json_type: "string", required: false, description: "Rename this open tab (id, 1-based index or title) to `title` instead of opening one.", cli_flag: Some("--tab") },
        ],
        destructive: false,
        read_only: false,
        build: |a| {
            // Rename mode (GH #331): a tab selector turns the call into the
            // tab strip's rename, which opens nothing.
            if let Some(tab) = arg_str(a, "tab")? {
                for open_only in ["kind", "agentId", "prompt", "library", "resume", "wait", "timeoutMs", "model", "args"] {
                    if a.get(open_only).is_some_and(|v| !v.is_null()) {
                        return Err(format!(
                            "\"{open_only}\" applies to opening a tab; with \"tab\" the call renames an open one"
                        ));
                    }
                }
                return Ok(Command::TabRename {
                    task: Some(need_str(a, "task")?),
                    project: arg_str(a, "project")?,
                    tab,
                    title: arg_str(a, "title")?
                        .ok_or("\"title\" is required with \"tab\" (\"\" for the automatic title)")?,
                    cwd: None,
                });
            }
            let kind = need_str(a, "kind")?;
            let agent_id = arg_str(a, "agentId")?;
            let need_id = |k: &str| -> Result<String, String> {
                agent_id.clone().ok_or_else(|| format!("\"agentId\" is required for kind \"{k}\""))
            };
            let kind = match kind.as_str() {
                "agent" => proto::TabKind::Agent { id: need_id("agent")? },
                "terminal" => proto::TabKind::Terminal { id: need_id("terminal")? },
                "shell" => proto::TabKind::Shell,
                "default" => proto::TabKind::Default,
                other => {
                    return Err(format!(
                        "\"kind\" must be one of agent, terminal, shell, default (got \"{other}\")"
                    ))
                }
            };
            Ok(Command::Tab {
                agent_args: proto::compose_task_agent_args(&arg_str_list(a, "args")?, arg_str(a, "model")?.as_deref()),
                task: Some(need_str(a, "task")?),
                project: arg_str(a, "project")?,
                kind,
                prompt: arg_str(a, "prompt")?,
                prompt_ref: arg_str(a, "library")?,
                wait: arg_bool(a, "wait")?,
                timeout_ms: arg_u64(a, "timeoutMs")?,
                resume: arg_str(a, "resume")?,
                // "" is "no title" on open; the wire carries only a real one.
                title: arg_str(a, "title")?.filter(|t| !t.is_empty()),
                cwd: None,
            })
        },
    },
    ToolDef {
        name: "task_tab_close",
        cli_verb: "tab close",
        description: "Close one tab of a running task, killing its process.",
        params: &[
            P_TASK,
            P_PROJECT,
            ParamDef { name: "tab", json_type: "string", required: true, description: "Which tab: a tab id, a 1-based strip index, or a title. Required, because there is no obvious tab to close by default and guessing would be the destructive direction.", cli_flag: Some("--tab") },
            ParamDef { name: "allowDefault", json_type: "boolean", required: false, description: "Permit closing the DEFAULT tab, the one unqualified task_send and task_wait resolve to. Refused without this even when its agent already exited, because the refusal is about what else is addressing that tab.", cli_flag: Some("--yes") },
        ],
        destructive: true,
        read_only: false,
        build: |a| Ok(Command::TabClose {
            task: Some(need_str(a, "task")?),
            project: arg_str(a, "project")?,
            tab: need_str(a, "tab")?,
            yes: arg_bool(a, "allowDefault")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "task_prop",
        cli_verb: "prop",
        description: "Tab properties shown on the task's sidebar row (ticket=ABC-1). key+value+tab sets (\"\" clears); otherwise lists.",
        params: &[
            // A flag on the CLI (`prop <key> <value>` takes the positionals).
            ParamDef { name: "task", json_type: "string", required: false, description: "Omitted: your own task.", cli_flag: Some("--task") },
            P_PROJECT,
            ParamDef { name: "key", json_type: "string", required: false, description: "[a-z0-9_-], max 32.", cli_flag: Some("key") },
            ParamDef { name: "value", json_type: "string", required: false, description: "One line, max 40.", cli_flag: Some("value") },
            ParamDef { name: "tab", json_type: "string", required: false, description: "Tab id, index or title.", cli_flag: Some("--tab") },
        ],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::Prop {
            task: Some(need_str(a, "task")?),
            project: arg_str(a, "project")?,
            tab: arg_str(a, "tab")?,
            key: arg_str(a, "key")?,
            value: arg_str(a, "value")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "task_agents",
        cli_verb: "agents",
        description: "List the agent CLIs this app can run: the ids task_new and task_tab accept, with whether each is installed and usable, and each agent's named accounts (what task_new's account takes) with the default. Without this a caller has to guess an agent id and read the refusal.",
        params: &[],
        destructive: false,
        read_only: true,
        build: |_| Ok(Command::Agents),
    },
    ToolDef {
        name: "prompts",
        cli_verb: "prompts",
        description: "The prompt library: list the saved prompts (ids, titles, no bodies), or pass a selector to resolve one and get its body.",
        params: &[ParamDef {
            name: "selector",
            json_type: "string",
            required: false,
            description: "Resolve ONE prompt and include its body: an exact id (builtin:review, a custom prompt's UUID) or its exact title, case-insensitive. Omitted lists the library.",
            // The CLI puts this on a `prompts show` subcommand; the wire
            // is one command with an optional selector, and the tool
            // mirrors the wire rather than the CLI's menu shape.
            cli_flag: None,
        }],
        destructive: false,
        read_only: true,
        build: |a| Ok(Command::Prompts { selector: arg_str(a, "selector")? }),
    },
    ToolDef {
        name: "project_list",
        cli_verb: "project list",
        description: "Registered projects with live-task counts.",
        params: &[],
        destructive: false,
        read_only: true,
        build: |_| Ok(Command::ProjectList),
    },
    ToolDef {
        name: "project_add",
        cli_verb: "project add",
        description: "Register a directory as a project (absolute path).",
        params: &[
            ParamDef { name: "path", json_type: "string", required: true, description: "Absolute path to the repo (or folder with nonGit).", cli_flag: Some("path") },
            ParamDef { name: "nonGit", json_type: "boolean", required: false, description: "Allow a plain non-git folder.", cli_flag: Some("--non-git") },
        ],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::ProjectAdd {
            path: need_str(a, "path")?,
            non_git: arg_bool(a, "nonGit")?,
        }),
    },
    ToolDef {
        name: "project_remove",
        cli_verb: "project remove",
        description: "Unregister a project. Archives and deletes ALL its tasks.",
        params: &[ParamDef {
            name: "name",
            json_type: "string",
            required: true,
            description: "Project name.",
            cli_flag: Some("name"),
        }],
        destructive: true,
        read_only: false,
        build: |a| Ok(Command::ProjectRemove { name: need_str(a, "name")? }),
    },
    ToolDef {
        name: "schedule_list",
        cli_verb: "schedule list",
        description: "List recurring schedules with cadence, enabled state, next run, and last outcome. Optionally filter to one project.",
        params: &[ParamDef {
            name: "project",
            json_type: "string",
            required: false,
            description: "Only this project's schedules.",
            cli_flag: Some("--project"),
        }],
        destructive: false,
        read_only: true,
        build: |a| Ok(Command::ScheduleList { project: arg_str(a, "project")? }),
    },
    ToolDef {
        name: "schedule_show",
        cli_verb: "schedule show",
        description: "Detailed schedule information for a task: cadence, status, full run history, and report files.",
        params: &[P_SCHEDULE_TASK, P_PROJECT],
        destructive: false,
        read_only: true,
        build: |a| Ok(Command::ScheduleShow {
            task: arg_str(a, "task")?,
            project: arg_str(a, "project")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "schedule_set",
        cli_verb: "schedule set",
        description: "Create or update a recurring schedule on a parent task (cadence, prompt, retention, enable/disable).",
        params: &[
            P_SCHEDULE_TASK,
            P_PROJECT,
            ParamDef { name: "name", json_type: "string", required: false, description: "Schedule display name (defaults to the task name).", cli_flag: Some("--name") },
            ParamDef { name: "cadence", json_type: "string", required: false, description: "\"daily\", \"weekdays\", \"weekly\", or \"once\" (with date).", cli_flag: Some("--cadence") },
            ParamDef { name: "time", json_type: "string", required: false, description: "Local wall-clock time in \"HH:MM\" 24-hour format.", cli_flag: Some("--time") },
            ParamDef { name: "weekday", json_type: "integer", required: false, description: "Day of week for weekly cadence: 0 (Sunday) to 6 (Saturday).", cli_flag: Some("--weekday") },
            ParamDef { name: "date", json_type: "string", required: false, description: "YYYY-MM-DD, for once.", cli_flag: Some("--date") },
            ParamDef { name: "prompt", json_type: "string", required: false, description: "Prompt to inject on each run.", cli_flag: Some("--prompt") },
            P_LIBRARY,
            ParamDef { name: "keepRuns", json_type: "integer", required: false, description: "Number of past run tasks to retain (1 to 20, default 7).", cli_flag: Some("--keep-runs") },
            ParamDef { name: "reportDays", json_type: "integer", required: false, description: "Days to keep report files (7, 30, 90, or 0 for forever).", cli_flag: Some("--report-days") },
            ParamDef { name: "catchUp", json_type: "boolean", required: false, description: "Run missed slots after app downtime.", cli_flag: Some("--catch-up") },
            ParamDef { name: "enabled", json_type: "boolean", required: false, description: "Whether the schedule is enabled.", cli_flag: Some("--enable") },
        ],
        destructive: true,
        read_only: false,
        build: |a| {
            let date = arg_str(a, "date")?;
            if let Some(why) = proto::schedule_date_problem(arg_str(a, "cadence")?.as_deref(), date.as_deref()) {
                return Err(why.to_string());
            }
            let cadence = match (arg_str(a, "cadence")?, arg_str(a, "time")?) {
                (Some(kind), Some(time)) => {
                    let weekday = match arg_u64(a, "weekday")? {
                        Some(w @ 0..=6) => Some(w as u8),
                        Some(w) => return Err(format!("\"weekday\" must be between 0 (Sunday) and 6 (Saturday), got {w}")),
                        None => None,
                    };
                    Some(proto::ScheduleCadence {
                        kind,
                        time,
                        weekday,
                        date,
                    })
                }
                (None, None) => None,
                _ => return Err("both cadence and time are required when setting cadence".to_string()),
            };
            let report_days = match arg_u64(a, "reportDays")? {
                Some(0) => Some(None),
                Some(n) => Some(Some(n as u32)),
                None => None,
            };
            Ok(Command::ScheduleSet {
                task: arg_str(a, "task")?,
                project: arg_str(a, "project")?,
                name: arg_str(a, "name")?,
                cadence,
                prompt: arg_str(a, "prompt")?,
                prompt_ref: arg_str(a, "library")?,
                keep_runs: arg_u64(a, "keepRuns")?.map(|k| k as u32),
                report_days,
                catch_up: arg_opt_bool(a, "catchUp")?,
                enabled: arg_opt_bool(a, "enabled")?,
                cwd: None,
            })
        },
    },
    ToolDef {
        name: "schedule_run",
        cli_verb: "schedule run",
        description: "Trigger an immediate out-of-band run of a schedule (\"Run now\"). Refused while a previous run is still going.",
        params: &[P_SCHEDULE_TASK, P_PROJECT],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::ScheduleRun {
            task: arg_str(a, "task")?,
            project: arg_str(a, "project")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "schedule_delete",
        cli_verb: "schedule delete",
        description: "Remove a schedule from a task, optionally deleting historical reports.",
        params: &[
            P_SCHEDULE_TASK,
            P_PROJECT,
            ParamDef { name: "deleteReports", json_type: "boolean", required: false, description: "Delete report files on disk in addition to removing the schedule.", cli_flag: Some("--delete-reports") },
            ParamDef { name: "archiveTasks", json_type: "boolean", required: false, description: "Archive related tasks and delete reports.", cli_flag: Some("--archive-tasks") },
        ],
        destructive: true,
        read_only: false,
        build: |a| Ok(Command::ScheduleDelete {
            task: arg_str(a, "task")?,
            project: arg_str(a, "project")?,
            delete_reports: arg_bool(a, "deleteReports")?,
            archive_tasks: arg_bool(a, "archiveTasks")?,
            cwd: None,
        }),
    },
    // LAN pairing (docs/peers.md). peer_call is the MCP form of the CLI's
    // global --peer flag; the other four are the `termic peer` verbs.
    ToolDef {
        name: PEER_CALL,
        cli_verb: GLOBAL_PEER_FLAG,
        description: "Run another tool on a PAIRED machine (peer_list) instead of here. Ask the agent you prompt there to reply through peer_call to this machine, naming your task id.",
        params: &[
            ParamDef { name: "peer", json_type: "string", required: true, description: "Paired machine: its name or id.", cli_flag: Some("--peer") },
            ParamDef { name: "tool", json_type: "string", required: true, description: "Tool to run there, e.g. task_new.", cli_flag: None },
            ParamDef { name: "arguments", json_type: "object", required: false, description: "That tool's arguments.", cli_flag: None },
        ],
        destructive: false,
        read_only: false,
        build: |_| Err("peer_call is dispatched in tools_call".into()),
    },
    ToolDef {
        name: "peer_list",
        cli_verb: "peer list",
        description: "This machine's name, its paired machines, and unpaired ones in sight.",
        params: &[],
        destructive: false,
        read_only: true,
        build: |_| Ok(Command::PeerList),
    },
    ToolDef {
        name: "peer_pair",
        cli_verb: "peer pair",
        description: "Pair with a machine in pairing mode, using the 4-digit code its screen shows (ask the person for it).",
        params: &[
            ParamDef { name: "target", json_type: "string", required: true, description: "Name or id from peer_list, or ip[:port].", cli_flag: Some("target") },
            ParamDef { name: "code", json_type: "string", required: true, description: "The 4 digits the other machine shows.", cli_flag: Some("code") },
        ],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::PeerPair { target: need_str(a, "target")?, code: need_str(a, "code")? }),
    },
    ToolDef {
        name: "peer_unpair",
        cli_verb: "peer unpair",
        description: "Forget a paired machine here and tell it to forget this one.",
        params: &[ParamDef { name: "peer", json_type: "string", required: true, description: "Its name or id.", cli_flag: Some("peer") }],
        destructive: true,
        read_only: false,
        build: |a| Ok(Command::PeerUnpair { target: need_str(a, "peer")? }),
    },
    ToolDef {
        name: "peer_rename",
        cli_verb: "peer rename",
        description: "Local name for a paired machine (empty: its own).",
        params: &[
            ParamDef { name: "peer", json_type: "string", required: true, description: "Its name or id.", cli_flag: Some("peer") },
            ParamDef { name: "name", json_type: "string", required: true, description: "New name.", cli_flag: Some("name") },
        ],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::PeerRename { target: need_str(a, "peer")?, name: need_str(a, "name")? }),
    },
];

fn tool_schema(t: &ToolDef) -> serde_json::Value {
    let mut props = serde_json::Map::new();
    let mut required = Vec::new();
    for p in t.params {
        let mut schema = serde_json::json!({ "type": p.json_type, "description": p.description });
        // The only array param shape we have: a list of strings.
        if p.json_type == "array" {
            schema["items"] = serde_json::json!({ "type": "string" });
        }
        props.insert(p.name.into(), schema);
        if p.required {
            required.push(serde_json::Value::String(p.name.into()));
        }
    }
    serde_json::json!({
        "type": "object",
        "properties": props,
        "required": required,
        "additionalProperties": false,
    })
}

fn tool_entry(t: &ToolDef) -> serde_json::Value {
    let mut entry = serde_json::json!({
        "name": t.name,
        "description": t.description,
        "inputSchema": tool_schema(t),
    });
    let mut ann = serde_json::Map::new();
    if t.read_only {
        ann.insert("readOnlyHint".into(), true.into());
    } else {
        // Only meaningful when readOnlyHint is false, and its documented
        // default is TRUE: omitting it on task_send or project_add tells
        // a conforming client those ordinary calls are destructive, so
        // it may prompt for or block them. State it either way.
        ann.insert("destructiveHint".into(), t.destructive.into());
    }
    if !ann.is_empty() {
        entry["annotations"] = serde_json::Value::Object(ann);
    }
    entry
}

fn tools_list(id: serde_json::Value) -> (u16, Vec<u8>) {
    let tools: Vec<_> = TOOLS.iter().map(tool_entry).collect();
    rpc_result(id, with_cache_hints(serde_json::json!({ "tools": tools })))
}

/// Bound every wait-shaped dispatch. Absent = the cap (a caller that
/// asked to wait gets the longest bounded wait, not an unbounded one).
pub(crate) fn clamp_wait(cmd: &mut Command) {
    match cmd {
        Command::Wait { timeout_ms, .. } => {
            *timeout_ms = Some(timeout_ms.unwrap_or(MCP_WAIT_CAP_MS).min(MCP_WAIT_CAP_MS));
        }
        Command::New { wait, timeout_ms, .. }
        | Command::Send { wait, timeout_ms, .. }
        | Command::Tab { wait, timeout_ms, .. }
            if *wait =>
        {
            *timeout_ms = Some(timeout_ms.unwrap_or(MCP_WAIT_CAP_MS).min(MCP_WAIT_CAP_MS));
        }
        _ => {}
    }
}

/// Stream events are dropped: only the final Reply matters to a tool
/// call, and there is no client-gone signal to propagate (the wait cap
/// bounds an orphaned connection's thread instead).
pub(crate) struct NoopSink;

impl cli_server::EventSink for NoopSink {
    fn emit(&mut self, _ev: &proto::StreamEvent) -> std::io::Result<()> {
        Ok(())
    }
}

fn tools_call(server: &McpServer, id: serde_json::Value, params: &serde_json::Value, caller: Option<&str>) -> (u16, Vec<u8>) {
    let Some(name) = params.get("name").and_then(|n| n.as_str()) else {
        return rpc_error(id, 200, -32602, "params.name is required");
    };
    let Some(tool) = TOOLS.iter().find(|t| t.name == name) else {
        return rpc_error(id, 200, -32602, &format!("unknown tool \"{name}\""));
    };
    let empty = Args::new();
    let args = match params.get("arguments") {
        None | Some(serde_json::Value::Null) => &empty,
        Some(serde_json::Value::Object(o)) => o,
        Some(_) => return rpc_error(id, 200, -32602, "params.arguments must be an object"),
    };
    // `peer_call`: another tool, run on a paired machine (peers.rs). Its
    // inner arguments are validated HERE, against the same registry, so a
    // typo fails before anything crosses the network.
    let (cmd, peer) = if tool.name == PEER_CALL {
        match peer_call_command(args) {
            Ok(x) => (x.0, Some(x.1)),
            Err(msg) => return rpc_error(id, 200, -32602, &msg),
        }
    } else if let Some(peer) = PEER_PARAM_TOOLS.contains(&tool.name).then(|| args.get("peer")).flatten() {
        // `task_new {peer: "laptop", ...}` is `peer_call {peer: "laptop",
        // tool: "task_new", arguments: {...}}`, spelled where it is used.
        let Some(peer) = peer.as_str().filter(|p| !p.trim().is_empty()) else {
            return rpc_error(id, 200, -32602, "\"peer\" must be a machine's name or id");
        };
        let mut inner = args.clone();
        inner.remove("peer");
        match build_call(tool, &inner, None) {
            Ok(c) => (c, Some(peer.to_string())),
            Err(msg) => return rpc_error(id, 200, -32602, &msg),
        }
    } else {
        match build_call(tool, args, caller) {
            Ok(c) => (c, None),
            Err(msg) => return rpc_error(id, 200, -32602, &msg),
        }
    };
    let req = Request {
        id: match &id {
            serde_json::Value::String(s) => format!("mcp-{s}"),
            other => format!("mcp-{other}"),
        },
        token: None,
        // MCP has no --profile flag of its own; a tool call routes the same
        // way an unflagged CLI request does (by the task or project it names).
        profile: None,
        // The caller's task rides along to a peer so that machine may reply
        // into it (the CLI sends $TERMIC_TASK_ID the same way).
        from_task: peer.as_ref().and(caller.map(str::to_string)),
        peer,
        cmd,
    };
    let reply = cli_server::dispatch_authenticated(&req, server.host.as_ref(), &mut NoopSink);
    rpc_result(id, tool_reply_payload(reply))
}

/// One tool call's arguments, validated and built into the wire command:
/// the strict-argument rule, the caller's own-task defaults, the wait cap.
fn build_call(tool: &ToolDef, args: &Args, caller: Option<&str>) -> Result<Command, String> {
    // Every schema advertises `additionalProperties: false`; enforce it
    // rather than trusting clients to validate. Silently ignoring a typo
    // like `timeoutMS` would change behaviour without saying so (that
    // one turns a short wait into the five-minute cap).
    if let Some(unknown) = args.keys().find(|k| !tool.params.iter().any(|p| p.name == k.as_str())) {
        return Err(format!("unknown argument \"{unknown}\" for tool \"{}\"", tool.name));
    }
    // The CLI's "your own task" defaults, from the caller's task header. An
    // argument the caller passed always wins; nothing is filled without it.
    let args = with_caller_defaults(tool.name, args, caller);
    if SELF_DEFAULT_TOOLS.contains(&tool.name) && !args.contains_key("task") {
        return Err(
            "name the task: this client did not say which Termic task it runs in (re-run Termic's MCP setup for your client to have it send that)".into(),
        );
    }
    let mut cmd = (tool.build)(&args)?;
    clamp_wait(&mut cmd);
    // Who is asking, for the one verb where that changes what happens: an
    // agent inside a task is never merged into another group by name.
    if let Command::Group { caller_task, .. } = &mut cmd {
        *caller_task = caller.map(str::to_string);
    }
    Ok(cmd)
}

const PEER_CALL: &str = "peer_call";

/// `peer_call {peer, tool, arguments}` -> (the inner tool's command, peer).
/// No caller defaults inside: "your own task" means a task on THIS machine,
/// which the other one does not have, so a self-defaulting tool must name
/// its task there explicitly.
fn peer_call_command(args: &Args) -> Result<(Command, String), String> {
    if let Some(unknown) = args.keys().find(|k| !["peer", "tool", "arguments"].contains(&k.as_str())) {
        return Err(format!("unknown argument \"{unknown}\" for tool \"{PEER_CALL}\""));
    }
    let peer = need_str(args, "peer")?;
    let name = need_str(args, "tool")?;
    if name.starts_with("peer_") {
        return Err(format!("{name} acts on this machine; call it directly, not through peer_call"));
    }
    let tool = TOOLS
        .iter()
        .find(|t| t.name == name)
        .ok_or_else(|| format!("unknown tool \"{name}\" (peer_call runs any tool from tools/list)"))?;
    let empty = Args::new();
    let inner = match args.get("arguments") {
        None | Some(serde_json::Value::Null) => &empty,
        Some(serde_json::Value::Object(o)) => o,
        Some(_) => return Err("\"arguments\" must be an object".into()),
    };
    if SELF_DEFAULT_TOOLS.contains(&tool.name) && !inner.contains_key("task") {
        return Err(format!("name the task: {name} on another machine has no task of yours to default to"));
    }
    Ok((build_call(tool, inner, None)?, peer))
}

/// Tools whose `task` defaults to the caller's own, as the CLI's `rename`,
/// `group` and `tab` default to `$TERMIC_TASK_ID`.
const SELF_DEFAULT_TOOLS: &[&str] = &[
    "task_rename", "task_group", "task_tab", "task_prop",
    "scratchpad_new", "scratchpad_write", "scratchpad_read", "scratchpad_list",
    "scratchpad_remove", "scratchpad_clear",
    "schedule_show", "schedule_set", "schedule_run", "schedule_delete",
];

/// `args` with the caller's task filled in where the CLI would have used
/// `$TERMIC_TASK_ID`: `task_new`'s parent (grouping) and the self-targeting
/// tools' `task`. Only absent keys are filled.
fn with_caller_defaults(tool: &str, args: &Args, caller: Option<&str>) -> Args {
    let mut out = args.clone();
    let Some(caller) = caller else { return out };
    let key = match tool {
        "task_new" | "task_review" => "parentTask",
        // `send --here`: the caller's own task, only when asked for.
        "task_send" if args.get("here").and_then(|v| v.as_bool()) == Some(true) => "task",
        t if SELF_DEFAULT_TOOLS.contains(&t) => "task",
        _ => return out,
    };
    out.entry(key.to_string()).or_insert_with(|| serde_json::Value::String(caller.to_string()));
    out
}

/// Map a dispatch Reply onto the tools/call result PAYLOAD; the shared
/// envelope is added by `rpc_result`. Dispatch failures are
/// TOOL results with isError, never JSON-RPC errors: the protocol
/// exchange succeeded, the verb refused (MCP convention).
fn tool_reply_payload(reply: proto::Reply) -> serde_json::Value {
    let (is_error, structured, text) = if reply.ok {
        let structured = reply
            .data
            .map(|d| serde_json::to_value(d).unwrap_or(serde_json::Value::Null))
            .unwrap_or(serde_json::json!({}));
        let text = structured.to_string();
        (false, structured, text)
    } else {
        let err = reply.error.expect("err reply carries an error body");
        let text = err.message.clone();
        let structured = serde_json::to_value(&err).unwrap_or(serde_json::Value::Null);
        (true, structured, text)
    };
    serde_json::json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": structured,
        "isError": is_error,
    })
}

// ───────────────────────────── lifecycle ─────────────────────────────

struct McpHandle {
    port: u16,
    /// What this listener was bound to, so a changed setting is noticed.
    addr: IpAddr,
    shutdown: Arc<AtomicBool>,
    /// Fires when the accept loop has returned and the socket is gone.
    stopped: Option<mpsc::Receiver<()>>,
}

#[derive(Default)]
struct McpState {
    handle: Option<McpHandle>,
    /// Signalled once a retired listener's accept loop has returned and
    /// dropped its socket. Teardown does not join the thread (that would
    /// block the UI thread on the synchronous settings_save), so the
    /// port can still be held for a moment; the NEXT bind waits on this
    /// receiver, which is where losing the port would actually matter.
    /// A channel rather than a sleep-poll: one bounded blocking wait,
    /// the same shape as the condvar parks elsewhere in the app, not a
    /// loop that wakes the CPU (CLAUDE.md's Rust poll-loop trap).
    stopped: Option<mpsc::Receiver<()>>,
    /// Port to prefer on the next bind, surviving disable/enable within
    /// one run. Across restarts the mcp-port file serves the same role.
    last_port: Option<u16>,
    /// Why the last bind did not happen, for Settings. None while serving
    /// or switched off.
    bind_error: Option<String>,
}

fn state() -> &'static Mutex<McpState> {
    static STATE: OnceLock<Mutex<McpState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(McpState::default()))
}

/// Bind the advertised port, preferring `preferred` so client configs
/// survive, or a fresh one when there is nothing to reclaim. `Err(PortTaken)` when a port we previously advertised is
/// held by someone else, which is NOT a case to paper over: see
/// apply_enabled.
fn bind_listener(preferred: Option<u16>, addr: IpAddr) -> Result<TcpListener, BindFailure> {
    match preferred.filter(|p| *p != 0) {
        Some(p) => TcpListener::bind((addr, p)).map_err(|e| bind_failure(e, p)),
        // Never an OS-assigned port when one of ours is free: the OS hands
        // out the dynamic range, which is the one Windows later reserves
        // out from under us (see bind_failure).
        // into_iter(): `find_map` takes `&mut self`, and calling it on the
        // const itself mutates a temporary copy, which rustc warns about.
        None => AUTO_PORTS
            .into_iter()
            .find_map(|p| TcpListener::bind((addr, p)).ok())
            .map_or_else(|| TcpListener::bind((addr, 0)).map_err(BindFailure::Io), Ok),
    }
}

/// Where an unset port is picked from. Below every platform's dynamic
/// range (Linux starts at 32768, macOS and Windows at 49152) and clear of
/// the task port allocator, which starts at 18100.
const AUTO_PORTS: std::ops::RangeInclusive<u16> = 23517..=23616;

/// Why a bind to a specific port failed. Only "in use" is a squatter.
fn bind_failure(e: std::io::Error, port: u16) -> BindFailure {
    match e.kind() {
        // An address this machine does not have is a wrong setting,
        // not a squatter on our port: report it as what it is.
        std::io::ErrorKind::AddrNotAvailable => BindFailure::Io(e),
        // Windows answers WSAEACCES for a port inside an excluded range.
        // Hyper-V (WSL, Docker) reserves blocks of 100 in 49152-65535 and
        // reshuffles them on boot, so a port there works for days and
        // then cannot be bound by anyone, with nothing listening on it.
        std::io::ErrorKind::PermissionDenied => BindFailure::Reserved(port),
        _ => BindFailure::PortTaken(port),
    }
}

impl BindFailure {
    /// The sentence Settings shows. User-visible: no em dashes.
    fn message(&self) -> String {
        match self {
            BindFailure::PortTaken(p) => format!(
                "Port {p} is in use by another program. Termic will not move to a different port on its own, because your clients are pointed at this one."
            ),
            BindFailure::Reserved(p) => format!(
                "The system refused port {p}. On Windows this means it sits in a reserved range (Hyper-V, WSL and Docker take blocks of ports from 49152 up, and change them on restart). Use a port below 49152."
            ),
            BindFailure::Io(e) => format!("Could not bind: {e}"),
        }
    }
}

const LOOPBACK: IpAddr = IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);

/// The address and port Settings asks for ("mcp_bind_address",
/// "mcp_port"). Empty or unparseable is loopback, never "everything": a
/// typo must not be what exposes the endpoint. Port 0 means no preference.
fn bind_setting() -> (IpAddr, Option<u16>) {
    let s = crate::load_settings_inner();
    (parse_bind_address(&s.mcp_bind_address), Some(s.mcp_port).filter(|p| *p != 0))
}

fn parse_bind_address(s: &str) -> IpAddr {
    s.trim().parse().unwrap_or(LOOPBACK)
}

/// The address a client on THIS machine dials for a listener bound to
/// `addr`. A wildcard is not dialable, and a listener bound to one
/// specific interface does not answer on loopback.
fn reach(addr: IpAddr) -> IpAddr {
    match addr {
        a if !a.is_unspecified() => a,
        IpAddr::V4(_) => LOOPBACK,
        IpAddr::V6(_) => IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
    }
}

/// SocketAddr's own formatting, so an IPv6 address gets its brackets.
fn url_at(addr: IpAddr, port: u16) -> String {
    format!("http://{}/mcp", std::net::SocketAddr::new(addr, port))
}

#[derive(Debug)]
enum BindFailure {
    /// Someone else holds the port our clients were told to use.
    PortTaken(u16),
    /// The OS will not let anyone bind it (see bind_failure).
    Reserved(u16),
    Io(std::io::Error),
}

#[cfg(test)]
fn url_for(port: u16) -> String {
    url_at(LOOPBACK, port)
}

/// The credential currently on disk, when the file is one this server
/// would have written: 64 hex chars, owner-only. Used to hand the value
/// to the Settings copy affordance, NOT to adopt a token at bind time,
/// which would let a credential outlive the port that vouched for it
/// (see the mint-per-bind note in apply_enabled).
fn token_from_file(dir: &Path) -> Option<String> {
    let path = dir.join(MCP_TOKEN_FILE);
    // Unix: refuse a token file anyone else could read. Windows has no
    // mode bits; the file inherits the per-user data dir's ACL.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(&path).ok()?;
        if meta.permissions().mode() & 0o077 != 0 {
            return None;
        }
    }
    let token = std::fs::read_to_string(&path).ok()?;
    let token = token.trim().to_string();
    if token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(token)
    } else {
        None
    }
}

/// Last advertised port, from the mcp-port file (survives restarts;
/// written on bind, removed on disable).
fn port_from_file(dir: &Path) -> Option<u16> {
    let url = std::fs::read_to_string(dir.join(MCP_PORT_FILE)).ok()?;
    let url = url.trim();
    // Whatever address it was bound to: the port is after the last colon
    // of the authority.
    let authority = url.strip_prefix("http://")?.split('/').next()?;
    authority.rsplit(':').next()?.parse().ok()
}

/// Setup-hook entry: bind now if the setting is already on.
pub(crate) fn start_if_enabled(app: tauri::AppHandle) {
    if crate::load_settings_inner().mcp_enabled {
        apply_enabled(app, true);
    }
}

/// The one lifecycle switch, idempotent both ways. Called from the
/// setup hook and from settings_save, so the Settings toggle applies
/// live in both directions.
pub(crate) fn apply_enabled(app: tauri::AppHandle, on: bool) {
    let (addr, want_port) = bind_setting();
    let mut st = state().lock().unwrap();
    // Both are fixed at bind, so a changed address or port is a stop and a
    // start, with a fresh token as on any re-enable.
    if on && st.handle.as_ref().is_some_and(|h| h.addr != addr || want_port.is_some_and(|p| p != h.port)) {
        drop(st);
        apply_enabled(app.clone(), false);
        return apply_enabled(app, true);
    }
    match (on, st.handle.is_some()) {
        (true, false) => {
            let Ok(dir) = crate::global_dir() else {
                dlog("[mcp] no data dir; not binding");
                return;
            };
            // A quick off-then-on can reach here while the previous
            // listener still holds the port, and bind_listener would
            // quietly fall back to an OS-assigned one, breaking the
            // client config the port file promised to keep valid.
            // Bounded, on an explicit user action, and only when a
            // teardown is actually outstanding: not a poll loop.
            if let Some(rx) = st.stopped.take() {
                if rx.recv_timeout(PORT_RELEASE_WAIT).is_err() {
                    dlog("[mcp] previous listener still winding down; the port may change");
                }
            }
            // A port the user typed outranks the one we remembered.
            let preferred = want_port.or(st.last_port).or_else(|| port_from_file(&dir));
            let listener = match bind_listener(preferred, addr) {
                Ok(l) => l,
                // Moving to a different port silently is the dangerous
                // option, not the safe one. Client configs hold the OLD
                // url and a helper that reads the CURRENT token file, so
                // the next client start would hand a freshly minted,
                // valid token to whatever process now answers on that
                // port, and it could spend it against us. Refuse to
                // serve.
                Err(f @ (BindFailure::PortTaken(p) | BindFailure::Reserved(p))) => {
                    dlog(&format!(
                        "[mcp] {f:?}; not serving, because clients pointed at \
                         that port would send their token to whoever answers there"
                    ));
                    st.bind_error = Some(f.message());
                    // Keep refusing THIS port until it can be reclaimed:
                    // dropping the memo would make the next enable bind a
                    // different port while every installed client still
                    // points at the squatter. Not for a TYPED port: the
                    // setting already holds it, and a memo of it would
                    // keep refusing after the user clears the field,
                    // which is them asking for a different port.
                    if want_port.is_none() {
                        st.last_port = Some(p);
                    }
                    return;
                }
                Err(f) => {
                    dlog(&format!("[mcp] bind failed: {f:?}"));
                    st.bind_error = Some(f.message());
                    return;
                }
            };
            let port = match listener.local_addr() {
                Ok(a) => a.port(),
                Err(e) => {
                    dlog(&format!("[mcp] local_addr failed: {e}"));
                    return;
                }
            };
            // Socket live BEFORE the credential exists (cli_server
            // discipline); if the token cannot be written, advertise
            // nothing and keep the port closed.
            //
            // Adopted from the file, not minted per bind. Minting per
            // bind closed a narrow hole (another local user binding our
            // freed port after a crash keeps whatever token a client then
            // hands it) at the price of breaking every client that holds
            // a pasted token on each restart. The user regenerates it
            // when they want it changed.
            let token = token_for_bind(&dir);
            if let Err(e) = cli_server::write_token_file(&dir.join(MCP_TOKEN_FILE), &token) {
                dlog(&format!("[mcp] token write failed: {e}; not serving"));
                return;
            }
            if let Err(e) = std::fs::write(dir.join(MCP_PORT_FILE), format!("{}\n", url_at(reach(addr), port))) {
                dlog(&format!("[mcp] port file write failed: {e}; not serving"));
                return;
            }
            let shutdown = Arc::new(AtomicBool::new(false));
            let mut server = McpServer::new(
                token.clone(),
                Arc::new(cli_server::tauri_host(app, token)),
                Box::new(|| crate::load_settings_inner().mcp_enabled),
                shutdown.clone(),
            );
            server.lan = !addr.is_loopback();
            let server = Arc::new(server);
            let sd = shutdown.clone();
            let (done_tx, done_rx) = mpsc::channel();
            // Not bound: nothing joins it, and the channel below is how
            // the next bind learns the port is free again.
            std::thread::spawn(move || {
                serve_listener(listener, server, sd);
                // Sent after serve_listener returns, which is after the
                // listener is dropped and the port released.
                let _ = done_tx.send(());
            });
            dlog(&format!("[mcp] listening on {}", url_at(addr, port)));
            st.last_port = Some(port);
            st.bind_error = None;
            st.handle = Some(McpHandle { port, addr, shutdown, stopped: Some(done_rx) });
        }
        (false, true) => {
            let mut h = st.handle.take().unwrap();
            h.shutdown.store(true, Ordering::SeqCst);
            // accept() has no shutdown; a self-connect unblocks it so
            // the loop observes the flag and exits. BOUNDED on purpose:
            // this runs on the synchronous settings_save command, i.e.
            // the main thread, while holding this lock. An untimed
            // connect can park for the OS timeout (~75s) on a full
            // backlog, which would freeze the window and wedge every
            // later save (docs/ipc.md; the CLAUDE.md sync-IO trap).
            let poke = std::net::SocketAddr::new(reach(h.addr), h.port);
            let _ = TcpStream::connect_timeout(&poke, SHUTDOWN_POKE_TIMEOUT);
            // The accept loop only has to observe the flag; if the poke
            // did not land, let it exit on its own rather than blocking
            // the UI thread on a join that may never return.
            st.stopped = h.stopped.take();
            // Off means nothing is advertised. The token is kept for the
            // next enable (see revoke_advertisement).
            if let Ok(dir) = crate::global_dir() {
                revoke_advertisement(&dir);
            }
            st.last_port = Some(h.port);
            dlog("[mcp] stopped");
        }
        // Disabling with no live handle still has to revoke: a bind that
        // failed part-way, or a refusal that deliberately kept the port
        // memo, leaves files behind, and "off" has to mean nothing is
        // advertised.
        (false, false) => {
            st.bind_error = None;
            if let Ok(dir) = crate::global_dir() {
                revoke_advertisement(&dir);
            }
        }
        (true, true) => {}
    }
}

#[derive(serde::Serialize)]
pub(crate) struct McpStatus {
    /// The exact codex config block, rendered by the same code that
    /// writes it. The page used to build this in TypeScript, which put
    /// a shell-escaped apostrophe inside a TOML BASIC string where `\'`
    /// is not a legal escape, so a path like /Users/O'Brien produced a
    /// block that does not parse. Rendering once removes the second
    /// copy that made that possible.
    codex_config: Option<String>,
    /// The claude registration command, likewise rendered once.
    claude_command: Option<String>,
    /// Live endpoint URL (None = not bound). The token is deliberately
    /// NOT here: the UI shows the file path, never the value.
    url: Option<String>,
    /// Where the client reads its credential from.
    token_path: Option<String>,
    /// The address another device on the network connects to, when the
    /// listener is bound on every interface (where `url` is the loopback
    /// one) and the machine has a network address.
    lan_url: Option<String>,
    /// Why the endpoint is not bound although the setting is on.
    bind_error: Option<String>,
    /// Whether a `termic` server is registered with Claude Code (user
    /// scope, in EVERY claude config dir: the default one and each named
    /// account's) and with Codex. Pairing reaches the other computer only
    /// through these tools, so Settings refuses to pair until one is set.
    claude_registered: bool,
    /// The claude accounts still missing it while others have it, by name.
    claude_missing: Vec<String>,
    codex_registered: bool,
}

/// Settings-UI probe. Reads the live handle, so it reflects reality
/// (a failed bind reports url: null even with the setting on).
#[tauri::command]
pub(crate) fn mcp_status() -> McpStatus {
    let (url, lan_url, bind_error) = {
        let st = state().lock().unwrap();
        match st.handle.as_ref() {
            Some(h) => (
                Some(url_at(reach(h.addr), h.port)),
                h.addr.is_unspecified().then(lan_ip).flatten().map(|ip| url_at(ip, h.port)),
                None,
            ),
            None => (None, None, st.bind_error.clone()),
        }
    };
    let rendered = url.as_ref().and_then(|u| {
        let dir = crate::global_dir().ok()?;
        let helper = helper_command(&dir.join(MCP_TOKEN_FILE));
        Some((codex_block(u, &helper), claude_command(u, &helper)))
    });
    let claude_dirs = claude_config_dirs();
    let claude_total = claude_dirs.len();
    let claude_missing: Vec<String> = claude_dirs
        .into_iter()
        .filter(|c| !claude_has_termic(c.dir.as_deref()))
        .map(|c| c.label)
        .collect();
    McpStatus {
        codex_config: rendered.as_ref().map(|(c, _)| c.clone()),
        claude_command: rendered.as_ref().map(|(_, c)| c.clone()),
        token_path: url
            .is_some()
            .then(|| crate::global_dir().ok().map(|d| d.join(MCP_TOKEN_FILE).to_string_lossy().into_owned()))
            .flatten(),
        url,
        lan_url,
        bind_error,
        claude_registered: claude_missing.is_empty(),
        claude_missing: if claude_missing.len() < claude_total { claude_missing } else { Vec::new() },
        codex_registered: codex_has_termic(),
    }
}

/// One claude config dir an agent here can run with: `dir` None is claude's
/// default (~/.claude.json), Some a named account's store or a clone's own
/// CLAUDE_CONFIG_DIR.
///
/// Every one needs the server. A user-scope MCP server lives in that dir's
/// `.claude.json`, which an account deliberately does NOT share with the
/// primary (agent_dirs::shared_config_entries: it holds the account
/// identity), so registering only the default left every task on a second
/// account without the peer tools. Codex needs no such walk: its accounts
/// share config.toml by symlink. Profiles need none either: they share the
/// agent's config dirs, and logins are keyed by name across profiles.
struct ClaudeDir {
    label: String,
    dir: Option<std::path::PathBuf>,
}

fn claude_config_dirs() -> Vec<ClaudeDir> {
    let mut out = vec![ClaudeDir { label: "default".into(), dir: None }];
    let home = dirs::home_dir();
    let logins = crate::global_dir().ok().map(|d| d.join("logins"));
    let mut push = |label: String, dir: std::path::PathBuf| {
        if !out.iter().any(|c| c.dir.as_ref() == Some(&dir)) {
            out.push(ClaudeDir { label, dir: Some(dir) });
        }
    };
    for pid in crate::profiles_registry().ids() {
        let agents = crate::load_settings_in(&pid).agents;
        for a in &agents {
            if crate::docker::base_agent_id(&agents, &a.id) != "claude" { continue; }
            if let (Some(raw), Some(home)) = (crate::agent_dirs::resolve_agent(&agents, &a.id)
                .and_then(|r| r.env.get("CLAUDE_CONFIG_DIR").cloned()), home.as_ref())
            {
                let dir = crate::agent_dirs::expand_home(&raw, home);
                if !dir.as_os_str().is_empty() { push(a.display_name.clone(), dir); }
            }
            // Named accounts: <data>/logins/<agent id>/<slug>/, global.
            let Some(root) = logins.as_ref().map(|l| l.join(&a.id)) else { continue };
            let Ok(rd) = std::fs::read_dir(&root) else { continue };
            for e in rd.flatten().filter(|e| e.path().is_dir()) {
                push(e.file_name().to_string_lossy().into_owned(), e.path());
            }
        }
    }
    out
}

/// Where claude keeps a dir's user-scope servers.
fn claude_json_path(dir: Option<&std::path::Path>) -> Option<std::path::PathBuf> {
    match dir {
        Some(d) => Some(d.join(".claude.json")),
        None => dirs::home_dir().map(|h| h.join(".claude.json")),
    }
}

/// Is `termic` in that dir's user-scope servers (what Add to Claude Code
/// writes)? Read-only; an unreadable file is "no".
fn claude_has_termic(dir: Option<&std::path::Path>) -> bool {
    claude_json_path(dir)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|doc| claude_doc_has_termic(&doc))
}

fn claude_doc_has_termic(doc: &serde_json::Value) -> bool {
    doc.get("mcpServers").and_then(|m| m.get("termic")).is_some()
}

/// Is `termic` in ~/.codex/config.toml's mcp_servers? Parsed, for the
/// same quoted-header reason codex_config_with_termic parses.
fn codex_has_termic() -> bool {
    let Some(home) = dirs::home_dir() else { return false };
    std::fs::read_to_string(home.join(".codex/config.toml"))
        .is_ok_and(|t| codex_text_has_termic(&t))
}

fn codex_text_has_termic(text: &str) -> bool {
    text.parse::<toml_edit::DocumentMut>()
        .ok()
        .and_then(|doc| doc.get("mcp_servers")?.get("termic").map(|_| ()))
        .is_some()
}

/// The live credential, for the Settings "Copy token" affordance only.
/// Clients that take a pasted value (Claude Desktop and friends) cannot
/// read the file themselves, and the UI hands this straight to the
/// clipboard without ever rendering it, so the value stays off screen,
/// out of screenshots, and out of a screen share.
///
/// This discloses nothing new: the caller is the app's own webview on
/// the user's machine, and anything running as this user can read the
/// 0600 file directly. Reading the file (rather than caching the value)
/// keeps one source of truth.
#[tauri::command]
pub(crate) fn mcp_token() -> Option<String> {
    token_from_file(&crate::global_dir().ok()?)
}

/// Settings "Regenerate token": the ONLY thing that changes the token.
/// A running listener holds the old value, so it is restarted, which
/// drops every client still presenting it.
#[tauri::command]
pub(crate) fn mcp_regenerate_token(app: tauri::AppHandle) -> Result<(), String> {
    let dir = crate::global_dir().map_err(|e| e.to_string())?;
    cli_server::write_token_file(&dir.join(MCP_TOKEN_FILE), &cli_server::mint_token())
        .map_err(|e| e.to_string())?;
    if state().lock().unwrap().handle.is_some() {
        apply_enabled(app.clone(), false);
        apply_enabled(app, crate::load_settings_inner().mcp_enabled);
    }
    Ok(())
}

// ─────────────────────── one-click client setup ──────────────────────

/// The shell command both clients run to fetch the credential. Single
/// source, so the two configs cannot drift apart.
fn helper_command(token_path: &Path) -> String {
    // Windows: claude runs the helper through cmd.exe (measured on
    // 2.1.291), where the POSIX line below prints no token, the request
    // goes out bare, and the 401 surfaces as "Dynamic Client Registration
    // rejected (HTTP 404)". The sidecar is shell-free instead.
    #[cfg(windows)]
    if let Ok(cli) = crate::cli_server::bundled_cli_path() {
        return windows_helper_command(&cli, token_path);
    }
    sh_helper_command(token_path)
}

/// `"<termic-cli.exe>" mcp-headers "<token file>"`: a program and one
/// argument, which cmd.exe and sh parse the same way. A Windows path
/// cannot contain a double quote.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_helper_command(cli: &Path, token_path: &Path) -> String {
    format!("\"{}\" mcp-headers \"{}\"", cli.display(), token_path.display())
}

fn sh_helper_command(token_path: &Path) -> String {
    // Single-quoted for the shell, with any embedded apostrophe closed,
    // escaped and reopened, so a path like /Users/O'Brien still parses.
    let quoted = format!("'{}'", token_path.to_string_lossy().replace('\'', "'\\''"));
    // The task header comes from the AGENT's environment: the client runs
    // this helper as its own child, so $TERMIC_TASK_ID is whatever task the
    // agent runs in, and empty outside Termic (the server ignores empty).
    format!(
        "printf '{{\"{MCP_TOKEN_HEADER}\":\"%s\",\"{MCP_TASK_HEADER}\":\"%s\"}}' \"$(cat {quoted})\" \"${{TERMIC_TASK_ID:-}}\""
    )
}

/// The codex block a user pastes: the same two tables the installer
/// writes, rendered by toml_edit so quoting and escaping are its
/// problem rather than a format string's.
fn codex_block(url: &str, helper: &str) -> String {
    codex_config_with_termic("", url, helper).unwrap_or_default()
}

/// The claude registration command, with the JSON wrapped as one shell
/// argument. The JSON carries double quotes and the helper inside it
/// carries single quotes, so the wrapping has to close, escape and
/// reopen rather than just surround.
fn claude_command(url: &str, helper: &str) -> String {
    let json = serde_json::json!({ "type": "http", "url": url, "headersHelper": helper })
        .to_string();
    format!("claude mcp add-json termic {} -s user", shell_quote(&json))
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Codex's config.toml with our server (and the revision flag) present,
/// leaving every other table, comment and ordering untouched.
///
/// Parsed rather than line-edited. A line scan cannot see a quoted
/// table header (`[mcp_servers."termic"]`) or a dotted key, so it
/// appended a SECOND definition and produced TOML that does not parse,
/// which makes codex fail to load its whole config rather than just our
/// entry. Returns Err on a config we cannot parse, so the caller can
/// refuse instead of overwriting something it did not understand.
fn codex_config_with_termic(existing: &str, url: &str, helper: &str) -> Result<String, String> {
    use toml_edit::{value, DocumentMut, Item, Table};

    let mut doc: DocumentMut = existing
        .parse()
        .map_err(|e| format!("codex's config is not valid TOML, so it was left alone: {e}"))?;

    // Indexing with `[..]` PANICS when an existing key is the wrong
    // kind (`[[mcp_servers]]` as an array of tables, `features = "on"`
    // as a scalar), and the panic surfaces to the user as
    // "task <n> panicked" AFTER the backup was taken. Reach for the
    // table explicitly so a shape we do not understand is refused, as
    // the contract above promises.
    let table = |doc: &mut DocumentMut, key: &str| -> Result<(), String> {
        let entry = doc.entry(key).or_insert(Item::Table(Table::new()));
        if entry.as_table_mut().is_none() {
            return Err(format!(
                "codex's config has a {key} entry this cannot edit safely, so it was left alone"
            ));
        }
        Ok(())
    };
    table(&mut doc, "mcp_servers")?;
    table(&mut doc, "features")?;

    let mut ours = Table::new();
    ours["url"] = value(url);
    ours["http_headers_helper"] = value(helper);
    doc["mcp_servers"]
        .as_table_mut()
        .ok_or("codex's mcp_servers is not a table")?
        .insert("termic", Item::Table(ours));
    doc["features"]
        .as_table_mut()
        .ok_or("codex's features is not a table")?
        .insert(CODEX_FEATURE_KEY, value(true));
    Ok(doc.to_string())
}

const CODEX_FEATURE_KEY: &str = "mcp_2026_07_28";

/// Register this endpoint with a client, so the setup is a button
/// rather than a block a user pastes into a file by hand.
///
/// Claude is delegated to `claude mcp add-json`, because ~/.claude.json
/// is written by every running claude session and its own CLI is the
/// only thing that takes the lock. Codex has no equivalent (its
/// `mcp add` cannot express a headers helper, and `-c` overrides do not
/// persist), so its config is edited here, after a backup.
#[tauri::command]
pub(crate) async fn mcp_install_client(client: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install_client_inner(&client))
        .await
        .map_err(|e| e.to_string())?
}

/// Projects whose claude config defines its own `termic` server. A
/// project-scoped entry takes precedence over the user-scoped one, so
/// an old one left behind silently keeps winning. Read-only, and a
/// config we cannot read simply reports nothing.
fn claude_project_scopes_with_termic() -> Vec<String> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(home.join(".claude.json")) else { return Vec::new() };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
    project_scopes_with_termic(&doc)
}

fn project_scopes_with_termic(doc: &serde_json::Value) -> Vec<String> {
    doc.get("projects")
        .and_then(|p| p.as_object())
        .map(|projects| {
            projects
                .iter()
                .filter(|(_, cfg)| {
                    cfg.get("mcpServers").and_then(|m| m.get("termic")).is_some()
                })
                .map(|(path, _)| path.clone())
                .collect()
        })
        .unwrap_or_default()
}

fn install_client_inner(client: &str) -> Result<String, String> {
    // A clone registers the way what it was copied from does: same binary,
    // same config shape, same registration command. Keyed on the raw id, a
    // duplicated agent fell through to the unsupported arm and could not be
    // wired to the MCP endpoint at all.
    let agents = crate::load_settings_inner().agents;
    let client = crate::docker::base_agent_id(&agents, client).to_string();
    let client = client.as_str();
    let dir = crate::global_dir().map_err(|e| e.to_string())?;
    let url = state()
        .lock()
        .unwrap()
        .handle
        .as_ref()
        .map(|h| url_at(reach(h.addr), h.port))
        .ok_or("the endpoint is not running, so there is no address to register")?;
    let helper = helper_command(&dir.join(MCP_TOKEN_FILE));

    match client {
        "claude" => {
            let json = serde_json::json!({
                "type": "http",
                "url": url,
                "headersHelper": helper,
            })
            .to_string();
            // Passed as one argv entry, so no shell quoting is involved
            // here; claude_command() renders the copy-paste form.
            //
            // Remove first: add-json refuses a name that is already there
            // ("MCP server termic already exists in user config", measured
            // on 2.1.291), and a second click is exactly how a stale entry
            // (a new port, a helper an older build wrote) gets replaced.
            // Nothing to remove is the first-click case, so its failure is
            // not one.
            //
            // Once per claude config dir (see ClaudeDir): each account has
            // its own .claude.json, and CLAUDE_CONFIG_DIR is how claude's
            // own CLI is pointed at one, so the lock stays claude's.
            let run = |args: &[&str], dir: Option<&std::path::Path>| {
                let mut c = crate::proc_ctl::command("claude");
                c.args(args).env("PATH", crate::shell_env::resolved_path());
                if let Some(d) = dir { c.env("CLAUDE_CONFIG_DIR", d); }
                c.output()
            };
            let dirs = claude_config_dirs();
            let mut failed = Vec::new();
            for d in &dirs {
                let _ = run(&["mcp", "remove", "termic", "-s", "user"], d.dir.as_deref());
                let out = run(&["mcp", "add-json", "termic", &json, "-s", "user"], d.dir.as_deref())
                    .map_err(|e| format!("could not run claude: {e}"))?;
                if !out.status.success() {
                    failed.push(format!("{}: {}", d.label, String::from_utf8_lossy(&out.stderr).trim()));
                }
            }
            if failed.len() == dirs.len() {
                return Err(failed.join("; "));
            }
            let mut msg = if dirs.len() > 1 {
                format!(
                    "Added to Claude Code ({} accounts). Restart any running session to pick it up.",
                    dirs.len() - failed.len()
                )
            } else {
                String::from("Added to Claude Code. Restart any running session to pick it up.")
            };
            if !failed.is_empty() {
                msg.push_str(&format!(" Could not add it for {}.", failed.join("; ")));
            }
            // A project-scoped entry of the same name WINS over the user
            // one we just wrote, so reporting plain success would be a
            // lie in that directory: the tools simply would not mount.
            let shadows = claude_project_scopes_with_termic();
            if !shadows.is_empty() {
                msg.push_str(&format!(
                    " Note: an entry named termic is also set for {}, which takes precedence there. \
                     Remove it with `claude mcp remove termic -s local` in that directory.",
                    shadows.join(", ")
                ));
            }
            Ok(msg)
        }
        "codex" => {
            let path = dirs::home_dir().ok_or("no home directory")?.join(".codex/config.toml");
            // NotFound is the only "there is nothing here yet" case. Any
            // other read failure (invalid UTF-8, permissions) has to abort:
            // the write below TRUNCATES, so carrying on with an empty string
            // would replace a config we could not read with a Termic-only
            // one, and skip the backup on the way past.
            let existing = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(e) => return Err(format!("could not read {}: {e}", path.display())),
            };
            // Render BEFORE backing up. A config this cannot edit is
            // reported as left alone, and a backup file appearing beside it
            // would say otherwise.
            let updated = codex_config_with_termic(&existing, &url, &helper)?;
            if !existing.is_empty() {
                let backup = path.with_extension("toml.termic-backup");
                std::fs::write(&backup, &existing)
                    .map_err(|e| format!("could not back up {}: {e}", path.display()))?;
            }
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&path, updated)
                .map_err(|e| format!("could not write {}: {e}", path.display()))?;
            let note = if existing.is_empty() {
                String::new()
            } else {
                " The previous file is saved beside it.".into()
            };
            Ok(format!("Added to Codex ({}).{note}", path.display()))
        }
        other => Err(format!("unknown client \"{other}\"")),
    }
}

// ───────────────────────────── tests ─────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_server::test_support::StubHost;
    use std::str::FromStr as _;
    use std::sync::atomic::AtomicBool;

    /// Real listener + server thread on an OS port; returns the address,
    /// the minted token, and the shutdown flag.
    fn spawn(enabled: bool) -> (std::net::SocketAddr, String, Arc<AtomicBool>) {
        spawn_with(Arc::new(StubHost::default()), Box::new(move || enabled))
    }

    fn spawn_with(
        host: Arc<dyn CliHost>,
        enabled: Box<dyn Fn() -> bool + Send + Sync>,
    ) -> (std::net::SocketAddr, String, Arc<AtomicBool>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let token = cli_server::mint_token();
        let shutdown = Arc::new(AtomicBool::new(false));
        let server = Arc::new(McpServer::new(token.clone(), host, enabled, shutdown.clone()));
        let sd = shutdown.clone();
        std::thread::spawn(move || serve_listener(listener, server, sd));
        (addr, token, shutdown)
    }

    /// Raw HTTP round trip; returns (status, headers, body).
    fn http(
        addr: std::net::SocketAddr,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> (u16, Vec<String>, Vec<u8>) {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n", body.len());
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        s.write_all(req.as_bytes()).unwrap();
        s.write_all(body).unwrap();
        let mut buf = Vec::new();
        // A reset AFTER the response arrived is not a failure. The server
        // answers and closes (`Connection: close`), and Windows can report
        // that close as WSAECONNRESET (10054) to a reader that already holds
        // every byte: this unwrapped the error and failed a Windows run on
        // a response it had in hand. What was read is kept and judged by
        // the assertions; only a reset with nothing read is fatal here.
        if let Err(e) = s.read_to_end(&mut buf) {
            assert!(!buf.is_empty(), "no response before the connection ended: {e}");
        }
        let text = String::from_utf8_lossy(&buf);
        let (head, rest) = text.split_once("\r\n\r\n").unwrap_or((&*text, ""));
        let mut lines = head.lines();
        let status: u16 = lines
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        (status, lines.map(str::to_string).collect(), rest.as_bytes().to_vec())
    }

    fn post(
        addr: std::net::SocketAddr,
        token: Option<&str>,
        extra: &[(&str, &str)],
        body: &str,
    ) -> (u16, Vec<String>, Vec<u8>) {
        let auth = token.map(|t| format!("Bearer {t}"));
        let mut headers: Vec<(&str, &str)> = Vec::new();
        if let Some(a) = &auth {
            headers.push(("Authorization", a));
        }
        headers.extend_from_slice(extra);
        http(addr, "POST", "/mcp", &headers, body.as_bytes())
    }

    fn no_cors(headers: &[String]) {
        assert!(
            !headers.iter().any(|h| h.to_ascii_lowercase().starts_with("access-control-")),
            "a response carried a CORS header: {headers:?}"
        );
    }

    // ── ct_eq ────────────────────────────────────────────────────────

    #[test]
    fn ct_eq_accepts_equal_and_rejects_diffs() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(!ct_eq(b"", b"x"));
        assert!(ct_eq(b"", b""));

        // Length differences must not fold to zero. As `(a.len() ^
        // b.len()) as u8` the high bits were lost, so a length
        // differing by a multiple of 256 vanished and the modular index
        // matched the rest: the real 64-char token repeated five times
        // (320 ^ 64 = 256) authenticated.
        let token = vec![b'd'; 64];
        let repeated: Vec<u8> = token.iter().cycle().take(320).copied().collect();
        assert!(!ct_eq(&repeated, &token), "a repeated token must not authenticate");
        for extra in [256usize, 512] {
            let long: Vec<u8> = token.iter().cycle().take(64 + extra).copied().collect();
            assert!(!ct_eq(&long, &token), "length +{extra} must not fold to equal");
        }
    }

    // ── boundary ─────────────────────────────────────────────────────

    #[test]
    fn missing_and_wrong_tokens_get_identical_bare_401() {
        let (addr, _token, _sd) = spawn(true);
        let a = post(addr, None, &[("Mcp-Method", "tools/list")], "{}");
        let b = post(addr, Some("nope"), &[("Mcp-Method", "tools/list")], "{}");
        assert_eq!(a.0, 401);
        assert_eq!(b.0, 401);
        assert_eq!(a.2, b.2, "401 bodies must not differ");
        assert!(a.2.is_empty());
        // The challenge is required (RFC 9110) and identical either way,
        // so it distinguishes nothing while keeping clients off the
        // OAuth path they take when no challenge is offered.
        let challenge = |h: &[String]| {
            h.iter().find(|l| l.to_ascii_lowercase().starts_with("www-authenticate:")).cloned()
        };
        assert_eq!(challenge(&a.1).as_deref(), Some("WWW-Authenticate: Bearer"));
        assert_eq!(challenge(&a.1), challenge(&b.1));
        no_cors(&a.1);
        no_cors(&b.1);
    }

    #[test]
    fn cli_token_is_not_an_mcp_token() {
        // A host whose CLI token is known to the caller: presenting it
        // on the MCP surface must be exactly a wrong token.
        let host = Arc::new(StubHost::default());
        let cli_token = host.token.clone();
        let (addr, mcp_token, _sd) = spawn_with(host, Box::new(|| true));
        assert_ne!(cli_token, mcp_token);
        let (status, headers, body) =
            post(addr, Some(&cli_token), &[("Mcp-Method", "tools/list")], "{}");
        assert_eq!(status, 401);
        assert!(body.is_empty());
        no_cors(&headers);
    }

    #[test]
    fn origin_header_is_refused_even_with_a_valid_token() {
        let (addr, token, _sd) = spawn(true);
        let (status, headers, body) = post(
            addr,
            Some(&token),
            &[("Origin", "https://evil.example"), ("Mcp-Method", "tools/list")],
            "{}",
        );
        assert_eq!(status, 403);
        assert!(body.is_empty());
        no_cors(&headers);
    }

    #[test]
    fn preflight_is_never_answered() {
        let (addr, _token, _sd) = spawn(true);
        let (status, headers, _) = http(
            addr,
            "OPTIONS",
            "/mcp",
            &[
                ("Origin", "https://evil.example"),
                ("Access-Control-Request-Method", "POST"),
                ("Access-Control-Request-Headers", "authorization,mcp-method"),
            ],
            b"",
        );
        assert_eq!(status, 405);
        no_cors(&headers);
    }

    #[test]
    fn wrong_path_and_method_reveal_nothing() {
        let (addr, _token, _sd) = spawn(true);
        let (status, headers, body) = http(addr, "GET", "/mcp", &[], b"");
        assert_eq!(status, 405);
        assert!(body.is_empty());
        no_cors(&headers);
        let (status, _, body) = http(addr, "POST", "/", &[], b"");
        assert_eq!(status, 404);
        assert!(body.is_empty());
    }

    #[test]
    fn disabled_setting_answers_403_before_auth() {
        let (addr, token, _sd) = spawn(false);
        let (status, _, body) = post(addr, Some(&token), &[("Mcp-Method", "tools/list")], "{}");
        assert_eq!(status, 403);
        assert!(body.is_empty());
        // And without a token: identical, so off = dark either way.
        let (status, _, _) = post(addr, None, &[("Mcp-Method", "tools/list")], "{}");
        assert_eq!(status, 403);
    }

    #[test]
    fn multibyte_authorization_values_fail_auth_without_panicking() {
        // Regression: `v[..7]` on the header VALUE sliced mid-char when
        // the value opened with multi-byte UTF-8, panicking the
        // connection thread pre-auth (no response at all). Every shape
        // here must come back as a normal refusal, and the server must
        // still answer afterwards.
        let (addr, token, _sd) = spawn(true);
        for bad in ["aaaaaé", "é", "Bearéé wrong", "Béarer x"] {
            let (status, _, body) = http(
                addr,
                "POST",
                "/mcp",
                &[("Authorization", bad), ("Mcp-Method", "tools/list")],
                b"{}",
            );
            assert_eq!(status, 401, "value {bad:?} must refuse, not drop");
            assert!(body.is_empty());
        }
        let (status, _) = rpc(
            addr,
            &token,
            "server/discover",
            serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "server/discover" }),
        );
        assert_eq!(status, 200, "server must survive the malformed headers");
    }

    #[test]
    fn oversized_heads_are_431_not_unbounded_memory() {
        // The head cap is pre-auth DoS protection: a streamed endless
        // header must hit MAX_HEAD and get a bounded refusal. A header
        // just past the cap proves the bound without streaming gigs.
        let (addr, _token, _sd) = spawn(true);
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let huge = "x".repeat(MAX_HEAD + 1024);
        let head = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Filler: {huge}\r\n\r\n");
        let _ = s.write_all(head.as_bytes());
        // The server stops reading at the cap and closes; the bytes it
        // never read make the close an RST on macOS, which may discard
        // the 431 before the client reads it. The response is
        // best-effort for an abuse path; the CONTRACT is the bound
        // itself: the read stops, the thread exits, and the listener
        // keeps serving (asserted below).
        let mut buf = Vec::new();
        if s.read_to_end(&mut buf).is_ok() && !buf.is_empty() {
            assert!(
                String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 431"),
                "got: {}",
                String::from_utf8_lossy(&buf)
            );
        }
        // Well-formed requests still fit comfortably under the cap.
        let (status, _, _) = http(addr, "POST", "/", &[], b"");
        assert_eq!(status, 404);
    }

    #[test]
    fn initialize_naming_our_own_revision_is_not_a_version_error() {
        // A version this server serves is not a version fault. Saying
        // "Unsupported protocol version" while listing that same version
        // as supported reads as a server bug and sends the reader
        // looking in the wrong place; the real fault is that this
        // revision has no handshake.
        let (addr, token, _sd) = spawn(true);
        let init = |ver: &str| {
            let body = format!(
                r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"{ver}","capabilities":{{}}}}}}"#
            );
            let (status, _, out) = http(
                addr,
                "POST",
                "/mcp",
                &[("Authorization", &format!("Bearer {token}"))],
                body.as_bytes(),
            );
            (status, serde_json::from_slice::<serde_json::Value>(&out).unwrap())
        };

        // A genuinely older revision: a version error naming ours.
        let (status, v) = init("2025-06-18");
        assert_eq!(status, 400);
        assert_eq!(v["error"]["code"], VERSION_MISMATCH);
        assert_eq!(v["error"]["data"]["supported"], serde_json::json!([SPEC_REVISION]));
        assert_eq!(v["error"]["data"]["requested"], "2025-06-18");

        // Our own revision: method-not-found, never "unsupported".
        let (status, v) = init(SPEC_REVISION);
        assert_eq!(status, 404);
        assert_eq!(v["error"]["code"], -32601);
        let msg = v["error"]["message"].as_str().unwrap();
        assert!(!msg.to_lowercase().contains("unsupported protocol version"), "{msg}");
        assert!(msg.contains("handshake"), "{msg}");
        // Still machine-readable for a client deciding what to do next.
        assert_eq!(v["error"]["data"]["supported"], serde_json::json!([SPEC_REVISION]));
    }

    #[test]
    fn task_new_does_not_promise_a_default_mode_it_cannot_keep() {
        // Field report: the description said "its own git worktree by
        // default", but an absent mode means the app's last-used mode,
        // which produced a main-checkout task.
        let t = TOOLS.iter().find(|t| t.name == "task_new").unwrap();
        assert!(!t.description.contains("worktree by default"), "{}", t.description);
        let mode = t.params.iter().find(|p| p.name == "mode").unwrap();
        assert!(mode.description.contains("last-used"), "{}", mode.description);
    }

    #[test]
    fn delegating_tools_teach_signing_and_reporting_back_until_a_human_says_stop() {
        // Field report: codex launched an agy task with task_new and never
        // signed the prompt or asked for a report, because the rule lived
        // only in the server instructions and task_send. Every tool that
        // carries a first prompt to another agent states it itself.
        for tool in ["task_new", "task_tab"] {
            let t = TOOLS.iter().find(|t| t.name == tool).unwrap();
            let p = t.params.iter().find(|p| p.name == "prompt").unwrap();
            assert!(p.description.contains("sign it as task_send says"), "{tool}: {}", p.description);
            assert!(p.description.contains("finishes or gets stuck"), "{tool}: {}", p.description);
            assert!(p.description.contains("until a human tells it to stop"), "{tool}: {}", p.description);
        }
        // And the receiver is told when the reporting ends.
        assert!(MCP_INSTRUCTIONS.contains("stop only when a human tells you to"));
    }

    #[test]
    fn the_custom_header_carries_the_same_credential_as_bearer() {
        // Codex cannot put Authorization in its per-server headers
        // helper (reserved), and its only bearer path is an env var,
        // which would mean editing a shell profile to use an MCP
        // server. X-Termic-Token is the way out, so it has to be
        // exactly as strong: same token, same constant-time compare.
        let (addr, token, _sd) = spawn(true);
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}"#;
        let hdrs: &[(&str, &str)] = &[
            ("X-Termic-Token", token.as_str()),
            ("Mcp-Method", "server/discover"),
            ("MCP-Protocol-Version", "2026-07-28"),
        ];
        let (status, _, out) = http(addr, "POST", "/mcp", hdrs, body.as_bytes());
        assert_eq!(status, 200, "the custom header must authenticate");
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["result"]["supportedVersions"], serde_json::json!([SPEC_REVISION]));

        // In any casing. HTTP header names are case-insensitive and nothing
        // stops a client normalising them, so the spelling on the wire is
        // not ours to assume.
        for spelling in ["x-termic-token", "X-TERMIC-TOKEN"] {
            let cased: &[(&str, &str)] = &[
                (spelling, token.as_str()),
                ("Mcp-Method", "server/discover"),
                ("MCP-Protocol-Version", "2026-07-28"),
            ];
            let (status, _, _) = http(addr, "POST", "/mcp", cased, body.as_bytes());
            assert_eq!(status, 200, "{spelling} must authenticate");
        }

        // A wrong value in it is refused exactly like a wrong bearer.
        let bad: &[(&str, &str)] = &[
            ("X-Termic-Token", "nope"),
            ("Mcp-Method", "server/discover"),
            ("MCP-Protocol-Version", "2026-07-28"),
        ];
        let (status, headers, out) = http(addr, "POST", "/mcp", bad, body.as_bytes());
        assert_eq!(status, 401);
        assert!(out.is_empty());
        no_cors(&headers);
    }

    #[test]
    fn a_connection_open_before_a_disable_is_refused_after_it() {
        // The real shape: a socket is accepted and its worker parks in
        // read_request; the user disables, then re-enables. The setting
        // reads true again, but this worker still holds the previous
        // listener's revoked token, so it must refuse. Opening the
        // connection BEFORE retiring is the whole point: a connection
        // opened after is simply not accepted.
        let (addr, token, sd) = spawn(true);
        let mut early = TcpStream::connect(addr).unwrap();
        early.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        // Give the accept loop a moment to hand this to a worker.
        std::thread::sleep(Duration::from_millis(50));

        sd.store(true, Ordering::SeqCst);

        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}"#;
        let req = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\n\
             Mcp-Method: tools/list\r\nMCP-Protocol-Version: 2026-07-28\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        early.write_all(req.as_bytes()).unwrap();
        let mut buf = Vec::new();
        let _ = early.read_to_end(&mut buf);
        let text = String::from_utf8_lossy(&buf);
        assert!(
            text.starts_with("HTTP/1.1 403") || text.is_empty(),
            "a retired worker must refuse its revoked token, got: {text}"
        );
        assert!(!text.starts_with("HTTP/1.1 200"), "served a request after revocation");
    }

    #[test]
    fn a_hijacked_advertised_port_is_refused_not_silently_moved() {
        // Falling back to a fresh port looks harmless and is not: client
        // configs still hold the OLD url next to a helper that reads the
        // CURRENT token file, so the next client start would hand a
        // valid token to whoever answers there.
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(
            matches!(bind_listener(Some(port), LOOPBACK), Err(BindFailure::PortTaken(p)) if p == port),
            "a taken advertised port must be an error, never a quiet fallback"
        );
        // With nothing to reclaim, any free port is fine.
        assert!(bind_listener(None, LOOPBACK).unwrap().local_addr().unwrap().ip().is_loopback());
        // An address this machine does not have (TEST-NET-1) is a wrong
        // setting, reported as that and not as someone holding our port.
        let elsewhere: IpAddr = "192.0.2.1".parse().unwrap();
        assert!(matches!(bind_listener(Some(port), elsewhere), Err(BindFailure::Io(_))));
        // A refusal is not a squatter: it is the OS reserving the port.
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let f = bind_failure(denied, 65510);
        assert!(matches!(f, BindFailure::Reserved(65510)));
        assert!(f.message().contains("65510"));
        // An unset port is picked from our own range, not the OS's.
        let auto = bind_listener(None, LOOPBACK).unwrap().local_addr().unwrap().port();
        assert!(AUTO_PORTS.contains(&auto), "{auto}");
        // And once it is free again, it is reclaimed.
        //
        // Retried rather than asserted on the first attempt. `drop` closes the
        // socket but the kernel can hold the address briefly afterwards, so an
        // immediate rebind races TIME_WAIT and fails for a reason that has
        // nothing to do with what this test checks. It failed intermittently
        // on an idle machine and reliably on a loaded one, which is the worst
        // shape for a gating test: it looks like whatever you changed last.
        // PORT_RELEASE_WAIT is the same budget the production reclaim path
        // allows for exactly this.
        drop(held);
        let deadline = std::time::Instant::now() + PORT_RELEASE_WAIT * 8;
        let reclaimed = loop {
            if bind_listener(Some(port), LOOPBACK).is_ok() { break true }
            if std::time::Instant::now() >= deadline { break false }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(reclaimed, "a freed advertised port must be reclaimable");
    }

    #[test]
    fn a_bad_bind_address_is_loopback_and_urls_name_a_dialable_address() {
        // A typo must never be what exposes the endpoint.
        for bad in ["", "  ", "everything", "0.0.0", "192.168.1.300", "localhost"] {
            assert_eq!(parse_bind_address(bad), LOOPBACK, "{bad:?}");
        }
        assert!(parse_bind_address(" 0.0.0.0 ").is_unspecified());
        // What a local client is told to dial: never the wildcard, and the
        // interface itself when bound to one.
        let any: IpAddr = "0.0.0.0".parse().unwrap();
        let one: IpAddr = "192.168.1.20".parse().unwrap();
        assert_eq!(url_at(reach(any), 8123), "http://127.0.0.1:8123/mcp");
        assert_eq!(url_at(reach(one), 8123), "http://192.168.1.20:8123/mcp");
        assert_eq!(url_at(reach("::".parse().unwrap()), 8123), "http://[::1]:8123/mcp");
        // And the port comes back out of whichever was written.
        let dir = tempfile::tempdir().unwrap();
        for url in ["http://127.0.0.1:8123/mcp", "http://192.168.1.20:8123/mcp", "http://[::1]:8123/mcp"] {
            std::fs::write(dir.path().join(MCP_PORT_FILE), format!("{url}\n")).unwrap();
            assert_eq!(port_from_file(dir.path()), Some(8123), "{url}");
        }
    }

    #[test]
    fn the_token_outlives_a_disable_and_changes_only_when_asked() {
        // A client on another machine holds a pasted copy. Anything that
        // changed the token by itself (a restart, a toggle, a rebind) broke
        // that client, so going quiet takes the port file and nothing else.
        let dir = tempfile::tempdir().unwrap();
        let first = token_for_bind(dir.path());
        assert!(first.len() == 64, "nothing on disk yet: a fresh one");
        cli_server::write_token_file(&dir.path().join(MCP_TOKEN_FILE), &first).unwrap();
        std::fs::write(dir.path().join(MCP_PORT_FILE), "http://127.0.0.1:65000/mcp\n").unwrap();

        revoke_advertisement(dir.path());
        assert_eq!(port_from_file(dir.path()), None, "off advertises nothing");
        assert_eq!(token_for_bind(dir.path()), first, "the next bind serves the same token");

        // A file this server did not write is not adopted.
        std::fs::write(dir.path().join(MCP_TOKEN_FILE), "not a token").unwrap();
        assert_ne!(token_for_bind(dir.path()), first);
    }

    #[test]
    fn too_many_open_connections_are_refused_rather_than_spawning_threads() {
        // Every local uid can reach the port, and a socket that never
        // sends a request holds a thread for the whole read timeout.
        let (addr, _token, _sd) = spawn(true);
        let mut idle = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            // Opened and left silent, exactly what a flooder does.
            idle.push(TcpStream::connect(addr).unwrap());
        }
        // Let the accept loop take them all before testing the cap.
        std::thread::sleep(Duration::from_millis(200));
        let mut over = TcpStream::connect(addr).unwrap();
        over.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut buf = Vec::new();
        let _ = over.read_to_end(&mut buf);
        let text = String::from_utf8_lossy(&buf);
        assert!(
            text.starts_with("HTTP/1.1 503") || text.is_empty(),
            "over the cap the server must refuse, got: {text}"
        );

        // Closing them frees the slots again.
        drop(idle);
        std::thread::sleep(Duration::from_millis(300));
    }

    #[test]
    fn host_gate_stops_a_rebound_hostname() {
        // DNS rebinding: the page's request is same-origin, so it
        // carries no Origin and gate 2 never fires. Only the Host
        // separates it from a local client.
        let (addr, token, _sd) = spawn(true);
        let bad = http(
            addr,
            "POST",
            "/mcp",
            &[("Host", "evil.example"), ("Authorization", &format!("Bearer {token}")), ("Mcp-Method", "tools/list")],
            b"{}",
        );
        assert_eq!(bad.0, 403, "a rebound Host must be refused even with a valid token");
        assert!(bad.2.is_empty());
        no_cors(&bad.1);
        // The loopback spellings all pass the gate (and then fail on
        // their own merits further down, never on the Host).
        for h in ["127.0.0.1", "127.0.0.1:1", "localhost", "[::1]:80"] {
            assert!(host_is_loopback(h), "{h} should pass");
        }
        // The LAN setting answers this machine's address and still no
        // hostname, which is the half a rebinding page needs.
        for h in ["192.168.1.20:65510", "10.0.0.5", "[fe80::1]:80", "127.0.0.1:1", "localhost"] {
            assert!(host_allowed(h, true), "{h}");
        }
        for h in ["192.168.1.20:65510", "10.0.0.5", "[fe80::1]:80"] {
            assert!(!host_allowed(h, false), "{h} must be refused on a loopback-only listener");
        }
        for h in ["evil.example", "machine.local:65510", "192.168.1.20.evil.example", ""] {
            assert!(!host_allowed(h, true), "{h}");
        }
        for h in ["evil.example", "termic.dev:80", "", "127.0.0.1.evil.example"] {
            assert!(!host_is_loopback(h), "{h} should be refused");
        }
    }

    #[test]
    fn an_unparseable_content_length_is_named_too() {
        // Read as zero bytes it comes back "-32700 parse error",
        // pointing the client at its JSON rather than its framing.
        let (addr, token, _sd) = spawn(true);
        let (status, _, _) = http(
            addr,
            "POST",
            "/mcp",
            &[("Authorization", &format!("Bearer {token}")), ("Mcp-Method", "tools/list"), ("Content-Length", "abc")],
            b"",
        );
        assert_eq!(status, 411);
    }

    #[test]
    fn chunked_bodies_are_named_not_mistaken_for_parse_errors() {
        // Without this the body reads as zero bytes and comes back
        // "-32700 parse error", which points the client at its JSON.
        let (addr, token, _sd) = spawn(true);
        let (status, _, _) = http(
            addr,
            "POST",
            "/mcp",
            &[("Authorization", &format!("Bearer {token}")), ("Mcp-Method", "tools/list"), ("Transfer-Encoding", "chunked")],
            b"",
        );
        assert_eq!(status, 411);
    }

    #[test]
    fn unknown_tool_arguments_are_refused_not_ignored() {
        // The schemas advertise additionalProperties: false. Silently
        // dropping `timeoutMS` would turn a 1s wait into the 5m cap.
        let (addr, token, _sd) = spawn(true);
        let v = call(addr, &token, "task_wait", serde_json::json!({ "task": "solo", "timeoutMS": 1000 }));
        assert_eq!(v["error"]["code"], -32602);
        assert!(v["error"]["message"].as_str().unwrap().contains("timeoutMS"), "{v}");
    }

    #[test]
    fn oversized_body_is_rejected() {
        let (addr, token, _sd) = spawn(true);
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let head = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        s.write_all(head.as_bytes()).unwrap();
        let mut buf = Vec::new();
        // The status line is the verdict; see `http` for why a reset after it
        // is not one.
        let _ = s.read_to_end(&mut buf);
        assert!(String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 413"));
    }

    // ── backoff ──────────────────────────────────────────────────────

    #[test]
    fn backoff_grows_and_resets() {
        let mut b = Backoff { failures: 0 };
        let d1 = b.delay();
        let d2 = b.delay();
        let d3 = b.delay();
        assert!(d1 < d2 && d2 < d3, "{d1:?} {d2:?} {d3:?}");
        // Caps.
        b.failures = 10_000;
        assert_eq!(b.delay(), BACKOFF_MAX);
        b.reset();
        assert_eq!(b.delay(), d1);
    }

    #[test]
    fn a_valid_token_still_authenticates_after_repeated_failures() {
        // The reset itself is not observable here (backoff only sleeps
        // on the failure path); `backoff_grows_and_resets` covers it.
        let (addr, token, _sd) = spawn(true);
        for _ in 0..3 {
            let (status, _, _) = post(addr, Some("wrong"), &[("Mcp-Method", "x")], "{}");
            assert_eq!(status, 401);
        }
        // A good request goes through (and resets the counter).
        let (status, _) = rpc(
            addr,
            &token,
            "tools/list",
            serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
        );
        assert_eq!(status, 200);
    }

    // ── header agreement (stub rpc layer) ────────────────────────────

    #[test]
    fn mcp_method_header_is_required_and_must_match() {
        let (addr, token, _sd) = spawn(true);
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/list",
            "params": { "_meta": meta() },
        })
        .to_string();
        let ver = ("MCP-Protocol-Version", SPEC_REVISION);
        // Missing: a header fault, not a generic invalid-request.
        let (status, _, resp) = post(addr, Some(&token), &[ver], &body);
        assert_eq!(status, 400);
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["error"]["code"], HEADER_MISMATCH);
        // Mismatched.
        let (status, _, resp) = post(addr, Some(&token), &[ver, ("Mcp-Method", "tools/call")], &body);
        assert_eq!(status, 400);
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["error"]["code"], HEADER_MISMATCH);
        // Matching reaches dispatch.
        let (status, _, _) = post(addr, Some(&token), &[ver, ("Mcp-Method", "tools/list")], &body);
        assert_eq!(status, 200);
    }

    #[test]
    fn unparseable_body_is_a_parse_error() {
        let (addr, token, _sd) = spawn(true);
        let (status, _, resp) = post(addr, Some(&token), &[("Mcp-Method", "x")], "{nope");
        assert_eq!(status, 400);
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32700);
    }

    #[test]
    fn a_malformed_envelope_never_reaches_a_verb() {
        // The headers are validated strictly; the body has to be too. A
        // caller naming another JSON-RPC version, or an id no version
        // allows, is malformed rather than asking for a method, and
        // dispatching it anyway would run a real verb (tools/call included)
        // off a request we just said we did not understand.
        let (addr, token, _sd) = spawn(true);
        let cases = [
            (r#"{"jsonrpc":"1.0","id":1,"method":"tools/list"}"#, "another version"),
            (r#"{"id":1,"method":"tools/list"}"#, "no version at all"),
            (r#"{"jsonrpc":"2.0","id":{"a":1},"method":"tools/list"}"#, "an object id"),
            (r#"{"jsonrpc":"2.0","id":1,"method":7}"#, "a non-string method"),
            (r#""just a string""#, "not an object"),
        ];
        for (body, what) in cases {
            let (status, _, resp) = post(addr, Some(&token), &[("Mcp-Method", "tools/list")], body);
            assert_eq!(status, 400, "{what} must be refused");
            let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
            assert_eq!(v["error"]["code"], -32600, "{what} is an invalid request");
        }
    }

    // ── stateless core ───────────────────────────────────────────────

    /// The required `_meta` block of a well-formed modern request.
    fn meta() -> serde_json::Value {
        let mut m = serde_json::Map::new();
        m.insert(META_VERSION.into(), SPEC_REVISION.into());
        m.insert(META_CAPABILITIES.into(), serde_json::json!({}));
        serde_json::Value::Object(m)
    }

    /// Fill in everything the transport requires but the test is not
    /// about: the standard headers, the `_meta` block, and the Mcp-Name
    /// mirror for tools/call. A test that supplies its own `_meta` keeps
    /// it, so the negative cases below still say what they mean.
    fn modern(mut body: serde_json::Value, method: &str) -> (Vec<(String, String)>, String) {
        let mut headers = vec![
            ("Mcp-Method".to_string(), method.to_string()),
            ("MCP-Protocol-Version".to_string(), SPEC_REVISION.to_string()),
        ];
        if !body["params"].is_object() {
            body["params"] = serde_json::json!({});
        }
        if body["params"].get("_meta").is_none() {
            body["params"]["_meta"] = meta();
        }
        if method == "tools/call" {
            if let Some(n) = body["params"].get("name").and_then(|v| v.as_str()) {
                headers.push(("Mcp-Name".to_string(), n.to_string()));
            }
        }
        (headers, body.to_string())
    }

    fn rpc(
        addr: std::net::SocketAddr,
        token: &str,
        method: &str,
        body: serde_json::Value,
    ) -> (u16, serde_json::Value) {
        let (headers, body) = modern(body, method);
        let h: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let (status, _, resp) = post(addr, Some(token), &h, &body);
        let v = if resp.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&resp).unwrap()
        };
        (status, v)
    }

    fn assert_complete(result: &serde_json::Value) {
        assert_eq!(result["resultType"], "complete", "resultType is a result field, not _meta");
        assert_eq!(result["_meta"][META_SERVER_INFO]["name"], "termic");
        assert_eq!(result["_meta"][META_SERVER_INFO]["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn discover_advertises_one_revision_and_tools_only() {
        let (addr, token, _sd) = spawn(true);
        let (status, v) = rpc(
            addr,
            &token,
            "server/discover",
            serde_json::json!({ "jsonrpc": "2.0", "id": 7, "method": "server/discover" }),
        );
        assert_eq!(status, 200);
        assert_eq!(v["id"], 7);
        let r = &v["result"];
        // Spec field name; `versions` is what stalled a real client.
        assert_eq!(r["supportedVersions"], serde_json::json!([SPEC_REVISION]));
        assert!(r.get("versions").is_none(), "the pre-spec field name must be gone");
        // Caching hints are MANDATORY on discover, as top-level fields.
        assert_eq!(r["ttlMs"], TOOLS_TTL_MS);
        assert_eq!(r["cacheScope"], "public");
        assert_eq!(r["capabilities"], serde_json::json!({ "tools": {} }));
        assert!(
            r.get("serverInfo").is_none(),
            "serverInfo moved to _meta in the final revision; a body copy is rejected by SDK v2"
        );
        assert_complete(r);
    }

    /// A handshake client cannot fall forward, so the refusal has to
    /// carry the revision it would need. This is the whole diagnostic
    /// such a user gets.
    #[test]
    fn initialize_is_refused_with_a_version_error_that_names_the_revision() {
        let (addr, token, _sd) = spawn(true);
        // Exactly what Claude Code 2.1.228 sends: no Mcp-Method header,
        // no _meta, protocolVersion at the top level of params.
        let (status, _, resp) = post(
            addr,
            Some(&token),
            &[],
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{}}}"#,
        );
        assert_eq!(status, 400);
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["id"], 1);
        assert_eq!(v["error"]["code"], VERSION_MISMATCH);
        assert_eq!(v["error"]["data"]["supported"], serde_json::json!([SPEC_REVISION]));
        assert_eq!(
            v["error"]["data"]["requested"], "2025-11-25",
            "the client's own version must come back so it can tell what was rejected"
        );
        assert!(v.get("result").is_none(), "no handshake is ever answered");
    }

    #[test]
    fn notifications_are_swallowed_without_header_ceremony() {
        let (addr, token, _sd) = spawn(true);
        // No Mcp-Method, no _meta: this revision defines no header
        // requirements for notification POSTs.
        for body in [
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            r#"{"jsonrpc":"2.0","method":"notifications/something-new"}"#,
        ] {
            let (status, _, resp) = post(addr, Some(&token), &[], body);
            assert_eq!(status, 202, "notification {body}");
            assert!(resp.is_empty());
        }
    }

    #[test]
    fn protocol_version_must_be_present_in_both_header_and_meta_and_agree() {
        let (addr, token, _sd) = spawn(true);
        let call = |headers: &[(&str, &str)], params: serde_json::Value| {
            let body = serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": params,
            });
            let (s, _, r) = post(addr, Some(&token), headers, &body.to_string());
            (s, serde_json::from_slice::<serde_json::Value>(&r).unwrap())
        };
        let hdr = &[("Mcp-Method", "server/discover"), ("MCP-Protocol-Version", SPEC_REVISION)];

        // Missing header: a header fault, even though the body is fine.
        let (status, v) = call(&[("Mcp-Method", "server/discover")], serde_json::json!({ "_meta": meta() }));
        assert_eq!(status, 400);
        assert_eq!(v["error"]["code"], HEADER_MISMATCH);

        // Header present, body version missing: malformed params, NOT a
        // header fault. The distinction is what the spec asks for.
        let (status, v) = call(hdr, serde_json::json!({}));
        assert_eq!(status, 400);
        assert_eq!(v["error"]["code"], -32602);

        // Required client capabilities missing: also -32602.
        let mut only_version = serde_json::Map::new();
        only_version.insert(META_VERSION.into(), SPEC_REVISION.into());
        let (status, v) = call(hdr, serde_json::json!({ "_meta": only_version }));
        assert_eq!(status, 400);
        assert_eq!(v["error"]["code"], -32602);

        // Header and body disagree.
        let mut other = serde_json::Map::new();
        other.insert(META_VERSION.into(), "2019-01-01".into());
        other.insert(META_CAPABILITIES.into(), serde_json::json!({}));
        let (status, v) = call(hdr, serde_json::json!({ "_meta": other }));
        assert_eq!(status, 400);
        assert_eq!(v["error"]["code"], HEADER_MISMATCH);

        // Agreeing on a revision this server does not serve.
        let old = &[("Mcp-Method", "server/discover"), ("MCP-Protocol-Version", "2019-01-01")];
        let mut m = serde_json::Map::new();
        m.insert(META_VERSION.into(), "2019-01-01".into());
        m.insert(META_CAPABILITIES.into(), serde_json::json!({}));
        let (status, v) = call(old, serde_json::json!({ "_meta": m }));
        assert_eq!(status, 400);
        assert_eq!(v["error"]["code"], VERSION_MISMATCH);
        assert_eq!(v["error"]["data"]["supported"], serde_json::json!([SPEC_REVISION]));
    }

    #[test]
    fn mcp_name_must_mirror_the_called_tool_including_base64_form() {
        let (addr, token, _sd) = spawn(true);
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "project_list", "arguments": {}, "_meta": meta() },
        });
        let hdr = |extra: Option<&str>| {
            let mut h = vec![
                ("Mcp-Method".to_string(), "tools/call".to_string()),
                ("MCP-Protocol-Version".to_string(), SPEC_REVISION.to_string()),
            ];
            if let Some(n) = extra {
                h.push(("Mcp-Name".to_string(), n.to_string()));
            }
            h
        };
        let go = |h: Vec<(String, String)>| {
            let hh: Vec<(&str, &str)> = h.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            let (s, _, r) = post(addr, Some(&token), &hh, &body.to_string());
            (s, serde_json::from_slice::<serde_json::Value>(&r).unwrap())
        };

        let (status, v) = go(hdr(None));
        assert_eq!(status, 400, "Mcp-Name is required for tools/call");
        assert_eq!(v["error"]["code"], HEADER_MISMATCH);

        let (status, v) = go(hdr(Some("something_else")));
        assert_eq!(status, 400, "header must mirror params.name");
        assert_eq!(v["error"]["code"], HEADER_MISMATCH);

        let (status, _) = go(hdr(Some("project_list")));
        assert_eq!(status, 200);

        // The base64 sentinel has to be decoded before comparing, or a
        // conforming client with an awkward name is refused.
        let (status, _) = go(hdr(Some("=?base64?cHJvamVjdF9saXN0?=")));
        assert_eq!(status, 200, "=?base64?...?= must decode to project_list");
    }

    #[test]
    fn batches_and_idless_requests_are_invalid() {
        let (addr, token, _sd) = spawn(true);
        let (status, _, resp) = post(
            addr,
            Some(&token),
            &[("Mcp-Method", "server/discover")],
            r#"[{"jsonrpc":"2.0","id":1,"method":"server/discover"}]"#,
        );
        assert_eq!(status, 400);
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32600);
        // A request (non-notification method) with no id.
        let (status, v) = {
            let (s, _, r) = post(
                addr,
                Some(&token),
                &[("Mcp-Method", "server/discover")],
                r#"{"jsonrpc":"2.0","method":"server/discover"}"#,
            );
            (s, serde_json::from_slice::<serde_json::Value>(&r).unwrap())
        };
        assert_eq!(status, 400);
        assert_eq!(v["error"]["code"], -32600);
    }

    #[test]
    fn unknown_methods_are_method_not_found_at_404() {
        let (addr, token, _sd) = spawn(true);
        let (status, v) = rpc(
            addr,
            &token,
            "resources/list",
            serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "resources/list" }),
        );
        // 404 with a JSON-RPC body: the status says "not here", the
        // body says "this IS an MCP endpoint, that method is not".
        assert_eq!(status, 404);
        assert_eq!(v["error"]["code"], -32601);
    }

    // ── tool registry ────────────────────────────────────────────────

    fn call(
        addr: std::net::SocketAddr,
        token: &str,
        tool: &str,
        args: serde_json::Value,
    ) -> serde_json::Value {
        let (status, v) = rpc(
            addr,
            token,
            "tools/call",
            serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": tool, "arguments": args },
            }),
        );
        assert_eq!(status, 200, "{v}");
        v
    }

    #[test]
    fn tools_list_is_deterministic_and_carries_ttl() {
        let (addr, token, _sd) = spawn(true);
        let body = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
        let (status, v1) = rpc(addr, &token, "tools/list", body.clone());
        assert_eq!(status, 200);
        let (_, v2) = rpc(addr, &token, "tools/list", body);
        assert_eq!(v1, v2, "tools/list must be byte-stable");
        let tools = v1["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), TOOLS.len());
        // Wire order IS registry order.
        let names: Vec<_> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        let expected: Vec<_> = TOOLS.iter().map(|t| t.name).collect();
        assert_eq!(names, expected);
        // Top-level result fields, not _meta keys.
        assert_eq!(v1["result"]["ttlMs"], TOOLS_TTL_MS);
        assert_eq!(v1["result"]["cacheScope"], "public");
        assert!(v1["result"]["_meta"].get("ttlMs").is_none(), "ttlMs does not belong in _meta");
        assert_complete(&v1["result"]);
    }

    /// mcp.md: record the serialized size so surface growth is a
    /// conscious diff. Update RECORDED deliberately when the surface
    /// changes; the slack absorbs incidental wording tweaks.
    #[test]
    fn tools_list_size_is_a_conscious_diff() {
        let tools: Vec<_> = TOOLS.iter().map(tool_entry).collect();
        let size = serde_json::to_string(&tools).unwrap().len();
        // 11300. Up from 7600 when task_tab, task_tab_close,
        // task_agents and prompts landed and four verbs gained a `tab`
        // selector. That is roughly 45% more surface for full scope to
        // mean what it says, and it is the context cost mcp.md weighed
        // against the CLI: every client pays it per session, softened
        // only by the cache hints. Worth re-reading before the next
        // tool, not a number to keep nudging. The last 120 bytes buy
        // an explicit `destructiveHint: false` on the safe mutating
        // tools, because the schema's default for an omitted one is
        // TRUE and clients may prompt on ordinary calls without it.
        // 11400: task_new's `checkout` (an existing branch into a new
        // worktree), about 200 bytes with its description cut to the
        // one sentence an agent needs to pick it over `base`. In parallel,
        // task_new's `parentTask`, the one way an MCP caller can say which
        // task it runs in, so its children group under it.
        // 12100: task_group, so an agent can NAME the group its tasks
        // form (the CLI's `group`; every agent-facing verb ships on both).
        // 12250: task_send names the agent-to-agent signature, since an MCP
        // caller has no shell to fill it in and must write it out.
        // 16900: FULL CLI parity, decided by the maintainer: task_new's
        // --sandbox/--yolo/--model/--arg/--from/--resume/--open/--no-group/
        // -P, send's --here/-P, tab's -P/--resume, and the four scratchpad
        // tools with descriptions that steer agents off throwaway .md files.
        // Roughly 38% more per session, paid on purpose: "the MCP must be a
        // clone of the CLI". every_cli_flag_has_an_mcp_param_or_a_reason
        // keeps it that way.
        // 17100: the two lines above meeting in one tree (parity plus
        // `checkout`, which landed in parallel).
        // 17500: task_tab's `title` and `tab` (GH #331), parity with
        // `termic tab --title` / `--tab`: name a tab so it is a selector
        // that survives the agent retitling itself, and rename an open one
        // without a sixth tab tool. Descriptions cut to one clause each.
        // 17800: task_tab model/args, preserving CLI parity without adding
        // provider-specific model catalogues or a separate launch tool.
        // 18400: task_prop (GH #358), the `termic prop` verb: tab properties
        // agents set and the sidebar row collects. One tool for set, clear
        // and list, descriptions cut to a clause, the limits by name only.
        // 21664: schedule_list, schedule_show, schedule_set, schedule_run,
        // schedule_delete: recurring task schedules on both CLI and MCP.
        // 21850: task_send's `now`, parity with `termic send --now`:
        // skip a busy agent's queue for a message that cannot wait. One clause
        // on the param, three words on the tool, the rest in the CLI's help.
        // task_send's `now` became `queue` when sends turned immediate by
        // default: same size, the opposite default.
        // 21907: schedule_delete's `archiveTasks`, parity with `--archive-tasks`:
        // archive related tasks and delete reports.
        // 22350: scratchpad scope parameter for global and project scratchpads.
        // 22428: schedule_set's `date` and the `once` cadence, parity with
        // `termic schedule set --cadence once --date`: one run on a calendar
        // day, which no weekday preset can name. One short clause each.
        // 23636: scratchpad_remove and scratchpad_clear, parity with
        // `termic scratchpad rm` / `clear`: an agent that writes pads has to
        // be able to tidy them up. One clause each; most of the 1.2 KB is the
        // task/project/scope params every pad tool repeats.
        // 24953: task_review, parity with `termic review`: a PR reviewed in
        // its own task under a code-review library prompt. Params cut to a
        // few words each; the shape lives in `termic review --help`.
        // 26731: LAN pairing (docs/peers.md). peer_list / peer_pair /
        // peer_unpair / peer_rename for the `termic peer` verbs, and ONE
        // peer_call proxy for the global `--peer` flag instead of a `peer`
        // param on every tool, which would have cost about 4 KB more. Most
        // of the 1.8 KB is per-tool schema and annotation scaffolding; the
        // descriptions are a clause each.
        // 27191: an optional `peer` on the five verbs an orchestrator uses
        // across machines (task_list/new/send/wait/result), so the common
        // case reads `task_new {peer: "laptop"}` instead of a nested
        // peer_call. 92 bytes each; peer_call keeps the rest.
        // 27285: peer_pair takes the 4-digit code the other machine shows in
        // pairing mode (SPAKE2, docs/peers.md); one short param.
        // 27468: task_group moves a task (`join`, `leave`), parity with
        // `termic group --join/--leave`. Two short params and a clause.
        // 27788: task_new's `account`, parity with `termic new --account`,
        // and task_agents listing each agent's accounts (GH #278).
        // 28122: task_new's and task_tab's `prompt` say to sign it and ask
        // for a report back until a human says stop. An orchestrator using
        // task_new never saw the rule when its client dropped the server
        // instructions. The format itself stays in task_send, pointed at.
        // 28336: task_new's `members`, parity with `termic new --member`:
        // the multi-repo members a task worktrees. One sentence; the
        // refusals live in the server's errors.
        // 28396: task_send's `now` became `queue` (sends are immediate by
        // default), with a description that says what it waits for.
        const RECORDED: usize = 28396;
        assert!(
            size <= RECORDED,
            "serialized tools/list grew to {size} bytes (recorded {RECORDED}); grow it consciously"
        );
    }

    #[test]
    fn every_tool_has_a_valid_schema_and_no_em_dash() {
        for t in TOOLS {
            let entry = tool_entry(t);
            let schema = &entry["inputSchema"];
            assert_eq!(schema["type"], "object");
            for p in t.params {
                assert!(schema["properties"][p.name].is_object(), "{} lacks {}", t.name, p.name);
            }
            // Copy rule, same as the CLI's help sweep.
            assert!(!entry.to_string().contains('\u{2014}'), "{} copy has an em dash", t.name);
        }
        // Destructive verbs are annotated; reads are marked read-only.
        for (name, key) in [
            ("task_apply", "destructiveHint"),
            ("task_archive", "destructiveHint"),
            ("project_remove", "destructiveHint"),
            ("task_list", "readOnlyHint"),
            ("task_status", "readOnlyHint"),
        ] {
            let t = TOOLS.iter().find(|t| t.name == name).unwrap();
            assert_eq!(tool_entry(t)["annotations"][key], true, "{name}");
        }
    }

    #[test]
    fn tools_call_happy_path_reaches_dispatch() {
        let (addr, token, _sd) = spawn(true);
        // StubHost default carries three tasks in two projects.
        let v = call(addr, &token, "task_list", serde_json::json!({}));
        let r = &v["result"];
        assert_eq!(r["isError"], false);
        assert_eq!(r["structuredContent"]["kind"], "list");
        assert_eq!(r["structuredContent"]["tasks"].as_array().unwrap().len(), 3);
        assert_complete(r);
        // And the text block is the same JSON, for clients that only
        // read content.
        let text: serde_json::Value =
            serde_json::from_str(r["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(&text, &r["structuredContent"]);
    }

    #[test]
    fn a_peer_argument_is_peer_call_spelled_inline() {
        let (addr, token, _sd) = spawn(true);
        // Both forms reach the same forwarding path with the same command,
        // so whatever the stub answers for one it answers for the other.
        let inline = call(addr, &token, "task_list", serde_json::json!({ "peer": "laptop" }));
        let proxied = call(addr, &token, "peer_call", serde_json::json!({ "peer": "laptop", "tool": "task_list" }));
        assert!(inline.get("error").is_none(), "{inline}");
        assert_eq!(inline["result"], proxied["result"]);
        // Never treated as a local call: the stub's three local tasks are
        // not what came back.
        assert_ne!(inline["result"]["structuredContent"]["kind"], "list");
        // A blank peer is refused, not run here.
        let blank = call(addr, &token, "task_list", serde_json::json!({ "peer": " " }));
        assert!(blank["error"]["message"].as_str().unwrap().contains("peer"), "{blank}");
        // Only the five orchestration verbs take it.
        let other = call(addr, &token, "task_status", serde_json::json!({ "task": "x", "peer": "laptop" }));
        assert!(other["error"]["message"].as_str().unwrap().contains("unknown argument \"peer\""), "{other}");
    }

    #[test]
    fn dispatch_refusals_are_tool_errors_not_rpc_errors() {
        let (addr, token, _sd) = spawn(true);
        let v = call(addr, &token, "task_status", serde_json::json!({ "task": "no-such" }));
        let r = &v["result"];
        assert!(v.get("error").is_none(), "verb refusal must not be a JSON-RPC error");
        assert_eq!(r["isError"], true);
        assert_eq!(r["structuredContent"]["code"], "not_found");
        assert!(r["content"][0]["text"].as_str().unwrap().contains("no-such"));
    }

    #[test]
    fn ambiguous_task_names_come_back_typed() {
        let (addr, token, _sd) = spawn(true);
        // "fix-auth" exists in both stub projects.
        let v = call(addr, &token, "task_status", serde_json::json!({ "task": "fix-auth" }));
        assert_eq!(v["result"]["structuredContent"]["code"], "ambiguous");
    }

    #[test]
    fn the_http_status_rule_is_spec_first_then_json_rpc() {
        // -32602 comes back at two HTTP statuses and that is deliberate,
        // so pin it: the transport mandates 400 for header and version
        // faults, while an ordinary JSON-RPC error rides a 200 with the
        // error in the body. A client routing on status alone would
        // otherwise read a tool-argument mistake as success-shaped.
        let (addr, token, _sd) = spawn(true);
        // Envelope layer: spec-mandated 400.
        let (status, _, _) = post(addr, Some(&token), &[], r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#);
        assert_eq!(status, 400, "a missing standard header is a transport fault");
        // Inside tools/call: JSON-RPC error at 200.
        let v = call(addr, &token, "task_status", serde_json::json!({}));
        assert_eq!(v["error"]["code"], -32602);
    }

    #[test]
    fn bad_arguments_are_invalid_params() {
        let (addr, token, _sd) = spawn(true);
        // Missing required arg.
        let v = call(addr, &token, "task_status", serde_json::json!({}));
        assert_eq!(v["error"]["code"], -32602);
        assert!(v["error"]["message"].as_str().unwrap().contains("task"));
        // Wrong type.
        let v = call(addr, &token, "task_status", serde_json::json!({ "task": 7 }));
        assert_eq!(v["error"]["code"], -32602);
        // Unknown tool.
        let v = call(addr, &token, "task_attach", serde_json::json!({}));
        assert_eq!(v["error"]["code"], -32602);
    }

    #[test]
    fn task_tab_maps_each_kind_and_refuses_a_bogus_one() {
        // The kind decides sandbox, resume and YOLO behaviour, so a
        // wrong or silently-defaulted kind is the dangerous failure.
        let tab = TOOLS.iter().find(|t| t.name == "task_tab").unwrap();
        let build = |v: serde_json::Value| {
            let args = v.as_object().unwrap().clone();
            (tab.build)(&args)
        };
        let agent = build(serde_json::json!({ "task": "t", "kind": "agent", "agentId": "claude" })).unwrap();
        assert!(matches!(&agent, Command::Tab { kind: proto::TabKind::Agent { id }, .. } if id == "claude"));
        let term = build(serde_json::json!({ "task": "t", "kind": "terminal", "agentId": "shellish" })).unwrap();
        assert!(matches!(&term, Command::Tab { kind: proto::TabKind::Terminal { id }, .. } if id == "shellish"));
        assert!(matches!(
            build(serde_json::json!({ "task": "t", "kind": "shell" })).unwrap(),
            Command::Tab { kind: proto::TabKind::Shell, .. }
        ));
        assert!(matches!(
            build(serde_json::json!({ "task": "t", "kind": "default" })).unwrap(),
            Command::Tab { kind: proto::TabKind::Default, .. }
        ));

        // An unknown kind is refused by name rather than defaulted.
        let err = build(serde_json::json!({ "task": "t", "kind": "agnet" })).unwrap_err();
        assert!(err.contains("agnet") && err.contains("agent"), "{err}");
        // The id-bearing kinds say which field is missing.
        let err = build(serde_json::json!({ "task": "t", "kind": "agent" })).unwrap_err();
        assert!(err.contains("agentId"), "{err}");
    }

    #[test]
    fn task_prop_sets_clears_and_lists() {
        let tool = TOOLS.iter().find(|t| t.name == "task_prop").unwrap();
        let build = |v: serde_json::Value| (tool.build)(v.as_object().unwrap());
        let c = build(serde_json::json!({ "task": "t", "tab": "2", "key": "ticket", "value": "ABC-1" })).unwrap();
        assert!(matches!(&c, Command::Prop { tab: Some(tab), key: Some(k), value: Some(v), .. }
            if tab == "2" && k == "ticket" && v == "ABC-1"));
        // "" survives as the clear.
        let c = build(serde_json::json!({ "task": "t", "tab": "2", "key": "ticket", "value": "" })).unwrap();
        assert!(matches!(&c, Command::Prop { value: Some(v), .. } if v.is_empty()));
        // Bare: a list.
        let c = build(serde_json::json!({ "task": "t" })).unwrap();
        assert!(matches!(c, Command::Prop { tab: None, key: None, value: None, .. }));
        // It defaults to the caller's task, like the CLI.
        assert!(SELF_DEFAULT_TOOLS.contains(&"task_prop"));
        assert_eq!(tool_entry(tool)["annotations"]["destructiveHint"], false);
    }

    #[test]
    fn schedule_set_once_carries_its_date_and_refuses_a_bad_one() {
        let tool = TOOLS.iter().find(|t| t.name == "schedule_set").unwrap();
        let build = |v: serde_json::Value| (tool.build)(v.as_object().unwrap());
        let c = build(serde_json::json!({ "task": "t", "cadence": "once", "time": "09:00", "date": "2026-10-27" })).unwrap();
        assert!(matches!(&c, Command::ScheduleSet { cadence: Some(cad), .. }
            if cad.kind == "once" && cad.time == "09:00" && cad.date.as_deref() == Some("2026-10-27")));
        // Each mismatch is refused here, the same rule `termic schedule set`
        // applies before its socket (termic_proto::schedule_date_problem).
        for (bad, why) in [
            (serde_json::json!({ "task": "t", "cadence": "once", "time": "09:00" }), "needs a date"),
            (serde_json::json!({ "task": "t", "cadence": "daily", "time": "09:00", "date": "2026-10-27" }), "only goes with"),
            (serde_json::json!({ "task": "t", "date": "2026-10-27" }), "needs the once cadence"),
            (serde_json::json!({ "task": "t", "cadence": "once", "time": "09:00", "date": "27-10-2026" }), "real calendar day"),
            (serde_json::json!({ "task": "t", "cadence": "once", "time": "09:00", "date": "2026-02-30" }), "real calendar day"),
        ] {
            let err = build(bad.clone()).unwrap_err();
            assert!(err.contains(why), "{bad}: {err}");
        }
    }

    #[test]
    fn task_tab_titles_a_new_tab_or_renames_an_open_one() {
        let tab = TOOLS.iter().find(|t| t.name == "task_tab").unwrap();
        let build = |v: serde_json::Value| (tab.build)(v.as_object().unwrap());
        // Open mode: the title rides the open; "" is no title on the wire.
        let c = build(serde_json::json!({ "task": "t", "kind": "shell", "title": "logs" })).unwrap();
        assert!(matches!(&c, Command::Tab { title: Some(t), .. } if t == "logs"));
        let c = build(serde_json::json!({ "task": "t", "kind": "shell", "title": "" })).unwrap();
        assert!(matches!(c, Command::Tab { title: None, .. }));
        // Opening still needs a kind.
        assert!(build(serde_json::json!({ "task": "t", "title": "x" })).unwrap_err().contains("kind"));

        // Rename mode: `tab` + `title`, and "" survives as the reset.
        let c = build(serde_json::json!({ "task": "t", "tab": "2", "title": "impl" })).unwrap();
        assert!(matches!(&c, Command::TabRename { tab, title, .. } if tab == "2" && title == "impl"));
        let c = build(serde_json::json!({ "task": "t", "tab": "impl", "title": "" })).unwrap();
        assert!(matches!(&c, Command::TabRename { title, .. } if title.is_empty()));
        // A rename needs a title to rename to.
        assert!(build(serde_json::json!({ "task": "t", "tab": "2" })).unwrap_err().contains("title"));
        // And opens nothing: every open-only param is refused beside `tab`.
        for (k, v) in [
            ("kind", serde_json::json!("agent")),
            ("agentId", serde_json::json!("claude")),
            ("prompt", serde_json::json!("go")),
            ("library", serde_json::json!("builtin:review")),
            ("resume", serde_json::json!("abc")),
            ("wait", serde_json::json!(true)),
            ("timeoutMs", serde_json::json!(1000)),
        ] {
            let mut args = serde_json::json!({ "task": "t", "tab": "2", "title": "x" });
            args[k] = v;
            let err = build(args).unwrap_err();
            assert!(err.contains(k), "{k}: {err}");
        }
    }

    #[test]
    fn closing_a_tab_needs_an_explicit_target_and_guards_the_default_one() {
        let close = TOOLS.iter().find(|t| t.name == "task_tab_close").unwrap();
        let build = |v: serde_json::Value| (close.build)(v.as_object().unwrap());
        // No guessing which tab to close.
        assert!(build(serde_json::json!({ "task": "t" })).unwrap_err().contains("tab"));
        // The default tab stays guarded unless the caller opts in.
        let c = build(serde_json::json!({ "task": "t", "tab": "2" })).unwrap();
        assert!(matches!(&c, Command::TabClose { yes: false, tab, .. } if tab == "2"));
        let c = build(serde_json::json!({ "task": "t", "tab": "2", "allowDefault": true })).unwrap();
        assert!(matches!(c, Command::TabClose { yes: true, .. }));
        // And it is annotated so a client can confirm before calling.
        assert_eq!(tool_entry(close)["annotations"]["destructiveHint"], true);
    }

    #[test]
    fn tab_selectors_reach_the_verbs_that_accept_them() {
        // Creating a tab you cannot then address would be a half
        // feature: send, wait and log all take the selector task_tab
        // hands back.
        for name in ["task_send", "task_wait", "task_log"] {
            let t = TOOLS.iter().find(|t| t.name == name).unwrap();
            assert!(t.params.iter().any(|p| p.name == "tab"), "{name} takes no tab selector");
        }
        let send = TOOLS.iter().find(|t| t.name == "task_send").unwrap();
        let args = serde_json::json!({ "task": "t", "prompt": "p", "tab": "abc" });
        let cmd = (send.build)(args.as_object().unwrap()).unwrap();
        assert!(matches!(&cmd, Command::Send { tab: Some(t), .. } if t == "abc"));
        // Immediate unless asked to queue; resume/fresh spawn, so never `now`.
        assert!(matches!(&cmd, Command::Send { now: true, .. }));
        let args = serde_json::json!({ "task": "t", "prompt": "later", "queue": true });
        let cmd = (send.build)(args.as_object().unwrap()).unwrap();
        assert!(matches!(&cmd, Command::Send { now: false, .. }));
        let args = serde_json::json!({ "task": "t", "prompt": "p", "fresh": true });
        let cmd = (send.build)(args.as_object().unwrap()).unwrap();
        assert!(matches!(&cmd, Command::Send { now: false, .. }));
    }

    #[test]
    fn discovery_tools_take_no_target() {
        // task_agents exists so a caller can learn the ids task_new and
        // task_tab accept instead of guessing and reading a refusal.
        let agents = TOOLS.iter().find(|t| t.name == "task_agents").unwrap();
        assert!(agents.params.is_empty());
        assert!(matches!((agents.build)(&Args::new()).unwrap(), Command::Agents));
        assert_eq!(tool_entry(agents)["annotations"]["readOnlyHint"], true);

        // prompts folds the CLI's list/show split into one optional
        // selector, matching the wire.
        let prompts = TOOLS.iter().find(|t| t.name == "prompts").unwrap();
        assert!(matches!((prompts.build)(&Args::new()).unwrap(), Command::Prompts { selector: None }));
        let one = serde_json::json!({ "selector": "builtin:review" });
        assert!(matches!(
            (prompts.build)(one.as_object().unwrap()).unwrap(),
            Command::Prompts { selector: Some(s) } if s == "builtin:review"
        ));
    }

    #[test]
    fn wait_timeouts_are_clamped_to_the_cap() {
        let mut c = Command::Wait { task: Some("t".into()), project: None, timeout_ms: None, tab: None, cwd: None };
        clamp_wait(&mut c);
        assert!(matches!(c, Command::Wait { timeout_ms: Some(MCP_WAIT_CAP_MS), .. }));
        let mut c = Command::Wait { task: Some("t".into()), project: None, timeout_ms: Some(u64::MAX), tab: None, cwd: None };
        clamp_wait(&mut c);
        assert!(matches!(c, Command::Wait { timeout_ms: Some(MCP_WAIT_CAP_MS), .. }));
        let mut c = Command::Wait { task: Some("t".into()), project: None, timeout_ms: Some(1_000), tab: None, cwd: None };
        clamp_wait(&mut c);
        assert!(matches!(c, Command::Wait { timeout_ms: Some(1_000), .. }));
        // task_tab takes wait/timeoutMs too, and an unbounded wait
        // there holds a connection forever, which is the invariant the
        // cap exists for.
        let tab_cmd = |wait: bool, ms: Option<u64>| Command::Tab {
            agent_args: Vec::new(),
            task: Some("t".into()),
            project: None,
            kind: proto::TabKind::Shell,
            prompt: None,
            prompt_ref: None,
            wait,
            timeout_ms: ms,
            resume: None,
            title: None,
            cwd: None,
        };
        let mut c = tab_cmd(true, None);
        clamp_wait(&mut c);
        assert!(matches!(c, Command::Tab { timeout_ms: Some(MCP_WAIT_CAP_MS), .. }));
        let mut c = tab_cmd(true, Some(u64::MAX));
        clamp_wait(&mut c);
        assert!(matches!(c, Command::Tab { timeout_ms: Some(MCP_WAIT_CAP_MS), .. }));
        let mut c = tab_cmd(false, None);
        clamp_wait(&mut c);
        assert!(matches!(c, Command::Tab { timeout_ms: None, .. }));

        // send --wait is clamped; send without wait is left alone.
        let mut c = Command::Send { task: Some("t".into()), project: None, prompt: "p".into(), prompt_ref: None, resume: false, fresh: false, wait: true, timeout_ms: None, tab: None, now: false, cwd: None };
        clamp_wait(&mut c);
        assert!(matches!(c, Command::Send { timeout_ms: Some(MCP_WAIT_CAP_MS), .. }));
        let mut c = Command::Send { task: Some("t".into()), project: None, prompt: "p".into(), prompt_ref: None, resume: false, fresh: false, wait: false, timeout_ms: None, tab: None, now: false, cwd: None };
        clamp_wait(&mut c);
        assert!(matches!(c, Command::Send { timeout_ms: None, .. }));
    }

    #[test]
    fn task_wait_returns_outcome_and_state() {
        let (addr, token, _sd) = spawn_wait_host();
        let v = call(addr, &token, "task_wait", serde_json::json!({ "task": "solo" }));
        let r = &v["result"];
        assert_eq!(r["isError"], false, "{v}");
        assert_eq!(r["structuredContent"]["kind"], "wait");
        assert_eq!(r["structuredContent"]["outcome"], "done");
    }

    fn spawn_wait_host() -> (std::net::SocketAddr, String, Arc<AtomicBool>) {
        let host = Arc::new(StubHost::default());
        // Quiescent and capable: wait can settle immediately.
        host.push_states(&[(
            "w3",
            crate::cli_server::TaskAgentState { props: Default::default(),
                state: "done".into(),
                tabs: 1,
                queued: 0,
                capable: true,
                tab_states: Vec::new(),
                hydrated: true,
            },
        )]);
        spawn_with(host, Box::new(|| true))
    }

    // ── "you are inside Termic" guidance ─────────────────────────────

    /// The discover instructions and the CLI overview name tools and verbs
    /// in prose, which no compiler checks. A renamed or removed one would
    /// leave both texts sending agents to something that does not exist.
    #[test]
    fn inside_termic_guidance_only_names_things_that_exist() {
        for word in MCP_INSTRUCTIONS.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
            if (word.starts_with("task_") || word.starts_with("project_") || word.starts_with("scratchpad_") || word.starts_with("peer_")) && word.len() > 5 {
                assert!(TOOLS.iter().any(|t| t.name == word), "MCP_INSTRUCTIONS names unknown tool {word}");
            }
        }
        let help = termic_cli::machine_help();
        let overview = help["overview"].as_str().expect("help --json carries an overview");
        let verbs: Vec<&str> = help["commands"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
        // Every `backticked` word in the overview that looks like a verb is one.
        let globals: Vec<&str> =
            help["global_flags"].as_array().unwrap().iter().filter_map(|f| f["flag"].as_str()).collect();
        for chunk in overview.split('`').skip(1).step_by(2) {
            let verb = chunk.split_whitespace().next().unwrap_or("");
            // A global flag leads where it applies to every verb (`--peer`).
            if verb.starts_with("--") {
                assert!(globals.contains(&verb), "overview names unknown global flag `{verb}`");
                continue;
            }
            assert!(verbs.iter().any(|v| v.split(' ').next() == Some(verb)), "overview names unknown verb `{verb}`");
        }
        for text in [MCP_INSTRUCTIONS, overview] {
            assert!(text.contains("TERMIC_TASK_ID"), "says how an agent knows it is inside a task");
            assert!(text.contains("INSIDE a Termic task"));
            assert!(!text.contains('\u{2014}'), "no em dashes in agent-facing copy");
        }
    }

    #[test]
    fn discover_returns_the_instructions() {
        let (addr, token, _sd) = spawn(true);
        let (status, v) = rpc(
            addr,
            &token,
            "server/discover",
            serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "server/discover" }),
        );
        assert_eq!(status, 200);
        assert_eq!(v["result"]["instructions"], MCP_INSTRUCTIONS);
    }

    // ── registry parity vs machine_help() ────────────────────────────

    /// Drift gate (mcp.md "Registry parity"): both surfaces render from
    /// their own tables, so this test is what makes them ONE surface. A
    /// renamed verb, removed flag, or new full-scope verb goes red here
    /// until the MCP registry is updated deliberately.
    #[test]
    fn mcp_registry_matches_machine_help() {
        let help = termic_cli::machine_help();
        let commands = help["commands"].as_array().unwrap();
        let find = |verb: &str| {
            commands
                .iter()
                .find(|c| c["name"] == verb)
                .unwrap_or_else(|| panic!("machine_help has no verb \"{verb}\""))
        };
        for t in TOOLS {
            // peer_call presents a GLOBAL flag (`--peer` on every verb), not a
            // verb, so it is checked against the global flags instead.
            if t.cli_verb == GLOBAL_PEER_FLAG {
                let globals: Vec<&str> =
                    help["global_flags"].as_array().unwrap().iter().filter_map(|f| f["flag"].as_str()).collect();
                assert!(globals.contains(&GLOBAL_PEER_FLAG), "{} claims a global {GLOBAL_PEER_FLAG}", t.name);
                for p in t.params {
                    assert!(p.cli_flag.is_none_or(|f| f == GLOBAL_PEER_FLAG), "{}.{}", t.name, p.name);
                }
                continue;
            }
            let cmd = find(t.cli_verb);
            let positionals: Vec<&str> = cmd["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a["name"].as_str().unwrap())
                .collect();
            let flags: Vec<&str> = cmd["flags"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|f| f["flag"].as_str())
                .collect();
            for p in t.params {
                let Some(cli) = p.cli_flag else { continue };
                // `--peer` is global (every verb takes it), not in a verb's flags
                let found = if cli == GLOBAL_PEER_FLAG {
                    true
                } else if cli.starts_with("--") {
                    flags.contains(&cli)
                } else {
                    positionals.contains(&cli)
                };
                assert!(
                    found,
                    "{}.{} claims CLI arg \"{cli}\" on \"{}\", which has positionals {positionals:?} and flags {flags:?}",
                    t.name, p.name, t.cli_verb
                );
            }
        }
        // Reverse direction, and the one that matters: EVERY CLI verb is
        // either exposed or excluded on purpose. Checking against a list
        // of verbs we meant to expose is what let tab, tab close, agents
        // and prompts go missing without a test noticing, because the
        // list was written before some of them existed.
        //
        // Excluding a verb is a decision, so it is recorded here with
        // its reason and has to be made again deliberately when a new
        // verb lands.
        const EXCLUDED: &[(&str, &str)] = &[
            ("attach", "a live TTY stream is not a tool call"),
            ("quit", "tears down every agent; too destructive for a remote caller"),
            ("hello", "unauthenticated liveness probe, not a caller-facing verb"),
            ("raise", "second-instance handoff, meaningless over MCP"),
            ("open-url", "deep-link handoff from the OS, not a caller-facing verb"),
            ("path", "prints a path for shell substitution; callers get it from task_status"),
            ("help", "the CLI's own help; tools/list is the MCP equivalent"),
            ("prompts show", "folded into the prompts tool's optional selector, matching the wire"),
        ];
        for cmd in commands {
            let verb = cmd["name"].as_str().unwrap();
            let exposed = TOOLS.iter().any(|t| t.cli_verb == verb);
            let excluded = EXCLUDED.iter().any(|(v, _)| *v == verb);
            assert!(
                exposed || excluded,
                "CLI verb \"{verb}\" is neither exposed as a tool nor in EXCLUDED. \
                 Add a tool for it, or add it to EXCLUDED with the reason."
            );
            assert!(
                !(exposed && excluded),
                "CLI verb \"{verb}\" is both exposed and listed as excluded"
            );
        }
    }

    /// Flag-level parity, the gap `mcp_registry_matches_machine_help` left
    /// open: it proves every VERB is exposed, not every FLAG, which is how
    /// task_new ended up without --sandbox, --yolo, --model and seven more.
    /// Every CLI flag and positional maps to a tool param, or is listed here
    /// with the reason it has no MCP form. A new CLI flag fails this until
    /// someone decides.
    #[test]
    fn every_cli_flag_has_an_mcp_param_or_a_reason() {
        const UNMAPPED: &[(&str, &str, &str)] = &[
            ("send", "--now", "hidden no-op kept for old scripts; immediate is the default, `queue` is the param"),
            ("list", "--quiet", "output formatting; a tool returns structured JSON"),
            ("new", "--worktree", "the tool's single `mode` enum"),
            ("new", "--main", "the tool's single `mode` enum"),
            ("tab", "--terminal", "the tool's `kind` enum"),
            ("tab", "--shell", "the tool's `kind` enum"),
            ("apply", "--yes", "a TTY confirmation; the tool carries destructiveHint"),
            ("archive", "--yes", "a TTY confirmation; the tool carries destructiveHint"),
            ("project remove", "--yes", "a TTY confirmation; the tool carries destructiveHint"),
            ("peer unpair", "--yes", "a TTY confirmation; the tool carries destructiveHint"),
            ("schedule list", "--quiet", "output formatting; a tool returns structured JSON"),
            ("schedule set", "--no-catch-up", "the tool takes a boolean `catchUp` param"),
            ("schedule set", "--disable", "the tool takes a boolean `enabled` param"),
            ("schedule set", "--yes", "a TTY confirmation; the tool carries destructiveHint"),
            ("schedule delete", "--yes", "a TTY confirmation; the tool carries destructiveHint"),
            ("scratchpad list", "--global", "the tool's `scope` enum"),
            ("scratchpad new", "--global", "the tool's `scope` enum"),
            ("scratchpad write", "--global", "the tool's `scope` enum"),
            ("scratchpad read", "--global", "the tool's `scope` enum"),
            ("scratchpad rm", "--global", "the tool's `scope` enum"),
            ("scratchpad clear", "--global", "the tool's `scope` enum"),
        ];
        let help = termic_cli::machine_help();
        for c in help["commands"].as_array().unwrap() {
            let verb = c["name"].as_str().unwrap();
            let Some(tool) = TOOLS.iter().find(|t| t.cli_verb == verb) else { continue }; // verb-level EXCLUDED
            let mapped: Vec<&str> = tool.params.iter().filter_map(|p| p.cli_flag).collect();
            let args = c["args"].as_array().unwrap().iter().filter_map(|a| a["name"].as_str());
            let flags = c["flags"].as_array().unwrap().iter().filter_map(|f| f["flag"].as_str());
            for arg in args.chain(flags) {
                let allowed = UNMAPPED.iter().any(|(v, f, _)| *v == verb && *f == arg);
                assert!(
                    mapped.contains(&arg) || allowed,
                    "CLI `{verb} {arg}` has no param on {} and no reason in UNMAPPED",
                    tool.name
                );
            }
        }
    }

    // ── lifecycle pieces ─────────────────────────────────────────────

    #[test]
    fn safe_mutating_tools_say_so_rather_than_defaulting_to_destructive() {
        // An omitted destructiveHint means TRUE in the schema, and is
        // only meaningful when readOnlyHint is false. Omitting it on
        // task_send told conforming clients to treat an ordinary prompt
        // as destructive.
        for name in ["task_send", "task_new", "project_add", "task_tab"] {
            let t = TOOLS.iter().find(|t| t.name == name).unwrap();
            assert_eq!(
                tool_entry(t)["annotations"]["destructiveHint"], false,
                "{name} must say it is not destructive"
            );
        }
        for name in ["task_archive", "task_apply", "project_remove", "task_tab_close", "schedule_delete", "schedule_set"] {
            let t = TOOLS.iter().find(|t| t.name == name).unwrap();
            assert_eq!(tool_entry(t)["annotations"]["destructiveHint"], true, "{name}");
        }
        // Read-only tools carry readOnlyHint and no destructive claim,
        // which the schema says is meaningless there.
        let list = TOOLS.iter().find(|t| t.name == "task_list").unwrap();
        let ann = &tool_entry(list)["annotations"];
        assert_eq!(ann["readOnlyHint"], true);
        assert!(ann.get("destructiveHint").is_none());
    }

    #[test]
    fn codex_config_editing_leaves_everything_else_alone() {
        // This rewrites a file we do not own, and a config codex cannot
        // parse takes down its WHOLE setup, not just our entry.
        let helper = "printf '{}' x";
        let existing = "\
# a comment the user wrote\n\
[marketplaces.openai]\n\
source = \"local\"\n\
\n\
[features]\n\
js_repl = false\n\
\n\
[mcp_servers.other]\n\
command = \"/bin/true\"\n";
        let out = codex_config_with_termic(existing, "http://127.0.0.1:1/mcp", helper).unwrap();
        assert!(out.contains("# a comment the user wrote"), "comments survive");
        assert!(out.contains("[mcp_servers.other]") && out.contains("command = \"/bin/true\""));
        assert!(out.contains("js_repl = false"));
        assert_eq!(out.matches("[features]").count(), 1, "joins the existing table");
        assert!(out.contains("mcp_2026_07_28 = true"));
        assert!(out.contains(helper));
        assert!(toml_edit::DocumentMut::from_str(&out).is_ok(), "output must parse");

        // Re-running replaces our entry rather than adding another.
        let twice = codex_config_with_termic(&out, "http://127.0.0.1:2/mcp", helper).unwrap();
        assert!(toml_edit::DocumentMut::from_str(&twice).is_ok());
        assert!(twice.contains("http://127.0.0.1:2/mcp") && !twice.contains("127.0.0.1:1"));
        assert_eq!(twice.matches("mcp_2026_07_28").count(), 1);
        assert!(twice.contains("[mcp_servers.other]"));
    }

    #[test]
    fn codex_config_editing_handles_the_shapes_a_line_scan_missed() {
        let helper = "printf x";
        // A quoted table header and a dotted key are the same entry as
        // far as TOML is concerned. Appending a second [mcp_servers.termic]
        // beside either produced a duplicate-key error, so codex refused
        // to load ANY of its config.
        for existing in [
            "[mcp_servers.\"termic\"]\nurl = \"http://old/mcp\"\n",
            "[mcp_servers]\ntermic = { url = \"http://old/mcp\" }\n",
        ] {
            let out = codex_config_with_termic(existing, "http://new/mcp", helper).unwrap();
            assert!(
                toml_edit::DocumentMut::from_str(&out).is_ok(),
                "must stay parseable for {existing:?}, got:\n{out}"
            );
            assert!(out.contains("http://new/mcp"), "the url updates");
            assert!(!out.contains("http://old/mcp"), "the old entry is replaced, not duplicated");
        }
    }

    #[test]
    fn a_wrongly_shaped_codex_config_is_refused_not_panicked_on() {
        // Parseable TOML can still hold these keys as the wrong kind.
        // Indexing them panicked, which reached the user as
        // "task <n> panicked" and only AFTER the backup was written.
        for existing in [
            "[[mcp_servers]]\nname = \"x\"\n",   // array of tables
            "features = \"on\"\n",               // scalar where a table goes
            "mcp_servers = 3\n",
        ] {
            let out = codex_config_with_termic(existing, "http://x/mcp", "printf x");
            assert!(out.is_err(), "expected a refusal for {existing:?}, got Ok");
            assert!(out.unwrap_err().contains("left alone"));
        }
    }

    #[test]
    fn an_unparseable_codex_config_is_refused_not_overwritten() {
        // Better their broken file than ours on top of it.
        let err = codex_config_with_termic("[[[not toml", "http://x/mcp", "printf x").unwrap_err();
        assert!(err.contains("left alone"), "{err}");
    }

    #[test]
    fn a_project_scoped_entry_is_reported_because_it_wins() {
        // Writing the user-scoped entry and reporting plain success is a
        // lie wherever a project scope defines the same name: claude
        // prefers the narrower one, so the tools never mount there.
        let doc = serde_json::json!({
            "mcpServers": { "termic": { "type": "http" } },
            "projects": {
                "/work/app": { "mcpServers": { "termic": { "headers": {} } } },
                "/work/other": { "mcpServers": { "something-else": {} } },
                "/work/none": {}
            }
        });
        let found = project_scopes_with_termic(&doc);
        assert_eq!(found, vec!["/work/app".to_string()]);

        // Nothing to warn about in the common case.
        assert!(project_scopes_with_termic(&serde_json::json!({ "projects": {} })).is_empty());
        assert!(project_scopes_with_termic(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn the_pasted_codex_block_parses_even_with_an_apostrophe_in_the_path() {
        // The page used to build this block in TypeScript by dropping a
        // shell-escaped path into a TOML BASIC string, where \' is not a
        // legal escape: /Users/O'Brien produced a block that does not
        // parse, and by this feature's own reasoning an unparseable
        // config.toml makes codex refuse ALL of it. Rendering through
        // toml_edit makes the escaping its problem.
        for path in [
            "/Users/plain/mcp-token",
            "/Users/O'Brien/Library/Application Support/termic/mcp-token",
            "/Users/back\\slash/mcp-token",
        ] {
            let helper = helper_command(Path::new(path));
            let block = codex_block("http://127.0.0.1:1/mcp", &helper);
            let doc = toml_edit::DocumentMut::from_str(&block)
                .unwrap_or_else(|e| panic!("block for {path} does not parse: {e}\n{block}"));
            // And the helper survives the round trip intact.
            let got = doc["mcp_servers"]["termic"]["http_headers_helper"].as_str().unwrap();
            assert_eq!(got, helper, "helper mangled for {path}");
        }
    }

    #[test]
    fn registration_is_read_from_both_clients_configs() {
        assert!(claude_doc_has_termic(&serde_json::json!({ "mcpServers": { "termic": { "type": "http" } } })));
        // A project-scoped entry is not the user one the button writes.
        assert!(!claude_doc_has_termic(&serde_json::json!({ "projects": { "/x": { "mcpServers": { "termic": {} } } } })));
        assert!(!claude_doc_has_termic(&serde_json::json!({})));
        assert!(codex_text_has_termic("[mcp_servers.termic]\nurl = \"http://127.0.0.1:1/mcp\"\n"));
        assert!(codex_text_has_termic("[mcp_servers.\"termic\"]\nurl = \"u\"\n"));
        assert!(!codex_text_has_termic("[mcp_servers.other]\nurl = \"u\"\n"));
        assert!(!codex_text_has_termic("not = [valid"));
    }

    #[test]
    fn the_pasted_claude_command_is_one_shell_argument() {
        let helper = helper_command(Path::new("/Users/O'Brien/mcp-token"));
        let cmd = claude_command("http://127.0.0.1:1/mcp", &helper);
        // Everything between the name and the flag is a single quoted
        // argument; unbalanced quoting would split it.
        let arg = cmd
            .strip_prefix("claude mcp add-json termic ")
            .and_then(|r| r.strip_suffix(" -s user"))
            .expect("shape");
        assert!(arg.starts_with('\'') && arg.ends_with('\''));
        // Undo the shell's own unquoting to get the JSON back.
        let unquoted = arg[1..arg.len() - 1].replace("'\\''", "'");
        let v: serde_json::Value = serde_json::from_str(&unquoted).expect("argument is JSON");
        assert_eq!(v["headersHelper"].as_str().unwrap(), helper);
    }

    #[test]
    fn the_helper_command_survives_an_apostrophe_in_the_path() {
        let cmd = sh_helper_command(Path::new("/Users/O'Brien/mcp-token"));
        // Closed, escaped, reopened: the shell must see one argument.
        assert!(cmd.contains(r"'/Users/O'\''Brien/mcp-token'"), "{cmd}");
        assert!(cmd.contains(MCP_TOKEN_HEADER));
    }

    #[test]
    fn the_windows_helper_is_the_sidecar_and_survives_both_config_formats() {
        // No `$(...)`, no `printf`, nothing cmd.exe would have to
        // understand: claude runs the helper there, and the POSIX line
        // printed no token. Backslashes and a space are the hard case for
        // the two formats it is written into.
        let helper = windows_helper_command(
            Path::new(r"C:\Users\bob smith\AppData\Local\Termic\termic-cli.exe"),
            Path::new(r"C:\Users\bob smith\AppData\Local\termic\mcp-token"),
        );
        assert_eq!(
            helper,
            r#""C:\Users\bob smith\AppData\Local\Termic\termic-cli.exe" mcp-headers "C:\Users\bob smith\AppData\Local\termic\mcp-token""#
        );
        assert!(!helper.contains('$') && !helper.contains("printf"));
        let block = codex_block("http://127.0.0.1:1/mcp", &helper);
        let doc = toml_edit::DocumentMut::from_str(&block).expect("codex block parses");
        assert_eq!(doc["mcp_servers"]["termic"]["http_headers_helper"].as_str().unwrap(), helper);
        let json = serde_json::json!({ "headersHelper": helper }).to_string();
        let back: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(back["headersHelper"].as_str().unwrap(), helper);
    }

    /// Run the helper the way a client does (through sh, in the agent's
    /// environment) and parse what it prints.
    fn run_helper(token_file: &Path, task: Option<&str>) -> serde_json::Value {
        let mut cmd = std::process::Command::new("sh");
        cmd.arg("-c").arg(sh_helper_command(token_file)).env_remove("TERMIC_TASK_ID");
        if let Some(t) = task {
            cmd.env("TERMIC_TASK_ID", t);
        }
        let out = cmd.output().unwrap();
        serde_json::from_slice(&out.stdout).unwrap_or_else(|e| panic!("helper printed non-JSON ({e}): {:?}", String::from_utf8_lossy(&out.stdout)))
    }

    #[test]
    fn the_helper_sends_the_agents_own_task_from_its_environment() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("mcp-token");
        std::fs::write(&f, "tok123").unwrap();
        let inside = run_helper(&f, Some("task-abc"));
        assert_eq!(inside[MCP_TOKEN_HEADER], "tok123");
        assert_eq!(inside[MCP_TASK_HEADER], "task-abc");
        // Outside Termic the header is empty, which the server ignores.
        assert_eq!(run_helper(&f, None)[MCP_TASK_HEADER], "");
    }

    fn build(tool: &str, args: serde_json::Value) -> Result<Command, String> {
        let t = TOOLS.iter().find(|t| t.name == tool).unwrap();
        (t.build)(args.as_object().unwrap())
    }

    #[test]
    fn task_new_takes_the_cli_new_flags() {
        let Command::New { agent_args, sandbox, yolo, account, open, from, resume, prompt_ref, parent_task, .. } = build(
            "task_new",
            serde_json::json!({
                "name": "x", "args": ["--effort", "low"], "model": "worker", "sandbox": "monitor",
                "yolo": true, "account": "work", "open": true, "from": "/w", "resume": "S1", "library": "builtin:review",
                "parentTask": "p",
            }),
        ).unwrap() else { panic!() };
        // Composed exactly as `termic new --arg ... --model ...` composes it.
        assert_eq!(agent_args, ["--effort", "low", "--model", "worker"]);
        assert_eq!((sandbox.as_deref(), yolo, open), (Some("monitor"), true, true));
        assert_eq!(account.as_deref(), Some("work"));
        assert_eq!((from.as_deref(), resume.as_deref(), prompt_ref.as_deref()), (Some("/w"), Some("S1"), Some("builtin:review")));
        assert_eq!(parent_task.as_deref(), Some("p"));
        // noGroup beats an explicit parent AND the caller default.
        let Command::New { parent_task, .. } = build("task_new", serde_json::json!({ "name": "x", "parentTask": "p", "noGroup": true })).unwrap() else { panic!() };
        assert_eq!(parent_task, None);
        assert!(build("task_new", serde_json::json!({ "name": "x", "args": [1] })).is_err(), "argv entries are strings");
        // `members` is `--member` repeated, names passed through for the server to resolve.
        let Command::New { members, .. } = build("task_new", serde_json::json!({ "name": "x", "members": ["api", "Web"] })).unwrap() else { panic!() };
        assert_eq!(members, ["api", "Web"]);
        let Command::New { members, .. } = build("task_new", serde_json::json!({ "name": "x" })).unwrap() else { panic!() };
        assert!(members.is_empty());
        assert!(build("task_new", serde_json::json!({ "name": "x", "members": "api" })).is_err(), "an array, not one name");
    }

    #[test]
    fn task_send_takes_a_library_prompt_alone_but_not_nothing() {
        let Command::Send { prompt, prompt_ref, .. } = build("task_send", serde_json::json!({ "task": "t", "library": "builtin:review" })).unwrap() else { panic!() };
        assert_eq!((prompt.as_str(), prompt_ref.as_deref()), ("", Some("builtin:review")));
        assert!(build("task_send", serde_json::json!({ "task": "t" })).is_err());
    }

    #[test]
    fn caller_defaults_fill_only_what_the_cli_would_and_never_override() {
        let empty = Args::new();
        let d = with_caller_defaults("task_new", &empty, Some("me"));
        assert_eq!(d.get("parentTask").and_then(|v| v.as_str()), Some("me"));
        for t in SELF_DEFAULT_TOOLS {
            assert_eq!(with_caller_defaults(t, &empty, Some("me")).get("task").and_then(|v| v.as_str()), Some("me"));
        }
        // Explicit arguments win.
        let mut given = Args::new();
        given.insert("task".into(), "other".into());
        assert_eq!(with_caller_defaults("task_rename", &given, Some("me"))["task"], "other");
        // `send --here` is the only way send aims at the caller.
        let mut here = Args::new();
        here.insert("here".into(), true.into());
        assert_eq!(with_caller_defaults("task_send", &here, Some("me"))["task"], "me");
        for t in ["scratchpad_new", "scratchpad_write", "scratchpad_read", "scratchpad_list", "scratchpad_remove", "scratchpad_clear"] {
            assert_eq!(with_caller_defaults(t, &empty, Some("me"))["task"], "me", "{t}");
        }
        // Verbs the CLI never aims at "your own task" are left alone.
        assert!(with_caller_defaults("task_archive", &empty, Some("me")).is_empty());
        assert!(with_caller_defaults("task_send", &empty, Some("me")).is_empty());
        // No header, no defaults.
        assert!(with_caller_defaults("task_new", &empty, None).is_empty());
    }

    #[test]
    fn a_self_tool_uses_the_callers_task_header_and_refuses_without_it() {
        let (addr, token, _sd) = spawn(true);
        let body = |args: serde_json::Value| {
            let mut b = serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "task_group", "arguments": args },
            });
            b["params"]["_meta"] = meta();
            b.to_string()
        };
        let headers = |task: Option<&'static str>| {
            let mut h = vec![
                ("Mcp-Method", "tools/call"),
                ("Mcp-Name", "task_group"),
                ("MCP-Protocol-Version", SPEC_REVISION),
                ("Content-Type", "application/json"),
            ];
            if let Some(t) = task {
                h.push((MCP_TASK_HEADER, t));
            }
            h
        };
        // With the header: `group` alone reports the CALLER's task (w3 = solo).
        let (status, _, resp) = post(addr, Some(&token), &headers(Some("w3")), &body(serde_json::json!({})));
        assert_eq!(status, 200);
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["result"]["isError"], false, "{v}");
        assert!(v["result"]["structuredContent"]["task"].as_str().unwrap().ends_with("/solo"), "{v}");
        // Without it: a clear refusal saying how to fix it, never a guess.
        let (_, _, resp) = post(addr, Some(&token), &headers(None), &body(serde_json::json!({})));
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v["error"]["message"].as_str().unwrap().contains("did not say which Termic task"), "{v}");
    }

    #[test]
    fn port_file_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(MCP_PORT_FILE), format!("{}\n", url_for(43812))).unwrap();
        assert_eq!(port_from_file(dir.path()), Some(43812));
        assert_eq!(port_from_file(Path::new("/nonexistent")), None);
        std::fs::write(dir.path().join(MCP_PORT_FILE), "garbage\n").unwrap();
        assert_eq!(port_from_file(dir.path()), None);
    }

    #[test]
    fn shutdown_flag_stops_the_accept_loop() {
        let (addr, _token, sd) = spawn(true);
        sd.store(true, Ordering::SeqCst);
        // Unblock accept; the loop must exit and stop answering.
        let _ = TcpStream::connect(addr);
        std::thread::sleep(Duration::from_millis(50));
        let refused = TcpStream::connect_timeout(&addr, Duration::from_millis(200))
            .map(|mut s| {
                // Listener object still exists in the parked thread only
                // if the loop failed to exit; a live loop would answer.
                let _ = s.write_all(b"GET / HTTP/1.1\r\n\r\n");
                let mut buf = [0u8; 1];
                matches!(s.read(&mut buf), Ok(0) | Err(_))
            })
            .unwrap_or(true);
        assert!(refused, "listener kept serving after shutdown");
    }

    /// A restart must not invalidate configs holding the last token, so
    /// the copy affordance only reads a file this server would have
    /// written, so a hand-made or loosened one is not handed out.
    #[cfg(unix)]
    #[test]
    fn token_from_file_accepts_only_a_file_this_server_wrote() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(MCP_TOKEN_FILE);

        assert_eq!(token_from_file(dir.path()), None, "no file yet");

        let good = cli_server::mint_token();
        cli_server::write_token_file(&path, &good).unwrap();
        assert_eq!(
            token_from_file(dir.path()),
            Some(good.clone()),
            "a token this server wrote must be readable for the copy affordance"
        );

        // Trailing newline is the shape a hand-edited file takes.
        std::fs::write(&path, format!("{good}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(token_from_file(dir.path()), Some(good.clone()), "trimmed");

        for bad in [&good[..63], "", "zz"] {
            cli_server::write_token_file(&path, bad).unwrap();
            assert_eq!(token_from_file(dir.path()), None, "rejects {bad:?}");
        }
        let non_hex = "g".repeat(64);
        cli_server::write_token_file(&path, &non_hex).unwrap();
        assert_eq!(token_from_file(dir.path()), None, "rejects non-hex");

        // Readable by anyone else is not a credential we will keep using.
        cli_server::write_token_file(&path, &good).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(token_from_file(dir.path()), None, "rejects loose mode");
    }
}

