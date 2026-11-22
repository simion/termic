//! The remote-control stream (docs/remote.md).
//!
//! One long-lived connection between a client (a phone, another Termic) and
//! a host (a Termic desktop, a headless `termic-server`). Three layers, each
//! a module with its own tests:
//!
//! - [`wire`]: the messages, JSON with a `t` tag. Additive by contract: a
//!   side ignores a message type or field it does not know, and the hello
//!   carries a version and a capability list so an older peer is degraded,
//!   never refused.
//! - [`seal`]: the session crypto. Fresh keys per connection from the pair
//!   key and a salt from each side (so a recorded session can never be
//!   replayed), one key per direction (so a frame can never be reflected),
//!   bound to both ids, ChaCha20-Poly1305 with a counter nonce (so frames
//!   cannot be dropped, reordered or repeated without the next one failing).
//! - [`ws`] and [`framed`]: carrying frames. A WebSocket over TCP for phones
//!   and computers (what React Native speaks natively), length-prefixed
//!   frames over stdio for `ssh host termic-server bridge`, where SSH is the
//!   secure channel and frames are not sealed again.
//!
//! Nothing here knows about tasks or PTYs; the app and the server do.

pub mod compat;
pub mod conn;
pub mod pty;
pub mod framed;
pub mod outbox;
mod pb;
pub mod screen;
pub mod seal;
pub mod transcript;
pub mod wire;
pub mod ws;

use std::io;

/// Sends whole frames. One writer per connection, owned by one thread.
pub trait FrameWrite: Send {
    fn send(&mut self, frame: &[u8]) -> io::Result<()>;
    /// End the connection politely (a WebSocket close frame). Best effort.
    fn close(&mut self, _code: u16, _reason: &str) {}
}

/// Receives whole frames. `Ok(None)` is a clean end of the connection.
pub trait FrameRead: Send {
    fn recv(&mut self) -> io::Result<Option<Vec<u8>>>;
}

/// The largest frame either side accepts. A terminal backlog is at most
/// 256 KiB of PTY output (base64 and JSON make it ~350 KiB); a reply can
/// carry `diff --full`. Anything larger is refused before it is buffered.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

pub fn b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn unb64(s: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s.trim()).ok()
}

pub fn b64url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64url(s: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s.trim().trim_end_matches('=')).ok()
}

/// A 32-hex id (an instance or phone id) as its 16 raw bytes, and back.
pub fn id_to_bytes(id: &str) -> Option<[u8; 16]> {
    if id.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, chunk) in id.as_bytes().chunks(2).enumerate() {
        let s = std::str::from_utf8(chunk).ok()?;
        out[i] = u8::from_str_radix(s, 16).ok()?;
    }
    Some(out)
}

pub fn id_from_bytes(b: &[u8]) -> Option<String> {
    (b.len() == 16).then(|| b.iter().map(|x| format!("{x:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_and_reject_bad_input() {
        let id = "00ff10a0b1c2d3e4f5061728394a5b6c";
        assert_eq!(id_from_bytes(&id_to_bytes(id).unwrap()).unwrap(), id);
        assert!(id_to_bytes("short").is_none());
        assert!(id_to_bytes("zz00000000000000000000000000000z").is_none());
        assert!(id_from_bytes(&[0u8; 15]).is_none());
    }

    #[test]
    fn base64url_round_trips_with_or_without_padding() {
        let k = [7u8; 32];
        let s = b64url(&k);
        assert!(!s.contains('='));
        assert_eq!(unb64url(&s).unwrap(), k);
        assert_eq!(unb64url(&format!("{s}=")).unwrap(), k);
    }
}
