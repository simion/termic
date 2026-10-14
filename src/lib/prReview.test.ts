import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({}));

import { parsePrRef, repoSlug, prReviewPrompt, reviewTaskName, prCommands } from "@/lib/prReview";

describe("parsePrRef", () => {
  it("reads a number in every spelling a user pastes", () => {
    expect(parsePrRef("123")).toBe(123);
    expect(parsePrRef(" #123 ")).toBe(123);
    expect(parsePrRef("!45")).toBe(45);
    expect(parsePrRef("https://github.com/acme/web/pull/77")).toBe(77);
    expect(parsePrRef("https://github.com/acme/web/pull/77/files")).toBe(77);
    expect(parsePrRef("https://gitlab.example.io/acme/web/-/merge_requests/9")).toBe(9);
    expect(parsePrRef("https://dev.azure.com/acme/proj/_git/web/pullrequest/12")).toBe(12);
  });
  it("answers 0 for anything else, never a guess", () => {
    for (const s of ["", "abc", "0", "-3", "1.5", "https://github.com/acme/web/issues/4"]) {
      expect(parsePrRef(s), s).toBe(0);
    }
  });
});

describe("repoSlug", () => {
  it("names the repo of a PR link and of a remote, so the two can be compared", () => {
    expect(repoSlug("https://github.com/Acme/Web/pull/77")).toBe("acme/web");
    expect(repoSlug("git@github.com:acme/web.git")).toBe("acme/web");
    expect(repoSlug("https://github.com/acme/web.git")).toBe("acme/web");
    expect(repoSlug("https://gitlab.example.io/group/sub/web/-/merge_requests/9")).toBe("sub/web");
    expect(repoSlug("https://gitlab.example.io/group/sub/web.git")).toBe("sub/web");
    expect(repoSlug("https://dev.azure.com/acme/proj/_git/web/pullrequest/12")).toBe("proj/web");
  });
  it("has no answer for something that is not a repo URL", () => {
    expect(repoSlug("123")).toBe(null);
    expect(repoSlug("https://github.com/")).toBe(null);
  });
  it("has no answer for a local-path remote, however the platform spells it", () => {
    expect(repoSlug("/Users/u/src/web.git")).toBe(null);
    expect(repoSlug("D:\\a\\src\\web.git")).toBe(null);
    // what Windows Chromium makes of the drive path above
    expect(repoSlug("file:///D:/a/src/web.git")).toBe(null);
    expect(repoSlug("ssh://git@github.com/acme/web.git")).toBe("acme/web");
  });
});

describe("prReviewPrompt", () => {
  const pr = {
    provider: "github" as const, number: 77, title: "Fix login", url: "https://github.com/acme/web/pull/77",
    body: "Closes #3.", head_ref: "fix-login", author: "alice",
  };
  it("puts the PR first and the library prompt after it", () => {
    const out = prReviewPrompt(pr, "Review carefully.");
    expect(out.startsWith("Review GitHub pull request #77: Fix login\nhttps://github.com/acme/web/pull/77\nAuthor: alice")).toBe(true);
    expect(out).toContain("`gh pr diff 77`");
    expect(out).toContain("`gh pr view 77 --comments`");
    expect(out).toContain("Closes #3.");
    expect(out.endsWith("---\n\nReview carefully.")).toBe(true);
  });
  it("says so when there is no description, and cuts a long one with the way to the rest", () => {
    expect(prReviewPrompt({ ...pr, body: "" }, "x")).toContain("(The pull request has no description.)");
    const long = prReviewPrompt({ ...pr, body: "a".repeat(5000) }, "x");
    expect(long).toContain("Description cut here");
    expect(long.length).toBeLessThan(5000);
  });
  it("speaks GitLab's language for a merge request", () => {
    const out = prReviewPrompt({ ...pr, provider: "gitlab" }, "x");
    expect(out).toContain("GitLab merge request !77");
    expect(out).toContain("`glab mr diff 77`");
  });
  it("never passes a control character through to the agent's terminal", () => {
    expect(prReviewPrompt({ ...pr, title: "a\u001b[31mb" }, "x")).not.toContain("\u001b");
  });
});

describe("naming", () => {
  it("keeps one task name per PR, so a second review finds the first", () => {
    expect(reviewTaskName(77)).toBe("review-pr-77");
  });
  it("has commands for every forge", () => {
    expect(prCommands("azure", 3).view).toBe("az repos pr show --id 3");
  });
});
