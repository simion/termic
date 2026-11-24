//! Agent work state from PTY activity and the screen tail, in the
//! desktop's vocabulary: working, waiting, done, idle, inactive.
//!
//! The desktop reads agent hooks and its xterm screen; a headless box has
//! neither, so this is the floor every agent gets: output within the quiet
//! window is work, a quiet screen showing a question is waiting (matched
//! on the screen as rendered now, not the raw stream).

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

/// Whether the screen as it is drawn now shows a question. The rendered
/// screen, not the raw stream: a menu Claude drew and then erased (its
/// rewind picker, a trust prompt) stays in the last bytes of output, and
/// matching those kept a finished task on Needs you.
pub fn shows_question(screen: &[String]) -> bool {
    // Only the bottom: a live question is the last thing drawn, and an
    // answered one a line-printing agent leaves above its next output must
    // not keep it on Needs you.
    let bottom: Vec<&String> = screen.iter().rev().filter(|l| !l.trim().is_empty()).take(BOTTOM_LINES).collect();
    QUESTION_PATTERNS.iter().any(|p| bottom.iter().any(|l| l.contains(p)))
}

/// How many non-empty lines from the bottom `shows_question` reads.
const BOTTOM_LINES: usize = 3;

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
    /// Someone has its terminal open right now.
    pub watched: bool,
    /// When its terminal was last opened or closed: output from before
    /// that has been seen.
    pub seen: Option<Instant>,
}

pub fn work_state(a: &Activity, now: Instant, quiet: Duration) -> &'static str {
    if a.exited {
        return "inactive";
    }
    // Output is work only once the agent was given something. Before any
    // input it is the agent starting up (or redrawing), which the desktop
    // does not draw as work either.
    if a.last_input.is_some() && a.last_activity.is_some_and(|t| now.saturating_duration_since(t) < quiet) {
        return "working";
    }
    if a.question {
        return "waiting";
    }
    // Done: it answered something it was given, and nobody has looked
    // since. Looking (its terminal open, or opened after the answer) makes
    // it idle, as reading a finished task does on the desktop.
    match (a.last_input, a.last_output) {
        (Some(i), Some(o)) if o >= i && !a.watched && a.seen.is_none_or(|s| o > s) => "done",
        _ => "idle",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            assert!(shows_question(&termic_remote::screen::render(y, 24, 80)), "{:?}", String::from_utf8_lossy(y));
        }
        let no = [&b"Fixed the bug in src/login.rs.\r\n> "[..], b"\x1b[2m? for shortcuts\x1b[0m", b"Running tests... 12 passed", b"allowed list updated"];
        for n in no {
            assert!(!shows_question(&termic_remote::screen::render(n, 24, 80)), "{:?}", String::from_utf8_lossy(n));
        }
    }

    #[test]
    fn an_answered_question_above_newer_output_is_not_a_question() {
        let raw = b"Do you want to proceed? (y/n) yes\r\necho: yes\r\nfinished\r\n> ";
        assert!(!shows_question(&termic_remote::screen::render(raw, 10, 60)));
        assert!(shows_question(&termic_remote::screen::render(b"echo: hi\r\nDo you want to proceed? (y/n) ", 10, 60)));
    }

    #[test]
    fn an_erased_menu_is_not_a_question() {
        // A picker drawn at the bottom, then erased line by line and the
        // prompt box drawn in its place: the shape Claude leaves behind
        // when its rewind menu is dismissed.
        let menu = b"done\r\n  Rewind\r\n  Restore the conversation\r\n  Enter to continue \xc2\xb7 Esc to cancel";
        let mut ring = menu.to_vec();
        ring.extend_from_slice(b"\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\r\xe2\x9d\xaf \r\n  auto mode on");
        assert!(shows_question(&termic_remote::screen::render(menu, 10, 60)));
        assert!(!shows_question(&termic_remote::screen::render(&ring, 10, 60)));
    }

    #[test]
    fn states_follow_activity_and_the_screen() {
        let q = Duration::from_secs(2);
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let base = Activity { exited: false, last_activity: None, last_output: None, last_input: None, question: false, watched: false, seen: None };
        assert_eq!(work_state(&base, at(10), q), "idle");
        // Starting up, given nothing yet: not work, whatever it prints.
        let booted = Activity { last_activity: Some(at(0)), last_output: Some(at(0)), ..base };
        assert_eq!(work_state(&booted, at(1), q), "idle");
        let answered = Activity { last_input: Some(at(5)), last_output: Some(at(6)), last_activity: Some(at(6)), ..base };
        assert_eq!(work_state(&answered, at(7), q), "working");
        assert_eq!(work_state(&answered, at(9), q), "done");
        // Looked at: open now, or opened after the answer.
        assert_eq!(work_state(&Activity { watched: true, ..answered }, at(9), q), "idle");
        assert_eq!(work_state(&Activity { seen: Some(at(8)), ..answered }, at(9), q), "idle");
        assert_eq!(work_state(&Activity { seen: Some(at(4)), ..answered }, at(9), q), "done", "seen before the answer");
        let asking = Activity { question: true, ..answered };
        assert_eq!(work_state(&asking, at(7), q), "working");
        assert_eq!(work_state(&asking, at(9), q), "waiting");
        assert_eq!(work_state(&Activity { watched: true, ..asking }, at(9), q), "waiting", "looking does not answer it");
        let gone = Activity { exited: true, ..answered };
        assert_eq!(work_state(&gone, at(7), q), "inactive");
    }
}

