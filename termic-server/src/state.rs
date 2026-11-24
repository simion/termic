//! What survives a daemon restart: the server's id, its projects and its
//! tasks, in `state.json`. Live PTYs are not here; after a restart every
//! task is a record whose agent is inactive until the desktop starts it
//! again. The PTYs a `quit` ended are noted (`restarted_claims`), so the
//! desktop is told to.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::util;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    /// Added as a plain folder (`project_add` with `non_git`).
    pub non_git: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TaskRec {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub path: String,
    pub branch: String,
    pub base_branch: String,
    pub agent: String,
    /// Extra argv for the agent, after the table's.
    pub agent_args: Vec<String>,
    /// RFC 3339.
    pub created: String,
    pub archived: bool,
    pub is_main_checkout: bool,
    /// The desktops' organisation of it (task_put `org`), opaque here.
    #[serde(skip_serializing_if = "serde_json::Value::is_null")]
    pub org: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct State {
    pub version: u32,
    /// 32 hex, stable for the life of this data dir. Keep the shape: it is
    /// the `id` a phone's pairing link carries (the phone app requires 32
    /// hex) and a seal key derivation input, so a phone pairing straight
    /// with this server needs exactly this.
    pub server_id: String,
    pub projects: Vec<Project>,
    pub tasks: Vec<TaskRec>,
    /// Desktop PTYs (their claims) a `quit` ended: a desktop coming back to
    /// one is told "restarted", and starts it again instead of showing it
    /// exited (session.rs `pty_open`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub restarted_claims: Vec<String>,
}

pub fn state_path(dir: &Path) -> PathBuf {
    dir.join("state.json")
}

impl State {
    /// Read the state, or start a fresh one (with a new id) when there is
    /// none. A file that does not parse is kept aside, never overwritten
    /// silently: it is the only record of the user's tasks.
    pub fn load(dir: &Path) -> io::Result<State> {
        let p = state_path(dir);
        let mut st = match std::fs::read(&p) {
            Ok(b) => match serde_json::from_slice::<State>(&b) {
                Ok(s) => s,
                Err(e) => {
                    let aside = dir.join(format!("state.json.corrupt-{}", util::now_secs()));
                    std::fs::rename(&p, &aside)?;
                    util::log(&format!("state.json did not parse ({e}); moved to {}", aside.display()));
                    State::default()
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => State::default(),
            Err(e) => return Err(e),
        };
        let mut dirty = false;
        if st.server_id.len() != 32 {
            st.server_id = util::hex(&util::random_bytes::<16>());
            dirty = true;
        }
        if st.version == 0 {
            st.version = 1;
            dirty = true;
        }
        if dirty {
            st.save(dir)?;
        }
        Ok(st)
    }

    pub fn save(&self, dir: &Path) -> io::Result<()> {
        let text = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        util::write_private(&state_path(dir), &text)
    }

    pub fn project(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }

    pub fn project_name(&self, id: &str) -> String {
        self.project(id).map(|p| p.name.clone()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ts-state-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn state_round_trips_and_keeps_its_id() {
        let d = tmpdir("rt");
        let mut st = State::load(&d).unwrap();
        assert_eq!(st.server_id.len(), 32);
        st.projects.push(Project { id: "p1".into(), name: "api".into(), path: "/srv/api".into(), non_git: false });
        st.tasks.push(TaskRec {
            id: "t1".into(),
            name: "fix".into(),
            project_id: "p1".into(),
            path: "/x".into(),
            branch: "fix".into(),
            base_branch: "main".into(),
            agent: "claude".into(),
            agent_args: vec!["--model".into(), "opus".into()],
            created: "2026-10-18T12:00:00Z".into(),
            archived: false,
            is_main_checkout: false,
            org: serde_json::json!({"name": "fix", "pinned": true}),
        });
        st.save(&d).unwrap();
        let back = State::load(&d).unwrap();
        assert_eq!(back, st);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(state_path(&d)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_corrupt_state_is_moved_aside_not_lost() {
        let d = tmpdir("corrupt");
        std::fs::write(state_path(&d), b"{not json").unwrap();
        let st = State::load(&d).unwrap();
        assert!(st.tasks.is_empty());
        let aside = std::fs::read_dir(&d).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("state.json.corrupt-"));
        assert!(aside);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unknown_fields_from_a_newer_server_are_tolerated() {
        let st: State = serde_json::from_str(r#"{"version":9,"server_id":"x","tasks":[{"id":"t","future":1}],"other":true}"#).unwrap();
        assert_eq!(st.tasks[0].id, "t");
    }
}
