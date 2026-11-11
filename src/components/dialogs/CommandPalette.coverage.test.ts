// The palette went 95 feature commits without gaining a row. Nothing failed,
// because nothing was checking — a palette silently falls behind rather than
// breaking. This is the check.
//
// Every global `open*` action on the UI store is either surfaced by the palette
// or listed below with a reason. Adding a new dialog therefore forces a
// decision at PR time instead of leaving a gap nobody notices for three months.
//
// Source-level rather than render-level on purpose: the rows are built from
// live store state (a task, a project, a sandbox mode), so asserting on a
// rendered list would mean constructing a plausible world and would only prove
// the palette works in THAT world. The invariant here is about coverage, not
// behaviour. Same pattern as cspGuard.test.ts reading tauri.conf.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..", "..");
const uiSrc = readFileSync(join(root, "src", "store", "ui.ts"), "utf8");
const paletteSrc = readFileSync(
  join(root, "src", "components", "dialogs", "CommandPalette.tsx"), "utf8",
);

/** Deliberately absent, with the reason. Anything not here must be reachable. */
const EXCLUDED: Record<string, string> = {
  openCommandPalette: "the palette itself",
  openPromptFire: "needs a specific Prompt object; reached from the prompt palette",
  openRaceCompare: "needs a raceId; reached from the race board",
  openEditCommand: "edits the run command of a specific tab; reached from its menu",
  openEditTask: "edits one MULTI-repo task's member composition; reached from that task's menu, and there is nothing to edit on a single-repo task",
  openCustomCommand: "a New-task variant; reached from the launcher menu",
  openNewTask: "needs a projectId + seed; the palette routes via openProjectPicker",
  openWelcome: "first-run onboarding, not a thing you go looking for",
  openSandbox: "surfaced (task-scoped row)",
  openCageActivity: "surfaced (task-scoped row)",
  openFileFinder: "surfaced",
  openFindInFiles: "surfaced",
  openProjectPicker: "surfaced as New task",
  openShortcutsHelp: "surfaced",
  openChangelog: "surfaced",
  openNewProject: "surfaced",
  openPromptPalette: "surfaced",
  openRace: "surfaced",
  openBroadcast: "surfaced",
  openProjectBroadcast: "surfaced",
  openRunCommands: "surfaced",
  openResumeOverride: "surfaced",
  openScratchExport: "needs a specific scratchpad file and scope; reached from scratchpad editor breadcrumb or tree context menu",
  openNewTabPalette: "needs an active taskId and target pane; reached via Cmd+T or the tab strip + button",
};

/** `open*` action names declared in the UI store's interface. */
function uiOpenActions(): string[] {
  const names = new Set<string>();
  for (const m of uiSrc.matchAll(/^\s{2}(open[A-Z][A-Za-z]*): \(/gm)) names.add(m[1]);
  return [...names].sort();
}

describe("command palette coverage", () => {
  it("finds the UI store's open* actions at all", () => {
    // Guards the regex itself: if the store's shape changes and this stops
    // matching, every assertion below would pass vacuously.
    expect(uiOpenActions().length).toBeGreaterThan(8);
  });

  it("surfaces every global open* action, or names why not", () => {
    const missing = uiOpenActions().filter(
      name => !paletteSrc.includes(`${name}(`) && !(name in EXCLUDED),
    );
    expect(missing,
      `These UI-store actions are neither in the palette nor in EXCLUDED.\n`
      + `Add a row, or add an entry to EXCLUDED saying why not:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps EXCLUDED honest", () => {
    // An exclusion for an action that no longer exists is stale documentation
    // that quietly weakens the check above.
    const actions = new Set(uiOpenActions());
    const stale = Object.keys(EXCLUDED).filter(n => !actions.has(n));
    expect(stale, `EXCLUDED names actions that no longer exist: ${stale.join(", ")}`)
      .toEqual([]);
  });

  it("never puts an irreversible command in Recent", () => {
    // The top Recent row is pre-selected, so Enter on a freshly-opened palette
    // fires it. Archive and Stop must therefore carry noRecent.
    for (const id of ["archive-task", "stop-task"]) {
      const at = paletteSrc.indexOf(`id: "${id}"`);
      expect(at, `command ${id} not found`).toBeGreaterThan(-1);
      const block = paletteSrc.slice(at, at + 600);
      expect(block, `${id} must set noRecent`).toContain("noRecent: true");
    }
  });

  it("does not offer the focus-dependent terminal commands", () => {
    // new-tab / close-tab / clear-terminal each read document.activeElement to
    // decide WHICH pane they act on. From the palette that is the palette's own
    // input, so a row would act on the wrong thing or do nothing at all.
    for (const sc of ["new-tab", "close-tab", "clear-terminal"]) {
      expect(paletteSrc).not.toContain(`shortcutId: "${sc}"`);
    }
  });
});
