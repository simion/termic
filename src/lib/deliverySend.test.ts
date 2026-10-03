// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ targets: vi.fn(), validate: vi.fn(), check: vi.fn(), alive: vi.fn(), status: vi.fn(), requests: vi.fn(), ready: vi.fn(), send: vi.fn(), patch: vi.fn(), toast: vi.fn() }));
vi.mock("./sendComments", () => ({ agentTargets: mocks.targets }));
vi.mock("./agentSend", () => ({ deliverMessage: mocks.send }));
vi.mock("./agentReady", () => ({ waitForAgentReady: mocks.ready, hooksOwnStartupReadiness: () => false }));
vi.mock("./ipc", () => ({ taskDeliveryValidate: mocks.validate, taskDeliveryRequestCheck: mocks.check, taskDeliveryRequests: mocks.requests, ptyAlive: mocks.alive, taskDeliveryRequestStatus: mocks.status }));
vi.mock("@/store/app", () => ({ useApp: { getState: () => ({ patchTab: mocks.patch, agentHooksInstalled: {} }) } }));
vi.mock("@/store/ui", () => ({ useUI: { getState: () => ({ pushToast: mocks.toast }) } }));
vi.mock("./i18n", () => ({ i18n: { t: (key: string) => key } }));
import { sendDeliveryMessage } from "./deliverySend";
import type { QueueItem } from "./types";
const item: QueueItem = { id: "item", text: "Fix selected evidence", repeat: 1, remaining: 1, delivery: { requestId: "request", identities: [], ptyId: "pty" } };
let current: string;
beforeEach(() => {
  vi.resetAllMocks();
  current = "queued";
  mocks.targets.mockReturnValue([{ id: "agent", ptyId: "pty" }]);
  mocks.validate.mockResolvedValue(undefined); mocks.check.mockResolvedValue(undefined); mocks.alive.mockResolvedValue(true);
  mocks.requests.mockImplementation(async () => [{ id: "request", status: current }]);
  mocks.ready.mockResolvedValue("ready");
  // Mirror the backend: a set_status call returns the status it replaced.
  mocks.status.mockImplementation(async (_t: string, _r: string, s: string) => { const prev = current; current = s; return prev; });
  mocks.send.mockResolvedValue(undefined);
});
it("keeps stale queued evidence without sending to another agent", async () => {
  mocks.validate.mockRejectedValue(new Error("HEAD changed"));
  expect(await sendDeliveryMessage("task", "agent", item)).toBe(false);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.status).toHaveBeenCalledWith("task", "request", "failed", "Error: HEAD changed");
});
it("blocks the send when evidence changed since review", async () => {
  mocks.check.mockRejectedValue(new Error("Evidence changed since review"));
  expect(await sendDeliveryMessage("task", "agent", item)).toBe(false);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.status).toHaveBeenCalledWith("task", "request", "failed", "Error: Evidence changed since review");
});
it("revalidates the exact PTY after provider validation", async () => {
  mocks.validate.mockImplementation(async () => mocks.targets.mockReturnValue([{ id: "agent", ptyId: "replacement" }]));
  expect(await sendDeliveryMessage("task", "agent", item)).toBe(false);
  expect(mocks.send).not.toHaveBeenCalled();
});
it("never automatically repeats an ambiguous submission", async () => {
  mocks.send.mockRejectedValue(new Error("PTY disappeared"));
  expect(await sendDeliveryMessage("task", "agent", item)).toBe(true);
  expect(mocks.status).toHaveBeenCalledWith("task", "request", "uncertain", "Error: PTY disappeared");
});
it("tracks a successful send", async () => {
  expect(await sendDeliveryMessage("task", "agent", item)).toBe(true);
  expect(mocks.send).toHaveBeenCalledWith("pty", item.text, { verifyEcho: false });
  // The sent mark records the receiving tab — the request card's
  // "Open agent" jump target.
  expect(mocks.status).toHaveBeenCalledWith("task", "request", "sent", null, "agent");
});
it("verifies the echo when readiness was only inferred", async () => {
  mocks.ready.mockResolvedValue("deadline");
  expect(await sendDeliveryMessage("task", "agent", item)).toBe(true);
  expect(mocks.send).toHaveBeenCalledWith("pty", item.text, { verifyEcho: true });
});
it("does not type into a blocked agent", async () => {
  mocks.ready.mockResolvedValue("blocked");
  expect(await sendDeliveryMessage("task", "agent", item)).toBe(false);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.status).toHaveBeenCalledWith("task", "request", "failed", "Error: panels:delivery.agentNotReady");
});
it("drops an already-delivered request without typing", async () => {
  mocks.requests.mockResolvedValue([{ id: "request", status: "sent" }]);
  expect(await sendDeliveryMessage("task", "agent", item)).toBe(true);
  expect(mocks.send).not.toHaveBeenCalled();
});
it("never resends an uncertain request", async () => {
  mocks.requests.mockResolvedValue([{ id: "request", status: "uncertain" }]);
  expect(await sendDeliveryMessage("task", "agent", item)).toBe(false);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.status).not.toHaveBeenCalled();
});
it("leaves 'prepared' before the evidence check so amend cannot race the send", async () => {
  current = "prepared";
  const order: string[] = [];
  mocks.status.mockImplementation(async (_t: string, _r: string, s: string) => { order.push(s); const prev = current; current = s; return prev; });
  mocks.check.mockImplementation(async () => { order.push("check"); });
  expect(await sendDeliveryMessage("task", "agent", item)).toBe(true);
  expect(order.indexOf("queued")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("queued")).toBeLessThan(order.indexOf("check"));
});
it("drops the send when a dismiss lands between the read and the claim", async () => {
  current = "prepared";
  // Dismiss (prepared → failed) lands after our status read; the queued
  // mark is still legal (failed → queued allows stale-queue retries), so
  // the returned 'prev' is the only signal the request moved under us.
  mocks.status.mockImplementationOnce(async (_t: string, _r: string, s: string) => { const prev = "failed"; current = s; return prev; });
  expect(await sendDeliveryMessage("task", "agent", item)).toBe(false);
  expect(mocks.send).not.toHaveBeenCalled();
});
it("drops the send when the request moved on before typing", async () => {
  // A parallel send landed between the status read and the queued-mark:
  // re-read the status and skip typing rather than double-send.
  mocks.requests
    .mockResolvedValueOnce([{ id: "request", status: "prepared" }])
    .mockResolvedValueOnce([{ id: "request", status: "sent" }]);
  mocks.status.mockRejectedValueOnce(new Error("illegal transition"));
  expect(await sendDeliveryMessage("task", "agent", item)).toBe(true);
  expect(mocks.send).not.toHaveBeenCalled();
});
it("serializes concurrent sends of the same request", async () => {
  let release!: () => void;
  mocks.send.mockImplementation(() => new Promise<void>(r => { release = r; }));
  const first = sendDeliveryMessage("task", "agent", item);
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalled());
  expect(await sendDeliveryMessage("task", "agent", item)).toBe(false);
  release();
  expect(await first).toBe(true);
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
