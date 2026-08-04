#!/usr/bin/env node
// Seed an e2e fixture profile from committed templates (scripts/e2e-seed/*).
// The real profile is gitignored, so CI + fresh checkouts recreate it here.
// Exposed as seed(opts) so wdio.conf can seed an ISOLATED profile per parallel
// worker (own data dir + fixture repo + tasks/worktree base). Idempotent.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const seedDir = path.join(scriptDir, "e2e-seed");

/** 1x1 transparent PNG — the committed side of the image-diff spec's fixture. */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: "ignore" });
const shOut = (cmd, cwd) =>
  execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();

/**
 * @param {object} [o]
 * @param {string} [o.dataDir]  TERMIC_DATA_DIR (profile) to write.
 * @param {string} [o.fixture]  path of the fixture git repo (project root).
 * @param {string} [o.tasksPath] project.tasks_path — where worktrees go.
 * @param {string} [o.sbcheck]  path of the pre-seeded importable worktree.
 */
export function seed(o = {}) {
  const home = os.homedir();
  const e2e = path.join(repoRoot, ".e2e");
  const dataDir = o.dataDir ?? path.join(e2e, "profile");
  const fixture = o.fixture ?? path.join(e2e, "fixture-repo");
  const tasksPath =
    o.tasksPath ?? path.join(home, "termic_dev", "tasks", "fixture-repo");
  const sbcheck =
    o.sbcheck ??
    path.join(home, "termic_dev", "workspaces", "fixture-repo", "sbcheck");

  // 1. Fixture git repo (README committed on main).
  if (!existsSync(path.join(fixture, ".git"))) {
    mkdirSync(fixture, { recursive: true });
    sh("git init -b main -q .", fixture);
    writeFileSync(path.join(fixture, "README.md"), "# e2e fixture\n");
    sh("git add .", fixture);
    sh(
      'git -c user.email=e2e@termic.dev -c user.name=e2e commit -q -m "init fixture"',
      fixture,
    );
  }

  // 1a. A committed 1x1 PNG, so the image-diff spec has a HEAD side to compare
  // against. Separate from the block above (which only runs for a brand-new
  // fixture) so an already-seeded checkout picks it up too.
  const shot = path.join(fixture, "shot.png");
  if (!existsSync(shot)) {
    writeFileSync(shot, Buffer.from(TINY_PNG_B64, "base64"));
    sh("git add shot.png", fixture);
    sh(
      'git -c user.email=e2e@termic.dev -c user.name=e2e commit -q -m "fixture image"',
      fixture,
    );
  }

  // 1b. An `origin` remote with `origin/main`. Real repos are cloned and carry
  // a remote-tracking base, so the default project base_branch is "origin/main"
  // (see projects.json + detect_base_branch in lib.rs). Without this the fixture
  // is local-only and every worktree spawn that honors the project default
  // (New Task, and Agent Race) fails: `git branch --no-track <b> origin/main`
  // → "not a valid object name". Give the fixture a bare origin so it exercises
  // the SAME code path production does. A sibling bare repo, not a network.
  const originGit = path.join(
    path.dirname(fixture),
    path.basename(fixture) + "-origin.git",
  );
  let remotes = "";
  try {
    remotes = shOut("git remote", fixture);
  } catch {
    /* ignore */
  }
  if (!remotes.split(/\s+/).includes("origin")) {
    if (!existsSync(originGit)) sh(`git init --bare -q "${originGit}"`, fixture);
    sh(`git remote add origin "${originGit}"`, fixture);
    sh("git push -q origin main", fixture);
    // Set upstream so origin/main resolves without a network fetch.
    sh("git branch --set-upstream-to=origin/main main", fixture);
  }

  // 1b. Self-heal tracked fixture content. Specs that edit tracked files
  // (git dirty-tree, editor save) restore them in after(), but a crashed
  // or aborted run skips teardown and leaves the tree dirty; the git
  // spec asserts clean-at-boot and its "Git" tab match breaks on the
  // dirty-count badge. Tracked files only: untracked state (a spec's
  // .termic.yaml, task droppings) is owned and cleaned by the specs.
  // Unstage first: `checkout HEAD -- .` restores tracked paths but leaves
  // a file staged as NEW sitting in the index; reset demotes it to
  // untracked (spec-owned, like .termic.yaml). Then HEAD (not the bare
  // `-- .` index form): a run that crashed after staging leaves the dirt
  // in index AND worktree, where the index form is a no-op and the
  // clean-tree spec still boots red.
  try {
    sh("git reset -q HEAD -- .", fixture);
    sh("git checkout -q HEAD -- .", fixture);
  } catch {
    /* ignore */
  }

  // 2. An unopened `sbcheck` worktree (the import-worktree spec expects it).
  //
  // The dir lives under $HOME and is SHARED by every termic checkout's
  // fixture, so it can exist but belong to another checkout (its `.git`
  // file points at that checkout's fixture). Such a dir blocks
  // `worktree add` with "already exists" AND keeps this fixture's stale
  // registration alive (git only prunes when the dir is gone or
  // unreadable, verified: a foreign-owned dir is NOT prunable), which
  // used to skip the re-add entirely and leave the import-worktree spec
  // red forever, on whichever checkout lost the dir. Reclaim it: it is
  // throwaway derived state on both sides, and the losing checkout's
  // seed does the same reclaim right back on its next run.
  // Owned means the back-pointer names THIS fixture AND the admin dir it
  // points at still exists: a recreated .e2e (rm -rf, or this checkout
  // being a re-made task worktree) leaves the dir's .git naming our path
  // while the fixture no longer knows it, and treating that dangling
  // state as "ours" would skip the reclaim and leave `worktree add`
  // permanently blocked by the non-empty dir.
  const sbcheckOwnedHere = () => {
    try {
      const gitfile = readFileSync(path.join(sbcheck, ".git"), "utf8");
      const target = gitfile.replace(/^gitdir:\s*/, "").trim();
      return gitfile.includes(path.join(fixture, ".git")) && existsSync(target);
    } catch {
      return false;
    }
  };
  if (existsSync(sbcheck) && !sbcheckOwnedHere()) {
    rmSync(sbcheck, { recursive: true, force: true });
  }
  // With a foreign dir gone (or the dir deleted out from under git), the
  // leftover registration is now genuinely dangling; prune BEFORE listing
  // so the includes() check below reflects reality.
  try {
    sh("git worktree prune", fixture);
  } catch {
    /* ignore */
  }
  let worktrees = "";
  try {
    worktrees = shOut("git worktree list", fixture);
  } catch {
    /* ignore */
  }
  if (!worktrees.includes(sbcheck)) {
    mkdirSync(path.dirname(sbcheck), { recursive: true });
    try {
      sh(`git worktree add -q "${sbcheck}" -b sbcheck`, fixture);
    } catch {
      // -b fails when the branch survived a removed worktree; attach the
      // existing branch instead of seeding nothing. Guarded: seed() must
      // never hard-fail the whole suite over this fixture nicety, and a
      // missing sbcheck only reddens the one import spec.
      try {
        sh(`git worktree add -q "${sbcheck}" sbcheck`, fixture);
      } catch {
        /* leave it to the import spec to report */
      }
    }
  }

  // 3. Profile (settings + projects) from templates, paths filled in.
  mkdirSync(path.join(dataDir, "tasks"), { recursive: true });
  mkdirSync(tasksPath, { recursive: true });
  const fill = (s) =>
    s
      .replaceAll("__REPO__", repoRoot)
      .replaceAll("__HOME__", home)
      .replaceAll("__FIXTURE__", fixture)
      .replaceAll("__TASKS__", tasksPath);
  for (const f of ["settings.json", "projects.json"]) {
    writeFileSync(
      path.join(dataDir, f),
      fill(readFileSync(path.join(seedDir, f), "utf8")),
    );
  }
  return { dataDir, fixture, tasksPath, sbcheck };
}

// CLI: seed the default local profile.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = seed();
  console.log("e2e profile seeded at", r.dataDir);
}
