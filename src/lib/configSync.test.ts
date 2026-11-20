// @vitest-environment happy-dom
// The window's half of config sync: what a snapshot reads, what an apply
// writes, and that a pull which changed nothing writes and publishes nothing
// (docs/performance.md, bear trap 8).
//
// localStorage is a fake that counts writes, stubbed before each fresh module
// instance, for the reason prefs.test.ts gives: the stores read it at load.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PREF_KEYS } from "./prefsRegistry";

vi.mock("@/lib/ipc", () => ({
  syncStatus: vi.fn(),
  syncNow: vi.fn(),
  syncLaunchPull: vi.fn(),
  syncFocusPull: vi.fn(),
}));

function countingStorage() {
  const store = new Map<string, string>();
  const s = {
    writes: 0,
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { s.writes++; store.set(k, String(v)); },
    removeItem: (k: string) => { s.writes++; store.delete(k); },
    clear: () => { store.clear(); },
  };
  return s;
}

type Storage = ReturnType<typeof countingStorage>;
let ls: Storage;

async function load() {
  return await import("./configSync");
}

beforeEach(() => {
  ls = countingStorage();
  vi.stubGlobal("localStorage", ls);
  vi.resetModules();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the sync key lists", () => {
  it("are exactly the registry's sync keys, split by scope", async () => {
    const { SHARED_SYNC_KEYS, SCOPED_SYNC_KEYS } = await load();
    const sync = PREF_KEYS.filter(k => k.class === "sync" && !k.family && !k.legacy);
    expect([...SHARED_SYNC_KEYS].sort()).toEqual(sync.filter(k => !k.scoped).map(k => k.key).sort());
    expect([...SCOPED_SYNC_KEYS].sort()).toEqual(sync.filter(k => k.scoped).map(k => k.key).sort());
    for (const k of PREF_KEYS.filter(p => p.class === "local")) {
      expect(SHARED_SYNC_KEYS).not.toContain(k.key);
      expect(SCOPED_SYNC_KEYS).not.toContain(k.key);
    }
    // The safety defaults sync (docs/ideas/config-sync.md, decided).
    expect(SHARED_SYNC_KEYS).toEqual(expect.arrayContaining(["defaultYolo", "globalDefaultSandboxKind"]));
  });
});

describe("snapshotSyncPrefs", () => {
  it("reads sync keys only, per namespace, and leaves absent keys out", async () => {
    const { snapshotSyncPrefs } = await load();
    ls.setItem("themeMode", "dark");
    ls.setItem("defaultYolo", "1");
    ls.setItem("terminalRenderer", "dom");          // local: hardware
    ls.setItem("uiScale", "120");                   // local: display
    ls.setItem("promptLibrary", "{\"customs\":[]}"); // scoped, root profile
    ls.setItem("collapsedProjects", "{}");          // scoped, local
    ls.setItem("profile-work:groupColors", "{\"a\":\"red\"}");
    ls.setItem("profile-other:groupColors", "{\"b\":\"blue\"}");
    const snap = snapshotSyncPrefs(["", "profile-work:"]);
    expect(snap.shared).toEqual({ themeMode: "dark", defaultYolo: "1" });
    expect(snap.scoped).toEqual({
      "": { promptLibrary: "{\"customs\":[]}" },
      "profile-work:": { groupColors: "{\"a\":\"red\"}" },
    });
  });

  it("ignores a namespace that is not a profile's", async () => {
    const { snapshotSyncPrefs } = await load();
    ls.setItem("evil:groupColors", "{}");
    expect(snapshotSyncPrefs(["evil:"]).scoped).toEqual({});
  });
});

describe("writeSyncPrefs", () => {
  it("writes only changed sync keys, and nothing else a repo names", async () => {
    const { writeSyncPrefs } = await load();
    ls.setItem("themeMode", "dark");
    ls.setItem("branchPrefix", "feature");
    ls.writes = 0;
    const out = writeSyncPrefs({
      shared: [
        { key: "themeMode", value: "dark" },          // unchanged
        { key: "branchPrefix", value: "alice" },      // changed
        { key: "defaultYolo", value: "1" },           // new
        { key: "terminalRenderer", value: "dom" },    // local: refused
        { key: "notARealKey", value: "x" },           // unknown: refused
      ],
      scoped: {
        "profile-work:": [{ key: "groupColors", value: "{}" }, { key: "collapsedProjects", value: "{}" }],
        "../": [{ key: "groupColors", value: "{}" }],
      },
    });
    expect(out).toEqual({ shared: ["branchPrefix", "defaultYolo"], scoped: { "profile-work:": ["groupColors"] } });
    expect(ls.writes).toBe(3);
    expect(ls.getItem("terminalRenderer")).toBeNull();
    expect(ls.getItem("profile-work:collapsedProjects")).toBeNull();
  });

  it("removes a key the other machine reset to its default", async () => {
    const { writeSyncPrefs } = await load();
    ls.setItem("branchPrefix", "alice");
    writeSyncPrefs({ shared: [{ key: "branchPrefix", value: null }], scoped: {} });
    expect(ls.getItem("branchPrefix")).toBeNull();
  });

  it("writes nothing when applied a second time", async () => {
    const { writeSyncPrefs } = await load();
    const changes = { shared: [{ key: "themeMode", value: "light" }], scoped: { "": [{ key: "promptLibrary", value: "{}" }] } };
    writeSyncPrefs(changes);
    ls.writes = 0;
    expect(writeSyncPrefs(changes)).toEqual({ shared: [], scoped: {} });
    expect(ls.writes).toBe(0);
  });
});

describe("reloading the stores", () => {
  it("publishes nothing and writes nothing when storage did not change", async () => {
    const { reloadSyncedStores } = await load();
    const { usePrefs } = await import("@/store/prefs");
    const { usePromptLibrary } = await import("@/store/prompts");
    const { useApp } = await import("@/store/app");
    let notified = 0;
    const unsub = [usePrefs, usePromptLibrary, useApp].map(s => (s as { subscribe: (f: () => void) => () => void }).subscribe(() => { notified++; }));
    ls.writes = 0;
    expect(reloadSyncedStores()).toBe(false);
    expect(notified).toBe(0);
    expect(ls.writes).toBe(0);
    unsub.forEach(u => u());
  });

  it("publishes exactly the fields a pull changed, in one set", async () => {
    const { reloadSyncedStores, writeSyncPrefs } = await load();
    const { usePrefs } = await import("@/store/prefs");
    const before = usePrefs.getState();
    let notified = 0;
    const unsub = usePrefs.subscribe(() => { notified++; });
    writeSyncPrefs({ shared: [
      { key: "terminalFontSize", value: "17" },
      { key: "branchPrefix", value: "alice" },
      { key: "defaultYolo", value: "1" },
    ], scoped: {} });
    expect(reloadSyncedStores()).toBe(true);
    expect(notified).toBe(1);
    const after = usePrefs.getState();
    expect(after.terminalFontSize).toBe(17);
    expect(after.branchPrefix).toBe("alice");
    expect(after.defaultYolo).toBe(true);
    // Untouched objects keep their identity, so their selectors do not fire.
    expect(after.shortcuts).toBe(before.shortcuts);
    expect(after.agentFooterHidden).toBe(before.agentFooterHidden);
    unsub();
  });

  it("reloads the prompt library and folder colors only when they moved", async () => {
    const { reloadSyncedStores, writeSyncPrefs } = await load();
    const { usePromptLibrary } = await import("@/store/prompts");
    const { useApp } = await import("@/store/app");
    writeSyncPrefs({ shared: [], scoped: { "": [
      { key: "promptLibrary", value: JSON.stringify({ customs: [{ id: "c1", title: "Mine", body: "do it" }], overrides: {}, deletedBuiltins: [], disabled: [], order: [] }) },
      { key: "groupColors", value: JSON.stringify({ work: "red" }) },
    ] } });
    expect(reloadSyncedStores()).toBe(true);
    expect(usePromptLibrary.getState().prompts.some(p => p.id === "c1")).toBe(true);
    expect(useApp.getState().groupColors).toEqual({ work: "red" });
    expect(reloadSyncedStores()).toBe(false);
  });
});

describe("describeNotice", () => {
  it("says an agent removed elsewhere is gone here and what that costs", async () => {
    const { describeNotice, isNotice } = await load();
    const { i18n } = await import("@/lib/i18n");
    const t = i18n.t.bind(i18n) as (k: string, o?: Record<string, unknown>) => string;
    const removal = { kind: "agent" as const, target: "My agent", action: "remove" as const, safety: false };
    expect(isNotice(removal)).toBe(true);
    expect(isNotice({ ...removal, action: "add" as const })).toBe(false);
    expect(describeNotice(removal, t)).toBe(
      "Agent My agent removed: it was deleted on another machine. Tasks here that use it can no longer start it.");
    expect(describeNotice(removal, t)).not.toContain("\u2014");
  });
});

describe("describeSafety", () => {
  it("names the field and both values, with no em dash", async () => {
    const { describeSafety } = await load();
    const { i18n } = await import("@/lib/i18n");
    const t = i18n.t.bind(i18n) as (k: string, o?: Record<string, unknown>) => string;
    const line = describeSafety({ kind: "pref", target: "defaultYolo", action: "update", from: null, to: "1", safety: true }, t);
    expect(line).toBe("All projects: Start new tasks in YOLO changed from Default to On");
    const proj = describeSafety({ kind: "project", target: "app", action: "update", field: "default_sandbox", from: true, to: false, safety: true }, t);
    expect(proj).toBe("app: Sandbox new tasks changed from On to Off");
    expect(line + proj).not.toContain("\u2014");
  });
});

describe("syncFailureKind", () => {
  it("tells a sign-in failure from being offline, and stays quiet for neither when the text is something else", async () => {
    const { syncFailureKind } = await load();
    expect(syncFailureKind("git fetch failed: Permission denied (publickey).")).toBe("auth");
    expect(syncFailureKind("fatal: Authentication failed for 'https://git.acme.com/acme/termic-config.git/'")).toBe("auth");
    expect(syncFailureKind("The requested URL returned error: 403")).toBe("auth");
    expect(syncFailureKind("could not read Username for 'https://git.acme.com': terminal prompts disabled")).toBe("auth");
    // The wrapper line git uses for both. The access-rights sentence is the sign-in.
    expect(syncFailureKind("Could not read from remote repository.\nPlease make sure you have the correct access rights and the repository exists.")).toBe("auth");
    expect(syncFailureKind("ssh: Could not resolve hostname git.acme.com: nodename nor servname provided, or not known")).toBe("offline");
    expect(syncFailureKind("fatal: unable to access 'https://git.acme.com/acme/cfg.git/': Could not resolve host: git.acme.com")).toBe("offline");
    expect(syncFailureKind("git fetch timed out")).toBe("offline");
    expect(syncFailureKind("Connection refused")).toBe("offline");
    expect(syncFailureKind("fatal: 'origin' does not appear to be a git repository")).toBe("other");
  });
});

describe("background sync toasts", () => {
  const emptyRun = {
    ok: false, skipped: true, pushed: false, changed_profiles: [],
    prefs: { shared: [], scoped: {} }, themes_changed: false, changes: [],
    conflicts: [] as string[], error: null as string | null, profiles_changed: false,
  };

  it("toasts a conflict once, a sign-in failure once, and nothing when offline", async () => {
    const { surfaceConflicts, surfaceSyncFailure } = await load();
    const { useUI } = await import("@/store/ui");
    useUI.setState({ toasts: [] });
    surfaceConflicts(["profiles/a/settings.json"]);
    surfaceConflicts(["profiles/a/settings.json"]);
    // Settled, then the same file conflicts again: that is a new conflict.
    surfaceConflicts([]);
    surfaceConflicts(["profiles/a/settings.json"]);
    expect(useUI.getState().toasts.map(t => t.msg)).toEqual([
      "Changed on both machines. This machine's copy was kept.",
      "Changed on both machines. This machine's copy was kept.",
    ]);
    expect(useUI.getState().toasts[0].actions[0]?.label).toBe("Review");
    expect(useUI.getState().toasts.map(t => t.msg).join("")).not.toContain("\u2014");

    surfaceSyncFailure("git fetch timed out");
    expect(useUI.getState().toasts).toHaveLength(2);

    surfaceSyncFailure("Permission denied (publickey).");
    surfaceSyncFailure("Permission denied (publickey).");
    expect(useUI.getState().toasts.map(t => t.msg)).toEqual([
      "Changed on both machines. This machine's copy was kept.",
      "Changed on both machines. This machine's copy was kept.",
      "Sync could not sign in to the repo. Check this machine's git login, then press Sync now.",
    ]);

    surfaceSyncFailure("fatal: 'origin' does not appear to be a git repository");
    expect(useUI.getState().toasts.at(-1)?.msg).toBe(
      "Sync failed: fatal: 'origin' does not appear to be a git repository");
  });

  it("pulls when the window regains focus, and a skipped pull writes nothing", async () => {
    const { onConfigSyncFocus } = await load();
    const ipc = await import("@/lib/ipc");
    const { useUI } = await import("@/store/ui");
    useUI.setState({ toasts: [] });
    vi.mocked(ipc.syncFocusPull).mockClear();
    vi.mocked(ipc.syncStatus).mockResolvedValue({
      connected: true,
      bound: [{ ns: "", sync_id: "p" }],
      notices: [],
    } as never);
    vi.mocked(ipc.syncFocusPull).mockResolvedValue({ ...emptyRun, skipped: true });
    await onConfigSyncFocus(false, true);
    await onConfigSyncFocus(true, true);
    expect(ipc.syncFocusPull).not.toHaveBeenCalled();
    await onConfigSyncFocus(true, false);
    expect(ipc.syncFocusPull).toHaveBeenCalledTimes(1);
    expect(useUI.getState().toasts).toEqual([]);

    vi.mocked(ipc.syncFocusPull).mockResolvedValue({
      ...emptyRun, skipped: true, conflicts: ["profiles/a/settings.json"],
    });
    await onConfigSyncFocus(true, false);
    expect(useUI.getState().toasts).toHaveLength(1);
    expect(useUI.getState().toasts[0].msg).toBe("Changed on both machines. This machine's copy was kept.");
  });

  it("reports a sign-in failure again after a pull succeeds", async () => {
    const { onConfigSyncFocus } = await load();
    const ipc = await import("@/lib/ipc");
    const { useUI } = await import("@/store/ui");
    useUI.setState({ toasts: [] });
    vi.mocked(ipc.syncFocusPull).mockClear();
    vi.mocked(ipc.syncStatus).mockResolvedValue({
      connected: true,
      bound: [{ ns: "", sync_id: "p" }],
      notices: [],
    } as never);
    const auth = { ...emptyRun, skipped: false, ok: false, error: "Permission denied (publickey)." };
    vi.mocked(ipc.syncFocusPull).mockResolvedValue(auth);
    await onConfigSyncFocus(true, false);
    expect(useUI.getState().toasts).toHaveLength(1);
    await onConfigSyncFocus(true, false);
    expect(ipc.syncFocusPull).toHaveBeenCalledTimes(2);
    expect(useUI.getState().toasts).toHaveLength(1);

    vi.mocked(ipc.syncFocusPull).mockResolvedValue({ ...emptyRun, skipped: false, ok: true, error: null });
    await onConfigSyncFocus(true, false);
    expect(ipc.syncFocusPull).toHaveBeenCalledTimes(3);
    vi.mocked(ipc.syncFocusPull).mockResolvedValue(auth);
    await onConfigSyncFocus(true, false);
    expect(useUI.getState().toasts).toHaveLength(2);
  });
});
