//! Text renderers for the read verbs. Pure string builders so the
//! output contract is golden-testable. Copy rule: no em dashes in any
//! CLI output.

use serde::Serialize;
use termic_proto::{DiffStat, OpenData, TaskStatus, TaskSummary};

/// One JSON object, compact, exactly as documented in each verb's help.
pub fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "{}".into())
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
    fn output_carries_no_em_dashes() {
        let t = TaskStatus {
            summary: summary(),
            sandbox: "enforce".into(),
            sessions: 2,
            dirty_files: Some(4),
        };
        for s in [
            list_text(&[summary()]),
            status_text(&t),
            open_text(&OpenData { task: None, raised: true }),
        ] {
            assert!(!s.contains('\u{2014}'), "em dash in output: {s}");
        }
    }
}
