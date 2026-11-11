import { describe, expect, it } from "vitest";
import { parseShellBrokerKey, shellBrokerKey } from "./ipc";

describe("shell broker keys", () => {
  it("round-trips and never reads a task id as a shell", () => {
    const k = shellBrokerKey("t-1", "tab-9");
    expect(k).toBe("shell:t-1:tab-9");
    expect(parseShellBrokerKey(k)).toEqual({ taskId: "t-1", tabId: "tab-9" });
    expect(parseShellBrokerKey("t-1")).toBeNull();
    expect(parseShellBrokerKey("shell:nocolon")).toBeNull();
  });
});
