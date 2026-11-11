// Secrets, shell side: a terminal started with a role (docs/sandbox.md
// "Shells"): the tab menu, the tab badge, its rows in Activity and the rc-file
// banner.
export default {
  restartWith: "Restart with secrets",
  noSecrets: "No secrets",
  confirmTitle: "Restart this shell as {{role}}?",
  confirmTitleNone: "Restart this shell without secrets?",
  confirmBody: "A role is set when a shell starts, so switching ends this shell and opens a new one. Still running: {{procs}}.",
  confirm: "Restart shell",
  badgeTip: "This shell runs as {{role}}",
  badgeForeignTip: "This shell runs as {{role}}, but gh sent its own token",
  badgeSuspiciousTip: "This shell runs as {{role}}. Something suspicious happened",
  rcBanner: "gh sent its own token instead of this shell's placeholder, so this shell is using a token Termic doesn't manage. Something in your shell startup (often ~/.zshrc) sets GH_TOKEN after Termic does.",
  rcCopy: "Copy a fix",
  rcFixLabel: "the rc-file fix",
  rcDismiss: "Dismiss",
  pausedBanner: "Paused. Every brokered request from this shell is refused until you resume.",
  pauseTip: "Refuse every brokered request from this shell until you resume. Applies now, no restart.",
  tmuxPeer: "tmux runs its server in a session of its own, so Termic can't tell it came from this shell and refused it. Run gh outside tmux, or open a Termic tab per window instead.",
};
