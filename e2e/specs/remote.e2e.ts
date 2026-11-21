// Remote control (docs/remote.md): Settings > Remote, end to end
// against the REAL stream listener. The phone is a fake in this process: it
// speaks the stream with node:crypto (HKDF-SHA256, ChaCha20-Poly1305), so
// every pairing here is also a cross-implementation check of termic-remote's
// seal.rs.
//
// wdio.conf.ts sets TERMIC_PEER_LOOPBACK=1, so the listener binds 127.0.0.1
// and the QR code carries that address.
//
// Servers come in two kinds here. A LOCAL one runs everywhere, CI
// included: the host termic-e2e-local, which wdio.conf.ts's stand-in for
// ssh (e2e/fixtures/fake-ssh.sh) serves from a real termic-server built
// into the debug target. A REAL box is reached over the user's own ssh
// when TERMIC_E2E_TEST_BOX names one.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clickMenuItem, clickPresent, clickWhenVisible, requireTermicApi, setInputValue, snap, typeIntoRemoteTerminal, waitForAppShell, waitForAttr, waitGone, waitVisible } from "../helpers.js";

const nonce = (n: number) => { const b = Buffer.alloc(12); b.writeBigUInt64BE(BigInt(n), 4); return b; };
const key = (pair: Buffer, salt: Buffer, dir: string, host: string, client: string) =>
  Buffer.from(crypto.hkdfSync("sha256", pair, salt, Buffer.from(`termic-stream-v1|${dir}|${host}|${client}`), 32));
function seal(k: Buffer, n: number, m: unknown) {
  const c = crypto.createCipheriv("chacha20-poly1305", k, nonce(n), { authTagLength: 16 });
  return Buffer.concat([c.update(Buffer.from(JSON.stringify(m))), c.final(), c.getAuthTag()]);
}
function open(k: Buffer, n: number, f: Buffer) {
  const d = crypto.createDecipheriv("chacha20-poly1305", k, nonce(n), { authTagLength: 16 });
  d.setAuthTag(f.subarray(f.length - 16));
  return JSON.parse(Buffer.concat([d.update(f.subarray(0, f.length - 16)), d.final()]).toString());
}

function parseLink(link: string) {
  const q = new URLSearchParams(link.slice(link.indexOf("?") + 1));
  return { hosts: q.get("h")!.split(","), id: q.get("id")!, key: Buffer.from(q.get("k")!, "base64url") };
}

/** A fake phone connecting with a pairing link. Resolves once welcomed,
 *  with a promise that settles when the app closes the connection. */
function phone(link: string, id: string, name: string) {
  const l = parseLink(link);
  return new Promise<{ welcome: any; closed: Promise<number>; close(): void }>((resolve, reject) => {
    const ws = new WebSocket(`ws://${l.hosts[0]}/termic-peer/v1/stream`);
    ws.binaryType = "arraybuffer";
    let tx: Buffer | null = null, rx: Buffer | null = null, rn = 0, welcomed = false;
    let onClose: (c: number) => void = () => {};
    const closed = new Promise<number>(r => (onClose = r));
    ws.onmessage = (ev) => {
      const f = Buffer.from(ev.data as ArrayBuffer);
      if (!tx) {
        const salt = crypto.randomBytes(16);
        const s = Buffer.concat([f, salt]);
        tx = key(l.key, s, "c2s", l.id, id);
        rx = key(l.key, s, "s2c", l.id, id);
        ws.send(Buffer.concat([salt, Buffer.from(id, "hex")]));
        ws.send(seal(tx, 0, { t: "hello", v: 1, name, kind: "phone", caps: [] }));
        return;
      }
      const m = open(rx!, rn++, f);
      if (!welcomed && m.t === "welcome") { welcomed = true; resolve({ welcome: m, closed, close: () => ws.close() }); }
    };
    ws.onclose = (ev) => { onClose(ev.code); if (!welcomed) reject(new Error(`closed ${ev.code}`)); };
    ws.onerror = () => {};
  });
}

const status = () => browser.execute(() => window.__termic!.invoke("peer_status")) as Promise<any>;


/** Type `line` into the open shell tab until `done()` holds: the shell may
 *  still be starting on the box when the first keystrokes arrive, and the
 *  command is idempotent, so typing it again is safe. Polls, never sleeps. */
async function typeInShellUntil(line: string, done: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await browser.execute((l) => {
      // The shell tab on screen: others (a Setup tab) stay mounted, hidden.
      const host = [...document.querySelectorAll('[data-testid="aux-terminal"]')].find(e => e.getBoundingClientRect().width > 0)!;
      const ta = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
      ta.focus();
      ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: l, bubbles: true }));
    }, line);
    try {
      await browser.waitUntil(async () => !!(await done()), { timeout: 3_000, interval: 200 });
      return;
    } catch { /* not yet: type it again */ }
  }
  throw new Error(what);
}

describe("Phones and servers", () => {
  const phoneId = crypto.randomBytes(16).toString("hex");
  let link = "";

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    // Start with no phones, whatever an earlier run (or a phone-host
    // session) left paired in this profile: the first cases count them.
    const s = await status().catch(() => null);
    for (const p of s?.phones ?? []) {
      await browser.execute((id) => window.__termic!.invoke("phone_unpair", { id }), p.id).catch(() => {});
    }
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("remote"));
  });

  after(async () => {
    // Leave the profile as it was: no phones, sharing off, settings closed.
    const s = await status().catch(() => null);
    for (const p of s?.phones ?? []) {
      await browser.execute((id) => window.__termic!.invoke("phone_unpair", { id }), p.id).catch(() => {});
    }
    await browser.execute(async () => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      await t.ipc.settingsSave({ ...s, lan_sharing_enabled: false });
      t.useApp.getState().closeSettings();
    }).catch(() => {});
  });

  it("opens with no phone and no server", async () => {
    await waitVisible('[data-testid="remote-section"]');
    expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-phones"]'))).toBe(false);
    expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-servers"]'))).toBe(false);
    // The phone app is not out: one closed row, nothing to press yet.
    expect(await browser.execute(() => document.querySelector('[data-testid="remote-phones-toggle"]')?.getAttribute("aria-expanded"))).toBe("false");
    expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-connect-phone"]'))).toBe(false);
    await snap("remote-settings-empty.png");
  });

  it("shows a QR code with a countdown, turning sharing on to do it", async () => {
    await clickPresent('[data-testid="remote-phones-toggle"]');
    await waitVisible('[data-testid="remote-connect-phone"]');
    await snap("remote-phones-open.png");
    await clickPresent('[data-testid="remote-connect-phone"]');
    await waitVisible('[data-testid="phone-qr"]');
    await waitVisible('[data-testid="phone-qr-countdown"]');
    link = await browser.execute(() => document.querySelector('[data-testid="phone-qr"]')!.getAttribute("data-link") ?? "");
    expect(link).toMatch(/^termic-remote:\/\/pair\?v=1&h=127%2E0%2E0%2E1%3A\d+&id=[0-9a-f]{32}&m=.+&k=[A-Za-z0-9_-]{43}$/);
    const s = await status();
    expect(s.enabled).toBe(true);
    expect(s.phone_pairing).not.toBeNull();
    // The page behind the dialog says so too (it read a stale copy once).
    await waitForAttr('[data-testid="remote-sharing"]', "data-enabled", "true");
    // And the switch DRAWS on: the attribute alone once said true while the
    // knob sat at off.
    await browser.waitUntil(async () => (await browser.execute(() => {
      const b = document.querySelector('[data-testid="remote-sharing"] [role="switch"]') as HTMLElement;
      return b.getAttribute("aria-checked") === "true" && getComputedStyle(b.firstElementChild!).left === "18px";
    })), { timeout: 3000, timeoutMsg: "the sharing switch is not drawn on" });
    await snap("remote-qr.png");
  });

  it("pairs the phone that scans it, and says so", async () => {
    const p = await phone(link, phoneId, "Test iPhone");
    expect(p.welcome.kind).toBe("desktop");
    expect(p.welcome.grant).toBe("drive");
    await waitVisible('[data-testid="phone-paired"]');
    await setInputValue('[data-testid="phone-paired-name"]', "My iPhone");
    await snap("remote-phone-paired.png");
    await clickPresent('[data-testid="phone-paired-done"]');
    await waitGone('[data-testid="phone-paired"]');
    await waitForAttr(`[data-testid="phone-row-${phoneId}"]`, "data-connected", "true");
    const s = await status();
    expect(s.phones.map((x: any) => x.name)).toEqual(["My iPhone"]);
    expect(s.phone_pairing).toBeNull();
    await snap("remote-phone-listed.png");
    p.close();
    await waitForAttr(`[data-testid="phone-row-${phoneId}"]`, "data-connected", "false");
  });

  it("lets no second phone in with a code already used", async () => {
    await expect(phone(link, crypto.randomBytes(16).toString("hex"), "Intruder")).rejects.toThrow("closed 4001");
    expect((await status()).phones.length).toBe(1);
  });

  it("unpairs a phone after a confirmation, cutting its live connection", async () => {
    const p = await phone(link, phoneId, "My iPhone");
    await waitForAttr(`[data-testid="phone-row-${phoneId}"]`, "data-connected", "true");
    await clickPresent(`[data-testid="phone-unpair-${phoneId}"]`);
    await clickPresent('[data-testid="confirm-ok"]');
    // The app shut the socket: the phone sees the close, not a timeout.
    const code = await Promise.race([p.closed, new Promise<number>(r => setTimeout(() => r(-1), 10_000))]);
    expect(code).not.toBe(-1);
    await waitGone(`[data-testid="phone-row-${phoneId}"]`);
    await expect(phone(link, phoneId, "My iPhone")).rejects.toThrow("closed 4001");
  });

  it("opens Add a server from the sidebar's projects header too", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await clickPresent('[data-testid="sidebar-add-server"]');
    await waitVisible('[data-testid="server-ssh"]');
    await browser.execute(() => window.__termic!.useRemote.getState().setDialog({ serverDialog: false }));
    await waitGone('[data-testid="server-ssh"]');
    // And from Add project: the link closes it and opens the server dialog.
    await clickPresent('[data-testid="sidebar-add-project"]');
    await clickPresent('[data-testid="new-project-add-server"]');
    await waitVisible('[data-testid="server-ssh"]');
    await waitGone('[data-testid="project-mode-repo"]');
    await browser.execute(() => window.__termic!.useRemote.getState().setDialog({ serverDialog: false }));
    await waitGone('[data-testid="server-ssh"]');
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("remote"));
  });

  it("checks a server before saving it, and explains a failure in one sentence", async () => {
    await clickPresent('[data-testid="remote-add-server"]');
    await setInputValue('[data-testid="server-ssh"]', "nobody@no-such-host.invalid");
    await clickPresent('[data-testid="server-connect"]');
    await waitVisible('[data-testid="server-reach-error"]', 30_000);
    const msg = await browser.execute(() => document.querySelector('[data-testid="server-reach-error"]')!.textContent ?? "");
    expect(msg).toContain("no-such-host.invalid");
    await snap("remote-server-unreachable.png");
    // Nothing was saved.
    expect(await browser.execute(() => window.__termic!.invoke("server_list"))).toEqual([]);
    await browser.keys("Escape");
    await waitGone('[data-testid="server-checklist"]');
  });

  // Against a real box over the user's ssh: TERMIC_E2E_TEST_BOX=user@host
  // (and TERMIC_E2E_SERVER_BIN_DIR with builds, if termic-server is not
  // installed there yet; wdio.conf.ts hands it to the app as
  // TERMIC_SERVER_BIN_DIR). Both need the E2E_ prefix: wdio.conf.ts drops
  // every other TERMIC_* before the workers start. Skipped otherwise: CI has no box. The box gets a scratch
  // repo and a fake agent (an agents.json entry, the server's own way to
  // add one), so no agent CLI or login is needed there; both are removed,
  // and an agents.json the box already had is put back, at the end.
  const box = process.env.TERMIC_E2E_TEST_BOX;
  const onBox = box ? it : it.skip;
  const BOX_DIR = "termic-e2e-box";
  const ssh = (script: string) => execFileSync("ssh", ["-o", "BatchMode=yes", "--", box!, script], { encoding: "utf8" });
  let serverId = "";

  onBox("adds a real server through the checklist and shows it connected", async () => {
    ssh(`set -e; rm -rf ~/${BOX_DIR}; mkdir -p ~/${BOX_DIR}/repo ~/.termic-server
cd ~/${BOX_DIR}/repo && git init -q -b main && printf 'scripts:\n  setup: touch set-up-ran\n' > .termic.yaml && git add .termic.yaml && git -c user.email=e2e@termic.dev -c user.name=e2e commit -q -m init
printf '%s\n' '#!/bin/sh' 'printf "fake agent ready\\r\\n> "' 'while IFS= read -r l; do printf "box says: %s\\r\\n> " "$l"; done' > ~/${BOX_DIR}/agent.sh
chmod +x ~/${BOX_DIR}/agent.sh
[ -e ~/.termic-server/agents.json ] && mv ~/.termic-server/agents.json ~/.termic-server/agents.json.e2e-bak || true
printf '{"fake":["%s"]}' "$HOME/${BOX_DIR}/agent.sh" > ~/.termic-server/agents.json`);
    await clickPresent('[data-testid="remote-add-server"]');
    await setInputValue('[data-testid="server-ssh"]', box!);
    await setInputValue('[data-testid="server-name"]', "Test box");
    await clickPresent('[data-testid="server-connect"]');
    // termic-server may need installing first: the checklist offers it.
    await browser.waitUntil(async () => browser.execute(() =>
      !!document.querySelector('[data-testid="server-install"]') || !!document.querySelector('[data-testid="server-done"]')),
    { timeout: 60_000, timeoutMsg: "the checklist neither connected nor offered an install" });
    if (await browser.execute(() => !!document.querySelector('[data-testid="server-install"]'))) {
      await clickPresent('[data-testid="server-install"]');
    }
    await waitVisible('[data-testid="server-done"]', 60_000);
    await waitForAttr('[data-testid="server-step-reach"]', "data-mark", "ok");
    await waitForAttr('[data-testid="server-step-installed"]', "data-mark", "ok");
    await waitForAttr('[data-testid="server-step-connect"]', "data-mark", "ok");
    await snap("remote-server-connected.png");
    await clickPresent('[data-testid="server-done-button"]');
    serverId = await browser.execute(() => window.__termic!.useRemote.getState().machines.find((m: any) => m.kind === "server")?.id as string) ?? "";
    await waitForAttr(`[data-testid="server-row-${serverId}"]`, "data-state", "online");
    await snap("remote-server-row.png");
  });

  // A project left on the box by an earlier, interrupted run.
  const dropBoxProjects = async () => {
    const call = (request: Record<string, unknown>) => browser.execute((m, r) =>
      window.__termic!.invoke("remote_call", { machine: m, request: { id: "", ...r } }), serverId, request) as Promise<any>;
    const list = await call({ cmd: "project_list" });
    for (const p of list?.data?.projects ?? []) {
      if (String(p.root_path).includes(BOX_DIR)) await call({ cmd: "project_remove", name: p.name });
    }
  };

  onBox("starts a task on the server from the sidebar, and the agent there answers", async function () {
    this.timeout(120_000);
    expect(serverId).not.toBe("");
    await dropBoxProjects();
    // From the sidebar, as a user would: settings closed.
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    // New task on the server (a server project's + opens this dialog; a box
    // with no projects yet has no row to start from, so open it directly).
    await browser.execute((id) => window.__termic!.useRemote.getState().setDialog({ newTaskOn: id }), serverId);
    // A fresh box has no projects: add one by its path on the box.
    await clickPresent('[data-testid="remote-add-project"]');
    await setInputValue('[data-testid="remote-project-path"]', `~/${BOX_DIR}/repo`);
    // Every label the Start button shows while the project is added: it
    // used to read "Starting..." through that wait, as if a task were.
    await browser.execute(() => {
      const w = window as any;
      w.__startLabels = [];
      const read = () => {
        const t = document.querySelector('[data-testid="remote-new-start"]')?.textContent;
        if (t) w.__startLabels.push(t);
      };
      read();
      w.__startObs = new MutationObserver(read);
      w.__startObs.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await clickPresent('[data-testid="remote-project-add"]');
    // Added: the path field closes and the project is picked.
    await waitGone('[data-testid="remote-project-path"]', 20_000);
    await waitVisible('[data-testid="remote-new-project"]', 20_000);
    expect(await browser.execute(() => (document.querySelector('[data-testid="remote-new-project"]') as HTMLSelectElement | null)?.value)).toBe("repo");
    await waitVisible('[data-testid="remote-agent-fake"]', 20_000);
    await clickPresent('[data-testid="remote-agent-fake"]');
    await setInputValue('[data-testid="remote-new-prompt"]', "hello from the desk");
    await snap("remote-server-new-task.png");
    const labels = await browser.execute(() => { const w = window as any; w.__startObs.disconnect(); return [...new Set(w.__startLabels as string[])]; });
    expect(labels).toEqual(["Start task"]);
    await browser.waitUntil(() => browser.execute(() => !(document.querySelector('[data-testid="remote-new-start"]') as HTMLButtonElement).disabled),
      { timeout: 20_000, timeoutMsg: "Start never became available" });
    await clickPresent('[data-testid="remote-new-start"]');
    // The task opens, and its row is listed under the server.
    await waitVisible('[data-testid="remote-task-view"]', 60_000);
    const task = await browser.waitUntil(async () => browser.execute((id) =>
      // By its name (from the prompt): a real box may already have tasks.
      (window.__termic!.useRemote.getState().machines.find((m: any) => m.id === id)?.tasks ?? []).find((t: any) => String(t.name).includes("hello"))?.id as string | undefined, serverId),
    { timeout: 20_000, timeoutMsg: "the new task never showed under the server" });
    // Listed as an ordinary sidebar row (server_projects.rs).
    await waitVisible(`[data-sidebar-task-id="${task}"]`, 30_000);
    // The prompt reached the agent ON THE BOX, which is the whole point.
    const out = await browser.waitUntil(async () => {
      const r = await browser.execute((m, t) => window.__termic!.invoke("remote_call", { machine: m, request: { id: "", cmd: "logs", task: t } }), serverId, task) as any;
      const data = String(r?.data?.data ?? "");
      return data.includes("box says: hello from the desk") ? data : false;
    }, { timeout: 30_000, timeoutMsg: "the agent on the box never answered the prompt" });
    expect(out).toContain("fake agent ready");
    // The server's PTY has no screen of its own: it follows this pane, and
    // confirms the size it took (term_resize) before the grid draws at it.
    expect(await browser.execute(() => document.querySelector('[data-testid="remote-terminal"]')!.getAttribute("data-owns-size"))).toBe("true");
    const sized = await browser.waitUntil(async () =>
      browser.execute(() => document.querySelector('[data-testid="remote-terminal"]')!.getAttribute("data-size")),
    { timeout: 10_000, timeoutMsg: "the server never took the pane's size" });
    expect(sized).not.toBe("120x40");
    // A follow-up typed into the terminal reaches the same agent.
    await typeIntoRemoteTerminal("and a second thing\r");
    await browser.waitUntil(async () => {
      const r = await browser.execute((m, t) => window.__termic!.invoke("remote_call", { machine: m, request: { id: "", cmd: "logs", task: t } }), serverId, task) as any;
      return String(r?.data?.data ?? "").includes("box says: and a second thing");
    }, { timeout: 30_000, timeoutMsg: "the follow-up typed into the terminal never reached the agent on the box" });
    expect(ssh(`ls ~/.termic-server/worktrees 2>/dev/null | wc -l`).trim()).not.toBe("0");
    await snap("remote-server-task.png");
    // Its git and files are the box's (termic-server exec): a save from the
    // desktop lands there, and a commit made here is the box's newest.
    const wt = await browser.execute((id) => (window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id) as any)?.path as string, task);
    expect(wt).toContain(".termic-server/worktrees");
    // The repo's setup script ran in a Setup tab on the box when the task
    // was created from the dialog.
    await browser.waitUntil(() => ssh(`test -e '${wt}/set-up-ran' && echo yes || true`).trim() === "yes",
      { timeout: 30_000, timeoutMsg: "the setup script never ran on the box" });
    expect(await browser.execute(() => [...document.querySelectorAll('[data-testid="server-tab-shell"]')].map(e => e.textContent?.trim()))).toContain("Setup");
    await browser.execute((id) => window.__termic!.invoke("task_file_write", { id, path: "desk.txt", content: "written from the desk\n" }), task);
    expect(ssh(`cat '${wt}/desk.txt'`)).toBe("written from the desk\n");
    const list = await browser.execute((id) => window.__termic!.invoke("task_dir_list", { id, rel: "", heal: false }), task) as any[];
    expect(list.map(e => e.name)).toContain("desk.txt");
    await browser.execute((id) => window.__termic!.invoke("task_stage", { id, dirName: "", paths: ["desk.txt"] }), task);
    await browser.execute((id) => window.__termic!.invoke("task_commit", { id, dirName: "", subject: "from the desk", body: "", amend: false, push: false }), task);
    expect(ssh(`git -C '${wt}' log -1 --format=%s`).trim()).toBe("from the desk");
    // A shell tab runs on the box: open the task from its sidebar row, add a
    // shell, and what it runs shows up there (checked over ssh).
    await clickPresent(`[data-sidebar-task-id="${task}"]`);
    await clickPresent('[data-testid="server-new-shell"]');
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="aux-terminal"] .xterm-helper-textarea')),
      { timeout: 20_000, timeoutMsg: "the shell tab never mounted its terminal" });
    await typeInShellUntil("uname -s > from-shell.txt\r", () => ssh(`cat '${wt}/from-shell.txt' 2>/dev/null || true`).trim() === "Linux", "the shell tab never ran on the box");
    await snap("remote-real-shell.png");
    // Send to main on the real box: the commit and the untracked file land
    // in the box repo's checkout (git apply and a tar pipe, there).
    const sent = await browser.execute((id) => window.__termic!.invoke("task_send_diff_to_main", { id }), task) as any;
    expect(sent.tracked_files).toBe(1);
    expect(ssh(`cat ~/${BOX_DIR}/repo/desk.txt`)).toBe("written from the desk\n");
    expect(ssh(`cat ~/${BOX_DIR}/repo/from-shell.txt`).trim()).toBe("Linux");
    // Archived from the desktop: the agent stops and its worktree goes, on the box.
    await browser.execute((t) => window.__termic!.invoke("task_archive", { id: t }), task);
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    await waitGone(`[data-sidebar-task-id="${task}"]`, 20_000);
  });

  onBox("removes the server", async () => {
    try {
      await dropBoxProjects();
      await browser.execute(() => window.__termic!.useApp.getState().openSettings("remote"));
      await clickPresent(`[data-testid="server-remove-${serverId}"]`);
      await clickPresent('[data-testid="confirm-ok"]');
      await waitGone(`[data-testid="server-row-${serverId}"]`);
      expect(await browser.execute(() => window.__termic!.invoke("server_list"))).toEqual([]);
    } finally {
      ssh(`rm -rf ~/${BOX_DIR}; rm -f ~/.termic-server/agents.json; [ -e ~/.termic-server/agents.json.e2e-bak ] && mv ~/.termic-server/agents.json.e2e-bak ~/.termic-server/agents.json || true`);
    }
  });

  it("refuses a server name that could pass options to ssh", async () => {
    const err = await browser.execute(() =>
      window.__termic!.invoke("server_add", { ssh: "-oProxyCommand=touch /tmp/x", name: "" }).then(() => "", (e: unknown) => String(e)));
    expect(err).toContain("after `ssh`");
  });
});

// A real termic-server on this machine, behind the ssh stand-in. Not on
// Windows, where termic-server does not run (and wdio.conf.ts sets no
// stand-in).
const localBox = process.env.TERMIC_E2E_LOCAL_BOX;
const describeLocal = process.platform !== "win32" && localBox ? describe : describe.skip;

describeLocal("A server's tasks in the sidebar (local termic-server)", function () {
  this.timeout(120_000);
  const HOST = "termic-e2e-local";
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const box = localBox!;
  const repo = path.join(box, "repo");
  const bin = path.join(process.env.TERMIC_E2E_SERVER_DIR ?? path.join(repoRoot, "src-tauri", "target", "debug"), "termic-server");
  const server = (...args: string[]) => execFileSync(bin, args, { env: { ...process.env, HOME: box, SHELL: "/bin/sh" }, encoding: "utf8" });
  let serverId = "";
  let task = "";
  const call = (request: Record<string, unknown>) => browser.execute((m, r) =>
    window.__termic!.invoke("remote_call", { machine: m, request: { id: "", ...r } }), serverId, request) as Promise<any>;
  const logs = async () => String((await call({ cmd: "logs", task }))?.data?.data ?? "");
  const row = () => `[data-sidebar-task-id="${task}"]`;
  const openMenu = async () => {
    await browser.execute((sel) => {
      const el = document.querySelector(sel)!;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5, button: 2 }));
    }, row());
    await browser.waitUntil(() => browser.execute(() => document.querySelectorAll("[role='menuitem']").length > 0), { timeout: 5000, timeoutMsg: "no menu" });
  };
  const menuItems = () => browser.execute(() => [...document.querySelectorAll("[role='menuitem']")].map(e => e.textContent?.trim() ?? ""));
  const closeMenu = () => browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    // The debug target's termic-server, fresh (no-op when it already is).
    execFileSync("cargo", ["build", "-q", "-p", "termic-server"], { cwd: path.join(repoRoot, "src-tauri"), stdio: "inherit" });
    try { server("stop"); } catch { /* not running */ }
    rmSync(box, { recursive: true, force: true });
    mkdirSync(path.join(box, ".termic-server"), { recursive: true });
    mkdirSync(repo, { recursive: true });
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "e2e@termic.dev"], ["config", "user.name", "e2e"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
      execFileSync("git", ["-C", repo, ...args]);
    }
    // A fake agent, the server's own way to add one (agents.json): it
    // echoes, and asks a question when told to.
    const agent = path.join(box, "agent.sh");
    writeFileSync(agent, [
      "#!/bin/sh",
      "printf 'fake agent ready\\r\\n> '",
      "while IFS= read -r l; do",
      "  case \"$l\" in",
      "    *ask*) printf 'Do you want to proceed? (y/n) ' ;;",
      "    *) printf 'box says: %s\\r\\n> ' \"$l\" ;;",
      "  esac",
      "done",
      "",
    ].join("\n"));
    chmodSync(agent, 0o755);
    writeFileSync(path.join(box, ".termic-server", "agents.json"), JSON.stringify({ fake: [agent] }));
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  after(async () => {
    if (serverId) await browser.execute((id) => window.__termic!.invoke("server_remove", { id }), serverId).catch(() => {});
    await browser.execute(() => window.__termic!.useRemote.getState().openTask(null)).catch(() => {});
    try { server("stop"); } catch { /* already gone */ }
    rmSync(box, { recursive: true, force: true });
  });

  it("connects, and lists the server's project and task in the normal sidebar", async () => {
    const rec = await browser.execute((h) => window.__termic!.invoke("server_add", { ssh: h, name: "Local box" }), HOST) as any;
    serverId = rec.id;
    await browser.waitUntil(async () => browser.execute((id) =>
      window.__termic!.useRemote.getState().machines.find((m: any) => m.id === id)?.state === "online", serverId),
    { timeout: 30_000, timeoutMsg: "the local server never came online" });
    const added = await call({ cmd: "project_add", path: repo });
    expect(added.ok).toBe(true);
    const r = await call({ cmd: "new", name: "box-task", project: "repo", agent: "fake", prompt: "hello" });
    expect(r.ok).toBe(true);
    task = r.data.task.id;
    // Mirrored into the desktop's own store (server_projects.rs): an
    // ordinary project tagged with the server, and its task an ordinary row.
    await browser.waitUntil(async () => browser.execute((id, sid) => {
      const s = window.__termic!.useApp.getState();
      const t = s.tasks.find((x: any) => x.id === id);
      return !!t && s.projects.find((p: any) => p.id === t.project_id)?.server === sid;
    }, task, serverId), { timeout: 30_000, timeoutMsg: "the server's task never reached the store" });
    await waitVisible(row());
    await browser.waitUntil(async () => (await logs()).includes("box says: hello"), { timeout: 20_000, timeoutMsg: "the agent never answered" });
    // The old per-server section is gone for servers.
    expect(await browser.execute((id) => !!document.querySelector(`[data-testid="remote-machine-${id}"]`), serverId)).toBe(false);
    await snap("remote-local-server-row.png");
  });

  it("opens the task as its terminal from its row, and typing reaches the agent", async () => {
    await clickPresent(row());
    await waitVisible('[data-testid="remote-task-view"]', 20_000);
    await waitVisible('[data-testid="remote-terminal"]');
    expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-tabs"]'))).toBe(false);
    expect(await browser.execute(() => document.querySelector('[data-testid="remote-terminal"]')!.getAttribute("data-owns-size"))).toBe("true");
    await typeIntoRemoteTerminal("typed here\r");
    await browser.waitUntil(async () => (await logs()).includes("box says: typed here"), { timeout: 20_000, timeoutMsg: "keys typed into the terminal never reached the agent" });
    await snap("remote-local-server-task.png");
    // The top bar's Prompts menu sends a prompt to the agent on the box.
    const pid = await browser.execute(() => (window.__termic as any).usePromptLibrary.getState().addPrompt({ title: "Box prompt", body: "prompt from the menu", enabled: true }) as string);
    try {
      // Radix opens a menu on pointerdown, which el.click() skips.
      await browser.execute(() => {
        const el = document.querySelector('[data-testid="prompts-menu"]') as HTMLElement;
        const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as PointerEventInit;
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
      });
      await browser.waitUntil(() => browser.execute(() => {
        const item = [...document.querySelectorAll('[data-testid="server-prompt"]')].find(e => e.textContent?.includes("Box prompt")) as HTMLElement | undefined;
        item?.click();
        return !!item;
      }), { timeout: 10_000, timeoutMsg: "the Prompts menu never listed the prompt" });
      await browser.waitUntil(async () => (await logs()).includes("box says: prompt from the menu"),
        { timeout: 20_000, timeoutMsg: "a prompt from the Prompts menu never reached the agent on the box" });
    } finally {
      await browser.execute((id) => (window.__termic as any).usePromptLibrary.getState().deletePrompt(id), pid);
    }
    // Open with: an editor opens the worktree ON THE BOX over SSH (its
    // Remote-SSH URL), not a local folder. The e2e build records the URL.
    const browserLog = path.join(process.cwd(), ".e2e", "profile", "e2e-browser.log");
    rmSync(browserLog, { force: true });
    await browser.execute(() => {
      const el = document.querySelector('[data-testid="server-open-with"]') as HTMLElement;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as PointerEventInit;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    });
    await clickWhenVisible('[data-testid="server-open-vscode"]');
    const taskPath = await browser.execute((id) => (window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id) as any)?.path as string, task);
    await browser.waitUntil(() => existsSync(browserLog) && readFileSync(browserLog, "utf8").includes(`vscode://vscode-remote/ssh-remote+termic-e2e-local${taskPath}`),
      { timeout: 10_000, timeoutMsg: "Open with never asked the OS for the editor's SSH URL" });
  });

  it("runs the task's git on the box: branches come from its worktree there", async () => {
    // git_bytes (lib.rs) sends a server folder's git through termic-server's exec.
    const branches = await browser.execute((id) => window.__termic!.invoke("task_git_branches", { id, dirName: "" }), task) as string[];
    expect(branches).toContain("box-task");
    const st = await browser.execute((id) => window.__termic!.invoke("task_git_status", { id }), task) as any;
    expect(JSON.stringify(st)).toContain("box-task");
    // The file tree and the editor's read come from the box too, fenced in.
    const wt = await browser.execute((id) => (window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id) as any)?.path, task) as string;
    writeFileSync(path.join(wt, "hello.txt"), "hi from the box\n");
    const list = await browser.execute((id) => window.__termic!.invoke("task_dir_list", { id, rel: "", heal: false }), task) as any[];
    expect(list.map(e => e.name)).toContain("hello.txt");
    expect(await browser.execute((id) => window.__termic!.invoke("task_file_read", { id, path: "hello.txt" }), task)).toBe("hi from the box\n");
    const escape = await browser.execute((id) => window.__termic!.invoke("task_file_read", { id, path: "../../../etc/hosts" }).then(() => "read", (e: unknown) => String(e)), task);
    expect(escape).toContain("outside the task");
    // Saving from the editor writes it on the box; stage and commit run there.
    await browser.execute((id) => window.__termic!.invoke("task_file_write", { id, path: "hello.txt", content: "edited on the desk\n" }), task);
    expect(readFileSync(path.join(wt, "hello.txt"), "utf8")).toBe("edited on the desk\n");
    await browser.execute((id) => window.__termic!.invoke("task_stage", { id, dirName: "", paths: ["hello.txt"] }), task);
    await browser.execute((id) => window.__termic!.invoke("task_commit", { id, dirName: "", subject: "from the desk", body: "", amend: false, push: false }), task);
    expect(execFileSync("git", ["-C", wt, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim()).toBe("from the desk");
    // And the right panel shows them: its Files tab lists the box's file.
    await clickPresent(row());
    await browser.execute(() => {
      const tab = [...document.querySelectorAll('[data-testid="right-tab"]')].find(b => /files/i.test(b.getAttribute("data-tab") ?? "")) as HTMLElement | undefined;
      tab?.click();
    });
    // No file watcher on a box: Refresh reads the folder again.
    await clickPresent('[data-testid="right-refresh"]');
    await waitVisible('[data-path="hello.txt"]', 20_000);
    // Listed by the box (ls through exec), which hides the worktree's .git.
    expect(await browser.execute(() => !!document.querySelector('[data-path=".git"]'))).toBe(false);
    await snap("remote-server-files.png");
    // Opening a file from the tree shows it in the server task's view (the
    // editor reads it from the box), as a tab beside the agent.
    await clickPresent('[data-path="hello.txt"]');
    await waitVisible('[data-testid="server-tab-file"][data-path="hello.txt"]', 15_000);
    await browser.waitUntil(() => browser.execute(() =>
      [...document.querySelectorAll('[data-testid="remote-task-view"] .cm-content')].some(e => e.textContent?.includes("edited on the desk"))),
    { timeout: 15_000, timeoutMsg: "the server file never showed in the editor" });
    await snap("remote-server-editor.png");
    await clickPresent('[data-testid="server-tab-agent"]');
    // No watcher on a box: the agent finishing a turn refreshes the tree
    // instead (its row leaving "working"), with no Refresh clicked.
    writeFileSync(path.join(wt, "after-turn.txt"), "x");
    expect((await call({ cmd: "send", task, prompt: "a turn" })).ok).toBe(true);
    await waitVisible('[data-path="after-turn.txt"]', 30_000);
    // Its top bar keeps what works on a box: prompts, archive, the panel toggle.
    expect(await browser.execute(() => ({
      archive: !!document.querySelector('[data-testid="archive-task"]'),
      panel: !!document.querySelector('[data-testid="toggle-right-panel"]'),
      prompts: !!document.querySelector('[data-testid="prompts-menu"]'),
      run: !!document.querySelector('[data-testid="run-button"]'),
      serverRun: !!document.querySelector('[data-testid="server-run"]'),
      openWith: !!document.querySelector('[data-testid="open-with-launch"]'),
    }))).toEqual({ archive: true, panel: true, prompts: true, run: false, serverRun: true, openWith: false });
    // A shell tab is a shell ON THE BOX, in the task's folder (termic-server
    // pty_open): what it runs lands in the box's worktree.
    await clickPresent('[data-testid="server-new-shell"]');
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="aux-terminal"] .xterm-helper-textarea')),
      { timeout: 20_000, timeoutMsg: "the shell tab never mounted its terminal" });
    await typeInShellUntil("touch from-shell-$((6*7))\r", () => existsSync(path.join(wt, "from-shell-42")), "the shell tab never ran in the box's worktree");
    await snap("remote-server-shell.png");
    // Away and back: the same shell is still running (MainArea keeps a server
    // task with shells mounted), and still takes input.
    const shellTab = await browser.execute(() => document.querySelector('[data-testid="aux-terminal"]')!.getAttribute("data-tab-id"));
    await browser.execute(() => window.__termic!.useApp.getState().setActiveTask(null));
    await browser.waitUntil(() => browser.execute(() => {
      const v = document.querySelector('[data-testid="remote-task-view"]');
      return !!v && v.getBoundingClientRect().width === 0;
    }), { timeout: 10_000, timeoutMsg: "the server task's view never went into hiding" });
    expect(await browser.execute(() => document.querySelector('[data-testid="aux-terminal"]')?.getAttribute("data-tab-id"))).toBe(shellTab);
    await clickPresent(row());
    await typeInShellUntil("touch still-here\r", () => existsSync(path.join(wt, "still-here")), "the shell did not survive switching away from the task");
    // Run: the box repo's `.termic.yaml` run script (read on the box) runs
    // in a new shell tab, in the task's worktree there.
    writeFileSync(path.join(repo, ".termic.yaml"), "scripts:\n  run: touch ran-by-run\n");
    try {
      await clickPresent('[data-testid="server-run"]');
      await browser.waitUntil(() => existsSync(path.join(wt, "ran-by-run")),
        { timeout: 20_000, timeoutMsg: "Run never ran the box's run script in the worktree" });
      expect(await browser.execute(() => [...document.querySelectorAll('[data-testid="server-tab-shell"]')].map(e => e.textContent?.trim()))).toContain("Run");
      // While it runs, Run is Stop; Stop closes the Run tab (ending it on the box).
      await clickPresent('[data-testid="server-stop"]');
      await waitVisible('[data-testid="server-run"]');
      expect(await browser.execute(() => [...document.querySelectorAll('[data-testid="server-tab-shell"]')].map(e => e.textContent?.trim()))).not.toContain("Run");
      // Custom run commands from the box's `.termic.yaml`: Run becomes a menu
      // (read when the task is shown), and a command runs in its own tab.
      writeFileSync(path.join(repo, ".termic.yaml"), "scripts:\n  run: touch ran-by-run\n  run_scripts:\n    - label: Lint\n      command: touch ran-lint\n");
      await browser.execute(() => window.__termic!.useApp.getState().setActiveTask(null));
      await clickPresent(row());
      await browser.waitUntil(async () => {
        await browser.execute(() => {
          const el = document.querySelector('[data-testid="server-run"]') as HTMLElement | null;
          if (!el) return;
          const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as PointerEventInit;
          el.dispatchEvent(new PointerEvent("pointerdown", opts));
          el.dispatchEvent(new PointerEvent("pointerup", opts));
        });
        return browser.execute(() => !!document.querySelector('[data-testid="server-run-custom"]'));
      }, { timeout: 15_000, timeoutMsg: "Run never offered the box's custom command" });
      await clickWhenVisible('[data-testid="server-run-custom"]');
      await browser.waitUntil(() => existsSync(path.join(wt, "ran-lint")),
        { timeout: 20_000, timeoutMsg: "the custom command never ran in the worktree" });
      expect(await browser.execute(() => [...document.querySelectorAll('[data-testid="server-tab-shell"]')].map(e => e.textContent?.trim()))).toContain("Lint");
    } finally {
      rmSync(path.join(repo, ".termic.yaml"), { force: true });
    }
    // Back to the agent: its terminal is still there; closing the shell ends it.
    await clickPresent('[data-testid="server-tab-agent"]');
    await waitVisible('[data-testid="remote-terminal"]');
    for (;;) {
      const closed = await browser.execute(() => {
        const x = document.querySelector('[data-testid="server-tab-shell"] [role="button"]') as HTMLElement | null;
        x?.click();
        return !!x;
      });
      if (!closed) break;
    }
    await waitGone('[data-testid="aux-terminal"]');
    // Send to main runs on the box: the task's committed edit and its
    // untracked files land in the box repo's main checkout, uncommitted.
    expect(await browser.execute(() => !!document.querySelector('[data-testid="send-to-main"]'))).toBe(true);
    try {
      const sent = await browser.execute((id) => window.__termic!.invoke("task_send_diff_to_main", { id }), task) as any;
      expect(sent.tracked_files).toBe(1);
      expect(sent.untracked_files).toBeGreaterThan(0);
      expect(readFileSync(path.join(repo, "hello.txt"), "utf8")).toBe("edited on the desk\n");
      expect(existsSync(path.join(repo, "still-here"))).toBe(true);
      // A dirty main checkout is refused, as locally.
      const again = await browser.execute((id) => window.__termic!.invoke("task_send_diff_to_main", { id }).then(() => "sent", (e: unknown) => JSON.stringify(e)), task);
      expect(again).not.toBe("sent");
    } finally {
      execFileSync("git", ["-C", repo, "reset", "-q", "--hard"]);
      execFileSync("git", ["-C", repo, "clean", "-qfd"]);
    }
  });

  it("keeps the desktop's organisation: a pin and a name stay through a resync", async () => {
    await browser.execute(async (id) => {
      const t = window.__termic!;
      await t.invoke("task_set_pinned", { id, pinned: true });
      await t.invoke("task_rename", { id, name: "renamed-here" });
      await t.useApp.getState().loadAll();
    }, task);
    // Anything on the box changing makes the desktop resync it.
    expect((await call({ cmd: "send", task, prompt: "nudge" })).ok).toBe(true);
    await browser.waitUntil(async () => (await logs()).includes("box says: nudge"), { timeout: 20_000, timeoutMsg: "the nudge never landed" });
    // Outlasts the resync the box's new task list starts (sync_soon: one
    // project_list and list round trip on a local socket, then a reload),
    // so the check below reads the store after it, not before.
    await browser.pause(1500);
    const t = await browser.execute((id) => {
      const x = window.__termic!.useApp.getState().tasks.find((y: any) => y.id === id) as any;
      return { name: x?.name, pinned: x?.pinned };
    }, task) as any;
    expect(t).toEqual({ name: "renamed-here", pinned: true });
    // Its menu groups it like a local task (groups are the desktop's), and a
    // resync keeps the group.
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, `${row()} [data-testid="task-menu-trigger"]`);
    await clickWhenVisible(`[data-testid="task-move-to-group-${task}"]`);
    await clickWhenVisible(`[data-testid="task-new-group-${task}"]`);
    const grouped = () => browser.execute((id) => !!(window.__termic!.useApp.getState().tasks.find((y: any) => y.id === id) as any)?.group, task);
    await browser.waitUntil(grouped, { timeout: 10_000, timeoutMsg: "the server task never joined a new group" });
    await browser.keys("Escape");
    expect((await call({ cmd: "send", task, prompt: "nudge again" })).ok).toBe(true);
    await browser.waitUntil(async () => (await logs()).includes("box says: nudge again"), { timeout: 20_000, timeoutMsg: "the second nudge never landed" });
    await browser.waitUntil(async () => {
      await browser.execute(() => window.__termic!.useApp.getState().loadAll());
      return grouped();
    }, { timeout: 5_000, timeoutMsg: "a resync dropped the server task's group" });
    // Duplicate: the server's New task dialog, starting from this branch;
    // the box makes the new task from it.
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, `${row()} [data-testid="task-menu-trigger"]`);
    await clickWhenVisible(`[data-testid="task-duplicate-${task}"]`);
    await waitVisible('[data-testid="remote-new-base"]');
    expect(await browser.execute(() => document.querySelector('[data-testid="remote-new-base"]')!.textContent)).toContain("box-task");
    await waitVisible('[data-testid="remote-new-prompt"]', 20_000);
    await setInputValue('[data-testid="remote-new-prompt"]', "the duplicate");
    await setInputValue('[data-testid="remote-new-name"]', "box-dup");
    await browser.waitUntil(() => browser.execute(() => !(document.querySelector('[data-testid="remote-new-start"]') as HTMLButtonElement).disabled),
      { timeout: 20_000, timeoutMsg: "Start never became available" });
    await clickPresent('[data-testid="remote-new-start"]');
    const dup = await browser.waitUntil(async () => ((await call({ cmd: "list" }))?.data?.tasks ?? []).find((t: any) => t.name === "box-dup"),
      { timeout: 30_000, timeoutMsg: "the duplicate never appeared on the box" }) as any;
    expect(dup.base_branch).toBe("box-task");
    expect((await call({ cmd: "archive", task: dup.id })).ok).toBe(true);
  });

  it("shows the server's agent waiting on its row, and raises the alert", async () => {
    const alerts = () => browser.execute(() => (window.__termic!.useRemote.getState().alerts as any[]).map(a => [a.task, a.kind, a.machineName] as string[])) as Promise<string[][]>;
    const before = (await alerts()).length;
    expect((await call({ cmd: "send", task, prompt: "please ask" })).ok).toBe(true);
    await waitForAttr(row(), "data-remote-state", "waiting", 20_000);
    const waiting = () => alerts().then(a => a.slice(before).find(x => x[1] === "waiting"));
    await browser.waitUntil(async () => !!(await waiting()), { timeout: 10_000, timeoutMsg: "no alert for the task that started waiting" });
    expect((await waiting())![0]).toBe(task);
  });

  it("starts a server task from the project's 'Branch new tasks from'", async () => {
    // A desktop setting: the server dialog passes it to the box's `new`.
    const proj = await browser.execute((sid) => window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid), serverId) as any;
    await browser.execute((p) => window.__termic!.invoke("project_update", { p: { ...p, base_branch: "box-task" } }), proj);
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    try {
      await browser.execute((sid, name) => window.__termic!.useRemote.getState().setDialog({ newTaskOn: sid, newTaskProject: name }), serverId, proj.name);
      await waitVisible('[data-testid="remote-new-prompt"]', 20_000);
      expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-new-base"]'))).toBe(false);
      await setInputValue('[data-testid="remote-new-prompt"]', "from the base");
      await setInputValue('[data-testid="remote-new-name"]', "box-based");
      await browser.waitUntil(() => browser.execute(() => !(document.querySelector('[data-testid="remote-new-start"]') as HTMLButtonElement).disabled),
        { timeout: 20_000, timeoutMsg: "Start never became available" });
      await clickPresent('[data-testid="remote-new-start"]');
      const made = await browser.waitUntil(async () => ((await call({ cmd: "list" }))?.data?.tasks ?? []).find((t: any) => t.name === "box-based"),
        { timeout: 30_000, timeoutMsg: "the task never appeared on the box" }) as any;
      expect(made.base_branch).toBe("box-task");
      expect((await call({ cmd: "archive", task: made.id })).ok).toBe(true);
    } finally {
      await browser.execute((p) => window.__termic!.invoke("project_update", { p: { ...p, base_branch: "" } }), proj);
      await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    }
  });

  it("shows a server project's settings without this Mac's sandbox, secrets or code navigation", async () => {
    const pid = await browser.execute((sid) => (window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid) as any)?.id as string, serverId);
    await browser.execute((id) => window.__termic!.useApp.getState().openSettings("repositories", id), pid);
    await waitVisible('[data-repo-tab="git"]');
    const tabs = await browser.execute(() => [...document.querySelectorAll("[data-repo-tab]")].map(e => e.getAttribute("data-repo-tab")));
    expect(tabs).toEqual(["scripts", "git", "advanced"]);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("removing a server project removes it on the box, so a resync does not bring it back", async () => {
    const extra = path.join(box, "extra");
    rmSync(extra, { recursive: true, force: true });
    mkdirSync(extra, { recursive: true });
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "e2e@termic.dev"], ["config", "user.name", "e2e"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
      execFileSync("git", args, { cwd: extra });
    }
    expect((await call({ cmd: "project_add", path: extra })).ok).toBe(true);
    const pid = await browser.waitUntil(async () => browser.execute((sid) =>
      (window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid && p.name === "extra") as any)?.id as string | undefined, serverId),
    { timeout: 30_000, timeoutMsg: "the box's new project never reached the desktop" });
    await browser.execute((id) => window.__termic!.invoke("project_remove", { id }), pid);
    expect(((await call({ cmd: "project_list" }))?.data?.projects ?? []).some((p: any) => p.name === "extra")).toBe(false);
    // A change on the box resyncs; the project stays gone.
    expect((await call({ cmd: "send", task, prompt: "after removal" })).ok).toBe(true);
    await browser.waitUntil(async () => (await logs()).includes("box says: after removal"), { timeout: 20_000, timeoutMsg: "the nudge never landed" });
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    expect(await browser.execute((sid) => window.__termic!.useApp.getState().projects.some((p: any) => p.server === sid && p.name === "extra"), serverId)).toBe(false);
    rmSync(extra, { recursive: true, force: true });
  });

  it("saves a server project's .termic.yaml on the box", async () => {
    const pid = await browser.execute((sid) => (window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid) as any)?.id as string, serverId);
    const cfg = (await browser.execute((id) => window.__termic!.invoke("repo_config_load", { projectId: id }), pid) as any) ?? {};
    cfg.scripts = { ...(cfg.scripts ?? {}), run: "echo from-settings" };
    await browser.execute((id, c) => window.__termic!.invoke("repo_config_save", { projectId: id, config: c }), pid, cfg);
    try {
      expect(readFileSync(path.join(repo, ".termic.yaml"), "utf8")).toContain("echo from-settings");
    } finally {
      rmSync(path.join(repo, ".termic.yaml"), { force: true });
    }
  });

  it("archives from the desktop: the box removes its worktree, the row goes", async () => {
    // The repo's archive script runs in the worktree on the box first.
    const wt = await browser.execute((id) => (window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id) as any)?.path as string, task);
    const marker = path.join(path.dirname(wt), "archive-ran");
    rmSync(marker, { force: true });
    writeFileSync(path.join(repo, ".termic.yaml"), "scripts:\n  archive: touch ../archive-ran\n");
    try {
      // From the view's own Archive button, as a user does: the desktop
      // archive, so the task also stops being the active one here.
      await clickPresent(row());
      await clickPresent('[data-testid="remote-task-archive"]');
      await browser.waitUntil(async () => {
        await browser.execute(() => (document.querySelector('[data-testid="confirm-ok"]') as HTMLElement | null)?.click());
        return browser.execute((id) => window.__termic!.useApp.getState().activeTaskId !== id, task);
      }, { timeout: 30_000, timeoutMsg: "archiving from the view left the task active" });
      await browser.waitUntil(() => existsSync(marker), { timeout: 30_000, timeoutMsg: "the archive script never ran" });
    } finally {
      rmSync(path.join(repo, ".termic.yaml"), { force: true });
      rmSync(marker, { force: true });
    }
    await browser.waitUntil(async () => !((await call({ cmd: "list" }))?.data?.tasks ?? []).some((t: any) => t.id === task),
      { timeout: 20_000, timeoutMsg: "the box still has the task" });
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    await waitGone(row(), 20_000);
  });

  it("removing the server takes its projects out of this machine's store", async () => {
    await browser.execute((id) => window.__termic!.invoke("server_remove", { id }), serverId);
    await browser.waitUntil(async () => browser.execute((sid) =>
      !window.__termic!.useApp.getState().projects.some((p: any) => p.server === sid), serverId),
    { timeout: 20_000, timeoutMsg: "the removed server's projects stayed" });
    serverId = "";
  });
});
