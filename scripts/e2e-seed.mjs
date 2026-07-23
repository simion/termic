#!/usr/bin/env node
// Seed the e2e fixture profile (.e2e/) from committed templates. The real
// profile is gitignored (machine-specific), so CI (and a fresh checkout) needs
// this to recreate a deterministic profile: a tiny fixture git repo + its
// `sbcheck` worktree, and a profile with the `fakeagent` CLI + fixture-repo
// project. Idempotent — safe to run repeatedly. See the `e2e` skill.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const e2e = path.join(repo, ".e2e");
const fixture = path.join(e2e, "fixture-repo");
const profile = path.join(e2e, "profile");
const seedDir = path.join(repo, "scripts", "e2e-seed");

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: "ignore" });
const shOut = (cmd, cwd) =>
  execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();

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
if (!worktrees.includes("sbcheck")) {
  const wt = path.join(home, "termic_dev", "workspaces", "fixture-repo", "sbcheck");
  mkdirSync(path.dirname(wt), { recursive: true });
  try {
    sh(`git worktree add -q "${wt}" -b sbcheck`, fixture);
  } catch {
    /* branch/dir may already exist */
  }
}

// 3. Profile (settings + projects) from templates, with paths filled in.
mkdirSync(path.join(profile, "tasks"), { recursive: true });
const fill = (s) =>
  s.replaceAll("__REPO__", repo).replaceAll("__HOME__", home);
for (const f of ["settings.json", "projects.json"]) {
  writeFileSync(
    path.join(profile, f),
    fill(readFileSync(path.join(seedDir, f), "utf8")),
  );
}

console.log("e2e profile seeded at", profile);
