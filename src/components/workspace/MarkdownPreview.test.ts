// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  openPath: vi.fn(),
  workspaceFileReadBase64: vi.fn(),
  workspacePathStat: vi.fn(),
  workspaceRevealPath: vi.fn(),
}));
vi.mock("@/store/app", () => ({ useApp: { getState: vi.fn() } }));
vi.mock("@/store/ui", () => ({ useUI: { getState: vi.fn() } }));

import { workspaceFileReadBase64 } from "@/lib/ipc";
import {
  attemptReveal, captureReveal, consumeNavRevalidate, expireRevealGrace, hydrateWorkspaceImages, IMG_CACHE_MAX_ENTRIES,
  imgCacheInsert, newNavRevalidateState, newRevealState,
  type ImgCache, type MarkdownCtx,
} from "./MarkdownPreview";

const readBase64 = vi.mocked(workspaceFileReadBase64);

// Drain the fetch → cache-insert → DOM-apply promise chain (microtasks only,
// but setTimeout(0) outlives however many .then hops it grows).
const flush = () => new Promise<void>(r => setTimeout(r, 0));

function newCache(): ImgCache {
  return { map: new Map(), bytes: 0, inflight: new Map() };
}

function mount(html: string): { host: HTMLElement; img: HTMLImageElement } {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host); // hydrate skips disconnected imgs on apply
  return { host, img: host.querySelector("img")! };
}

describe("hydrateWorkspaceImages", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    readBase64.mockReset();
  });

  it("swaps a relative src for a data: URL", async () => {
    readBase64.mockResolvedValue({ unchanged: false, mime: "image/png", data: "AAA", fp: "1:5" });
    const { host, img } = mount(`<img src="a.png">`);
    const cache = newCache();

    hydrateWorkspaceImages(host, { wsId: "ws1", filePath: "docs/readme.md" }, cache);
    expect(img.getAttribute("src")).toBeNull(); // never hits the webview origin
    await flush();

    expect(readBase64).toHaveBeenCalledWith("ws1", "docs/a.png", undefined);
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");
  });

  it("does not re-fetch a positive entry unless revalidatePositive is set", async () => {
    readBase64.mockResolvedValue({ unchanged: false, mime: "image/png", data: "AAA", fp: "1:5" });
    const ctx: MarkdownCtx = { wsId: "ws1", filePath: "docs/readme.md" };
    const { host } = mount(`<img src="a.png">`);
    const cache = newCache();

    hydrateWorkspaceImages(host, ctx, cache);
    await flush();
    expect(readBase64).toHaveBeenCalledTimes(1);

    // Re-render (main text effect): same DOM, cache already positive — no
    // reason to re-check a known-good image on every keystroke.
    hydrateWorkspaceImages(host, ctx, cache);
    await flush();
    expect(readBase64).toHaveBeenCalledTimes(1);
  });

  it("sends the cached fp on a settle revalidation and applies the server's unchanged response", async () => {
    readBase64.mockResolvedValue({ unchanged: false, mime: "image/png", data: "AAA", fp: "1:5" });
    const ctx: MarkdownCtx = { wsId: "ws1", filePath: "docs/readme.md" };
    const { host, img } = mount(`<img src="a.png">`);
    const cache = newCache();

    hydrateWorkspaceImages(host, ctx, cache);
    await flush();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");

    readBase64.mockResolvedValue({ unchanged: true, fp: "1:5" });
    hydrateWorkspaceImages(host, ctx, cache, { revalidatePositive: true });
    await flush();

    expect(readBase64).toHaveBeenLastCalledWith("ws1", "docs/a.png", "1:5");
    // Server confirmed unchanged: no payload was sent, cached bytes stand.
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");
  });

  it("clears the stale image when a settle revalidation fails (file deleted)", async () => {
    readBase64.mockResolvedValue({ unchanged: false, mime: "image/png", data: "AAA", fp: "1:5" });
    const ctx: MarkdownCtx = { wsId: "ws1", filePath: "docs/readme.md" };
    const { host, img } = mount(`<img src="a.png">`);
    const cache = newCache();

    hydrateWorkspaceImages(host, ctx, cache);
    await flush();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");

    readBase64.mockRejectedValue("read failed: No such file");
    hydrateWorkspaceImages(host, ctx, cache, { revalidatePositive: true });
    // Stale-while-revalidate: the old bytes stay up while the read is in flight.
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");
    await flush();

    expect(img.getAttribute("src")).toBeNull();
    expect(img.title).toBe("read failed: No such file");

    // A later hydrate pass must not resurrect the stale bytes from cache.
    hydrateWorkspaceImages(host, ctx, cache);
    await flush();
    expect(img.getAttribute("src")).toBeNull();
  });

  it("does not retry a negative entry within the cooldown, but does once it's passed", async () => {
    // A failed read must not stick around for a whole epoch — the user may
    // just have fixed the path/created the file — but retrying on literally
    // every keystroke-debounce tick would mean an IPC round-trip per ~200ms
    // of typing anywhere in the doc. The cooldown spaces retries out.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    readBase64.mockRejectedValue("read failed: No such file");
    const ctx: MarkdownCtx = { wsId: "ws1", filePath: "docs/readme.md" };
    const { host, img } = mount(`<img src="a.png">`);
    const cache = newCache();

    hydrateWorkspaceImages(host, ctx, cache);
    await flush();
    expect(img.getAttribute("src")).toBeNull();
    expect(img.title).toBe("read failed: No such file");
    expect(readBase64).toHaveBeenCalledTimes(1);

    // Still within the cooldown: a re-render (e.g. another keystroke) must
    // not issue a second IPC call.
    nowSpy.mockReturnValue(1_000_000 + 500);
    readBase64.mockResolvedValue({ unchanged: false, mime: "image/png", data: "BBB", fp: "2:5" });
    hydrateWorkspaceImages(host, ctx, cache);
    await flush();
    expect(readBase64).toHaveBeenCalledTimes(1);
    expect(img.getAttribute("src")).toBeNull();

    // Past the cooldown: retries and picks up the fix, without needing
    // revalidatePositive (the "retry on an error/re-render trigger" path).
    nowSpy.mockReturnValue(1_000_000 + 2_000);
    hydrateWorkspaceImages(host, ctx, cache);
    await flush();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,BBB");
    expect(img.getAttribute("title")).toBeNull(); // failure hint cleared

    nowSpy.mockRestore();
  });

  it("preserves an authored title (caption) through success and failure", async () => {
    // ![alt](a.png "caption") renders title="caption"; hydration must never
    // remove it on success nor overwrite it with a failure hint.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    readBase64.mockResolvedValue({ unchanged: false, mime: "image/png", data: "AAA", fp: "1:5" });
    const ctx: MarkdownCtx = { wsId: "ws1", filePath: "docs/readme.md" };
    const { host, img } = mount(`<img src="a.png" title="caption">`);
    const cache = newCache();

    hydrateWorkspaceImages(host, ctx, cache);
    await flush();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(img.title).toBe("caption");

    readBase64.mockRejectedValue("read failed: No such file");
    hydrateWorkspaceImages(host, ctx, cache, { revalidatePositive: true });
    await flush();
    expect(img.getAttribute("src")).toBeNull(); // stale image still cleared
    expect(img.title).toBe("caption");

    nowSpy.mockReturnValue(1_000_000 + 2_000); // past the negative-entry cooldown
    readBase64.mockResolvedValue({ unchanged: false, mime: "image/png", data: "BBB", fp: "3:5" });
    hydrateWorkspaceImages(host, ctx, cache);
    await flush();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,BBB");
    expect(img.title).toBe("caption");

    nowSpy.mockRestore();
  });

  it("single-flights concurrent reads for the same key instead of racing two", async () => {
    let resolveRead!: (v: { unchanged: boolean; mime?: string; data?: string; fp: string }) => void;
    readBase64.mockReturnValue(new Promise(r => { resolveRead = r; }));
    const ctx: MarkdownCtx = { wsId: "ws1", filePath: "docs/readme.md" };
    const { host } = mount(`<img src="a.png">`);
    const cache = newCache();

    // Two overlapping triggers (e.g. a text-effect re-render racing an
    // epoch-effect settle) before the first read has resolved.
    hydrateWorkspaceImages(host, ctx, cache);
    hydrateWorkspaceImages(host, ctx, cache, { revalidatePositive: true });
    expect(readBase64).toHaveBeenCalledTimes(1);

    resolveRead({ unchanged: false, mime: "image/png", data: "AAA", fp: "1:5" });
    await flush();
    expect(readBase64).toHaveBeenCalledTimes(1);
  });

  it("resolves multiple <img> tags referencing the same file from one fetch", async () => {
    readBase64.mockResolvedValue({ unchanged: false, mime: "image/png", data: "AAA", fp: "1:5" });
    const ctx: MarkdownCtx = { wsId: "ws1", filePath: "docs/readme.md" };
    const { host } = mount(`<img src="a.png"><img src="./a.png">`);
    const cache = newCache();

    hydrateWorkspaceImages(host, ctx, cache);
    expect(readBase64).toHaveBeenCalledTimes(1); // same resolved path, one call
    await flush();

    for (const img of Array.from(host.querySelectorAll("img"))) {
      expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");
    }
  });
});

describe("imgCacheInsert entry-count cap", () => {
  it("bounds the cache by entry count, not just bytes (negative entries are ~0 bytes)", () => {
    const cache = newCache();
    for (let i = 0; i < IMG_CACHE_MAX_ENTRIES + 50; i++) {
      imgCacheInsert(cache, `ws1:missing-${i}.png`, "", "", "not found");
    }
    expect(cache.map.size).toBeLessThanOrEqual(IMG_CACHE_MAX_ENTRIES);
    // The newest entries survive (FIFO evicts the oldest first).
    expect(cache.map.has(`ws1:missing-${IMG_CACHE_MAX_ENTRIES + 49}.png`)).toBe(true);
    expect(cache.map.has("ws1:missing-0.png")).toBe(false);
  });
});

describe("reveal state machine (captureReveal / attemptReveal)", () => {
  function mountHeadings(...titles: string[]): HTMLElement {
    const host = document.createElement("div");
    host.innerHTML = titles.map(t => `<h2>${t}</h2>`).join("");
    return host;
  }

  it("skips when nothing is pending", () => {
    const state = newRevealState();
    const host = mountHeadings("Usage");
    expect(attemptReveal(state, host, true, "Usage")).toEqual({ kind: "skip" });
  });

  it("skips (without consuming) when pending but not visible", () => {
    const state = newRevealState();
    captureReveal(state, "usage");
    const host = mountHeadings("Usage");
    expect(attemptReveal(state, host, false, "# Usage")).toEqual({ kind: "skip" });
    expect(state.pending).toBe("usage"); // still there for the next attempt
  });

  it("matches and clears pending once visible", () => {
    const state = newRevealState();
    captureReveal(state, "usage");
    const host = mountHeadings("Usage");
    const result = attemptReveal(state, host, true, "# Usage");
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") expect(result.target.textContent).toBe("Usage");
    expect(state.pending).toBeNull();
  });

  it("retries while text is empty and ambiguous, and drops once the grace timer expires", () => {
    const state = newRevealState();
    captureReveal(state, "usage");
    const host = mountHeadings(); // empty file: no headings yet (or ever)

    const first = attemptReveal(state, host, true, "");
    expect(first.kind).toBe("retry");
    expect(state.pending).toBe("usage"); // kept for the retry

    // Repeated attempts before the grace timer fires keep retrying, not
    // dropping — only the timer itself (expireRevealGrace) can end the wait.
    const second = attemptReveal(state, host, true, "");
    expect(second.kind).toBe("retry");
    expect(state.pending).toBe("usage");

    expireRevealGrace(state); // the deliberate 350ms timer firing
    const third = attemptReveal(state, host, true, "");
    expect(third.kind).toBe("dropped");
    expect(state.pending).toBeNull(); // never resurfaces while the user types later
  });

  it("an incidental visible bounce while still loading does not consume the grace budget", () => {
    // Regression: a rapid visible→false→true bounce (e.g. MarkdownPane's
    // auto-flip effect racing a second view toggle) re-invokes attemptReveal
    // while content is still loading. That alone must never end the wait —
    // only the deliberate grace timer firing may.
    const state = newRevealState();
    captureReveal(state, "usage");
    const host = mountHeadings();

    expect(attemptReveal(state, host, true, "").kind).toBe("retry");
    expect(attemptReveal(state, host, false, "").kind).toBe("skip"); // container hidden again
    // Visible again, still no content loaded, grace timer hasn't fired yet.
    expect(attemptReveal(state, host, true, "").kind).toBe("retry");
    expect(state.pending).toBe("usage"); // still alive, not prematurely dropped

    expireRevealGrace(state);
    expect(attemptReveal(state, host, true, "").kind).toBe("dropped");
  });

  it("drops immediately (no retry) when content is loaded and simply has no match", () => {
    const state = newRevealState();
    captureReveal(state, "no-such-heading");
    const host = mountHeadings("Usage");
    const result = attemptReveal(state, host, true, "# Usage");
    expect(result.kind).toBe("dropped");
    expect(state.pending).toBeNull();
  });

  it("a fresh capture resets the grace window", () => {
    const state = newRevealState();
    captureReveal(state, "usage");
    const empty = mountHeadings();
    attemptReveal(state, empty, true, ""); // schedules a retry
    expireRevealGrace(state);
    expect(state.graceExpired).toBe(true);

    captureReveal(state, "install"); // a NEW reveal arrives before the old one dropped
    expect(state.graceExpired).toBe(false);
    expect(state.pending).toBe("install");
  });

  it("resetting the reveal state (as on a file-identity change) drops a mid-retry pending reveal", () => {
    // Regression: MarkdownPreview isn't remounted when a preview tab recycles
    // to a different file (WorkspaceView keys by tab id, not path), so a
    // reveal captured for fileA that's still mid-retry (its content hadn't
    // loaded yet) must not survive a recycle to fileB and fire against
    // fileB's headings — even if fileB happens to contain a matching one.
    let state = newRevealState();
    captureReveal(state, "usage");
    const fileAEmpty = mountHeadings(); // fileA hasn't loaded yet
    const first = attemptReveal(state, fileAEmpty, true, "");
    expect(first.kind).toBe("retry");

    // The tab recycles to fileB before the retry timer fires — MarkdownPreview's
    // file-identity-change effect replaces the state object wholesale.
    state = newRevealState();

    const fileBHasMatchingHeading = mountHeadings("Usage");
    const afterRecycle = attemptReveal(state, fileBHasMatchingHeading, true, "# Usage");
    expect(afterRecycle.kind).toBe("skip"); // nothing pending — never scrolls fileB for fileA's fragment
  });

  it("disambiguates duplicate headings via a used-slug set, not a per-base counter", () => {
    // A literal "Usage 1" heading claims slug "usage-1" for itself. A LATER
    // duplicate "Usage" must skip past it to "usage-2", not collide on
    // "usage-1" (which a naive per-base occurrence counter would produce).
    const host = mountHeadings("Usage", "Usage 1", "Usage");

    const wantUsage1 = newRevealState();
    captureReveal(wantUsage1, "usage-1");
    const r1 = attemptReveal(wantUsage1, host, true, "x");
    expect(r1.kind).toBe("matched");
    if (r1.kind === "matched") expect(r1.target.textContent).toBe("Usage 1");

    const wantUsage2 = newRevealState();
    captureReveal(wantUsage2, "usage-2");
    const r2 = attemptReveal(wantUsage2, host, true, "x");
    expect(r2.kind).toBe("matched");
    if (r2.kind === "matched") expect(r2.target.textContent).toBe("Usage"); // the 2nd literal "Usage"
  });

  it("keeps Unicode letters in a heading slug instead of stripping them", () => {
    const host = mountHeadings("Café Menu");
    const state = newRevealState();
    captureReveal(state, "café-menu");
    const result = attemptReveal(state, host, true, "x");
    expect(result.kind).toBe("matched");
  });
});

describe("consumeNavRevalidate", () => {
  it("does not flag navigation on repeated calls for the same file", () => {
    const state = newNavRevalidateState();
    expect(consumeNavRevalidate(state, "fileA.md", "content A")).toBe(true); // first time seeing this path
    expect(consumeNavRevalidate(state, "fileA.md", "content A")).toBe(false);
    expect(consumeNavRevalidate(state, "fileA.md", "content A (edited)")).toBe(false);
  });

  it("survives a blank interim render and still fires on the render that actually has content", () => {
    // Regression: MarkdownPane derives an empty `text` for one render right
    // after a preview tab recycles to a different file (its debounced
    // buffer is still labeled with the PREVIOUS tab.path) — the file-change
    // signal must not be consumed on that blank render, since it has no
    // <img> tags to revalidate at all; it must survive to the render that
    // actually has content.
    const state = newNavRevalidateState();
    consumeNavRevalidate(state, "fileA.md", "content A");
    consumeNavRevalidate(state, "fileA.md", "content A");

    // Recycle to fileB: ctx.filePath changes, but text is still "" for one render.
    expect(consumeNavRevalidate(state, "fileB.md", "")).toBe(true);
    // ~200ms later: real content lands. filePath is UNCHANGED from the
    // previous call — a naive "did filePath change THIS render" check would
    // miss this, since the change was already observed on the blank render.
    expect(consumeNavRevalidate(state, "fileB.md", "content B")).toBe(true);
    // Consumed now — subsequent edits within fileB don't re-trigger.
    expect(consumeNavRevalidate(state, "fileB.md", "content B (edited)")).toBe(false);
  });

  it("a second navigation before the first is consumed still ends up pending for the latest file", () => {
    const state = newNavRevalidateState();
    consumeNavRevalidate(state, "fileA.md", "content A");
    consumeNavRevalidate(state, "fileB.md", ""); // recycle to B, content not loaded yet
    consumeNavRevalidate(state, "fileC.md", ""); // recycles again to C before B ever loaded
    expect(consumeNavRevalidate(state, "fileC.md", "content C")).toBe(true);
  });
});
