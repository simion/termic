//! Socket discovery, connect-or-launch, and the request/reply exchange.
//!
//! Rules from docs/plans/cli.md this module enforces:
//! - The CLI NEVER touches termic's data files (no offline mode); the
//!   only file it reads is the per-boot token, which is the credential.
//! - No socket means "launch the app and poll with a deadline", never a
//!   hang; `--no-launch` swaps the launch for an immediate error.
//! - After a connection exists, any IO failure is "connection lost"
//!   (exit 8), distinct from "app not running" (exit 4).

use crate::CliError;
use std::io::{BufReader, Read};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;
use termic_proto as proto;
use termic_proto::exit_code;

/// Where the socket and token live. `custom` is set when TERMIC_SOCKET
/// overrode discovery; auto-launch is disabled then (the override points
/// at a specific instance, launching the installed app would be wrong).
pub struct SocketPaths {
    pub socket: PathBuf,
    pub token_file: PathBuf,
    pub custom: bool,
}

/// Mirror of the app's data-dir choice (src-tauri/src/lib.rs `APP_DIR`):
/// debug builds use `termic_dev` and honor TERMIC_DATA_DIR, release uses
/// `termic`. Used only to locate the socket + token, never to read data.
fn default_data_dir() -> Option<PathBuf> {
    const APP_DIR: &str = if cfg!(debug_assertions) { "termic_dev" } else { "termic" };
    if cfg!(debug_assertions) {
        if let Ok(d) = std::env::var("TERMIC_DATA_DIR") {
            if !d.trim().is_empty() {
                return Some(PathBuf::from(d));
            }
        }
    }
    dirs::data_local_dir().map(|p| p.join(APP_DIR))
}

pub fn socket_paths() -> SocketPaths {
    socket_paths_from(std::env::var("TERMIC_SOCKET").ok(), default_data_dir())
}

/// Pure resolution, split out for tests.
pub fn socket_paths_from(socket_env: Option<String>, data_dir: Option<PathBuf>) -> SocketPaths {
    if let Some(s) = socket_env.filter(|s| !s.trim().is_empty()) {
        let socket = PathBuf::from(s);
        let token_file =
            socket.parent().map(|p| p.join(proto::TOKEN_FILE)).unwrap_or_else(|| {
                PathBuf::from(proto::TOKEN_FILE)
            });
        return SocketPaths { socket, token_file, custom: true };
    }
    // No data dir at all is a broken environment; point at a path that
    // will fail to connect with a clear error rather than panicking.
    let dir = data_dir.unwrap_or_else(|| PathBuf::from("/nonexistent/termic"));
    SocketPaths {
        socket: dir.join(proto::SOCKET_FILE),
        token_file: dir.join(proto::TOKEN_FILE),
        custom: false,
    }
}

pub struct Conn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

fn try_connect(paths: &SocketPaths) -> std::io::Result<Conn> {
    let stream = UnixStream::connect(&paths.socket)?;
    // Replies for these read verbs are quick; the generous ceiling only
    // exists so a wedged app can never hang a script forever.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let reader = BufReader::new(stream.try_clone()?);
    Ok(Conn { reader, writer: stream })
}

pub fn connect_or_launch(paths: &SocketPaths, no_launch: bool) -> Result<Conn, CliError> {
    match try_connect(paths) {
        Ok(c) => return Ok(c),
        Err(_) if no_launch => {
            return Err(CliError::new(
                exit_code::APP_NOT_RUNNING,
                "Termic must be open (--no-launch given)",
            ));
        }
        Err(_) if paths.custom => {
            return Err(CliError::new(
                exit_code::APP_NOT_RUNNING,
                format!("Termic is not listening on TERMIC_SOCKET ({})", paths.socket.display()),
            ));
        }
        Err(_) => {}
    }

    // Auto-launch is a RELEASE-build convenience only. `open -ga Termic`
    // can start just the INSTALLED release app, which serves the release
    // data dir (<data>/termic). A DEBUG cli targets <data>/termic_dev, so
    // launching the release app would poll a socket it never binds and
    // time out with a misleading "Termic did not start" - and worse, pop
    // open the prod app while you are testing a `make dev` instance. In
    // debug (and on non-macOS) fail fast and point at the fix instead.
    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    {
        // Background launch without focus steal, then poll with a
        // deadline. Concurrent invocations racing `open -ga` are deduped
        // by LaunchServices (docs/plans/cli.md).
        let launched = std::process::Command::new("open")
            .args(["-ga", "Termic"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !launched {
            return Err(CliError::new(
                exit_code::APP_NOT_RUNNING,
                "Termic is not running and could not be launched (is Termic.app installed?)",
            ));
        }
        // `Instant` is only used on this release-only path; qualify it
        // inline so a debug build has no unused import.
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if let Ok(c) = try_connect(paths) {
                return Ok(c);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        Err(CliError::new(exit_code::APP_NOT_RUNNING, "Termic did not start"))
    }
    #[cfg(not(all(target_os = "macos", not(debug_assertions))))]
    {
        Err(CliError::new(
            exit_code::APP_NOT_RUNNING,
            format!(
                "Termic is not running at {}. Start Termic, or point TERMIC_SOCKET at its termic.sock.",
                paths.socket.display()
            ),
        ))
    }
}

fn lost(e: impl std::fmt::Display) -> CliError {
    CliError::new(exit_code::CONNECTION_LOST, format!("connection to Termic lost ({e})"))
}

fn exchange(conn: &mut Conn, req: &proto::Request) -> Result<proto::Reply, CliError> {
    proto::write_msg(&mut conn.writer, req).map_err(lost)?;
    match proto::read_msg::<_, proto::Reply>(&mut conn.reader) {
        Ok(Some(reply)) => Ok(reply),
        Ok(None) => Err(lost("server closed the connection")),
        Err(e) => Err(lost(e)),
    }
}

/// Unauthenticated hello: proves the app is up and gates on the protocol
/// version before anything else is attempted.
pub fn hello(conn: &mut Conn) -> Result<proto::HelloData, CliError> {
    let reply = exchange(
        conn,
        &proto::Request { id: "hello".into(), token: None, cmd: proto::Command::Hello },
    )?;
    match reply.data {
        Some(proto::ReplyData::Hello(h)) => {
            proto::check_protocol(h.protocol)
                .map_err(|msg| CliError::new(exit_code::ERROR, msg))?;
            Ok(h)
        }
        _ => Err(CliError::new(exit_code::ERROR, "unexpected reply to hello")),
    }
}

/// Read the per-boot token. Running uncaged in the user's shell this
/// always works while the app is up; failure means an old app version
/// (no server) or deliberate lockdown.
pub fn read_token(paths: &SocketPaths) -> Result<String, CliError> {
    let mut buf = String::new();
    std::fs::File::open(&paths.token_file)
        .and_then(|mut f| f.read_to_string(&mut buf))
        .map_err(|e| {
            CliError::new(
                exit_code::REFUSED,
                format!("cannot read the CLI token at {} ({e})", paths.token_file.display()),
            )
        })?;
    let token = buf.trim().to_string();
    if token.is_empty() {
        return Err(CliError::new(
            exit_code::REFUSED,
            format!("the CLI token at {} is empty", paths.token_file.display()),
        ));
    }
    Ok(token)
}

/// Send one authenticated verb and unwrap the reply.
pub fn request(
    conn: &mut Conn,
    cmd: proto::Command,
    token: &str,
) -> Result<proto::ReplyData, CliError> {
    let reply = exchange(
        conn,
        &proto::Request { id: "1".into(), token: Some(token.to_string()), cmd },
    )?;
    reply_to_result(reply)
}

/// Map a reply envelope onto the exit-code contract. Pure, unit-tested.
pub fn reply_to_result(reply: proto::Reply) -> Result<proto::ReplyData, CliError> {
    if let Some(err) = reply.error {
        return Err(CliError::new(err.code.exit_code(), err.message));
    }
    reply
        .data
        .ok_or_else(|| CliError::new(exit_code::ERROR, "empty reply from Termic"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use termic_proto::{ErrorCode, Reply, ReplyData};

    #[test]
    fn socket_env_overrides_and_disables_launch() {
        let p = socket_paths_from(Some("/x/y/termic.sock".into()), Some(PathBuf::from("/data")));
        assert!(p.custom);
        assert_eq!(p.socket, PathBuf::from("/x/y/termic.sock"));
        assert_eq!(p.token_file, PathBuf::from("/x/y/cli-token"));
    }

    #[test]
    fn default_paths_come_from_the_data_dir() {
        let p = socket_paths_from(None, Some(PathBuf::from("/data/termic")));
        assert!(!p.custom);
        assert_eq!(p.socket, PathBuf::from("/data/termic/termic.sock"));
        assert_eq!(p.token_file, PathBuf::from("/data/termic/cli-token"));
    }

    #[test]
    fn empty_socket_env_is_ignored() {
        let p = socket_paths_from(Some("  ".into()), Some(PathBuf::from("/data/termic")));
        assert!(!p.custom);
    }

    #[test]
    fn disabled_cli_maps_to_exit_5_with_the_exact_message() {
        let err = reply_to_result(Reply::err(
            "1",
            ErrorCode::CliDisabled,
            proto::CLI_DISABLED_MESSAGE,
        ))
        .unwrap_err();
        assert_eq!(err.code, 5);
        assert_eq!(err.message, proto::CLI_DISABLED_MESSAGE);
    }

    #[test]
    fn auth_failure_maps_to_exit_6() {
        let err =
            reply_to_result(Reply::err("1", ErrorCode::Auth, "invalid or missing CLI token"))
                .unwrap_err();
        assert_eq!(err.code, 6);
    }

    #[test]
    fn not_found_and_ambiguous_map_to_exit_1() {
        for code in [ErrorCode::NotFound, ErrorCode::Ambiguous, ErrorCode::Internal] {
            let err = reply_to_result(Reply::err("1", code, "x")).unwrap_err();
            assert_eq!(err.code, 1);
        }
    }

    #[test]
    #[cfg(debug_assertions)]
    fn debug_build_fails_fast_without_launching() {
        // A debug CLI must NEVER shell out to `open -ga Termic` (that
        // launches the RELEASE app, a different data dir): a missing
        // socket returns APP_NOT_RUNNING immediately, not after a
        // 15s launch+poll. cargo test runs in debug, so this branch is
        // the one compiled here.
        let paths = SocketPaths {
            socket: PathBuf::from("/nonexistent/termic_dev/termic.sock"),
            token_file: PathBuf::from("/nonexistent/termic_dev/cli-token"),
            custom: false,
        };
        let start = std::time::Instant::now();
        let err = match connect_or_launch(&paths, false) {
            Err(e) => e,
            Ok(_) => panic!("expected APP_NOT_RUNNING, not a connection"),
        };
        assert_eq!(err.code, exit_code::APP_NOT_RUNNING);
        assert!(err.message.contains("TERMIC_SOCKET"));
        assert!(start.elapsed() < Duration::from_secs(2), "debug must not launch+poll");
    }

    #[test]
    fn ok_reply_yields_data() {
        let data = reply_to_result(Reply::ok(
            "1",
            ReplyData::Open(proto::OpenData { task: None, raised: true }),
        ))
        .unwrap();
        assert!(matches!(data, ReplyData::Open(_)));
    }
}
