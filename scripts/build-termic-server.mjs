#!/usr/bin/env node
// Builds the termic-server binaries the app installs on a server
// (docs/remote.md, "Servers") into src-tauri/resources/termic-server/, which
// tauri.conf.json bundles. The name of each is `termic-server-<triple>`, what
// remote_client::find_binary looks for.
//
// - Linux: static musl builds, so one file runs on any distribution, for
//   x86_64 and aarch64 (a home box or a cloud machine). Cross-compiled with
//   cargo-zigbuild (zig as the linker), so this works on a Linux CI runner
//   and on a Mac. Needs rustup with the targets, `cargo install
//   cargo-zigbuild`, and zig on PATH.
// - macOS: aarch64 and x86_64 (a Mac mini as a server), plain cargo, so
//   only on a Mac (Apple's SDK). The release signs them before bundling.
//
//   node scripts/build-termic-server.mjs            # every target this host can build
//   node scripts/build-termic-server.mjs linux      # by OS...
//   node scripts/build-termic-server.mjs aarch64    # ...or by arch (or a whole triple)
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "src-tauri", "resources", "termic-server");
const linux = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"];
const mac = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
const all = process.platform === "darwin" ? [...linux, ...mac] : linux;
const want = process.argv.slice(2);
const targets = want.length ? all.filter((t) => want.some((w) => t.includes(w))) : all;
if (!targets.length) {
  console.error(`no target matches ${want.join(" ")}; this host builds: ${all.join(", ")}`);
  process.exit(2);
}

mkdirSync(out, { recursive: true });

// The build's version: the app's, plus a hash of every source file the
// server is built from, so two builds of unchanged code match and the app
// never restarts a server for nothing (remote_client::auto_upgrade). Baked
// in (termic-server util::VERSION) and written next to the builds, where
// the app reads it: it cannot run a Linux build to ask.
const appVersion = readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)[1];
const sources = execFileSync("git", ["ls-files", "termic-server", "termic-remote", "termic-proto", "src-tauri/Cargo.lock"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean).sort();
const h = createHash("sha256");
for (const f of sources) h.update(f).update("\0").update(readFileSync(path.join(root, f))).update("\0");
const version = `${appVersion}+${h.digest("hex").slice(0, 12)}`;
writeFileSync(path.join(out, "termic-server-version.txt"), version + "\n");
console.log(`termic-server ${version}`);
for (const target of targets) {
  console.log(`→ termic-server for ${target}`);
  const darwin = target.endsWith("-apple-darwin");
  execFileSync(
    "cargo",
    [darwin ? "build" : "zigbuild", "--release", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml"), "-p", "termic-server", "--target", target],
    { stdio: "inherit", env: { ...process.env, TERMIC_SERVER_VERSION: version } },
  );
  const built = path.join(root, "src-tauri", "target", target, "release", "termic-server");
  const dest = path.join(out, `termic-server-${target}`);
  copyFileSync(built, dest);
  chmodSync(dest, 0o755);
  console.log(`  ${path.relative(root, dest)}`);
}
