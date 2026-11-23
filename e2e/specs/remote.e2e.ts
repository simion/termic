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
import os from "node:os";
import { chmodSync, existsSync, lstatSync, readFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cliRpc, clickMenuItem, clickPresent, clickWhenVisible, requireTermicApi, setInputValue, snap, typeIntoAgent, typeIntoRemoteTerminal, waitForAgentPty, waitForAppShell, waitTabInFront, waitForAttr, waitGone, waitVisible } from "../helpers.js";

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


/** Open the remote add menu: REMOTE's + once the section has rows, the
 *  footer's globe while it has none (a Radix trigger wants pointer events,
 *  not a click). */
async function openAddRemote(): Promise<void> {
  await browser.waitUntil(() => browser.execute(() => {
    if (document.querySelector('[data-testid="sidebar-add-server"]')) return true;
    const el = document.querySelector('[data-testid="sidebar-add-remote"], [data-testid="sidebar-footer-remote"]') as HTMLElement | null;
    if (!el) return false;
    const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as PointerEventInit;
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    return !!document.querySelector('[data-testid="sidebar-add-server"]');
  }), { timeout: 10_000, timeoutMsg: "REMOTE's + menu never opened" });
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

  it("opens with no phone and no server, servers in a section of their own", async () => {
    await waitVisible('[data-testid="remote-section"]');
    expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-phones"]'))).toBe(false);
    // Remote control is what drives this computer over the network: phones,
    // then paired computers. Servers (where projects run) are not on it.
    expect(await browser.execute(() => {
      const top = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top;
      return top("remote-connect-phone") < top("settings-peers");
    })).toBe(true);
    expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-add-server"]'))).toBe(false);
    // The rail: MCP & CLI, Remote control, Servers, in that order.
    expect(await browser.execute(() => {
      const t = ["cli", "remote", "servers"].map(id => document.querySelector(`[data-rail-item="${id}"]`)?.getBoundingClientRect().top ?? -1);
      return t.every(x => x >= 0) && t[0] < t[1] && t[1] < t[2];
    })).toBe(true);
    await clickPresent('[data-rail-item="servers"]');
    await waitVisible('[data-testid="servers-section"]');
    expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-servers"]'))).toBe(false);
    // Servers say what they are and how they work, in three steps.
    expect(await browser.execute(() => document.querySelectorAll('[data-testid="servers-how"] li').length)).toBe(3);
    await snap("settings-servers-empty.png");
    await clickPresent('[data-rail-item="remote"]');
    await waitVisible('[data-testid="remote-section"]');
    await snap("settings-remote-control.png");
    // The phone card is open, with where to get the app on each platform.
    await waitVisible('[data-testid="remote-connect-phone"]');
    expect(await browser.execute(() => document.querySelector('[data-testid="phone-get-ios"]')?.getAttribute("data-url"))).toBe("https://testflight.apple.com/join/SqxhPr6a");
    expect(await browser.execute(() => document.querySelector('[data-testid="phone-get-android"]')?.getAttribute("data-url"))).toBe("https://play.google.com/store/apps/details?id=dev.termic.remote");
    await snap("remote-settings-empty.png");
  });

  it("connects a phone from the footer's globe while REMOTE has nothing to show", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    // No server or paired computer: no empty REMOTE section, a globe in the
    // footer instead.
    await waitVisible('[data-testid="sidebar-footer-remote"]');
    expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-sidebar-section"]'))).toBe(false);
    await openAddRemote();
    // In order of use, the same as Settings > Remote.
    expect(await browser.execute(() => {
      const top = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().top ?? NaN;
      return top("sidebar-connect-phone") < top("sidebar-pair-computer") && top("sidebar-pair-computer") < top("sidebar-add-server");
    })).toBe(true);
    await snap("remote-sidebar-add-menu.png");
    await clickPresent('[data-testid="sidebar-connect-phone"]');
    await waitVisible('[data-testid="phone-qr"]');
    await snap("remote-sidebar-phone.png");
    await browser.keys("Escape");
    await waitGone('[data-testid="phone-qr"]');
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("remote"));
    await waitVisible('[data-testid="remote-section"]');
  });

  it("shows a QR code with a countdown, turning sharing on to do it", async () => {
    await clickPresent('[data-testid="remote-connect-phone"]');
    await waitVisible('[data-testid="phone-qr"]');
    await waitVisible('[data-testid="phone-qr-countdown"]');
    link = await browser.execute(() => document.querySelector('[data-testid="phone-qr"]')!.getAttribute("data-link") ?? "");
    expect(link).toMatch(/^termic-remote:\/\/pair\?v=1&h=127%2E0%2E0%2E1%3A\d+&id=[0-9a-f]{32}&m=.+&k=[A-Za-z0-9_-]{43}$/);
    const s = await status();
    expect(s.enabled).toBe(true);
    expect(s.phone_pairing).not.toBeNull();
    // The page behind the dialog says so too (it read a stale copy once).
    await waitForAttr('[data-testid="peers-toggle"]', "data-enabled", "true");
    // And the switch DRAWS on: the attribute alone once said true while the
    // knob sat at off.
    await browser.waitUntil(async () => (await browser.execute(() => {
      const b = document.querySelector('[data-testid="peers-toggle"] [role="switch"]') as HTMLElement;
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

  it("opens Pair computers in settings from the remote add menu", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await openAddRemote();
    await clickPresent('[data-testid="sidebar-pair-computer"]');
    await waitVisible('[data-testid="settings-peers"]');
    await browser.execute(() => document.querySelector('[data-testid="settings-peers"]')!.scrollIntoView({ block: "start" }));
    await snap("remote-sidebar-pair.png");
  });

  it("opens Add a server from the remote add menu too", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await openAddRemote();
    await clickPresent('[data-testid="sidebar-add-server"]');
    await waitVisible('[data-testid="server-ssh"]');
    await snap("remote-sidebar-server.png");
    await browser.execute(() => window.__termic!.useRemote.getState().setDialog({ serverDialog: false }));
    await waitGone('[data-testid="server-ssh"]');
    // And from Add project: the link closes it and opens the server dialog.
    await clickPresent('[data-testid="sidebar-add-project"]');
    await clickPresent('[data-testid="new-project-add-server"]');
    await waitVisible('[data-testid="server-ssh"]');
    await waitGone('[data-testid="project-mode-repo"]');
    await browser.execute(() => window.__termic!.useRemote.getState().setDialog({ serverDialog: false }));
    await waitGone('[data-testid="server-ssh"]');
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("servers"));
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
  // repo and a fake agent script (run by a desktop agent entry whose
  // command is its path there), so no agent CLI or login is needed there;
  // both are removed at the end.
  const box = process.env.TERMIC_E2E_TEST_BOX;
  const onBox = box ? it : it.skip;
  const BOX_DIR = "termic-e2e-box";
  const ssh = (script: string) => execFileSync("ssh", ["-o", "BatchMode=yes", "--", box!, script], { encoding: "utf8" });
  let serverId = "";

  onBox("adds a real server through the checklist and shows it connected", async function () {
    this.timeout(240_000);
    ssh(`set -e; rm -rf ~/${BOX_DIR}; mkdir -p ~/${BOX_DIR}/repo ~/.termic-server
cd ~/${BOX_DIR}/repo && git init -q -b main && printf 'scripts:\n  setup: touch set-up-ran\n' > .termic.yaml && git add .termic.yaml && git -c user.email=e2e@termic.dev -c user.name=e2e commit -q -m init
printf '%s\n' '#!/bin/sh' 'printf "fake agent ready\\r\\n> "' 'while IFS= read -r l; do printf "box says: %s\\r\\n> " "$l"; done' > ~/${BOX_DIR}/agent.sh
chmod +x ~/${BOX_DIR}/agent.sh`);
    await clickPresent('[data-testid="remote-add-server"]');
    await setInputValue('[data-testid="server-ssh"]', box!);
    await setInputValue('[data-testid="server-name"]', "Test box");
    await clickPresent('[data-testid="server-connect"]');
    // termic-server may need installing first: the checklist offers it.
    await browser.waitUntil(async () => browser.execute(() =>
      !!document.querySelector('[data-testid="server-install"]') || !!document.querySelector('[data-testid="server-done"]')),
    { timeout: 60_000, timeoutMsg: "the checklist neither connected nor offered an install" });
    if (await browser.execute(() => !!document.querySelector('[data-testid="server-install"]'))) {
      // Beside the button, the same install from the server's own shell.
      expect(await browser.execute(() => document.querySelector('[data-testid="server-step-installed"]')?.textContent ?? "")).toContain("curl -fsSL https://termic.dev/install-server.sh | sh");
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
    // A box on an older termic-server gets this app's build installed; it
    // restarts onto it by itself only once no agent there is working or
    // waiting, and a real box's own agents may be. Restart now (what the
    // row's button sends), so the rest runs against this build.
    const bundled = process.env.TERMIC_E2E_SERVER_BIN_DIR
      ? readFileSync(path.join(process.env.TERMIC_E2E_SERVER_BIN_DIR, "termic-server-version.txt"), "utf8").trim() : "";
    if (bundled) {
      const machine = () => browser.execute((id) => window.__termic!.useRemote.getState().machines.find((m: any) => m.id === id) ?? null, serverId) as Promise<any>;
      await browser.waitUntil(async () => { const m = await machine(); return m?.version === bundled || !!m?.update; },
        { timeout: 60_000, timeoutMsg: "the box was neither on this build nor given it" });
      if ((await machine())?.version !== bundled) {
        await browser.execute((id) => window.__termic!.invoke("server_restart", { machine: id }), serverId);
        await browser.waitUntil(async () => { const m = await machine(); return m?.state === "online" && m.version === bundled; },
          { timeout: 90_000, timeoutMsg: "the box never came back on this build" });
      }
    }
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

  onBox("starts a task on the server from the normal New task dialog, and the agent there answers", async function () {
    this.timeout(180_000);
    expect(serverId).not.toBe("");
    await dropBoxProjects();
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    // The desktop's registry starts the agent: a desktop agent whose
    // command is the fake on the box (its path there).
    const boxHome = ssh("printf %s \"$HOME\"").trim();
    await browser.execute(async (cmd) => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      const fake = s.agents.find((a: any) => a.id === "fakeagent");
      const caps = { ...fake.capabilities, yolo_args: [], resume_args: [], session_id_args: [], resume_id_args: [], name_args: [] };
      s.agents = [...s.agents.filter((a: any) => a.id !== "boxagent"), { ...fake, id: "boxagent", display_name: "BoxAgent", command: cmd, args: [], builtin: false, capabilities: caps }];
      await t.ipc.settingsSave(s);
      await t.useApp.getState().loadAll();
    }, `${boxHome}/${BOX_DIR}/agent.sh`);
    // The server's Add project (its menu): a real box may already have
    // projects, so its + would open New task for one of those instead.
    await browser.execute((id) => window.__termic!.useRemote.getState().setDialog({ newTaskOn: id, newTaskAdding: true }), serverId);
    // Add project on a server is only that: a path, no New task form.
    await waitVisible('[data-testid="remote-add-project-dialog"]');
    expect(await browser.execute(() => ["remote-new-prompt", "remote-new-start", "remote-new-project"].some(id => !!document.querySelector(`[data-testid="${id}"]`)))).toBe(false);
    await snap("remote-server-add-project.png");
    await setInputValue('[data-testid="remote-project-path"]', `~/${BOX_DIR}/repo`);
    await clickPresent('[data-testid="remote-project-add"]');
    // Added: the dialog closes once the project is listed, as locally.
    await waitGone('[data-testid="remote-add-project-dialog"]', 40_000);
    expect(await browser.execute(() => !!document.querySelector('[role="dialog"] [data-testid="new-task-name"]'))).toBe(false);
    const projectId = await browser.execute((sid) => (window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid && String(p.root_path).includes("termic-e2e-box")) as any)?.id as string, serverId);
    expect(projectId).toBeTruthy();
    // Its tasks start from the ordinary New task dialog.
    await browser.execute((pid) => window.__termic!.useUI.getState().openNewTask(pid), projectId);
    await waitVisible('[role="dialog"] [data-testid="new-task-name"]', 10_000);
    // Only what works on a box: no isolation or secrets panes.
    expect(await browser.execute(() => !!document.querySelector('[data-testid="rail-isolation"]'))).toBe(false);
    await clickPresent('[data-testid="rail-agent"]');
    await clickWhenVisible('[role="dialog"] [data-cli="boxagent"]');
    await clickPresent('[data-testid="rail-task"]');
    await clickPresent('[data-testid="task-type-worktree"]');
    await setInputValue('[data-testid="new-task-name"]', "box-hello");
    await snap("remote-server-new-task.png");
    await clickPresent('[data-testid="new-task-create"]');
    const task = await browser.waitUntil(async () => browser.execute((pid) =>
      (window.__termic!.useApp.getState().tasks.find((t: any) => t.project_id === pid && t.name === "box-hello") as any)?.id as string | undefined, projectId),
    { timeout: 60_000, timeoutMsg: "the new task never reached the store" });
    await waitVisible(`[data-sidebar-task-id="${task}"]`, 30_000);
    // Its worktree is on the box, in termic-server's folder, and the box
    // lists the task (task_put) so every desktop sees it.
    const wt = await browser.execute((id) => (window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id) as any)?.path as string, task);
    expect(wt).toContain(".termic-server/worktrees");
    expect(ssh(`test -d '${wt}' && echo yes || true`).trim()).toBe("yes");
    const boxList = await browser.execute((m) => window.__termic!.invoke("remote_call", { machine: m, request: { id: "", cmd: "list" } }), serverId) as any;
    expect((boxList?.data?.tasks ?? []).some((t: any) => t.id === task)).toBe(true);
    // The agent runs on the box, started by this desktop.
    await waitForAgentPty(task, 60_000);
    await typeIntoAgent(task, "hello from the desk\r");
    await browser.waitUntil(async () => String((await cliRpc({ cmd: "logs", task }))?.data?.data ?? "").includes("box says: hello from the desk"),
      { timeout: 30_000, timeoutMsg: "the agent on the box never answered" });
    await snap("remote-server-task.png");
    // The repo's setup script ran in a setup tab, on the box.
    await browser.waitUntil(() => ssh(`test -e '${wt}/set-up-ran' && echo yes || true`).trim() === "yes",
      { timeout: 30_000, timeoutMsg: "the setup script never ran on the box" });
    // Its git and files are the box's: a save from the desktop lands there,
    // and a commit made here is the box's newest.
    await browser.execute((id) => window.__termic!.invoke("task_file_write", { id, path: "desk.txt", content: "written from the desk\n" }), task);
    expect(ssh(`cat '${wt}/desk.txt'`)).toBe("written from the desk\n");
    await browser.execute((id) => window.__termic!.invoke("task_stage", { id, dirName: "", paths: ["desk.txt"] }), task);
    await browser.execute((id) => window.__termic!.invoke("task_commit", { id, dirName: "", subject: "from the desk", body: "", amend: false, push: false }), task);
    expect(ssh(`git -C '${wt}' log -1 --format=%s`).trim()).toBe("from the desk");
    // A shell tab runs on the box.
    const shellId = await browser.execute((id) => {
      const tabId = crypto.randomUUID();
      window.__termic!.useApp.getState().addTab(id, { id: tabId, type: "terminal", title: "Terminal", cli: "shell" });
      return tabId;
    }, task) as string;
    await waitTabInFront(task, shellId);
    await browser.waitUntil(async () => browser.execute((id, sid) => !!(window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.id === sid)?.ptyId, task, shellId),
      { timeout: 30_000, timeoutMsg: "the shell tab never started on the box" });
    await browser.waitUntil(async () => {
      await typeIntoAgent(task, "uname -s > from-shell.txt\r");
      return ssh(`cat '${wt}/from-shell.txt' 2>/dev/null || true`).trim() === "Linux";
    }, { timeout: 30_000, timeoutMsg: "the shell tab never ran on the box" });
    await snap("remote-real-shell.png");
    // Send to main on the real box.
    const sent = await browser.execute((id) => window.__termic!.invoke("task_send_diff_to_main", { id }), task) as any;
    expect(sent.tracked_files).toBe(1);
    expect(ssh(`cat ~/${BOX_DIR}/repo/desk.txt`)).toBe("written from the desk\n");
    // Archived from the desktop: its worktree goes, on the box.
    await browser.execute((t) => window.__termic!.invoke("task_archive", { id: t }), task);
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    await waitGone(`[data-sidebar-task-id="${task}"]`, 30_000);
    await browser.waitUntil(() => ssh(`test -d '${wt}' && echo yes || echo no`).trim() === "no", { timeout: 30_000, timeoutMsg: "the worktree stayed on the box after archive" });
    // Nothing of it keeps running there: archive ends every terminal the
    // task had on the box (its agent and its shells), not just one. The
    // [a] keeps pgrep from matching the shell that runs it.
    await browser.waitUntil(() => ssh(`pgrep -f '${BOX_DIR}/[a]gent.sh' >/dev/null && echo yes || echo no`).trim() === "no",
      { timeout: 15_000, timeoutMsg: "the task's agent kept running on the box after archive" });
  });

  onBox("removes the server", async () => {
    try {
      await dropBoxProjects();
      await browser.execute(() => window.__termic!.useApp.getState().openSettings("servers"));
      await clickPresent(`[data-testid="server-remove-${serverId}"]`);
      await clickPresent('[data-testid="confirm-ok"]');
      await waitGone(`[data-testid="server-row-${serverId}"]`);
      expect(await browser.execute(() => window.__termic!.invoke("server_list"))).toEqual([]);
    } finally {
      ssh(`rm -rf ~/${BOX_DIR}`);
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

/** codex on this Mac: its hooks' trust step needs the binary. */
const codexHere = (() => { try { execFileSync("/bin/sh", ["-lc", "command -v codex"], { stdio: "ignore" }); return true; } catch { return false; } })();

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
  /** The task's branch, as the desktop named it (its branch prefix + slug). */
  const taskBranch = () => browser.execute((id) => (window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id) as any)?.branch as string, task);
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
    // A fake agent: it echoes, and asks a question when told to.
    const agent = path.join(box, "agent.sh");
    writeFileSync(agent, [
      "#!/bin/sh",
      "printf 'fake agent ready\\r\\n> '",
      "while IFS= read -r l; do",
      "  case \"$l\" in",
      // Asks the way an agent's hook reports it: Termic's attention OSC in
      // its own terminal (docs/agent-hooks.md "Transport"), then the question.
      "    *ask*) printf '\\033]777;notify;termic;agent needs your input\\007Do you want to proceed? (y/n) ' ;;",
      "    *) printf 'box says: %s\\r\\n> ' \"$l\" ;;",
      "  esac",
      "done",
      "",
    ].join("\n"));
    chmodSync(agent, 0o755);
    // The desktop's registry starts a server task's agent: the fake, as a
    // desktop agent (the box is this Mac, so the path is there).
    await browser.execute(async (cmd) => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      const fake = s.agents.find((a: any) => a.id === "fakeagent");
      const caps = { ...fake.capabilities, yolo_args: [], resume_args: [], session_id_args: [], resume_id_args: [], name_args: [] };
      s.agents = [...s.agents.filter((a: any) => a.id !== "boxagent"), { ...fake, id: "boxagent", display_name: "BoxAgent", command: cmd, args: [], builtin: false, capabilities: caps }];
      await t.ipc.settingsSave(s);
      await t.useApp.getState().loadAll();
    }, agent);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    // claude's hooks on this Mac (the e2e agent home), so the box gets them;
    // codex's too where codex is installed (its trust step runs codex).
    await browser.execute(() => window.__termic!.invoke("agent_hooks_install", { agentId: "claude" }));
    // grok writes a second config (its status line in config.toml).
    await browser.execute(() => window.__termic!.invoke("agent_hooks_install", { agentId: "grok" }));
    if (codexHere) await browser.execute(() => window.__termic!.invoke("agent_hooks_install", { agentId: "codex" }));
  });

  after(async () => {
    await browser.execute(() => window.__termic!.invoke("agent_hooks_remove", { agentId: "claude" })).catch(() => {});
    await browser.execute(() => window.__termic!.invoke("agent_hooks_remove", { agentId: "grok" })).catch(() => {});
    if (codexHere) await browser.execute(() => window.__termic!.invoke("agent_hooks_remove", { agentId: "codex" })).catch(() => {});
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
    // The box's project is mirrored into the desktop's own store
    // (server_projects.rs) as an ordinary project tagged with the server,
    // and a task on it is made by the desktop, like a local one.
    const projectId = await browser.waitUntil(async () => browser.execute((sid) =>
      (window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid) as any)?.id as string | undefined, serverId),
    { timeout: 30_000, timeoutMsg: "the server's project never reached the store" }) as string;
    await browser.execute((pid) => window.__termic!.useUI.getState().openNewTask(pid), projectId);
    task = await createInDialog("box-task");
    // The box records it (task_put), so its own list has it too.
    await browser.waitUntil(async () => ((await call({ cmd: "list" }))?.data?.tasks ?? []).some((t: any) => t.id === task),
      { timeout: 20_000, timeoutMsg: "the box never recorded the task" });
    await waitVisible(row());
    await browser.waitUntil(async () => (await logs()).includes("fake agent ready"), { timeout: 20_000, timeoutMsg: "the agent never started on the box" });
    await typeIntoAgent(task, "hello\r");
    await browser.waitUntil(async () => (await logs()).includes("box says: hello"), { timeout: 20_000, timeoutMsg: "the agent never answered" });
    // The old per-server section is gone for servers.
    expect(await browser.execute((id) => !!document.querySelector(`[data-testid="remote-machine-${id}"]`), serverId)).toBe(false);
    await snap("remote-local-server-row.png");
    // Settings > Servers with the server listed.
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("servers"));
    await waitVisible(`[data-testid="server-row-${serverId}"]`);
    await browser.execute((id) => document.querySelector(`[data-testid="server-row-${id}"]`)!.scrollIntoView({ block: "center" }), serverId);
    await snap("remote-settings-with-server.png");
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("adds a folder that is not a git repo as a plain folder, when asked", async () => {
    // Outside any repo (the box's HOME may itself sit in one).
    const plain = path.join(mkdtempSync(path.join(os.tmpdir(), "termic-plain-")), "notes");
    mkdirSync(plain, { recursive: true });
    await browser.execute((id) => window.__termic!.useRemote.getState().setDialog({ newTaskOn: id, newTaskAdding: true }), serverId);
    await waitVisible('[data-testid="remote-add-project-dialog"]');
    await setInputValue('[data-testid="remote-project-path"]', plain);
    await clickPresent('[data-testid="remote-project-add"]');
    // Refused as a repo, offered as a folder (no CLI flag named).
    await waitVisible('[data-testid="remote-project-add-plain"]');
    expect(await browser.execute(() => document.querySelector('[data-testid="remote-new-error"]')?.textContent ?? "")).not.toContain("--non-git");
    await snap("remote-server-add-plain.png");
    await clickPresent('[data-testid="remote-project-add-plain"]');
    await waitGone('[data-testid="remote-add-project-dialog"]', 20_000);
    // The desktop's copy knows it is a plain folder, so its tasks never
    // ask for a worktree.
    const nonGit = await browser.waitUntil(
      () => browser.execute((sid) => (window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid && p.name === "notes") as any)?.non_git, serverId),
      { timeout: 10_000, timeoutMsg: "the plain folder never reached the sidebar" });
    expect(nonGit).toBe(true);
    await call({ cmd: "project_remove", name: "notes" });
  });

  it("installs this Mac's agent hooks on the box, naming the box's own paths", async () => {
    // agent_hooks.rs sync_server: the agents with hooks here get them there,
    // so a server agent reports its state exactly as a local one does.
    const settings = path.join(box, ".claude", "settings.json");
    await browser.waitUntil(async () => existsSync(settings) && readFileSync(settings, "utf8").includes(`${box}/.claude/termic-hooks/`),
      { timeout: 30_000, timeoutMsg: "claude's hooks never reached the box" });
    const cfg = JSON.parse(readFileSync(settings, "utf8"));
    const commands = Object.values(cfg.hooks ?? {}).flat().flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command as string));
    expect(commands.length).toBeGreaterThan(0);
    // Every command is a script on the box, never this Mac's install.
    for (const c of commands) {
      expect(c.startsWith(`${box}/.claude/termic-hooks/`)).toBe(true);
      expect(statSync(c).mode & 0o111).toBeGreaterThan(0);
    }
  });

  it("installs a slot agent's second config on the box too (grok's status line)", async () => {
    const home = path.join(box, ".grok");
    await browser.waitUntil(() => existsSync(path.join(home, "config.toml")) && readFileSync(path.join(home, "config.toml"), "utf8").includes(`${home}/termic-hooks/`),
      { timeout: 30_000, timeoutMsg: "grok's status line never reached the box" });
    expect(readFileSync(path.join(home, "hooks", "termic.json"), "utf8")).toContain(`${home}/termic-hooks/`);
  });

  (codexHere ? it : it.skip)("trusts codex's hooks on the box, as codex there reports", async () => {
    // The box is this Mac, so its codex answers for the box's CODEX_HOME.
    const home = path.join(box, ".codex");
    await browser.waitUntil(() => existsSync(path.join(home, "config.toml")) && readFileSync(path.join(home, "config.toml"), "utf8").includes("trusted_hash"),
      { timeout: 60_000, timeoutMsg: "codex's trust entries never reached the box" });
    expect(readFileSync(path.join(home, "hooks.json"), "utf8")).toContain(`${home}/termic-hooks/`);
    const init = JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "e2e", version: "0" } } });
    const list = JSON.stringify({ id: 2, method: "hooks/list", params: { cwds: [box] } });
    const out = execFileSync("/bin/sh", ["-lc", `{ printf '%s\\n%s\\n' '${init}' '${list}'; sleep 8; } | CODEX_HOME='${home}' codex app-server 2>/dev/null | grep -m 1 -E '"id": ?2[,}]'`], { encoding: "utf8" });
    const ours = JSON.parse(out).result.data.flatMap((e: any) => e.hooks ?? []).filter((h: any) => String(h.command).startsWith(`${home}/termic-hooks/`));
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.every((h: any) => h.trustStatus === "trusted")).toBe(true);
  });

  it("files the server's projects under it in REMOTE, with a menu to manage it", async () => {
    // Its project and task sit inside the server's block, not in PROJECTS.
    await waitVisible('[data-testid="remote-section-header"]');
    expect(await browser.execute((sid, sel) => {
      const block = document.querySelector(`[data-testid="server-block-${sid}"]`)?.parentElement;
      return !!block?.querySelector(sel);
    }, serverId, row())).toBe(true);
    // It belongs to the profile whose window added it (this one, "main"),
    // and only that profile's window lists it.
    expect(await browser.execute((sid) => window.__termic!.invoke("remote_machines").then((l: any) => l.find((m: any) => m.id === sid)?.profile), serverId)).toBe("main");
    // One way in: REMOTE's +, none left in the PROJECTS header.
    expect(await browser.execute(() => !!document.querySelector('[data-testid="projects-section-header"] [data-testid="sidebar-add-server"]'))).toBe(false);
    // Its menu: New task, Add project (the dialog opens on the path field),
    // settings, remove.
    const openServerMenu = () => browser.waitUntil(() => browser.execute((sid) => {
      if (document.querySelector('[data-testid="server-menu-settings"]')) return true;
      const el = document.querySelector(`[data-testid="server-menu-${sid}"]`) as HTMLElement;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as PointerEventInit;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      return !!document.querySelector('[data-testid="server-menu-settings"]');
    }, serverId), { timeout: 10_000, timeoutMsg: "the server's menu never opened" });
    await openServerMenu();
    expect(await browser.execute(() => ["add-project", "settings", "remove"].every(k => !!document.querySelector(`[data-testid="server-menu-${k}"]`)))).toBe(true);
    // New task lives on each project row, never on the server: a server holds
    // several projects, and a server-level New task started in the first one.
    expect(await browser.execute((id) => !!document.querySelector(`[data-testid="server-menu-new-task"], [data-testid="server-new-task-${id}"]`), serverId)).toBe(false);
    // With a server, REMOTE is drawn and the footer's globe is gone.
    expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-sidebar-section"]') && !document.querySelector('[data-testid="sidebar-footer-remote"]'))).toBe(true);
    await snap("remote-server-menu.png");
    await clickPresent('[data-testid="server-menu-add-project"]');
    await waitVisible('[data-testid="remote-project-path"]');
    await browser.keys("Escape");
    await waitGone('[data-testid="remote-project-path"]');
    // Disconnect: the row stays, reads "Disconnected", its projects fold
    // away and no link runs; Connect brings it back online with them.
    await openServerMenu();
    await clickPresent('[data-testid="machine-menu-disconnect"]');
    await waitForAttr(`[data-testid="server-block-${serverId}"]`, "data-state", "disconnected", 10_000);
    await waitGone(row());
    expect(await browser.execute((sid) => window.__termic!.invoke("remote_machines").then((l: any) => l.find((m: any) => m.id === sid)?.state), serverId)).toBe("disconnected");
    await snap("remote-server-disconnected.png");
    // The row's own switch turns it back on.
    expect(await browser.execute((sid) => document.querySelector(`[data-testid="machine-switch-${sid}"]`)?.getAttribute("aria-checked"), serverId)).toBe("false");
    await clickPresent(`[data-testid="machine-switch-${serverId}"]`);
    await waitForAttr(`[data-testid="server-block-${serverId}"]`, "data-state", "online", 30_000);
    await waitVisible(row(), 20_000);
    // Folding the server hides its projects; unfolding brings them back.
    await clickPresent(`[data-testid="server-block-${serverId}"] button[aria-expanded]`);
    await waitGone(row());
    await clickPresent(`[data-testid="server-block-${serverId}"] button[aria-expanded]`);
    await waitVisible(row());
  });

  // A server task is an ordinary desktop task whose terminals run on the
  // box (docs/remote.md, Servers): the desktop starts its agent
  // itself, through the same TaskView, tabs and PTY slots as a local one.
  const deskLogs = async () => String((await cliRpc({ cmd: "logs", task }))?.data?.data ?? "");
  const terminalTabs = () => browser.execute((id) =>
    (window.__termic!.useApp.getState().tabs[id] ?? []).filter((t: any) => t.type === "terminal").map((t: any) => ({ id: t.id, cli: t.cli, ptyId: t.ptyId, isDefault: !!t.is_default })), task) as Promise<{ id: string; cli: string; ptyId?: string; isDefault: boolean }[]>;
  const showAgentTab = async () => {
    const agentTab = (await terminalTabs()).find(t => t.isDefault)!;
    await browser.execute((id, tab) => window.__termic!.useApp.getState().setActiveTabId(id, tab), task, agentTab.id);
    await waitTabInFront(task, agentTab.id);
  };
  const typeUntil = async (text: string, done: () => boolean | Promise<boolean>, msg: string) => {
    await browser.waitUntil(async () => {
      await typeIntoAgent(task, text);
      for (let i = 0; i < 10; i++) {
        if (await done()) return true;
        await new Promise(r => setTimeout(r, 300)); // a poll tick for a file on disk, not a wait for the app
      }
      return false;
    }, { timeout: 30_000, timeoutMsg: msg });
  };
  // A shortcut pressed in the task's visible terminal, as a user does.
  const pressCmd = (key: string) => browser.execute((k, id) => {
    const ta = [...document.querySelectorAll<HTMLTextAreaElement>(`[data-task-id="${id}"] .xterm-helper-textarea`)]
      .find(el => (el.closest(".xterm") ?? el).getBoundingClientRect().width > 0);
    const target: HTMLElement | Window = ta ?? window;
    ta?.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true, cancelable: true }));
  }, key, task);
  // The ordinary New task dialog, open on a server project: the desktop's
  // fake agent, a name, Create. The task's id once the store has it.
  const createInDialog = async (name: string) => {
    await waitVisible('[role="dialog"] [data-testid="new-task-name"]', 20_000);
    await clickPresent('[data-testid="rail-agent"]');
    await clickWhenVisible('[role="dialog"] [data-cli="boxagent"]');
    await clickPresent('[data-testid="rail-task"]');
    await clickPresent('[data-testid="task-type-worktree"]');
    await setInputValue('[data-testid="new-task-name"]', name);
    await clickPresent('[data-testid="new-task-create"]');
    return browser.waitUntil(async () => browser.execute((n) =>
      (window.__termic!.useApp.getState().tasks.find((t: any) => t.name === n && !t.archived) as any)?.id as string | undefined, name),
    { timeout: 60_000, timeoutMsg: `${name} never reached the store` }) as Promise<string>;
  };
  const boxState = () => browser.execute((id, sid) =>
    window.__termic!.useRemote.getState().machines.find((m: any) => m.id === sid)?.tasks.find((t: any) => t.id === id)?.state as string, task, serverId);

  it("opens the task as its terminal, the agent started by this desktop on the box", async () => {
    await clickPresent(row());
    await waitForAgentPty(task, 30_000);
    // The id is the claim: one agent per task on the box, whichever desktop
    // opens it, and a restarted desktop attaches to it.
    expect((await terminalTabs()).find(t => t.isDefault)?.ptyId?.startsWith(`${task}:agent/`)).toBe(true);
    expect(await browser.execute((id) => !!document.querySelector(`[data-task-id="${id}"] .xterm`), task)).toBe(true);
    await typeIntoAgent(task, "typed here\r");
    await browser.waitUntil(async () => (await deskLogs()).includes("box says: typed here"),
      { timeout: 20_000, timeoutMsg: "keys typed into the terminal never reached the agent on the box" });
    await snap("remote-local-server-task.png");
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

  it("the termic CLI drives a server task's agent like a local one: send, then logs", async () => {
    const name = await browser.execute((id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.name, task) as string;
    const sent = await cliRpc({ cmd: "send", task: name, prompt: "from the cli" });
    expect(sent.ok).toBe(true);
    await browser.waitUntil(async () => (await deskLogs()).includes("box says: from the cli"),
      { timeout: 20_000, timeoutMsg: "the CLI's send never reached the agent on the box, or logs never read it back" });
  });

  it("the termic CLI's new makes a server task the way the dialog does", async () => {
    // cli_server.rs handle_new: a server project's task is made by the
    // desktop (worktree through exec, then task_put), not forwarded.
    const project = await browser.execute((sid) => (window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid) as any)?.name as string, serverId);
    const r = await cliRpc({ cmd: "new", name: "cli-made", project, agent: "boxagent" });
    expect(r.ok).toBe(true);
    const id = r.data.task.id as string;
    await browser.waitUntil(async () => ((await call({ cmd: "list" }))?.data?.tasks ?? []).some((t: any) => t.id === id),
      { timeout: 20_000, timeoutMsg: "the box never recorded the CLI's task" });
    const refused = await cliRpc({ cmd: "new", name: "cli-pr", project, pr: 1 });
    expect(refused.ok).toBe(false);
    await browser.execute((t) => window.__termic!.invoke("task_archive", { id: t }), id);
  });

  it("reads a server task's result from the transcript on the box", async () => {
    // cli_server.rs claude_transcript_file through TaskHost: the claude
    // session file is the box's (HOME there), never this Mac's.
    await browser.execute((pid) => window.__termic!.useUI.getState().openNewTask(pid),
      await browser.execute((sid) => (window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid) as any)?.id as string, serverId));
    const id = await createInDialog("box-chat");
    await browser.execute((t) => window.__termic!.invoke("task_set_cli", { id: t, cli: "claude" }), id);
    const wt = await browser.execute((t) => (window.__termic!.useApp.getState().tasks.find((x: any) => x.id === t) as any)?.path as string, id);
    const dir = path.join(box, ".claude", "projects", wt.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "s.jsonl"), [
      JSON.stringify({ type: "user", message: { content: "go" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done on the box" }] } }),
    ].join("\n") + "\n");
    const r = await cliRpc({ cmd: "result", task: id });
    expect(r.ok).toBe(true);
    expect(r.data.text).toBe("done on the box");
    expect(r.data.transcript).toBe(path.join(dir, "s.jsonl"));
    await browser.execute((t) => window.__termic!.invoke("task_archive", { id: t }), id);
  });

  it("runs the task's git, files, shells and scripts on the box through the normal view", async () => {
    // git_bytes (lib.rs) sends a server folder's git through termic-server's exec.
    const branches = await browser.execute((id) => window.__termic!.invoke("task_git_branches", { id, dirName: "" }), task) as string[];
    const br = await taskBranch();
    expect(br).toMatch(/(^|\/)box-task$/);
    expect(branches).toContain(br);
    const st = await browser.execute((id) => window.__termic!.invoke("task_git_status", { id }), task) as any;
    expect(JSON.stringify(st)).toContain(br);
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
    // The right panel's Files tab lists the box's file; opening it is an
    // ordinary editor tab, read from the box.
    await clickPresent(row());
    await browser.execute(() => {
      const tab = [...document.querySelectorAll('[data-testid="right-tab"]')].find(b => /files/i.test(b.getAttribute("data-tab") ?? "")) as HTMLElement | undefined;
      tab?.click();
    });
    await clickPresent('[data-testid="right-refresh"]');
    await waitVisible('[data-path="hello.txt"]', 20_000);
    expect(await browser.execute(() => !!document.querySelector('[data-path=".git"]'))).toBe(false);
    await snap("remote-server-files.png");
    await clickPresent('[data-path="hello.txt"]');
    await browser.waitUntil(() => browser.execute((id) =>
      [...document.querySelectorAll(`[data-task-id="${id}"] .cm-content`)].some(e => e.textContent?.includes("edited on the desk")), task),
    { timeout: 15_000, timeoutMsg: "the server file never showed in the editor" });
    await snap("remote-server-editor.png");
    await showAgentTab();
    // No watcher on a box: the agent finishing a turn refreshes the tree.
    writeFileSync(path.join(wt, "after-turn.txt"), "x");
    expect((await cliRpc({ cmd: "send", task, prompt: "a turn" })).ok).toBe(true);
    await waitVisible('[data-path="after-turn.txt"]', 30_000);
    // One top bar for every task: what acts only on this Mac is left out.
    expect(await browser.execute(() => ({
      archive: !!document.querySelector('[data-testid="archive-task"]'),
      panel: !!document.querySelector('[data-testid="toggle-right-panel"]'),
      prompts: !!document.querySelector('[data-testid="prompts-menu"]'),
      run: !!document.querySelector('[data-testid="run-button"]'),
      openWith: !!document.querySelector('[data-testid="server-open-with"]'),
      localOpenWith: !!document.querySelector('[data-testid="open-with-launch"]'),
    }))).toEqual({ archive: true, panel: true, prompts: true, run: true, openWith: true, localOpenWith: false });
    // ⌘T: the same new-tab palette as locally, its agents the ones
    // installed ON THE BOX (the desktop's registry, checked there).
    await pressCmd("t");
    await waitVisible('[data-testid="new-tab-palette"]');
    const offered = await browser.execute(() => [...document.querySelectorAll('[data-testid="new-tab-palette"] [data-kind="agent"]')].map(e => (e as HTMLElement).innerText.split("\n")[0].trim()));
    expect(offered).toContain("BoxAgent");
    await browser.keys("Escape");
    await waitGone('[data-testid="new-tab-palette"]');
    // A shell tab is a shell ON THE BOX, in the task's folder.
    const before = (await terminalTabs()).length;
    const shellId = await browser.execute((id) => {
      const tabId = crypto.randomUUID();
      window.__termic!.useApp.getState().addTab(id, { id: tabId, type: "terminal", title: "Terminal", cli: "shell" });
      return tabId;
    }, task) as string;
    await waitTabInFront(task, shellId);
    await browser.waitUntil(async () => !!(await terminalTabs()).find(t => t.id === shellId)?.ptyId, { timeout: 20_000, timeoutMsg: "the shell tab never started on the box" });
    expect((await terminalTabs()).find(t => t.id === shellId)?.ptyId?.startsWith(`${task}:${shellId}/`)).toBe(true);
    await typeUntil("touch from-shell-$((6*7))\r", () => existsSync(path.join(wt, "from-shell-42")), "the shell tab never ran in the box's worktree");
    await snap("remote-server-shell.png");
    // The connection drops (laptop asleep) and comes back: the box kept
    // the shell (pty_keep) and the desktop attaches to it again.
    await browser.execute((id) => window.__termic!.invoke("remote_set_connected", { machine: id, on: false }), serverId);
    await browser.execute((id) => window.__termic!.invoke("remote_set_connected", { machine: id, on: true }), serverId);
    await browser.waitUntil(() => browser.execute((sid) =>
      window.__termic!.useRemote.getState().machines.find((m: any) => m.id === sid)?.state === "online", serverId), { timeout: 20_000, timeoutMsg: "the server never came back online" });
    await typeUntil("touch after-reconnect\r", () => existsSync(path.join(wt, "after-reconnect")), "the shell did not survive the connection dropping");
    // ⌘W closes the shell tab like a local one (it is not the agent).
    await pressCmd("w");
    await browser.waitUntil(async () => !(await terminalTabs()).some(t => t.id === shellId), { timeout: 10_000, timeoutMsg: "⌘W did not close the server shell tab" });
    expect((await terminalTabs()).length).toBe(before);
    // Run: the repo's run script in a run tab, on the box.
    writeFileSync(path.join(repo, ".termic.yaml"), "scripts:\n  run: touch ran-by-run\n");
    try {
      await clickPresent('[data-testid="run-button"]');
      await browser.waitUntil(() => existsSync(path.join(wt, "ran-by-run")), { timeout: 30_000, timeoutMsg: "Run never ran the script on the box" });
    } finally {
      rmSync(path.join(repo, ".termic.yaml"), { force: true });
    }
    await showAgentTab();
    // ⌘W on the agent asks: it runs on the box past the view. Cancel keeps
    // everything; Close view leaves the agent running there.
    await pressCmd("w");
    await waitVisible('[data-testid="server-close-dialog"]');
    await snap("remote-server-close-ask.png");
    await clickPresent('[data-testid="server-close-cancel"]');
    await waitGone('[data-testid="server-close-dialog"]');
    expect(await browser.execute((id) => window.__termic!.useApp.getState().activeTaskId === id, task)).toBe(true);
    await pressCmd("w");
    await clickPresent('[data-testid="server-close-view"]');
    await browser.waitUntil(() => browser.execute((id) => window.__termic!.useApp.getState().activeTaskId !== id, task),
      { timeout: 5_000, timeoutMsg: "Close view did not close the server task's view" });
    expect((await terminalTabs()).find(t => t.isDefault)?.ptyId?.startsWith(`${task}:agent/`)).toBe(true);
    await clickPresent(row());
    await typeIntoAgent(task, "still running\r");
    await browser.waitUntil(async () => (await deskLogs()).includes("box says: still running"),
      { timeout: 20_000, timeoutMsg: "the agent did not keep running behind a closed view" });
    // Stop agent: the desktop stops its tabs, so the agent ends on the box;
    // opening the task starts it again.
    await pressCmd("w");
    await clickPresent('[data-testid="server-close-stop"]');
    await browser.waitUntil(async () => (await boxState()) === "inactive", { timeout: 20_000, timeoutMsg: "Stop agent did not end it on the box" });
    await clickPresent(row());
    await waitForAgentPty(task, 30_000);
    await browser.waitUntil(async () => (await boxState()) !== "inactive", { timeout: 20_000, timeoutMsg: "opening the stopped task did not start its agent" });
    // Send to main runs on the box: the task's committed edit and its
    // untracked files land in the box repo's main checkout, uncommitted.
    expect(await browser.execute(() => !!document.querySelector('[data-testid="send-to-main"]'))).toBe(true);
    try {
      const sent = await browser.execute((id) => window.__termic!.invoke("task_send_diff_to_main", { id }), task) as any;
      expect(sent.tracked_files).toBe(1);
      expect(sent.untracked_files).toBeGreaterThan(0);
      expect(readFileSync(path.join(repo, "hello.txt"), "utf8")).toBe("edited on the desk\n");
      expect(existsSync(path.join(repo, "after-reconnect"))).toBe(true);
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
    expect((await cliRpc({ cmd: "send", task, prompt: "nudge" })).ok).toBe(true);
    await browser.waitUntil(async () => (await deskLogs()).includes("box says: nudge"), { timeout: 20_000, timeoutMsg: "the nudge never landed" });
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
    expect((await cliRpc({ cmd: "send", task, prompt: "nudge again" })).ok).toBe(true);
    await browser.waitUntil(async () => (await deskLogs()).includes("box says: nudge again"), { timeout: 20_000, timeoutMsg: "the second nudge never landed" });
    await browser.waitUntil(async () => {
      await browser.execute(() => window.__termic!.useApp.getState().loadAll());
      return grouped();
    }, { timeout: 5_000, timeoutMsg: "a resync dropped the server task's group" });
    // Duplicate: the ordinary New task dialog, starting from this branch;
    // the desktop makes the task on the box and records it there.
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, `${row()} [data-testid="task-menu-trigger"]`);
    await clickWhenVisible(`[data-testid="task-duplicate-${task}"]`);
    const dupId = await createInDialog("box-dup");
    const dup = await browser.waitUntil(async () => ((await call({ cmd: "list" }))?.data?.tasks ?? []).find((t: any) => t.id === dupId),
      { timeout: 30_000, timeoutMsg: "the duplicate never appeared on the box" }) as any;
    expect(dup.base_branch).toBe(await taskBranch());
    expect(execFileSync("git", ["-C", dup.path ?? (await browser.execute((id) => (window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id) as any)?.path, dupId)) as string, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim()).toMatch(/(^|\/)box-dup$/);
    await browser.execute((t) => window.__termic!.invoke("task_archive", { id: t }), dupId);
  });

  it("shares its organisation through the box with every desktop there", async () => {
    // server_projects.rs push_org_if_changed: this desktop's name, pin and
    // group are on the box's record.
    const rec = async () => ((await call({ cmd: "list" }))?.data?.tasks ?? []).find((t: any) => t.id === task);
    await browser.waitUntil(async () => {
      const o = (await rec())?.org;
      return o?.pinned === true && o?.name === "renamed-here" && !!o?.group;
    }, { timeout: 15_000, timeoutMsg: "this desktop's organisation never reached the box" });
    // Another desktop renames, unpins and ungroups it there (its task_put).
    const r = await rec();
    const pid = ((await call({ cmd: "project_list" }))?.data?.projects ?? []).find((p: any) => p.name === r.project)?.id;
    const put = await call({ cmd: "task_put", task, name: "renamed-elsewhere", project: pid, path: r.path, branch: r.branch, base_branch: r.base_branch, agent: r.agent,
      org: { name: "renamed-elsewhere", pinned: false, order: null, group: null, at: Date.now() + 1000 } });
    expect(put.ok).toBe(true);
    // The box's snapshot changed, so this desktop resyncs and files it so too.
    await browser.waitUntil(async () => browser.execute(async (id) => {
      await window.__termic!.useApp.getState().loadAll();
      const x = window.__termic!.useApp.getState().tasks.find((y: any) => y.id === id) as any;
      return x?.name === "renamed-elsewhere" && !x.pinned && !x.group;
    }, task), { timeout: 15_000, timeoutMsg: "another desktop's organisation never reached this one" });
  });

  it("starts a server task from the project's 'Branch new tasks from'", async () => {
    // A desktop setting: the desktop's own creation branches from it, on the box.
    const proj = await browser.execute((sid) => window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid), serverId) as any;
    const br = await taskBranch();
    await browser.execute((p, b) => window.__termic!.invoke("project_update", { p: { ...p, base_branch: b } }), proj, br);
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    try {
      await browser.execute((pid) => window.__termic!.useUI.getState().openNewTask(pid), proj.id);
      const madeId = await createInDialog("box-based");
      const made = await browser.waitUntil(async () => ((await call({ cmd: "list" }))?.data?.tasks ?? []).find((t: any) => t.id === madeId),
        { timeout: 30_000, timeoutMsg: "the task never appeared on the box" }) as any;
      expect(made.base_branch).toBe(br);
      await browser.execute((t) => window.__termic!.invoke("task_archive", { id: t }), madeId);
    } finally {
      await browser.execute((p) => window.__termic!.invoke("project_update", { p: { ...p, base_branch: "" } }), proj);
      await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    }
  });

  it("a main-checkout task on a server is recorded on the box too, and survives a resync", async () => {
    const proj = await browser.execute((sid) => window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid), serverId) as any;
    const id = await browser.execute(async (pid) => {
      const t = window.__termic!;
      const task = await t.ipc.taskOpenRepo(pid, "boxagent", "box-main");
      await t.useApp.getState().loadAll();
      return task.id as string;
    }, proj.id) as string;
    const onBox = await browser.waitUntil(async () => ((await call({ cmd: "list" }))?.data?.tasks ?? []).find((t: any) => t.id === id),
      { timeout: 20_000, timeoutMsg: "the main-checkout task never reached the box" }) as any;
    expect(onBox.name).toBe("box-main");
    // A resync (any change on the box) keeps it, unarchived.
    expect((await cliRpc({ cmd: "send", task, prompt: "resync please" })).ok).toBe(true);
    await browser.waitUntil(async () => (await deskLogs()).includes("box says: resync please"), { timeout: 20_000, timeoutMsg: "the nudge never landed" });
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    expect(await browser.execute((t) => (window.__termic!.useApp.getState().tasks.find((x: any) => x.id === t) as any)?.archived, id)).toBe(false);
    await browser.execute((t) => window.__termic!.invoke("task_archive", { id: t }), id);
  });

  it("shows a server project's settings without this Mac's sandbox, secrets or code navigation", async () => {
    const pid = await browser.execute((sid) => (window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid) as any)?.id as string, serverId);
    // Opening settings right after the previous case's dialog closed was
    // occasionally lost on a real-box run: ask again until the page shows.
    await browser.waitUntil(async () => {
      await browser.execute((id) => window.__termic!.useApp.getState().openSettings("repositories", id), pid);
      return browser.execute(() => !!document.querySelector('[data-repo-tab="git"]'));
    }, { timeout: 20_000, interval: 1_000, timeoutMsg: "the server project's settings never opened" });
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
    expect((await cliRpc({ cmd: "send", task, prompt: "after removal" })).ok).toBe(true);
    await browser.waitUntil(async () => (await deskLogs()).includes("box says: after removal"), { timeout: 20_000, timeoutMsg: "the nudge never landed" });
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    expect(await browser.execute((sid) => window.__termic!.useApp.getState().projects.some((p: any) => p.server === sid && p.name === "extra"), serverId)).toBe(false);
    rmSync(extra, { recursive: true, force: true });
  });

  it("a server project's + opens the New task dialog straight away", async () => {
    const pid = await browser.execute((sid) => (window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid) as any)?.id as string, serverId);
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as PointerEventInit;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    }, `[data-testid="project-new-task-${pid}"]`);
    await waitVisible('[role="dialog"] [data-testid="new-task-name"]', 20_000);
    expect(await browser.execute(() => !!document.querySelector("[role='menu']"))).toBe(false);
    await browser.execute(() => window.__termic!.useUI.getState().closeNewTask());
    await waitGone('[role="dialog"] [data-testid="new-task-name"]');
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

  it("renaming the server project here keeps its tasks through a resync", async () => {
    // server_projects.rs mirror: box tasks are matched by the box's project
    // id; matched by name, a rename here archived every task.
    const proj = await browser.execute((sid) => window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid), serverId) as any;
    await browser.execute((p) => window.__termic!.invoke("project_update", { p: { ...p, name: "Renamed here" } }), proj);
    try {
      expect((await cliRpc({ cmd: "send", task, prompt: "after a project rename" })).ok).toBe(true);
      await browser.waitUntil(async () => (await deskLogs()).includes("box says: after a project rename"), { timeout: 20_000, timeoutMsg: "the send never landed" });
      // The box's changed snapshot resyncs; the task must still be live.
      await browser.waitUntil(async () => browser.execute(async (id) => {
        await window.__termic!.useApp.getState().loadAll();
        const t = window.__termic!.useApp.getState().tasks.find((x: any) => x.id === id) as any;
        return !!t && !t.archived;
      }, task), { timeout: 10_000, timeoutMsg: "a project rename archived the server task" });
    } finally {
      await browser.execute((p) => window.__termic!.invoke("project_update", { p }), proj);
    }
  });

  it("an editor save on the box keeps the file's mode and writes through a symlink", async () => {
    // lib.rs BOX_WRITE_SH: was a plain cat-then-mv, which left a 0755
    // script 0644 and replaced a dotfiles link with a file.
    const wt = await browser.execute((id) => (window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id) as any)?.path as string, task);
    writeFileSync(path.join(wt, "run.sh"), "#!/bin/sh\necho old\n");
    chmodSync(path.join(wt, "run.sh"), 0o755);
    execFileSync("ln", ["-sf", "run.sh", path.join(wt, "link.sh")]);
    await browser.execute((id) => window.__termic!.invoke("task_file_write", { id, path: "link.sh", content: "#!/bin/sh\necho new\n" }), task);
    expect(readFileSync(path.join(wt, "run.sh"), "utf8")).toContain("echo new");
    expect(statSync(path.join(wt, "run.sh")).mode & 0o777).toBe(0o755);
    expect(lstatSync(path.join(wt, "link.sh")).isSymbolicLink()).toBe(true);
  });

  it("a terminal closed while the box is offline ends there once it is back", async () => {
    // remote_client.rs pending_kills: the kill used to be dropped, and the
    // process ran on the box with nobody left who knew it.
    const wt = await browser.execute((id) => (window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id) as any)?.path as string, task);
    const marker = `sleep ${7000 + Math.floor(Math.random() * 999)}`;
    const running = () => { try { execFileSync("pgrep", ["-f", marker.replace("sleep", "[s]leep")]); return true; } catch { return false; } };
    const pty = await browser.execute((cwd, m, id) => window.__termic!.invoke("pty_spawn", { args: { cwd, cmd: "/bin/sh", args: ["-c", m], rows: 24, cols: 80, owner: { task_id: id, tab_id: "offline-kill", kind: "aux" } } }), wt, marker, task) as any;
    await browser.waitUntil(async () => running(), { timeout: 15_000, timeoutMsg: "the terminal never started on the box" });
    await browser.execute((id) => window.__termic!.invoke("remote_set_connected", { machine: id, on: false }), serverId);
    await browser.execute((id) => window.__termic!.invoke("pty_kill", { ptyId: id }), pty.id);
    // Outlasts remote_client's KILL_GRACE (1.5 s): the kill is attempted
    // after it, finds no link, and must be queued, not dropped.
    await browser.pause(2500);
    expect(running()).toBe(true);
    await browser.execute((id) => window.__termic!.invoke("remote_set_connected", { machine: id, on: true }), serverId);
    await browser.waitUntil(async () => !running(), { timeout: 30_000, timeoutMsg: "the closed terminal kept running on the box" });
  });

  it("archiving with Delete branch removes the branch on the box too", async () => {
    // lib.rs task_archive_sync: the server branch returned before reading it.
    const proj = await browser.execute((sid) => window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid), serverId) as any;
    await browser.execute((pid) => window.__termic!.useUI.getState().openNewTask(pid), proj.id);
    const id = await createInDialog("box-branch-gone");
    const branch = await browser.execute((t) => (window.__termic!.useApp.getState().tasks.find((x: any) => x.id === t) as any)?.branch as string, id);
    const branches = () => execFileSync("git", ["-C", repo, "branch", "--list", "--format=%(refname:short)"], { encoding: "utf8" }).split("\n");
    expect(branches()).toContain(branch);
    await browser.execute((t) => window.__termic!.invoke("task_archive", { id: t, deleteBranch: true }), id);
    await browser.waitUntil(async () => !branches().includes(branch), { timeout: 20_000, timeoutMsg: "the branch stayed on the box" });
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
      // The top bar's Archive: a server task has no second header of its own.
      expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-task-archive"]'))).toBe(false);
      await clickPresent('[data-testid="archive-task"]');
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

// Keeping a server's termic-server current (remote_client::auto_upgrade):
// on connecting, a box running another build than the one this app carries
// gets the carried one, then a restart onto it. The "old" server is the
// debug build wrapped to report another version (TERMIC_SERVER_FAKE_VERSION,
// debug only); the carried build is the same binary staged where the app
// looks for its builds (.e2e/server-bin, wdio.conf.ts).
const describeUpgrade = process.platform !== "win32" && localBox && !process.env.TERMIC_E2E_SERVER_BIN_DIR ? describe : describe.skip;

describeUpgrade("A server's termic-server stays current", function () {
  this.timeout(180_000);
  const HOST = "termic-e2e-local";
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const box = localBox!;
  const repo = path.join(box, "repo");
  const bin = path.join(process.env.TERMIC_E2E_SERVER_DIR ?? path.join(repoRoot, "src-tauri", "target", "debug"), "termic-server");
  const staged = path.join(repoRoot, ".e2e", "server-bin");
  const installed = path.join(box, ".termic", "bin", "termic-server");
  const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
  const server = (...args: string[]) => execFileSync(bin, args, { env: { ...process.env, HOME: box, SHELL: "/bin/sh" }, encoding: "utf8" });
  let serverId = "";
  const machine = () => browser.execute((id) => window.__termic!.useRemote.getState().machines.find((m: any) => m.id === id) ?? null, serverId) as Promise<any>;
  const call = (request: Record<string, unknown>) => browser.execute((m, r) =>
    window.__termic!.invoke("remote_call", { machine: m, request: { id: "", ...r } }), serverId, request) as Promise<any>;
  /** The box runs an old build: the daemon stopped, the installed binary a wrapper. */
  const stageOld = (version = "0-old") => {
    try { server("stop"); } catch { /* not running */ }
    mkdirSync(path.dirname(installed), { recursive: true });
    writeFileSync(installed, `#!/bin/sh\nTERMIC_SERVER_FAKE_VERSION=${version} exec "${bin}" "$@"\n`);
    chmodSync(installed, 0o755);
  };
  /** Off and on again: a fresh connection, which is when the upgrade runs. */
  const reconnect = async () => {
    await browser.execute((id) => window.__termic!.invoke("remote_set_connected", { machine: id, on: false }), serverId);
    await browser.execute((id) => window.__termic!.invoke("remote_set_connected", { machine: id, on: true }), serverId);
  };
  const versionIs = (v: string, msg: string) => browser.waitUntil(async () => {
    const m = await machine();
    return m?.state === "online" && m.version === v;
  }, { timeout: 40_000, timeoutMsg: msg });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    execFileSync("cargo", ["build", "-q", "-p", "termic-server"], { cwd: path.join(repoRoot, "src-tauri"), stdio: "inherit" });
    try { server("stop"); } catch { /* not running */ }
    rmSync(box, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(path.join(box, ".termic-server"), { recursive: true });
    mkdirSync(repo, { recursive: true });
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "e2e@termic.dev"], ["config", "user.name", "e2e"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
      execFileSync("git", ["-C", repo, ...args]);
    }
    const agent = path.join(box, "agent.sh");
    // "busy N": a turn that prints for N half-seconds (the server reads
    // output as working), then settles.
    writeFileSync(agent, [
      "#!/bin/sh",
      "printf 'fake agent ready\\r\\n> '",
      "while IFS= read -r l; do",
      "  case \"$l\" in",
      "    busy*) set -- $l; i=0; while [ $i -lt $2 ]; do printf 'working %s\\r\\n' $i; sleep 0.5; i=$((i+1)); done; printf 'done\\r\\n> ' ;;",
      "    *) printf 'box says: %s\\r\\n> ' \"$l\" ;;",
      "  esac",
      "done",
      "",
    ].join("\n"));
    chmodSync(agent, 0o755);
    // The desktop's registry runs it (the box is this Mac).
    await browser.execute(async (cmd) => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      const fake = s.agents.find((a: any) => a.id === "fakeagent");
      const caps = { ...fake.capabilities, yolo_args: [], resume_args: [], session_id_args: [], resume_id_args: [], name_args: [] };
      s.agents = [...s.agents.filter((a: any) => a.id !== "boxagent"), { ...fake, id: "boxagent", display_name: "BoxAgent", command: cmd, args: [], builtin: false, capabilities: caps }];
      await t.ipc.settingsSave(s);
      await t.useApp.getState().loadAll();
    }, agent);
    stageOld();
  });

  /** A task on the box, made by this desktop with the box's fake agent. */
  const makeTask = async (name: string) => {
    const projectId = await browser.waitUntil(async () => browser.execute((sid) =>
      (window.__termic!.useApp.getState().projects.find((p: any) => p.server === sid) as any)?.id as string | undefined, serverId),
    { timeout: 30_000, timeoutMsg: "the box's project never reached the store" }) as string;
    await browser.execute((pid) => window.__termic!.useUI.getState().openNewTask(pid), projectId);
    await waitVisible('[role="dialog"] [data-testid="new-task-name"]', 20_000);
    await clickPresent('[data-testid="rail-agent"]');
    await clickWhenVisible('[role="dialog"] [data-cli="boxagent"]');
    await clickPresent('[data-testid="rail-task"]');
    await clickPresent('[data-testid="task-type-worktree"]');
    await setInputValue('[data-testid="new-task-name"]', name);
    await clickPresent('[data-testid="new-task-create"]');
    const id = await browser.waitUntil(async () => browser.execute((n) =>
      (window.__termic!.useApp.getState().tasks.find((t: any) => t.name === n && !t.archived) as any)?.id as string | undefined, name),
    { timeout: 60_000, timeoutMsg: `${name} never reached the store` }) as string;
    await browser.waitUntil(async () => String((await cliRpc({ cmd: "logs", task: id }))?.data?.data ?? "").includes("fake agent ready"),
      { timeout: 30_000, timeoutMsg: `${name}'s agent never started` });
    return id;
  };

  after(async () => {
    if (serverId) await browser.execute((id) => window.__termic!.invoke("server_remove", { id }), serverId).catch(() => {});
    try { server("stop"); } catch { /* already gone */ }
    rmSync(box, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  });

  it("leaves an old server alone while this app carries no build", async () => {
    const rec = await browser.execute((h) => window.__termic!.invoke("server_add", { ssh: h, name: "Upgrade box" }), HOST) as any;
    serverId = rec.id;
    await versionIs("0-old", "the old server never came online");
    expect((await call({ cmd: "project_add", path: repo })).ok).toBe(true);
    await makeTask("long-job");
    expect((await machine()).update ?? null).toBe(null);
    expect(readFileSync(installed, "utf8")).toContain("0-old");
  });

  const stateOf = async (name: string) => (await call({ cmd: "list" }))?.data?.tasks?.find((t: any) => t.name === name)?.work_state as string | undefined;
  const busy = async (halfSeconds: number) => {
    // Through this desktop. A box stopped under it (stageOld) ended the
    // agent: then --fresh starts it again (the fake has no session).
    let r = await cliRpc({ cmd: "send", task: "long-job", prompt: `busy ${halfSeconds}` });
    if (!r.ok) r = await cliRpc({ cmd: "send", task: "long-job", prompt: `busy ${halfSeconds}`, fresh: true });
    if (!r.ok) throw new Error(`send failed: ${JSON.stringify(r)}`);
    await browser.waitUntil(async () => (await stateOf("long-job")) === "working", { timeout: 15_000, timeoutMsg: "the box never read the turn as working" });
  };
  const stageNew = () => {
    mkdirSync(staged, { recursive: true });
    execFileSync("cp", [bin, path.join(staged, `termic-server-${triple}`)]);
    writeFileSync(path.join(staged, "termic-server-version.txt"), `${server("version").trim().replace(/^termic-server /, "")}\n`);
  };
  const newVersion = () => server("version").trim().replace(/^termic-server /, "");

  it("mid-turn, installs the carried build and waits; restarts by itself when the turn ends", async () => {
    stageNew();
    await busy(16); // 8 s
    await reconnect();
    await waitVisible(`[data-testid="server-update-${serverId}"]`, 40_000);
    // Installed, not yet running: the file is the real build, the daemon still the old one.
    expect(readFileSync(installed).subarray(0, 2).toString()).not.toBe("#!");
    expect((await machine()).version).toBe("0-old");
    await snap("remote-server-update-waiting.png");
    // The turn ends; the server moves onto the new build with no click, and
    // the agent comes back.
    await versionIs(newVersion(), "the server never restarted after the turn ended");
    await waitGone(`[data-testid="server-update-${serverId}"]`);
    await browser.waitUntil(async () => { const st = await stateOf("long-job"); return !!st && st !== "inactive"; },
      { timeout: 20_000, timeoutMsg: "the agent was not resumed after the restart" });
  });

  it("Restart now does not wait for the turn", async () => {
    // An old server, with nothing carried yet so it stays old while a long
    // turn starts; then the carried build appears and a fresh link (off and
    // on) installs it.
    rmSync(staged, { recursive: true, force: true });
    stageOld();
    await reconnect();
    await versionIs("0-old", "the re-staged old server never came online");
    await busy(240);
    stageNew();
    await reconnect();
    await waitVisible(`[data-testid="server-update-${serverId}"]`, 40_000);
    await clickPresent(`[data-testid="server-restart-${serverId}"]`);
    await versionIs(newVersion(), "Restart now did not move the server onto the new build");
  });

  it("with no agent mid-turn, restarts onto the carried build without showing anything", async () => {
    stageOld();
    await reconnect();
    // The wrapper is replaced (it may run for only a moment, so the file is
    // what proves an upgrade ran, not catching the old version).
    await browser.waitUntil(() => readFileSync(installed).subarray(0, 2).toString() !== "#!", { timeout: 40_000, timeoutMsg: "the old build was never replaced" });
    await versionIs(newVersion(), "a settled server was not restarted onto the new build");
    expect(await browser.execute((id) => !!document.querySelector(`[data-testid="server-update-${id}"]`), serverId)).toBe(false);
  });

  it("an older server that still works is upgraded quietly, and restarts only when asked", async () => {
    // Both far above compat::REQUIRES_SERVER: the old one still works with
    // this desktop. The carried build is a wrapper too, so it can report a
    // newer version than this debug binary does.
    const [oldV, newV] = ["900.0.0+old", "900.0.1+new"];
    stageOld(oldV);
    mkdirSync(staged, { recursive: true });
    const carried = path.join(staged, `termic-server-${triple}`);
    writeFileSync(carried, `#!/bin/sh\nTERMIC_SERVER_FAKE_VERSION=${newV} exec "${bin}" "$@"\n`);
    chmodSync(carried, 0o755);
    writeFileSync(path.join(staged, "termic-server-version.txt"), `${newV}\n`);
    await reconnect();
    await waitVisible(`[data-testid="server-update-${serverId}"]`, 40_000);
    expect(await browser.execute((id) => document.querySelector(`[data-testid="server-update-${id}"]`)!.getAttribute("data-required"), serverId)).toBe("false");
    expect(readFileSync(installed, "utf8")).toContain(newV);
    expect((await machine()).update_required).toBe(false);
    // No agent is mid-turn, so a required update would restart at once:
    // a negative, outlasting the restart a required update sends straight
    // after the install. Nothing fires for a restart that never happens.
    await browser.pause(4000);
    expect((await machine()).version).toBe(oldV);
    await snap("remote-server-update-optional.png");
    await clickPresent(`[data-testid="server-restart-${serverId}"]`);
    await versionIs(newV, "Restart now did not move the server onto the installed build");
    await waitGone(`[data-testid="server-update-${serverId}"]`);
  });

  it("never downgrades a server that is newer than the build this app carries", async () => {
    // The server now runs 900.0.1; carry an older build.
    const carried = path.join(staged, `termic-server-${triple}`);
    writeFileSync(carried, `#!/bin/sh\nTERMIC_SERVER_FAKE_VERSION=900.0.0+old exec "${bin}" "$@"\n`);
    writeFileSync(path.join(staged, "termic-server-version.txt"), "900.0.0+old\n");
    await reconnect();
    await versionIs("900.0.1+new", "the newer server did not come back online");
    // A negative: no install may start. Nothing fires for an upload that
    // never happens.
    await browser.pause(3000);
    expect(readFileSync(installed, "utf8")).toContain("900.0.1+new");
    expect((await machine()).update ?? null).toBe(null);
  });

  it("an agent this desktop started on the box comes back after the box restarts", async () => {
    const id = await makeTask("survives-restart");
    const agentPty = () => browser.execute((tid) => ((window.__termic!.useApp.getState().tabs[tid] ?? []).find((t: any) => t.type === "terminal" && t.is_default) as any)?.ptyId as string | undefined, id);
    await browser.waitUntil(async () => !!(await agentPty()), { timeout: 30_000, timeoutMsg: "the agent never started" });
    const before = await agentPty();
    await typeIntoAgent(id, "first\r");
    await browser.waitUntil(async () => String((await cliRpc({ cmd: "logs", task: id }))?.data?.data ?? "").includes("box says: first"),
      { timeout: 20_000, timeoutMsg: "the agent never answered" });
    // Restart the box (what an upgrade does): its PTYs end, and the new
    // daemon tells this desktop they were restarted, not that they exited.
    await browser.execute((sid) => window.__termic!.invoke("server_restart", { machine: sid }), serverId);
    await browser.waitUntil(async () => { const p = await agentPty(); return !!p && p !== before; },
      { timeout: 60_000, timeoutMsg: "the agent was not started again after the restart" });
    await typeIntoAgent(id, "again\r");
    await browser.waitUntil(async () => String((await cliRpc({ cmd: "logs", task: id }))?.data?.data ?? "").includes("box says: again"),
      { timeout: 30_000, timeoutMsg: "the restarted agent never answered" });
  });
});
