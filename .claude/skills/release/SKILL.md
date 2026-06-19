---
name: release
description: Cut a termic release from main, or fold a small change into a patch on the last release. Use whenever the user wants to release, ship a version, cut a tag, bump the version, publish an update, or push a quick patch/hotfix. Covers the changelog entry, make release / make release-patch, what CI does, and developing the update UI.
---

# Releasing termic

Releases are cut from a single Mac, on `main`. CI does everything else once the
tag is pushed. There are two paths:

- **Normal release** (`make release`) — a fresh version with its own changelog
  entry. Patch, minor, major, or explicit. Requires a clean tree.
- **Patch-merge** (`make release-patch`) — fold an uncommitted working-tree
  change into a *patch on top of the last release*, appending the bullet to the
  **last** changelog entry (no new entry). Patch only. Dirty tree expected.

Both bump `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`,
and `Cargo.lock` in lockstep, commit `release: vX`, and tag `vX`. The push of
the tag triggers `.github/workflows/release.yml`.

`CHANGELOG.md` (repo root, Keep a Changelog format) is the **single source of
truth** for release notes. From it, `scripts/changelog.mjs` derives a slim
`changelog.json` (`{version, date, summary}` per version) that the in-app Update
card reads for its one-line summary. The full notes render straight from the
markdown: the in-app Changelog dialog and the `/changelog` page on `termic.dev`
both fetch/render `changelog.md`. CI copies both `CHANGELOG.md` and the derived
`changelog.json` to `termic.dev`, and the GitHub Release notes are extracted
from the new version's section. Never hand-edit `changelog.json` — it's
generated; edit `CHANGELOG.md`.

## When invoked — what to confirm, what to infer

Don't interrogate. There are only two things you can't read off the repo, so
confirm them in a single question and then proceed:

1. **Which path** — normal release (Path A, its own changelog entry) or
   patch-merge (Path B, fold into the last release). If the user already said
   ("cut a release" → A; "quick patch", "hotfix", "ride along with the last
   release" → B), don't ask — just state which you're taking.
2. **Bump level** (Path A only) — patch / minor / major / explicit. Don't
   default silently; ask if unstated. Path B is always patch, so no question.

Infer everything else yourself, don't ask:
- current version (`package.json`), the computed new version, today's date
  (the script stamps it);
- the changelog summary + bullets — draft them from the diff / commits and
  show the user the entry for a quick yes before running. Obey the copy rule
  (no em dashes) and keep the summary line ≤15 words.

After cutting the tag, push it: `git push && git push --tags`. This kicks off
the CI publish (build, sign, GitHub Release, tap + website bump) — it's the
point of the release, so don't stop short of it. Then report the pushed tag and
that CI is running.

---

## Path A — normal release (`make release`)

```sh
# 1. Author the changelog entry for the new version (see "Changelog entry").
#    Add a new "## [x.y.z] - " section at the TOP of CHANGELOG.md.
# 2. Cut the release:
make release                 # patch bump (0.4.4 → 0.4.5)
make release BUMP=minor      # 0.4.4 → 0.5.0
make release BUMP=major      # 0.4.4 → 1.0.0
make release BUMP=0.5.0-rc1  # explicit version
# 3. Push to trigger CI:
git push && git push --tags
```

`scripts/release.sh`:

1. Refuses to run on a dirty tree (dirty `CHANGELOG.md` / `changelog.json` are
   allowed — that's the entry you just wrote + its derived file) or off `main`.
2. Gates on `CHANGELOG.md` via `scripts/changelog.mjs release-gate`: scaffolds a
   stub section if the top entry is missing, stamps today's date, regenerates
   `changelog.json`, and aborts if the summary is empty. (If you forget step 1,
   this is what scaffolds the stub and stops — write its summary, then re-run.)
3. Bumps the four version files in lockstep.
4. Commits the version files **+ `CHANGELOG.md` + `changelog.json`** as
   `release: vX` and tags `vX`.

---

## Path B — patch-merge (`make release-patch`)

For when you have a small uncommitted change sitting in the working tree and
want to ship it as a patch *riding along with the last release* — no separate
feature commit, no new changelog block. **Patch only.**

What it does: bumps patch on top of the last release (0.11.0 → 0.11.1), folds
your working change + the version bumps into one new `release: v0.11.1` commit,
tags it. The previous release commit and tag are left untouched (new commit on
top, nothing rewritten).

```sh
# 1. In CHANGELOG.md, edit the TOP (latest) entry in place:
#      - bump its heading version  (## [0.11.0] → ## [0.11.1])
#      - append your change as a bullet under one of its existing ### subsections
#        (do NOT add a new top entry — the change merges into the last release)
# 2. Fold + cut:
make release-patch
# 3. Push:
git push && git push --tags
```

`scripts/release.sh patch merge` (via `changelog.mjs merge-gate`):

1. Requires `main`. **Allows a dirty tree** — that change is the whole point.
2. Gates on `CHANGELOG.md`: the top entry must already be bumped to the new
   patch version with a non-empty summary and at least one bullet. If it's still
   on the previous version, it tells you to bump-in-place + append, then re-run.
   It restamps the date and regenerates `changelog.json`, but never scaffolds a
   new entry.
3. Bumps the four version files.
4. `git add -A` (sweeps your working change in too), commits `release: vX`, tags.

Guardrails: non-patch bumps are rejected in this mode; an unknown second arg is
rejected. If you actually want a distinct release with its own notes, use Path A.

---

## Changelog entry (Path A)

Add a new section to the **top** of `CHANGELOG.md` (just under the `# Changelog`
title + intro), newest first:

```markdown
## [0.4.5] - 

Short headline that becomes the summary (≤15 words).

### Features
- First new thing.
- Second new thing.

### Bug fixes
- Something broken that is now fixed.
```

Format notes:

- **heading** — `## [<version>] - <date>`. The version must equal the version
  being released (`make release` gates on it). Leave the date blank after the
  `- `; `release.sh` stamps today's date.
- **summary** — the lead paragraph, the first line under the heading before any
  `###`. Required, ≤15 words; it's what `scripts/changelog.mjs` extracts into the
  slim `changelog.json` for the sidebar Update card. `release.sh` warns if it
  exceeds 15 words.
- **subsections** — `### Features` / `### Bug fixes` / `### Improvements` /
  `### Sponsors` (use whatever fits), each with `-` bullets. At least one bullet
  is required. Inline `[text](url)` links are fine (markdown-native).

Newest entry first. Never reorder or delete old entries — the dialog + the
website show the whole history. `changelog.json` is generated from this file;
don't edit it by hand.

**Copy rule:** no em dashes (—) anywhere in user-visible text, including
`CHANGELOG.md`. Use a comma, period, parentheses, or colon.

---

## What CI does (after `git push --tags`)

`.github/workflows/release.yml`:

1. **validate** — frontend type-check.
2. **build-mac** — universal (arm64 + x86_64) build, ad-hoc codesigned and
   ed25519-signed for the updater.
3. **release** — creates the GitHub Release with the signed `.dmg` + updater
   `.tar.gz`. Notes body leads with the new version's section (extracted from
   `CHANGELOG.md` via `changelog.mjs notes`) followed by a short install footer.
4. **bump-tap** — bumps the Homebrew cask in `simion/homebrew-termic`.
5. **bump-website** — commits three files to `simion/termic.dev`:
   - `public/updates/latest.json` — the Tauri updater manifest (version,
     signature, download URLs).
   - `public/updates/changelog.md` — the full `CHANGELOG.md`, copied verbatim.
   - `public/updates/changelog.json` — the slim derived summary file.

## How updates reach users

- **Tauri updater** fetches `termic.dev/updates/latest.json` (Rust-side,
  ed25519-verified). Running apps see a new release within ~5 min (the CF Pages
  cache TTL). The in-app Update card / pill surfaces it.
- **Homebrew** users get it via `brew upgrade --cask`.
- The **Update card** fetches `termic.dev/updates/changelog.json` (slim summary)
  and the **Changelog dialog** fetches `termic.dev/updates/changelog.md` (full
  notes, rendered with the in-app markdown pipeline). Both are WebView `fetch()`
  — the host is allowlisted in `tauri.conf.json`'s CSP `connect-src` and served
  with `Access-Control-Allow-Origin: *`.

Both `changelog.md` and `changelog.json` are also seeded directly in the
`termic.dev` repo so the feature works before the first release that runs the
updated CI.

## Developing the update UI

`check()` never returns an update in a `tauri dev` build (no signed release to
verify against). Mock it with an env var:

```sh
VITE_MOCK_UPDATE=available npm run tauri dev   # update-available card + pill
VITE_MOCK_UPDATE=whatsnew  npm run tauri dev   # post-update "what's new" card
```

The mock is fully self-contained (no network) — see `src/store/update.ts`.
