//! On-demand process sampling for the Activity monitor.
//!
//! Answers "which agent is eating my CPU / RAM?" by rolling up the whole
//! process TREE under each PTY we spawned, plus Termic's own processes.
//!
//! Three properties this module is built around:
//!
//! 1. **Zero cost when nobody is looking.** There is no sampler thread and
//!    no background state: `start` allocates a session, `sample` is driven
//!    by the webview's interval, `stop` drops everything. A `thread::sleep`
//!    poll loop here would be the exact mistake documented as bear trap 9
//!    in docs/performance.md - the monitor would burn more CPU than the
//!    thing it measures.
//! 2. **Cost proportional to OUR processes, not the machine's.** One pass
//!    of `PROC_PIDT_SHORTBSDINFO` over every pid builds the pid->ppid map
//!    (64 bytes per pid, no allocation per call); the expensive per-process
//!    calls (task info, rusage) run ONLY for pids inside one of our
//!    subtrees. Shelling out to `ps` per pid would fork dozens of
//!    processes per second (`sandbox`'s path watcher did, and burned a
//!    core; it now uses `short_info` below).
//! 3. **`phys_footprint`, not RSS.** Summing RSS across a process tree
//!    double-counts shared pages - a node agent plus its children share
//!    the binary and every dylib, so an RSS sum reads ~2x reality.
//!    `ri_phys_footprint` is the number Activity Monitor labels "Memory".
//!    We report the RSS sum too, but only as a secondary figure.
//!
//! CPU% is a DELTA and needs two samples, so the first snapshot after
//! `start` reports `cpu_pct: None`. The alternative (cumulative CPU time
//! divided by uptime) looks like a number but answers a different
//! question, so the UI shows a dash for one tick instead.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;

use crate::procmon_common::{build_child_map, collect_subtree, cpu_ratio, label_for, signal_from_name, EMPTY_SET};
// Re-exported: lib.rs reaches these as `procmon::Root` / `procmon::Snapshot`
// regardless of which platform module `procmon` resolves to.
pub use crate::procmon_common::{ChildRow, ProcRow, Root, Snapshot};

// ───────────────────────────── libproc FFI ─────────────────────────────
// These structs are the kernel's, mirrored from <sys/proc_info.h> and
// <sys/resource.h>. We never trust their size blindly: `proc_pidinfo`
// returns ENOSPC (-1) if the KERNEL's struct is bigger than the buffer we
// pass, and copies out exactly its own size otherwise - so a future macOS
// that extends either struct degrades to "no sample" rather than writing
// past the end of ours.

const PROC_ALL_PIDS: u32 = 1;
const PROC_PIDT_SHORTBSDINFO: libc::c_int = 13;
const PROC_PIDTASKINFO: libc::c_int = 4;
const RUSAGE_INFO_V0: libc::c_int = 0;
const MAXCOMLEN: usize = 16;
const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;

#[repr(C)]
#[derive(Clone, Copy)]
struct ProcBsdShortInfo {
    pbsi_pid: u32,
    pbsi_ppid: u32,
    pbsi_pgid: u32,
    pbsi_status: u32,
    pbsi_comm: [libc::c_char; MAXCOMLEN],
    pbsi_flags: u32,
    pbsi_uid: u32,
    pbsi_gid: u32,
    pbsi_ruid: u32,
    pbsi_rgid: u32,
    pbsi_svuid: u32,
    pbsi_svgid: u32,
    pbsi_rfu: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct ProcTaskInfo {
    pti_virtual_size: u64,
    pti_resident_size: u64,
    /// Mach ABSOLUTE TIME units, not nanoseconds. See `cpu_ratio`.
    pti_total_user: u64,
    pti_total_system: u64,
    pti_threads_user: u64,
    pti_threads_system: u64,
    pti_policy: i32,
    pti_faults: i32,
    pti_pageins: i32,
    pti_cow_faults: i32,
    pti_messages_sent: i32,
    pti_messages_received: i32,
    pti_syscalls_mach: i32,
    pti_syscalls_unix: i32,
    pti_csw: i32,
    pti_threadnum: i32,
    pti_numrunning: i32,
    pti_priority: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct RUsageInfoV0 {
    ri_uuid: [u8; 16],
    ri_user_time: u64,
    ri_system_time: u64,
    ri_pkg_idle_wkups: u64,
    ri_interrupt_wkups: u64,
    ri_pageins: u64,
    ri_wired_size: u64,
    ri_resident_size: u64,
    ri_phys_footprint: u64,
    ri_proc_start_abstime: u64,
    ri_proc_exit_abstime: u64,
}

extern "C" {
    fn proc_listpids(
        t: u32,
        typeinfo: u32,
        buffer: *mut libc::c_void,
        buffersize: libc::c_int,
    ) -> libc::c_int;
    fn proc_pidinfo(
        pid: libc::c_int,
        flavor: libc::c_int,
        arg: u64,
        buffer: *mut libc::c_void,
        buffersize: libc::c_int,
    ) -> libc::c_int;
    fn proc_pid_rusage(
        pid: libc::c_int,
        flavor: libc::c_int,
        buffer: *mut libc::c_void,
    ) -> libc::c_int;
    fn proc_pidpath(pid: libc::c_int, buffer: *mut libc::c_void, buffersize: u32) -> libc::c_int;
    fn mach_absolute_time() -> u64;
    /// Declared here rather than used from `libc`, whose copy is deprecated
    /// in favour of a `mach2` dependency we do not need for two u32s.
    fn mach_timebase_info(info: *mut MachTimebaseInfo) -> libc::c_int;
}

#[repr(C)]
#[derive(Clone, Copy)]
struct MachTimebaseInfo {
    numer: u32,
    denom: u32,
}

/// Every pid the kernel will tell us about. Sized by asking twice (the
/// first call with a null buffer returns the byte count needed), then
/// padded: pids come and go between the two calls.
fn all_pids() -> Vec<u32> {
    let needed = unsafe { proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return Vec::new();
    }
    let slots = (needed as usize / std::mem::size_of::<u32>()) + 64;
    let mut buf = vec![0u32; slots];
    let bytes = unsafe {
        proc_listpids(
            PROC_ALL_PIDS,
            0,
            buf.as_mut_ptr() as *mut libc::c_void,
            (buf.len() * std::mem::size_of::<u32>()) as libc::c_int,
        )
    };
    if bytes <= 0 {
        return Vec::new();
    }
    let n = bytes as usize / std::mem::size_of::<u32>();
    buf.truncate(n.min(slots));
    // pid 0 is the kernel and shows up as a zero slot in the tail padding.
    buf.retain(|&p| p != 0);
    buf
}

fn c_str_to_string(raw: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = raw
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// (ppid, comm) for one pid, or None if it exited between the listing and
/// now (the common case for short-lived helpers - a false negative here
/// just means the process is missing from this one sample). Also the
/// sandbox path watcher's ancestry lookup.
pub(crate) fn short_info(pid: u32) -> Option<(u32, String)> {
    let mut info: ProcBsdShortInfo = unsafe { std::mem::zeroed() };
    let ret = unsafe {
        proc_pidinfo(
            pid as libc::c_int,
            PROC_PIDT_SHORTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            std::mem::size_of::<ProcBsdShortInfo>() as libc::c_int,
        )
    };
    if ret <= 0 {
        return None;
    }
    Some((info.pbsi_ppid, c_str_to_string(&info.pbsi_comm)))
}

/// Per-process numbers we actually display. Separate call from
/// `short_info` because it is ~10x the kernel work, so it runs only for
/// pids that turned out to be ours.
struct PidStats {
    /// user+system, in mach absolute time units (see `cpu_ratio`).
    cpu: u64,
    threads: u32,
    footprint: u64,
    rss: u64,
    start_abs: u64,
}

fn pid_stats(pid: u32) -> Option<PidStats> {
    let mut ti: ProcTaskInfo = unsafe { std::mem::zeroed() };
    let ret = unsafe {
        proc_pidinfo(
            pid as libc::c_int,
            PROC_PIDTASKINFO,
            0,
            &mut ti as *mut _ as *mut libc::c_void,
            std::mem::size_of::<ProcTaskInfo>() as libc::c_int,
        )
    };
    if ret <= 0 {
        return None;
    }
    // rusage is a second call because footprint lives nowhere in taskinfo.
    // A failure here is not fatal: fall back to resident size so the row
    // still shows something rather than 0 B.
    let mut ru: RUsageInfoV0 = unsafe { std::mem::zeroed() };
    let ru_ok = unsafe {
        proc_pid_rusage(
            pid as libc::c_int,
            RUSAGE_INFO_V0,
            &mut ru as *mut _ as *mut libc::c_void,
        )
    } == 0;
    Some(PidStats {
        cpu: ti.pti_total_user.saturating_add(ti.pti_total_system),
        threads: ti.pti_threadnum.max(0) as u32,
        footprint: if ru_ok && ru.ri_phys_footprint > 0 {
            ru.ri_phys_footprint
        } else {
            ti.pti_resident_size
        },
        rss: ti.pti_resident_size,
        start_abs: if ru_ok { ru.ri_proc_start_abstime } else { 0 },
    })
}

/// Executable path for one pid. Also the sandbox path watcher's
/// process-name fallback.
pub(crate) fn pid_path(pid: u32) -> Option<String> {
    let mut buf = vec![0u8; PROC_PIDPATHINFO_MAXSIZE];
    let ret = unsafe {
        proc_pidpath(
            pid as libc::c_int,
            buf.as_mut_ptr() as *mut libc::c_void,
            buf.len() as u32,
        )
    };
    if ret <= 0 {
        return None;
    }
    buf.truncate(ret as usize);
    String::from_utf8(buf).ok()
}

/// Direct children of `ppid`. One kernel call, no full process-table pass.
pub(crate) fn child_pids(ppid: u32) -> Vec<u32> {
    const PROC_PPID_ONLY: u32 = 6;
    // with a null buffer the kernel sizes for every pid, whatever the filter.
    let needed = unsafe { proc_listpids(PROC_PPID_ONLY, ppid, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return Vec::new();
    }
    let mut buf = vec![0u32; needed as usize / 4 + 16];
    let bytes = unsafe {
        proc_listpids(PROC_PPID_ONLY, ppid, buf.as_mut_ptr().cast(), (buf.len() * 4) as libc::c_int)
    };
    buf.truncate(bytes.max(0) as usize / 4);
    buf.retain(|&p| p != 0);
    buf
}

/// Whether `pid` holds the client end of a loopback TCP connection from
/// local port `lport` to port `fport`: what a listener on `fport` that
/// accepted a peer at 127.0.0.1:`lport` needs to name its peer, since TCP
/// has no `LOCAL_PEERPID`. Costs one fd listing plus one call per socket.
pub(crate) fn holds_tcp_client(pid: u32, lport: u16, fport: u16) -> bool {
    // `struct socket_fdinfo` from <sys/proc_info.h>, which libc does not
    // bind. Read by offset rather than mirrored: only these fields matter,
    // all are in the struct's stable prefix (offsets checked with clang
    // against the 26.x SDK), and the buffer is larger than the kernel's
    // 792 bytes so a struct that grows at the end still copies out.
    const PROC_PIDFDSOCKETINFO: libc::c_int = 3;
    const SOI_KIND: usize = 256; // psi.soi_kind
    const SOCKINFO_IN: i32 = 1;
    const SOCKINFO_TCP: i32 = 2;
    const INSI_FPORT: usize = 264; // psi.soi_proto.pri_in.insi_fport
    const INSI_LPORT: usize = 268;
    const INSI_FADDR4: usize = 296 + 12; // in4in6_addr.i46a_addr4
    let fd_bytes = unsafe { proc_pidinfo(pid as libc::c_int, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    if fd_bytes <= 0 {
        return false;
    }
    let mut fds = vec![libc::proc_fdinfo { proc_fd: 0, proc_fdtype: 0 }; fd_bytes as usize / 8 + 16];
    let got = unsafe {
        proc_pidinfo(pid as libc::c_int, libc::PROC_PIDLISTFDS, 0, fds.as_mut_ptr().cast(),
            (fds.len() * std::mem::size_of::<libc::proc_fdinfo>()) as libc::c_int)
    };
    fds.truncate(got.max(0) as usize / std::mem::size_of::<libc::proc_fdinfo>());
    let mut buf = [0u64; 128];
    for fd in fds.iter().filter(|f| f.proc_fdtype as libc::c_int == libc::PROX_FDTYPE_SOCKET) {
        let n = unsafe {
            libc::proc_pidfdinfo(pid as libc::c_int, fd.proc_fd, PROC_PIDFDSOCKETINFO,
                buf.as_mut_ptr().cast(), std::mem::size_of_val(&buf) as libc::c_int)
        };
        if n < (INSI_FADDR4 + 4) as libc::c_int {
            continue;
        }
        // SAFETY: u64s viewed as bytes, same length.
        let b: &[u8] = unsafe { std::slice::from_raw_parts(buf.as_ptr().cast(), std::mem::size_of_val(&buf)) };
        let i32_at = |o: usize| i32::from_ne_bytes(b[o..o + 4].try_into().unwrap());
        // ports are network order in the low 16 bits (lsof does the same).
        let port_at = |o: usize| u16::from_be(i32_at(o) as u16);
        let kind = i32_at(SOI_KIND);
        if (kind == SOCKINFO_TCP || kind == SOCKINFO_IN)
            && port_at(INSI_LPORT) == lport
            && port_at(INSI_FPORT) == fport
            && b[INSI_FADDR4..INSI_FADDR4 + 4] == [127, 0, 0, 1]
        {
            return true;
        }
    }
    false
}

/// mach absolute ticks -> milliseconds. `mach_timebase_info` is 1/1 on
/// Intel but 125/3 on Apple silicon, so skipping it would report CPU
/// times ~24x too small on every current Mac.
fn ticks_to_ms(ticks: u64) -> u64 {
    let (numer, denom) = timebase();
    // ticks * numer / denom = nanoseconds. u128 so the multiply can't wrap
    // on a long-lived process (u64 ns overflows after ~584 years, but
    // ticks * 125 does not have that headroom).
    ((ticks as u128 * numer as u128) / (denom as u128 * 1_000_000u128)) as u64
}

fn timebase() -> (u32, u32) {
    static CACHED: std::sync::OnceLock<(u32, u32)> = std::sync::OnceLock::new();
    *CACHED.get_or_init(|| {
        let mut info = MachTimebaseInfo { numer: 0, denom: 0 };
        let ok = unsafe { mach_timebase_info(&mut info) } == 0;
        if ok && info.numer != 0 && info.denom != 0 {
            (info.numer, info.denom)
        } else {
            (1, 1)
        }
    })
}

/// Attribute the WKWebView sidecars (`com.apple.WebKit.WebContent`,
/// `.GPU`, `.Networking`) to us. They are XPC services owned by launchd,
/// NOT our children, so no ppid walk can ever find them - the only
/// supported link is the "responsible process" relationship, which is
/// what Activity Monitor uses to group them under an app.
///
/// The symbol is private, hence `dlsym` rather than a link-time
/// reference: if a future macOS drops it we report zero sidecars instead
/// of failing to launch.
fn responsible_pid(pid: u32) -> Option<u32> {
    type Fn = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
    static SYM: std::sync::OnceLock<Option<Fn>> = std::sync::OnceLock::new();
    let f = SYM.get_or_init(|| unsafe {
        let name = c"responsibility_get_pid_responsible_for_pid";
        let p = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr());
        if p.is_null() {
            None
        } else {
            Some(std::mem::transmute::<*mut libc::c_void, Fn>(p))
        }
    });
    let f = (*f)?;
    let got = unsafe { f(pid as libc::pid_t) };
    if got <= 0 {
        None
    } else {
        Some(got as u32)
    }
}

// Root/ChildRow/ProcRow/Snapshot moved to procmon_common.rs (shared with
// procmon_linux.rs / procmon_other.rs — plain data, nothing macOS-specific
// about the shapes themselves). The WebKit sidecar attribution this module
// does (via `responsible_pid` above) is macOS-only; the other platforms
// never attempt it, so their "Termic itself" row is honestly missing that
// slice of memory too — see their own `webkit_unavailable: true`.

// ───────────────────────────── session ─────────────────────────────

const HISTORY_LEN: usize = 90;
/// At most this many child processes per row. A `npm install` under an
/// agent can fan out to hundreds; the panel wants the hogs, not a census.
const MAX_CHILDREN: usize = 8;

struct Session {
    id: u64,
    /// pid -> cumulative cpu ticks at the previous sample.
    prev_cpu: HashMap<u32, u64>,
    /// mach_absolute_time() at the previous sample.
    prev_wall: u64,
    /// row key -> (cumulative pty out bytes, unix ms) at the previous sample.
    prev_out: HashMap<String, (u64, f64)>,
    /// row key -> cpu_pct history, oldest first.
    hist: HashMap<String, Vec<f64>>,
}

static STATE: Mutex<Option<Session>> = Mutex::new(None);
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

/// Begin sampling. Returns a baseline snapshot (no CPU% yet) and the
/// session id every subsequent `sample` call must present. Starting twice
/// replaces the old session, so a reloaded webview cannot leave a
/// zombie behind.
pub fn start(roots: Vec<Root>) -> Snapshot {
    let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    *STATE.lock() = Some(Session {
        id,
        prev_cpu: HashMap::new(),
        prev_wall: 0,
        prev_out: HashMap::new(),
        hist: HashMap::new(),
    });
    sample(id, roots).unwrap_or_else(|_| Snapshot {
        session: id,
        unix_ms: unix_ms_now(),
        rows: Vec::new(),
        sample_ms: 0.0,
        webkit_unavailable: false,
    })
}

/// Drop all session state. After this the module holds nothing and costs
/// nothing - there is no thread to stop because there never was one.
pub fn stop(session: u64) {
    let mut g = STATE.lock();
    if g.as_ref().is_some_and(|s| s.id == session) {
        *g = None;
    }
}

/// Drop the session whatever its id. For the Activity window being
/// destroyed, where the frontend never got to call `stop` with its id.
pub fn stop_all() {
    *STATE.lock() = None;
}

/// Test-only: nothing in the app asks this, because "is the monitor
/// sampling?" is the Activity window's own existence.
#[cfg(test)]
pub fn is_running() -> bool {
    STATE.lock().is_some()
}

fn unix_ms_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Take one snapshot. Errors when the session id does not match the live
/// session, which is how a webview that reloaded mid-poll learns to call
/// `start` again instead of silently reading another window's deltas.
pub fn sample(session: u64, roots: Vec<Root>) -> Result<Snapshot, String> {
    let began = std::time::Instant::now();
    {
        let g = STATE.lock();
        match g.as_ref() {
            None => return Err("procmon: no active session".into()),
            Some(s) if s.id != session => return Err("procmon: stale session".into()),
            Some(_) => {}
        }
    }

    // ── pass 1: the whole pid table, cheap fields only ──
    let pids = all_pids();
    let mut ppid: HashMap<u32, u32> = HashMap::with_capacity(pids.len());
    let mut comm: HashMap<u32, String> = HashMap::with_capacity(pids.len());
    let mut webkit_candidates: Vec<u32> = Vec::new();
    for pid in pids {
        let Some((parent, name)) = short_info(pid) else { continue };
        // The comm field is MAXCOMLEN bytes INCLUDING the terminator, so
        // every WebKit XPC service arrives truncated to "com.apple.WebKi" -
        // 15 characters, with the trailing "t" already gone. Matching the
        // full "com.apple.WebKit" here found nothing at all, which read as
        // "this Mac has no webview" rather than as a string bug. The prefix
        // also cannot tell WebContent from GPU, so the label comes from the
        // executable path, fetched only for these few candidates.
        if name.starts_with("com.apple.WebK") {
            webkit_candidates.push(pid);
        }
        ppid.insert(pid, parent);
        comm.insert(pid, name);
    }
    let children = build_child_map(&ppid);

    // ── our own WebKit sidecars ──
    let us = std::process::id();
    let mut webkit_unavailable = false;
    let mut roots = roots;
    if !webkit_candidates.is_empty() {
        let mut attributed = 0usize;
        for pid in webkit_candidates {
            // STRICT: the sidecar's responsible process must be us. The
            // looser "same responsibility group as us" test would work for a
            // dev build but is unsafe, because macOS makes the TERMINAL
            // responsible for anything launched from it - the group is then
            // iTerm/Terminal, and every WebKit app started from any terminal
            // window would be charged to Termic. Measured, not assumed: a
            // build run from a shell reports responsible=iTerm2, while
            // /Applications/Termic.app reports itself.
            if responsible_pid(pid) != Some(us) {
                continue;
            }
            attributed += 1;
            let label = pid_path(pid)
                .and_then(|p| {
                    p.rsplit('/')
                        .find(|seg| seg.starts_with("com.apple.WebKit."))
                        .map(|seg| seg.trim_start_matches("com.apple.WebKit.").to_string())
                })
                .unwrap_or_else(|| "WebKit".to_string());
            roots.push(Root {
                // Keyed by PID, not by label: opening the Activity window can
                // add a SECOND WebContent process, and two rows sharing a key
                // would collide in the history map and land two identical
                // React keys in the table. A pid is stable for the process's
                // lifetime, which is exactly the lifetime of its history.
                key: format!("webkit:{pid}"),
                kind: format!("webkit-{}", label.to_lowercase()),
                pty_id: None,
                task_id: None,
                tab_id: None,
                pid,
                out_bytes: None,
                docker_container: None,
            });
        }
        // We are a webview app, so finding no sidecar of our own never means
        // "there is no webview" - it means we could not prove ownership (the
        // private symbol is gone, or this is a dev build whose responsible
        // process is the terminal). Say so; silently omitting the rows would
        // under-report our own memory by ~100 MB.
        webkit_unavailable = attributed == 0;
    }

    // ── subtrees ──
    // Every PTY child is also a descendant of Termic itself, so the app row
    // has to stop at each PTY root or it would double-count every agent.
    let pty_root_pids: HashSet<u32> =
        roots.iter().filter(|r| r.pty_id.is_some()).map(|r| r.pid).collect();
    let now_wall = unsafe { mach_absolute_time() };
    let now_unix = unix_ms_now();

    let mut g = STATE.lock();
    let Some(sess) = g.as_mut() else {
        return Err("procmon: session ended".into());
    };
    if sess.id != session {
        return Err("procmon: stale session".into());
    }
    let delta_wall = now_wall.saturating_sub(sess.prev_wall);
    let have_baseline = sess.prev_wall != 0 && delta_wall > 0;

    let mut next_cpu: HashMap<u32, u64> = HashMap::new();
    let mut rows: Vec<ProcRow> = Vec::with_capacity(roots.len());
    let mut seen_keys: HashSet<String> = HashSet::with_capacity(roots.len());

    for root in &roots {
        let stop: &HashSet<u32> = if root.pid == us { &pty_root_pids } else { &EMPTY_SET };
        let members = collect_subtree(root.pid, &children, stop);

        let mut cpu_ticks_total = 0u64;
        let mut cpu_delta = 0u64;
        let mut mem = 0u64;
        let mut rss = 0u64;
        let mut threads = 0u32;
        let mut alive = false;
        let mut start_abs = 0u64;
        let mut kids: Vec<ChildRow> = Vec::new();

        for &pid in &members {
            let Some(st) = pid_stats(pid) else { continue };
            alive = true;
            if pid == root.pid {
                start_abs = st.start_abs;
            }
            cpu_ticks_total = cpu_ticks_total.saturating_add(st.cpu);
            mem = mem.saturating_add(st.footprint);
            rss = rss.saturating_add(st.rss);
            threads = threads.saturating_add(st.threads);
            // A pid new since the last sample has no previous value: count
            // its whole CPU time, which IS in-window because it started
            // in-window. A pid whose counter went backwards was recycled
            // (pid reuse) - treat it as new rather than reporting a
            // negative delta.
            let prev = sess.prev_cpu.get(&pid).copied().unwrap_or(0);
            let d = st.cpu.saturating_sub(prev.min(st.cpu));
            cpu_delta = cpu_delta.saturating_add(d);
            next_cpu.insert(pid, st.cpu);
            let child_pct = if have_baseline {
                Some(cpu_ratio(d, delta_wall))
            } else {
                None
            };
            kids.push(ChildRow {
                pid,
                label: comm.get(&pid).cloned().unwrap_or_else(|| "?".into()),
                cpu_pct: child_pct,
                mem_bytes: st.footprint,
            });
        }

        // Heaviest first so the culprit is the first child row; ties break
        // on memory, then pid, so the order does not shuffle every tick.
        kids.sort_by(|a, b| {
            b.cpu_pct
                .unwrap_or(0.0)
                .partial_cmp(&a.cpu_pct.unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.mem_bytes.cmp(&a.mem_bytes))
                .then(a.pid.cmp(&b.pid))
        });
        let proc_count = kids.len() as u32;
        kids.truncate(MAX_CHILDREN);

        let cpu_pct = if have_baseline {
            Some(cpu_ratio(cpu_delta, delta_wall))
        } else {
            None
        };

        // Output rate: cumulative PTY bytes differenced against the
        // previous sample's wall clock.
        let out_bps = match (root.out_bytes, sess.prev_out.get(&root.key)) {
            (Some(now_bytes), Some(&(prev_bytes, prev_ms))) if now_unix > prev_ms => {
                let secs = (now_unix - prev_ms) / 1000.0;
                Some(now_bytes.saturating_sub(prev_bytes) as f64 / secs)
            }
            _ => None,
        };
        if let Some(b) = root.out_bytes {
            sess.prev_out.insert(root.key.clone(), (b, now_unix));
        }

        let h = sess.hist.entry(root.key.clone()).or_default();
        h.push(cpu_pct.unwrap_or(0.0));
        if h.len() > HISTORY_LEN {
            let drop = h.len() - HISTORY_LEN;
            h.drain(0..drop);
        }

        seen_keys.insert(root.key.clone());
        rows.push(ProcRow {
            key: root.key.clone(),
            kind: root.kind.clone(),
            pty_id: root.pty_id.clone(),
            task_id: root.task_id.clone(),
            tab_id: root.tab_id.clone(),
            pid: root.pid,
            label: label_for(root.pid, &children, &comm),
            cpu_pct,
            mem_bytes: mem,
            rss_bytes: rss,
            proc_count,
            threads,
            cpu_ms: ticks_to_ms(cpu_ticks_total),
            uptime_ms: if start_abs > 0 {
                ticks_to_ms(now_wall.saturating_sub(start_abs))
            } else {
                0
            },
            out_bps,
            alive,
            cpu_history: h.clone(),
            children: kids,
            is_docker: false,
        });
    }

    // Forget state for rows that went away (tab closed, agent exited), so
    // a long session does not accumulate history for dead PTYs.
    sess.hist.retain(|k, _| seen_keys.contains(k));
    sess.prev_out.retain(|k, _| seen_keys.contains(k));
    sess.prev_cpu = next_cpu;
    sess.prev_wall = now_wall;
    drop(g);

    Ok(Snapshot {
        session,
        unix_ms: now_unix,
        rows,
        sample_ms: began.elapsed().as_secs_f64() * 1000.0,
        webkit_unavailable,
    })
}

/// Send `sig` to `pid`, but ONLY if it sits inside the subtree of a PTY we
/// spawned. Two things this refuses on purpose: pids we cannot prove are
/// ours (the webview would otherwise be an arbitrary `kill(2)` gadget),
/// and Termic's own process or its WebKit sidecars (killing those looks
/// like a crash to the user, and the app cannot ask for confirmation
/// after its own renderer is gone).
pub fn signal(roots: &[Root], pid: u32, sig_name: &str) -> Result<(), String> {
    let Some(sig) = signal_from_name(sig_name) else {
        return Err(format!("unsupported signal {sig_name}"));
    };
    if pid == 0 || pid == std::process::id() {
        return Err("refusing to signal Termic itself".into());
    }
    let mut ppid: HashMap<u32, u32> = HashMap::new();
    for p in all_pids() {
        if let Some((parent, _)) = short_info(p) {
            ppid.insert(p, parent);
        }
    }
    let children = build_child_map(&ppid);
    let owned = roots.iter().filter(|r| r.pty_id.is_some()).any(|r| {
        // Each PTY row is checked against its own subtree with no stop set:
        // a nested agent still belongs to the PTY that launched it.
        collect_subtree(r.pid, &children, &EMPTY_SET).contains(&pid)
    });
    if !owned {
        return Err("pid is not part of a Termic terminal".into());
    }
    // SAFETY: kill(2) is async-signal-safe and the pid is validated above.
    let rc = unsafe { libc::kill(pid as libc::c_int, sig) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The session is process-global (there is one Activity window), so the
    /// tests that drive it must not run concurrently with each other.
    static SESSION_TEST: Mutex<()> = Mutex::new(());

    // subtree/cpu_ratio/label_for/signal_from_name tests moved to
    // procmon_common.rs with the functions themselves. What's left here
    // needs the real macOS process table.

    #[test]
    fn signal_refuses_our_own_pid() {
        let err = signal(&[], std::process::id(), "TERM").unwrap_err();
        assert!(err.contains("Termic itself"), "{err}");
    }

    #[test]
    fn signal_refuses_a_pid_we_do_not_own() {
        // launchd is emphatically not one of our terminals.
        let err = signal(&[], 1, "TERM").unwrap_err();
        assert!(err.contains("not part of"), "{err}");
    }

    // The FFI layer itself: these run against the real process table, so
    // they assert only what must be true of any live macOS process.
    #[test]
    fn reads_the_real_process_table() {
        let pids = all_pids();
        assert!(pids.len() > 5, "expected a populated pid table, got {}", pids.len());
        let us = std::process::id();
        assert!(pids.contains(&us));
        let (parent, name) = short_info(us).expect("own short info");
        assert!(parent > 0);
        assert!(!name.is_empty());
    }

    #[test]
    fn reads_our_own_stats() {
        let st = pid_stats(std::process::id()).expect("own stats");
        assert!(st.threads >= 1);
        assert!(st.footprint > 0, "phys_footprint should be non-zero");
        assert!(st.start_abs > 0, "start abstime should be populated");
    }

    #[test]
    fn timebase_is_sane() {
        let (n, d) = timebase();
        assert!(n > 0 && d > 0);
        // One second of ticks must convert to about 1000 ms.
        let ticks = (1_000_000_000u128 * d as u128 / n as u128) as u64;
        let ms = ticks_to_ms(ticks);
        assert!((999..=1001).contains(&ms), "1s converted to {ms}ms");
    }

    /// End-to-end check that the CPU math produces a REAL percentage: peg
    /// one core and the row must report something near 100, not 4 (what a
    /// mach-ticks / nanoseconds unit mismatch would give on Apple silicon)
    /// and not 2400 (the inverse mistake). Threshold is loose on purpose -
    /// this asserts the order of magnitude, which is the part that breaks.
    #[test]
    fn cpu_percent_tracks_a_busy_core() {
        fn app_root() -> Vec<Root> {
            vec![Root {
                key: "app".into(),
                kind: "app".into(),
                pty_id: None,
                task_id: None,
                tab_id: None,
                pid: std::process::id(),
                out_bytes: None,
                docker_container: None,
            }]
        }
        let _guard = SESSION_TEST.lock();
        let base = start(app_root());
        let stop_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let f = stop_flag.clone();
        let spinner = std::thread::spawn(move || {
            let mut x = 0u64;
            while !f.load(Ordering::Relaxed) {
                x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
            }
            x
        });
        std::thread::sleep(std::time::Duration::from_millis(400));
        let hot = sample(base.session, app_root()).expect("sample while busy");
        stop_flag.store(true, Ordering::Relaxed);
        let _ = spinner.join();
        stop(base.session);

        let pct = hot.rows[0].cpu_pct.expect("cpu after a baseline");
        assert!(
            (25.0..400.0).contains(&pct),
            "one pegged core should read near 100%, got {pct}"
        );
        assert!(hot.rows[0].cpu_ms > 0, "cumulative cpu time should be non-zero");
        assert!(hot.sample_ms < 500.0, "sampling took {}ms", hot.sample_ms);
    }

    #[test]
    fn session_lifecycle_holds_no_state_when_stopped() {
        let _guard = SESSION_TEST.lock();
        let snap = start(vec![Root {
            key: "app".into(),
            kind: "app".into(),
            pty_id: None,
            task_id: None,
            tab_id: None,
            pid: std::process::id(),
            out_bytes: None,
            docker_container: None,
        }]);
        assert!(is_running());
        assert_eq!(snap.rows.len(), 1);
        // First sample has no delta to report.
        assert!(snap.rows[0].cpu_pct.is_none());
        assert!(snap.rows[0].mem_bytes > 0);
        assert!(snap.rows[0].alive);

        let second = sample(snap.session, vec![Root {
            key: "app".into(),
            kind: "app".into(),
            pty_id: None,
            task_id: None,
            tab_id: None,
            pid: std::process::id(),
            out_bytes: None,
            docker_container: None,
        }])
        .expect("second sample");
        assert!(second.rows[0].cpu_pct.is_some(), "second sample must have a delta");
        assert_eq!(second.rows[0].cpu_history.len(), 2);

        // A stale id must not read the live session's deltas.
        assert!(sample(snap.session + 999, Vec::new()).is_err());

        stop(snap.session);
        assert!(!is_running());
        assert!(sample(snap.session, Vec::new()).is_err());
    }
}
