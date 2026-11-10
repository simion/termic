#!/bin/bash
# Fixture agent for the README screenshots (e2e/specs/readme-shots.e2e.ts).
#
# Like scripts/fake-agent.sh it is a real PTY that drives claude's OSC title
# glyphs (`✳` idle, a Braille spinner working), so Termic's work-state UI
# reads it the way it reads claude. Unlike fake-agent.sh it prints nothing
# about itself: what a screenshot shows of its terminal is a short scripted
# session from e2e/fixtures/readme-transcripts/<task name>.txt, or nothing.
# Every word in those files is synthetic.
#
# Input, one line per prompt. A task with a transcript is a screenshot, so
# its echo is off and nothing typed shows. Any other keeps its echo, which
# Termic waits for before it presses Enter on a message (a scheduled run).
#   #work       spin until the next line arrives, so the tab stays "working"
#   #idle       stop spinning
#   a scheduled run's prompt: write a short report where Termic asked for it

set -u
here="$(cd "$(dirname "$0")" && pwd)"
transcript="${here}/readme-transcripts/${TERMIC_TASK:-none}.txt"
# Echo off before anything else, so a line typed early cannot show either.
if [ -t 0 ]; then
  stty iutf8
  [ -f "$transcript" ] && stty -echo
fi

set_title() { printf '\033]0;%s\033\\' "$1"; }
SPINNER=("⣷" "⣯" "⣟" "⡿" "⢿" "⣻" "⣽" "⣾")

name="${TERMIC_TASK:-agent}"
prev=""
for a in "$@"; do
  [ "$prev" = "--name" ] && name="$a"
  prev="$a"
done

spin_pid=""
stop_spin() {
  if [ -n "$spin_pid" ]; then
    kill "$spin_pid" 2>/dev/null
    wait "$spin_pid" 2>/dev/null
    spin_pid=""
  fi
}
trap 'stop_spin; set_title "✳ ${name}"; exit 0' INT TERM

[ -f "$transcript" ] && printf '%b\n' "$(cat "$transcript")"
set_title "✳ ${name}"
# Plan usage and context for the footer chip, in the shape claude's Termic
# status line reports them (src/lib/agentUsage.ts).
printf '\033]777;notify;termic;usage 34 12 - - 0\007'
printf '\033]777;notify;termic;ctx 61400 200000\007'

log() {
  [ -n "${TERMIC_DATA_DIR:-}" ] && printf '%s\t%s\n' "${TERMIC_TASK_ID:-}" "$1" \
    >> "${TERMIC_DATA_DIR}/readme-agent.log" 2>/dev/null
  return 0
}

while IFS= read -r line; do
  # Bracketed paste: one prompt, read through to the closing marker.
  if [[ "$line" == *$'\e[200~'* && "$line" != *$'\e[201~'* ]]; then
    while IFS= read -r more; do
      line+=$'\n'"$more"
      [[ "$more" == *$'\e[201~'* ]] && break
    done
  fi
  line="${line//$'\e[200~'/}"
  line="${line//$'\e[201~'/}"
  line="${line#"${line%%[!$'\x1b\x03']*}"}"
  line="${line#\[200~}"
  log "$line"
  case "$line" in
    *"[Termic scheduled run:"*)
      stop_spin
      rest="${line#*write a report of this run to \`}"
      report="${rest%%\`*}"
      for f in 0 1 2 3 4 5; do set_title "${SPINNER[$f]} ${name}"; sleep 0.15; done
      mkdir -p "$(dirname "$report")"
      printf '# Morning triage\n\n- 3 new issues, 1 labelled bug\n- 2 pull requests waiting for review\n- main is green\n' > "$report"
      set_title "✳ ${name}"
      ;;
    "#work"*)
      stop_spin
      ( i=0; while :; do set_title "${SPINNER[$((i % 8))]} ${name}"; i=$((i + 1)); sleep 0.12; done ) &
      spin_pid=$!
      ;;
    *)
      stop_spin
      set_title "✳ ${name}"
      ;;
  esac
done
stop_spin
