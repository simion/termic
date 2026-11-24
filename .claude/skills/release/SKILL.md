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
# 0. Prune the README roadmap (see "Roadmap upkeep"):
gh issue list --label planned --state closed
# 0b. Check the compatibility floors and PROPOSE a bump if the wire broke
#     (see "Compatibility floors"). Never skip; never bump without asking.
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

## Compatibility floors (every release, both paths)

Termic does not demand a 1:1 version match with the machines it talks to.
`termic-remote/src/compat.rs` holds two minimums, and nothing else decides
compatibility:

- `REQUIRES_SERVER`: the oldest termic-server this desktop works with. A
  server below it is upgraded AND restarted by itself once no agent is
  mid-turn. A server at or above it but older than the carried build is
  upgraded quietly and restarts only when the user clicks Restart now (or
  the box restarts). A newer server is never downgraded.
- `REQUIRES_DESKTOP`: the oldest Termic desktop this build works with, as a
  paired computer (checked both ways) and as the desktop driving a
  termic-server built from this tree. A desktop below a host's floor is
  told to update itself.

Most releases change nothing on the wire, and then the floors stay. Raise
one only when this release stops working with what is older. **Each
release, before the changelog, do this and tell the maintainer the result
in one line** ("floors unchanged: no wire changes since v1.25.0", or a
proposal):

```sh
last=$(git describe --tags --abbrev=0)
git diff --stat "$last"..HEAD -- termic-remote termic-proto termic-server \
  src-tauri/src/remote_server.rs src-tauri/src/remote_client.rs src-tauri/src/peers.rs
grep -n 'REQUIRES_' termic-remote/src/compat.rs
```

Read the diff (not just the stat) and ask, per side:

- Does this desktop now SEND something an older server or computer cannot
  handle and cannot ignore: a new required field, a changed meaning, a
  request the feature depends on (an unknown request merely fails with
  "unknown variant", which `explainReply` and the CLI already explain, so
  an optional new verb is not a break)? Then propose raising the floor for
  that side to the version that first understands it.
- Does it now RELY on something older ones do not send (a reply field, a
  message, a behaviour)? Same.
- Did `termic_proto::PROTOCOL_VERSION` change? That alone is not a break
  for paired computers any more (they are judged by version once both
  send one); look at what changed under it.
- Additive changes (a new optional field with `#[serde(default)]`, a new
  message type an old side ignores, a new capability string) are never a
  break.

A proposal names the side, the new floor, and the one change that forces
it: "REQUIRES_SERVER 1.25.0 → 1.27.0: the desktop now opens server shells
with `pty_open2`, which 1.26 servers reject." The floor is always at or
below the version being released (`remote_client` test
`this_build_works_with_itself` fails otherwise), and the bump lands in the
release commit's tree, so edit it before `make release`. Never lower a
floor to "fix" a refusal without finding why it was raised.

## Roadmap upkeep (Path A, step 0)

The README roadmap goes stale silently: nothing in the build, the tests or
the release flow reads it, so a shipped item sits in the list until someone
notices by eye. This step is the only thing that catches it.

The roadmap has two halves. **Planned** items each have an issue labelled
`planned`, and that issue, not the position in the list, is the item's
identity: never cite a roadmap item by position, in a doc, a commit message
or a comment. **Ideas** deliberately have NO issue (see CLAUDE.md's docs-tree
section) and are checked against `docs/ideas/` instead.

```sh
gh issue list --label planned --state closed    # shipped, may still be in Planned
gh issue list --label planned --state open      # should match README ## Planned
ls docs/ideas docs/plans                        # should match README ## Ideas
```

For each closed one: delete its Planned item (do not mark it done, the
roadmap is what is *not* built), and if it shipped in this release make sure
the changelog entry covers it. If an item shipped only in part, narrow the
README text to the remaining half rather than deleting it, and say so.

For each open one with no Planned item, either add it or drop the label. For
each `docs/ideas/` file with no Ideas bullet, add one (or delete the file if
the idea is dead).

A new PLANNED item needs a `planned` issue and a `docs/plans/` spec. A new
idea needs neither: it is a file and a bullet. Do not open issues for ideas.

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
# 0. Check the compatibility floors (see "Compatibility floors").
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

### A fix only counts if the bug SHIPPED

`### Bug fixes` is for things that were broken **in a release a user could
already be running**. A bug found and fixed inside the same cycle that
introduces the feature never existed for anybody outside this repo, so listing
it is noise at best and actively misleading at worst: it makes a feature's
debut read like a maintenance release for something users have been suffering
through.

So, for every fix you are about to list, ask: **was the thing it fixes in the
previous release?**

- **Yes** → it belongs under `### Bug fixes`.
- **No, the feature debuts in THIS release** → delete the bullet. The feature's
  own `### Features` entry describes what ships; that it works correctly is not
  a separate accomplishment. This covers the whole cluster: a new feature's
  rough edges, its UI polish, its performance work, and the fixes that came out
  of reviewing it before release.

The same goes for a REGRESSION introduced and repaired between releases: it
never reached a user, so it is not a fix, it is just development.

Concretely, in the 1.0.0 entry: code navigation, PR/MR integration and Docker
sandboxing all debuted there, so **none** of their fixes were listed, however
real the bugs were (a second agent tab killing the first one's container,
switching a Docker task out of Docker leaving it uncaged, PR polling pinned to
a closed PR). That cut roughly thirty commits' worth of candidate bullets. What
survived were only fixes against surfaces that existed in 0.29.0: `files_to_copy`
on multi-repo tasks, a blank glob copying a whole repo, a retired built-in agent
that could not be deleted, the sidebar sandbox badge claiming a task was caged
before it had ever run, five competing focus rings, and a word collision after
inline code.

Note the last three: each of those changes ALSO touched a debuting feature, and
the bullet is scoped to the half that shipped. The focus work unified rings that
existed in 0.29.0, so it counts, but it is not written up as "the sandbox cards
had a clipped ring" because those cards are new. The `<code>` fix repaired two
sites; only the multi-repo one shipped, so only that one is named. Ask what a
0.29.0 user would notice, not which commit the fix rode in on.

Two other things that are not user-facing fixes and never belong in the
changelog at all: **test/CI work** (a flaky spec, a suite that steals focus)
and **internal refactors** with no behaviour change. Neither is something a
user can observe in the app.

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

## Post-release notifications (minor releases only)

After a **minor release** (x.Y.0) — not patches — post release notification comments on the GitHub issues and PRs addressed in this release.

**Skip for patch releases (x.y.Z > 0).**

### Workflow

1. **Find closed issues** since the previous minor release:
   ```sh
   gh issue list -R simion/termic --state closed --limit 50 --json number,title,closedAt
   ```
   Filter to those closed in the ~2 weeks before the release date.

2. **Find merged PRs** and check which ones have no linked issue (parse body for `closes #N` / `fixes #N`):
   ```sh
   gh pr list -R simion/termic --state merged --limit 30 --json number,title,mergedAt,body
   ```

3. **Propose the list** before posting anything:
   - Issues closed as part of this release
   - PRs merged with no linked issue (user-facing ones only — skip internal tooling / docs-only PRs)

4. **Draft messages** for approval:
   - **Standard issue**: `This shipped in [vX.Y.0](<release-url>), released today. Thanks for reporting!`
   - **Standard PR (no issue)**: `This is live in [vX.Y.0](<release-url>), released today. Thanks for the contribution!`
   - **Custom**: For issues with significant back-and-forth, check existing comments first — if already explained, keep it short: just the "shipped in vX.Y.0" line.

5. **Post only after approval.** Batch all comments in one step.

---

## Developing the update UI

`check()` never returns an update in a `tauri dev` build (no signed release to
verify against). Mock it with an env var:

```sh
VITE_MOCK_UPDATE=available npm run tauri dev   # update-available card + pill
VITE_MOCK_UPDATE=whatsnew  npm run tauri dev   # post-update "what's new" card
```

The mock is fully self-contained (no network) — see `src/store/update.ts`.
