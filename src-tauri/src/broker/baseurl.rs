//! The base-URL delivery: a per-spawn plaintext endpoint on loopback that a
//! tool's `*_BASE_URL` env var points at. The broker does the TLS upstream.
//! One listener per agent spawn.
//!
//! TCP has no `LOCAL_PEERPID`, so unlike the gh socket the peer is not
//! checked by pid: the request must carry this spawn's random path marker
//! (`Spawn::base_url_target`). Only the caged agent's env holds it.
// ponytail: marker, not pid, for this endpoint and both proxy deliveries
// (docs/sandbox.md "marker-only deliveries"). A same-user process that reads
// the agent's env could use them; a pid check via libproc's socket tables is
// the upgrade if that ever matters.

use super::accept::{self, Acceptor};
use super::{Spawn, Via, CLIENT_READ_TIMEOUT, CLIENT_WRITE_TIMEOUT};
use std::io::BufReader;
use std::net::TcpListener;
use std::sync::Arc;

pub(crate) struct Listener {
    pub(crate) port: u16,
    _acceptor: Acceptor,
}

pub(crate) fn listen(sp: Arc<Spawn>) -> std::io::Result<Listener> {
    let l = TcpListener::bind(("127.0.0.1", 0))?;
    let port = l.local_addr()?.port();
    let acceptor = accept::spawn(l, |_| true, move |conn| {
        let _ = conn.set_read_timeout(Some(CLIENT_READ_TIMEOUT));
        let _ = conn.set_write_timeout(Some(CLIENT_WRITE_TIMEOUT));
        super::serve(&sp, &mut BufReader::new(conn), Via::BaseUrl);
    })?;
    Ok(Listener { port, _acceptor: acceptor })
}
