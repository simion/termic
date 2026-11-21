//! Print the turns a remote client would see for a transcript file, for
//! debugging a reader: `cargo run --example transcript -- codex <rollout.jsonl>`
//! (or `claude <session.jsonl>`, `agy <conversation.db>`).
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (agent, path) = match args.as_slice() {
        [a, p] => (a.as_str(), std::path::Path::new(p)),
        _ => return eprintln!("usage: transcript <claude|codex|agy> <file>"),
    };
    let turns = match agent {
        "claude" => termic_remote::transcript::parse_claude_jsonl(&std::fs::read_to_string(path).expect("read")),
        "codex" => termic_remote::transcript::parse_codex_jsonl(&std::fs::read_to_string(path).expect("read")),
        _ => termic_remote::transcript::read_antigravity(path).expect("read"),
    };
    for t in turns {
        let text: String = t.text.chars().take(100).collect::<String>().replace('\n', " / ");
        println!("{:<9} {:<16} {}", t.role, t.tool.unwrap_or_default(), text);
    }
}
