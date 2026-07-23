fn main() {
    // `termic --version` reports the APP version, injected via
    // TERMIC_APP_VERSION by src-tauri/build.rs and scripts/build-cli.mjs so
    // the bundled CLI is versioned with the app it ships in. Track the env
    // var so a version bump rebuilds the CLI with the new value; without a
    // value set, the crate version is the dev fallback.
    println!("cargo:rerun-if-env-changed=TERMIC_APP_VERSION");
}
