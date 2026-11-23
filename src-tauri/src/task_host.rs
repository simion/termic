//! Where a task's files live, and the few file operations task creation
//! needs there (docs/remote.md, "TaskHost is the seam"). A
//! local project's are this computer's; a server project's run on the box
//! through termic-server's `exec`, inside the folders it fences. Git already
//! routes by path (`git_bytes`), so only what creation does to the
//! filesystem itself is here; the creation logic stays one function.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::Project;

pub(crate) enum Host {
    Local,
    /// A server, with a folder exec may run in (the project's root).
    Server { id: String, cwd: PathBuf },
}

/// What occupies a path.
#[derive(Debug, PartialEq)]
pub(crate) enum Slot {
    Empty,
    Dir,
    Link,
    Other,
}

impl Host {
    pub(crate) fn for_project(p: &Project) -> Host {
        match &p.server {
            Some(id) => Host::Server { id: id.clone(), cwd: PathBuf::from(&p.root_path) },
            None => Host::Local,
        }
    }

    pub(crate) fn is_server(&self) -> bool {
        matches!(self, Host::Server { .. })
    }

    /// A script on the box (`sh`), for a caller with one of its own.
    pub(crate) fn run_sh(&self, script: &str, args: &[&str]) -> Result<String, String> {
        self.sh(script, args)
    }

    /// Run a POSIX shell script on the box with `args` as $1..; its stdout.
    /// Local hosts never call this.
    fn sh(&self, script: &str, args: &[&str]) -> Result<String, String> {
        let Host::Server { id, cwd } = self else { return Err("not a server".into()) };
        let mut argv: Vec<&str> = vec!["/bin/sh", "-c", script, "sh"];
        argv.extend_from_slice(args);
        let (code, out, err) = crate::server_projects::exec_on(id, cwd, &argv, &[])?;
        if code != 0 {
            return Err(if err.trim().is_empty() { format!("exited {code}") } else { err.trim().to_string() });
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    pub(crate) fn create_dir_all(&self, p: &Path) -> Result<(), String> {
        match self {
            Host::Local => std::fs::create_dir_all(p).map_err(|e| e.to_string()),
            Host::Server { .. } => self.sh("mkdir -p \"$1\"", &[&p.to_string_lossy()]).map(|_| ()),
        }
    }

    pub(crate) fn exists(&self, p: &Path) -> bool {
        match self {
            Host::Local => p.exists(),
            Host::Server { .. } => self.sh("[ -e \"$1\" ] && echo y || true", &[&p.to_string_lossy()]).is_ok_and(|o| o.trim() == "y"),
        }
    }

    /// What sits at `p`, not following a symlink.
    pub(crate) fn slot(&self, p: &Path) -> Slot {
        match self {
            Host::Local => match std::fs::symlink_metadata(p) {
                Err(_) => Slot::Empty,
                Ok(m) if m.file_type().is_symlink() => Slot::Link,
                Ok(m) if m.is_dir() => Slot::Dir,
                Ok(_) => Slot::Other,
            },
            Host::Server { .. } => {
                let o = self.sh("if [ -L \"$1\" ]; then echo l; elif [ -d \"$1\" ]; then echo d; elif [ -e \"$1\" ]; then echo o; else echo e; fi", &[&p.to_string_lossy()]).unwrap_or_default();
                match o.trim() {
                    "l" => Slot::Link,
                    "d" => Slot::Dir,
                    "o" => Slot::Other,
                    _ => Slot::Empty,
                }
            }
        }
    }

    pub(crate) fn remove_dir_all(&self, p: &Path) -> Result<(), String> {
        match self {
            Host::Local => std::fs::remove_dir_all(p).map_err(|e| e.to_string()),
            Host::Server { .. } => self.sh("rm -rf -- \"$1\"", &[&p.to_string_lossy()]).map(|_| ()),
        }
    }

    pub(crate) fn remove_link(&self, p: &Path) -> Result<(), String> {
        match self {
            Host::Local => crate::fs_link::remove_link(p).map_err(|e| e.to_string()),
            Host::Server { .. } => self.sh("rm -f -- \"$1\"", &[&p.to_string_lossy()]).map(|_| ()),
        }
    }

    /// The box user's home (a server); this computer's otherwise.
    pub(crate) fn home(&self) -> Option<PathBuf> {
        match self {
            Host::Local => dirs::home_dir(),
            Host::Server { .. } => self.sh("printf %s \"$HOME\"", &[]).ok().filter(|h| !h.is_empty()).map(PathBuf::from),
        }
    }

    pub(crate) fn is_file(&self, p: &Path) -> bool {
        match self {
            Host::Local => p.is_file(),
            Host::Server { .. } => self.sh("[ -f \"$1\" ] && echo y || true", &[&p.to_string_lossy()]).is_ok_and(|o| o.trim() == "y"),
        }
    }

    /// The most recently modified `*.<ext>` file directly in `dir`.
    pub(crate) fn newest_with_ext(&self, dir: &Path, ext: &str) -> Option<PathBuf> {
        match self {
            Host::Local => std::fs::read_dir(dir)
                .ok()?
                .flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == ext))
                .max_by_key(|e| e.metadata().ok().and_then(|m| m.modified().ok()))
                .map(|e| e.path()),
            Host::Server { .. } => {
                let o = self.sh("ls -t \"$1\"/*.\"$2\" 2>/dev/null | head -n 1", &[&dir.to_string_lossy(), ext]).ok()?;
                let line = o.lines().next()?.trim();
                (!line.is_empty()).then(|| PathBuf::from(line))
            }
        }
    }

    /// A file's bytes, unchanged (a SQLite database, not text).
    pub(crate) fn read_bytes(&self, p: &Path) -> Result<Vec<u8>, String> {
        match self {
            Host::Local => std::fs::read(p).map_err(|e| e.to_string()),
            Host::Server { id, cwd } => {
                let (code, out, err) = crate::server_projects::exec_on(id, cwd, &["cat", "--", &p.to_string_lossy()], &[])?;
                if code != 0 {
                    return Err(if err.trim().is_empty() { format!("exited {code}") } else { err.trim().to_string() });
                }
                Ok(out)
            }
        }
    }

    pub(crate) fn read_to_string(&self, p: &Path) -> Result<String, String> {
        match self {
            Host::Local => std::fs::read_to_string(p).map_err(|e| e.to_string()),
            Host::Server { .. } => self.sh("cat -- \"$1\"", &[&p.to_string_lossy()]),
        }
    }

    /// Copy what `pattern` matches in `repo` into the same place in `wt`
    /// (a project's "files to copy" on a box: `.env` and friends). Local
    /// projects keep `copy_matching`, which also handles the cases a glob
    /// on the box need not (Windows paths, clonefile).
    pub(crate) fn copy_matching_on_box(&self, repo: &Path, wt: &Path, pattern: &str) {
        // The pattern is the project's own setting, globbed by the shell in
        // the repo; each match is copied with its parents.
        let script = "cd \"$1\" || exit 0; set +f; for f in $3; do [ -e \"$f\" ] || continue; [ -e \"$2/$f\" ] && continue; mkdir -p \"$2/$(dirname \"$f\")\" && cp -a \"$f\" \"$2/$f\"; done";
        let _ = self.sh(script, &[&repo.to_string_lossy(), &wt.to_string_lossy(), pattern]);
    }

    /// Link `repo/name` into `wt/name` when the repo has it and the worktree
    /// does not (the agents' config dirs), on a box.
    pub(crate) fn link_on_box(&self, repo: &Path, wt: &Path, name: &str) {
        let script = "[ -e \"$1/$3\" ] && [ ! -e \"$2/$3\" ] && ln -s \"$1/$3\" \"$2/$3\"; true";
        let _ = self.sh(script, &[&repo.to_string_lossy(), &wt.to_string_lossy(), name]);
    }
}

/// The folder a server keeps task worktrees in (termic-server's data dir
/// `worktrees`, the one its exec fence allows), asked once per server.
pub(crate) fn server_worktrees_root(server: &str, cwd: &Path) -> Result<PathBuf, String> {
    static ROOTS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    let roots = ROOTS.get_or_init(Default::default);
    if let Some(p) = roots.lock().unwrap().get(server) {
        return Ok(p.clone());
    }
    let host = Host::Server { id: server.to_string(), cwd: cwd.to_path_buf() };
    let out = host.sh("printf %s \"${TERMIC_SERVER_HOME:-$HOME/.termic-server}/worktrees\"", &[])?;
    let p = PathBuf::from(out.trim());
    if !p.is_absolute() {
        return Err(format!("the server named a worktrees folder that is not absolute: {}", out.trim()));
    }
    roots.lock().unwrap().insert(server.to_string(), p.clone());
    Ok(p)
}
