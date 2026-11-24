// MCP endpoint, Phase A (docs/ideas/mcp.md), over the REAL loopback
// listener: the seeded profile enables mcp_enabled, so the app binds at
// launch, writes <dataDir>/mcp-port (the URL) and <dataDir>/mcp-token
// (the credential), and this spec speaks HTTP to it like an outside MCP
// client would. The unit suite covers the core against a StubHost; this
// file is where the WHOLE thread runs: bind-at-setup, the token files,
// auth, dispatch into the live webview (task_new spawns a real
// fakeagent PTY), and the lifecycle (disable unbinds and revokes,
// re-enable mints fresh).
//
// Raw node:http, not fetch: the boundary cases need forbidden headers
// (Origin) and header-identical comparisons that fetch abstracts away.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

/** The seeded repo every spec shares (scripts/e2e-seed.mjs). */
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");
import { dataDir } from "../../wdio.conf.js";
import { archiveTask, requireTermicApi, waitForAppShell } from "../helpers.js";

const portFile = path.join(dataDir, "mcp-port");
const tokenFile = path.join(dataDir, "mcp-token");
const endpoint = () => fs.readFileSync(portFile, "utf8").trim();
const token = () => fs.readFileSync(tokenFile, "utf8").trim();

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One raw request against the endpoint URL (or an override). */
function raw(
  opts: { method?: string; headers?: Record<string, string>; url?: string },
  body: string,
): Promise<HttpResult> {
  const u = new URL(opts.url ?? endpoint());
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: opts.method ?? "POST",
        headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** The one revision this endpoint serves. */
const REVISION = "2026-07-28";

/** The `_meta` block every modern request is required to carry. */
const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** An authenticated JSON-RPC call; returns the parsed frame. */
async function rpc(method: string, params?: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<any> {
  const merged: Record<string, unknown> = { ...(params ?? {}) };
  if (!("_meta" in merged)) merged._meta = META;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token()}`,
    "mcp-method": method,
    "mcp-protocol-version": REVISION,
    ...extraHeaders,
  };
  // Mcp-Name mirrors params.name, and tools/call is the only method
  // here that has one.
  if (method === "tools/call" && typeof merged.name === "string") {
    headers["mcp-name"] = merged.name;
  }
  const r = await raw(
    { headers },
    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: merged }),
  );
  expect(r.status).toBe(200);
  return JSON.parse(r.body);
}

/** tools/call sugar; returns the tool result object. */
async function call(tool: string, args: Record<string, unknown>): Promise<any> {
  const frame = await rpc("tools/call", { name: tool, arguments: args });
  expect(frame.error).toBeUndefined();
  return frame.result;
}

const noCors = (r: HttpResult) => {
  for (const k of Object.keys(r.headers)) {
    expect(k.toLowerCase().startsWith("access-control-")).toBe(false);
  }
};

describe("MCP endpoint: files, discovery, and the Phase A boundary", () => {
  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
  });

  it("advertises itself only through the data-dir files", () => {
    // Bind order contract: if either file exists, the listener is live
    // (socket-before-credential, cli_server discipline).
    expect(fs.existsSync(portFile)).toBe(true);
    expect(fs.existsSync(tokenFile)).toBe(true);
    expect(endpoint()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    // The credential is 0600 and never the CLI's token.
    // Unix mode bits. Windows has none (the file inherits the per-user data
    // dir's ACL), so the check is unix-only.
    if (process.platform !== "win32") expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(token().length).toBeGreaterThanOrEqual(32);
    const cliToken = fs.readFileSync(path.join(dataDir, "cli-token"), "utf8").trim();
    expect(token()).not.toBe(cliToken);
  });

  it("answers server/discover with the one revision it serves", async () => {
    const frame = await rpc("server/discover");
    // Spec field name (server/discover -> DiscoverResult.supportedVersions).
    // Sending `versions` instead left a real client unable to negotiate.
    expect(frame.result.supportedVersions).toEqual([REVISION]);
    expect(frame.result.versions).toBeUndefined();
    // Caching hints are mandatory on discover, as top-level fields.
    expect(frame.result.ttlMs).toBeGreaterThan(0);
    expect(frame.result.cacheScope).toBe("public");
    expect(frame.result.capabilities).toEqual({ tools: {} });
    // resultType is a result field; serverInfo is a namespaced _meta
    // key. A body copy of serverInfo is the pre-final shape and gets
    // rejected by conforming clients.
    expect(frame.result.resultType).toBe("complete");
    expect(frame.result.serverInfo).toBeUndefined();
    expect(frame.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("termic");
    // DiscoverResult.instructions: the one place this server can tell a
    // model that it may itself be running INSIDE a Termic task.
    expect(frame.result.instructions).toContain("TERMIC_TASK_ID");
    expect(frame.result.instructions).toContain("task_group");
  });

  it("refuses a handshake client with a version error naming the revision", async () => {
    // A legacy-era opening request: no Mcp-Method, no _meta,
    // protocolVersion at the top of params. Claude Code sent exactly
    // this at 2.1.228; by 2.1.238 it speaks the modern revision and no
    // longer does. The case stays because the refusal is the only
    // diagnostic a legacy client can surface, and the spec asks a
    // modern-only server to name its versions there.
    const r = await raw(
      { headers: { authorization: `Bearer ${token()}` } },
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {} },
      }),
    );
    expect(r.status).toBe(400);
    const frame = JSON.parse(r.body);
    expect(frame.result).toBeUndefined();
    expect(frame.error.code).toBe(-32022);
    // The supported list has to be machine-readable: it is what a
    // client retries from, and the only diagnostic a legacy one gets.
    expect(frame.error.data.supported).toEqual([REVISION]);
    expect(frame.error.data.requested).toBe("2025-11-25");
  });

  it("swallows notifications without requiring the header ceremony", async () => {
    for (const method of ["notifications/initialized", "notifications/unknown-to-us"]) {
      const note = await raw(
        { headers: { authorization: `Bearer ${token()}` } },
        JSON.stringify({ jsonrpc: "2.0", method }),
      );
      expect(note.status).toBe(202);
      expect(note.body).toBe("");
    }
  });

  it("refuses missing, wrong, and CLI tokens with one indistinguishable 401", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const cliToken = fs.readFileSync(path.join(dataDir, "cli-token"), "utf8").trim();
    const none = await raw({ headers: { "mcp-method": "tools/list" } }, body);
    const wrong = await raw(
      { headers: { authorization: "Bearer nope", "mcp-method": "tools/list" } },
      body,
    );
    const cli = await raw(
      { headers: { authorization: `Bearer ${cliToken}`, "mcp-method": "tools/list" } },
      body,
    );
    for (const r of [none, wrong, cli]) {
      expect(r.status).toBe(401);
      expect(r.body).toBe("");
      noCors(r);
    }
  });

  it("refuses any request carrying an Origin header, even a token-valid one", async () => {
    const r = await raw(
      {
        headers: {
          authorization: `Bearer ${token()}`,
          "mcp-method": "tools/list",
          origin: "https://evil.example",
        },
      },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    expect(r.status).toBe(403);
    expect(r.body).toBe("");
    noCors(r);
  });

  it("never answers a CORS preflight", async () => {
    const r = await raw(
      {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,mcp-method",
        },
      },
      "",
    );
    expect(r.status).toBe(405);
    noCors(r);
  });

  it("requires the standard headers, and says which fault it is", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: META },
    });
    const auth = `Bearer ${token()}`;

    const missing = await raw(
      { headers: { authorization: auth, "mcp-protocol-version": REVISION } },
      body,
    );
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body).error.code).toBe(-32020);

    const mismatch = await raw(
      {
        headers: {
          authorization: auth,
          "mcp-method": "tools/call",
          "mcp-protocol-version": REVISION,
        },
      },
      body,
    );
    expect(mismatch.status).toBe(400);
    expect(JSON.parse(mismatch.body).error.code).toBe(-32020);

    const noVersion = await raw(
      { headers: { authorization: auth, "mcp-method": "tools/list" } },
      body,
    );
    expect(noVersion.status).toBe(400);
    expect(JSON.parse(noVersion.body).error.code).toBe(-32020);

    // Header present but the body's _meta is not: malformed params,
    // NOT a header fault. Conflating the two strands the client.
    const noMeta = await raw(
      {
        headers: {
          authorization: auth,
          "mcp-method": "tools/list",
          "mcp-protocol-version": REVISION,
        },
      },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    );
    expect(noMeta.status).toBe(400);
    expect(JSON.parse(noMeta.body).error.code).toBe(-32602);
  });

  it("answers an unimplemented method with 404 and a JSON-RPC body", async () => {
    // The status says "not here"; the body proves this IS an MCP
    // endpoint, which is how a client tells the two 404s apart.
    const r = await raw(
      {
        headers: {
          authorization: `Bearer ${token()}`,
          "mcp-method": "resources/list",
          "mcp-protocol-version": REVISION,
        },
      },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list", params: { _meta: META } }),
    );
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).error.code).toBe(-32601);
  });

  it("lists the full-scope tool surface deterministically", async () => {
    const a = await rpc("tools/list");
    const b = await rpc("tools/list");
    expect(a).toEqual(b);
    const names = a.result.tools.map((t: any) => t.name);
    expect(names).toEqual([
      "task_list", "task_status", "task_new", "task_review", "task_send", "task_wait",
      "task_result", "task_log", "task_diff", "task_open", "task_rename", "task_pin", "task_group", "task_run",
      "scratchpad_new", "scratchpad_write", "scratchpad_read", "scratchpad_list",
      "scratchpad_remove", "scratchpad_clear",
      "task_apply", "task_archive", "task_stop", "task_tab", "task_tab_close", "task_prop", "task_agents",
      "prompts", "project_list", "project_add", "project_remove",
      // #380: recurring schedules, the `termic schedule` verbs.
      "schedule_list", "schedule_show", "schedule_set", "schedule_run", "schedule_delete",
      "peer_call", "peer_list", "peer_pair", "peer_unpair", "peer_rename",
    ]);
    // Consent surface: destructive verbs are annotated for clients.
    const archive = a.result.tools.find((t: any) => t.name === "task_archive");
    expect(archive.annotations.destructiveHint).toBe(true);
  });
});

describe("MCP tools/call: a real task round-trip through the live webview", () => {
  let taskId: string | undefined;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
  });

  after(async () => {
    if (taskId) await archiveTask(taskId);
    // task_diff dirties README to have something to diff. When the task is a
    // main-checkout one that README is the shared fixture's, and archiving the
    // task does not undo the edit: the next run's git spec then boots on a
    // dirty tree. The seed heals this too, but only when the suite is entered
    // through `make e2e`.
    try {
      execSync(`git -C "${fixture}" checkout -q HEAD -- README.md`);
    } catch { /* nothing of ours to restore */ }
  });

  it("task_new creates a task and spawns the fake agent", async () => {
    const r = await call("task_new", {
      name: "mcp-task",
      project: "fixture-repo",
      agent: "fakeagent",
    });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.kind).toBe("new");
    taskId = r.structuredContent.task.id;
    // The task is REAL: the live store carries it (same app, not a
    // parallel data path).
    const inStore = await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.some((t: any) => t.id === id),
      taskId,
    );
    expect(inStore).toBe(true);
  });

  it("task_new from inside a task joins that task's group, with no argument", async () => {
    // The agent passes NOTHING: the headers helper Termic installs sends the
    // agent's own $TERMIC_TASK_ID as X-Termic-Task, the way the CLI reads it
    // from its env (task.e2e.ts). Same behaviour, both surfaces.
    const frame = await rpc(
      "tools/call",
      { name: "task_new", arguments: { name: "mcp-grouped-child", project: "fixture-repo", agent: "fakeagent" } },
      { "x-termic-task": taskId! },
    );
    const r = frame.result;
    expect(r.isError).toBe(false);
    const childId = r.structuredContent.task.id;
    try {
      await browser.waitUntil(
        () => browser.execute(
          (sel) => !!document.querySelector(sel),
          `[data-task-group-id="${taskId}"] [data-sidebar-task-id="${childId}"]`,
        ),
        { timeout: 8_000, timeoutMsg: "the MCP-created task was not drawn inside its caller's group" },
      );
      const groups = await browser.execute(async (a, b) => {
        const all: any[] = await window.__termic!.ipc.tasksList();
        return [a, b].map(id => all.find(t => t.id === id)?.group?.id ?? null);
      }, taskId!, childId) as unknown as (string | null)[];
      expect(groups).toEqual([taskId, taskId]);
      // task_group names it, as the CLI's `group` does.
      // task_group with no `task` targets the caller's own, as `termic group` does.
      const named = (await rpc(
        "tools/call",
        { name: "task_group", arguments: { name: "MCP batch", color: "pink" } },
        { "x-termic-task": taskId! },
      )).result;
      expect(named.isError).toBe(false);
      expect(named.structuredContent.group).toMatchObject({ id: taskId, name: "MCP batch", named: true, color: "pink" });
      await browser.waitUntil(
        () => browser.execute(
          (g) => document.querySelector(`[data-testid="task-group-label-${g}"]`)?.textContent === "MCP batch",
          taskId!,
        ),
        { timeout: 8_000, timeoutMsg: "the caption never showed the name set over MCP" },
      );
      const bad = await call("task_group", { task: "mcp-task", color: "mauve" });
      expect(bad.isError).toBe(true);
      // noGroup beats the caller header, as --no-group beats $TERMIC_TASK_ID.
      const out = (await rpc(
        "tools/call",
        { name: "task_new", arguments: { name: "mcp-ungrouped", project: "fixture-repo", agent: "fakeagent", noGroup: true } },
        { "x-termic-task": taskId! },
      )).result;
      expect(out.isError).toBe(false);
      const outId = out.structuredContent.task.id;
      try {
        const g = await browser.execute(async (id) =>
          ((await window.__termic!.ipc.tasksList()) as any[]).find(t => t.id === id)?.group ?? null, outId);
        expect(g).toBeNull();
      } finally {
        await archiveTask(outId);
      }
    } finally {
      await archiveTask(childId);
    }
  });

  // A client OUTSIDE any task (Claude Code on another machine, say) has no
  // parent for its tasks to group under, so a shared group name is the only
  // way it can say "these belong together". Naming each task's group founded
  // a group per call: two groups, one name, two colours.
  it("two tasks given the same group name from outside any task share one group", async () => {
    const made: string[] = [];
    try {
      for (const name of ["mcp-pair-a", "mcp-pair-b"]) {
        const r = await call("task_new", { name, project: "fixture-repo", agent: "fakeagent" });
        expect(r.isError).toBe(false);
        made.push(r.structuredContent.task.id);
        const named = await call("task_group", { task: name, project: "fixture-repo", name: "Pair batch" });
        expect(named.isError).toBe(false);
      }
      const groups = await browser.execute(async (ids) => {
        const all: any[] = await window.__termic!.ipc.tasksList();
        return ids.map(id => all.find(t => t.id === id)?.group ?? null);
      }, made) as unknown as ({ id: string; name?: string; color?: string } | null)[];
      // One group: the first task founded it, the second joined it.
      expect(groups[0]?.id).toBe(made[0]);
      expect(groups[1]?.id).toBe(made[0]);
      expect(groups[1]?.color).toBe(groups[0]?.color);
      // And one caption with that name in the sidebar, holding both rows.
      await browser.waitUntil(
        () => browser.execute(
          (g, b) => !!document.querySelector(`[data-task-group-id="${g}"] [data-sidebar-task-id="${b}"]`),
          made[0], made[1],
        ),
        { timeout: 8_000, timeoutMsg: "the second task was not drawn inside the first one's group" },
      );
      const captions = await browser.execute(() =>
        [...document.querySelectorAll('[data-testid^="task-group-label-"]')]
          .filter(e => e.textContent === "Pair batch").length);
      expect(captions).toBe(1);
    } finally {
      for (const id of made) await archiveTask(id);
    }
  });

  // The other side of the case above. An agent INSIDE a task has a parent for
  // its tasks to group under, so a name is only a label. It used to be a join
  // key for everyone: two orchestrators that both called their batch "Review"
  // were merged, and everything the second one launched afterwards landed in
  // the first one's group.
  it("an agent inside a task that picks a name another group already has founds its own group", async () => {
    const made: string[] = [];
    try {
      const mk = async (name: string) => {
        const r = await call("task_new", { name, project: "fixture-repo", agent: "fakeagent", noGroup: true });
        expect(r.isError).toBe(false);
        made.push(r.structuredContent.task.id);
        return r.structuredContent.task.id as string;
      };
      const first = await mk("mcp-same-name-a");
      const second = await mk("mcp-same-name-b");
      const nameAs = async (self: string) =>
        (await rpc("tools/call", { name: "task_group", arguments: { name: "Review" } }, { "x-termic-task": self })).result;
      // Each names ITS OWN group "Review", from inside its own task.
      expect((await nameAs(first)).isError).toBe(false);
      expect((await nameAs(second)).isError).toBe(false);
      const groups = await browser.execute(async (ids) => {
        const all: any[] = await window.__termic!.ipc.tasksList();
        return ids.map(id => all.find(t => t.id === id)?.group ?? null);
      }, made) as unknown as ({ id: string; name?: string } | null)[];
      // Two groups, each led by its own task, both called Review.
      expect(groups[0]?.id).toBe(first);
      expect(groups[1]?.id).toBe(second);
      expect(groups.map(g => g?.name)).toEqual(["Review", "Review"]);
      // So a task the second one launches goes to the second one's group.
      const child = await rpc("tools/call",
        { name: "task_new", arguments: { name: "mcp-same-name-child", project: "fixture-repo", agent: "fakeagent" } },
        { "x-termic-task": second });
      const childId = child.result.structuredContent.task.id as string;
      made.push(childId);
      const childGroup = await browser.execute(async (id) =>
        ((await window.__termic!.ipc.tasksList()) as any[]).find(t => t.id === id)?.group?.id ?? null, childId);
      expect(childGroup).toBe(second);
    } finally {
      for (const id of made) await archiveTask(id);
    }
  });

  // An agent moving a task between groups, which the sidebar's Move to group
  // could do and the CLI and MCP could not: into another task's group, out
  // of it, and refused across projects or mixed with a rename.
  it("moves a task into another task's group and out again", async () => {
    const made: string[] = [];
    const groupOf = (id: string) => browser.execute(async (t) =>
      ((await window.__termic!.ipc.tasksList()) as any[]).find(x => x.id === t)?.group?.id ?? null, id);
    try {
      for (const name of ["mcp-move-lead", "mcp-move-mover"]) {
        const r = await call("task_new", { name, project: "fixture-repo", agent: "fakeagent", noGroup: true });
        expect(r.isError).toBe(false);
        made.push(r.structuredContent.task.id);
      }
      const [lead, mover] = made;
      // The lead is in no group yet: joining it starts one, led by it.
      const joined = await call("task_group", { task: "mcp-move-mover", project: "fixture-repo", join: "mcp-move-lead" });
      expect(joined.isError).toBe(false);
      expect(joined.structuredContent.group.id).toBe(lead);
      expect(await groupOf(mover)).toBe(lead);
      expect(await groupOf(lead)).toBe(lead);
      await browser.waitUntil(
        () => browser.execute(
          (g, m) => !!document.querySelector(`[data-task-group-id="${g}"] [data-sidebar-task-id="${m}"]`), lead, mover),
        { timeout: 8_000, timeoutMsg: "the moved task was not drawn inside the group" },
      );
      // A move is a call of its own.
      const mixed = await call("task_group", { task: "mcp-move-mover", project: "fixture-repo", join: "mcp-move-lead", name: "x" });
      expect(mixed.isError).toBe(true);
      // Out again; the lead keeps its group.
      const left = await call("task_group", { task: "mcp-move-mover", project: "fixture-repo", leave: true });
      expect(left.isError).toBe(false);
      expect(left.structuredContent.group ?? null).toBeNull();
      expect(await groupOf(mover)).toBeNull();
      expect(await groupOf(lead)).toBe(lead);
    } finally {
      for (const id of made) await archiveTask(id);
    }
  });

  it("scratchpads round-trip over MCP, defaulting to the caller's own task", async () => {
    // No `task` anywhere: the X-Termic-Task header says whose, as `termic
    // scratchpad` reads $TERMIC_TASK_ID. The pad is a note for the user,
    // never a file in the worktree.
    const self = { "x-termic-task": taskId! };
    const tool = async (name: string, args: Record<string, unknown>) =>
      (await rpc("tools/call", { name, arguments: args }, self)).result;
    const made = await tool("scratchpad_new", { title: "mcp findings", content: "first line" });
    expect(made.isError).toBe(false);
    const padId = made.structuredContent.pads[0].id;
    expect(made.structuredContent.task_id).toBe(taskId);
    expect((await tool("scratchpad_write", { pad: padId, content: "\nsecond line", append: true })).isError).toBe(false);
    const read = await tool("scratchpad_read", { pad: "mcp findings" });
    expect(read.structuredContent.content).toBe("first line\nsecond line");
    const listed = await tool("scratchpad_list", {});
    expect(listed.structuredContent.pads.map((p: any) => p.id)).toContain(padId);
    // Nothing landed in git.
    const wt = await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.path, taskId,
    ) as string;
    expect(execSync(`git -C "${wt}" status --porcelain`, { encoding: "utf8" })).not.toContain("mcp findings");
  });

  it("task_review refuses a missing or unreadable PR, and a repo off any forge makes no task", async () => {
    // Bad arguments are invalid params (a JSON-RPC error), like every tool's.
    const missing = await rpc("tools/call", { name: "task_review", arguments: { project: "fixture-repo" } });
    expect(missing.error.message).toContain("\"pr\" is required");
    const bad = await rpc("tools/call", { name: "task_review", arguments: { pr: "abc", project: "fixture-repo" } });
    expect(bad.error.message).toContain("pull request number or link");
    const before = await browser.execute(() => window.__termic!.useApp.getState().tasks.length);
    // A number is taken as well as a string. The fixture is not on a forge,
    // so the fetch is what refuses, after the prompt was resolved.
    const r = await call("task_review", { pr: 5, project: "fixture-repo", agent: "fakeagent" });
    expect(r.isError).toBe(true);
    expect(await browser.execute(() => window.__termic!.useApp.getState().tasks.length)).toBe(before);
  });

  it("scratchpad_remove and scratchpad_clear tidy up over MCP, and say they are destructive", async () => {
    const self = { "x-termic-task": taskId! };
    const tool = async (name: string, args: Record<string, unknown>) =>
      (await rpc("tools/call", { name, arguments: args }, self)).result;
    const ids = async () => ((await tool("scratchpad_list", {})).structuredContent.pads as any[]).map(p => p.id as string);

    // A well-behaved client confirms a destructiveHint'd call before making it.
    const listed = (await rpc("tools/list")).result.tools as any[];
    for (const name of ["scratchpad_remove", "scratchpad_clear"]) {
      const def = listed.find(t => t.name === name);
      if (!def) throw new Error(`${name} is not in tools/list`);
      expect(def.annotations.destructiveHint).toBe(true);
    }

    const a = (await tool("scratchpad_new", { title: "mcp throwaway", content: "x" })).structuredContent.pads[0].id as string;
    const b = (await tool("scratchpad_new", { title: "mcp other", content: "y" })).structuredContent.pads[0].id as string;
    expect(await ids()).toEqual(expect.arrayContaining([a, b]));

    // One pad, by title, on the caller's own task (no `task` argument).
    const removed = await tool("scratchpad_remove", { pad: "mcp throwaway" });
    expect(removed.isError).toBe(false);
    expect(removed.structuredContent.pads.map((p: any) => p.id)).toEqual([a]);
    const afterOne = await ids();
    expect(afterOne).not.toContain(a);
    expect(afterOne).toContain(b);

    // A pad is required: an empty call must not be read as "all of them".
    // Refused as invalid params before it reaches the app at all.
    const bare = await rpc("tools/call", { name: "scratchpad_remove", arguments: {} }, self);
    expect(bare.result).toBeUndefined();
    expect(bare.error).toBeDefined();
    expect(await ids()).toEqual(afterOne);

    // Everything the list showed, and the reply names what went.
    const cleared = await tool("scratchpad_clear", {});
    expect(cleared.isError).toBe(false);
    expect((cleared.structuredContent.pads as any[]).map(p => p.id).sort()).toEqual([...afterOne].sort());
    expect(await ids()).toEqual([]);
  });

  it("task_send delivers and task_log reads the echo back", async () => {
    const marker = `MCP-MARKER-${Date.now()}`;
    const sent = await call("task_send", { task: "mcp-task", prompt: marker });
    expect(sent.isError).toBe(false);
    await browser.waitUntil(
      async () => {
        const logs = await call("task_log", { task: "mcp-task" });
        return !logs.isError && logs.structuredContent.data.includes(`FAKE-AGENT echo: ${marker}`);
      },
      { timeout: 20_000, timeoutMsg: "the prompt's echo never showed in task_log" },
    );
  });

  it("task_wait settles with a typed outcome", async () => {
    // timeoutMs MUST stay well under wdio's mocha timeout (60s). At or
    // above it the server is still holding the long-poll when mocha
    // kills the test, which reports an opaque "Timeout" no matter what
    // the endpoint actually did.
    const r = await call("task_wait", { task: "mcp-task", timeoutMs: 15_000 });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.kind).toBe("wait");
    // A wait that runs out is a typed outcome too, not a failure: the
    // contract is that the tool always comes back saying which it was.
    expect(["done", "needs_input", "timeout"]).toContain(r.structuredContent.outcome);
  });

  it("task_diff counts a tracked edit against the base branch", async () => {
    // The diff is taken against the task's stored base, which is a
    // remote-tracking ref ("origin/main"). Any repo that cannot resolve it
    // used to come back as zeros rather than an error, so assert the counts
    // land, not merely that the call succeeded.
    const wt = await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.path,
      taskId,
    ) as string;
    fs.appendFileSync(path.join(wt, "README.md"), "edited by the mcp spec\n");

    const r = await call("task_diff", { task: "mcp-task", full: true });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.kind).toBe("diff");
    expect(r.structuredContent.files_changed).toBeGreaterThan(0);
    expect(r.structuredContent.insertions).toBeGreaterThan(0);
    expect(r.structuredContent.diff).toContain("README.md");
  });

  it("opens a tab, addresses it by the id it returned, then closes it", async () => {
    // The whole point of tab support: a caller that opens a second agent
    // has to be able to talk to THAT tab and clean it up. If the id came
    // back but selectors ignored it, every assertion below still passes
    // against the default tab, so the log check targets the new tab and
    // the close proves the id resolves.
    const opened = await call("task_tab", {
      task: "mcp-task",
      kind: "agent",
      agentId: "fakeagent",
    });
    expect(opened.isError).toBe(false);
    const tabId = opened.structuredContent.tab_id;
    expect(tabId).toBeTruthy();

    // task_tab returns once the tab exists; its agent PTY spawns after,
    // so sending straight away races the spawn (same reason cli.e2e.ts
    // waits for a tab's pty before addressing it).
    // The callback params are annotated because WebdriverIO otherwise
    // infers them as HTMLElement, which fails typecheck:e2e (its own
    // tsconfig, so `npm run build` does not cover it).
    const forTask = taskId as string;
    await browser.waitUntil(
      () =>
        browser.execute(
          (tid: string, tab: string) =>
            (window.__termic!.useApp.getState().tabs[tid] ?? []).some(
              (t: any) => t.id === tab && t.ptyId,
            ),
          forTask,
          tabId as string,
        ),
      { timeout: 20_000, timeoutMsg: "the tab task_tab opened never got a pty" },
    );

    const marker = `MCP-TAB-${Date.now()}`;
    const sent = await call("task_send", { task: "mcp-task", prompt: marker, tab: tabId });
    expect(sent.isError).toBe(false);
    await browser.waitUntil(
      async () => {
        const logs = await call("task_log", { task: "mcp-task", tab: tabId });
        return !logs.isError && logs.structuredContent.data.includes(`FAKE-AGENT echo: ${marker}`);
      },
      { timeout: 20_000, timeoutMsg: "the prompt never reached the tab that task_tab returned" },
    );

    const closed = await call("task_tab_close", { task: "mcp-task", tab: tabId });
    expect(closed.isError).toBe(false);
  });

  it("lists the agents task_new accepts, so an id need not be guessed", async () => {
    const r = await call("task_agents", {});
    expect(r.isError).toBe(false);
    const ids = r.structuredContent.agents.map((a: any) => a.id);
    expect(ids).toContain("fakeagent");
  });

  it("verb refusals come back as typed tool errors, not protocol errors", async () => {
    const r = await call("task_status", { task: "no-such-task" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.code).toBe("not_found");
  });
});

describe("MCP lifecycle: disable goes quiet, re-enable serves the same token", () => {
  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
  });

  it("toggling off unbinds and removes the port file; on keeps the token", async () => {
    const urlBefore = endpoint();
    const tokenBefore = token();
    const setEnabled = (on: boolean) =>
      browser.execute(async (v) => {
        const t = window.__termic!;
        const s = await t.invoke("settings_load");
        await t.invoke("settings_save", { s: { ...(s as object), mcp_enabled: v } });
      }, on);

    await setEnabled(false);
    try {
      // settings_save unbinds before it resolves. Nothing is advertised,
      // and the token is kept: it changes only when regenerated.
      expect(fs.existsSync(tokenFile)).toBe(true);
      expect(fs.existsSync(portFile)).toBe(false);
      await expect(
        raw({ url: urlBefore, headers: { "mcp-method": "tools/list" } }, "{}"),
      ).rejects.toThrow(); // connection refused: nothing is listening
    } finally {
      await setEnabled(true);
    }
    // The same credential and (preferred-port rebind) the same URL, so a
    // pasted client config survives the cycle.
    expect(token()).toBe(tokenBefore);
    expect(endpoint()).toBe(urlBefore);
    const frame = await rpc("server/discover");
    expect(frame.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("termic");
  });

  // The other half of "the token changes only when you regenerate it": the
  // one action that does change it, through the command the Settings button
  // calls. A client on another machine holds a pasted token, so what matters
  // is that the OLD value is refused afterwards, not just that the file moved.
  it("Regenerate token replaces the credential, and the old one is refused", async () => {
    const urlBefore = endpoint();
    const old = token();
    await browser.execute(() => window.__termic!.invoke("mcp_regenerate_token"));
    // The listener restarts on the new token; the port file is briefly gone.
    await browser.waitUntil(() => fs.existsSync(portFile) && fs.existsSync(tokenFile) && token() !== old,
      { timeout: 10_000, timeoutMsg: "the token file never changed after Regenerate token" });
    // Same address: only the credential moved, so a client needs one new
    // value, not a new URL as well.
    expect(endpoint()).toBe(urlBefore);

    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    let stale: HttpResult | undefined;
    await browser.waitUntil(async () => {
      try {
        stale = await raw({ headers: { authorization: `Bearer ${old}`, "mcp-method": "tools/list" } }, body);
        return true;
      } catch {
        return false; // connection refused: the restart has not bound yet
      }
    }, { timeout: 10_000, timeoutMsg: "the listener never came back after Regenerate token" });
    expect(stale!.status).toBe(401);
    expect(stale!.body).toBe("");

    // And the new one works, read from the file the way a local client does.
    const frame = await rpc("server/discover");
    expect(frame.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("termic");
  });
});

describe("MCP bind address and port: the settings decide where it listens", () => {
  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
  });

  const setBind = (address: string, port: number) =>
    browser.execute(async (a, p) => {
      const t = window.__termic!;
      const s = await t.invoke("settings_load");
      await t.invoke("settings_save", { s: { ...(s as object), mcp_bind_address: a, mcp_port: p } });
    }, address, port);

  /** A port nothing holds right now, found the way the app would. */
  const freePort = () =>
    new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address() as net.AddressInfo;
        srv.close(() => resolve(port));
      });
    });

  // 0.0.0.0 is deliberately not driven here: binding every interface makes
  // the OS firewall ask a question no spec can answer. The address half is
  // covered in mcp_server.rs; this covers the live rebind.
  it("a typed port moves the listener there, with the same token", async () => {
    const tokenBefore = token();
    const port = await freePort();
    await setBind("", port);
    try {
      expect(endpoint()).toBe(`http://127.0.0.1:${port}/mcp`);
      expect(token()).toBe(tokenBefore);
      const frame = await rpc("server/discover");
      expect(frame.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("termic");
    } finally {
      await setBind("", 0);
    }
    // No preference again keeps the port it has: nothing moved, so a
    // client config written a moment ago still works.
    expect(endpoint()).toBe(`http://127.0.0.1:${port}/mcp`);
  });

  it("an address that is not an IP stays on loopback, never everything", async () => {
    const urlBefore = endpoint();
    await setBind("everything", 0);
    try {
      expect(endpoint()).toBe(urlBefore);
      const frame = await rpc("server/discover");
      expect(frame.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("termic");
    } finally {
      await setBind("", 0);
    }
  });
});
