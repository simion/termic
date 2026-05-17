set shell := ["bash", "-euo", "pipefail", "-c"]

# Show every available recipe with its description.
default:
    @just --list

# ─── dev ──────────────────────────────────────────────────────────────

# Run termic in dev mode (Vite HMR + Rust auto-rebuild).
dev:
    @npm run tauri dev

# Type-check the Rust backend only (fast — no codegen, no link).
check:
    @cd src-tauri && cargo check

# Type-check the frontend only (no Vite bundle — fast). Use `just build`
# if you actually want the production output.
check-web:
    @npx tsc -b --noEmit

# Run everything: rust + frontend type checks. CI-style.
check-all: check check-web

# ─── icons ────────────────────────────────────────────────────────────

# Regenerate every icon size + format from src-tauri/icons/icon.svg.
# Run this after editing the SVG, then commit the regenerated rasters.
icons:
    @./scripts/gen-icon.sh

# ─── deps (vendored reference apps for ad-hoc inspection) ─────────────

# Refresh src-tauri/vendor/ from current system (Ghostty etc.). Vendored
# apps are gitignored — local only.
fetch-deps:
    @./scripts/fetch-deps.sh

# ─── build ────────────────────────────────────────────────────────────

# Build a release .app + .dmg bundle. Output lives in
# src-tauri/target/release/bundle/ — universal arm64 + x86_64 if your
# tauri.conf.json targets are set up for it.
build:
    @npm run tauri build

# Build the release bundle AND copy the .app to /Applications, replacing
# any prior install. Quits a running instance via bundle ID (not app name —
# precise even if you've got a dev binary running with the same display
# name). Touches the new bundle so LaunchServices re-reads its icon
# without the more disruptive `killall Dock` flash.
install: build
    @set -e; \
    APP_NAME="termic"; \
    BUNDLE_ID="com.simion.termic"; \
    SRC="src-tauri/target/release/bundle/macos/$APP_NAME.app"; \
    DEST="/Applications/$APP_NAME.app"; \
    if [ ! -d "$SRC" ]; then echo "✗ build artifact missing: $SRC"; exit 1; fi; \
    echo "→ Quitting any running $APP_NAME instance (by bundle id $BUNDLE_ID)"; \
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" 2>/dev/null || true; \
    sleep 1; \
    echo "→ Removing $DEST (if present)"; \
    rm -rf "$DEST"; \
    echo "→ Copying $SRC → $DEST"; \
    cp -R "$SRC" "$DEST"; \
    echo "→ Refreshing icon cache"; \
    touch "$DEST"; \
    /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "$DEST" 2>/dev/null || true; \
    killall Finder 2>/dev/null || true; \
    echo "✓ Installed. Launch with: open $DEST"

# Build, install, AND launch. One-liner for "ship it and try it".
run: install
    @open "/Applications/termic.app"

# Remove the installed copy from /Applications (does NOT touch user data
# in ~/Library/Application Support/com.simion.conductor).
uninstall:
    @rm -rf /Applications/termic.app && echo "✓ Removed /Applications/termic.app"

# Wipe ALL local user data. Two separate dirs to clear:
#   - termic/                  → app-owned: projects.json, workspaces/, settings.json
#   - com.simion.termic/       → tauri-plugin-state: window position, size
# Both stem from macOS conventions. Worktrees on disk are NOT touched —
# those are real git repos under ~/termic/workspaces/.
# DESTRUCTIVE. Confirms before running.
nuke-data:
    @APP_DATA="$HOME/Library/Application Support/termic"; \
    BUNDLE_DATA="$HOME/Library/Application Support/com.simion.termic"; \
    echo "This will delete:"; \
    echo "  $APP_DATA"; \
    echo "  $BUNDLE_DATA"; \
    read -p "Type 'yes' to confirm: " confirm; \
    if [ "$confirm" = "yes" ]; then \
        rm -rf "$APP_DATA" "$BUNDLE_DATA"; \
        echo "✓ Wiped. Worktrees on disk are untouched."; \
    else \
        echo "✗ Aborted."; \
    fi

# ─── cleanup ──────────────────────────────────────────────────────────

# Remove all build artifacts (frontend dist + rust target). Recovers
# ~3GB on a typical machine.
clean:
    @rm -rf dist node_modules/.vite src-tauri/target
    @echo "✓ Cleaned dist/, .vite cache, src-tauri/target/"

# Same as clean + remove node_modules. Forces a fresh `npm install`.
clean-all: clean
    @rm -rf node_modules
    @echo "✓ Also removed node_modules/"
