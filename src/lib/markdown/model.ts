// A structural view of the document, built from the same markdown-it tokens
// the preview renders (no second parse). Lines are 1-based and inclusive,
// over the NORMALIZED source (markdown-it turns \r\n into \n first), and
// match the data-src-line / data-src-end stamps on the rendered blocks.

import type Token from "markdown-it/lib/token.mjs";
import { headingSlugger } from "@/lib/markdownPaths";
import type { TaskItem } from "./extensions/taskList";

export interface Block {
  /** token type without `_open`: paragraph, heading, bullet_list, fence, … */
  kind: string;
  tag: string;
  startLine: number;
  endLine: number;
  /** markdown-it token nesting level (a list item's paragraph is 2). */
  depth: number;
}

export interface Heading {
  level: number;
  /** rendered text (markup stripped, inline math as its TeX), what the
   *  slug is made from: the same text headingText() reads off the DOM */
  text: string;
  /** GitHub-style, with the same duplicate handling as `#fragment` links */
  slug: string;
  line: number;
}

/** the YAML front matter at the very top (extensions/frontMatter). No YAML
 *  parser: `pairs` are the top-level `key: value` lines, `raw` every other
 *  non-blank line, verbatim. Lines are the whole block, fences included. */
export interface FrontMatter {
  pairs: [key: string, value: string][];
  raw: string[];
  startLine: number;
  endLine: number;
}

export interface DocModel {
  /** document order, one per line-mapped block token (raw html_block
   *  entries included, which have no stamped element). Production reads
   *  only `headings` (the outline); the rest is the parse's inspection
   *  surface for tests. */
  blocks: Block[];
  headings: Heading[];
  /** GitHub task list items, document order (extensions/taskList) */
  tasks: TaskItem[];
  frontMatter: FrontMatter | null;
}

/** The normalized source split into lines, once per parse: cached on the
 *  markdown-it env so every rule (and buildModel) shares one array. */
export function docLines(state: { src: string; env: { lines?: string[] } }): string[] {
  return (state.env.lines ??= state.src.split("\n"));
}

/** Whether a token is one of the blocks we stamp with a line range. */
export function isLineBlock(t: Token): boolean {
  return !!t.map && t.block && t.nesting >= 0 && t.type !== "inline";
}

/** The last source line (1-based, inclusive) of a block. A list item's map
 *  runs through the blank line after it; trim that so a comment on it does
 *  not claim (and quote) an empty line. */
export function blockEnd(lines: readonly string[], map: [number, number]): number {
  let end = map[1];
  while (end > map[0] + 1 && !lines[end - 1]?.trim()) end--;
  return end;
}

/** Heading text as the reader sees it: `## Sub *it*` -> "Sub it". Math is
 *  its TeX, as GitHub slugs it. */
function inlineText(inline: Token | undefined): string {
  let s = "";
  for (const c of inline?.children ?? []) {
    if (c.type === "text" || c.type === "code_inline" || c.type === "math_inline") s += c.content;
    else if (c.type === "softbreak" || c.type === "hardbreak") s += "\n";
  }
  return s;
}

export function buildModel(tokens: readonly Token[], lines: readonly string[]): DocModel {
  const blocks: Block[] = [];
  const headings: Heading[] = [];
  const tasks: TaskItem[] = [];
  // ponytail: only markdown headings get slugs here. A raw-HTML <h2> in the
  // document also takes one in the DOM (findHeadingBySlug walks the DOM), so a
  // later duplicate can disagree by one. Walk html_block tokens if that bites.
  const slug = headingSlugger();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // hidden = a tight list item's paragraph, which renders no element
    if (!isLineBlock(t) || t.hidden) continue;
    const startLine = t.map![0] + 1;
    const endLine = blockEnd(lines, t.map!);
    blocks.push({
      kind: t.type.endsWith("_open") ? t.type.slice(0, -5) : t.type,
      tag: t.tag,
      startLine,
      endLine,
      depth: t.level,
    });
    if (t.meta?.task) tasks.push(t.meta.task);
    if (t.type === "heading_open") {
      const text = inlineText(tokens[i + 1]);
      headings.push({ level: Number(t.tag.slice(1)), text, slug: slug(text), line: startLine });
    }
  }
  const fm = tokens[0]?.type === "front_matter" ? tokens[0] : null;
  const frontMatter = fm ? { ...(fm.meta as Pick<FrontMatter, "pairs" | "raw">), startLine: fm.map![0] + 1, endLine: fm.map![1] } : null;
  return { blocks, headings, tasks, frontMatter };
}
