//! LAN discovery for paired Termic instances: a hand-rolled subset of
//! mDNS / DNS-SD (RFC 6762 / 6763), IPv4 only, for one service type,
//! `_termic._tcp.local`.
//!
//! Why hand-rolled: the subset we need is one PTR question and one answer
//! set, spoken between copies of this same file. `mdns-sd` would bring a
//! dependency tree (flume, if-addrs, mio) for machinery we never use, and
//! socket2 is already linked. Anything else that speaks DNS-SD still sees
//! us (`dns-sd -B _termic._tcp` on a Mac), because the records are the
//! standard PTR / SRV / TXT / A set.
//!
//! Shape of what we advertise:
//!   PTR  _termic._tcp.local          -> termic-<id12>._termic._tcp.local
//!   SRV  termic-<id12>._termic._tcp  -> port, termic-<id12>.local
//!   TXT  termic-<id12>._termic._tcp  -> id= name= ver= proto= pv= [pair=1]
//!   A    termic-<id12>.local         -> each interface address
//! The instance label is derived from the instance id, so it is unique by
//! construction and the name-conflict probing of RFC 6762 section 8 is not
//! needed. The friendly name rides in TXT, where it may be any UTF-8.
//!
//! A peer's address is the SOURCE address of the packet we heard it in,
//! not its A record: a multi-homed machine is then reached on the
//! interface that actually carries traffic between the two of us.
//!
//! Threading: one thread, blocked in recv_from with a read timeout equal
//! to the time until its next scheduled action (second announce, the 60s
//! re-query, the next expiry). No sleep-poll (docs/performance.md bear
//! trap 9). Sends from other threads go straight out on the shared
//! socket, so update_advert / query_now never need to wake it; stop sends
//! the goodbye, whose multicast loopback is what wakes it to exit.
//!
//! Everything in the parser runs on unauthenticated network input:
//! bounds-checked throughout, compression pointers capped at 16 jumps,
//! packets capped at 9000 bytes, and never a panic.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
const PORT: u16 = 5353;
const SERVICE: &str = "_termic._tcp.local";
/// DNS-SD service enumeration (RFC 6763 section 9): browsers that list
/// every service type ask this, and answering it is what makes us show up
/// in generic tooling.
const META: &str = "_services._dns-sd._udp.local";

const T_A: u16 = 1;
const T_PTR: u16 = 12;
const T_TXT: u16 = 16;
const T_SRV: u16 = 33;
const T_ANY: u16 = 255;
const CLASS_IN: u16 = 1;
/// The cache-flush bit (RFC 6762 10.2): set on records unique to us.
const CACHE_FLUSH: u16 = 0x8000;

/// Largest packet we read or parse. mDNS allows up to 9000 on jumbo
/// frames; anything past that is not something we sent.
const MAX_PACKET: usize = 9000;
const MAX_JUMPS: usize = 16;
const MAX_NAME: usize = 255;
/// Records we look at per packet, so a crafted header count cannot make us
/// walk forever (the walk is bounded by the buffer anyway; this bounds work).
const MAX_RECORDS: usize = 256;
/// TXT `name=` value cap, in bytes.
const NAME_MAX: usize = 63;

/// How long our records say they are valid. Peers re-query every minute
/// and expire us after three, so this only matters to other DNS-SD tools.
const TTL: u32 = 120;
const REQUERY_EVERY: Duration = Duration::from_secs(60);
const EXPIRE_AFTER: Duration = Duration::from_secs(180);
const SECOND_ANNOUNCE: Duration = Duration::from_secs(1);
const RESPONSE_MIN_GAP: Duration = Duration::from_millis(500);

/// What this instance tells the network about itself.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Advert {
    pub id: String,
    pub name: String,
    pub version: String,
    pub proto: u32,
    pub pv: u32,
    pub port: u16,
    /// In pairing mode: showing a code, ready for another machine to pair.
    /// TXT `pair=1`, absent otherwise.
    pub pairing: bool,
}

/// Another instance, as last heard.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Sighting {
    pub id: String,
    pub name: String,
    pub version: String,
    pub proto: u32,
    pub pv: u32,
    pub addr: IpAddr,
    pub port: u16,
    pub seen: Instant,
    pub pairing: bool,
}

// ───────────────────────────── wire format ───────────────────────────

/// `termic-<first 12 hex of id>`, restricted to what a DNS label may hold.
fn instance_label(id: &str) -> String {
    let clean: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .take(12)
        .collect();
    format!("termic-{clean}")
}

/// Cut at `max` bytes without splitting a character.
fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn push_name(out: &mut Vec<u8>, name: &str) {
    for label in name.split('.').filter(|l| !l.is_empty()) {
        let bytes = truncate_utf8(label, 63).as_bytes();
        out.push(bytes.len() as u8);
        out.extend_from_slice(bytes);
    }
    out.push(0);
}

fn push_record(out: &mut Vec<u8>, name: &str, rtype: u16, class: u16, ttl: u32, rdata: &[u8]) {
    push_name(out, name);
    out.extend_from_slice(&rtype.to_be_bytes());
    out.extend_from_slice(&class.to_be_bytes());
    out.extend_from_slice(&ttl.to_be_bytes());
    out.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
    out.extend_from_slice(rdata);
}

fn header(flags: u16, qd: u16, an: u16) -> Vec<u8> {
    let mut h = Vec::with_capacity(512);
    h.extend_from_slice(&0u16.to_be_bytes()); // id: always 0 in mDNS
    h.extend_from_slice(&flags.to_be_bytes());
    h.extend_from_slice(&qd.to_be_bytes());
    h.extend_from_slice(&an.to_be_bytes());
    h.extend_from_slice(&0u16.to_be_bytes());
    h.extend_from_slice(&0u16.to_be_bytes());
    h
}

/// A PTR question for our service type, multicast-answered (QU bit clear:
/// a unicast reply would reach only one of the sockets sharing 5353).
pub(crate) fn encode_query() -> Vec<u8> {
    let mut out = header(0, 1, 0);
    push_name(&mut out, SERVICE);
    out.extend_from_slice(&T_PTR.to_be_bytes());
    out.extend_from_slice(&CLASS_IN.to_be_bytes());
    out
}

/// Our full answer set. `ttl` 0 is the goodbye.
pub(crate) fn encode_response(advert: &Advert, ips: &[Ipv4Addr], ttl: u32) -> Vec<u8> {
    encode_response_with(advert, ips, ttl, false)
}

fn encode_response_with(advert: &Advert, ips: &[Ipv4Addr], ttl: u32, with_meta: bool) -> Vec<u8> {
    let label = instance_label(&advert.id);
    let instance = format!("{label}.{SERVICE}");
    let host = format!("{label}.local");

    let mut body = Vec::with_capacity(512);
    let mut count: u16 = 0;

    if with_meta {
        let mut rd = Vec::new();
        push_name(&mut rd, SERVICE);
        push_record(&mut body, META, T_PTR, CLASS_IN, ttl, &rd);
        count += 1;
    }

    let mut rd = Vec::new();
    push_name(&mut rd, &instance);
    push_record(&mut body, SERVICE, T_PTR, CLASS_IN, ttl, &rd);
    count += 1;

    let mut rd = Vec::new();
    rd.extend_from_slice(&0u16.to_be_bytes()); // priority
    rd.extend_from_slice(&0u16.to_be_bytes()); // weight
    rd.extend_from_slice(&advert.port.to_be_bytes());
    push_name(&mut rd, &host);
    push_record(&mut body, &instance, T_SRV, CLASS_IN | CACHE_FLUSH, ttl, &rd);
    count += 1;

    let mut rd = Vec::new();
    let entries = [
        format!("id={}", truncate_utf8(&advert.id, 64)),
        format!("name={}", truncate_utf8(&advert.name, NAME_MAX)),
        format!("ver={}", truncate_utf8(&advert.version, 32)),
        format!("proto={}", advert.proto),
        format!("pv={}", advert.pv),
    ];
    let pairing = advert.pairing.then(|| "pair=1".to_string());
    for e in entries.iter().chain(pairing.iter()) {
        rd.push(e.len() as u8);
        rd.extend_from_slice(e.as_bytes());
    }
    push_record(&mut body, &instance, T_TXT, CLASS_IN | CACHE_FLUSH, ttl, &rd);
    count += 1;

    for ip in ips {
        push_record(&mut body, &host, T_A, CLASS_IN | CACHE_FLUSH, ttl, &ip.octets());
        count += 1;
    }

    let mut out = header(0x8400, 0, count); // QR + AA
    out.extend_from_slice(&body);
    out
}

/// What one packet told us.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Parsed {
    pub is_response: bool,
    /// A query we should answer: PTR or ANY for our service, or the
    /// DNS-SD enumeration name.
    pub questions_for_us: bool,
    /// The enumeration question specifically, so the answer carries the
    /// META -> SERVICE pointer.
    pub meta_question: bool,
    /// Complete adverts (PTR + SRV + TXT with an id), with the PTR's TTL.
    pub adverts: Vec<(Advert, u32)>,
}

fn u16_at(b: &[u8], p: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(p)?, *b.get(p + 1)?]))
}

fn u32_at(b: &[u8], p: usize) -> Option<u32> {
    Some(u32::from_be_bytes([*b.get(p)?, *b.get(p + 1)?, *b.get(p + 2)?, *b.get(p + 3)?]))
}

/// A possibly-compressed name at `pos`; returns it and the offset just
/// past it in the ORIGINAL stream (not past any pointer target).
fn read_name(buf: &[u8], pos: usize) -> Option<(String, usize)> {
    let mut out = String::new();
    let mut p = pos;
    let mut jumps = 0;
    let mut end = None;
    loop {
        let len = *buf.get(p)?;
        if len & 0xC0 == 0xC0 {
            let lo = *buf.get(p + 1)?;
            if end.is_none() {
                end = Some(p + 2);
            }
            jumps += 1;
            if jumps > MAX_JUMPS {
                return None;
            }
            p = (((len & 0x3F) as usize) << 8) | lo as usize;
            continue;
        }
        // 0x40 / 0x80 are reserved label types.
        if len & 0xC0 != 0 {
            return None;
        }
        if len == 0 {
            if end.is_none() {
                end = Some(p + 1);
            }
            break;
        }
        let l = len as usize;
        let label = buf.get(p + 1..p + 1 + l)?;
        if !out.is_empty() {
            out.push('.');
        }
        out.push_str(&String::from_utf8_lossy(label));
        if out.len() > MAX_NAME {
            return None;
        }
        p += 1 + l;
    }
    Some((out, end?))
}

fn name_eq(a: &str, b: &str) -> bool {
    a.trim_end_matches('.').eq_ignore_ascii_case(b.trim_end_matches('.'))
}

fn parse_txt(rd: &[u8]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut p = 0;
    while p < rd.len() {
        let l = rd[p] as usize;
        let Some(s) = rd.get(p + 1..p + 1 + l) else { break };
        let s = String::from_utf8_lossy(s);
        if let Some((k, v)) = s.split_once('=') {
            out.insert(k.to_ascii_lowercase(), v.to_string());
        }
        p += 1 + l;
    }
    out
}

/// Parse one datagram. Malformed input yields an empty `Parsed`, never a
/// panic: this is the first thing any host on the network reaches.
pub(crate) fn parse_packet(buf: &[u8]) -> Parsed {
    parse_inner(buf).unwrap_or_default()
}

fn parse_inner(buf: &[u8]) -> Option<Parsed> {
    if buf.len() > MAX_PACKET || buf.len() < 12 {
        return None;
    }
    let flags = u16_at(buf, 2)?;
    let qd = u16_at(buf, 4)? as usize;
    let an = u16_at(buf, 6)? as usize;
    let ns = u16_at(buf, 8)? as usize;
    let ar = u16_at(buf, 10)? as usize;
    let mut parsed = Parsed { is_response: flags & 0x8000 != 0, ..Default::default() };
    let mut p = 12;

    for _ in 0..qd.min(MAX_RECORDS) {
        let (name, next) = read_name(buf, p)?;
        let qtype = u16_at(buf, next)?;
        p = next + 4;
        if !parsed.is_response && (qtype == T_PTR || qtype == T_ANY) {
            if name_eq(&name, SERVICE) {
                parsed.questions_for_us = true;
            } else if name_eq(&name, META) {
                parsed.questions_for_us = true;
                parsed.meta_question = true;
            }
        }
    }

    // Records keyed by lowercased owner name. Collected first, joined
    // after: the order of PTR / SRV / TXT inside a packet is not fixed.
    let mut ptrs: Vec<(String, u32)> = Vec::new();
    let mut srvs: HashMap<String, u16> = HashMap::new();
    let mut txts: HashMap<String, HashMap<String, String>> = HashMap::new();
    let total = (an + ns + ar).min(MAX_RECORDS);
    for _ in 0..total {
        let Some((name, next)) = read_name(buf, p) else { break };
        let (Some(rtype), Some(ttl), Some(rdlen)) =
            (u16_at(buf, next), u32_at(buf, next + 4), u16_at(buf, next + 8))
        else {
            break;
        };
        let rstart = next + 10;
        let rend = rstart + rdlen as usize;
        let Some(rd) = buf.get(rstart..rend) else { break };
        match rtype {
            T_PTR if name_eq(&name, SERVICE) => {
                if let Some((target, _)) = read_name(buf, rstart) {
                    ptrs.push((target.to_ascii_lowercase(), ttl));
                }
            }
            T_SRV => {
                if let Some(port) = u16_at(rd, 4) {
                    srvs.insert(name.to_ascii_lowercase(), port);
                }
            }
            T_TXT => {
                txts.insert(name.to_ascii_lowercase(), parse_txt(rd));
            }
            _ => {}
        }
        p = rend;
    }

    if parsed.is_response {
        for (instance, ttl) in ptrs {
            let (Some(port), Some(txt)) = (srvs.get(&instance), txts.get(&instance)) else {
                continue;
            };
            let Some(id) = txt.get("id").filter(|i| !i.is_empty() && i.len() <= 64) else {
                continue;
            };
            let num = |k: &str| txt.get(k).and_then(|v| v.parse().ok()).unwrap_or(0);
            parsed.adverts.push((
                Advert {
                    id: id.clone(),
                    name: truncate_utf8(txt.get("name").map(String::as_str).unwrap_or(""), NAME_MAX)
                        .to_string(),
                    version: truncate_utf8(txt.get("ver").map(String::as_str).unwrap_or(""), 32)
                        .to_string(),
                    proto: num("proto"),
                    pv: num("pv"),
                    port: *port,
                    pairing: txt.get("pair").is_some_and(|v| v == "1"),
                },
                ttl,
            ));
        }
    }
    Some(parsed)
}

// ───────────────────────────── interfaces ────────────────────────────

/// Every up, multicast-capable, non-loopback IPv4 address. Empty when the
/// platform will not say, in which case the caller falls back to the
/// default interface.
#[cfg(unix)]
fn interface_addrs() -> Vec<Ipv4Addr> {
    let mut out = Vec::new();
    // SAFETY: getifaddrs hands back a linked list we only read, then free
    // exactly once with freeifaddrs.
    unsafe {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut head) != 0 {
            return out;
        }
        let mut cur = head;
        while !cur.is_null() {
            let ifa = &*cur;
            cur = ifa.ifa_next;
            if ifa.ifa_addr.is_null() || (*ifa.ifa_addr).sa_family as i32 != libc::AF_INET {
                continue;
            }
            let f = ifa.ifa_flags;
            if f & libc::IFF_UP as u32 == 0
                || f & libc::IFF_MULTICAST as u32 == 0
                || f & libc::IFF_LOOPBACK as u32 != 0
            {
                continue;
            }
            let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
            let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
            if !ip.is_loopback() && !ip.is_unspecified() && !out.contains(&ip) {
                out.push(ip);
            }
        }
        libc::freeifaddrs(head);
    }
    out
}

#[cfg(windows)]
fn interface_addrs() -> Vec<Ipv4Addr> {
    windows_addrs(true)
}

/// Every up, non-loopback IPv4 address. `multicast_only` is discovery's
/// filter; the phone's reachable list passes false, because a VPN adapter
/// (Tailscale's) has no multicast and is exactly the away-from-home path.
#[cfg(windows)]
fn windows_addrs(multicast_only: bool) -> Vec<Ipv4Addr> {
    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH,
        IP_ADAPTER_NO_MULTICAST,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

    let mut out = Vec::new();
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    // The documented pattern: start at 15 KB, grow to what the call asks
    // for. u64 storage keeps the buffer aligned for the struct.
    let mut len: u32 = 15 * 1024;
    let mut buf: Vec<u64> = Vec::new();
    let mut rc = ERROR_BUFFER_OVERFLOW;
    for _ in 0..3 {
        buf = vec![0u64; (len as usize).div_ceil(8)];
        // SAFETY: buf is at least `len` bytes, aligned for the struct.
        rc = unsafe {
            GetAdaptersAddresses(
                AF_INET as u32,
                flags,
                std::ptr::null(),
                buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                &mut len,
            )
        };
        if rc != ERROR_BUFFER_OVERFLOW {
            break;
        }
    }
    if rc != NO_ERROR {
        return out;
    }
    // SAFETY: on NO_ERROR the buffer holds a valid linked list that lives
    // as long as `buf`, which outlives this walk.
    unsafe {
        let mut cur = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !cur.is_null() {
            let a = &*cur;
            cur = a.Next;
            if a.OperStatus != IfOperStatusUp
                || a.IfType == IF_TYPE_SOFTWARE_LOOPBACK
                || (multicast_only && a.Anonymous2.Flags & IP_ADAPTER_NO_MULTICAST != 0)
            {
                continue;
            }
            let mut ua = a.FirstUnicastAddress;
            while !ua.is_null() {
                let u = &*ua;
                ua = u.Next;
                let sa = u.Address.lpSockaddr;
                if sa.is_null() || (*sa).sa_family != AF_INET {
                    continue;
                }
                let sin = &*(sa as *const SOCKADDR_IN);
                let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.S_un.S_addr));
                if !ip.is_loopback() && !ip.is_unspecified() && !out.contains(&ip) {
                    out.push(ip);
                }
            }
        }
    }
    out
}

#[cfg(not(any(unix, windows)))]
fn interface_addrs() -> Vec<Ipv4Addr> {
    Vec::new()
}

/// Every address a phone or another machine might reach this one on, best
/// first: private LAN ranges, then CGNAT (Tailscale's 100.64.0.0/10), then
/// anything else that is up. Unlike discovery's list this includes
/// interfaces without multicast (a VPN tunnel), and leaves out link-local.
pub(crate) fn reachable_addrs() -> Vec<Ipv4Addr> {
    #[cfg(unix)]
    let mut all = {
        let mut out = Vec::new();
        // SAFETY: as in interface_addrs: read the list, free it once.
        unsafe {
            let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
            if libc::getifaddrs(&mut head) == 0 {
                let mut cur = head;
                while !cur.is_null() {
                    let ifa = &*cur;
                    cur = ifa.ifa_next;
                    if ifa.ifa_addr.is_null() || (*ifa.ifa_addr).sa_family as i32 != libc::AF_INET {
                        continue;
                    }
                    if ifa.ifa_flags & libc::IFF_UP as u32 == 0 || ifa.ifa_flags & libc::IFF_LOOPBACK as u32 != 0 {
                        continue;
                    }
                    let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                    let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                    if !out.contains(&ip) {
                        out.push(ip);
                    }
                }
                libc::freeifaddrs(head);
            }
        }
        out
    };
    #[cfg(windows)]
    let mut all = windows_addrs(false);
    #[cfg(not(any(unix, windows)))]
    let mut all = interface_addrs();
    all.retain(|ip| !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local());
    let rank = |ip: &Ipv4Addr| -> u8 {
        let o = ip.octets();
        if ip.is_private() {
            0
        } else if o[0] == 100 && (64..128).contains(&o[1]) {
            1
        } else {
            2
        }
    };
    all.sort_by_key(rank);
    all
}

/// Test seam: confine discovery to the loopback interface. macOS's Local
/// Network privacy answers EHOSTUNREACH to every multicast send from a
/// process it has not been granted to (a test binary under a terminal),
/// and loopback is exempt, so this is how the end-to-end test runs at all.
#[cfg(test)]
static LOOPBACK_ONLY: AtomicBool = AtomicBool::new(false);

/// Ask macOS for Local Network access the way it reliably asks: a Bonjour
/// browse through the system (`DNSServiceBrowse`) for the service type
/// Info.plist declares (`NSBonjourServices`: `_termic._tcp`). Our own
/// multicast sends are not a reliable trigger for the prompt (Apple TN3179):
/// on a fresh Mac sharing came on, nothing asked, and every send was refused
/// (`DenyMulticast = 1`, `MulticastPreferenceSet = 0`). Once per process.
#[cfg(target_os = "macos")]
pub(crate) fn ask_local_network_access() {
    use std::os::raw::{c_char, c_int, c_uint, c_void};
    type Ref = *mut c_void;
    type Reply = extern "C" fn(Ref, c_uint, c_uint, c_int, *const c_char, *const c_char, *const c_char, *mut c_void);
    extern "C" {
        fn DNSServiceBrowse(sd: *mut Ref, flags: c_uint, iface: c_uint, regtype: *const c_char, domain: *const c_char, cb: Reply, ctx: *mut c_void) -> c_int;
    }
    extern "C" fn ignore(_: Ref, _: c_uint, _: c_uint, _: c_int, _: *const c_char, _: *const c_char, _: *const c_char, _: *mut c_void) {}
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let mut r: Ref = std::ptr::null_mut();
        // shortcut: the browse is never processed or released (one idle
        // mDNSResponder connection per process); its only job is the prompt.
        let err = unsafe { DNSServiceBrowse(&mut r, 0, 0, c"_termic._tcp".as_ptr(), std::ptr::null(), ignore, std::ptr::null_mut()) };
        if err != 0 {
            crate::dlog(&format!("[mdns] DNSServiceBrowse failed ({err}); the Local Network prompt may not appear"));
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn ask_local_network_access() {}

/// "No route to host": what a denied macOS Local Network permission answers.
#[cfg(target_os = "macos")]
const EHOSTUNREACH: i32 = 65;
#[cfg(target_os = "linux")]
const EHOSTUNREACH: i32 = 113;
#[cfg(windows)]
const EHOSTUNREACH: i32 = 10065; // WSAEHOSTUNREACH
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
const EHOSTUNREACH: i32 = -1;

fn ifaces() -> Vec<Ipv4Addr> {
    #[cfg(test)]
    if LOOPBACK_ONLY.load(Ordering::SeqCst) {
        return vec![Ipv4Addr::LOCALHOST];
    }
    interface_addrs()
}

// ───────────────────────────── the service ───────────────────────────

struct State {
    advert: Advert,
    sightings: HashMap<String, Sighting>,
    /// Interfaces we send on and advertise A records for.
    ifaces: Vec<Ipv4Addr>,
    last_response: Option<Instant>,
}

struct Shared {
    state: Mutex<State>,
    /// Signalled on every sighting upsert, for wait_for.
    cv: Condvar,
    sock: UdpSocket,
    /// Serialises "pick the interface, send": IP_MULTICAST_IF is socket
    /// state, and the discovery thread and the caller both send.
    send_lock: Mutex<()>,
    /// Every send of the last round was refused as "no route to host".
    /// That is macOS Local Network privacy denying this app (a send to the
    /// group on a real interface has a route by definition), and without
    /// this it looked exactly like a quiet network: Nearby just stayed
    /// empty. Measured on a beta build whose permission was never asked:
    /// `DenyMulticast = 1`, nothing sent, nothing received.
    blocked: AtomicBool,
    stop: AtomicBool,
    on_change: Arc<dyn Fn() + Send + Sync>,
}

impl Shared {
    /// Send `pkt` to the group on every interface, or on the default one
    /// when we know of none.
    fn send_all(&self, pkt: &[u8], ifaces: &[Ipv4Addr]) {
        let _g = self.send_lock.lock().unwrap_or_else(|e| e.into_inner());
        let dest = SocketAddr::V4(SocketAddrV4::new(GROUP, PORT));
        let sock = socket2::SockRef::from(&self.sock);
        let (mut sent, mut refused) = (false, false);
        let mut note = |r: std::io::Result<usize>| match r {
            Ok(_) => sent = true,
            Err(e) if e.raw_os_error() == Some(EHOSTUNREACH) => refused = true,
            Err(_) => {}
        };
        if ifaces.is_empty() {
            note(self.sock.send_to(pkt, dest));
        } else {
            for ip in ifaces {
                if sock.set_multicast_if_v4(ip).is_ok() {
                    note(self.sock.send_to(pkt, dest));
                }
            }
        }
        let blocked = refused && !sent;
        if self.blocked.swap(blocked, Ordering::SeqCst) != blocked {
            (self.on_change)();
        }
    }

    fn snapshot(&self) -> (Advert, Vec<Ipv4Addr>) {
        let st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        (st.advert.clone(), st.ifaces.clone())
    }

    fn announce(&self, ttl: u32) {
        let (advert, ifaces) = self.snapshot();
        self.send_all(&encode_response(&advert, &ifaces, ttl), &ifaces);
    }

    fn query(&self) {
        let (_, ifaces) = self.snapshot();
        self.send_all(&encode_query(), &ifaces);
    }
}

/// The running discovery service. Dropping it stops it.
pub(crate) struct Discovery {
    shared: Arc<Shared>,
    stopped: bool,
}

fn bind_socket() -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    // Both, on unix: mDNSResponder and avahi hold 5353 with SO_REUSEPORT,
    // and a bind without it is refused. Windows has only SO_REUSEADDR,
    // which is how dnscache shares the port.
    s.set_reuse_address(true)?;
    #[cfg(unix)]
    s.set_reuse_port(true)?;
    s.bind(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, PORT)).into())?;
    // Loop ON: two instances on one machine (release + dev) see each
    // other, and stop()'s goodbye reaches our own thread to wake it.
    s.set_multicast_loop_v4(true)?;
    s.set_multicast_ttl_v4(255)?;
    Ok(s.into())
}

/// Join the group on every interface we have not joined yet. Errors are
/// expected (an address that vanished, a join that already exists) and
/// harmless: discovery degrades to the interfaces that worked.
fn join_all(sock: &UdpSocket, joined: &mut HashSet<Ipv4Addr>, ifaces: &[Ipv4Addr]) {
    if ifaces.is_empty() {
        if joined.insert(Ipv4Addr::UNSPECIFIED) {
            let _ = sock.join_multicast_v4(&GROUP, &Ipv4Addr::UNSPECIFIED);
        }
        return;
    }
    for ip in ifaces {
        if !joined.contains(ip) && sock.join_multicast_v4(&GROUP, ip).is_ok() {
            joined.insert(*ip);
        }
    }
}

impl Discovery {
    pub(crate) fn start(advert: Advert, on_change: Arc<dyn Fn() + Send + Sync>) -> Result<Discovery, String> {
        let sock = bind_socket().map_err(|e| {
            format!("Could not listen for other Termic instances on this network (UDP port 5353): {e}")
        })?;
        let ifaces = ifaces();
        let mut joined = HashSet::new();
        join_all(&sock, &mut joined, &ifaces);
        if joined.is_empty() {
            return Err("Could not join the local network discovery group on any network interface.".into());
        }
        let shared = Arc::new(Shared {
            state: Mutex::new(State { advert, sightings: HashMap::new(), ifaces, last_response: None }),
            cv: Condvar::new(),
            sock,
            send_lock: Mutex::new(()),
            blocked: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            on_change,
        });
        shared.announce(TTL);
        shared.query();
        let thread_shared = shared.clone();
        std::thread::Builder::new()
            .name("termic-mdns".into())
            .spawn(move || run(thread_shared, joined))
            .map_err(|e| format!("Could not start network discovery: {e}"))?;
        Ok(Discovery { shared, stopped: false })
    }

    /// Replace what we advertise and say so at once.
    pub(crate) fn update_advert(&self, advert: Advert) {
        self.shared.state.lock().unwrap_or_else(|e| e.into_inner()).advert = advert;
        self.shared.announce(TTL);
    }

    pub(crate) fn query_now(&self) {
        self.shared.query();
    }

    /// True while the OS refuses every multicast send (see `Shared::blocked`).
    pub(crate) fn blocked(&self) -> bool {
        self.shared.blocked.load(Ordering::SeqCst)
    }

    pub(crate) fn sightings(&self) -> Vec<Sighting> {
        let st = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let mut v: Vec<Sighting> = st
            .sightings
            .values()
            .filter(|s| now.duration_since(s.seen) < EXPIRE_AFTER)
            .cloned()
            .collect();
        v.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        v
    }

    pub(crate) fn wait_for(&self, id: &str, after: Instant, timeout: Duration) -> Option<Sighting> {
        let deadline = Instant::now() + timeout;
        let mut st = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(s) = st.sightings.get(id).filter(|s| s.seen > after) {
                return Some(s.clone());
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            st = self
                .shared
                .cv
                .wait_timeout(st, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    pub(crate) fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        self.shared.stop.store(true, Ordering::SeqCst);
        // The goodbye is also the wake-up: multicast loopback delivers it
        // to our own blocked recv. If it does not arrive, the thread
        // still exits at its next scheduled tick (at most a minute).
        self.shared.announce(0);
        self.shared.cv.notify_all();
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The discovery thread.
fn run(shared: Arc<Shared>, mut joined: HashSet<Ipv4Addr>) {
    let own_id = shared.snapshot().0.id;
    let mut buf = vec![0u8; MAX_PACKET];
    let mut next_tick = Instant::now() + REQUERY_EVERY;
    let mut second_announce = Some(Instant::now() + SECOND_ANNOUNCE);
    let mut failures = 0u32;

    loop {
        if shared.stop.load(Ordering::SeqCst) {
            return;
        }
        let now = Instant::now();

        if second_announce.is_some_and(|t| now >= t) {
            second_announce = None;
            shared.announce(TTL);
        }
        if now >= next_tick {
            next_tick = now + REQUERY_EVERY;
            // A network that came up since (Wi-Fi joined, VPN connected)
            // gets joined here, at the cost of noticing it within a minute.
            let ifaces = ifaces();
            join_all(&shared.sock, &mut joined, &ifaces);
            shared.state.lock().unwrap_or_else(|e| e.into_inner()).ifaces = ifaces;
            shared.query();
        }
        let expired = {
            let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            let before = st.sightings.len();
            st.sightings.retain(|_, s| now.duration_since(s.seen) < EXPIRE_AFTER);
            before != st.sightings.len()
        };
        if expired {
            (shared.on_change)();
        }

        // Sleep in recv until the earliest scheduled thing.
        let mut wake = next_tick;
        if let Some(t) = second_announce {
            wake = wake.min(t);
        }
        if let Some(oldest) = shared
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sightings
            .values()
            .map(|s| s.seen + EXPIRE_AFTER)
            .min()
        {
            wake = wake.min(oldest);
        }
        let wait = wake.saturating_duration_since(Instant::now()).max(Duration::from_millis(5));
        let _ = shared.sock.set_read_timeout(Some(wait));

        let (n, src) = match shared.sock.recv_from(&mut buf) {
            Ok(r) => {
                failures = 0;
                r
            }
            Err(e) => match e.kind() {
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => continue,
                // Windows reports an ICMP port-unreachable for an earlier
                // send as a reset on the next recv, and a datagram larger
                // than the buffer as an error rather than a truncation.
                // Neither says anything about this socket.
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::Interrupted => continue,
                _ => {
                    failures += 1;
                    if failures > 64 {
                        return;
                    }
                    // Error path only, never the steady state: stops a
                    // persistent failure from spinning this thread.
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
            },
        };
        if shared.stop.load(Ordering::SeqCst) {
            return;
        }
        handle_packet(&shared, &own_id, &buf[..n], src.ip());
    }
}

fn handle_packet(shared: &Shared, own_id: &str, pkt: &[u8], src: IpAddr) {
    let parsed = parse_packet(pkt);
    if !parsed.is_response {
        if parsed.questions_for_us {
            let now = Instant::now();
            let send = {
                let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                let ok = st.last_response.is_none_or(|t| now.duration_since(t) >= RESPONSE_MIN_GAP);
                if ok {
                    st.last_response = Some(now);
                }
                ok.then(|| (st.advert.clone(), st.ifaces.clone()))
            };
            if let Some((advert, ifaces)) = send {
                shared.send_all(&encode_response_with(&advert, &ifaces, TTL, parsed.meta_question), &ifaces);
            }
        }
        return;
    }
    let mut changed = false;
    {
        let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        for (a, ttl) in parsed.adverts {
            if a.id == own_id {
                continue;
            }
            if ttl == 0 {
                changed |= st.sightings.remove(&a.id).is_some();
                continue;
            }
            let next = Sighting {
                id: a.id.clone(),
                name: a.name,
                version: a.version,
                proto: a.proto,
                pv: a.pv,
                addr: src,
                port: a.port,
                seen: now,
                pairing: a.pairing,
            };
            let differs = st.sightings.get(&a.id).is_none_or(|old| {
                old.name != next.name
                    || old.version != next.version
                    || old.proto != next.proto
                    || old.pv != next.pv
                    || old.addr != next.addr
                    || old.port != next.port
                    || old.pairing != next.pairing
            });
            changed |= differs;
            st.sightings.insert(a.id, next);
        }
    }
    shared.cv.notify_all();
    if changed {
        (shared.on_change)();
    }
}

// ───────────────────────────── tests ─────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn advert(id: &str, name: &str) -> Advert {
        Advert { id: id.into(), name: name.into(), version: "1.16.0".into(), proto: 22, pv: 2, port: 23620, pairing: false }
    }

    #[test]
    fn round_trip() {
        let a = advert("0123456789abcdef0123456789abcdef", "alice's laptop");
        let pkt = encode_response(&a, &[Ipv4Addr::new(192, 168, 1, 20)], TTL);
        let p = parse_packet(&pkt);
        assert!(p.is_response);
        assert!(!p.questions_for_us);
        assert_eq!(p.adverts, vec![(a, TTL)]);
    }

    #[test]
    fn goodbye_carries_ttl_zero() {
        let a = advert("aa", "x");
        let p = parse_packet(&encode_response(&a, &[], 0));
        assert_eq!(p.adverts, vec![(a, 0)]);
    }

    #[test]
    fn query_is_recognised() {
        let p = parse_packet(&encode_query());
        assert!(!p.is_response);
        assert!(p.questions_for_us);
        assert!(!p.meta_question);
    }

    #[test]
    fn enumeration_query_is_recognised() {
        let mut q = header(0, 1, 0);
        push_name(&mut q, META);
        q.extend_from_slice(&T_PTR.to_be_bytes());
        q.extend_from_slice(&CLASS_IN.to_be_bytes());
        let p = parse_packet(&q);
        assert!(p.questions_for_us && p.meta_question);
        // And the answer to it points at our service type.
        let r = encode_response_with(&advert("aa", "x"), &[], TTL, true);
        assert!(r.windows(7).any(|w| w == b"_termic"));
        assert_eq!(parse_packet(&r).adverts.len(), 1);
    }

    #[test]
    fn other_questions_are_ignored() {
        let mut q = header(0, 1, 0);
        push_name(&mut q, "_http._tcp.local");
        q.extend_from_slice(&T_PTR.to_be_bytes());
        q.extend_from_slice(&CLASS_IN.to_be_bytes());
        assert!(!parse_packet(&q).questions_for_us);
    }

    #[test]
    fn compressed_names_parse() {
        // A response whose SRV / TXT owners and the PTR target point back
        // at the PTR rdata, the way mDNSResponder writes them.
        let mut out = header(0x8400, 0, 3);
        push_name(&mut out, SERVICE); // offset 12
        out.extend_from_slice(&T_PTR.to_be_bytes());
        out.extend_from_slice(&CLASS_IN.to_be_bytes());
        out.extend_from_slice(&TTL.to_be_bytes());
        let rd_len_at = out.len();
        out.extend_from_slice(&0u16.to_be_bytes());
        let inst_at = out.len();
        out.push(6);
        out.extend_from_slice(b"termic");
        out.extend_from_slice(&[0xC0, 12]); // -> _termic._tcp.local
        let rd_len = (out.len() - inst_at) as u16;
        out[rd_len_at..rd_len_at + 2].copy_from_slice(&rd_len.to_be_bytes());
        let ptr = [0xC0 | (inst_at >> 8) as u8, inst_at as u8];
        // SRV
        out.extend_from_slice(&ptr);
        out.extend_from_slice(&T_SRV.to_be_bytes());
        out.extend_from_slice(&CLASS_IN.to_be_bytes());
        out.extend_from_slice(&TTL.to_be_bytes());
        out.extend_from_slice(&8u16.to_be_bytes());
        out.extend_from_slice(&[0, 0, 0, 0, 0x5c, 0x44, 0xC0, 12]);
        // TXT
        out.extend_from_slice(&ptr);
        out.extend_from_slice(&T_TXT.to_be_bytes());
        out.extend_from_slice(&CLASS_IN.to_be_bytes());
        out.extend_from_slice(&TTL.to_be_bytes());
        let txt = b"\x05id=ab\x06name=z";
        out.extend_from_slice(&(txt.len() as u16).to_be_bytes());
        out.extend_from_slice(txt);
        let p = parse_packet(&out);
        assert_eq!(p.adverts.len(), 1);
        let (a, _) = &p.adverts[0];
        assert_eq!((a.id.as_str(), a.name.as_str(), a.port), ("ab", "z", 0x5c44));
    }

    #[test]
    fn malformed_input_is_harmless() {
        let good = encode_response(&advert("aa", "x"), &[Ipv4Addr::LOCALHOST], TTL);
        // Every truncation.
        for n in 0..good.len() {
            let _ = parse_packet(&good[..n]);
        }
        // Every single-byte corruption.
        for i in 0..good.len() {
            let mut b = good.clone();
            b[i] ^= 0xFF;
            let _ = parse_packet(&b);
        }
        // A pointer to itself, and a two-pointer cycle.
        let mut loop1 = header(0x8400, 0, 1);
        loop1.extend_from_slice(&[0xC0, 12]);
        assert_eq!(parse_packet(&loop1), Parsed { is_response: true, ..Default::default() });
        let mut loop2 = header(0, 1, 0);
        loop2.extend_from_slice(&[0xC0, 14, 0xC0, 12, 0, 12, 0, 1]);
        assert!(!parse_packet(&loop2).questions_for_us);
        // Huge header counts with no records behind them.
        let mut lies = header(0x8400, 0xFFFF, 0xFFFF);
        lies.extend_from_slice(&[0u8; 8]);
        let _ = parse_packet(&lies);
        // Oversize.
        assert_eq!(parse_packet(&vec![0u8; MAX_PACKET + 1]), Parsed::default());
    }

    #[test]
    fn long_multibyte_name_is_cut_on_a_char_boundary() {
        let name = "é".repeat(40); // 80 bytes
        let p = parse_packet(&encode_response(&advert("aa", &name), &[], TTL));
        let got = &p.adverts[0].0.name;
        assert!(got.len() <= NAME_MAX);
        assert_eq!(got.len(), 62);
        assert!(got.chars().all(|c| c == 'é'));
    }

    #[test]
    fn instance_label_is_a_safe_dns_label() {
        assert_eq!(instance_label("0123456789ABCDEFxyz"), "termic-0123456789ab");
        assert_eq!(instance_label("a.b/c"), "termic-abc");
    }

    #[test]
    fn own_packets_are_filtered() {
        let (tx, _rx) = std::sync::mpsc::channel::<()>();
        let tx = Mutex::new(tx);
        let sock = UdpSocket::bind("127.0.0.1:0").unwrap();
        let shared = Shared {
            state: Mutex::new(State {
                advert: advert("self", "me"),
                sightings: HashMap::new(),
                ifaces: Vec::new(),
                last_response: None,
            }),
            cv: Condvar::new(),
            sock,
            send_lock: Mutex::new(()),
            blocked: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            on_change: Arc::new(move || {
                let _ = tx.lock().unwrap().send(());
            }),
        };
        let src: IpAddr = Ipv4Addr::new(10, 0, 0, 2).into();
        handle_packet(&shared, "self", &encode_response(&advert("self", "me"), &[], TTL), src);
        assert!(shared.state.lock().unwrap().sightings.is_empty());
        handle_packet(&shared, "self", &encode_response(&advert("other", "them"), &[], TTL), src);
        let st = shared.state.lock().unwrap();
        assert_eq!(st.sightings["other"].addr, src, "the address is the packet's source");
        drop(st);
        handle_packet(&shared, "self", &encode_response(&advert("other", "them"), &[], 0), src);
        assert!(shared.state.lock().unwrap().sightings.is_empty(), "a goodbye removes it");
    }

    /// Two real instances on the real group and port, over loopback (see
    /// LOOPBACK_ONLY). Ignored by default: it binds the shared port 5353,
    /// which a CI runner may not allow. Run with --ignored.
    #[test]
    #[ignore]
    fn two_instances_find_each_other() {
        LOOPBACK_ONLY.store(true, Ordering::SeqCst);
        let noop: Arc<dyn Fn() + Send + Sync> = Arc::new(|| {});
        let a = Discovery::start(advert("aaaaaaaaaaaaaaaa", "alpha"), noop.clone()).expect("start a");
        let b = Discovery::start(advert("bbbbbbbbbbbbbbbb", "beta"), noop).expect("start b");
        let t0 = Instant::now() - Duration::from_secs(1);
        b.query_now();
        a.query_now();
        let saw_a = b.wait_for("aaaaaaaaaaaaaaaa", t0, Duration::from_secs(3)).expect("b sees a");
        let saw_b = a.wait_for("bbbbbbbbbbbbbbbb", t0, Duration::from_secs(3)).expect("a sees b");
        assert_eq!(saw_a.name, "alpha");
        assert_eq!(saw_b.port, 23620);
        assert!(a.sightings().iter().all(|s| s.id != "aaaaaaaaaaaaaaaa"), "never our own id");
        // Renaming re-announces.
        b.update_advert(advert("bbbbbbbbbbbbbbbb", "beta two"));
        // Packets already in flight (the second announce, a query answer)
        // can still carry the old name, so wait for the new one to land.
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut after = Instant::now() - Duration::from_millis(1);
        let mut renamed = None;
        while Instant::now() < deadline {
            match a.wait_for("bbbbbbbbbbbbbbbb", after, deadline - Instant::now()) {
                Some(s) if s.name == "beta two" => {
                    renamed = Some(s);
                    break;
                }
                Some(s) => after = s.seen,
                None => break,
            }
        }
        assert!(renamed.is_some(), "the rename is announced");
        // And a stop says goodbye.
        b.stop();
        let gone = (0..30).any(|_| {
            a.wait_for("never", Instant::now(), Duration::from_millis(100));
            a.sightings().iter().all(|s| s.id != "bbbbbbbbbbbbbbbb")
        });
        assert!(gone, "goodbye removes the sighting");
        a.stop();
    }
}
