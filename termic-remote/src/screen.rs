//! Reading an agent's screen: what a phone shows as "Claude wants to run
//! a command" with the agent's own options as buttons.
//!
//! The host keeps raw PTY output (a ring), not a screen. [`render`] replays
//! the ring's tail through a terminal emulator (`vt100`) at the PTY's size
//! and returns the visible lines; [`question`] and [`activity`] read them.
//!
//! The parsing is deliberately conservative. A false "question" puts
//! buttons on a phone that type into an agent, so anything that does not
//! look like a menu with a confirm affordance is not one, and the phone
//! falls back to "look at the terminal". Answers are bound to the
//! question's id and the host refuses keys for a question that is no
//! longer on screen (remote_server.rs).

use crate::wire::{Question, QuestionOption};

/// The visible screen, one string per row, right-trimmed. Starting
/// mid-stream is fine: TUIs redraw their whole frame, and a garbled first
/// line scrolls away or is overwritten.
pub fn render(bytes: &[u8], rows: u16, cols: u16) -> Vec<String> {
    let mut p = vt100::Parser::new(rows.max(2), cols.max(10), 0);
    p.process(bytes);
    p.screen().rows(0, cols.max(10)).map(|r| r.trim_end().to_string()).collect()
}

const MARKERS: [char; 4] = ['❯', '›', '>', '▶'];
const BOX: &[char] = &['│', '┃', '║', '╭', '╮', '╰', '╯', '┌', '┐', '└', '┘', '|'];

/// A line with box-drawing borders removed.
fn unbox(line: &str) -> String {
    line.trim().trim_matches(|c| BOX.contains(&c)).trim().to_string()
}

fn is_rule(line: &str) -> bool {
    let t = line.trim();
    !t.is_empty() && t.chars().all(|c| matches!(c, '─' | '━' | '═' | '-' | '╌' | '┄' | '▔' | '▁') || BOX.contains(&c) || c == ' ')
        && t.chars().any(|c| matches!(c, '─' | '━' | '═' | '-' | '╌' | '┄' | '▔' | '▁'))
}

/// A full-width rule that closes a dialog (`─`), as opposed to the dashed
/// one (`╌`) a dialog draws around its own content, such as the command.
fn is_solid_rule(line: &str) -> bool {
    is_rule(line) && !line.contains('╌') && !line.contains('┄')
}

fn is_dashed_rule(line: &str) -> bool {
    is_rule(line) && (line.contains('╌') || line.contains('┄'))
}

/// One option row: whether it carries the selection marker, its number if
/// numbered, its label, and its indentation.
struct OptRow {
    selected: bool,
    number: Option<u32>,
    label: String,
}

fn parse_opt(line: &str) -> Option<OptRow> {
    let t = unbox(line);
    let (selected, rest) = match t.chars().next() {
        Some(c) if MARKERS.contains(&c) => (true, t[c.len_utf8()..].trim_start()),
        _ => (false, t.as_str()),
    };
    // "1. Yes" / "2) No"
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() && digits.len() <= 2 {
        let after = &rest[digits.len()..];
        if let Some(label) = after.strip_prefix(". ").or_else(|| after.strip_prefix(") ")) {
            let label = label.trim();
            if !label.is_empty() {
                return Some(OptRow { selected, number: digits.parse().ok(), label: label.to_string() });
            }
        }
    }
    if selected && !rest.is_empty() {
        return Some(OptRow { selected, number: None, label: rest.to_string() });
    }
    None
}

/// Footers that say "this is a menu you confirm", which an agent's own
/// input prompt (also drawn with ❯) never shows.
fn is_confirm_footer(line: &str) -> bool {
    let l = line.to_lowercase();
    l.contains("enter to confirm")
        || l.contains("esc to cancel")
        || l.contains("to select")
        || l.contains("enter to select")
        // Antigravity: "↑/↓ Navigate · enter Confirm".
        || l.contains("enter confirm")
}

/// A label without a trailing key hint: Codex's "Yes, proceed (y)" and
/// "No, and tell Codex what to do differently (esc)". A longer aside such
/// as "(Persist to settings.json)" is part of the label and stays.
fn strip_key_hint(label: &str) -> String {
    if let Some(open) = label.rfind(" (") {
        let hint = &label[open + 2..];
        if let Some(inner) = hint.strip_suffix(')') {
            if !inner.is_empty() && inner.len() <= 5 && inner.chars().all(|c| c.is_ascii_alphanumeric()) {
                return label[..open].trim_end().to_string();
            }
        }
    }
    label.to_string()
}

/// "Reason: May I create the file?" is a field of the dialog, not its
/// question: a short capitalised label before ": ".
fn is_field(line: &str) -> bool {
    line.split_once(": ").is_some_and(|(k, _)| {
        !k.is_empty() && k.len() <= 24 && k.starts_with(|c: char| c.is_ascii_uppercase()) && k.chars().all(|c| c.is_alphanumeric() || c == ' ')
    })
}

/// The question on screen, if the screen holds a menu: two or more numbered
/// options counting up from 1, or a ❯-marked list with a confirm footer.
pub fn question(lines: &[String]) -> Option<Question> {
    // The last menu on screen is the live one.
    let mut end = None;
    for (i, l) in lines.iter().enumerate().rev() {
        if parse_opt(l).is_some() {
            end = Some(i);
            break;
        }
    }
    let end = end?;
    let (start, stop, rows) = match numbered_menu(lines, end) {
        Some(found) => found,
        None => {
            let mut start = end;
            while start > 0 {
                let prev = &lines[start - 1];
                if parse_opt(prev).is_some() {
                    start -= 1;
                    continue;
                }
                // An unnumbered sibling under a ❯ list: same text column, no marker.
                let t = unbox(prev);
                if !t.is_empty() && !is_rule(prev) && start <= end && unmarked_sibling(prev, &lines[start]) {
                    start -= 1;
                    continue;
                }
                break;
            }
            // Unmarked siblings BELOW the last parsed row (a ❯ on the first option).
            let mut stop = end;
            while stop + 1 < lines.len() && unmarked_sibling(&lines[stop + 1], &lines[stop]) {
                stop += 1;
            }
            let rows: Vec<(usize, OptRow)> = (start..=stop)
                .filter_map(|i| parse_opt(&lines[i]).map(|o| (i, o)).or_else(|| {
                    let t = unbox(&lines[i]);
                    (!t.is_empty()).then_some((i, OptRow { selected: false, number: None, label: t }))
                }))
                .collect();
            (start, stop, rows)
        }
    };
    if rows.len() < 2 {
        return None;
    }
    let numbered = rows.iter().all(|(_, o)| o.number.is_some())
        && rows.iter().enumerate().all(|(k, (_, o))| o.number == Some(k as u32 + 1));
    let footer = lines[stop + 1..].iter().take(4).any(|l| is_confirm_footer(l));
    if !numbered && !footer {
        return None;
    }
    // Exactly one highlighted option, or none known (then the first is).
    let marked: Vec<usize> = rows.iter().enumerate().filter(|(_, (_, o))| o.selected).map(|(k, _)| k).collect();
    if marked.len() > 1 {
        return None;
    }
    let current = marked.first().copied().unwrap_or(0);

    // The dialog above the options: up to a rule, a box top, or two blank
    // lines. Its last line ending in '?' is the title; the rest the body.
    let mut top = start;
    let mut blanks = 0;
    while top > 0 {
        let l = &lines[top - 1];
        if is_solid_rule(l) || l.trim_start().starts_with('╭') || l.trim_start().starts_with('┌') {
            break;
        }
        if unbox(l).is_empty() {
            blanks += 1;
            if blanks >= 2 {
                break;
            }
        } else {
            blanks = 0;
        }
        top -= 1;
        if start - top > 24 {
            break;
        }
    }
    let region: Vec<String> = lines[top..start].iter().map(|l| unbox(l)).collect();
    // The title: the last line that is a question (not a "Reason: ...?"
    // field), else a question that ends mid-line, where a dialog runs its
    // explanation on after it (Codex's folder trust), else the first line.
    let title_idx = region
        .iter()
        .rposition(|l| l.ends_with('?') && !is_field(l))
        .or_else(|| region.iter().rposition(|l| l.ends_with('?')));
    // A field-shaped line ("Quick safety check: Is this ...? (Like ...") is
    // the question after its label, when no other line is one.
    let inline_q = || {
        let mid = |l: &String| Some(l[..=l.find("? ")?].trim().to_string());
        region.iter().filter(|l| !is_field(l)).find_map(mid).or_else(|| {
            region.iter().filter(|l| is_field(l)).find_map(|l| mid(l).map(|q| q.split_once(": ").map_or(q.clone(), |(_, rest)| rest.to_string())))
        })
    };
    let title = title_idx
        .map(|i| region[i].clone())
        .or_else(inline_q)
        .or_else(|| region.iter().find(|l| !l.is_empty() && !is_rule(l)).cloned())
        .unwrap_or_default();
    // The body is what the question is about. A dialog that frames it with
    // dashed rules (Claude's command and edit prompts) means exactly that
    // frame: the command that will run, nothing around it.
    let dashed: Vec<usize> = lines[top..start].iter().enumerate().filter(|(_, l)| is_dashed_rule(l)).map(|(i, _)| i).collect();
    let body_lines: Vec<&String> = match (dashed.first(), dashed.last()) {
        (Some(&a), Some(&b)) if b > a => region[a + 1..b].iter().filter(|l| !l.is_empty()).collect(),
        _ => region
            .iter()
            .enumerate()
            .filter(|(i, l)| Some(*i) != title_idx && !l.is_empty() && !is_rule(l) && (title_idx.is_some() || **l != title))
            .map(|(_, l)| l)
            .collect(),
    };
    let body = body_lines.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n");
    let all = region.join("\n").to_lowercase();
    let kind = if all.contains("bash command") || all.contains("run this command") || all.contains("command") && all.contains("run") {
        "command"
    } else if all.contains("edit file") || all.contains("create file") || all.contains("write") && all.contains("file") || all.contains("make this edit") {
        "edit"
    // Asked to FETCH, not merely showing a link: Codex's update menu
    // carries its release notes' URL and is a menu.
    } else if all.contains("fetch") {
        "fetch"
    } else {
        "menu"
    };
    let options: Vec<QuestionOption> = rows
        .iter()
        .enumerate()
        .map(|(k, (_, o))| {
            let mut keys = Vec::new();
            let step: &[u8] = if k > current { b"\x1b[B" } else { b"\x1b[A" };
            for _ in 0..k.abs_diff(current) {
                keys.extend_from_slice(step);
            }
            keys.push(b'\r');
            QuestionOption { label: strip_key_hint(&o.label), keys: crate::b64(&keys), selected: k == current }
        })
        .collect();
    // The id is the question's TEXT, whitespace removed: a redraw at another
    // width rewraps lines and must not read as a different question, while
    // two commands asked in a row still differ.
    let squash = |s: &str| s.split_whitespace().collect::<String>();
    let labels = rows.iter().map(|(_, o)| squash(&o.label)).collect::<Vec<_>>().join("\u{2}");
    let id = fnv(&format!("{}\u{1}{}\u{1}{labels}", squash(&title), squash(&body)));
    Some(Question { id, kind: kind.into(), title, body, options })
}

/// Spaces before a line's text, after any box border.
fn indent(line: &str) -> usize {
    let s = line.trim_start().strip_prefix(|c| BOX.contains(&c)).unwrap_or(line);
    s.chars().take_while(|c| *c == ' ').count()
}

/// A menu's first and last line, and its option rows with their lines.
type Menu = (usize, usize, Vec<(usize, OptRow)>);

/// A numbered menu ending at `end`: options counting up from 1, possibly
/// with a description indented under each and a rule between two groups
/// (the shape of Claude's AskUserQuestion). None when the rows above `end`
/// are not that.
fn numbered_menu(lines: &[String], end: usize) -> Option<Menu> {
    let mut rows: Vec<(usize, OptRow)> = Vec::new();
    // Text wrapped out of an option's label, read bottom-up: an unindented
    // line between two numbered options (agy wraps long labels to column 0
    // in a narrow pane). Joined onto the option above it.
    let mut wrapped: Vec<String> = Vec::new();
    let mut i = end + 1;
    while i > 0 {
        i -= 1;
        let l = &lines[i];
        match parse_opt(l) {
            Some(mut o) if o.number.is_some() => {
                if !wrapped.is_empty() {
                    wrapped.reverse();
                    o.label = format!("{} {}", o.label, wrapped.join(" "));
                    wrapped.clear();
                }
                rows.push((i, o))
            }
            Some(_) => break,
            None if is_rule(l) || (indent(l) >= 3 && !unbox(l).is_empty()) => continue,
            None if !rows.is_empty() && i > 0 && !unbox(l).is_empty() && !is_confirm_footer(l)
                && parse_opt(&lines[i - 1]).is_some_and(|o| o.number.is_some()) =>
            {
                wrapped.push(unbox(l));
                continue;
            }
            None => break,
        }
        if rows.last().is_some_and(|(_, o)| o.number == Some(1)) {
            break;
        }
    }
    rows.reverse();
    let ok = rows.len() >= 2 && rows.iter().enumerate().all(|(k, (_, o))| o.number == Some(k as u32 + 1));
    ok.then(|| (rows[0].0, end, rows))
}

/// `b` continues a ❯ list `a` without its own marker: same text column as
/// `a`'s label, not a footer, not a rule.
fn unmarked_sibling(b: &str, a: &str) -> bool {
    let tb = unbox(b);
    if tb.is_empty() || is_rule(b) || is_confirm_footer(b) || parse_opt(b).is_some_and(|o| o.selected) {
        return false;
    }
    let col = |l: &str| -> Option<usize> {
        let t = unbox(l);
        let skip = t.chars().next().filter(|c| MARKERS.contains(c)).map(|c| c.len_utf8()).unwrap_or(0);
        let label = t[skip..].trim_start();
        let lead = l.find(label)?;
        Some(l[..lead].chars().count())
    };
    match (col(a), col(b)) {
        (Some(x), Some(y)) => x == y && parse_opt(a).is_some_and(|o| o.number.is_none()),
        _ => false,
    }
}

/// What a working agent says it is doing: the status line that offers
/// "esc to interrupt", without its spinner glyph and running counters.
pub fn activity(lines: &[String]) -> Option<String> {
    let line = lines.iter().rev().find(|l| l.to_lowercase().contains("esc to interrupt"))?;
    let t = unbox(line);
    let t = t.split('(').next().unwrap_or(&t);
    let t = t.trim_start_matches(|c: char| !c.is_alphanumeric()).trim();
    let t = t.trim_end_matches(['…', '.', ' ']);
    (!t.is_empty()).then(|| t.chars().take(80).collect())
}

/// FNV-1a, hex: a stable id for a question's text within one host.
fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &str) -> Vec<String> {
        s.lines().map(str::to_string).collect()
    }

    fn keys(o: &QuestionOption) -> Vec<u8> {
        crate::unb64(&o.keys).unwrap()
    }

    /// The shape of Claude Code's permission prompt (retyped, synthetic).
    #[test]
    fn a_boxed_numbered_permission_prompt() {
        let screen = lines(
            "\
some earlier output
╭──────────────────────────────────────────────╮
│ Bash command                                 │
│                                              │
│   npm run test -- --watch=false              │
│   Run the unit tests                         │
│                                              │
│ Do you want to proceed?                      │
│ ❯ 1. Yes                                     │
│   2. Yes, and don't ask again for npm run    │
│   3. No, and tell Claude what to do (esc)    │
╰──────────────────────────────────────────────╯",
        );
        let q = question(&screen).expect("a question");
        assert_eq!(q.kind, "command");
        assert_eq!(q.title, "Do you want to proceed?");
        assert!(q.body.contains("npm run test -- --watch=false"), "{}", q.body);
        assert!(q.body.contains("Bash command"));
        let labels: Vec<&str> = q.options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, ["Yes", "Yes, and don't ask again for npm run", "No, and tell Claude what to do"], "the (esc) key hint is not part of the label");
        assert!(q.options[0].selected);
        assert_eq!(keys(&q.options[0]), b"\r");
        assert_eq!(keys(&q.options[2]), b"\x1b[B\x1b[B\r");
    }

    /// The shape of Claude's AskUserQuestion (retyped, synthetic): a
    /// description under each option, and one option after a rule.
    #[test]
    fn options_with_descriptions_and_a_rule_between_them() {
        let screen = lines(
            "\
 \u{2610} Name

Should the function be named sum or plus?

\u{276f} 1. sum
     Name the function sum
  2. plus
     Name the function plus
  3. Type something.
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  4. Chat about this

Enter to select \u{b7} \u{2191}/\u{2193} to navigate \u{b7} Esc to cancel",
        );
        let q = question(&screen).expect("a question");
        let labels: Vec<&str> = q.options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, ["sum", "plus", "Type something.", "Chat about this"]);
        assert_eq!(q.title, "Should the function be named sum or plus?");
        assert!(q.options[0].selected);
        assert_eq!(keys(&q.options[3]), b"\x1b[B\x1b[B\x1b[B\r");
    }

    /// The shape of Claude's Bash permission prompt (retyped, synthetic): the
    /// command framed by dashed rules, the dialog topped by a solid one.
    #[test]
    fn a_framed_command_is_the_body_and_the_kind_is_command() {
        let dash = "\u{254c}".repeat(40);
        let solid = "\u{2500}".repeat(40);
        let screen = lines(&format!(
            "earlier output\n{solid}\n Bash command\n\n Show the first line of a file\n{dash}\n head -1 src/math.js\n{dash}\n This command requires approval\n\n Do you want to proceed?\n \u{276f} 1. Yes\n   2. Yes, and don't ask again for: head *\n   3. No\n\n Esc to cancel"
        ));
        let q = question(&screen).expect("a question");
        assert_eq!(q.kind, "command");
        assert_eq!(q.body, "head -1 src/math.js");
        assert_eq!(q.title, "Do you want to proceed?");
        assert_eq!(q.options.len(), 3);
    }

    #[test]
    fn the_id_survives_a_rewrap_at_another_width() {
        let wide = question(&lines("Run this?\nnpm run test -- --watch=false\n\u{276f} 1. Yes\n  2. No\n")).unwrap();
        let narrow = question(&lines("Run this?\nnpm run test --\n--watch=false\n\u{276f} 1. Yes\n  2. No\n")).unwrap();
        assert_eq!(wide.id, narrow.id);
    }

    #[test]
    fn the_selection_can_be_anywhere() {
        let screen = lines("Pick one?\n  1. Red\n❯ 2. Green\n  3. Blue\n");
        let q = question(&screen).unwrap();
        assert_eq!(q.options.iter().position(|o| o.selected), Some(1));
        assert_eq!(keys(&q.options[0]), b"\x1b[A\r");
        assert_eq!(keys(&q.options[1]), b"\r");
        assert_eq!(keys(&q.options[2]), b"\x1b[B\r");
    }

    /// An unnumbered menu (the shape of Claude's folder-trust prompt) counts
    /// only with its confirm footer.
    #[test]
    fn an_unnumbered_menu_needs_its_confirm_footer() {
        let with = lines(
            "\
Quick safety check: Is this a project you trust?

❯ No, exit
  Yes, I trust this folder

Enter to confirm · Esc to cancel",
        );
        let q = question(&with).expect("menu with footer");
        let labels: Vec<&str> = q.options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, ["No, exit", "Yes, I trust this folder"]);
        assert_eq!(q.title, "Quick safety check: Is this a project you trust?");
        assert_eq!(keys(&q.options[1]), b"\x1b[B\r");

        let without = lines("Some text\n\n❯ No, exit\n  Yes, I trust this folder\n");
        assert!(question(&without).is_none());
    }

    #[test]
    fn an_input_prompt_is_not_a_question() {
        let screen = lines("● Done. All tests pass.\n\n────────────\n❯ try \"fix the bug\"\n────────────\n  ⏵⏵ auto mode on");
        assert!(question(&screen).is_none());
        // Nor is a numbered list in prose that does not start at 1.
        assert!(question(&lines("Steps:\n  2. build\n  3. test\n")).is_none());
        // Nor a lone numbered line.
        assert!(question(&lines("  1. Only one\n")).is_none());
    }

    #[test]
    fn the_id_is_stable_for_the_same_question_and_changes_with_it() {
        let a = question(&lines("Proceed?\n❯ 1. Yes\n  2. No\n")).unwrap();
        // Earlier output, separated from the dialog as it is on screen,
        // is not part of it.
        let b = question(&lines("noise above\n\n\nProceed?\n❯ 1. Yes\n  2. No\n")).unwrap();
        assert_eq!(a.id, b.id);
        // The same title and options about a different command is a
        // different question (two Bash approvals in a row).
        let e = question(&lines("rm -rf build\nProceed?\n❯ 1. Yes\n  2. No\n")).unwrap();
        assert_ne!(a.id, e.id);
        let c = question(&lines("Delete it?\n❯ 1. Yes\n  2. No\n")).unwrap();
        assert_ne!(a.id, c.id);
        // Moving the highlight is the same question (the answer still fits).
        let d = question(&lines("Proceed?\n  1. Yes\n❯ 2. No\n")).unwrap();
        assert_eq!(a.id, d.id);
    }

    #[test]
    fn activity_reads_the_status_line() {
        let s = lines("output\n✻ Running the tests… (42s · ↑ 1.2k tokens · esc to interrupt)\n\n❯ \n");
        assert_eq!(activity(&s).as_deref(), Some("Running the tests"));
        assert_eq!(activity(&lines("idle screen\n❯ ")), None);
    }

    #[test]
    fn render_replays_escape_sequences_into_lines() {
        let bytes = b"\x1b[2J\x1b[Hhello\r\nwor\x1b[1;1HH\x1b[2;4Hld\x1b[31m!\x1b[0m";
        let screen = render(bytes, 5, 20);
        assert_eq!(screen[0], "Hello");
        assert_eq!(screen[1], "world!");
        assert_eq!(screen.len(), 5);
    }

    // Codex and Antigravity prompt shapes, retyped from the screens their
    // TUIs draw (Codex 0.154, agy 1.5) with placeholder paths. What makes
    // each hard is named on its test.

    /// Codex's command approval: two lines end in '?', and the last is the
    /// "Reason:" field, not the question. Labels carry key hints.
    #[test]
    fn codex_command_approval() {
        let screen = lines(
            "\
• Running touch notes.txt

  Would you like to run the following command?

  Environment: local

  Reason: May I create the requested notes.txt file?

  $ touch notes.txt

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `touch notes.txt` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel",
        );
        let q = question(&screen).expect("a question");
        assert_eq!(q.kind, "command");
        assert_eq!(q.title, "Would you like to run the following command?");
        assert!(q.body.contains("Reason: May I create the requested notes.txt file?"), "{}", q.body);
        assert!(q.body.contains("$ touch notes.txt"), "{}", q.body);
        let labels: Vec<_> = q.options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, [
            "Yes, proceed",
            "Yes, and don't ask again for commands that start with `touch notes.txt`",
            "No, and tell Codex what to do differently",
        ]);
        assert!(q.options[0].selected);
        assert_eq!(keys(&q.options[0]), b"\r");
        assert_eq!(keys(&q.options[2]), b"\x1b[B\x1b[B\r");
    }

    /// Codex's folder trust: no line ENDS in '?' (the explanation runs on
    /// after it), and the line above starts with '>' and holds a path.
    #[test]
    fn codex_folder_trust() {
        let screen = lines(
            "\
> You are in /Users/u/src/app

  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of
  prompt injection. Trusting the directory allows project-local config, hooks, and exec policies to load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue",
        );
        let q = question(&screen).expect("a question");
        assert_eq!(q.title, "Do you trust the contents of this directory?");
        assert!(q.body.contains("prompt injection"), "{}", q.body);
        assert_eq!(q.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["Yes, continue", "No, quit"]);
        assert_eq!(keys(&q.options[1]), b"\x1b[B\r");
    }

    /// Antigravity's command approval: numbered, '>' marker, its own footer,
    /// and a long parenthetical that is part of a label, not a key hint.
    #[test]
    fn antigravity_command_approval() {
        let screen = lines(
            "\
Requesting permission for:
   rm -f old.js

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start with 'rm -f old.js'
  3. Yes, and always allow for commands that start with 'rm -f old.js' (Persist to settings.json)
  4. No, cancel
  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command",
        );
        let q = question(&screen).expect("a question");
        assert_eq!(q.kind, "command");
        assert_eq!(q.title, "Run this command?");
        assert_eq!(q.body, "Requesting permission for:\nrm -f old.js");
        assert_eq!(q.options.len(), 4);
        assert!(q.options[2].label.ends_with("(Persist to settings.json)"), "{}", q.options[2].label);
        assert_eq!(keys(&q.options[3]), b"\x1b[B\x1b[B\x1b[B\r");
    }

    /// Antigravity's folder trust: UNNUMBERED, so only its footer says it
    /// is a menu to confirm.
    #[test]
    fn antigravity_folder_trust() {
        let screen = lines(
            "\
Accessing workspace:
/Users/u/src/app

Do you trust the contents of this project?
Antigravity CLI requires permission to read, edit, and execute files here.

> Yes, I trust this folder
  No, exit

  ↑/↓ Navigate · enter Confirm",
        );
        let q = question(&screen).expect("a question");
        assert_eq!(q.kind, "menu");
        assert_eq!(q.title, "Do you trust the contents of this project?");
        assert_eq!(q.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["Yes, I trust this folder", "No, exit"]);
        assert!(q.options[0].selected);
        assert_eq!(keys(&q.options[1]), b"\x1b[B\r");
    }

    /// A question that LOOKS like a field is still the title when it is the
    /// only question there.
    #[test]
    fn a_field_shaped_question_alone_is_the_title() {
        let screen = lines(
            "\
Database: Postgres or SQLite?
❯ 1. Postgres
  2. SQLite",
        );
        assert_eq!(question(&screen).unwrap().title, "Database: Postgres or SQLite?");
    }

    #[test]
    fn key_hints_are_stripped_and_asides_kept() {
        assert_eq!(strip_key_hint("Yes, proceed (y)"), "Yes, proceed");
        assert_eq!(strip_key_hint("No (esc)"), "No");
        assert_eq!(strip_key_hint("Keep it (Persist to settings.json)"), "Keep it (Persist to settings.json)");
        assert_eq!(strip_key_hint("Run tests (all)"), "Run tests");
        assert_eq!(strip_key_hint("Plain"), "Plain");
    }

    /// agy in a narrow pane wraps long option labels to column 0. The
    /// wrapped text belongs to the option above, and the menu still reads.
    #[test]
    fn antigravity_options_wrapped_in_a_narrow_pane() {
        let screen = lines(
            "\
Requesting permission for:
   rm -f old.js
Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start with 'rm
-f old.js'
  3. Yes, and always allow for commands that start with 'rm -f old.js' (Persist
to settings.json)
  4. No, cancel
  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command",
        );
        let q = question(&screen).expect("a question");
        assert_eq!(q.title, "Run this command?");
        let labels: Vec<_> = q.options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, [
            "Yes, run command",
            "Yes, and always allow in this conversation for commands that start with 'rm -f old.js'",
            "Yes, and always allow for commands that start with 'rm -f old.js' (Persist to settings.json)",
            "No, cancel",
        ]);
        assert_eq!(keys(&q.options[3]), b"\x1b[B\x1b[B\x1b[B\r");
    }

    /// Claude's folder trust: its question runs on mid-line after a
    /// "Quick safety check:" label, and nothing else on screen is one.
    #[test]
    fn claude_folder_trust_titles_its_question() {
        let screen = lines(
            "\
 Accessing workspace:

 /Users/u/src/app

 Quick safety check: Is this a project you created or one you trust? (Like your
 own code, a well-known open source project, or work from your team). If not,
 take a moment to review what's in this folder first.

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel",
        );
        let q = question(&screen).expect("a question");
        assert_eq!(q.title, "Is this a project you created or one you trust?");
        assert!(q.body.contains("Quick safety check"), "{}", q.body);
    }

    /// Codex's update menu shows a release-notes link: a link on screen is
    /// not a request to fetch it.
    #[test]
    fn a_menu_with_a_link_is_not_a_fetch() {
        let screen = lines(
            "\
  Update available! 0.1.0 -> 0.2.0
  Release notes: https://example.com/releases/latest

› 1. Update now
  2. Skip
  3. Skip until next version

  Press enter to continue",
        );
        let q = question(&screen).expect("a question");
        assert_eq!(q.kind, "menu");
        assert_eq!(q.options[1].label, "Skip");
    }
}
