# Markdown preview pipeline

How a markdown document becomes the rendered preview, and the rules a new
markdown feature has to follow. The code is `src/lib/markdown/` (pure TS,
no React, unit-tested) and the component that drives it,
`src/components/task/MarkdownPreview.tsx`. UI behaviour (comments, scroll
sync, find, copy) is in docs/ui.md.

## Pipeline

Every rebuild (text, theme, linkify or remote-image change) runs, in order:

1. **parse**: `renderDoc(text, { linkify })` in `engine.ts` calls
   `md.parse` once. The normalized source is split into lines once and
   cached on the markdown-it env (`docLines`), shared by every rule.
2. **model**: `buildModel` walks the same tokens into a `DocModel`
   (`model.ts`): one `Block` per rendered, line-stamped element (kind, tag,
   1-based inclusive lines, depth) and the headings with their GitHub
   slugs. The component keeps the latest one in `modelRef`; only the
   outline reads it, everything else reads the DOM's line stamps.
3. **render + sanitize**: `md.renderer.render` on those tokens, then
   DOMPurify over the ASSEMBLED html (an opening `<div align="center">` and
   its `</div>` are separate tokens, so per-token sanitizing would destroy
   the wrapper). The allowlist is the base list in `engine.ts` plus every
   extension's `allow` and `trusted` entries. Deny by default.
4. **claim**: the html goes into the host with `innerHTML`, then
   `claim(host)` (see Trust below).
5. **viewState restore**: state each extension captured off the OLD DOM
   just before the rebuild is put back on the new one.
6. The component's own passes: scroll-sync realign, task images, remote
   image gate, find re-run. These stay in `MarkdownPreview.tsx`.
7. **hydrate**: each extension's `hydrate(host, cx)`. Async work (mermaid)
   checks `cx.isAlive()` before touching the DOM and runs `cx.claim()` on
   anything it inserts. Cleanups run before the next rebuild or on unmount.

Steps 1 to 5 run inside `rebuildWithSlots()` (see Slots), so slots are placed
against the final DOM. There is one parse per rebuild; do not add a
second one (performance.md).

## Extension contract

`MdExtension` in `extension.ts`. Register it in `EXTENSIONS` in
`engine.ts`; registration order is plugin order.

- `plugin(md)`: markdown-it rules and renderer overrides.
- `allow: { tags, attrs }`: what the sanitizer lets through for it. A
  document can write anything allowed, so never put something the preview
  trusts here.
- `trusted: { attrs, tags }`: things only we may produce. Added to the
  allowlist automatically, and policed by claim.
- `hydrate(host, cx)`: post-mount pass after every rebuild, may return a
  cleanup. `cx` is `{ themeDark, canEdit, isAlive(), claim(root), filePath?,
  scroller? }`; `canEdit` says whether the preview has a write path (see
  Edits), and a flip of it rebuilds the preview. `scroller` is what an
  in-document jump scrolls. Hydrates run in registration order, and one
  that throws is logged and skipped, the rest still run. Read the DOM
  knowing what has hydrated before you: `headingLinks` runs before `math`,
  which is why heading text reads math through `headingText`.
- `viewState: { capture(host), restore(host, state) }`: reader state the
  full rebuild would otherwise lose (which `<details>` are open).

Everything an extension adds runs on every rebuild (each 200ms typing
debounce, each agent write) over input an attacker can shape, so it must
be linear. `lib/markdown/pathological.test.ts` is the check: block rules are
COUNTED (line-table reads at n and 2n lines, in root, list, quote and
paragraph contexts: a new block rule gets a case there), and the passes with
nothing cheap to count run big locally under vitest's timeout and small on
CI. Per docs/perf-ci.md, only the counts gate.

## Shipped extensions

Each entry: what it renders, what it adds to the allowlist (`allow`), what
it trusts (`trusted`). Styles are one section each under "Markdown
extensions" at the end of `src/index.css`; strings are `panels:mdExt.*`.

- `srcLines`: the `data-src-line` / `data-src-end` stamps on every block.
  Trusts both attrs.
- `fence`: code fences, the mermaid placeholder and its lazy render.
  Allows `data-mermaid` (diagram source the document wrote anyway).
- `alerts`: GitHub callouts, a blockquote whose first line is `[!NOTE]`,
  `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` (any case, alone on
  its line). Adds `markdown-alert markdown-alert-<type>` to the blockquote
  and a localized `<p class="markdown-alert-title">`; the icon is a CSS mask.
  Allows and trusts nothing new (a document writing those classes only
  borrows the styling).
- `details`: no parsing (raw `<details>` / `<summary>` are in the base
  allowlist). A `viewState` keeps each one's open or closed state across
  rebuilds, keyed by summary text and the first line stamped inside it
  (closest line wins, so lines shifting above do not lose it). Find opens
  every `<details>` around the current match (`revealInDetails`, called
  from `gotoMatch`). Allows and trusts nothing.
- `frontMatter`: YAML front matter (`---` on line 1 through the next `---`
  or `...`, root document only; unclosed stays an `<hr>`) as a key/value
  card, `<div class="front-matter">`. No YAML parser: flat top-level
  `key: value` lines are pairs, every other line is shown raw in a
  collapsed `<details>`. One stamped block, so comments and line numbers
  work on it. `DocModel.frontMatter` carries `{ pairs, raw, startLine,
  endLine }`. Allows and trusts nothing new.
- `codeHeader`: hydrate only. Inserts a header row (language from the
  `language-*` class, a Copy button through `copyToClipboard`) as the
  previous sibling of every stamped `<pre>`, so it sits inside a breakout
  wrapper but outside the `<pre>`'s horizontal scroll; mermaid fences and a
  document's raw `<pre>` get none. The header is `SLOT_ATTR` chrome with no
  text nodes (label and caption are CSS `content: attr()`), so find, copy
  and selection text never see it. Allows and trusts nothing.
- `headingLinks`: hydrate only. A hover-revealed button at the end of each
  heading copies `<filePath>#<slug>` (`cx.filePath`, the bare `#slug`
  without one). The slug is computed at CLICK time by `findHeading`, the
  one walk `findHeadingBySlug` also resolves a `file.md#slug` link with:
  `headingSlugger` over every DOM heading in order, each read by
  `headingText`, which takes inline math as its TeX (math hydrate keeps it
  in `data-tex`). So the slug is the same before and after KaTeX renders,
  matches GitHub's, and matches `DocModel.headings` (whose text also takes
  `math_inline` as TeX). `SLOT_ATTR` chrome with no text, so the heading's
  `textContent` is unchanged. Allows and trusts nothing.
- `footnotes`: `markdown-it-footnote` (`[^1]` with a `[^1]:` definition,
  and `^[inline]`). No element ids: the note `<li>` carries `data-fn="N"`,
  a reference `<a data-fnref="N:k">` (note N, its k-th reference) and the
  back link `<a class="footnote-backref" data-fnref="N:k">`. A delegated
  click scrolls `cx.scroller` to the target and flashes it (`flashTo`, `.md-flash`); a reference's
  `title` is its note's text. Each definition's `<li>` gets the line stamps
  of its source lines (inline notes have none). Trusts `data-fn`,
  `data-fnref`; renders the list as `<ol class="footnotes">` (no
  `<section>`, which is not allowlisted).
- `deflist`: `markdown-it-deflist` (`Term` then `: definition`). Fixes the
  plugin's empty `[line, line]` term map so a `<dt>` is stamped with its
  own line. `dl` / `dt` / `dd` are base tags. Allows and trusts nothing.
- `mark`: `markdown-it-mark`, `==text==` as `<mark>` (a base tag). Its
  style excludes the find and comment-quote overlay marks. Allows and
  trusts nothing.
- `math`: `$inline$` (no space just inside either `$`; the first
  unescaped `$` closes it or nothing does, and not when a digit follows, so
  `$5 and $10` stays text), `$$` blocks opening and closing on their own
  lines (or `$$ x $$` on one) with no blank line between, as on GitHub, so
  a prose `$$` never runs to some later `$$`, and ```` ```math ```` fences (retyped to
  `math_block` before render). Placeholders are `<span class="math-inline">`
  / stamped `<div class="math-block">` holding the TeX as text; find and
  comment quotes skip them. The hydrate lazy-imports KaTeX (direct dep,
  pinned to the 0.16.x mermaid pulls in) and renders `output: "mathml"`
  with `trust: false`: KaTeX's HTML output needs inline `style`, MathML
  needs no CSS, fonts or CSP change. The MathML goes through its own
  DOMPurify config (MathML tags and layout attrs only, no `id` / `href` /
  `style` / `class`, `<annotation>` dropped with its text; DOMPurify's
  namespace check only admits MathML via `<math>`), is cached per source,
  and is `cx.claim`ed. Once KaTeX is loaded a rebuild renders in the same
  task, so raw TeX never paints for a frame. A parse error keeps the TeX
  with `.math-error` and the message as its title. Allows and trusts
  nothing in the main sanitizer. Hostile-input limits: sources over 5000
  chars and any user macro definition (`\def`, `\gdef`, `\let`,
  `\newcommand`, ...) are refused before KaTeX runs, because `maxExpand`
  counts expansions, not output (a 4.9 KB `\def` formula renders 29 MB);
  output over 256 KB is cached as an error; `maxSize: 20`. The unclosed
  `$$` scan remembers its last miss per block context (container type,
  indent, level), so `$$` lines never rescan the run they sit in.
- `taskList` and `breakout`: below. `breakout` is registered last.

`breakout` is a core rule that wraps each TOP-LEVEL table, fence, indented
code block and image-only paragraph (linked images count, a README's badge
row) in `<div class="md-wide">` (`md-wide md-wide-fill` for mermaid). The
wrappers are `html_block` tokens with no `map`, so they are never stamped
and never enter the model: the stamps stay on the inner `<table>` / `<pre>`
/ `<p>`, which is what scroll sync, comments, the gutter and go to line
read. Comment slots go after the top-level child, the wrapper, so they
land after the whole block. Copy unwraps it (`lib/markdownCopy.ts`). A
rule that walks top-level tokens and runs after it would see the wrapper
tokens, which is why it goes last. Nested blocks (a table in a list item)
are left at the measure. The geometry is in docs/ui.md "Markdown preview".

### taskList

A list item whose text starts `[ ]`, `[x]` or `[X]` followed by
whitespace or the end of the line renders a real
`<input type="checkbox" class="task-list-item-checkbox">`, a trusted tag
(any `<input>` the document writes is removed by claim) with the trusted
`data-task-line` = the 1-based line of the marker. The `<li>` gets
`task-list-item` (and `task-list-item-done` when ticked): no bullet, the
checkbox hangs in its place, done items dimmed. Each item is also in
`DocModel.tasks` (`{ line, checked, text }`).

A click is delegated on the preview host: `toggleTask(text, line)` in
`edit.ts` builds the one-line `DocEdit` (any of `-` `*` `+` `1.` `1)`,
indented, inside `>`), or refuses a line that no longer reads as a task.
A refused or conflicting edit puts the checkbox back and toasts. Without a
write path (`cx.canEdit` false) the checkboxes are disabled. Copy keeps
them as plain checkboxes with their state.

## Trust

`trust.ts`. Raw HTML in a document passes the sanitizer with whatever
allowlisted attributes it wrote, so anything the preview reads as a fact
about the source cannot be taken off the DOM as-is.

- **Trusted attrs**: set only through `stampAttr(token, name, value)`,
  which prefixes a per-load nonce the document cannot know. `claim()`
  unwraps ours to the bare value and removes every other value.
- **Trusted tags**: elements only we create (a task checkbox `<input>`).
  Ours carry `trustMark()` (`data-md-trust` = nonce); `claim()` removes
  every element of that tag without it and strips the mark from the rest.
  A trusted tag is still on the sanitizer's allowlist, so it must not be
  able to do harm in the moment between insertion and claim: for `input`,
  `renderDoc` adds a sanitize hook (`inputCannotFetch`) that drops `src`
  and any `type` but `checkbox`, so a document's `<input type="image"
  src=...>` can never fetch, claim or no claim. A new trusted tag needs the
  same question asked of it.
- **UI chrome**: `SLOT_ATTR`, `data-tc-commented` and `tc-*` classes mark
  app UI inside the document, which find, copy and selection skip. `claim()`
  strips them from document content so a document cannot pass for them.

`claim()` runs exactly once per fresh piece of content: a second pass would
read our already-unwrapped values as forged. Content inserted after the
main claim (a mermaid SVG) gets its own `cx.claim(el)`.

The engine exports `claim` built from the registered extensions (and
`claimDocument`, the old name). `createClaim` in `trust.ts` exists for
tests; production code imports `claim` from the engine.

Under happy-dom DOMPurify does not sanitize (it unwraps the first element
and passes the rest), so unit tests open documents with a sacrificial line
and test claim against unsanitized input.

## Slots

App UI that lives inside the rendered document (review-comment cards and
composers, the block editor) sits in a slot:
`components/task/markdown/previewSlots.ts`. A slot is a `<div SLOT_ATTR>`
its owner keeps a reference to; the full innerHTML rebuild detaches it,
and the owner's `place()` puts it back. `rebuildWithSlots(host, render,
place)` wraps every rebuild: it also gives a focused textarea its caret
back and a focused CodeMirror its focus. `keepAfter` moves a slot only
when it is out of place (a detached field loses focus), `innermostBlocks`
is the stamped-block lookup both owners share. Find, copy and selection
skip slots; claim strips `SLOT_ATTR` from document content.

Slots and other `SLOT_ATTR` chrome (a code header, a heading's link button)
sit INSIDE the document's own elements, so a `closest()` from them finds
the document's ancestors: a raw `<a>` a document left open around a section
wraps the chrome too. Every delegated handler on the preview asks
`inChrome(target)` first: the link click (a chrome click never follows a
document link), the ⌘F / ⌘G gate (a field in a slot keeps its keys, and
taking them would blur, and so commit, the block editor) and the block
editor's double-click.

## Edits

`edit.ts`: `DocEdit { fromLine, toLine, expect, insert }` over 1-based
inclusive lines, the same numbering as the model and the stamps.
`applyDocEdit(text, edit)` refuses with `conflict` when the lines are not
`expect` any more and `range` when they do not exist. Lines are compared
without `\r`; `insert` is written back with the document's own separator.

Every edit made on the preview is a `DocEdit`, sent to the
`PreviewEditTarget` the preview was given (`edit` prop):

- `apply(edit, label)` verifies `expect` against the LIVE buffer (the
  preview renders a debounced copy) and replaces the lines in ONE
  CodeMirror transaction, `userEvent: "input.preview"`. So undo, the dirty
  dot and review-comment re-anchoring see an ordinary edit. `label`
  ("Checked off line 12") is for the toast. A checkbox click builds its
  edit from the rendered line and remaps that line onto the live buffer
  (`taskChange`), so a box ticks only where its own line now is.
- `read(from, to)` returns the live lines and `text()` the whole live
  buffer (what a held line range is remapped onto), `undo` / `redo` / `save` are
  what `⌘Z` / `⇧⌘Z` / `⌘S` do while the preview has focus (a text field
  inside the preview keeps its own keys). Undo and redo go through the same
  save policy as an edit: undoing an auto-saved tick unticks the file, not
  just the buffer.
- `canEdit` false (an external file) or no target at all (diff view, folder
  listing, Changelog) makes the preview read-only: checkboxes disabled, no
  block editor.

Only `MarkdownPane` builds one (`components/task/markdown/editTarget.ts`,
over the tab's `EditorView`). An untitled pad edits like any buffer and
flushes itself. After an edit lands the pane re-renders the preview at
once instead of after the 200ms typing debounce.

Save policy (pref `markdownSavePreviewEdits`, default on, the review
menu's "Save edits" switch; read when the edit lands; `previewSaveAction`):

- on, buffer clean before the edit: written to disk straight away, through
  the editor's own save (`editorHandle(view).persist()` in EditorPane, the
  same write `⌘S` does). "Clean" is not "current": there is no file
  watcher, so a clean buffer can sit behind an agent's writes until its
  turn settles. `persist` therefore re-reads the file and refuses
  (`DiskChangedError`, the changed-on-disk banner, a toast) when it moved
  on since the buffer last read or wrote it. The edit stays in the buffer,
  dirty. The banner's Keep mine accepts the newer file as the one the next
  save replaces. `⌘S` goes through the same check. A save clears the dirty
  dot only if the buffer is still the doc it wrote: an edit made while the
  read and write were in flight stays dirty.
- on, buffer already dirty: the edit stays in the buffer, nothing is
  saved, and the toast says so. The toggle never saves editor typing.
- off: never saved (dirty dot, `⌘S`).

Typing in the editor still never auto-saves.

## Block editor

`components/task/markdown/blockEditor.ts`. Double-click a block, or
click the pencil on its gutter number (only when the preview has a write
path), and a small CodeMirror opens in a slot
just before it, seeded with the block's exact source lines; the block
itself is hidden while it is open. Markdown highlighting and the editor
theme come from the same `langForId` / `resolveEditorTheme` /
`editorSurfaceTheme` the tab's editor uses, read at open.

- Which block: `editableBlock(target, host)`, the innermost stamped element
  under the pointer (a list item rather than its list, the paragraph inside
  a quote, a heading, a fence or mermaid block), except that any table part
  edits the whole table. Nothing inside a slot or on a checkbox, and a
  double-click on a link never opens it (its first click followed it).
- A code block's header (`codeHeader`) hides and shows with its `<pre>`,
  and the slot goes before it.
- `⌘Enter`, `⌘S`, the Save button, or blur commits a `DocEdit` with
  `expect` = the lines it opened on (trailing newlines dropped). Blur skips
  focus moving within the editor, the window losing focus, and a rebuild
  moving the slot. `Esc` / Cancel discards. An unchanged commit just
  closes.
- The editor holds a line range and the source it is a range of. After
  every rebuild `place()`, and every commit against the live buffer
  (`text()`), follow it with `remapRange(before, after, range)`
  (`lib/markdown/lines.ts`), a line prefix/suffix diff of the two sources,
  NOT by content: a twin block with the same text must never capture the
  editor. The diff runs both ways (shared start first, shared end first);
  when identical lines make them disagree (`X A X` losing two lines) the
  range could be either copy, and the block is lost. Three outcomes:
  - the edit missed the range: it stays, or shifts by the lines added or
    removed above it.
  - the edit stayed inside the range (an agent or the split editor rewrote
    the block): the range takes its new extent and the conflict bar shows.
    **Take theirs** closes, **Use mine** replaces whatever the range reads
    now. A line diff cannot tell "the heading was rewritten" from "a line
    was added above and the heading rewritten", so Use mine writes only
    once a render has shown ONE block of the same tag at exactly that
    range; otherwise the block is lost. Pressed while the buffer is ahead
    of the render, it waits for the next render to confirm, then writes.
  - anything else (the edit reached past the range, or deleted it): lost.
    Nothing is written; the bar says so and Use mine becomes **Copy mine**.
  Any render with no block of the editor's tag at exactly its range loses
  it too, even when the diff said the range itself was untouched: an edit
  just outside can still reshape the block (a lazy continuation line, a
  setext underline).
  A reload from disk replaces the whole document in one change, which is
  why this diffs sources rather than mapping CodeMirror positions.
- A commit re-renders the preview at once (MarkdownPane skips its typing
  debounce for preview edits), so the closed editor never shows the old
  block for a frame, and the scroll position stays put.

`useBlockEditor` returns `open(el)`, which the line-number gutter's pencil
calls (`useLineGutter`'s `onEdit`, which `MarkdownPreview` passes whenever
its `edit` target can edit); `editableBlock` picks the block, the table for
a row's number. The gutter has no caller-supplied actions: its two buttons
(copy, edit) are built in, and built on a label's first hover rather than
per paint.

## Outline

The outline rail (docs/ui.md "Outline") reads `DocModel.headings`, not the
DOM: level, rendered text, slug and source line, from the same parse. The
preview passes each rebuild's model to it; the rail keeps h1-h3 and finds a
heading's element by its `data-src-line` stamp, which a document cannot
forge (see Trust).
