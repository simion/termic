import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { slugify, branchify, shortPath, formatBytes, SLUG_FOLD } from "@/lib/utils";
import { derivedBranch, uniqueBranch } from "@/lib/quickTask";

// ── slugify ───────────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips leading and trailing hyphens", () => {
    // Spaces at start/end become hyphens, then get stripped.
    expect(slugify("  hello  ")).toBe("hello");
  });

  it("collapses multiple consecutive non-alphanum chars into one hyphen", () => {
    // Multiple spaces → single hyphen; trailing !! → single hyphen → stripped.
    expect(slugify("fix   bug!!")).toBe("fix-bug");
  });

  it("preserves underscores", () => {
    expect(slugify("my_component")).toBe("my_component");
  });

  it("preserves existing hyphens", () => {
    expect(slugify("foo-bar")).toBe("foo-bar");
  });

  it("collapses dashes a stripped character puts next to a real one", () => {
    // '!' is not [a-z0-9-_] → replaced with '-', landing beside the typed
    // one. A slug is a branch name, and a branch name never carries two
    // dashes in a row.
    expect(slugify("go!-now")).toBe("go-now");
  });

  it("spells out accented letters instead of dropping them (GH #472)", () => {
    expect(slugify("ÄÜÖ Übersicht")).toBe("aeueoe-uebersicht");
    expect(slugify("Straße")).toBe("strasse");
    expect(slugify("mă-duc")).toBe("ma-duc");
    expect(slugify("Łódź")).toBe("lodz");
  });

  it("folds with the same table as the Rust side, byte for byte", () => {
    const rust = readFileSync(resolve(__dirname, "../../termic-proto/src/lib.rs"), "utf8");
    expect(rust).toContain(`pub const SLUG_FOLD: &str = "${SLUG_FOLD}";`);
  });

  it("returns empty string for all-special input", () => {
    expect(slugify("!!!")).toBe("");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("numeric-only string passes through", () => {
    expect(slugify("123")).toBe("123");
  });

  it("never yields a Windows reserved device name (same cases as the Rust side)", () => {
    expect(slugify("CON")).toBe("con-1");
    expect(slugify("nul")).toBe("nul-1");
    expect(slugify("com1")).toBe("com1-1");
    expect(slugify("lpt9")).toBe("lpt9-1");
    expect(slugify("com10")).toBe("com10");
    expect(slugify("console")).toBe("console");
  });
});

// ── the one-dash rule ─────────────────────────────────────────────────
//
// A slug becomes a BRANCH NAME (`derivedBranch`) and a worktree DIRECTORY
// (Rust's `slugify`, on the same name), so a run of dashes is a run of dashes
// in both. The `[^a-z0-9-_]+` above only ever collapsed a run it REPLACED,
// and `-` is a character it keeps: every case below reached `--` by two
// different routes and sailed through.
describe("slugify never emits two dashes in a row", () => {
  const CASES: Array<[string, string]> = [
    // The ordinary one. A space, a typed dash and a space are three separate
    // substitutions, so "a - b" became the branch `a---b`.
    ["a - b", "a-b"],
    ["Fix - auth bug", "fix-auth-bug"],
    // Dashes the user typed themselves.
    ["a--b", "a-b"],
    ["fix -- auth", "fix-auth"],
    ["a------b", "a-b"],
    // A stripped character landing beside a typed dash.
    ["go!-now", "go-now"],
    // Accents are spelled out (GH #472), not dropped.
    ["mă-duc", "ma-duc"],
    ["ÄÜÖ Übersicht", "aeueoe-uebersicht"],
    // Edges still go entirely, and collapsing must not leave one behind.
    ["  --lead", "lead"],
    ["trail--  ", "trail"],
    ["---", ""],
    // Underscores are kept and are not dashes: they never merge.
    ["a__b", "a__b"],
    ["a_-_b", "a_-_b"],
    // ASCII only, and Rust's `slugify` now agrees character for character.
    // It used to be Unicode-aware (`is_alphanumeric`), so the same task name
    // got `café-crème` from one side and `caf-cr-me` from the other.
    ["café crème", "cafe-creme"],
    ["naïve", "naive"],
    ["🚀 ship it", "ship-it"],
    ["日本語 heading", "heading"],
  ];

  for (const [input, want] of CASES) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(want)}`, () => {
      expect(slugify(input)).toBe(want);
      expect(slugify(input)).not.toMatch(/--/);
    });
  }

  it("holds through branchify, per segment and across the joins", () => {
    expect(branchify("feature/my--thing")).toBe("feature/my-thing");
    expect(branchify("a - b/c -- d")).toBe("a-b/c-d");
    // An empty segment is dropped rather than becoming a bare dash.
    expect(branchify("feat//x")).toBe("feat/x");
  });

  it("holds through derivedBranch, prefix included", () => {
    expect(derivedBranch("a - b", "sim")).toBe("sim/a-b");
    expect(derivedBranch("Fix -- the thing", "")).toBe("fix-the-thing");
    expect(derivedBranch("feature/my--thing", "sim")).toBe("feature/my-thing");
  });

  it("refuses a name with nothing a branch can be made of", () => {
    // Not a dash, not a prefix with a trailing slash: nothing. `sim/` is what
    // a prefix plus an empty slug used to compose, and git rejects it several
    // layers later in its own words. The caller turns "" into the message.
    for (const name of ["日本語", "Привет мир", "🚀", "!!!", "---"]) {
      expect(slugify(name), name).toBe("");
      expect(derivedBranch(name, "sim"), name).toBe("");
      expect(derivedBranch(name, ""), name).toBe("");
    }
  });

  it("keeps a qualified name that only PARTLY slugs away", () => {
    // branchify drops empty segments rather than leaving a `//` or a bare
    // dash, so the half that survives is still a usable ref.
    expect(branchify("日本語/fix-auth")).toBe("fix-auth");
    expect(branchify("feat/日本語")).toBe("feat");
  });

  it("leaves the auto-numbering suffix alone", () => {
    // `uniqueBranch` appends `-2`, `-3`… off a stem that now cannot end in a
    // dash, so the bump can never manufacture a `--`.
    expect(uniqueBranch("sim/a-b", ["sim/a-b"])).toBe("sim/a-b-2");
    expect(uniqueBranch("sim/a-b-2", ["sim/a-b-2"])).toBe("sim/a-b-3");
  });
});

// ── branchify ─────────────────────────────────────────────────────────

describe("branchify", () => {
  it("preserves slashes in an already-qualified branch", () => {
    // The #15 case: a Linear branch pasted verbatim stays multi-segment.
    expect(branchify("jarred/special-branch-name")).toBe("jarred/special-branch-name");
  });

  it("slugifies each segment independently", () => {
    expect(branchify("Jarred/Login Fix")).toBe("jarred/login-fix");
  });

  it("drops leading, trailing, and doubled slashes", () => {
    expect(branchify("/feature//login/")).toBe("feature/login");
  });

  it("matches slugify when there is no slash", () => {
    expect(branchify("fix login bug")).toBe(slugify("fix login bug"));
  });

  it("returns empty string for slash-only input", () => {
    expect(branchify("///")).toBe("");
  });

  it("keeps underscores and hyphens within a segment", () => {
    expect(branchify("user/my_cool-feature")).toBe("user/my_cool-feature");
  });
});

// ── shortPath ─────────────────────────────────────────────────────────

describe("shortPath", () => {
  it("returns path unchanged when segments <= default (2)", () => {
    expect(shortPath("/foo/bar")).toBe("/foo/bar");
  });

  it("truncates long paths to last 2 segments with ellipsis prefix", () => {
    expect(shortPath("/a/b/c/d")).toBe("…/c/d");
  });

  it("respects custom segment count", () => {
    expect(shortPath("/a/b/c/d", 3)).toBe("…/b/c/d");
  });

  it("handles root-like single segment without truncation", () => {
    expect(shortPath("/foo")).toBe("/foo");
  });
});

// ── formatBytes ───────────────────────────────────────────────────────

describe("formatBytes", () => {
  it("shows raw bytes below 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(999)).toBe("999 B");
  });

  it("switches to KB at 1000 bytes", () => {
    expect(formatBytes(1000)).toBe("1.0 KB");
    expect(formatBytes(2450)).toBe("2.5 KB");
  });

  it("drops the decimal at 10 units and above", () => {
    expect(formatBytes(9950)).toBe("10 KB");
    expect(formatBytes(245_000)).toBe("245 KB");
  });

  it("steps up through MB and GB", () => {
    expect(formatBytes(1_400_000)).toBe("1.4 MB");
    expect(formatBytes(20_000_000)).toBe("20 MB");
    expect(formatBytes(3_200_000_000)).toBe("3.2 GB");
  });

  it("stays in GB beyond the largest unit", () => {
    expect(formatBytes(5_000_000_000_000)).toBe("5000 GB");
  });
});
