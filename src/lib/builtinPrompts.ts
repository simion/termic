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
2. Cover the new and changed behavior, plus the edge cases that matter: empty input, missing or null values, error and failure paths, and boundaries.
3. Keep each test focused and readable. Prefer clear, specific assertions over broad snapshots.
4. Run the test suite and make your new tests pass. Do not weaken an assertion or skip a case just to get a green run. Fix the code or the test honestly, and if a change is a real bug, say so.

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

Finish by showing \`git log -1\` for what you committed.`;
