import { describe, it, expect } from "vitest";
import { explainDirError } from "./dirError";

describe("explainDirError", () => {
  it("names the errno cases a failed dir read actually hits", () => {
    expect(explainDirError("Permission denied (os error 13)").short).toBe("Permission denied");
    expect(explainDirError("No such file or directory (os error 2)").short).toBe("This folder no longer exists");
    expect(explainDirError("Not a directory (os error 20)").short).toBe("This is not a folder any more");
    expect(explainDirError("Too many open files (os error 24)").short).toBe("Too many open files");
  });

  it("recognises the error the path still carries when Rust prefixes it", () => {
    // task_dir_list names the resolved path, so the errno is no longer at the start.
    const e = explainDirError("/Users/x/task/build: Permission denied (os error 13)");
    expect(e.short).toBe("Permission denied");
    expect(e.detail).toBe("/Users/x/task/build: Permission denied (os error 13)");
  });

  it("calls out a link into termic's data, which retrying can never fix", () => {
    const e = explainDirError("path escapes task: vendor -> /Users/u/termic/cli-token");
    expect(e.short).toBe("This folder links into Termic's own data");
  });

  it("falls back to the raw message rather than a generic sentence (GH #250)", () => {
    const e = explainDirError("something nobody mapped yet");
    expect(e.short).toBe("something nobody mapped yet");
    expect(e.detail).toBe("something nobody mapped yet");
  });

  it("takes an Error or any other throwable", () => {
    expect(explainDirError(new Error("Permission denied (os error 13)")).short).toBe("Permission denied");
    expect(explainDirError(undefined).short).toBe("undefined");
    expect(explainDirError("").short).toBe("Unknown error");
  });
});
