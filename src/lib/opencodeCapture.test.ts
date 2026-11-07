import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { postLaunchCaptureForCli } from "@/lib/agents";

// The fallback table in lib/agents.ts runs before the registry loads, so it
// must capture exactly what the Rust default does. Two copies drifted once
// already: opencode 2 prints `session list` tab-separated, and a `cut -d' '`
// left in either copy resumes into a fresh, empty session.
const here = dirname(fileURLToPath(import.meta.url));
const libRs = readFileSync(resolve(here, "../../src-tauri/src/lib.rs"), "utf8");

describe("opencode session capture", () => {
  it("is the Rust default, character for character", () => {
    const m = libRs.match(/^const OPENCODE_CAPTURE: &str = "(.*)";$/m);
    expect(m, "OPENCODE_CAPTURE not found in lib.rs").not.toBeNull();
    expect(postLaunchCaptureForCli("opencode")?.command).toBe(m![1]);
  });

  it("splits on any blank, not only a space", () => {
    const cmd = postLaunchCaptureForCli("opencode")?.command ?? "";
    expect(cmd).not.toContain("cut -d' '");
    expect(cmd).toContain("awk");
  });
});
