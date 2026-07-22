import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { keepAtlasCanvasConnected } from "./atlasCanvasGuard";

// Node environment: no DOM, so `document` is stubbed with just the surface the
// guard touches. Shapes mirror the addon-webgl internals pinned by
// xtermInternals.test.ts.

interface FakeCanvas {
  isConnected: boolean;
  style: Record<string, string>;
}

const mkCanvas = (connected: boolean): FakeCanvas => ({ isConnected: connected, style: {} });
const mkCtx = () => ({ font: "" });
const mkAddon = (canvas?: FakeCanvas, ctx?: { font: string }) => ({
  _renderer: { _charAtlas: { _tmpCanvas: canvas, _tmpCtx: ctx } },
});

let append: ReturnType<typeof vi.fn>;

beforeEach(() => {
  append = vi.fn();
  vi.stubGlobal("document", { body: { append } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("keepAtlasCanvasConnected", () => {
  it("parks a disconnected canvas under document.body, hidden, and busts the ctx font", () => {
    const canvas = mkCanvas(false);
    const ctx = mkCtx();
    keepAtlasCanvasConnected(mkAddon(canvas, ctx));
    expect(append).toHaveBeenCalledWith(canvas);
    expect(canvas.style.display).toBe("none");
    expect(ctx.font).toBe("1px serif");
  });

  it("moves a still-connected canvas out of a dying host", () => {
    const canvas = mkCanvas(true);
    const dyingHost = { contains: (n: unknown) => n === canvas } as unknown as HTMLElement;
    keepAtlasCanvasConnected(mkAddon(canvas, mkCtx()), dyingHost);
    expect(append).toHaveBeenCalledWith(canvas);
  });

  it("leaves a connected canvas hosted elsewhere in place but still busts the font", () => {
    const canvas = mkCanvas(true);
    const ctx = mkCtx();
    const otherHost = { contains: () => false } as unknown as HTMLElement;
    keepAtlasCanvasConnected(mkAddon(canvas, ctx), otherHost);
    expect(append).not.toHaveBeenCalled();
    // self-healing: any stale resolution is cleared even when nothing moved
    expect(ctx.font).toBe("1px serif");
  });

  it("busts the font even when the ctx is reachable but the canvas needs no move", () => {
    const canvas = mkCanvas(true);
    const ctx = mkCtx();
    keepAtlasCanvasConnected(mkAddon(canvas, ctx));
    expect(append).not.toHaveBeenCalled();
    expect(ctx.font).toBe("1px serif");
  });

  it("fails soft on missing addon or missing internals", () => {
    expect(() => keepAtlasCanvasConnected(null)).not.toThrow();
    expect(() => keepAtlasCanvasConnected(undefined)).not.toThrow();
    expect(() => keepAtlasCanvasConnected({})).not.toThrow();
    expect(() => keepAtlasCanvasConnected({ _renderer: {} })).not.toThrow();
    expect(() => keepAtlasCanvasConnected({ _renderer: { _charAtlas: {} } })).not.toThrow();
    // canvas present but no ctx: moves the canvas, skips the font poke
    const canvas = mkCanvas(false);
    expect(() => keepAtlasCanvasConnected(mkAddon(canvas, undefined))).not.toThrow();
    expect(append).toHaveBeenCalledWith(canvas);
  });
});
