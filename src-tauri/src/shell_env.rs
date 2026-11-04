//! Resolve the user's login-shell environment.
//!
//! GUI-launched .app bundles on macOS inherit a bare env from launchd:
//! a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) and none of the
//! variables the user exports from their shell rc. So anything we spawn
//! directly (the agent CLIs, scratch terminals, setup/run scripts) is
//! missing the user's real world:
//!   - PATH — `claude`/`codex` in `~/.local/bin`, nvm/bun shims, etc.
//!     are invisible ("env: claude: No such file or directory", #13/#16).
//!   - EDITOR/VISUAL — Claude Code's Ctrl+G opens the wrong editor (#17).
//!   - LANG, GPG_TTY, tool tokens, … — anything else the rc exports.
//!
//! Fix: shell out to `$SHELL -ilc env`, diff it against our own (bare)
//! env, and inject the delta into everything we spawn. `-l` runs the
//! login profile (`.zprofile`), `-i` runs the interactive rc (`.zshrc`)
//! — both are needed because dynamic installers (nvm, mise, fnm, asdf,
//! bun) typically write to `.zshrc`. Diffing against our own env drops
//! inherited launchd noise (XPC_SERVICE_NAME, …) for free: unchanged
//! keys aren't in the delta.
//!
//! Lifecycle (#186): readers NEVER block on the probe (beyond a bounded
//! 1s courtesy wait while the very first attempt is still in flight, so
//! launch-restored terminals usually get the real env). The state starts
//! as the static fallback and is atomically swapped to the probed env
//! when a probe succeeds. A failed probe is NOT cached forever: the
//! startup loop retries with backoff, and after it gives up, any later
//! read may kick one more background attempt (cooldown-limited), so a
//! transiently slow rc heals without an app restart.
//!
//! VS Code, Cursor, Zed, GitHub Desktop all do the same thing for the
//! same reason. See e.g. microsoft/vscode `shellEnv.ts`.
use std::collections::HashMap;
#[cfg(not(windows))]
use std::process::Stdio;
use std::sync::{Condvar, Mutex, Once, OnceLock};
use std::time::{Duration, Instant};

/// Per-probe deadline. The probe runs off-thread, so this protects
/// nothing at startup — it only bounds how long a single shell gets
/// before we give up on that attempt and schedule a retry. Generous on
/// purpose (VS Code uses 10s): a cold rc at login can legitimately take
/// seconds, and cutting it off used to mean permanent fallback (#186).
#[cfg(not(windows))]
const PROBE_DEADLINE: Duration = Duration::from_secs(10);

/// How long a reader may wait for the FIRST probe attempt before
/// settling for the fallback env. Only ever paid while that first
/// attempt is in flight (typically the first ~0.5s of app life), so
/// launch-restored terminals get the real env instead of racing it.
const FIRST_PROBE_WAIT: Duration = Duration::from_secs(1);

/// Startup retry schedule: TOTAL probe attempts (the first try plus
/// retries), with the backoff doubling between them (2s, 4s, 8s, 16s).
const MAX_STARTUP_ATTEMPTS: u32 = 5;
const FIRST_BACKOFF: Duration = Duration::from_secs(2);

/// After the startup loop exhausts its attempts, a read may kick one
/// more background attempt — but at most once per this cooldown, so
/// frequent spawns against a genuinely broken shell don't fork-bomb it.
const RETRY_COOLDOWN: Duration = Duration::from_secs(30);

/// Hard cap on read-kicked retries, so a permanently broken shell costs
/// a BOUNDED number of probe spawns over the app's lifetime (startup
/// attempts + this) instead of one every cooldown forever.
const MAX_KICKED_RETRIES: u32 = 10;

static STATE: OnceLock<State> = OnceLock::new();
static PROBE_STARTED: Once = Once::new();
static RESOLVED_SHELL: OnceLock<String> = OnceLock::new();
static FALLBACK_DIRS: OnceLock<Vec<String>> = OnceLock::new();
static HEALED_HOOK: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

/// Run `f` once if the login env lands AFTER some reader was already handed
/// the fallback. Whatever that reader decided (CLI detection marking an
/// nvm-installed agent as missing, GH #441) was decided on the wrong PATH and
/// nothing else would ever ask again. First call wins.
pub fn on_healed(f: impl Fn() + Send + Sync + 'static) {
    let _ = HEALED_HOOK.set(Box::new(f));
}

/// The login-shell environment as currently known — the fallback until
/// a probe succeeds, the real thing after.
#[derive(Default, Clone, Debug, PartialEq)]
struct LoginEnv {
    /// PATH suitable for finding user-installed CLIs (login-shell PATH,
    /// or a best-effort fallback until a probe succeeds). Kept as its
    /// own field because PATH has fallback logic the other vars don't.
    path: String,
    /// Every OTHER variable the login shell exports that our bare env
    /// doesn't already have with the same value — the delta to inject
    /// into spawned children. Excludes PATH (use `path`) and the
    /// terminal-identity / bookkeeping vars we manage ourselves.
    inject: Vec<(String, String)>,
}

/// Probe bookkeeping guarded by one mutex. `env` is always readable
/// (initialized to the fallback before the first probe starts).
struct Inner {
    env: LoginEnv,
    /// The first probe attempt has finished (success OR failure).
    /// Once true, readers never wait again.
    first_attempt_done: bool,
    /// A probe attempt succeeded; `env` is the real login env and no
    /// further probing will ever run.
    succeeded: bool,
    /// A probe attempt (or the startup retry loop, including its
    /// backoff sleeps) is currently active — gates read-kicked retries.
    probing: bool,
    /// When the last attempt finished — cooldown anchor for read-kicked
    /// retries.
    last_attempt: Option<Instant>,
    /// How many read-kicked retries have run, capped at
    /// `MAX_KICKED_RETRIES` so probing is bounded over the app's life.
    kicked_retries: u32,
    /// A reader got the fallback env (the probe had not succeeded yet).
    served_fallback: bool,
    /// Times a success landed after `served_fallback`; only ever 0 or 1.
    heals: u32,
}

struct State {
    inner: Mutex<Inner>,
    cvar: Condvar,
}

impl State {
    fn new(initial: LoginEnv) -> Self {
        State {
            inner: Mutex::new(Inner {
                env: initial,
                first_attempt_done: false,
                succeeded: false,
                probing: false,
                last_attempt: None,
                kicked_retries: 0,
                served_fallback: false,
                heals: 0,
            }),
            cvar: Condvar::new(),
        }
    }

    /// Current env, waiting at most `max_wait` for the FIRST attempt to
    /// finish. After that attempt (either way) this never blocks.
    /// Production reads go through `snapshot_final`; this is the
    /// env-only view the tests assert on.
    #[cfg(test)]
    fn snapshot(&self, max_wait: Duration) -> LoginEnv {
        self.snapshot_final(max_wait).0
    }

    /// `snapshot` plus whether the env came from a SUCCEEDED probe, read
    /// under the SAME lock. Two separate calls could straddle a probe
    /// landing and pair a fallback env with `final = true`, which is the
    /// one combination a memoizing caller must never see.
    fn snapshot_final(&self, max_wait: Duration) -> (LoginEnv, bool) {
        let mut guard = self.inner.lock().unwrap();
        if !guard.first_attempt_done && !max_wait.is_zero() {
            guard = self
                .cvar
                .wait_timeout_while(guard, max_wait, |i| !i.first_attempt_done)
                .unwrap()
                .0;
        }
        if !guard.succeeded { guard.served_fallback = true; }
        (guard.env.clone(), guard.succeeded)
    }

    /// Record a finished probe attempt. `resolved` is `Some` on success
    /// (the env to swap in). `still_probing` keeps the probing flag up
    /// through the startup loop's backoff sleeps so read-kicked retries
    /// don't stack a second shell on top. Returns whether a probe has
    /// succeeded. Wakes any first-attempt waiters either way.
    fn attempt_finished(&self, resolved: Option<LoginEnv>, still_probing: bool) -> bool {
        let mut guard = self.inner.lock().unwrap();
        guard.first_attempt_done = true;
        guard.last_attempt = Some(Instant::now());
        let healed = resolved.is_some() && !guard.succeeded && guard.served_fallback;
        if let Some(env) = resolved {
            guard.env = env;
            guard.succeeded = true;
            guard.probing = false;
        } else {
            guard.probing = still_probing;
        }
        if healed { guard.heals += 1; }
        self.cvar.notify_all();
        let succeeded = guard.succeeded;
        drop(guard);
        // Outside the lock: the hook may read the env itself.
        if healed { if let Some(f) = HEALED_HOOK.get() { f(); } }
        succeeded
    }

    /// Whether a read-kicked retry should run now: never after success,
    /// never while one is in flight, at most once per `cooldown`, and
    /// at most `max_kicks` times ever (so probing is bounded over the
    /// app's lifetime, not a shell spawn every cooldown forever). On
    /// `true` the probing flag is taken — the caller MUST run an
    /// attempt and report it via `attempt_finished`.
    fn try_begin_retry(&self, cooldown: Duration, max_kicks: u32) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if guard.succeeded || guard.probing || !guard.first_attempt_done {
            return false;
        }
        if guard.kicked_retries >= max_kicks {
            return false;
        }
        if let Some(t) = guard.last_attempt {
            if t.elapsed() < cooldown {
                return false;
            }
        }
        guard.kicked_retries += 1;
        guard.probing = true;
        true
    }

    /// Report a probe attempt that never ran (the probe thread died or
    /// could not be spawned). Poison-tolerant: this is called from a
    /// panic path, and a poisoned lock must not turn into a double
    /// panic (abort). Readers stop waiting and the retry gate opens.
    fn attempt_aborted(&self) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.first_attempt_done = true;
        guard.last_attempt = Some(Instant::now());
        guard.probing = false;
        self.cvar.notify_all();
    }
}

fn state() -> &'static State {
    STATE.get_or_init(|| State::new(bare_login_env()))
}

/// Marks the attempt aborted if the probe thread unwinds before
/// reporting — otherwise a panic mid-probe would leave `probing` stuck
/// and every read waiting out `FIRST_PROBE_WAIT` for the app's life.
struct AbortGuard {
    armed: bool,
}

impl Drop for AbortGuard {
    fn drop(&mut self) {
        if self.armed {
            state().attempt_aborted();
        }
    }
}

/// Run `probe` on a background thread, reporting an aborted attempt if
/// the thread can't be spawned or dies before reporting, so readers
/// never wait on a probe that will never finish.
fn spawn_probe_thread(probe: impl FnOnce() + Send + 'static) {
    let spawned = std::thread::Builder::new()
        .name("shell-env-probe".into())
        .spawn(move || {
            let mut guard = AbortGuard { armed: true };
            probe();
            guard.armed = false;
        });
    if spawned.is_err() {
        state().attempt_aborted();
    }
}

/// Start the background probe (idempotent). Readers call this too, so
/// the env resolves even if `warm()` was never reached.
fn ensure_probe_started() {
    PROBE_STARTED.call_once(|| {
        state().inner.lock().unwrap().probing = true;
        spawn_probe_thread(|| {
            run_probe_loop(
                state(),
                probe_once,
                std::thread::sleep,
                MAX_STARTUP_ATTEMPTS,
                FIRST_BACKOFF,
            );
        });
    });
}

/// Trigger resolution off the main thread so the first PTY spawn
/// doesn't pay the shell-startup cost.
pub fn warm() {
    ensure_probe_started();
}

fn current_env() -> LoginEnv {
    current_env_final().0
}

fn current_env_final() -> (LoginEnv, bool) {
    // Windows: the PATH as the system has it NOW, not as it was when the app
    // started. There is no login shell to probe there (probe_once), so the
    // inherited PATH was the answer for the whole session, and a tool
    // installed while Termic ran (Git, an agent CLI) stayed invisible until
    // a restart: a Windows tester's repo was refused as "not a git repo"
    // for exactly that reason. Two registry reads, microseconds each.
    if cfg!(windows) {
        return (LoginEnv { path: windows_live_path(), inject: Vec::new() }, true);
    }
    ensure_probe_started();
    let st = state();
    let env = st.snapshot_final(FIRST_PROBE_WAIT);
    // Startup retries exhausted without success? Let actual usage kick
    // one more background attempt (cooldown- and count-limited) so a
    // slow login eventually heals instead of pinning the fallback until
    // restart.
    if st.try_begin_retry(RETRY_COOLDOWN, MAX_KICKED_RETRIES) {
        spawn_probe_thread(|| {
            let resolved = probe_once();
            state().attempt_finished(resolved, false);
        });
    }
    env
}

/// Return a PATH suitable for spawning user-installed CLIs. Never
/// blocks once the first probe attempt has finished; until a probe
/// succeeds this is the static fallback. For a spawn that also injects
/// the rc delta, use `spawn_env()` — two separate calls can straddle
/// the probe landing and mix snapshots.
pub fn resolved_path() -> String {
    current_env().path
}

/// PATH plus whether it came from a SUCCEEDED probe, from one snapshot.
///
/// For callers that MEMOIZE a decision derived from PATH. The static
/// fallback has no Homebrew/nvm/bun dirs, so "this tool isn't installed"
/// computed from it is not an answer worth keeping: cache it and the
/// wrong verdict outlives the probe for the whole session (GH #181, the
/// find-in-files backend). `false` means "ask again later".
pub fn resolved_path_final() -> (String, bool) {
    let (env, resolved) = current_env_final();
    (env.path, resolved)
}

/// PATH plus the rc delta, from ONE snapshot. The delta is the user's
/// login-shell environment MINUS PATH and the vars we manage ourselves
/// — i.e. EDITOR/VISUAL/LANG/GPG_TTY/tool-tokens/etc. that the rc
/// exports but a GUI-launched `.app` never inherits. Inject both into
/// anything we spawn so the agent, scratch terminal, and scripts all
/// see the same environment the user's own terminal would (#17, and
/// the general class behind #13/#16). The single snapshot matters
/// twice: the pair can't tear across the probe landing (fallback PATH
/// with probed delta), and a spawn pays the bounded first-probe wait
/// once, not per accessor. Delta is empty until a probe succeeds.
pub fn spawn_env() -> (String, Vec<(String, String)>) {
    let env = current_env();
    (env.path, env.inject)
}

/// Absolute path to the user's preferred login shell, used to spawn
/// interactive terminals (scratch shells, custom-command tabs).
///
/// Preference order: the account's configured login shell (from the
/// passwd database, like Terminal.app / iTerm use), then `$SHELL`, then
/// the first of zsh → bash → fish → sh present on this machine. The
/// passwd shell comes FIRST on purpose: `$SHELL` is frozen at login by
/// launchd for GUI apps, so after a `chsh` it stays stale until the user
/// logs out (they'd report "I switched to bash but terminals still open
/// zsh"). The passwd entry reflects `chsh` immediately. termic also used
/// to hard-code `zsh`, locking out users without it (issue #13). Cached
/// after the first call.
pub fn login_shell() -> String {
    RESOLVED_SHELL
        .get_or_init(|| {
            #[cfg(windows)]
            return windows_shell();
            #[cfg(not(windows))]
            {
                let preferred = passwd_shell().or_else(|| std::env::var("SHELL").ok());
                pick_shell(preferred, |p| std::path::Path::new(p).exists())
            }
        })
        .clone()
}

/// Windows has no passwd shell. PowerShell 7 (`pwsh`) when installed, as
/// Windows Terminal defaults to, then the inbox Windows PowerShell, then
/// `%COMSPEC%` (cmd.exe), which always exists.
#[cfg(windows)]
fn windows_shell() -> String {
    if let Some(p) = which_in("pwsh", &std::env::var("PATH").unwrap_or_default()) {
        return p.to_string_lossy().into_owned();
    }
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let ps = std::path::Path::new(&root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    if ps.is_file() {
        return ps.to_string_lossy().into_owned();
    }
    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
}

/// The current user's login shell from the passwd database
/// (`getpwuid(getuid())->pw_shell`). Reflects `chsh` without needing a
/// re-login, unlike `$SHELL`. `None` if unavailable or empty.
#[cfg(unix)]
fn passwd_shell() -> Option<String> {
    use std::ffi::CStr;
    // SAFETY: getpwuid returns a pointer into a static buffer owned by
    // libc; we copy pw_shell out immediately and never retain the
    // pointer. Called once (cached), so the static-buffer reuse that
    // makes getpwuid non-reentrant doesn't matter here.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() {
            return None;
        }
        let s = CStr::from_ptr((*pw).pw_shell).to_str().ok()?.to_string();
        (!s.is_empty()).then_some(s)
    }
}

/// Pure shell-selection logic, factored out for testability. `exists`
/// is the disk probe (real `Path::exists` in production, a stub in
/// tests). Prefers the given `preferred` shell when set and present,
/// else the first known-good interpreter found, else `/bin/sh` as a
/// last resort (POSIX guarantees it).
#[cfg_attr(windows, allow(dead_code))]
fn pick_shell(preferred: Option<String>, exists: impl Fn(&str) -> bool) -> String {
    if let Some(s) = preferred {
        if !s.is_empty() && exists(&s) {
            return s;
        }
    }
    const CANDIDATES: &[&str] = &[
        "/bin/zsh",
        "/usr/bin/zsh",
        "/bin/bash",
        "/usr/bin/bash",
        "/opt/homebrew/bin/bash",
        "/opt/homebrew/bin/fish",
        "/usr/local/bin/fish",
        "/usr/bin/fish",
        "/bin/sh",
    ];
    for cand in CANDIDATES {
        if exists(cand) {
            return (*cand).to_string();
        }
    }
    "/bin/sh".to_string()
}

/// The startup probe loop: attempt, and on failure retry with doubling
/// backoff until `max_attempts` is spent. Injected `probe`/`sleep` keep
/// the schedule unit-testable without spawning shells or waiting.
fn run_probe_loop(
    st: &State,
    mut probe: impl FnMut() -> Option<LoginEnv>,
    mut sleep: impl FnMut(Duration),
    max_attempts: u32,
    first_backoff: Duration,
) {
    let mut backoff = first_backoff;
    for attempt in 1..=max_attempts {
        let last = attempt == max_attempts;
        if st.attempt_finished(probe(), !last) {
            return;
        }
        if last {
            return;
        }
        sleep(backoff);
        backoff = backoff.saturating_mul(2);
    }
}

/// PATH from the registry as it is now (machine, then user, with
/// `%VARS%` expanded), then whatever the inherited PATH adds on top (a
/// launcher's own entries). Each directory once, compared without case.
fn windows_live_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    #[cfg(not(windows))]
    fn windows_registry_path(_machine: bool) -> Option<String> { None }
    let known = windows_known_tool_dirs(&|k| std::env::var(k).ok())
        .into_iter()
        .filter(|d| std::path::Path::new(d).is_dir())
        .collect::<Vec<_>>()
        .join(";");
    merge_path_lists(&[
        &windows_registry_path(true).unwrap_or_default(),
        &windows_registry_path(false).unwrap_or_default(),
        &inherited,
        &known,
    ])
}

/// Where Windows installers put agent CLIs without always adding the folder
/// to PATH, searched after PATH itself. Claude Code's PowerShell installer
/// puts `claude.exe` in `%USERPROFILE%\.local\bin`; with that folder missing
/// from the PATH Termic sees, every claude spawn failed with "cannot find
/// the file" (seen by a Windows tester). The rest are npm, bun, cargo,
/// winget and scoop's own bins. The Windows counterpart of
/// `fallback_extras`.
fn windows_known_tool_dirs(env: &dyn Fn(&str) -> Option<String>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(home) = env("USERPROFILE").filter(|v| !v.is_empty()) {
        for rel in [r".local\bin", r".bun\bin", r".cargo\bin", r"scoop\shims"] {
            out.push(format!("{home}\\{rel}"));
        }
    }
    if let Some(appdata) = env("APPDATA").filter(|v| !v.is_empty()) {
        out.push(format!("{appdata}\\npm"));
    }
    if let Some(local) = env("LOCALAPPDATA").filter(|v| !v.is_empty()) {
        out.push(format!(r"{local}\Microsoft\WinGet\Links"));
    }
    out
}

/// The `Path` value of the machine (`HKLM`) or user (`HKCU`) environment,
/// expanded. `None` when it is missing or unreadable.
#[cfg(windows)]
fn windows_registry_path(machine: bool) -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
    };
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (root, key) = if machine {
        (HKEY_LOCAL_MACHINE, wide(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"))
    } else {
        (HKEY_CURRENT_USER, wide("Environment"))
    };
    let name = wide("Path");
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
    let mut size: u32 = 0;
    // SAFETY: a size query (null buffer) on NUL-terminated wide strings.
    let rc = unsafe {
        RegGetValueW(root, key.as_ptr(), name.as_ptr(), flags, std::ptr::null_mut(), std::ptr::null_mut(), &mut size)
    };
    if rc != 0 || size == 0 {
        return None;
    }
    let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
    let mut len = (buf.len() * 2) as u32;
    // SAFETY: `buf` holds `len` bytes; RegGetValueW writes at most that and
    // expands REG_EXPAND_SZ (no RRF_NOEXPAND).
    let rc = unsafe {
        RegGetValueW(root, key.as_ptr(), name.as_ptr(), flags, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut len)
    };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end]))
}

/// `;`-separated PATH lists joined in order, each directory kept once
/// (Windows paths compare without case, and a trailing `\` is the same dir).
fn merge_path_lists(lists: &[&str]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<&str> = Vec::new();
    for list in lists {
        for dir in list.split(';').map(str::trim).filter(|d| !d.is_empty()) {
            if seen.insert(dir.trim_end_matches(['\\', '/']).to_ascii_lowercase()) {
                out.push(dir);
            }
        }
    }
    out.join(";")
}

/// One full probe attempt: run the shell, and on success turn its env
/// dump into the `LoginEnv` to swap in. `None` on timeout/failure/empty.
fn probe_once() -> Option<LoginEnv> {
    // Windows has no login shell whose rc files hold the real PATH: a GUI
    // app inherits the registry-backed user + machine PATH from Explorer,
    // which re-reads it whenever an installer broadcasts the change. So
    // the inherited environment IS the resolved one, and "probing" it is
    // instant and cannot fail. (Spawning `/bin/sh -ilc env` here would
    // fail every time and pin the static fallback for the whole session.)
    #[cfg(windows)]
    return Some(LoginEnv { path: std::env::var("PATH").unwrap_or_default(), inject: Vec::new() });
    #[cfg(not(windows))]
    {
        let probed = probe_login_shell().filter(|v| !v.is_empty())?;
        Some(env_from_probe(&probed))
    }
}

/// The env served before any probe succeeds: the inherited PATH from a
/// terminal launch, or the static fallback union for a GUI launch. No
/// rc delta — we haven't seen the rc yet.
fn bare_login_env() -> LoginEnv {
    // Minus an AppImage's own bin dir, which AppRun puts first: it holds the
    // app binary under the name the CLI is installed as.
    let bare_path = crate::appimage_env::host_var("PATH").unwrap_or_default();
    let from_terminal = std::env::var("TERM_PROGRAM").is_ok();
    let path = if from_terminal && !bare_path.is_empty() {
        bare_path
    } else {
        fallback_path(&bare_path)
    };
    LoginEnv { path, inject: Vec::new() }
}

/// Build the resolved env from a successful probe's `env` dump.
#[cfg(not(windows))]
fn env_from_probe(probed: &[(String, String)]) -> LoginEnv {
    let current: HashMap<String, String> = std::env::vars().collect();
    let bare_path = current.get("PATH").cloned().unwrap_or_default();
    // TERM_PROGRAM (set by Terminal.app, iTerm2, Ghostty, WezTerm, …) means
    // we were launched from a real terminal, so the inherited env is the
    // user's live session.
    let from_terminal = std::env::var("TERM_PROGRAM").is_ok();

    // PATH: a terminal launch already inherited the full login PATH (and may
    // carry session-specific additions), so keep it. A GUI launch gets a bare
    // launchd PATH → use the probed one, or the static fallback.
    let path = if from_terminal && !bare_path.is_empty() {
        bare_path.clone()
    } else {
        probed
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.clone())
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| fallback_path(&bare_path))
    };

    // Inject the rc delta. From a terminal the session is authoritative, so
    // only FILL gaps (never override a var the user set in that session);
    // from a GUI launch the bare env has no authority, so also override
    // differing values (e.g. launchd's LANG=C → your rc's en_US.UTF-8).
    let inject = select_injected(probed, &current, from_terminal);

    LoginEnv { path, inject }
}

/// From the probed login env, keep only what's worth injecting into a
/// child: drop PATH (handled separately, with fallback), drop the vars we
/// manage ourselves or that are pure shell bookkeeping, and decide per the
/// `fill_only` flag whether to touch a var our own env already carries:
///   - `fill_only` (terminal launch): only add vars MISSING from our env;
///     never override a value the live session already set.
///   - otherwise (GUI launch): also override vars whose value DIFFERS, so a
///     bare launchd value (LANG=C, no EDITOR) loses to the rc's. Unchanged
///     vars (incl. inherited launchd noise like XPC_SERVICE_NAME) are
///     dropped either way. Pure for testing.
#[cfg_attr(windows, allow(dead_code))]
fn select_injected(
    probed: &[(String, String)],
    current: &HashMap<String, String>,
    fill_only: bool,
) -> Vec<(String, String)> {
    probed
        .iter()
        .filter(|(k, v)| {
            if k == "PATH" || is_managed(k) {
                return false;
            }
            match current.get(k.as_str()) {
                None => true,                        // missing → always add
                Some(cur) => !fill_only && cur != v, // present → override only outside fill_only
            }
        })
        .cloned()
        .collect()
}

/// Vars we must NOT carry from the probed login env: ones we set ourselves
/// per spawn (terminal identity), pure shell-session bookkeeping, and
/// per-shell activation state that would be wrong to FREEZE at startup and
/// force onto every task.
///
/// The venv/conda group is the important one: if the user's rc auto-activates
/// an environment, the one-time probe captures its `VIRTUAL_ENV` / `CONDA_*`,
/// and injecting that into every agent + setup/run script would point
/// `python`/`pip` at that single startup-time env regardless of the
/// task's own — a frozen-activation footgun. PATH already carries the
/// right bin dirs; we just drop the activation pointers so each task's
/// own activation (or lack of one) wins.
#[cfg_attr(windows, allow(dead_code))]
fn is_managed(key: &str) -> bool {
    matches!(
        key,
        "TERM" | "TERM_PROGRAM" | "TERM_PROGRAM_VERSION" | "COLORTERM" | "COLORFGBG"
            | "SHLVL" | "_" | "PWD" | "OLDPWD"
            | "VIRTUAL_ENV" | "VIRTUAL_ENV_PROMPT"
            | "CONDA_PREFIX" | "CONDA_DEFAULT_ENV" | "CONDA_PROMPT_MODIFIER" | "CONDA_SHLVL"
    )
}

#[cfg(not(windows))]
fn probe_login_shell() -> Option<Vec<(String, String)>> {
    // Probe the SAME shell we spawn terminals with — the account login
    // shell (reflects `chsh`), then `$SHELL`, then a last-resort scan. No
    // hardcoded zsh/bash here: whatever the user's shell is, we ask it.
    let shell = login_shell();

    let mut child = crate::proc_ctl::command(&shell)
        // `env` dumps the whole exported environment in one round-trip.
        .args(["-ilc", "env"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // Interactive shells print MOTDs and complain about non-tty
        // stdin. Drop it on the floor.
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // Drain stdout CONCURRENTLY with the wait below. Waiting first and
    // reading after deadlocks on any env dump bigger than the pipe
    // buffer (~64KB): the child blocks writing, we block waiting, and
    // the deadline kills a probe that was fine.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        stdout.read_to_end(&mut buf).ok();
        buf
    });

    // Bounded try_wait poll, not a condvar: Child has no waitable
    // handle. Total poll time over the app's life is bounded too —
    // probing stops at MAX_STARTUP_ATTEMPTS + MAX_KICKED_RETRIES
    // attempts (or the first success), so this never becomes the
    // app-lifetime sleep-poll CLAUDE.md bans.
    let deadline = Instant::now() + PROBE_DEADLINE;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                // Reap the killed child so it doesn't linger as a zombie
                // (the kill also EOFs stdout, releasing the reader).
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }

    let stdout = reader.join().ok()?;
    Some(parse_env_output(&String::from_utf8_lossy(&stdout)))
}

/// Parse `env`'s `KEY=VALUE` lines into pairs. Split out so the line
/// handling is unit-testable without spawning a shell. Only lines whose
/// key is a valid shell identifier are kept, which skips MOTD banner
/// junk and the trailing lines of any multi-line value (rare, and we'd
/// rather drop one than inject a garbage key). Values keep everything
/// after the first `=`, so `FOO=a=b` round-trips correctly.
#[cfg_attr(windows, allow(dead_code))]
fn parse_env_output(stdout: &str) -> Vec<(String, String)> {
    stdout
        .lines()
        .filter_map(|line| {
            let (k, v) = line.split_once('=')?;
            is_env_key(k).then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

/// A POSIX-ish env var name: leading letter/underscore, then
/// alphanumerics/underscores. Also used by the extra-named-ports
/// validator in lib.rs (GH #196).
pub(crate) fn is_env_key(k: &str) -> bool {
    let mut chars = k.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// No successful probe yet. Union the bare PATH with the well-known
/// dev-tool locations. Misses dynamic shims (nvm picks a node version
/// per shell), but covers the common static installers so at least
/// `claude`, `codex`, `gemini` resolve.
pub(crate) fn fallback_path(current: &str) -> String {
    let mut dirs: Vec<std::path::PathBuf> = path_dirs(current);
    for p in fallback_dirs() {
        let p = std::path::PathBuf::from(p);
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    join_path_dirs(&dirs)
}

/// The directories of a PATH-style list, in order, empties dropped. The
/// platform separator decides the split: `;` on Windows, where `:` is
/// part of every drive letter, `:` elsewhere. Every PATH walk in the app
/// goes through this rather than `split(':')`.
pub fn path_dirs(path: &str) -> Vec<std::path::PathBuf> {
    std::env::split_paths(path).filter(|p| !p.as_os_str().is_empty()).collect()
}

/// Inverse of `path_dirs`. An entry that cannot be represented (it
/// contains the separator itself) is dropped rather than corrupting the
/// whole list.
pub fn join_path_dirs(dirs: &[std::path::PathBuf]) -> String {
    let ok: Vec<&std::path::PathBuf> =
        dirs.iter().filter(|d| std::env::join_paths([d.as_path()]).is_ok()).collect();
    std::env::join_paths(ok)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The file names to try for a command `bin` inside one directory.
///
/// Unix: just `bin`. Windows: a bare name is resolved through PATHEXT
/// (`claude` -> `claude.exe`, `codex` -> `codex.cmd`), and the bare name
/// itself is NOT tried: npm writes an extensionless POSIX shell shim next
/// to every `.cmd` one, which exists but cannot be executed, so finding
/// it first would report an agent as installed and then fail to spawn
/// it. A name that already has an extension is tried as is.
pub fn exe_candidates(bin: &str) -> Vec<String> {
    if cfg!(windows) && std::path::Path::new(bin).extension().is_none() {
        let pathext = std::env::var("PATHEXT").unwrap_or_default();
        return exe_candidates_with(bin, &pathext);
    }
    vec![bin.to_string()]
}

/// Pure half of `exe_candidates`, so the Windows rule is tested on every
/// platform.
pub(crate) fn exe_candidates_with(bin: &str, pathext: &str) -> Vec<String> {
    let exts: Vec<String> = if pathext.trim().is_empty() {
        vec![".COM".into(), ".EXE".into(), ".BAT".into(), ".CMD".into()]
    } else {
        pathext.split(';').filter(|e| !e.is_empty()).map(str::to_string).collect()
    };
    exts.iter().map(|e| format!("{bin}{}", e.to_ascii_lowercase())).collect()
}

/// Whether `p` names something a PATH lookup should accept: a regular
/// file, and on unix one with an execute bit (a README that shares the
/// name is not a command).
pub fn is_executable_file(p: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// Resolve a command name against a PATH-style list: the first
/// directory holding an executable `bin` (or, on Windows, `bin` plus a
/// PATHEXT extension). The one PATH walk every lookup shares.
pub fn which_in(bin: &str, path: &str) -> Option<std::path::PathBuf> {
    let names = exe_candidates(bin);
    for dir in path_dirs(path) {
        for n in &names {
            let cand = dir.join(n);
            if is_executable_file(&cand) {
                return Some(cand);
            }
        }
    }
    None
}

/// The program a PTY should start for `cmd`, on Windows: a bare name
/// (no directory, no extension) resolved against `path` with PATHEXT, so
/// `pi` becomes `...\npm\pi.cmd`. portable-pty's own lookup tries the exact
/// name first in every directory, and npm installs an extensionless shell
/// shim next to each `.cmd`; it found that shim, and CreateProcess refused
/// it ("%1 is not a valid Win32 application"). Anything else, and every
/// name off Windows, is returned unchanged.
pub fn resolve_program(cmd: &str, path: &str) -> String {
    if !cfg!(windows)
        || cmd.contains(['/', '\\'])
        || std::path::Path::new(cmd).extension().is_some()
    {
        return cmd.to_string();
    }
    which_in(cmd, path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| cmd.to_string())
}

/// The bash that runs `.termic.yaml` setup / run / archive scripts and
/// agent session-capture commands (`bash -lc <script>`).
///
/// Unix: `bash` from PATH. Windows: Git for Windows' own bash, located
/// explicitly. A bare `bash` there is a trap: Git's installer puts only
/// `Git\cmd` on PATH, so the lookup falls through to
/// `System32\bash.exe`, which is the WSL launcher, and the script runs
/// inside a Linux distro (or fails with "no distribution installed").
/// Scripts in `.termic.yaml` are committed to user repos and written as
/// POSIX shell, so Git Bash is also what keeps one script dialect across
/// a team's Macs and Windows machines.
pub fn script_bash() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        if let Some(p) = git_bash() {
            return p;
        }
    }
    std::path::PathBuf::from("bash")
}

/// `...\Git\cmd\git.exe` (or `...\Git\bin\git.exe`,
/// `...\Git\mingw64\bin\git.exe`) -> `...\Git\bin\bash.exe`.
#[cfg(windows)]
fn git_bash() -> Option<std::path::PathBuf> {
    static BASH: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    BASH.get_or_init(|| {
        let git = which("git")?;
        git.ancestors()
            .skip(1)
            .take(3)
            .flat_map(|root| [root.join("bin").join("bash.exe"), root.join("usr").join("bin").join("bash.exe")])
            .find(|p| p.is_file())
    })
    .clone()
}

/// `which_in` against the resolved spawn PATH.
pub fn which(bin: &str) -> Option<std::path::PathBuf> {
    which_in(bin, &resolved_path())
}

/// The well-known tool dirs, resolved against this account. The one
/// source of truth for "where a CLI is likely installed": the PATH
/// fallback unions these in, and CLI detection probes them directly when
/// its login-shell lookup fails (the same degraded window). Cached after
/// the first call: the account cannot change under a running process,
/// and `passwd_name` must not run on several threads at once (CLI
/// detection probes every agent in parallel).
pub(crate) fn fallback_dirs() -> &'static [String] {
    FALLBACK_DIRS.get_or_init(|| fallback_extras(&account_home(), &account_user()))
}

/// `$HOME`, or the passwd entry when it is unset. Same reasoning as
/// `passwd_shell`: launchd hands a GUI `.app` a minimal environment, and
/// the passwd database is the authority that does not depend on it.
fn account_home() -> String {
    let env_home = std::env::var("HOME").unwrap_or_default();
    if !env_home.is_empty() {
        return env_home;
    }
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// `$USER`, or `getpwuid(getuid())->pw_name` when it is unset.
fn account_user() -> String {
    let env_user = std::env::var("USER").unwrap_or_default();
    if !env_user.is_empty() {
        return env_user;
    }
    passwd_name().unwrap_or_default()
}

/// The current user's login name from the passwd database.
#[cfg(unix)]
fn passwd_name() -> Option<String> {
    use std::ffi::CStr;
    // SAFETY: as in `passwd_shell` — getpwuid returns a pointer into a
    // static libc buffer; we copy pw_name out immediately and never
    // retain the pointer.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_name.is_null() {
            return None;
        }
        let s = CStr::from_ptr((*pw).pw_name).to_str().ok()?.to_string();
        (!s.is_empty()).then_some(s)
    }
}

#[cfg(not(unix))]
fn passwd_name() -> Option<String> {
    None
}

/// The dir list itself, split out from the account lookups so it stays
/// testable for an account with no resolvable home or user name.
fn fallback_extras(home: &str, user: &str) -> Vec<String> {
    // Windows: nothing here. Its PATH comes from the registry on every use
    // (`windows_live_path`), with its own well-known tool dirs
    // (`windows_known_tool_dirs`); every dir below is a unix layout.
    if cfg!(windows) {
        let _ = (home, user);
        return Vec::new();
    }
    // Nix profiles lead: a nix-darwin login PATH puts them ahead of
    // homebrew and of /usr/bin, so when a tool exists in both places
    // this picks the same binary the user's own terminal runs. Within
    // the nix set, per-user before system, as nix-darwin orders them.
    // Every one of these is stable by design (a generation switch flips
    // the symlink behind the path), and nix deliberately keeps out of
    // /etc/paths.d, so there is no registry a GUI app could read
    // instead. Without them, everything installed to a nix profile is
    // invisible whenever this fallback is in use.
    let mut extras: Vec<String> = Vec::new();
    if !user.is_empty() {
        extras.push(format!("/etc/profiles/per-user/{user}/bin"));
    }
    if !home.is_empty() {
        extras.push(format!("{home}/.nix-profile/bin"));
        // With `use-xdg-base-directories` (nix 2.14+) the per-user
        // profile lives here instead, and ~/.nix-profile never exists.
        extras.push(format!("{home}/.local/state/nix/profile/bin"));
    }
    extras.push("/run/current-system/sw/bin".into());
    extras.push("/nix/var/nix/profiles/default/bin".into());

    extras.extend([
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/local/sbin".to_string(),
    ]);
    if !home.is_empty() {
        extras.extend([
            format!("{home}/.local/bin"),
            format!("{home}/.bun/bin"),
            format!("{home}/.deno/bin"),
            format!("{home}/.cargo/bin"),
            format!("{home}/.volta/bin"),
            format!("{home}/.npm-global/bin"),
            format!("{home}/n/bin"),
        ]);
    }
    extras
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_candidates_follow_pathext_and_skip_the_bare_shim() {
        assert_eq!(
            exe_candidates_with("codex", ".COM;.EXE;.CMD"),
            vec!["codex.com", "codex.exe", "codex.cmd"]
        );
        // An empty PATHEXT still finds npm's .cmd shims.
        assert!(exe_candidates_with("claude", "").contains(&"claude.cmd".to_string()));
        assert!(!exe_candidates_with("claude", "").contains(&"claude".to_string()));
    }

    #[cfg(windows)]
    #[test]
    fn a_bare_name_resolves_past_npms_extensionless_shim() {
        // npm's global bin holds `pi` (a POSIX shell shim, not an exe) next
        // to `pi.cmd`; the spawn has to get the .cmd.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("pi"), "#!/bin/sh\n").unwrap();
        std::fs::write(dir.path().join("pi.cmd"), "@echo off\r\n").unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let got = resolve_program("pi", &path);
        assert!(got.to_ascii_lowercase().ends_with("pi.cmd"), "{got}");
        // A path, or a name with an extension, is taken as given.
        assert_eq!(resolve_program(r"C:\tools\pi", &path), r"C:\tools\pi");
        assert_eq!(resolve_program("pi.exe", &path), "pi.exe");
        // Nothing on PATH: unchanged, so the spawn error names what was asked.
        assert_eq!(resolve_program("nope-not-here", &path), "nope-not-here");
    }

    #[test]
    fn windows_known_tool_dirs_cover_the_agent_installers() {
        let env = |k: &str| match k {
            "USERPROFILE" => Some(r"C:\Users\u".to_string()),
            "APPDATA" => Some(r"C:\Users\u\AppData\Roaming".to_string()),
            "LOCALAPPDATA" => Some(r"C:\Users\u\AppData\Local".to_string()),
            _ => None,
        };
        let dirs = windows_known_tool_dirs(&env);
        assert!(dirs.contains(&r"C:\Users\u\.local\bin".to_string()), "{dirs:?}");
        assert!(dirs.contains(&r"C:\Users\u\AppData\Roaming\npm".to_string()), "{dirs:?}");
        assert!(dirs.contains(&r"C:\Users\u\AppData\Local\Microsoft\WinGet\Links".to_string()), "{dirs:?}");
        assert!(windows_known_tool_dirs(&|_| None).is_empty());
    }

    #[test]
    fn path_lists_merge_in_order_each_dir_once() {
        assert_eq!(
            merge_path_lists(&[
                r"C:\Windows;C:\Program Files\Git\cmd",
                r"C:\Users\u\AppData\Local\bin;c:\windows\",
                r"C:\Program Files\Git\cmd;;D:\tools",
            ]),
            r"C:\Windows;C:\Program Files\Git\cmd;C:\Users\u\AppData\Local\bin;D:\tools",
        );
        assert_eq!(merge_path_lists(&["", ""]), "");
    }

    #[test]
    fn resolve_program_is_the_identity_off_windows() {
        if cfg!(windows) { return; }
        assert_eq!(resolve_program("pi", "/usr/bin"), "pi");
    }

    #[test]
    fn which_in_finds_an_executable_and_ignores_a_plain_file() {
        let dir = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) { "tool.exe" } else { "tool" };
        let f = dir.path().join(name);
        std::fs::write(&f, "x").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(which_in("tool", &dir.path().to_string_lossy()), None);
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = join_path_dirs(&[std::path::PathBuf::from("/nonexistent-termic"), dir.path().to_path_buf()]);
        assert_eq!(which_in("tool", &path), Some(f));
    }

    #[test]
    fn path_dirs_round_trips_through_the_platform_separator() {
        let dirs = vec![std::path::PathBuf::from("/a/b"), std::path::PathBuf::from("/c")];
        assert_eq!(path_dirs(&join_path_dirs(&dirs)), dirs);
    }

    #[cfg(unix)] // unix paths / tools; the Windows behaviour differs by design
    #[test]
    fn fallback_path_adds_homebrew_when_missing() {
        let result = fallback_path("/usr/bin:/bin");
        assert!(result.contains("/opt/homebrew/bin"), "must add homebrew bin");
    }

    #[test]
    fn fallback_path_does_not_duplicate_existing_entry() {
        let result = fallback_path("/usr/bin:/opt/homebrew/bin:/bin");
        let count = result.split(':').filter(|s| *s == "/opt/homebrew/bin").count();
        assert_eq!(count, 1, "homebrew bin must appear exactly once");
    }

    #[test]
    fn fallback_path_preserves_original_entries_first() {
        let result = fallback_path("/usr/bin:/bin");
        assert!(result.starts_with("/usr/bin:/bin"), "original path must be at the start");
    }

    #[cfg(unix)] // unix paths / tools; the Windows behaviour differs by design
    #[test]
    fn fallback_path_empty_current_path() {
        let result = fallback_path("");
        assert!(result.contains("/opt/homebrew/bin"), "must add extras even for empty path");
        assert!(!result.starts_with(':'), "must not start with colon");
    }

    #[test]
    #[cfg(unix)]
    fn fallback_path_adds_private_tmp_equiv_via_cargo_bin() {
        // ~/.cargo/bin is always added (for rustup installs).
        let home = std::env::var("HOME").unwrap_or_default();
        let result = fallback_path("/usr/bin");
        if !home.is_empty() {
            assert!(result.contains(&format!("{home}/.cargo/bin")),
                "must add cargo bin dir");
        }
    }

    #[cfg(unix)] // unix paths / tools; the Windows behaviour differs by design
    #[test]
    fn fallback_path_adds_nix_profile_dirs() {
        let extras = fallback_extras("/Users/x", "x");
        for dir in [
            "/etc/profiles/per-user/x/bin",
            "/Users/x/.nix-profile/bin",
            "/run/current-system/sw/bin",
            "/nix/var/nix/profiles/default/bin",
        ] {
            assert!(extras.iter().any(|p| p == dir), "must add {dir}");
        }
    }

    #[cfg(unix)] // unix paths / tools; the Windows behaviour differs by design
    #[test]
    fn fallback_path_adds_system_nix_dirs_without_home_or_user() {
        // A GUI process can launch with neither set. The two system-wide
        // nix profiles don't depend on either, so they still apply.
        let extras = fallback_extras("", "");
        assert!(extras.iter().any(|p| p == "/run/current-system/sw/bin"));
        assert!(extras.iter().any(|p| p == "/nix/var/nix/profiles/default/bin"));
    }

    #[cfg(unix)] // unix paths / tools; the Windows behaviour differs by design
    #[test]
    fn fallback_path_adds_xdg_nix_profile_dir() {
        // use-xdg-base-directories (nix 2.14+) moves the per-user
        // profile here and leaves no ~/.nix-profile behind.
        let extras = fallback_extras("/Users/x", "x");
        assert!(extras.iter().any(|p| p == "/Users/x/.local/state/nix/profile/bin"));
    }

    #[cfg(unix)] // unix paths / tools; the Windows behaviour differs by design
    #[test]
    fn fallback_path_prefers_nix_over_homebrew() {
        // A nix-darwin login PATH puts the nix profiles ahead of
        // homebrew, so a tool installed in both must resolve the same
        // way here as it does in the user's own terminal.
        let extras = fallback_extras("/Users/x", "x");
        let at = |dir: &str| extras.iter().position(|p| p == dir).unwrap();
        assert!(at("/run/current-system/sw/bin") < at("/opt/homebrew/bin"));
        assert!(at("/etc/profiles/per-user/x/bin") < at("/opt/homebrew/bin"));
    }

    #[test]
    fn fallback_path_skips_per_user_nix_dirs_without_home_or_user() {
        // Neither $HOME/$USER nor the passwd entry resolved. Interpolating
        // the empties would yield a bogus /etc/profiles/per-user//bin
        // and /.nix-profile/bin.
        let extras = fallback_extras("", "");
        assert!(
            !extras.iter().any(|p| p.contains("/etc/profiles/per-user/")),
            "no per-user profile without $USER, got: {extras:?}"
        );
        assert!(
            !extras.iter().any(|p| p.starts_with("/.")),
            "no home-relative dirs without $HOME, got: {extras:?}"
        );
    }

    #[cfg(unix)] // unix paths / tools; the Windows behaviour differs by design
    #[test]
    fn fallback_path_keeps_nix_dirs_in_nix_darwin_order() {
        let extras = fallback_extras("/Users/x", "x");
        let at = |dir: &str| extras.iter().position(|p| p == dir).unwrap();
        assert!(
            at("/etc/profiles/per-user/x/bin") < at("/run/current-system/sw/bin"),
            "per-user profile must precede the system profile"
        );
        assert!(
            at("/run/current-system/sw/bin") < at("/nix/var/nix/profiles/default/bin"),
            "system profile must precede the default profile"
        );
    }

    #[test]
    fn fallback_path_all_entries_nonempty() {
        let result = fallback_path("/usr/bin:/bin");
        for entry in result.split(':') {
            assert!(!entry.is_empty(), "no empty PATH entries allowed, got: {:?}", result);
        }
    }

    #[test]
    fn pick_shell_honors_existing_shell_var() {
        let got = pick_shell(Some("/usr/bin/fish".into()), |p| p == "/usr/bin/fish");
        assert_eq!(got, "/usr/bin/fish", "must use $SHELL when it exists");
    }

    #[test]
    fn pick_shell_skips_shell_var_that_does_not_exist() {
        // $SHELL points at zsh, but this machine doesn't have it (the
        // exact #13 scenario). Fall through to the first present cand.
        let got = pick_shell(Some("/bin/zsh".into()), |p| p == "/bin/bash");
        assert_eq!(got, "/bin/bash", "missing $SHELL must fall through to a real shell");
    }

    #[test]
    fn pick_shell_falls_back_when_shell_var_unset() {
        let got = pick_shell(None, |p| p == "/opt/homebrew/bin/fish");
        assert_eq!(got, "/opt/homebrew/bin/fish");
    }

    #[test]
    fn pick_shell_ignores_empty_shell_var() {
        let got = pick_shell(Some(String::new()), |p| p == "/bin/bash");
        assert_eq!(got, "/bin/bash", "empty $SHELL must be treated as unset");
    }

    #[test]
    fn pick_shell_last_resort_is_bin_sh() {
        // Nothing exists on disk — still return a POSIX-guaranteed path
        // rather than an empty string the spawner can't use.
        let got = pick_shell(None, |_| false);
        assert_eq!(got, "/bin/sh");
    }

    #[test]
    fn pick_shell_prefers_zsh_when_several_present() {
        let got = pick_shell(None, |_| true);
        assert_eq!(got, "/bin/zsh", "zsh is first in the candidate list");
    }

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn parse_env_output_basic_pairs() {
        let v = parse_env_output("PATH=/usr/bin:/bin\nEDITOR=nvim\nLANG=en_US.UTF-8");
        assert_eq!(v, vec![
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("EDITOR".into(), "nvim".into()),
            ("LANG".into(), "en_US.UTF-8".into()),
        ]);
    }

    #[test]
    fn parse_env_output_value_may_contain_equals() {
        // Only the FIRST '=' splits; the rest is value (e.g. a base64 token).
        let v = parse_env_output("FOO=a=b=c");
        assert_eq!(v, vec![("FOO".into(), "a=b=c".into())]);
    }

    #[test]
    fn parse_env_output_skips_motd_and_continuation_junk() {
        // A banner line and a multi-line value's tail have no valid KEY=.
        let v = parse_env_output("Welcome to your shell!\nEDITOR=nvim\n  some wrapped text");
        assert_eq!(v, vec![("EDITOR".into(), "nvim".into())]);
    }

    #[test]
    fn parse_env_output_preserves_spaces_in_value() {
        let v = parse_env_output("EDITOR=emacsclient -nw");
        assert_eq!(v, vec![("EDITOR".into(), "emacsclient -nw".into())]);
    }

    #[test]
    fn is_env_key_accepts_valid_and_rejects_junk() {
        assert!(is_env_key("EDITOR"));
        assert!(is_env_key("_FOO9"));
        assert!(!is_env_key(""));        // empty
        assert!(!is_env_key("9LIVES"));  // leading digit
        assert!(!is_env_key("a b"));     // space
        assert!(!is_env_key("Welcome to")); // banner text
    }

    #[test]
    fn select_injected_keeps_new_var() {
        // EDITOR isn't in our bare env → it's part of the delta to inject.
        let probed = vec![("EDITOR".into(), "nvim".into())];
        let got = select_injected(&probed, &map(&[("HOME", "/Users/x")]), false);
        assert_eq!(got, vec![("EDITOR".to_string(), "nvim".to_string())]);
    }

    #[test]
    fn select_injected_drops_unchanged_var() {
        // Inherited launchd noise (same value in our env) must NOT inject.
        let probed = vec![("XPC_SERVICE_NAME".into(), "app.termic".into())];
        let got = select_injected(&probed, &map(&[("XPC_SERVICE_NAME", "app.termic")]), false);
        assert!(got.is_empty());
    }

    #[test]
    fn select_injected_gui_overrides_changed_var() {
        // GUI launch (fill_only=false): rc's LANG beats launchd's LANG=C.
        let probed = vec![("LANG".into(), "en_US.UTF-8".into())];
        let got = select_injected(&probed, &map(&[("LANG", "C")]), false);
        assert_eq!(got, vec![("LANG".to_string(), "en_US.UTF-8".to_string())]);
    }

    #[test]
    fn select_injected_fill_only_does_not_override_session_var() {
        // Terminal launch (fill_only=true): the live session's EDITOR wins;
        // we must NOT clobber it with the rc default.
        let probed = vec![("EDITOR".into(), "nano".into())];
        let got = select_injected(&probed, &map(&[("EDITOR", "vim")]), true);
        assert!(got.is_empty(), "fill_only must not override a present var");
    }

    #[test]
    fn select_injected_fill_only_still_adds_missing_var() {
        // The #17 fix: EDITOR added to the rc AFTER a stale terminal opened
        // is missing from the inherited env, so fill_only still injects it.
        let probed = vec![("EDITOR".into(), "nano".into())];
        let got = select_injected(&probed, &HashMap::new(), true);
        assert_eq!(got, vec![("EDITOR".to_string(), "nano".to_string())]);
    }

    #[test]
    fn select_injected_drops_frozen_venv_activation() {
        // An rc-activated venv/conda must NOT be frozen + injected into every
        // task; PATH carries the bin dir, the activation pointers don't.
        let probed = vec![
            ("VIRTUAL_ENV".into(), "/Users/x/.venv".into()),
            ("CONDA_PREFIX".into(), "/opt/conda".into()),
            ("CONDA_DEFAULT_ENV".into(), "base".into()),
            ("EDITOR".into(), "nvim".into()),
        ];
        let got = select_injected(&probed, &HashMap::new(), false);
        assert_eq!(got, vec![("EDITOR".to_string(), "nvim".to_string())]);
    }

    #[test]
    fn select_injected_excludes_path_and_managed_vars() {
        // PATH is handled by resolved_path(); TERM/SHLVL/PWD are ours.
        let probed = vec![
            ("PATH".into(), "/opt/homebrew/bin".into()),
            ("TERM".into(), "xterm".into()),
            ("SHLVL".into(), "2".into()),
            ("PWD".into(), "/somewhere".into()),
            ("EDITOR".into(), "nvim".into()),
        ];
        let got = select_injected(&probed, &HashMap::new(), false);
        assert_eq!(got, vec![("EDITOR".to_string(), "nvim".to_string())]);
    }

    // ---- probe state machine (#186) --------------------------------------

    fn fallback_env() -> LoginEnv {
        LoginEnv { path: "/usr/bin:/bin".into(), inject: Vec::new() }
    }

    fn real_env() -> LoginEnv {
        LoginEnv {
            path: "/nix/profile/bin:/usr/bin:/bin".into(),
            inject: vec![("EDITOR".into(), "nvim".into())],
        }
    }

    #[test]
    fn snapshot_serves_fallback_before_any_probe() {
        // Reads must never block on an unstarted probe: zero wait returns
        // the initial (fallback) env immediately.
        let st = State::new(fallback_env());
        assert_eq!(st.snapshot(Duration::ZERO), fallback_env());
    }

    #[test]
    fn snapshot_does_not_wait_after_first_attempt_failed() {
        // Acceptance #2: once the first attempt has finished (even in
        // failure), reads return immediately — no per-spawn stall.
        let st = State::new(fallback_env());
        st.attempt_finished(None, false);
        let t0 = Instant::now();
        let env = st.snapshot(Duration::from_secs(5));
        assert!(t0.elapsed() < Duration::from_secs(2), "must not wait out the timeout");
        assert_eq!(env, fallback_env(), "failed probe leaves the fallback in place");
    }

    #[test]
    fn snapshot_wakes_when_first_probe_succeeds() {
        // A reader arriving mid-first-probe waits (bounded) and gets the
        // REAL env as soon as the probe lands, not the fallback.
        use std::sync::Arc;
        let st = Arc::new(State::new(fallback_env()));
        let publisher = {
            let st = Arc::clone(&st);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                st.attempt_finished(Some(real_env()), false);
            })
        };
        let t0 = Instant::now();
        let env = st.snapshot(Duration::from_secs(5));
        publisher.join().unwrap();
        assert_eq!(env, real_env(), "waiter must see the probed env");
        assert!(t0.elapsed() < Duration::from_secs(2), "must wake on publish, not timeout");
    }

    #[test]
    fn failed_then_successful_probe_swaps_env_in() {
        // Acceptance #1: a transient failure is NOT cached — the retry's
        // success replaces the fallback for every later read.
        let st = State::new(fallback_env());
        assert!(!st.attempt_finished(None, true));
        assert_eq!(st.snapshot(Duration::ZERO), fallback_env());
        assert!(st.attempt_finished(Some(real_env()), false));
        assert_eq!(st.snapshot(Duration::ZERO), real_env());
    }

    // Callers that MEMOIZE something derived from PATH (the find-in-files
    // backend, GH #181) need to know whether the env they just read is
    // the real one. The flag has to come from the same lock as the env:
    // a pair read separately could straddle a probe landing and report a
    // fallback env as final, which is the one lie that would let a wrong
    // verdict get cached for the session.
    #[test]
    fn snapshot_final_marks_the_fallback_as_not_final() {
        let st = State::new(fallback_env());
        assert_eq!(st.snapshot_final(Duration::ZERO), (fallback_env(), false));

        // A failed attempt unblocks readers but still isn't an answer.
        st.attempt_finished(None, false);
        assert_eq!(st.snapshot_final(Duration::ZERO), (fallback_env(), false));
    }

    #[test]
    fn heals_only_when_a_reader_got_the_fallback_first() {
        // Probe lands before anyone reads: nothing was decided on the
        // fallback, so nothing needs redoing.
        let st = State::new(fallback_env());
        st.attempt_finished(Some(real_env()), false);
        assert_eq!(st.inner.lock().unwrap().heals, 0);

        // A reader gets the fallback, then the probe lands: one heal, and a
        // later success-shaped call does not count again.
        let st = State::new(fallback_env());
        st.snapshot_final(Duration::ZERO);
        st.attempt_finished(None, true);
        st.attempt_finished(Some(real_env()), false);
        assert_eq!(st.inner.lock().unwrap().heals, 1);
        st.snapshot_final(Duration::ZERO);
        st.attempt_finished(Some(real_env()), false);
        assert_eq!(st.inner.lock().unwrap().heals, 1);
    }

    #[test]
    fn snapshot_final_marks_a_probed_env_as_final() {
        let st = State::new(fallback_env());
        st.attempt_finished(Some(real_env()), false);
        assert_eq!(st.snapshot_final(Duration::ZERO), (real_env(), true));
    }

    #[test]
    fn a_waiter_that_wakes_on_success_sees_final_with_the_real_env() {
        // The pairing has to survive the wakeup path too, not just the
        // already-settled read.
        use std::sync::Arc;
        let st = Arc::new(State::new(fallback_env()));
        let publisher = {
            let st = Arc::clone(&st);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                st.attempt_finished(Some(real_env()), false);
            })
        };
        assert_eq!(st.snapshot_final(Duration::from_secs(5)), (real_env(), true));
        publisher.join().unwrap();
    }

    #[test]
    fn retry_gate_blocks_after_success_and_while_probing() {
        let st = State::new(fallback_env());
        // First attempt still pending → no read-kicked retry.
        assert!(!st.try_begin_retry(Duration::ZERO, 10));
        // Loop still active (probing) → blocked.
        st.attempt_finished(None, true);
        assert!(!st.try_begin_retry(Duration::ZERO, 10));
        // Loop over, cooldown elapsed (ZERO) → exactly one kick wins...
        st.attempt_finished(None, false);
        assert!(st.try_begin_retry(Duration::ZERO, 10));
        // ...and holds the probing flag against a second concurrent kick.
        assert!(!st.try_begin_retry(Duration::ZERO, 10));
        // After success, retries stop forever.
        st.attempt_finished(Some(real_env()), false);
        assert!(!st.try_begin_retry(Duration::ZERO, 10));
    }

    #[test]
    fn retry_gate_respects_cooldown() {
        let st = State::new(fallback_env());
        st.attempt_finished(None, false);
        // last_attempt is "just now": a long cooldown blocks the kick, a
        // zero cooldown allows it.
        assert!(!st.try_begin_retry(Duration::from_secs(3600), 10));
        assert!(st.try_begin_retry(Duration::ZERO, 10));
    }

    #[test]
    fn retry_gate_caps_lifetime_kicks() {
        // A permanently broken shell must cost a BOUNDED number of probes:
        // after max_kicks read-kicked retries, the gate closes for good.
        let st = State::new(fallback_env());
        st.attempt_finished(None, false);
        for _ in 0..2 {
            assert!(st.try_begin_retry(Duration::ZERO, 2));
            st.attempt_finished(None, false);
        }
        assert!(!st.try_begin_retry(Duration::ZERO, 2), "cap must close the gate");
    }

    #[test]
    fn attempt_aborted_unblocks_readers_and_reopens_gate() {
        // A probe thread that dies before reporting (panic, spawn failure)
        // must not leave readers waiting out FIRST_PROBE_WAIT forever or
        // the retry gate stuck on `probing`.
        let st = State::new(fallback_env());
        st.inner.lock().unwrap().probing = true;
        st.attempt_aborted();
        let t0 = Instant::now();
        assert_eq!(st.snapshot(Duration::from_secs(5)), fallback_env());
        assert!(t0.elapsed() < Duration::from_secs(2), "aborted attempt must not block reads");
        assert!(st.try_begin_retry(Duration::ZERO, 10), "gate must reopen after abort");
    }

    #[test]
    fn probe_loop_retries_with_doubling_backoff_until_success() {
        // Fail twice, succeed on the third try: the loop must sleep the
        // 2s→4s schedule, swap in the real env, then stop retrying.
        let st = State::new(fallback_env());
        let mut calls = 0;
        let mut slept: Vec<Duration> = Vec::new();
        run_probe_loop(
            &st,
            || {
                calls += 1;
                (calls == 3).then(real_env)
            },
            |d| slept.push(d),
            5,
            Duration::from_secs(2),
        );
        assert_eq!(calls, 3, "loop must stop probing once it succeeds");
        assert_eq!(slept, vec![Duration::from_secs(2), Duration::from_secs(4)]);
        assert_eq!(st.snapshot(Duration::ZERO), real_env());
        assert!(!st.try_begin_retry(Duration::ZERO, 10), "no retries after success");
    }

    #[test]
    fn probe_loop_exhausts_attempts_then_allows_read_kicked_retry() {
        // Every startup attempt fails: fallback stays served, the loop
        // stops at max_attempts, and the usage-driven retry gate opens.
        let st = State::new(fallback_env());
        let mut calls = 0;
        run_probe_loop(&st, || { calls += 1; None }, |_| {}, 3, Duration::from_secs(2));
        assert_eq!(calls, 3, "must stop at max_attempts");
        assert_eq!(st.snapshot(Duration::ZERO), fallback_env());
        assert!(st.try_begin_retry(Duration::ZERO, 10), "reads may now kick a retry");
    }
}
