# Docker sandbox (research bundle)

Self-contained design + research for an opt-in Docker sandboxing mode: run
the agent CLI inside a container instead of macOS Seatbelt, so it can only
touch the paths we mount. Status: **proposed, not started.**

Contents:

- **[design.md](design.md)** - the full Phase 1 plan: scope, UX (dialog
  transparency + how-it-works explainer + command preview), architecture
  and integration points, auth/`login`-persistence, sessions/resume,
  customization persistence, cleanup, open questions, task breakdown.
- **[findings.md](findings.md)** - empirical evidence from real container
  experiments (agent installs/config dirs, config-dir relocation envs,
  worktree `.git` mount result, macOS ownership, env-token matrix).
- **[Dockerfile](Dockerfile)** - the validated generic image (all six agents
  build and run). Intended as the shipped reset-to-default.

Start with design.md; findings.md is the evidence it rests on.
