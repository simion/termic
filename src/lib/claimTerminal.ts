// A task picked in the sidebar takes its terminal back from another screen
// (a phone, another computer) at once: picking it IS the "Continue here"
// the overlay would otherwise ask for. The sidebar fires this; the task's
// on-screen terminal (TerminalPane, or RemoteTerminal for a paired
// computer's task) does what its overlay's button does. A terminal this
// window already sizes ignores it.

const EVENT = "termic-claim-terminal";

/** Deferred a tick, so a task the click just mounted or showed has its
 *  terminal laid out before it measures the size to take. */
export function claimTerminal(taskId: string): void {
  setTimeout(() => window.dispatchEvent(new CustomEvent(EVENT, { detail: { taskId } })), 0);
}

export function onClaimTerminal(taskId: string, claim: () => void): () => void {
  const on = (e: Event) => { if ((e as CustomEvent<{ taskId: string }>).detail?.taskId === taskId) claim(); };
  window.addEventListener(EVENT, on);
  return () => window.removeEventListener(EVENT, on);
}
