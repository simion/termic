import path from "node:path";
import { archiveTask, openTask, submitToAgent, typeIntoAgent, waitForAgentReady, waitForAppShell } from "../helpers";

type InputState = { draft: string; submitted: string; submits: number; bytes: number[] };
const agentIds = ["e2e-newline-opencode", "e2e-newline-claude"];

describe("terminal Shift+Enter", () => {
  before(async () => {
    await waitForAppShell();
    await browser.execute(async (command, script, ids) => {
      const t = window.__termic!;
      await t.ipc.agentsSave([
        ...t.useApp.getState().agents.filter((a: { id: string }) => !ids.includes(a.id)),
        ...ids.map((id: string) => ({ id, display_name: "Newline fixture", command, args: [script],
          extends: id.endsWith("opencode") ? "opencode" : "claude", builtin: false, icon_id: "lucide:terminal",
          color: "#9aa0a6", capabilities: {}, sandbox_allowed_paths: [],
          // Do not inherit OpenCode's session-list probe on fixture exit.
          post_launch_capture: { command: "true" } })),
      ]);
      await t.useApp.getState().loadAll();
    }, process.execPath, path.resolve("scripts/fake-newline-agent.mjs"), agentIds);
  });

  after(async () => {
    // Sweep by name too if setup created the task but failed before returning
    // its id. Never leave a live fixture behind in the shared profile.
    const ids = await browser.execute(() => window.__termic!.useApp.getState().tasks
      .filter((t: { name: string }) => t.name.startsWith("e2e-terminal-newline"))
      .map((t: { id: string }) => t.id));
    for (const id of ids) await archiveTask(id);
    await browser.execute(async ids => {
      const t = window.__termic!;
      await t.ipc.agentsSave(t.useApp.getState().agents.filter((a: { id: string }) => !ids.includes(a.id)));
      await t.useApp.getState().loadAll();
    }, agentIds);
  });

  for (const base of ["opencode", "claude"]) {
    describe(`${base}-derived agent`, () => {
      let taskId: string;
      before(async () => {
        taskId = await openTask(`e2e-terminal-newline-${base}`, true, `e2e-newline-${base}`);
        await waitForAgentReady(taskId);
      });

      const state = () => browser.execute(id => {
        const title = window.__termic!.useApp.getState().tabs[id]?.[0]?.liveTitle ?? "";
        return title.startsWith("newline:") ? JSON.parse(title.slice(8)) : null;
      }, taskId) as Promise<InputState | null>;

      it("inserts a newline without submitting or losing the draft", async () => {
        await typeIntoAgent(taskId, "first");
        await browser.waitUntil(async () => (await state())?.draft === "first");

        const prevented = await browser.execute(id => {
          const ta = document.querySelector<HTMLTextAreaElement>(
            `[data-task-id="${id}"] [data-terminal-host] .xterm-helper-textarea`,
          )!;
          ta.focus();
          const key = { key: "Enter", code: "Enter", keyCode: 13, shiftKey: true, bubbles: true, cancelable: true };
          const allowed = ta.dispatchEvent(new KeyboardEvent("keydown", key));
          ta.dispatchEvent(new KeyboardEvent("keyup", key));
          return !allowed;
        }, taskId);
        expect(prevented).toBe(true);
        await browser.waitUntil(async () => (await state())?.draft === "first\n");
        expect(await state()).toEqual({
          draft: "first\n", submitted: "", submits: 0,
          bytes: [102, 105, 114, 115, 116, ...(base === "opencode" ? [0x0a] : [0x5c, 0x0d])],
        });
        expect(await browser.execute(id => window.__termic!.useApp.getState().tabs[id]?.[0]?.composing, taskId)).toBe(true);
      });

      it("still submits both lines with ordinary Enter", async () => {
        await submitToAgent(taskId, "second");
        await browser.waitUntil(async () => (await state())?.submits === 1);
        expect((await state())?.submitted).toBe("first\nsecond");
      });
    });
  }
});
