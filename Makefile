# Termic — top-level developer commands.
#
# Run `make` (no args) to see every target with a one-line description.
# Each target is a thin wrapper over npm / cargo / a helper script.
#
# Conventions used below:
#   * `## …` after a target name is its `make help` description.
#   * `.PHONY` everything — we have no real file targets here.
#   * `MAKEFLAGS += --no-print-directory` keeps the output legible.
#   * Each recipe runs in its own shell; multi-line uses backslash-newline.
#
# Windows: needs GNU make (`winget install ezwinports.make`) and Git for
# Windows, and runs from Git Bash, PowerShell or cmd alike. Recipes run under
# Git's bash, and the targets that differ by platform (setup, install, beta,
# reset, ...) pick their Windows branch from $(IS_WINDOWS). See docs/windows.md.
ifeq ($(OS),Windows_NT)
IS_WINDOWS := 1
# Git's bash by PATH, never a bare `bash`. Outside Git Bash that name is
# System32's WSL launcher, or nothing at all, and then make quietly runs the
# recipes in cmd.exe ("'#' is not recognized as an internal or external
# command"). The unix tools the recipes use (awk, sed, cygpath) are not on
# PATH there either. So ask git where it lives, which is
# <Git>/<mingw64|ucrt64|clangarm64>/libexec/git-core, and put <Git>/usr/bin
# first. `subst`, not the word functions: the path has a space in it.
GIT_ROOT := $(shell git --exec-path)
GIT_ROOT := $(subst /mingw64/libexec/git-core,,$(GIT_ROOT))
GIT_ROOT := $(subst /ucrt64/libexec/git-core,,$(GIT_ROOT))
GIT_ROOT := $(subst /clangarm64/libexec/git-core,,$(GIT_ROOT))
export PATH := $(subst /,\,$(GIT_ROOT))\usr\bin;$(PATH)
SHELL := $(GIT_ROOT)/usr/bin/bash.exe
else
SHELL := /bin/bash
ifeq ($(shell uname -s),Linux)
IS_LINUX := 1
# An AppImage's terminals (Termic's own included) inherit an LD_LIBRARY_PATH
# pointing at its bundled libraries, and on Ubuntu 25.10+ that breaks `env`,
# `ls` and every `#!/usr/bin/env` script a recipe runs. No target wants it.
unexport LD_LIBRARY_PATH
# rustup installs into ~/.cargo/bin and puts it on PATH through the shell
# profile, which the shell that just ran `make setup` has already read. So
# the very next `make dev` could not find cargo. Look there ourselves.
ifneq ($(wildcard $(HOME)/.cargo/bin/cargo),)
export PATH := $(HOME)/.cargo/bin:$(PATH)
endif
endif
endif
.SHELLFLAGS := -euo pipefail -c
MAKEFLAGS += --no-print-directory

.DEFAULT_GOAL := help

# ─── help ─────────────────────────────────────────────────────────────

# Parse `## …` annotations from this file and print them. Same UX as
# `just --list` without depending on just.
help: ## Show this help (default target).
	@awk 'BEGIN {FS = ":.*## "} \
	     /^[a-zA-Z_-]+:.*## / && !seen[$$1]++ {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' \
	     $(MAKEFILE_LIST) | sort
.PHONY: help

# ─── setup ────────────────────────────────────────────────────────────

ifdef IS_WINDOWS
setup: ## One-shot dev env bootstrap (build tools, rust, node, make via winget + npm install + cargo check).
	@# Also runnable without make: bash scripts/setup-windows.sh
	@bash scripts/setup-windows.sh
else ifdef IS_LINUX
setup: ## One-shot dev env bootstrap (system packages, rust, node + npm install + cargo check).
	@# Also runnable without make: bash scripts/setup-linux.sh
	@bash scripts/setup-linux.sh
else
setup: ## One-shot dev env bootstrap (rust/node + npm install + cargo check).
	@echo "→ Termic dev environment bootstrap"
	@if ! command -v brew >/dev/null 2>&1; then \
	    echo "✗ homebrew required. Install from https://brew.sh and re-run."; \
	    exit 1; \
	fi
	@echo "→ Checking Rust toolchain"
	@if command -v cargo >/dev/null 2>&1; then \
	    echo "  ✓ cargo present ($$(cargo --version))"; \
	elif command -v rustup >/dev/null 2>&1; then \
	    echo "  rustup present but no cargo, installing the stable toolchain"; \
	    rustup default stable; \
	else \
	    echo "  installing rustup + stable toolchain"; \
	    brew install rustup && rustup default stable; \
	fi
	@echo "→ Checking Node"
	@if ! command -v node >/dev/null 2>&1; then \
	    echo "  installing node"; brew install node; \
	else \
	    echo "  ✓ node present ($$(node --version))"; \
	fi
	@echo "→ Installing npm packages"
	@npm install
	@echo "→ Seeding the e2e fixture profile"
	@node scripts/e2e-seed.mjs || true
	@echo "→ Pre-fetching Rust crate index (cargo check)"
	@# Homebrew's rustup is keg-only, so cargo AND rustc live in its keg bin
	@# (not on PATH). Prepend it so cargo can find rustc; a normal (official
	@# rustup) install already has cargo on PATH and skips this.
	@if command -v cargo >/dev/null 2>&1; then \
	    (cd src-tauri && cargo check) >/dev/null; \
	else \
	    PATH="$$(brew --prefix rustup)/bin:$$PATH" sh -c 'cd src-tauri && cargo check' >/dev/null; \
	fi
	@echo ""
	@echo "✓ Setup complete. Try: make dev"
	@# Homebrew's rustup is keg-only: cargo lives in its keg bin, not on PATH.
	@# make targets fall back to `rustup run`, but `make dev` shells out to
	@# cargo directly, so point the user at the one line that fixes their shell.
	@if ! command -v cargo >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then \
	    echo ""; \
	    echo "  Note: cargo is not on your PATH (Homebrew rustup is keg-only)."; \
	    echo "  To run 'make dev', add rustup to your shell, then restart it:"; \
	    echo "    echo 'export PATH=\"\$$(brew --prefix rustup)/bin:\$$PATH\"' >> ~/.zshrc"; \
	fi
endif
.PHONY: setup

doctor: ## Verify the dev env without installing anything (CI-friendly, exits nonzero on first missing dep).
	@fail=0; \
	check() { \
	    local name="$$1"; local cmd="$$2"; local ver="$${3-}"; \
	    if command -v "$$cmd" >/dev/null 2>&1; then \
	        local v="$$($$cmd $$ver 2>&1 | head -1)"; \
	        echo "  ✓ $$name: $$v"; \
	    else \
	        echo "  ✗ $$name: missing"; fail=1; \
	    fi; \
	}; \
	if [ -n "$(IS_LINUX)" ]; then \
	    check cc cc --version; check pkg-config pkg-config --version; \
	    if pkg-config --exists webkit2gtk-4.1 2>/dev/null; then \
	        echo "  ✓ webkit2gtk-4.1: $$(pkg-config --modversion webkit2gtk-4.1)"; \
	    else echo "  ✗ webkit2gtk-4.1 dev package: missing"; fail=1; fi; \
	elif [ -z "$(IS_WINDOWS)" ]; then check brew brew --version; else \
	    check make make --version; check git git --version; \
	    vsw="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"; \
	    if [ -x "$$vsw" ] && [ -n "$$("$$vsw" -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>/dev/null)" ]; then \
	        echo "  ✓ C++ build tools: present"; \
	    else echo "  ✗ C++ build tools: missing"; fail=1; fi; \
	fi; \
	check rust cargo --version; \
	check node node --version; \
	if [ -d node_modules ]; then \
	    echo "  ✓ node_modules present"; \
	else \
	    echo "  ✗ node_modules missing (run: npm install)"; fail=1; \
	fi; \
	if [ $$fail -eq 0 ]; then \
	    echo ""; echo "✓ Dev env looks good."; \
	else \
	    echo ""; echo "✗ Run 'make setup' to fix."; exit 1; \
	fi
.PHONY: doctor

# ─── dev ──────────────────────────────────────────────────────────────

dev: ## Run termic in dev mode (Vite HMR + Rust auto-rebuild).
	@# A freshly pulled commit can add npm deps (tsc then fails with
	@# TS2307 "Cannot find module"). npm install is a ~1s no-op when
	@# node_modules is already in sync, so always run it first.
	@npm install --no-fund --no-audit
	@node scripts/prune-target.mjs
	@# Run dev.mjs directly (not via `npm run`): npm 11 swallows Ctrl+C and
	@# orphans the tauri/cargo/app subtree. Direct exec makes node the
	@# process-group leader so dev.mjs's signal handler can tear the group down.
	@node scripts/dev.mjs
.PHONY: dev

run: dev ## Alias for `make dev`.
.PHONY: run

run_no_pill: ## Run dev with the DEV pill hidden (VITE_HIDE_DEV_PILL=1). For clean screenshots / recordings.
	@VITE_HIDE_DEV_PILL=1 node scripts/dev.mjs
.PHONY: run_no_pill

cli-dev: ## Build the debug termic-cli and install it as `termic-dev` in ~/.local/bin (talks to the dev app; coexists with a prod `termic`).
	@cd src-tauri && TERMIC_APP_VERSION="$$(node -p "require('$(CURDIR)/package.json').version")" cargo build -p termic-cli
	@mkdir -p "$$HOME/.local/bin"
	@# Windows: a copy, not a link (symlinks need Developer Mode, and a
	@# `termic-dev` without `.exe` would not run). Re-run after rebuilding.
	@if [ -n "$(IS_WINDOWS)" ]; then \
	    cp -f "$(CURDIR)/src-tauri/target/debug/termic-cli.exe" "$$HOME/.local/bin/termic-dev.exe"; \
	    echo "✓ termic-dev.exe <- src-tauri/target/debug/termic-cli.exe (a copy: re-run after rebuilding)"; \
	else \
	    ln -sf "$(CURDIR)/src-tauri/target/debug/termic-cli" "$$HOME/.local/bin/termic-dev"; \
	    echo "✓ termic-dev -> src-tauri/target/debug/termic-cli"; \
	fi
	@case ":$$PATH:" in *":$$HOME/.local/bin:"*) echo "  ~/.local/bin is on your PATH; run: termic-dev list";; \
	  *) echo "  note: add ~/.local/bin to your PATH, then run: termic-dev list";; esac
.PHONY: cli-dev

check: ## Type-check the Rust backend (fast — no codegen, no link).
	@if command -v cargo >/dev/null 2>&1; then \
	    cd src-tauri && cargo check; \
	else \
	    PATH="$$(brew --prefix rustup)/bin:$$PATH" sh -c 'cd src-tauri && cargo check'; \
	fi
.PHONY: check

check-web: ## Type-check the frontend (no Vite bundle — fast).
	@npx tsc -b --noEmit
.PHONY: check-web

check-all: check check-web ## Run everything: rust + frontend type checks. CI-style.
.PHONY: check-all

lsp-smoke: ## Drive the REAL language servers on this machine against tiny fixture projects. Local only, never CI. LANG_ONLY=python for one. See docs/lsp.md.
	@node scripts/lsp-smoke.mjs
.PHONY: lsp-smoke

login-probe: ## Check each agent's login STILL follows the env var agent_dirs::login_store claims. Local only, never CI. `make login-probe AGENT=claude` for one. See docs/plans/agent-credentials.md.
	@node scripts/login-probe.mjs $(AGENT)
.PHONY: login-probe

lsp-smoke-record: ## Same, plus refresh the recorded workspace/symbol answers the offline suite ranks.
	@node scripts/lsp-smoke.mjs --record
.PHONY: lsp-smoke-record

e2e: ## Build the e2e binary (--features e2e) and run the WebdriverIO suite. Real window, invisible on macOS (see e2e_visible). See docs/e2e-tests.md.
	@# Self-sufficient: install JS deps + (re)seed the throwaway fixture profile
	@# if needed, so a fresh checkout can `make e2e` with no manual steps. Uses
	@# the embedded WebDriver (tauri-plugin-wdio-webdriver, compiled in by the
	@# e2e feature) — no external tauri-driver needed; its "not found" line is a
	@# harmless diagnostic.
	@[ -x node_modules/.bin/wdio ] || npm install
	@node scripts/e2e-seed.mjs
	@node scripts/prune-target.mjs
	@npm run e2e:build
	@npm run test:e2e
.PHONY: e2e

e2e_visible: ## Same as `make e2e`, with the window on screen so you can watch the specs drive it. It still never takes focus.
	@# The default run is transparent and click-through on macOS so it does not
	@# interrupt whoever is at the machine. The app reads this at runtime, so
	@# both targets share one binary.
	@TERMIC_E2E_VISIBLE=1 $(MAKE) e2e
.PHONY: e2e_visible

transcript-audit: ## Run the remote transcript reader over this machine's Claude sessions (local only, after a Claude Code update).
	@cd termic-remote && cargo test --test transcript_audit -- --ignored --nocapture
.PHONY: transcript-audit

perf: ## Run both performance suites locally and report each separately.
	@# Section 1 is the same suite the nightly workflow runs (startup marks +
	@# RSS growth) — durations and memory, measurable anywhere, reported not
	@# gated. Section 2 is the local-only half (idle CPU / GPU / compositor)
	@# that a CI runner cannot measure honestly. They print separately because
	@# they carry different amounts of trust: section 1 is reproducible,
	@# section 2 is only as good as the desktop it ran on.
	@# Why not gated: docs/perf-ci.md.
	@[ -x node_modules/.bin/wdio ] || npm install
	@node scripts/e2e-seed.mjs
	@npm run perf:build
	@mkdir -p .perf
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  Section 1 — CI SUITE (startup, memory) — same as the nightly"
	@echo "════════════════════════════════════════════════════════════════"
	@echo ""
	@# Section 1 must NOT abort the run. A spec that fails still emits the rows
	@# it got to, and section 2 measures something else entirely, so swallowing
	@# it here would hide half the report over an unrelated failure. The status
	@# is kept and re-raised at the end so `make perf` still fails honestly.
	@npm run test:perf; echo $$? > .perf/.section1-status
	@if [ -n "$(IS_WINDOWS)" ]; then echo "  (section 2, the local idle CPU / GPU bench, is macOS-only: skipped)"; else ./perf/local/local-report.sh; fi
	@s=$$(cat .perf/.section1-status 2>/dev/null || echo 0); \
	  if [ "$$s" != "0" ]; then \
	    echo ""; \
	    echo "  NOTE: section 1 exited $$s (a spec failed). Section 2 above still ran."; \
	    exit "$$s"; \
	  fi
.PHONY: perf

perf-ci: ## Section 1 only: perf/nightly (startup + memory), without perf/local.
	@[ -x node_modules/.bin/wdio ] || npm install
	@node scripts/e2e-seed.mjs
	@npm run perf:build
	@npm run test:perf
.PHONY: perf-ci

# ─── release ──────────────────────────────────────────────────────────

# `make release` defaults to a patch bump. Override with BUMP=...
#   make release                # 0.1.0 → 0.1.1
#   make release BUMP=minor     # 0.1.0 → 0.2.0
#   make release BUMP=major     # 0.1.0 → 1.0.0
#   make release BUMP=0.4.2     # set explicit version
BUMP ?= patch
release: ## Cut a release tag (CI does the rest). Use BUMP=patch|minor|major|<version>.
	@./scripts/release.sh $(BUMP)
.PHONY: release

# `make release-patch` folds an uncommitted working-tree change into a
# fresh patch on top of the LAST release: bumps patch, appends the bullet
# to the last CHANGELOG.md entry (no new entry), commits everything + tags.
# Patch only. Bump the top CHANGELOG.md heading version + append your bullet
# first; the script gates on it. See the `release` skill.
release-patch: ## Fold the current working change into a patch on the last release (CI does the rest).
	@./scripts/release.sh patch merge
.PHONY: release-patch

# ─── icons ────────────────────────────────────────────────────────────

icons: ## Regenerate every icon size + format from src-tauri/icons/icon.svg.
	@./scripts/gen-icon.sh
.PHONY: icons

# ─── relaunch: keep the profile windows that were open ────────────────
#
# `make install` / `make beta` quit the running app and launch the new bundle.
# With MORE THAN ONE profile window open (GH #280) the wrong set of windows
# comes back: usually the root window stays hidden and a second profile comes
# up alone.
#
# An AppleScript `quit` reaches each window's CloseRequested handler
# (`build_profile_window`, src-tauri/src/lib.rs), and while another profile
# window is still up that handler reads the close as DELIBERATE: it clears
# `open_at_quit` and prevents the close. Whichever window is handled last sees
# only itself left, so it keeps its flag, and the registry that survives says
# "one window was open" naming an arbitrary one of them. Launch restore then
# does exactly what it was told.
#
# So: read the flags while the app is still up, quit it, and write them back
# with nothing alive to touch profiles.json. install-app.sh then finds a dead
# app (its own quit is a no-op) and launches into the registry we restored.
#
# The quit has to happen HERE rather than in install-app.sh, because the
# repair only holds if it lands between the quit and the launch, and the
# script does both. The script's own socket wait still covers the gap after.
#
# A dormant install has no profiles.json and skips the whole thing; so does a
# single-profile one, where nothing was ever cleared.
ifdef IS_WINDOWS
REGISTRY := $(LOCALAPPDATA)/termic/profiles.json
else
REGISTRY := $(HOME)/Library/Application Support/termic/profiles.json
endif

ifdef IS_WINDOWS
# $(call quit_keeping_profiles,<app name>,<bundle id>)
#
# Windows: the same read-quit-restore dance, but the quit is a close message
# to the process whose path is the installed exe (then a kill), because there
# is no AppleScript `quit` and both apps may be named termic.exe.
define quit_keeping_profiles
@REG="$(REGISTRY)"; \
	if [ -f "$$REG" ]; then \
	  OPEN="$$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((r.profiles||[]).filter(p=>p.open_at_quit).map(p=>p.slug).join(" "))' "$$REG" 2>/dev/null || true)"; \
	  echo "→ Quitting $(1) (profile windows open: $${OPEN:-none})"; \
	  DIR="$$LOCALAPPDATA\\$(1)"; \
	  powershell -NoProfile -Command "Get-Process | Where-Object { \$$_.Path -like \"$$DIR\\*\" } | ForEach-Object { \$$_.CloseMainWindow() | Out-Null }" 2>/dev/null || true; \
	  sleep 2; \
	  powershell -NoProfile -Command "Get-Process | Where-Object { \$$_.Path -like \"$$DIR\\*\" } | Stop-Process -Force" 2>/dev/null || true; \
	  sleep 1; \
	  if [ -n "$$OPEN" ]; then \
	    node -e 'const fs=require("fs"),f=process.argv[1],want=new Set(process.argv.slice(2));const r=JSON.parse(fs.readFileSync(f,"utf8"));let n=0;for(const p of r.profiles||[]){const v=want.has(p.slug);if(p.open_at_quit!==v){p.open_at_quit=v;n++;}}if(n)fs.writeFileSync(f,JSON.stringify(r,null,2)+"\n");process.stdout.write(String(n));' -- "$$REG" $$OPEN >/dev/null; \
	    echo "  · will relaunch with: $$OPEN"; \
	  fi; \
	fi
endef
else ifdef IS_LINUX
# Linux: install-app-linux.sh quits the running copy itself (it is the only
# place that knows which AppImage file is "this app"). Nothing to do here.
define quit_keeping_profiles
@true
endef
else
# $(call quit_keeping_profiles,<app name>,<bundle id>)
define quit_keeping_profiles
@REG="$(REGISTRY)"; PAT="/$(1).app/Contents/MacOS/"; \
	if [ -f "$$REG" ]; then \
	  OPEN="$$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((r.profiles||[]).filter(p=>p.open_at_quit).map(p=>p.slug).join(" "))' "$$REG" 2>/dev/null || true)"; \
	  echo "→ Quitting $(1) (profile windows open: $${OPEN:-none})"; \
	  osascript -e 'tell application id "$(2)" to quit' 2>/dev/null || true; \
	  for _ in $$(seq 1 40); do pgrep -f "$$PAT" >/dev/null || break; sleep 0.25; done; \
	  if pgrep -f "$$PAT" >/dev/null; then \
	    echo "  · quit didn't take (it never does with two windows up), killing it"; \
	    pkill -f "$$PAT" 2>/dev/null || true; \
	    for _ in $$(seq 1 20); do pgrep -f "$$PAT" >/dev/null || break; sleep 0.25; done; \
	  fi; \
	  if [ -n "$$OPEN" ] && ! pgrep -f "$$PAT" >/dev/null; then \
	    node -e 'const fs=require("fs"),f=process.argv[1],want=new Set(process.argv.slice(2));const r=JSON.parse(fs.readFileSync(f,"utf8"));let n=0;for(const p of r.profiles||[]){const v=want.has(p.slug);if(p.open_at_quit!==v){p.open_at_quit=v;n++;}}if(n)fs.writeFileSync(f,JSON.stringify(r,null,2)+"\n");process.stdout.write(String(n));' -- "$$REG" $$OPEN >/dev/null; \
	    echo "  · will relaunch with: $$OPEN"; \
	  fi; \
	fi
endef
endif

# ─── build / install / run ────────────────────────────────────────────

# Windows: NSIS only. The MSI target needs WiX, which depends on VBScript and
# is unreliable on Windows 11 24H2; the NSIS installer is what `install` runs.
ifdef IS_WINDOWS
BUNDLE_ARGS := -- --bundles nsis
BETA_BUNDLES := nsis
else ifdef IS_LINUX
# The AppImage alone: it is what install-app-linux.sh installs, and building
# the .deb and .rpm beside it costs minutes nobody asked for.
BUNDLE_ARGS := -- --bundles appimage
BETA_BUNDLES := appimage
else
BUNDLE_ARGS :=
BETA_BUNDLES := app
endif

build: ## Build a release bundle (.app + .dmg on macOS, NSIS installer on Windows). Output in src-tauri/target/release/bundle/.
	@# The updater artifacts need the release signing key. Without it (any
	@# machine but the release one) skip them rather than fail the build.
	@if [ -n "$${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then \
	    npm run tauri build $(BUNDLE_ARGS); \
	else \
	    npm run tauri build -- $(filter-out --,$(BUNDLE_ARGS)) --config '{"bundle":{"createUpdaterArtifacts":false}}'; \
	fi
.PHONY: build

install: build ## Build a release app, install it (/Applications on macOS, per-user NSIS on Windows), and launch.
	$(call quit_keeping_profiles,Termic,com.simion.termic)
	@./scripts/install-app.sh
.PHONY: install

# `Termic Beta.app` — a SECOND app installed next to the shipped one, from the
# current branch. tauri.beta.conf.json renames the bundle, gives it its own
# identifier (com.simion.termic.beta) and a blue-T icon, so both live in
# /Applications and both can run.
#
# It deliberately shares the PRODUCTION data dir (~/Library/Application
# Support/termic + ~/termic): APP_DIR only splits on debug_assertions
# (src-tauri/src/lib.rs), and this is a release build. Same projects, same
# tasks, same settings.json as the shipped app. Two consequences worth
# knowing: (1) running both at once means two processes writing the same JSON,
# last writer wins, so don't; (2) UI prefs (theme, fonts, shortcut overrides)
# are NOT shared — those live in localStorage, which WKWebView keys by bundle
# id, so the beta starts on defaults.
#
# Sharing the data dir is also why there is only ONE `termic` command and one
# `termic://` scheme for both apps: one data dir means one control socket means
# one running instance, so a single command and a single URL scheme already
# reach whichever of the two is up. See docs/ipc.md, "The `termic` command".
#
# VITE_BETA lights up the BETA pill in the unified bar; VITE_BETA_INFO
# (branch@sha, `+` when the tree was dirty) shows in its tooltip. The beta
# never self-updates (store/update.ts skips the probe), so nothing can
# overwrite this bundle with a shipped build behind your back. To move it
# forward, re-run `make beta`.
#
# --bundles app: just the .app. No .dmg (nothing to distribute) and no updater
# tarball, which is what wanted TAURI_SIGNING_PRIVATE_KEY.
beta: ## Build the CURRENT BRANCH as Termic Beta (parallel install, shared data dir) and launch it.
	@# Signed with the keychain's Developer ID when there is one. Ad-hoc, every
	@# build was a NEW app to macOS: Local Network (and any other TCC grant)
	@# switched on in System Settings never stuck, and discovery stayed
	@# blocked with the switch showing on (DenyMulticast = 1 in
	@# /Library/Preferences/com.apple.networkextension.plist). A stable
	@# identity keeps the grant across rebuilds, as the shipped app does.
	@# The price is Tauri's "skipping app notarization" warning: a Developer
	@# ID makes the bundler try to notarize, there is no switch to tell it not
	@# to (checked in @tauri-apps/cli 2.11.1), and the beta needs none, since
	@# Gatekeeper only checks a quarantined download. Announced below so it
	@# does not read as a broken build.
	@# A freshly pulled commit can add npm deps (tsc then fails with
	@# TS2307 "Cannot find module"). npm install is a ~1s no-op when
	@# node_modules is already in sync, so always run it first.
	@npm install --no-fund --no-audit
	@BRANCH="$$(git rev-parse --abbrev-ref HEAD)"; \
	SHA="$$(git rev-parse --short HEAD)"; \
	DIRTY=""; \
	if [ -n "$$(git status --porcelain)" ]; then DIRTY="+"; fi; \
	echo "→ Building Termic Beta from $$BRANCH@$$SHA$$DIRTY"; \
	SIGN=""; \
	if [ "$$(uname)" = "Darwin" ]; then \
	    SIGN="$$(security find-identity -v -p codesigning 2>/dev/null | awk '/Developer ID Application/ {print $$2; exit}')"; \
	fi; \
	if [ -n "$$SIGN" ]; then echo "→ Signing with the Developer ID in this keychain"; \
	    echo "→ Tauri will warn 'skipping app notarization': expected. Only a DOWNLOADED app is checked for it; one installed from this machine is not."; \
	else echo "→ No Developer ID in this keychain: ad-hoc signed (macOS forgets its permissions on every rebuild)"; fi; \
	APPLE_SIGNING_IDENTITY="$${SIGN:--}" VITE_BETA=1 VITE_BETA_INFO="$$BRANCH@$$SHA$$DIRTY" \
	    npm run tauri build -- --config src-tauri/tauri.beta.conf.json --bundles $(BETA_BUNDLES)
	$(call quit_keeping_profiles,Termic Beta,com.simion.termic.beta)
	@./scripts/install-app.sh "Termic Beta" com.simion.termic.beta
.PHONY: beta

install-beta: beta ## Alias for `make beta`.
.PHONY: install-beta

ifdef IS_WINDOWS
uninstall: ## Remove the installed copies (shipped + beta). User data untouched.
	@for app in "Termic" "Termic Beta"; do \
	    un="$$LOCALAPPDATA/$$app/uninstall.exe"; \
	    if [ -f "$$un" ]; then "$$un" //S && echo "✓ Uninstalled $$app"; else echo "  (not installed) $$app"; fi; \
	done
else ifdef IS_LINUX
uninstall: ## Remove the installed copies (shipped + beta). User data untouched.
	@D="$${TERMIC_INSTALL_DIR:-$$HOME/Applications}"; rm -f "$$D/Termic.AppImage" "$$D/Termic-Beta.AppImage" \
	  && echo "✓ Removed Termic.AppImage + Termic-Beta.AppImage from $$D"
else
uninstall: ## Remove the installed copies (shipped + beta). User data untouched.
	@rm -rf /Applications/Termic.app /Applications/termic.app "/Applications/Termic Beta.app" \
	  && echo "✓ Removed Termic.app + Termic Beta.app from /Applications"
endif
.PHONY: uninstall

# ─── cleanup ──────────────────────────────────────────────────────────

ifdef IS_WINDOWS
reset: ## DESTRUCTIVE: wipe every byte of termic state on this machine (config, caches, webview data, window state). Confirms first.
	@L="$$(cygpath -u "$$LOCALAPPDATA")"; R="$$(cygpath -u "$$APPDATA")"; T="$$(cygpath -u "$$TEMP")"; \
	TARGETS=("$$L/termic" "$$L/com.simion.termic" "$$L/com.simion.termic.beta" "$$R/com.simion.termic" "$$R/com.simion.termic.beta" "$$T/termic-debug.log"); \
	echo "This will delete:"; for t in "$${TARGETS[@]}"; do echo "  $$t"; done; \
	echo ""; \
	echo "Worktrees under ~/termic/ are NOT touched (real git checkouts)."; \
	echo ""; \
	read -p "Type 'yes' to confirm: " confirm; \
	if [ "$$confirm" != "yes" ]; then echo "✗ Aborted."; exit 1; fi; \
	echo "→ Quitting any running termic"; \
	powershell -NoProfile -Command "Get-Process | Where-Object { \$$_.Path -like \"*\\Termic*\\*\" -or \$$_.Path -like \"*\\target\\debug\\termic.exe\" } | Stop-Process -Force" 2>/dev/null || true; \
	sleep 1; \
	for t in "$${TARGETS[@]}"; do rm -rf "$$t"; done; \
	echo "✓ Wiped. Worktrees on disk are untouched."
else ifdef IS_LINUX
reset: ## DESTRUCTIVE: wipe every byte of termic state on this machine (config, caches, webview data, window state). Confirms first.
	@bash scripts/reset-linux.sh all
else
reset: ## DESTRUCTIVE: wipe every byte of termic state on this machine (config, caches, webview data, window state). Confirms first.
	@BUNDLE_ID="com.simion.termic"; \
	APP_DATA="$$HOME/Library/Application Support/termic"; \
	APP_DATA_CAP="$$HOME/Library/Application Support/Termic"; \
	BUNDLE_DATA="$$HOME/Library/Application Support/com.simion.termic"; \
	CACHES="$$HOME/Library/Caches/com.simion.termic"; \
	CACHES_CAP="$$HOME/Library/Caches/Termic"; \
	CACHES_LC="$$HOME/Library/Caches/termic"; \
	PREFS="$$HOME/Library/Preferences/com.simion.termic.plist"; \
	PREFS_LC="$$HOME/Library/Preferences/termic.plist"; \
	PREFS_CAP="$$HOME/Library/Preferences/Termic.plist"; \
	SAVED="$$HOME/Library/Saved Application State/com.simion.termic.savedState"; \
	WEBKIT="$$HOME/Library/WebKit/com.simion.termic"; \
	WEBKIT_LC="$$HOME/Library/WebKit/termic"; \
	WEBKIT_CAP="$$HOME/Library/WebKit/Termic"; \
	HTTPSTORE="$$HOME/Library/HTTPStorages/com.simion.termic"; \
	HTTPSTORE_LC="$$HOME/Library/HTTPStorages/termic"; \
	HTTPSTORE_CAP="$$HOME/Library/HTTPStorages/Termic"; \
	TMPD=$$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || dirname "$$(mktemp -u)"); \
	echo "This will delete:"; \
	echo "  $$APP_DATA"; \
	echo "  $$APP_DATA_CAP"; \
	echo "  $$BUNDLE_DATA"; \
	echo "  $$CACHES"; \
	echo "  $$CACHES_CAP"; \
	echo "  $$CACHES_LC"; \
	echo "  $$PREFS"; \
	echo "  $$PREFS_LC"; \
	echo "  $$PREFS_CAP"; \
	echo "  $$SAVED"; \
	echo "  $$WEBKIT"; \
	echo "  $$WEBKIT_LC"; \
	echo "  $$WEBKIT_CAP"; \
	echo "  $$HTTPSTORE"; \
	echo "  $$HTTPSTORE_LC"; \
	echo "  $$HTTPSTORE_CAP"; \
	echo "  $$TMPD/termic-sandbox-*.sb"; \
	echo "  $$TMPD/termic-proxy-*.filter"; \
	echo "  $$TMPD/termic-debug.log"; \
	echo ""; \
	echo "Worktrees at ~/termic/workspaces/ are NOT touched (real git checkouts;"; \
	echo "if you want those too, run: rm -rf ~/termic/workspaces — destructive)."; \
	echo ""; \
	read -p "Type 'yes' to confirm: " confirm; \
	if [ "$$confirm" != "yes" ]; then echo "✗ Aborted."; exit 1; fi; \
	echo "→ Quitting any running termic (bundle $$BUNDLE_ID)"; \
	osascript -e "tell application id \"$$BUNDLE_ID\" to quit" 2>/dev/null || true; \
	pkill -f "target/debug/termic" 2>/dev/null || true; \
	pkill -f "/Applications/Termic.app/Contents/MacOS/termic" 2>/dev/null || true; \
	pkill -f "/Applications/termic.app/Contents/MacOS/termic" 2>/dev/null || true; \
	sleep 1; \
	rm -rf "$$APP_DATA" "$$APP_DATA_CAP" "$$BUNDLE_DATA" \
	       "$$CACHES" "$$CACHES_CAP" "$$CACHES_LC" \
	       "$$WEBKIT" "$$WEBKIT_LC" "$$WEBKIT_CAP" \
	       "$$HTTPSTORE" "$$HTTPSTORE_LC" "$$HTTPSTORE_CAP"; \
	rm -f "$$PREFS" "$$PREFS_LC" "$$PREFS_CAP"; \
	rm -rf "$$SAVED"; \
	defaults delete "$$BUNDLE_ID" 2>/dev/null || true; \
	defaults delete termic 2>/dev/null || true; \
	defaults delete Termic 2>/dev/null || true; \
	rm -f "$$TMPD"/termic-sandbox-*.sb 2>/dev/null || true; \
	rm -f "$$TMPD"/termic-proxy-*.filter 2>/dev/null || true; \
	rm -f "$$TMPD"/termic-debug.log 2>/dev/null || true; \
	echo "✓ Wiped. Worktrees on disk are untouched."
endif
.PHONY: reset

# Back-compat alias for the old `nuke-data` name.
nuke-data: reset
.PHONY: nuke-data

ifdef IS_WINDOWS
reset_dev: ## DESTRUCTIVE (dev profile only): wipe the dev data dir + ~/termic_dev. Production 'termic' data is untouched. No prompt.
	@DEV_DATA="$$(cygpath -u "$$LOCALAPPDATA")/termic_dev"; \
	DEV_HOME="$$HOME/termic_dev"; \
	echo "→ Quitting any running dev instance (best-effort)"; \
	powershell -NoProfile -Command "Get-Process | Where-Object { \$$_.Path -like \"*\\target\\debug\\termic.exe\" } | Stop-Process -Force" 2>/dev/null || true; \
	sleep 1; \
	for d in "$$DEV_DATA" "$$DEV_HOME"; do \
	    if [ -e "$$d" ]; then echo "→ Removing $$d"; rm -rf "$$d"; else echo "  (absent) $$d"; fi; \
	done; \
	echo "  (the dev webview's localStorage is not separate on Windows: WebView2 keys it by"; \
	echo "   bundle identifier, which dev shares with the release build, so it is left alone)"; \
	echo "✓ Dev profile reset. Production 'termic' data untouched."
else ifdef IS_LINUX
reset_dev: ## DESTRUCTIVE (dev profile only): wipe the dev data dir + ~/termic_dev. Production 'termic' data is untouched. No prompt.
	@bash scripts/reset-linux.sh dev
else
reset_dev: ## DESTRUCTIVE (dev profile only): wipe the dev data dir + ~/termic_dev. Production 'termic' data is untouched. No prompt.
	@DEV_DATA="$$HOME/Library/Application Support/termic_dev"; \
	DEV_HOME="$$HOME/termic_dev"; \
	DEV_WEBKIT="$$HOME/Library/WebKit/termic"; \
	echo "→ Quitting any running dev instance (best-effort)"; \
	pkill -f "target/debug/termic" 2>/dev/null || true; \
	pkill -f "node scripts/dev.mjs" 2>/dev/null || true; \
	sleep 1; \
	for d in "$$DEV_DATA" "$$DEV_HOME" "$$DEV_WEBKIT"; do \
	    if [ -e "$$d" ]; then echo "→ Removing $$d"; rm -rf "$$d"; else echo "  (absent) $$d"; fi; \
	done; \
	echo "✓ Dev profile reset. Production 'termic' data untouched."
endif
.PHONY: reset_dev

prune: ## Drop Rust incremental caches over 8 GB (TERMIC_INCREMENTAL_CAP_GB). Runs on its own before dev and e2e.
	@node scripts/prune-target.mjs
.PHONY: prune

clean: ## Remove build artifacts (frontend dist + rust target). Recovers tens of GB on a long-lived checkout.
	@rm -rf dist node_modules/.vite src-tauri/target
	@echo "✓ Cleaned dist/, .vite cache, src-tauri/target/"
.PHONY: clean

clean-all: clean ## Same as clean + remove node_modules. Forces a fresh npm install.
	@rm -rf node_modules
	@echo "✓ Also removed node_modules/"
.PHONY: clean-all
