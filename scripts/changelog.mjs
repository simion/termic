#!/usr/bin/env node
// CHANGELOG.md is the single human-authored source of truth (Keep a Changelog
// format). This module derives the machine artifact the app consumes and gates
// the release on a well-formed top entry. It is the ONLY place that knows the
// markdown <-> json mapping.
//
// Per-version shape in CHANGELOG.md:
//
//   ## [0.15.0] - 2026-06-19
//
//   One-sentence summary (the lead paragraph — this becomes `summary`).
//
//   ### Features
//   - a bullet
//   ### Bug fixes
//   - another bullet
//
// The derived `changelog.json` is intentionally SLIM — {version, date, summary}
// only. The rich notes (sections/bullets) render straight from the markdown:
//   * in-app   — the Changelog dialog fetches changelog.md and renders it.
//   * website  — /changelog renders changelog.md.
// So the json exists purely for the sidebar Update card's one-line summary and
// the what's-new version compare in src/store/update.ts.
//
// CLI (used by scripts/release.sh):
//   node scripts/changelog.mjs generate            # write slim changelog.json
//   node scripts/changelog.mjs parse               # print parsed entries (debug)
//   node scripts/changelog.mjs release-gate <new>  # Path A: scaffold/stamp/validate/generate
//   node scripts/changelog.mjs merge-gate <new> <cur>  # Path B: validate-in-place/stamp/generate
//   node scripts/changelog.mjs notes <version>     # print one version's markdown body (for GH release notes)
//
// The gate subcommands print a single status token on stdout that release.sh
// branches on: OK | EMPTY | NOT_BUMPED | MISMATCH:<v> | INCOMPLETE. Warnings
// (e.g. summary too long) go to stderr. Exit code is always 0 — the status
// token is the contract.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MD_PATH = join(ROOT, "CHANGELOG.md");
const JSON_PATH = join(ROOT, "changelog.json");

// A version heading: "## [0.15.0] - 2026-06-19" (date optional / may be blank).
const HEADING_RE = /^##\s+\[([^\]]+)\](?:\s*-\s*(.*?))?\s*$/;

/** Read CHANGELOG.md as a raw string. */
function readMd() {
  return readFileSync(MD_PATH, "utf8");
}

/** Parse the markdown into per-version blocks. Returns an array (newest first,
 *  i.e. document order) of:
 *    { version, date, summary, hasItems, startLine, headingDate }
 *  `summary` is the lead paragraph (lines after the heading, before the first
 *  ### subsection or the next ## heading). `hasItems` is true if the block has
 *  at least one "- " bullet. */
export function parse(md = readMd()) {
  const lines = md.split("\n");
  const entries = [];
  let cur = null;

  const pushSummaryDone = () => {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(HEADING_RE);
    if (m) {
      if (cur) entries.push(cur);
      cur = {
        version: m[1].trim(),
        date: (m[2] ?? "").trim(),
        summaryLines: [],
        sawSubsection: false,
        hasItems: false,
        startLine: i,
      };
      continue;
    }
    if (!cur) continue; // preamble before the first version heading
    if (/^###\s+/.test(line)) {
      cur.sawSubsection = true;
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      cur.hasItems = true;
      continue;
    }
    // Summary = non-empty prose lines before the first subsection.
    if (!cur.sawSubsection && line.trim()) {
      cur.summaryLines.push(line.trim());
    }
  }
  if (cur) entries.push(cur);
  pushSummaryDone();

  return entries.map(e => ({
    version: e.version,
    date: e.date,
    summary: e.summaryLines.join(" ").trim(),
    hasItems: e.hasItems,
    startLine: e.startLine,
  }));
}

/** Slim entries for the json artifact: {version, date, summary}. */
export function slimEntries(md = readMd()) {
  return parse(md).map(({ version, date, summary }) => ({ version, date, summary }));
}

/** Write the derived slim changelog.json. Matches the prior file's formatting
 *  (2-space indent, trailing newline) so diffs stay small. */
export function generate() {
  const json = { versions: slimEntries() };
  writeFileSync(JSON_PATH, JSON.stringify(json, null, 2) + "\n");
  return json;
}

/** Rewrite the date on the heading for `version` to `date` (today). No-op if
 *  the version is not found. Returns true if a change was written. */
export function stamp(version, date) {
  const lines = readMd().split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m && m[1].trim() === version) {
      const next = `## [${version}] - ${date}`;
      if (lines[i] !== next) {
        lines[i] = next;
        changed = true;
      }
      break;
    }
  }
  if (changed) writeFileSync(MD_PATH, lines.join("\n"));
  return changed;
}

/** Path A only: if the top entry isn't `version`, prepend a stub block (empty
 *  summary + one empty Features bullet) so the author has a slot to fill. The
 *  subsequent validate() reports INCOMPLETE until the summary is written. */
export function scaffold(version) {
  const md = readMd();
  const top = parse(md)[0];
  if (top && top.version === version) return false;

  const stub = `## [${version}] - \n\n\n### Features\n- \n`;
  const lines = md.split("\n");
  // Insert before the first existing version heading; if none, after preamble.
  let idx = lines.findIndex(l => HEADING_RE.test(l));
  if (idx === -1) idx = lines.length;
  const before = lines.slice(0, idx).join("\n").replace(/\n*$/, "\n\n");
  const after = lines.slice(idx).join("\n");
  writeFileSync(MD_PATH, before + stub + "\n" + after);
  return true;
}

/** Validate the TOP entry: non-empty summary AND at least one bullet.
 *  Warns (stderr) if the summary exceeds 15 words (it renders in a narrow
 *  sidebar card). Returns "OK" | "EMPTY" | "INCOMPLETE". */
function validateTop() {
  const top = parse()[0];
  if (!top) return "EMPTY";
  const haveSummary = top.summary.length > 0;
  if (!haveSummary || !top.hasItems) return "INCOMPLETE";
  const words = top.summary.split(/\s+/).length;
  if (words > 15) {
    process.stderr.write(
      `  ⚠ summary is ${words} words (target ≤15) — it renders in a narrow sidebar card.\n`,
    );
  }
  return "OK";
}

/** Print one version's markdown body (everything under its heading, excluding
 *  the heading line itself, up to the next ## heading). Used to build the
 *  GitHub Release notes. Prints nothing if the version is absent. */
function printNotes(version) {
  const lines = readMd().split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m && m[1].trim() === version) { start = i + 1; break; }
  }
  if (start === -1) return;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i])) { end = i; break; }
  }
  process.stdout.write(lines.slice(start, end).join("\n").trim() + "\n");
}

// ─── CLI ────────────────────────────────────────────────────────────────
const [cmd, a, b] = process.argv.slice(2);

switch (cmd) {
  case "parse":
    process.stdout.write(JSON.stringify(parse(), null, 2) + "\n");
    break;

  case "generate":
    generate();
    process.stdout.write("OK\n");
    break;

  case "notes":
    printNotes(a);
    break;

  case "release-gate": {
    // Path A: scaffold a stub if the top entry is missing, stamp today's date,
    // validate, and (when OK) regenerate the json.
    const NEW = a;
    const today = b || new Date().toISOString().slice(0, 10);
    scaffold(NEW);
    stamp(NEW, today);
    const status = validateTop();
    if (status === "OK") generate();
    process.stdout.write(status);
    break;
  }

  case "merge-gate": {
    // Path B: the top entry must already be bumped in place to NEW. We never
    // scaffold here. Stamp the date, validate, regenerate.
    const NEW = a;
    const CUR = b;
    const today = process.argv[5] || new Date().toISOString().slice(0, 10);
    const top = parse()[0];
    let status;
    if (!top) status = "EMPTY";
    else if (top.version === CUR) status = "NOT_BUMPED";
    else if (top.version !== NEW) status = "MISMATCH:" + top.version;
    else {
      stamp(NEW, today);
      status = validateTop();
      if (status === "OK") generate();
    }
    process.stdout.write(status);
    break;
  }

  default:
    process.stderr.write(
      "usage: changelog.mjs <parse|generate|notes <v>|release-gate <new> [date]|merge-gate <new> <cur> [date]>\n",
    );
    process.exit(2);
}
