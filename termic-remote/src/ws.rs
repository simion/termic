//! A minimal WebSocket (RFC 6455): what a phone's `new WebSocket()` speaks,
//! over a plain `std::net::TcpStream`.
//!
//! Hand-written rather than a crate because the subset needed is small and
//! fixed: binary messages, fragmentation, ping/pong, close, a size cap.
//! No extensions (no permessage-deflate: frames are sealed, so they do not
//! compress), no TLS (the seal is the security, see `seal`).
//!
//! The server side starts AFTER the HTTP upgrade request has been read by
//! the listener (it routes on the path); [`accept_value`] and
//! [`write_upgrade_response`] finish the handshake. The client side does
//! the whole handshake in [`client_handshake`].

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

use crate::{FrameRead, FrameWrite, MAX_FRAME};

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONT: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

/// `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`.
pub fn accept_value(key: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, format!("{}{GUID}", key.trim()).as_bytes());
    crate::b64(d.as_ref())
}

pub fn write_upgrade_response(stream: &mut impl Write, key: &str) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
        accept_value(key)
    );
    stream.write_all(head.as_bytes())?;
    stream.flush()
}

/// Upgrade a fresh TCP connection to a WebSocket as the client. Leaves the
/// stream positioned at the first frame.
pub fn client_handshake(stream: &mut TcpStream, host: &str, path: &str) -> io::Result<()> {
    let key = crate::b64(&crate::seal::random_bytes::<16>());
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    stream.write_all(req.as_bytes())?;
    stream.flush()?;
    // Read the response head byte by byte so nothing after it is consumed
    // into a buffer this function would then drop.
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 16 * 1024 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "oversized handshake response"));
        }
        if stream.read(&mut byte)? == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed during the handshake"));
        }
        head.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&head);
    let mut lines = BufReader::new(text.as_bytes()).lines();
    let status = lines.next().and_then(|l| l.ok()).unwrap_or_default();
    let code: u16 = status.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    if code != 101 {
        return Err(io::Error::new(io::ErrorKind::ConnectionRefused, format!("refused ({code})")));
    }
    let want = accept_value(&key);
    let ok = lines.map_while(Result::ok).any(|l| {
        l.split_once(':').is_some_and(|(k, v)| k.trim().eq_ignore_ascii_case("sec-websocket-accept") && v.trim() == want)
    });
    if !ok {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "bad handshake accept value"));
    }
    Ok(())
}

/// Which end: the client masks what it sends, the server must not, and
/// each refuses the other's convention (RFC 6455 section 5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    Server,
    Client,
}

struct WriterInner<W: Write> {
    w: W,
    end: End,
    closed: bool,
}

/// The sending half. Cloneable: the reading half keeps a clone to answer
/// pings and echo a close.
pub struct WsWriter<W: Write + Send> {
    inner: Arc<Mutex<WriterInner<W>>>,
}

impl<W: Write + Send> Clone for WsWriter<W> {
    fn clone(&self) -> Self {
        WsWriter { inner: self.inner.clone() }
    }
}

impl<W: Write + Send> WsWriter<W> {
    fn frame(&self, op: u8, payload: &[u8]) -> io::Result<()> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.closed && op != OP_CLOSE {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "websocket closed"));
        }
        let mask = g.end == End::Client;
        let mut head = Vec::with_capacity(14);
        head.push(0x80 | op);
        let mbit = if mask { 0x80 } else { 0 };
        let n = payload.len();
        if n < 126 {
            head.push(mbit | n as u8);
        } else if n <= u16::MAX as usize {
            head.push(mbit | 126);
            head.extend_from_slice(&(n as u16).to_be_bytes());
        } else {
            head.push(mbit | 127);
            head.extend_from_slice(&(n as u64).to_be_bytes());
        }
        if mask {
            let key = crate::seal::random_bytes::<4>();
            head.extend_from_slice(&key);
            let masked: Vec<u8> = payload.iter().enumerate().map(|(i, b)| b ^ key[i % 4]).collect();
            g.w.write_all(&head)?;
            g.w.write_all(&masked)?;
        } else {
            g.w.write_all(&head)?;
            g.w.write_all(payload)?;
        }
        g.w.flush()
    }
}

impl<W: Write + Send> FrameWrite for WsWriter<W> {
    fn send(&mut self, frame: &[u8]) -> io::Result<()> {
        self.frame(OP_BINARY, frame)
    }
    fn close(&mut self, code: u16, reason: &str) {
        let mut p = code.to_be_bytes().to_vec();
        p.extend_from_slice(&reason.as_bytes()[..reason.len().min(120)]);
        let _ = self.frame(OP_CLOSE, &p);
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
    }
}

pub struct WsReader<R: Read + Send, W: Write + Send> {
    r: R,
    end: End,
    writer: WsWriter<W>,
    /// The close code the other side sent, if it closed.
    pub close_code: Option<u16>,
}

/// Split a connection into its two halves.
pub fn split<R: Read + Send, W: Write + Send>(r: R, w: W, end: End) -> (WsReader<R, W>, WsWriter<W>) {
    let writer = WsWriter { inner: Arc::new(Mutex::new(WriterInner { w, end, closed: false })) };
    (WsReader { r, end, writer: writer.clone(), close_code: None }, writer)
}

/// Both halves of a TCP stream.
pub fn split_tcp(stream: TcpStream, end: End) -> io::Result<(WsReader<TcpStream, TcpStream>, WsWriter<TcpStream>)> {
    let w = stream.try_clone()?;
    Ok(split(stream, w, end))
}

impl<R: Read + Send, W: Write + Send> WsReader<R, W> {
    fn read_frame(&mut self) -> io::Result<(bool, u8, Vec<u8>)> {
        let mut h = [0u8; 2];
        self.r.read_exact(&mut h)?;
        let fin = h[0] & 0x80 != 0;
        if h[0] & 0x70 != 0 {
            return Err(bad("reserved bits set (no extensions were negotiated)"));
        }
        let op = h[0] & 0x0F;
        let masked = h[1] & 0x80 != 0;
        match self.end {
            End::Server if !masked => return Err(bad("unmasked frame from a client")),
            End::Client if masked => return Err(bad("masked frame from a server")),
            _ => {}
        }
        let len = match h[1] & 0x7F {
            126 => {
                let mut b = [0u8; 2];
                self.r.read_exact(&mut b)?;
                u16::from_be_bytes(b) as u64
            }
            127 => {
                let mut b = [0u8; 8];
                self.r.read_exact(&mut b)?;
                u64::from_be_bytes(b)
            }
            n => n as u64,
        };
        if len > MAX_FRAME as u64 {
            return Err(bad("frame too large"));
        }
        if op >= 0x8 && (len > 125 || !fin) {
            return Err(bad("malformed control frame"));
        }
        let key = if masked {
            let mut k = [0u8; 4];
            self.r.read_exact(&mut k)?;
            Some(k)
        } else {
            None
        };
        let mut payload = vec![0u8; len as usize];
        self.r.read_exact(&mut payload)?;
        if let Some(k) = key {
            for (i, b) in payload.iter_mut().enumerate() {
                *b ^= k[i % 4];
            }
        }
        Ok((fin, op, payload))
    }
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

impl<R: Read + Send, W: Write + Send> FrameRead for WsReader<R, W> {
    /// The next whole data message (binary, or text as its bytes). Pings
    /// are answered and closes echoed here; `Ok(None)` after a close.
    fn recv(&mut self) -> io::Result<Option<Vec<u8>>> {
        let mut message: Option<Vec<u8>> = None;
        loop {
            let (fin, op, payload) = match self.read_frame() {
                Ok(f) => f,
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof && message.is_none() => return Ok(None),
                Err(e) => return Err(e),
            };
            match op {
                OP_PING => {
                    let _ = self.writer.frame(OP_PONG, &payload);
                }
                OP_PONG => {}
                OP_CLOSE => {
                    self.close_code = (payload.len() >= 2).then(|| u16::from_be_bytes([payload[0], payload[1]]));
                    let code = self.close_code.unwrap_or(1000);
                    let mut w = self.writer.clone();
                    w.close(code, "");
                    return Ok(None);
                }
                OP_TEXT | OP_BINARY => {
                    if message.is_some() {
                        return Err(bad("new message inside a fragmented one"));
                    }
                    if fin {
                        return Ok(Some(payload));
                    }
                    message = Some(payload);
                }
                OP_CONT => {
                    let Some(m) = message.as_mut() else { return Err(bad("continuation without a message")) };
                    if m.len() + payload.len() > MAX_FRAME {
                        return Err(bad("message too large"));
                    }
                    m.extend_from_slice(&payload);
                    if fin {
                        return Ok(message);
                    }
                }
                _ => return Err(bad("unknown opcode")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn accept_value_matches_the_rfc_example() {
        // RFC 6455 section 1.3.
        assert_eq!(accept_value("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    /// A real client and server over loopback: handshake, messages both
    /// ways (small, 16-bit and 64-bit lengths), ping, close.
    #[test]
    fn client_and_server_talk_over_tcp() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            // Read the upgrade head ourselves, as the peer listener does.
            let mut head = Vec::new();
            let mut b = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                s.read_exact(&mut b).unwrap();
                head.push(b[0]);
            }
            let text = String::from_utf8(head).unwrap();
            let key = text.lines().find_map(|l| l.strip_prefix("Sec-WebSocket-Key: ")).unwrap().to_string();
            write_upgrade_response(&mut s, &key).unwrap();
            let (mut r, mut w) = split_tcp(s, End::Server).unwrap();
            while let Some(m) = r.recv().unwrap() {
                w.send(&m).unwrap(); // echo
            }
            r.close_code
        });
        let mut c = TcpStream::connect(addr).unwrap();
        client_handshake(&mut c, &addr.to_string(), "/x").unwrap();
        let (mut r, mut w) = split_tcp(c, End::Client).unwrap();
        for size in [0usize, 5, 125, 126, 300, 70_000] {
            let msg: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            w.send(&msg).unwrap();
            assert_eq!(r.recv().unwrap().unwrap(), msg, "size {size}");
        }
        w.frame(OP_PING, b"hi").unwrap();
        w.send(b"after ping").unwrap();
        assert_eq!(r.recv().unwrap().unwrap(), b"after ping");
        w.close(4001, "bye");
        assert_eq!(r.recv().unwrap(), None);
        assert_eq!(server.join().unwrap(), Some(4001));
    }

    #[test]
    fn fragmented_messages_are_reassembled() {
        // Client-side frames (masked) fed to a server reader from memory.
        let mut wire = Vec::new();
        for (fin, op, part) in [(false, OP_BINARY, b"hel".as_slice()), (true, OP_CONT, b"lo".as_slice())] {
            let key = [1u8, 2, 3, 4];
            wire.push(if fin { 0x80 } else { 0 } | op);
            wire.push(0x80 | part.len() as u8);
            wire.extend_from_slice(&key);
            wire.extend(part.iter().enumerate().map(|(i, b)| b ^ key[i % 4]));
        }
        let (mut r, _) = split(std::io::Cursor::new(wire), Vec::new(), End::Server);
        assert_eq!(r.recv().unwrap().unwrap(), b"hello");
    }

    #[test]
    fn a_server_refuses_unmasked_and_oversized_frames() {
        let (mut r, _) = split(std::io::Cursor::new(vec![0x82, 0x01, b'x']), Vec::new(), End::Server);
        assert!(r.recv().is_err());
        let mut big = vec![0x82, 0x80 | 127];
        big.extend_from_slice(&(MAX_FRAME as u64 + 1).to_be_bytes());
        big.extend_from_slice(&[0; 4]);
        let (mut r, _) = split(std::io::Cursor::new(big), Vec::new(), End::Server);
        assert!(r.recv().is_err());
    }

    #[test]
    fn a_handshake_to_something_else_fails() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 512];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        });
        let mut c = TcpStream::connect(addr).unwrap();
        let e = client_handshake(&mut c, &addr.to_string(), "/x").unwrap_err();
        assert!(e.to_string().contains("403"), "{e}");
    }
}
