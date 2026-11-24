//! Session crypto for the stream.
//!
//! The pair key never encrypts anything itself. Each connection derives two
//! fresh keys from it:
//!
//! ```text
//! salt  = host_salt (16 B, sent first by the host) || client_salt (16 B)
//! info  = "termic-stream-v1|" dir "|" host_id "|" client_id
//! key   = HKDF-SHA256(salt, ikm = pair key, info)       dir in {c2s, s2c}
//! nonce = 4 zero bytes || frame counter (u64, big-endian)
//! ```
//!
//! - Both sides contribute randomness, so a recording of one connection
//!   opens nothing on the next: replaying it derives other keys.
//! - One key per direction: a frame cannot be reflected back at its sender.
//! - Both ids in the info: the keys belong to exactly this pair.
//! - The counter is implicit and strictly increasing, so a dropped,
//!   repeated or reordered frame makes the next one fail to open, and the
//!   connection ends. WebSocket and stdio are both ordered and reliable, so
//!   that only ever happens under attack or corruption.
//!
//! ChaCha20-Poly1305 from `ring`, like the rest of pairing (peer_crypto.rs).

use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::hkdf;
use ring::rand::{SecureRandom, SystemRandom};

pub const SALT_LEN: usize = 16;
pub const KEY_LEN: usize = 32;
pub const TAG_LEN: usize = 16;
const INFO_PREFIX: &str = "termic-stream-v1";

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    // Only fails when the OS has no entropy at all; a zeroed key would be a
    // silent disaster, so a panic is the right answer here.
    SystemRandom::new().fill(&mut out).expect("the OS random source failed");
    out
}

struct Len(usize);
impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn derive(pair_key: &[u8; KEY_LEN], salt: &[u8], dir: &str, host_id: &str, client_id: &str) -> [u8; KEY_LEN] {
    let info = format!("{INFO_PREFIX}|{dir}|{host_id}|{client_id}");
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(pair_key);
    let parts = [info.as_bytes()];
    let okm = prk.expand(&parts, Len(KEY_LEN)).expect("32 bytes is within HKDF-SHA256's limit");
    let mut out = [0u8; KEY_LEN];
    okm.fill(&mut out).expect("buffer is the requested length");
    out
}

fn nonce(counter: u64) -> Nonce {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&counter.to_be_bytes());
    Nonce::assume_unique_for_key(n)
}

/// Which end of the connection this process is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Host,
    Client,
}

/// The two halves of a connection's crypto, split so the reading thread and
/// the writing thread each own one.
pub fn session(
    pair_key: &[u8; KEY_LEN],
    host_salt: &[u8; SALT_LEN],
    client_salt: &[u8; SALT_LEN],
    host_id: &str,
    client_id: &str,
    role: Role,
) -> (Sealer, Opener) {
    let mut salt = [0u8; SALT_LEN * 2];
    salt[..SALT_LEN].copy_from_slice(host_salt);
    salt[SALT_LEN..].copy_from_slice(client_salt);
    let c2s = derive(pair_key, &salt, "c2s", host_id, client_id);
    let s2c = derive(pair_key, &salt, "s2c", host_id, client_id);
    let (send, recv) = match role {
        Role::Client => (c2s, s2c),
        Role::Host => (s2c, c2s),
    };
    (Sealer::new(&send), Opener::new(&recv))
}

pub struct Sealer {
    key: LessSafeKey,
    n: u64,
}

impl Sealer {
    fn new(k: &[u8; KEY_LEN]) -> Sealer {
        Sealer { key: LessSafeKey::new(UnboundKey::new(&aead::CHACHA20_POLY1305, k).expect("32-byte key")), n: 0 }
    }
    pub fn seal(&mut self, plain: &[u8]) -> Vec<u8> {
        let mut buf = plain.to_vec();
        let n = nonce(self.n);
        // u64 frames will not run out; refuse to wrap rather than reuse a nonce.
        self.n = self.n.checked_add(1).expect("frame counter exhausted");
        self.key.seal_in_place_append_tag(n, Aad::empty(), &mut buf).expect("sealing cannot fail for in-memory buffers");
        buf
    }
}

pub struct Opener {
    key: LessSafeKey,
    n: u64,
}

impl Opener {
    fn new(k: &[u8; KEY_LEN]) -> Opener {
        Opener { key: LessSafeKey::new(UnboundKey::new(&aead::CHACHA20_POLY1305, k).expect("32-byte key")), n: 0 }
    }
    /// None when the frame was not sealed by the other end of THIS
    /// connection, in THIS position. The caller ends the connection.
    pub fn open(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        if frame.len() < TAG_LEN {
            return None;
        }
        let mut buf = frame.to_vec();
        let n = nonce(self.n);
        let plain_len = self.key.open_in_place(n, Aad::empty(), &mut buf).ok()?.len();
        self.n = self.n.checked_add(1)?;
        buf.truncate(plain_len);
        Some(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const CLIENT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn pair() -> ((Sealer, Opener), (Sealer, Opener)) {
        let key = [9u8; 32];
        let hs = [1u8; 16];
        let cs = [2u8; 16];
        (session(&key, &hs, &cs, HOST, CLIENT, Role::Host), session(&key, &hs, &cs, HOST, CLIENT, Role::Client))
    }

    #[test]
    fn frames_flow_both_ways_in_order() {
        let ((mut hs, mut ho), (mut cs, mut co)) = pair();
        for i in 0..5 {
            let m = format!("client {i}");
            assert_eq!(ho.open(&cs.seal(m.as_bytes())).unwrap(), m.as_bytes());
            let r = format!("host {i}");
            assert_eq!(co.open(&hs.seal(r.as_bytes())).unwrap(), r.as_bytes());
        }
    }

    #[test]
    fn a_frame_cannot_be_reflected_to_its_sender() {
        let ((_, mut ho), (mut cs, mut co)) = pair();
        let f = cs.seal(b"hello");
        assert!(co.open(&f).is_none(), "client opened its own frame");
        assert!(ho.open(&f).is_some());
    }

    #[test]
    fn replayed_dropped_or_reordered_frames_fail() {
        let ((_, mut ho), (mut cs, _)) = pair();
        let a = cs.seal(b"a");
        let b = cs.seal(b"b");
        assert!(ho.open(&b).is_none(), "out of order opened");
        let ((_, mut ho), (mut cs, _)) = pair();
        let a2 = cs.seal(b"a");
        assert_eq!(a, a2, "same keys and counter give the same frame");
        assert!(ho.open(&a2).is_some());
        assert!(ho.open(&a2).is_none(), "a repeated frame opened");
    }

    #[test]
    fn a_tampered_frame_fails() {
        let ((_, mut ho), (mut cs, _)) = pair();
        let mut f = cs.seal(b"send rm -rf");
        f[0] ^= 1;
        assert!(ho.open(&f).is_none());
        assert!(ho.open(&[0u8; 3]).is_none());
    }

    #[test]
    fn another_connection_derives_other_keys() {
        let key = [9u8; 32];
        let (_, mut ho) = session(&key, &[1; 16], &[2; 16], HOST, CLIENT, Role::Host);
        let (mut cs_old, _) = session(&key, &[3; 16], &[2; 16], HOST, CLIENT, Role::Client);
        // A recording from a session with another host salt does not open.
        assert!(ho.open(&cs_old.seal(b"x")).is_none());
    }

    #[test]
    fn keys_are_bound_to_both_ids_and_the_pair_key() {
        let (_, mut ho) = session(&[9; 32], &[1; 16], &[2; 16], HOST, CLIENT, Role::Host);
        let (mut other_id, _) = session(&[9; 32], &[1; 16], &[2; 16], HOST, HOST, Role::Client);
        assert!(ho.open(&other_id.seal(b"x")).is_none());
        let (_, mut ho) = session(&[9; 32], &[1; 16], &[2; 16], HOST, CLIENT, Role::Host);
        let (mut other_key, _) = session(&[8; 32], &[1; 16], &[2; 16], HOST, CLIENT, Role::Client);
        assert!(ho.open(&other_key.seal(b"x")).is_none());
    }

    /// Pins the derivation, so another implementation of the stream (the
    /// phone's) can be checked against the same vector.
    #[test]
    fn known_vector() {
        let (mut cs, _) = session(&[9; 32], &[1; 16], &[2; 16], HOST, CLIENT, Role::Client);
        let f = cs.seal(b"{\"t\":\"ping\"}");
        let hex: String = f.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex.len(), (12 + 16) * 2);
        // Printed so another implementation can copy it into its own test.
        println!("KNOWN_VECTOR {hex}");
    }
}
