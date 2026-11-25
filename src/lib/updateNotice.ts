// What the update card says about a release besides its summary: what kind
// of step it is from the running version, and when it shipped. A patch
// merge reuses its release's changelog entry, so two updates in a day read
// the same summary; the version, its age and a "Patch" label are what tell
// them apart.

import { cmpVersion } from "@/store/update";

export type ReleaseKind = "patch" | "minor" | "major";

/** The step from `current` to `next`: a patch keeps major.minor. */
export function releaseKind(current: string | null | undefined, next: string): ReleaseKind {
  const [a, b] = [current ?? "", next].map(v => v.replace(/^v/, "").split(/[.-]/).map(n => Number(n) || 0));
  if (a[0] !== b[0]) return "major";
  if (a[1] !== b[1]) return "minor";
  return cmpVersion(next, current ?? "0") > 0 ? "patch" : "minor";
}

/** "2 hours ago", "yesterday", in the UI's language. A bare date
 *  ("2026-11-25", what the changelog carries) counts in days. */
export function releasedAgo(when: string | undefined, now: number, lang: string): string | null {
  if (!when) return null;
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(when);
  const t = Date.parse(dayOnly ? `${when}T00:00:00` : when);
  if (Number.isNaN(t)) return null;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const s = Math.max(0, (now - t) / 1000);
  if (dayOnly) {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    return rtf.format(-Math.max(0, Math.round((today.getTime() - t) / 86_400_000)), "day");
  }
  if (s < 60) return rtf.format(0, "second");
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86_400) return rtf.format(-Math.floor(s / 3600), "hour");
  return rtf.format(-Math.floor(s / 86_400), "day");
}
