// MCP endpoint, Phase A (docs/plans/mcp.md), over the REAL loopback
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
import fs from "node:fs";
import path from "node:path";
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
async function rpc(method: string, params?: Record<string, unknown>): Promise<any> {
  const merged: Record<string, unknown> = { ...(params ?? {}) };
  if (!("_meta" in merged)) merged._meta = META;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token()}`,
    "mcp-method": method,
    "mcp-protocol-version": REVISION,
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
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
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
      "task_list", "task_status", "task_new", "task_send", "task_wait",
      "task_result", "task_log", "task_diff", "task_open", "task_rename",
      "task_apply", "task_archive", "task_tab", "task_tab_close", "task_agents",
      "prompts", "project_list", "project_add", "project_remove",
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

describe("MCP lifecycle: disable revokes, re-enable mints fresh", () => {
  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
  });

  it("toggling off unbinds and removes both files; on mints a new token", async () => {
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
      // settings_save unbinds before it resolves; the files are the
      // revocation contract.
      expect(fs.existsSync(tokenFile)).toBe(false);
      expect(fs.existsSync(portFile)).toBe(false);
      await expect(
        raw({ url: urlBefore, headers: { "mcp-method": "tools/list" } }, "{}"),
      ).rejects.toThrow(); // connection refused: nothing is listening
    } finally {
      await setEnabled(true);
    }
    // Fresh credential, and (preferred-port rebind) the same URL, so a
    // pasted client config survives the cycle.
    expect(fs.existsSync(tokenFile)).toBe(true);
    expect(token()).not.toBe(tokenBefore);
    expect(endpoint()).toBe(urlBefore);
    const frame = await rpc("server/discover");
    expect(frame.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("termic");
  });
});
