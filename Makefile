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

setup: ## One-shot dev env bootstrap (brew/rust/node + npm install + cargo check).
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
	@npm run tauri:dev
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

# ─── icons ────────────────────────────────────────────────────────────

icons: ## Regenerate every icon size + format from src-tauri/icons/icon.svg.
	@./scripts/gen-icon.sh
.PHONY: icons

# ─── build / install / run ────────────────────────────────────────────

build: ## Build a release .app + .dmg bundle. Output in src-tauri/target/release/bundle/.
	@npm run tauri build
.PHONY: build

install: build ## Build a release .app, copy it to /Applications (replacing any prior copy), and launch.
	@APP_NAME="Termic"; \
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
	echo "→ Launching $$DEST"; \
	open "$$DEST"; \
	echo "✓ Installed."
.PHONY: install

uninstall: ## Remove the installed copy from /Applications (user data untouched).
	@rm -rf /Applications/Termic.app /Applications/termic.app && echo "✓ Removed Termic.app from /Applications"
.PHONY: uninstall

# ─── cleanup ──────────────────────────────────────────────────────────

reset: ## DESTRUCTIVE: wipe every byte of termic state on this Mac (config, caches, window state, sandbox temp). Confirms first.
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
.PHONY: reset

# Back-compat alias for the old `nuke-data` name.
nuke-data: reset
.PHONY: nuke-data

clean: ## Remove build artifacts (frontend dist + rust target). Recovers ~3GB.
	@rm -rf dist node_modules/.vite src-tauri/target
	@echo "✓ Cleaned dist/, .vite cache, src-tauri/target/"
.PHONY: clean

clean-all: clean ## Same as clean + remove node_modules. Forces a fresh npm install.
	@rm -rf node_modules
	@echo "✓ Also removed node_modules/"
.PHONY: clean-all
