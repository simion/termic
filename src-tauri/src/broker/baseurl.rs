//! The base-URL delivery: a per-spawn plaintext endpoint on loopback that a
//! tool's `*_BASE_URL` env var points at. The broker does the TLS upstream.
//! One listener per agent spawn.
//!
//! The peer is checked before a connection takes a slot, like the gh
//! socket's, but by pid lookup instead of `LOCAL_PEERPID` (TCP has none):
//! `Spawn::admit_tcp`. The request must still carry this spawn's random path
//! marker (`Spawn::base_url_target`), which only the caged agent's env holds.

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
    let sp2 = sp.clone();
    let acceptor = accept::spawn(l, move |conn| sp2.admit_tcp(conn), move |conn| {
        let _ = conn.set_read_timeout(Some(CLIENT_READ_TIMEOUT));
        let _ = conn.set_write_timeout(Some(CLIENT_WRITE_TIMEOUT));
        super::serve(&sp, &mut BufReader::new(conn), Via::BaseUrl);
    })?;
    Ok(Listener { port, _acceptor: acceptor })
}
