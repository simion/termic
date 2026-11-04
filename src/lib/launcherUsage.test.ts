import { describe, expect, it } from "vitest";
import { launcherLastUsed, launcherVisibilityOf, parseLauncherVisibility, pinnedFirst, RECENT_MS, splitLauncher } from "./launcherUsage";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const opts = (pinned: string[] = [], folded: string[] = ["race"]) =>
  ({ pinned: new Set(pinned), folded: new Set(folded), now: NOW });

describe("splitLauncher", () => {
  const ids = ["claude", "codex", "gemini", "shell", "custom", "review", "race"];

  it("keeps what was used in the last 7 days on top and folds the rest", () => {
    const used = { claude: NOW - DAY, shell: NOW - 6 * DAY, codex: NOW - 8 * DAY };
    expect(splitLauncher(ids, used, opts())).toEqual({
      top: ["claude", "shell"],
      more: ["codex", "gemini", "custom", "review", "race"],
    });
  });

  it("keeps the project default on top however old, and Race always in More", () => {
    const used = { claude: NOW - DAY, race: NOW };
    const { top, more } = splitLauncher(ids, used, opts(["gemini"]));
    expect(top).toEqual(["claude", "gemini"]);
    expect(more.at(-1)).toBe("race");
  });

  it("folds nothing but Race for someone with no history yet", () => {
    expect(splitLauncher(ids, {}, opts())).toEqual({ top: ids.slice(0, -1), more: ["race"] });
  });

  it("does not make a submenu for one entry, and keeps its place", () => {
    const used = { claude: NOW, codex: NOW, shell: NOW, custom: NOW, review: NOW };
    expect(splitLauncher(["claude", "codex", "gemini", "shell", "custom", "review"], used, opts([], [])))
      .toEqual({ top: ["claude", "codex", "gemini", "shell", "custom", "review"], more: [] });
  });

  it("treats exactly 7 days ago as old", () => {
    expect(splitLauncher(["a", "b", "c"], { a: NOW - RECENT_MS, b: NOW }, opts([], [])).more).toEqual(["a", "c"]);
  });
});

describe("launcherLastUsed", () => {
  it("takes the newest of the menu stamp and any task created with that cli", () => {
    const tasks = [
      { cli: "codex", created: "2026-10-14T00:00:00Z" },
      { cli: "codex", created: "2026-10-01T00:00:00Z" },
      { cli: "claude", created: "not a date" },
    ];
    const got = launcherLastUsed(tasks, { codex: 1, review: 5 });
    expect(got.codex).toBe(Date.parse("2026-10-14T00:00:00Z"));
    expect(got.review).toBe(5);
    expect(got.claude).toBeUndefined();
  });
});

describe("launcher visibility", () => {
  it("defaults the standard agents to Always shown, Race to More, the rest to Auto", () => {
    expect(launcherVisibilityOf("claude", {})).toBe("shown");
    expect(launcherVisibilityOf("agy", {})).toBe("shown");
    expect(launcherVisibilityOf("race", {})).toBe("more");
    expect(launcherVisibilityOf("gemini", {})).toBe("auto");
    expect(launcherVisibilityOf("codex", { codex: "more" })).toBe("more");
  });

  it("puts pinned entries first and keeps everyone else's order", () => {
    expect(pinnedFirst(["claude", "codex", "shell", "gemini"], { gemini: "pinned", shell: "pinned" }))
      .toEqual(["shell", "gemini", "claude", "codex"]);
  });

  it("parses the stored map and drops anything that is not a placement", () => {
    expect(parseLauncherVisibility('{"a":"pinned","b":"bogus","c":"more"}')).toEqual({ a: "pinned", c: "more" });
    expect(parseLauncherVisibility("not json")).toEqual({});
    expect(parseLauncherVisibility("[]")).toEqual({});
  });
});
