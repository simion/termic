import { describe, expect, it } from "vitest";
import { cageChipState } from "./cageChip";
import type { BrokerCounts, Role } from "./types";

const reviewer: Role = { id: "reviewer", name: "Reviewer", colour: "purple", description: "", secrets: [], rule_sets: [] };
const maintainer: Role = { ...reviewer, id: "maintainer", name: "Maintainer" };
const roles = [reviewer, maintainer];
const counts = (c: Partial<BrokerCounts> = {}): BrokerCounts =>
  ({ blocked: 0, suspicious: 0, foreign_token: 0, no_secret: 0, used: 0, paused: false, live: 1, roles: ["reviewer"], stale: false, ...c });

const enforce = { sandbox_mode: "enforce" as const, sandbox_block_keychain: true };
const enforceFs = { sandbox_mode: "enforce-fs" as const, sandbox_block_keychain: true };
const off = { sandbox_mode: "off" as const };
const monitor = { sandbox_mode: "monitor" as const, sandbox_block_keychain: true };
const docker = { sandbox_mode: "off" as const, docker_sandbox_enabled: true };

// one row per state on the "one cage chip, every state" board.
describe("cageChipState", () => {
  it.each([
    ["caged, role applied, nothing needs you", enforce, counts(), 0, reviewer, reviewer, 0,
      { mode: "enforce", role: "Reviewer", applied: true, tail: null, pending: false }],
    ["one blocked count: cage denies plus role blocks", enforce, counts({ blocked: 2 }), 3, reviewer, reviewer, 0,
      { mode: "enforce", role: "Reviewer", applied: true, tail: { kind: "blocked", count: 5 }, pending: false }],
    ["no role, no role part", enforceFs, null, 0, null, null, 0,
      { mode: "enforce-fs", role: null, applied: null, tail: null, pending: false }],
    ["a live block saved without a restart", enforce, null, 0, null, null, 1,
      { mode: "enforce", role: null, applied: null, tail: null, pending: true }],
    ["role set but uncaged: struck through", off, null, 0, null, reviewer, null,
      { mode: "off", role: "Reviewer", applied: false, tail: null, pending: false }],
    ["paused", enforce, counts({ paused: true, blocked: 4 }), 1, reviewer, reviewer, 0,
      { mode: "enforce", role: "Reviewer", applied: true, tail: { kind: "paused" }, pending: false }],
    ["suspicious outranks every other tail", enforce, counts({ suspicious: 1, paused: true, blocked: 3 }), 2, reviewer, reviewer, 0,
      { mode: "enforce", role: "Reviewer", applied: true, tail: { kind: "suspicious", count: 1 }, pending: false }],
    ["monitor counts accesses and never applies a role", monitor, null, 42, null, reviewer, null,
      { mode: "monitor", role: "Reviewer", applied: false, tail: { kind: "accesses", count: 42 }, pending: false }],
    ["docker: role set shows struck through", docker, null, 0, null, reviewer, null,
      { mode: "docker", role: "Reviewer", applied: false, tail: null, pending: false }],
    ["docker with no role", docker, null, 0, null, null, null,
      { mode: "docker", role: null, applied: null, tail: null, pending: false }],
    ["off with no role and no counts", off, null, 0, null, null, null,
      { mode: "off", role: null, applied: null, tail: null, pending: false }],
  ])("%s", (_name, task, c, deny, role, configured, kcOpen, want) => {
    const s = cageChipState(task, c, deny, role, configured, { roles, kcOpen });
    expect({
      mode: s.mode, role: s.role?.role.name ?? null, applied: s.role ? s.role.applied : null, tail: s.tail, pending: s.pending,
    }).toEqual(want);
  });

  it("shows the role the live spawn runs after a switch, and says it is pending", () => {
    const s = cageChipState(enforce, counts({ roles: ["reviewer"] }), 0, maintainer, maintainer, { roles, kcOpen: 0 });
    expect(s.role?.role.id).toBe("reviewer");
    expect(s.savedRole?.id).toBe("maintainer");
    expect(s.pendingWhy).toBe("switched");
  });

  it("a role edited since the agent started reads as pending", () => {
    const s = cageChipState(enforce, counts({ stale: true }), 0, reviewer, reviewer, { roles, kcOpen: 0 });
    expect(s.pendingWhy).toBe("stale");
  });

  it("a saved role with nothing live is not pending", () => {
    const s = cageChipState(enforce, counts({ live: 0, roles: [] }), 0, maintainer, maintainer, { roles, kcOpen: 0 });
    expect(s.role?.role.id).toBe("maintainer");
    expect(s.pending).toBe(false);
  });

  it("an unknown Keychain answer is never pending", () => {
    expect(cageChipState(enforce, null, 0, null, null, { roles, kcOpen: null }).pending).toBe(false);
  });

  it("broker counts do not count without an applied role", () => {
    const s = cageChipState(enforce, counts({ blocked: 3, suspicious: 2 }), 0, null, null, { roles, kcOpen: 0 });
    expect(s.tail).toBeNull();
  });

  it("an off cage ignores a stale deny total", () => {
    expect(cageChipState(off, null, 7, null, null, { roles, kcOpen: null }).tail).toBeNull();
  });

  describe("role shells", () => {
    const opts = (shells: (BrokerCounts | null)[]) => ({ roles, kcOpen: null, shells });
    it("a background shell's suspicious row reaches an uncaged task's tail", () => {
      expect(cageChipState(off, null, 0, null, null, opts([null, counts({ suspicious: 2 })])).tail)
        .toEqual({ kind: "suspicious", count: 2 });
    });
    it("shell blocks add to the cage's and the agent's", () => {
      expect(cageChipState(enforce, counts({ blocked: 1 }), 2, reviewer, reviewer, opts([counts({ blocked: 4 })])).tail)
        .toEqual({ kind: "blocked", count: 7 });
    });
    it("agent and shell suspicious rows sum, and outrank a pause", () => {
      expect(cageChipState(enforce, counts({ suspicious: 1, paused: true }), 0, reviewer, reviewer, opts([counts({ suspicious: 1 })])).tail)
        .toEqual({ kind: "suspicious", count: 2 });
    });
    it("Monitor's accesses still win over shell blocks, which show once it is quiet", () => {
      expect(cageChipState(monitor, null, 5, null, null, opts([counts({ blocked: 2 })])).tail).toEqual({ kind: "accesses", count: 5 });
      expect(cageChipState(monitor, null, 0, null, null, opts([counts({ blocked: 2 })])).tail).toEqual({ kind: "blocked", count: 2 });
    });
  });
});
