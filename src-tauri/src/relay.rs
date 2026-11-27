//! The relay client (docs/remote.md, Relay): how a phone reaches this
//! computer when no direct address works (another network, a carrier NAT).
//!
//! While sharing is on AND a paired phone holds a valid entitlement with
//! "relay" (`Node::relay_wanted`), one control socket stays open to
//! `wss://relay-eu-central.termic.dev/v1/host?addr=A`, where A is this
//! machine's random relay address (peers.json, never the instance id). For
//! each phone that dials A the relay sends `{"t":"incoming","conn":C}`;
//! this side opens `/v1/accept/C` and serves it exactly like a LAN
//! connection (`remote_server::serve_conn`): the sealed handshake runs end
//! to end, so the relay copies bytes it cannot read.
//!
//! Threads: one supervisor (connect, then backoff with jitter), one pinger
//! per control socket (every 25 s, under Cloudflare's 100 s idle limit; it
//! also notices the rule turning false, an entitlement expiring or the last
//! entitled phone unpaired), one per accepted connection. Every wait is a
//! blocking read, a channel or a condvar with a timeout (no sleep-polls).

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use rustls::pki_types::ServerName;
use rustls::ClientConnection;
use termic_remote::ws::{self, WsReader, WsWriter};

use crate::dlog;
use crate::peers::Node;

/// The relay a phone is told to dial (`ServerMsg::Relay`).
pub(crate) const SERVER: &str = "wss://relay-eu-central.termic.dev";
const HOST: &str = "relay-eu-central.termic.dev";
const PING: Duration = Duration::from_secs(25);
/// Silence on the control socket longer than this (no pong to three pings)
/// means it is dead: reconnect.
const CONTROL_IDLE: Duration = Duration::from_secs(80);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);

static RUNNING: AtomicBool = AtomicBool::new(false);
/// The open control socket's TCP, so turning the relay off cuts it at once.
static CONTROL: Mutex<Option<TcpStream>> = Mutex::new(None);
/// Wakes a supervisor waiting out its backoff.
static WAKE: (Mutex<()>, Condvar) = (Mutex::new(()), Condvar::new());

/// Re-apply the on/off rule: start the supervisor when the relay is wanted
/// and not running, cut the control socket when it is running and not
/// wanted. Called when sharing is switched and when a phone's
/// registration changes.
pub(crate) fn kick(node: &Arc<Node>) {
    if node.relay_wanted() {
        if RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            let node = node.clone();
            std::thread::spawn(move || supervise(node));
        }
    } else if let Some(t) = CONTROL.lock().unwrap().as_ref() {
        let _ = t.shutdown(std::net::Shutdown::Both);
    }
    WAKE.1.notify_all();
}

#[cfg(test)]
pub(crate) fn running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

fn supervise(node: Arc<Node>) {
    let mut backoff = BACKOFF_MIN;
    while node.relay_wanted() {
        let started = Instant::now();
        let r = tls_config().and_then(|cfg| control(&node, cfg));
        match r {
            Ok(()) => dlog("[relay] control socket closed"),
            Err(e) => dlog(&format!("[relay] control socket: {e}")),
        }
        if started.elapsed() > BACKOFF_MAX {
            backoff = BACKOFF_MIN;
        }
        if !node.relay_wanted() {
            break;
        }
        // Jitter (50-150%) so computers the relay dropped together do not
        // all come back in the same second.
        let j = crate::peer_crypto::random_bytes::<1>()[0] as u32;
        let wait = backoff.mul_f64(0.5 + j as f64 / 255.0);
        let g = WAKE.0.lock().unwrap();
        let _ = WAKE.1.wait_timeout(g, wait);
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
    RUNNING.store(false, Ordering::SeqCst);
    dlog("[relay] off");
    // The rule may have turned true again between the last check and now.
    if node.relay_wanted() {
        kick(&node);
    }
}

/// One control socket, until it ends or the relay is no longer wanted.
fn control(node: &Arc<Node>, cfg: Arc<rustls::ClientConfig>) -> io::Result<()> {
    let addr = node.relay_addr();
    let (mut r, w, tcp) = dial(cfg.clone(), HOST, 443, &format!("/v1/host?addr={addr}"))?;
    tcp.set_read_timeout(Some(CONTROL_IDLE))?;
    *CONTROL.lock().unwrap() = Some(tcp.try_clone()?);
    dlog("[relay] control socket open");
    let (stop, stopped) = mpsc::channel::<()>();
    let pinger = {
        let node = node.clone();
        std::thread::spawn(move || loop {
            if stopped.recv_timeout(PING) != Err(mpsc::RecvTimeoutError::Timeout) {
                return;
            }
            if !node.relay_wanted() {
                dlog("[relay] no paired phone has the relay now, closing");
                let _ = tcp.shutdown(std::net::Shutdown::Both);
                return;
            }
            if w.ping().is_err() {
                return;
            }
        })
    };
    let result = loop {
        match termic_remote::FrameRead::recv(&mut r) {
            Ok(Some(frame)) => {
                if let Some(conn) = incoming(&frame) {
                    let (node, cfg) = (node.clone(), cfg.clone());
                    std::thread::spawn(move || accept(node, cfg, &conn));
                }
            }
            Ok(None) => break Ok(()),
            Err(e) => break Err(e),
        }
    };
    drop(stop);
    let _ = pinger.join();
    *CONTROL.lock().unwrap() = None;
    result
}

/// The connection id in `{"t":"incoming","conn":C}`, if it is one and
/// safe to put in a path.
fn incoming(frame: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(frame).ok()?;
    if v.get("t")?.as_str()? != "incoming" {
        return None;
    }
    let c = v.get("conn")?.as_str()?;
    (!c.is_empty() && c.len() <= 128 && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')).then(|| c.to_string())
}

/// A phone dialled this computer through the relay: open its data socket
/// and serve it like any other connection.
fn accept(node: Arc<Node>, cfg: Arc<rustls::ClientConfig>, conn: &str) {
    match dial(cfg, HOST, 443, &format!("/v1/accept/{conn}")) {
        Ok((r, w, tcp)) => {
            let _ = tcp.set_read_timeout(Some(crate::remote_server::IDLE_TIMEOUT));
            crate::remote_server::serve_conn(Box::new(r), Box::new(w), tcp, node, None);
        }
        Err(e) => dlog(&format!("[relay] accept {conn}: {e}")),
    }
}

/// Verified TLS with the OS trust store (as the broker's upstream).
fn tls_config() -> io::Result<Arc<rustls::ClientConfig>> {
    static CFG: OnceLock<Result<Arc<rustls::ClientConfig>, String>> = OnceLock::new();
    CFG.get_or_init(|| {
        use rustls_platform_verifier::BuilderVerifierExt;
        let mut c = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
            .with_safe_default_protocol_versions()
            .and_then(|b| b.with_platform_verifier())
            .map_err(|e| e.to_string())?
            .with_no_client_auth();
        c.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Arc::new(c))
    })
    .clone()
    .map_err(io::Error::other)
}

type Reader = WsReader<TlsRead, TlsWrite>;
type Writer = WsWriter<TlsWrite>;

/// A WebSocket over TLS to `host:port` `path`: its two halves and the TCP
/// under them (shut it down to end the connection).
fn dial(cfg: Arc<rustls::ClientConfig>, host: &str, port: u16, path: &str) -> io::Result<(Reader, Writer, TcpStream)> {
    let tcp = crate::proxy::dial(host, port, CONNECT_TIMEOUT)?;
    let _ = tcp.set_nodelay(true);
    tcp.set_read_timeout(Some(CONNECT_TIMEOUT))?;
    tcp.set_write_timeout(Some(Duration::from_secs(30)))?;
    let (r, w) = websocket(cfg, tcp.try_clone()?, host, port, path)?;
    Ok((r, w, tcp))
}

/// The TLS and WebSocket handshakes over a connected TCP stream, then the
/// split into a reader and a writer that share the TLS session.
fn websocket(cfg: Arc<rustls::ClientConfig>, mut tcp: TcpStream, host: &str, port: u16, path: &str) -> io::Result<(Reader, Writer)> {
    let name = ServerName::try_from(host.to_string()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    let mut conn = ClientConnection::new(cfg, name).map_err(io::Error::other)?;
    let host_header = if port == 443 { host.to_string() } else { format!("{host}:{port}") };
    ws::client_handshake(&mut rustls::Stream::new(&mut conn, &mut tcp), &host_header, path)?;
    let conn = Arc::new(Mutex::new(conn));
    let w = TlsWrite { tcp: tcp.try_clone()?, conn: conn.clone() };
    let r = TlsRead { tcp, conn, pending: Vec::new() };
    Ok(ws::split(r, w, ws::End::Client))
}

/// The reading half of a TLS session shared with a writer. It blocks on
/// the raw TCP WITHOUT the session lock, and takes the lock only to feed
/// what arrived and take out plaintext, so a write never waits on a read.
pub(crate) struct TlsRead {
    tcp: TcpStream,
    conn: Arc<Mutex<ClientConnection>>,
    /// TLS bytes read but not yet fed to the session.
    pending: Vec<u8>,
}

pub(crate) struct TlsWrite {
    tcp: TcpStream,
    conn: Arc<Mutex<ClientConnection>>,
}

fn flush_tls(c: &mut ClientConnection, mut tcp: &TcpStream) -> io::Result<()> {
    while c.wants_write() {
        c.write_tls(&mut tcp)?;
    }
    Ok(())
}

impl Read for TlsRead {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        loop {
            {
                let mut c = self.conn.lock().unwrap_or_else(|e| e.into_inner());
                match c.reader().read(out) {
                    Ok(n) => return Ok(n),
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                    Err(e) => return Err(e),
                }
                if !self.pending.is_empty() {
                    let n = c.read_tls(&mut self.pending.as_slice())?;
                    self.pending.drain(..n);
                    c.process_new_packets().map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
                    flush_tls(&mut c, &self.tcp)?; // alerts, key updates
                    continue;
                }
            }
            let mut buf = [0u8; 16 * 1024];
            let n = (&self.tcp).read(&mut buf)?;
            if n == 0 {
                return Ok(0);
            }
            self.pending.extend_from_slice(&buf[..n]);
        }
    }
}

impl Write for TlsWrite {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        let mut c = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let n = c.writer().write(b)?;
        flush_tls(&mut c, &self.tcp)?;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        let mut c = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        c.writer().flush()?;
        flush_tls(&mut c, &self.tcp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use termic_remote::{FrameRead, FrameWrite};

    /// One stream as both halves, for a strictly request/response server.
    struct Shared<T>(Arc<Mutex<T>>);
    impl<T> Clone for Shared<T> {
        fn clone(&self) -> Self {
            Shared(self.0.clone())
        }
    }
    impl<T: Read> Read for Shared<T> {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            self.0.lock().unwrap().read(b)
        }
    }
    impl<T: Write> Write for Shared<T> {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().write(b)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.lock().unwrap().flush()
        }
    }

    /// A TLS WebSocket echo server for "localhost" with its own CA; returns
    /// its port, a client config trusting it, and the path it was asked for.
    fn echo_server() -> (u16, Arc<rustls::ClientConfig>, mpsc::Receiver<String>) {
        let provider = || Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap().self_signed(&key).unwrap();
        let server = Arc::new(
            rustls::ServerConfig::builder_with_provider(provider())
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(vec![cert.der().clone()], rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into()))
                .unwrap(),
        );
        let mut roots = rustls::RootCertStore::empty();
        roots.add(cert.der().clone()).unwrap();
        let client = Arc::new(
            rustls::ClientConfig::builder_with_provider(provider())
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let tls = Shared(Arc::new(Mutex::new(rustls::StreamOwned::new(rustls::ServerConnection::new(server).unwrap(), s))));
            let mut head = Vec::new();
            let mut b = [0u8; 1];
            let mut rd = tls.clone();
            while !head.ends_with(b"\r\n\r\n") {
                rd.read_exact(&mut b).unwrap();
                head.push(b[0]);
            }
            let text = String::from_utf8(head).unwrap();
            tx.send(text.split_whitespace().nth(1).unwrap().to_string()).unwrap();
            let key = text.lines().find_map(|l| l.strip_prefix("Sec-WebSocket-Key: ")).unwrap().to_string();
            ws::write_upgrade_response(&mut tls.clone(), &key).unwrap();
            let (mut r, mut w) = ws::split(tls.clone(), tls, ws::End::Server);
            while let Ok(Some(m)) = r.recv() {
                w.send(&m).unwrap();
            }
        });
        (port, client, rx)
    }

    #[test]
    fn the_tls_websocket_adapter_round_trips_frames() {
        let (port, cfg, path) = echo_server();
        let tcp = TcpStream::connect(("127.0.0.1", port)).unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let (mut r, mut w) = websocket(cfg, tcp, "localhost", port, "/v1/accept/abc").unwrap();
        assert_eq!(path.recv().unwrap(), "/v1/accept/abc");
        // Small, 16-bit and 64-bit lengths, and more than one TLS record.
        for size in [0usize, 5, 300, 70_000] {
            let msg: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            w.send(&msg).unwrap();
            assert_eq!(r.recv().unwrap().unwrap(), msg, "size {size}");
        }
        w.ping().unwrap();
        w.send(b"after ping").unwrap();
        assert_eq!(r.recv().unwrap().unwrap(), b"after ping");
        w.close(1000, "");
        assert_eq!(r.recv().unwrap(), None);
    }

    #[test]
    fn a_certificate_the_client_does_not_trust_is_refused() {
        let (port, _, _) = echo_server();
        let (_, other, _) = echo_server();
        let tcp = TcpStream::connect(("127.0.0.1", port)).unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        assert!(websocket(other, tcp, "localhost", port, "/x").is_err());
    }

    #[test]
    fn only_a_well_formed_incoming_names_a_connection() {
        assert_eq!(incoming(br#"{"t":"incoming","conn":"Ab-9_z"}"#).as_deref(), Some("Ab-9_z"));
        assert_eq!(incoming(br#"{"t":"pong"}"#), None);
        assert_eq!(incoming(br#"{"t":"incoming","conn":"../host?addr=x"}"#), None, "never a path");
        assert_eq!(incoming(br#"{"t":"incoming","conn":""}"#), None);
        assert_eq!(incoming(b"not json"), None);
    }
}
