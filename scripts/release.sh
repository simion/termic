#!/usr/bin/env bash
# Cut a release tag locally. CI (.github/workflows/release.yml) takes
# over once the tag is pushed: builds the macOS bundle, ed25519-signs
# the updater package, uploads to a GitHub Release, bumps the
# homebrew tap and the website's update manifest + changelog.
#
# Before bumping versions this script gates on changelog.json: the
# entry for the new version must exist with a summary (it's what the
# in-app Update card and Changelog dialog render). A stub is
# scaffolded if missing — fill it in and re-run. See the `release` skill.
#
# Usage:
#   ./scripts/release.sh patch          0.1.0 → 0.1.1
#   ./scripts/release.sh minor          0.1.0 → 0.2.0
#   ./scripts/release.sh major          0.1.0 → 1.0.0
#   ./scripts/release.sh 0.4.2-rc1      set explicit version
#
# Patch-merge mode (second arg `merge`) — fold an uncommitted working-tree
# change into a fresh patch on top of the last release, with the changelog
# bullet appended to the LAST entry (no new entry):
#   ./scripts/release.sh patch merge    0.11.0 → 0.11.1
# In this mode a dirty tree is expected (that's your change), and the top
# changelog entry must already be bumped to the new version with your
# bullet appended. Patch only. See the `release` skill.
set -euo pipefail

BUMP="${1:-patch}"
MODE="${2:-}"

if [[ -n "$MODE" && "$MODE" != "merge" ]]; then
  echo "✗ unknown mode '$MODE' (only 'merge' is supported)"
  exit 1
fi
if [[ "$MODE" == "merge" && "$BUMP" != "patch" ]]; then
  echo "✗ patch-merge mode is patch-only (got BUMP=$BUMP)"
  exit 1
fi

# ─── preflight ──────────────────────────────────────────────────────
# The changelog.json entry for the new version is authored right before
# the release (it feeds the in-app Update card), so it's expected to be
# uncommitted here — exempt it from the dirty check. release.sh commits
# it together with the version bump below.
#
# Patch-merge mode is the exception: the whole point is to fold an
# uncommitted working-tree change into the release, so any dirty tree is
# allowed and `git add -A` sweeps it into the release commit.
if [[ "$MODE" != "merge" ]]; then
  if [[ -n "$(git status --porcelain | grep -v ' changelog\.json$' || true)" ]]; then
    echo "✗ working tree dirty (other than changelog.json) — commit or stash first"
    echo "  (to fold a change into a patch on the last release, use: make release-patch)"
    exit 1
  fi
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "✗ releases cut from main only (currently on $BRANCH)"
  exit 1
fi

# ─── compute new version ────────────────────────────────────────────
CUR="$(node -p 'require("./package.json").version')"
case "$BUMP" in
  patch)
    NEW=$(awk -F. -v OFS=. '{$3++; print}' <<<"$CUR")
    ;;
  minor)
    NEW=$(awk -F. -v OFS=. '{$2++; $3=0; print}' <<<"$CUR")
    ;;
  major)
    NEW=$(awk -F. -v OFS=. '{$1++; $2=0; $3=0; print}' <<<"$CUR")
    ;;
  *)
    NEW="$BUMP"
    ;;
esac

echo "→ Bumping $CUR → $NEW"

# ─── changelog gate ─────────────────────────────────────────────────
if [[ "$MODE" == "merge" ]]; then
  # Patch-merge: the change folds into the LAST release's notes rather
  # than getting its own entry. The top entry must already be bumped in
  # place to $NEW (with the new bullet appended) before this runs — we do
  # NOT scaffold a new entry here. Restamp the date and validate.
  CL_STATUS="$(node -e '
    const fs = require("fs");
    const f = "changelog.json";
    const v = process.argv[1];
    const cur = process.argv[2];
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const top = (j.versions || [])[0];
    if (!top) { process.stdout.write("EMPTY"); process.exit(0); }
    if (top.version === cur) { process.stdout.write("NOT_BUMPED"); process.exit(0); }
    if (top.version !== v) { process.stdout.write("MISMATCH:" + top.version); process.exit(0); }
    top.date = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    const haveSummary = typeof top.summary === "string" && top.summary.trim().length > 0;
    const haveSections = Array.isArray(top.sections) && top.sections.some(s => Array.isArray(s.items) && s.items.some(n => typeof n === "string" && n.trim().length > 0));
    if (!haveSummary || !haveSections) { process.stdout.write("INCOMPLETE"); process.exit(0); }
    process.stdout.write("OK");
  ' "$NEW" "$CUR")"
  if [[ "$CL_STATUS" != "OK" ]]; then
    echo ""
    echo "✗ patch-merge needs the top changelog.json entry bumped to $NEW."
    case "$CL_STATUS" in
      NOT_BUMPED)
        echo "  The top entry is still $CUR. Bump its \"version\" to $NEW in place,"
        echo "  append your change as a bullet to one of its existing \"sections\","
        echo "  then re-run:  make release-patch" ;;
      MISMATCH:*)
        echo "  The top entry is ${CL_STATUS#MISMATCH:}, expected $NEW. Fix it and re-run." ;;
      *)
        echo "  The top entry needs a non-empty summary and at least one section item." ;;
    esac
    exit 1
  fi
  echo "→ changelog.json top entry folded into $NEW: ok"
else
# Every release must ship a filled-in changelog.json entry for $NEW —
# it's the source the in-app Update card + Changelog dialog render, and
# CI copies it verbatim to termic.dev. Scaffold a stub if the entry is
# missing, stamp today's date onto it, and refuse to proceed until its
# summary is written.
CL_STATUS="$(node -e '
  const fs = require("fs");
  const f = "changelog.json";
  const v = process.argv[1];
  let j;
  try {
    j = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") {
      j = { versions: [] };
    } else {
      console.error("✗ Failed to parse changelog.json. Please check for syntax errors:");
      throw e;
    }
  }
  if (!Array.isArray(j.versions)) j.versions = [];
  let top = j.versions[0];
  if (!top || top.version !== v) {
    top = { version: v, date: "", summary: "", sections: [{ label: "Features", items: [""] }] };
    j.versions.unshift(top);
  }
  top.date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  const haveSummary = typeof top.summary === "string" && top.summary.trim().length > 0;
  const haveSections = Array.isArray(top.sections) && top.sections.some(s => Array.isArray(s.items) && s.items.some(n => typeof n === "string" && n.trim().length > 0));
  const haveNotes = Array.isArray(top.notes) && top.notes.some(n => typeof n === "string" && n.trim().length > 0);
  if (!haveSummary || (!haveSections && !haveNotes)) { process.stdout.write("INCOMPLETE"); process.exit(0); }
  const words = top.summary.trim().split(/\s+/).length;
  if (words > 15) {
    process.stderr.write("  ⚠ summary is " + words + " words (target ≤15) — it renders in a narrow sidebar card.\n");
  }
  process.stdout.write("OK");
' "$NEW")"
if [[ "$CL_STATUS" != "OK" ]]; then
  echo ""
  echo "✗ changelog.json needs the $NEW entry filled in."
  echo "  A stub for $NEW is now at the top of changelog.json — write its"
  echo "  short \"summary\" (≤15 words) and at least one \"notes\" bullet,"
  echo "  then re-run:"
  echo "      make release BUMP=$BUMP"
  exit 1
fi
echo "→ changelog.json entry for $NEW: ok"
fi

# ─── bump the three version files in lockstep ──────────────────────
# package.json (npm version)
npm version --no-git-tag-version "$NEW" >/dev/null

# src-tauri/Cargo.toml (top-level [package] version)
sed -i.bak -E "s/^version = \".*\"/version = \"$NEW\"/" src-tauri/Cargo.toml
rm src-tauri/Cargo.toml.bak

# src-tauri/tauri.conf.json
node -e "
  const fs = require('fs');
  const f = 'src-tauri/tauri.conf.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.version = process.argv[1];
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
" "$NEW"

# Keep Cargo.lock in sync so it doesn't drift in CI.
( cd src-tauri && cargo update -p termic >/dev/null 2>&1 || true )

# ─── commit + tag ──────────────────────────────────────────────────
# Patch-merge sweeps the whole working tree (your change is the point of
# the merge) into the release commit. The normal path stages only the
# version files + changelog, leaving anything else for a separate commit.
if [[ "$MODE" == "merge" ]]; then
  git add -A
else
  git add \
    package.json package-lock.json \
    src-tauri/Cargo.toml src-tauri/Cargo.lock \
    src-tauri/tauri.conf.json \
    changelog.json
fi
git commit -m "release: v$NEW"
git tag "v$NEW"

echo ""
echo "✓ Tagged v$NEW. Push to trigger CI:"
echo "    git push && git push --tags"
