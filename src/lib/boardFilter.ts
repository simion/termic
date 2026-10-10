// Kanban filter bar (docs/ui.md "Kanban view" > Filtering): a GitHub
// Projects style query over the board's cards.
//
//   login bug                  free text, every word must match
//   project:termic agent:claude  qualifiers AND together
//   agent:claude,codex         comma ORs inside one qualifier
//   -status:settled            leading `-` negates
//   project:"my repo"          quotes keep spaces in a value
//
// Pure and hook-free like taskBoardState.ts: BoardView parses once per query
// change and runs `boardTaskMatches` per card. Free text goes through the
// sidebar filter's `taskMatchesText` (GH #324), so everything the sidebar
// filter matches (name, stable tab titles, tab property values) matches here
// too. The board also matches the branch, which the sidebar does not.

import { effectiveSandboxMode, isSandboxEnforced, type Agent, type PrLookup, type Project, type Task } from "./types";
import { agentDisplayName } from "./agents";
import { taskMatchesText, type TaskFilterFacts } from "./taskFilter";
import { BOARD_STATE_COLUMNS, hasPrIdentity, type BoardColumn } from "./taskBoardState";
import { groupOf } from "./projectGroups";
import { fuzzyMatch } from "./fuzzy";

/** Canonical qualifier keys. Aliases fold into these at parse time. */
const BOARD_QUALIFIERS = [
  "project", "group", "agent", "status", "branch", "base", "pr", "checks", "is", "has", "no",
] as const;
export type BoardQualifier = (typeof BOARD_QUALIFIERS)[number];

const ALIASES: Record<string, BoardQualifier> = { repo: "project", column: "status" };

/** Everything a user can type before the colon, canonical keys first:
 *  the pending-negation rule and key completion both offer aliases too. */
const TYPABLE_KEYS: readonly string[] = [...BOARD_QUALIFIERS, ...Object.keys(ALIASES)];

/** A negation still being typed: `-`, or `-a`, `-re`, ... on the way to a
 *  key. Excluding every card holding "a" would blank the board a keystroke
 *  at a time. */
function pendingNegation(tok: string): boolean {
  if (tok === "-") return true;
  if (!tok.startsWith("-") || tok.includes(":")) return false;
  const body = tok.slice(1).toLowerCase();
  return TYPABLE_KEYS.some(k => k.startsWith(body));
}

/** A typed key (any case) to its qualifier, or undefined. Own-property
 *  lookups only: `constructor:` must read as an unknown key, not resolve
 *  through Object.prototype. */
function resolveKey(raw: string): BoardQualifier | undefined {
  const k = raw.toLowerCase();
  if ((BOARD_QUALIFIERS as readonly string[]).includes(k)) return k as BoardQualifier;
  return Object.hasOwn(ALIASES, k) ? ALIASES[k] : undefined;
}

/** Closed value sets. Keys missing here take free values (project names,
 *  agents, branches) that the caller supplies for autocomplete. */
const BOARD_ENUM_VALUES: Partial<Record<BoardQualifier, readonly string[]>> = {
  // `done` is not a column: it is the row's blue dot (a turn finished,
  // unseen), an overlay on whichever column the task sits in. See
  // BoardMatchCtx.done.
  status: [...BOARD_STATE_COLUMNS, "archived", "done"],
  pr: ["open", "draft", "merged", "closed", "none"],
  checks: ["passing", "failing", "pending", "none"],
  is: ["main", "worktree", "yolo", "docker", "sandboxed", "multi", "archived"],
  has: ["pr", "changes"],
  no: ["pr", "changes"],
};

export interface BoardClause {
  key: BoardQualifier;
  /** Lower-cased, unquoted. Any one matching satisfies the clause. */
  values: string[];
  negated: boolean;
}

export interface BoardTerm {
  /** Lower-cased, unquoted. */
  text: string;
  negated: boolean;
}

export interface BoardQuery {
  terms: BoardTerm[];
  clauses: BoardClause[];
  /** Raw `key:` prefixes that named no qualifier. They still match as free
   *  text; the bar marks them so a typo does not silently look like a rule. */
  unknownKeys: string[];
}

export function isBoardQueryActive(q: BoardQuery): boolean {
  return q.terms.length > 0 || q.clauses.length > 0;
}

/** Whether any clause uses `key`. BoardView widens a subscription only
 *  while the query actually reads it (`checks:`, `has:changes`). */
export function boardQueryUses(q: BoardQuery, key: BoardQualifier, value?: string): boolean {
  const v = value?.toLowerCase();
  return q.clauses.some(c => c.key === key && (v === undefined || c.values.includes(v)));
}

/** Split on whitespace outside double quotes. Quotes stay in the token so
 *  the value splitter can tell `"a,b"` from `a,b`. An unterminated quote runs
 *  to the end of the input, which is what a user mid-typing means. */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of input) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Comma-split outside quotes, quotes removed, case KEPT: rewriting a token
 *  should not lower-case the values the user typed next to the one changed. */
function rawValues(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of raw) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

/** Comma-split outside quotes, quotes removed, lower-cased. Empty pieces
 *  drop, so a trailing comma while typing (`agent:claude,`) is not a value. */
function splitValues(raw: string): string[] {
  return rawValues(raw).map(v => v.toLowerCase());
}

const KEY_RE = /^([a-zA-Z]+):(.*)$/;

export function parseBoardQuery(input: string): BoardQuery {
  const q: BoardQuery = { terms: [], clauses: [], unknownKeys: [] };
  const toks = tokenize(input);
  const typing = !/\s$/.test(input);
  for (const [i, tok] of toks.entries()) {
    // A bare `-` is a negation still being typed, not a search for dashes.
    if (tok === "-") continue;
    const negated = tok.length > 1 && tok.startsWith("-");
    const body = negated ? tok.slice(1) : tok;
    // `-a`, `-ag`, `-re` ... on the way to a key. A trailing space commits
    // it as text.
    if (typing && i === toks.length - 1 && pendingNegation(tok)) continue;
    const m = KEY_RE.exec(body);
    if (m) {
      const key = resolveKey(m[1]);
      if (key) {
        const values = splitValues(m[2]);
        // `project:` with nothing after it yet: still typing, filter nothing.
        if (values.length) q.clauses.push({ key, values, negated });
        continue;
      }
      // `https://...` or `C:\...` is text with a colon in it, not a typo'd
      // qualifier, so it earns no warning.
      const k = m[1].toLowerCase();
      if (!/^[/\\]/.test(m[2]) && !q.unknownKeys.includes(k)) q.unknownKeys.push(k);
    }
    const text = body.replace(/"/g, "").trim().toLowerCase();
    if (text) q.terms.push({ text, negated });
  }
  return q;
}

/** Everything one card's match reads besides the task itself. */
export interface BoardMatchCtx {
  project: Project | undefined;
  column: BoardColumn | undefined;
  /** The task shows the done dot: a turn finished and nobody has looked.
   *  `status:done` matches on this and nothing else, so it cuts across the
   *  columns (such a task is in settled, or in review with a PR). Session
   *  state: it does not survive a restart, exactly like the dot. */
  done?: boolean;
  /** The live PR poll result, null when nothing has been fetched. */
  pr: PrLookup | null;
  /** From the diffStat store: null = not measured, which matches neither
   *  `has:changes` nor `no:changes` (unknown is not "no"). */
  changed: boolean | null;
  facts: TaskFilterFacts | undefined;
  agents: Agent[];
}

/** PR state for `pr:`. Behind the review column's own gate
 *  (`hasPrIdentity`), and an identity with no poll yet reads as open, the
 *  same optimism that column applies. */
function prState(task: Task, pr: PrLookup | null): string {
  if (!hasPrIdentity(task)) return "none";
  // Archived tasks are never polled, so the optimism above would call a PR
  // merged months ago open. Unknown matches no `pr:` value.
  if (task.archived && !pr?.pr) return "unknown";
  return pr?.pr?.state ?? "open";
}

function hasFlag(task: Task, ctx: BoardMatchCtx, v: string): boolean | null {
  switch (v) {
    case "pr": return prState(task, ctx.pr) !== "none";
    case "changes": return ctx.changed;
    // Unknown, not false: `no:typo` must not match every card.
    default: return null;
  }
}

function clauseValueMatches(task: Task, ctx: BoardMatchCtx, key: BoardQualifier, v: string): boolean {
  switch (key) {
    case "project": {
      if (ctx.project?.name.toLowerCase() === v) return true;
      // Multi-repo: a member's directory names the repo inside the task.
      return (task.composition ?? []).some(m => m.dir_name.toLowerCase() === v);
    }
    // groupOf, the sidebar's normalization, so `"Work "` and `WORK` are one group.
    case "group": return !!ctx.project && groupOf(ctx.project).toLowerCase() === v;
    case "agent":
      return task.cli.toLowerCase() === v || agentDisplayName(task.cli, ctx.agents).toLowerCase() === v;
    case "status": return v === "done" ? !!ctx.done : ctx.column === v;
    case "branch": return task.branch.toLowerCase().includes(v);
    case "base": return task.base_branch.toLowerCase().includes(v);
    case "pr": return prState(task, ctx.pr) === v;
    case "checks": return (ctx.pr?.pr?.checks ?? "none") === v;
    case "is":
      switch (v) {
        case "main": return !!task.is_main_checkout;
        case "worktree": return !task.is_main_checkout;
        case "yolo": return !!task.yolo;
        case "docker": return !!task.docker_sandbox_enabled;
        case "sandboxed": return !task.docker_sandbox_enabled && isSandboxEnforced(effectiveSandboxMode(task));
        case "multi": return (task.composition?.length ?? 0) > 0;
        case "archived": return task.archived;
        default: return false;
      }
    case "has": return hasFlag(task, ctx, v) === true;
    case "no": return hasFlag(task, ctx, v) === false;
  }
}

export function boardTaskMatches(task: Task, ctx: BoardMatchCtx, q: BoardQuery): boolean {
  for (const c of q.clauses) {
    const hit = c.values.some(v => clauseValueMatches(task, ctx, c.key, v));
    if (hit === c.negated) return false;
  }
  for (const t of q.terms) {
    const hit = taskMatchesText(task, ctx.facts, ctx.agents, t.text)
      || task.branch.toLowerCase().includes(t.text);
    if (hit === t.negated) return false;
  }
  return true;
}

/** `q` without its clauses on `key`. The status chips count their column
 *  under the REST of the query, so turning one chip on does not zero the
 *  others. */
export function dropBoardClauses(q: BoardQuery, key: BoardQualifier): BoardQuery {
  return { ...q, clauses: q.clauses.filter(c => c.key !== key) };
}

// ── Query text editing ──────────────────────────────────────────────────

const quote = (v: string) => (/[\s,"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);

export type BoardClauseState = "include" | "exclude" | null;

/** How `key:value` stands in the query right now. Exclude wins a tie: a
 *  value both included and excluded matches nothing, and the exclusion is
 *  the part that says so. */
export function boardClauseState(q: BoardQuery, key: BoardQualifier, value: string): BoardClauseState {
  const v = value.toLowerCase();
  const held = q.clauses.filter(c => c.key === key && c.values.includes(v));
  if (held.some(c => c.negated)) return "exclude";
  return held.length ? "include" : null;
}

/** Put `key:value` into the query in `state`: included, excluded, or not at
 *  all. Edits the TEXT, so the bar stays the single source of truth and the
 *  user sees exactly what a click did. The value leaves every token of that
 *  key first; then, if it stays, it joins an existing token of the same key
 *  and sign (`project:a` + b -> `project:a,b`, the way GitHub writes it) or
 *  starts a new one at the end. */
export function setBoardClause(input: string, key: BoardQualifier, value: string, state: BoardClauseState): string {
  const want = value.toLowerCase();
  const kept: string[] = [];
  // Index into `kept` of the first token of this key and sign, to merge into.
  const home: Record<"include" | "exclude", number> = { include: -1, exclude: -1 };
  const toks = tokenize(input);
  // A trailing `-ag` filters nothing only while it is the LAST token. The
  // clause this click appends would push it into the middle, where it turns
  // into an exclusion of every card holding "ag", so it goes.
  if (toks.length && !/\s$/.test(input) && pendingNegation(toks[toks.length - 1])) toks.pop();
  for (const tok of toks) {
    const neg = tok.length > 1 && tok.startsWith("-");
    const m = KEY_RE.exec(neg ? tok.slice(1) : tok);
    const k = m ? resolveKey(m[1]) : undefined;
    if (!m || k !== key) { kept.push(tok); continue; }
    const vals = rawValues(m[2]);
    const rest = vals.filter(v => v.toLowerCase() !== want);
    // The token held only this value, or nothing yet (`project:` mid-typing,
    // which a click completes rather than leaving a stray key behind).
    if (rest.length === 0) continue;
    const sign = neg ? "exclude" : "include";
    if (home[sign] === -1) home[sign] = kept.length;
    kept.push(rest.length === vals.length ? tok : `${neg ? "-" : ""}${m[1]}:${rest.map(quote).join(",")}`);
  }
  if (state) {
    const at = home[state];
    if (at === -1) kept.push(`${state === "exclude" ? "-" : ""}${key}:${quote(value)}`);
    else kept[at] = `${kept[at]},${quote(value)}`;
  }
  return kept.join(" ");
}

/** Click-to-filter on a lane divider or project header: in, or back out. */
export function toggleBoardClause(input: string, key: BoardQualifier, value: string): string {
  const state = boardClauseState(parseBoardQuery(input), key, value);
  return setBoardClause(input, key, value, state === "include" ? null : "include");
}

/** The filter menu's chip cycle: off -> include -> exclude -> off. */
export function cycleBoardClause(input: string, key: BoardQualifier, value: string): string {
  const state = boardClauseState(parseBoardQuery(input), key, value);
  return setBoardClause(input, key, value, state === null ? "include" : state === "include" ? "exclude" : null);
}

/** Strip all clauses on `key` from the query text, leaving other keys and free text. */
export function stripBoardKey(input: string, key: BoardQualifier): string {
  const kept: string[] = [];
  const toks = tokenize(input);
  if (toks.length && !/\s$/.test(input) && pendingNegation(toks[toks.length - 1])) toks.pop();
  for (const tok of toks) {
    const neg = tok.length > 1 && tok.startsWith("-");
    const m = KEY_RE.exec(neg ? tok.slice(1) : tok);
    const k = m ? resolveKey(m[1]) : undefined;
    if (m && k === key) continue;
    kept.push(tok);
  }
  return kept.join(" ");
}

// ── Autocomplete ────────────────────────────────────────────────────────

export interface BoardSuggestion {
  /** What the row shows. */
  label: string;
  /** The full query text after picking it. */
  next: string;
  /** Highlight indexes into `label`. */
  matches: number[];
}

/** Suggestions for the token being typed at the END of `input` (the bar
 *  only completes at the end, which is where a query is typed). A bare word
 *  offers qualifier keys; `key:partial` offers that key's values from
 *  `valuesFor`, ranked by fuzzyMatch, the palettes' matcher. */
export function boardSuggestions(
  input: string,
  valuesFor: (key: BoardQualifier) => readonly string[],
  limit = 8,
): BoardSuggestion[] {
  if (input === "" || /\s$/.test(input)) return [];
  const toks = tokenize(input);
  const last = toks[toks.length - 1] ?? "";
  const head = input.slice(0, input.length - last.length);
  const neg = last.startsWith("-") ? "-" : "";
  const body = last.slice(neg.length);
  const m = KEY_RE.exec(body);

  if (!m) {
    if (!body) return [];
    return TYPABLE_KEYS
      // An exact key stays offered (`pr` completes to `pr:`), and sorts first.
      .filter(k => k.startsWith(body.toLowerCase()))
      .sort((a, b) => Number(b === body.toLowerCase()) - Number(a === body.toLowerCase()))
      .map(k => ({ label: `${k}:`, next: `${head}${neg}${k}:`, matches: [...body].map((_, i) => i) }));
  }

  const key = resolveKey(m[1]);
  if (!key) return [];
  // Complete the value after the last comma; the ones before it stay.
  const lastComma = m[2].lastIndexOf(",");
  const done = lastComma === -1 ? "" : m[2].slice(0, lastComma + 1);
  const partial = m[2].slice(lastComma + 1).replace(/"/g, "");
  const already = new Set(splitValues(done));
  const pool = [...new Set(BOARD_ENUM_VALUES[key] ?? valuesFor(key))]
    .filter(v => !already.has(v.toLowerCase()));
  const ranked = partial
    ? pool.flatMap(v => {
        const fm = fuzzyMatch(v, partial);
        return fm ? [{ v, fm }] : [];
      }).sort((a, b) => b.fm.score - a.fm.score)
    : pool.map(v => ({ v, fm: { score: 0, matches: [] as number[] } }));
  const exact = partial.toLowerCase();
  return ranked
    // A value typed in full stays offered, first, the way an exact key is:
    // dropping it left Enter to pick the next row, so `project:acme` +
    // Enter silently became `project:acme-web`.
    .sort((a, b) => Number(b.v.toLowerCase() === exact) - Number(a.v.toLowerCase() === exact))
    .slice(0, limit)
    .map(({ v, fm }) => ({
      label: v,
      next: `${head}${neg}${m[1]}:${done}${quote(v)} `,
      matches: fm.matches,
    }));
}
