#!/bin/bash
# Fixture "agent CLI" for automation / E2E runs (see automation.rs and
# .claude/skills/drive-termic). Registered in the agent registry of a
# scratch profile so workspaces can spawn, resume, and queue against a
# real PTY without burning tokens on a real agent. Echoes its argv (so a
# driver can assert resume flags like --session-id/--resume made it to
# the spawn) and then mirrors stdin.
echo "FAKE-AGENT ready (args: $*)"
trap 'echo "FAKE-AGENT exiting"; exit 0' INT TERM
while IFS= read -r line; do
  echo "FAKE-AGENT echo: $line"
done
