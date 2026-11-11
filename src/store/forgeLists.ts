// Forge issue and PR lists, cached per query and shared by every reader: the
// Todos view, the New Task dialog's pickers and Review PR's waiting list.
// One bounded queue for the CLI subprocesses, at most one fetch in flight per
// query, and a snapshot of the last good answers so a relaunch paints them
// while the next fetch runs. Does NOT write to useApp (docs/performance.md
// bear traps 5 and 8).
//
// Readers outside the Todos view use `getState()` and the returned promise,
// never a subscription: every landed query writes `entries`, and the New
// Task dialog re-rendering on a Todos fetch would be pure waste.

import { create } from "zustand";
import { useApp } from "@/store/app";
import { projectForgeIssues, projectForgeLists, projectForgePrs } from "@/lib/ipc";
import { scoped } from "@/lib/profileScope";
import { BODY_MAX as ISSUE_BODY_MAX, cleanIssueText } from "@/lib/issuePrompt";
import { BODY_MAX as PR_BODY_MAX, cleanPrText } from "@/lib/prReview";
import type { ForgeIssue, ForgePr, IssueLookup, IssueScope, PrPickList, PrScope } from "@/lib/types";

export type IssueListQuery = { projectId: string; kind: "issues"; scope: IssueScope; limit?: number };
export type PrListQuery = { projectId: string; kind: "prs"; scope: PrScope; limit?: number };
export type ForgeListQuery = IssueListQuery | PrListQuery;
export type ForgeListAnswer = IssueLookup | PrPickList;

export interface ForgeListEntry {
  query: ForgeListQuery;
  status: "loading" | "ok" | "error" | "unsupported";
  /** The last ok answer. Kept through a failed refresh, so a forge that
   *  stops answering leaves the rows it last gave on screen. */
  ok: ForgeListAnswer | null;
  /** When `ok` was fetched. 0 = never. */
  okAt: number;
  /** When the last fetch finished, ok or not. The TTL counts from here, so a
   *  failure is not re-run on every filter change. 0 = never finished. */
  fetchedAt: number;
  errorMessage?: string;
}

export const FORGE_LIST_TTL_MS = 2 * 60 * 1000;
export const MAX_CONCURRENT_FETCHES = 3;
/** What project_forge_issues and project_forge_prs use for a missing limit
 *  (lib.rs), so a bare call and an explicit default are ONE query. */
export const ISSUE_LIMIT_DEFAULT = 50;
export const PR_LIMIT_DEFAULT = 30;

const limitOf = (q: ForgeListQuery) =>
  q.limit ?? (q.kind === "issues" ? ISSUE_LIMIT_DEFAULT : PR_LIMIT_DEFAULT);

export function forgeListKey(q: ForgeListQuery): string {
  return `${q.projectId}:${q.kind}:${q.scope}:${limitOf(q)}`;
}

interface ForgeListsState {
  entries: Record<string, ForgeListEntry>;
}

// ── launch snapshot ──
//
// localStorage is one quota per origin, shared by every key and every
// profile window, and every write in the app swallows a quota error. So a
// snapshot that grew without bound would not fail here: it would silently
// stop some unrelated preference from saving. Hence a hard budget, measured
// on the serialized text, filled with the personal lists first.

const LS_FORGE_LISTS = scoped("forgeListSnapshot");
export const SNAPSHOT_BUDGET_CHARS = 256 * 1024;

const ISSUE_SCOPES: readonly string[] = ["all", "assigned", "mentions"];
const PR_SCOPES: readonly string[] = ["mine", "review", "open"];
/** Lists about the user rather than the whole repo: what the snapshot keeps
 *  first when the budget runs out. */
const PERSONAL_SCOPES: readonly string[] = ["assigned", "mentions", "mine", "review"];

/** A body cut for the snapshot so the prompt built from it is the same text
 *  as from the live row, truncation note included.
 *
 *  The prompt cleans and trims a body BEFORE comparing it to its cap, so the
 *  cut is made on that cleaned text, not the raw one: a body from GitHub's
 *  web editor is CRLF, and a raw cut one past the cap lost every `\r` to the
 *  cleaning, landed under the cap, and the note saying there is more went
 *  with it. The cut ends on a non-blank character for the same reason, since
 *  the prompt's trim would pull a cut ending in spaces back under too. */
export function cutBodyForSnapshot(body: string, max: number, clean: (s: string) => string): string {
  if (body.length <= max + 1) return body;
  const text = clean(body).trim();
  if (text.length <= max) return text;
  let end = max + 1;
  while (end < text.length && /\s/.test(text[end - 1])) end++;
  return text.slice(0, end);
}

function capBodies(a: ForgeListAnswer): ForgeListAnswer {
  if ("issues" in a) {
    return { ...a, issues: a.issues.map((i) => ({ ...i, body: cutBodyForSnapshot(i.body, ISSUE_BODY_MAX, cleanIssueText) })) };
  }
  return { ...a, prs: a.prs.map((p) => ({ ...p, body: cutBodyForSnapshot(p.body, PR_BODY_MAX, cleanPrText) })) };
}

/** The ok entries as snapshot text, newest first within personal-before-repo,
 *  skipping any that would overrun the budget. `live` drops removed projects;
 *  null means the project list has not loaded, and then nothing is dropped. */
export function serializeSnapshot(entries: Record<string, ForgeListEntry>, live: Set<string> | null): string {
  const rows = Object.values(entries)
    .filter((e) => e.ok && e.okAt > 0 && (!live || live.has(e.query.projectId)))
    .sort((a, b) =>
      Number(PERSONAL_SCOPES.includes(b.query.scope)) - Number(PERSONAL_SCOPES.includes(a.query.scope))
      || b.okAt - a.okAt);
  const parts: string[] = [];
  let size = 2;
  for (const e of rows) {
    const q = { projectId: e.query.projectId, kind: e.query.kind, scope: e.query.scope, limit: limitOf(e.query) };
    const s = JSON.stringify({ q, at: e.okAt, a: capBodies(e.ok!) });
    if (size + s.length + 1 > SNAPSHOT_BUDGET_CHARS) continue;
    parts.push(s);
    size += s.length + 1;
  }
  return `[${parts.join(",")}]`;
}

const isStr = (v: unknown): v is string => typeof v === "string";

function issueOf(v: any): ForgeIssue | null {
  if (!v || typeof v !== "object" || !Number.isInteger(v.number) || !isStr(v.title)) return null;
  return {
    provider: v.provider, number: v.number, title: v.title,
    url: isStr(v.url) ? v.url : "", body: isStr(v.body) ? v.body : "", author: isStr(v.author) ? v.author : "",
    comments: Number.isInteger(v.comments) ? v.comments : 0,
    labels: Array.isArray(v.labels) ? v.labels.filter(isStr) : [],
    updated_at: isStr(v.updated_at) ? v.updated_at : "",
  };
}

function prOf(v: any): ForgePr | null {
  if (!v || typeof v !== "object" || !Number.isInteger(v.number) || !isStr(v.title) || !isStr(v.head_ref)) return null;
  return {
    provider: v.provider, number: v.number, title: v.title,
    url: isStr(v.url) ? v.url : "", body: isStr(v.body) ? v.body : "", author: isStr(v.author) ? v.author : "",
    head_ref: v.head_ref, cross_repository: v.cross_repository === true, draft: v.draft === true,
    updated_at: isStr(v.updated_at) ? v.updated_at : "",
  };
}

/** Snapshot text back to entries. Anything malformed is dropped row by row:
 *  a cache that cannot be read is an empty cache, never a crash. Entries keep
 *  the time they were fetched, so they are stale by the TTL and the first
 *  reader re-fetches them. */
export function parseSnapshot(raw: string | null): Record<string, ForgeListEntry> {
  const out: Record<string, ForgeListEntry> = {};
  if (!raw) return out;
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return out; }
  if (!Array.isArray(doc)) return out;
  for (const row of doc as any[]) {
    const q = row?.q, a = row?.a;
    if (!q || !isStr(q.projectId) || !q.projectId || !Number.isInteger(q.limit) || q.limit <= 0) continue;
    if (typeof row.at !== "number" || row.at <= 0 || !a || a.status !== "ok") continue;
    let query: ForgeListQuery;
    let ok: ForgeListAnswer;
    const head = { provider: a.provider ?? null, remote_url: isStr(a.remote_url) ? a.remote_url : "", status: "ok" as const, message: "" };
    if (q.kind === "issues" && ISSUE_SCOPES.includes(q.scope) && Array.isArray(a.issues)) {
      query = { projectId: q.projectId, kind: "issues", scope: q.scope, limit: q.limit };
      ok = { ...head, issues: a.issues.map(issueOf).filter((i: ForgeIssue | null): i is ForgeIssue => !!i) };
    } else if (q.kind === "prs" && PR_SCOPES.includes(q.scope) && Array.isArray(a.prs)) {
      query = { projectId: q.projectId, kind: "prs", scope: q.scope, limit: q.limit };
      ok = { ...head, prs: a.prs.map(prOf).filter((p: ForgePr | null): p is ForgePr => !!p) };
    } else {
      continue;
    }
    out[forgeListKey(query)] = { query, status: "ok", ok, okAt: row.at, fetchedAt: row.at };
  }
  return out;
}

let lastWritten: string | null = null;
let dirty = false;

function persistSnapshot() {
  if (!dirty) return;
  dirty = false;
  const projects = useApp.getState().projects;
  const live = projects.length ? new Set(projects.map((p) => p.id)) : null;
  const raw = serializeSnapshot(useForgeLists.getState().entries, live);
  if (raw === lastWritten) return;
  try {
    localStorage.setItem(LS_FORGE_LISTS, raw);
    lastWritten = raw;
  } catch { /* private mode, or the quota: the next launch just starts cold */ }
}

export const useForgeLists = create<ForgeListsState>(() => ({
  entries: (() => {
    try {
      const raw = localStorage.getItem(LS_FORGE_LISTS);
      lastWritten = raw;
      return parseSnapshot(raw);
    } catch { return {}; }
  })(),
}));

// ── fetching ──

/** Bumped by `clearForgeLists`: a fetch started before it lands nowhere. */
let epoch = 0;
const inFlight = new Map<string, Promise<ForgeListAnswer>>();
let active = 0;
const queue: Array<{ key: string; run: () => void }> = [];

/** Run `job` within the concurrency bound. An `urgent` one (a dialog someone
 *  is looking at) waits at the FRONT: Todos on All is five lists a project,
 *  and a dialog behind a twenty-project refresh would wait out a hundred. */
function schedule<T>(key: string, job: () => Promise<T>, urgent: boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      active++;
      // A job that throws before returning its promise still frees its slot.
      let p: Promise<T>;
      try { p = job(); } catch (e) { p = Promise.reject(e); }
      p.then(resolve, reject).finally(() => {
        active--;
        queue.shift()?.run();
        // One write per burst, once the queue has drained. On a timer, so it
        // runs after the answer that just landed has been recorded.
        if (active === 0 && queue.length === 0) setTimeout(persistSnapshot, 0);
      });
    };
    if (active < MAX_CONCURRENT_FETCHES) run();
    else if (urgent) queue.unshift({ key, run });
    else queue.push({ key, run });
  });
}

/** Move a list still waiting in the queue to its front, for an urgent caller
 *  joining a fetch Todos queued first. */
function hurry(key: string) {
  const i = queue.findIndex((j) => j.key === key);
  if (i > 0) queue.unshift(...queue.splice(i, 1));
}

function setEntry(key: string, next: (prev: ForgeListEntry | undefined) => ForgeListEntry) {
  useForgeLists.setState((s) => ({ entries: { ...s.entries, [key]: next(s.entries[key]) } }));
}

const isUnsupported = (a: ForgeListAnswer) =>
  a.status === "unsupported-remote"
  || a.message.toLowerCase().includes("not supported")
  || a.message.toLowerCase().includes("unsupported");

/** The last ok answer for a query, to paint before a fetch lands. */
export function cachedForgeList(q: IssueListQuery): IssueLookup | null;
export function cachedForgeList(q: PrListQuery): PrPickList | null;
export function cachedForgeList(q: ForgeListQuery): ForgeListAnswer | null {
  return useForgeLists.getState().entries[forgeListKey(q)]?.ok ?? null;
}

export interface FetchOptions {
  /** Jump the queue: the dialogs pass this, Todos does not. */
  urgent?: boolean;
}

/** Fetch a list now, joining a fetch already in flight for the same query.
 *  Resolves with the forge's answer whatever its status, and rejects only
 *  when the IPC itself throws. */
export function fetchForgeList(q: IssueListQuery, opts?: FetchOptions): Promise<IssueLookup>;
export function fetchForgeList(q: PrListQuery, opts?: FetchOptions): Promise<PrPickList>;
export function fetchForgeList(q: ForgeListQuery, opts?: FetchOptions): Promise<ForgeListAnswer>;
export function fetchForgeList(q: ForgeListQuery, opts: FetchOptions = {}): Promise<ForgeListAnswer> {
  const key = forgeListKey(q);
  const running = inFlight.get(key);
  if (running) {
    if (opts.urgent) hurry(key);
    return running;
  }

  const at = epoch;
  const limit = limitOf(q);
  setEntry(key, (e) => ({ query: q, status: "loading", ok: e?.ok ?? null, okAt: e?.okAt ?? 0, fetchedAt: e?.fetchedAt ?? 0 }));

  const p: Promise<ForgeListAnswer> = schedule<ForgeListAnswer>(
    key,
    () =>
      q.kind === "issues"
        ? projectForgeIssues(q.projectId, limit, q.scope)
        : projectForgePrs(q.projectId, { scope: q.scope, limit }),
    !!opts.urgent,
  )
    .then((answer) => record(key, q, at, answer), (err) => recordFailure(key, q, at, err))
    .finally(() => {
      if (inFlight.get(key) === p) inFlight.delete(key);
    });
  inFlight.set(key, p);
  return p;
}

/** Land one answer on its entry (unless `clearForgeLists` ran since). A
 *  failure keeps the last ok rows. */
function record(key: string, q: ForgeListQuery, at: number, answer: ForgeListAnswer): ForgeListAnswer {
  if (at !== epoch) return answer;
  const now = Date.now();
  if (answer.status === "ok") {
    dirty = true;
    setEntry(key, () => ({ query: q, status: "ok", ok: answer, okAt: now, fetchedAt: now }));
  } else {
    setEntry(key, (e) => ({
      query: q,
      status: isUnsupported(answer) ? "unsupported" : "error",
      ok: e?.ok ?? null,
      okAt: e?.okAt ?? 0,
      fetchedAt: now,
      errorMessage: answer.message || answer.status,
    }));
  }
  return answer;
}

function recordFailure(key: string, q: ForgeListQuery, at: number, err: unknown): never {
  if (at === epoch) {
    setEntry(key, (e) => ({
      query: q, status: "error", ok: e?.ok ?? null, okAt: e?.okAt ?? 0,
      fetchedAt: Date.now(), errorMessage: String(err),
    }));
  }
  throw err;
}

/** Fetch every list in `qs` that is missing or past the TTL (all of them
 *  with `force`) in ONE IPC, which Rust answers with one GraphQL query per
 *  GitHub host and the per-project CLI path for the rest. Lists already in
 *  flight are joined, not fetched twice, and each list joins the batch under
 *  its own key, so a dialog asking for one of them meanwhile waits on it. */
export async function refreshForgeLists(qs: ForgeListQuery[], force = false): Promise<void> {
  const { entries } = useForgeLists.getState();
  const joined: Promise<unknown>[] = [];
  const due = new Map<string, ForgeListQuery>();
  for (const q of qs) {
    const key = forgeListKey(q);
    const running = inFlight.get(key);
    if (running) { joined.push(running); continue; }
    const e = entries[key];
    if (!force && e && e.status !== "loading" && Date.now() - e.fetchedAt < FORGE_LIST_TTL_MS) continue;
    due.set(key, q);
  }
  if (due.size) {
    const at = epoch;
    const list = [...due.values()];
    for (const [key, q] of due) {
      setEntry(key, (e) => ({ query: q, status: "loading", ok: e?.ok ?? null, okAt: e?.okAt ?? 0, fetchedAt: e?.fetchedAt ?? 0 }));
    }
    const batch = schedule(
      `batch:${[...due.keys()].join("|")}`,
      () => projectForgeLists(list.map((q) => ({ projectId: q.projectId, kind: q.kind, scope: q.scope, limit: limitOf(q) }))),
      false,
    );
    list.forEach((q, i) => {
      const key = forgeListKey(q);
      const p: Promise<ForgeListAnswer> = batch
        .then((answers) => {
          const a = answers[i];
          if (!a) throw new Error("no answer for this list");
          return record(key, q, at, a);
        })
        .catch((err) => recordFailure(key, q, at, err))
        .finally(() => {
          if (inFlight.get(key) === p) inFlight.delete(key);
        });
      inFlight.set(key, p);
      joined.push(p);
    });
  }
  await Promise.allSettled(joined);
}

const sameRows = (a: ForgeListAnswer, b: ForgeListAnswer) =>
  a.provider === b.provider && a.remote_url === b.remote_url
  && JSON.stringify("issues" in a ? a.issues : a.prs) === JSON.stringify("issues" in b ? b.issues : b.prs);

/** What a dialog's list shows once the re-fetch behind a cached paint
 *  answers. A fresh list with the same rows keeps the object on screen, so
 *  nothing re-renders and no row moves under a cursor about to click it. A
 *  failure with rows already shown keeps them and says why, rather than
 *  swapping a usable list for an error card; with nothing shown, the failure
 *  is the answer, as before. */
export function afterRevalidate<L extends ForgeListAnswer>(
  shown: L | null,
  answer: L,
): { lookup: L; refreshErr: string | null } {
  if (answer.status === "ok") return { lookup: shown && sameRows(shown, answer) ? shown : answer, refreshErr: null };
  if (shown) return { lookup: shown, refreshErr: answer.message || answer.status };
  return { lookup: answer, refreshErr: null };
}

/** Fetch a list unless a fresh answer (or failure) is cached, or `force`. */
export async function refreshForgeList(q: ForgeListQuery, force = false): Promise<void> {
  const e = useForgeLists.getState().entries[forgeListKey(q)];
  if (!force && e && e.status !== "loading" && Date.now() - e.fetchedAt < FORGE_LIST_TTL_MS) return;
  try { await fetchForgeList(q); } catch { /* recorded on the entry */ }
}

/** Forget every list, the snapshot included. A fetch still running lands
 *  nowhere. */
export function clearForgeLists() {
  epoch++;
  inFlight.clear();
  dirty = false;
  lastWritten = null;
  try { localStorage.removeItem(LS_FORGE_LISTS); } catch { /* private mode */ }
  useForgeLists.setState({ entries: {} });
}
