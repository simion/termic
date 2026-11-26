// LAN pairing (docs/peers.md), end to end against the REAL peer listener.
// Calls cross on the stream (docs/remote.md): a sealed WebSocket.
//
// The second machine is a fake in this process: it speaks the peer protocol
// with node:crypto (HKDF-SHA256, ChaCha20-Poly1305) and @noble/curves for
// SPAKE2 over Ed25519, so every pairing here is also a cross-implementation
// check of peer_crypto.rs and the spake2 crate: the fake types the code the
// app's pairing mode shows (or shows one the app types), and the pairing
// only completes when both derived the same key from it.
//
// wdio.conf.ts sets TERMIC_PEER_LOOPBACK=1, so sharing binds 127.0.0.1 and
// skips mDNS: no Local Network or firewall prompt for a run that only talks
// to itself. Discovery is unit-tested in mdns.rs; this file covers the UI,
// the listener, pairing both ways, sealed calls, grants, rename and unpair.
//
// Order matters: a WRONG CODE cools the address down for 2 seconds, and every
// request here comes from 127.0.0.1, so that case runs after the last
// pairing the fake starts against the app.
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { ed25519 } from "@noble/curves/ed25519";
import { dataDir } from "../../wdio.conf.js";
import { readFileSync } from "node:fs";

// The fake machine runs this release: paired computers are judged by a
// version floor (termic_remote::compat::REQUIRES_DESKTOP), so a made-up
// version would read as too old.
const FAKE_VERSION = (JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")) as { version: string }).version;
import {
  waitForText,
  cliBinary, clickMenuItem, clickPresent, readClipboard, requireTermicApi, setInputValue, snap, typeIntoRemoteTerminal, waitForAppShell, waitForAttr, waitGone, waitVisible,
  openTask,
} from "../helpers.js";

const PREFIX = "/termic-peer/v1";

// ── the protocol, as the fake speaks it ─────────────────────────────

const sha256 = (...parts: Buffer[]) => {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const hkdf32 = (salt: Buffer, ikm: Buffer, info: string) =>
  Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from(info), 32));
const pairKey = (secret: Buffer, idA: string, idB: string) =>
  hkdf32(Buffer.from("termic-pair-v2"), secret, `termic-peer-v2|${idA}|${idB}`);

// SPAKE2 over Ed25519, as the spake2 crate (0.4) runs it: messages are a
// side byte ('A' 0x41 typed the code, 'B' 0x42 shows it) and a compressed
// point; the password scalar is HKDF(pw, "SPAKE2 pw") read big-endian; the
// key is SHA256 over H(pw), H(idA), H(idB), X, Y and K.
const Ed = ed25519.ExtendedPoint;
const L = ed25519.CURVE.n;
const M = Ed.fromHex("15cfd18e385952982b6a8f8c7854963b58e34388c8e6dae891db756481a02312");
const N = Ed.fromHex("f04f2e7eb734b2a8f8b472eaf9c3c632576ac64aea650b496a8a20ff00e583c3");
const toScalar = (b: Buffer) => BigInt(`0x${b.toString("hex")}`) % L;

function spake(side: "A" | "B", code: string, idA: string, idB: string) {
  const pw = Buffer.from(code);
  const w = toScalar(Buffer.from(crypto.hkdfSync("sha256", pw, Buffer.alloc(0), Buffer.from("SPAKE2 pw"), 48)));
  const x = toScalar(crypto.randomBytes(64)) || 1n;
  const mine = Buffer.from(Ed.BASE.multiply(x).add((side === "A" ? M : N).multiply(w)).toRawBytes());
  const msg = Buffer.concat([Buffer.from([side === "A" ? 0x41 : 0x42]), mine]);
  const finish = (theirs: Buffer) => {
    const t = theirs.subarray(1);
    const k = Ed.fromHex(t).add((side === "A" ? N : M).multiply(L - w)).multiply(x);
    const [X, Y] = side === "A" ? [mine, t] : [t, mine];
    return sha256(sha256(pw), sha256(Buffer.from(idA)), sha256(Buffer.from(idB)), X, Y, Buffer.from(k.toRawBytes()));
  };
  return { msg, finish };
}
const dirKey = (k: Buffer, sender: string, receiver: string) =>
  hkdf32(Buffer.from("termic-dir-v1"), k, `${sender}->${receiver}`);
const aad = (path: string, sender: string, receiver: string) =>
  Buffer.from(`termic-peer-v1|${path}|${sender}|${receiver}`);

interface Envelope { from: string; n: string; c: string }

function seal(k: Buffer, path: string, sender: string, receiver: string, msg: unknown): Envelope {
  const plain = Buffer.from(JSON.stringify(msg));
  const n = crypto.randomBytes(12);
  const c = crypto.createCipheriv("chacha20-poly1305", dirKey(k, sender, receiver), n, { authTagLength: 16 });
  c.setAAD(aad(path, sender, receiver), { plaintextLength: plain.length });
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { from: sender, n: n.toString("base64"), c: ct.toString("base64") };
}

function open(k: Buffer, path: string, receiver: string, env: Envelope): any {
  const buf = Buffer.from(env.c, "base64");
  const d = crypto.createDecipheriv("chacha20-poly1305", dirKey(k, env.from, receiver),
    Buffer.from(env.n, "base64"), { authTagLength: 16 });
  d.setAAD(aad(path, env.from, receiver), { plaintextLength: buf.length - 16 });
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString());
}

const sealed = (body: unknown, extra: Record<string, unknown> = {}) =>
  ({ ts: Date.now(), rid: crypto.randomBytes(16).toString("hex"), body, ...extra });

/** One HTTP exchange with the app's peer listener. */
function req(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json" } }, res => {
      let data = "";
      res.on("data", d => (data += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on("error", reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** The CLI, ASYNCHRONOUSLY. Not helpers' runCli: execFileSync blocks this
 *  process's event loop, and the machine a `--peer` call reaches is a fake
 *  server in this same process, so the call could never be answered. Same
 *  socket pinning as runCli (a release sidecar must not reach a real app). */
function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const sock = process.platform === "win32" ? {} : { TERMIC_SOCKET: path.join(dataDir, "termic.sock") };
  return new Promise(resolve => {
    execFile(cliBinary(), args, { env: { ...process.env, TERMIC_DATA_DIR: dataDir, ...sock, ...env }, encoding: "utf8" },
      (err, stdout, stderr) => resolve({ code: err ? Number((err as any).code ?? 1) : 0, stdout, stderr }));
  });
}

// ── the fake machine ────────────────────────────────────────────────

/** A paired fake: what it needs to call the app, and to be called. */
interface Fake { id: string; name: string; key?: Buffer; port: number }

function newFake(name: string): Fake {
  return { id: crypto.randomBytes(16).toString("hex"), name, port: 9 };
}

/** The fake types `code` against the app's pairing mode (an INCOMING pairing
 *  on the app's side). Returns what the app answered at each step, and the
 *  key when the app accepted the confirm. */
/** The fake's person clicked Pair on the app: the app shows a code. */
async function fakeAsks(app: number, fake: Fake) {
  const hello = JSON.parse((await req(app, "GET", `${PREFIX}/hello`)).body);
  return req(app, "POST", `${PREFIX}/pair/request`, {
    from: { id: fake.id, name: fake.name, version: FAKE_VERSION, proto: hello.proto, pv: 2, port: fake.port },
  });
}

async function fakePairs(app: number, fake: Fake, code: string) {
  const hello = JSON.parse((await req(app, "GET", `${PREFIX}/hello`)).body);
  const a = spake("A", code, fake.id, hello.id);
  const start = await req(app, "POST", `${PREFIX}/pair/start`, {
    from: { id: fake.id, name: fake.name, version: FAKE_VERSION, proto: hello.proto, pv: 2, port: fake.port },
    msg: a.msg.toString("base64"),
  });
  const base = { appId: hello.id as string, proto: hello.proto as number, start: start.status };
  if (start.status !== 200) return { ...base, confirm: 0, error: start.body, key: undefined as Buffer | undefined, grant: undefined as string | undefined };
  const s = JSON.parse(start.body);
  expect(s.to.id).toBe(hello.id);
  const key = pairKey(a.finish(Buffer.from(s.msg, "base64")), fake.id, hello.id);
  const path = `${PREFIX}/pair/confirm`;
  const msg = sealed({ grant: "drive" });
  const r = await req(app, "POST", path, { pairing: s.pairing, env: seal(key, path, fake.id, hello.id, msg) });
  if (r.status !== 200) return { ...base, confirm: r.status, error: r.body, key: undefined, grant: undefined };
  // The app's answer opens under the fake's key: one key from one code.
  const answer = open(key, path, fake.id, JSON.parse(r.body));
  expect(answer.rid).toBe(msg.rid);
  return { ...base, confirm: 200, error: "", key, grant: answer.body.grant as string };
}

// ── the stream (docs/remote.md), as the fake speaks it ─────────────

const STREAM = `${PREFIX}/stream`;
const streamNonce = (n: number) => { const b = Buffer.alloc(12); b.writeBigUInt64BE(BigInt(n), 4); return b; };
const streamKey = (pair: Buffer, salt: Buffer, dir: "c2s" | "s2c", host: string, client: string) =>
  Buffer.from(crypto.hkdfSync("sha256", pair, salt, Buffer.from(`termic-stream-v1|${dir}|${host}|${client}`), 32));
function sealFrame(k: Buffer, n: number, msg: unknown): Buffer {
  const c = crypto.createCipheriv("chacha20-poly1305", k, streamNonce(n), { authTagLength: 16 });
  return Buffer.concat([c.update(Buffer.from(JSON.stringify(msg))), c.final(), c.getAuthTag()]);
}
function openFrame(k: Buffer, n: number, f: Buffer): any {
  const d = crypto.createDecipheriv("chacha20-poly1305", k, streamNonce(n), { authTagLength: 16 });
  d.setAuthTag(f.subarray(f.length - 16));
  return JSON.parse(Buffer.concat([d.update(f.subarray(0, f.length - 16)), d.final()]).toString());
}

/** The fake connects to the app's stream as a paired computer. Resolves
 *  once welcomed; rejects with the close code when refused. */
function fakeStream(app: number, fake: Fake, appId: string, key: Buffer, raw?: { salt: Buffer; hello?: Buffer }) {
  return new Promise<{ send(m: unknown): void; next(pred?: (m: any) => boolean): Promise<any>; close(): void; welcome: any; hello: Buffer; salt: Buffer }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${app}${STREAM}`);
    ws.binaryType = "arraybuffer";
    let tx: Buffer | null = null, rx: Buffer | null = null, sn = 0, rn = 0, welcomed = false;
    const inbox: any[] = []; const waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = [];
    const salt = raw?.salt ?? crypto.randomBytes(16);
    let helloFrame = Buffer.alloc(0);
    const api = {
      send: (m: unknown) => ws.send(sealFrame(tx!, sn++, m)),
      next: (pred: (m: any) => boolean = () => true) => new Promise<any>(res => {
        const i = inbox.findIndex(pred);
        if (i >= 0) res(inbox.splice(i, 1)[0]); else waiters.push({ pred, res });
      }),
      close: () => ws.close(),
    };
    ws.onmessage = (ev) => {
      const f = Buffer.from(ev.data as ArrayBuffer);
      if (!tx) {
        const s = Buffer.concat([f, salt]);
        tx = streamKey(key, s, "c2s", appId, fake.id);
        rx = streamKey(key, s, "s2c", appId, fake.id);
        ws.send(Buffer.concat([salt, Buffer.from(fake.id, "hex")]));
        helloFrame = raw?.hello ?? sealFrame(tx, sn, { t: "hello", v: 1, name: fake.name, kind: "computer", caps: [], grant: "drive", port: fake.port });
        sn++;
        ws.send(helloFrame);
        return;
      }
      const m = openFrame(rx!, rn++, f);
      if (!welcomed && m.t === "welcome") { welcomed = true; resolve({ ...api, welcome: m, hello: helloFrame, salt }); return; }
      const w = waiters.findIndex(x => x.pred(m));
      if (w >= 0) waiters.splice(w, 1)[0].res(m); else inbox.push(m);
    };
    ws.onclose = (ev) => { if (!welcomed) reject(new Error(`closed ${ev.code}`)); };
    ws.onerror = () => {};
  });
}

/** One verb from the fake over the stream, as `termic --peer` on its side
 *  would send it. `refused` is the close code when the app turned it away. */
async function fakeCalls(app: number, fake: Fake, appId: string, proto: number, cmd: Record<string, unknown>) {
  let c;
  try {
    c = await fakeStream(app, fake, appId, fake.key!);
  } catch (e) {
    return { refused: String(e), reply: null as any };
  }
  c.send({ t: "call", id: "e2e", req: { id: "e2e", ...cmd }, proto });
  const r = await c.next(m => m.t === "reply" && m.id === "e2e");
  c.close();
  return { refused: null as string | null, reply: r.reply };
}

/** The fake as a stream HOST (the app connects out to it for `--peer`): a
 *  minimal WebSocket server on top of node:http's upgrade, enough for the
 *  app's client (masked frames in, unmasked out). */
/** What the fake host's task looks like, and what it was sent. */
const remoteTask = {
  id: "rt-1", name: "fix-login", project: "webapp", agent: "claude", branch: "fix/login", state: "waiting",
  // Its strip as the host lists it: the agent, a running dev server, a
  // shell (which opens only on that machine) and a second agent whose
  // process has exited.
  tabs: [
    { id: "t-agent", title: "claude", agent: "claude", state: "waiting", is_default: true, kind: "agent", live: true },
    { id: "t-run", title: "Run", agent: "shell", state: "unknown", is_default: false, kind: "run", live: true },
    { id: "t-shell", title: "zsh", agent: "shell", state: "unknown", is_default: false, kind: "shell", live: true, viewable: false },
    { id: "t-codex", title: "codex", agent: "codex", state: "idle", is_default: false, kind: "agent", live: false },
  ],
  is_main_checkout: false,
  question: {
    id: "q-1", kind: "command", title: "Do you want to proceed?", body: "Bash command\nnpm test",
    options: [
      { label: "Yes", keys: Buffer.from("\r").toString("base64"), selected: true },
      { label: "No", keys: Buffer.from("\x1b[B\r").toString("base64"), selected: false },
    ],
  },
};
// Filed as the other machine's own sidebar files them: a project folder,
// a coloured task group (named after its lead), a pin, a PR, tab labels.
const backend = { id: "Backend", name: "Backend", color: "purple" };
const authGroup = { id: "rt-2", name: "Auth work", color: "teal" };
const filed = [
  { id: "rt-2", name: "lead-auth", project: "api", agent: "claude", state: "working", tabs: [], is_main_checkout: false,
    project_group: backend, group: authGroup, project_order: 1, order: 0 },
  { id: "rt-3", name: "token-refresh", project: "api", agent: "codex", state: "idle", is_main_checkout: false,
    tabs: [{ id: "t3", title: "codex", agent: "codex", state: "idle", is_default: true, props: [{ key: "ticket", value: "ABC-1" }, { key: "phase", value: "review" }] }],
    project_group: backend, group: authGroup, project_order: 1, order: 2, pinned: true,
    pr: { number: 42, state: "open", title: "Refresh tokens", url: "https://github.com/acme/api/pull/42", provider: "github" } },
  { id: "rt-4", name: "loose-one", project: "api", agent: "claude", state: "done", tabs: [], is_main_checkout: false,
    project_group: backend, project_order: 1, order: 1 },
];
const hostSaw: any[] = [];
/** The fake host's sender for the open terminal, to play it taking the
 *  size back (its own window worked in). */
let hostSend: (msg: unknown) => void = () => {};
/** Push a new task snapshot down the live stream, as the host does when a
 *  task's state moves. Set once the desktop subscribes to tasks. */
let pushTasks: ((tasks: unknown[]) => void) | null = null;
const baseTasks = () => [{ ...remoteTask, project_order: 0, order: 0 }, ...filed];

function serveStream(server: http.Server, remote: Fake, onCall: (req: any) => unknown) {
  // Upgraded sockets leave http.Server's bookkeeping: closing the server
  // must end them itself, or "the machine is off" never happens.
  const live = new Set<import("node:stream").Duplex>();
  server.on("close", () => { for (const s of live) s.destroy(); live.clear(); });
  server.on("upgrade", (q, sock) => {
    if (q.url !== STREAM) { sock.destroy(); return; }
    live.add(sock);
    sock.on("close", () => live.delete(sock));
    const accept = crypto.createHash("sha1").update(`${q.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const frame = (payload: Buffer) => {
      const n = payload.length;
      const head = n < 126 ? Buffer.from([0x82, n]) : n < 65536 ? Buffer.from([0x82, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x82; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
      sock.write(Buffer.concat([head, payload]));
    };
    const hostSalt = crypto.randomBytes(16);
    frame(hostSalt);
    let buf = Buffer.alloc(0);
    let tx: Buffer | null = null, rx: Buffer | null = null, sn = 0, rn = 0, clientId = "";
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15;
        let len = buf[1] & 127, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { sock.end(); return; }
        if (op !== 2 && op !== 1) continue;
        if (!tx) {
          clientId = payload.subarray(16).toString("hex");
          const s = Buffer.concat([hostSalt, payload.subarray(0, 16)]);
          rx = streamKey(remote.key!, s, "c2s", remote.id, clientId);
          tx = streamKey(remote.key!, s, "s2c", remote.id, clientId);
          continue;
        }
        const m = openFrame(rx!, rn++, payload);
        const send = (msg: unknown) => frame(sealFrame(tx!, sn++, msg));
        hostSaw.push(m);
        if (m.t === "hello") {
          send({ t: "welcome", v: 1, id: remote.id, name: remote.name, version: FAKE_VERSION, kind: "desktop", caps: ["call", "tasks", "terminal", "keys", "transcript", "resize"], grant: "drive" });
          if ((m.caps ?? []).includes("tasks")) {
            send({ t: "tasks", tasks: baseTasks() });
            pushTasks = (tasks) => send({ t: "tasks", tasks });
          }
        } else if (m.t === "call") {
          send({ t: "reply", id: m.id, reply: { ...(onCall(m.req) as object), id: m.req.id } });
        } else if (m.t === "keys" && m.id) {
          send({ t: "ack", id: m.id, ok: m.question === remoteTask.question.id, message: m.question === remoteTask.question.id ? undefined : "stale" });
        } else if (m.t === "term_open") {
          hostSend = send;
          send({ t: "term_reset", task: m.task, cols: 80, rows: 10, data: Buffer.from("hello from the other machine\r\n").toString("base64") });
        } else if (m.t === "term_size") {
          // A real host sizes the PTY and confirms it.
          send({ t: "term_resize", cols: m.cols, rows: m.rows });
        } else if (m.t === "transcript") {
          send({ t: "transcript", id: m.id, task: m.task, turns: [{ role: "user", text: "fix the login bug" }, { role: "tool", tool: "Bash", text: "npm test" }, { role: "assistant", text: "Found it." }] });
        }
      }
    });
    sock.on("error", () => {});
  });
}

// ── the app ─────────────────────────────────────────────────────────

const status = () => browser.execute(() => window.__termic!.invoke("peer_status")) as Promise<any>;

const setSharing = (on: boolean) =>
  browser.execute(async (v) => {
    const t = window.__termic!;
    const s = await t.ipc.settingsLoad();
    await t.ipc.settingsSave({ ...s, lan_sharing_enabled: v });
  }, on);

/** The after-pairing dialog, from one side. */
const dialog = (direction: string) => `[data-testid="peer-pair-dialog"][data-direction="${direction}"]`;

async function waitFor<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeout = 15_000): Promise<T> {
  let last: T | undefined;
  await browser.waitUntil(async () => ok((last = await read())), {
    timeout,
    timeoutMsg: `${what} (last: ${JSON.stringify(last)})`,
  });
  return last as T;
}

/** Set a native <select> the way React sees a user pick. */
const pick = (selector: string, value: string) =>
  browser.execute((sel, v) => {
    const el = document.querySelector(sel) as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector, value);

/** No fold mid-animation (ui/Expand.tsx marks one with these classes), so a
 *  screenshot shows where rows end up, not a frame of them moving. */
const foldsSettled = () => browser.waitUntil(
  () => browser.execute(() => !document.querySelector(".termic-expand-in, .termic-expand-out")),
  { timeout: 3_000, timeoutMsg: "a fold was still animating" },
);

describe("LAN pairing", () => {
  let appPort = 0;
  const incoming = newFake("Fake laptop");

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
  });

  after(async () => {
    // Leave the profile as it was: no pairs, the default name, sharing off.
    const s = await status().catch(() => null);
    for (const p of s?.peers ?? []) {
      await browser.execute((id) => window.__termic!.invoke("peer_unpair", { peer: id }), p.id).catch(() => {});
    }
    await browser.execute(() => window.__termic!.invoke("peer_set_name", { name: "" })).catch(() => {});
    await setSharing(false).catch(() => {});
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings()).catch(() => {});
  });

  it("opens Pair computers with sharing off and nothing listening", async () => {
    await setSharing(false);
    // Open the page FIRST, then turn MCP off behind it: the next case shows
    // sharing still turns MCP on when the page's own copy says it is on
    // (it once decided from that copy, and sharing came on with MCP off).
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("peers" as any));
    await waitForAttr('[data-testid="peers-toggle"]', "data-enabled", "false");
    await browser.execute(async () => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      await t.ipc.settingsSave({ ...s, mcp_enabled: true });
    });
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("peers" as any));
    await waitForAttr('[data-testid="peers-toggle"]', "data-enabled", "false");
    await browser.execute(async () => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      await t.ipc.settingsSave({ ...s, mcp_enabled: false });
    });
    await waitForAttr('[data-testid="peers-toggle"]', "data-enabled", "false");
    const s = await status();
    expect(s.enabled).toBe(false);
    expect(s.port).toBeNull();
    // The old "peers" tab lands on Remote, with phones and servers.
    await waitVisible('[data-testid="remote-section"]');
    expect(await browser.execute(() => document.querySelector('[data-rail-item="remote"]')!.className.includes("color-sel"))).toBe(true);
    // Off is off, and short: the card is its empty state, with no footer
    // and no pairing controls until Pair a computer is clicked.
    await waitVisible('[data-testid="peers-paired-empty"]');
    for (const gone of ["peers-address-input", "peers-self-name", "peers-self-address", "peers-nearby-empty", "peers-pair-dialog"]) {
      expect(await browser.execute((id) => !!document.querySelector(`[data-testid="${id}"]`), gone)).toBe(false);
    }
    expect(await browser.execute(() => {
      const r = document.querySelector('[data-testid="settings-peers"]')!.getBoundingClientRect();
      return r.height;
    })).toBeLessThan(200);
    await snap("peers-off.png");
  });

  it("turns sharing on from the toggle and answers hello on its port", async () => {
    await clickPresent('[data-testid="peers-toggle"] [role="switch"]');
    await waitForAttr('[data-testid="peers-toggle"]', "data-enabled", "true");
    // Sharing turns MCP on with it: agents reach a paired computer through
    // this Termic's MCP tools. Saved, bound, and drawn on, not just stored.
    // The switch flips before the save resolves: wait for the saved value.
    await browser.waitUntil(
      async () => (await browser.execute(async () => (await window.__termic!.ipc.settingsLoad()).mcp_enabled)) === true,
      { timeout: 5_000, timeoutMsg: "turning sharing on did not save MCP on" });
    await waitFor("MCP binds",
      async (): Promise<{ url: string | null }> => browser.execute(() => window.__termic!.invoke("mcp_status")) as never,
      v => !!v.url);
    await waitVisible('[data-testid="peers-agent-status"]');
    const s = await waitFor("the listener binds", status, v => v.port !== null);
    appPort = s.port;
    expect(s.addresses).toEqual([`127.0.0.1:${appPort}`]);
    const hello = await req(appPort, "GET", `${PREFIX}/hello`);
    expect(hello.status).toBe(200);
    const who = JSON.parse(hello.body);
    expect(Object.keys(who).sort()).toEqual(["id", "name", "port", "proto", "pv", "version"]);
    expect(who.id).toBe(s.self_id);
    // The page shows where it can be reached, with the port once.
    await browser.waitUntil(async () =>
      (await browser.execute(() => document.querySelector('[data-testid="peers-self-address"]')?.textContent ?? ""))
        .includes(`127.0.0.1:${appPort}`) , { timeoutMsg: "the address line never showed the bound address" });
    expect(await browser.execute(() => document.querySelector('[data-testid="peers-self-address"]')!.textContent))
      .not.toContain(`:${appPort}:`);
    await waitForAttr('[data-testid="peers-paired-empty"]', "data-testid", "peers-paired-empty");
    await browser.execute(() => document.querySelector('[data-testid="settings-peers"]')!.scrollIntoView({ block: "center" }));
    await snap("peers-on.png");
    // Nearby computers show only once the person asks to pair: a dialog.
    await clickPresent('[data-testid="peers-pair-open"]');
    await waitVisible('[data-testid="peers-nearby-empty"]');
    await snap("peers-pair-dialog.png");
    await browser.keys("Escape");
    await waitGone('[data-testid="peers-pair-dialog"]');
  });

  it("renames this machine, and the new name is what others see", async () => {
    await clickPresent('[data-testid="peers-self-edit"]');
    await setInputValue('[data-testid="peers-self-name"]', "E2E Studio");
    await browser.keys("Enter");
    await waitFor("the name is saved", status, v => v.self_name === "E2E Studio");
    expect(JSON.parse((await req(appPort, "GET", `${PREFIX}/hello`)).body).name).toBe("E2E Studio");
  });

  it("refuses a pairing request from a web page", async () => {
    const r = await new Promise<number>((resolve, reject) => {
      const q = http.request({
        host: "127.0.0.1", port: appPort, path: `${PREFIX}/pair/start`, method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example.io" },
      }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      q.on("error", reject);
      q.end("{}");
    });
    expect(r).toBe(403);
    expect((await status()).pair_mode).toBeNull();
  });

  let appId = "";
  let proto = 0;

  it("pairs with nobody while it is not in pairing mode", async () => {
    const p = await fakePairs(appPort, newFake("Stranger"), "1234");
    expect([p.start, JSON.parse(p.error).error]).toEqual([403, "not_pairing"]);
    expect((await status()).peers).toEqual([]);
    // Nothing on this screen either: no dialog for a request nobody invited.
    expect(await browser.execute(() => !!document.querySelector('[data-testid="peer-pair-dialog"]'))).toBe(false);
  });

  it("shows a code when the other machine clicks Pair, and pairs when it types it", async () => {
    // The other machine's person clicked Pair on this one: nothing was
    // opened here first, and the code pops up wherever the app is.
    expect((await fakeAsks(appPort, incoming)).status).toBe(200);
    await waitVisible('[data-testid="peer-code-dialog"]');
    expect(await browser.execute(() => document.querySelector('[data-testid="peer-code-dialog"]')!.getAttribute("data-peer"))).toBe(incoming.name);
    const code = await browser.execute(() => document.querySelector('[data-testid="peer-code-dialog"]')!.getAttribute("data-code")!);
    expect(code).toMatch(/^\d{4}$/);
    expect(await browser.execute(() => document.querySelector('[data-testid="peer-code"]')!.textContent)).toBe(code);
    expect((await status()).pair_mode.code).toBe(code);
    expect((await status()).pair_mode.requested_by).toBe(incoming.name);
    await snap("peers-code-dialog.png");

    const p = await fakePairs(appPort, incoming, code);
    expect([p.start, p.confirm]).toEqual([200, 200]);
    expect(p.grant).toBe("drive");
    appId = p.appId;
    proto = p.proto;
    incoming.key = p.key;
    // The code is spent: pairing mode closed on success, and its dialog
    // gave way to the "paired" one.
    await waitFor("pairing mode closed", status, v => v.pair_mode === null);
    await waitGone('[data-testid="peer-code-dialog"]');
    // The pairing goes both ways, the connection one way: the machine that
    // asked connects; here, where the code was shown, it starts switched off.
    // (The row's switch is off by default now; the row says it.)
    await waitForAttr(`[data-testid="remote-machine-${incoming.id}"]`, "data-state", "disconnected");

    // The after-pairing dialog: who, what pairing means, what it is for.
    await waitVisible(dialog("incoming"));
    await waitVisible('[data-testid="peer-pair-together"]');
    // It asks what to call the other computer HERE, starting from its own
    // name; a role fills that in too, without renaming the machine itself.
    expect(await browser.execute(() => (document.querySelector('[data-testid="peer-pair-alias"]') as HTMLInputElement).value)).toBe(incoming.name);
    await clickPresent('[data-testid="peer-pair-roles"] [data-role="worker"]');
    const note = await browser.execute(() => (document.querySelector('[data-testid="peer-pair-note"]') as HTMLInputElement).value);
    expect(note).toMatch(/^Worker: /);
    expect(await browser.execute(() => (document.querySelector('[data-testid="peer-pair-alias"]') as HTMLInputElement).value)).toBe("Worker");
    await snap("peers-paired-dialog.png");
    await clickPresent('[data-testid="peer-pair-done"]');
    await waitFor("the role is the note, and the name here", status,
      v => v.peers.some((x: any) => x.id === incoming.id && x.note === note && x.name === "Worker" && x.advertised_name === incoming.name));

    const row = `[data-testid="peer-row-${incoming.id}"]`;
    await waitForAttr(row, "data-grant", "drive");
    // One compact row: the role picked in the dialog shows on it, and the
    // rest is behind the chevron.
    expect(await browser.execute((id) => (document.querySelector(`[data-testid="peer-role-${id}"]`) as HTMLSelectElement).value, incoming.id)).toBe("worker");
    expect(await browser.execute((id) => !!document.querySelector(`[data-testid="peer-note-${id}"]`), incoming.id)).toBe(false);
    await clickPresent(`[data-testid="peer-expand-${incoming.id}"]`);
    await waitForAttr(`[data-testid="peer-their-grant-${incoming.id}"]`, "data-their-grant", "drive");
    await snap("peers-paired-list.png");
  });

  it("refuses a wrong code, counts it, and pairs nobody", async () => {
    const guesser = newFake("Guesser");
    expect((await fakeAsks(appPort, guesser)).status).toBe(200);
    const code = await waitFor("the code is up", status, v => !!v.pair_mode).then(v => v.pair_mode.code as string);
    const wrong = code === "0000" ? "0001" : "0000";
    const p = await fakePairs(appPort, guesser, wrong);
    expect([p.start, p.confirm, JSON.parse(p.error).error]).toEqual([200, 403, "wrong_code"]);
    expect((await status()).peers.map((x: any) => x.id)).toEqual([incoming.id]);
    await waitForText("Wrong codes: 1 of 3");
    // Decline closes it, and the code is dead.
    await clickPresent('[data-testid="peer-code-decline"]');
    await waitFor("pairing mode closed", status, v => v.pair_mode === null);
    await waitGone('[data-testid="peer-code-dialog"]');
    // The 2 s cooldown a wrong code starts applies to pairing starts only,
    // and nothing after this case starts one against the app.
  });

  it("runs a sealed call from a Drive peer and refuses it once the grant is Reply only", async () => {
    const list = await fakeCalls(appPort, incoming, appId, proto, { cmd: "list" });
    expect(list.refused).toBeNull();
    expect(list.reply.ok).toBe(true);
    expect(list.reply.data.kind).toBe("list");
    // The real dispatch answered (the profile may have no live tasks now).
    expect(Array.isArray(list.reply.data.tasks)).toBe(true);

    // Even Drive cannot quit the app.
    const quit = await fakeCalls(appPort, incoming, appId, proto, { cmd: "quit", commit: true });
    expect(quit.reply.error.code).toBe("auth");

    await pick(`[data-testid="peer-grant-${incoming.id}"]`, "reply");
    await waitForAttr(`[data-testid="peer-row-${incoming.id}"]`, "data-grant", "reply");
    const refused = await fakeCalls(appPort, incoming, appId, proto, { cmd: "list" });
    expect(refused.reply.ok).toBe(false);
    expect(refused.reply.error.code).toBe("auth");
    expect(refused.reply.error.message).toContain("reply");
  });

  it("refuses a replayed connection and a caller that is not paired, identically", async () => {
    // A recorded connection, replayed byte for byte: the app picks a fresh
    // salt every time, so the old hello no longer opens.
    const first = await fakeStream(appPort, incoming, appId, incoming.key!);
    first.close();
    await expect(fakeStream(appPort, incoming, appId, incoming.key!, { salt: first.salt, hello: first.hello }))
      .rejects.toThrow("closed 4001");
    // A stranger, and a known id with the wrong key: the same 4001.
    const stranger = newFake("Stranger");
    await expect(fakeStream(appPort, stranger, appId, crypto.randomBytes(32))).rejects.toThrow("closed 4001");
    await expect(fakeStream(appPort, incoming, appId, crypto.randomBytes(32))).rejects.toThrow("closed 4001");
  });

  it("renames a paired machine locally", async () => {
    const input = `[data-testid="peer-rename-${incoming.id}"]`;
    await setInputValue(input, "Build laptop");
    await browser.keys("Enter");
    const s = await waitFor("the alias is saved", status, v => v.peers.some((p: any) => p.name === "Build laptop"));
    const p = s.peers.find((x: any) => x.id === incoming.id);
    expect(p.advertised_name).toBe("Fake laptop");
    expect(p.alias).toBe("Build laptop");
  });

  it("keeps a note of what a paired machine is for, and the CLI's peer list carries it", async () => {
    const input = `[data-testid="peer-note-${incoming.id}"]`;
    if (!await browser.execute((sel) => !!document.querySelector(sel), input)) await clickPresent(`[data-testid="peer-expand-${incoming.id}"]`);
    await setInputValue(input, "  Windows builds and   installer tests ");
    await browser.keys("Enter");
    // Saved as one tidy line.
    await waitFor("the note is saved", status,
      v => v.peers.some((p: any) => p.id === incoming.id && p.note === "Windows builds and installer tests"));
    await snap("peers-note.png");
    // What an agent reads: `termic peer list` names it, so a prompt need not.
    const out = await cli(["--no-launch", "--json", "peer", "list"]);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    const listed = JSON.parse(out.stdout).peers.find((p: any) => p.id === incoming.id);
    expect(listed.note).toBe("Windows builds and installer tests");
    // Cleared, it is gone from the list rather than an empty string.
    await setInputValue(input, "");
    await browser.keys("Enter");
    await waitFor("the note is cleared", status, v => v.peers.some((p: any) => p.id === incoming.id && p.note === ""));
    const again = JSON.parse((await cli(["--no-launch", "--json", "peer", "list"])).stdout).peers.find((p: any) => p.id === incoming.id);
    expect(again.note).toBeUndefined();
  });

  it("unpairs from Settings after a confirmation, and the old key stops working", async () => {
    // A Radix menu opens on pointerdown, which a scripted click never sends.
    await browser.waitUntil(() => browser.execute((id) => {
      if (document.querySelector(`[data-testid="peer-unpair-${id}"]`)) return true;
      const el = document.querySelector(`[data-testid="peer-menu-${id}"]`) as HTMLElement;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as PointerEventInit;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      return !!document.querySelector(`[data-testid="peer-unpair-${id}"]`);
    }, incoming.id), { timeout: 10_000, timeoutMsg: "the paired computer's menu never opened" });
    await clickPresent(`[data-testid="peer-unpair-${incoming.id}"]`);
    await clickPresent('[data-testid="confirm-ok"]');
    await waitFor("the pair is gone", status, v => !v.peers.some((p: any) => p.id === incoming.id));
    await browser.waitUntil(
      () => browser.execute((id) => !document.querySelector(`[data-testid="peer-row-${id}"]`), incoming.id),
      { timeoutMsg: "the unpaired row is still drawn" },
    );
    const r = await fakeCalls(appPort, incoming, appId, proto, { cmd: "list" });
    expect(r.refused).toContain("closed 4001");
  });

  describe("pairing out, to a machine that answers", () => {
    const remote = newFake("Fake desktop");
    let server: http.Server;
    const remoteCode = "4821";
    const calls: any[] = [];
    let unpaired = false;

    before(async () => {
      // The fake as a SERVER: hello, the three pairing steps (it accepts with
      // Drive), and the two sealed endpoints. Its state is one pairing.
      let pending: { appId: string; key: Buffer } | null = null;
      server = http.createServer((q, res) => {
        let raw = "";
        q.on("data", d => (raw += d));
        q.on("end", () => {
          const send = (status: number, body: unknown = "") => {
            const out = typeof body === "string" ? body : JSON.stringify(body);
            res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(out) });
            res.end(out);
          };
          const who = { id: remote.id, name: remote.name, version: FAKE_VERSION, proto, pv: 2, port: remote.port };
          const body = raw ? JSON.parse(raw) : {};
          switch (q.url) {
            case `${PREFIX}/hello`: return send(200, who);
            // Asked to pair: the fake "shows" `remoteCode`.
            case `${PREFIX}/pair/request`: return send(200, { to: who, expires_at_ms: Date.now() + 300_000 });
            case `${PREFIX}/pair/start`: {
              // The fake is in pairing mode, showing `remoteCode`.
              const b = spake("B", remoteCode, body.from.id, remote.id);
              const secret = b.finish(Buffer.from(body.msg, "base64"));
              pending = { appId: body.from.id, key: pairKey(secret, body.from.id, remote.id) };
              return send(200, { to: who, pairing: "e2epairing0001", msg: b.msg.toString("base64") });
            }
            case `${PREFIX}/pair/confirm`: {
              const p = pending!;
              const path = `${PREFIX}/pair/confirm`;
              let msg: any;
              try { msg = open(p.key, path, remote.id, body.env); } catch { return send(403, { error: "wrong_code" }); }
              remote.key = p.key;
              return send(200, seal(p.key, path, remote.id, p.appId, { ...sealed({ grant: "drive" }), rid: msg.rid }));
            }
            case `${PREFIX}/unpair`: {
              const path = `${PREFIX}/unpair`;
              const msg = open(remote.key!, path, remote.id, body);
              unpaired = true;
              return send(200, seal(remote.key!, path, remote.id, pending!.appId, { ...sealed({}), rid: msg.rid }));
            }
            default: return send(404);
          }
        });
      });
      // `--peer` reaches it over the stream: a WebSocket on the same port.
      serveStream(server, remote, (request) => {
        calls.push(request);
        return request.cmd === "send" ? { ok: true, data: { kind: "send", task_id: request.task } } : { ok: true, data: { kind: "list", tasks: [] } };
      });
      await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
      remote.port = (server.address() as AddressInfo).port;
    });

    after(() => { server?.close(); });

    it("pairs by address with the code the other machine shows, and refuses a wrong one", async () => {
      await clickPresent('[data-testid="peers-pair-open"]');
      await waitVisible('[data-testid="peers-pair-dialog"]');
      // Pair is locked until a coding agent has Termic's MCP server. The
      // test machine may have neither, so take the "added it myself" way.
      if (await browser.execute(() => document.querySelector('[data-testid="peers-agent-setup"]')?.getAttribute("data-ready") === "false")) {
        await clickPresent('[data-testid="peers-agent-other"]');
      }
      // Folded behind a link: discovery is the normal way in.
      if (!await browser.execute(() => !!document.querySelector('[data-testid="peers-address-input"]'))) {
        await clickPresent('[data-testid="peers-address-toggle"]');
      }
      await setInputValue('[data-testid="peers-address-input"]', `127.0.0.1:${remote.port}`);
      // Pair asks the other machine to show its code, then asks for it here.
      await clickPresent('[data-testid="peers-address-request"]');
      await waitVisible('[data-testid="peers-address-code"]');
      await waitForText(`Type the code shown on ${remote.name}`);
      await snap("peers-address-code.png");
      // Four digits submit on their own.
      await setInputValue('[data-testid="peers-address-code"]', "1111");
      await waitForText(`That is not the code ${remote.name} shows`);
      expect((await status()).peers.some((x: any) => x.id === remote.id)).toBe(false);

      await setInputValue('[data-testid="peers-address-code"]', remoteCode);
      await waitVisible(dialog("outgoing"));
      await snap("peers-outgoing-dialog.png");
      await clickPresent('[data-testid="peer-pair-skip"]');
      // A successful pair closes the pair dialog.
      await waitGone('[data-testid="peers-pair-dialog"]');
      await clickPresent(`[data-testid="peer-expand-${remote.id}"]`);
      await waitForAttr(`[data-testid="peer-their-grant-${remote.id}"]`, "data-their-grant", "drive");
      // Paired computers work together: the app lets it drive here too.
      await waitForAttr(`[data-testid="peer-row-${remote.id}"]`, "data-grant", "drive");
    });

    it("forwards `termic --peer` to it, without this machine's paths", async () => {
      const out = await cli(["--no-launch", "--json", "--peer", "Fake desktop", "list"], {
        TERMIC_TASK_ID: "e2e-caller-task",
      });
      expect([out.code, out.stderr]).toEqual([0, ""]);
      expect(JSON.parse(out.stdout)).toEqual({ tasks: [] });
      expect(calls.filter(c => c.cmd === "list").length).toBe(1);
      expect(calls[0].cmd).toBe("list");
      // Neither the caller's cwd nor its task id are the other machine's
      // business; the task id stays on THIS side as a reply contact.
      expect(calls[0].cwd).toBeUndefined();
      expect(JSON.stringify(calls[0])).not.toContain("e2e-caller-task");
    });

    it("shows the paired computer's tasks in the sidebar", async () => {
      await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
      await waitVisible(`[data-testid="remote-machine-${remote.id}"]`, 20_000);
      await waitForAttr(`[data-testid="remote-machine-${remote.id}"]`, "data-state", "online");
      await waitVisible(`[data-testid="remote-task-${remoteTask.id}"]`);
      expect(await browser.execute(id => document.querySelector(`[data-testid="remote-task-${id}"]`)!.getAttribute("data-state"), remoteTask.id)).toBe("waiting");
      await snap("remote-sidebar.png");
    });

    it("files the paired computer's tasks as its own sidebar does: folder, group, pin, PR, labels", async () => {
      await waitVisible('[data-testid="remote-folder-Backend"]');
      const m = await browser.execute(() => {
        const q = (s: string) => document.querySelector(s);
        const folder = q('[data-testid="remote-folder-Backend"]')!;
        const group = q('[data-testid="remote-group-rt-2"]')!;
        const rail = group.querySelector(".border-l") as HTMLElement;
        // The palette's own teal, resolved the same way, to compare against.
        const probe = document.createElement("span");
        probe.style.color = "var(--color-palette-teal)";
        document.body.appendChild(probe);
        const teal = getComputedStyle(probe).color;
        probe.remove();
        const order = [...document.querySelectorAll('[data-testid^="remote-task-rt-"]')].map(e => e.getAttribute("data-testid"));
        const pinnedRow = q('[data-testid="remote-task-rt-3"]')!;
        return {
          folderColor: folder.getAttribute("data-color"),
          apiInFolder: !!folder.querySelector('[data-testid="remote-project-api"]'),
          webInFolder: !!folder.querySelector('[data-testid="remote-project-webapp"]'),
          groupColor: group.getAttribute("data-color"),
          groupText: group.textContent,
          members: [...group.querySelectorAll('[data-testid^="remote-task-"]')].map(e => e.getAttribute("data-testid")).filter(x => !x!.includes("props") && !x!.includes("pinned")),
          railIsTeal: getComputedStyle(rail).borderLeftColor === teal,
          order,
          pinned: !!pinnedRow.querySelector('[data-testid="remote-task-pinned"]'),
          prState: pinnedRow.querySelector('[data-testid="remote-pr-badge"]')?.getAttribute("data-pr-state"),
          prText: pinnedRow.querySelector('[data-testid="remote-pr-badge"]')?.textContent,
          props: pinnedRow.querySelector('[data-testid="remote-task-props"]')?.textContent,
          loosePinned: !!q('[data-testid="remote-task-rt-4"] [data-testid="remote-task-pinned"]'),
        };
      });
      expect(m.folderColor).toBe("purple");
      expect(m.apiInFolder).toBe(true);
      expect(m.webInFolder).toBe(false);
      expect(m.groupColor).toBe("teal");
      expect(m.groupText).toContain("Auth work");
      expect(m.members).toEqual(["remote-task-rt-2", "remote-task-rt-3"]);
      expect(m.railIsTeal).toBe(true);
      // The host's order: its first project, then the group gathered at its
      // lead's place, then the loose task that sits between them on disk.
      expect(m.order.filter(x => !x!.includes("props") && !x!.includes("pinned"))).toEqual(["remote-task-rt-1", "remote-task-rt-2", "remote-task-rt-3", "remote-task-rt-4"]);
      expect(m.pinned).toBe(true);
      expect(m.loosePinned).toBe(false);
      expect(m.prState).toBe("open");
      expect(m.prText).toContain("42");
      expect(m.props).toBe("ABC-1 · review");
      await snap("remote-sidebar-filed.png");
      // The sidebar's row settings reach a paired computer's rows too: the
      // PR badge's icon / number / none, and the branch name.
      const row = () => browser.execute(() => {
        const r = document.querySelector('[data-testid="remote-task-rt-3"]')!;
        const b = r.querySelector('[data-testid="remote-pr-badge"]');
        return { badge: !!b, icon: !!b?.querySelector("svg"), number: (b?.textContent ?? "").includes("42") };
      });
      const prefs = (f: string, v: string) => browser.execute((fn, val) => (window.__termic!.usePrefs.getState() as any)[fn](val), f, v);
      await prefs("setTaskPrBadge", "icon");
      await browser.waitUntil(async () => { const x = await row(); return x.icon && !x.number; }, { timeout: 3_000, timeoutMsg: "Icon only did not reach the remote row" });
      await prefs("setTaskPrBadge", "none");
      await browser.waitUntil(async () => !(await row()).badge, { timeout: 3_000, timeoutMsg: "None did not hide the remote PR badge" });
      await prefs("setTaskPrBadge", "number");
      await prefs("setTaskBranchName", "right");
      await browser.waitUntil(async () => !!(await browser.execute(() =>
        document.querySelector('[data-testid="remote-task-rt-1"] [data-testid="task-branch"]')?.getAttribute("data-branch") === "fix/login")),
      { timeout: 3_000, timeoutMsg: "the branch setting did not reach the remote row" });
      await prefs("setTaskBranchName", "none");
      // A paired computer's project folds like a local one.
      await browser.execute(() => (document.querySelector('[data-testid="remote-project-fold-webapp"]') as HTMLElement).click());
      await browser.waitUntil(async () => !(await browser.execute(() => !!document.querySelector('[data-testid="remote-task-rt-1"]'))),
        { timeout: 3_000, timeoutMsg: "folding the project did not hide its tasks" });
      await browser.execute(() => (document.querySelector('[data-testid="remote-project-fold-webapp"]') as HTMLElement).click());
      await waitVisible('[data-testid="remote-task-rt-1"]');
      // A task whose agent is not running reads as such: greyed, as a local
      // or server task's row is.
      const dimmed = (id: string) => browser.execute((x) => getComputedStyle(document.querySelector(`[data-testid="remote-task-${x}"]`)!).opacity, id);
      expect(Number(await dimmed("rt-3"))).toBe(1);
      pushTasks!(baseTasks().map((x: any) => x.id === "rt-3" ? { ...x, state: "inactive" } : x));
      await browser.waitUntil(async () => Number(await dimmed("rt-3")) < 1, { timeout: 3_000, timeoutMsg: "an inactive remote task was not greyed" });
      // An agent waiting on work it handed off (a subagent, a background
      // shell) draws the local row's ring, not the spinner: working or not,
      // no model is computing. Gone again once nothing is delegated.
      const badge = () => browser.execute(() => {
        const b = document.querySelector('[data-testid="remote-task-rt-3"] [data-testid="remote-work-badge"]');
        return b ? `${b.getAttribute("data-work-state")}:${b.getAttribute("data-delegated")}` : null;
      });
      const delegating = (state: string) => baseTasks().map((x: any) => x.id === "rt-3"
        ? { ...x, state, tabs: [{ id: "a", title: "claude", agent: "claude", state, is_default: true, kind: "agent", live: true, delegated: { label: "shell", count: 2, ids: ["s1", "s2"] } }] }
        : x);
      pushTasks!(delegating("working"));
      await browser.waitUntil(async () => (await badge()) === "working:shell", { timeout: 3_000, timeoutMsg: "a delegating working task drew no ring" });
      pushTasks!(delegating("idle"));
      await browser.waitUntil(async () => (await badge()) === "delegated:shell", { timeout: 3_000, timeoutMsg: "an idle task with shells running drew no ring" });
      pushTasks!(baseTasks());
      await browser.waitUntil(async () => (await badge()) === null, { timeout: 3_000, timeoutMsg: "the ring outlived its delegated work" });
    });

    it("lists other computers inline at the end of the project list, drawn by REMOTE's own display menu", async () => {
      const q = (sel: string) => browser.execute((x) => !!document.querySelector(x), sel);
      // Inline, in the same scroll as the projects and after them: local
      // work keeps the top, and remote rows scroll with it.
      expect(await browser.execute(() => {
        const sec = document.querySelector('[data-testid="remote-sidebar-section"]');
        const list = sec?.closest(".overflow-y-auto");
        const projects = list?.querySelectorAll("[data-project-wrap]") ?? [];
        const last = projects[projects.length - 1];
        return !!list && !!last && !!(last.compareDocumentPosition(sec!) & Node.DOCUMENT_POSITION_FOLLOWING);
      })).toBe(true);
      // Let a fold animation the previous case started finish first.
      await foldsSettled();
      await snap("remote-inline.png");
      // A minor release's update card floats over the end of the list, and
      // the list makes room under its last row for it, so nothing is stuck
      // behind the card.
      await browser.execute(() => window.__termic!.useUpdate.setState({ update: { version: "99.0.0", date: new Date().toISOString(), body: "" }, currentVersion: "2.0.0", dismissedVersion: null }));
      await waitVisible('[data-testid="update-card"]');
      await browser.waitUntil(() => browser.execute(() => {
        const card = document.querySelector('[data-testid="update-card"]')!.getBoundingClientRect().height;
        const list = document.querySelector('[data-testid="remote-sidebar-section"]')!.closest(".overflow-y-auto") as HTMLElement;
        return parseFloat(getComputedStyle(list).paddingBottom) >= card;
      }), { timeout: 3_000, timeoutMsg: "the list left no room under its end for the update card" });
      await snap("remote-inline-update.png");
      await browser.execute(() => window.__termic!.useUpdate.setState({ update: null }));
      await waitGone('[data-testid="update-card"]');
      // The connect switch is on the row by default.
      // Reset first: the options live in localStorage, which outlives a
      // reseed, so an earlier run's choices would otherwise carry in.
      await browser.execute(() => window.__termic!.usePrefs.getState().setRemoteDisplay({ newTask: "always", hideSwitch: false, counts: true, offline: "gather", inactiveAtBottom: true }));
      expect(await q(`[data-testid="machine-switch-${remote.id}"]`)).toBe(true);
      // Each project has its New task row under its tasks, as locally. The
      // option takes the row away; the headers' + (shown on hover) stay.
      expect(await q('[data-testid="remote-project-new-task-row-webapp"]')).toBe(true);
      await browser.execute(() => window.__termic!.usePrefs.getState().setRemoteDisplay({ newTask: "never" }));
      await browser.waitUntil(async () => !(await q('[data-testid="remote-project-new-task-row-webapp"]')), { timeout: 3_000, timeoutMsg: "turning the New task row off left it" });
      expect(await q(`[data-testid="remote-new-task-${remote.id}"]`)).toBe(true);
      expect(await q('[data-testid="remote-project-new-task-webapp"]')).toBe(true);
      await browser.execute(() => window.__termic!.usePrefs.getState().setRemoteDisplay({ newTask: "always" }));
      // The display menu itself.
      await browser.execute(() => {
        const el = document.querySelector('[data-testid="remote-display-menu"]') as HTMLElement;
        const o = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as PointerEventInit;
        el.dispatchEvent(new PointerEvent("pointerdown", o));
        el.dispatchEvent(new PointerEvent("pointerup", o));
      });
      await waitVisible('[data-testid="remote-display-counts"]');
      await snap("remote-display-menu.png");
      await browser.keys("Escape");
      // Folded, a computer says what it is doing: working and finished counts.
      await clickPresent(`[data-testid="remote-machine-${remote.id}"] [data-machine-head] button`);
      await browser.waitUntil(async () => q(`[data-testid="remote-machine-${remote.id}"] [data-testid="machine-counts"]`), { timeout: 3_000, timeoutMsg: "a folded computer showed no counts" });
      await foldsSettled();
      await snap("remote-inline-folded.png");
      await clickPresent(`[data-testid="remote-machine-${remote.id}"] [data-machine-head] button`);
      // A project whose agents are all stopped folds into the computer's own
      // Inactive projects.
      pushTasks!(baseTasks().map((x: any) => x.project === "webapp" ? { ...x, state: "inactive" } : x));
      await browser.waitUntil(async () => q(`[data-testid="remote-inactive-${remote.id}"]`), { timeout: 3_000, timeoutMsg: "no Inactive projects under the computer" });
      expect(await q('[data-testid="remote-project-webapp"]')).toBe(false);
      await clickPresent(`[data-testid="remote-inactive-${remote.id}"] button`);
      await waitVisible('[data-testid="remote-project-webapp"]');
      await foldsSettled();
      await snap("remote-inline-inactive.png");
      pushTasks!(baseTasks());
      await browser.waitUntil(async () => !(await q(`[data-testid="remote-inactive-${remote.id}"]`)), { timeout: 3_000, timeoutMsg: "the inactive fold outlived its projects" });
    });

    it("folds the paired computer's projects, groups and folders as its own sidebar has them", async () => {
      const expanded = (sel: string) => browser.execute((x) => document.querySelector(x)?.getAttribute("aria-expanded") ?? null, sel);
      const groupFold = '[data-testid="remote-group-rt-2"] > button';
      const withFolds = (p: boolean, g: boolean, f: boolean) => baseTasks().map((x: any) => x.project === "api"
        ? { ...x, project_collapsed: p, ...(x.group ? { group: { ...x.group, collapsed: g } } : {}), project_group: { ...x.project_group, collapsed: f } }
        : x);
      // The host folds the api project, its Auth group and the Backend folder: so does this view.
      pushTasks!(withFolds(false, true, false));
      await browser.waitUntil(async () => (await expanded(groupFold)) === "false", { timeout: 3_000, timeoutMsg: "the host's folded group showed open" });
      pushTasks!(withFolds(true, true, false));
      await browser.waitUntil(async () => (await expanded('[data-testid="remote-project-fold-api"]')) === "false", { timeout: 3_000, timeoutMsg: "the host's folded project showed open" });
      pushTasks!(withFolds(false, true, true));
      await browser.waitUntil(async () => (await expanded('[data-testid="remote-folder-fold-Backend"]')) === "false", { timeout: 3_000, timeoutMsg: "the host's folded folder showed open" });
      // Opened here: it stays open while the host keeps it folded...
      await browser.execute(() => (document.querySelector('[data-testid="remote-folder-fold-Backend"]') as HTMLElement).click());
      expect(await expanded('[data-testid="remote-folder-fold-Backend"]')).toBe("true");
      await browser.waitUntil(async () => (await expanded(groupFold)) === "false", { timeout: 3_000, timeoutMsg: "the group under the opened folder lost the host's fold" });
      pushTasks!(withFolds(false, true, true));
      // Negative: the host re-sending a fold it did not change must NOT undo
      // the one opened here, and nothing fires for a fold that stays; 300 ms
      // outlasts the task-list push and its render.
      await browser.pause(300);
      expect(await expanded('[data-testid="remote-folder-fold-Backend"]')).toBe("true");
      // ...and once the host changes that fold, the host's state wins again.
      pushTasks!(withFolds(false, false, false));
      await browser.waitUntil(async () => (await expanded(groupFold)) === "true" && (await expanded('[data-testid="remote-folder-fold-Backend"]')) === "true", { timeout: 3_000, timeoutMsg: "the host opening its folds did not open them here" });
      pushTasks!(withFolds(false, false, true));
      await browser.waitUntil(async () => (await expanded('[data-testid="remote-folder-fold-Backend"]')) === "false", { timeout: 3_000, timeoutMsg: "the host folding its folder again was ignored" });
      pushTasks!(baseTasks());
      await browser.waitUntil(async () => (await expanded('[data-testid="remote-folder-fold-Backend"]')) === "true", { timeout: 3_000, timeoutMsg: "the folder did not reopen with the host" });
    });

    it("rings the desktop when a paired computer's task starts needing you, and when it finishes", async () => {
      await browser.execute(() => window.__termic!.usePrefs.setState({ desktopNotifications: true }));
      const alerts = () => browser.execute(() => (window.__termic!.useRemote.getState().alerts as any[]).map(a => [a.task, a.kind, a.question ?? null, a.machineName]));
      const before = (await alerts()).length;
      const withLead = (patch: Record<string, unknown>) => baseTasks().map(t => t.id === "rt-2" ? { ...t, ...patch } : t);
      expect(pushTasks).not.toBeNull();
      pushTasks!(withLead({ state: "waiting", question: { id: "q9", kind: "command", title: "Run npm test?", body: "npm test", options: [] } }));
      await browser.waitUntil(async () => (await alerts()).length > before, { timeout: 5000, timeoutMsg: "no alert for the task that started waiting" });
      pushTasks!(withLead({ state: "working" }));
      await browser.waitUntil(async () => (await browser.execute(() => document.querySelector('[data-testid="remote-task-rt-2"]')?.getAttribute("data-state"))) === "working", { timeout: 5000 });
      pushTasks!(withLead({ state: "done" }));
      await browser.waitUntil(async () => (await alerts()).length >= before + 2, { timeout: 5000, timeoutMsg: "no alert for the task that finished" });
      expect((await alerts()).slice(before)).toEqual([
        ["rt-2", "waiting", "Run npm test?", remote.name],
        ["rt-2", "done", null, remote.name],
      ]);
      // Back to where the next cases expect it; a return to working is no news.
      pushTasks!(baseTasks());
      await browser.waitUntil(async () => (await browser.execute(() => document.querySelector('[data-testid="remote-task-rt-2"]')?.getAttribute("data-state"))) === "working", { timeout: 5000 });
      expect((await alerts()).length).toBe(before + 2);
    });

    it("renames, pins and regroups a paired computer's task from its row, through that machine's own verbs", async () => {
      const menu = async (id: string) => {
        await browser.execute((sel) => {
          const row = document.querySelector(sel)!;
          const r = row.getBoundingClientRect();
          row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5, button: 2 }));
        }, `[data-testid="remote-task-${id}"]`);
        await browser.waitUntil(() => browser.execute(() => document.querySelectorAll("[role='menuitem']").length > 0), { timeout: 5000, timeoutMsg: "no menu" });
      };
      // A keydown in the page, not browser.keys: the latter needs the window
      // to be the key window, which a local run often is not.
      const press = (sel: string, key: string) => browser.execute((q, k) => {
        document.querySelector(q)!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      }, sel, key);
      const sent = (from: number) => calls.slice(from).map(c => { const { id: _id, ...rest } = c; return rest; });
      const waitSent = async (from: number, want: Record<string, unknown>) => {
        await browser.waitUntil(async () => sent(from).some(c => JSON.stringify(c) === JSON.stringify(want)), { timeout: 5000, timeoutMsg: `never sent ${JSON.stringify(want)}; sent ${JSON.stringify(sent(from))}` });
      };

      let mark = calls.length;
      await menu("rt-3");
      await clickMenuItem("Unpin");
      await waitSent(mark, { cmd: "pin", task: "rt-3", pinned: false });

      mark = calls.length;
      await menu("rt-4");
      await clickMenuItem("Move to group");
      await browser.waitUntil(() => browser.execute(() => [...document.querySelectorAll("[role='menuitem']")].some(e => e.textContent?.trim() === "Auth work")), { timeout: 5000, timeoutMsg: "the group list never opened" });
      await snap("remote-task-menu.png");
      await clickMenuItem("Auth work");
      await waitSent(mark, { cmd: "group", task: "rt-4", join: "rt-2" });

      // A new group takes the first colour no group in that project uses.
      mark = calls.length;
      await menu("rt-4");
      await clickMenuItem("Move to group");
      await browser.waitUntil(() => browser.execute(() => [...document.querySelectorAll("[role='menuitem']")].some(e => e.textContent?.trim() === "New group")), { timeout: 5000, timeoutMsg: "no New group" });
      await clickMenuItem("New group");
      await waitSent(mark, { cmd: "group", task: "rt-4", color: "red" });

      mark = calls.length;
      await menu("rt-3");
      await clickMenuItem("Remove from group");
      await waitSent(mark, { cmd: "group", task: "rt-3", leave: true });

      // Rename edits in place: Enter sends it, Escape sends nothing.
      mark = calls.length;
      await menu("rt-4");
      await clickMenuItem("Rename");
      await waitVisible('[data-testid="remote-task-rename-rt-4"]');
      await setInputValue('[data-testid="remote-task-rename-rt-4"]', "loose-two");
      await press('[data-testid="remote-task-rename-rt-4"]', "Enter");
      await waitSent(mark, { cmd: "rename", task: "rt-4", name: "loose-two" });
      mark = calls.length;
      await menu("rt-4");
      await clickMenuItem("Rename");
      await waitVisible('[data-testid="remote-task-rename-rt-4"]');
      await press('[data-testid="remote-task-rename-rt-4"]', "Escape");
      await waitGone('[data-testid="remote-task-rename-rt-4"]');
      expect(sent(mark).filter(c => c.cmd === "rename")).toEqual([]);

      // A group's right-click is the local group's menu, run on that machine
      // through its group verb on a member: colour, then ungroup (every
      // member leaves). No default swatch: that verb cannot clear a colour.
      const groupMenu = async () => {
        await browser.execute((sel) => {
          const head = document.querySelector(sel)!;
          const r = head.getBoundingClientRect();
          head.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5, button: 2 }));
        }, '[data-testid="remote-group-rt-2"] > button');
        await browser.waitUntil(() => browser.execute(() => document.querySelectorAll("[role='menuitem']").length > 0), { timeout: 5000, timeoutMsg: "no group menu" });
      };
      await groupMenu();
      expect(await browser.execute(() => !!document.querySelector("[role='menuitemradio'][aria-label='Default']"))).toBe(false);
      mark = calls.length;
      await browser.execute(() => (document.querySelector("[role='menuitemradio'][aria-label='Blue']") as HTMLElement).click());
      await browser.waitUntil(async () => sent(mark).some(c => c.cmd === "group" && c.color === "blue"), { timeout: 5000, timeoutMsg: `the colour never went: ${JSON.stringify(sent(mark))}` });
      mark = calls.length;
      await groupMenu();
      await clickMenuItem("Ungroup tasks");
      await browser.waitUntil(async () => sent(mark).filter(c => c.cmd === "group" && c.leave === true).length >= 1, { timeout: 5000, timeoutMsg: `nobody left: ${JSON.stringify(sent(mark))}` });

      // A new tab in the task there: the agent it already runs, by default.
      mark = calls.length;
      await menu("rt-4");
      await clickMenuItem("New tab");
      await browser.waitUntil(() => browser.execute(() => [...document.querySelectorAll("[role='menuitem']")].some(e => e.textContent?.trim() === "Same agent")), { timeout: 5000, timeoutMsg: "no Same agent" });
      await clickMenuItem("Same agent");
      await waitSent(mark, { cmd: "tab", task: "rt-4", kind: { tab: "default" } });

      // Restart agent only on a stopped task: it reopens it in its last session.
      pushTasks!(baseTasks().map((x: any) => x.id === "rt-3" ? { ...x, state: "inactive" } : x));
      await waitForAttr('[data-testid="remote-task-rt-3"]', "data-state", "inactive");
      mark = calls.length;
      await menu("rt-3");
      await clickMenuItem("Restart agent");
      await waitSent(mark, { cmd: "open", task: "rt-3" });
      pushTasks!(baseTasks());
      await waitForAttr('[data-testid="remote-task-rt-3"]', "data-state", "idle");

      // Duplicate opens New task on that computer, from this task's branch.
      await menu("rt-1");
      await clickMenuItem("Duplicate worktree");
      await waitVisible('[data-testid="remote-new-base"]');
      expect(await browser.execute(() => document.querySelector('[data-testid="remote-new-base"]')!.textContent)).toContain("fix/login");
      await browser.keys("Escape");
      await waitGone('[data-testid="remote-new-base"]');

      // The computer's own + opens New task on its projects, not on "add a
      // project": the path field is for a server, where a project is a path.
      await clickPresent(`[data-testid="remote-new-task-${remote.id}"]`);
      await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="remote-new-project"], [data-testid="remote-add-project"]')), { timeout: 5000, timeoutMsg: "New task did not open" });
      expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-project-path"]'))).toBe(false);
      await browser.keys("Escape");
      await browser.waitUntil(() => browser.execute(() => !document.querySelector('[data-testid="remote-add-project"], [data-testid="remote-new-project"]')), { timeout: 5000, timeoutMsg: "New task did not close" });
      // Each project row has its own +, the local project header's: New task
      // there, in that project.
      mark = calls.length;
      await clickPresent('[data-testid="remote-project-new-task-webapp"]');
      await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="remote-new-project"], [data-testid="remote-add-project"]')), { timeout: 5000, timeoutMsg: "the project's New task did not open" });
      expect(await browser.execute(() => !!document.querySelector('[data-testid="remote-project-path"]'))).toBe(false);
      await browser.waitUntil(async () => sent(mark).some(c => c.cmd === "project_list"), { timeout: 5000, timeoutMsg: "the dialog never asked for the projects" });
      await browser.keys("Escape");
      await browser.waitUntil(() => browser.execute(() => !document.querySelector('[data-testid="remote-add-project"], [data-testid="remote-new-project"]')), { timeout: 5000, timeoutMsg: "New task did not close" });

      // The local row's Stop and Archive, run on that machine. Stop only
      // while its agent runs; Archive asks first, and a cancel sends nothing.
      mark = calls.length;
      await menu("rt-2");
      await clickMenuItem("Stop task");
      await waitSent(mark, { cmd: "stop", task: "rt-2" });
      mark = calls.length;
      await menu("rt-2");
      await clickMenuItem("Archive task");
      await clickPresent('[data-testid="confirm-cancel"]');
      await waitGone('[data-testid="confirm-cancel"]');
      expect(sent(mark).filter(c => c.cmd === "archive")).toEqual([]);
    });

    it("shows only the host profiles ticked in the computer's menu", async () => {
      await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
      const work = { id: "work", name: "Work", accent: "#d97757" };
      const home = { id: "home", name: "Home", accent: "#5e9ed6" };
      const tasks = baseTasks().map((t, i) => ({ ...t, profile: i % 2 ? home : work }));
      const homeIds = tasks.filter(t => t.profile === home).map(t => t.id);
      const workIds = tasks.filter(t => t.profile === work).map(t => t.id);
      pushTasks!(tasks);
      await waitVisible(`[data-testid="remote-task-${homeIds[0]}"]`);
      const openMenu = () => browser.waitUntil(() => browser.execute((id) => {
        if (document.querySelector('[data-testid="machine-menu-profile-home"]')) return true;
        const el = document.querySelector(`[data-testid="server-menu-${id}"]`) as HTMLElement | null;
        if (!el) return false;
        const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as PointerEventInit;
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        return !!document.querySelector('[data-testid="machine-menu-profile-home"]');
      }, remote.id), { timeout: 10_000, timeoutMsg: "the computer's menu never opened" });
      const ticked = (p: string) => browser.execute((q) => document.querySelector(`[data-testid="machine-menu-profile-${q}"] [data-checked]`)?.getAttribute("data-checked"), p);

      // The rows were already there (same ids): wait for the profiles.
      await browser.waitUntil(() => browser.execute((id) =>
        !!window.__termic!.useRemote.getState().machines.find((x: { id: string }) => x.id === id)?.tasks.some((t: { profile?: unknown }) => t.profile), remote.id),
        { timeout: 5000, timeoutMsg: "the tasks never arrived with their profiles" });
      // Both ticked at first; unticking Home hides its tasks and keeps Work's.
      await openMenu();
      expect([await ticked("work"), await ticked("home")]).toEqual(["true", "true"]);
      await snap("remote-profile-menu.png");
      await clickPresent('[data-testid="machine-menu-profile-home"]');
      await waitGone(`[data-testid="remote-task-${homeIds[0]}"]`);
      await waitVisible(`[data-testid="remote-task-${workIds[0]}"]`);

      // A hidden profile stays in the list, unticked, so it can come back.
      await openMenu();
      expect(await ticked("home")).toBe("false");
      await clickPresent('[data-testid="machine-menu-profile-home"]');
      await waitVisible(`[data-testid="remote-task-${homeIds[0]}"]`);
      pushTasks!(baseTasks());
    });

    it("opens a remote task as its terminal, focused, and says where it runs", async () => {
      await clickPresent(`[data-testid="remote-task-${remoteTask.id}"]`);
      await waitVisible('[data-testid="remote-task-view"]');
      const where = await browser.execute(() => document.querySelector('[data-testid="remote-task-location"]')!.textContent);
      expect(where).toContain(remote.name);
      // The terminal received the other machine's backlog, at its size.
      // Asserted on the event, not on painted rows: xterm paints nothing in
      // the local e2e window (it does in CI), so rows would read empty here.
      // (The claim's term_resize may land right behind the reset, so wait
      // for the open and a size rather than for the reset to be last.)
      await waitForAttr('[data-testid="remote-terminal"]', "data-opened", "true");
      // Drawn like a local terminal: the same renderer (WebGL joins the box
      // glyphs of an agent's tables; the DOM renderer left gaps between rows).
      // Compared with a local pane in this window, as WebGL may be off here.
      const renderers = await browser.execute(() => {
        const canvas = (el: Element | null) => !!el?.querySelector(".xterm-screen canvas");
        const local = document.querySelector("[data-terminal-host]");
        return { local: local ? canvas(local) : null, remote: canvas(document.querySelector('[data-testid="remote-terminal"]')) };
      });
      if (renderers.local !== null) expect(renderers.remote).toBe(renderers.local);
      else expect(renderers.remote).toBe(true);
      // An OSC 52 copy from the other machine (what Claude sends for a
      // selection) lands on THIS clipboard. Claude also runs pbcopy, but on
      // the machine it runs on, so over a pairing OSC 52 is the only way.
      const copied = `copied over the pair ${Date.now()}`;
      hostSend({ t: "term_data", data: Buffer.from(`\x1b]52;c;${Buffer.from(copied).toString("base64")}\x07`).toString("base64") });
      await browser.waitUntil(async () => readClipboard() === copied, { timeout: 5000, timeoutMsg: `the OSC 52 copy never reached the clipboard (it has ${JSON.stringify(readClipboard().slice(0, 60))})` });
      await browser.waitUntil(async () => !!(await browser.execute(() => document.querySelector('[data-testid="remote-terminal"]')!.getAttribute("data-size"))),
        { timeout: 5_000, timeoutMsg: "the backlog never arrived" });
      // The last screen to take it owns the size. Opening it is taking it:
      // this pane claims its size, with no overlay.
      const view = () => browser.execute(() => {
        const h = document.querySelector('[data-testid="remote-terminal"]') as HTMLElement;
        const x = h.querySelector(".xterm") as HTMLElement;
        return { owner: h.dataset.owner, hidden: x.style.display === "none", overlay: !!document.querySelector('[data-testid="terminal-elsewhere"]'), size: h.dataset.size };
      });
      await browser.waitUntil(async () => hostSaw.some(m => m.t === "term_size"), { timeout: 5_000, timeoutMsg: "opening it never claimed the size" });
      await browser.waitUntil(async () => (await view()).owner === "true", { timeout: 5_000, timeoutMsg: "the claimed size never applied" });
      expect((await view()).overlay).toBe(false);
      // The other machine takes it back: this pane hides behind the overlay
      // without asking again, and a click elsewhere does not take it.
      const asked = hostSaw.filter(m => m.t === "term_size").length;
      hostSend({ t: "term_resize", cols: 200, rows: 60 });
      await browser.waitUntil(async () => { const v = await view(); return v.owner === "false" && v.size === "200x60" && v.hidden && v.overlay; },
        { timeout: 5_000, timeoutMsg: "the host taking the size back did not raise the overlay" });
      await browser.execute(() => document.querySelector('[data-testid="remote-terminal"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
      // Negative: a click must NOT claim the size, and nothing fires for a
      // term_size that is never sent; 300 ms outlasts the rAF + IPC it took.
      await browser.pause(300);
      expect(hostSaw.filter(m => m.t === "term_size").length).toBe(asked);
      await snap("remote-terminal-elsewhere.png");
      // Continue here takes it again.
      await clickPresent('[data-testid="terminal-continue-here"]');
      await browser.waitUntil(async () => { const v = await view(); return v.owner === "true" && !v.hidden && !v.overlay; }, { timeout: 5_000, timeoutMsg: "Continue here did not take the size back" });
      // Picking the task in the sidebar takes it back too: having clicked it
      // here is the "use it here", so there is no overlay left to click.
      hostSend({ t: "term_resize", cols: 200, rows: 60 });
      await browser.waitUntil(async () => (await view()).overlay, { timeout: 5_000, timeoutMsg: "the host taking the size again did not raise the overlay" });
      await clickPresent(`[data-testid="remote-task-${remoteTask.id}"]`);
      await browser.waitUntil(async () => { const v = await view(); return v.owner === "true" && !v.hidden && !v.overlay; }, { timeout: 5_000, timeoutMsg: "picking the task in the sidebar did not take the size back" });
      // The terminal and nothing else: the phone's card, transcript and
      // composer stand in for a keyboard, and this window has one.
      const extras = await browser.execute(() =>
        ["remote-question", "remote-tab-transcript", "remote-transcript", "remote-composer"].filter(id => document.querySelector(`[data-testid="${id}"]`)));
      expect(extras).toEqual([]);
      // Focused on open, so typing goes straight to the other machine.
      const focused = await browser.execute(() =>
        !!document.activeElement?.closest('[data-testid="remote-terminal"]'));
      expect(focused).toBe(true);
      await snap("remote-task-view.png");
    });

    it("answers the remote agent's question by typing into its terminal", async () => {
      const before = hostSaw.length;
      await typeIntoRemoteTerminal("\r");
      await browser.waitUntil(async () => hostSaw.slice(before).some(m => m.t === "term_input"), { timeoutMsg: "the keystroke never reached the other machine" });
      const k = hostSaw.slice(before).find(m => m.t === "term_input");
      expect(Buffer.from(k.data, "base64").toString()).toBe("\r");
      // Raw keys, not the phone's bound answer: no `keys` message went out.
      expect(hostSaw.slice(before).some(m => m.t === "keys")).toBe(false);
      await clickPresent('[data-testid="remote-task-close"]');
      await waitGone('[data-testid="remote-task-view"]');
      // Back to where the cases after this one work.
      await browser.execute(() => window.__termic!.useApp.getState().openSettings("remote"));
      await waitVisible('[data-testid="peers-section"]');
    });

    it("clicking the local task that was active underneath leaves the remote one", async () => {
      await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
      // A local task, active underneath (the seeded fixture repo's checkout).
      const local = await openTask("peers-local");
      await waitVisible(`[data-sidebar-task-id="${local}"]`);
      expect(local).toBeTruthy();
      await clickPresent(`[data-testid="remote-task-${remoteTask.id}"]`);
      await waitVisible('[data-testid="remote-task-view"]');
      // The same task, so the active task does not change: the click alone
      // must close the remote view (it used to need a different task).
      await clickPresent(`[data-sidebar-task-id="${local}"]`);
      await waitGone('[data-testid="remote-task-view"]');
      await browser.execute(() => window.__termic!.useApp.getState().openSettings("remote"));
      await waitVisible('[data-testid="peers-section"]');
    });

    it("switches between the remote task's tabs; a shell or a stopped tab cannot be opened", async () => {
      await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
      await clickPresent(`[data-testid="remote-task-${remoteTask.id}"]`);
      await waitVisible('[data-testid="remote-tabs"]');
      const strip = await browser.execute(() => [...document.querySelectorAll('[data-testid^="remote-tab-t-"]')].map(b => ({
        id: b.getAttribute("data-testid"), kind: b.getAttribute("data-kind"), selected: b.getAttribute("aria-selected"), disabled: (b as HTMLButtonElement).disabled,
      })));
      expect(strip).toEqual([
        { id: "remote-tab-t-agent", kind: "agent", selected: "true", disabled: false },
        { id: "remote-tab-t-run", kind: "run", selected: "false", disabled: false },
        { id: "remote-tab-t-shell", kind: "shell", selected: "false", disabled: true },
        { id: "remote-tab-t-codex", kind: "agent", selected: "false", disabled: true },
      ]);
      expect(await browser.execute(() => document.querySelector('[data-testid="remote-tab-t-shell"]')!.getAttribute("title"))).toBe("Opens only on that computer");
      // It opened the default agent tab, by its id.
      await browser.waitUntil(async () => hostSaw.some(m => m.t === "term_open" && m.tab === "t-agent"), { timeoutMsg: "the agent tab was not the one opened" });
      const before = hostSaw.length;
      await clickPresent('[data-testid="remote-tab-t-run"]');
      await browser.waitUntil(async () => hostSaw.slice(before).some(m => m.t === "term_open" && m.tab === "t-run"), { timeoutMsg: "the run tab never opened" });
      expect(await browser.execute(() => document.querySelector('[data-testid="remote-tab-t-run"]')!.getAttribute("aria-selected"))).toBe("true");
      expect(hostSaw.some(m => m.t === "term_open" && m.tab === "t-shell")).toBe(false);
      // Typing now goes to the run tab's terminal.
      const mark = hostSaw.length;
      await typeIntoRemoteTerminal("ls\r");
      await browser.waitUntil(async () => hostSaw.slice(mark).some(m => m.t === "term_input"), { timeoutMsg: "keys never reached the run tab" });
      await snap("remote-task-tabs.png");
      await clickPresent('[data-testid="remote-task-close"]');
      await waitGone('[data-testid="remote-task-view"]');
      await browser.execute(() => window.__termic!.useApp.getState().openSettings("remote"));
      await waitVisible('[data-testid="peers-section"]');
    });

    it("names an unknown machine instead of guessing", async () => {
      const out = await cli(["--no-launch", "--peer", "nobody-by-that-name", "list"]);
      expect(out.code).toBe(1);
      const message = out.stderr;
      expect(message).toContain("no paired machine called nobody-by-that-name");
      expect(message).toContain("Fake desktop");
    });

    it("exits 12 when the paired machine does not answer", async () => {
      server.closeAllConnections?.();
      const closed = new Promise(r => server.once("close", r));
      server.close();
      server.emit("close");
      await closed;
      const out = await cli(["--no-launch", "--peer", "Fake desktop", "list"]);
      expect(out.code).toBe(12);
      expect(out.stderr).toContain("Could not reach Fake desktop");
      // Back up for the unpair notice, on the same port.
      await new Promise<void>(r => server.listen(remote.port, "127.0.0.1", () => r()));
    });

    it("unpairs from the computer's sidebar menu, and tells the other machine", async () => {
      // The same menu as a server's, with Unpair where a server has Remove.
      await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
      await browser.waitUntil(() => browser.execute((id) => {
        if (document.querySelector('[data-testid="machine-menu-unpair"]')) return true;
        const el = document.querySelector(`[data-testid="server-menu-${id}"]`) as HTMLElement | null;
        if (!el) return false;
        const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as PointerEventInit;
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        return !!document.querySelector('[data-testid="machine-menu-unpair"]');
      }, remote.id), { timeout: 10_000, timeoutMsg: "the computer's menu never opened" });
      expect(await browser.execute(() => !!document.querySelector('[data-testid="server-menu-remove"]'))).toBe(false);
      await snap("peers-sidebar-menu.png");
      await clickPresent('[data-testid="machine-menu-unpair"]');
      await clickPresent('[data-testid="confirm-ok"]');
      await waitFor("the pair is gone", status, v => !v.peers.some((p: any) => p.id === remote.id));
      await browser.waitUntil(async () => unpaired, { timeoutMsg: "the fake never received the unpair notice" });
      await browser.execute(() => window.__termic!.useApp.getState().openSettings("remote"));
      await waitVisible('[data-testid="peers-section"]');
    });
  });

  // Last, in its own block: mocha runs nested describes AFTER the outer its.
  describe("switching off", () => {
    it("stops listening when sharing is turned off", async () => {
      const me = (await status()).self_id;
      await clickPresent('[data-testid="peers-toggle"] [role="switch"]');
      await waitForAttr('[data-testid="peers-toggle"]', "data-enabled", "false");
      await waitFor("the listener is gone", status, v => v.port === null);
      // Nothing of THIS app answers. Another Termic on the machine sharing
      // on the same port (a wildcard bind) may: that is not this one.
      const got = await req(appPort, "GET", `${PREFIX}/hello`).then(
        r => r.status === 200 && JSON.parse(r.body).id === me ? "this app answered" : "not this app",
        () => "not this app",
      );
      expect(got).toBe("not this app");
    });
  });
});
