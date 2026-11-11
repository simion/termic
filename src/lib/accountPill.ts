// The account pill's decisions, as pure functions (GH #278).
//
// Split out of the component because this repo tests logic rather than
// rendered output: there is no React testing library here, and the rules below
// are the part worth pinning. The component is then a thin renderer over them.

import type { AgentAccountsView } from "@/lib/types";

/** Should the pill render at all?
 *
 *  ONE named account is the threshold. With ZERO there is no account concept
 *  at all: the user has "whatever the agent is logged into" and has never
 *  named it, so the pill would have to invent a label, which is the "Default
 *  forever" trap the profiles chip avoids by not existing yet.
 *
 *  It was TWO, on the grounds that one account is nothing to switch between.
 *  That was wrong in use: naming a credential set is the moment the user
 *  starts thinking in accounts, and the footer staying empty afterwards reads
 *  as the feature not having worked. The pill also carries "add another",
 *  so at one account it is the thing that gets you to two. */
export function pillVisible(view: AgentAccountsView | null): boolean {
  return !!view && view.supported && view.accounts.length >= 1;
}

/** What the pill says: the task's own account if it has been switched,
 *  otherwise the agent's default. `null` when neither applies, which the
 *  caller renders as the agent's ordinary login. */
export function pillLabel(view: AgentAccountsView | null, current: string | null): string | null {
  if (current) return current;
  return view?.accounts.find(a => a.isDefault)?.name ?? null;
}

/** What to show for an account NAME: its label, else the name itself. Names
 *  stay the identity everywhere (compare names, never labels). */
export function accountLabel(view: AgentAccountsView | null, name: string): string {
  return view?.accounts.find(a => a.name === name)?.label ?? name;
}

/** What the pill SHOWS (as labels): the account in use NOW, and the one it is moving to.
 *
 *  `now` is what the pill prints, and it is the RUNNING account rather than
 *  the configured one, because the usage numbers beside the pill are that
 *  account's: printing the configured name would caption Work's 97% with the
 *  word "Client".
 *
 *  `next` is NOT printed. It briefly was, as `Work -> Client`, and two names
 *  in a footer chip read as a state nobody asked about; picking an account now
 *  offers an immediate restart, so the staged state lasts seconds rather than
 *  the rest of a session. It survives here for the TOOLTIP, which is where a
 *  rare state belongs. */
export function pillText(
  view: AgentAccountsView | null,
  current: string | null,
  running: string | null,
): { now: string; next: string | null } {
  const configured = pillLabel(view, current);
  // `running === null` means "the agent's ordinary login", which is a REAL
  // answer, not a missing one. The adopted account is the name for exactly
  // that login, so it is what the pill should say.
  //
  // Falling through to the CONFIGURED account here was a lie: with a switch
  // staged and not yet restarted, the process is still on the old login while
  // `configured` already names the new one, so the pill claimed an account
  // the agent had never run as.
  const now = running ?? view?.adoptedAccount ?? configured;
  return {
    now: now ? accountLabel(view, now) : "default",
    next: now && configured && configured !== now ? accountLabel(view, configured) : null,
  };
}

/** Which realm's store a task's login lives in. A caged task reads the
 *  directory termic mounts into the container, never the host's config dir, so
 *  reporting the host's would name a different account entirely. */
export const realmForTask = (docker: boolean): boolean => docker;

/** Accounts in the order the popover lists them: the order they were ADDED,
 *  unchanged.
 *
 *  It used to float the account in use to the top, so "which am I on" was the
 *  first row rather than a hunt. That reads well in a screenshot and badly in
 *  use: the list reorders itself under the cursor every time you switch, so
 *  the row you want is never where it was last time and muscle memory never
 *  forms. A tick marks the current one, which answers the same question
 *  without moving anything.
 */
export function pillOrder(view: AgentAccountsView): AgentAccountsView["accounts"] {
  return view.accounts;
}
