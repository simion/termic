// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushPhones = vi.fn();
vi.mock("@/lib/ipc", () => ({ pushPhones: (...a: unknown[]) => pushPhones(...a) }));

import { useApp } from "@/store/app";
import { pushPhonesForTask } from "./phonePush";

describe("pushPhonesForTask", () => {
  beforeEach(() => {
    pushPhones.mockClear();
    useApp.setState({
      projects: [{ id: "p1", name: "web" }] as never,
      tasks: [{ id: "t1", project_id: "p1", name: "fix-login" }] as never,
    });
  });

  it("sends the banner's own title and the agent's words, flagged needs-you", () => {
    pushPhonesForTask("t1", true, "Allow Bash(npm test)?");
    expect(pushPhones).toHaveBeenCalledWith("web · fix-login", "Allow Bash(npm test)?", "t1", true);
  });

  it("falls back to a phrase for a finished turn with nothing said", () => {
    pushPhonesForTask("t1", false);
    const [title, body, task, attention] = pushPhones.mock.calls[0];
    expect([title, task, attention]).toEqual(["web · fix-login", "t1", false]);
    expect(String(body).length).toBeGreaterThan(0);
  });
});
