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
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
MAKEFLAGS += --no-print-directory

.DEFAULT_GOAL := help

# ─── help ─────────────────────────────────────────────────────────────

# Parse `## …` annotations from this file and print them. Same UX as
# `just --list` without depending on just.
help: ## Show this help (default target).
	@awk 'BEGIN {FS = ":.*## "} \
	     /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' \
	     $(MAKEFILE_LIST) | sort
.PHONY: help

# ─── setup ────────────────────────────────────────────────────────────

setup: ## One-shot dev env bootstrap (brew/rust/node/tinyproxy + npm install + cargo check).
	@echo "→ Termic dev environment bootstrap"
	@if ! command -v brew >/dev/null 2>&1; then \
	    echo "✗ homebrew required. Install from https://brew.sh and re-run."; \
	    exit 1; \
	fi
	@echo "→ Checking Rust toolchain"
	@if ! command -v cargo >/dev/null 2>&1; then \
	    echo "  installing via rustup-init"; \
	    brew install rustup-init && rustup-init -y --no-modify-path; \
	    source "$$HOME/.cargo/env"; \
	else \
	    echo "  ✓ cargo present ($$(cargo --version))"; \
	fi
	@echo "→ Checking Node"
	@if ! command -v node >/dev/null 2>&1; then \
	    echo "  installing node"; brew install node; \
	else \
	    echo "  ✓ node present ($$(node --version))"; \
	fi
	@echo "→ Checking tinyproxy (per-workspace HTTPS allowlist for sandboxed agents)"
	@if ! command -v tinyproxy >/dev/null 2>&1; then \
	    echo "  installing tinyproxy"; brew install tinyproxy; \
	else \
	    echo "  ✓ tinyproxy present"; \
	fi
	@echo "→ Installing npm packages"
	@npm install
	@echo "→ Pre-fetching Rust crate index (cargo check)"
	@(cd src-tauri && cargo check) >/dev/null
	@echo ""
	@echo "✓ Setup complete. Try: make dev"
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
	check brew brew --version; \
	check rust cargo --version; \
	check node node --version; \
	if command -v tinyproxy >/dev/null 2>&1; then \
	    echo "  ✓ tinyproxy present"; \
	else \
	    echo "  ✗ tinyproxy missing (sandboxed workspaces will spawn with full network deny — run: make setup)"; \
	fi; \
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
	@npm run tauri dev
.PHONY: dev

check: ## Type-check the Rust backend (fast — no codegen, no link).
	@cd src-tauri && cargo check
.PHONY: check

check-web: ## Type-check the frontend (no Vite bundle — fast).
	@npx tsc -b --noEmit
.PHONY: check-web

check-all: check check-web ## Run everything: rust + frontend type checks. CI-style.
.PHONY: check-all

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

# ─── icons + sandbox bundling ─────────────────────────────────────────

icons: ## Regenerate every icon size + format from src-tauri/icons/icon.svg.
	@./scripts/gen-icon.sh
.PHONY: icons

bundle-tinyproxy: ## Copy local tinyproxy into src-tauri/resources/ so the next build bundles it.
	@SRC="$$(command -v tinyproxy || true)"; \
	if [ -z "$$SRC" ]; then \
	    echo "✗ tinyproxy not on PATH. Install: brew install tinyproxy"; \
	    exit 1; \
	fi; \
	DEST="src-tauri/resources/tinyproxy"; \
	mkdir -p "$$(dirname "$$DEST")"; \
	cp "$$SRC" "$$DEST"; \
	echo "✓ bundled $$(file "$$DEST" | sed 's/.*: //') → $$DEST"; \
	echo "  Next: npm run tauri:build (the .app will ship with tinyproxy)."
.PHONY: bundle-tinyproxy

# ─── build / install / run ────────────────────────────────────────────

build: ## Build a release .app + .dmg bundle. Output in src-tauri/target/release/bundle/.
	@npm run tauri build
.PHONY: build

install: build ## Build + copy the .app to /Applications, replacing any prior install.
	@APP_NAME="termic"; \
	BUNDLE_ID="com.simion.termic"; \
	SRC="src-tauri/target/release/bundle/macos/$$APP_NAME.app"; \
	DEST="/Applications/$$APP_NAME.app"; \
	if [ ! -d "$$SRC" ]; then echo "✗ build artifact missing: $$SRC"; exit 1; fi; \
	echo "→ Quitting any running $$APP_NAME instance (by bundle id $$BUNDLE_ID)"; \
	osascript -e "tell application id \"$$BUNDLE_ID\" to quit" 2>/dev/null || true; \
	sleep 1; \
	echo "→ Removing $$DEST (if present)"; \
	rm -rf "$$DEST"; \
	echo "→ Copying $$SRC → $$DEST"; \
	cp -R "$$SRC" "$$DEST"; \
	echo "→ Refreshing icon cache"; \
	touch "$$DEST"; \
	/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "$$DEST" 2>/dev/null || true; \
	killall Finder 2>/dev/null || true; \
	echo "✓ Installed. Launch with: open $$DEST"
.PHONY: install

run: install ## Build, install, AND launch — one-liner for "ship it and try it".
	@open "/Applications/termic.app"
.PHONY: run

uninstall: ## Remove the installed copy from /Applications (user data untouched).
	@rm -rf /Applications/termic.app && echo "✓ Removed /Applications/termic.app"
.PHONY: uninstall

# ─── cleanup ──────────────────────────────────────────────────────────

nuke-data: ## DESTRUCTIVE: wipe local app data (projects, settings, window state). Confirms first.
	@APP_DATA="$$HOME/Library/Application Support/termic"; \
	BUNDLE_DATA="$$HOME/Library/Application Support/com.simion.termic"; \
	echo "This will delete:"; \
	echo "  $$APP_DATA"; \
	echo "  $$BUNDLE_DATA"; \
	read -p "Type 'yes' to confirm: " confirm; \
	if [ "$$confirm" = "yes" ]; then \
	    rm -rf "$$APP_DATA" "$$BUNDLE_DATA"; \
	    echo "✓ Wiped. Worktrees on disk are untouched."; \
	else \
	    echo "✗ Aborted."; \
	fi
.PHONY: nuke-data

clean: ## Remove build artifacts (frontend dist + rust target). Recovers ~3GB.
	@rm -rf dist node_modules/.vite src-tauri/target
	@echo "✓ Cleaned dist/, .vite cache, src-tauri/target/"
.PHONY: clean

clean-all: clean ## Same as clean + remove node_modules. Forces a fresh npm install.
	@rm -rf node_modules
	@echo "✓ Also removed node_modules/"
.PHONY: clean-all
