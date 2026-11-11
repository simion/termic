import { describe, expect, it } from "vitest";
import { shellSecretsArg } from "./shellSecrets";

describe("shellSecretsArg", () => {
  it("adds nothing for a plain shell", () => {
    const args = { cwd: "/w", cmd: "zsh", ...shellSecretsArg("t1", "tab-1", undefined) };
    expect("shell_secrets" in args).toBe(false);
    expect(shellSecretsArg("t1", "tab-1", "")).toEqual({});
    expect(shellSecretsArg(undefined, "tab-1", "dep")).toEqual({});
  });
  it("names the task, tab and role for a shell with one", () => {
    expect(shellSecretsArg("t1", "tab-1", "dep")).toEqual({ shell_secrets: { task_id: "t1", tab_id: "tab-1", role: "dep" } });
  });
});
