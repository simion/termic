// App-wide task-creation lock, shared by EVERY create path: the New Task
// dialog, quick create, agent races, and the CLI's new_task RPC.
//
// Why (docs/plans/cli.md, Command surface): `task_create_sync` is
// unserialized on the Rust side and its orphan cleanup will
// `remove_dir_all` an unregistered-looking worktree dir, so two same-name
// creates interleaving is DESTRUCTIVE (one deletes the other's
// in-progress worktree). `git worktree add` also contends on the repo
// index (agentRace has always serialized its own loop for that reason).
// All creation flows through this webview, so one promise-chain mutex
// here is the app-wide lock.

let chain: Promise<unknown> = Promise.resolve();

/** Run `fn` after every previously queued create has settled. Errors
 *  propagate to the caller but never poison the chain. */
export function withCreateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
