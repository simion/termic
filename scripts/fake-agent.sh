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
#     --name) reached the spawn, and records it to e2e-agent-argv.log, which
#     is the only place a spec can read it (terminal output is a canvas).
#   - with TERMIC_FAKE_SESSION_ID set, reports that id over termic's hook OSC
#     on the FIRST prompt: codex's shape, where the session is created lazily.

set -u

# Unlike a real agent's raw-mode editor, this fixture reads canonical lines.
# Make DEL erase a whole UTF-8 character so IME edits survive that read.
if [ -t 0 ]; then stty iutf8; fi

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

# Record the LOGIN environment this spawn actually received (GH #278).
#
# Terminal output is a WebGL canvas, never the DOM, so a spec cannot read what
# the agent printed. Writing it to a file in the isolated e2e profile is the
# same trick `e2e_record_open` uses, and it is the only way to prove the whole
# chain end to end: account chosen -> login_env computed -> pty_spawn applied
# -> the PROCESS actually got it. Asserting the store instead would only prove
# termic's own bookkeeping.
#
# Guarded on TERMIC_DATA_DIR, which only the e2e/automation seam sets, so a
# real run writes nothing.
if [ -n "${TERMIC_DATA_DIR:-}" ]; then
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "${TERMIC_TASK_ID:-}" \
    "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-}" \
    "CODEX_HOME=${CODEX_HOME:-}" \
    "GEMINI_CLI_HOME=${GEMINI_CLI_HOME:-}" \
    "XDG_DATA_HOME=${XDG_DATA_HOME:-}" \
    >> "${TERMIC_DATA_DIR}/e2e-agent-login.log" 2>/dev/null || true
  # And the ARGV, for the same reason and with the same trick. The resume
  # block is composed frontend-side and only ever exists as a spawned
  # process's arguments: the store can agree with itself about a session id
  # while the flag that would have used it never reaches the command line.
  # One line per spawn, task id first, so a spec can ask what the SECOND
  # spawn in a task was told.
  printf '%s\t%s\n' "${TERMIC_TASK_ID:-}" "$*" \
    >> "${TERMIC_DATA_DIR}/e2e-agent-argv.log" 2>/dev/null || true
fi

# Cold start: banner + idle title (awaiting input == work done).
echo "FAKE-AGENT ready (args: $*)"
echo "  claude-like fixture: ✳ = idle, spinner = working. Type a prompt."
set_title "✳ ${name}"

# Signal drills for the work-done specs. Real claude reaches states that a
# plain echo loop never does, so a line starting with `#` is a directive rather
# than a prompt:
#
#   #pending N  reproduce the backgrounded-subagent trap: print claude's
#               "Waiting for N background agents to finish" status line and go
#               to the IDLE glyph while the work is still outstanding. Every
#               byte-stream signal then says "finished" and only that line says
#               otherwise, which is the whole point.
#   #settle     clear the pending line (the work landed) and go idle for real.
#   #stage      a multi-stage turn whose FIRST stage looks finished: idle glyph,
#               quiet PTY, still screen, so termic calls the turn done. Then the
#               agent goes back to work long after that done and finishes for
#               real. Both halves have to survive: the spinner has to come back
#               (a done we got wrong must not outlive the evidence), and the
#               real completion still has to fire (the turn's done token was
#               spent on the wrong one). The sleep is long enough to clear
#               STICKY_DONE_MS counted from when the done actually fires, not
#               from when the stage ends.
#   #hookstage  the same two-stage turn as #stage, but reported over the HOOK
#               transport (OSC 133;C/;D) rather than the title. A 133;D
#               reaches fireDone with `fromHook`, which bypasses the
#               one-done-per-submit token, so this is the path #stage cannot
#               cover. Real claude with shell integration emits this shape all
#               day (GH #276).
#   #osc9 TEXT  emit an OSC 9 notification with a verbatim body, the way claude
#               asks for the user. BEL-terminated, as claude sends it.
#   #usage BODY replay what claude's termic STATUS LINE writes: an OSC 777
#               carrying subscription usage (GH #277). BODY is everything after
#               the trusted `termic;` sender, e.g. `usage 58 41 - -`. Real
#               claude sends this on every turn from the script
#               agent_hooks::statusline_body generates; the wire format is
#               pinned in lib/agentUsage.ts. It must NEVER badge the tab, which
#               is the half a spec has to prove.
#   #delegated BODY
#               a hook turn whose done found work OUTSTANDING: 133;C, then the
#               DELEGATED report instead of a 133;D, which is what claude's
#               generated done script writes when its `Stop` payload still
#               holds a subagent or a backgrounded shell. BODY is everything
#               after the `agent delegated: ` prefix, e.g. `1 shell b1`. The
#               grammar is pinned in lib/delegatedWork.ts and produced by
#               agent_hooks.rs; send the same BODY twice to replay the case
#               where the same work is still outstanding a turn later.
#   #hookdone   a plain hook turn that ENDS: 133;C then 133;D, nothing
#               outstanding. What claude writes when its `Stop` payload has an
#               empty `background_tasks`, and the only one of these that rings.
#   #sh CMD     run CMD with bash inside the agent's cage and env, as a
#               tool call would (the broker spec's gh-socket request).
#   #bel        emit a REAL bell, distinct from the BEL that terminates an OSC.
#   #iip        emit an inline PNG, then Pi's alternate-screen redraw.
#   #hookattn   reproduce a claude PERMISSION PROMPT with termic's agent hook
#               installed. Real claude paints its IDLE glyph while it is
#               blocked on you (measured), which arms termic's 5s settle and
#               fires a false "done"; the hook's OSC 777 lands ~20ms later and
#               cancels it. This directive replays that exact order, so the
#               spec proves the attention wins the race rather than trusting
#               that it does. Body must match agentHooks.ts HOOK_OSC_BODY.
osc9()   { printf '\033]9;%s\007' "$1"; }
osc777() { printf '\033]777;notify;%s\007' "$1"; }
# The hook transport: what termic's installed scripts write. `C` = a turn
# started, `D` = it is over, sent as termic's own trusted bodies (they used to
# be raw OSC 133, which agents also emit themselves; see agentHooks.ts).
osc133() {
  case "$1" in
    C) osc777 "termic;agent working" ;;
    D) osc777 "termic;agent done" ;;
    *) printf '\033]133;%s\007' "$1" ;;
  esac
}
spin()   { for f in 0 1 2; do set_title "${SPINNER[$f]} ${name}"; sleep 0.15; done; }

# One "prompt" per stdin line: go busy (spinner title + streamed output), then
# return to the idle glyph — the busy -> idle transition claude drives, which
# termic turns into working -> done.
# Resume shapes for GH #311, claude's, measured on 2.1.278:
#   --resume <id>, with <id> listed in $TERMIC_DATA_DIR/e2e-dead-sessions:
#     claude's "No conversation found" line and exit 1, which is what a stored
#     id that no longer resolves does.
#   --resume with no id: claude's session picker. A line `pick <uuid>` picks
#     that session, reported over the hook OSC as claude's SessionStart
#     (`source: resume`) is, and the fixture carries on as a normal agent. Any
#     other line exits 1, which is what leaving claude's picker with Esc does.
prev_arg=""; resume_arg=""; picker=""
for a in "$@"; do
  if [ "$prev_arg" = "--resume" ]; then
    case "$a" in -*) picker=1 ;; *) resume_arg="$a" ;; esac
  fi
  prev_arg="$a"
done
[ "$prev_arg" = "--resume" ] && picker=1
if [ -n "$resume_arg" ] && [ -n "${TERMIC_DATA_DIR:-}" ] \
   && grep -qx "$resume_arg" "${TERMIC_DATA_DIR}/e2e-dead-sessions" 2>/dev/null; then
  echo "No conversation found with session ID: $resume_arg"
  exit 1
fi
if [ -n "$picker" ]; then
  echo "FAKE-AGENT picker: Resume session"
  # Esc alone leaves, with no Enter, exactly as claude's picker does; anything
  # else is the start of a line.
  # A terminal also writes ESC-led REPLIES to its own queries (xterm answers
  # device-attribute and focus queries this way), so an ESC followed at once
  # by more bytes is one of those and is skipped; a lone ESC is the key.
  esc="$(printf '\033')"
  picker_log() {
    [ -n "${TERMIC_DATA_DIR:-}" ] && printf '%s\t%s\n' "${TERMIC_TASK_ID:-}" "$1" \
      >> "${TERMIC_DATA_DIR}/e2e-picker.log" 2>/dev/null
    return 0
  }
  # Listening from here on. A spec waits for this line before typing: a
  # key sent while Git Bash is still starting can be dropped when read
  # puts the console into raw mode.
  picker_log "<ready>"
  while :; do
    IFS= read -r -n1 first || { picker_log "<eof>"; exit 1; }
    [ "$first" != "$esc" ] && break
    if IFS= read -r -n1 -t 0.15 _next; then
      # Skip exactly ONE reply, not everything that follows it: a focus-in
      # report (ESC [ I, which ConPTY turns on for every console) lands right
      # before the keys typed after focusing the terminal, and draining by
      # timing swallowed the whole typed line with it. CSI runs to a final
      # byte in @..~; OSC to BEL or ESC \; anything else is ESC plus one.
      _seq="$_next"
      case "$_next" in
        "[") while IFS= read -r -n1 -t 0.15 _more; do
               _seq="$_seq$_more"
               case "$_more" in [@-~]) break ;; esac
             done ;;
        "]") while IFS= read -r -n1 -t 0.15 _more; do
               case "$_more" in $'\a'|"$esc") break ;; esac
             done
             [ "${_more:-}" = "$esc" ] && IFS= read -r -n1 -t 0.15 _more ;;
      esac
      picker_log "<skipped ESC$(printf '%q' "$_seq")>"
      continue
    fi
    picker_log "<esc>"
    exit 1
  done
  picker_log "<first $(printf '%q' "$first")>"
  IFS= read -r rest || true
  choice="${first}${rest}"
  # What the picker read, escaped, for a spec that fails on one platform
  # only: the line is the whole story and the terminal is a canvas.
  picker_log "$(printf '%q' "$choice")"
  case "$choice" in
    "pick "*)
      osc777 "termic;agent ready for input"
      osc777 "termic;session ${choice#pick }"
      echo "FAKE-AGENT resumed ${choice#pick }" ;;
    *) exit 1 ;;
  esac
fi

while IFS= read -r line; do
  # Record every submitted line, in order, one per line. Terminal output is a
  # canvas, so this file is the only way a spec can assert WHAT the agent
  # received and in what ORDER: "send all now" writes several messages back to
  # back, and a message landing inside another one's input box is exactly the
  # failure that would otherwise pass unnoticed. Same best-effort append as the
  # argv log, and the leading debris is stripped below rather than here so the
  # file shows what was really read.
  printf '%s\n' "$line" \
    >> "${TERMIC_DATA_DIR}/e2e-agent-prompts.log" 2>/dev/null || true
  # Strip leading interrupt bytes. A directive that reads a keystroke mid-turn
  # can be handed MORE than the one byte it consumes (xterm does not promise
  # one onData call per key), and the remainder then arrives glued to the front
  # of the next prompt: `#longwork` swallowed one Escape and left the tail to
  # turn the following `#longwork-silent` into an unrecognised line, which
  # dispatched to the default branch and silently tested nothing. Every
  # directive begins with `#`, so anything before it is debris.
  # A bracketed paste is ONE prompt, as it is to every real agent TUI: read on
  # to the closing marker, so a multi-line message is one turn rather than one
  # turn per line. Each physical line is still logged above and here.
  # Before the debris strip below, which would eat the marker's ESC.
  if [[ "$line" == *$'\e[200~'* && "$line" != *$'\e[201~'* ]]; then
    while IFS= read -r more; do
      printf '%s\n' "$more" \
        >> "${TERMIC_DATA_DIR}/e2e-agent-prompts.log" 2>/dev/null || true
      line+=$'\n'"$more"
      [[ "$more" == *$'\e[201~'* ]] && break
    done
  fi
  line="${line#"${line%%[!$'\x1b\x03']*}"}"
  # A scheduled run's prompt (GH #300): the first line is the directive, and
  # Termic's appended instruction names the report file to write, relative to
  # the run's directory (the project's live checkout).
  if [[ "$line" == *"[Termic scheduled run:"* ]]; then
    body="${line//$'\e[200~'/}"
    body="${body//$'\e[201~'/}"
    body="${body#\[200~}"
    first="${body%%$'\n'*}"
    rest="${body#*write a report of this run to \`}"
    report="${rest%%\`*}"
    case "$first" in
      "#report")
        spin
        mkdir -p "$(dirname "$report")"
        printf '# Fake scheduled report\n\nEverything is green.\n' > "$report"
        echo "FAKE-AGENT wrote ${report}"
        set_title "✳ ${name}"
        continue ;;
      "#attn")
        spin
        echo "FAKE-AGENT needs your permission to continue"
        set_title "✳ ${name}"
        osc777 "termic;agent needs your input"
        continue ;;
      *)
        # `#noreport` and anything else: a turn that writes nothing.
        spin
        echo "FAKE-AGENT finished without a report"
        set_title "✳ ${name}"
        continue ;;
    esac
  fi
  case "$line" in
    "#sh "*)
      # run a shell line as the agent would (inside its cage, with its env):
      # the broker spec sends a request through gh's socket this way, so the
      # peer check, the spawn dir's profile rules and the placeholder are the
      # real ones. Its output goes to the canvas like any tool call's.
      bash -c "${line#\#sh }"
      set_title "✳ ${name}"
      continue ;;
    "#pending "*)
      spin
      # Order matters: the status line must be the LAST thing painted, so it
      # sits at the bottom of the screen where the pending check looks.
      echo "FAKE-AGENT backgrounded ${line#\#pending } agent(s)"
      echo "✻ Waiting for ${line#\#pending } background agents to finish"
      set_title "✳ ${name}"              # idle glyph WHILE work is outstanding
      continue ;;
    "#blink")
      # codex's approval prompt: the title blinks "[ ! ]"/"[ . ]" once a second
      # until answered (captured on codex 0.164.0). 12 blinks outlast the 10s
      # ATTENTION_ECHO_MS, which is where each blink used to ring again.
      for i in $(seq 1 12); do
        if (( i % 2 )); then set_title "[ ! ] needs your permission"; else set_title "[ . ] needs your permission"; fi
        sleep 1
      done
      set_title "✳ ${name}"
      continue ;;
    "#settle")
      # Enough lines to push the pending status line out of the bottom-of-screen
      # window the check looks at. That IS the real behaviour: claude's words
      # stay in the scrollback, they just stop being the live status.
      echo "FAKE-AGENT all background work landed"
      for i in 1 2 3 4 5 6 7 8 9 10; do echo "FAKE-AGENT result line ${i}"; done
      set_title "✳ ${name}"
      continue ;;
    "#stage")
      # ~1.5s of visible work before the misleading idle glyph — just enough for
      # termic to latch "working" (observed: ~0.7s from submit to badge).
      # This used to be ~6s: the done that follows only badges on a tab nobody
      # is watching, and the spec backgrounded the task by CREATING the second
      # one here (~1.5s), which raced the spinner. The spec now creates that
      # task up front and backgrounds with a store call, so the padding is gone.
      for i in $(seq 1 5); do set_title "${SPINNER[$((i % 8))]} ${name}"; sleep 0.3; done
      echo "FAKE-AGENT stage 1 landed"
      set_title "✳ ${name}"              # looks finished, isn't
      sleep 16
      spin                               # stage 2: back to work
      echo "FAKE-AGENT stage 2 landed"
      sleep 2
      set_title "✳ ${name}"              # finished for real this time
      continue ;;
    "#hookstage")
      # The SAME two-stage turn as #stage, but reported over the HOOK
      # transport (OSC 133;C/;D) instead of the title. It exists because the
      # two paths reach `fireDone` with opposite guards and only one of them
      # was ever covered: a 133;D calls it with `fromHook`, which bypasses the
      # one-done-per-submit token outright, so nothing at all stood between a
      # multi-command turn and one notification per command. Real claude with
      # shell integration emits exactly this shape - a captured
      # `termic-workstate.log` shows `CDCDCDCDCD` on ordinary tasks (GH #276).
      #
      # No title is painted here, deliberately. Mixing the two would let the
      # title path account for a transition the hook path was supposed to
      # prove, which is how the hook half stayed untested in the first place.
      osc133 "C"
      echo "FAKE-AGENT hook stage 1 working"
      sleep 1
      osc133 "D"                         # turn "ends" - badge #1
      echo "FAKE-AGENT hook stage 1 landed"
      sleep 16                           # clear STICKY_DONE_MS from the done
      osc133 "C"                         # back to work, which clears the badge
      echo "FAKE-AGENT hook stage 2 working"
      sleep 1
      osc133 "D"                         # ends for real - badge #2 today
      echo "FAKE-AGENT hook stage 2 landed"
      continue ;;
    "#osc9 "*)
      osc9 "${line#\#osc9 }"
      continue ;;
    "#usage "*)
      # Sender field is `termic`, exactly as the generated status line writes
      # it: the body is only trusted when it is.
      osc777 "termic;${line#\#usage }"
      continue ;;
    "#bel")
      printf '\007'
      continue ;;
    "#iip")
      # Match Pi's IIP redraw: clear the screen, reserve image rows, emit the
      # image from the last reserved row, then repeat after a layout shift.
      rows=$(stty size <&0 2>/dev/null | cut -d' ' -f1)
      rows=${rows:-24}
      printf '\033[?1049h'
      for top in 1 2; do
        printf '\033[?2026h\033[2J'
        image_row=$((top + 20))
        for ((row = 1; row <= rows; row++)); do
          printf '\033[%s;1H\033[2K' "$row"
          if ((row == image_row)); then
            printf '\033[20A'
            cat "$(dirname "$0")/../e2e/fixtures/iip/termic-icon.iip"
          elif ((row == image_row + 1)); then
            printf 'Pi redraw %s' "$top"
          fi
        done
        printf '\033[?2026l'
        sleep 0.1
      done
      set_title "✳ ${name} iip-after"
      continue ;;
    "#longwork")
      # A turn long enough for a spec to interrupt it. The first attempt at
      # this raced a ~1s turn and pressed the key after it had already ended,
      # which is the same mistake that invalidated the first live interrupt
      # probe: an interrupt test has to interrupt something.
      #
      # It also HONOURS the interrupt, because that is what a real agent does:
      # claude stops and repaints its idle glyph ~90ms after Escape. A fixture
      # that kept spinning would be testing an agent that ignored the user.
      # `read -t 1` doubles as the frame delay and the input check; integer
      # timeouts only, since macOS ships bash 3.2 where fractional ones fail.
      # Starts the turn the way a hooked agent does. Hooks own both edges now,
      # so a busy title alone cannot set working for an agent that reports its
      # own state.
      osc133 C
      for i in $(seq 1 60); do
        set_title "${SPINNER[$((i % 8))]} ${name}"
        if IFS= read -r -t 1 -N 1 _key; then
          echo "FAKE-AGENT interrupted"
          set_title "✳ ${name}"
          continue 2
        fi
      done
      set_title "✳ ${name}"
      continue ;;
    "#longwork-silent")
      # The agy shape: a long turn that HONOURS the interrupt but reports it
      # through neither a hook nor a title, so the terminal simply falls quiet.
      # Measured: agy fires nothing at all on Escape or Ctrl-C and has no title
      # state to read, which leaves the terminal going quiet as the only
      # evidence the user's key landed. It is the only agent in that position:
      # claude repaints its idle glyph, grok has StopCancelled, and opencode
      # reports session.idle on the second Escape.
      #
      # The busy title is painted ONCE and never cleared, including on the
      # interrupt. That is what isolates the path under test: termic's other
      # interrupt route needs the title to go idle, so if the badge clears here
      # it can only have been the terminal falling quiet. It also makes a
      # mis-dispatch loud, since the default branch below ends on the idle
      # glyph and the spec asserts the busy one is still there.
      set_title "${SPINNER[1]} ${name}"
      # The turn STARTS the way a hooked agent starts one. Since hooks own both
      # edges, a busy title no longer sets working for an agent that reports
      # its own state, so a fixture without this could never reach working and
      # would be testing an agent that does not exist.
      osc133 C
      for i in $(seq 1 60); do
        printf '.'
        if IFS= read -r -t 1 -N 1 _key; then
          echo "FAKE-AGENT interrupted"
          continue 2
        fi
      done
      continue ;;
    "#hookturn")
      # A hooked agent mid-turn whose TITLE then goes idle while the turn is
      # still outstanding: 133;C and no 133;D. Exactly claude's shape when it
      # backgrounds subagents, and the case the whole design turns on, so the
      # fixture has to produce it rather than the spec faking a state.
      osc133 C
      spin
      echo "FAKE-AGENT echo: ${line}"
      set_title "✳ ${name}"
      continue ;;
    "#hookdone")
      osc133 C
      spin
      echo "FAKE-AGENT done"
      set_title "✳ ${name}"
      osc133 D
      continue ;;
    "#delegated "*)
      # Order matters and is the measured one: the turn starts, the agent
      # works, and the report lands where a done would have. Nothing after it,
      # because that is the point - the real hook writes this INSTEAD of a
      # done and then says nothing at all, possibly forever.
      osc133 C
      spin
      echo "FAKE-AGENT delegated: ${line#\#delegated }"
      set_title "✳ ${name}"
      osc777 "termic;agent delegated: ${line#\#delegated }"
      continue ;;
    "#autoapproved")
      # codex with `approvals_reviewer = "auto_review"`, as measured on
      # 0.164.0: the turn starts, a permission request is reported, the
      # reviewer approves it on its own, the command runs, and the turn ends.
      # No working report between the needs-you and the done: the command's
      # PreToolUse fired BEFORE its permission request.
      osc133 C
      spin
      sleep 3                            # mid-turn: a message sent now queues
      osc777 "termic;needs your permission: Bash"
      sleep 2
      echo "FAKE-AGENT ran the auto-approved command"
      osc133 D
      continue ;;
    "#hookattn")
      spin
      echo "FAKE-AGENT needs your permission to continue"
      set_title "✳ ${name}"                       # the lie: idle while blocked
      osc777 "termic;agent needs your input"      # the hook, right behind it
      continue ;;
  esac
  # Codex's shape: the session does not exist until the first prompt, so the
  # id is reported on the FIRST submitted line and never at launch. Measured
  # on a live codex 0.154.0 — `SessionStart` fires during the first turn, and
  # not at all on a `codex resume <id>` spawn, which is why a spec that waits
  # for this at spawn time waits forever. Only fires when the fixture entry
  # sets the env var, so every other spec is untouched.
  if [ -n "${TERMIC_FAKE_SESSION_ID:-}" ] && [ -z "${session_reported:-}" ]; then
    session_reported=1
    osc777 "termic;agent ready for input"
    osc777 "termic;session ${TERMIC_FAKE_SESSION_ID}"
  fi
  spin
  echo "FAKE-AGENT echo: ${line}"        # streamed "response"
  set_title "✳ ${name}"                  # done: idle glyph
done
