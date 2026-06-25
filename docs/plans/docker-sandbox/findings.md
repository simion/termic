# Docker sandbox: empirical findings

Raw evidence behind [design.md](design.md), from real container experiments
on 2026-06-25 (Docker 29 on macOS; OrbStack is the intended prod runtime).
The validated image is [Dockerfile](Dockerfile).

## Supported agents: install + config (validated in-container)

Built one generic image. Base `node:lts-bookworm` (auto-tracks current Node
LTS; verified Node v24.18.0; always >=22, satisfying Copilot's floor).
Agents unpinned (always latest); upgrade via `docker build --no-cache
--pull`. All six install and report versions.

| Agent | Install | Binary lands | Config dir(s) | Config relocation env |
| --- | --- | --- | --- | --- |
| claude | `npm i -g @anthropic-ai/claude-code` | `/usr/local/bin` | `~/.claude/` **+ `~/.claude.json`** | **`CLAUDE_CONFIG_DIR`** (folds the dotfile in) |
| codex | `npm i -g @openai/codex` | `/usr/local/bin` | `~/.codex/` (sqlite state) | **`CODEX_HOME`** |
| gemini | `npm i -g @google/gemini-cli` | `/usr/local/bin` | `~/.gemini/` | none (dir has no binary, mount directly) |
| copilot | `npm i -g @github/copilot` | `/usr/local/bin` | `~/.copilot/` (+ `~/.cache/copilot` regenerable) | none (mount `~/.copilot` directly) |
| grok | `curl -fsSL https://x.ai/cli/install.sh \| bash` | **`~/.grok/bin`** | `~/.grok/` (config + skills + binary all here) | none clean (`GROK_WORKSPACE_BUNDLED_SKILLS_DIR` only) |
| agy | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | **`~/.local/bin`** | `~/.gemini/` (+ `~/.antigravity`) | n/a (mount config dirs, not `~/.local`) |

Versions seen: claude 2.1.191, codex 0.142.1, gemini 0.47.0, copilot 1.0.65,
grok 0.2.64, agy 1.0.12. Image size ~2.76GB (`node:22-slim` would trim).

## Config-dir relocation: verified

- `CLAUDE_CONFIG_DIR=/cfg` -> claude writes `/cfg/.claude.json`,
  `/cfg/projects/`, `/cfg/sessions/`, `/cfg/backups/`; **no stray
  `~/.claude.json`** in HOME. One clean dir.
- `CODEX_HOME=/ch` -> all codex sqlite state under `/ch`; **no stray
  `~/.codex`**. One clean dir.

These two env vars solve the HOME-root-dotfile problem and let claude/codex
be a single isolated dir mount.

## Critical trap: never mount the whole HOME

Mounting an empty dir over `/root` **shadows binaries baked into HOME at
build time**: grok (`/root/.grok/bin`) and agy (`/root/.local/bin`)
vanished, created nothing. => mount only the specific config dir, never the
home. grok is the outlier because its binary, bundled skills, and config all
live under `~/.grok`.

## Worktree `.git` mount: the core correctness result

Host repo + `git worktree add`; the worktree's `.git` is a pointer file with
an **absolute** gitdir into `<parent>/.git/worktrees/<name>`.

- Mount **worktree only** -> `fatal: not a git repository:
  <parent>/.git/worktrees/<name>`.
- Mount **worktree + parent `.git` at matching absolute paths** ->
  `status`, `log`, and `commit` all work; the container's commit appears on
  the host.
- Needed once: `git config --global --add safe.directory '*'` in the image
  (bind-mounted worktree is a different uid -> git's "dubious ownership"
  guard). Baked into the Dockerfile.

## macOS file ownership: non-issue

Container runs as root (uid 0), but files it writes appear host-side owned
by the host user (501/simion) via Docker Desktop / OrbStack file-sharing
remap. No `--user` / chown needed on macOS. (Native Linux would need uid
mapping; later-phase concern.)

## Sessions: keyed by cwd

claude stores transcripts at
`~/.claude/projects/<munged-absolute-cwd>/<uuid>.jsonl`. Because the
worktree is mounted at the same absolute path, the cwd key matches across
spawns, so a persisted config dir makes `--resume <uuid>` work. Reuse
termic's existing per-workspace UUID scheme; mint-vs-resume must be
cage-aware (docker store is separate from the OS store).

## Env-token auth: investigated, REJECTED

All agents support a headless env var, but only claude is a true long-lived
OAuth token; the rest are API keys (switches billing off the subscription),
and env auth does not solve resume anyway. Decision: not used. Matrix kept
for the record.

| Agent | Env var(s) | Kind |
| --- | --- | --- |
| claude | `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, 1yr) / `ANTHROPIC_API_KEY` | long-lived OAuth |
| codex | `OPENAI_API_KEY` / `codex login --with-api-key` | API key |
| gemini | `GEMINI_API_KEY` | API key |
| grok | `XAI_API_KEY` / `GROK_API_KEY` (also `login --device-auth`) | API key |
| copilot | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | PAT (Copilot Requests perm) |
| agy | `ANTIGRAVITY_TOKEN` / `ANTIGRAVITY_API_KEY` (`GEMINI_API_KEY` ignored) | in flux |

## Still open (spike before/while building)

- grok outlier: relocate binary to `/usr/local/bin` + seed bundled
  skills/config into the mounted dir, or mount only writable subdirs. May be
  deferred from Phase 1.
- Confirm an in-cage `/login` + an MCP OAuth login + `--session-id`/`--resume`
  all survive a container teardown via the mounted config dir, per agent.
