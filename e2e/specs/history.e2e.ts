import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dataDir } from "../../wdio.conf.js";
import os from "node:os";
import path from "node:path";
import { clickByText, dismissOverlays, requireTermicApi, snap, waitForAppShell, waitVisible } from "../helpers";

// History's project filter. Cases: the History button opens on All projects;
// picking a project narrows the list and All restores it; the filter ANDs with
// the search box; the sidebar's Resume › More… lands pre-filtered to its
// project (and the plain History button still resets to All); "Empty archive"
// under a filter deletes only that project's archive, then the filter falls
// back to All. Fixture: 6 archived tasks in fixture-repo (one past the
// sidebar's Resume limit, so More… shows) + 1 in a throwaway second project.
describe("history project filter", () => {
  let dir = "";
  let otherId = "";
  let fixtureId = "";
  const fixtureTasks: string[] = [];
  const FX = ["e2e-hist-fx-1", "e2e-hist-fx-2", "e2e-hist-fx-3", "e2e-hist-fx-4", "e2e-hist-fx-5", "e2e-hist-fx-6"];
  const OTHER = "e2e-hist-other-1";

  before(() => {
    // Not "e2e-hist-": the search matches project names case-insensitively,
    // and a random suffix starting "fX" turned the project into a match for
    // the "e2e-hist-fx" search that must find nothing.
    dir = mkdtempSync(path.join(os.tmpdir(), "e2e-histproj-"));
    execSync(
      `git -C "${dir}" init -q && git -C "${dir}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
  });
  after(async () => {
    await browser.execute(async (ids, pid) => {
      const t = window.__termic!;
      for (const id of ids) {
        try { await t.ipc.taskDelete(id); } catch { /* already gone */ }
      }
      if (pid) {
        try { await t.ipc.projectRemove(pid); } catch { /* already gone */ }
      }
      await t.useApp.getState().loadAll();
    }, fixtureTasks, otherId);
    rmSync(dir, { recursive: true, force: true });
  });

  const historyText = async () =>
    (await browser.execute(() => {
      const el = document.querySelector('[data-testid="history-root"]') as HTMLElement | null;
      return el?.innerText ?? "";
    })) as string;

  const waitHistory = async (pred: (text: string) => boolean, msg: string) =>
    browser.waitUntil(async () => pred(await historyText()), { timeout: 8_000, timeoutMsg: msg });

  const filterLabel = async () =>
    (await browser.execute(() => {
      const el = document.querySelector("[data-history-project-filter]") as HTMLElement | null;
      return el?.innerText.trim() ?? "";
    })) as string;

  // Radix opens on pointerdown, so a bare .click() isn't enough.
  const pressOpen = async (sel: string) => {
    await waitVisible(sel);
    await browser.execute((s) => {
      const el = document.querySelector(s) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, sel);
    await waitVisible('[role="menu"]');
  };

  // Matched on `data-project-name`, not on the row's text.
  //
  // The row renders the name plus a trailing count, so matching the row's
  // leading text also matches every name the target is a prefix of. That is
  // unreachable today, and only by luck: the options are sorted by name, a
  // prefix always sorts before its extensions, so `find` happens to reach the
  // right row first. This does not depend on that, and it drops the text
  // parsing along with it. There is deliberately no case for the collision,
  // because no gesture through this UI can produce one.
  const pickFilter = async (label: string) => {
    await pressOpen("[data-history-project-filter]");
    await browser.execute((l) => {
      const row = [...document.querySelectorAll('[role="menuitem"][data-project-name]')]
        .find((e) => e.getAttribute("data-project-name") === l) as HTMLElement | undefined;
      if (!row) throw new Error(`no filter row: ${l}`);
      row.click();
    }, label);
    await browser.waitUntil(async () => (await filterLabel()) === label, {
      timeout: 8_000, timeoutMsg: `filter never showed ${label}`,
    });
  };

  const setSearch = (value: string) =>
    browser.execute((v) => {
      const input = document.querySelector('[data-testid="history-root"] input') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);

  it("opens on All projects from the History button", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    const proj = await browser.execute(async (d) => await window.__termic!.ipc.projectAdd(d), dir);
    otherId = (proj as any).id;
    fixtureId = (await browser.execute(
      () => window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo").id as string,
    )) as string;

    // Repo-root tasks: archiving one never touches a worktree.
    const make = async (pid: string, name: string) =>
      (await browser.execute(async (p, n) => {
        const t = window.__termic!;
        const task = await t.ipc.taskOpenRepo(p, "fakeagent", n);
        await t.ipc.taskArchive(task.id);
        return task.id as string;
      }, pid, name)) as string;
    for (const n of FX) fixtureTasks.push(await make(fixtureId, n));
    fixtureTasks.push(await make(otherId, OTHER));
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());

    await clickByText("Dashboard");
    await clickByText("History");
    await waitHistory((t) => t.includes(OTHER) && t.includes("e2e-hist-fx-6"), "History never listed both projects");
    expect(await filterLabel()).toBe("All projects");
  });

  it("narrows to one project and back to All", async () => {
    const otherName = path.basename(dir);
    await pickFilter(otherName);
    await waitHistory((t) => t.includes(OTHER) && !t.includes("e2e-hist-fx-1"), "filter never narrowed to the other project");

    await pickFilter("fixture-repo");
    await waitHistory((t) => t.includes("e2e-hist-fx-1") && !t.includes(OTHER), "filter never switched to fixture-repo");

    await pickFilter("All projects");
    await waitHistory((t) => t.includes("e2e-hist-fx-1") && t.includes(OTHER), "All projects never restored the list");
  });

  it("combines the project filter with the search box", async () => {
    await pickFilter(path.basename(dir));
    await setSearch("e2e-hist-fx");
    await waitHistory((t) => t.includes("No tasks match your filter."), "search + filter should match nothing");
    await setSearch("e2e-hist");
    await waitHistory((t) => t.includes(OTHER) && !t.includes("e2e-hist-fx-1"), "search should keep the project filter");
    await setSearch("");
  });

  it("lands pre-filtered from the sidebar's Resume › More…", async () => {
    // Leave History on the OTHER project so the landing proves More… sets it.
    await clickByText("Dashboard");
    await pressOpen(`[data-testid="project-new-task-${fixtureId}"]`);
    // Resume lives inside the launcher's More submenu (docs/ui.md "Recent on
    // top, the rest under More"): open that first.
    await browser.execute(() => {
      const more = document.querySelector('[data-testid="launcher-more"]') as HTMLElement | null;
      if (!more) throw new Error("no More submenu trigger");
      const opts = { bubbles: true, pointerType: "mouse" } as any;
      more.dispatchEvent(new PointerEvent("pointerover", opts));
      more.dispatchEvent(new PointerEvent("pointermove", opts));
      more.click();
    });
    await browser.waitUntil(
      () => browser.execute(() =>
        [...document.querySelectorAll('[aria-haspopup="menu"]')].some((e) => e.textContent?.includes("Resume"))),
      { timeout: 8_000, timeoutMsg: "More never offered Resume" },
    );
    await browser.execute(() => {
      const t = [...document.querySelectorAll('[aria-haspopup="menu"]')].find((e) =>
        e.textContent?.includes("Resume"),
      ) as HTMLElement | undefined;
      if (!t) throw new Error("no Resume submenu trigger");
      const opts = { bubbles: true, pointerType: "mouse" } as any;
      t.dispatchEvent(new PointerEvent("pointerover", opts));
      t.dispatchEvent(new PointerEvent("pointermove", opts));
      t.click();
    });
    await browser.waitUntil(
      () => browser.execute(() =>
        [...document.querySelectorAll('[role="menuitem"]')].some((e) => (e as HTMLElement).innerText.trim() === "More…"),
      ),
      { timeout: 8_000, timeoutMsg: "Resume submenu never offered More…" },
    );
    await browser.execute(() => {
      const more = [...document.querySelectorAll('[role="menuitem"]')].find(
        (e) => (e as HTMLElement).innerText.trim() === "More…",
      ) as HTMLElement;
      more.click();
    });
    await waitHistory((t) => t.includes("e2e-hist-fx-1") && !t.includes(OTHER), "More… did not land filtered to fixture-repo");
    expect(await filterLabel()).toBe("fixture-repo");
    await snap("history-project-filter.png");

    // The plain History entry point never carries a stale filter.
    await clickByText("Dashboard");
    await clickByText("History");
    await waitHistory((t) => t.includes("e2e-hist-fx-1") && t.includes(OTHER), "History button should reset to All");
    expect(await filterLabel()).toBe("All projects");
  });

  it("empties only the filtered project's archive, then falls back to All", async () => {
    await pickFilter(path.basename(dir));
    await clickByText("Empty archive");
    await browser.waitUntil(
      () => browser.execute((n) =>
        [...document.querySelectorAll('[role="dialog"]')].some((d) =>
          d.textContent?.includes(`in ${n}`) && d.textContent?.includes("1 archived task")),
        path.basename(dir),
      ),
      { timeout: 8_000, timeoutMsg: "scoped confirm dialog never appeared" },
    );
    await clickByText("Delete all");
    // The other project's only archived task is gone, so the filter has
    // nothing to show and drops back to All; fixture-repo's are untouched.
    await browser.waitUntil(async () => (await filterLabel()) === "All projects", {
      timeout: 10_000, timeoutMsg: "filter never fell back to All",
    });
    await waitHistory((t) => t.includes("e2e-hist-fx-1") && !t.includes(OTHER), "Empty archive should only delete the filtered project");
  });
});

// History as the way back to an old PR: the table shows each task's branch,
// base, and the PR it last knew (number, state, title), and the search finds
// a task by that PR in any spelling, exactly. The PR fields are written into
// the task records here, as the status poll would have before archiving:
// the fixture repo is not on a forge, so no poll can produce them.
describe("history by pull request", () => {
  const ids: string[] = [];
  const WITH_PR = "e2e-hist-pr-fix";
  const NO_PR = "e2e-hist-pr-none-4242";

  const rows = () => browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>("[data-history-row]")].map(r => r.innerText));
  const search = (value: string) => browser.execute((v) => {
    const input = document.querySelector('[data-testid="history-search"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  const shown = async () => (await rows()).map(r => (r.includes(WITH_PR) ? "pr" : r.includes(NO_PR) ? "none" : "other"));

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    for (const name of [WITH_PR, NO_PR]) {
      ids.push(await browser.execute(async (n) => {
        const t = window.__termic!;
        const pid = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo").id;
        const task = await t.ipc.taskOpenRepo(pid, "fakeagent", n);
        await t.ipc.taskArchive(task.id);
        return task.id as string;
      }, name) as string);
    }
    const file = path.join(dataDir, "tasks", `${ids[0]}.json`);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({
      ...rec,
      pr_number: 4242, pr_provider: "github", pr_url: "https://github.com/acme/web/pull/4242",
      pr_title: "Fix the login redirect loop", pr_state: "merged", pr_state_at: "2026-09-30T10:00:00Z",
    }, null, 2));
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    await clickByText("Dashboard");
    await clickByText("History");
    await waitVisible('[data-testid="history-search"]');
  });

  after(async () => {
    await browser.execute(async (list) => {
      const t = window.__termic!;
      for (const id of list) { try { await t.ipc.taskDelete(id); } catch { /* gone */ } }
      await t.useApp.getState().loadAll();
    }, ids);
  });

  it("shows the branch, its base, and the PR's number, last state and title", async () => {
    await search(WITH_PR);
    await browser.waitUntil(async () => (await shown()).join() === "pr", { timeout: 8_000, timeoutMsg: "the PR task never showed alone" });
    const cell = await browser.execute((id) => {
      const row = document.querySelector(`[data-history-row="${id}"]`)!;
      const pr = row.querySelector('[data-testid="history-pr"]') as HTMLElement;
      return { text: pr.innerText, state: pr.querySelector("[data-pr-state]")?.getAttribute("data-pr-state"), pr: row.getAttribute("data-history-pr") };
    }, ids[0]);
    expect(cell.text).toContain("#4242");
    expect(cell.text).toContain("Fix the login redirect loop");
    expect(cell.state).toBe("merged");
    expect(cell.pr).toBe("4242");
    // A task that never had a PR says so with a dash, not an empty cell.
    await search(NO_PR);
    await browser.waitUntil(async () => (await shown()).join() === "none", { timeout: 8_000, timeoutMsg: "the no-PR task never showed alone" });
    expect(await browser.execute((id) =>
      (document.querySelector(`[data-history-row="${id}"]`) as HTMLElement).innerText, ids[1])).toContain("-");
    await search("");
    await snap("history-pr-table.png");
  });

  it("finds the task by its PR in every spelling, and only that PR", async () => {
    for (const q of ["#4242", "https://github.com/acme/web/pull/4242", "login redirect", "merged"]) {
      await search(q);
      await browser.waitUntil(async () => (await shown()).includes("pr"), { timeout: 8_000, timeoutMsg: `"${q}" did not find the PR task` });
      expect(await shown()).not.toContain("none");
    }
    // A bare number finds the PR AND a task that only names that number.
    await search("4242");
    await browser.waitUntil(async () => {
      const s = await shown();
      return s.includes("pr") && s.includes("none");
    }, { timeout: 8_000, timeoutMsg: "a bare number did not find both" });
    // A PR reference is exact: #424 is another PR, and a task merely named
    // with the number is not one.
    await search("#424");
    await browser.waitUntil(async () => (await shown()).filter(x => x !== "other").length === 0,
      { timeout: 8_000, timeoutMsg: "#424 matched PR 4242" });
  });

  it("restores the task found by its PR", async () => {
    await search("#4242");
    await browser.waitUntil(async () => (await shown()).join() === "pr", { timeout: 8_000, timeoutMsg: "the PR task never showed alone" });
    await browser.execute((id) => {
      const row = document.querySelector(`[data-history-row="${id}"]`) as HTMLElement;
      const btn = [...row.querySelectorAll("button")].find(b => b.textContent?.includes("Restore")) as HTMLButtonElement;
      btn.click();
    }, ids[0]);
    await browser.waitUntil(
      () => browser.execute((id) => window.__termic!.useApp.getState().tasks.some((t: any) => t.id === id && !t.archived), ids[0]),
      { timeout: 10_000, timeoutMsg: "the task was not restored" },
    );
    // Restoring kept what it knew about its PR.
    expect(await browser.execute((id) =>
      window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.pr_number, ids[0])).toBe(4242);
    await browser.execute(async (id) => { await window.__termic!.ipc.taskArchive(id); }, ids[0]);
  });
});
