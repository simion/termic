//! A connection carrying messages: the framing below, the seal (or none,
//! over SSH stdio) in the middle, JSON on top. Plus the two handshakes.
//!
//! ```text
//! host   -> client  host_salt (16 B, clear)
//! client -> host    client_salt (16 B) || client_id (16 B raw), clear
//! client -> host    sealed hello
//! host   -> client  sealed welcome
//! ...               sealed messages both ways
//! ```
//!
//! The host looks the client's id up to find the pair key (or, for a phone
//! scanning a pairing code, tries the pending key). The hello opening under
//! that key IS the client's proof; the welcome opening on the client is the
//! host's. Nothing before the hello is trusted, and a failure closes the
//! connection with 4001 and no detail.

use std::io;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::seal::{self, Opener, Role, Sealer, KEY_LEN, SALT_LEN};
use crate::wire::{ClientMsg, ServerMsg};
use crate::{FrameRead, FrameWrite};

/// WebSocket close code for "not paired, or the seal failed".
pub const CLOSE_UNAUTHENTICATED: u16 = 4001;
/// WebSocket close code for "the host stopped (sharing off, unpaired)".
pub const CLOSE_REVOKED: u16 = 4003;

pub struct MsgReader {
    inner: Box<dyn FrameRead>,
    opener: Option<Opener>,
}

pub struct MsgWriter {
    inner: Box<dyn FrameWrite>,
    sealer: Option<Sealer>,
}

impl MsgReader {
    /// Unsealed (SSH stdio).
    pub fn plain(inner: Box<dyn FrameRead>) -> MsgReader {
        MsgReader { inner, opener: None }
    }
    /// The next message's bytes. A frame that fails to open is an error:
    /// the connection is no longer trustworthy and must end.
    pub fn recv_bytes(&mut self) -> io::Result<Option<Vec<u8>>> {
        let Some(frame) = self.inner.recv()? else { return Ok(None) };
        match self.opener.as_mut() {
            None => Ok(Some(frame)),
            Some(o) => o
                .open(&frame)
                .map(Some)
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "a frame failed to open")),
        }
    }
    /// The next message, skipping any that are not JSON this side can read
    /// (unknown types still parse, as `Unknown`).
    pub fn recv<T: DeserializeOwned>(&mut self) -> io::Result<Option<T>> {
        loop {
            let Some(b) = self.recv_bytes()? else { return Ok(None) };
            if let Ok(m) = serde_json::from_slice(&b) {
                return Ok(Some(m));
            }
        }
    }
}

impl MsgWriter {
    pub fn plain(inner: Box<dyn FrameWrite>) -> MsgWriter {
        MsgWriter { inner, sealer: None }
    }
    pub fn send_bytes(&mut self, plain: &[u8]) -> io::Result<()> {
        match self.sealer.as_mut() {
            None => self.inner.send(plain),
            Some(s) => {
                let f = s.seal(plain);
                self.inner.send(&f)
            }
        }
    }
    pub fn send<T: Serialize>(&mut self, msg: &T) -> io::Result<()> {
        let b = serde_json::to_vec(msg).map_err(io::Error::other)?;
        self.send_bytes(&b)
    }
    pub fn close(&mut self, code: u16, reason: &str) {
        self.inner.close(code, reason);
    }
}

/// What the host learned from a client's handshake.
pub struct Accepted {
    pub client_id: String,
    /// Which of the candidate keys opened the hello (0 for a known pair;
    /// a pending phone pairing's key otherwise).
    pub key_index: usize,
    pub hello: ClientMsg,
    pub reader: MsgReader,
    pub writer: MsgWriter,
}

/// The host's half of the handshake. `keys_for(client_id)` returns the keys
/// that client may be using: its pair key, or the pending pairing keys for
/// an id this host does not know yet. On any failure the connection is
/// closed with `CLOSE_UNAUTHENTICATED` and Err is returned.
pub fn host_handshake(
    mut reader: Box<dyn FrameRead>,
    mut writer: Box<dyn FrameWrite>,
    host_id: &str,
    keys_for: impl Fn(&str) -> Vec<[u8; KEY_LEN]>,
) -> io::Result<Accepted> {
    let deny = |w: &mut Box<dyn FrameWrite>, why: &str| -> io::Error {
        w.close(CLOSE_UNAUTHENTICATED, "unauthenticated");
        io::Error::new(io::ErrorKind::PermissionDenied, why.to_string())
    };
    let host_salt = seal::random_bytes::<SALT_LEN>();
    writer.send(&host_salt)?;
    let first = reader.recv()?.ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "closed before the handshake"))?;
    if first.len() != SALT_LEN + 16 {
        return Err(deny(&mut writer, "malformed client hello"));
    }
    let mut client_salt = [0u8; SALT_LEN];
    client_salt.copy_from_slice(&first[..SALT_LEN]);
    let client_id = crate::id_from_bytes(&first[SALT_LEN..]).expect("16 bytes");
    let hello_frame = reader.recv()?.ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "closed before the hello"))?;
    for (i, key) in keys_for(&client_id).iter().enumerate() {
        let (sealer, mut opener) = seal::session(key, &host_salt, &client_salt, host_id, &client_id, Role::Host);
        let Some(plain) = opener.open(&hello_frame) else { continue };
        let Some(hello @ ClientMsg::Hello { .. }) = ClientMsg::parse(&plain) else {
            return Err(deny(&mut writer, "first message was not a hello"));
        };
        return Ok(Accepted {
            client_id,
            key_index: i,
            hello,
            reader: MsgReader { inner: reader, opener: Some(opener) },
            writer: MsgWriter { inner: writer, sealer: Some(sealer) },
        });
    }
    Err(deny(&mut writer, "unknown client or wrong key"))
}

/// What the client learned from the host's handshake.
pub struct Connected {
    pub welcome: ServerMsg,
    pub reader: MsgReader,
    pub writer: MsgWriter,
}

/// The client's half: send the hello sealed with `key`, and require a
/// welcome sealed by the host holding the same key.
pub fn client_handshake(
    mut reader: Box<dyn FrameRead>,
    mut writer: Box<dyn FrameWrite>,
    host_id: &str,
    client_id: &str,
    key: &[u8; KEY_LEN],
    hello: &ClientMsg,
) -> io::Result<Connected> {
    let refused = || io::Error::new(io::ErrorKind::PermissionDenied, "the host refused this pairing");
    let host_salt: [u8; SALT_LEN] = reader
        .recv()?
        .ok_or_else(refused)?
        .try_into()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "malformed host salt"))?;
    let client_salt = seal::random_bytes::<SALT_LEN>();
    let id = crate::id_to_bytes(client_id).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "client id is not 32 hex"))?;
    let mut first = client_salt.to_vec();
    first.extend_from_slice(&id);
    writer.send(&first)?;
    let (mut sealer, mut opener) = seal::session(key, &host_salt, &client_salt, host_id, client_id, Role::Client);
    writer.send(&sealer.seal(&hello.to_bytes()))?;
    let frame = reader.recv()?.ok_or_else(refused)?;
    let welcome = opener
        .open(&frame)
        .and_then(|p| ServerMsg::parse(&p))
        .filter(|m| matches!(m, ServerMsg::Welcome { .. }))
        .ok_or_else(|| io::Error::new(io::ErrorKind::PermissionDenied, "the host's answer did not check out"))?;
    Ok(Connected {
        welcome,
        reader: MsgReader { inner: reader, opener: Some(opener) },
        writer: MsgWriter { inner: writer, sealer: Some(sealer) },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{ClientKind, HostKind};
    use crate::ws::{self, End};
    use std::net::{TcpListener, TcpStream};

    const HOST: &str = "11111111111111111111111111111111";
    const PHONE: &str = "22222222222222222222222222222222";

    fn hello() -> ClientMsg {
        ClientMsg::Hello { v: 1, name: "Phone".into(), kind: ClientKind::Phone, caps: vec![], app_version: None, grant: None, port: None }
    }

    fn welcome() -> ServerMsg {
        ServerMsg::Welcome { v: 1, id: HOST.into(), name: "Mac".into(), version: "t".into(), kind: HostKind::Desktop, caps: vec![], grant: None, needs: None }
    }

    /// Run a host on loopback that accepts with `keys`, sends a welcome and
    /// echoes pings as pongs; returns its address and what it accepted.
    fn host(keys: Vec<[u8; 32]>) -> (std::net::SocketAddr, std::thread::JoinHandle<Result<(String, usize), String>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut head = Vec::new();
            let mut b = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                std::io::Read::read_exact(&mut s, &mut b).unwrap();
                head.push(b[0]);
            }
            let text = String::from_utf8(head).unwrap();
            let key = text.lines().find_map(|l| l.strip_prefix("Sec-WebSocket-Key: ")).unwrap().to_string();
            ws::write_upgrade_response(&mut s, &key).unwrap();
            let (r, w) = ws::split_tcp(s, End::Server).unwrap();
            let mut acc = host_handshake(Box::new(r), Box::new(w), HOST, |_| keys.clone()).map_err(|e| e.to_string())?;
            acc.writer.send(&welcome()).unwrap();
            while let Some(m) = acc.reader.recv::<ClientMsg>().map_err(|e| e.to_string())? {
                if m == (ClientMsg::Ping {}) {
                    acc.writer.send(&ServerMsg::Pong {}).unwrap();
                }
            }
            Ok((acc.client_id, acc.key_index))
        });
        (addr, h)
    }

    fn connect(addr: std::net::SocketAddr, key: &[u8; 32]) -> io::Result<Connected> {
        let mut s = TcpStream::connect(addr)?;
        ws::client_handshake(&mut s, &addr.to_string(), "/s")?;
        let (r, w) = ws::split_tcp(s, End::Client)?;
        client_handshake(Box::new(r), Box::new(w), HOST, PHONE, key, &hello())
    }

    #[test]
    fn a_paired_client_connects_and_talks() {
        let (addr, h) = host(vec![[5; 32]]);
        let mut c = connect(addr, &[5; 32]).unwrap();
        assert!(matches!(c.welcome, ServerMsg::Welcome { .. }));
        c.writer.send(&ClientMsg::Ping {}).unwrap();
        assert_eq!(c.reader.recv::<ServerMsg>().unwrap().unwrap(), ServerMsg::Pong {});
        c.writer.close(1000, "");
        assert_eq!(h.join().unwrap().unwrap(), (PHONE.to_string(), 0));
    }

    #[test]
    fn the_matching_candidate_key_is_reported() {
        let (addr, h) = host(vec![[1; 32], [2; 32], [3; 32]]);
        let mut c = connect(addr, &[3; 32]).unwrap();
        c.writer.close(1000, "");
        assert_eq!(h.join().unwrap().unwrap().1, 2);
    }

    #[test]
    fn a_wrong_key_is_refused_on_both_sides() {
        let (addr, h) = host(vec![[5; 32]]);
        let err = connect(addr, &[6; 32]).err().expect("connected with a wrong key");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(h.join().unwrap().is_err());
    }

    #[test]
    fn an_unknown_client_with_no_pending_pairing_is_refused() {
        let (addr, h) = host(vec![]);
        assert!(connect(addr, &[5; 32]).is_err());
        assert!(h.join().unwrap().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn plain_framed_connections_carry_messages() {
        use crate::framed::{FramedReader, FramedWriter};
        let (a, b) = std::os::unix::net::UnixStream::pair().unwrap();
        let mut w = MsgWriter::plain(Box::new(FramedWriter(a)));
        let mut r = MsgReader::plain(Box::new(FramedReader(b)));
        w.send(&ClientMsg::Ping {}).unwrap();
        assert_eq!(r.recv::<ClientMsg>().unwrap().unwrap(), ClientMsg::Ping {});
    }
}
