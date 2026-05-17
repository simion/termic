// In-process HTTP CONNECT proxy with a regex hostname allowlist.
// Replaces the tinyproxy child process we previously spawned per
// sandboxed workspace - eliminates the external dependency, removes
// the bundling problem (Mach-O / Elf arch issues, dylib transitive
// deps, brew assumptions), and makes the Linux port trivial because
// the proxy code is platform-neutral Rust.
//
// Design constraints:
//   - One proxy instance per sandboxed PTY. Lives in the SandboxBundle;
//     Drop signals shutdown and joins the accept thread.
//   - Bind to 127.0.0.1:0 (kernel-assigned port) so multiple workspaces
//     don't collide. Port returned to the caller for env injection.
//   - Allowlist is a precompiled Vec<Regex> over the request hostname.
//     Anything not matching gets HTTP 403 (matches tinyproxy's
//     FilterDefaultDeny=Yes behavior so the rest of the system can
//     pretend nothing changed).
//   - Two methods supported:
//       CONNECT host:port HTTP/1.1   - for HTTPS tunneling (99% of
//                                       what agent CLIs do).
//       Plain HTTP requests          - GET/POST/etc with absolute-form
//                                       URL `http://host/path`. Less
//                                       common but kept for parity with
//                                       tinyproxy.
//   - Thread-per-connection. PTY-bound proxies see a handful of
//     concurrent connections; the cost of a pthread vs. an async
//     reactor doesn't matter and std-only keeps the dep tree clean.
//
// Shutdown:
//   - SandboxBundle::Drop sends a () through a oneshot channel and
//     joins the listener thread. Accept loop uses set_nonblocking +
//     a short sleep so it polls the shutdown flag between accepts;
//     ~50ms shutdown latency, fine for a process-teardown path.

use anyhow::{anyhow, Result};
use regex::Regex;
use std::io::{Read, Write, ErrorKind};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const ACCEPT_POLL_MS: u64 = 50;
const READ_HEADER_TIMEOUT_MS: u64 = 5_000;
const CONNECT_UPSTREAM_TIMEOUT_MS: u64 = 8_000;
// Max bytes we'll buffer for the request line + headers before bailing.
// Real proxy requests are well under 8KB; anything larger is a buggy
// or malicious client.
const MAX_HEADER_BYTES: usize = 16 * 1024;

pub struct ProxyHandle {
    pub port: u16,
    shutdown: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Drop for ProxyHandle {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            // Join is best-effort; the accept loop checks the flag at
            // most every ACCEPT_POLL_MS so worst case we wait that long.
            let _ = t.join();
        }
    }
}

/// Spin up the proxy. Returns immediately once the listener is bound;
/// the accept loop runs in a background thread. `allowed_patterns` is
/// the host-allowlist regex set (one entry per line of the workspace's
/// allowed_hosts config); patterns are tried in order, first match wins.
pub fn start(allowed_patterns: Vec<String>) -> Result<ProxyHandle> {
    // Compile up front so a bad regex fails the workspace spawn cleanly
    // rather than silently 403-ing every request.
    let regexes: Vec<Regex> = allowed_patterns
        .iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| Regex::new(p).map_err(|e| anyhow!("bad allowed_hosts regex {:?}: {}", p, e)))
        .collect::<Result<_>>()?;

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    listener.set_nonblocking(true)?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_clone = Arc::clone(&shutdown);
    let regexes = Arc::new(regexes);

    let thread = thread::spawn(move || {
        loop {
            if shutdown_clone.load(Ordering::Relaxed) { break; }
            match listener.accept() {
                Ok((stream, _addr)) => {
                    let regexes = Arc::clone(&regexes);
                    // Each connection on its own thread. Slightly
                    // wasteful but keeps the code obvious and the
                    // per-PTY connection count low.
                    thread::spawn(move || {
                        if let Err(e) = handle_connection(stream, &regexes) {
                            // Log only - we never want a malformed
                            // request to take down the proxy.
                            eprintln!("[proxy] connection error: {e}");
                        }
                    });
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(ACCEPT_POLL_MS));
                }
                Err(e) => {
                    eprintln!("[proxy] accept failed: {e}");
                    // Don't break - transient errors (EMFILE etc.)
                    // shouldn't kill the proxy. Sleep before retry.
                    thread::sleep(Duration::from_millis(ACCEPT_POLL_MS * 4));
                }
            }
        }
    });

    Ok(ProxyHandle { port, shutdown, thread: Some(thread) })
}

// ─── connection handler ──────────────────────────────────────────────

fn handle_connection(mut stream: TcpStream, regexes: &[Regex]) -> Result<()> {
    // Bound how long we wait for the client's request headers so a
    // half-open connection can't pin a thread forever.
    stream.set_read_timeout(Some(Duration::from_millis(READ_HEADER_TIMEOUT_MS)))?;

    let (request_line, headers, leftover) = read_http_headers(&mut stream)?;
    // request line: "METHOD TARGET HTTP/X.Y"
    let mut parts = request_line.splitn(3, ' ');
    let method = parts.next().unwrap_or("").to_ascii_uppercase();
    let target = parts.next().unwrap_or("");
    let _version = parts.next().unwrap_or("");

    if method == "CONNECT" {
        handle_connect(stream, target, regexes)
    } else {
        handle_plain_http(stream, &method, target, &headers, &leftover, regexes)
    }
}

/// Read HTTP request line + headers until CRLFCRLF. Returns the first
/// line, the header block as a single string, and any leftover bytes
/// that arrived in the same read (for plain-HTTP forwarding — the
/// request body, if any, starts after the header terminator).
fn read_http_headers(stream: &mut TcpStream) -> Result<(String, String, Vec<u8>)> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        if buf.len() > MAX_HEADER_BYTES {
            return Err(anyhow!("request headers exceeded {} bytes", MAX_HEADER_BYTES));
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(anyhow!("client closed before sending complete headers"));
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(idx) = find_double_crlf(&buf) {
            let headers_end = idx + 4;
            let header_block = String::from_utf8_lossy(&buf[..idx + 2]).into_owned();
            let mut lines = header_block.split("\r\n");
            let request_line = lines.next().unwrap_or("").to_string();
            let header_lines = lines.collect::<Vec<_>>().join("\r\n");
            let leftover = buf[headers_end..].to_vec();
            return Ok((request_line, header_lines, leftover));
        }
    }
}

fn find_double_crlf(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

// ─── CONNECT (HTTPS tunneling) ───────────────────────────────────────

fn handle_connect(mut client: TcpStream, target: &str, regexes: &[Regex]) -> Result<()> {
    // CONNECT target is "host:port".
    let (host, port_str) = match target.rsplit_once(':') {
        Some(t) => t,
        None => {
            write_status(&mut client, 400, "Bad Request")?;
            return Err(anyhow!("malformed CONNECT target: {target}"));
        }
    };
    let port: u16 = match port_str.parse() {
        Ok(p) => p,
        Err(_) => {
            write_status(&mut client, 400, "Bad Request")?;
            return Err(anyhow!("non-numeric port in CONNECT: {port_str}"));
        }
    };

    if !host_allowed(host, regexes) {
        // 403 matches tinyproxy's FilterDefaultDeny behavior so the
        // rest of the sandbox UI (recent-denies panel, frontend
        // observation) sees the same status code we used to emit.
        write_status(&mut client, 403, "Forbidden")?;
        return Ok(());
    }

    // Connect to the actual upstream. ToSocketAddrs handles DNS in
    // one call; we don't constrain IPv6 vs IPv4 - whichever resolves.
    let upstream = match (host, port).to_socket_addrs()
        .map_err(|e| anyhow!("resolve {host}: {e}"))?
        .next()
    {
        Some(addr) => addr,
        None => {
            write_status(&mut client, 502, "Bad Gateway")?;
            return Err(anyhow!("no addresses for {host}"));
        }
    };
    let upstream = match TcpStream::connect_timeout(&upstream, Duration::from_millis(CONNECT_UPSTREAM_TIMEOUT_MS)) {
        Ok(s) => s,
        Err(e) => {
            write_status(&mut client, 502, "Bad Gateway")?;
            return Err(anyhow!("connect upstream {host}:{port}: {e}"));
        }
    };

    write_status(&mut client, 200, "Connection Established")?;

    // From here on it's a dumb byte pipe - the TLS handshake happens
    // end-to-end between the agent and the upstream; we never see the
    // plaintext. Clear the read timeout so long-lived connections
    // (claude streaming responses for minutes) don't get killed.
    client.set_read_timeout(None).ok();
    upstream.set_read_timeout(None).ok();
    pipe_bidirectional(client, upstream)
}

// ─── Plain HTTP forwarding ───────────────────────────────────────────

fn handle_plain_http(
    mut client: TcpStream,
    method: &str,
    target: &str,
    headers: &str,
    leftover: &[u8],
    regexes: &[Regex],
) -> Result<()> {
    // Plain HTTP target is "http://host[:port]/path?query".
    if !target.to_ascii_lowercase().starts_with("http://") {
        write_status(&mut client, 400, "Bad Request")?;
        return Err(anyhow!("non-absolute target on plain method: {target}"));
    }
    let after_scheme = &target[7..];                  // strip "http://"
    let (host_port, path) = match after_scheme.find('/') {
        Some(i) => (&after_scheme[..i], &after_scheme[i..]),
        None => (after_scheme, "/"),
    };
    let (host, port): (&str, u16) = match host_port.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().unwrap_or(80)),
        None => (host_port, 80),
    };

    if !host_allowed(host, regexes) {
        write_status(&mut client, 403, "Forbidden")?;
        return Ok(());
    }

    let upstream_addr = match (host, port).to_socket_addrs()?.next() {
        Some(a) => a,
        None => {
            write_status(&mut client, 502, "Bad Gateway")?;
            return Err(anyhow!("no addresses for {host}"));
        }
    };
    let mut upstream = TcpStream::connect_timeout(&upstream_addr, Duration::from_millis(CONNECT_UPSTREAM_TIMEOUT_MS))?;

    // Rewrite the request line into origin form (path-only) per
    // RFC 7230 §5.3.1; most upstreams require it. Strip any
    // Proxy-Connection header on the way through.
    let mut req = format!("{method} {path} HTTP/1.1\r\n");
    for line in headers.split("\r\n") {
        if line.trim().is_empty() { continue; }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("proxy-connection:") { continue; }
        req.push_str(line);
        req.push_str("\r\n");
    }
    req.push_str("\r\n");

    upstream.write_all(req.as_bytes())?;
    if !leftover.is_empty() {
        upstream.write_all(leftover)?;
    }

    client.set_read_timeout(None).ok();
    upstream.set_read_timeout(None).ok();
    pipe_bidirectional(client, upstream)
}

// ─── helpers ─────────────────────────────────────────────────────────

fn host_allowed(host: &str, regexes: &[Regex]) -> bool {
    // Strip IPv6 brackets if present so the regex authors don't have
    // to think about them: `[::1]` → `::1`.
    let h = host.strip_prefix('[').and_then(|s| s.strip_suffix(']')).unwrap_or(host);
    regexes.iter().any(|r| r.is_match(h))
}

fn write_status(stream: &mut TcpStream, code: u16, reason: &str) -> std::io::Result<()> {
    let body = format!(
        "HTTP/1.1 {code} {reason}\r\n\
         Content-Length: 0\r\n\
         Connection: close\r\n\
         \r\n"
    );
    stream.write_all(body.as_bytes())
}

/// Pipe bytes both directions until either side EOFs or errors.
/// Spawns one thread for the client→upstream direction; the calling
/// thread handles upstream→client. Both shut down their write half on
/// EOF so the other direction's reader sees the close.
fn pipe_bidirectional(client: TcpStream, upstream: TcpStream) -> Result<()> {
    let client_w = client.try_clone()?;
    let upstream_w = upstream.try_clone()?;
    let t = thread::spawn(move || {
        let mut c = client;
        let mut u = upstream_w;
        let _ = std::io::copy(&mut c, &mut u);
        let _ = u.shutdown(Shutdown::Write);
    });
    let mut u = upstream;
    let mut c = client_w;
    let _ = std::io::copy(&mut u, &mut c);
    let _ = c.shutdown(Shutdown::Write);
    let _ = t.join();
    Ok(())
}
