// Rust-side terminal state machine — fed the PTY firehose in parallel
// with the frontend xterm.js render path. Lets us produce an
// xterm.js-compatible serialization on demand, so a (re)attaching
// frontend can replay the snapshot via `term.write(snapshot)` and pick
// up exactly where the previous render left off.
//
// Architecture follows kanna's `HeadlessTerminal` (apache-2.0,
// https://github.com/jemdiggity/kanna/blob/main/crates/daemon/src/headless_terminal.rs).
// We only need the parser + snapshot bits — kanna's status-detection
// (Claude markers, idle-prompt heuristics) is left out; Termic's settled
// detection lives in the frontend and works off rendered text.
//
// Thread safety: callers wrap `HeadlessTerminal` in `Mutex` and access
// from both the reader thread (write) and the IPC command (snapshot).
// libghostty-vt's underlying `Terminal` is !Sync !Send by default
// (zig-backed handles), so we mark our wrapper Send via unsafe — same
// trick kanna uses. The Mutex around it provides the actual
// serialization; we just need rustc to accept the type-level promise.

use libghostty_vt::{terminal::Mode, Terminal, TerminalOptions};
use ghostty_xterm_compat_serialize::serialize_terminal;

/// Cell-size budget hint from libghostty's C API. Their `max_scrollback`
/// is a *byte* budget, not a row count. 20 bytes/cell is the figure
/// kanna landed on after measurement and matches what we want.
const GHOSTTY_BYTES_PER_CELL: usize = 20;

/// Convert a logical-row scrollback target to libghostty's byte budget.
/// We cap at 50K rows to keep the byte budget from overflowing on
/// pathological inputs.
fn scrollback_byte_limit(cols: u16, rows: u16, scrollback_rows: usize) -> usize {
    let cols = cols.max(1) as usize;
    let rows = rows.max(1) as usize;
    let grid_rows = rows.saturating_add(scrollback_rows.min(50_000));
    grid_rows.saturating_mul(cols).saturating_mul(GHOSTTY_BYTES_PER_CELL)
}

pub struct HeadlessTerminal {
    // 'static lifetimes match kanna's wrapping - libghostty's Terminal
    // type is parameterized by allocator + callback lifetimes that, for
    // a long-lived headless instance, are trivially 'static.
    terminal: Box<Terminal<'static, 'static>>,
    rows: u16,
    cols: u16,
}

// SAFETY: callers MUST wrap this in a Mutex (or other exclusive-access
// primitive) before sharing across threads. The Terminal handle itself
// is a Zig pointer; libghostty's API contract is "one thread of access
// at a time," which `Mutex<HeadlessTerminal>` satisfies.
unsafe impl Send for HeadlessTerminal {}

impl HeadlessTerminal {
    pub fn new(cols: u16, rows: u16, scrollback_rows: usize) -> Result<Self, String> {
        let cols = if cols == 0 { 80 } else { cols };
        let rows = if rows == 0 { 24 } else { rows };
        let terminal = Box::new(
            Terminal::new(TerminalOptions {
                cols,
                rows,
                max_scrollback: scrollback_byte_limit(cols, rows, scrollback_rows),
            })
            .map_err(|e| format!("Terminal::new: {e}"))?,
        );
        Ok(Self { terminal, rows, cols })
    }

    /// Feed PTY output through the VT parser. Non-blocking; the parser
    /// state is updated in-place.
    pub fn write(&mut self, bytes: &[u8]) {
        self.terminal.vt_write(bytes);
    }

    /// Resize the grid to match a frontend resize. Reflow numbers
    /// (1, 1) are the libghostty defaults — see kanna for the
    /// rationale.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        self.terminal
            .resize(cols, rows, 1, 1)
            .map_err(|e| format!("resize: {e}"))?;
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    /// Produce an xterm.js-compatible VT escape-sequence string that,
    /// when written to a fresh xterm.js Terminal, recreates this
    /// instance's screen state. Includes a cursor-restore tail so the
    /// next byte the frontend writes lands at the right column.
    ///
    /// We temporarily disable SYNC_OUTPUT (DEC mode 2026) around the
    /// serialization. If the parser is in a sync-output sequence the
    /// renderer's pending buffer would be partial and the snapshot
    /// would miss recent updates. Mode is restored afterward so we
    /// don't perturb the live state.
    pub fn snapshot(&mut self) -> Result<String, String> {
        let was_sync = self
            .terminal
            .mode(Mode::SYNC_OUTPUT)
            .map_err(|e| format!("snapshot/mode-read: {e}"))?;
        if was_sync {
            self.terminal
                .set_mode(Mode::SYNC_OUTPUT, false)
                .map_err(|e| format!("snapshot/sync-disable: {e}"))?;
        }
        let serialized = serialize_terminal(&self.terminal, None)
            .map_err(|e| format!("serialize: {e}"))?
            .serialized_candidate;
        if was_sync {
            self.terminal
                .set_mode(Mode::SYNC_OUTPUT, true)
                .map_err(|e| format!("snapshot/sync-restore: {e}"))?;
        }
        let cursor_row = self
            .terminal
            .cursor_y()
            .map_err(|e| format!("cursor_y: {e}"))?;
        let cursor_col = self
            .terminal
            .cursor_x()
            .map_err(|e| format!("cursor_x: {e}"))?;
        let cursor_visible = self
            .terminal
            .is_cursor_visible()
            .map_err(|e| format!("cursor_visible: {e}"))?;
        // Tail the serialization with explicit cursor visibility +
        // position so xterm picks up exactly where libghostty left off
        // (the serializer emits enough state to recreate the grid but
        // its cursor positioning is approximate across renderers).
        let mut out = serialized;
        out.push_str(if cursor_visible { "\x1b[?25h" } else { "\x1b[?25l" });
        out.push_str(&format!(
            "\x1b[{};{}H",
            u32::from(cursor_row) + 1,
            u32::from(cursor_col) + 1,
        ));
        Ok(out)
    }
}
