//! GitHub rate-limit ledger: what the token's limits are, what is left, and
//! what termic itself spent, per host.
//!
//! The `gh` token is shared with the user's terminal and with every agent
//! running `gh` in a task, so two numbers are kept apart:
//!
//! - the account-wide window (limit / remaining / reset), as GitHub last
//!   reported it on any response, which includes everyone's spend;
//! - termic's own spend, a one-hour ring tagged by feature.
//!
//! Background work (pollers, timers) asks `background_gate` first and is
//! deferred while termic is over its share or the account is under the
//! floor. A user action still runs. Rules and numbers: docs/performance.md
//! "Forge budget".

use std::collections::{HashMap, VecDeque};
use std::sync::OnceLock;

// parking_lot: a panic in the listener must not poison the ledger and take
// every later `gh_api` call down with it.
use parking_lot::Mutex;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Bucket {
    Graphql,
    Core,
}

impl Bucket {
    fn parse(resource: &str) -> Option<Self> {
        match resource {
            "graphql" => Some(Bucket::Graphql),
            "core" => Some(Bucket::Core),
            _ => None,
        }
    }

    /// GitHub's documented hourly limit for a user token, used until a
    /// response tells us the real one.
    fn default_limit(self) -> u64 {
        5000
    }

    /// Termic's own hourly cap. GraphQL: a share of the limit (the token is
    /// shared). Core: a flat number, since termic's only REST use today is
    /// the comment watcher's inline-comments call, which is the one
    /// background caller gated on it. The pill and `paused` follow GraphQL,
    /// the bucket every other background job spends.
    fn cap(self, limit: u64) -> u64 {
        match self {
            Bucket::Graphql => (limit as f64 * TERMIC_SHARE) as u64,
            Bucket::Core => CORE_CAP.min(limit),
        }
    }
}

/// Share of the GraphQL hourly limit termic may spend in the background.
pub const TERMIC_SHARE: f64 = 0.20;
/// Termic's REST core requests per hour (gates the background comments leg).
pub const CORE_CAP: u64 = 300;
/// Pause background work while the ACCOUNT has less than this share left.
pub const FLOOR: f64 = 0.15;
const HOUR: u64 = 3600;
/// First wait after a secondary limit with no retry-after, doubled per
/// repeat and capped, per GitHub's guidance.
const SECONDARY_BACKOFF_SECS: u64 = 60;
const SECONDARY_BACKOFF_MAX_SECS: u64 = 15 * 60;
/// The furthest out a host may push a pause or a window reset. GitHub's
/// windows are an hour; a larger number is a broken or hostile host, and
/// left alone it would hold background work for good (and overflow the
/// webview's timer, which wraps past ~24.8 days).
const MAX_AHEAD_SECS: u64 = 24 * HOUR;
/// Ceiling on one query's reported cost. GitHub caps a query well below
/// this; the clamp only keeps a hostile number from overflowing the sums.
const MAX_COST: u64 = 10_000;

/// GitHub's view of one bucket, as of the last response that carried it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Window {
    pub limit: u64,
    pub remaining: u64,
    pub used: u64,
    /// Epoch seconds.
    pub reset_at: u64,
}

struct Spend {
    at: u64,
    feature: &'static str,
    bucket: Bucket,
    cost: u64,
    /// A legacy `gh pr ...` / `gh issue ...` call, which cannot report its
    /// cost. Counted as the 1-point minimum and labelled as a guess.
    estimated: bool,
}

#[derive(Default)]
struct HostLedger {
    windows: HashMap<Bucket, Window>,
    spend: VecDeque<Spend>,
    /// Epoch seconds per bucket GitHub refused on; absent = not refused.
    /// Per bucket because a core 403 says nothing about GraphQL. A
    /// secondary limit is account-wide and sets both.
    limited_until: HashMap<Bucket, u64>,
    /// Consecutive secondary limits without a retry-after, for the backoff.
    secondary_strikes: u32,
}

fn ledger() -> &'static Mutex<HashMap<String, HostLedger>> {
    static L: OnceLock<Mutex<HashMap<String, HostLedger>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(HashMap::new()))
}

type Listener = Box<dyn Fn(Vec<RateStatus>) + Send + Sync>;

fn listener() -> &'static Mutex<Option<Listener>> {
    static L: OnceLock<Mutex<Option<Listener>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(None))
}

/// Called with the full status whenever it changes (throttled, see
/// `notify`). Set once at app setup to emit `termic://forge-rate-changed`.
pub fn on_changed(f: impl Fn(Vec<RateStatus>) + Send + Sync + 'static) {
    *listener().lock() = Some(Box::new(f));
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ───────────────────────── recording ─────────────────────────

/// One HTTP answer as `gh api -i` printed it.
#[derive(Debug, Default)]
pub struct Observation<'a> {
    pub status: u16,
    /// Lowercased header names.
    pub headers: Option<&'a HashMap<String, String>>,
    /// GraphQL `data.rateLimit`, when the query asked for it.
    pub graphql_rate: Option<&'a serde_json::Value>,
    /// GraphQL `errors`, to spot a primary limit (which comes back as 200).
    pub graphql_errors: Option<&'a serde_json::Value>,
    /// Body text, to spot a secondary limit on a 403.
    pub body: &'a str,
}

/// What `observe` concluded.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    /// GitHub refused on a limit. Epoch seconds until termic may retry.
    Limited { until: u64 },
}

fn header_u64(h: &HashMap<String, String>, k: &str) -> Option<u64> {
    h.get(k).and_then(|v| v.trim().parse().ok())
}

/// A window GitHub reported. A limit of 0 is treated as no window: it would
/// put the cap at 0 and hold background work for good.
fn window_from_headers(h: &HashMap<String, String>) -> Option<(Bucket, Window)> {
    let bucket = Bucket::parse(h.get("x-ratelimit-resource")?.trim())?;
    Some((bucket, Window {
        limit: header_u64(h, "x-ratelimit-limit").filter(|&n| n > 0)?,
        remaining: header_u64(h, "x-ratelimit-remaining")?,
        used: header_u64(h, "x-ratelimit-used").unwrap_or(0),
        reset_at: header_u64(h, "x-ratelimit-reset")?,
    }))
}

fn window_from_graphql(v: &serde_json::Value) -> Option<Window> {
    let reset_at = chrono::DateTime::parse_from_rfc3339(v["resetAt"].as_str()?).ok()?.timestamp();
    Some(Window {
        limit: v["limit"].as_u64().filter(|&n| n > 0)?,
        remaining: v["remaining"].as_u64()?,
        used: v["used"].as_u64().unwrap_or(0),
        reset_at: reset_at.max(0) as u64,
    })
}

/// Record one response for `host`, charged to `feature`. Returns whether
/// GitHub refused it on a limit, in which case the host's background work
/// pauses until then.
pub fn observe(host: &str, feature: &'static str, bucket: Bucket, o: &Observation) -> Verdict {
    let verdict = {
        let mut map = ledger().lock();
        let l = map.entry(host.to_string()).or_default();
        observe_at(l, feature, bucket, o, now_secs())
    };
    notify();
    verdict
}

fn observe_at(l: &mut HostLedger, feature: &'static str, bucket: Bucket, o: &Observation, now: u64) -> Verdict {
    // The window: GraphQL's own rateLimit object first (it is what this
    // query was charged against), then the headers, which GitHub calls the
    // authoritative source and which every REST answer carries.
    // GitHub's reset times are its clock; the gate compares them to ours.
    let skew = o.headers.map_or(0, |h| clock_skew(h, now));
    let local = |server: u64| server.saturating_add_signed(-skew).min(now + MAX_AHEAD_SECS);
    let from_body = o.graphql_rate.and_then(window_from_graphql).map(|w| (Bucket::Graphql, w));
    let from_headers = o.headers.and_then(window_from_headers);
    if let Some((b, mut w)) = from_body.or(from_headers) {
        w.reset_at = local(w.reset_at);
        l.windows.insert(b, w);
    }

    let reported = o.graphql_rate.and_then(|r| r["cost"].as_u64());
    l.spend.push_back(Spend {
        at: now,
        feature,
        bucket,
        cost: reported.unwrap_or(1).clamp(1, MAX_COST),
        estimated: reported.is_none() && bucket == Bucket::Graphql,
    });
    prune(l, now);

    let remaining_zero = o.headers.and_then(|h| header_u64(h, "x-ratelimit-remaining")) == Some(0);
    let reset = o.headers.and_then(|h| header_u64(h, "x-ratelimit-reset")).map(local)
        .or_else(|| l.windows.get(&bucket).map(|w| w.reset_at))
        .unwrap_or(now + HOUR)
        .min(now + MAX_AHEAD_SECS);
    let retry_after = o.headers.and_then(|h| header_u64(h, "retry-after")).map(|s| s.min(MAX_AHEAD_SECS));
    let graphql_limited = o.graphql_errors
        .and_then(|e| e.as_array())
        .is_some_and(|errs| errs.iter().any(|e| e["type"].as_str() == Some("RATE_LIMITED")));
    // Only a 403/429 body is read, so an ordinary (possibly large) answer is
    // not copied just to look for the phrase.
    let secondary = matches!(o.status, 403 | 429) && o.body.to_lowercase().contains("secondary rate limit");
    let refused = graphql_limited || (matches!(o.status, 403 | 429) && (remaining_zero || retry_after.is_some() || secondary));

    if !refused {
        l.secondary_strikes = 0;
        return Verdict::Ok;
    }
    // The bucket refused: the response's own resource header when it names
    // one, else the bucket the call was made against.
    let refused_bucket = o.headers.and_then(window_from_headers).map(|(b, _)| b).unwrap_or(bucket);
    let primary = remaining_zero || graphql_limited;
    Verdict::Limited { until: refuse_at(l, refused_bucket, secondary, retry_after, primary.then_some(reset), now) }
}

/// Record a refusal and return when `bucket` may be asked again. GitHub's
/// order: retry-after, then the window reset when nothing is left
/// (`primary_reset`), then a minute doubling per repeat. A secondary limit
/// throttles the account as a whole, so it holds both buckets.
fn refuse_at(l: &mut HostLedger, bucket: Bucket, secondary: bool, retry_after: Option<u64>, primary_reset: Option<u64>, now: u64) -> u64 {
    let until = if let Some(s) = retry_after {
        now + s
    } else if let Some(reset) = primary_reset {
        reset.max(now + 1)
    } else {
        let wait = (SECONDARY_BACKOFF_SECS << l.secondary_strikes.min(8)).min(SECONDARY_BACKOFF_MAX_SECS);
        l.secondary_strikes = l.secondary_strikes.saturating_add(1);
        now + wait
    };
    let buckets: &[Bucket] = if secondary {
        &[Bucket::Graphql, Bucket::Core]
    } else {
        std::slice::from_ref(&bucket)
    };
    for b in buckets {
        let cur = l.limited_until.entry(*b).or_insert(0);
        *cur = (*cur).max(until);
    }
    l.limited_until[&bucket]
}

/// Seconds GitHub's clock is ahead of ours, from the `Date` header. Under
/// a few seconds is latency and the header's own 1s resolution, not skew.
fn clock_skew(h: &HashMap<String, String>, now: u64) -> i64 {
    let Some(server) = h.get("date").and_then(|d| chrono::DateTime::parse_from_rfc2822(d.trim()).ok()) else { return 0 };
    let skew = server.timestamp() - now as i64;
    if skew.abs() < 5 { 0 } else { skew.clamp(-(MAX_AHEAD_SECS as i64), MAX_AHEAD_SECS as i64) }
}

/// A legacy `gh` call whose stderr says GitHub refused it on a limit. The
/// CLI does not print the headers, so the wait is the window's reset when
/// the ledger knows it (an hour when not), or the secondary backoff.
/// Returns when termic may ask again.
pub fn record_cli_refusal(host: &str, bucket: Bucket, secondary: bool) -> u64 {
    let until = {
        let mut map = ledger().lock();
        let l = map.entry(host.to_string()).or_default();
        cli_refusal_at(l, bucket, secondary, now_secs())
    };
    notify();
    until
}

fn cli_refusal_at(l: &mut HostLedger, bucket: Bucket, secondary: bool, now: u64) -> u64 {
    let reset = (!secondary).then(|| {
        l.windows.get(&bucket).map(|w| w.reset_at).filter(|&r| r > now).unwrap_or(now + HOUR)
    });
    refuse_at(l, bucket, secondary, None, reset, now)
}

/// When GitHub itself refused `bucket` on `host` and that refusal still
/// stands, the epoch second it lifts. Asked before ANY call, user or not:
/// GitHub's guidance is not to retry while limited, and a refused
/// secondary-limit call only doubles the wait.
pub fn refused_until(host: &str, bucket: Bucket) -> Option<u64> {
    let now = now_secs();
    ledger().lock().get(host)
        .and_then(|l| l.limited_until.get(&bucket).copied())
        .filter(|&u| u > now)
}

/// A legacy CLI call (`gh pr view`, `gh issue list`, ...) that cannot report
/// its cost. Counted as the minimum of 1, marked estimated.
pub fn record_estimated(host: &str, feature: &'static str, bucket: Bucket) {
    {
        let mut map = ledger().lock();
        let l = map.entry(host.to_string()).or_default();
        let now = now_secs();
        l.spend.push_back(Spend { at: now, feature, bucket, cost: 1, estimated: true });
        prune(l, now);
    }
    notify();
}

/// `GET /rate_limit`'s `resources`, which does not count against the
/// primary limit. Seeds the windows before termic has made any call.
pub fn record_rate_limit_resources(host: &str, v: &serde_json::Value) {
    {
        let mut map = ledger().lock();
        let l = map.entry(host.to_string()).or_default();
        for (name, b) in [("graphql", Bucket::Graphql), ("core", Bucket::Core)] {
            let r = &v["resources"][name];
            if let (Some(limit), Some(remaining), Some(reset_at)) =
                (r["limit"].as_u64().filter(|&n| n > 0), r["remaining"].as_u64(), r["reset"].as_u64())
            {
                let reset_at = reset_at.min(now_secs() + MAX_AHEAD_SECS);
                l.windows.insert(b, Window { limit, remaining, used: r["used"].as_u64().unwrap_or(0), reset_at });
            }
        }
    }
    notify();
}

/// Whether the ledger has a current window for `host` (one whose reset is
/// still ahead), so the launch probe can skip hosts it already knows.
pub fn has_fresh_window(host: &str) -> bool {
    let now = now_secs();
    ledger().lock().get(host)
        .is_some_and(|l| l.windows.values().any(|w| w.reset_at > now))
}

fn prune(l: &mut HostLedger, now: u64) {
    while l.spend.front().is_some_and(|s| s.at + HOUR <= now) {
        l.spend.pop_front();
    }
}

// ───────────────────────── the gate ─────────────────────────

/// Why background work is paused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Pause {
    /// Epoch seconds.
    pub until: u64,
    /// "limited" (GitHub refused), "floor" (the account is low), or
    /// "budget" (termic spent its share). The UI words it (i18n).
    pub kind: &'static str,
}

/// May background work spend from `bucket` on `host` right now? A user
/// action does not ask. Unknown host: yes, with the documented defaults.
pub fn background_gate(host: &str, bucket: Bucket) -> Result<(), Pause> {
    let mut map = ledger().lock();
    // A host with no row has spent nothing and been refused nothing. Not
    // inserted: asking about a host must not make it a row in Settings.
    match map.get_mut(host).and_then(|l| gate_at(l, bucket, now_secs())) {
        Some(p) => Err(p),
        None => Ok(()),
    }
}

fn gate_at(l: &mut HostLedger, bucket: Bucket, now: u64) -> Option<Pause> {
    prune(l, now);
    if let Some(&until) = l.limited_until.get(&bucket).filter(|&&u| u > now) {
        return Some(Pause { until, kind: "limited" });
    }
    let window = l.windows.get(&bucket).filter(|w| w.reset_at > now).copied();
    let limit = window.map(|w| w.limit).unwrap_or(bucket.default_limit());
    if let Some(w) = window {
        if (w.remaining as f64) < FLOOR * w.limit as f64 {
            return Some(Pause { until: w.reset_at, kind: "floor" });
        }
    }
    let cap = bucket.cap(limit);
    let spent: u64 = l.spend.iter().filter(|s| s.bucket == bucket).map(|s| s.cost).sum();
    if spent >= cap {
        // Free again once enough of the oldest spend ages out of the hour.
        let mut over = spent + 1 - cap;
        let mut until = now + 1;
        for s in l.spend.iter().filter(|s| s.bucket == bucket) {
            until = s.at + HOUR;
            if s.cost >= over {
                break;
            }
            over -= s.cost;
        }
        return Some(Pause { until, kind: "budget" });
    }
    None
}

// ───────────────────────── status ─────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FeatureSpend {
    pub feature: String,
    pub cost: u64,
    pub estimated: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BucketStatus {
    pub bucket: Bucket,
    /// GitHub's window, None when unknown or already reset.
    pub window: Option<Window>,
    /// Termic's spend in the last hour, and how much of it is estimated.
    pub spent: u64,
    pub estimated: u64,
    pub cap: u64,
    pub by_feature: Vec<FeatureSpend>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RateStatus {
    pub host: String,
    pub buckets: Vec<BucketStatus>,
    /// Background work on this host is paused, and why. GraphQL gate, since
    /// that is the bucket every background job spends.
    pub paused: Option<Pause>,
}

pub fn status() -> Vec<RateStatus> {
    let now = now_secs();
    let mut map = ledger().lock();
    let mut out: Vec<RateStatus> = map.iter_mut().map(|(host, l)| status_of(host, l, now)).collect();
    out.sort_by(|a, b| a.host.cmp(&b.host));
    out
}

fn status_of(host: &str, l: &mut HostLedger, now: u64) -> RateStatus {
    prune(l, now);
    let buckets = [Bucket::Graphql, Bucket::Core].into_iter().map(|b| {
        let window = l.windows.get(&b).filter(|w| w.reset_at > now).copied();
        let mut by: Vec<FeatureSpend> = Vec::new();
        for s in l.spend.iter().filter(|s| s.bucket == b) {
            let i = match by.iter().position(|f| f.feature == s.feature) {
                Some(i) => i,
                None => {
                    by.push(FeatureSpend { feature: s.feature.to_string(), cost: 0, estimated: 0 });
                    by.len() - 1
                }
            };
            by[i].cost += s.cost;
            if s.estimated {
                by[i].estimated += s.cost;
            }
        }
        by.sort_by(|a, b| b.cost.cmp(&a.cost).then(a.feature.cmp(&b.feature)));
        BucketStatus {
            bucket: b,
            window,
            spent: by.iter().map(|f| f.cost).sum(),
            estimated: by.iter().map(|f| f.estimated).sum(),
            cap: b.cap(window.map(|w| w.limit).unwrap_or(b.default_limit())),
            by_feature: by,
        }
    }).collect();
    RateStatus { host: host.to_string(), buckets, paused: gate_at(l, Bucket::Graphql, now) }
}

/// Tell the listener. Throttled to one call per 2s, except when any host's
/// pause starts, ends or moves, which always goes out: a budget or floor
/// pause starts on an ordinary answer, and if the throttle swallowed that
/// one, background work would stop on the Rust side and nothing would be
/// left to announce it. Spend-only changes the throttle drops are picked up
/// by the next call or by the Settings row, which asks while it is open.
///
/// `LAST` is held from the snapshot to the emit, so two threads cannot
/// emit out of order (an older unpaused snapshot landing after a newer
/// paused one would hide the pill while Rust holds work). Lock order is
/// LAST, then the ledger (released inside `status`), then the listener;
/// nothing takes them the other way round.
fn notify() {
    static LAST: Mutex<(u64, Vec<(String, Option<u64>)>)> = Mutex::new((0, Vec::new()));
    let mut last = LAST.lock();
    let now = now_secs();
    let s = status();
    let pauses = pause_key(&s);
    if !should_emit(now, &last, &pauses) {
        return;
    }
    *last = (now, pauses);
    if let Some(f) = listener().lock().as_ref() {
        f(s);
    }
}

/// The throttle: once per 2s, or at once when a pause starts, ends or moves.
fn should_emit(now: u64, last: &(u64, Vec<(String, Option<u64>)>), pauses: &[(String, Option<u64>)]) -> bool {
    now >= last.0 + 2 || pauses != last.1.as_slice()
}

/// Each host's pause end, the part of a status the throttle must not drop.
fn pause_key(s: &[RateStatus]) -> Vec<(String, Option<u64>)> {
    s.iter().map(|h| (h.host.clone(), h.paused.as_ref().map(|p| p.until))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn graphql_rate(cost: u64, remaining: u64) -> serde_json::Value {
        serde_json::json!({ "cost": cost, "limit": 5000, "remaining": remaining, "used": 5000 - remaining,
            "resetAt": "2030-01-01T00:00:00Z" })
    }

    const NOW: u64 = 1_800_000_000;

    #[test]
    fn graphql_cost_and_window_come_from_the_rate_limit_object() {
        let mut l = HostLedger::default();
        let rate = graphql_rate(3, 4900);
        let v = observe_at(&mut l, "pr_status", Bucket::Graphql,
            &Observation { status: 200, graphql_rate: Some(&rate), ..Default::default() }, NOW);
        assert_eq!(v, Verdict::Ok);
        assert_eq!(l.windows[&Bucket::Graphql].remaining, 4900);
        let s = status_of("github.com", &mut l, NOW);
        assert_eq!(s.buckets[0].spent, 3);
        assert_eq!(s.buckets[0].estimated, 0);
        assert_eq!(s.buckets[0].by_feature[0].feature, "pr_status");
    }

    #[test]
    fn rest_headers_set_the_core_window() {
        let mut l = HostLedger::default();
        let h = headers(&[("x-ratelimit-resource", "core"), ("x-ratelimit-limit", "5000"),
            ("x-ratelimit-remaining", "4999"), ("x-ratelimit-used", "1"), ("x-ratelimit-reset", "1800003600")]);
        observe_at(&mut l, "comments", Bucket::Core, &Observation { status: 200, headers: Some(&h), ..Default::default() }, NOW);
        assert_eq!(l.windows[&Bucket::Core].remaining, 4999);
        assert_eq!(status_of("h", &mut l, NOW).buckets[1].spent, 1);
    }

    #[test]
    fn a_zero_limit_is_no_window_not_a_permanent_pause() {
        let mut l = HostLedger::default();
        let h = headers(&[("x-ratelimit-resource", "graphql"), ("x-ratelimit-limit", "0"),
            ("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", "1800003600")]);
        observe_at(&mut l, "pr_status", Bucket::Graphql, &Observation { status: 200, headers: Some(&h), ..Default::default() }, NOW);
        assert!(l.windows.is_empty());
        let body = serde_json::json!({ "cost": 1, "limit": 0, "remaining": 0, "used": 0, "resetAt": "2027-01-15T08:00:00Z" });
        observe_at(&mut l, "pr_status", Bucket::Graphql, &Observation { status: 200, graphql_rate: Some(&body), ..Default::default() }, NOW);
        assert!(l.windows.is_empty());
        assert_eq!(gate_at(&mut l, Bucket::Graphql, NOW), None);
    }

    #[test]
    fn a_reset_is_moved_into_our_clock_by_the_date_header() {
        let mut l = HostLedger::default();
        // GitHub's clock is 10 minutes ahead of ours.
        let server_now = chrono::DateTime::from_timestamp((NOW + 600) as i64, 0).unwrap().to_rfc2822();
        let h = headers(&[("x-ratelimit-resource", "graphql"), ("x-ratelimit-limit", "5000"),
            ("x-ratelimit-remaining", "10"), ("x-ratelimit-reset", &(NOW + 600 + 1800).to_string()), ("date", &server_now)]);
        observe_at(&mut l, "pr_status", Bucket::Graphql, &Observation { status: 200, headers: Some(&h), ..Default::default() }, NOW);
        assert_eq!(l.windows[&Bucket::Graphql].reset_at, NOW + 1800);
        // A couple of seconds is latency, not skew.
        let near = chrono::DateTime::from_timestamp((NOW + 2) as i64, 0).unwrap().to_rfc2822();
        assert_eq!(clock_skew(&headers(&[("date", &near)]), NOW), 0);
    }

    #[test]
    fn a_cli_refusal_holds_until_the_known_reset_or_backs_off() {
        let mut l = HostLedger::default();
        // No window known: an hour.
        assert_eq!(cli_refusal_at(&mut l, Bucket::Graphql, false, NOW), NOW + 3600);
        let mut l = HostLedger::default();
        l.windows.insert(Bucket::Graphql, Window { limit: 5000, remaining: 0, used: 5000, reset_at: NOW + 900 });
        assert_eq!(cli_refusal_at(&mut l, Bucket::Graphql, false, NOW), NOW + 900);
        assert!(l.limited_until.get(&Bucket::Core).is_none());
        // Secondary: the doubling backoff, on both buckets.
        let mut l = HostLedger::default();
        assert_eq!(cli_refusal_at(&mut l, Bucket::Graphql, true, NOW), NOW + 60);
        assert_eq!(cli_refusal_at(&mut l, Bucket::Graphql, true, NOW), NOW + 120);
        assert_eq!(l.limited_until[&Bucket::Core], NOW + 120);
    }

    #[test]
    fn a_graphql_limit_arrives_as_200_and_pauses_until_reset() {
        let mut l = HostLedger::default();
        let h = headers(&[("x-ratelimit-resource", "graphql"), ("x-ratelimit-limit", "5000"),
            ("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", "1800000900")]);
        let errs = serde_json::json!([{ "type": "RATE_LIMITED", "message": "API rate limit exceeded" }]);
        let v = observe_at(&mut l, "todos", Bucket::Graphql,
            &Observation { status: 200, headers: Some(&h), graphql_errors: Some(&errs), ..Default::default() }, NOW);
        assert_eq!(v, Verdict::Limited { until: 1_800_000_900 });
        assert_eq!(gate_at(&mut l, Bucket::Graphql, NOW).unwrap().kind, "limited");
        // Past the reset the pause lifts by itself.
        assert!(gate_at(&mut l, Bucket::Graphql, 1_800_000_901).is_none());
    }

    #[test]
    fn retry_after_wins_and_secondary_limits_back_off_doubling() {
        let mut l = HostLedger::default();
        let h = headers(&[("retry-after", "30")]);
        let v = observe_at(&mut l, "x", Bucket::Graphql, &Observation { status: 403, headers: Some(&h), ..Default::default() }, NOW);
        assert_eq!(v, Verdict::Limited { until: NOW + 30 });

        let mut l = HostLedger::default();
        let body = "You have exceeded a secondary rate limit";
        let o = Observation { status: 403, body, ..Default::default() };
        assert_eq!(observe_at(&mut l, "x", Bucket::Graphql, &o, NOW), Verdict::Limited { until: NOW + 60 });
        assert_eq!(observe_at(&mut l, "x", Bucket::Graphql, &o, NOW), Verdict::Limited { until: NOW + 120 });
        // A good answer resets the strikes.
        observe_at(&mut l, "x", Bucket::Graphql, &Observation { status: 200, ..Default::default() }, NOW);
        assert_eq!(l.secondary_strikes, 0);
    }

    #[test]
    fn a_host_cannot_push_a_pause_or_a_reset_past_a_day() {
        let mut l = HostLedger::default();
        let h = headers(&[("retry-after", &u64::MAX.to_string())]);
        let v = observe_at(&mut l, "x", Bucket::Graphql, &Observation { status: 429, headers: Some(&h), ..Default::default() }, NOW);
        assert_eq!(v, Verdict::Limited { until: NOW + MAX_AHEAD_SECS });

        let mut l = HostLedger::default();
        let h = headers(&[("x-ratelimit-resource", "graphql"), ("x-ratelimit-limit", "5000"),
            ("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", &u64::MAX.to_string())]);
        observe_at(&mut l, "x", Bucket::Graphql, &Observation { status: 403, headers: Some(&h), ..Default::default() }, NOW);
        assert_eq!(l.windows[&Bucket::Graphql].reset_at, NOW + MAX_AHEAD_SECS);
        assert_eq!(l.limited_until[&Bucket::Graphql], NOW + MAX_AHEAD_SECS);
    }

    #[test]
    fn a_huge_reported_cost_is_clamped_not_summed_into_an_overflow() {
        let mut l = HostLedger::default();
        let rate = serde_json::json!({ "cost": u64::MAX, "limit": 5000, "remaining": 10, "resetAt": "2027-01-15T08:00:00Z" });
        for _ in 0..3 {
            observe_at(&mut l, "x", Bucket::Graphql, &Observation { status: 200, graphql_rate: Some(&rate), ..Default::default() }, NOW);
        }
        assert_eq!(status_of("h", &mut l, NOW).buckets[0].spent, 3 * MAX_COST);
        assert!(gate_at(&mut l, Bucket::Graphql, NOW).is_some());
    }

    #[test]
    fn asking_the_gate_about_a_host_adds_no_row() {
        let host = "gate-probe.ghe.acme.com";
        assert!(background_gate(host, Bucket::Graphql).is_ok());
        assert!(status().iter().all(|s| s.host != host));
    }

    #[test]
    fn the_pause_key_moves_with_a_pause_but_not_with_spend() {
        let mut l = HostLedger::default();
        let quiet = vec![status_of("h", &mut l, NOW)];
        observe_at(&mut l, "x", Bucket::Graphql, &Observation { status: 200, ..Default::default() }, NOW);
        assert_eq!(pause_key(&quiet), pause_key(&[status_of("h", &mut l, NOW)]));
        let h = headers(&[("retry-after", "30")]);
        observe_at(&mut l, "x", Bucket::Graphql, &Observation { status: 403, headers: Some(&h), ..Default::default() }, NOW);
        assert_ne!(pause_key(&quiet), pause_key(&[status_of("h", &mut l, NOW)]));
    }

    #[test]
    fn a_core_limit_does_not_pause_graphql_but_a_secondary_limit_pauses_both() {
        let mut l = HostLedger::default();
        let h = headers(&[("x-ratelimit-resource", "core"), ("x-ratelimit-limit", "5000"),
            ("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", "1800000900")]);
        let v = observe_at(&mut l, "comments", Bucket::Core, &Observation { status: 403, headers: Some(&h), ..Default::default() }, NOW);
        assert_eq!(v, Verdict::Limited { until: 1_800_000_900 });
        assert!(gate_at(&mut l, Bucket::Graphql, NOW).is_none());
        assert_eq!(gate_at(&mut l, Bucket::Core, NOW).unwrap().kind, "limited");

        let mut l = HostLedger::default();
        let o = Observation { status: 403, body: "You have exceeded a secondary rate limit", ..Default::default() };
        observe_at(&mut l, "comments", Bucket::Core, &o, NOW);
        assert_eq!(gate_at(&mut l, Bucket::Graphql, NOW).unwrap().kind, "limited");
        assert_eq!(gate_at(&mut l, Bucket::Core, NOW).unwrap().kind, "limited");
    }

    #[test]
    fn refused_until_reports_only_a_standing_refusal() {
        let host = "refused.ghe.acme.com";
        assert_eq!(refused_until(host, Bucket::Graphql), None);
        let h = headers(&[("retry-after", "60")]);
        observe(host, "x", Bucket::Graphql, &Observation { status: 429, headers: Some(&h), ..Default::default() });
        assert!(refused_until(host, Bucket::Graphql).is_some_and(|u| u > now_secs()));
        assert_eq!(refused_until(host, Bucket::Core), None);
        // A budget pause is termic's own policy, not a refusal.
        let mut l = HostLedger::default();
        for i in 0..10 {
            l.spend.push_back(Spend { at: NOW + i, feature: "x", bucket: Bucket::Graphql, cost: 100, estimated: false });
        }
        assert_eq!(gate_at(&mut l, Bucket::Graphql, NOW + 10).unwrap().kind, "budget");
        assert!(l.limited_until.is_empty());
    }

    #[test]
    fn the_throttle_drops_spend_but_never_a_pause_change() {
        let quiet = vec![("h".to_string(), None)];
        let paused = vec![("h".to_string(), Some(NOW + 60))];
        let last = (NOW, quiet.clone());
        assert!(!should_emit(NOW + 1, &last, &quiet));
        assert!(should_emit(NOW + 2, &last, &quiet));
        assert!(should_emit(NOW + 1, &last, &paused));
        // A pause that lifts is a change too.
        assert!(should_emit(NOW + 1, &(NOW, paused), &quiet));
    }

    #[test]
    fn a_plain_403_is_not_a_limit() {
        let mut l = HostLedger::default();
        let o = Observation { status: 403, body: "Resource not accessible by integration", ..Default::default() };
        assert_eq!(observe_at(&mut l, "x", Bucket::Graphql, &o, NOW), Verdict::Ok);
    }

    #[test]
    fn the_gate_closes_under_the_account_floor() {
        let mut l = HostLedger::default();
        let rate = graphql_rate(1, 700); // 14% left
        observe_at(&mut l, "x", Bucket::Graphql, &Observation { status: 200, graphql_rate: Some(&rate), ..Default::default() }, NOW);
        assert_eq!(gate_at(&mut l, Bucket::Graphql, NOW).unwrap().kind, "floor");
    }

    #[test]
    fn the_gate_closes_at_termics_share_and_reopens_as_spend_ages_out() {
        let mut l = HostLedger::default();
        // Cap is 20% of the default 5000 = 1000.
        for i in 0..10 {
            l.spend.push_back(Spend { at: NOW + i, feature: "x", bucket: Bucket::Graphql, cost: 100, estimated: false });
        }
        let p = gate_at(&mut l, Bucket::Graphql, NOW + 10).unwrap();
        assert_eq!(p.kind, "budget");
        // One 100-point entry has to age out to get back under the cap.
        assert_eq!(p.until, NOW + HOUR);
        assert!(gate_at(&mut l, Bucket::Graphql, NOW + HOUR).is_none());
    }

    #[test]
    fn estimated_spend_is_labelled_and_old_spend_drops_off() {
        let mut l = HostLedger::default();
        l.spend.push_back(Spend { at: NOW - HOUR, feature: "old", bucket: Bucket::Graphql, cost: 5, estimated: false });
        l.spend.push_back(Spend { at: NOW, feature: "todos", bucket: Bucket::Graphql, cost: 1, estimated: true });
        let s = status_of("h", &mut l, NOW);
        assert_eq!(s.buckets[0].spent, 1);
        assert_eq!(s.buckets[0].estimated, 1);
    }

    #[test]
    fn rate_limit_endpoint_seeds_both_windows() {
        let reset = now_secs() + 3600;
        let v = serde_json::json!({ "resources": {
            "core": { "limit": 5000, "remaining": 4000, "used": 1000, "reset": reset },
            "graphql": { "limit": 5000, "remaining": 4500, "used": 500, "reset": reset },
            "search": { "limit": 30, "remaining": 30, "used": 0, "reset": reset },
        }});
        assert!(!has_fresh_window("ghe.acme.com"));
        record_rate_limit_resources("ghe.acme.com", &v);
        assert!(has_fresh_window("ghe.acme.com"));
        let s = status().into_iter().find(|s| s.host == "ghe.acme.com").unwrap();
        let remaining: Vec<_> = s.buckets.iter().map(|b| b.window.map(|w| w.remaining)).collect();
        assert_eq!(remaining, vec![Some(4500), Some(4000)]);
        assert!(s.paused.is_none());
    }
}
