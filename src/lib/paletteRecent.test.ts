// The expiry rule is the whole point of this module, so it is tested against an
// injected clock. A test that slept for an hour would not be run, and one that
// mocked Date.now globally would pin the behaviour to how the mock is wired
// rather than to the rule.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECENT_MAX,
  RECENT_TTL_MS,
  parseRecents,
  readSchemeFilter,
  readThemeRecents,
  recentIds,
  recordThemeRecent,
  withRecorded,
  type RecentEntry,
} from "./paletteRecent";

const T0 = 1_700_000_000_000;
const raw = (entries: RecentEntry[]) => JSON.stringify(entries);

describe("withRecorded", () => {
  it("puts the newest run first", () => {
    let list: RecentEntry[] = [];
    list = withRecorded(list, "a", T0);
    list = withRecorded(list, "b", T0 + 1000);
    expect(list.map(e => e.id)).toEqual(["b", "a"]);
  });

  it("moves a re-run command up instead of duplicating it", () => {
    let list: RecentEntry[] = [];
    list = withRecorded(list, "a", T0);
    list = withRecorded(list, "b", T0 + 1000);
    list = withRecorded(list, "a", T0 + 2000);
    expect(list.map(e => e.id)).toEqual(["a", "b"]);
    expect(list.filter(e => e.id === "a")).toHaveLength(1);
  });

  it("keeps at most RECENT_MAX", () => {
    let list: RecentEntry[] = [];
    for (let i = 0; i < RECENT_MAX + 4; i++) list = withRecorded(list, `c${i}`, T0 + i * 1000);
    expect(list).toHaveLength(RECENT_MAX);
    // The oldest fell off, the newest is on top.
    expect(list[0].id).toBe(`c${RECENT_MAX + 3}`);
  });

  it("drops entries that expired while the palette was closed", () => {
    let list = withRecorded([], "old", T0);
    list = withRecorded(list, "fresh", T0 + RECENT_TTL_MS + 1);
    expect(list.map(e => e.id)).toEqual(["fresh"]);
  });
});

describe("parseRecents expiry", () => {
  it("keeps an entry just under the hour", () => {
    const r = parseRecents(raw([{ id: "a", at: T0 }]), T0 + RECENT_TTL_MS - 1);
    expect(r.map(e => e.id)).toEqual(["a"]);
  });

  it("drops it exactly AT the hour", () => {
    const r = parseRecents(raw([{ id: "a", at: T0 }]), T0 + RECENT_TTL_MS);
    expect(r).toEqual([]);
  });

  it("drops an entry stamped in the future", () => {
    // A clock change backwards would otherwise pin a row to the top for over
    // an hour, since `now - at` stays negative.
    const r = parseRecents(raw([{ id: "a", at: T0 + 5000 }]), T0);
    expect(r).toEqual([]);
  });

  it("returns newest-first regardless of stored order", () => {
    const r = parseRecents(
      raw([{ id: "old", at: T0 }, { id: "new", at: T0 + 9000 }]),
      T0 + 10_000,
    );
    expect(r.map(e => e.id)).toEqual(["new", "old"]);
  });
});

describe("parseRecents robustness", () => {
  it("survives absent, corrupt and wrong-shaped storage", () => {
    // A broken recents list must never stop the palette from opening.
    expect(parseRecents(null, T0)).toEqual([]);
    expect(parseRecents("not json", T0)).toEqual([]);
    expect(parseRecents('{"id":"a"}', T0)).toEqual([]);   // object, not array
    expect(parseRecents("[1,2,3]", T0)).toEqual([]);
    expect(parseRecents(raw([{ id: "", at: T0 }] as RecentEntry[]), T0)).toEqual([]);
    expect(parseRecents('[{"id":"a"}]', T0)).toEqual([]); // no timestamp
    expect(parseRecents('[{"at":123}]', T0)).toEqual([]); // no id
    expect(parseRecents('[{"id":"a","at":"soon"}]', T0)).toEqual([]);
  });

  it("keeps the good entries in a partly-corrupt list", () => {
    const r = parseRecents(
      '[{"id":"a","at":' + T0 + '},{"bogus":true},{"id":"b","at":' + (T0 + 1) + "}]",
      T0 + 2,
    );
    expect(r.map(e => e.id)).toEqual(["b", "a"]);
  });
});

describe("recentIds", () => {
  it("hides ids whose command is not currently available", () => {
    // Task-scoped rows (Stop task, Copy branch) vanish when no task is active;
    // a remembered id must not render a dead row.
    const entries = [
      { id: "stop-task", at: T0 + 2 },
      { id: "settings", at: T0 + 1 },
    ];
    expect(recentIds(entries, new Set(["settings"]))).toEqual(["settings"]);
  });

  it("preserves newest-first order", () => {
    const entries = [
      { id: "b", at: T0 + 2 },
      { id: "a", at: T0 + 1 },
    ];
    expect(recentIds(entries, new Set(["a", "b"]))).toEqual(["b", "a"]);
  });
});

// The theme list's own two bits. localStorage is shared with whatever is
// there, so a corrupt or foreign value must read as "nothing saved".
describe("theme recents and filter", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps the newest committed themes first, deduped and capped", () => {
    for (const id of ["a", "b", "c", "a", "d"]) recordThemeRecent(id);
    expect(readThemeRecents()).toEqual(["d", "a", "c"].slice(0, RECENT_MAX));
  });

  it("reads corrupt or foreign values as empty", () => {
    store.set("commandPaletteThemeRecent", "{not json");
    expect(readThemeRecents()).toEqual([]);
    store.set("commandPaletteThemeRecent", JSON.stringify(["a", 7, null, "b"]));
    expect(readThemeRecents()).toEqual(["a", "b"]);
    store.set("commandPaletteThemeFilter", "sepia");
    expect(readSchemeFilter()).toBeNull();
    store.set("commandPaletteThemeFilter", "light");
    expect(readSchemeFilter()).toBe("light");
  });
});
