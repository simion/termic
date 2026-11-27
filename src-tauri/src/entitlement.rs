//! Entitlement tokens (docs/remote.md, Push and Relay): what a phone sends
//! in `push_reg` to say its person may use termic.dev's push and relay.
//! Checked offline here, as the phone and termic.dev check it.
//!
//! ```text
//! token   = b64url(payload_json) "." b64url(ed25519 signature over the b64url payload bytes)
//! payload = { "sub": "...", "ent": ["relay","push"], "exp": <unix seconds>, "prod": "..." }
//! ```
//!
//! Valid = the signature checks AND `exp` is in the future AND `ent` holds
//! the feature.

use serde::Deserialize;

/// termic.dev's ed25519 public key (raw 32 bytes, base64url).
pub(crate) const ENT_PUBLIC_KEY: &str = "XR-JQ5AidZgpV81fnUS5OeDkI_K99ArQ079FacPdRrc";

pub(crate) const PUSH: &str = "push";
pub(crate) const RELAY: &str = "relay";

#[derive(Deserialize)]
struct Payload {
    #[serde(default)]
    ent: Vec<String>,
    exp: i64,
}

/// Whether `token` grants `feature` now.
pub(crate) fn valid(token: &str, feature: &str) -> bool {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    // Tests sign with one process-wide test keypair (tests::issue); the
    // real key's seed is in no repo.
    #[cfg(test)]
    return valid_with(token, feature, ring::signature::KeyPair::public_key(tests::test_keypair()).as_ref(), now);
    #[cfg(not(test))]
    let Some(key) = termic_remote::unb64url(ENT_PUBLIC_KEY) else { return false };
    #[cfg(not(test))]
    valid_with(token, feature, &key, now)
}

pub(crate) fn valid_with(token: &str, feature: &str, public_key: &[u8], now_s: i64) -> bool {
    let Some((payload_b64, sig_b64)) = token.trim().split_once('.') else { return false };
    let Some(sig) = termic_remote::unb64url(sig_b64) else { return false };
    let key = ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public_key);
    if key.verify(payload_b64.as_bytes(), &sig).is_err() {
        return false;
    }
    let Some(p) = termic_remote::unb64url(payload_b64).and_then(|b| serde_json::from_slice::<Payload>(&b).ok()) else { return false };
    p.exp > now_s && p.ent.iter().any(|e| e == feature)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    pub(crate) fn keypair() -> Ed25519KeyPair {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
        Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap()
    }

    pub(crate) fn sign(kp: &Ed25519KeyPair, payload: serde_json::Value) -> String {
        let p = termic_remote::b64url(payload.to_string().as_bytes());
        format!("{p}.{}", termic_remote::b64url(kp.sign(p.as_bytes()).as_ref()))
    }

    /// The keypair `valid` trusts in tests.
    pub(crate) fn test_keypair() -> &'static Ed25519KeyPair {
        static KP: std::sync::OnceLock<Ed25519KeyPair> = std::sync::OnceLock::new();
        KP.get_or_init(keypair)
    }

    /// A token `valid` accepts in tests: `ent`, expiring in an hour.
    pub(crate) fn issue(ent: &[&str]) -> String {
        let exp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 3600;
        sign(test_keypair(), serde_json::json!({"sub":"install","ent":ent,"exp":exp,"prod":"pro"}))
    }

    #[test]
    fn the_shipped_key_is_32_bytes() {
        assert_eq!(termic_remote::unb64url(ENT_PUBLIC_KEY).unwrap().len(), 32);
    }

    #[test]
    fn a_token_is_valid_only_signed_unexpired_and_for_its_features() {
        let kp = keypair();
        let pk = kp.public_key().as_ref().to_vec();
        let t = sign(&kp, serde_json::json!({"sub":"s","ent":["relay","push"],"exp":2000,"prod":"p"}));
        assert!(valid_with(&t, PUSH, &pk, 1000));
        assert!(valid_with(&t, RELAY, &pk, 1000));
        assert!(!valid_with(&t, "other", &pk, 1000), "a feature it does not list");
        assert!(!valid_with(&t, PUSH, &pk, 2000), "expired");
        let push_only = sign(&kp, serde_json::json!({"ent":["push"],"exp":2000}));
        assert!(!valid_with(&push_only, RELAY, &pk, 1000));
        // Another key, a tampered payload, garbage.
        assert!(!valid_with(&t, PUSH, keypair().public_key().as_ref(), 1000));
        let (_, sig) = t.split_once('.').unwrap();
        let forged = termic_remote::b64url(br#"{"ent":["push"],"exp":99999999999}"#);
        assert!(!valid_with(&format!("{forged}.{sig}"), PUSH, &pk, 1000));
        assert!(!valid_with("", PUSH, &pk, 1000));
        assert!(!valid_with("a.b", PUSH, &pk, 1000));
        assert!(valid(&issue(&[PUSH]), PUSH) && !valid(&issue(&[PUSH]), RELAY));
        // The shipped key refuses a test-signed token.
        assert!(!valid_with(&t, PUSH, &termic_remote::unb64url(ENT_PUBLIC_KEY).unwrap(), 1000));
    }
}
