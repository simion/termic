//! Agent work state from PTY activity and the screen tail, in the
//! desktop's vocabulary: working, waiting, done, idle, inactive.
//!
//! The desktop reads agent hooks and its xterm screen; a headless box has
//! neither, so this is the floor every agent gets: output within the quiet
//! window is work, a quiet screen showing a question is waiting.

use std::time::{Duration, Instant};

/// Text that, on a quiet screen, means the agent is asking something.
/// Matched against the ANSI-stripped tail. Kept small and specific: a
/// false "waiting" is a nag, a missed one is a stalled agent.
pub const QUESTION_PATTERNS: &[&str] = &[
    "Do you want",
    "Would you like",
    "❯ 1.",
    "(y/n)",
    "(Y/n)",
    "(y/N)",
    "[Y/n]",
    "[y/N]",
    "[y/n]",
    "Allow ",
    "Esc to cancel",
    "Enter to confirm",
    "Press Enter to continue",
];

/// The tail of the ring the question patterns look at.
pub const TAIL_BYTES: usize = 4096;

/// Remove ANSI escape sequences (CSI, OSC, two-byte ESC) and other control
/// bytes except newline and tab. Carriage returns become newlines, so a
/// redraw does not glue a stale line onto a new one.
pub fn strip_ansi(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\x1b' => match it.next() {
                Some('[') => {
                    // CSI: parameters then one final byte in @..~.
                    for n in it.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') | Some('P') | Some('_') | Some('^') => {
                    // OSC / DCS / APC / PM: up to BEL or ST (ESC \).
                    while let Some(n) = it.next() {
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' {
                            if it.peek() == Some(&'\\') {
                                it.next();
                            }
                            break;
                        }
                    }
                }
                Some('(') | Some(')') | Some('#') => {
                    it.next();
                }
                _ => {}
            },
            '\r' => out.push('\n'),
            '\n' | '\t' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Whether the tail of a ring shows a question.
pub fn shows_question(tail: &[u8]) -> bool {
    let start = tail.len().saturating_sub(TAIL_BYTES);
    let text = strip_ansi(&tail[start..]);
    QUESTION_PATTERNS.iter().any(|p| text.contains(p))
}

/// Everything the state depends on, captured at one instant.
#[derive(Debug, Clone, Copy)]
pub struct Activity {
    /// The agent process exited (or there is no live PTY at all).
    pub exited: bool,
    /// Last PTY output, or a prompt delivery (which counts as activity so
    /// a `wait` right after a `send` never sees the previous turn's done).
    pub last_activity: Option<Instant>,
    /// Last output from the agent.
    pub last_output: Option<Instant>,
    /// Last input of any kind (a prompt, keys, terminal typing).
    pub last_input: Option<Instant>,
    /// The quiet screen shows a question.
    pub question: bool,
}

pub fn work_state(a: &Activity, now: Instant, quiet: Duration) -> &'static str {
    if a.exited {
        return "inactive";
    }
    if a.last_activity.is_some_and(|t| now.saturating_duration_since(t) < quiet) {
        return "working";
    }
    if a.question {
        return "waiting";
    }
    // Done: it answered something it was given. Idle: it only ever drew its
    // own startup screen.
    match (a.last_input, a.last_output) {
        (Some(i), Some(o)) if o >= i => "done",
        _ => "idle",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_escapes_and_keeps_text() {
        let raw = b"\x1b[2J\x1b[1;1H\x1b[38;5;208mHello\x1b[0m \x1b]0;title\x07world\r\n\x1b(Bok\x1b]8;;http://x\x1b\\link";
        assert_eq!(strip_ansi(raw), "Hello world\n\noklink");
    }

    #[test]
    fn question_patterns_match_real_prompt_shapes() {
        let yes = [
            &b"\x1b[1mDo you want to proceed?\x1b[0m\r\n\x1b[36m\xe2\x9d\xaf 1. Yes\r\n  2. No"[..],
            b"Overwrite file? (y/n) ",
            b"Continue? [Y/n] ",
            b"Allow this command to run?",
            b"\x1b[2mEsc to cancel\x1b[0m",
            b"Would you like to run the following command?",
        ];
        for y in yes {
            assert!(shows_question(y), "{:?}", String::from_utf8_lossy(y));
        }
        let no = [&b"Fixed the bug in src/login.rs.\r\n> "[..], b"\x1b[2m? for shortcuts\x1b[0m", b"Running tests... 12 passed", b"allowed list updated"];
        for n in no {
            assert!(!shows_question(n), "{:?}", String::from_utf8_lossy(n));
        }
    }

    #[test]
    fn only_the_tail_is_read() {
        let mut ring = b"Do you want to proceed?".to_vec();
        ring.extend(std::iter::repeat_n(b'x', TAIL_BYTES + 10));
        assert!(!shows_question(&ring));
    }

    #[test]
    fn states_follow_activity_and_the_screen() {
        let q = Duration::from_secs(2);
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let base = Activity { exited: false, last_activity: None, last_output: None, last_input: None, question: false };
        assert_eq!(work_state(&base, at(10), q), "idle");
        let booted = Activity { last_activity: Some(at(0)), last_output: Some(at(0)), ..base };
        assert_eq!(work_state(&booted, at(1), q), "working");
        assert_eq!(work_state(&booted, at(3), q), "idle");
        let answered = Activity { last_input: Some(at(5)), last_output: Some(at(6)), last_activity: Some(at(6)), ..base };
        assert_eq!(work_state(&answered, at(7), q), "working");
        assert_eq!(work_state(&answered, at(9), q), "done");
        let asking = Activity { question: true, ..answered };
        assert_eq!(work_state(&asking, at(7), q), "working");
        assert_eq!(work_state(&asking, at(9), q), "waiting");
        let gone = Activity { exited: true, ..answered };
        assert_eq!(work_state(&gone, at(7), q), "inactive");
    }
}
