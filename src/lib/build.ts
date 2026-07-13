// What kind of build am I? Set at compile time by `make beta`, which produces
// "Termic Beta.app" (own identifier + icon) from the current branch and
// installs it alongside the shipped app, sharing the production data dir.
//
// Two consumers: UpdaterBanner (paints the BETA pill) and store/update.ts
// (skips the self-update probe, which would overwrite this bundle with a
// shipped build).

/** True in a `make beta` bundle. Statically false everywhere else, so the
 *  beta-only branches are dead-code-eliminated from shipped builds. */
export function isBetaBuild(): boolean {
  return (
    import.meta.env.VITE_BETA === "1" || import.meta.env.VITE_BETA === "true"
  );
}

/** Provenance of a beta build: "branch@sha", with a trailing "+" when the tree
 *  was dirty at build time. Empty when not a beta (or built outside git). */
export function betaInfo(): string {
  return String(import.meta.env.VITE_BETA_INFO ?? "");
}
