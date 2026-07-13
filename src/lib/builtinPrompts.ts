// Built-in prompt bodies for the prompt library (src/store/prompts.ts), in the
// same voice as the Review prompt (lib/review.ts). All diff-aware prompts open
// with the same way to see the worktree changes via plain git. User-visible
// text, so no em dashes.

// Shared preamble so every diff-aware prompt finds the changes the same way.
// A branch's changes = committed diff vs the base branch + uncommitted work.
const SEE_CHANGES =
  "To see what changed, run `git diff HEAD` (uncommitted) and, for the committed " +
  "work on this branch, `git diff $(git merge-base origin/main HEAD 2>/dev/null " +
  "|| git merge-base main HEAD) HEAD`. Use `git status --short` for untracked files.";

export const WRITE_TESTS_PROMPT = `# Write tests

Add tests for the changes in this branch.

${SEE_CHANGES}

Then:
1. Match the project's existing test framework, file layout, and naming. Read a nearby test file before writing a new one.
2. Test BEHAVIOR through the public interface, not implementation details. Prefer integration-style tests over mock-heavy unit tests; a test that only exercises its own mocks proves nothing.
3. Cover the new and changed behavior, plus the edge cases that matter: empty input, missing or null values, error and failure paths, and boundaries.
4. Keep each test focused and readable. Prefer clear, specific assertions over broad snapshots.
5. Run the test suite and make your new tests pass. Do not weaken an assertion or skip a case just to get a green run. Fix the code or the test honestly, and if a change is a real bug, say so.

If something is not meaningfully testable (pure formatting, comments, generated files), say so instead of padding with trivial tests.`;

export const SECURITY_REVIEW_PROMPT = `# Security review

Audit the changes in this branch for security issues.

${SEE_CHANGES}

Look specifically for:
- Injection: SQL, command, path, or template injection from unsanitized input.
- Secrets: hardcoded credentials, API keys, tokens, or private keys.
- AuthN / AuthZ: missing or incorrect authentication and authorization checks on new endpoints or actions.
- Unsafe input handling: missing validation, unsafe deserialization, SSRF, open redirects, XSS.
- Crypto and randomness: weak algorithms or predictable values used where security matters.
- New dependencies: anything added to lockfiles or manifests; check for typosquats, unpinned versions, and install scripts.
- Unwanted egress: new network calls to hosts the project did not already talk to.

For each finding, give the file and line, a severity (low, medium, high, or critical), the concrete scenario an attacker would use, and a specific fix. Flag only real, exploitable issues introduced or exposed by these changes, not theoretical or style concerns. If you find nothing, say so plainly.`;

export const EXPLAIN_CHANGES_PROMPT = `# Explain the changes

Summarize the changes in this branch for a teammate who is about to review them.

${SEE_CHANGES}

Produce:
1. A two or three sentence high-level summary: what changed and why.
2. A bullet list of the notable changes, grouped by area or file, in plain language (not a line-by-line diff readout).
3. A short "Worth a closer look" note for anything risky, surprising, or that needs a decision.

Keep it concise and skimmable. Do not restate the obvious or pad the summary.`;

export const COMMIT_PROMPT = `# Commit

Commit the current changes.

1. Run \`git status\` and \`git diff\` (and \`git diff --staged\`) to see everything that changed.
2. Stage the changes that belong together. If the working tree mixes unrelated changes, make separate commits rather than one catch-all.
3. Write a Conventional Commits message: a \`type(scope): summary\` subject, where type is one of feat, fix, refactor, docs, test, chore, or perf, with an accurate scope, kept under about 72 characters, and a body that explains the why, not the what.
4. Do not commit scratch files, debug output, secrets, or unrelated edits. Leave those out and mention them.
5. Never pass \`--no-verify\` or \`--no-gpg-sign\`, and never amend or rewrite commits that already exist, unless explicitly told to. If a hook blocks the commit, stop and report the hook's output instead of working around it.

Finish by showing \`git log -1\` for what you committed.`;

export const COMMIT_PUSH_PROMPT = `# Commit and push

Commit the current changes and push the branch.

1. Run \`git status\` and \`git diff\` (and \`git diff --staged\`) to see everything that changed.
2. Stage what belongs together; split unrelated changes into separate commits. Write Conventional Commits messages (\`type(scope): summary\`, body explains the why).
3. Do not commit scratch files, debug output, secrets, or unrelated edits. Never pass \`--no-verify\` or \`--no-gpg-sign\`. If a hook blocks the commit, stop and report its output.
4. Push the current branch to its remote (\`git push\`, or \`git push -u origin <branch>\` for a new branch). Never force-push, and never push to a branch other than the current one.
5. If the push is rejected, report the exact error and stop. Do not rebase, force, or delete anything to make it go through.

Finish by showing \`git log -1\` and the push result.`;

export const VERIFY_PROMPT = `# Verify end to end

Verify that the current changes actually work by running them, not by reading the diff.

${SEE_CHANGES}

Then:
1. Run the project's checks: typecheck, lint, and the test suite. Report exact commands and exit codes.
2. Exercise the changed behavior for real: start the app or service, hit the endpoint with real inputs, run the CLI end to end, or drive the UI flow that changed. Check logs and console for errors while doing it.
3. Reading the diff is not verification, and "it compiles" is not verification. If a step cannot be exercised from here (needs hardware, credentials, or a human eye), say exactly which step and why.

End with one verdict line per claim: [tested] ran it end to end and saw it work, [smoke-passed] checks pass but the behavior was not exercised, or [untested] with what is missing. Never imply something works without saying which of these it is.`;

export const FIX_BUG_PROMPT = `# Fix the bug (reproduce first)

Fix the bug I describe next (or the failure visible in the current output), with reproduction as the first step.

1. REPRODUCE it first: find the exact command, input, or flow that triggers it, run it, and show the failing output. If you cannot reproduce it, stop and say what you tried and what input you need. Never fix from the description alone.
2. Find the root cause, not the symptom. If a fix would just patch over an earlier bad fix, name the underlying cause and fix that instead.
3. Make the smallest fix that resolves the root cause. A bug fix stays a bug fix: no drive-by refactors, renames, or features.
4. Re-run the reproduction from step 1 and show it passing. Run the test suite to catch regressions.
5. Add a regression test that fails without the fix, if the project has a test setup where that is natural.

Report: the repro, the root cause, the fix, and the passing rerun.`;

export const STATUS_PROMPT = `# What is the state?

Orient me in this workspace right now. Do not change anything.

Report, concretely:
1. Branch and git state: current branch, how far from the base branch, uncommitted or untracked files (\`git status --short\`), and the last few commits (\`git log --oneline -5\`).
2. Whether the project currently builds and passes its checks: run the cheapest ones (typecheck, quick tests) and report exit codes.
3. Any work that looks in flight: TODO or FIXME added on this branch, half-wired code, failing tests, uncommitted experiments.
4. The next 2 or 3 obvious moves, each in one line, based on what you found, not speculation.

Keep it short and factual. If something is unknowable from here, say so instead of guessing.`;

export const UPDATE_DOCS_PROMPT = `# Update the docs

Bring the project's documentation in line with what actually changed on this branch.

${SEE_CHANGES}

Then:
1. Find the docs that describe the changed behavior: README, docs/, CHANGELOG if the project keeps one, agent instruction files (CLAUDE.md, AGENTS.md), inline usage examples, and command or flag references.
2. Update only what the changes made stale: renamed commands, changed flags or defaults, new or removed features, changed setup steps. Verify each claim against the code before writing it.
3. Do not invent promises, roadmaps, or features that do not exist, and do not pad with marketing language. Write plainly.
4. If the docs and the code disagree in a way you cannot resolve, flag the conflict instead of picking a side silently.

Show the doc diff at the end.`;

export const RESEARCH_PROMPT = `# Research before answering

For the question I ask next, verify against current sources before answering. Do not answer from memory.

1. If you have web access, search for the specific claim, version, pairing, or price in question and read the primary source (official docs, changelog, repo). If you have no web access, say so up front and clearly mark everything that follows as unverified.
2. Verify the SPECIFIC pairing or version asked about, not a neighboring fact that feels similar. APIs, prices, model names, and defaults change; the feeling of already knowing is exactly when to check.
3. Separate the answer into what is verified (with the source) and what is inference. Never present inference as fact.
4. If sources disagree or the answer is genuinely unsettled, say that plainly instead of picking the most confident-sounding version.`;

export const CONTINUE_PROMPT = `# Continue from last

Pick up the in-flight work in this workspace and continue it.

1. Reconstruct where things stand from the ground truth: \`git status --short\`, \`git log --oneline -10\`, uncommitted diffs, and any handoff, checkpoint, TODO, or plan files in the repo. Treat handoff notes as hypotheses and verify them against the actual code.
2. State in 2 or 3 lines what the in-flight work is and what remains, before touching anything.
3. Continue that work. Do not start something new, re-do finished parts, or "clean up" unrelated code along the way.
4. If the trail is ambiguous (multiple unfinished threads, contradictory state), list the threads and ask which one to continue instead of guessing.`;

export const SIMPLIFY_PROMPT = `# Simplify

Simplify the changes on this branch without changing behavior.

${SEE_CHANGES}

Look for:
- Dead code: unused exports, unreachable branches, leftover debug output, commented-out blocks.
- Premature abstraction: helpers, wrappers, or config used exactly once; three similar lines beat an early abstraction.
- Machinery where a primitive would do: a subsystem or per-frame solver where one property, flag, or existing utility gives the same observable result.
- Comments that narrate WHAT the code does or justify a workaround at length; keep only one-line WHY comments for genuine hidden constraints.

Rules: behavior stays identical, the diff stays small, and the test suite stays green (run it before and after). If something looks simplifiable but risky, list it instead of touching it.`;
