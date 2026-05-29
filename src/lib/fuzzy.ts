// Sublime-style fuzzy matcher shared by the ⌘P file finder
// (FileFinderDialog) and the ⌘I context picker (ContextPickerDialog).
// Extracted verbatim so both pickers rank identically with one matcher to
// maintain.

export interface Scored {
  path: string;
  score: number;
  /** Indexes into `path` that matched a query char — for bolding. */
  matches: number[];
}

/**
 * Single-term match. Tries substring first (so "review" highlights the
 * full contiguous "Review", not scattered r-e-v-i-e-w chars greedily
 * picked from earlier in the path) — preferring occurrences inside the
 * basename and at word boundaries. Falls back to subsequence.
 */
export function matchTerm(
  s: string,
  lower: string,
  term: string,
  slash: number,
): { score: number; matches: number[] } | null {
  const t = term.toLowerCase();
  // Substring fast path: scan all occurrences, pick the best by
  // basename-ness + word-boundary-ness. Contiguous matches always beat
  // scattered subsequence matches (huge consecutive bonus below).
  let bestSubstr: { idx: number; score: number } | null = null;
  for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + 1)) {
    let sc = 100 + t.length * 9; // baseline: contiguous run of t.length chars
    const prev = i > 0 ? s[i - 1] : "/";
    if (prev === "/" || prev === "-" || prev === "_" || prev === ".") sc += 10;
    if (i > slash) sc += 8;
    sc -= i * 0.05; // mild earlier-is-better tiebreak
    if (!bestSubstr || sc > bestSubstr.score) bestSubstr = { idx: i, score: sc };
  }
  if (bestSubstr) {
    const matches: number[] = [];
    for (let i = 0; i < t.length; i++) matches.push(bestSubstr.idx + i);
    return { score: bestSubstr.score, matches };
  }
  // Subsequence fallback for typos / out-of-order chars.
  const matches: number[] = [];
  let qi = 0;
  let prevMatch = -2;
  let score = 0;
  for (let i = 0; i < lower.length && qi < t.length; i++) {
    if (lower[i] !== t[qi]) continue;
    matches.push(i);
    let bonus = 1;
    if (i === prevMatch + 1) bonus += 8;
    const prev = i > 0 ? s[i - 1] : "/";
    if (prev === "/" || prev === "-" || prev === "_" || prev === ".") bonus += 4;
    if (i > slash) bonus += 2;
    if (s[i] === term[qi]) bonus += 1;
    score += bonus;
    prevMatch = i;
    qi++;
  }
  if (qi < t.length) return null;
  return { score, matches };
}

/**
 * Fuzzy match. Splits the query on whitespace into AND-ed terms — every
 * term must subsequence-match (Sublime / fzf convention: "components
 * broa" finds files containing both). Each term gets its own independent
 * pass so the order/positions of terms don't have to line up.
 */
export function fuzzyScore(s: string, query: string): Scored | null {
  if (!query) return { path: s, score: 0, matches: [] };
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.length) return { path: s, score: 0, matches: [] };
  const lower = s.toLowerCase();
  const slash = s.lastIndexOf("/");
  const allMatches = new Set<number>();
  let total = 0;
  for (const t of terms) {
    const r = matchTerm(s, lower, t, slash);
    if (!r) return null;
    total += r.score;
    for (const m of r.matches) allMatches.add(m);
  }
  total -= s.length * 0.01;
  return { path: s, score: total, matches: [...allMatches].sort((a, b) => a - b) };
}
