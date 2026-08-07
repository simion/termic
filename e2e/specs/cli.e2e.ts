// `termic tab` part 2 (GH #138): tab ids end to end, over the REAL
// control socket.
//
// This spec is the coverage docs/plans/cli.md mandates part 2 to start
// with: `PtyRole.tab_id` is set in TerminalPane's spawn call and read by
// Rust's find_tab_pty, a thread no unit suite can see whole. Every case
// here keys on "a tab opened by `termic tab` is addressable by the id
// that command returned": if the field is dropped, misspelled, or wired
// to the wrong id, `logs --tab` below stops resolving and this file goes
// red, instead of the failure surfacing as a mystery in some future
// user's script.
//
// The socket speaks the wire protocol directly (the app.e2e.ts raise
// precedent) with the per-boot token from the profile dir, so the whole
// server path runs: auth, task resolution, the selector resolver, the
// webview RPCs.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";
import { dataDir } from "../../wdio.conf.js";
import { archiveTask, openTask, requireTermicApi, waitForAppShell } from "../helpers.js";

const socketPath = path.join(dataDir, "termic.sock");
const token = () => fs.readFileSync(path.join(dataDir, "cli-token"), "utf8").trim();

/** One request over a fresh connection; stream lines (heartbeats,
 *  state events) are skipped, the final Reply resolves. */
function rpc(cmd: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    const to = setTimeout(() => {
      c.destroy();
      reject(new Error("no reply from the control socket within 30s"));
    }, 30_000);
    c.on("connect", () =>
      c.write(JSON.stringify({ id: "e2e", token: token(), ...cmd }) + "\n"),
    );
    c.on("data", d => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.stream) continue; // heartbeat / state / queued events
        clearTimeout(to);
        c.end();
        resolve(msg);
        return;
      }
    });
    c.on("error", e => {
      clearTimeout(to);
      reject(e);
    });
  });
}

/** Poll a tab's live PTY through the store (spawn is async). */
async function waitForTabPty(taskId: string, tabId: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (tid, tab) =>
          (window.__termic!.useApp.getState().tabs[tid] ?? []).some(
            (t: any) => t.id === tab && t.ptyId,
          ),
        taskId,
        tabId,
      ),
    { timeout: 20_000, timeoutMsg: `tab ${tabId} never got a PTY` },
  );
}

describe("termic tab: ids are addressable end to end (GH #138 part 2)", () => {
  let taskId: string;
  let secondTabId: string;

  // The task carries three live agent tabs by the end; leaving it in
  // the shared profile makes it the ACTIVE task of every later spec
  // file's launch, whose hidden mounted strip then wins unscoped
  // queries (helpers trap #2) and broke tabs-layout/files wholesale.
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("cli-tabs");
    await browser.waitUntil(
      () =>
        browser.execute(
          tid =>
            (window.__termic!.useApp.getState().tabs[tid] ?? []).some(
              (t: any) => t.ptyId,
            ),
          taskId,
        ),
      { timeout: 20_000, timeoutMsg: "default agent PTY never spawned" },
    );
  });

  it("opens a second agent tab and returns its stable id", async () => {
    const r = await rpc({
      cmd: "tab",
      task: "cli-tabs",
      kind: { tab: "agent", id: "fakeagent" },
    });
    expect(r.ok).toBe(true);
    secondTabId = r.data.tab_id;
    expect(secondTabId).toBeTruthy();
    // The id is the STORE's id for a real tab, not something invented
    // on the way out.
    const inStore = await browser.execute(
      (tid, tab) =>
        (window.__termic!.useApp.getState().tabs[tid] ?? []).some(
          (t: any) => t.id === tab,
        ),
      taskId,
      secondTabId,
    );
    expect(inStore).toBe(true);
    await waitForTabPty(taskId, secondTabId);
  });

  it("logs --tab resolves that id to that tab's own PTY", async () => {
    // THE tab_id assertion: find_tab_pty resolves the returned id via
    // PtyRole.tab_id, with no default-tab fallback to hide a broken
    // thread behind.
    const r = await rpc({ cmd: "logs", task: "cli-tabs", tab: secondTabId });
    expect(r.ok).toBe(true);
    expect(r.data.source).toBe("agent");
    expect(r.data.data).toContain("FAKE-AGENT ready");
  });

  it("send --tab delivers to the targeted tab, not the default", async () => {
    const marker = `MARKER-${Date.now()}`;
    const r = await rpc({
      cmd: "send",
      task: "cli-tabs",
      prompt: marker,
      tab: secondTabId,
    });
    expect(r.ok).toBe(true);
    // The fake agent echoes each prompt line; the echo must land in the
    // TARGETED tab's ring and only there.
    await browser.waitUntil(
      async () => {
        const logs = await rpc({ cmd: "logs", task: "cli-tabs", tab: secondTabId });
        return logs.ok && logs.data.data.includes(`FAKE-AGENT echo: ${marker}`);
      },
      { timeout: 20_000, timeoutMsg: "the prompt never reached the targeted tab" },
    );
    const dflt = await rpc({ cmd: "logs", task: "cli-tabs" });
    expect(dflt.ok).toBe(true);
    expect(dflt.data.data).not.toContain(marker);
  });

  it("status lists the strip with the same ids and 1-based indices", async () => {
    // status's tab list is the --tab contract surface: what it prints
    // is what selectors mean.
    await browser.waitUntil(
      async () => {
        const r = await rpc({ cmd: "status", task: "cli-tabs" });
        return r.ok && Array.isArray(r.data.task.tabs) && r.data.task.tabs.length >= 2;
      },
      { timeout: 10_000, timeoutMsg: "status never listed the strip" },
    );
    const r = await rpc({ cmd: "status", task: "cli-tabs" });
    const tabs = r.data.task.tabs;
    expect(tabs.map((t: any) => t.index)).toEqual(tabs.map((_: any, i: number) => i + 1));
    expect(tabs.some((t: any) => t.id === secondTabId)).toBe(true);
    expect(tabs.filter((t: any) => t.is_default).length).toBe(1);
    expect(tabs.every((t: any) => t.kind === "agent")).toBe(true);
  });

  it("tab -p opens a tab and confirms delivery into exactly that tab", async () => {
    const marker = `MARKER-P-${Date.now()}`;
    const r = await rpc({
      cmd: "tab",
      task: "cli-tabs",
      kind: { tab: "agent", id: "fakeagent" },
      prompt: marker,
    });
    expect(r.ok).toBe(true);
    const newId = r.data.tab_id;
    expect(r.data.prompt.mode).toBeTruthy();
    // The rode-along prompt goes through the targeted send route, so the
    // echo must appear in the NEW tab's ring (spawn + settle beat first).
    await browser.waitUntil(
      async () => {
        const logs = await rpc({ cmd: "logs", task: "cli-tabs", tab: newId });
        return logs.ok && logs.data.data.includes(`FAKE-AGENT echo: ${marker}`);
      },
      { timeout: 40_000, timeoutMsg: "tab -p's prompt never reached the new tab" },
    );
  });

  it("selector misses are typed errors, ambiguity names the candidates", async () => {
    const miss = await rpc({ cmd: "logs", task: "cli-tabs", tab: "99" });
    expect(miss.ok).toBe(false);
    expect(miss.error.code).toBe("not_found");
    // Three fakeagent tabs by now: a title selector must refuse with the
    // candidates listed, never guess one.
    const ambiguous = await rpc({ cmd: "logs", task: "cli-tabs", tab: "fakeagent" });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error.code).toBe("ambiguous");
    expect(ambiguous.error.message).toContain(secondTabId);
  });
});

// `termic rename` (GH #153) over the REAL socket: the whole server path
// (auth, resolve_task_arg, the conflict pre-check, the rename_task
// webview RPC, the post-write disk re-read) in one thread. The unit
// suites stub the webview; this is the one place a broken RPC handler
// registration or a stale-reply regression surfaces.
describe("termic rename: label only, over the real socket (GH #153)", () => {
  let taskId: string;
  let otherId: string;

  after(async () => {
    if (taskId) await archiveTask(taskId);
    if (otherId) await archiveTask(otherId);
  });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("cli-rename", false);
    otherId = await openTask("cli-rename-other", false);
  });

  it("renames by explicit name; the reply and the store carry the new label", async () => {
    const r = await rpc({ cmd: "rename", task: "cli-rename", name: "PR 42 - retitled" });
    expect(r.ok).toBe(true);
    expect(r.data.kind).toBe("rename");
    expect(r.data.old_name).toBe("cli-rename");
    // The reply is the post-write re-read, so this pins "reply reflects
    // what was persisted" against the real disk, not a stub mirror.
    expect(r.data.task.name).toBe("PR 42 - retitled");
    const inStore = await browser.execute(
      (i) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === i)?.name,
      taskId,
    );
    expect(inStore).toBe("PR 42 - retitled");
  });

  it("refuses a same-project duplicate with a typed conflict", async () => {
    // Resolve by id, not by the name case 1 just set: ids also exercise
    // the resolver's id arm, and a case-1 failure then reports as ITS
    // assertion instead of a misleading not_found here.
    const r = await rpc({ cmd: "rename", task: taskId, name: "cli-rename-other" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("conflict");
    expect(r.error.message).toContain("cli-rename-other");
  });
});

// `termic new --from` / `--resume` (GH #169): adopt a worktree some outside
// script created, over the real socket. The full server thread runs: project
// resolution from the worktree's own repo (repo_worktrees), the import RPC
// into the webview, Rust's worktree validation, and the mount. The --resume
// SEEDING is pinned by unit suites on both sides (cli_server.rs, agents.test,
// cliTab.integration.test); here we pin the wiring plus the typed refusals a
// script would hit.
describe("termic new --from: adopt an existing worktree (GH #169)", () => {
  let repoRoot: string;
  let wtPath: string;
  let adoptedId: string | undefined;

  const git = (args: string, cwd: string) => execSync(`git ${args}`, { cwd, stdio: "pipe" });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    repoRoot = await browser.execute(
      () =>
        window.__termic!.useApp
          .getState()
          .projects.find((p: any) => p.name === "fixture-repo").root_path as string,
    );
    // The issue's shape: a worktree termic did NOT create, parked outside
    // every registered project root.
    wtPath = path.join(dataDir, "..", "adopt-me-wt");
    git(`worktree add -b adopt-me ${JSON.stringify(wtPath)}`, repoRoot);
  });

  after(async () => {
    // Archive removes the worktree dir; the prune + branch delete put the
    // fixture repo back exactly as seeded for later spec files. The prune
    // only drops OUR stale registration: the dir is already gone, unlike
    // the seeded sbcheck worktree, which stays intact.
    if (adoptedId) await archiveTask(adoptedId);
    try { git(`worktree remove --force ${JSON.stringify(wtPath)}`, repoRoot); } catch { /* archived */ }
    try { git("worktree prune", repoRoot); } catch { /* best-effort */ }
    try { git("branch -D adopt-me", repoRoot); } catch { /* best-effort */ }
  });

  it("adopts the worktree with --resume, seeding the session end to end", async () => {
    // fakeagent mirrors claude's registry entry, resume_id_args included,
    // so the WHOLE thread runs for real at zero tokens: socket → import →
    // agent_session_ids seed → mount → the default tab picks the id up.
    const r = await rpc({
      cmd: "new", name: "", from: wtPath, agent: "fakeagent", resume: "SESSION-EXT",
    });
    expect(r.ok).toBe(true);
    adoptedId = r.data.task.id;
    expect(r.data.task.name).toBe("adopt-me");
    expect(r.data.task.branch).toBe("adopt-me");
    expect(fs.realpathSync(r.data.task.path)).toBe(fs.realpathSync(wtPath));
    // The seed landed on the task and on the mounted default tab: this is
    // what the first spawn's `--resume {UUID}` expands from.
    const seeded = await browser.execute(id => {
      const s = window.__termic!.useApp.getState();
      const task = s.tasks.find((t: any) => t.id === id);
      const tab = (s.tabs[id!] ?? []).find((t: any) => t.is_default);
      return {
        sessionIds: task?.agent_session_ids,
        resumable: task?.has_resumable_history,
        tabSession: tab?.sessionId,
      };
    }, adoptedId);
    expect(seeded.sessionIds?.fakeagent).toBe("SESSION-EXT");
    // Deliberately false: the seed is per-cli, and the task-wide flag
    // would make OTHER agents' first tabs cwd-resume unrelated sessions.
    expect(seeded.resumable).toBe(false);
    expect(seeded.tabSession).toBe("SESSION-EXT");
  });

  it("--resume also seeds a plain create (no --from)", async () => {
    // GH #169 follow-up: the session field rides every create path, not
    // just import. A fresh worktree create carries the seed the same way.
    const r = await rpc({
      cmd: "new", name: "resume-create", mode: "worktree",
      agent: "fakeagent", resume: "SESSION-CREATE", project: "fixture-repo",
    });
    expect(r.ok).toBe(true);
    try {
      const seeded = await browser.execute(
        id =>
          window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)
            ?.agent_session_ids,
        r.data.task.id,
      );
      expect(seeded?.fakeagent).toBe("SESSION-CREATE");
    } finally {
      await archiveTask(r.data.task.id);
    }
  });

  it("a DERIVED name colliding with a live task auto-bumps past it", async () => {
    // A detached worktree derives its name from the dir basename, here
    // "adopt-me", colliding with the live task adopted above. Derived
    // names auto-bump past live twins (the GH #153 unique_task_name
    // rule); only a caller-TYPED name refuses as a conflict.
    const dupPath = path.join(dataDir, "..", "adopt-me");
    git(`worktree add --detach ${JSON.stringify(dupPath)}`, repoRoot);
    let bumpedId: string | undefined;
    try {
      const r = await rpc({ cmd: "new", name: "", from: dupPath, agent: "fakeagent" });
      expect(r.ok).toBe(true);
      bumpedId = r.data.task.id;
      expect(r.data.task.name).toBe("adopt-me-2");

      // The TYPED spelling of the same collision stays a typed conflict.
      const typed = await rpc({ cmd: "new", name: "adopt-me", from: dupPath, agent: "fakeagent" });
      expect(typed.ok).toBe(false);
      expect(typed.error.code).toBe("conflict");
      expect(typed.error.message).toContain("already");
    } finally {
      if (bumpedId) await archiveTask(bumpedId);
      try { git(`worktree remove --force ${JSON.stringify(dupPath)}`, repoRoot); } catch { /* best-effort */ }
      try { git("worktree prune", repoRoot); } catch { /* best-effort */ }
    }
  });

  it("re-adopting the same worktree is a clean error, not a second task", async () => {
    const r = await rpc({ cmd: "new", name: "", from: wtPath, agent: "fakeagent" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("conflict");
    expect(r.error.message).toContain("already open as a task");
  });

  it("a plain directory (no git anywhere above it) is refused", async () => {
    // NOT a dir inside the termic checkout: rev-parse would find THAT repo
    // and shift the error to unregistered-project, an environment accident.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "termic-e2e-plain-"));
    try {
      const r = await rpc({ cmd: "new", name: "", from: plain, agent: "fakeagent" });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("bad_request");
      expect(r.error.message).toContain("not a git worktree");
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it("tab --resume seeds the NEW tab's own session id", async () => {
    const r = await rpc({
      cmd: "tab",
      task: "adopt-me",
      kind: { tab: "agent", id: "fakeagent" },
      resume: "SESSION-TAB",
    });
    expect(r.ok).toBe(true);
    const tabSession = await browser.execute(
      (id, tab) =>
        (window.__termic!.useApp.getState().tabs[id!] ?? []).find((t: any) => t.id === tab)
          ?.sessionId,
      adoptedId,
      r.data.tab_id,
    );
    expect(tabSession).toBe("SESSION-TAB");
  });

  it("--resume refuses an agent with no id-resume support, naming the gate", async () => {
    // codex's seeded entry has no resume_id_args, so a seeded id would be
    // silently ignored at spawn; the server must refuse instead. Same gate
    // on both verbs.
    const viaNew = await rpc({
      cmd: "new", name: "", from: wtPath, agent: "codex", resume: "SESSION-X",
    });
    expect(viaNew.ok).toBe(false);
    expect(viaNew.error.code).toBe("unsupported");
    expect(viaNew.error.message).toContain("cannot resume a session by id");

    const viaTab = await rpc({
      cmd: "tab",
      task: "adopt-me",
      kind: { tab: "agent", id: "codex" },
      resume: "SESSION-X",
    });
    expect(viaTab.ok).toBe(false);
    expect(viaTab.error.code).toBe("unsupported");
    expect(viaTab.error.message).toContain("cannot resume a session by id");
  });
});
