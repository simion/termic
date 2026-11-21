// Push notifications to paired phones that are away (docs/remote.md, "Push").
//
// A push goes through Apple (APNs) or Google (FCM), and the sender needs a
// key that cannot ship inside this app (anyone could pull it out). So the
// desktop hands each push to a small relay on termic.dev that holds the
// keys, and the relay forwards it. Until that relay exists `PUSH_RELAY` is
// None and nothing leaves this machine: the tokens are stored, the call
// sites are wired, the network call is the one missing piece.

use serde::Serialize;

/// The relay that forwards to APNs / FCM. termic.dev is already the one
/// host the app talks to (termic.dev/local), so it adds no new party.
const PUSH_RELAY: Option<&str> = None;

#[derive(Serialize, Debug, PartialEq)]
struct PushBody<'a> {
    platform: &'a str,
    token: &'a str,
    title: &'a str,
    body: &'a str,
}

/// What would be sent for one notification: one request per away phone.
fn bodies<'a>(targets: &'a [crate::peers::PushTarget], title: &'a str, body: &'a str) -> Vec<PushBody<'a>> {
    targets.iter().map(|t| PushBody { platform: &t.platform, token: &t.token, title, body }).collect()
}

/// Push the notification the desktop just showed to every paired phone
/// that is not connected. Fire and forget: a failed push loses nothing the
/// phone will not see when it next opens.
#[tauri::command]
pub(crate) fn phones_push(title: String, body: String) {
    let Some(node) = crate::peers::node() else { return };
    let targets = node.away_push_targets();
    if targets.is_empty() {
        return;
    }
    let Some(relay) = PUSH_RELAY else {
        crate::dlog(&format!("[push] {} away phone(s), no relay configured yet", targets.len()));
        return;
    };
    let payloads: Vec<String> = bodies(&targets, &title, &body).iter().filter_map(|b| serde_json::to_string(b).ok()).collect();
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        for json in payloads {
            let r = client.post(relay).header("content-type", "application/json").body(json).send().await;
            if let Err(e) = r {
                crate::dlog(&format!("[push] relay: {e}"));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peers::PushTarget;

    #[test]
    fn one_body_per_away_phone_carrying_only_the_notification() {
        let t = vec![
            PushTarget { platform: "ios".into(), token: "a1".into() },
            PushTarget { platform: "android".into(), token: "b2".into() },
        ];
        let b = bodies(&t, "api · fix-login", "needs you");
        assert_eq!(b.len(), 2);
        assert_eq!(b[1], PushBody { platform: "android", token: "b2", title: "api · fix-login", body: "needs you" });
        assert!(PUSH_RELAY.is_none(), "turning the relay on is a decision (docs/remote.md, Push), not a drive-by");
    }
}
