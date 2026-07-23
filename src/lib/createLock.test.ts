import { describe, it, expect } from "vitest";
import { withCreateLock } from "@/lib/createLock";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe("withCreateLock", () => {
  it("serializes overlapping creates in submission order", async () => {
    const log: string[] = [];
    const job = (name: string, ms: number) => () =>
      (async () => {
        log.push(`${name}:start`);
        await sleep(ms);
        log.push(`${name}:end`);
        return name;
      })();
    const [a, b, c] = await Promise.all([
      withCreateLock(job("a", 30)),
      withCreateLock(job("b", 5)),
      withCreateLock(job("c", 1)),
    ]);
    expect([a, b, c]).toEqual(["a", "b", "c"]);
    // No interleaving: each job's start/end pair is adjacent.
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("propagates errors without poisoning the chain", async () => {
    const boom = withCreateLock(() => Promise.reject(new Error("boom")));
    await expect(boom).rejects.toThrow("boom");
    // The next create still runs.
    await expect(withCreateLock(() => Promise.resolve(42))).resolves.toBe(42);
  });
});
