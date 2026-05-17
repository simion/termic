set shell := ["bash", "-euo", "pipefail", "-c"]

# Show every available recipe with its description.
default:
    @just --list

# ─── setup ────────────────────────────────────────────────────────────

# One-shot dev environment bootstrap. Installs every system prereq
# Termic needs (homebrew, Rust toolchain, Node) and runs `npm install`
# + `cargo check` so the first `just dev` doesn't surprise-compile.
# Idempotent - re-runnable any time.
setup:
    @echo "→ Termic dev environment bootstrap"
    @set -e; \
    if ! command -v brew >/dev/null 2>&1; then \
        echo "✗ homebrew required. Install from https://brew.sh and re-run."; \
        exit 1; \
    fi; \
    echo "→ Checking Rust toolchain"; \
    if ! command -v cargo >/dev/null 2>&1; then \
        echo "  installing via rustup-init"; \
        brew install rustup-init && rustup-init -y --no-modify-path; \
        source "$HOME/.cargo/env"; \
    else \
        echo "  ✓ cargo present ($(cargo --version))"; \
    fi; \
    echo "→ Checking Node"; \
    if ! command -v node >/dev/null 2>&1; then \
        echo "  installing node"; brew install node; \
    else \
        echo "  ✓ node present ($(node --version))"; \
    fi; \
    echo "→ Checking tinyproxy (per-workspace HTTPS allowlist for sandboxed agents)"; \
    if ! command -v tinyproxy >/dev/null 2>&1; then \
        echo "  installing tinyproxy"; brew install tinyproxy; \
    else \
        echo "  ✓ tinyproxy present"; \
    fi; \
    echo "→ Installing npm packages"; \
    npm install; \
    echo "→ Pre-fetching Rust crate index (cargo check)"; \
    (cd src-tauri && cargo check) >/dev/null; \
    echo ""; \
    echo "✓ Setup complete. Try: just dev"

# Verify the dev env without installing anything. Useful for CI or
# pre-PR sanity. Exits nonzero on the first missing dep so the message
# is whatever you need to fix.
doctor:
    @set -e; \
    fail=0; \
    check() { \
        local name="$1"; local cmd="$2"; local ver="${3-}"; \
        if command -v "$cmd" >/dev/null 2>&1; then \
            local v="$($cmd $ver 2>&1 | head -1)"; \
            echo "  ✓ $name: $v"; \
        else \
            echo "  ✗ $name: missing"; fail=1; \
        fi; \
    }; \
    check brew brew --version; \
    check rust cargo --version; \
    check node node --version; \
    if command -v tinyproxy >/dev/null 2>&1; then echo "  ✓ tinyproxy present"; else echo "  ✗ tinyproxy missing (sandboxed workspaces will spawn with full network deny — run: just setup)"; fi; \
    if [ -d node_modules ]; then echo "  ✓ node_modules present"; else echo "  ✗ node_modules missing (run: npm install)"; fail=1; fi; \
    if [ $fail -eq 0 ]; then echo ""; echo "✓ Dev env looks good."; else echo ""; echo "✗ Run 'just setup' to fix."; exit 1; fi

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

# ─── release ──────────────────────────────────────────────────────────

# Cut a release tag and push - GitHub Actions does the rest (build,
# ad-hoc codesign, ed25519-sign the updater package, GitHub Release,
# bump homebrew tap, bump termic.dev manifest).
#
# Usage:
#   just release           # bump patch (0.1.0 → 0.1.1)
#   just release minor     # 0.1.0 → 0.2.0
#   just release major     # 0.1.0 → 1.0.0
#   just release 0.4.2     # set explicit version
release bump="patch":
    @set -e; \
    if [[ -n "$(git status --porcelain)" ]]; then \
        echo "✗ working tree dirty - commit or stash first"; exit 1; \
    fi; \
    if [[ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then \
        echo "✗ releases cut from main only (currently on $(git rev-parse --abbrev-ref HEAD))"; exit 1; \
    fi; \
    CUR="$(node -p 'require(\"./package.json\").version')"; \
    case "{{ bump }}" in \
        patch) NEW=$(node -e "let [a,b,c]=process.argv[1].split('.').map(Number); console.log(\`\${a}.\${b}.\${c+1}\`)" "$CUR");; \
        minor) NEW=$(node -e "let [a,b,c]=process.argv[1].split('.').map(Number); console.log(\`\${a}.\${b+1}.0\`)" "$CUR");; \
        major) NEW=$(node -e "let [a,b,c]=process.argv[1].split('.').map(Number); console.log(\`\${a+1}.0.0\`)" "$CUR");; \
        *)     NEW="{{ bump }}";; \
    esac; \
    echo "→ Bumping $CUR → $NEW"; \
    # Three files must agree: package.json, Cargo.toml, tauri.conf.json. \
    npm version --no-git-tag-version "$NEW" >/dev/null; \
    sed -i.bak -E "s/^version = \".*\"/version = \"$NEW\"/" src-tauri/Cargo.toml && rm src-tauri/Cargo.toml.bak; \
    node -e "let f='src-tauri/tauri.conf.json',c=require('fs').readFileSync(f,'utf8'),j=JSON.parse(c);j.version='$NEW';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"; \
    # Keep Cargo.lock in sync so it doesn't drift in CI. \
    (cd src-tauri && cargo update -p termic >/dev/null 2>&1 || true); \
    git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json; \
    git commit -m "release: v$NEW"; \
    git tag "v$NEW"; \
    echo ""; \
    echo "✓ Tagged v$NEW. Push to trigger CI:"; \
    echo "    git push && git push --tags"

# ─── sandbox bundling ─────────────────────────────────────────────────

# Copy the local tinyproxy binary into src-tauri/resources/ so the next
# `npm run tauri:build` bundles it into Termic.app/Contents/Resources/.
# Without this, sandboxed workspaces require the user to install
# tinyproxy themselves (the TinyproxyBanner surfaces the install hint).
#
# Note: the bundled binary is architecture-specific. Running this on
# an arm64 Mac copies an arm64 binary; users on x86_64 Macs will fall
# back to PATH (or the banner) until we wire a release-time fetch for
# both arches. Treat as a release-prep step.
bundle-tinyproxy:
    @set -e; \
    SRC="$(command -v tinyproxy || true)"; \
    if [ -z "$SRC" ]; then \
        echo "✗ tinyproxy not on PATH. Install: brew install tinyproxy"; \
        exit 1; \
    fi; \
    DEST="src-tauri/resources/tinyproxy"; \
    mkdir -p "$(dirname "$DEST")"; \
    cp "$SRC" "$DEST"; \
    echo "✓ bundled $(file "$DEST" | sed 's/.*: //') → $DEST"; \
    echo "  Next: npm run tauri:build (the .app will ship with tinyproxy)."

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
