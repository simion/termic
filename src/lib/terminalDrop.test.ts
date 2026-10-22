// @vitest-environment happy-dom
// Path handling for drops into a terminal (Finder drags + file-tree drags).
// The pointer gesture and the Tauri wiring are exercised by e2e; these cover
// the decisions that determine WHAT gets typed at the prompt, and WHERE a
// Finder drop lands.

import { describe, it, expect, vi, beforeEach } from "vitest";

// capture the handler the app registers with Tauri's native drag-drop listener.
type DropHandler = (e: { payload: any }) => void;
const drop = vi.hoisted(() => ({ handler: null as DropHandler | null }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (h: DropHandler) => { drop.handler = h; return () => {}; },
  }),
}));
vi.mock("@/lib/ipc", () => ({ ptyWrite: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/store/ui", () => ({ useUI: { getState: () => ({}) } }));

import * as ipc from "@/lib/ipc";
import {
  shellEscapePath, pathForTerminal, registerTerminalDropTarget, initTerminalDropHandler,
  type DraggedPath,
} from "./terminalDrop";

const DRAG: DraggedPath = {
  taskId: "task-a",
  rel: "src/lib/terminalDrop.ts",
  abs: "/Users/x/tasks/task-a/src/lib/terminalDrop.ts",
};

describe("shellEscapePath", () => {
  it("leaves a plain path untouched", () => {
    expect(shellEscapePath("src/lib/a-b_c.ts")).toBe("src/lib/a-b_c.ts");
  });

  it("escapes spaces and shell metacharacters", () => {
    expect(shellEscapePath("/Downloads/Nextech 0098.jpg"))
      .toBe("/Downloads/Nextech\\ 0098.jpg");
    expect(shellEscapePath("a(1)&b$c'd\"e.txt"))
      .toBe("a\\(1\\)\\&b\\$c\\'d\\\"e.txt");
  });

  it("escapes non-ASCII so the byte stream stays literal", () => {
    expect(shellEscapePath("docs/설계.md")).toBe("docs/\\설\\계.md");
  });
});

describe("pathForTerminal", () => {
  it("types the relative path into a terminal of the same task", () => {
    expect(pathForTerminal(DRAG, "task-a")).toBe(DRAG.rel);
  });

  it("falls back to absolute for another task's terminal", () => {
    expect(pathForTerminal(DRAG, "task-b")).toBe(DRAG.abs);
  });

  it("falls back to absolute when either side has no task", () => {
    expect(pathForTerminal(DRAG, "")).toBe(DRAG.abs);
    expect(pathForTerminal({ ...DRAG, taskId: "" }, "task-a")).toBe(DRAG.abs);
  });
});

describe("Finder drop onto a terminal", () => {
  const host = document.createElement("div");
  const SHOT = "/Users/x/Desktop/Screen Shot 1.png";
  const typed = () =>
    vi.mocked(ipc.ptyWrite).mock.calls.map(([id, bytes]) => [id, new TextDecoder().decode(new Uint8Array(bytes))]);

  beforeEach(async () => {
    vi.mocked(ipc.ptyWrite).mockClear();
    document.body.appendChild(host);
    registerTerminalDropTarget(host, () => "pty-1");
    // the terminal occupies CSS px (200..400, 100..300), everything else is body.
    document.elementFromPoint = (x: number, y: number) =>
      x >= 200 && x < 400 && y >= 100 && y < 300 ? host : document.body;
    // Retina: if the handler treated the position as physical px and divided
    // by this, (300, 200) would become (150, 100) and miss the terminal.
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    await initTerminalDropHandler();
  });

  const fire = (type: string, x: number, y: number) =>
    drop.handler!({ payload: { type, paths: [SHOT], position: { x, y } } });

  it("types the escaped path into the terminal under the drop point (Retina)", () => {
    fire("drop", 300, 200);
    expect(typed()).toEqual([["pty-1", "/Users/x/Desktop/Screen\\ Shot\\ 1.png "]]);
  });

  it("outlines the terminal under the cursor and clears it on leave", () => {
    fire("over", 300, 200);
    expect(host.classList.contains("termic-drop-target")).toBe(true);
    drop.handler!({ payload: { type: "leave" } });
    expect(host.classList.contains("termic-drop-target")).toBe(false);
  });

  it("ignores a drop outside any terminal", () => {
    fire("drop", 150, 100);
    expect(typed()).toEqual([]);
  });
});
