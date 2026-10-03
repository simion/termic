import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { taskDeliveryValidate, taskDeliveryRequestCheck, taskDeliveryRequestStatus, taskDeliveryRequests, ptyAlive } from "./ipc";
import { deliverMessage } from "./agentSend";
import { waitForAgentReady, hooksOwnStartupReadiness } from "./agentReady";
import { agentTargets } from "./sendComments";
import type { QueueItem } from "./types";
import { i18n } from "./i18n";

/** requestIds with a send under way: a queue drain and a panel "Send now"
 *  racing the same request must not type the prompt twice. */
const inflight = new Set<string>();

/** A send is mid-flight for this request — its durable status is 'queued'
 *  with no queue item, which the panel's orphan sweep must not reap. */
export const deliveryInflight = (requestId: string) => inflight.has(requestId);

/** Used both at confirmation and queue drain. Never resolve a substitute agent. */
export async function sendDeliveryMessage(taskId: string, tabId: string, item: QueueItem): Promise<boolean> {
  const guard = item.delivery;
  if (!guard || inflight.has(guard.requestId)) return false;
  inflight.add(guard.requestId);
  let attempted = false;
  try {
    const getTarget = () => agentTargets(taskId).find(t => t.id === tabId && t.ptyId === guard.ptyId);
    const target = getTarget();
    if (!target?.ptyId || !(await ptyAlive(target.ptyId))) throw new Error(i18n.t("panels:delivery.agentChanged"));
    // A request whose prompt already landed (or whose report already
    // imported) is done — the queue drops its copy without typing again.
    // "uncertain" means a submit may have landed: never resend it silently.
    const status = (await taskDeliveryRequests(taskId)).find(r => r.id === guard.requestId)?.status;
    if (status === "sent" || status === "drafted") return true;
    if (status === "uncertain") {
      useUI.getState().pushToast(i18n.t("panels:delivery.sendUncertain"), "error");
      return false;
    }
    if (status !== "prepared" && status !== "queued" && status !== "failed") {
      throw new Error(i18n.t("panels:delivery.agentChanged"));
    }
    // Close the amend window before the (slow) evidence check: leaving
    // 'prepared' means request_amend can no longer swap drafts/evidence
    // under a prompt that is about to be typed. queued→queued is a no-op,
    // so drained queue items pass through unchanged. The mark must have
    // transitioned from the status we just read — a different 'prev' means
    // a dismiss or a parallel send landed in between and owns it now.
    const prev = await taskDeliveryRequestStatus(taskId, guard.requestId, "queued", null, tabId).then(p => p, () => null);
    if (prev === null || prev !== status) {
      const now = (await taskDeliveryRequests(taskId)).find(r => r.id === guard.requestId)?.status;
      if (now === "sent" || now === "drafted") return true;
      if (now === "uncertain") {
        useUI.getState().pushToast(i18n.t("panels:delivery.sendUncertain"), "error");
        return false;
      }
      throw new Error(i18n.t("panels:delivery.agentChanged"));
    }
    await taskDeliveryValidate(taskId, guard.identities);
    // The prompt embeds provider evidence the user reviewed; a comment
    // edited or a check re-run since then would silently send stale
    // context. Re-probe and compare before typing.
    await taskDeliveryRequestCheck(taskId, guard.requestId);
    // Same wait as a scheduled item: typing into an agent that is still
    // working (or parked on a picker that eats keystrokes) is how prompts
    // get truncated or worse.
    const outcome = await waitForAgentReady(getTarget, { hooksOwnReadiness: hooksOwnStartupReadiness(target.cli, useApp.getState().agentHooksInstalled[target.cli] === true) });
    if (outcome === "lost" || outcome === "blocked") throw new Error(i18n.t("panels:delivery.agentNotReady"));
    const current = getTarget();
    if (!current?.ptyId) throw new Error(i18n.t("panels:delivery.agentChanged"));
    attempted = true;
    await deliverMessage(current.ptyId, item.text, { verifyEcho: outcome !== "ready" });
    if (!getTarget() || !(await ptyAlive(guard.ptyId))) throw new Error(i18n.t("panels:delivery.agentChanged"));
    useApp.getState().patchTab(taskId, tabId, { lastInputAt: Date.now() });
    // A report that imported between the status read and this mark rejects
    // the transition (sent/drafted are terminal) — that race means the send
    // already landed, so it is success, not an error.
    await taskDeliveryRequestStatus(taskId, guard.requestId, "sent", null, tabId).catch(async e => {
      const now = (await taskDeliveryRequests(taskId)).find(r => r.id === guard.requestId)?.status;
      if (now !== "sent" && now !== "drafted") throw e;
    });
    useUI.getState().pushToast(i18n.t("panels:delivery.sent"), "success");
    return true;
  } catch (error) {
    await taskDeliveryRequestStatus(taskId, guard.requestId, attempted ? "uncertain" : "failed", String(error)).catch(() => {});
    useUI.getState().pushToast(attempted ? i18n.t("panels:delivery.sendUncertain") : String(error), "error");
    return attempted; // Never automatically repeat a possibly submitted prompt.
  } finally {
    inflight.delete(guard.requestId);
  }
}
