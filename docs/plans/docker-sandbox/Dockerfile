# termic Docker sandbox — generic image for ALL agents.
# One image, every supported agent installed. The per-workspace agent is
# just the command run inside it.
#
# Edit the marked regions to customize. Rebuild from termic afterwards.
#
# Agents are intentionally UNPINNED (always latest). To upgrade them (and
# the LTS Node base), rebuild WITHOUT cache:  docker build --no-cache --pull
# termic exposes this as a one-click "Update agents" / rebuild-no-cache.

# ── Base: current Node LTS (always >=22, satisfies Copilot) + Debian ────
# node:lts auto-tracks the latest LTS; --pull on rebuild fetches it fresh.
FROM node:lts-bookworm

# ── System toolchain (git is essential; the rest are common agent deps) ─
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      ripgrep \
      less \
      openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Native-binary installers (grok, agy) drop into ~/.local/bin.
ENV PATH="/root/.local/bin:${PATH}"

# The workspace is bind-mounted from the host, so its files are owned by a
# different uid than the container user. Without this, git refuses every
# operation with "detected dubious ownership". Safe here: the only repos in
# this throwaway cage are the user's own mounted worktrees.
RUN git config --global --add safe.directory '*'

# ── Agents installed via npm (claude, codex, gemini, copilot) ───────────
# claude  : https://www.npmjs.com/package/@anthropic-ai/claude-code
# codex   : https://www.npmjs.com/package/@openai/codex
# gemini  : https://www.npmjs.com/package/@google/gemini-cli
# copilot : https://www.npmjs.com/package/@github/copilot
RUN npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      @google/gemini-cli \
      @github/copilot

# ── Agents installed via official curl one-liners (grok, agy) ───────────
# grok = xAI Grok Build (native binary -> ~/.grok/bin)
# docs: https://docs.x.ai/build/cli
RUN curl -fsSL https://x.ai/cli/install.sh | bash
# agy = Google Antigravity (native binary -> ~/.local/bin)
# docs: https://antigravity.google/docs/cli-install
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

# ── Add your MCP servers here (installed into the image) ────────────────
# RUN npm install -g @some/mcp-server

# ── Add CLI tools / system packages here ────────────────────────────────
# RUN apt-get update && apt-get install -y <pkg> && rm -rf /var/lib/apt/lists/*

# ── Add baked-in skills here ────────────────────────────────────────────
# COPY my-skills/ /root/.claude/skills/

WORKDIR /workspace
CMD ["bash"]
