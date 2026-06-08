import { describe, it, expect } from "vitest";
import { shellName, loginShellArgs } from "@/lib/loginShell";

// ── shellName ─────────────────────────────────────────────────────────

describe("shellName", () => {
  it("returns the basename of an absolute path", () => {
    expect(shellName("/opt/homebrew/bin/fish")).toBe("fish");
    expect(shellName("/bin/zsh")).toBe("zsh");
    expect(shellName("/usr/bin/bash")).toBe("bash");
  });

  it("lowercases the name", () => {
    expect(shellName("/usr/local/bin/FISH")).toBe("fish");
  });

  it("handles a bare name with no slashes", () => {
    expect(shellName("zsh")).toBe("zsh");
  });
});

// ── loginShellArgs ────────────────────────────────────────────────────

describe("loginShellArgs", () => {
  it("returns a plain login shell when there is no command", () => {
    expect(loginShellArgs("/bin/zsh")).toEqual(["-l"]);
    expect(loginShellArgs("/opt/homebrew/bin/fish")).toEqual(["-l"]);
  });

  it("runs the command then execs back into a login shell", () => {
    expect(loginShellArgs("/bin/zsh", "npm run dev")).toEqual([
      "-l", "-i", "-c", "npm run dev; exec /bin/zsh -l",
    ]);
  });

  it("interpolates the resolved shell path into the exec tail", () => {
    // fish users get `exec fish`, not a hard-coded `exec zsh` (#13).
    expect(loginShellArgs("/opt/homebrew/bin/fish", "yarn start")).toEqual([
      "-l", "-i", "-c", "yarn start; exec /opt/homebrew/bin/fish -l",
    ]);
  });

  it("works for bash", () => {
    expect(loginShellArgs("/bin/bash", "make")).toEqual([
      "-l", "-i", "-c", "make; exec /bin/bash -l",
    ]);
  });

  it("omits -i for sh, whose interactive semantics are flaky", () => {
    expect(loginShellArgs("/bin/sh", "./run.sh")).toEqual([
      "-l", "-c", "./run.sh; exec /bin/sh -l",
    ]);
  });

  it("treats an empty command as no command", () => {
    expect(loginShellArgs("/bin/zsh", undefined)).toEqual(["-l"]);
  });
});
