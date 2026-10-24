//! gh's `http_unix_socket`: gh writes plaintext HTTP here and the broker
//! does the TLS. One listener per agent spawn.

use super::accept::{self, Acceptor};
use super::{record_suspicious, Spawn, Via, CLIENT_READ_TIMEOUT, CLIENT_WRITE_TIMEOUT};
use std::io::BufReader;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(crate) struct Listener {
    path: PathBuf,
    acceptor: Option<Acceptor>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        // stops by self-pipe (accept.rs), so an agent unlinking the socket
        // cannot make this hang.
        drop(self.acceptor.take());
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(crate) fn listen(sp: Arc<Spawn>, path: &Path) -> std::io::Result<Listener> {
    let _ = std::fs::remove_file(path);
    let l = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    let sp2 = sp.clone();
    let acceptor = accept::spawn(l, move |conn| admit(&sp2, conn), move |conn| handle(&sp, conn))?;
    Ok(Listener { path: path.to_path_buf(), acceptor: Some(acceptor) })
}

/// The peer check, on the accept thread before the connection takes a slot:
/// the pid comes from the kernel, so another task's process is turned away
/// without ever holding one of this agent's connections.
fn admit(sp: &Spawn, conn: &UnixStream) -> bool {
    let pid = peer_pid(conn);
    if pid.is_some_and(|p| (sp.deps.peer_ok)(&sp.task_id, p)) { return true; }
    let who = pid.map(crate::sandbox::describe_pid).unwrap_or_else(|| "unknown pid".into());
    record_suspicious(&sp.task_id, "wrong_peer", "", &format!("{who} is not this task's agent"));
    // a short refusal into an empty socket buffer; the timeout keeps a peer
    // that never reads from stalling the accept thread.
    let _ = conn.set_write_timeout(Some(std::time::Duration::from_millis(200)));
    let mut w = conn;
    let _ = super::http::respond(&mut w, 403, "Forbidden", &[("X-Termic-Secrets", "wrong-peer")],
        "Refused by Termic: this socket belongs to another task's agent.\n");
    false
}

fn handle(sp: &Spawn, conn: UnixStream) {
    let _ = conn.set_read_timeout(Some(CLIENT_READ_TIMEOUT));
    let _ = conn.set_write_timeout(Some(CLIENT_WRITE_TIMEOUT));
    super::serve(sp, &mut BufReader::new(conn), Via::Socket);
}

/// The connecting process, from the kernel (LOCAL_PEERPID), not from
/// anything the client says.
#[cfg(target_os = "macos")]
fn peer_pid(s: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: getsockopt writes at most `len` bytes into `pid`.
    let rc = unsafe {
        libc::getsockopt(s.as_raw_fd(), libc::SOL_LOCAL, libc::LOCAL_PEERPID,
            &mut pid as *mut libc::pid_t as *mut libc::c_void, &mut len)
    };
    (rc == 0 && pid > 0).then_some(pid as u32)
}

#[cfg(not(target_os = "macos"))]
fn peer_pid(_s: &UnixStream) -> Option<u32> { None }
