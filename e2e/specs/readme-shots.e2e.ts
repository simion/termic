// The README's screenshots (docs/hero.png, docs/screenshots/*.png), staged in
// the e2e profile so they can be retaken whenever the UI moves on.
//
// NOT part of the suite: wdio.conf.ts excludes this file unless
// TERMIC_E2E_README_SHOTS is set, and it asserts nothing about features (the
// specs for the Kanban board, schedules and preview comments do that). Run it
// after `make e2e` has built and seeded:
//
//   TERMIC_E2E_README_SHOTS=1 npm run test:e2e -- --spec e2e/specs/readme-shots.e2e.ts
//
// then copy .e2e/artifacts/readme-*.png into docs/ (see docs/e2e-tests.md).
//
// Everything on screen is synthetic: three `acme-*` repos made here under
// .e2e/readme, agents labelled claude and codex that run
// e2e/fixtures/readme-agent.sh, and its scripted transcripts. Each shot is
// refused if the page text carries this machine's home path, user name or
// host name, because a screenshot in the README is a fixture (CLAUDE.md
// "Fixtures").

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveTask, clickWhenVisible, dismissOverlays, ensureActiveTask, openRightTab, requireTermicApi, rmTree, snap,
  submitToAgent, waitForAgentReady, waitForAppShell, waitForWorkBadge, waitForWorkBadgeGone, waitVisible,
} from "../helpers.js";

const root = path.join(process.cwd(), ".e2e", "readme");
const agentScript = path.resolve("e2e/fixtures/readme-agent.sh");
const AGENTS = [
  { id: "readme-claude", label: "claude", extends: "claude" },
  { id: "readme-codex", label: "codex", extends: "codex" },
];

/** The demo repos' committed files. */
const REPOS: Record<string, Record<string, string>> = {
  "acme-api": {
    "README.md": "# acme-api\n\nAuth and billing API behind the Acme storefront.\n",
    "package.json": JSON.stringify({ name: "acme-api", private: true, scripts: { test: "vitest run" } }, null, 2) + "\n",
    "src/server.ts": 'import { login } from "./auth/login";\n\nexport const routes = { "POST /login": login };\n',
    "src/auth/login.ts": [
      'import { findUser } from "../db/users";',
      'import { createSession } from "./session";',
      "",
      "export async function login(req: Request): Promise<Response> {",
      "  const { email, password } = await req.json();",
      "  const user = await findUser(email);",
      "  if (!user || !(await user.verify(password))) {",
      '    return new Response("invalid credentials", { status: 401 });',
      "  }",
      "  return Response.json(await createSession(user));",
      "}",
      "",
    ].join("\n"),
    "src/auth/session.ts": "export async function createSession(user: { id: string }) {\n  return { user: user.id, expires: Date.now() + 3_600_000 };\n}\n",
    "src/middleware/index.ts": "export const middleware = [];\n",
    "src/db/users.ts": "export async function findUser(email: string) {\n  return null as null | { id: string; verify(p: string): Promise<boolean> };\n}\n",
    "tests/login.test.ts": 'import { test } from "vitest";\n\ntest.todo("login");\n',
    "docs/plans/rate-limiting.md": [
      "# Rate limiting for /login",
      "",
      "Credential stuffing against `POST /login` is our noisiest alert. Limit",
      "attempts before they reach the password check, so a burst costs us a",
      "counter lookup instead of a bcrypt round.",
      "",
      "## Approach",
      "",
      "- A token bucket per client IP: 5 attempts, refilled at one every 12s.",
      "- Over the limit, answer `429` with a `Retry-After` header and log the",
      "  IP once per window, not once per request.",
      "- Keep the buckets in memory for now. One instance serves login today.",
      "",
      "> [!NOTE]",
      "> A successful login does not refill the bucket. Otherwise one valid",
      "> account would unlock unlimited guesses at the others.",
      "",
      "## Tests",
      "",
      "- [x] Five attempts pass, the sixth gets 429",
      "- [x] `Retry-After` counts down to the next token",
      "- [ ] Two IPs never share a bucket",
      "",
      "## Later",
      "",
      "1. Move the buckets to Redis once login runs on more than one instance.",
      "2. Decide whether a known-good device skips the limit.",
      "",
    ].join("\n"),
  },
  "acme-web": {
    "README.md": "# acme-web\n\nThe Acme storefront.\n",
    "package.json": JSON.stringify({ name: "acme-web", private: true }, null, 2) + "\n",
    "src/app.tsx": 'export function App() {\n  return <main id="app" />;\n}\n',
    "src/pages/checkout.tsx": "export function Checkout() {\n  return <form />;\n}\n",
    "src/components/Button.tsx": "export function Button(props: { label: string }) {\n  return <button>{props.label}</button>;\n}\n",
  },
  "acme-infra": {
    "README.md": "# acme-infra\n\nTerraform for the Acme stack.\n",
    "main.tf": 'terraform {\n  required_version = ">= 1.6"\n}\n\nmodule "network" {\n  source = "./modules/network"\n}\n',
    "variables.tf": 'variable "region" {\n  default = "eu-west-1"\n}\n',
    "modules/network/main.tf": 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n',
  },
};

/** What the hero task's agent "did": its transcript names these files. */
const HERO_CHANGES: Record<string, string> = {
  "src/auth/rateLimit.ts": [
    "const CAPACITY = 5;",
    "const REFILL_MS = 12_000;",
    "",
    "type Bucket = { tokens: number; at: number };",
    "const buckets = new Map<string, Bucket>();",
    "",
    "/** Take a token for `ip`. Returns ms to wait when there is none. */",
    "export function take(ip: string, now = Date.now()): number {",
    "  const b = buckets.get(ip) ?? { tokens: CAPACITY, at: now };",
    "  const refill = Math.floor((now - b.at) / REFILL_MS);",
    "  if (refill > 0) {",
    "    b.tokens = Math.min(CAPACITY, b.tokens + refill);",
    "    b.at += refill * REFILL_MS;",
    "  }",
    "  buckets.set(ip, b);",
    "  if (b.tokens === 0) return REFILL_MS - (now - b.at);",
    "  b.tokens -= 1;",
    "  return 0;",
    "}",
    "",
  ].join("\n"),
  "src/auth/login.ts": [
    'import { findUser } from "../db/users";',
    'import { take } from "./rateLimit";',
    'import { createSession } from "./session";',
    "",
    "export async function login(req: Request): Promise<Response> {",
    '  const wait = take(req.headers.get("x-forwarded-for") ?? "unknown");',
    "  if (wait > 0) {",
    '    return new Response("too many attempts", {',
    '      status: 429, headers: { "Retry-After": String(Math.ceil(wait / 1000)) },',
    "    });",
    "  }",
    "  const { email, password } = await req.json();",
    "  const user = await findUser(email);",
    "  if (!user || !(await user.verify(password))) {",
    '    return new Response("invalid credentials", { status: 401 });',
    "  }",
    "  return Response.json(await createSession(user));",
    "}",
    "",
  ].join("\n"),
  "tests/rateLimit.test.ts": [
    'import { expect, test } from "vitest";',
    'import { take } from "../src/auth/rateLimit";',
    "",
    'test("five attempts pass, the sixth waits", () => {',
    "  for (let i = 0; i < 5; i++) expect(take(\"10.0.0.1\", 0)).toBe(0);",
    '  expect(take("10.0.0.1", 0)).toBe(12_000);',
    "});",
    "",
  ].join("\n"),
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd, stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Termic e2e", GIT_AUTHOR_EMAIL: "e2e@termic.dev",
      GIT_COMMITTER_NAME: "Termic e2e", GIT_COMMITTER_EMAIL: "e2e@termic.dev",
    },
  });

function writeTree(dir: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
}

describe("README screenshots", () => {
  const projectIds: Record<string, string> = {};
  const tasks: Record<string, string> = {};
  let scheduleId = "";
  let weeklyId = "";
  let prefsWere: { theme: string; branch: string } | null = null;

  /** Page text that would identify this machine. Must be empty to shoot. */
  const leaks = () =>
    browser.execute((needles: string[]) => {
      const text = document.body.innerText;
      return needles.filter(n => n && text.includes(n));
    }, [os.homedir(), os.userInfo().username, os.hostname().replace(/\.local$/, "")]);

  /** The seeded fixture project is not part of the story; drop it from the
   *  store (never from disk) right before a shot. The next loadAll brings
   *  it back. */
  const hideFixtureProject = () =>
    browser.execute(() => {
      const app = window.__termic!.useApp;
      app.setState({ projects: app.getState().projects.filter((p: any) => p.name !== "fixture-repo") });
    });

  const shot = async (name: string) => {
    // The release's What's new card, which would sit over the sidebar.
    await browser.execute(() => {
      const card = [...document.querySelectorAll("button[aria-label]")]
        .find(b => b.closest("div")?.textContent?.includes("What's new"));
      (card as HTMLElement | undefined)?.click();
    });
    await hideFixtureProject();
    await dismissOverlays();
    expect(await leaks()).toEqual([]);
    await snap(`readme-${name}.png`);
  };

  const createTask = (project: string, name: string, cli: string) =>
    browser.execute(async (pid, n, c) => {
      const t = window.__termic!;
      const task = await t.ipc.taskCreate({ project_id: pid, name: n, cli: c, base_branch: "main", branch: n });
      await t.useApp.getState().loadAll();
      return task.id as string;
    }, projectIds[project], name, cli);

  const visit = async (id: string) => {
    await ensureActiveTask(id);
    await waitForAgentReady(id);
  };

  const rawLine = (id: string, line: string) =>
    browser.execute(async (tid, l) => {
      const t = window.__termic!;
      const tab = (t.useApp.getState().tabs[tid] ?? [])[0];
      await t.ipc.ptyWrite(tab.ptyId, Array.from(new TextEncoder().encode(`${l}\r`)));
    }, id, line);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();

    // A 1440x900 (logical) window. The embedded driver sizes in PHYSICAL
    // pixels, so ask for twice that on a 2x display.
    const dpr = await browser.execute(() => devicePixelRatio);
    await browser.setWindowSize(1440 * dpr, 900 * dpr).catch((e: unknown) => console.log(`setWindowSize: ${String(e)}`));
    console.log("readme window", await browser.execute(() => ({
      inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], dpr: devicePixelRatio,
      screen: [screen.width, screen.height], uiScale: window.__termic!.usePrefs.getState().uiScale,
      zoom: getComputedStyle(document.documentElement).zoom,
    })));

    prefsWere = await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      return { theme: p.themeMode as string, branch: p.taskBranchName as string };
    });
    await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      p.setThemeMode("claude");
      p.setTaskBranchName("none");
    });

    // Agents labelled as the real CLIs, running the scripted fixture.
    await browser.execute(async (command, defs) => {
      const t = window.__termic!;
      const agents = t.useApp.getState().agents;
      const ids = defs.map((d: any) => d.id);
      await t.ipc.agentsSave([
        ...agents.filter((a: any) => !ids.includes(a.id)),
        ...defs.map((d: any) => {
          const base = agents.find((a: any) => a.id === d.extends);
          return {
            id: d.id, display_name: d.label, command, args: [], extends: d.extends, builtin: false,
            icon_id: base?.icon_id ?? d.extends, color: base?.color ?? "#9aa0a6", capabilities: {},
            sandbox_allowed_paths: [], post_launch_capture: { command: "true" },
          };
        }),
      ]);
      await t.useApp.getState().loadAll();
      // No hooks: the fixture reports through its title, as claude does
      // without them.
      const s = t.useApp;
      s.setState({ agentHooksInstalled: { ...s.getState().agentHooksInstalled, ...Object.fromEntries(ids.map((i: string) => [i, false])) } });
    }, agentScript, AGENTS);

    // Three demo repos, each a project with its worktrees kept under .e2e.
    rmTree(root, { bestEffort: true });
    for (const [name, files] of Object.entries(REPOS)) {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q", "-b", "main");
      writeTree(dir, files);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "Initial commit");
      // Record the id the moment the project exists, so a throw in the
      // update below still leaves it for the after hook to remove.
      projectIds[name] = await browser.execute(async (p) =>
        (await window.__termic!.ipc.projectAdd(p)).id as string, dir);
      await browser.execute(async (id, tasksPath) => {
        const t = window.__termic!;
        const proj = (await t.ipc.projectsList()).find((x: any) => x.id === id)!;
        await t.ipc.projectUpdate({ ...proj, tasks_path: tasksPath, base_branch: "main" });
        await t.useApp.getState().loadAll();
      }, projectIds[name], path.join(root, "tasks", name));
    }
    await browser.execute(async (ours) => {
      const t = window.__termic!;
      const rest = t.useApp.getState().projects.map((p: any) => p.id).filter((id: string) => !ours.includes(id));
      await t.ipc.projectReorder([...ours, ...rest]);
      await t.useApp.getState().loadAll();
    }, Object.values(projectIds));
  });

  after(async () => {
    for (const id of [scheduleId, weeklyId].filter(Boolean)) {
      await browser.execute(async (i) => { await window.__termic!.scheduleRunner.deleteSchedule(i, true); }, id)
        .catch(() => {});
    }
    // Sweep by project, so a throw half way through staging still archives
    // every task it made.
    const live = await browser.execute((pids) =>
      window.__termic!.useApp.getState().tasks
        .filter((t: any) => pids.includes(t.project_id) && !t.archived).map((t: any) => t.id as string),
    Object.values(projectIds)).catch(() => [] as string[]);
    for (const id of live) await archiveTask(id).catch(() => {});
    await browser.execute(async (pids, ids) => {
      const t = window.__termic!;
      for (const id of pids) await t.ipc.projectRemove(id).catch(() => {});
      await t.ipc.agentsSave(t.useApp.getState().agents.filter((a: any) => !ids.includes(a.id)));
      await t.useApp.getState().loadAll();
    }, Object.values(projectIds), AGENTS.map(a => a.id)).catch(() => {});
    if (prefsWere) {
      await browser.execute((was) => {
        const p = window.__termic!.usePrefs.getState();
        p.setThemeMode(was.theme);
        p.setTaskBranchName(was.branch);
      }, prefsWere);
    }
    rmTree(root, { bestEffort: true });
  });

  it("stages a fleet of tasks in every state", async () => {
    tasks.hero = await createTask("acme-api", "rate-limit-login", "readme-claude");
    tasks.session = await createTask("acme-api", "session-expiry", "readme-codex");
    tasks.flaky = await createTask("acme-api", "flaky-login-tests", "readme-claude");
    tasks.node = await createTask("acme-api", "upgrade-node-22", "readme-claude");
    tasks.checkout = await createTask("acme-web", "checkout-redesign", "readme-claude");
    tasks.dark = await createTask("acme-web", "dark-mode-toggle", "readme-codex");
    tasks.tf = await createTask("acme-infra", "terraform-1-9", "readme-claude");

    // The hero's agent "made" the changes its transcript lists.
    const heroPath = await browser.execute((id) =>
      window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id).path as string, tasks.hero);
    writeTree(heroPath, HERO_CHANGES);

    // An orchestrator and the two tasks it started, as one named group.
    await browser.execute(async (lead, members) => {
      const t = window.__termic!;
      for (const m of members) await t.ipc.taskGroupJoin(m, lead, "purple");
      await t.ipc.taskGroupUpdate(lead, "Auth hardening", "purple");
      await t.useApp.getState().loadAll();
    }, tasks.hero, [tasks.session, tasks.flaky]);

    // Working: two agents mid-turn.
    for (const id of [tasks.session, tasks.checkout]) {
      await visit(id);
      await submitToAgent(id, "#work");
      await waitForWorkBadge(id, "working");
    }
    // Done and not yet read: a turn that ended while you were elsewhere.
    await visit(tasks.tf);
    await submitToAgent(tasks.tf, "#work");
    await waitForWorkBadge(tasks.tf, "working");
    // Needs you: an agent blocked on a question.
    await visit(tasks.flaky);
    // The hero: a finished turn, on screen. Its idle title is set after the
    // transcript is printed and echo is off, so nothing typed can land in it.
    await visit(tasks.hero);
    await browser.waitUntil(
      () => browser.execute((id) =>
        String((window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.liveTitle ?? "").startsWith("✳"), tasks.hero),
      { timeout: 15_000, timeoutMsg: "the hero agent never reached its idle title" },
    );
    await submitToAgent(tasks.hero, "#work");
    await waitForWorkBadge(tasks.hero, "working");
    await rawLine(tasks.tf, "#idle");
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      app.markAttention(id, app.tabs[id][0].id, "attention", "Allow edits to tests/login.test.ts?");
    }, tasks.flaky);
    await submitToAgent(tasks.hero, "#idle");
    await waitForWorkBadge(tasks.tf, "done", { timeout: 20_000 });
    // On screen, so its finished turn is read at once: no badge, just no
    // spinner.
    await waitForWorkBadgeGone(tasks.hero, "working", { timeout: 20_000 });
    await waitForWorkBadge(tasks.flaky, "attention");
  });

  it("hero: the sidebar, an agent and its changes", async () => {
    await ensureActiveTask(tasks.hero);
    // A finished turn keeps its done mark even on screen, until the next
    // input (markAttention, taskWorkDone). Wait for it rather than racing
    // it, so every run draws the hero the same way: finished, marked done.
    await browser.waitUntil(
      () => browser.execute((id) => !!(window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.unread, tasks.hero),
      { timeout: 20_000, timeoutMsg: "the hero's finished turn never marked its tab" },
    );
    await openRightTab("Git");
    await browser.waitUntil(
      () => browser.execute(() => document.body.innerText.includes("rateLimit.ts")),
      { timeout: 15_000, timeoutMsg: "the Git tab never listed the hero task's changes" },
    );
    await shot("hero");
  });

  it("board: every task in the column its agent put it in", async () => {
    await clickWhenVisible('[data-testid="nav-board"]');
    await waitVisible('[data-testid="board-view"]');
    await shot("board");
  });

  it("markdown review: a plan in the reader, with a comment for the agent", async () => {
    const DOC = "docs/plans/rate-limiting.md";
    await browser.execute((id, p) => {
      const app = window.__termic!.useApp.getState();
      app.setActiveTask(id);
      app.bumpFsRevision(id);
      app.openPreviewTab(id, { type: "edit", path: p, title: "rate-limiting.md" });
      const tab = app.tabs[id].find((t: any) => t.type === "edit" && t.path === p);
      app.persistTab(id, tab.id);
      app.setActiveTabId(id, tab.id);
      app.patchTab(id, tab.id, { mdView: "preview" });
    }, tasks.hero, DOC);
    await ensureActiveTask(tasks.hero);
    const shown = (sel: string) => `[data-task-id="${tasks.hero}"] ${sel}`;
    await browser.waitUntil(
      () => browser.execute((s) => [...document.querySelectorAll(s)]
        .some(el => el.getBoundingClientRect().width > 0 && el.textContent!.includes("Later")), shown(".markdown-body")),
      { timeout: 15_000, timeoutMsg: "the plan's preview never rendered" },
    );
    // Select a phrase in the rendered text and comment on it, the way a
    // reviewer would.
    await browser.execute((s) => {
      (document.activeElement as HTMLElement | null)?.blur();
      const host = [...document.querySelectorAll<HTMLElement>(s)].find(el => el.getBoundingClientRect().width > 0)!;
      const li = [...host.querySelectorAll("li")].find(x => x.textContent!.startsWith("Keep the buckets in memory"))!;
      const node = li.firstChild as Text;
      const m = /Keep the buckets in memory/.exec(node.nodeValue!)!;
      const r = document.createRange();
      r.setStart(node, m.index);
      r.setEnd(node, m.index + m[0].length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      host.parentElement!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, shown(".markdown-body"));
    await waitVisible('[data-testid="md-add-comment"]');
    await browser.execute(() => document.querySelector('[data-testid="md-add-comment"]')!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    const composer = shown(".markdown-body .tc-comment-composer");
    await waitVisible(`${composer} textarea`);
    await browser.execute((c) => {
      const ta = document.querySelector(`${c} textarea`) as HTMLTextAreaElement;
      ta.value = "Staging already runs two instances. Can this go straight to Redis?";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      (Array.from(document.querySelectorAll(`${c} button`)).find(b => b.textContent === "Add to pending") as HTMLElement).click();
    }, composer);
    await waitVisible(shown(".markdown-body .tc-comment-card"));
    // The preview is the subject: give it the right panel's width.
    const toggleRight = () => browser.execute(() => window.__termic!.useApp.getState().toggleRightPanel());
    await toggleRight();
    try {
      await shot("markdown-review");
    } finally {
      await toggleRight();
    }
  });

  it("scheduled: a daily triage and its runs", async () => {
    weeklyId = await browser.execute(async (pid) =>
      window.__termic!.scheduleRunner.createSchedule({
        projectId: pid,
        agent: { cli: "readme-codex", agentArgs: [], yolo: false, sandbox: { enabled: false, rwPaths: [], allowedHosts: [] } },
        input: {
          name: "Dependency updates",
          prompt: "Bump outdated dependencies one at a time, run the tests after each, and list what you could not update.",
          cadence: { kind: "weekly", time: "07:00", weekday: 1 },
          catch_up: false, keep_runs: 4, report_days: null,
        },
      }), projectIds["acme-web"]);
    scheduleId = await browser.execute(async (pid) =>
      window.__termic!.scheduleRunner.createSchedule({
        projectId: pid,
        agent: { cli: "readme-claude", agentArgs: [], yolo: false, sandbox: { enabled: false, rwPaths: [], allowedHosts: [] } },
        input: {
          name: "Morning triage",
          prompt: "Triage new issues and PRs, check main is green, and write up what needs me today.",
          cadence: { kind: "weekdays", time: "09:00" },
          catch_up: false, keep_runs: 7, report_days: null,
        },
      }), projectIds["acme-api"]);
    const run = await browser.execute(async (id) => window.__termic!.scheduleRunner.runScheduleNow(id), scheduleId) as
      { kind: string; runId?: string };
    expect(run.kind).toBe("started");
    await browser.waitUntil(
      () => browser.execute((id, rid) => {
        const s = window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.schedule;
        return (s?.history ?? []).some((e: any) => e.run_task_id === rid && e.outcome === "fired");
      }, scheduleId, run.runId!),
      { timeout: 30_000 },
    ).catch(async () => {
      const history = await browser.execute((id) =>
        window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.schedule?.history, scheduleId);
      throw new Error(`the triage run never reported: ${JSON.stringify(history)}`);
    });
    await clickWhenVisible('[data-testid="nav-scheduled"]');
    await waitVisible('[data-testid="scheduled-root"]');
    // Open the triage's run history.
    await browser.execute(() => {
      const root = document.querySelector('[data-testid="scheduled-root"]')!;
      const btn = [...root.querySelectorAll("button")].find(b => b.textContent?.trim() === "History");
      (btn as HTMLElement | undefined)?.click();
    });
    await shot("scheduled");
  });
});
