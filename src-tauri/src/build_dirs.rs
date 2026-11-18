//! Idle build-folder cleanup: free regenerable build output (node_modules,
//! cargo target, ...) inside the worktrees of OPEN tasks nobody has opened
//! for a while. Archived tasks already lose their whole worktree; the space
//! this goes after is the open-but-forgotten task holding gigabytes of
//! node_modules. Rules and the reason for each: docs/data-model.md, "Idle
//! build-folder cleanup".
//!
//! Driven from the frontend (src/lib/idleBuildDirs.ts): a timer calls
//! `idle_build_dirs_free`, and activating a task calls `task_mark_active`.
//! No Rust timer, so no sleeping thread.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::{dlog, git, git_bytes, load_task_in, load_tasks_all, load_tasks_in, save_task, window_profile, ProfileId, PtyManager, Task};

/// Only directories with one of these names are ever deleted. Each is the
/// output of a tool that rebuilds it from tracked files (npm/pnpm/yarn,
/// cargo, Next, Turbo, SwiftPM, Xcode, Gradle, Python, CocoaPods).
pub(crate) const BUILD_DIR_NAMES: &[&str] = &[
    "node_modules", "target", ".next", ".turbo", ".build", "DerivedData",
    ".gradle", "__pycache__", ".venv", "Pods",
];

fn parse(ts: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(ts).ok().map(|d| d.with_timezone(&Utc))
}

/// max(last_active_at, created). `None` when neither parses, and such a task
/// is never idle: an unreadable date is not evidence of age.
pub(crate) fn last_active(t: &Task) -> Option<DateTime<Utc>> {
    [t.last_active_at.as_deref(), Some(t.created.as_str())]
        .into_iter()
        .flatten()
        .filter_map(parse)
        .max()
}

/// Whether a task may have its build folders freed at all, before looking at
/// the disk. Never the main checkout (the user's own repo), never a task
/// with any live PTY, never one the window is showing (`keep`).
pub(crate) fn eligible(
    t: &Task,
    live: &HashSet<String>,
    keep: &HashSet<String>,
    now: DateTime<Utc>,
    idle_days: u32,
) -> bool {
    !t.archived
        && !t.is_main_checkout
        && !live.contains(&t.id)
        && !keep.contains(&t.id)
        && last_active(t).is_some_and(|a| now - a >= chrono::Duration::days(idle_days.max(1) as i64))
}

/// Every task id a live PTY belongs to. All three tags count: an agent
/// carries `task_id`, the aux terminal only a `role`, a plain shell only an
/// `owner`. `owner` is otherwise reporting-only; reading it here can only
/// make the cleanup do LESS.
pub(crate) fn live_task_ids(m: &PtyManager) -> HashSet<String> {
    let map = m.inner.lock();
    map.values()
        .flat_map(|s| {
            [
                s.task_id.clone(),
                s.role.as_ref().map(|r| r.task_id.clone()),
                s.owner.as_ref().and_then(|o| o.task_id.clone()),
            ]
        })
        .flatten()
        .collect()
}

/// The build folders under `worktree` that are safe to delete. Every check
/// must pass; see the module docs for why each exists.
pub(crate) fn freeable_dirs(worktree: &Path) -> Vec<PathBuf> {
    let Ok(root) = worktree.canonicalize() else { return Vec::new() };
    // git must see THIS directory as the repo root. A task dir that is not a
    // worktree of its own would otherwise be answered for by an enclosing
    // repo, and "ignored" would mean that repo's rules.
    let top = match git(&["rev-parse", "--show-toplevel"], &root) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return Vec::new(),
    };
    if Path::new(&top).canonicalize().ok().as_deref() != Some(root.as_path()) {
        return Vec::new();
    }
    // Ignored entries only (tracked and untracked-unignored files never
    // appear), collapsed to the directory when everything in it is ignored.
    let Ok(out) = git_bytes(
        &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
        &root,
    ) else {
        return Vec::new();
    };
    let mut rels: Vec<&str> = out
        .split(|b| *b == 0)
        .filter_map(|s| std::str::from_utf8(s).ok())
        .filter_map(|s| s.strip_suffix('/'))
        .collect();
    rels.sort();
    let mut picked: Vec<PathBuf> = Vec::new();
    for rel in rels {
        // Component by component: git prints `/`, and a joined `a/b` would
        // never compare equal to its canonical form on Windows.
        let p = rel.split('/').fold(root.clone(), |acc, c| acc.join(c));
        // Never descend into a directory already being deleted.
        if picked.iter().any(|q| p.starts_with(q)) { continue; }
        if qualifies(&root, &p) { picked.push(p); }
    }
    picked
}

fn qualifies(root: &Path, p: &Path) -> bool {
    let Some(name) = p.file_name().and_then(|n| n.to_str()) else { return false };
    if !BUILD_DIR_NAMES.contains(&name) { return false; }
    // A symlink is not a directory to symlink_metadata, so a linked
    // node_modules is refused here rather than followed.
    let Ok(md) = fs::symlink_metadata(p) else { return false };
    if !md.is_dir() { return false; }
    // Canonical form equal to the joined path: no component on the way is a
    // symlink, so the deletion cannot land outside the worktree.
    match p.canonicalize() {
        Ok(c) if c == p && c.starts_with(root) => {}
        _ => return false,
    }
    // `target` is a common name for things that are not cargo's. Cargo
    // writes CACHEDIR.TAG into its own; anything without one is left alone.
    if name == "target" && !fs::symlink_metadata(p.join("CACHEDIR.TAG")).is_ok_and(|m| m.is_file()) {
        return false;
    }
    true
}

/// On-disk bytes under `p`, never following a symlink.
fn disk_usage(p: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(md) = e.path().symlink_metadata() else { continue };
            #[cfg(unix)]
            { use std::os::unix::fs::MetadataExt; total += md.blocks() * 512; }
            #[cfg(not(unix))]
            { total += md.len(); }
            if md.is_dir() { stack.push(e.path()); }
        }
    }
    total
}

#[derive(Serialize, Default, Debug)]
pub(crate) struct FreeReport {
    /// Ids of the tasks something was deleted from.
    pub tasks: Vec<String>,
    pub bytes: u64,
}

/// One pass over a profile's tasks. `live` is re-read before every deletion:
/// a pass can take a while, and a task opened meanwhile must be let go.
pub(crate) fn free_idle(
    profile: &ProfileId,
    live: &dyn Fn() -> HashSet<String>,
    keep: &HashSet<String>,
    now: DateTime<Utc>,
    idle_days: u32,
) -> FreeReport {
    let mut report = FreeReport::default();
    for t in load_tasks_in(profile) {
        if !eligible(&t, &live(), keep, now, idle_days) { continue; }
        let dirs = freeable_dirs(Path::new(&t.path));
        let mut touched = false;
        for d in dirs {
            // Fresh record AND fresh PTY set per directory: opening the task
            // stamps last_active_at or spawns a PTY, either of which stops it.
            match load_task_in(profile, &t.id) {
                Some(fresh) if eligible(&fresh, &live(), keep, now, idle_days) => {}
                _ => break,
            }
            let size = disk_usage(&d);
            touched = true;
            match fs::remove_dir_all(&d) {
                Ok(()) => {
                    report.bytes += size;
                    dlog(&format!("[build-dirs] freed {} ({size} bytes) from task {}", d.display(), t.name));
                }
                Err(e) => dlog(&format!("[build-dirs] could not delete {}: {e}", d.display())),
            }
        }
        if touched {
            report.tasks.push(t.id.clone());
            // Reload: the record on disk may have changed during the deletes.
            if let Some(mut fresh) = load_task_in(profile, &t.id) {
                fresh.artifacts_freed_at = Some(now.to_rfc3339());
                if let Err(e) = save_task(&fresh) {
                    dlog(&format!("[build-dirs] could not mark task {}: {e}", t.name));
                }
            }
        }
    }
    report
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Free build folders of this window's profile's idle tasks. `keep` is the
/// task(s) the window is showing, which are never idle whatever their stamp.
#[tauri::command]
pub(crate) async fn idle_build_dirs_free(
    window: tauri::Window,
    ptys: tauri::State<'_, PtyManager>,
    idle_days: u32,
    keep: Vec<String>,
) -> Result<FreeReport, String> {
    let profile = window_profile(&window);
    let ptys = ptys.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Two windows (or a manual run racing the timer) would delete the
        // same folders twice; the second just skips.
        if RUNNING.swap(true, Ordering::AcqRel) { return FreeReport::default(); }
        let keep: HashSet<String> = keep.into_iter().collect();
        let r = free_idle(&profile, &|| live_task_ids(&ptys), &keep, Utc::now(), idle_days);
        RUNNING.store(false, Ordering::Release);
        r
    })
    .await
    .map_err(|e| e.to_string())
}

/// Stamp `last_active_at` and take `artifacts_freed_at`, returning it so the
/// caller can restore (re-run setup, or say so) exactly once.
pub(crate) fn mark_active(id: &str, now: DateTime<Utc>) -> Result<Option<String>, String> {
    let mut list = load_tasks_all();
    let t = list.iter_mut().find(|t| t.id == id).ok_or("no such task")?;
    t.last_active_at = Some(now.to_rfc3339());
    let freed = t.artifacts_freed_at.take();
    save_task(t).map_err(|e| e.to_string())?;
    Ok(freed)
}

#[tauri::command]
pub(crate) async fn task_mark_active(id: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || mark_active(&id, Utc::now()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_scratch_data_dir;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(ok.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ok.stderr));
    }

    fn touch(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, b"x").unwrap();
    }

    /// A repo with one tracked file, `.gitignore` covering the build names.
    fn repo() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        sh(r, &["init", "-q"]);
        sh(r, &["config", "user.email", "e2e@termic.dev"]);
        sh(r, &["config", "user.name", "e2e"]);
        fs::write(r.join(".gitignore"), "node_modules/\ntarget/\n.venv/\n").unwrap();
        touch(&r.join("src/a.js"));
        sh(r, &["add", "."]);
        sh(r, &["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
        d
    }

    fn names(root: &Path, dirs: &[PathBuf]) -> Vec<String> {
        let root = root.canonicalize().unwrap();
        let mut v: Vec<String> = dirs.iter()
            .map(|d| d.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn picks_only_ignored_allowlisted_dirs_including_nested_ones() {
        let d = repo();
        let r = d.path();
        touch(&r.join("node_modules/a/index.js"));
        touch(&r.join("packages/x/node_modules/b/index.js"));
        touch(&r.join("node_modules/a/node_modules/c/i.js")); // nested inside a hit
        touch(&r.join(".venv/bin/python"));
        // ignored but not on the allowlist
        fs::write(r.join(".gitignore"), "node_modules/\ntarget/\n.venv/\ndist/\n").unwrap();
        touch(&r.join("dist/out.js"));
        // allowlisted name, NOT ignored: user-created, untracked
        touch(&r.join("Pods/mine.txt"));
        let got = names(r, &freeable_dirs(r));
        assert_eq!(got, vec![".venv", "node_modules", "packages/x/node_modules"]);
    }

    #[test]
    fn a_tracked_build_named_dir_is_never_picked() {
        let d = repo();
        let r = d.path();
        touch(&r.join("vendor/node_modules/keep.js"));
        sh(r, &["add", "-f", "vendor/node_modules/keep.js"]);
        assert!(freeable_dirs(r).is_empty());
    }

    #[test]
    fn target_needs_cargos_cachedir_tag() {
        let d = repo();
        let r = d.path();
        touch(&r.join("target/notes.txt"));
        assert!(freeable_dirs(r).is_empty(), "a target without CACHEDIR.TAG was picked");
        touch(&r.join("target/CACHEDIR.TAG"));
        assert_eq!(names(r, &freeable_dirs(r)), vec!["target"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_worktree_is_refused() {
        let d = repo();
        let r = d.path();
        let outside = tempfile::tempdir().unwrap();
        touch(&outside.path().join("node_modules/precious.js"));
        touch(&outside.path().join("pkg/node_modules/precious.js"));
        // A symlinked node_modules, and a real node_modules under a symlinked parent.
        std::os::unix::fs::symlink(outside.path().join("node_modules"), r.join("node_modules")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("pkg"), r.join("linked")).unwrap();
        fs::write(r.join(".gitignore"), "node_modules\nlinked/node_modules\n").unwrap();
        assert!(freeable_dirs(r).is_empty());
        // git never lists through a symlinked dir, so check the guard itself.
        let root = r.canonicalize().unwrap();
        assert!(!qualifies(&root, &root.join("linked").join("node_modules")));
        assert!(!qualifies(&root, &root.join("node_modules")));
        assert!(outside.path().join("pkg/node_modules/precious.js").exists());
    }

    #[test]
    fn a_dir_that_is_not_its_own_repo_root_is_refused() {
        let d = repo();
        let r = d.path();
        touch(&r.join("sub/node_modules/a.js"));
        // `sub` is inside the repo, not a worktree root: an enclosing repo's
        // rules must not count.
        assert!(freeable_dirs(&r.join("sub")).is_empty());
    }

    fn task(id: &str, path: &Path, created: &str) -> Task {
        Task {
            id: id.into(),
            name: id.into(),
            path: path.to_string_lossy().into_owned(),
            created: created.into(),
            ..Default::default()
        }
    }

    #[test]
    fn eligibility_rules() {
        let now = parse("2026-11-18T00:00:00Z").unwrap();
        let none = HashSet::new();
        let old = task("a", Path::new("/x"), "2026-10-01T00:00:00Z");
        assert!(eligible(&old, &none, &none, now, 14));
        // threshold
        assert!(!eligible(&task("b", Path::new("/x"), "2026-11-10T00:00:00Z"), &none, &none, now, 14));
        // a recent last_active_at beats an old created
        let mut seen = old.clone();
        seen.last_active_at = Some("2026-11-17T00:00:00Z".into());
        assert!(!eligible(&seen, &none, &none, now, 14));
        // main checkout
        let mut main = old.clone();
        main.is_main_checkout = true;
        assert!(!eligible(&main, &none, &none, now, 14));
        // archived
        let mut arch = old.clone();
        arch.archived = true;
        assert!(!eligible(&arch, &none, &none, now, 14));
        // live PTY / shown in the window
        let set: HashSet<String> = ["a".to_string()].into();
        assert!(!eligible(&old, &set, &none, now, 14));
        assert!(!eligible(&old, &none, &set, now, 14));
        // unparseable dates are never idle
        assert!(!eligible(&task("c", Path::new("/x"), "garbage"), &none, &none, now, 14));
    }

    #[test]
    fn a_pass_deletes_idle_build_dirs_marks_the_task_and_spares_live_ones() {
        let idle = repo();
        let busy = repo();
        let main = repo();
        for r in [idle.path(), busy.path(), main.path()] {
            touch(&r.join("node_modules/a/index.js"));
        }
        with_scratch_data_dir(|_| {
            let created = "2026-01-01T00:00:00Z";
            save_task(&task("idle", idle.path(), created)).unwrap();
            save_task(&task("busy", busy.path(), created)).unwrap();
            let mut m = task("main", main.path(), created);
            m.is_main_checkout = true;
            save_task(&m).unwrap();

            let now = parse("2026-11-18T00:00:00Z").unwrap();
            let live = || -> HashSet<String> { ["busy".to_string()].into() };
            let report = free_idle(&ProfileId::default(), &live, &HashSet::new(), now, 14);

            assert_eq!(report.tasks, vec!["idle".to_string()]);
            assert!(report.bytes > 0);
            assert!(!idle.path().join("node_modules").exists());
            assert!(idle.path().join("src/a.js").exists(), "a tracked file went");
            assert!(busy.path().join("node_modules").exists(), "a live task was touched");
            assert!(main.path().join("node_modules").exists(), "the main checkout was touched");

            let rec = load_task_in(&ProfileId::default(), "idle").unwrap();
            assert_eq!(rec.artifacts_freed_at.as_deref(), Some(now.to_rfc3339().as_str()));

            // Opening it hands the marker back once and stamps activity.
            assert_eq!(mark_active("idle", now).unwrap(), Some(now.to_rfc3339()));
            assert_eq!(mark_active("idle", now).unwrap(), None);
            let rec = load_task_in(&ProfileId::default(), "idle").unwrap();
            assert_eq!(rec.last_active_at.as_deref(), Some(now.to_rfc3339().as_str()));
        });
    }
}
