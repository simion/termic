# termic-server builds

`scripts/build-termic-server.mjs` puts the `termic-server` builds here
(`termic-server-<target triple>`: Linux musl x86_64 and aarch64, macOS
aarch64 and x86_64), and the release workflow fetches them before `tauri
build`, which bundles this folder. Settings > Remote > Add a server
installs the one matching the server (`remote_client::find_binary`).

The builds are not committed. This file keeps the folder, so a local build
without them still bundles; Install then reports that this Termic has no
build for that system.

`termic-server-version.txt` is the version those builds carry (the app's,
plus a hash of the server's sources). The app compares it with what a
server reports on connect and replaces a different build
(`remote_client::auto_upgrade`, docs/remote.md).
