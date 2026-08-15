// `termic://` deep-link parsing (GH #192).
//
// The security-relevant cases are the ones that must NOT parse: an unknown
// project (a link must never be able to point Termic at a repo the user
// didn't register, and must never fall back to "the first project"), and an
// oversized prompt. Those are pinned here because they're the whole reason
// the link opens a dialog instead of creating a task.

import { describe, it, expect } from "vitest";
import { parseDeepLink, MAX_PROMPT_CHARS, MAX_NAME_CHARS } from "./deepLink";
import type { Project, Task } from "./types";

function project(over: Partial<Project> & { id: string; name: string }): Project {
  return {
    root_path: `/repos/${over.name}`,
    tasks_path: `/tasks/${over.name}`,
    base_branch: "main",
    remote: "",
    preview_url: "",
    files_to_copy: [],
    setup_script: "",
    run_script: "",
    archive_script: "",
    default_cli: "claude",
    created: "2026-01-01T00:00:00Z",
    ...over,
  } as Project;
}

const PROJECTS: Project[] = [
  project({ id: "p-web", name: "web" }),
  project({ id: "p-api", name: "API" }),
  project({ id: "p-notes", name: "notes", non_git: true }),
];

function task(over: Partial<Task> & { id: string; name: string; project_id: string }): Task {
  return {
    branch: "feature/x",
    base_branch: "main",
    path: `/tasks/${over.id}`,
    cli: "claude",
    port: 0,
    created: "2026-01-01T00:00:00Z",
    archived: false,
    ...over,
  } as Task;
}

const TASKS: Task[] = [
  task({ id: "t-1", name: "fix-login", project_id: "p-web" }),
  task({ id: "t-2", name: "Shared-Name", project_id: "p-web" }),
  task({ id: "t-3", name: "shared-name", project_id: "p-api" }),
  task({ id: "t-4", name: "old-work", project_id: "p-web", archived: true }),
];

/** Unwrap a result expected to be ok, with a readable failure otherwise. */
function ok(url: string, projects = PROJECTS, tasks = TASKS) {
  const r = parseDeepLink(url, projects, tasks);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.value;
}
function err(url: string, projects = PROJECTS, tasks = TASKS) {
  const r = parseDeepLink(url, projects, tasks);
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.value)}`);
  return r.error;
}
/** `new` results, narrowed so the field assertions typecheck. */
function okNew(url: string, projects = PROJECTS) {
  const v = ok(url, projects);
  if (v.action !== "new") throw new Error(`expected a new link, got ${v.action}`);
  return v;
}

describe("parseDeepLink — happy path", () => {
  it("resolves a project by name and carries the basic fields", () => {
    expect(okNew("termic://new?project=web&name=fix-login")).toEqual({
      action: "new",
      projectId: "p-web",
      name: "fix-login",
      prompt: undefined,
      agent: undefined,
      mode: undefined,
      base: undefined,
    });
  });

  it("resolves a project by id as well as by name", () => {
    expect(okNew("termic://new?project=p-web").projectId).toBe("p-web");
  });

  it("matches project names case-insensitively", () => {
    expect(okNew("termic://new?project=api").projectId).toBe("p-api");
    expect(okNew("termic://new?project=API").projectId).toBe("p-api");
  });

  it("prefers an exact id over a name match", () => {
    // A project literally named after another's id must not shadow it.
    const tricky = [...PROJECTS, project({ id: "x", name: "p-web" })];
    expect(okNew("termic://new?project=p-web", tricky).projectId).toBe("p-web");
  });

  it("parses the issue's example URL end to end", () => {
    const v = okNew(
      "termic://new?project=web&worktree=1&name=feature/this-is-a-test"
        + "&p=" + encodeURIComponent("repeat back to me: hello mammoth"),
    );
    expect(v).toEqual({
      action: "new",
      projectId: "p-web",
      name: "feature/this-is-a-test",
      prompt: "repeat back to me: hello mammoth",
      agent: undefined,
      mode: "worktree",
      base: undefined,
    });
  });

  it("accepts the scheme without slashes (termic:new?…)", () => {
    expect(okNew("termic:new?project=web").projectId).toBe("p-web");
  });

  it("ignores unknown query params instead of failing", () => {
    expect(okNew("termic://new?project=web&somethingNew=1&other=x").projectId).toBe("p-web");
  });

  it("preserves newlines and punctuation in an encoded prompt", () => {
    const body = "Fix this:\n  - step one\n  - step two & three (100% urgent)";
    expect(okNew(`termic://new?project=web&prompt=${encodeURIComponent(body)}`).prompt).toBe(body);
  });
});

describe("parseDeepLink — project resolution is a hard gate", () => {
  it("rejects a project that is not registered", () => {
    expect(err("termic://new?project=nope")).toMatch(/No project named "nope"/);
  });

  it("does NOT fall back to the first project when the name is unknown", () => {
    // The whole point: a link must not be able to aim at the wrong repo.
    expect(parseDeepLink("termic://new?project=nope", PROJECTS, TASKS).ok).toBe(false);
  });

  it("rejects a link with no project at all", () => {
    expect(err("termic://new")).toMatch(/needs a project/);
    expect(err("termic://new?project=")).toMatch(/needs a project/);
    expect(err("termic://new?project=%20%20")).toMatch(/needs a project/);
  });

  it("rejects every link when no projects are registered", () => {
    expect(err("termic://new?project=web", [])).toMatch(/No project named/);
  });
});

describe("parseDeepLink — rejected shapes", () => {
  it("rejects a non-termic scheme", () => {
    expect(err("https://evil.example/new?project=web")).toMatch(/Unsupported scheme/);
    expect(err("file:///etc/passwd")).toMatch(/Unsupported scheme/);
  });

  it("rejects an unknown action rather than defaulting to new", () => {
    expect(err("termic://archive?project=web")).toMatch(/Unknown termic:\/\/ action "archive"/);
  });

  it("rejects a malformed URL", () => {
    expect(err("not a url at all")).toMatch(/Not a valid URL/);
  });

  it("rejects an unknown mode", () => {
    expect(err("termic://new?project=web&mode=sideways")).toMatch(/Unknown mode "sideways"/);
  });

  it("rejects a worktree ask on a non-git project", () => {
    expect(err("termic://new?project=notes&mode=worktree")).toMatch(/non-git/);
    expect(err("termic://new?project=notes&worktree=1")).toMatch(/non-git/);
  });

  it("allows a main-checkout task on a non-git project", () => {
    expect(okNew("termic://new?project=notes&mode=main").mode).toBe("repo_root");
  });
});

describe("parseDeepLink — length caps", () => {
  it("accepts a prompt exactly at the cap", () => {
    const body = "x".repeat(MAX_PROMPT_CHARS);
    expect(okNew(`termic://new?project=web&prompt=${body}`).prompt).toHaveLength(MAX_PROMPT_CHARS);
  });

  it("rejects (never truncates) a prompt over the cap", () => {
    const body = "x".repeat(MAX_PROMPT_CHARS + 1);
    expect(err(`termic://new?project=web&prompt=${body}`)).toMatch(/Prompt is too long/);
  });

  it("rejects a name over the cap", () => {
    expect(err(`termic://new?project=web&name=${"n".repeat(MAX_NAME_CHARS + 1)}`))
      .toMatch(/Task name is too long/);
  });
});

describe("parseDeepLink — field aliases and normalization", () => {
  it("accepts both prompt and p, preferring prompt", () => {
    expect(okNew("termic://new?project=web&p=short").prompt).toBe("short");
    expect(okNew("termic://new?project=web&prompt=first&p=second").prompt).toBe("first");
  });

  it("accepts both agent and cli", () => {
    expect(okNew("termic://new?project=web&agent=codex").agent).toBe("codex");
    expect(okNew("termic://new?project=web&cli=codex").agent).toBe("codex");
  });

  it("maps mode=main and mode=repo_root to repo_root", () => {
    expect(okNew("termic://new?project=web&mode=main").mode).toBe("repo_root");
    expect(okNew("termic://new?project=web&mode=repo_root").mode).toBe("repo_root");
  });

  it("treats worktree=0/false as the main checkout", () => {
    expect(okNew("termic://new?project=web&worktree=0").mode).toBe("repo_root");
    expect(okNew("termic://new?project=web&worktree=false").mode).toBe("repo_root");
    expect(okNew("termic://new?project=web&worktree=true").mode).toBe("worktree");
    // The other spellings people actually type in a URL.
    expect(okNew("termic://new?project=web&worktree=yes").mode).toBe("worktree");
    expect(okNew("termic://new?project=web&worktree=ON").mode).toBe("worktree");
    expect(okNew("termic://new?project=web&worktree=no").mode).toBe("repo_root");
  });

  it("refuses a worktree value it does not understand, like an unknown mode", () => {
    // The asymmetry this replaces: `mode=sideways` errored while
    // `worktree=sideways` quietly built a repo_root task — the OPPOSITE
    // shape from the one the link asked for, with nothing on screen saying
    // so. A typo in a URL is invisible; it must not silently change what
    // gets created.
    expect(err("termic://new?project=web&worktree=sideways")).toMatch(/Unknown worktree value/);
    expect(err("termic://new?project=web&worktree=2")).toMatch(/Unknown worktree value/);
    expect(err("termic://new?project=web&worktree=maybe")).toMatch(/1\/0, true\/false, yes\/no/);
  });

  it("leaves mode unset when neither param is given, so the dialog keeps its default", () => {
    expect(okNew("termic://new?project=web").mode).toBeUndefined();
  });

  it("trims whitespace and treats blank fields as absent", () => {
    const v = okNew("termic://new?project=%20web%20&name=%20%20&prompt=%20hi%20&base=%20%20");
    expect(v.projectId).toBe("p-web");
    expect(v.name).toBeUndefined();
    expect(v.prompt).toBe("hi");
    expect(v.base).toBeUndefined();
  });
});

describe("parseDeepLink — open", () => {
  it("resolves a task by name within a project", () => {
    expect(ok("termic://open?project=web&task=fix-login"))
      .toEqual({ action: "open", taskId: "t-1" });
  });

  it("resolves a task by id, with or without a project", () => {
    expect(ok("termic://open?task=t-1")).toEqual({ action: "open", taskId: "t-1" });
    expect(ok("termic://open?project=web&task=t-1")).toEqual({ action: "open", taskId: "t-1" });
  });

  it("resolves a bare unambiguous name with no project", () => {
    expect(ok("termic://open?task=fix-login")).toEqual({ action: "open", taskId: "t-1" });
  });

  it("matches task names case-insensitively", () => {
    expect(ok("termic://open?project=web&task=FIX-LOGIN"))
      .toEqual({ action: "open", taskId: "t-1" });
  });

  // Two projects, same task name: opening the wrong repo's task silently is
  // the same class of mistake `new` refuses to make, so this must ask.
  it("refuses an ambiguous bare name and names the candidates", () => {
    const e = err("termic://open?task=shared-name");
    expect(e).toMatch(/More than one task is named "shared-name"/);
    expect(e).toMatch(/web/);
    expect(e).toMatch(/API/);
  });

  it("disambiguates the same name with a project scope", () => {
    expect(ok("termic://open?project=web&task=shared-name"))
      .toEqual({ action: "open", taskId: "t-2" });
    expect(ok("termic://open?project=API&task=shared-name"))
      .toEqual({ action: "open", taskId: "t-3" });
  });

  // "Open" means resume work. Surfacing something the user archived would be
  // a surprise, and the PM link that named it is simply stale.
  it("does not match an archived task", () => {
    expect(err("termic://open?task=old-work")).toMatch(/No open task named "old-work"/);
  });

  it("refuses a task that does not exist, scoped or not", () => {
    expect(err("termic://open?task=nope")).toMatch(/No open task named "nope"/);
    expect(err("termic://open?project=web&task=nope")).toMatch(/No open task named "nope" in web/);
  });

  it("refuses an unregistered project scope rather than widening the search", () => {
    // Without the gate this would fall back to a global name search and
    // could open a task in a project the link never named.
    expect(err("termic://open?project=nope&task=fix-login")).toMatch(/No project named "nope"/);
  });

  it("refuses a link with no task", () => {
    expect(err("termic://open")).toMatch(/needs a task/);
    expect(err("termic://open?project=web")).toMatch(/needs a task/);
    expect(err("termic://open?task=%20%20")).toMatch(/needs a task/);
  });

  it("refuses every open link when no tasks exist", () => {
    expect(err("termic://open?task=fix-login", PROJECTS, [])).toMatch(/No open task named/);
  });

  it("names both actions when the action is unknown", () => {
    expect(err("termic://opne?task=fix-login")).toMatch(/supported: new, open/);
  });
});
