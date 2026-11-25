import { describe, expect, it } from "vitest";
import { releasedAgo, releaseKind } from "./updateNotice";

describe("releaseKind", () => {
  it("calls a step within major.minor a patch, anything else minor or major", () => {
    expect(releaseKind("2.0.7", "2.0.9")).toBe("patch");
    expect(releaseKind("2.0.9", "2.1.0")).toBe("minor");
    expect(releaseKind("1.24.6", "2.0.0")).toBe("major");
    expect(releaseKind(null, "2.0.9")).toBe("major");
  });
});

describe("releasedAgo", () => {
  const now = Date.parse("2026-11-25T09:00:00Z");
  it("counts a release time in minutes, hours, then days", () => {
    expect(releasedAgo("2026-11-25T08:59:30Z", now, "en")).toBe("now");
    expect(releasedAgo("2026-11-25T08:15:00Z", now, "en")).toBe("45 minutes ago");
    expect(releasedAgo("2026-11-25T06:37:23Z", now, "en")).toBe("2 hours ago");
    expect(releasedAgo("2026-11-23T06:00:00Z", now, "en")).toBe("2 days ago");
  });
  it("has nothing to say without a parseable time", () => {
    expect(releasedAgo(undefined, now, "en")).toBeNull();
    expect(releasedAgo("soon", now, "en")).toBeNull();
  });
});
