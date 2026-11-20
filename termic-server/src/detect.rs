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
    QUESTION_PATTERNS.iter().any(|p| screen.iter().any(|l| l.contains(p)))
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

