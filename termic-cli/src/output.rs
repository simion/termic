//! Text renderers for the read verbs. Pure string builders so the
//! output contract is golden-testable. Copy rule: no em dashes in any
//! CLI output.

use serde::Serialize;
use termic_proto::{
    ArchiveData, DiffStat, NewData, OpenData, ProjectInfo, ProjectRemoveData, StreamEvent,
    TaskStatus, TaskSummary, WaitData, WaitOutcome, WaitResult,
};

/// One JSON object, compact, exactly as documented in each verb's help.
pub fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "{}".into())
}

/// One stream-json event line: the wire event minus its transport
/// fields (`id`, `stream`), which are connection plumbing, not output.
pub fn event_line(ev: &StreamEvent) -> String {
    let mut v = serde_json::to_value(ev).unwrap_or_default();
    if let Some(o) = v.as_object_mut() {
        o.remove("id");
        o.remove("stream");
    }
    serde_json::to_string(&v).unwrap_or_else(|_| "{}".into())
}

/// The stream-json terminator: the verb's result object tagged
/// `"event":"result"`, so consumers read one uniform NDJSON stream.
pub fn result_line<T: Serialize>(v: &T) -> String {
    let val = serde_json::to_value(v).unwrap_or_default();
    match val {
        serde_json::Value::Object(o) => {
            let mut out = serde_json::Map::new();
            out.insert("event".into(), serde_json::Value::String("result".into()));
            out.extend(o);
            serde_json::to_string(&serde_json::Value::Object(out)).unwrap_or_else(|_| "{}".into())
        }
        other => serde_json::to_string(&other).unwrap_or_else(|_| "{}".into()),
    }
}

pub fn list_quiet(tasks: &[TaskSummary]) -> String {
    tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>().join("\n")
}

pub fn diff_cell(diff: &Option<DiffStat>) -> String {
    match diff {
        None => "-".into(),
        Some(d) => {
            let mut s = format!("{}f +{} -{}", d.files_changed, d.insertions, d.deletions);
            if d.untracked > 0 {
                s.push_str(&format!(" {}u", d.untracked));
            }
            s
        }
    }
}

pub fn state_cell(state: &Option<String>) -> String {
    state.clone().unwrap_or_else(|| "-".into())
}

pub fn list_text(tasks: &[TaskSummary]) -> String {
    if tasks.is_empty() {
        return "no tasks".into();
    }
    // Project then task, matching how tasks are addressed everywhere else
    // (`status project/task`, the `project/name` ambiguity errors). Rows
    // arrive already sorted by (project, name), so this reads top-down.
    let header = ["PROJECT", "TASK", "AGENT", "STATE", "DIFF", "BRANCH"];
    let rows: Vec<[String; 6]> = tasks
        .iter()
        .map(|t| {
            [
                t.project.clone(),
                t.name.clone(),
                t.agent.clone(),
                state_cell(&t.work_state),
                diff_cell(&t.diff),
                t.branch.clone(),
            ]
        })
        .collect();
    // Width by CHARACTER count, not bytes: Rust's `{:width$}` pads strings
    // by chars, so a byte-length width over-pads any multi-byte name and
    // skews the table. (Still not display-width-aware for CJK, but names
    // are normally ASCII slugs.)
    let cells = |s: &str| s.chars().count();
    let mut widths: Vec<usize> = header.iter().map(|h| cells(h)).collect();
    for row in &rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cells(cell));
        }
    }
    let fmt_row = |cells: &[String]| -> String {
        cells
            .iter()
            .enumerate()
            .map(|(i, c)| {
                if i == cells.len() - 1 {
                    c.clone()
                } else {
                    format!("{:w$}", c, w = widths[i])
                }
            })
            .collect::<Vec<_>>()
            .join("  ")
            .trim_end()
            .to_string()
    };
    let mut out = vec![fmt_row(&header.map(String::from))];
    out.extend(rows.iter().map(|r| fmt_row(r)));
    out.join("\n")
}

pub fn status_text(t: &TaskStatus) -> String {
    let s = &t.summary;
    let mut lines: Vec<String> = Vec::new();
    let mut push = |k: &str, v: String| lines.push(format!("{k:<13}{v}"));
    push("name:", s.name.clone());
    push("project:", s.project.clone());
    push("agent:", s.agent.clone());
    let state = match (s.work_state.as_deref(), s.open_tabs) {
        // No answer from the webview at all (busy, or still booting).
        (None, _) => "unknown (Termic UI did not answer)".into(),
        // Known to the app, but no agent is running for it.
        (Some("inactive"), _) => "inactive (no agent open)".into(),
        (Some(st), Some(n)) if n > 0 => format!("{st} ({n} tabs open)"),
        (Some(st), _) => st.to_string(),
    };
    push("state:", state);
    let branch = if s.base_branch.is_empty() {
        s.branch.clone()
    } else {
        format!("{} (from {})", s.branch, s.base_branch)
    };
    push("branch:", branch);
    push("path:", s.path.clone());
    push("sandbox:", t.sandbox.clone());
    push("sessions:", t.sessions.to_string());
    let dirty = match (&t.dirty_files, &s.diff) {
        (Some(n), Some(d)) => format!(
            "{n} ({} changed, +{} -{}, {} untracked)",
            d.files_changed, d.insertions, d.deletions, d.untracked
        ),
        (Some(n), None) => n.to_string(),
        (None, _) => "unknown (not a git checkout?)".into(),
    };
    push("dirty files:", dirty);
    push("created:", s.created.clone());
    if s.is_main_checkout {
        push("checkout:", "main checkout (shared with other main-checkout tasks)".into());
    }
    lines.join("\n")
}

pub fn open_text(d: &OpenData) -> String {
    match &d.task {
        Some(t) => format!("opened {}/{} in Termic", t.project, t.name),
        None => "raised the Termic window (no task matched here)".into(),
    }
}

/// The block `termic new` prints at the `created` event (text mode).
pub fn new_created_text(t: &TaskSummary) -> String {
    let mut lines = vec![format!("created {}/{}", t.project, t.name)];
    let mut push = |k: &str, v: String| lines.push(format!("  {k:<8}{v}"));
    push("agent:", t.agent.clone());
    if t.is_main_checkout {
        push("mode:", "main checkout (shared with the live repo)".into());
    } else {
        let branch = if t.base_branch.is_empty() {
            t.branch.clone()
        } else {
            format!("{} (from {})", t.branch, t.base_branch)
        };
        push("branch:", branch);
    }
    push("path:", t.path.clone());
    push("id:", t.id.clone());
    lines.join("\n")
}

/// One line saying how a watched run ended.
pub fn outcome_text(r: &WaitResult) -> String {
    match r.outcome {
        WaitOutcome::Done => match r.state.as_deref() {
            Some("inactive") => "the agent is gone (tab closed or task archived)".into(),
            _ => "agent finished".into(),
        },
        WaitOutcome::NeedsInput => "agent stopped and needs input".into(),
        WaitOutcome::Timeout => match &r.detail {
            Some(d) => format!("stopped watching ({d}); the task keeps running"),
            None => "timed out; the task keeps running in Termic".into(),
        },
        WaitOutcome::NotDelivered => match &r.detail {
            Some(d) => format!("the prompt was never delivered ({d})"),
            None => "the prompt was never delivered".into(),
        },
    }
}

/// `new`'s final text line: the outcome under --wait, nothing otherwise
/// (the created event already printed the task block).
pub fn new_final_text(n: &NewData) -> String {
    match &n.wait {
        Some(r) => outcome_text(r),
        None => String::new(),
    }
}

pub fn wait_text(w: &WaitData) -> String {
    outcome_text(&w.result)
}

pub fn archive_text(a: &ArchiveData) -> String {
    // killed_agents counts every live PTY of the task (agents, shells,
    // setup tabs alike), so say "terminals", not "agents".
    let killed = match a.killed_agents {
        0 => "no live terminals".into(),
        1 => "1 live terminal killed".into(),
        n => format!("{n} live terminals killed"),
    };
    format!("archived {}/{} ({killed})", a.project, a.name)
}

pub fn project_list_text(projects: &[ProjectInfo]) -> String {
    if projects.is_empty() {
        return "no projects".into();
    }
    let header = ["NAME", "TASKS", "AGENT", "PATH"];
    let rows: Vec<[String; 4]> = projects
        .iter()
        .map(|p| {
            [p.name.clone(), p.tasks.to_string(), p.default_agent.clone(), p.root_path.clone()]
        })
        .collect();
    let cells = |s: &str| s.chars().count();
    let mut widths: Vec<usize> = header.iter().map(|h| cells(h)).collect();
    for row in &rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cells(cell));
        }
    }
    let fmt_row = |cells: &[String]| -> String {
        cells
            .iter()
            .enumerate()
            .map(|(i, c)| {
                if i == cells.len() - 1 { c.clone() } else { format!("{:w$}", c, w = widths[i]) }
            })
            .collect::<Vec<_>>()
            .join("  ")
            .trim_end()
            .to_string()
    };
    let mut out = vec![fmt_row(&header.map(String::from))];
    out.extend(rows.iter().map(|r| fmt_row(r)));
    out.join("\n")
}

pub fn project_add_text(p: &ProjectInfo) -> String {
    format!("added project {} at {}", p.name, p.root_path)
}

pub fn project_remove_text(r: &ProjectRemoveData) -> String {
    let tasks = match r.removed_tasks {
        0 => "no tasks".into(),
        1 => "1 task archived".into(),
        n => format!("{n} tasks archived"),
    };
    format!("removed project {} ({tasks})", r.name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary() -> TaskSummary {
        TaskSummary {
            id: "id-1".into(),
            name: "fix-auth".into(),
            project: "web".into(),
            agent: "claude".into(),
            branch: "fix-auth".into(),
            base_branch: "main".into(),
            path: "/w/fix-auth".into(),
            is_main_checkout: false,
            created: "2026-01-01T00:00:00Z".into(),
            work_state: Some("working".into()),
            open_tabs: Some(2),
            diff: Some(DiffStat { files_changed: 3, insertions: 10, deletions: 2, untracked: 1 }),
        }
    }

    #[test]
    fn list_text_golden() {
        let out = list_text(&[summary(), TaskSummary {
            name: "longer-task-name".into(),
            project: "api".into(),
            agent: "codex".into(),
            branch: "b2".into(),
            ..Default::default()
        }]);
        let expected = "\
PROJECT  TASK              AGENT   STATE    DIFF          BRANCH
web      fix-auth          claude  working  3f +10 -2 1u  fix-auth
api      longer-task-name  codex   -        -             b2";
        assert_eq!(out, expected);
    }

    #[test]
    fn list_text_empty() {
        assert_eq!(list_text(&[]), "no tasks");
    }

    #[test]
    fn list_text_width_is_char_not_byte_based() {
        // "café" (4 chars / 5 bytes) is the widest TASK, tying the header
        // "TASK" (4). Char-based width => the TASK column is 4 wide, so the
        // name is followed by exactly the 2-space column separator; a
        // byte-based width (the old bug) would size it to 5 and add a space.
        let t = TaskSummary {
            name: "café".into(),
            project: "web".into(),
            agent: "a".into(),
            branch: "b".into(),
            ..Default::default()
        };
        let out = list_text(&[t]);
        let row = out.lines().nth(1).unwrap();
        assert!(row.contains("café  a"), "misaligned row: {row:?}");
    }

    #[test]
    fn status_text_golden() {
        let t = TaskStatus {
            summary: summary(),
            sandbox: "enforce".into(),
            sessions: 2,
            dirty_files: Some(4),
        };
        let expected = "\
name:        fix-auth
project:     web
agent:       claude
state:       working (2 tabs open)
branch:      fix-auth (from main)
path:        /w/fix-auth
sandbox:     enforce
sessions:    2
dirty files: 4 (3 changed, +10 -2, 1 untracked)
created:     2026-01-01T00:00:00Z";
        assert_eq!(status_text(&t), expected);
    }

    #[test]
    fn status_text_inactive_reads_as_no_agent_not_unknown() {
        let mut s = summary();
        s.work_state = Some("inactive".into());
        s.open_tabs = Some(0);
        let t = TaskStatus { summary: s, sandbox: "off".into(), sessions: 1, dirty_files: Some(4) };
        let out = status_text(&t);
        assert!(out.contains("state:       inactive (no agent open)"), "{out}");
        assert!(!out.contains("did not answer"));
        assert!(!out.contains("0 tabs open"));
    }

    #[test]
    fn status_text_degrades_when_webview_and_git_are_silent() {
        let mut s = summary();
        s.work_state = None;
        s.open_tabs = None;
        s.diff = None;
        let t = TaskStatus { summary: s, sandbox: "off".into(), sessions: 0, dirty_files: None };
        let out = status_text(&t);
        assert!(out.contains("state:       unknown (Termic UI did not answer)"));
        assert!(out.contains("dirty files: unknown (not a git checkout?)"));
    }

    #[test]
    fn open_text_variants() {
        assert_eq!(
            open_text(&OpenData { task: Some(summary()), raised: true }),
            "opened web/fix-auth in Termic"
        );
        assert_eq!(
            open_text(&OpenData { task: None, raised: true }),
            "raised the Termic window (no task matched here)"
        );
    }

    #[test]
    fn new_created_text_golden() {
        let out = new_created_text(&summary());
        let expected = "\
created web/fix-auth
  agent:  claude
  branch: fix-auth (from main)
  path:   /w/fix-auth
  id:     id-1";
        assert_eq!(out, expected);
        // Main-checkout tasks show the shared-checkout mode, not a branch.
        let mut s = summary();
        s.is_main_checkout = true;
        let out = new_created_text(&s);
        assert!(out.contains("main checkout"), "{out}");
        assert!(!out.contains("branch:"), "{out}");
    }

    #[test]
    fn outcome_text_variants() {
        let r = |outcome, state: Option<&str>, detail: Option<&str>| WaitResult {
            outcome,
            state: state.map(str::to_string),
            detail: detail.map(str::to_string),
        };
        assert_eq!(outcome_text(&r(WaitOutcome::Done, Some("done"), None)), "agent finished");
        assert!(outcome_text(&r(WaitOutcome::Done, Some("inactive"), None)).contains("gone"));
        assert_eq!(
            outcome_text(&r(WaitOutcome::NeedsInput, Some("waiting"), None)),
            "agent stopped and needs input"
        );
        assert!(outcome_text(&r(WaitOutcome::Timeout, None, None)).contains("keeps running"));
        assert!(
            outcome_text(&r(WaitOutcome::NotDelivered, None, Some("webview reloaded")))
                .contains("webview reloaded")
        );
    }

    #[test]
    fn archive_and_project_text() {
        let a = ArchiveData {
            task_id: "w1".into(),
            name: "fix-auth".into(),
            project: "web".into(),
            killed_agents: 2,
        };
        assert_eq!(archive_text(&a), "archived web/fix-auth (2 live terminals killed)");
        let p = ProjectInfo {
            id: "p1".into(),
            name: "web".into(),
            root_path: "/repo/web".into(),
            tasks: 3,
            default_agent: "claude".into(),
        };
        assert_eq!(project_add_text(&p), "added project web at /repo/web");
        let out = project_list_text(&[p]);
        assert!(out.starts_with("NAME"), "{out}");
        assert!(out.contains("web   3      claude  /repo/web"), "{out:?}");
        assert_eq!(project_list_text(&[]), "no projects");
        let r = ProjectRemoveData { name: "web".into(), removed_tasks: 1 };
        assert_eq!(project_remove_text(&r), "removed project web (1 task archived)");
    }

    #[test]
    fn event_line_strips_transport_fields() {
        let ev = StreamEvent::setup_output("req-9", "npm install\n".into());
        let v: serde_json::Value = serde_json::from_str(&event_line(&ev)).unwrap();
        assert_eq!(v["event"], "setup_output");
        assert_eq!(v["data"], "npm install\n");
        assert!(v.get("id").is_none());
        assert!(v.get("stream").is_none());
    }

    #[test]
    fn result_line_is_tagged() {
        let w = WaitData {
            task_id: "w1".into(),
            result: WaitResult {
                outcome: WaitOutcome::Done,
                state: Some("done".into()),
                detail: None,
            },
        };
        let v: serde_json::Value = serde_json::from_str(&result_line(&w)).unwrap();
        assert_eq!(v["event"], "result");
        assert_eq!(v["task_id"], "w1");
        assert_eq!(v["outcome"], "done");
    }

    #[test]
    fn output_carries_no_em_dashes() {
        let t = TaskStatus {
            summary: summary(),
            sandbox: "enforce".into(),
            sessions: 2,
            dirty_files: Some(4),
        };
        let wait = WaitResult { outcome: WaitOutcome::Timeout, state: None, detail: None };
        for s in [
            list_text(&[summary()]),
            status_text(&t),
            open_text(&OpenData { task: None, raised: true }),
            new_created_text(&summary()),
            outcome_text(&wait),
            archive_text(&ArchiveData {
                task_id: "w".into(),
                name: "n".into(),
                project: "p".into(),
                killed_agents: 0,
            }),
            project_list_text(&[ProjectInfo::default()]),
            project_remove_text(&ProjectRemoveData { name: "n".into(), removed_tasks: 0 }),
        ] {
            assert!(!s.contains('\u{2014}'), "em dash in output: {s}");
        }
    }
}
