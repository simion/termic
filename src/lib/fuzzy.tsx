// Shared Sublime/fzf-style fuzzy matcher + highlight component, used by the
// ⌘P file finder and the ⌘N project picker. Substring-first (so "review"
// highlights the contiguous "Review" rather than scattering chars), with
// word-boundary / basename boosts and a subsequence fallback for typos.

export interface FuzzyMatch {
  score: number;
  /** Indexes into the source string that matched a query char — for bolding. */
  matches: number[];
}

/**
 * Single-term match. Tries substring first — preferring occurrences inside the
 * basename (right of the last `slash`) and at word boundaries. Falls back to a
 * subsequence scan. `slash` is the index of the last path separator, or -1 for
 * strings without one (so every char counts as basename).
 */
function matchTerm(s: string, lower: string, term: string, slash: number): FuzzyMatch | null {
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
 * term must match (Sublime / fzf convention: "components broa" finds strings
 * containing both). Each term gets its own independent pass so the
 * order/positions of terms don't have to line up. Returns `{score:0,matches:[]}`
 * for an empty query so callers can treat "no filter" uniformly.
 */
export function fuzzyMatch(s: string, query: string): FuzzyMatch | null {
  if (!query) return { score: 0, matches: [] };
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 0, matches: [] };
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
  return { score: total, matches: [...allMatches].sort((a, b) => a - b) };
}

/** Bolds the matched character ranges within `text`. */
export function Highlighted({ text, matches }: { text: string; matches: number[] }) {
  if (!matches.length) return <>{text}</>;
  const set = new Set(matches);
  const out: React.ReactNode[] = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      if (buf) { out.push(buf); buf = ""; }
      out.push(<b key={i} className="text-[var(--color-accent)] font-semibold">{text[i]}</b>);
    } else {
      buf += text[i];
    }
  }
  if (buf) out.push(buf);
  return <>{out}</>;
}
