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
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clickMenuItem, clickPresent, requireTermicApi, setInputValue, snap, typeIntoRemoteTerminal, waitForAppShell, waitForAttr, waitGone, waitVisible } from "../helpers.js";

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
cd ~/${BOX_DIR}/repo && git init -q -b main && git -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init
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
    await clickPresent(`[data-testid="remote-new-task-${serverId}"]`);
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
    await waitVisible(`[data-testid="remote-task-${task}"]`);
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
    await clickPresent('[data-testid="remote-task-close"]');
    await waitGone('[data-testid="remote-task-view"]');
    // Archived from here: the agent stops and its worktree goes, on the box.
    const r = await browser.execute((m, t) => window.__termic!.invoke("remote_call", { machine: m, request: { id: "", cmd: "archive", task: t } }), serverId, task) as any;
    expect(r.ok).toBe(true);
    await waitGone(`[data-testid="remote-task-${task}"]`, 20_000);
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
  const row = () => `[data-testid="remote-task-${task}"]`;
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
    for (const args of [["init", "-q", "-b", "main"], ["-c", "user.email=e2e@termic.dev", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "init"]]) {
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

  it("connects, and lists a task started on it under the server", async () => {
    const rec = await browser.execute((h) => window.__termic!.invoke("server_add", { ssh: h, name: "Local box" }), HOST) as any;
    serverId = rec.id;
    await waitVisible(`[data-testid="remote-machine-${serverId}"]`, 30_000);
    await browser.waitUntil(async () => browser.execute((id) =>
      window.__termic!.useRemote.getState().machines.find((m: any) => m.id === id)?.state === "online", serverId),
    { timeout: 30_000, timeoutMsg: "the local server never came online" });
    const added = await call({ cmd: "project_add", path: repo });
    expect(added.ok).toBe(true);
    const r = await call({ cmd: "new", name: "box-task", project: "repo", agent: "fake", prompt: "hello" });
    expect(r.ok).toBe(true);
    task = await browser.waitUntil(async () => browser.execute((id) =>
      (window.__termic!.useRemote.getState().machines.find((m: any) => m.id === id)?.tasks ?? []).find((t: any) => t.name === "box-task")?.id as string | undefined, serverId),
    { timeout: 20_000, timeoutMsg: "the new task never showed under the server" });
    await waitVisible(row());
    await browser.waitUntil(async () => (await logs()).includes("box says: hello"), { timeout: 20_000, timeoutMsg: "the agent never answered" });
    await snap("remote-local-server-row.png");
  });

  it("opens the task as its terminal, with no tab strip for a single tab, and typing reaches the agent", async () => {
    await clickPresent(row());
    await waitVisible('[data-testid="remote-task-view"]', 20_000);
    await waitVisible('[data-testid="remote-terminal"]');
    // A server task has one tab: no strip to pick from.
    expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-tabs"]'))).toBe(false);
    // The server's PTY follows this pane's size.
    expect(await browser.execute(() => document.querySelector('[data-testid="remote-terminal"]')!.getAttribute("data-owns-size"))).toBe("true");
    await typeIntoRemoteTerminal("typed here\r");
    await browser.waitUntil(async () => (await logs()).includes("box says: typed here"), { timeout: 20_000, timeoutMsg: "keys typed into the terminal never reached the agent" });
    await snap("remote-local-server-task.png");
    await clickPresent('[data-testid="remote-task-close"]');
    await waitGone('[data-testid="remote-task-view"]');
  });

  it("offers Rename alone on a server task's menu, and renames it on the server", async () => {
    await openMenu();
    // No pin, no task groups on a server: termic-server answers neither verb.
    expect(await menuItems()).toEqual(["Rename"]);
    await clickMenuItem("Rename");
    const input = `[data-testid="remote-task-rename-${task}"]`;
    await waitVisible(input);
    await setInputValue(input, "renamed-on-box");
    await browser.execute((sel) => document.querySelector(sel)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })), input);
    await browser.waitUntil(async () => {
      const list = await call({ cmd: "list" });
      return (list?.data?.tasks ?? []).some((t: any) => t.id === task && t.name === "renamed-on-box");
    }, { timeout: 10_000, timeoutMsg: "the server never got the new name" });
    await browser.waitUntil(async () => browser.execute((sel) => document.querySelector(sel)?.textContent?.includes("renamed-on-box") ?? false, row()),
      { timeout: 10_000, timeoutMsg: "the row never showed the new name" });
    await closeMenu();
  });

  it("raises a needs-you alert when the server's agent asks something", async () => {
    const alerts = () => browser.execute(() => (window.__termic!.useRemote.getState().alerts as any[]).map(a => [a.task, a.kind, a.machineName] as string[])) as Promise<string[][]>;
    const before = (await alerts()).length;
    expect((await call({ cmd: "send", task, prompt: "please ask" })).ok).toBe(true);
    await browser.waitUntil(async () => browser.execute((sel) => document.querySelector(sel)?.getAttribute("data-state") === "waiting", row()),
      { timeout: 20_000, timeoutMsg: "the row never showed the agent waiting" });
    // Look for it among the new alerts rather than first: the turn typed in
    // the case before may finish meanwhile, which rightly rings "done".
    const waiting = () => alerts().then(a => a.slice(before).find(x => x[1] === "waiting"));
    await browser.waitUntil(async () => !!(await waiting()), { timeout: 10_000, timeoutMsg: "no alert for the task that started waiting" });
    expect(await waiting()).toEqual([task, "waiting", "Local box"]);
  });

  it("archives the task from here, and it leaves the sidebar", async () => {
    expect((await call({ cmd: "archive", task })).ok).toBe(true);
    await waitGone(row(), 20_000);
  });
});
