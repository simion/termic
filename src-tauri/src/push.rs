// Push notifications to paired phones that are away (docs/remote.md, "Push").
//
// A push goes through Apple (APNs) or Google (FCM), and the sender needs
// keys that cannot ship inside this app, so termic.dev sends it. What it
// says is sealed to the phone first: each phone's `push_reg` carries a
// 32-byte key, and termic.dev, Apple and Google see only ciphertext, the
// kind ("attention" or "done") and an opaque collapse id. The device token
// itself stays with termic.dev, sealed into the phone's `handle`.

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN};
use serde::Serialize;

use crate::peers::PushReg;

const PUSH_URL: &str = "https://api.termic.dev/v1/push";

#[derive(Serialize, Debug, PartialEq)]
struct PushBody<'a> {
    handle: &'a str,
    ent: &'a str,
    kind: &'a str,
    collapse: String,
    /// This computer's id: which of the phone's keys opens `ct`.
    c: &'a str,
    ct: String,
}

/// `b64url(nonce(12) || ChaCha20-Poly1305(key, json) || tag(16))` of
/// `{"title","body","task"}`: the layout CryptoKit's
/// `ChaChaPoly.SealedBox(combined:)` reads. None for a damaged key.
fn seal(key: &[u8], title: &str, body: &str, task: &str) -> Option<String> {
    let key = LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, key).ok()?);
    let nonce = crate::peer_crypto::random_bytes::<NONCE_LEN>();
    let mut buf = serde_json::to_vec(&serde_json::json!({ "title": title, "body": body, "task": task })).ok()?;
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut buf).ok()?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&buf);
    Some(termic_remote::b64url(&out))
}

/// One collapse id per (phone, task), so a newer push replaces an older one
/// on the lock screen. Opaque to the relay: it cannot read the task id.
fn collapse(key: &[u8], task: &str) -> String {
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    ctx.update(key);
    ctx.update(task.as_bytes());
    termic_remote::b64url(ctx.finish().as_ref())[..22].to_string()
}

/// What to send for one notification: one request per away phone whose
/// entitlement has "push", by phone id. A phone without one gets nothing.
fn requests<'a>(targets: &'a [(String, PushReg)], computer: &'a str, title: &str, body: &str, task: &str, attention: bool) -> Vec<(&'a str, &'a str, PushBody<'a>)> {
    let kind = if attention { "attention" } else { "done" };
    targets
        .iter()
        .filter(|(_, r)| crate::entitlement::valid(&r.ent, crate::entitlement::PUSH))
        .filter_map(|(id, r)| {
            let key = termic_remote::unb64url(&r.key).filter(|k| k.len() == 32)?;
            let ct = seal(&key, title, body, task)?;
            Some((id.as_str(), r.handle.as_str(), PushBody { handle: &r.handle, ent: &r.ent, kind, collapse: collapse(&key, task), c: computer, ct }))
        })
        .collect()
}

/// Push the notification the desktop just showed (title "project · task",
/// body what it needs) to every paired phone that is not connected.
/// `attention`: a needs-you, rather than a finished turn. Fire and forget:
/// a failed push loses nothing the phone will not see when it next opens,
/// so nothing is retried.
///
/// Not while the person is at this computer: phones are told only once the
/// machine has gone without input for this kind's delay (peers.rs
/// `notify_prefs`, set in Settings > Notifications or from a phone; 0
/// always, -1 never). A needs-you and a finished turn have separate delays. The whole system counts, not just
/// Termic: typing in a browser beside it is being here. Where the OS cannot
/// say (Linux), Termic's own last input (`app_idle_ms`) stands in.
/// shortcut: a push skipped because you were here is not sent later if you
/// leave with the task still waiting; add a deferred re-check if asked for.
#[tauri::command]
pub(crate) fn phones_push(title: String, body: String, task: Option<String>, attention: Option<bool>, app_idle_ms: Option<u64>) {
    let attention = attention.unwrap_or(false);
    let idle = system_idle_ms().or(app_idle_ms).unwrap_or(u64::MAX);
    let Some(node) = crate::peers::node() else { return };
    let (a, d) = node.notify_prefs();
    if !due(if attention { a } else { d }, idle) {
        crate::dlog(&format!("[push] not yet: input {}s ago", idle / 1000));
        return;
    }
    let targets = node.away_push_targets();
    if targets.is_empty() {
        return;
    }
    let computer = node.self_id();
    let task = task.unwrap_or_default();
    let reqs: Vec<(String, String, String)> = requests(&targets, &computer, &title, &body, &task, attention)
        .into_iter()
        .filter_map(|(id, handle, b)| Some((id.to_string(), handle.to_string(), serde_json::to_string(&b).ok()?)))
        .collect();
    if reqs.is_empty() {
        crate::dlog(&format!("[push] {} away phone(s), none with push", targets.len()));
        return;
    }
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        for (phone, handle, json) in reqs {
            match client.post(PUSH_URL).header("content-type", "application/json").body(json).send().await {
                Ok(r) if r.status().is_success() => {}
                Ok(r) if r.status() == reqwest::StatusCode::GONE => {
                    crate::dlog("[push] a phone's device is gone, dropping its registration");
                    node.forget_push_handle(&phone, &handle);
                }
                Ok(r) => crate::dlog(&format!("[push] relay answered {}", r.status())),
                Err(e) => crate::dlog(&format!("[push] relay: {e}")),
            }
        }
    });
}

/// Whether phones are told now: the delay for this kind against how long
/// the machine has gone without input. Negative is never.
fn due(after_s: i32, idle_ms: u64) -> bool {
    after_s >= 0 && idle_ms >= after_s as u64 * 1000
}

/// Settings > Notifications reads the two delays.
#[tauri::command]
pub(crate) fn phones_notify_prefs() -> (i32, i32) {
    crate::peers::node().map(|n| n.notify_prefs()).unwrap_or(crate::peers::NOTIFY_DEFAULTS)
}

/// And sets them (phones read them on their next connect).
#[tauri::command]
pub(crate) fn phones_set_notify_prefs(attention_s: i32, done_s: i32) {
    if let Some(n) = crate::peers::node() {
        n.set_notify_prefs(attention_s, done_s);
    }
}

/// Milliseconds since the last keyboard, mouse or trackpad input anywhere on
/// this machine. None where the OS has no cheap answer.
#[cfg(target_os = "macos")]
fn system_idle_ms() -> Option<u64> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }
    // kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType.
    let s = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
    (s.is_finite() && s >= 0.0).then(|| (s * 1000.0) as u64)
}

#[cfg(windows)]
fn system_idle_ms() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    Some(unsafe { GetTickCount() }.wrapping_sub(info.dwTime) as u64)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn system_idle_ms() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entitlement::tests::issue;

    fn open(key: &[u8], ct: &str) -> serde_json::Value {
        let raw = termic_remote::unb64url(ct).unwrap();
        let (nonce, sealed) = raw.split_at(NONCE_LEN);
        let k = LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, key).unwrap());
        let mut buf = sealed.to_vec();
        let plain = k.open_in_place(Nonce::try_assume_unique_for_key(nonce).unwrap(), Aad::empty(), &mut buf).unwrap();
        serde_json::from_slice(plain).unwrap()
    }

    #[test]
    fn phones_hear_only_once_this_computer_has_been_left_long_enough() {
        assert!(due(0, 5_000), "always");
        assert!(!due(120, 30_000), "typed 30 s ago");
        assert!(due(120, 120_000));
        assert!(!due(-1, u64::MAX), "never");
        // The real reading is sane on a machine that has one.
        if let Some(ms) = system_idle_ms() {
            assert!(ms < 365 * 86_400_000);
        }
    }

    #[test]
    fn the_sealed_payload_is_nonce_ciphertext_tag_and_opens_with_the_key() {
        let key = [7u8; 32];
        let ct = seal(&key, "api · fix-login", "Claude needs your permission", "t1").unwrap();
        let raw = termic_remote::unb64url(&ct).unwrap();
        let json = serde_json::to_vec(&serde_json::json!({"title":"api · fix-login","body":"Claude needs your permission","task":"t1"})).unwrap();
        assert_eq!(raw.len(), 12 + json.len() + 16, "nonce || ciphertext || tag");
        assert_eq!(open(&key, &ct), serde_json::json!({"title":"api · fix-login","body":"Claude needs your permission","task":"t1"}));
        assert_ne!(seal(&key, "a", "b", "c"), seal(&key, "a", "b", "c"), "a fresh nonce each time");
        assert!(seal(&[1u8; 5], "a", "b", "c").is_none());
    }

    #[test]
    fn only_entitled_phones_get_a_body_and_it_hides_the_message() {
        let key = termic_remote::b64url(&[9u8; 32]);
        let reg = |ent: String| PushReg { handle: "h".into(), key: key.clone(), ent };
        let targets = vec![
            ("p1".to_string(), reg(issue(&["relay", "push"]))),
            ("p2".to_string(), reg(issue(&["relay"]))),
            ("p3".to_string(), reg(String::new())),
            ("p4".to_string(), PushReg { key: "short".into(), ..reg(issue(&["push"])) }),
        ];
        let r = requests(&targets, "c0ffee", "api · fix-login", "Allow Bash(rm -rf build)?", "t1", true);
        assert_eq!(r.len(), 1, "no push entitlement or a damaged key gets nothing");
        let (id, handle, b) = &r[0];
        assert_eq!((*id, *handle, b.kind, b.c, b.handle), ("p1", "h", "attention", "c0ffee", "h"));
        assert_eq!(b.collapse.len(), 22);
        assert_eq!(b.collapse, collapse(&[9u8; 32], "t1"));
        assert_ne!(b.collapse, collapse(&[9u8; 32], "t2"));
        let wire = serde_json::to_value(b).unwrap();
        let mut keys: Vec<_> = wire.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["c", "collapse", "ct", "ent", "handle", "kind"]);
        assert!(!wire.to_string().contains("fix-login"), "the message only travels sealed");
        assert_eq!(open(&[9u8; 32], &b.ct)["body"], "Allow Bash(rm -rf build)?");
        assert_eq!(requests(&targets, "c", "t", "b", "t1", false)[0].2.kind, "done");
    }
}
