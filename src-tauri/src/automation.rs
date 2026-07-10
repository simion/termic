//! Dev-only automation bridge: lets an agent (or a script) drive the live
//! app over localhost HTTP — eval JS in the webview, screenshot the
//! window, quit. Built for agent-driven E2E verification of the real app
//! (tauri-driver has no macOS support; this is the house equivalent).
//!
//! Armed ONLY when BOTH hold:
//!   - debug build (`cfg!(debug_assertions)`), and
//!   - `TERMIC_AUTOMATION=1` in the environment.
//! Release builds compile the module but everything refuses to run.
//!
//! Surface (all requests need the token: `?t=<token>` or
//! `X-Automation-Token: <token>`; the token + port are printed to the
//! debug log on startup):
//!   GET  /info        → app/version/pid/data-dir/window-rect JSON.
//!   POST /eval        → body = JS, the body of an async function (use
//!                       `return` for a result). Runs in the main webview;
//!                       responds {ok, value} JSON. `window.__termic`
//!                       (main.tsx, dev-only) exposes the stores + ipc.
//!   GET  /screenshot  → focuses the window, captures its rect via
//!                       `screencapture -R`, responds image/png.
//!   POST /raise       → ?on=1 floats the window above everything
//!                       (always-on-top + focus), ?on=0 drops it back.
//!                       Needed because WKWebView throttles rAF in fully
//!                       occluded windows - PTY spawn flows await a
//!                       double-rAF and stall until the window is visible.
//!                       TCC-free, unlike AppleScript activation.
//!   POST /quit        → app.exit(0).
//!
//! Results come back from the webview through the `automation_result`
//! Tauri command (eval is fire-and-forget; the injected wrapper invokes
//! the command with a correlation id that resolves a waiting channel).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::Manager;

use crate::dlog;

/// Bridge enabled? Debug build + explicit env opt-in.
pub fn armed() -> bool {
    cfg!(debug_assertions) && std::env::var("TERMIC_AUTOMATION").map(|v| v == "1").unwrap_or(false)
}

/// Frontend probe: is this instance being driven by the e2e automation
/// bridge? Drives the red E2E pill so an automated run is never mistaken
/// for a normal dev window. Always false in release builds.
#[tauri::command]
pub fn automation_armed() -> bool {
    armed()
}

fn token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        std::env::var("TERMIC_AUTOMATION_TOKEN")
            .ok()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string())
    })
}

/// Pending /eval calls: correlation id → channel the HTTP thread blocks on.
fn pending() -> &'static Mutex<HashMap<String, mpsc::SyncSender<String>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, mpsc::SyncSender<String>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Callback target for the injected eval wrapper. Rejects when the bridge
/// isn't armed so a release build (or an unarmed dev run) exposes nothing.
#[tauri::command]
pub fn automation_result(id: String, payload: String) -> Result<(), String> {
    if !armed() {
        return Err("automation bridge is not armed".into());
    }
    if let Some(tx) = pending().lock().unwrap().remove(&id) {
        let _ = tx.send(payload);
    }
    Ok(())
}

/// Start the bridge (no-op unless armed). Called from the app setup hook
/// once the main window exists.
pub fn start(app: tauri::AppHandle) {
    if !armed() {
        return;
    }
    let port: u16 = std::env::var("TERMIC_AUTOMATION_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            dlog(&format!("[automation] bind failed: {e}"));
            return;
        }
    };
    let addr = listener.local_addr().map(|a| a.to_string()).unwrap_or_default();
    // The launch script greps the debug log for this exact line.
    dlog(&format!("[automation] listening on {addr} token={}", token()));

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, app);
            });
        }
    });
}

fn handle(stream: TcpStream, app: tauri::AppHandle) -> std::io::Result<()> {
    // A client that connects and never finishes its request must not pin
    // this thread forever. Only request *reading* races the clock; long
    // evals respond after reading and are unaffected.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };

    // Headers: keep Content-Length + the token header.
    let mut content_len = 0usize;
    let mut header_token = String::new();
    loop {
        let mut h = String::new();
        reader.read_line(&mut h)?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            let k = k.trim().to_ascii_lowercase();
            let v = v.trim();
            if k == "content-length" {
                content_len = v.parse().unwrap_or(0);
            } else if k == "x-automation-token" {
                header_token = v.to_string();
            }
        }
    }
    // Reject oversized bodies outright: silently truncating a script at
    // 4MB would hand the webview half a program, which fails as a parse
    // error and reads like a mystery timeout to the driver.
    if content_len > 4 * 1024 * 1024 {
        return respond(stream, 413, "text/plain", b"body too large (4MB max)");
    }
    let mut body = vec![0u8; content_len];
    if !body.is_empty() {
        reader.read_exact(&mut body)?;
    }

    let query_token = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("t="))
        .unwrap_or("");
    if header_token != token() && query_token != token() {
        return respond(stream, 401, "text/plain", b"bad or missing token");
    }

    match (method.as_str(), path.as_str()) {
        ("GET", "/info") => {
            let win = app.get_webview_window("main");
            let rect = win.as_ref().map(|w| {
                let pos = w.outer_position().unwrap_or(tauri::PhysicalPosition::new(0, 0));
                let size = w.outer_size().unwrap_or(tauri::PhysicalSize::new(0, 0));
                let scale = w.scale_factor().unwrap_or(1.0);
                serde_json::json!({
                    "x": pos.x, "y": pos.y,
                    "w": size.width, "h": size.height,
                    "scale": scale,
                })
            });
            let info = serde_json::json!({
                "app": "termic",
                "version": env!("CARGO_PKG_VERSION"),
                "pid": std::process::id(),
                "data_dir": crate::data_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                "window": rect,
            });
            respond(stream, 200, "application/json", info.to_string().as_bytes())
        }

        ("POST", "/eval") => {
            let js = String::from_utf8_lossy(&body).into_owned();
            let timeout_ms: u64 = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("timeout_ms="))
                .and_then(|v| v.parse().ok())
                .unwrap_or(15_000);
            match eval_in_webview(&app, &js, timeout_ms) {
                Ok(payload) => respond(stream, 200, "application/json", payload.as_bytes()),
                Err(e) => respond(stream, 500, "text/plain", e.as_bytes()),
            }
        }

        ("GET", "/screenshot") => match screenshot(&app) {
            Ok(png) => respond(stream, 200, "image/png", &png),
            Err(e) => respond(stream, 500, "text/plain", e.as_bytes()),
        },

        ("POST", "/raise") => {
            let on = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("on="))
                .map(|v| v != "0")
                .unwrap_or(true);
            match app.get_webview_window("main") {
                Some(win) => {
                    let _ = win.unminimize();
                    // All-Spaces visibility matters as much as z-order:
                    // the driver's user is often on a DIFFERENT macOS Space
                    // where an always-on-top window still reports
                    // document.visibilityState=hidden and rAF stays frozen.
                    let _ = win.set_visible_on_all_workspaces(on);
                    let _ = win.set_always_on_top(on);
                    // And the Space the user is on may be a FULLSCREEN one,
                    // which all-Spaces windows still don't join without
                    // NSWindowCollectionBehaviorFullScreenAuxiliary. Raw
                    // AppKit call - main thread only.
                    #[cfg(target_os = "macos")]
                    {
                        let w2 = win.clone();
                        let _ = win.run_on_main_thread(move || {
                            use objc2::msg_send;
                            use objc2::runtime::{AnyObject, Bool};
                            use objc2::class;
                            if let Ok(ns) = w2.ns_window() {
                                let ns = ns as *mut AnyObject;
                                if !ns.is_null() {
                                    // canJoinAllSpaces (1<<0) | fullScreenAuxiliary (1<<8).
                                    let behavior: usize = if on { (1 << 0) | (1 << 8) } else { 0 };
                                    // SAFETY: main thread (run_on_main_thread), live
                                    // NSWindow owned by tao, public setter.
                                    unsafe {
                                        let _: () = msg_send![ns, setCollectionBehavior: behavior];
                                    }
                                }
                            }
                            if on {
                                // Window-level set_focus is NOT app activation:
                                // an inactive app's windows can stay behind the
                                // active app (and Stage Manager parks them
                                // offscreen entirely, where WKWebView reports
                                // visibilityState=hidden and rAF freezes).
                                // SAFETY: main thread; NSApplication is a
                                // well-known singleton; public method.
                                unsafe {
                                    let nsapp: *mut AnyObject =
                                        msg_send![class!(NSApplication), sharedApplication];
                                    if !nsapp.is_null() {
                                        let _: () = msg_send![nsapp, activateIgnoringOtherApps: Bool::YES];
                                    }
                                }
                            }
                        });
                    }
                    if on {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                    respond(stream, 200, "application/json",
                        format!("{{\"always_on_top\":{on}}}").as_bytes())
                }
                None => respond(stream, 500, "text/plain", b"no main window"),
            }
        }

        ("POST", "/quit") => {
            let _ = respond(stream, 200, "text/plain", b"bye");
            app.exit(0);
            Ok(())
        }

        _ => respond(stream, 404, "text/plain", b"unknown route"),
    }
}

/// Run `js` (the body of an async function) in the main webview and wait
/// for the wrapper to call back through `automation_result`.
fn eval_in_webview(app: &tauri::AppHandle, js: &str, timeout_ms: u64) -> Result<String, String> {
    let win = app
        .get_webview_window("main")
        .ok_or("no main window")?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = mpsc::sync_channel::<String>(1);
    pending().lock().unwrap().insert(id.clone(), tx);

    // The user script becomes the body of an async function: `return`
    // produces the JSON value of the call. The script is passed as a JSON
    // string literal and compiled via the AsyncFunction constructor inside
    // a try/catch - NOT spliced into the wrapper source - so a syntax
    // error comes back as {ok:false} immediately instead of killing the
    // whole injected script at parse time (which would leave the channel
    // hanging until the timeout). It also means no script content can
    // unbalance the wrapper.
    let js_lit = serde_json::Value::String(js.to_string()).to_string();
    let wrapped = format!(
        r#"(() => {{
            const __send = (ok, value) => {{
                window.__TAURI_INTERNALS__.invoke('automation_result', {{
                    id: '{id}',
                    payload: JSON.stringify({{ ok, value }}),
                }}).catch(() => {{}});
            }};
            // String(e) carries "SyntaxError: <message>"; WebKit's .stack
            // does NOT repeat the message, so concatenate both.
            const __err = e => String(e) + ((e && e.stack) ? '\n' + e.stack : '');
            let __fn;
            try {{
                const __AF = Object.getPrototypeOf(async function () {{}}).constructor;
                __fn = new __AF({js_lit});
            }} catch (e) {{
                __send(false, __err(e));
                return;
            }}
            Promise.resolve().then(async () => {{
                const __r = await __fn();
                let __v = null;
                try {{ __v = __r === undefined ? null : JSON.parse(JSON.stringify(__r)); }}
                catch {{ __v = String(__r); }}
                __send(true, __v);
            }}).catch(e => __send(false, __err(e)));
        }})();"#
    );
    if let Err(e) = win.eval(&wrapped) {
        // Without this, a failed eval would strand the correlation id in
        // the pending map forever (the webview never calls back).
        pending().lock().unwrap().remove(&id);
        return Err(format!("eval failed: {e}"));
    }

    match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(payload) => Ok(payload),
        Err(_) => {
            pending().lock().unwrap().remove(&id);
            Err(format!("eval timed out after {timeout_ms}ms (script never resolved)"))
        }
    }
}

/// Focus the window and capture its rect with `screencapture -R` (logical
/// points - physical pixels divided by the scale factor). Rect capture
/// grabs whatever is on screen in that area, hence the focus-first.
fn screenshot(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    let win = app
        .get_webview_window("main")
        .ok_or("no main window")?;
    let _ = win.set_focus();
    std::thread::sleep(Duration::from_millis(250));

    let pos = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let (x, y) = (pos.x as f64 / scale, pos.y as f64 / scale);
    let (w, h) = (size.width as f64 / scale, size.height as f64 / scale);

    let out = std::env::temp_dir().join(format!("termic-automation-{}.png", std::process::id()));
    let status = std::process::Command::new("screencapture")
        .args([
            "-x",
            "-R",
            &format!("{x:.0},{y:.0},{w:.0},{h:.0}"),
            &out.to_string_lossy(),
        ])
        .status()
        .map_err(|e| format!("screencapture failed to start: {e}"))?;
    if !status.success() {
        return Err("screencapture failed (Screen Recording permission?)".into());
    }
    let png = std::fs::read(&out).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&out);
    Ok(png)
}

fn respond(mut stream: TcpStream, status: u16, ctype: &str, body: &[u8]) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}
