//! MCP endpoint, Phase A (docs/plans/mcp.md): a loopback HTTP listener
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
use std::net::{TcpListener, TcpStream};
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
    backoff: Mutex<Backoff>,
}

impl McpServer {
    pub(crate) fn new(
        token: String,
        host: Arc<dyn CliHost>,
        enabled: Box<dyn Fn() -> bool + Send + Sync>,
        retired: Arc<AtomicBool>,
    ) -> Self {
        McpServer { retired, token, host, enabled, backoff: Mutex::new(Backoff { failures: 0 }) }
    }
}

/// What revocation removes. One definition, because three copies of
/// "delete the token then the port file" means a change to the contract
/// can leave one path still advertising a dead endpoint.
fn revoke_advertisement(dir: &Path) {
    for f in [MCP_TOKEN_FILE, MCP_PORT_FILE] {
        let _ = std::fs::remove_file(dir.join(f));
    }
}

/// Revoke the credential but KEEP the port memo, for the one case where
/// forgetting the port is the dangerous half: a port we advertised is now
/// held by someone else.
///
/// The token has to go, or a client still pointed at that port reads it
/// and hands it to whoever answers there. The port must NOT go with it.
/// It is the only durable record of what clients were told, and a later
/// bind that cannot find it binds somewhere else and mints a fresh token,
/// which those same clients then send to the squatter: the handoff the
/// refusal exists to prevent, one restart later.
fn revoke_credential(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(MCP_TOKEN_FILE));
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
    if let Ok(dir) = crate::data_dir() {
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
                _ if k == MCP_TOKEN_HEADER.to_ascii_lowercase() => {
                    termic_token = Some(v.to_string())
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
        if !host_is_loopback(h) {
            return respond(stream, 403, b"");
        }
    }
    // 3. Setting, re-read per request: merged is not live, and the
    //    unbind on disable races in-flight connections. The retired
    //    check is the half the setting cannot cover: a quick off/on
    //    leaves the setting true again while this worker still holds
    //    the previous listener's revoked token.
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
    let name = match host.strip_prefix('[') {
        // [::1]:port -> ::1
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(""),
    };
    matches!(name, "127.0.0.1" | "localhost" | "::1")
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
            })),
        ),
        "tools/list" => tools_list(id),
        "tools/call" => tools_call(server, id, &params),
        // A method this server does not implement is 404 at the HTTP
        // layer; the JSON-RPC body is what separates it from a 404 out
        // of something that is not an MCP endpoint at all.
        _ => rpc_error(id, 404, -32601, &format!("unknown method \"{method}\"")),
    }
}

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
const MCP_WAIT_CAP_MS: u64 = 300_000;

/// tools/list result ttl hint: the surface only changes with the app
/// binary, so clients may cache generously (blunts the context cost).
const TOOLS_TTL_MS: u64 = 3_600_000;

type Args = serde_json::Map<String, serde_json::Value>;

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

fn arg_u64(a: &Args, k: &str) -> Result<Option<u64>, String> {
    match a.get(k) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => v.as_u64().map(Some).ok_or_else(|| format!("\"{k}\" must be a non-negative integer")),
    }
}

/// Shared param blurbs. Unlike the CLI there is no cwd fallback on this
/// surface (an outside client has no meaningful cwd), so `task` is
/// required wherever the CLI would have inferred it.
const P_TASK: ParamDef = ParamDef {
    name: "task",
    json_type: "string",
    required: true,
    description: "Task name or id.",
    cli_flag: Some("task"),
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
        }],
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
            ParamDef { name: "prompt", json_type: "string", required: false, description: "First prompt for the agent.", cli_flag: Some("--prompt") },
            ParamDef { name: "agent", json_type: "string", required: false, description: "Agent CLI id (see the project's registry); default is the project's.", cli_flag: Some("--agent") },
            // The CLI splits this into --worktree/--main; the wire field
            // is one string, and a tool enum beats two mutually
            // exclusive booleans, so this param is MCP-shaped (no 1:1
            // CLI flag to assert against).
            ParamDef { name: "mode", json_type: "string", required: false, description: "\"worktree\" for a task on its own git worktree and branch, or \"main\" to work in the project's main checkout. Omitted means the app's last-used mode, so pass it when the answer matters.", cli_flag: None },
            ParamDef { name: "base", json_type: "string", required: false, description: "Base branch for a worktree task.", cli_flag: Some("--base") },
            P_WAIT,
            P_TIMEOUT,
        ],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::New {
            name: need_str(a, "name")?,
            prompt: arg_str(a, "prompt")?,
            // The prompt-library selector (CLI -P/--library) has no MCP
            // param in Phase A: the tool surface mirrors the design
            // doc's verb list, and widening it is a scope decision.
            prompt_ref: None,
            agent: arg_str(a, "agent")?,
            mode: arg_str(a, "mode")?,
            base: arg_str(a, "base")?,
            from: None,
            resume: None,
            sandbox: None,
            yolo: false,
            project: arg_str(a, "project")?,
            open: false,
            wait: arg_bool(a, "wait")?,
            timeout_ms: arg_u64(a, "timeoutMs")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "task_send",
        cli_verb: "send",
        description: "Prompt the task's running agent (queued if busy). With no agent running, resume restores the last session and fresh spawns a new one.",
        params: &[
            P_TASK,
            P_PROJECT,
            ParamDef { name: "prompt", json_type: "string", required: true, description: "The prompt to deliver.", cli_flag: Some("--prompt") },
            ParamDef { name: "resume", json_type: "boolean", required: false, description: "No agent running: restore the last session, then deliver.", cli_flag: Some("--resume") },
            ParamDef { name: "fresh", json_type: "boolean", required: false, description: "No agent running: spawn a fresh agent, then deliver. Refused alongside tab, which targets something already open.", cli_flag: Some("--fresh") },
            P_TAB,
            P_WAIT,
            P_TIMEOUT,
        ],
        destructive: false,
        read_only: false,
        build: |a| Ok(Command::Send {
            task: Some(need_str(a, "task")?),
            project: arg_str(a, "project")?,
            prompt: need_str(a, "prompt")?,
            prompt_ref: None, // see task_new
            resume: arg_bool(a, "resume")?,
            fresh: arg_bool(a, "fresh")?,
            wait: arg_bool(a, "wait")?,
            timeout_ms: arg_u64(a, "timeoutMs")?,
            tab: arg_str(a, "tab")?,
            cwd: None,
        }),
    },
    ToolDef {
        name: "task_wait",
        cli_verb: "wait",
        description: "Block until the task's agent is quiescent (settled turn, empty queue) or the timeout expires, whichever is first; returns {outcome, state}. Bounded: loop on outcome \"timeout\" to keep waiting. Settle detection is heuristic.",
        params: &[P_TASK, P_PROJECT, P_TAB, P_TIMEOUT],
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
        params: &[P_TASK, P_PROJECT],
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
            P_TASK,
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
        description: "Open a tab inside a running task (the app's \"+\" menu as a tool), optionally delivering a first prompt to it. Returns the new tab's id, which is the stable selector other tools take.",
        params: &[
            P_TASK,
            P_PROJECT,
            // The kind is explicit rather than free text because the
            // kinds differ in sandbox, resume and YOLO behaviour, and a
            // typo must not land the caller in the wrong semantics.
            ParamDef { name: "kind", json_type: "string", required: true, description: "\"agent\" (needs agentId), \"terminal\" (needs agentId naming a terminal entry), \"shell\" for a plain login shell, or \"default\" for another tab of whatever the task already runs.", cli_flag: None },
            ParamDef { name: "agentId", json_type: "string", required: false, description: "Registry id for the agent and terminal kinds; see task_agents. Ignored by the other kinds.", cli_flag: Some("--agent") },
            ParamDef { name: "prompt", json_type: "string", required: false, description: "Deliver this prompt into the tab just opened (agent kinds only).", cli_flag: Some("--prompt") },
            P_WAIT,
            P_TIMEOUT,
        ],
        destructive: false,
        read_only: false,
        build: |a| {
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
                task: Some(need_str(a, "task")?),
                project: arg_str(a, "project")?,
                kind,
                prompt: arg_str(a, "prompt")?,
                prompt_ref: None,
                wait: arg_bool(a, "wait")?,
                timeout_ms: arg_u64(a, "timeoutMs")?,
                resume: None,
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
        name: "task_agents",
        cli_verb: "agents",
        description: "List the agent CLIs this app can run: the ids task_new and task_tab accept, with whether each is installed and usable. Without this a caller has to guess an agent id and read the refusal.",
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
];

fn tool_schema(t: &ToolDef) -> serde_json::Value {
    let mut props = serde_json::Map::new();
    let mut required = Vec::new();
    for p in t.params {
        props.insert(
            p.name.into(),
            serde_json::json!({ "type": p.json_type, "description": p.description }),
        );
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
fn clamp_wait(cmd: &mut Command) {
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
struct NoopSink;

impl cli_server::EventSink for NoopSink {
    fn emit(&mut self, _ev: &proto::StreamEvent) -> std::io::Result<()> {
        Ok(())
    }
}

fn tools_call(server: &McpServer, id: serde_json::Value, params: &serde_json::Value) -> (u16, Vec<u8>) {
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
    // Every schema advertises `additionalProperties: false`; enforce it
    // rather than trusting clients to validate. Silently ignoring a typo
    // like `timeoutMS` would change behaviour without saying so (that
    // one turns a short wait into the five-minute cap).
    if let Some(unknown) = args.keys().find(|k| !tool.params.iter().any(|p| p.name == k.as_str())) {
        return rpc_error(id, 200, -32602, &format!("unknown argument \"{unknown}\" for tool \"{name}\""));
    }
    let mut cmd = match (tool.build)(args) {
        Ok(c) => c,
        Err(msg) => return rpc_error(id, 200, -32602, &msg),
    };
    clamp_wait(&mut cmd);

    let req = Request {
        id: match &id {
            serde_json::Value::String(s) => format!("mcp-{s}"),
            other => format!("mcp-{other}"),
        },
        token: None,
        cmd,
    };
    let reply = cli_server::dispatch_authenticated(&req, server.host.as_ref(), &mut NoopSink);
    rpc_result(id, tool_reply_payload(reply))
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
}

fn state() -> &'static Mutex<McpState> {
    static STATE: OnceLock<Mutex<McpState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(McpState::default()))
}

/// Bind the advertised port, preferring `preferred` so client configs
/// survive, or a fresh one when there is nothing to reclaim. `Err(PortTaken)` when a port we previously advertised is
/// held by someone else, which is NOT a case to paper over: see
/// apply_enabled.
fn bind_listener(preferred: Option<u16>) -> Result<TcpListener, BindFailure> {
    match preferred.filter(|p| *p != 0) {
        Some(p) => TcpListener::bind(("127.0.0.1", p)).map_err(|_| BindFailure::PortTaken(p)),
        None => TcpListener::bind(("127.0.0.1", 0)).map_err(BindFailure::Io),
    }
}

#[derive(Debug)]
enum BindFailure {
    /// Someone else holds the port our clients were told to use.
    PortTaken(u16),
    Io(std::io::Error),
}

fn url_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

/// The credential currently on disk, when the file is one this server
/// would have written: 64 hex chars, owner-only. Used to hand the value
/// to the Settings copy affordance, NOT to adopt a token at bind time,
/// which would let a credential outlive the port that vouched for it
/// (see the mint-per-bind note in apply_enabled).
fn token_from_file(dir: &Path) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(MCP_TOKEN_FILE);
    let meta = std::fs::metadata(&path).ok()?;
    if meta.permissions().mode() & 0o077 != 0 {
        return None;
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
    let rest = url.strip_prefix("http://127.0.0.1:")?;
    rest.split('/').next()?.parse().ok()
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
    let mut st = state().lock().unwrap();
    match (on, st.handle.is_some()) {
        (true, false) => {
            let Ok(dir) = crate::data_dir() else {
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
            let preferred = st.last_port.or_else(|| port_from_file(&dir));
            let listener = match bind_listener(preferred) {
                Ok(l) => l,
                // Moving to a different port silently is the dangerous
                // option, not the safe one. Client configs hold the OLD
                // url and a helper that reads the CURRENT token file, so
                // the next client start would hand a freshly minted,
                // valid token to whatever process now answers on that
                // port, and it could spend it against us. Refuse to
                // serve, and take the advertisement down so there is no
                // token left for a squatter to be handed.
                Err(BindFailure::PortTaken(p)) => {
                    dlog(&format!(
                        "[mcp] port {p} is held by another process; not serving, \
                         because clients pointed at it would send their token there"
                    ));
                    // Keep refusing THIS port until it can be reclaimed,
                    // in memory and on disk both. Dropping the memo here
                    // would make the next enable, or the next launch, bind
                    // a different port and mint a live token while every
                    // installed client still points at the squatter.
                    st.last_port = Some(p);
                    revoke_credential(&dir);
                    return;
                }
                Err(BindFailure::Io(e)) => {
                    dlog(&format!("[mcp] bind failed: {e}"));
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
            // Minted fresh on EVERY bind, never adopted from the file.
            // Adopting looked like config stability, but it let a token
            // outlive the port that vouched for it: after a crash the
            // files persist while the port frees, so another local user
            // can bind it, collect the bearer from the next client that
            // connects, and still be holding a valid credential once we
            // relaunch. The port is only ours while we hold it, so the
            // token cannot be older than the binding.
            let token = cli_server::mint_token();
            if let Err(e) = cli_server::write_token_file(&dir.join(MCP_TOKEN_FILE), &token) {
                dlog(&format!("[mcp] token write failed: {e}; not serving"));
                return;
            }
            if let Err(e) = std::fs::write(dir.join(MCP_PORT_FILE), format!("{}\n", url_for(port))) {
                dlog(&format!("[mcp] port file write failed: {e}; not serving"));
                let _ = std::fs::remove_file(dir.join(MCP_TOKEN_FILE));
                return;
            }
            let shutdown = Arc::new(AtomicBool::new(false));
            let server = Arc::new(McpServer::new(
                token.clone(),
                Arc::new(cli_server::tauri_host(app, token)),
                Box::new(|| crate::load_settings_inner().mcp_enabled),
                shutdown.clone(),
            ));
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
            dlog(&format!("[mcp] listening on {}", url_for(port)));
            st.last_port = Some(port);
            st.handle = Some(McpHandle { port, shutdown, stopped: Some(done_rx) });
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
            let addr = std::net::SocketAddr::from(([127, 0, 0, 1], h.port));
            let _ = TcpStream::connect_timeout(&addr, SHUTDOWN_POKE_TIMEOUT);
            // The accept loop only has to observe the flag; if the poke
            // did not land, let it exit on its own rather than blocking
            // the UI thread on a join that may never return.
            st.stopped = h.stopped.take();
            // Disable is an explicit revocation: both files go, unlike
            // the harmless lingering cli-token. Re-enable mints fresh.
            if let Ok(dir) = crate::data_dir() {
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
            if let Ok(dir) = crate::data_dir() {
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
}

/// Settings-UI probe. Reads the live handle, so it reflects reality
/// (a failed bind reports url: null even with the setting on).
#[tauri::command]
pub(crate) fn mcp_status() -> McpStatus {
    let url = state().lock().unwrap().handle.as_ref().map(|h| url_for(h.port));
    let rendered = url.as_ref().and_then(|u| {
        let dir = crate::data_dir().ok()?;
        let helper = helper_command(&dir.join(MCP_TOKEN_FILE));
        Some((codex_block(u, &helper), claude_command(u, &helper)))
    });
    McpStatus {
        codex_config: rendered.as_ref().map(|(c, _)| c.clone()),
        claude_command: rendered.as_ref().map(|(_, c)| c.clone()),
        token_path: url
            .is_some()
            .then(|| crate::data_dir().ok().map(|d| d.join(MCP_TOKEN_FILE).to_string_lossy().into_owned()))
            .flatten(),
        url,
    }
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
/// keeps one source of truth and answers None the moment a disable
/// revokes it.
#[tauri::command]
pub(crate) fn mcp_token() -> Option<String> {
    token_from_file(&crate::data_dir().ok()?)
}

// ─────────────────────── one-click client setup ──────────────────────

/// The shell command both clients run to fetch the credential. Single
/// source, so the two configs cannot drift apart.
fn helper_command(token_path: &Path) -> String {
    // Single-quoted for the shell, with any embedded apostrophe closed,
    // escaped and reopened, so a path like /Users/O'Brien still parses.
    let quoted = format!("'{}'", token_path.to_string_lossy().replace('\'', "'\\''"));
    format!("printf '{{\"{MCP_TOKEN_HEADER}\":\"%s\"}}' \"$(cat {quoted})\"")
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
    let dir = crate::data_dir().map_err(|e| e.to_string())?;
    let url = state()
        .lock()
        .unwrap()
        .handle
        .as_ref()
        .map(|h| url_for(h.port))
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
            let out = std::process::Command::new("claude")
                .args(["mcp", "add-json", "termic", &json, "-s", "user"])
                .env("PATH", crate::shell_env::resolved_path())
                .output()
                .map_err(|e| format!("could not run claude: {e}"))?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            let mut msg = String::from("Added to Claude Code. Restart any running session to pick it up.");
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
        s.read_to_end(&mut buf).unwrap();
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
            matches!(bind_listener(Some(port)), Err(BindFailure::PortTaken(p)) if p == port),
            "a taken advertised port must be an error, never a quiet fallback"
        );
        // With nothing to reclaim, any free port is fine.
        assert!(bind_listener(None).is_ok());
        // And once it is free again, it is reclaimed.
        drop(held);
        assert!(bind_listener(Some(port)).is_ok());
    }

    #[test]
    fn refusing_a_hijacked_port_keeps_the_port_memo_and_drops_only_the_token() {
        // The refusal is only safe while we still remember WHICH port the
        // clients hold. Revoking the memo too would make the next bind pick
        // a fresh port and mint a live token, and every installed client
        // would then hand that token to whoever holds the old one: the
        // handoff this refusal exists to prevent, one restart later.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(MCP_TOKEN_FILE), "secret").unwrap();
        std::fs::write(dir.path().join(MCP_PORT_FILE), "http://127.0.0.1:65000/mcp\n").unwrap();

        revoke_credential(dir.path());

        assert!(!dir.path().join(MCP_TOKEN_FILE).exists(), "the credential must go");
        assert_eq!(
            port_from_file(dir.path()),
            Some(65000),
            "the port clients were told to use must survive, so the next bind keeps refusing it",
        );

        // Full revocation (disable, listener death) still takes both.
        revoke_advertisement(dir.path());
        assert_eq!(port_from_file(dir.path()), None);
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
        s.read_to_end(&mut buf).unwrap();
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
        const RECORDED: usize = 11300;
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
            task: Some("t".into()),
            project: None,
            kind: proto::TabKind::Shell,
            prompt: None,
            prompt_ref: None,
            wait,
            timeout_ms: ms,
            resume: None,
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
        let mut c = Command::Send { task: Some("t".into()), project: None, prompt: "p".into(), prompt_ref: None, resume: false, fresh: false, wait: true, timeout_ms: None, tab: None, cwd: None };
        clamp_wait(&mut c);
        assert!(matches!(c, Command::Send { timeout_ms: Some(MCP_WAIT_CAP_MS), .. }));
        let mut c = Command::Send { task: Some("t".into()), project: None, prompt: "p".into(), prompt_ref: None, resume: false, fresh: false, wait: false, timeout_ms: None, tab: None, cwd: None };
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
            crate::cli_server::TaskAgentState {
                state: "done".into(),
                tabs: 1,
                queued: 0,
                capable: true,
                tab_states: Vec::new(),
            },
        )]);
        spawn_with(host, Box::new(|| true))
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
                let found = if cli.starts_with("--") {
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
        for name in ["task_archive", "task_apply", "project_remove", "task_tab_close"] {
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
        let cmd = helper_command(Path::new("/Users/O'Brien/mcp-token"));
        // Closed, escaped, reopened: the shell must see one argument.
        assert!(cmd.contains(r"'/Users/O'\''Brien/mcp-token'"), "{cmd}");
        assert!(cmd.contains(MCP_TOKEN_HEADER));
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
