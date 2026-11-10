// Secrets, task side: New Task / sandbox / edit / schedule role picker, the
// cage popover's secrets parts, the sidebar and title bar key.
export default {
  // role picker
  roleLabel: "This task runs as",
  experimental: "Experimental",
  roleHint: "Which secrets this task's agents may use. Saved on the task, switchable later from the task footer.",
  noSecrets: "No secrets",
  noSecretsDesc: "No placeholders, nothing brokered.",
  seededFromProject: "Picked for you from this project's default. Saved on the task when you create it; changing a default later doesn't move this task.",
  seededFromAgent: "Picked for you from {{agent}}'s default. Saved on the task when you create it; changing a default later doesn't move this task.",
  disabledNoSeatbelt: "A role needs Enforcing or Enforcing (FS), which this computer cannot run.",
  roleSwitchesCage: "Picking a role switches this task to Enforcing (FS) and blocks the Keychain: an agent that can reach your Keychain could read the real item itself.",
  disabledDocker: "Not available in Docker yet. Pick Enforcing or Enforcing (FS) above to give this task a role.",

  // right column
  secretsForTask: "Secrets for this task",
  brokered: "Brokered.",
  brokeredBody: "The agent only ever sees placeholders.",
  viaGh: "via gh socket and git proxy",
  reaches: "Reaches {{hosts}}.",
  roleHasNoSecrets: "This role holds no secrets yet.",
  notAvailable: "Not available to this task",
  envTitle: "What the agent's environment will contain",
  envPlaceholder: "placeholder, fresh per agent session",
  envSocket: "routes gh to its socket",
  ruleAllow: "allow",
  ruleDeny: "deny",
  ruleElseAllow: "anything else allowed",
  ruleElseDeny: "anything else denied",

  // key (sidebar, title bar)
  keyTip: "Secrets role: {{role}}",
  keySuspiciousTip: "Secrets role: {{role}}. Something in this task tried to misuse a secret.",
  keyUnappliedTip: "Secrets role {{role}} is set but does not apply: this task does not block its Keychain, or runs in Docker.",

  // the cage popover's Secrets row, status lines and role-rule rows
  pause: "Pause secrets",
  resume: "Resume secrets",
  pauseTip: "Refuse every brokered request from this task until you resume. Applies now, no restart.",
  pausedBanner: "Paused. Every brokered request from this task is refused until you resume.",
  pendingBanner: "{{saved}} applies when the agent restarts. The running agent still uses {{running}}.",
  staleBanner: "{{role}} changed since the agent started. Its secrets apply when the agent restarts.",
  suspPlaceholder: "Placeholder sent to an unknown host",
  suspKeychain: "Keychain access denied by the cage",
  suspPeer: "Socket used from outside this task's agent",
  suspOther: "Refused request",
  suspForeignToken: "gh sent its own token, not this spawn's placeholder",
  noSecretNote: "Upstream answered 401 and the role has no secret for this host.",
  grant: "Grant…",
  grantTip: "Add a secret for this host to the role in Settings. Delivering it needs an agent restart.",

  // role set but not applied: the one-click cage
};
