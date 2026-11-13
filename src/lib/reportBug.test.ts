import { describe, expect, it } from "vitest";
import { issueBody } from "./reportBug";

describe("issueBody", () => {
  it("fills the version and OS, and asks for the crash log only when there is one", () => {
    const plain = issueBody({ version: "1.2.3", os: "macos aarch64", crashLog: null });
    expect(plain).toContain("Termic version: 1.2.3 (macos aarch64)");
    expect(plain).not.toContain("panic.log");
    const crashed = issueBody({ version: "1.2.3", os: "macos aarch64", crashLog: "/Users/u/x/panic.log" });
    expect(crashed).toContain("panic.log");
    expect(crashed).not.toContain("/Users/u");
  });
});
