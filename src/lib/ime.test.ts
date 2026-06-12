// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import {
  computeImeDelta,
  isForwardedInputType,
  setupImeReplacementBridge,
} from "@/lib/ime";

const DEL = 0x7f;
const enc = (s: string) => Array.from(new TextEncoder().encode(s));

// ── computeImeDelta ────────────────────────────────────────────────────
// Diffs the textarea value (code-point aware) into DEL backspaces + the new
// tail. This is the core of the WebKit IME fix.

describe("computeImeDelta", () => {
  it("encodes a fresh append from empty", () => {
    expect(computeImeDelta("", "아")).toEqual(enc("아"));
  });

  it("returns nothing when unchanged", () => {
    expect(computeImeDelta("안", "안")).toEqual([]);
    expect(computeImeDelta("", "")).toEqual([]);
  });

  it("replaces the composing syllable (ㅇ -> 아)", () => {
    expect(computeImeDelta("ㅇ", "아")).toEqual([DEL, ...enc("아")]);
  });

  it("keeps the common prefix and only rewrites the tail (안ㄴ -> 안녀)", () => {
    // common prefix "안"; backspace the trailing ㄴ, send 녀.
    expect(computeImeDelta("안ㄴ", "안녀")).toEqual([DEL, ...enc("녀")]);
  });

  it("handles Korean final-consonant migration (안 -> 아나)", () => {
    // The trailing ㄴ of 안 migrates to start the next syllable. Diffing the
    // whole value (not just the last char) gets this right: DEL 안, send 아나.
    expect(computeImeDelta("안", "아나")).toEqual([DEL, ...enc("아나")]);
  });

  it("emits a bare backspace when the value shrinks", () => {
    expect(computeImeDelta("안녕", "안")).toEqual([DEL]);
  });

  it("counts a surrogate-pair grapheme as ONE backspace", () => {
    // 👍 and 👋 are each a single code point spanning two UTF-16 units. A
    // naive .length diff would emit two backspaces; code-point diffing emits one.
    expect(computeImeDelta("👍", "👋")).toEqual([DEL, ...enc("👋")]);
  });
});

// ── isForwardedInputType ───────────────────────────────────────────────
// xterm forwards only "insertText"; everything composition-related it drops,
// so those are the events the bridge must forward.

describe("isForwardedInputType", () => {
  it("does NOT forward insertText (xterm handles it)", () => {
    expect(isForwardedInputType("insertText")).toBe(false);
  });

  it("does NOT forward paste or line breaks (xterm/keydown handle them)", () => {
    expect(isForwardedInputType("insertFromPaste")).toBe(false);
    expect(isForwardedInputType("insertLineBreak")).toBe(false);
    expect(isForwardedInputType("insertParagraph")).toBe(false);
  });

  it("forwards composition refinements and composition deletes", () => {
    expect(isForwardedInputType("insertReplacementText")).toBe(true);
    expect(isForwardedInputType("insertCompositionText")).toBe(true);
    expect(isForwardedInputType("deleteContentBackward")).toBe(true);
  });
});

// ── setupImeReplacementBridge (DOM) ────────────────────────────────────

function mountTerminal() {
  const host = document.createElement("div");
  host.className = "xterm";
  const ta = document.createElement("textarea");
  ta.className = "xterm-helper-textarea";
  host.appendChild(ta);
  document.body.appendChild(host);
  return { host, ta };
}

function fireInput(ta: HTMLTextAreaElement, inputType: string, value: string, data: string | null) {
  ta.value = value;
  ta.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true }));
}

describe("setupImeReplacementBridge", () => {
  const PID = "pty-1";

  it("forwards only the dropped events while typing 안녕, reconstructing it on the PTY", () => {
    const { host, ta } = mountTerminal();
    const write = vi.fn();
    setupImeReplacementBridge(host, () => PID, write);

    // The exact WebKit event sequence captured from the live app.
    fireInput(ta, "insertText", "ㅇ", "ㅇ");             // xterm forwards → bridge skips
    fireInput(ta, "insertReplacementText", "아", "아");  // dropped → bridge forwards
    fireInput(ta, "insertReplacementText", "안", "안");
    fireInput(ta, "insertText", "안ㄴ", "ㄴ");           // xterm forwards → bridge skips
    fireInput(ta, "insertReplacementText", "안녀", "녀");
    fireInput(ta, "insertReplacementText", "안녕", "녕");

    // Only the 4 replacement events produce writes.
    expect(write).toHaveBeenCalledTimes(4);
    expect(write.mock.calls.map(c => c[1])).toEqual([
      [DEL, ...enc("아")], // ㅇ -> 아
      [DEL, ...enc("안")], // 아 -> 안
      [DEL, ...enc("녀")], // 안ㄴ -> 안녀
      [DEL, ...enc("녕")], // 안녀 -> 안녕
    ]);

    // Replaying xterm's insertText sends + the bridge's writes onto a model
    // PTY line yields exactly "안녕".
    const xtermSends = ["ㅇ", "ㄴ"]; // what xterm forwards for the insertText events
    let line = [...Array.from(xtermSends[0])];
    // Apply: bridge(아), bridge(안), xterm(ㄴ), bridge(녀), bridge(녕)
    const apply = (bytes: number[]) => {
      const text = new TextDecoder().decode(Uint8Array.from(bytes.filter(b => b !== DEL)));
      const backs = bytes.filter(b => b === DEL).length;
      for (let i = 0; i < backs; i++) line.pop();
      line.push(...Array.from(text));
    };
    apply([DEL, ...enc("아")]);
    apply([DEL, ...enc("안")]);
    line.push(...Array.from("ㄴ")); // xterm insertText
    apply([DEL, ...enc("녀")]);
    apply([DEL, ...enc("녕")]);
    expect(line.join("")).toBe("안녕");

    host.remove();
  });

  it("resets its baseline on Enter so the next composition does not backspace the old line", () => {
    const { host, ta } = mountTerminal();
    const write = vi.fn();
    setupImeReplacementBridge(host, () => PID, write);

    fireInput(ta, "insertText", "안녕", "녕"); // baseline := "안녕"
    write.mockClear();

    // Enter: xterm sends \r and clears the textarea WITHOUT an input event.
    ta.value = "";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    // Next composition starts fresh.
    fireInput(ta, "insertReplacementText", "하", "하");
    // No DEL for the (gone) old line — just the new char.
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][1]).toEqual([...enc("하")]);

    host.remove();
  });

  it("stops forwarding after cleanup", () => {
    const { host, ta } = mountTerminal();
    const write = vi.fn();
    const dispose = setupImeReplacementBridge(host, () => PID, write);

    dispose();
    fireInput(ta, "insertReplacementText", "아", "아");
    expect(write).not.toHaveBeenCalled();

    host.remove();
  });

  it("does not write when there is no PTY yet", () => {
    const { host, ta } = mountTerminal();
    const write = vi.fn();
    setupImeReplacementBridge(host, () => null, write);

    fireInput(ta, "insertReplacementText", "아", "아");
    expect(write).not.toHaveBeenCalled();

    host.remove();
  });
});
