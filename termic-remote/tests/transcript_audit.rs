//! `make transcript-audit`: the transcript reader against the real Claude
//! Code sessions on this machine. Ignored by default (it reads your
//! `~/.claude/projects`, so it can never run in CI); run it after a Claude
//! Code update. The JSONL format is Claude's, undocumented, and changes
//! under us: unit tests pin the shapes we know, this finds the ones we
//! don't. Prints paths and counts only, never transcript text.

use std::path::{Path, PathBuf};

/// Queue operations the reader handles (transcript.rs). A new one is how
/// `popAll` went unnoticed and left consumed prompts showing as Queued.
const KNOWN_OPS: &[&str] = &["enqueue", "dequeue", "remove", "popAll"];

fn sessions(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for dir in std::fs::read_dir(root).into_iter().flatten().flatten() {
        for f in std::fs::read_dir(dir.path()).into_iter().flatten().flatten() {
            let p = f.path();
            if p.extension().is_some_and(|e| e == "jsonl") {
                out.push(p);
            }
        }
    }
    out
}

#[test]
#[ignore = "reads this machine's Claude sessions: make transcript-audit"]
fn the_reader_holds_up_on_this_machines_sessions() {
    let home = std::env::var("HOME").expect("HOME");
    let roots: Vec<PathBuf> = std::env::var("CLAUDE_PROJECTS")
        .map(|v| v.split(':').map(PathBuf::from).collect())
        .unwrap_or_else(|_| vec![Path::new(&home).join(".claude/projects")]);
    let mut unknown: std::collections::BTreeMap<String, usize> = Default::default();
    let mut phantom = Vec::new();
    let mut ending_queued = 0;
    let mut n = 0;
    for path in roots.iter().flat_map(|r| sessions(r)) {
        let Ok(jsonl) = std::fs::read_to_string(&path) else { continue };
        n += 1;
        for line in jsonl.lines().filter(|l| l.contains("\"queue-operation\"")) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let op = v.get("operation").and_then(|o| o.as_str()).unwrap_or("<none>");
            if !KNOWN_OPS.contains(&op) {
                *unknown.entry(op.to_string()).or_default() += 1;
            }
        }
        let turns = termic_remote::transcript::parse_claude_jsonl(&jsonl);
        let queued: Vec<&str> = turns.iter().filter(|t| t.role == "queued").map(|t| t.text.as_str()).collect();
        if !queued.is_empty() {
            ending_queued += 1;
        }
        // The invariant: a prompt that already shows as sent is not queued.
        if queued.iter().any(|q| turns.iter().any(|t| t.role == "user" && t.text == *q)) {
            phantom.push(path.display().to_string());
        }
    }
    eprintln!("{n} sessions, {ending_queued} end with a queued prompt (expected only for a session mid-turn now)");
    assert!(unknown.is_empty(), "queue operations the reader does not handle (transcript.rs): {unknown:?}");
    assert!(phantom.is_empty(), "sessions showing an already-sent prompt as queued: {phantom:#?}");
}
