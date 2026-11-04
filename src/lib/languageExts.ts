// Which grammar a buffer gets, and how it is found. Imported ONLY by the
// lazily-loaded editor / diff panes: `@codemirror/language-data` has ~150
// grammars behind it and `lib/mainChunkGuard.test.ts` pins that none of them
// are reachable from app start. `lib/languages` is the module everything else
// touches.
//
// The set of languages is CodeMirror's published registry, so a `.zig` or a
// `.php` file lights up with no edit here. Three things are layered on top:
//
//   CUSTOM   grammars the registry cannot serve at all (see below)
//   OVERLAY  filename rules the registry lacks, reusing ITS loaders
//   registry everything else, as published
//
// First match wins, so CUSTOM and OVERLAY beat the registry on a tie.

import type { Extension } from "@codemirror/state";
import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { languages as registry } from "@codemirror/language-data";
import { PLAIN_TEXT, normalizeLanguageId } from "@/lib/languages";

/** Wrap one of the old CodeMirror 5 stream tokenizers as a LanguageSupport,
 *  which is what a LanguageDescription's `load` has to resolve to. */
function stream(mode: Parameters<typeof StreamLanguage.define>[0]): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(mode));
}

/** Grammars with no usable registry entry.
 *
 *  These are the only per-language entries left in termic, and each one is
 *  here for a reason that would not go away by waiting:
 *
 *  - Makefile — nothing upstream has a Makefile grammar at all.
 *  - ProtoBuf — the registry ships a mode that predates proto3. Same NAME as
 *    the registry entry on purpose: being first, it replaces it rather than
 *    sitting next to it in the picker.
 *  - Elixir  — simply absent from the registry.
 *  - HCL     — absent too, so Terraform files otherwise open as plain text.
 *  - Svelte  — absent, and the HTML fallback it used to get missed `{#if}`
 *    blocks and every `<script>` in the file.
 *  - Astro   — no CodeMirror grammar exists anywhere. `lib/astroMode` builds
 *    one out of the two parsers the file is actually made of.
 *
 *  React and Vue need nothing here: the registry's JSX / TSX and Vue entries
 *  are real grammars, and Vue's loads `@codemirror/lang-vue`.
 *
 *  Every loader is a dynamic import, so a grammar costs nothing until a file
 *  that needs it is opened. */
const CUSTOM: LanguageDescription[] = [
  LanguageDescription.of({
    name: "Makefile",
    alias: ["make", "bsdmake"],
    extensions: ["mk", "mak"],
    filename: /^(gnu)?makefile(\..+)?$/i,
    load: () => import("@/lib/makeMode").then(m => stream(m.makefile)),
  }),
  LanguageDescription.of({
    name: "ProtoBuf",
    alias: ["proto", "proto3", "grpc"],
    extensions: ["proto"],
    load: () => import("@/lib/protoMode").then(m => stream(m.proto3)),
  }),
  LanguageDescription.of({
    name: "Svelte",
    alias: ["svelte"],
    extensions: ["svelte"],
    load: () => import("@replit/codemirror-lang-svelte").then(m => m.svelte()),
  }),
  LanguageDescription.of({
    name: "Astro",
    alias: ["astro"],
    extensions: ["astro"],
    load: () => import("@/lib/astroMode").then(m => m.astro()),
  }),
  LanguageDescription.of({
    name: "Elixir",
    alias: ["ex", "exs"],
    extensions: ["ex", "exs"],
    load: () => import("codemirror-lang-elixir").then(m => m.elixir()),
  }),
  LanguageDescription.of({
    name: "HCL",
    alias: ["hcl", "terraform", "tf", "tfvars"],
    extensions: ["tf", "tfvars", "hcl"],
    load: () => import("@/lib/hclMode").then(m => m.hcl()),
  }),
];

/** Extra filename rules for a language the registry DOES have, sharing its
 *  loader so no grammar is duplicated.
 *
 *  Every row is a case that worked in termic before the registry swap and
 *  would otherwise silently regress to plain text. Two systematic gaps
 *  upstream produce most of it: filename regexes are anchored hard
 *  (`/^Dockerfile$/` misses `Dockerfile.dev`), and several languages list
 *  their shells/dialects only as search aliases, never as extensions
 *  (`zsh` on Shell, `rake` on Ruby). */
const OVERLAY_RULES: Array<{ name: string; extensions?: string[]; filename?: RegExp }> = [
  { name: "Dockerfile", filename: /^dockerfile(\..+)?$/i },
  // `justfile` is a Make-alike, but its recipes are shell and the shell
  // grammar is what termic has always given it.
  { name: "Shell", extensions: ["zsh", "fish"], filename: /^justfile$/i },
  { name: "Properties files", extensions: ["env", "conf"], filename: /^\.env(\..+)?$/i },
  // Component/template formats with no grammar of their own get tag
  // highlighting from HTML. `<script>` / `<style>` blocks miss deep JS/CSS
  // parsing, which is the same trade VS Code makes bare. `hbs`/`handlebars`
  // and `vue` are already upstream; `astro` and `svelte` have grammars of
  // their own in CUSTOM above, and were here until they did.
  { name: "HTML", extensions: ["ejs", "mustache", "twig", "njk"] },
  { name: "Markdown", extensions: ["mdx"] },
  { name: "Python", extensions: ["pyi"] },
  { name: "Ruby", extensions: ["rake"] },
  { name: "Groovy", extensions: ["gvy"] },
];

const byName = new Map(registry.map(d => [d.name, d]));

/** Rules whose base language is still in the registry. A dropped base skips
 *  its rule rather than throwing at module load, which would take the whole
 *  editor pane down; `languageExts.test.ts` asserts none are skipped. */
export const OVERLAY: LanguageDescription[] = OVERLAY_RULES.flatMap(rule => {
  const base = byName.get(rule.name);
  if (!base) return [];
  return [LanguageDescription.of({
    name: rule.name,
    // The base's search aliases come along: an overlay entry is FIRST in the
    // list, so it is the one the picker dedupes down to, and dropping them
    // would quietly stop "ini" finding Properties files.
    alias: base.alias,
    extensions: rule.extensions ?? [],
    filename: rule.filename,
    load: () => base.load(),
  })];
});

/** Everything, in resolution order. */
const ALL: LanguageDescription[] = [...CUSTOM, ...OVERLAY, ...registry];

/** One entry per NAME, in resolution order, so the overlay's duplicates and
 *  the registry's shadowed ProtoBuf do not show up twice in the picker. */
const UNIQUE: LanguageDescription[] = (() => {
  const seen = new Set<string>();
  return ALL.filter(d => (seen.has(d.name) ? false : (seen.add(d.name), true)));
})();

const UNIQUE_BY_NAME = new Map(UNIQUE.map(d => [d.name, d]));

/** The language a path selects on its own, or null when nothing matches.
 *
 *  Not `LanguageDescription.matchFilename`, which cannot be used here: it
 *  compares the raw extension with `indexOf`, so `README.MD` matches nothing.
 *  Same two passes as upstream otherwise — whole-filename patterns first
 *  (`Dockerfile.dev` is a Dockerfile, not a `.dev` file), then the extension,
 *  lower-cased. */
export function matchLanguage(path: string | null | undefined): LanguageDescription | null {
  if (!path) return null;
  const base = path.split("/").pop() || path;
  for (const d of ALL) if (d.filename?.test(base)) return d;
  const m = /\.([^.]+)$/.exec(base);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  for (const d of ALL) if (d.extensions.includes(ext)) return d;
  return null;
}

/** The name a path resolves to, for the panes to store on the tab. */
export function languageIdForPath(path: string | null | undefined): string | null {
  return matchLanguage(path)?.name ?? null;
}

export function isKnownLanguage(id: string): boolean {
  const name = normalizeLanguageId(id);
  return name === PLAIN_TEXT || UNIQUE_BY_NAME.has(name);
}

/** The grammar for a name, or null for plain text and for anything the
 *  registry does not have (a pick persisted by a build that knew a language
 *  this one does not). Rejected loads resolve to null as well: a grammar
 *  chunk that fails to fetch should leave the buffer unhighlighted, never
 *  fail the file open. */
export async function langForId(id: string | null | undefined): Promise<Extension | null> {
  if (!id) return null;
  const name = normalizeLanguageId(id);
  if (name === PLAIN_TEXT) return null;
  const desc = UNIQUE_BY_NAME.get(name);
  if (!desc) return null;
  try {
    return await desc.load();
  } catch (e) {
    console.warn(`[termic] could not load the ${name} grammar`, e);
    return null;
  }
}

/** Name + grammar for a path in ONE await, so the panes can run this
 *  concurrently with reading the file instead of after it. */
export async function langForPath(
  path: string | null | undefined,
): Promise<{ id: string; ext: Extension } | null> {
  const desc = matchLanguage(path);
  if (!desc) return null;
  try {
    return { id: desc.name, ext: await desc.load() };
  } catch (e) {
    // Loud, not silent. A grammar chunk that fails to load must not fail the
    // file open, but swallowing it outright is how a bundling mistake that
    // broke .ts and .js for every file looked exactly like "no grammar".
    console.warn(`[termic] could not load the ${desc.name} grammar`, e);
    return null;
  }
}

/** Rows for the "Set syntax" picker: the display name, plus the registry's
 *  aliases as extra fuzzy-search terms ("dotenv" is not one of them, but
 *  "ini" and "properties" both find Properties files). Alphabetical, with
 *  Plain Text pinned to the top — it is the "turn this off" row, not a
 *  language you go hunting for in the Ps. */
export function pickerLanguages(): Array<{ name: string; keywords: string }> {
  const rows = UNIQUE.map(d => ({ name: d.name, keywords: d.alias.join(" ") }));
  const common = PICKER_COMMON.flatMap(n => n === PLAIN_TEXT
    ? [{ name: PLAIN_TEXT, keywords: "none off plain raw txt text" }]
    : rows.filter(r => r.name === n));
  return [
    ...common,
    ...rows.filter(r => !PICKER_COMMON.includes(r.name)).sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

/** What the picker lists first, in this order, ahead of the alphabetical
 *  rest: what a scratch pad is set to most, Markdown above all. */
export const PICKER_COMMON: readonly string[] = ["Markdown", PLAIN_TEXT, "YAML", "JSON", "Shell"];
