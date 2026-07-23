#!/usr/bin/env node
// Seed an e2e fixture profile from committed templates (scripts/e2e-seed/*).
// The real profile is gitignored, so CI + fresh checkouts recreate it here.
// Exposed as seed(opts) so wdio.conf can seed an ISOLATED profile per parallel
// worker (own data dir + fixture repo + tasks/worktree base). Idempotent.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const seedDir = path.join(scriptDir, "e2e-seed");

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

  // 2. An unopened `sbcheck` worktree (the import-worktree spec expects it).
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
      /* already exists */
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
