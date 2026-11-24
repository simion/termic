//! Agent transcripts as turns, for a remote client's chat view. Shared by
//! the desktop (cli_server.rs) and the headless server, so both read a
//! session the same way.

use crate::wire::Turn;

/// How many turns a remote transcript carries: the recent conversation,
/// not a whole day's session.
pub const TRANSCRIPT_TURNS: usize = 200;
/// A tool call's input is summarised to this many characters.
const TOOL_SUMMARY_CHARS: usize = 160;

/// The task's conversation for a remote client (docs/remote.md): the
/// person's prompts, the agent's replies, and one line per tool call.
/// Returns the task's id with it, resolved from an id or a name.
/// Claude Code JSONL -> turns. Sidechain lines (a subagent's internal
/// conversation) and tool results are left out; the result of a tool is
/// what the agent says about it next.
pub fn parse_claude_jsonl(jsonl: &str) -> Vec<Turn> {
    let mut out: Vec<Turn> = Vec::new();
    // Prompts typed while Claude works wait in its queue (enqueue, then a
    // remove once Claude reads them): still waiting at the end = "queued".
    // The operations alone drift: a dequeue names nothing, a remove's text
    // can differ from its enqueue, and popAll empties it. So a prompt also
    // leaves the queue when it shows up as sent, and a finished turn
    // empties it (Claude drains its queue when a turn ends). Without these,
    // a long session left consumed prompts on the phone as Queued for good.
    let mut queue: Vec<(String, Option<String>)> = Vec::new();
    let sent = |queue: &mut Vec<(String, Option<String>)>, text: &str| {
        if let Some(i) = queue.iter().position(|(q, _)| q == text.trim()) {
            queue.remove(i);
        }
    };
    for line in jsonl.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) == Some("queue-operation") {
            let text = v.get("content").and_then(|c| c.as_str()).unwrap_or("").trim().to_string();
            match v.get("operation").and_then(|o| o.as_str()) {
                Some("enqueue") if !text.is_empty() => {
                    queue.push((text, v.get("timestamp").and_then(|t| t.as_str()).map(str::to_string)))
                }
                Some("popAll") => queue.clear(),
                // A dequeue names nothing: it takes the oldest.
                Some("dequeue") | Some("remove") => {
                    let i = if text.is_empty() { Some(0) } else { queue.iter().position(|(q, _)| *q == text) };
                    if let Some(i) = i.filter(|&i| i < queue.len()) {
                        queue.remove(i);
                    }
                }
                _ => {}
            }
            continue;
        }
        if v.get("isSidechain").and_then(|s| s.as_bool()) == Some(true) {
            continue;
        }
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let ts = v.get("timestamp").and_then(|t| t.as_str()).map(str::to_string);
        // A prompt sent while Claude is still mid-turn is not a user line:
        // Claude records it as a queued_command attachment and folds it into
        // the next tool result. It is still the person's words.
        if kind == "attachment" {
            let a = v.get("attachment");
            let queued = a.and_then(|a| a.get("type")).and_then(|t| t.as_str()) == Some("queued_command")
                && a.and_then(|a| a.get("commandMode")).and_then(|m| m.as_str()) == Some("prompt");
            if let Some(text) = a.and_then(|a| a.get("prompt")).and_then(|p| p.as_str()).filter(|_| queued) {
                let text = text.trim();
                sent(&mut queue, text);
                if !text.is_empty() {
                    out.push(Turn { role: "user".into(), text: text.into(), tool: None, ts });
                }
            }
            continue;
        }
        if kind != "user" && kind != "assistant" {
            continue;
        }
        if kind == "assistant" && v.pointer("/message/stop_reason").and_then(|r| r.as_str()) == Some("end_turn") {
            queue.clear();
        }
        let Some(content) = v.pointer("/message/content") else { continue };
        let mut push = |role: &str, text: String, tool: Option<String>| {
            let text = text.trim().to_string();
            if !text.is_empty() || tool.is_some() {
                out.push(Turn { role: role.into(), text, tool, ts: ts.clone() });
            }
        };
        match content {
            serde_json::Value::String(text) => {
                // Claude records slash commands and local-command echoes as
                // user lines wrapped in tags; they are not the person's words.
                if kind == "user" && injected(text) {
                    continue;
                }
                if kind == "user" {
                    sent(&mut queue, text);
                }
                push(kind, text.clone(), None);
            }
            serde_json::Value::Array(blocks) => {
                for b in blocks {
                    match b.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            let text = b.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
                            if kind == "user" && injected(&text) {
                                continue;
                            }
                            if kind == "user" {
                                sent(&mut queue, &text);
                            }
                            push(kind, text, None);
                        }
                        Some("tool_use") if kind == "assistant" => {
                            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                            push("tool", tool_summary(b.get("input")), Some(name));
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out.extend(queue.into_iter().filter(|(t, _)| !injected(t)).map(|(text, ts)| Turn { role: "queued".into(), text, tool: None, ts }));
    let skip = out.len().saturating_sub(TRANSCRIPT_TURNS);
    out.drain(..skip);
    out
}

/// Text Claude records as a user line that is not the person's words: slash
/// commands, local-command echoes, reminders, background-task notices.
fn injected(text: &str) -> bool {
    ["<command-", "<local-command", "<system-reminder>", "<task-notification>", "[Request interrupted by user"].iter().any(|p| text.starts_with(p))
}

/// One line saying what a tool call does: its command, path, pattern or
/// description, whichever it has, cut to `TOOL_SUMMARY_CHARS`.
fn tool_summary(input: Option<&serde_json::Value>) -> String {
    let Some(input) = input else { return String::new() };
    // Claude's keys, then Codex's (`cmd`) and Antigravity's (a
    // `toolSummary` it writes itself, then `CommandLine`, `Query`, ...).
    let pick = [
        "description", "toolSummary", "command", "cmd", "CommandLine", "file_path", "path", "AbsolutePath", "Path",
        "pattern", "Pattern", "url", "query", "Query", "prompt",
    ]
        .iter()
        .find_map(|k| input.get(*k).and_then(|v| v.as_str()))
        .unwrap_or("");
    let one_line: String = pick.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > TOOL_SUMMARY_CHARS {
        let cut: String = one_line.chars().take(TOOL_SUMMARY_CHARS).collect();
        format!("{cut}...")
    } else {
        one_line
    }
}

// ───────────────────────────── codex ──────────────────────────────────

/// Codex's rollout JSONL -> turns. Its `user` messages also carry what
/// Codex injects (`<environment_context>`, `# AGENTS.md instructions`,
/// `<turn_aborted>`, image markers), which are not the person's words;
/// `developer` messages and reasoning are left out, and a tool's output
/// is what the agent says about it next. Versions before 0.150 also wrote
/// `user_message` events, later ones do not, so the response items are
/// the one source that covers both.
pub fn parse_codex_jsonl(jsonl: &str) -> Vec<Turn> {
    let mut out: Vec<Turn> = Vec::new();
    for line in jsonl.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
            continue;
        }
        let ts = v.get("timestamp").and_then(|t| t.as_str()).map(str::to_string);
        let Some(p) = v.get("payload") else { continue };
        let str_of = |k: &str| p.get(k).and_then(|x| x.as_str()).unwrap_or("");
        let mut push = |role: &str, text: String, tool: Option<String>| {
            let text = text.trim().to_string();
            if !text.is_empty() || tool.is_some() {
                out.push(Turn { role: role.into(), text, tool, ts: ts.clone() });
            }
        };
        match (str_of("type"), str_of("role")) {
            ("message", role @ ("user" | "assistant")) => {
                let want = if role == "user" { "input_text" } else { "output_text" };
                let text = p
                    .get("content")
                    .and_then(|c| c.as_array())
                    .into_iter()
                    .flatten()
                    .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some(want))
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .filter(|t| role == "assistant" || !codex_injected(t))
                    .collect::<Vec<_>>()
                    .join("\n");
                push(role, text, None);
            }
            ("function_call", _) => {
                let args = serde_json::from_str::<serde_json::Value>(str_of("arguments")).ok();
                push("tool", tool_summary(args.as_ref()), Some(str_of("name").to_string()));
            }
            // apply_patch: its input is the patch, so name the files it touches.
            ("custom_tool_call", _) => {
                let files: Vec<&str> = str_of("input")
                    .lines()
                    .filter_map(|l| {
                        ["*** Update File: ", "*** Add File: ", "*** Delete File: "].iter().find_map(|k| l.strip_prefix(k))
                    })
                    .collect();
                push("tool", one_line(&files.join(", ")), Some(str_of("name").to_string()));
            }
            ("web_search_call", _) => {
                let action = p.get("action");
                push("tool", tool_summary(action), Some("web_search".into()));
            }
            _ => {}
        }
    }
    let skip = out.len().saturating_sub(TRANSCRIPT_TURNS);
    out.drain(..skip);
    out
}

/// A block Codex adds to the person's message: a tagged block (the whole
/// text is `<tag ...>...`), its AGENTS.md preamble, or an image marker.
fn codex_injected(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("# AGENTS.md instructions")
        || t.starts_with("</image>")
        || (t.starts_with('<') && t[1..].starts_with(|c: char| c.is_ascii_lowercase()) && t[1..].split(['>', ' ']).next().is_some_and(|tag| {
            tag.chars().all(|c| c.is_ascii_lowercase() || c == '_') && t.trim_end().ends_with('>')
        }))
}

/// The task's Codex rollout under `sessions` (`~/.codex/sessions`): the
/// one named for `session_id` when the tab recorded it, else the newest
/// whose session started in `cwd`. Rollouts live under YYYY/MM/DD and are
/// named by start time, so name order is time order.
pub fn codex_rollout(sessions: &std::path::Path, session_id: Option<&str>, cwd: &str) -> Option<std::path::PathBuf> {
    let sorted_desc = |d: &std::path::Path| -> Vec<std::path::PathBuf> {
        let mut v: Vec<_> = std::fs::read_dir(d).into_iter().flatten().flatten().map(|e| e.path()).collect();
        v.sort();
        v.reverse();
        v
    };
    let mut checked = 0;
    for y in sorted_desc(sessions) {
        for m in sorted_desc(&y) {
            for d in sorted_desc(&m) {
                for f in sorted_desc(&d) {
                    let name = f.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if !name.ends_with(".jsonl") {
                        continue;
                    }
                    match session_id {
                        Some(sid) => {
                            if name.ends_with(&format!("-{sid}.jsonl")) {
                                return Some(f);
                            }
                        }
                        None => {
                            // A bounded look back: the cwd's latest session is recent.
                            checked += 1;
                            if checked > 400 {
                                return None;
                            }
                            if codex_session_cwd(&f).as_deref() == Some(cwd) {
                                return Some(f);
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

/// The `cwd` in a rollout's first line (`session_meta`).
fn codex_session_cwd(f: &std::path::Path) -> Option<String> {
    use std::io::{BufRead, Read};
    let mut first = String::new();
    std::io::BufReader::new(std::fs::File::open(f).ok()?.take(1 << 20)).read_line(&mut first).ok()?;
    let v: serde_json::Value = serde_json::from_str(&first).ok()?;
    (v.get("type")?.as_str()? == "session_meta").then(|| v.pointer("/payload/cwd")?.as_str().map(str::to_string))?
}

// ─────────────────────────── antigravity ───────────────────────────────

/// Antigravity (agy) keeps a conversation as a SQLite file of steps, each
/// a protobuf with no published schema. Read from agy 1.5: the step's
/// type is in its own column; a person's prompt (14) carries its text at
/// 19.2, an agent turn (15) its reply at 20.1 and each tool call at 20.7
/// (name 2, JSON arguments 3). Other steps (tool results, bookkeeping)
/// are left out, like Claude's tool results. A shape that does not match
/// reads as nothing rather than as noise.
const AGY_USER: i64 = 14;
const AGY_AGENT: i64 = 15;

pub fn parse_antigravity_steps<'a>(steps: impl IntoIterator<Item = (i64, &'a [u8])>) -> Vec<Turn> {
    use crate::pb;
    let mut out: Vec<Turn> = Vec::new();
    let mut push = |role: &str, text: String, tool: Option<String>| {
        let text = text.trim().to_string();
        if !text.is_empty() || tool.is_some() {
            out.push(Turn { role: role.into(), text, tool, ts: None });
        }
    };
    for (kind, payload) in steps {
        match kind {
            AGY_USER => push("user", pb::text(payload, &[19, 2]).unwrap_or_default(), None),
            AGY_AGENT => {
                push("assistant", pb::text(payload, &[20, 1]).unwrap_or_default(), None);
                for call in pb::get(payload, &[20, 7]) {
                    let Some(name) = pb::text(call, &[2]) else { continue };
                    let args = pb::text(call, &[3]).and_then(|a| serde_json::from_str::<serde_json::Value>(&a).ok());
                    push("tool", tool_summary(args.as_ref()), Some(name));
                }
            }
            _ => {}
        }
    }
    let skip = out.len().saturating_sub(TRANSCRIPT_TURNS);
    out.drain(..skip);
    out
}

/// Read an agy conversation file. Read-only: agy may be writing it (WAL).
pub fn read_antigravity(db: &std::path::Path) -> Result<Vec<Turn>, String> {
    let rows = antigravity_rows(db, None)?;
    Ok(parse_antigravity_steps(rows.iter().map(|(k, p)| (*k, p.as_slice()))))
}

fn antigravity_rows(db: &std::path::Path, limit: Option<u32>) -> Result<Vec<(i64, Vec<u8>)>, String> {
    use rusqlite::OpenFlags;
    let con = rusqlite::Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("could not open the conversation ({e})"))?;
    let sql = match limit {
        Some(n) => format!("SELECT step_type, step_payload FROM steps WHERE step_type = {AGY_USER} ORDER BY idx LIMIT {n}"),
        None => "SELECT step_type, step_payload FROM steps ORDER BY idx".to_string(),
    };
    let mut st = con.prepare(&sql).map_err(|e| format!("not a conversation agy can be read from ({e})"))?;
    let rows = st
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<Vec<u8>>>(1)?.unwrap_or_default())))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    Ok(rows)
}

/// The task's agy conversation in `dir`
/// (`~/.gemini/antigravity-cli/conversations`): `<id>.db` when the tab
/// recorded the conversation id, else the newest whose first prompt names
/// `cwd` as its workspace (`file://<cwd>` in that step, wherever agy keeps
/// it in the message).
pub fn antigravity_conversation(dir: &std::path::Path, conversation: Option<&str>, cwd: &str) -> Option<std::path::PathBuf> {
    if let Some(id) = conversation {
        let f = dir.join(format!("{id}.db"));
        return f.is_file().then_some(f);
    }
    let mut dbs: Vec<(std::time::SystemTime, std::path::PathBuf)> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "db"))
        .filter_map(|p| Some((p.metadata().ok()?.modified().ok()?, p)))
        .collect();
    dbs.sort_by_key(|d| std::cmp::Reverse(d.0));
    let needle = format!("file://{cwd}");
    let ends = |b: &[u8], at: usize| b.get(at).is_none_or(|c| !(c.is_ascii_alphanumeric() || matches!(c, b'/' | b'-' | b'_' | b'.')));
    dbs.into_iter().take(40).map(|(_, p)| p).find(|p| {
        antigravity_rows(p, Some(1)).ok().and_then(|r| r.into_iter().next()).is_some_and(|(_, payload)| {
            payload.windows(needle.len()).enumerate().any(|(i, w)| w == needle.as_bytes() && ends(&payload, i + needle.len()))
        })
    })
}

/// One line, cut to `TOOL_SUMMARY_CHARS`.
fn one_line(s: &str) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > TOOL_SUMMARY_CHARS {
        format!("{}...", one.chars().take(TOOL_SUMMARY_CHARS).collect::<String>())
    } else {
        one
    }
}

/// A task's conversation for an agent other than Claude, from `home`:
/// Codex's rollouts and agy's conversation files, found by the session id
/// the tab recorded or, without one, by the task's folder.
pub fn other_agent(agent: &str, home: &std::path::Path, cwd: &str, session_id: Option<&str>) -> Result<Vec<Turn>, String> {
    match agent {
        "codex" => {
            let f = codex_rollout(&home.join(".codex").join("sessions"), session_id, cwd)
                .ok_or("no Codex session for this task yet (has the agent replied?)")?;
            let jsonl = std::fs::read_to_string(&f).map_err(|e| format!("could not read the transcript ({e})"))?;
            Ok(parse_codex_jsonl(&jsonl))
        }
        "agy" | "antigravity" => {
            let dir = home.join(".gemini").join("antigravity-cli").join("conversations");
            let f = antigravity_conversation(&dir, session_id, cwd).ok_or("no Antigravity conversation for this task yet (has the agent replied?)")?;
            read_antigravity(&f)
        }
        other => Err(format!("transcripts are available for Claude, Codex and Antigravity tasks, and this one runs \"{other}\"")),
    }
}

/// Claude Code's transcript-directory name for a cwd: every character
/// that is not ASCII alphanumeric becomes '-' ("/Users/x/.config/dotfiles"
/// -> "-Users-x--config-dotfiles").
pub fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// The agent's last message out of a Claude Code JSONL transcript: the
/// last "assistant" line carrying non-empty text content (tool-use-only
/// turns are skipped). Shared by the desktop's `result` and termic-server.
pub fn last_assistant_text(jsonl: &str) -> Option<String> {
    for line in jsonl.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        // Sidechain lines are a subagent's internal conversation
        // interleaved in the same transcript; their last message is not
        // the agent's answer.
        if v.get("isSidechain").and_then(|s| s.as_bool()) == Some(true) {
            continue;
        }
        let Some(content) = v.pointer("/message/content") else { continue };
        let text = match content {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(blocks) => blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => continue,
        };
        if !text.trim().is_empty() {
            return Some(text);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_turns_reads_prompts_replies_and_tool_calls() {
        let jsonl = [
            r#"{"type":"user","message":{"content":"fix the login bug"},"timestamp":"2026-10-18T10:00:00Z"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Looking at it."},{"type":"tool_use","name":"Bash","input":{"command":"grep -rn login src"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"src/a.ts:1"}]}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"subagent noise"}]}}"#,
            r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Fixed."}]}}"#,
            r#"not json"#,
        ]
        .join("\n");
        let turns = parse_claude_jsonl(&jsonl);
        let got: Vec<(String, String, Option<String>)> = turns.iter().map(|t| (t.role.clone(), t.text.clone(), t.tool.clone())).collect();
        assert_eq!(
            got,
            vec![
                ("user".into(), "fix the login bug".into(), None),
                ("assistant".into(), "Looking at it.".into(), None),
                ("tool".into(), "grep -rn login src".into(), Some("Bash".into())),
                ("assistant".into(), "Fixed.".into(), None),
            ]
        );
        assert_eq!(turns[0].ts.as_deref(), Some("2026-10-18T10:00:00Z"));
    }

    #[test]
    fn a_prompt_queued_mid_turn_is_a_user_turn() {
        // Sent while Claude was still in a turn (here, answering its own
        // question): recorded as an attachment, never as a user line.
        let jsonl = [
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"AskUserQuestion","input":{}}]}}"#,
            r#"{"type":"attachment","attachment":{"type":"queued_command","prompt":"now say PING","commandMode":"prompt"},"timestamp":"2026-10-18T10:01:00Z"}"#,
            r#"{"type":"attachment","attachment":{"type":"queued_command","prompt":"/compact","commandMode":"bash"}}"#,
            r#"{"type":"attachment","attachment":{"type":"file","prompt":"not a prompt"}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"answered"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"PING"}]}}"#,
        ]
        .join("\n");
        let got: Vec<(String, String)> = parse_claude_jsonl(&jsonl).into_iter().skip(1).map(|t| (t.role, t.text)).collect();
        assert_eq!(got, vec![("user".into(), "now say PING".into()), ("assistant".into(), "PING".into())]);
    }

    /// The ways the queue operations alone drifted in long sessions, each
    /// leaving a consumed prompt on the phone as Queued for good.
    #[test]
    fn a_consumed_prompt_never_stays_queued() {
        let queued = |lines: &[&str]| -> Vec<String> {
            parse_claude_jsonl(&lines.join("\n")).into_iter().filter(|t| t.role == "queued").map(|t| t.text).collect()
        };
        // A stale entry ahead of it: the nameless dequeue took the stale one.
        assert!(queued(&[
            r#"{"type":"queue-operation","operation":"enqueue","content":"stale"}"#,
            r#"{"type":"queue-operation","operation":"remove","content":"stale, reworded"}"#,
            r#"{"type":"queue-operation","operation":"enqueue","content":"fix the alignment"}"#,
            r#"{"type":"queue-operation","operation":"dequeue"}"#,
            r#"{"type":"user","message":{"content":[{"type":"text","text":"fix the alignment"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}"#,
        ]).is_empty());
        // popAll empties it.
        assert!(queued(&[
            r#"{"type":"queue-operation","operation":"enqueue","content":"a"}"#,
            r#"{"type":"queue-operation","operation":"enqueue","content":"b"}"#,
            r#"{"type":"queue-operation","operation":"popAll"}"#,
        ]).is_empty());
        // Sent (it shows up as a user line) even with no matching remove.
        assert!(queued(&[
            r#"{"type":"queue-operation","operation":"enqueue","content":"check the flag"}"#,
            r#"{"type":"user","message":{"content":"check the flag"}}"#,
        ]).is_empty());
        // A finished turn: Claude drains its queue then, whatever was logged.
        assert!(queued(&[
            r#"{"type":"queue-operation","operation":"enqueue","content":"scheduled check"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}}"#,
        ]).is_empty());
        // ...but one typed after the turn ended is still waiting.
        assert_eq!(queued(&[
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}}"#,
            r#"{"type":"queue-operation","operation":"enqueue","content":"next"}"#,
        ]), vec!["next".to_string()]);
    }

    #[test]
    fn a_prompt_still_waiting_in_the_queue_is_queued() {
        let jsonl = [
            r#"{"type":"user","message":{"content":"start"}}"#,
            r#"{"type":"queue-operation","operation":"enqueue","content":"read by now"}"#,
            r#"{"type":"queue-operation","operation":"remove","content":"read by now"}"#,
            r#"{"type":"attachment","attachment":{"type":"queued_command","prompt":"read by now","commandMode":"prompt"}}"#,
            r#"{"type":"queue-operation","operation":"enqueue","content":"<task-notification>\n<task-id>b1</task-id>"}"#,
            r#"{"type":"queue-operation","operation":"dequeue"}"#,
            r#"{"type":"user","message":{"content":"<task-notification>\n<task-id>b1</task-id>"}}"#,
            r#"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}"#,
            r#"{"type":"queue-operation","operation":"enqueue","content":"still waiting"}"#,
        ]
        .join("\n");
        let got: Vec<(String, String)> = parse_claude_jsonl(&jsonl).into_iter().map(|t| (t.role, t.text)).collect();
        assert_eq!(
            got,
            vec![("user".into(), "start".into()), ("user".into(), "read by now".into()), ("queued".into(), "still waiting".into())]
        );
    }

    #[test]
    fn parse_turns_keeps_the_most_recent_turns() {
        let line = r#"{"type":"assistant","message":{"content":"x"}}"#;
        let jsonl = vec![line; TRANSCRIPT_TURNS + 50].join("\n");
        assert_eq!(parse_claude_jsonl(&jsonl).len(), TRANSCRIPT_TURNS);
    }

    #[test]
    fn tool_summary_is_one_bounded_line() {
        let long = serde_json::json!({ "command": format!("echo {}\nnext", "a".repeat(400)) });
        let s = tool_summary(Some(&long));
        assert!(!s.contains('\n'));
        assert!(s.ends_with("...") && s.chars().count() == TOOL_SUMMARY_CHARS + 3);
        assert_eq!(tool_summary(Some(&serde_json::json!({ "description": "Run tests", "command": "npm test" }))), "Run tests");
        assert_eq!(tool_summary(None), "");
    }


    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("termic-transcript-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The shape of a Codex rollout (retyped, synthetic): what Codex adds
    /// to the person's message is dropped, the rest reads like Claude's.
    #[test]
    fn codex_rollouts_read_as_turns() {
        let jsonl = [
            r#"{"timestamp":"2026-01-01T10:00:00Z","type":"session_meta","payload":{"id":"s1","cwd":"/Users/u/src/app"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>sandbox</permissions instructions>"}]}}"#,
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/u/src/app\n\nbe brief"},{"type":"input_text","text":"<environment_context>\n  <cwd>/Users/u/src/app</cwd>\n</environment_context>"}]}}"##,
            r#"{"timestamp":"2026-01-01T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix the login bug"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","summary":[],"encrypted_content":"x"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"npm test\",\"workdir\":\"/Users/u/src/app\"}","call_id":"c1"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"1 failing"}}"#,
            r#"{"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"c2","input":"*** Begin Patch\n*** Update File: src/login.ts\n@@\n-a\n+b\n*** Add File: src/login.test.ts\n+x\n*** End Patch"}}"#,
            r#"{"type":"response_item","payload":{"type":"web_search_call","action":{"type":"search","query":"oauth refresh token"}}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Fixed."}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"Fixed."}}"#,
            r#"not json"#,
        ]
        .join("\n");
        let turns = parse_codex_jsonl(&jsonl);
        let got: Vec<(String, String, Option<String>)> = turns.iter().map(|t| (t.role.clone(), t.text.clone(), t.tool.clone())).collect();
        assert_eq!(
            got,
            vec![
                ("user".into(), "fix the login bug".into(), None),
                ("tool".into(), "npm test".into(), Some("exec_command".into())),
                ("tool".into(), "src/login.ts, src/login.test.ts".into(), Some("apply_patch".into())),
                ("tool".into(), "oauth refresh token".into(), Some("web_search".into())),
                ("assistant".into(), "Fixed.".into(), None),
            ]
        );
        assert_eq!(turns[0].ts.as_deref(), Some("2026-01-01T10:00:01Z"));
    }

    #[test]
    fn codex_injections_are_recognised_and_words_are_not() {
        for t in ["<environment_context>\n<cwd>/x</cwd>\n</environment_context>", "<turn_aborted> The user interrupted. </turn_aborted>", "<image name=[Image #1]>", "</image>", "# AGENTS.md instructions for /x"] {
            assert!(codex_injected(t), "{t}");
        }
        for t in ["fix the bug", "<div> is not closing", "use <T> here", "#1 priority"] {
            assert!(!codex_injected(t), "{t}");
        }
    }

    #[test]
    fn a_codex_rollout_is_found_by_session_or_by_folder() {
        let root = scratch("codex");
        let day = root.join("2026").join("01").join("02");
        std::fs::create_dir_all(&day).unwrap();
        let meta = |cwd: &str| format!(r#"{{"type":"session_meta","payload":{{"cwd":"{cwd}"}}}}"#);
        std::fs::write(day.join("rollout-2026-01-02T09-00-00-aaaa.jsonl"), meta("/Users/u/src/app")).unwrap();
        std::fs::write(day.join("rollout-2026-01-02T10-00-00-bbbb.jsonl"), meta("/Users/u/src/other")).unwrap();
        let older = root.join("2026").join("01").join("01");
        std::fs::create_dir_all(&older).unwrap();
        std::fs::write(older.join("rollout-2026-01-01T09-00-00-cccc.jsonl"), meta("/Users/u/src/app")).unwrap();
        let name = |p: Option<std::path::PathBuf>| p.and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()));
        assert_eq!(name(codex_rollout(&root, Some("cccc"), "/ignored")).as_deref(), Some("rollout-2026-01-01T09-00-00-cccc.jsonl"));
        assert_eq!(name(codex_rollout(&root, None, "/Users/u/src/app")).as_deref(), Some("rollout-2026-01-02T09-00-00-aaaa.jsonl"), "the newest for that folder");
        assert_eq!(codex_rollout(&root, Some("nope"), "/Users/u/src/app"), None, "a recorded id that is not there finds nothing, not a neighbour");
        assert_eq!(codex_rollout(&root, None, "/Users/u/src"), None, "a parent folder is not the task's");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The shape of an agy step (synthetic, built with the same field
    /// numbers): prompts, replies and tool calls, nothing else.
    fn agy_user(text: &str, workspace: &str) -> Vec<u8> {
        use crate::pb::enc::*;
        [int(1, 14), ld(19, &[ld(2, text.as_bytes()), ld(13, &ld(12, format!("file://{workspace}").as_bytes()))].concat())].concat()
    }
    fn agy_agent(reply: &str, calls: &[(&str, &str)]) -> Vec<u8> {
        use crate::pb::enc::*;
        let mut inner = ld(1, reply.as_bytes());
        inner.extend(ld(3, b"thinking it through"));
        for (name, args) in calls {
            inner.extend(ld(7, &[ld(1, b"call_1"), ld(2, name.as_bytes()), ld(3, args.as_bytes())].concat()));
        }
        [int(1, 15), ld(20, &inner)].concat()
    }

    #[test]
    fn antigravity_steps_read_as_turns() {
        let u = agy_user("why is docker not found?", "/Users/u/src/app");
        let a1 = agy_agent("", &[("run_command", r#"{"CommandLine":"which docker","toolSummary":"Find docker"}"#), ("view_file", r#"{"AbsolutePath":"/Users/u/src/app/a.rs"}"#)]);
        let a2 = agy_agent("PATH misses /usr/local/bin.", &[]);
        let junk = vec![0x0f, 0x01];
        let turns = parse_antigravity_steps([(14, &u[..]), (132, &b"tool output"[..]), (15, &a1[..]), (15, &junk[..]), (15, &a2[..])]);
        let got: Vec<(String, String, Option<String>)> = turns.iter().map(|t| (t.role.clone(), t.text.clone(), t.tool.clone())).collect();
        assert_eq!(
            got,
            vec![
                ("user".into(), "why is docker not found?".into(), None),
                ("tool".into(), "Find docker".into(), Some("run_command".into())),
                ("tool".into(), "/Users/u/src/app/a.rs".into(), Some("view_file".into())),
                ("assistant".into(), "PATH misses /usr/local/bin.".into(), None),
            ],
            "the thinking (20.3) is not a reply, and a step that is not a message reads as nothing"
        );
    }

    #[test]
    fn an_antigravity_conversation_is_found_and_read_from_its_file() {
        let dir = scratch("agy");
        let make = |id: &str, workspace: &str| {
            let con = rusqlite::Connection::open(dir.join(format!("{id}.db"))).unwrap();
            con.execute_batch("CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, step_payload blob);").unwrap();
            con.execute("INSERT INTO steps VALUES (0, 14, ?1)", [agy_user("hello", workspace)]).unwrap();
            con.execute("INSERT INTO steps VALUES (1, 15, ?1)", [agy_agent("hi", &[])]).unwrap();
        };
        make("11111111-0000-0000-0000-000000000000", "/Users/u/src/app");
        make("22222222-0000-0000-0000-000000000000", "/Users/u/src/app-two");
        let f = antigravity_conversation(&dir, Some("11111111-0000-0000-0000-000000000000"), "/ignored").unwrap();
        assert_eq!(read_antigravity(&f).unwrap().len(), 2);
        let by_folder = antigravity_conversation(&dir, None, "/Users/u/src/app").unwrap();
        assert!(by_folder.ends_with("11111111-0000-0000-0000-000000000000.db"), "/app is not a prefix match for /app-two: {by_folder:?}");
        assert_eq!(antigravity_conversation(&dir, Some("33333333-0000-0000-0000-000000000000"), "/Users/u/src/app"), None);
        assert_eq!(antigravity_conversation(&dir, None, "/Users/u/src"), None);
        std::fs::write(dir.join("not-sqlite.db"), b"nope").unwrap();
        assert!(read_antigravity(&dir.join("not-sqlite.db")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
