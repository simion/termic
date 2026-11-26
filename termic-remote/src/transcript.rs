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
    // A tool call's place in `out`, by its id, for its result to land on.
    let mut calls: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut results: std::collections::HashSet<String> = std::collections::HashSet::new();
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
                // A subagent's hand-back is queued like a prompt but is not
                // the person's: it shows once Claude takes it (below).
                Some("enqueue") if text.contains("<agent-message") => {}
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
        // A subagent's conversation, and what Claude writes for itself: the
        // summary it continues from after a compaction is a "user" line
        // nobody typed (isCompactSummary, isVisibleInTranscriptOnly).
        let flag = |k: &str| v.get(k).and_then(|s| s.as_bool()) == Some(true);
        // A subagent's final report, handed back to this session: Claude
        // writes it as an isMeta "user" line ("Another Claude session sent a
        // message: <agent-message ...>"). Its own turn, so a client can show
        // it as the agent's report rather than drop it or call it the user's.
        if flag("isMeta") && !flag("isSidechain") {
            let text = v.pointer("/message/content").and_then(|c| c.as_str()).unwrap_or("");
            if let Some(report) = agent_report(text) {
                let ts = v.get("timestamp").and_then(|t| t.as_str()).map(str::to_string);
                out.push(Turn { role: "assistant".into(), text: report, tool: Some("Subagent".into()), ts, detail: None, pending: false });
                continue;
            }
        }
        if flag("isSidechain") || flag("isCompactSummary") || flag("isVisibleInTranscriptOnly") || flag("isMeta") {
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
                    out.push(Turn { role: "user".into(), text: text.into(), tool: None, ts, detail: None, pending: false });
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
        let push = |out: &mut Vec<Turn>, role: &str, text: String, tool: Option<String>, detail: Option<String>| {
            push_turn(out, role, text, tool, ts.clone(), detail)
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
                let text = if kind == "user" { unwrap_pastes(text) } else { text.clone() };
                push(&mut out, kind, text, None, None);
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
                            let text = if kind == "user" { unwrap_pastes(&text) } else { text };
                            push(&mut out, kind, text, None, None);
                        }
                        Some("tool_use") if kind == "assistant" => {
                            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                            if let Some(id) = b.get("id").and_then(|i| i.as_str()) {
                                calls.insert(id.to_string(), out.len());
                            }
                            push(&mut out, "tool", tool_summary(b.get("input")), Some(name), edit_diff(b.get("input")));
                        }
                        // A call's result arrives in the next user line,
                        // by the call's id. An edit keeps its diff: "the
                        // file was updated" says less than the change.
                        Some("tool_result") if kind == "user" => {
                            if let Some(id) = b.get("tool_use_id").and_then(|i| i.as_str()) {
                                results.insert(id.to_string());
                            }
                            let at = b.get("tool_use_id").and_then(|i| i.as_str()).and_then(|i| calls.get(i)).copied();
                            if let Some(t) = at.and_then(|i| out.get_mut(i)).filter(|t| t.detail.is_none()) {
                                t.detail = result_text(b.get("content"));
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    mark_pending(&mut out, &calls, &results);
    out.extend(queue.into_iter().filter(|(t, _)| !injected(t)).map(|(text, ts)| Turn { role: "queued".into(), text, tool: None, ts, detail: None, pending: false }));
    let skip = out.len().saturating_sub(TRANSCRIPT_TURNS);
    out.drain(..skip);
    out
}

/// A prompt with pasted text: the paste is the person's words, the
/// `<pasted_content id="...">` tags around it are Claude Code's.
fn unwrap_pastes(text: &str) -> String {
    // Opening and closing tags both, each with or without attributes:
    // Claude Code writes `</pasted_content id="c771">` as well as the bare one.
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let at = [rest.find("<pasted_content"), rest.find("</pasted_content")].into_iter().flatten().min();
        let Some(at) = at else { break };
        out.push_str(&rest[..at]);
        let Some(end) = rest[at..].find('>') else { break };
        rest = &rest[at + end + 1..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// The report inside a subagent's hand-back (`<agent-message from="…">`):
/// what follows Claude Code's "The report follows:" preamble, with the two
/// spaces it indents every line by taken off. None when it is not one.
fn agent_report(text: &str) -> Option<String> {
    let start = text.find("<agent-message")?;
    let body = &text[start..];
    let body = &body[body.find('>')? + 1..];
    let body = body.split("</agent-message>").next().unwrap_or(body);
    let body = match body.find("The report follows:") {
        Some(i) => &body[i + "The report follows:".len()..],
        None => body,
    };
    let report = body.lines().map(|l| l.strip_prefix("  ").unwrap_or(l)).collect::<Vec<_>>().join("\n");
    let report = report.trim().to_string();
    (!report.is_empty()).then_some(report)
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

/// The tool calls in `calls` whose result never arrived are still running.
fn mark_pending(out: &mut [Turn], calls: &std::collections::HashMap<String, usize>, done: &std::collections::HashSet<String>) {
    for (id, &i) in calls {
        if !done.contains(id) {
            if let Some(t) = out.get_mut(i) {
                t.pending = true;
            }
        }
    }
}

/// One turn onto `out`, unless it says nothing (a tool call always says
/// which tool).
fn push_turn(out: &mut Vec<Turn>, role: &str, text: String, tool: Option<String>, ts: Option<String>, detail: Option<String>) {
    let text = text.trim().to_string();
    if !text.is_empty() || tool.is_some() {
        out.push(Turn { role: role.into(), text, tool, ts, detail, pending: false });
    }
}

/// The patch inside a Codex `exec` script: `"*** Begin Patch\n...*** End
/// Patch"` as a string literal, so its newlines and quotes are escaped.
/// Without the Begin/End lines, like apply_patch's.
fn inline_patch(script: &str) -> Option<String> {
    let start = script.find("*** Begin Patch")? + "*** Begin Patch".len();
    let end = start + script[start..].find("*** End Patch")?;
    let body = &script[start..end];
    let body = if body.contains('\n') {
        body.to_string()
    } else {
        body.replace("\\n", "\n").replace("\\t", "\t").replace("\\\"", "\"").replace("\\'", "'").replace("\\\\", "\\")
    };
    let body = body.trim_matches('\n').to_string();
    (!body.is_empty()).then_some(body)
}

/// The shell command inside a Codex `exec` script
/// (`tools.exec_command({cmd:"npm test", ...})`), unescaped: what the call
/// does, where the script around it is only plumbing.
fn exec_command_of(script: &str) -> Option<String> {
    let at = script.find("exec_command(")?;
    let rest = &script[at..];
    let key = rest.find("cmd:").or_else(|| rest.find("\"cmd\":"))?;
    let rest = rest[key..].split_once(':')?.1.trim_start();
    let quote = rest.chars().next().filter(|c| matches!(c, '"' | '\'' | '`'))?;
    let mut out = String::new();
    let mut esc = false;
    for c in rest[1..].chars() {
        match (esc, c) {
            (true, 'n') => { out.push(' '); esc = false; }
            (true, c) => { out.push(c); esc = false; }
            (false, '\\') => esc = true,
            (false, c) if c == quote => return Some(out),
            (false, c) => out.push(c),
        }
    }
    None
}

/// Codex wraps a command's output in a header ("Exit code: 0\nWall time:
/// ...\nOutput:\n"); the output is the part worth showing.
fn codex_output(text: &str) -> String {
    match text.split_once("\nOutput:\n") {
        Some((_, out)) => out.to_string(),
        None => text.to_string(),
    }
}

/// A tool call's detail is cut to this many characters: enough for a
/// test run's tail or a real diff, not a whole file.
const DETAIL_CHARS: usize = 4000;

/// `s` cut to `DETAIL_CHARS`, blank lines around it trimmed; None when empty.
fn bounded(s: &str) -> Option<String> {
    let s = s.trim_end().trim_start_matches(['\n', '\r']);
    if s.trim().is_empty() {
        return None;
    }
    Some(if s.chars().count() > DETAIL_CHARS { format!("{}\n...", s.chars().take(DETAIL_CHARS).collect::<String>()) } else { s.to_string() })
}

/// What an editing call changes, as `-`/`+` lines: Claude's Edit
/// (`old_string`/`new_string`), MultiEdit (`edits`) and Write (`content`,
/// all added).
fn edit_diff(input: Option<&serde_json::Value>) -> Option<String> {
    let input = input?;
    let pair = |e: &serde_json::Value| -> Option<String> {
        let old = e.get("old_string")?.as_str()?;
        let new = e.get("new_string")?.as_str()?;
        let mut d: Vec<String> = old.lines().map(|l| format!("-{l}")).collect();
        d.extend(new.lines().map(|l| format!("+{l}")));
        Some(d.join("\n"))
    };
    if let Some(edits) = input.get("edits").and_then(|e| e.as_array()) {
        return bounded(&edits.iter().filter_map(pair).collect::<Vec<_>>().join("\n@@\n"));
    }
    if let Some(d) = pair(input) {
        return bounded(&d);
    }
    let content = input.get("content")?.as_str()?;
    input.get("file_path")?;
    bounded(&content.lines().map(|l| format!("+{l}")).collect::<Vec<_>>().join("\n"))
}

/// A tool_result's text: a string, or its text blocks joined.
fn result_text(content: Option<&serde_json::Value>) -> Option<String> {
    match content? {
        serde_json::Value::String(s) => bounded(s),
        serde_json::Value::Array(blocks) => bounded(
            &blocks.iter().filter_map(|b| b.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n"),
        ),
        _ => None,
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
    let mut calls: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut results: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in jsonl.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
            continue;
        }
        let ts = v.get("timestamp").and_then(|t| t.as_str()).map(str::to_string);
        let Some(p) = v.get("payload") else { continue };
        let str_of = |k: &str| p.get(k).and_then(|x| x.as_str()).unwrap_or("");
        let push = |out: &mut Vec<Turn>, role: &str, text: String, tool: Option<String>, detail: Option<String>| {
            push_turn(out, role, text, tool, ts.clone(), detail)
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
                push(&mut out, role, text, None, None);
            }
            ("function_call", _) => {
                let args = serde_json::from_str::<serde_json::Value>(str_of("arguments")).ok();
                calls.insert(str_of("call_id").to_string(), out.len());
                push(&mut out, "tool", tool_summary(args.as_ref()), Some(str_of("name").to_string()), None);
            }
            // A call's output, by its call_id. apply_patch keeps its patch.
            ("function_call_output" | "custom_tool_call_output", _) => {
                results.insert(str_of("call_id").to_string());
                // A string, an array of content items (`input_text`), or an
                // object with `content`, by version and tool.
                let text = match p.get("output") {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(serde_json::Value::Array(items)) => {
                        items.iter().filter_map(|i| i.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n")
                    }
                    Some(o) => o.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string(),
                    None => String::new(),
                };
                if let Some(t) = calls.get(str_of("call_id")).and_then(|&i| out.get_mut(i)).filter(|t| t.detail.is_none()) {
                    t.detail = bounded(&codex_output(&text));
                }
            }
            // apply_patch: its input is the patch, so name the files it
            // touches and keep the patch. Any other custom tool (`exec`, a
            // script) is summarised by its input; its output is its detail.
            ("custom_tool_call", _) => {
                calls.insert(str_of("call_id").to_string(), out.len());
                let input = str_of("input");
                if str_of("name") == "apply_patch" {
                    let files: Vec<&str> = input
                        .lines()
                        .filter_map(|l| {
                            ["*** Update File: ", "*** Add File: ", "*** Delete File: "].iter().find_map(|k| l.strip_prefix(k))
                        })
                        .collect();
                    let patch: Vec<&str> = input.lines().filter(|l| !l.starts_with("*** Begin Patch") && !l.starts_with("*** End Patch")).collect();
                    push(&mut out, "tool", one_line(&files.join(", ")), Some(str_of("name").to_string()), bounded(&patch.join("\n")));
                } else if let Some(patch) = inline_patch(input) {
                    // An edit through `exec`: the patch is a string in the script.
                    let files: Vec<&str> = patch
                        .lines()
                        .filter_map(|l| ["*** Update File: ", "*** Add File: ", "*** Delete File: "].iter().find_map(|k| l.strip_prefix(k)))
                        .collect();
                    let summary = one_line(&files.join(", "));
                    push(&mut out, "tool", summary, Some(str_of("name").to_string()), bounded(&patch));
                } else {
                    let summary = exec_command_of(input).unwrap_or_else(|| input.to_string());
                    push(&mut out, "tool", one_line(&summary), Some(str_of("name").to_string()), None);
                }
            }
            ("web_search_call", _) => {
                let action = p.get("action");
                push(&mut out, "tool", tool_summary(action), Some("web_search".into()), None);
            }
            _ => {}
        }
    }
    mark_pending(&mut out, &calls, &results);
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
/// A tool call's result: its call id at [5,4,1], a command's output at
/// [140,2,3,10,3,4] (measured on agy's run_command, 2026-11).
const AGY_RESULT: i64 = 132;

pub fn parse_antigravity_steps<'a>(steps: impl IntoIterator<Item = (i64, &'a [u8])>) -> Vec<Turn> {
    use crate::pb;
    let mut out: Vec<Turn> = Vec::new();
    // A call's place in `out`, by its id, for its result step to land on.
    let mut calls: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut results: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (kind, payload) in steps {
        match kind {
            AGY_USER => push_turn(&mut out, "user", pb::text(payload, &[19, 2]).unwrap_or_default(), None, None, None),
            AGY_AGENT => {
                push_turn(&mut out, "assistant", pb::text(payload, &[20, 1]).unwrap_or_default(), None, None, None);
                for call in pb::get(payload, &[20, 7]) {
                    let Some(name) = pb::text(call, &[2]) else { continue };
                    let args = pb::text(call, &[3]).and_then(|a| serde_json::from_str::<serde_json::Value>(&a).ok());
                    if let Some(id) = pb::text(call, &[1]) {
                        calls.insert(id, out.len());
                    }
                    let diff = args.as_ref().and_then(agy_edit_diff);
                    push_turn(&mut out, "tool", tool_summary(args.as_ref()), Some(name), None, diff);
                }
            }
            // A call's result: a command's terminal output. An edit keeps its diff.
            AGY_RESULT => {
                if let Some(id) = pb::text(payload, &[5, 4, 1]) {
                    results.insert(id);
                }
                let at = pb::text(payload, &[5, 4, 1]).and_then(|id| calls.get(&id).copied());
                if let Some(t) = at.and_then(|i| out.get_mut(i)).filter(|t| t.detail.is_none()) {
                    t.detail = pb::text(payload, &[140, 2, 3, 10, 3, 4]).and_then(|o| bounded(&o.replace("\r\n", "\n")));
                }
            }
            _ => {}
        }
    }
    mark_pending(&mut out, &calls, &results);
    let skip = out.len().saturating_sub(TRANSCRIPT_TURNS);
    out.drain(..skip);
    out
}

/// What an agy editing call changes, as `-`/`+` lines: edit_file's
/// `Target`/`Replacement`, write_file's `Content` (all added).
fn agy_edit_diff(args: &serde_json::Value) -> Option<String> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str());
    if let (Some(old), Some(new)) = (s("Target"), s("Replacement")) {
        let mut d: Vec<String> = old.lines().map(|l| format!("-{l}")).collect();
        d.extend(new.lines().map(|l| format!("+{l}")));
        return bounded(&d.join("\n"));
    }
    s("Content").and_then(|c| bounded(&c.lines().map(|l| format!("+{l}")).collect::<Vec<_>>().join("\n")))
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
        // A command's output is its detail; the patch is apply_patch's.
        assert_eq!(turns[1].detail.as_deref(), Some("1 failing"));
        assert_eq!(turns[2].detail.as_deref(), Some("*** Update File: src/login.ts\n@@\n-a\n+b\n*** Add File: src/login.test.ts\n+x"));
        assert_eq!(turns[3].detail, None);
    }

    #[test]
    fn a_codex_custom_tool_that_is_not_a_patch_keeps_its_output() {
        // Newer Codex: `exec` as a custom tool, outputs as input_text items.
        let jsonl = [
            r#"{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"c1","input":"ls -la\nnpm test"}}"#,
            r#"{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":[{"type":"input_text","text":"total 0"},{"type":"input_text","text":"3 passing"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"wait","arguments":"{}","call_id":"c2"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c2","output":[{"type":"input_text","text":"done"}]}}"#,
        ]
        .join("\n");
        let t = parse_codex_jsonl(&jsonl);
        assert_eq!(t[0].text, "ls -la npm test");
        assert_eq!(t[0].detail.as_deref(), Some("total 0\n3 passing"));
        assert_eq!(t[1].detail.as_deref(), Some("done"));
    }

    #[test]
    fn a_codex_edit_through_exec_shows_its_patch() {
        let script = r#"const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old \"q\"\n+new\n*** End Patch";\ntext(await tools.apply_patch(patch));"#;
        let jsonl = format!(
            "{}\n{}",
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"c1","input":script}}),
            r#"{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":[{"type":"input_text","text":"Success."}]}}"#,
        );
        let t = parse_codex_jsonl(&jsonl);
        assert_eq!(t[0].text, "src/a.ts");
        assert_eq!(t[0].detail.as_deref(), Some("*** Update File: src/a.ts\n@@\n-old \"q\"\n+new"));
        assert_eq!(inline_patch("no patch here"), None);
    }

    #[test]
    fn a_codex_exec_call_is_summarised_by_its_command() {
        assert_eq!(exec_command_of(r#"const r = await tools.exec_command({cmd:"echo \"hi\" && ls", yield_time_ms: 1000}); text(r);"#).as_deref(), Some(r#"echo "hi" && ls"#));
        assert_eq!(exec_command_of("text(1)"), None);
        assert_eq!(bounded("\n\nout\n").as_deref(), Some("out"));
    }

    #[test]
    fn claude_writes_some_user_lines_for_itself() {
        let jsonl = [
            r#"{"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"content":"This session is being continued from a previous conversation."}}"#,
            r#"{"type":"user","isMeta":true,"message":{"content":[{"type":"text","text":"Base directory for this skill: /x"}]}}"#,
            r#"{"type":"user","message":{"content":"look: <pasted_content id=\"ab12\">\nline one\n</pasted_content> thanks"}}"#,
        ]
        .join("\n");
        let t: Vec<String> = parse_claude_jsonl(&jsonl).into_iter().map(|t| t.text).collect();
        assert_eq!(t, vec!["look: \nline one\n thanks".to_string()]);
        // The closing tag can carry the id too.
        assert_eq!(unwrap_pastes("<pasted_content id=\"c771\">\nwhat is next?\n</pasted_content id=\"c771\">"), "what is next?");
    }

    #[test]
    fn a_tool_call_without_its_result_is_still_running() {
        let jsonl = [
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"sleep 60"}}]}}"#,
        ]
        .join("\n");
        let p: Vec<bool> = parse_claude_jsonl(&jsonl).into_iter().map(|t| t.pending).collect();
        assert_eq!(p, vec![false, true]);
        let codex = r#"{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"make\"}","call_id":"c1"}}"#;
        assert!(parse_codex_jsonl(codex)[0].pending);
    }

    #[test]
    fn a_subagent_report_is_its_own_turn_not_the_users() {
        let handback = "Another Claude session sent a message:\n<agent-message from=\"a0f6\">\n[Subagent hand-back] The text below is the final report. The report follows:\n  Linux reports itself.\n\n  **Still to do:** run CI.\n</agent-message>";
        let jsonl = [
            serde_json::json!({"type":"queue-operation","operation":"enqueue","content": handback}).to_string(),
            serde_json::json!({"type":"user","isMeta":true,"message":{"content": handback}}).to_string(),
        ]
        .join("\n");
        let t = parse_claude_jsonl(&jsonl);
        assert_eq!(t.len(), 1, "queued once, shown once it is taken: {t:?}");
        assert_eq!(t[0].role, "assistant", "drawn as the agent's, like any reply");
        assert_eq!(t[0].text, "Linux reports itself.\n\n**Still to do:** run CI.");
        assert_eq!(agent_report("plain text"), None);
    }

    #[test]
    fn codex_output_drops_its_header() {
        assert_eq!(codex_output("Exit code: 0\nWall time: 1s\nOutput:\nok\n"), "ok\n");
        assert_eq!(codex_output("plain"), "plain");
    }

    #[test]
    fn a_claude_tool_call_carries_its_result_or_its_diff() {
        let jsonl = [
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"3 passing"}]}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"/Users/u/a.ts","old_string":"a\nb","new_string":"c"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"The file was updated."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","name":"Write","input":{"file_path":"/Users/u/b.ts","content":"x\ny"}}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t4","name":"Read","input":{"file_path":"/Users/u/c.ts"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t4","content":"   "}]}}"#,
        ]
        .join("\n");
        let d: Vec<Option<String>> = parse_claude_jsonl(&jsonl).into_iter().map(|t| t.detail).collect();
        assert_eq!(d, vec![Some("3 passing".into()), Some("-a\n-b\n+c".into()), Some("+x\n+y".into()), None]);
    }

    #[test]
    fn a_tool_detail_is_bounded() {
        let long = "x".repeat(DETAIL_CHARS + 50);
        let b = bounded(&long).unwrap();
        assert!(b.ends_with("\n...") && b.chars().count() == DETAIL_CHARS + 4);
        assert_eq!(bounded(" \n "), None);
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
    fn an_antigravity_call_carries_its_output_or_its_diff() {
        use crate::pb::enc::*;
        let call = |id: &str, name: &str, args: &str| ld(7, &[ld(1, id.as_bytes()), ld(2, name.as_bytes()), ld(3, args.as_bytes())].concat());
        let agent = [int(1, 15), ld(20, &[
            call("c1", "run_command", r#"{"CommandLine":"npm test"}"#),
            call("c2", "edit_file", r#"{"Path":"/Users/u/a.ts","Target":"a\nb","Replacement":"c"}"#),
            call("c3", "write_file", r#"{"Path":"/Users/u/b.ts","Content":"x"}"#),
        ].concat())].concat();
        // The result step as agy writes it: the call at 5.4, the terminal's output deep in 140.
        let result = |id: &str, out: &str| [ld(5, &ld(4, &ld(1, id.as_bytes()))), ld(140, &ld(2, &ld(3, &ld(10, &ld(3, &ld(4, out.as_bytes()))))))].concat();
        let (r1, r2) = (result("c1", "3 passing\r\ndone"), result("c2", "edited"));
        let d: Vec<Option<String>> = parse_antigravity_steps([(15, &agent[..]), (132, &r1[..]), (132, &r2[..])]).into_iter().filter(|t| t.role == "tool").map(|t| t.detail).collect();
        assert_eq!(d, vec![Some("3 passing\ndone".into()), Some("-a\n-b\n+c".into()), Some("+x".into())]);
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
