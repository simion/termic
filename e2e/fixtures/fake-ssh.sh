#!/bin/sh
# The e2e suite's stand-in for ssh (debug builds run it as TERMIC_SSH_BIN,
# set by wdio.conf.ts). One reserved host, termic-e2e-local, runs the
# command on this machine under a scratch HOME, so a real termic-server
# serves remote.e2e.ts's server cases with no box. Every other host goes
# to the real ssh unchanged, so the real-box cases still reach their box.
#
# The app always calls `ssh [options] -- <dest> [command]` (remote_client.rs
# ssh_command): the destination is the argument after `--`.
dest=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--" ]; then dest="$a"; break; fi
  prev="$a"
done
if [ "$dest" != "termic-e2e-local" ]; then
  exec ssh "$@"
fi
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift 2
mkdir -p "$TERMIC_E2E_LOCAL_BOX"
exec env HOME="$TERMIC_E2E_LOCAL_BOX" PATH="$TERMIC_E2E_SERVER_DIR:$PATH" SHELL=/bin/sh /bin/sh -c "$*"
