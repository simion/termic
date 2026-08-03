//! Text renderers for the read verbs. Pure string builders so the
//! output contract is golden-testable. Copy rule: no em dashes in any
//! CLI output.

use serde::Serialize;
use termic_proto::{
    send_mode, AgentsData, ApplyData, ArchiveData, DiffData, DiffStat, NewData, OpenData,
    ProjectInfo, ProjectRemoveData, QuitData, RenameData, ResultData, SendData, StreamEvent,
    TabData, TabStatus, TaskStatus, TaskSummary, WaitData, WaitOutcome, WaitResult,
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

/// One `status` tab row: `[n] title (facts)`, where the facts are the
/// kind or agent, the per-tab state when one exists, the queue depth,
/// and default-ness.
fn tab_row(t: &TabStatus) -> String {
    let mut bits: Vec<String> = Vec::new();
    bits.push(if t.kind == "agent" { t.agent.clone() } else { t.kind.clone() });
    // Liveness outranks state: a dead tab's state is by definition
    // stale (a stopped task keeps workState on its tabs), and "done"
    // on a tab with no PTY would invite a send that errors.
    if t.kind == "agent" && !t.live {
        bits.push("not running".into());
    } else if let Some(st) = &t.state {
        bits.push(st.clone());
    }
    if t.queued > 0 {
        bits.push(format!("{} queued", t.queued));
    }
    if t.is_default {
        bits.push("default".into());
    }
    format!("[{}] {} ({})", t.index, t.title, bits.join(", "))
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
    // The strip, one row per tab, numbered exactly as `--tab <n>` counts
    // them. Absent (not empty) when the webview has not answered: an
    // unknown strip must not render as "no tabs". Ids stay in the --json
    // shape; the index and title here are the human handles.
    if let Some(tabs) = &t.tabs {
        if tabs.is_empty() {
            push("tabs:", "none open".into());
        } else {
            for (i, tab) in tabs.iter().enumerate() {
                push(if i == 0 { "tabs:" } else { "" }, tab_row(tab));
            }
        }
    }
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

pub fn rename_text(r: &RenameData) -> String {
    // Worktree tasks: say out loud that the label moved and the git side
    // did not, so an agent never concludes the branch was renamed too.
    // Main-checkout tasks have no task-owned branch or directory to
    // reassure about.
    if r.task.is_main_checkout {
        format!("renamed {}/{} to \"{}\"", r.task.project, r.old_name, r.task.name)
    } else {
        format!(
            "renamed {}/{} to \"{}\" (branch {} and its directory are unchanged)",
            r.task.project, r.old_name, r.task.name, r.task.branch
        )
    }
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

/// The delivery-mode line shared by `send` and `tab -p`. An incapable
/// target gets the honesty note inline (its completion cannot be
/// observed).
fn mode_text(mode: &str, capable: bool) -> String {
    let mut line = match mode {
        send_mode::QUEUED => {
            "prompt queued; it sends when the agent's current turn finishes".to_string()
        }
        send_mode::SPAWNED => {
            "agent starting; the prompt injects once it is ready (unconfirmed without --wait)"
                .to_string()
        }
        _ => "prompt delivered".to_string(),
    };
    if !capable {
        line.push_str(
            " (this agent has work-done detection disabled, so completion cannot be observed)",
        );
    }
    line
}

/// `send`'s final text: the wait outcome when watched, the delivery
/// mode otherwise.
pub fn send_text(s: &SendData) -> String {
    if let Some(r) = &s.wait {
        return outcome_text(r);
    }
    mode_text(&s.mode, s.capable)
}

pub fn apply_text(a: &ApplyData) -> String {
    let n = |c: u64, what: &str| match c {
        1 => format!("1 {what}"),
        c => format!("{c} {what}s"),
    };
    format!(
        "applied to the main checkout: {} patched, {} copied",
        n(a.tracked_files, "tracked file"),
        n(a.untracked_files, "untracked file")
    )
}

/// `diff` summary text (without --full; --full prints the raw patch).
pub fn diff_text(d: &DiffData) -> String {
    let mut out = format!(
        "{} files changed, +{} -{} ({} untracked)",
        d.files_changed, d.insertions, d.deletions, d.untracked
    );
    let commits = d.commits.trim();
    if !commits.is_empty() {
        out.push_str("\ncommits:");
        for line in commits.lines() {
            out.push_str("\n  ");
            out.push_str(line);
        }
    }
    out
}

pub fn result_text(r: &ResultData) -> String {
    r.text.clone()
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

/// The confirmation question. Names what actually dies, because that is
/// the whole reason quitting a windowless Termic is a decision at all.
pub fn quit_question(p: &QuitData) -> String {
    if p.live_agents == 0 {
        return "termic: quit Termic?".into();
    }
    // NOTE: quitting also reverts any active spotlight session, which force-
    // checks-out the project's MAIN checkout. That is the one effect reaching
    // outside Termic's own state, so `quit --help` spells it out. It is left
    // out of this one-line question deliberately: spotlight is off by default
    // and naming it here would bury the number that matters.
    let agents = plural(p.live_agents, "agent", "agents");
    let tasks = plural(p.tasks_with_agents, "task", "tasks");
    // Three states, not two. `None` is UNKNOWN (the work-state cache went
    // stale), and saying so beats rendering it the same as "nothing is
    // working" on a question about killing agents.
    let working = match p.working_tasks {
        Some(0) => String::new(),
        Some(n) => format!(" {} still working.", plural(n, "task", "tasks")),
        None => " Work state unknown.".to_string(),
    };
    format!(
        "termic: quit Termic? This kills {agents} across {tasks}.{working}",
    )
}

pub fn quit_text(q: &QuitData) -> String {
    if q.live_agents == 0 {
        return "Termic is quitting.".into();
    }
    // Present tense on purpose: this reply is built and written BEFORE
    // serve_conn fires the teardown, so "killed" would claim something that
    // has not happened yet (guaranteed to follow, but not yet true).
    format!("Termic is quitting; {}.", plural(q.live_agents, "agent", "agents"))
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The registry as a table. `usable` is what a caller acts on, so it gets a
/// column of its own rather than being left implied by the other two: an entry
/// can be enabled but missing from PATH, and that combination is exactly the
/// one that produces a confusing `tab` failure.
pub fn agents_text(a: &AgentsData) -> String {
    if a.agents.is_empty() {
        return "No agents configured.".into();
    }
    // Registry ids are user-editable (`my-custom-terminal` is 18 chars), and
    // this table is documented output, so size the column to the data rather
    // than to a constant that a long id silently breaks. Never narrower than
    // the header.
    let idw = a
        .agents
        .iter()
        .map(|e| e.id.chars().count())
        .max()
        .unwrap_or(0)
        .max("ID".len());
    let mut out = format!("{:<idw$} KIND      ENABLED  INSTALLED  USABLE\n", "ID");
    for e in &a.agents {
        let installed = match e.installed {
            Some(true) => "yes",
            Some(false) => "no",
            // Blank, not "no": detection may simply not have run.
            None => "-",
        };
        out.push_str(&format!(
            "{:<idw$} {:<9} {:<8} {:<10} {}\n",
            e.id,
            e.kind,
            if e.enabled { "yes" } else { "no" },
            installed,
            if e.usable { "yes" } else { "no" },
        ));
    }
    out.trim_end().to_string()
}

/// One line naming the tab and, crucially, its id: that id is the stable
/// selector, so printing it is what lets a script address the tab it just
/// made instead of racing an index or an agent-authored title.
pub fn tab_text(t: &TabData) -> String {
    // `title` is what the tab shows in the GUI, and it is the only useful
    // label when it differs from the cli id: a custom-command task's tab is
    // titled with the TASK NAME, so printing `cli` alone would say "custom".
    let label = if t.title.is_empty() || t.title.eq_ignore_ascii_case(&t.cli) {
        t.cli.clone()
    } else {
        format!("{} ({})", t.title, t.cli)
    };
    let mut out = format!("Opened {label} tab {} in {}.", t.tab_id, t.task_id);
    // `tab -p`: the delivery outcome rides the same reply (send's own
    // vocabulary, so the two verbs never describe one delivery two ways).
    if let Some(p) = &t.prompt {
        out.push('\n');
        out.push_str(&p.wait.as_ref().map_or_else(
            || mode_text(&p.mode, p.capable),
            outcome_text,
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use termic_proto::{AgentEntry, PromptOutcome};

    fn d(tasks: u32, agents: u32, working: Option<u32>) -> QuitData {
        QuitData { running: true, tasks_with_agents: tasks, live_agents: agents, working_tasks: working, quitting: false }
    }

    // The question is the whole safety surface of `quit`: it is the only
    // thing standing between a teardown script and every running agent.
    #[test]
    fn question_names_what_dies() {
        let q = quit_question(&d(2, 3, Some(1)));
        assert!(q.contains("3 agents"), "{q}");
        assert!(q.contains("2 tasks"), "{q}");
        assert!(q.contains("1 task still working"), "{q}");
    }

    #[test]
    fn question_singularises() {
        let q = quit_question(&d(1, 1, Some(0)));
        assert!(q.contains("1 agent across 1 task"), "{q}");
        assert!(!q.contains("still working"), "nothing working, so do not mention it: {q}");
    }

    // The count is per TASK (the work-state cache aggregates that way), so
    // the wording must not imply agents. Two busy tabs in one task is "1 task
    // still working", not "2 agents".
    #[test]
    fn question_says_tasks_not_agents_for_the_working_count() {
        let q = quit_question(&d(2, 5, Some(2)));
        assert!(q.contains("5 agents"), "{q}");
        assert!(q.contains("2 tasks still working"), "{q}");
    }

    // `installed` must render "-" for unknown, never "no": the two mean
    // different things and a user reading "no" would go install something
    // that is already there.
    #[test]
    fn agents_table_distinguishes_unknown_from_missing() {
        let d = AgentsData {
            agents: vec![
                AgentEntry { id: "claude".into(), kind: "agent".into(), enabled: true, installed: Some(true), usable: true },
                AgentEntry { id: "codex".into(), kind: "agent".into(), enabled: true, installed: Some(false), usable: false },
                AgentEntry { id: "gemini".into(), kind: "agent".into(), enabled: true, installed: None, usable: true },
            ],
        };
        let out = agents_text(&d);
        assert!(out.contains("claude"), "{out}");
        // unknown renders as a dash, not "no"
        let gemini = out.lines().find(|l| l.starts_with("gemini")).unwrap();
        assert!(gemini.contains(" -  "), "unknown must be a dash: {gemini}");
        let codex = out.lines().find(|l| l.starts_with("codex")).unwrap();
        assert!(codex.contains("no"), "{codex}");
    }

    #[test]
    fn agents_table_is_not_empty_looking_when_there_are_none() {
        assert_eq!(agents_text(&AgentsData { agents: vec![] }), "No agents configured.");
    }

    // Registry ids are user-editable, so the id column cannot be a constant.
    // Every row's KIND must still start at the same column as the header's.
    #[test]
    fn agents_table_stays_aligned_when_an_id_is_longer_than_the_header() {
        let d = AgentsData {
            agents: vec![
                AgentEntry { id: "my-very-long-custom-terminal".into(), kind: "terminal".into(), enabled: true, installed: None, usable: true },
                AgentEntry { id: "cc".into(), kind: "agent".into(), enabled: true, installed: Some(true), usable: true },
            ],
        };
        let out = agents_text(&d);
        /// Column where the second field starts: first non-space after the id.
        fn kind_col(line: &str) -> usize {
            let id_end = line.find(' ').expect("row has an id");
            line.len() - line[id_end..].trim_start().len()
        }
        let mut lines = out.lines();
        let header = lines.next().unwrap();
        let want = header.find("KIND").expect("header has KIND");
        assert_eq!(kind_col(header), want);
        for l in lines {
            assert_eq!(kind_col(l), want, "misaligned row: {l:?}");
        }
        // And the long id is not truncated.
        assert!(out.contains("my-very-long-custom-terminal"), "{out}");
    }

    // The id is the whole point of the line: it is what a script records.
    #[test]
    fn tab_text_prints_the_id() {
        let t = TabData {
            task_id: "ws1".into(), tab_id: "abc-123".into(),
            cli: "claude".into(), title: "claude".into(),
            prompt: None,
        };
        let out = tab_text(&t);
        assert!(out.contains("abc-123"), "{out}");
        assert!(out.contains("claude"), "{out}");
    }

    #[test]
    fn new_verbs_carry_no_em_dashes() {
        let a = agents_text(&AgentsData {
            agents: vec![AgentEntry { id: "claude".into(), kind: "agent".into(), enabled: true, installed: None, usable: true }],
        });
        let t = tab_text(&TabData {
            task_id: "ws1".into(), tab_id: "x".into(), cli: "shell".into(), title: "Terminal".into(),
            prompt: None,
        });
        for s in [a, t] {
            assert!(!s.contains('\u{2014}'), "em dash in CLI output: {s}");
        }
    }

    // A stale work-state cache is UNKNOWN, not idle. Rendering it as silence
    // would make "nothing is working" and "I cannot tell" identical on a
    // prompt about killing agents, which understates what is about to die.
    #[test]
    fn question_says_unknown_rather_than_dropping_the_note() {
        let q = quit_question(&d(2, 3, None));
        assert!(q.contains("3 agents"), "{q}");
        assert!(q.contains("Work state unknown"), "{q}");
        assert!(!q.contains("still working"), "{q}");
    }

    // Nothing running: do not invent a scary question.
    #[test]
    fn question_is_plain_when_nothing_is_running() {
        assert_eq!(quit_question(&d(0, 0, Some(0))), "termic: quit Termic?");
    }

    #[test]
    fn text_reports_the_kill_count() {
        let mut q = d(1, 2, Some(0));
        q.quitting = true;
        assert!(quit_text(&q).contains("2 agents"), "{}", quit_text(&q));
        assert_eq!(quit_text(&d(0, 0, Some(0))), "Termic is quitting.");
    }

    // Copy rule: no em dashes anywhere in CLI output.
    #[test]
    fn no_em_dashes() {
        for s in [quit_question(&d(2, 3, Some(1))), quit_text(&d(1, 2, Some(0)))] {
            assert!(!s.contains('\u{2014}'), "em dash in CLI output: {s}");
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn tab_status(
        index: u32,
        kind: &str,
        agent: &str,
        title: &str,
        state: Option<&str>,
        is_default: bool,
        live: bool,
        queued: u32,
    ) -> TabStatus {
        TabStatus {
            id: format!("tab-{index}"),
            index,
            kind: kind.into(),
            agent: agent.into(),
            title: title.into(),
            state: state.map(str::to_string),
            is_default,
            live,
            queued,
        }
    }

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
            tabs: None,
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

    // The strip block: numbered exactly as `--tab <n>` resolves, one
    // row per tab, kind or agent first, then state, queue, defaultness.
    #[test]
    fn status_text_tabs_golden() {
        let t = TaskStatus {
            summary: summary(),
            sandbox: "enforce".into(),
            sessions: 2,
            dirty_files: Some(4),
            tabs: Some(vec![
                tab_status(1, "agent", "claude", "claude", Some("working"), true, true, 0),
                tab_status(2, "agent", "codex", "fixing tests", Some("done"), false, true, 1),
                tab_status(3, "shell", "shell", "Terminal", None, false, true, 0),
                // Dead tab still carrying a stale workState (a stopped
                // task keeps it): liveness must outrank it, or the row
                // reads "done" and invites a send that errors.
                tab_status(4, "agent", "claude", "claude", Some("done"), false, false, 0),
            ]),
        };
        let out = status_text(&t);
        let expected = "\
tabs:        [1] claude (claude, working, default)
             [2] fixing tests (codex, done, 1 queued)
             [3] Terminal (shell)
             [4] claude (claude, not running)";
        assert!(out.contains(expected), "{out}");
    }

    #[test]
    fn status_text_unknown_strip_prints_nothing_but_empty_says_none() {
        // None = the webview is silent: the block must be ABSENT
        // (unknown is not an empty strip). Some([]) = a real answer.
        let mut t = TaskStatus {
            summary: summary(),
            sandbox: "off".into(),
            sessions: 0,
            dirty_files: None,
            tabs: None,
        };
        assert!(!status_text(&t).contains("tabs:"), "{}", status_text(&t));
        t.tabs = Some(vec![]);
        assert!(status_text(&t).contains("tabs:        none open"), "{}", status_text(&t));
    }

    // tab -p: the outcome line rides the tab reply, in send's own
    // vocabulary, so the two verbs never describe one delivery two ways.
    #[test]
    fn tab_text_prompt_outcomes() {
        let base = TabData {
            task_id: "ws1".into(),
            tab_id: "abc".into(),
            cli: "claude".into(),
            title: "claude".into(),
            prompt: None,
        };
        let spawned = TabData {
            prompt: Some(PromptOutcome {
                mode: send_mode::SPAWNED.into(),
                capable: true,
                wait: None,
            }),
            ..base.clone()
        };
        let out = tab_text(&spawned);
        assert!(out.contains("abc"), "{out}");
        assert!(out.contains("agent starting"), "{out}");
        let waited = TabData {
            prompt: Some(PromptOutcome {
                mode: send_mode::SPAWNED.into(),
                capable: true,
                wait: Some(WaitResult {
                    outcome: WaitOutcome::Done,
                    state: Some("done".into()),
                    detail: None,
                }),
            }),
            ..base
        };
        let out = tab_text(&waited);
        assert!(out.contains("agent finished"), "{out}");
        assert!(!out.contains("agent starting"), "wait outcome must replace the mode line: {out}");
    }

    #[test]
    fn status_text_inactive_reads_as_no_agent_not_unknown() {
        let mut s = summary();
        s.work_state = Some("inactive".into());
        s.open_tabs = Some(0);
        let t = TaskStatus { summary: s, sandbox: "off".into(), sessions: 1, dirty_files: Some(4), tabs: None };
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
        let t = TaskStatus { summary: s, sandbox: "off".into(), sessions: 0, dirty_files: None, tabs: None };
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
    fn send_text_variants() {
        let s = |mode: &str, capable: bool, wait: Option<WaitResult>| SendData {
            task_id: "w1".into(),
            mode: mode.into(),
            capable,
            wait,
        };
        assert_eq!(send_text(&s(send_mode::DELIVERED, true, None)), "prompt delivered");
        assert!(send_text(&s(send_mode::QUEUED, true, None)).contains("queued"));
        assert!(send_text(&s(send_mode::SPAWNED, true, None)).contains("unconfirmed"));
        assert!(
            send_text(&s(send_mode::DELIVERED, false, None)).contains("cannot be observed"),
            "incapable targets carry the honesty note"
        );
        let done = WaitResult { outcome: WaitOutcome::Done, state: Some("done".into()), detail: None };
        assert_eq!(send_text(&s(send_mode::DELIVERED, true, Some(done))), "agent finished");
    }

    #[test]
    fn apply_and_diff_and_result_text() {
        let a = ApplyData { task_id: "w1".into(), tracked_files: 3, untracked_files: 1 };
        assert_eq!(
            apply_text(&a),
            "applied to the main checkout: 3 tracked files patched, 1 untracked file copied"
        );
        let d = DiffData {
            task_id: "w1".into(),
            files_changed: 2,
            insertions: 10,
            deletions: 3,
            untracked: 1,
            commits: "abc123 fix\ndef456 more\n".into(),
            diff: None,
        };
        let expected = "\
2 files changed, +10 -3 (1 untracked)
commits:
  abc123 fix
  def456 more";
        assert_eq!(diff_text(&d), expected);
        // No commits: the summary line only.
        let d2 = DiffData { commits: "".into(), ..d };
        assert_eq!(diff_text(&d2), "2 files changed, +10 -3 (1 untracked)");
        let r = ResultData {
            task_id: "w1".into(),
            agent: "claude".into(),
            transcript: "/t.jsonl".into(),
            text: "All done.".into(),
        };
        assert_eq!(result_text(&r), "All done.");
        for s in [send_text(&SendData { task_id: "w".into(), mode: "queued".into(), capable: false, wait: None }), apply_text(&a), diff_text(&d2)] {
            assert!(!s.contains('\u{2014}'), "em dash in output: {s}");
        }
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
            // Sweeps the tab rows too (every branch of tab_row).
            tabs: Some(vec![
                tab_status(1, "agent", "claude", "claude", Some("working"), true, true, 2),
                tab_status(2, "shell", "shell", "Terminal", None, false, true, 0),
                tab_status(3, "agent", "codex", "codex", None, false, false, 0),
            ]),
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
