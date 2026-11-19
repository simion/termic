import { describe, expect, it } from "vitest";
import { windowTitle } from "./useWindowTitle";

describe("windowTitle", () => {
  it("is the bare base with no task", () => {
    expect(windowTitle("Termic")).toBe("Termic");
    expect(windowTitle("Termic - Work")).toBe("Termic - Work");
  });
  it("names the project, task and tab", () => {
    expect(windowTitle("Termic", "api", "fix-login", "claude")).toBe("Termic - api / fix-login - claude");
    expect(windowTitle("Termic - Work", "api", "fix-login")).toBe("Termic - Work - api / fix-login");
  });
  it("drops a missing project rather than printing an empty one", () => {
    expect(windowTitle("Termic", undefined, "fix-login", "claude")).toBe("Termic - fix-login - claude");
  });
});
