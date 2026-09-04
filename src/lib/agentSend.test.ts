import { describe, it, expect, vi, beforeEach } from "vitest";

// The PTY is the unit under test's whole world: what we wrote, and what came
// back. Both halves are faked so the echo decision can be driven exactly.
const writes: number[][] = [];
let dataCb: ((d: Uint8Array) => void) | undefined;
const unlisten = vi.fn();

vi.mock("@/lib/ipc", () => ({
  ptyWrite: (_id: string, bytes: number[]) => { writes.push(bytes); return Promise.resolve(); },
  onPtyData: (_id: string, cb: (d: Uint8Array) => void) => { dataCb = cb; return Promise.resolve(unlisten); },
}));

const { deliverMessage } = await import("@/lib/agentSend");

const CR = 0x0d;
const text = (b: number[]) => new TextDecoder().decode(new Uint8Array(b));
/** Did we submit? The CR is written on its own, after the text. */
const submitted = () => writes.some(w => w.length === 1 && w[0] === CR);
const echo = (s: string) => dataCb?.(new TextEncoder().encode(s));

beforeEach(() => { writes.length = 0; dataCb = undefined; unlisten.mockClear(); });

describe("deliverMessage", () => {
  // The bug: bytes go to the PTY as typed, so a `\n` inside the text is an
  // Enter to the agent's TUI. An eight-line prompt was eight submits, seven of
  // them fragments, and only the trailing line survived as the message.
  it("sends a multi-line body as ONE bracketed paste, not as N submits", async () => {
    const body = "line one\nline two\nline three";
    const p = deliverMessage("pty-1", body);
    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const sent = text(writes[0]);
    expect(sent).toBe(`\x1b[200~${body}\x1b[201~`);
    // Every newline is still IN there: the point is that the terminal now
    // reads them as literal, not that we stripped them.
    expect(sent.split("\n")).toHaveLength(3);
    await p;
  });

  // The submit has to land OUTSIDE the paste markers, or it is literal text
  // inside the pasted body and nothing is ever sent.
  it("writes the submit CR after the paste ends, never inside it", async () => {
    const p = deliverMessage("pty-1", "a\nb");
    await p;
    expect(text(writes[0]).endsWith("\x1b[201~")).toBe(true);
    expect(submitted()).toBe(true);
    const crIndex = writes.findIndex(w => w.length === 1 && w[0] === CR);
    expect(crIndex).toBeGreaterThan(0);
  });

  // The common path must be byte-for-byte what it was, so a single-line send
  // cannot regress on an agent whose paste mode is off.
  it("leaves a single-line message completely unwrapped", async () => {
    const p = deliverMessage("pty-1", "fix the login bug");
    await p;
    expect(text(writes[0])).toBe("fix the login bug");
    expect(text(writes[0])).not.toContain("\x1b[200~");
  });


  it("measures the submit gap from when the TEXT write lands, not before it", async () => {
    // Regression. Timing the gap from before `ptyWrite` resolves spends part
    // of it on the IPC round trip, so the real gap shrinks by however slow
    // the machine is - which is precisely when a CR coalesced into the text
    // burst gets swallowed as a paste continuation.
    vi.resetModules();
    let resolveWrite: (() => void) | undefined;
    const slowWrites: number[][] = [];
    vi.doMock("@/lib/ipc", () => ({
      ptyWrite: (_i: string, b: number[]) => {
        slowWrites.push(b);
        // Only the TEXT write is slow; the CR resolves at once.
        return b.length === 1
          ? Promise.resolve()
          : new Promise<void>(r => { resolveWrite = r; });
      },
      onPtyData: () => Promise.resolve(() => {}),
    }));
    const { deliverMessage: dm } = await import("@/lib/agentSend");
    vi.useFakeTimers();
    try {
      const p = dm("pty-1", "hello");
      await vi.advanceTimersByTimeAsync(300);   // a slow round trip
      resolveWrite!();
      await vi.advanceTimersByTimeAsync(0);
      // 300ms already elapsed, but none of it counts: the gap starts now.
      await vi.advanceTimersByTimeAsync(400);
      expect(slowWrites.some(w => w.length === 1 && w[0] === CR)).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      await p;
      expect(slowWrites.some(w => w.length === 1 && w[0] === CR)).toBe(true);
    } finally { vi.useRealTimers(); vi.doUnmock("@/lib/ipc"); }
  });

  it("submits without asking anything when echo verification is off", async () => {
    // The queue's path, unchanged: it only ever sends after a turn ended,
    // which already proves the agent was at its input box.
    vi.useFakeTimers();
    try {
      const p = deliverMessage("pty-1", "hello");
      await vi.advanceTimersByTimeAsync(2000);
      await p;
      expect(text(writes[0])).toBe("hello");
      expect(submitted()).toBe(true);
      expect(dataCb).toBeUndefined();   // never even listened
    } finally { vi.useRealTimers(); }
  });

  it("submits once the agent echoes what we typed", async () => {
    vi.useFakeTimers();
    try {
      const p = deliverMessage("pty-1", "fix the login bug", { verifyEcho: true });
      await vi.advanceTimersByTimeAsync(50);
      expect(submitted()).toBe(false);          // nothing yet: no echo
      echo("\x1b[2K fix the login bug ");        // input box paints it back
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(submitted()).toBe(true);
      expect(unlisten).toHaveBeenCalled();      // listener always released
    } finally { vi.useRealTimers(); }
  });

  it("WITHHOLDS the submit when nothing comes back", async () => {
    // The measured failure: claude's trust picker takes the keystrokes and
    // echoes nothing, and the CR would confirm its highlighted `No, exit`.
    // A lost prompt is recoverable; a killed agent is not.
    vi.useFakeTimers();
    try {
      const p = deliverMessage("pty-1", "fix the login bug", { verifyEcho: true });
      const caught = p.catch(e => String(e));
      await vi.advanceTimersByTimeAsync(5000);
      expect(await caught).toMatch(/did not echo/);
      expect(text(writes[0])).toBe("fix the login bug");
      expect(submitted()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("accepts an echo that arrives re-wrapped and re-spaced", async () => {
    // A TUI redraws the line its own way: cursor moves between words, its own
    // spacing, wrapping. Comparing literally would reject text that plainly
    // arrived, and rejecting means refusing to deliver.
    vi.useFakeTimers();
    try {
      const p = deliverMessage("pty-1", "line one\nline two", { verifyEcho: true });
      await vi.advanceTimersByTimeAsync(50);   // let the listener attach
      echo("\x1b[1;1H line\x1b[3C one\r\n  line   two");
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(submitted()).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("submits anyway when the PTY cannot be observed", async () => {
    // Absence of evidence is not evidence. A listener that fails must not
    // silently swallow every prompt; fall back to the old behaviour.
    vi.resetModules();
    vi.doMock("@/lib/ipc", () => ({
      ptyWrite: (_i: string, b: number[]) => { writes.push(b); return Promise.resolve(); },
      onPtyData: () => Promise.reject(new Error("no listener")),
    }));
    const { deliverMessage: dm } = await import("@/lib/agentSend");
    await dm("pty-1", "hello", { verifyEcho: true });
    expect(submitted()).toBe(true);
    vi.doUnmock("@/lib/ipc");
  });

  it("never submits inside the paste-coalescing window", async () => {
    // SUBMIT_DELAY_MS is about the agent's stdin batching, not about whether
    // it was reading, so an echo seen at 40ms must still not submit at 40ms:
    // a CR coalesced into the text burst is read as a paste continuation and
    // swallowed, leaving the message sitting in the box unsent.
    vi.useFakeTimers();
    try {
      const p = deliverMessage("pty-1", "hello", { verifyEcho: true });
      await vi.advanceTimersByTimeAsync(40);
      echo("hello");
      await vi.advanceTimersByTimeAsync(60);
      expect(submitted()).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(submitted()).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
