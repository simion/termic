//! Small helpers with no state of their own: where files live, the log,
//! ids, timestamps, slugs.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The log rotates past this size (one previous file is kept).
const LOG_CAP: u64 = 2 * 1024 * 1024;


/// This build's version: the app's version plus a hash of the sources it
/// was built from (scripts/build-termic-server.mjs), so the desktop can
/// tell the build it carries from the one installed on a box and only
/// replace (and restart) a server that differs. A plain cargo build says
/// the crate version.
pub fn version() -> String {
    // Debug builds only: e2e/specs/remote.e2e.ts stages an "old" server
    // without building a second binary.
    #[cfg(debug_assertions)]
    if let Ok(v) = std::env::var("TERMIC_SERVER_FAKE_VERSION") {
        return v;
    }
    option_env!("TERMIC_SERVER_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")).to_string()
}

/// A task id as this box mints them (a uuid, hyphenated or not): it names
/// state and PTY claims, so nothing else is taken.
pub fn valid_task_id(id: &str) -> bool {
    (32..=36).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// `~/.termic-server`, or `$TERMIC_SERVER_HOME` (tests, a second instance).
pub fn data_dir() -> PathBuf {
    match std::env::var_os("TERMIC_SERVER_HOME") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => home().join(".termic-server"),
    }
}

pub fn sock_path(dir: &Path) -> PathBuf {
    dir.join("sock")
}

pub fn pid_path(dir: &Path) -> PathBuf {
    dir.join("daemon.pid")
}

pub fn log_path(dir: &Path) -> PathBuf {
    dir.join("daemon.log")
}

/// Create the data dir 0700, or check an existing one is ours and tighten
/// it. Another user's dir is refused: its socket would let them in.
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    if !dir.exists() {
        fs::create_dir_all(dir)?;
    }
    let md = fs::metadata(dir)?;
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    if md.uid() != me {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is owned by another user (uid {}); refusing to use it", dir.display(), md.uid()),
        ));
    }
    if md.permissions().mode() & 0o777 != 0o700 {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Write a file atomically (temp + rename) with mode 0600.
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    {
        let mut f = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

static LOG: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn init_log(path: PathBuf) {
    *LOG.lock().unwrap() = Some(path);
}

/// One line in the daemon log. Never fails the caller.
pub fn log(msg: &str) {
    let guard = LOG.lock().unwrap();
    let Some(path) = guard.as_ref() else {
        eprintln!("{msg}");
        return;
    };
    if fs::metadata(path).map(|m| m.len() > LOG_CAP).unwrap_or(false) {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).mode(0o600).open(path) {
        let _ = writeln!(f, "{} {msg}", rfc3339(now_secs()));
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// UTC RFC 3339 for a unix time ("2026-10-18T10:00:00Z").
pub fn rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem / 60 % 60, rem % 60)
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        if f.read_exact(&mut b).is_ok() {
            return b;
        }
    }
    // /dev/urandom is always there on the systems this runs on; this is
    // only so an id is never all zeros if it somehow is not.
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) ^ (std::process::id() as u128) << 64;
    for (i, x) in b.iter_mut().enumerate() {
        *x = (t >> ((i % 16) * 8)) as u8;
    }
    b
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A uuid v4 string, the shape the desktop's task ids have.
pub fn uuid() -> String {
    let mut b = random_bytes::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

pub fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for its length; gethostname NUL-terminates
    // on success (we also cap at the first NUL ourselves).
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    if rc != 0 {
        return "server".into();
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let s = String::from_utf8_lossy(&buf[..end]).trim().to_string();
    if s.is_empty() {
        "server".into()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // The slug the desktop names a task's branch and worktree folder with:
    // it must never climb out of the folder it is joined to.
    fn slugs_are_safe_path_and_branch_names() {
        assert_eq!(termic_proto::slugify("Fix the Login bug!"), "fix-the-login-bug");
        assert_eq!(termic_proto::slugify("../../etc/passwd"), "etc-passwd");
        assert_eq!(termic_proto::slugify("--rm -rf"), "rm-rf");
        assert_eq!(termic_proto::slugify("a//b..c"), "a-b-c");
        assert_eq!(termic_proto::slugify("..."), "");
        assert_eq!(termic_proto::slugify("日本語"), "");
        assert_eq!(termic_proto::slugify("ünïcode name"), "n-code-name");
        // The desktop's rules, not a box-only variant: `_` kept.
        assert_eq!(termic_proto::slugify("snake_case name"), "snake_case-name");
        for s in [termic_proto::slugify("-x-"), termic_proto::slugify(" a b "), termic_proto::slugify("a\nb\0c")] {
            assert!(!s.starts_with('-') && !s.ends_with('-') && !s.contains('/') && !s.contains('.'), "{s}");
        }
    }

    #[test]
    fn rfc3339_formats_known_instants() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_792_324_800), "2026-10-18T12:00:00Z");
    }

    #[test]
    fn uuids_have_the_v4_shape() {
        let u = uuid();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        assert_ne!(uuid(), u);
    }
}
