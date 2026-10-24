//! Keychain reads, plus writes for the items Termic owns (a pasted API
//! key or token, `termic:<id>`). The broker runs outside the cage, so #399's
//! Keychain block does not apply to it; the first read of a login-keychain
//! item may show macOS's "Termic wants to access" prompt.
//!
//! Owned items go to the data protection keychain when the build is signed
//! for it, else the login keychain (-34018 on unsigned builds). The kind a
//! secret saves says which, and reads and deletes follow it.
//!
//! The e2e build keeps Termic-owned items in memory, so a test run never
//! writes to the login Keychain of whoever runs it.

use super::SecretStatus;
use crate::secrets::{owned_service, KeychainKind, SecretDef, OWNED_ACCOUNT};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A secret's value. Deliberately no `Debug` / `Display`, so it cannot be
/// formatted into a `dlog` line or an error by accident.
pub(crate) struct Secret(String);

impl Secret {
    #[cfg(test)]
    pub(crate) fn new(v: String) -> Self { Secret(v) }
    pub(crate) fn expose(&self) -> &str { &self.0 }
}

const TTL: Duration = Duration::from_secs(60);

// (kind, service, account): the same name in two stores is two items.
type Key = (KeychainKind, String, String);

// ponytail: one global map, a few entries at most (one per secret).
type Cache = Mutex<HashMap<Key, (Instant, Arc<Secret>)>>;
static CACHE: OnceLock<Cache> = OnceLock::new();

fn cache() -> &'static Cache {
    CACHE.get_or_init(Default::default)
}

fn key(s: &SecretDef) -> Key { (s.kind, s.service.clone(), s.account.clone()) }

fn uncache(kind: KeychainKind, service: &str) {
    cache().lock().unwrap_or_else(|e| e.into_inner()).remove(&(kind, service.to_string(), OWNED_ACCOUNT.to_string()));
}

/// The value, from a 60s cache or a fresh read. Fails closed with the
/// status the UI shows.
pub(crate) fn read(s: &SecretDef) -> Result<Arc<Secret>, SecretStatus> {
    {
        let mut c = cache().lock().unwrap_or_else(|e| e.into_inner());
        // drop every expired value, not just this one: a deleted secret's
        // token must not sit in memory until the app exits.
        c.retain(|_, (at, _)| at.elapsed() < TTL);
        if let Some((_, v)) = c.get(&key(s)) { return Ok(v.clone()); }
    }
    read_fresh(s)
}

/// Bypasses the cache (Test access), and refreshes it on success.
pub(crate) fn read_fresh(s: &SecretDef) -> Result<Arc<Secret>, SecretStatus> {
    if s.service.trim().is_empty() || s.account.trim().is_empty() {
        return Err(SecretStatus::Missing);
    }
    let v = Arc::new(Secret(unwrap_value(raw_read(s)?)?));
    cache().lock().unwrap_or_else(|e| e.into_inner()).insert(key(s), (Instant::now(), v.clone()));
    Ok(v)
}

/// gh stores its token through go-keyring, which base64-wraps it.
fn unwrap_value(raw: Vec<u8>) -> Result<String, SecretStatus> {
    use base64::Engine;
    let s = String::from_utf8(raw).map_err(|_| SecretStatus::Error("item is not text".into()))?;
    let s = match s.strip_prefix("go-keyring-base64:") {
        Some(b) => {
            let d = base64::engine::general_purpose::STANDARD.decode(b.trim())
                .map_err(|_| SecretStatus::Error("bad go-keyring encoding".into()))?;
            String::from_utf8(d).map_err(|_| SecretStatus::Error("item is not text".into()))?
        }
        None => s,
    };
    let s = s.trim().to_string();
    if s.is_empty() { return Err(SecretStatus::Missing); }
    // the value lands in a header: a CR or LF would let the item inject more.
    if s.chars().any(char::is_control) { return Err(SecretStatus::Error("item holds control characters".into())); }
    Ok(s)
}

/// Largest value `store` accepts. API keys and tokens are well under this.
pub(crate) const MAX_VALUE: usize = 16 * 1024;

/// errSecMissingEntitlement: this build is not signed for the data
/// protection keychain (dev, ad-hoc and contributor builds).
const MISSING_ENTITLEMENT: i32 = -34018;

/// Write (or replace) the value of the Termic-owned item for secret `id`,
/// and say which store it landed in. There is no way back out except the
/// broker's own read on the way upstream. `name` becomes the item's label,
/// which is what macOS's access prompt and Keychain Access show.
pub(crate) fn store(id: &str, name: &str, value: &str) -> Result<KeychainKind, String> {
    let v = value.trim();
    if v.is_empty() { return Err("the value is empty".into()); }
    if v.len() > MAX_VALUE { return Err("the value is too long".into()); }
    if v.chars().any(char::is_control) { return Err("the value holds control characters".into()); }
    let service = owned_service(id);
    let label = owned_label(id, name);
    let kind = pick_store(
        raw_store(KeychainKind::Protected, &service, &label, v),
        || raw_store(KeychainKind::Generic, &service, &label, v),
    )
        .map_err(write_err)?;
    // a Replace on a build that writes to the other store leaves one item.
    let other = if kind == KeychainKind::Protected { KeychainKind::Generic } else { KeychainKind::Protected };
    raw_forget(other, &service);
    uncache(KeychainKind::Protected, &service);
    uncache(KeychainKind::Generic, &service);
    Ok(kind)
}

/// `Termic: <name>`, the secret's id when it has no name.
fn owned_label(id: &str, name: &str) -> String {
    let name = name.trim();
    format!("Termic: {}", if name.is_empty() { id } else { name })
}

/// Protected when that write worked, the login keychain only when the build
/// lacks the entitlement. Any other failure is the user's to see: falling
/// back on, say, a locked keychain would hide it.
fn pick_store(protected: Result<(), i32>, generic: impl FnOnce() -> Result<(), i32>) -> Result<KeychainKind, i32> {
    match protected {
        Ok(()) => Ok(KeychainKind::Protected),
        Err(MISSING_ENTITLEMENT) => generic().map(|()| KeychainKind::Generic),
        Err(c) => Err(c),
    }
}

fn write_err(code: i32) -> String {
    match status_for(code) {
        SecretStatus::Error(d) => d,
        _ => format!("Keychain error {code}"),
    }
}

/// Delete the Termic-owned item for secret `id` from both stores (the
/// caller may not know the kind). A missing item is fine.
pub(crate) fn forget(id: &str) {
    let service = owned_service(id);
    for kind in [KeychainKind::Protected, KeychainKind::Generic] {
        raw_forget(kind, &service);
        uncache(kind, &service);
    }
}

/// Whether this build may use the data protection keychain. Asks for an
/// item that is never written (ids cannot hold a `.`), so no value comes
/// back; only -34018 means no.
pub(crate) fn protected_available() -> bool {
    static P: OnceLock<bool> = OnceLock::new();
    *P.get_or_init(|| raw_probe_protected() != Err(MISSING_ENTITLEMENT))
}

#[cfg(feature = "e2e")]
fn raw_probe_protected() -> Result<(), i32> { Ok(()) }

#[cfg(all(target_os = "macos", not(feature = "e2e")))]
fn raw_probe_protected() -> Result<(), i32> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    let mut o = PasswordOptions::new_generic_password("termic.probe", OWNED_ACCOUNT);
    o.use_protected_keychain();
    generic_password(o).map(drop).map_err(|e| e.code())
}

#[cfg(all(not(target_os = "macos"), not(feature = "e2e")))]
fn raw_probe_protected() -> Result<(), i32> { Err(MISSING_ENTITLEMENT) }

// ponytail: the fake ignores the kind on read (see raw_read), so a seeded
// `generic` owned secret still reads in e2e.
#[cfg(feature = "e2e")]
fn fake_store() -> &'static Mutex<HashMap<(KeychainKind, String), String>> {
    static FAKE: OnceLock<Mutex<HashMap<(KeychainKind, String), String>>> = OnceLock::new();
    FAKE.get_or_init(Default::default)
}

#[cfg(feature = "e2e")]
fn raw_store(kind: KeychainKind, service: &str, _label: &str, v: &str) -> Result<(), i32> {
    fake_store().lock().unwrap_or_else(|e| e.into_inner()).insert((kind, service.into()), v.into());
    Ok(())
}

#[cfg(feature = "e2e")]
fn raw_forget(kind: KeychainKind, service: &str) {
    fake_store().lock().unwrap_or_else(|e| e.into_inner()).remove(&(kind, service.to_string()));
}

#[cfg(all(target_os = "macos", not(feature = "e2e")))]
fn owned_options(kind: KeychainKind, service: &str) -> security_framework::passwords::PasswordOptions {
    let mut o = security_framework::passwords::PasswordOptions::new_generic_password(service, OWNED_ACCOUNT);
    // not synchronizable: an agent-scoped token has no business on a phone.
    if kind == KeychainKind::Protected { o.use_protected_keychain(); }
    o
}

#[cfg(all(target_os = "macos", not(feature = "e2e")))]
fn raw_store(kind: KeychainKind, service: &str, label: &str, v: &str) -> Result<(), i32> {
    let set = || {
        let mut o = owned_options(kind, service);
        o.set_label(label);
        security_framework::passwords::set_generic_password_options(v.as_bytes(), o).map_err(|e| e.code())
    };
    match set() {
        // an existing item is updated by matching every attribute given, the
        // label too, so one saved under another label (a renamed secret, or
        // one from before labels) reads as not found: replace it.
        Err(-25300) => {
            raw_forget(kind, service);
            set()
        }
        r => r,
    }
}

#[cfg(all(target_os = "macos", not(feature = "e2e")))]
fn raw_forget(kind: KeychainKind, service: &str) {
    let _ = security_framework::passwords::delete_generic_password_options(owned_options(kind, service));
}

#[cfg(all(not(target_os = "macos"), not(feature = "e2e")))]
fn raw_store(_kind: KeychainKind, _service: &str, _label: &str, _v: &str) -> Result<(), i32> {
    Err(-4) // errSecUnimplemented
}

#[cfg(all(not(target_os = "macos"), not(feature = "e2e")))]
fn raw_forget(_kind: KeychainKind, _service: &str) {}

/// Map a Security.framework OSStatus to what the UI shows.
pub(crate) fn status_for(code: i32) -> SecretStatus {
    match code {
        -25300 => SecretStatus::Missing,           // errSecItemNotFound
        -25294 => SecretStatus::Missing,           // errSecNoSuchKeychain
        -25308 => SecretStatus::Locked,            // errSecInteractionNotAllowed
        -25293 | -128 => SecretStatus::Denied,     // errSecAuthFailed, errSecUserCanceled
        MISSING_ENTITLEMENT => SecretStatus::Error("this build is not signed for the protected Keychain (-34018)".into()),
        -4 => SecretStatus::Error("the Keychain needs macOS".into()), // errSecUnimplemented
        c => SecretStatus::Error(format!("Keychain error {c}")),
    }
}

#[cfg(target_os = "macos")]
fn raw_read(s: &SecretDef) -> Result<Vec<u8>, SecretStatus> {
    #[cfg(feature = "e2e")]
    if s.service.starts_with(crate::secrets::OWNED_SERVICE_PREFIX) {
        let fake = fake_store().lock().unwrap_or_else(|e| e.into_inner());
        return [KeychainKind::Protected, KeychainKind::Generic].iter()
            .find_map(|k| fake.get(&(*k, s.service.clone())))
            .map(|v| v.clone().into_bytes()).ok_or(SecretStatus::Missing);
    }
    if s.kind == KeychainKind::Generic && s.service.starts_with("gh:") {
        return read_via_security(s);
    }
    use security_framework::os::macos::passwords::{SecAuthenticationType, SecProtocolType};
    use security_framework::passwords::{self, PasswordOptions};
    let r = match s.kind {
        KeychainKind::Generic => passwords::get_generic_password(&s.service, &s.account),
        KeychainKind::Protected => {
            let mut o = PasswordOptions::new_generic_password(&s.service, &s.account);
            o.use_protected_keychain();
            passwords::generic_password(o)
        }
        KeychainKind::Unknown => return Err(SecretStatus::Error("saved by a newer Termic".into())),
        KeychainKind::Internet => {
            // git's osxkeychain helper stores server + account (+ protocol);
            // match on those two only, never path / auth type, which the
            // stock constructor would pin.
            let mut o = PasswordOptions::new_internet_password(
                &s.service, None, &s.account, "", None, SecProtocolType::Any, SecAuthenticationType::Any,
            );
            #[allow(deprecated)]
            o.query.retain(|(k, _)| !matches!(k.to_string().as_str(), "path" | "ptcl" | "atyp"));
            passwords::generic_password(o)
        }
    };
    r.map_err(|e| status_for(e.code()))
}

/// gh writes its login through `/usr/bin/security` (go-keyring), so the item
/// trusts that tool and not Termic. Reading it the same way never shows the
/// "wants to access" prompt, on any build; any process can already do this,
/// so it opens nothing new. Termic's own items stay on Security.framework.
// ponytail: `-w` prints hex for a value with non-printable bytes. go-keyring
// stores base64, so gh's never has any.
#[cfg(target_os = "macos")]
fn read_via_security(s: &SecretDef) -> Result<Vec<u8>, SecretStatus> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", &s.service, "-a", &s.account, "-w"])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| SecretStatus::Error(format!("could not run security: {e}")))?;
    match out.status.code() {
        Some(0) => Ok(out.stdout),
        Some(c) => Err(security_exit_status(c)),
        None => Err(SecretStatus::Error("security was killed".into())),
    }
}

/// `security` exits with the low byte of the OSStatus it got.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn security_exit_status(code: i32) -> SecretStatus {
    [-25300, -25294, -25308, -25293, -128].into_iter()
        .find(|s| s & 0xff == code)
        .map_or_else(|| SecretStatus::Error(format!("security exited {code}")), status_for)
}

#[cfg(not(target_os = "macos"))]
fn raw_read(_s: &SecretDef) -> Result<Vec<u8>, SecretStatus> {
    Err(SecretStatus::Error("Keychain reads need macOS".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn go_keyring_values_are_unwrapped() {
        let wrapped = format!("go-keyring-base64:{}", base64::engine::general_purpose::STANDARD.encode("gho_abc"));
        assert_eq!(unwrap_value(wrapped.into_bytes()).ok().as_deref(), Some("gho_abc"));
        assert_eq!(unwrap_value(b"plain\n".to_vec()).ok().as_deref(), Some("plain"));
        assert_eq!(unwrap_value(b"  ".to_vec()).err(), Some(SecretStatus::Missing));
        assert!(matches!(unwrap_value(b"go-keyring-base64:!!".to_vec()), Err(SecretStatus::Error(_))));
        // a value that would split a header is refused, wrapped or not
        assert!(matches!(unwrap_value(b"sk-1\r\nX-Evil: 1".to_vec()), Err(SecretStatus::Error(_))));
        let wrapped = format!("go-keyring-base64:{}", base64::engine::general_purpose::STANDARD.encode("a\nb"));
        assert!(matches!(unwrap_value(wrapped.into_bytes()), Err(SecretStatus::Error(_))));
    }

    #[test]
    fn store_refuses_bad_values_before_the_keychain() {
        assert!(store("k", "n", "  ").is_err());
        assert!(store("k", "n", "sk-1\nX: y").is_err());
        assert!(store("k", "n", &"a".repeat(MAX_VALUE + 1)).is_err());
    }

    #[test]
    fn owned_label_names_the_secret() {
        assert_eq!(owned_label("k1", " OpenAI key "), "Termic: OpenAI key");
        assert_eq!(owned_label("k1", "  "), "Termic: k1");
    }

    #[test]
    fn security_exit_codes_map_to_ui_status() {
        assert_eq!(security_exit_status(44), SecretStatus::Missing);
        assert_eq!(security_exit_status(36), SecretStatus::Locked);
        assert_eq!(security_exit_status(51), SecretStatus::Denied);
        assert_eq!(security_exit_status(128), SecretStatus::Denied);
        assert!(matches!(security_exit_status(1), SecretStatus::Error(d) if d.contains("exited 1")));
    }

    #[test]
    fn os_status_maps_to_ui_status() {
        assert_eq!(status_for(-25300), SecretStatus::Missing);
        assert_eq!(status_for(-25308), SecretStatus::Locked);
        assert_eq!(status_for(-25293), SecretStatus::Denied);
        assert_eq!(status_for(-128), SecretStatus::Denied);
        assert!(matches!(status_for(-1), SecretStatus::Error(_)));
        assert!(matches!(status_for(-34018), SecretStatus::Error(d) if d.contains("not signed")));
    }

    #[test]
    fn store_falls_back_only_on_missing_entitlement() {
        assert_eq!(pick_store(Ok(()), || panic!("no second write")), Ok(KeychainKind::Protected));
        assert_eq!(pick_store(Err(-34018), || Ok(())), Ok(KeychainKind::Generic));
        assert_eq!(pick_store(Err(-34018), || Err(-25308)), Err(-25308));
        // a locked keychain is the user's to see, not a reason to move stores
        assert_eq!(pick_store(Err(-25308), || panic!("no fallback")), Err(-25308));
    }

    #[test]
    fn empty_service_or_account_never_reads() {
        let s = SecretDef { service: "gh:github.com".into(), ..Default::default() };
        assert_eq!(read_fresh(&s).err(), Some(SecretStatus::Missing));
    }
}
