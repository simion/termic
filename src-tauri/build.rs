use std::path::PathBuf;
use std::process::Command;

fn main() {
    build_cli_sidecar();
    tauri_build::build()
}

/// Build the `termic-cli` sidecar BEFORE tauri_build runs: tauri-build
/// hard-errors when a configured `externalBin` file is missing, and it
/// runs on every `cargo check` / `cargo test` / `tauri dev` / `tauri
/// build` of this crate, so the sidecar has to exist for all of them.
/// Building it here (instead of a wrapper script) keeps plain cargo
/// workflows green with zero extra steps.
///
/// The nested cargo build uses its OWN target dir (`target/cli-sidecar`)
/// because the outer cargo holds a lock on the shared one; same-dir
/// nesting deadlocks. The universal-macOS bundle case (both arches +
/// lipo) is handled by scripts/build-cli.mjs in beforeBuildCommand,
/// which runs unconditionally at bundle time; this hook covers every
/// per-triple compile, including each arch pass of a universal build.
fn build_cli_sidecar() {
    // Rebuild the sidecar when the CLI crates change. Directory entries
    // are watched recursively by cargo.
    println!("cargo:rerun-if-changed=../termic-cli/src");
    println!("cargo:rerun-if-changed=../termic-cli/Cargo.toml");
    println!("cargo:rerun-if-changed=../termic-proto/src");
    println!("cargo:rerun-if-changed=../termic-proto/Cargo.toml");

    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let sidecar_target_dir = manifest_dir.join("target").join("cli-sidecar");
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());

    // Build the sidecar in the SAME profile as the app so a debug
    // `cargo check` / `make check` / `tauri dev` doesn't trigger a full
    // release codegen of the CLI (clap+serde). The dev app gets a debug
    // sidecar (which is what it wants anyway); a release `tauri build`
    // gets a release one, matching scripts/build-cli.mjs.
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    let profile_dir = if release { "release" } else { "debug" };
    let mut args: Vec<&str> = vec!["build", "-p", "termic-cli", "--target", &target];
    if release {
        args.push("--release");
    }
    args.extend(["--target-dir", sidecar_target_dir.to_str().expect("utf-8 target dir")]);

    let status = Command::new(&cargo)
        .current_dir(&manifest_dir)
        .args(&args)
        // Version the bundled CLI with the app: `termic --version` reads
        // this at compile time (termic-cli reads TERMIC_APP_VERSION via
        // option_env!). env!("CARGO_PKG_VERSION") here is the APP crate's
        // version. Kept in sync with scripts/build-cli.mjs, which sets the
        // same var for the `tauri build` sidecar.
        .env("TERMIC_APP_VERSION", env!("CARGO_PKG_VERSION"))
        // The outer build's target-dir override must not leak into the
        // nested build (it would recreate the lock deadlock), and the
        // jobserver env from make/cargo confuses a nested cargo.
        .env_remove("CARGO_TARGET_DIR")
        .env_remove("MAKEFLAGS")
        .env_remove("CARGO_MAKEFLAGS")
        .env_remove("MFLAGS")
        .status()
        .expect("failed to spawn cargo for the termic-cli sidecar");
    assert!(status.success(), "building the termic-cli sidecar failed");

    let built = sidecar_target_dir.join(&target).join(profile_dir).join("termic-cli");
    let binaries = manifest_dir.join("binaries");
    std::fs::create_dir_all(&binaries).expect("create src-tauri/binaries");
    let dest = binaries.join(format!("termic-cli-{target}"));
    std::fs::copy(&built, &dest)
        .unwrap_or_else(|e| panic!("copy {} -> {}: {e}", built.display(), dest.display()));

    // Universal-macOS convenience: once both arch sidecars exist, lipo
    // them so a `--target universal-apple-darwin` bundle finds its file
    // even without the beforeBuildCommand hook.
    if target.ends_with("-apple-darwin") {
        let a = binaries.join("termic-cli-aarch64-apple-darwin");
        let x = binaries.join("termic-cli-x86_64-apple-darwin");
        let u = binaries.join("termic-cli-universal-apple-darwin");
        if a.exists() && x.exists() {
            let ok = Command::new("lipo")
                .args(["-create", "-output"])
                .args([&u, &a, &x])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !ok {
                println!("cargo:warning=lipo of the universal termic-cli sidecar failed");
            }
        }
    }
}
