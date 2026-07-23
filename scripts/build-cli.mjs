#!/usr/bin/env node
// Stage the `termic-cli` sidecar into src-tauri/binaries/ for whatever
// triple `tauri build` is about to bundle. Runs from beforeBuildCommand.
//
// src-tauri/build.rs already produces the per-triple sidecar during every
// plain cargo compile (and lipos the universal one when both arch files
// exist). This hook is the belt-and-braces for `tauri build`, which does
// NOT reliably expose the requested --target to beforeBuildCommand: rather
// than guess, we build every macOS arch whose rustc target is installed
// (plus the host triple) and lipo the universal fat binary when both mac
// arches are present. Whatever triple tauri then asks tauri-build for,
// aarch64 / x86_64 / universal, the file is already there.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcTauri = resolve(root, "src-tauri");
const binaries = resolve(srcTauri, "binaries");
const targetDir = resolve(srcTauri, "target", "cli-sidecar");

// Version the bundled CLI with the app (see src-tauri/build.rs for the
// matching injection). termic-cli reads TERMIC_APP_VERSION via option_env!,
// so `termic --version` prints the app version rather than the crate one.
const appVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    stdio: "inherit",
    cwd: srcTauri,
    ...opts,
    env: { ...process.env, TERMIC_APP_VERSION: appVersion, ...(opts.env ?? {}) },
  });

const capture = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", cwd: srcTauri });

const hostTriple = () => {
  const m = capture("rustc", ["-vV"]).match(/^host: (.+)$/m);
  if (!m) throw new Error("cannot determine host triple from rustc -vV");
  return m[1].trim();
};

const installedTargets = () => {
  try {
    return new Set(capture("rustup", ["target", "list", "--installed"]).split(/\r?\n/).filter(Boolean));
  } catch {
    return new Set(); // no rustup (e.g. rustc-only) - host triple still builds
  }
};

const buildOne = (triple) => {
  run("cargo", [
    "build", "--release", "-p", "termic-cli",
    "--target", triple, "--target-dir", targetDir,
  ]);
  const built = resolve(targetDir, triple, "release", "termic-cli");
  const dest = resolve(binaries, `termic-cli-${triple}`);
  copyFileSync(built, dest);
  console.log(`sidecar: ${dest}`);
  return dest;
};

mkdirSync(binaries, { recursive: true });

const host = hostTriple();
const targets = new Set([host]);

if (platform() === "darwin") {
  // Build whichever mac arches are installed so a universal bundle finds
  // both halves; the host arch is always buildable.
  const installed = installedTargets();
  const arches = ["aarch64-apple-darwin", "x86_64-apple-darwin"].filter(
    (t) => t === host || installed.has(t),
  );
  arches.forEach((t) => targets.add(t));
  targets.forEach(buildOne);
  const a = resolve(binaries, "termic-cli-aarch64-apple-darwin");
  const x = resolve(binaries, "termic-cli-x86_64-apple-darwin");
  if (arches.includes("aarch64-apple-darwin") && arches.includes("x86_64-apple-darwin")) {
    const u = resolve(binaries, "termic-cli-universal-apple-darwin");
    run("lipo", ["-create", "-output", u, a, x]);
    console.log(`sidecar (universal): ${u}`);
  } else {
    console.log(
      "note: only one macOS arch installed; skipping the universal sidecar " +
        "(a universal `tauri build` needs both aarch64 and x86_64 rustup targets).",
    );
  }
} else {
  buildOne(host);
}
