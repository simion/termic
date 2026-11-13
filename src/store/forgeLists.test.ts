import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  afterRevalidate,
  cachedForgeList,
  clearForgeLists,
  fetchForgeList,
  forgeListKey,
  FORGE_LIST_TTL_MS,
  parseSnapshot,
  refreshForgeList,
  refreshForgeLists,
  serializeSnapshot,
  SNAPSHOT_BUDGET_CHARS,
  useForgeLists,
  type ForgeListEntry,
} from "./forgeLists";
import { BODY_MAX, issueContext } from "@/lib/issuePrompt";
import { prReviewPrompt } from "@/lib/prReview";
import { useApp } from "@/store/app";
import { rateLimitedText } from "@/store/forgeRate";
import * as ipc from "@/lib/ipc";
import type { ForgeIssue, ForgePr, IssueLookup, PrPickList, Project } from "@/lib/types";

vi.mock("@/lib/ipc", () => ({
  projectForgeIssues: vi.fn(),
  projectForgePrs: vi.fn(),
  projectForgeLists: vi.fn(),
}));

// node vitest has no localStorage. Installed before the store module runs, so
// its init-time read of the snapshot sees this stub too.
const stored = vi.hoisted(() => {
  const map = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  };
  return map;
});

const issue = (number: number, body = ""): ForgeIssue => ({
  provider: "github", number, title: `Issue ${number}`, url: `https://github.com/acme/repo/issues/${number}`,
  body, author: "alice", comments: 0, labels: ["bug"], updated_at: "2026-10-24T10:00:00Z",
});
const pr = (number: number): ForgePr => ({
  provider: "github", number, title: `PR ${number}`, url: `https://github.com/acme/repo/pull/${number}`,
  body: "", author: "bob", head_ref: `feature/${number}`, cross_repository: false, draft: false,
  updated_at: "2026-10-24T11:00:00Z",
});
const issuesOk = (issues: ForgeIssue[]): IssueLookup =>
  ({ provider: "github", remote_url: "git@github.com:acme/repo.git", status: "ok", message: "", issues });
const prsOk = (prs: ForgePr[]): PrPickList =>
  ({ provider: "github", remote_url: "git@github.com:acme/repo.git", status: "ok", message: "", prs });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Past the drain, the timer the snapshot write waits on. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const assigned = (projectId = "p1") => ({ projectId, kind: "issues" as const, scope: "assigned" as const });
const mine = (projectId = "p1") => ({ projectId, kind: "prs" as const, scope: "mine" as const });

describe("forge lists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearForgeLists();
    stored.clear();
    useApp.setState({ projects: [] });
  });

  describe("a Todos batch", () => {
    it("lands every list in one store write", async () => {
      vi.mocked(ipc.projectForgeLists).mockResolvedValueOnce([issuesOk([issue(1)]), prsOk([pr(2)]), issuesOk([issue(3)])]);
      let writes = 0;
      const unsub = useForgeLists.subscribe(() => { writes++; });
      await refreshForgeLists([assigned("p1"), mine("p1"), assigned("p2")]);
      unsub();
      // One for the loading marks, one for the answers.
      expect(writes).toBe(2);
      expect(cachedForgeList(mine("p1"))?.prs.map((p) => p.number)).toEqual([2]);
      expect(cachedForgeList(assigned("p2"))?.issues.map((i) => i.number)).toEqual([3]);
    });

    it("does not make a dialog wait it out: an urgent fetch runs on its own", async () => {
      const batch = deferred<(IssueLookup | PrPickList)[]>();
      vi.mocked(ipc.projectForgeLists).mockReturnValueOnce(batch.promise);
      vi.mocked(ipc.projectForgePrs).mockResolvedValueOnce(prsOk([pr(9)]));
      const todos = refreshForgeLists([assigned("p1"), mine("p1")]);

      // The dialog does not join the batch, and a second dialog asking
      // meanwhile joins the first dialog's fetch rather than a third.
      const first = fetchForgeList(mine("p1"), { urgent: true });
      const second = fetchForgeList(mine("p1"), { urgent: true });
      expect(second).toBe(first);
      // It answers while the batch is still out.
      expect((await first).prs.map((p) => p.number)).toEqual([9]);
      expect(ipc.projectForgePrs).toHaveBeenCalledTimes(1);
      batch.resolve([issuesOk([issue(1)]), prsOk([pr(2)])]);
      await todos;
      // The batch does not overwrite the list the dialog re-fetched.
      expect(cachedForgeList(mine("p1"))?.prs.map((p) => p.number)).toEqual([9]);
      expect(cachedForgeList(assigned("p1"))?.issues.map((i) => i.number)).toEqual([1]);
    });

    it("words a rate-limited list in the UI language, keeping the rows it had", async () => {
      vi.mocked(ipc.projectForgeLists).mockResolvedValueOnce([issuesOk([issue(1)])]);
      await refreshForgeLists([assigned("p1")]);
      const refused: IssueLookup = { ...issuesOk([]), status: "rate-limited", message: "GitHub rate limit reached on github.com." };
      vi.mocked(ipc.projectForgeLists).mockResolvedValueOnce([refused]);
      await refreshForgeLists([assigned("p1")], true);
      const e = useForgeLists.getState().entries[forgeListKey(assigned("p1"))];
      expect(e.status).toBe("error");
      expect(e.errorMessage).toMatch(/Termic asks again/);
      expect(cachedForgeList(assigned("p1"))?.issues.map((i) => i.number)).toEqual([1]);
    });

    it("sends each query with its own scope and limit", async () => {
      vi.mocked(ipc.projectForgeLists).mockResolvedValueOnce([issuesOk([]), prsOk([])]);
      await refreshForgeLists([assigned("p1"), mine("p1")]);
      expect(vi.mocked(ipc.projectForgeLists).mock.calls[0][0]).toEqual([
        { projectId: "p1", kind: "issues", scope: "assigned", limit: 50 },
        { projectId: "p1", kind: "prs", scope: "mine", limit: 30 },
      ]);
    });

    it("records a thrown batch on every list in it", async () => {
      vi.mocked(ipc.projectForgeLists).mockRejectedValueOnce(new Error("ipc down"));
      await refreshForgeLists([assigned("p1"), mine("p1")]);
      const { entries } = useForgeLists.getState();
      expect(entries[forgeListKey(assigned("p1"))].status).toBe("error");
      expect(entries[forgeListKey(mine("p1"))].errorMessage).toContain("ipc down");
    });
  });

  it("treats a missing limit as the IPC's default, so both spellings are one query", () => {
    expect(forgeListKey(mine())).toBe(forgeListKey({ ...mine(), limit: 30 }));
    expect(forgeListKey(assigned())).toBe(forgeListKey({ ...assigned(), limit: 50 }));
    expect(forgeListKey({ ...mine(), limit: 8 })).not.toBe(forgeListKey(mine()));
  });

  it("joins a fetch already in flight instead of starting a second one", async () => {
    const d = deferred<PrPickList>();
    vi.mocked(ipc.projectForgePrs).mockReturnValueOnce(d.promise);

    const a = fetchForgeList(mine());
    const b = fetchForgeList({ ...mine(), limit: 30 });
    // A forced refresh joins it too: a fetch that started a moment ago is fresh.
    const c = refreshForgeList(mine(), true);
    d.resolve(prsOk([pr(1)]));

    expect(await a).toBe(await b);
    await c;
    expect(ipc.projectForgePrs).toHaveBeenCalledTimes(1);
    expect(ipc.projectForgePrs).toHaveBeenCalledWith("p1", { scope: "mine", limit: 30 });
    expect(cachedForgeList(mine())?.prs.map((p) => p.number)).toEqual([1]);
  });

  it("runs at most three fetches at once, across every caller", async () => {
    const ds = Array.from({ length: 5 }, () => deferred<IssueLookup>());
    ds.forEach((d) => vi.mocked(ipc.projectForgeIssues).mockReturnValueOnce(d.promise));

    const all = ["p1", "p2", "p3", "p4", "p5"].map((id) => fetchForgeList(assigned(id)));
    await Promise.resolve();
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(3);

    ds[0].resolve(issuesOk([]));
    await vi.waitFor(() => expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(4));

    ds.slice(1).forEach((d) => d.resolve(issuesOk([])));
    await Promise.all(all);
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(5);
  });

  it("keeps the last good rows through a failed refresh, and records the failure", async () => {
    vi.mocked(ipc.projectForgeIssues).mockResolvedValueOnce(issuesOk([issue(7)]));
    await fetchForgeList(assigned());
    const okAt = useForgeLists.getState().entries[forgeListKey(assigned())].okAt;

    vi.mocked(ipc.projectForgeIssues).mockResolvedValueOnce(
      { provider: "github", remote_url: "", status: "error", message: "Network unreachable", issues: [] } as IssueLookup,
    );
    const answer = await fetchForgeList(assigned());
    expect(answer.status).toBe("error");

    const e = useForgeLists.getState().entries[forgeListKey(assigned())];
    expect(e.status).toBe("error");
    expect(e.errorMessage).toBe("Network unreachable");
    expect(e.okAt).toBe(okAt);
    expect(e.fetchedAt).toBeGreaterThanOrEqual(okAt);
    expect((e.ok as IssueLookup).issues.map((i) => i.number)).toEqual([7]);
  });

  it("marks an unsupported remote as such, and records a thrown IPC as an error", async () => {
    vi.mocked(ipc.projectForgePrs).mockResolvedValueOnce(
      { provider: null, remote_url: "", status: "unsupported-remote", message: "", prs: [] } as PrPickList,
    );
    await fetchForgeList(mine());
    expect(useForgeLists.getState().entries[forgeListKey(mine())].status).toBe("unsupported");

    vi.mocked(ipc.projectForgeIssues).mockRejectedValueOnce(new Error("ipc down"));
    await expect(fetchForgeList(assigned())).rejects.toThrow("ipc down");
    const e = useForgeLists.getState().entries[forgeListKey(assigned())];
    expect(e.status).toBe("error");
    expect(e.errorMessage).toContain("ipc down");
  });

  it("skips a fresh answer and a fresh failure, and fetches a stale one or on force", async () => {
    vi.mocked(ipc.projectForgeIssues).mockResolvedValue(
      { provider: "github", remote_url: "", status: "error", message: "gh: not logged in", issues: [] } as IssueLookup,
    );
    await refreshForgeList(assigned());
    await refreshForgeList(assigned());
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(1);

    await refreshForgeList(assigned(), true);
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(2);

    const key = forgeListKey(assigned());
    useForgeLists.setState((s) => ({
      entries: { ...s.entries, [key]: { ...s.entries[key], fetchedAt: Date.now() - FORGE_LIST_TTL_MS - 1 } },
    }));
    await refreshForgeList(assigned());
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(3);
  });

  it("puts a dialog's fetch ahead of the lists Todos queued first", async () => {
    const ds = Array.from({ length: 6 }, () => deferred<IssueLookup>());
    ds.forEach((d) => vi.mocked(ipc.projectForgeIssues).mockReturnValueOnce(d.promise));

    // Three running, two waiting: a Todos refresh across five projects.
    const todos = ["p1", "p2", "p3", "p4", "p5"].map((id) => fetchForgeList(assigned(id)));
    const dialog = fetchForgeList(assigned("dlg"), { urgent: true });
    await Promise.resolve();
    expect(vi.mocked(ipc.projectForgeIssues).mock.calls.map((c) => c[0])).toEqual(["p1", "p2", "p3"]);

    ds[0].resolve(issuesOk([]));
    await vi.waitFor(() => expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(4));
    expect(vi.mocked(ipc.projectForgeIssues).mock.calls[3][0]).toBe("dlg");

    ds.slice(1).forEach((d) => d.resolve(issuesOk([])));
    await Promise.all([...todos, dialog]);
  });

  it("moves a list Todos already queued to the front when a dialog asks for the same one", async () => {
    const ds = Array.from({ length: 5 }, () => deferred<IssueLookup>());
    ds.forEach((d) => vi.mocked(ipc.projectForgeIssues).mockReturnValueOnce(d.promise));

    const todos = ["p1", "p2", "p3", "p4", "p5"].map((id) => fetchForgeList(assigned(id)));
    // p5 is last in line; the dialog joins that fetch rather than starting one.
    const dialog = fetchForgeList(assigned("p5"), { urgent: true });
    expect(dialog).toBe(todos[4]);

    ds[0].resolve(issuesOk([]));
    await vi.waitFor(() => expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(4));
    expect(vi.mocked(ipc.projectForgeIssues).mock.calls[3][0]).toBe("p5");

    ds.slice(1).forEach((d) => d.resolve(issuesOk([])));
    await Promise.all(todos);
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(5);
  });

  it("frees the slot of a fetch that throws before returning its promise", async () => {
    vi.mocked(ipc.projectForgeIssues).mockImplementationOnce(() => { throw new Error("sync boom"); });
    await expect(fetchForgeList(assigned("p1"))).rejects.toThrow("sync boom");

    // Three more must all start at once: the thrown one left no slot taken.
    const ds = Array.from({ length: 3 }, () => deferred<IssueLookup>());
    ds.forEach((d) => vi.mocked(ipc.projectForgeIssues).mockReturnValueOnce(d.promise));
    const all = ["p2", "p3", "p4"].map((id) => fetchForgeList(assigned(id)));
    await Promise.resolve();
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(4);
    ds.forEach((d) => d.resolve(issuesOk([])));
    await Promise.all(all);
  });

  it("drops an answer that lands after the lists were cleared", async () => {
    const d = deferred<IssueLookup>();
    vi.mocked(ipc.projectForgeIssues).mockReturnValueOnce(d.promise);
    const p = fetchForgeList(assigned());
    clearForgeLists();
    d.resolve(issuesOk([issue(1)]));
    await p;
    expect(useForgeLists.getState().entries).toEqual({});
  });

  describe("a dialog's re-fetch behind a cached paint", () => {
    it("keeps the object on screen when the rows did not change, so nothing moves", () => {
      const shown = issuesOk([issue(1), issue(2)]);
      const same = issuesOk([issue(1), issue(2)]);
      const r = afterRevalidate(shown, same);
      expect(r.lookup).toBe(shown);
      expect(r.refreshErr).toBeNull();
    });

    it("swaps in a list that changed", () => {
      const shown = issuesOk([issue(1)]);
      const fresh = issuesOk([issue(2), issue(1)]);
      expect(afterRevalidate(shown, fresh)).toEqual({ lookup: fresh, refreshErr: null });
    });

    it("keeps the rows it showed through a failure, and says why", () => {
      const shown = prsOk([pr(4)]);
      const failed = { provider: "github", remote_url: "", status: "cli-unauthed", message: "gh: not logged in", prs: [] } as PrPickList;
      expect(afterRevalidate(shown, failed)).toEqual({ lookup: shown, refreshErr: "gh: not logged in" });
      // No message: the status names it.
      expect(afterRevalidate(shown, { ...failed, message: "" }).refreshErr).toBe("cli-unauthed");
    });

    it("words a rate refusal in the UI's language, timed from the answer's own retry_at", () => {
      const shown = prsOk([pr(4)]);
      const refused = {
        provider: "github", remote_url: "", status: "rate-limited",
        message: "GitHub rate limit reached on github.com. Termic is waiting until 14:05.",
        retry_at: 2_000_000_000, prs: [],
      } as PrPickList;
      expect(afterRevalidate(shown, refused).refreshErr).toBe(rateLimitedText(2_000_000_000));
    });

    it("answers with the failure when nothing was shown, as before the cache", () => {
      const failed = { provider: "github", remote_url: "", status: "cli-missing", message: "no gh", issues: [] } as IssueLookup;
      expect(afterRevalidate(null, failed)).toEqual({ lookup: failed, refreshErr: null });
    });
  });

  describe("launch snapshot", () => {
    const snapshotRows = () => JSON.parse(stored.get("forgeListSnapshot") ?? "[]") as any[];

    it("saves the good answers once the queue drains, with bodies cut one past the prompt's cap", async () => {
      vi.mocked(ipc.projectForgeIssues).mockResolvedValueOnce(issuesOk([issue(1, "x".repeat(BODY_MAX * 3)), issue(2, "short")]));
      vi.mocked(ipc.projectForgePrs).mockResolvedValueOnce(
        { provider: "github", remote_url: "", status: "error", message: "boom", prs: [] } as PrPickList,
      );
      await Promise.all([fetchForgeList(assigned()), fetchForgeList(mine())]);
      await settle();

      const rows = snapshotRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].q).toEqual({ projectId: "p1", kind: "issues", scope: "assigned", limit: 50 });
      expect(rows[0].a.issues[0].body).toHaveLength(BODY_MAX + 1);
      expect(rows[0].a.issues[1].body).toBe("short");
      // The entry in memory keeps the whole body.
      expect(cachedForgeList(assigned())?.issues[0].body).toHaveLength(BODY_MAX * 3);
    });

    const restore = (entry: ForgeListEntry) =>
      Object.values(parseSnapshot(serializeSnapshot({ k: entry }, null)))[0].ok!;

    it("keeps the truncation note for a CRLF body, which the prompt measures without its \\r", () => {
      // GitHub's web editor writes CRLF. ~7700 characters, ~130 of them \r.
      const body = Array.from({ length: 130 }, (_, i) => `Line ${i} of the reproduction steps goes here.\r\n`).join("")
        + "x".repeat(1500);
      expect(body.length).toBeGreaterThan(BODY_MAX * 1.5);
      const live = issue(5, body);
      const entry: ForgeListEntry = { query: assigned(), status: "ok", ok: issuesOk([live]), okAt: 1, fetchedAt: 1 };
      const restored = (restore(entry) as IssueLookup).issues[0];

      expect(issueContext(live)).toContain("[body truncated");
      expect(issueContext(restored)).toBe(issueContext(live));
    });

    it("keeps the note when the cut would land on blanks the prompt trims away", () => {
      const live = issue(6, "a".repeat(BODY_MAX) + " ".repeat(50) + "tail of the body");
      const entry: ForgeListEntry = { query: assigned(), status: "ok", ok: issuesOk([live]), okAt: 1, fetchedAt: 1 };
      const restored = (restore(entry) as IssueLookup).issues[0];

      expect(issueContext(restored)).toContain("[body truncated");
      expect(issueContext(restored)).toBe(issueContext(live));
    });

    it("cuts a CRLF PR description where the review prompt does", () => {
      const body = "Summary of the change.\r\n".repeat(400);
      const live = { ...pr(8), body };
      const entry: ForgeListEntry = { query: mine(), status: "ok", ok: prsOk([live]), okAt: 1, fetchedAt: 1 };
      const restored = (restore(entry) as PrPickList).prs[0];

      expect(prReviewPrompt(live, "Review it.")).toContain("Description cut here");
      expect(prReviewPrompt(restored, "Review it.")).toBe(prReviewPrompt(live, "Review it."));
    });

    it("does not rewrite an unchanged snapshot", async () => {
      vi.mocked(ipc.projectForgeIssues).mockResolvedValue(issuesOk([issue(1)]));
      const spy = vi.spyOn(localStorage, "setItem");
      await fetchForgeList(assigned());
      await settle();
      const writes = spy.mock.calls.filter(([k]) => k === "forgeListSnapshot").length;
      expect(writes).toBe(1);

      // A fetch that FAILS changes nothing that is saved, and writes nothing.
      vi.mocked(ipc.projectForgeIssues).mockResolvedValueOnce(
        { provider: "github", remote_url: "", status: "error", message: "boom", issues: [] } as IssueLookup,
      );
      await fetchForgeList(assigned());
      await settle();
      expect(spy.mock.calls.filter(([k]) => k === "forgeListSnapshot").length).toBe(writes);
      spy.mockRestore();
    });

    it("drops removed projects, but only once the project list has loaded", () => {
      const entry = (projectId: string, okAt: number): ForgeListEntry => ({
        query: assigned(projectId), status: "ok", ok: issuesOk([issue(1)]), okAt, fetchedAt: okAt,
      });
      const entries = { a: entry("p1", 10), b: entry("gone", 20) };
      expect(JSON.parse(serializeSnapshot(entries, null)).map((r: any) => r.q.projectId)).toEqual(["gone", "p1"]);
      expect(JSON.parse(serializeSnapshot(entries, new Set(["p1"]))).map((r: any) => r.q.projectId)).toEqual(["p1"]);
    });

    it("fills the budget with personal lists before repo-wide ones", () => {
      // Past the budget on its own: 100 bodies at the cap.
      const big = issuesOk(Array.from({ length: 100 }, (_, i) => issue(i + 1, "y".repeat(BODY_MAX))));
      const entries: Record<string, ForgeListEntry> = {
        all: { query: { projectId: "p1", kind: "issues", scope: "all" }, status: "ok", ok: big, okAt: 30, fetchedAt: 30 },
        mine: { query: assigned("p1"), status: "ok", ok: issuesOk([issue(1)]), okAt: 10, fetchedAt: 10 },
      };
      const raw = serializeSnapshot(entries, null);
      expect(raw.length).toBeLessThanOrEqual(SNAPSHOT_BUDGET_CHARS);
      expect(JSON.parse(raw).map((r: any) => r.q.scope)).toEqual(["assigned"]);
    });

    it("reads the snapshot back on a fresh load, stale, so the first reader re-fetches", async () => {
      useApp.setState({ projects: [{ id: "p1", name: "Repo 1", non_git: false } as Project] });
      vi.mocked(ipc.projectForgeIssues).mockResolvedValueOnce(issuesOk([issue(3)]));
      await fetchForgeList(assigned());
      await settle();
      const at = snapshotRows()[0].at;

      vi.resetModules();
      const fresh = await import("./forgeLists");
      const e = fresh.useForgeLists.getState().entries[fresh.forgeListKey(assigned())];
      expect(e.status).toBe("ok");
      expect(e.fetchedAt).toBe(at);
      expect(fresh.cachedForgeList(assigned())?.issues.map((i) => i.number)).toEqual([3]);

      fresh.useForgeLists.setState((s) => ({
        entries: { ...s.entries, [fresh.forgeListKey(assigned())]: { ...e, fetchedAt: at - FORGE_LIST_TTL_MS } },
      }));
      const ipcFresh = await import("@/lib/ipc");
      vi.mocked(ipcFresh.projectForgeIssues).mockResolvedValueOnce(issuesOk([issue(3), issue(4)]));
      await fresh.refreshForgeList(assigned());
      expect(fresh.cachedForgeList(assigned())?.issues.map((i) => i.number)).toEqual([3, 4]);
    });

    it("parses a malformed snapshot as empty, row by row", () => {
      expect(parseSnapshot(null)).toEqual({});
      expect(parseSnapshot("{oops")).toEqual({});
      expect(parseSnapshot('{"q":1}')).toEqual({});
      const good = { q: { projectId: "p1", kind: "prs", scope: "review", limit: 30 }, at: 5, a: prsOk([pr(9)]) };
      const rows = [
        good,
        { ...good, q: { ...good.q, scope: "everything" } },
        { ...good, q: { ...good.q, limit: -1 } },
        { ...good, at: 0 },
        { ...good, a: { ...good.a, status: "error" } },
        { q: { projectId: "p2", kind: "prs", scope: "mine", limit: 30 }, at: 5, a: { status: "ok", prs: [pr(1), { number: "x" }, { number: 2, title: "no branch" }] } },
      ];
      const out = parseSnapshot(JSON.stringify(rows));
      expect(Object.keys(out).sort()).toEqual(["p1:prs:review:30", "p2:prs:mine:30"]);
      expect((out["p2:prs:mine:30"].ok as PrPickList).prs.map((p) => p.number)).toEqual([1]);
    });
  });
});
