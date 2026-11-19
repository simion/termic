//! termic-server: the headless half of Termic's remote control.
//!
//! A daemon on a box (a mini PC, a VM) holds every agent PTY, so agents keep
//! running while the laptop sleeps or the network drops. The desktop
//! reaches it with `ssh <box> termic-server bridge`: the bridge copies the
//! ssh session's bytes to the daemon's unix socket, starting the daemon if
//! it is not running. No TCP port is ever opened; SSH is the only way in.
//! See README.md.
//!
//! Unix only, by design: a unix socket, process groups, setsid. The app
//! never installs it on Windows; on other systems the binary just says so,
//! which keeps the workspace building for the Windows desktop.

#[cfg(unix)]
include!("server.rs");

#[cfg(not(unix))]
fn main() {
    eprintln!("termic-server runs on Linux and macOS; this system is not one.");
    std::process::exit(1);
}
