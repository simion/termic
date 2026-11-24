// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { terminalKeysAfter, terminalKeysBefore } from "./terminalKeys";

const key = (init: KeyboardEventInit & { keyCode?: number }) => {
  const e = new KeyboardEvent("keydown", { cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(e, "keyCode", { value: init.keyCode });
  return e;
};
const target = () => {
  const write = vi.fn();
  return { write, t: { term: { hasSelection: () => false, getSelection: () => "", paste: vi.fn() } as never, write, agentBaseId: () => "claude" } };
};

describe("terminalKeys (shared by local and remote terminals)", () => {
  it("Shift+Enter writes a newline, not a submit, and stops the event", () => {
    const { write, t } = target();
    const e = key({ key: "Enter", shiftKey: true });
    expect(terminalKeysAfter(e, t)).toBe(false);
    expect(write).toHaveBeenCalledWith([0x5c, 0x0d]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("a plain Enter is not ours", () => {
    const { write, t } = target();
    expect(terminalKeysAfter(key({ key: "Enter" }), t)).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it("a key mid-composition goes to xterm's IME path", () => {
    expect(terminalKeysBefore(key({ key: "a", keyCode: 229 }))).toBe(false);
    expect(terminalKeysBefore(key({ key: "a" }))).toBeUndefined();
  });
});
