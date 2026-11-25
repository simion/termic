import { describe, expect, it } from "vitest";
import { addressKind, countdown, hostFold, isTerminalReply, joinableGroups, layoutRemote, nameFromPrompt, profilesOf, remoteAlerts, remoteProps, remoteTaskRequest, visibleTasks, type RemoteTask } from "@/lib/remote";

describe("isTerminalReply", () => {
  it("drops xterm's automatic answers to terminal queries", () => {
    for (const s of ["\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[12;40R", "\x1b[0n", "\x1b[I", "\x1b[O", "\x1b]11;rgb:0c0c/0c0c/0c0c\x07", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"]) {
      expect(isTerminalReply(s)).toBe(true);
    }
  });
  it("keeps what a person types", () => {
    for (const s of ["a", "\r", "\x1b", "\x1b[A", "\x1b[B", "\x03", "\x1b[200~pasted\x1b[201~", "hello"]) {
      expect(isTerminalReply(s)).toBe(false);
    }
  });
});

describe("addressKind", () => {
  it("labels LAN, Tailscale and everything else", () => {
    expect(addressKind("192.168.1.20:23620")).toBe("lan");
    expect(addressKind("10.0.0.5:23620")).toBe("lan");
    expect(addressKind("172.20.1.1:23620")).toBe("lan");
    expect(addressKind("100.101.102.103:23620")).toBe("tailscale");
    expect(addressKind("100.200.1.1:23620")).toBe("other");
    expect(addressKind("8.8.8.8:23620")).toBe("other");
  });
});

describe("countdown", () => {
  it("reads minutes and seconds, never negative", () => {
    expect(countdown(292_000)).toBe("4:52");
    expect(countdown(59_001)).toBe("1:00");
    expect(countdown(-5)).toBe("0:00");
  });
});

describe("nameFromPrompt", () => {
  it("makes a short branch-safe name", () => {
    expect(nameFromPrompt("Fix the login redirect loop on Safari, please!")).toBe("fix-the-login-redirect-loop");
    expect(nameFromPrompt("   ")).toBe("task");
    expect(nameFromPrompt("Ünïcödé only ✨")).toBe("n-c-d-only");
  });
});

describe("layoutRemote: a machine's tasks as its own sidebar files them", () => {
  const t = (id: string, project: string, extra: Partial<RemoteTask> = {}): RemoteTask =>
    ({ id, name: id, project, agent: "claude", state: "idle", tabs: [], is_main_checkout: false, ...extra });

  it("keeps the host's order, gathers folders and groups at their first member", () => {
    const g = { id: "lead", name: "Auth work", color: "teal" };
    const folder = { id: "Backend", name: "Backend", color: "purple" };
    const blocks = layoutRemote([
      t("docs", "web", { project_order: 0, order: 0 }),
      t("b-loose", "api", { project_order: 1, order: 2, project_group: folder }),
      t("b-lead", "api", { project_order: 1, order: 0, project_group: folder, group: g }),
      t("b-member", "api", { project_order: 1, order: 3, project_group: folder, group: g }),
      t("w-1", "worker", { project_order: 2, order: 0, project_group: folder }),
    ]);
    expect(blocks.map(b => b.kind === "project" ? `p:${b.project.name}` : `f:${b.folder.id}[${b.projects.map(p => p.name).join(",")}]`))
      .toEqual(["p:web", "f:Backend[api,worker]"]);
    const api = blocks[1].kind === "folder" ? blocks[1].projects[0] : null;
    expect(api!.segments.map(s => s.kind === "task" ? s.task.id : `group:${s.group.name}[${s.tasks.map(x => x.id).join(",")}]`))
      .toEqual(["group:Auth work[b-lead,b-member]", "b-loose"]);
  });

  it("an older host with no order lists projects and tasks by name", () => {
    const blocks = layoutRemote([t("zeta", "web"), t("alpha", "web"), t("one", "api")]);
    expect(blocks.map(b => b.kind === "project" && b.project.name)).toEqual(["api", "web"]);
    const web = blocks[1].kind === "project" ? blocks[1].project : null;
    expect(web!.segments.map(s => s.kind === "task" && s.task.id)).toEqual(["alpha", "zeta"]);
  });

  it("collects tab labels like the local row: each key once, values deduped", () => {
    const task = t("x", "web", { tabs: [
      { id: "1", title: "a", agent: "claude", state: "idle", is_default: true, props: [{ key: "ticket", value: "ABC-1" }, { key: "phase", value: "review" }] },
      { id: "2", title: "b", agent: "codex", state: "idle", is_default: false, props: [{ key: "ticket", value: "ABC-1" }, { key: "ticket", value: "ABC-2" }] },
    ] });
    expect(remoteProps(task)).toBe("ABC-1, ABC-2 · review");
    expect(remoteProps(t("y", "web"))).toBe("");
  });
});

describe("remote task actions: the host's own verbs", () => {
  const t = (id: string, project: string, group?: { id: string; name: string; color?: string }): RemoteTask =>
    ({ id, name: id, project, agent: "claude", state: "idle", tabs: [], is_main_checkout: false, group });

  it("each action is the verb the host's CLI would run, naming the task by id", () => {
    const strip = (r: Record<string, unknown>) => { const { id: _, ...rest } = r; return rest; };
    expect(strip(remoteTaskRequest("t1", { kind: "rename", name: "  Fix login  " }))).toEqual({ cmd: "rename", task: "t1", name: "Fix login" });
    expect(strip(remoteTaskRequest("t1", { kind: "pin", pinned: false }))).toEqual({ cmd: "pin", task: "t1", pinned: false });
    expect(strip(remoteTaskRequest("t1", { kind: "join", lead: "lead-id" }))).toEqual({ cmd: "group", task: "t1", join: "lead-id" });
    expect(strip(remoteTaskRequest("t1", { kind: "newGroup", color: "teal" }))).toEqual({ cmd: "group", task: "t1", color: "teal" });
    expect(strip(remoteTaskRequest("t1", { kind: "leave" }))).toEqual({ cmd: "group", task: "t1", leave: true });
  });

  it("offers the other groups in the same project, each once, never its own", () => {
    const auth = { id: "g1", name: "Auth", color: "teal" };
    const docs = { id: "g2", name: "Docs" };
    const other = { id: "g3", name: "Elsewhere" };
    const me = t("me", "api", auth);
    const all = [me, t("a2", "api", auth), t("d1", "api", docs), t("d2", "api", docs), t("x", "web", other), t("loose", "api")];
    expect(joinableGroups(all, me).map(g => g.id)).toEqual(["g2"]);
    expect(joinableGroups(all, t("loose", "api")).map(g => g.id)).toEqual(["g1", "g2"]);
  });
});

describe("remoteAlerts: what is worth ringing the desktop for", () => {
  const task = (id: string, state: string, question?: string): RemoteTask =>
    ({ id, name: id, project: "api", agent: "claude", state, tabs: [], is_main_checkout: false, question: question ? { id: "q", kind: "command", title: question, body: "", options: [] } : undefined });
  // Asserted rather than typed out: a machine grows fields (a server's
  // ssh) that these rules do not read.
  const mach = (state: "online" | "offline" | "connecting", tasks: RemoteTask[]) =>
    ({ id: "m1", kind: "computer", name: "Studio", state, error: null, version: null, grant: "drive", caps: [], tasks }) as unknown as Parameters<typeof remoteAlerts>[0][number];

  it("a task that starts waiting rings with its question; one that finishes working rings done", () => {
    const a = remoteAlerts([mach("online", [task("t1", "working"), task("t2", "working"), task("t3", "idle")])],
      [mach("online", [task("t1", "waiting", "Do you want to proceed?"), task("t2", "done"), task("t3", "done")])]);
    expect(a.map(x => [x.task, x.kind, x.question])).toEqual([["t1", "waiting", "Do you want to proceed?"], ["t2", "done", undefined]]);
    expect(a[0]).toMatchObject({ machine: "m1", machineName: "Studio", project: "api", taskName: "t1" });
  });

  it("says nothing on a first snapshot, for a new task, or across a reconnect", () => {
    expect(remoteAlerts([], [mach("online", [task("t1", "waiting")])])).toEqual([]);
    expect(remoteAlerts([mach("online", [])], [mach("online", [task("new", "waiting")])])).toEqual([]);
    expect(remoteAlerts([mach("offline", [task("t1", "working")])], [mach("online", [task("t1", "waiting")])])).toEqual([]);
    expect(remoteAlerts([mach("online", [task("t1", "waiting")])], [mach("online", [task("t1", "waiting")])])).toEqual([]);
  });
});

describe("a paired computer's profiles", () => {
  const work = { id: "work", name: "Work", accent: "#ff0000" };
  const home = { id: "home", name: "Home", accent: "#00ff00" };
  const tasks = [
    { id: "a", profile: work }, { id: "b", profile: home }, { id: "c", profile: work }, { id: "d" },
  ] as unknown as RemoteTask[];

  it("lists each profile once, in the order first seen", () => {
    expect(profilesOf(tasks).map(p => p.id)).toEqual(["work", "home"]);
  });

  it("hides the unticked profiles' tasks; a task with no profile always shows", () => {
    expect(visibleTasks(tasks, ["work"]).map(t => t.id)).toEqual(["b", "d"]);
    // Nothing hidden: the same array, so memoised rows do not rebuild.
    expect(visibleTasks(tasks, [])).toBe(tasks);
    expect(visibleTasks(tasks, undefined)).toBe(tasks);
  });
});

describe("orderMachines", () => {
  const m = (id: string) => ({ id });
  it("puts dragged ones first as placed, and new ones after in arrival order", async () => {
    const { orderMachines } = await import("./remote");
    expect(orderMachines([m("a"), m("b"), m("c")], []).map(x => x.id)).toEqual(["a", "b", "c"]);
    expect(orderMachines([m("a"), m("b"), m("c")], ["c", "a"]).map(x => x.id)).toEqual(["c", "a", "b"]);
    // A computer unpaired since keeps its slot in the saved order harmlessly.
    expect(orderMachines([m("a"), m("b")], ["gone", "b"]).map(x => x.id)).toEqual(["b", "a"]);
  });
});

describe("remoteTaskRequest: tab and open", () => {
  it("asks the host for a tab (same agent or a named one) and to reopen", () => {
    expect(remoteTaskRequest("t1", { kind: "tab", tab: { tab: "default" } })).toMatchObject({ cmd: "tab", task: "t1", kind: { tab: "default" } });
    expect(remoteTaskRequest("t1", { kind: "tab", tab: { tab: "agent", id: "codex" } })).toMatchObject({ cmd: "tab", task: "t1", kind: { tab: "agent", id: "codex" } });
    expect(remoteTaskRequest("t1", { kind: "open" })).toMatchObject({ cmd: "open", task: "t1" });
  });
});

describe("hostFold", () => {
  it("follows the host's own sidebar until folded here, and the host again once it changes", () => {
    expect(hostFold(undefined, true)).toBe(true);
    expect(hostFold(undefined, false)).toBe(false);
    // Opened here while the host had it folded: open, as long as the host keeps it folded.
    const over = { folded: false, host: true };
    expect(hostFold(over, true)).toBe(false);
    // The host opened it (or folded it again later): the host's state wins.
    expect(hostFold(over, false)).toBe(false);
    expect(hostFold({ folded: true, host: false }, true)).toBe(true);
  });
});
