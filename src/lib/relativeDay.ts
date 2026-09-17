// One ladder shared by History and the dashboard's task age, so the two
// never disagree about what "3 weeks ago" means. Extracted from
// `groupLabel()` in History.tsx: same buckets, same wording, now callable
// from anywhere that needs to talk about a date relative to now.

/**
 * Today / Yesterday / `N days ago` / Last week / `N weeks ago` / month+year,
 * for a timestamp against `now`. Identical output to History's original
 * `groupLabel()`.
 */
export function relativeDayLabel(iso: string, now: number = Date.now()): string {
  const diffDays = daysSince(iso, now);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7)  return `${diffDays} days ago`;
  if (diffDays < 14) return "Last week";
  if (diffDays < 21) return "2 weeks ago";
  if (diffDays < 28) return "3 weeks ago";
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(iso));
}

/**
 * Whole 24h buckets between `iso` and `now`, floored. These are NOT calendar
 * days (a timestamp from 11pm yesterday and one from 1am today can land in
 * the same bucket, or a different one, depending on the hour `now` falls
 * on), but History has always worked this way and nothing downstream expects
 * calendar-day boundaries.
 */
export function daysSince(iso: string, now: number = Date.now()): number {
  return Math.floor((now - new Date(iso).getTime()) / 86_400_000);
}
