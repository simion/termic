#!/bin/bash
# Fixture "agent CLI" for e2e runs (see .claude/skills/e2e + docs/e2e-tests.md).
# Registered in the scratch profile so tasks spawn / resume / queue against a
# real PTY with ZERO tokens.
#
# Built to behave like `claude` so termic's agent-state UI (working indicator,
# attention badge, notifications) is exercised realistically:
#   - long-lived interactive PTY: stays alive until signalled, like a TUI.
#   - drives the OSC terminal title with claude's status glyphs — `✳` when
#     idle (work done), a Braille spinner while working. termic classifies
#     these exactly as it classifies real claude (see BUILTIN_TITLE_SIGNALS
#     `claude` in src/lib/agents.ts). The `fakeagent` registry entry must carry
#     the same `capabilities.signals` for the classifier to fire (the e2e
#     profile seeds them — keep the two in lock-step).
#   - one busy -> idle cycle per submitted line, mirroring "type a prompt, it
#     works, it goes idle".
#   - echoes its argv so a test can assert resume flags (--session-id/--resume,
#     --name) reached the spawn.

set -u

# OSC 0 window/icon title, ST-terminated (ESC \). Deliberately NOT BEL-
# terminated: a stray BEL would trip termic's bell -> attention heuristic.
set_title() { printf '\033]0;%s\033\\' "$1"; }

# Braille spinner frames — the "leading glyph that isn't ✳" claude uses while
# working, which termic's busy signal `^\s*[^A-Za-z0-9\s✳]` matches.
SPINNER=("⣷" "⣯" "⣟" "⡿" "⢿" "⣻" "⣽" "⣾")

# claude shows the task in its title; pull it from --name if the spawn passed one.
name="fakeagent"
prev=""
for a in "$@"; do
  [ "$prev" = "--name" ] && name="$a"
  prev="$a"
done

# On exit, drop back to the idle glyph and say goodbye (like a clean quit).
trap 'set_title "✳ ${name}"; printf "\nFAKE-AGENT exiting\n"; exit 0' INT TERM

# Cold start: banner + idle title (awaiting input == work done).
echo "FAKE-AGENT ready (args: $*)"
echo "  claude-like fixture: ✳ = idle, spinner = working. Type a prompt."
set_title "✳ ${name}"

# One "prompt" per stdin line: go busy (spinner title + streamed output), then
# return to the idle glyph — the busy -> idle transition claude drives, which
# termic turns into working -> done.
while IFS= read -r line; do
  for f in 0 1 2; do
    set_title "${SPINNER[$f]} ${name}"   # working: spinner glyph title
    sleep 0.15
  done
  echo "FAKE-AGENT echo: ${line}"        # streamed "response"
  set_title "✳ ${name}"                  # done: idle glyph
done
