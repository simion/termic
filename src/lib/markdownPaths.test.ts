import { describe, it, expect } from "vitest";
import { dirnamePosix, resolveTaskHref, headingSlug } from "./markdownPaths";

describe("dirnamePosix", () => {
  it("returns the directory part", () => {
    expect(dirnamePosix("docs/guide/intro.md")).toBe("docs/guide");
    expect(dirnamePosix("docs/readme.md")).toBe("docs");
  });
  it("returns empty string for root-level files", () => {
    expect(dirnamePosix("README.md")).toBe("");
  });
});

describe("resolveTaskHref", () => {
  it("resolves siblings and ./ prefixes", () => {
    expect(resolveTaskHref("docs", "img.png")).toBe("docs/img.png");
    expect(resolveTaskHref("docs", "./img.png")).toBe("docs/img.png");
    expect(resolveTaskHref("", "assets/logo.png")).toBe("assets/logo.png");
  });

  it("collapses .. within the task", () => {
    expect(resolveTaskHref("docs/guide", "../assets/a.png")).toBe("docs/assets/a.png");
    expect(resolveTaskHref("docs", "../assets/a.png")).toBe("assets/a.png");
  });

  it("rejects paths that escape the task root", () => {
    expect(resolveTaskHref("docs", "../../etc/passwd")).toBeNull();
    expect(resolveTaskHref("", "../secrets.txt")).toBeNull();
  });

  it("rejects schemes and protocol-relative URLs", () => {
    expect(resolveTaskHref("docs", "https://example.com/a.png")).toBeNull();
    expect(resolveTaskHref("docs", "mailto:a@b.c")).toBeNull();
    expect(resolveTaskHref("docs", "file:///etc/passwd")).toBeNull();
    expect(resolveTaskHref("docs", "//evil.com/a.png")).toBeNull();
  });

  it("resolves a single leading slash from the task root", () => {
    expect(resolveTaskHref("docs/guide", "/assets/logo.png")).toBe("assets/logo.png");
    expect(resolveTaskHref("", "/docs/guide.md#top")).toBe("docs/guide.md");
    expect(resolveTaskHref("docs", "/")).toBeNull();
    expect(resolveTaskHref("docs", "/../outside.txt")).toBeNull();
  });

  it("strips fragments and queries", () => {
    expect(resolveTaskHref("docs", "other.md#section")).toBe("docs/other.md");
    expect(resolveTaskHref("docs", "img.png?raw=1")).toBe("docs/img.png");
    expect(resolveTaskHref("docs", "#top")).toBeNull();
    expect(resolveTaskHref("docs", "?q=1")).toBeNull();
  });

  it("decodes percent-encoding", () => {
    expect(resolveTaskHref("docs", "my%20image.png")).toBe("docs/my image.png");
    expect(resolveTaskHref("docs", "%zz.png")).toBeNull(); // malformed
  });

  it("percent-encoded dots cannot smuggle a root escape", () => {
    // %2e%2e decodes to ".." — must still be treated as a parent segment,
    // not blindly forwarded to the backend.
    expect(resolveTaskHref("docs", "%2e%2e/%2e%2e/etc/passwd")).toBeNull();
    expect(resolveTaskHref("docs/guide", "%2e%2e/a.png")).toBe("docs/a.png");
  });

  it("normalizes redundant segments", () => {
    expect(resolveTaskHref("docs", ".//a/./b.png")).toBe("docs/a/b.png");
  });

  describe("with member-aware tasks", () => {
    const members = ["backend", "frontend"];

    it("resolves root-relative from the containing member's root, not the wrapper root", () => {
      expect(resolveTaskHref("frontend/docs/guide", "/logo.png", members)).toBe("frontend/logo.png");
      expect(resolveTaskHref("frontend", "/logo.png", members)).toBe("frontend/logo.png");
    });

    it("resolves plain relative paths within the member as usual", () => {
      expect(resolveTaskHref("frontend/docs", "img.png", members)).toBe("frontend/docs/img.png");
    });

    it("does not let .. cross out of the containing member", () => {
      expect(resolveTaskHref("frontend/docs", "../../../outside.txt", members)).toBeNull();
      expect(resolveTaskHref("frontend", "../outside.txt", members)).toBeNull();
      // One level up stays legal as long as it doesn't pop the member root itself.
      expect(resolveTaskHref("frontend/docs/guide", "../assets/a.png", members)).toBe("frontend/docs/assets/a.png");
    });

    it("does not let .. hop from one member into a sibling member", () => {
      expect(resolveTaskHref("frontend", "../backend/secret.env", members)).toBeNull();
    });

    it("falls back to wrapper-root resolution for a path outside any member (the host repo)", () => {
      expect(resolveTaskHref("docs", "/logo.png", members)).toBe("logo.png");
      expect(resolveTaskHref("docs", "../../outside.txt", members)).toBeNull();
    });
  });
});

describe("headingSlug", () => {
  it("matches GitHub-style heading anchors", () => {
    expect(headingSlug("Step 04 — compact housing")).toBe("step-04--compact-housing");
    expect(headingSlug("Hello, World!")).toBe("hello-world");
    expect(headingSlug("  Spaces   everywhere  ")).toBe("spaces-everywhere");
    expect(headingSlug("under_score-kept")).toBe("under_score-kept");
  });

  it("keeps Unicode letters instead of stripping them", () => {
    expect(headingSlug("Café Menu")).toBe("café-menu");
    expect(headingSlug("日本語 Heading")).toBe("日本語-heading");
  });
});
