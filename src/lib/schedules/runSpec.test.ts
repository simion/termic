// Seatbelt is pinned on for every unit test (src/test/setup.ts), so the
// sandbox half of the inheritance is exercised on every OS the suite runs on.
import { describe, it, expect } from "vitest";
import {
  composePrompt, reportInstruction, reportPath, reportStem, runName, runPrompt, runRefusal,
  runSpecFromParent, scheduleSlug, stemOfReport, uniqueName,
} from "@/lib/schedules/runSpec";
import type { Task } from "@/lib/types";

const parent = (extra: Partial<Task> = {}): Task => ({
  id: "p", project_id: "proj", name: "grafana check", branch: "main", base_branch: "main",
  path: "/Users/u/web", cli: "claude", port: 18100, created: "", archived: false, ...extra,
});

describe("runSpecFromParent: the one inheritance point", () => {
  it("copies the agent, its args, YOLO, the sandbox and the account override", () => {
    const spec = runSpecFromParent(parent({
      cli: "codex",
      agent_args: ["--model", "o4"],
      yolo: true,
      sandbox_mode: "enforce-fs",
      sandbox_rw_paths: ["/Users/u/cache"],
      sandbox_allowed_hosts: ["grafana.acme.com"],
      sandbox_block_keychain: true,
      role: "reviewer",
      accounts: { codex: "work" },
    }));
    expect(spec).toEqual({
      cli: "codex",
      agentArgs: ["--model", "o4"],
      yolo: true,
      // a blocked parent never schedules an unblocked run.
      sandbox: { enabled: true, mode: "enforce-fs", rwPaths: ["/Users/u/cache"], allowedHosts: ["grafana.acme.com"], blockKeychain: true, role: "reviewer" },
      accounts: { codex: "work" },
      memberPaths: undefined,
    });
  });

  it("an uncaged parent gives an uncaged run with YOLO off unless the parent had it", () => {
    expect(runSpecFromParent(parent())).toMatchObject({
      yolo: false, sandbox: { enabled: false, rwPaths: [], allowedHosts: [] }, accounts: {},
    });
  });

  it("reads a legacy sandbox_enabled record as enforce", () => {
    expect(runSpecFromParent(parent({ sandbox_enabled: true })).sandbox).toMatchObject({ enabled: true, mode: "enforce" });
  });

  it("never hands back the parent's own arrays", () => {
    const p = parent({ agent_args: ["-x"], accounts: { claude: "a" } });
    const spec = runSpecFromParent(p);
    spec.agentArgs.push("-y");
    spec.accounts.claude = "b";
    expect(p.agent_args).toEqual(["-x"]);
    expect(p.accounts).toEqual({ claude: "a" });
  });

  it("a multi-repo parent's runs link the parent's members", () => {
    const p = parent({
      composition: [
        { dir_name: "api", mode: "repo_root", branch: "main", path: "/Users/u/web/api", repo_path: "/Users/u/api" },
        { dir_name: "ui", mode: "repo_root", branch: "main", path: "/Users/u/web/ui", repo_path: "/Users/u/ui" },
      ],
    });
    expect(runSpecFromParent(p, { type: "multi" }).memberPaths).toEqual(["/Users/u/api", "/Users/u/ui"]);
    expect(runSpecFromParent(parent(), { type: "multi" }).memberPaths).toEqual([]);
    expect(runSpecFromParent(p, { type: "single" }).memberPaths).toBeUndefined();
  });
});

describe("runRefusal", () => {
  it("refuses Docker before anything else, then an agent that cannot say done", () => {
    expect(runRefusal({ docker_sandbox_enabled: true }, true)).toBe("docker");
    expect(runRefusal({ docker_sandbox_enabled: true }, false)).toBe("docker");
    expect(runRefusal({}, false)).toBe("agent");
    expect(runRefusal({}, true)).toBeNull();
  });
});

describe("names and files", () => {
  const slot = new Date(2026, 8, 28, 9, 0).getTime();

  it("names a run for its slot, unique among live names", () => {
    expect(runName(" grafana-check ", slot)).toBe("grafana-check 2026-09-28 09:00");
    expect(uniqueName("a", ["b"])).toBe("a");
    expect(uniqueName("a", ["A", "a (2)"])).toBe("a (3)");
  });

  it("stems a report by its slot and moves a minute on a clash", () => {
    expect(reportStem(slot, new Set())).toBe("2026-09-28_0900");
    expect(reportStem(slot, new Set(["2026-09-28_0900", "2026-09-28_0901"]))).toBe("2026-09-28_0902");
    expect(stemOfReport(".termic/schedules/s/2026-09-28_0900.html")).toBe("2026-09-28_0900");
    expect(stemOfReport("notes.md")).toBeNull();
    expect(stemOfReport(undefined)).toBeNull();
  });

  it("slugs a name the way Rust's slug_ok accepts", () => {
    const ok = (s: string) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s) && s.length <= 64;
    for (const name of ["Grafana check!", "  --x--  ", "Ünïcödé", "日本語", "a".repeat(200)]) {
      expect(ok(scheduleSlug(name, [])), name).toBe(true);
    }
    expect(scheduleSlug("Grafana check!", [])).toBe("grafana-check");
    expect(scheduleSlug("日本語", [])).toBe("schedule");
    expect(scheduleSlug("Grafana", ["grafana", "grafana-2"])).toBe("grafana-3");
  });
});

describe("the prompt", () => {
  it("composes a library body and typed text like the CLI's -P + -p", () => {
    expect(composePrompt("body\n\n", " \ntext")).toBe("body\n\ntext");
    expect(composePrompt("body", "  ")).toBe("body");
    expect(composePrompt(undefined, "text")).toBe("text");
  });

  it("names the exact report file, its html alternative and the folder of earlier ones", () => {
    const s = { name: "grafana check", slug: "grafana-check" };
    const text = reportInstruction(s, "2026-09-28_0900");
    expect(text).toContain("`.termic/schedules/grafana-check/2026-09-28_0900.md`");
    expect(text).toContain("`.termic/schedules/grafana-check/2026-09-28_0900.html`");
    expect(text).toContain("`.termic/schedules/grafana-check/`");
    expect(text).not.toContain("—");
    expect(reportPath("grafana-check", "2026-09-28_0900")).toBe(".termic/schedules/grafana-check/2026-09-28_0900.md");
    expect(runPrompt("check the dashboards\n", s, "2026-09-28_0900")).toBe(`check the dashboards\n\n${text}`);
  });
});
