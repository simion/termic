// Rendered Markdown view for .md/.markdown/.mdx files. Parses with markdown-it
// and renders ```mermaid fenced blocks as SVG diagrams via mermaid
// (securityLevel: "strict").
//
// Raw HTML is PARSED but then filtered through a DOMPurify allowlist (see
// ALLOWED_TAGS / ALLOWED_ATTR below) before it reaches the DOM. It used to be
// dropped wholesale, which was safe but meant the single most common README
// header on GitHub, `<div align="center">` around an `<img>`, rendered as
// literal angle-bracket text: termic could not display its own README. The
// WKWebView has Tauri IPC reach, so a malicious README must never inject
// script; deny-by-default plus the CSP (script-src 'self', no 'unsafe-inline')
// is what keeps that true, not the absence of an HTML parser.
//
// Images and links: when a task `ctx` is provided, relative image srcs
// are read over IPC (worktree-contained, image extensions only) and swapped
// in as data: URLs, and relative link clicks open the target file in a tab
// (after an existence/type check — dead links and directories no longer open
// blank/dead tabs).
//
// Remote http(s) images (issue #69): tauri.conf.json's img-src still allows
// https: (the CSP is one whole-webview policy, so it can't gate just this
// component — see docs/sandbox.md, "Known gap: the webview is outside the
// cage"), but gateRemoteImages() below intercepts them BEFORE they ever hit
// an <img src>, keyed on the `remoteImagesAllowed` prop (prefs.loadRemoteImages,
// OFF by default, or a per-tab override). Blocked, the webview never fetches
// them at all: no unprompted GET to whatever host untrusted markdown names
// (prompt injection, a dependency's README, a contributor's fork). When any
// are blocked, the preview shows a banner to unblock them for this document.
// Only a GET was ever possible either way: script-src is 'self', raw HTML
// stays disabled, and markdown-it's validateLink blocks javascript:, so this
// gate closes egress, not a script-execution path.
//
// The rendered HTML is written into the host element IMPERATIVELY (not via
// React's dangerouslySetInnerHTML). React must NOT own this subtree: mermaid
// writes SVG into the .mermaid-block children asynchronously, and if React
// reconciled the same nodes it would wipe those diagrams on the next render.
// So this component owns one <div ref> and drives all of its contents by hand.
//
// markdown-it + mermaid are both heavy; this whole component is lazy-loaded
// (see TaskView) and mermaid is further dynamic-imported on first render
// so the chunk only lands when a markdown file is actually previewed.

import { useEffect, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { Check, ImageOff } from "lucide-react";
import { openPath, taskFileReadBase64, taskPathStat, taskRevealPath } from "@/lib/ipc";
import { dirnamePosix, headingSlug, MARKDOWN_EXT_RE, resolveTaskHref } from "@/lib/markdownPaths";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { TerminalExitedBanner } from "./TerminalExitedBanner";

// Monotonic id source for mermaid render targets. Math.random/Date.now are
// avoided elsewhere in this codebase; a plain counter is deterministic enough.
let mermaidSeq = 0;

/** Everything the preview is allowed to render, whether markdown-it emitted it
 *  or a README hand-wrote it. Deny-by-default: anything absent is dropped, so
 *  `script`, `iframe`, `object`, `form`, `style` and friends never appear by
 *  virtue of not being listed. Most of this list is just markdown-it's own
 *  output (`p`, `li`, `pre`, `table`, …) — cutting it down would break ordinary
 *  markdown, not just raw HTML. The genuinely new entries are the ones GitHub
 *  READMEs lean on: div, img, br, details, summary, sub, sup, kbd, span. */
const ALLOWED_TAGS = [
  "p", "br", "hr", "div", "span", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "em", "strong", "s", "del", "ins", "mark", "sub", "sup", "kbd",
  "ul", "ol", "li", "dl", "dt", "dd",
  "pre", "code", "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "details", "summary",
];

/** No `style` (CSS injection), no `on*` (DOMPurify strips those anyway, and the
 *  CSP has no 'unsafe-inline' so they could not fire regardless), no `srcset`.
 *  `class` is allowed because markdown-it stamps `language-*` on code blocks; a
 *  README setting its own class is inert without `style`. `data-mermaid` is
 *  listed explicitly rather than via ALLOW_DATA_ATTR so the data-* surface stays
 *  exactly one attribute wide. It grants nothing new: a ```mermaid fence already
 *  renders author-controlled diagram source (securityLevel: "strict"). */
const ALLOWED_ATTR = [
  "href", "src", "alt", "title", "align",
  "width", "height", "class", "colspan", "rowspan", "start",
  "data-mermaid",
];

/** markdown-it renders, DOMPurify decides what survives. Runs on the ASSEMBLED
 *  html, not per-token: markdown-it emits `<div align="center">` and its
 *  `</div>` as two separate html_block tokens, so sanitizing them in isolation
 *  would auto-close the opener and drop the closer, destroying the wrapper. This
 *  is how GitHub does it too.
 *
 *  DOMPurify's URI check still blocks `javascript:` in href/src, and the CSP
 *  (script-src 'self', no 'unsafe-inline') independently prevents inline script
 *  and event handlers from ever executing. Three gates, not one. */
function renderSanitized(text: string): string {
  return DOMPurify.sanitize(md.render(text), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}

// One markdown-it instance, reused across renders. html:true lets the GitHub
// README idiom (`<div align="center">` wrapping an `<img>`) render at all; every
// tag then has to survive the allowlist above. linkify autolinks bare URLs; we
// intercept ```mermaid fences below.
const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const info = tokens[idx].info.trim().split(/\s+/)[0]?.toLowerCase();
  if (info === "mermaid") {
    // Stash the diagram source URI-encoded in a data attr; rendered to SVG
    // after the HTML is injected (mermaid.render is async).
    return `<div class="mermaid-block" data-mermaid="${encodeURIComponent(tokens[idx].content)}"></div>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

// mermaid is imported lazily so the (large) chunk only loads on first preview.
let mermaidMod: typeof import("mermaid").default | null = null;
async function getMermaid() {
  if (!mermaidMod) mermaidMod = (await import("mermaid")).default;
  return mermaidMod;
}

/** Task context for resolving relative images/links. Absent (e.g. the
 *  Changelog dialog) → relative targets stay inert. `filePath` is the
 *  task-relative path of the file being previewed; `epoch` bumps
 *  revalidate cached images (wired to fsRevision by MarkdownPane).
 *  `memberDirs` are a multi-repo task's member `dir_name`s — threaded
 *  through to `resolveTaskHref` so root-relative links/images and `..`
 *  walks stay scoped to the containing member's own root. */
export type MarkdownCtx = { taskId: string; filePath: string; epoch?: number; memberDirs?: string[] };

// Relative-link targets that a text editor tab cannot render. Clicking one
// reveals it in the OS file manager instead of opening a dead error tab.
// Kept in sync by hand with `image_mime_for_ext` in lib.rs (the backend's
// "is this an image the base64 channel will serve" list) — that list is the
// image-only SUBSET of this one, which also covers archives/media that
// aren't images at all.
const BINARY_LINK_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|pdf|zip|gz|tgz|tar|dmg|mp4|mov|webm|mp3|wav|woff2?|ttf|otf)$/i;

type ImgCacheEntry = { fp: string; dataUrl: string; err?: string; failedAt?: number };
// A broken image is cheap to re-check (a failed open, no read/encode), but
// retrying on literally every keystroke-debounce tick anywhere in the
// document (the main render effect always retries negative entries) would
// still mean one IPC round-trip per ~200ms of typing for a doc with one
// dead image link. This floor spaces retries out without needing the
// settle-triggered `revalidatePositive` flag.
const NEGATIVE_RETRY_COOLDOWN_MS = 1500;

// Per-preview-instance image cache (data: URLs are heavy strings, so the
// cache dies with the component instead of accumulating at module scope). A
// recycled preview tab (same component instance, ctx.filePath swaps to a
// different file) forces a revalidation of that file's images instead of
// trusting whatever a PREVIOUS file's viewing left cached — see the
// lastFilePathRef check in the main render effect below — matching the way
// an editor tab re-reads from disk on open.
//
// - `map` keys by `${taskId}:${path}`. Freshness is tracked by `fp` (the
//   backend's mtime:len fingerprint of the bytes actually read), not by
//   fsRevision epoch — the backend confirms "unchanged since your fp" on
//   every revalidation, which is what lets a settle re-check every mounted
//   preview's images without paying for a full read + base64 encode of
//   anything that hasn't actually changed. Empty dataUrl = negative entry
//   (last read failed); `err` carries the message for the hover hint.
// - Capped by BOTH total byte size (`bytes`, FIFO-evict until under budget)
//   AND entry count (`IMG_CACHE_MAX_ENTRIES`): a negative entry is ~0 bytes
//   and would never trip the byte budget on its own, so an unbounded stream
//   of broken-image lookups over a long session couldn't otherwise be
//   capped at all.
// - `inflight` dedups concurrent reads per key (not per key+epoch): N <img>
//   tags referencing one file, or an epoch bump landing while a slow
//   multi-MB read from an earlier trigger is still in flight, share one IPC
//   call instead of racing two.
export type ImgCache = {
  map: Map<string, ImgCacheEntry>;
  bytes: number;
  inflight: Map<string, Promise<void>>;
};
export const IMG_CACHE_MAX_BYTES = 50_000_000;
export const IMG_CACHE_MAX_ENTRIES = 2000;

/** Exported for tests only. */
export function imgCacheInsert(cache: ImgCache, key: string, fp: string, dataUrl: string, err?: string) {
  const prev = cache.map.get(key);
  if (prev) {
    cache.bytes -= prev.dataUrl.length;
    cache.map.delete(key); // re-insert at the back of the FIFO order
  }
  cache.map.set(key, { fp, dataUrl, err, failedAt: dataUrl ? undefined : Date.now() });
  cache.bytes += dataUrl.length;
  for (const [k, v] of cache.map) {
    if ((cache.bytes <= IMG_CACHE_MAX_BYTES && cache.map.size <= IMG_CACHE_MAX_ENTRIES) || cache.map.size <= 1) break;
    cache.map.delete(k);
    cache.bytes -= v.dataUrl.length;
  }
}

/** Apply one cache entry's state to a single <img>: positive → data: URL
 *  (clearing any earlier failure hint we own), negative → src-less with a
 *  hover hint. `undefined` (no cache entry yet, e.g. before the first fetch
 *  for a brand-new image resolves) leaves the element untouched — it's
 *  already src-less from the raw→data-md-src move. An authored
 *  `![alt](a.png "caption")` title is never touched: the failure hint is
 *  only ever written to (and cleared from) a title WE set, tracked via the
 *  `data-md-error` marker. */
function applyImageCacheEntry(img: HTMLImageElement, entry: ImgCacheEntry | undefined) {
  if (entry?.dataUrl) {
    img.src = entry.dataUrl;
    if (img.dataset.mdError !== undefined) {
      img.removeAttribute("title");
      delete img.dataset.mdError;
    }
  } else if (entry) {
    img.removeAttribute("src");
    if (!img.title || img.dataset.mdError !== undefined) {
      img.title = entry.err ?? "image load failed";
      img.dataset.mdError = "";
    }
  }
}

/** Re-apply the cache's current state for `resolvedPath` to every <img> in
 *  `host` that currently references it (there may be more than one, and the
 *  DOM may have been rebuilt since the fetch was issued) — used once a fetch
 *  settles, instead of closing over the specific <img> elements present when
 *  it started. Matches on the `data-md-resolved` marker `hydrateTaskImages`
 *  stamps on each <img> (a plain string compare) rather than re-running
 *  `resolveTaskHref` per element per completed fetch — with N images
 *  that's an O(N) rescan on every one of N completions (O(N²) overall)
 *  instead of an O(1) lookup. */
function applyCacheToMatchingImages(host: HTMLElement, ctx: MarkdownCtx, cache: ImgCache, resolvedPath: string) {
  const key = `${ctx.taskId}:${resolvedPath}`;
  const entry = cache.map.get(key);
  for (const img of Array.from(host.querySelectorAll<HTMLImageElement>(`img[data-md-resolved]`))) {
    if (img.dataset.mdResolved !== resolvedPath) continue;
    applyImageCacheEntry(img, entry);
  }
}

/** Fetch (or cheaply revalidate) one task image, single-flight per key
 *  across overlapping hydrate() calls — a settle's epoch-triggered
 *  revalidation and a concurrent text-triggered re-render never issue two
 *  reads for the same file. Sending the cached `fp` lets the backend answer
 *  "unchanged" without paying for a full read + base64 encode, the fast path
 *  the settle-triggered revalidation of every mounted preview relies on. */
function fetchTaskImage(cache: ImgCache, ctx: MarkdownCtx, path: string, knownFp: string | undefined, host: HTMLElement) {
  const key = `${ctx.taskId}:${path}`;
  if (cache.inflight.has(key)) return; // already in flight; its resolution below covers this call too
  const p = taskFileReadBase64(ctx.taskId, path, knownFp)
    .then(
      (res) => {
        if (res.unchanged) return; // cached entry (and its fp) is still correct
        imgCacheInsert(cache, key, res.fp, `data:${res.mime};base64,${res.data}`);
      },
      (e) => { imgCacheInsert(cache, key, "", "", String(e)); },
    )
    .finally(() => {
      cache.inflight.delete(key);
      if (host.isConnected) applyCacheToMatchingImages(host, ctx, cache, path);
    });
  cache.inflight.set(key, p);
}

/** Swap task-relative <img> srcs for data: URLs read over IPC. The
 *  webview would resolve a relative src against its own origin (a guaranteed
 *  404), so every relative src is moved into data-md-src up front and only
 *  restored once a task read succeeds. Stale-while-revalidate: cached
 *  state (positive or negative) is applied synchronously on every call, for
 *  every currently-present <img> — a rebuilt DOM node (the main render
 *  effect regenerates innerHTML on text/theme changes) picks up a prior
 *  failure's hover hint immediately instead of showing a blank broken image
 *  until the next epoch. A negative entry retries once `NEGATIVE_RETRY_COOLDOWN_MS`
 *  has passed (broken images are cheap to re-check and the user may just
 *  have fixed the path/file, but not on literally every keystroke); a
 *  positive entry only revalidates when `opts.revalidatePositive` is set —
 *  the epoch effect passes that on a settle, the main text-driven effect
 *  doesn't (typing doesn't change files on disk, no need to re-check a
 *  known-good image on every keystroke). Exported for tests only. */
export function hydrateTaskImages(
  host: HTMLElement,
  ctx: MarkdownCtx | undefined,
  cache: ImgCache,
  opts?: { revalidatePositive?: boolean },
) {
  const revalidatePositive = opts?.revalidatePositive ?? false;
  const baseDir = ctx ? dirnamePosix(ctx.filePath) : "";
  const memberDirs = ctx?.memberDirs ?? [];
  for (const img of Array.from(host.querySelectorAll<HTMLImageElement>("img"))) {
    let raw = img.dataset.mdSrc;
    if (raw === undefined) {
      const src = img.getAttribute("src") || "";
      if (!src || /^(https?:|data:|blob:)/i.test(src)) continue; // inline, or remote (gateRemoteImages handles those)
      img.dataset.mdSrc = raw = src;
      img.removeAttribute("src");
    }
    if (!ctx) continue; // no task (Changelog dialog): stays src-less
    const resolved = resolveTaskHref(baseDir, raw, memberDirs);
    if (!resolved) continue; // root-escaping / scheme URL: stays src-less
    img.dataset.mdResolved = resolved; // O(1) lookup key for applyCacheToMatchingImages
    const key = `${ctx.taskId}:${resolved}`;
    const cached = cache.map.get(key);
    applyImageCacheEntry(img, cached);
    const isPositive = !!cached?.dataUrl;
    const negativeOnCooldown = cached && !isPositive
      && Date.now() - (cached.failedAt ?? 0) < NEGATIVE_RETRY_COOLDOWN_MS;
    if ((!cached || !isPositive || revalidatePositive) && !negativeOnCooldown) {
      fetchTaskImage(cache, ctx, resolved, isPositive ? cached!.fp : undefined, host);
    }
  }
}

/** Block (or restore) remote http(s) <img> sources in `host`, based on
 *  `allowed`. A blocked source is moved into `data-md-remote-src` and the
 *  `src` attribute removed, so the browser never issues the request; an
 *  allowed one is moved back onto `src` verbatim so the browser fetches it
 *  itself (this component does not proxy remote images, unlike task-relative
 *  ones — there's no IPC round-trip to gate, only whether the fetch happens
 *  at all). `data:`/`blob:` sources and task-relative ones (already claimed
 *  by `hydrateTaskImages` via `data-md-src`) are left untouched: gating only
 *  ever applies to an actual cross-origin network fetch.
 *
 *  Returns true if `host` currently has at least one blocked remote image,
 *  so the caller can show the per-document "load images" affordance.
 *  Exported for tests only. */
export function gateRemoteImages(host: HTMLElement, allowed: boolean): boolean {
  let blocked = false;
  for (const img of Array.from(host.querySelectorAll<HTMLImageElement>("img"))) {
    const stashed = img.dataset.mdRemoteSrc;
    if (stashed !== undefined) {
      if (allowed) {
        img.src = stashed;
        delete img.dataset.mdRemoteSrc;
      } else {
        blocked = true;
      }
      continue;
    }
    if (img.dataset.mdSrc !== undefined) continue; // task-relative image
    const src = img.getAttribute("src") || "";
    if (!/^https?:/i.test(src)) continue; // data:/blob:/no-src: never gated
    if (allowed) continue; // browser handles it natively
    img.dataset.mdRemoteSrc = src;
    img.removeAttribute("src");
    blocked = true;
  }
  return blocked;
}

export type RemoteImageBannerKind = "blocked" | "confirm" | null;

/** Which remote-image banner (if any) the preview should show. "blocked"
 *  always wins over "confirm": if THIS render still has a blocked image
 *  (e.g. gateRemoteImages hasn't caught up to a just-flipped pref yet, or a
 *  brand-new blocked image appeared some other way), that takes priority
 *  over a stale "you're all set" confirmation rather than showing both or
 *  flickering between them. `canUnblock` mirrors the `onUnblockRemoteImages`
 *  prop being present (no per-document override to offer, e.g. the
 *  Changelog dialog, means no banner at all regardless of blocked state).
 *  Exported for tests only. */
export function remoteImageBannerKind(
  hasBlockedRemoteImages: boolean,
  canUnblock: boolean,
  justAllowedGlobally: boolean,
): RemoteImageBannerKind {
  if (hasBlockedRemoteImages && canUnblock) return "blocked";
  if (justAllowedGlobally) return "confirm";
  return null;
}

/** Find a heading element by `#fragment`. markdown-it doesn't emit heading ids
 *  (and injecting ids could collide with app DOM ids), so match headings by
 *  GitHub-style slug of their text. Duplicate slugs are disambiguated with a
 *  set of slugs already assigned (not a per-base occurrence counter): a
 *  literal heading "Usage 1" claims "usage-1" for itself, so a LATER
 *  duplicate "Usage" heading must skip past it to "usage-2" rather than
 *  colliding on "usage-1" too. Returns null when the fragment is malformed
 *  or matches nothing. */
function findHeadingBySlug(host: HTMLElement | null, fragment: string): HTMLElement | null {
  if (!host) return null;
  let want: string;
  try {
    want = headingSlug(decodeURIComponent(fragment));
  } catch {
    return null; // malformed percent-encoding
  }
  if (!want) return null;
  const used = new Set<string>();
  for (const h of Array.from(host.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"))) {
    const base = headingSlug(h.textContent || "");
    let slug = base;
    for (let n = 1; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    if (slug === want) return h;
  }
  return null;
}

/** Scroll the preview to a `#fragment` link target (in-page anchor / self-link). */
function scrollToHeading(host: HTMLElement | null, fragment: string) {
  findHeadingBySlug(host, fragment)?.scrollIntoView({ block: "start" });
}

function renderMermaidError(el: HTMLElement, message: string, src: string) {
  el.innerHTML = "";
  const pre = document.createElement("pre");
  pre.className = "mermaid-error";
  pre.textContent = `Mermaid render error: ${message}\n\n${src}`;
  el.appendChild(pre);
}

/** Tracks whether the image cache still owes a navigation-triggered
 *  revalidation to the CURRENT file. Exported for tests only. */
type NavRevalidateState = { lastFilePath: string | undefined; pending: boolean };

/** Fresh nav-revalidate-tracking state for one MarkdownPreview instance.
 *  Exported for tests only. */
export function newNavRevalidateState(): NavRevalidateState {
  return { lastFilePath: undefined, pending: false };
}

/** Decide whether THIS render's hydrate call should revalidate positive
 *  image-cache entries because of a file-identity change — not just an
 *  agent settle — and update the tracking state accordingly. A preview
 *  component instance is reused (not remounted) when a tab recycles to a
 *  different path, and the image cache is keyed by path, not "the current
 *  file", so without this a file's images loaded once would never
 *  revalidate again just because the tab came back to it, unlike an editor
 *  tab re-reading from disk on open.
 *
 *  Tracks a PENDING flag rather than just "did filePath change since last
 *  call", because MarkdownPane derives an empty `text` for one render right
 *  after a recycle (its debounced buffer is still labeled with the
 *  PREVIOUS tab.path) before the real content arrives ~200ms later. That
 *  blank render has no `<img>` tags to revalidate at all — consuming the
 *  flag there would use it up before the render that actually has content
 *  (and images) ever happens. The flag survives across renders with `text`
 *  falsy and is only consumed once `text` is non-empty.
 *
 *  Exported for tests only. */
export function consumeNavRevalidate(state: NavRevalidateState, filePath: string | undefined, text: string): boolean {
  if (state.lastFilePath !== filePath) {
    state.lastFilePath = filePath;
    state.pending = true;
  }
  const isNavigation = state.pending;
  if (isNavigation && text) state.pending = false;
  return isNavigation;
}

/** Tracks one pending `file.md#heading` reveal across renders, independent
 *  of the `revealHeading` prop's own lifecycle (it's consumed from the tab
 *  immediately on arrival — see the capture effect in MarkdownPreview —
 *  well before the container may even be visible yet). `graceExpired` is
 *  set ONLY by the deliberate retry timer firing (see `expireRevealGrace`),
 *  never by `attemptReveal` itself — an incidental `visible` bounce (e.g.
 *  Editor→Preview→Editor→Preview in quick succession) re-invokes
 *  `attemptReveal` too, and if that alone could set the equivalent of "one
 *  retry used", a bounce landing before the deliberate grace window elapses
 *  would drop the reveal prematurely, indistinguishable from a genuinely
 *  missing heading. */
type RevealState = { pending: string | null; graceExpired: boolean };

/** Fresh reveal-tracking state for one MarkdownPreview instance. Exported
 *  for tests only. */
export function newRevealState(): RevealState {
  return { pending: null, graceExpired: false };
}

/** Capture a newly-arrived `revealHeading` fragment for later fulfillment.
 *  Resets the grace window so a fresh reveal always gets its own, even if a
 *  previous one was still pending. Exported for tests only. */
export function captureReveal(state: RevealState, fragment: string): void {
  state.pending = fragment;
  state.graceExpired = false;
}

/** Marks the grace window as expired. Called ONLY by the retry timer
 *  itself (never by `attemptReveal`) — see `RevealState`'s doc comment for
 *  why that distinction matters. Exported for tests only. */
export function expireRevealGrace(state: RevealState): void {
  state.graceExpired = true;
}

export type RevealAttempt =
  | { kind: "skip" }
  | { kind: "dropped" }
  | { kind: "retry" }
  | { kind: "matched"; target: HTMLElement };

/** Attempt to fulfill a pending reveal against the current DOM. Doesn't
 *  scroll or set up the re-pin machinery itself (the caller does that for a
 *  "matched" result) — kept a plain, synchronously-testable step.
 *
 *  - "skip": nothing pending, or the container isn't visible yet (hidden via
 *    CSS display while the tab shows Editor, not Preview/Split).
 *  - "matched": found the heading; `state.pending` is cleared.
 *  - "retry": no match, but `text` is empty — ambiguous between "content
 *    hasn't loaded yet" (MarkdownPane's debounced buffer starts at "" on
 *    every newly-opened tab) and "the file really is empty" — the caller
 *    should keep waiting (re-arming its grace timer if needed) rather than
 *    treating either as final. Repeated "retry" results (e.g. from an
 *    incidental `visible` bounce while genuinely still loading) are safe:
 *    only the timer itself can advance this toward "dropped".
 *  - "dropped": no match and nothing left to wait for — either `text` is
 *    non-empty (content definitely loaded and just doesn't contain this
 *    heading) or the grace window already expired and there's still no
 *    match (a genuinely empty file). `state.pending` is cleared for good,
 *    matching GitHub's "silently ignore an unknown anchor" behavior — it
 *    can never resurface later as a surprise scroll while the user is
 *    typing.
 *
 *  Exported for tests only. */
export function attemptReveal(state: RevealState, host: HTMLElement | null, visible: boolean, text: string): RevealAttempt {
  if (!state.pending || !visible) return { kind: "skip" };
  const target = findHeadingBySlug(host, state.pending);
  if (!target) {
    if (text || state.graceExpired) {
      state.pending = null;
      return { kind: "dropped" };
    }
    return { kind: "retry" };
  }
  state.pending = null;
  return { kind: "matched", target };
}

export function MarkdownPreview(
  { text, themeDark, linkify = true, ctx, revealHeading, onRevealConsumed, visible = true,
    remoteImagesAllowed = true, onUnblockRemoteImages, onAlwaysLoadRemoteImages }: {
    text: string; themeDark: boolean; linkify?: boolean; ctx?: MarkdownCtx;
    /** Pending `#fragment` to scroll to once content renders (from a
     *  `file.md#heading` link that opened this tab). Cleared by the owner
     *  via onRevealConsumed as soon as this component observes it — well
     *  before the reveal itself may be fulfillable, see the capture effect
     *  below. */
    revealHeading?: string;
    onRevealConsumed?: () => void;
    /** Whether this preview's container is actually laid out (not hidden
     *  via CSS display). MarkdownPane keeps the preview mounted across
     *  Editor/Preview/Split switches and toggles visibility with `display`,
     *  so a reveal scroll attempted while hidden is a no-op the browser
     *  never recovers from once the container later becomes visible — the
     *  reveal effect waits for this before it will scroll. Defaults to true
     *  for callers (the Changelog dialog) that never hide their preview. */
    visible?: boolean;
    /** Whether remote (http/https) images may load (issue #69). Defaults to
     *  true for callers with no untrusted-markdown threat model (the
     *  Changelog dialog renders termic's own bundled release notes).
     *  MarkdownPane computes this from `prefs.loadRemoteImages` and the
     *  tab's own `remoteImagesUnblocked` override for task-file previews. */
    remoteImagesAllowed?: boolean;
    /** Present only when there's a per-document override to flip (i.e. a
     *  task-file preview). Invoked from the "blocked images" banner. */
    onUnblockRemoteImages?: () => void;
    /** Present alongside onUnblockRemoteImages. Flips the GLOBAL pref
     *  instead of just this document's override — the banner's "Always"
     *  button. This component owns the confirmation UX itself (the banner
     *  swaps its own text/action in place for a few seconds, see
     *  justAllowedGlobally below); the callback here does nothing but
     *  flip the pref. */
    onAlwaysLoadRemoteImages?: () => void;
  },
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const imgCacheRef = useRef<ImgCache | null>(null);
  if (!imgCacheRef.current) imgCacheRef.current = { map: new Map(), bytes: 0, inflight: new Map() };
  const navRevalidateRef = useRef<NavRevalidateState | null>(null);
  if (!navRevalidateRef.current) navRevalidateRef.current = newNavRevalidateState();
  const [hasBlockedRemoteImages, setHasBlockedRemoteImages] = useState(false);
  // Transient confirmation after "Always": the banner swaps its text/action
  // in place (not a separate toast) and lingers a few seconds so the
  // Settings pointer is actually readable, then just disappears once
  // remoteImagesAllowed flips true and there's nothing left to gate.
  const [justAllowedGlobally, setJustAllowedGlobally] = useState(false);
  useEffect(() => {
    if (!justAllowedGlobally) return;
    const t = window.setTimeout(() => setJustAllowedGlobally(false), 5000);
    return () => window.clearTimeout(t);
  }, [justAllowedGlobally]);

  // Main imperative effect: parse → inject → hydrate images + mermaid.
  // Re-runs when the buffer text or the theme changes — deliberately NOT on
  // ctx.epoch: an agent settle must not rebuild the DOM or re-render mermaid
  // (see the epoch effect below). `alive` cancels a stale run when a newer
  // one supersedes it (or on unmount) mid async-render. Also re-runs on
  // remoteImagesAllowed: flipping the pref or the per-doc override is rare
  // (a settings toggle, a banner click), so a full re-render (mermaid
  // included) is simpler than a third gate-only effect and not worth
  // optimizing away.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    const isNavigation = consumeNavRevalidate(navRevalidateRef.current!, ctx?.filePath, text);
    // Toggle linkify right before the (synchronous) render. Callers like the
    // Changelog dialog pass linkify=false so bare filenames (CLAUDE.md, *.app)
    // don't autolink; explicit [text](url) links still render. The md instance
    // is shared, but set+render are atomic per effect run so there's no bleed.
    md.set({ linkify });
    host.innerHTML = renderSanitized(text || "");
    hydrateTaskImages(host, ctx, imgCacheRef.current!, { revalidatePositive: isNavigation });
    setHasBlockedRemoteImages(gateRemoteImages(host, remoteImagesAllowed));
    const blocks = Array.from(host.querySelectorAll<HTMLElement>(".mermaid-block"));
    if (blocks.length === 0) return () => { alive = false; };

    (async () => {
      let mermaid: typeof import("mermaid").default;
      try {
        mermaid = await getMermaid();
        if (!alive) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: themeDark ? "dark" : "default",
        });
      } catch (e) {
        // Import or init failed — surface it on every block instead of
        // leaving silent gaps, and log so it reaches the debug log.
        console.error("[markdown-preview] mermaid load/init failed:", e);
        if (alive) blocks.forEach(el => renderMermaidError(el, String(e), decodeURIComponent(el.dataset.mermaid || "")));
        return;
      }
      for (const el of blocks) {
        if (!alive) return;
        const src = decodeURIComponent(el.dataset.mermaid || "");
        try {
          const { svg } = await mermaid.render(`mmd-${mermaidSeq++}`, src);
          if (!alive) return;
          el.innerHTML = svg;
        } catch (e) {
          console.error("[markdown-preview] mermaid render failed:", e);
          if (!alive) return;
          renderMermaidError(el, String(e), src);
        }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, themeDark, linkify, ctx?.taskId, ctx?.filePath, ctx?.memberDirs, remoteImagesAllowed]);

  // fsRevision bump = images may have changed on disk. Revalidate ONLY the
  // images (cached bytes stay on screen until a fresh read lands; a cheap
  // fp check skips the read+encode entirely for anything unchanged) — never
  // rebuild innerHTML or re-render mermaid for an agent settle. Skipped
  // while hidden (Editor-only view) — no point paying even the cheap fp-stat
  // cost for images nobody can see — and re-run once `visible` flips back to
  // true so a settle that happened while hidden gets a catch-up check. Also
  // skipped on this effect's very first run: the main render effect above
  // always hydrates too, and both effects fire on initial mount, so without
  // this guard the first Preview open does two full image scans instead of
  // one.
  const epochEffectRanOnceRef = useRef(false);
  useEffect(() => {
    const host = hostRef.current;
    if (epochEffectRanOnceRef.current && host && ctx && visible) {
      hydrateTaskImages(host, ctx, imgCacheRef.current!, { revalidatePositive: true });
    }
    epochEffectRanOnceRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.epoch, visible]);

  const revealStateRef = useRef<RevealState | null>(null);
  if (!revealStateRef.current) revealStateRef.current = newRevealState();
  const [revealTick, setRevealTick] = useState(0);

  // Drop any pending reveal when the underlying file identity changes. This
  // component instance is NOT remounted when a preview tab recycles to a
  // different path (TaskView keys by tab id, not path; MarkdownPane
  // reuses the same MarkdownPreview across the swap) — so without this, a
  // reveal captured for the PREVIOUS file that's still mid-retry (waiting
  // out the empty-text grace window while that file loads) would survive
  // the swap and later fire `attemptReveal` against the NEW file's headings
  // instead of being dropped with the file it belonged to. Declared BEFORE
  // the capture effect below so the two run in that order within the same
  // commit: a fragment arriving in the SAME commit as a file-identity change
  // (recycling straight into a new `file.md#heading` link) is captured
  // fresh here, not immediately wiped by this reset.
  useEffect(() => {
    revealStateRef.current = newRevealState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.taskId, ctx?.filePath]);

  // Capture a newly-arrived revealHeading fragment and consume it from the
  // tab IMMEDIATELY, before we know whether the container is even visible
  // yet. This decouples the tab field's (short) lifecycle from the fragment
  // itself, which the attempt effect below drains independently — so
  // MarkdownPane's own effect (which flips a source-view tab to preview
  // when tab.revealHeading arrives, making the container visible) still
  // sees the field set for the commit where it arrived: it runs after this
  // effect in the same commit but reads its own render's `tab` prop, not a
  // value this effect might have just cleared.
  useEffect(() => {
    if (!revealHeading) return;
    captureReveal(revealStateRef.current!, revealHeading);
    onRevealConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealHeading]);

  // Attempt to fulfill a pending reveal. Deliberately NOT keyed on
  // revealHeading — by the time the container becomes visible (often
  // several renders after MarkdownPane's flip-to-preview effect fires) the
  // tab field has long since been consumed above. Keyed on `visible`/`text`
  // instead, so this naturally re-attempts exactly when either could newly
  // permit a match, and the re-pin machinery it sets up on a match is never
  // torn down by the (already-happened) tab-field consumption.
  useEffect(() => {
    const host = hostRef.current;
    const state = revealStateRef.current!;
    const attempt = attemptReveal(state, host, visible, text);
    if (attempt.kind === "retry") {
      // Give content one short grace window to load (well past
      // MarkdownPane's 200ms debounce) before concluding an empty `text`
      // means a genuinely empty file, not "hasn't loaded yet". Only the
      // timer firing expires the grace window — an incidental `visible`
      // bounce re-runs this effect too (re-arming a fresh timer here, which
      // is fine), but must never itself count as the retry being spent.
      //
      // The `revealStateRef.current === state` guard matters when `text`
      // and `visible` happen to be UNCHANGED across a file-identity change
      // (e.g. both the old and new file are still empty/loading) — this
      // effect's own deps wouldn't detect that as a change, so its cleanup
      // wouldn't fire and cancel this timer, but the file-identity reset
      // effect above still replaces `revealStateRef.current` with a fresh
      // object. Without this guard, this now-stale timer would call
      // `expireRevealGrace` on whatever NEW reveal has since been captured
      // on that fresh object, prematurely burning ITS grace window instead
      // of the (abandoned) one this timer was actually scheduled for.
      const t = window.setTimeout(() => {
        if (revealStateRef.current !== state) return;
        expireRevealGrace(state);
        setRevealTick(n => n + 1);
      }, 350);
      return () => window.clearTimeout(t);
    }
    if (attempt.kind !== "matched" || !host) return;
    const target = attempt.target;
    target.scrollIntoView({ block: "start" });

    // Images and mermaid diagrams above the heading are still 0-height at this
    // point and grow as they render, pushing the heading down. Re-pin whenever
    // the content resizes, until the user scrolls or a short settle window
    // elapses — bounded so we never fight the user's own scrolling. Listens
    // on `window` (not the scroller div, which is never itself focusable and
    // so never actually receives a bubbled keydown) so any keyboard activity
    // anywhere counts as user intent; our own scrollIntoView doesn't emit
    // wheel/touch/keydown, so re-pins don't self-cancel.
    const scroller = host.parentElement;
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      ro.disconnect();
      window.clearTimeout(timer);
      scroller?.removeEventListener("wheel", stop);
      scroller?.removeEventListener("touchmove", stop);
      window.removeEventListener("keydown", stop);
    };
    const ro = new ResizeObserver(() => {
      if (!done && target.isConnected) target.scrollIntoView({ block: "start" });
    });
    ro.observe(host);
    const timer = window.setTimeout(stop, 1200);
    scroller?.addEventListener("wheel", stop, { passive: true });
    scroller?.addEventListener("touchmove", stop, { passive: true });
    window.addEventListener("keydown", stop);
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, visible, revealTick]);

  // Intercept link clicks: a bare <a href> would navigate the whole webview
  // (and blow away the app), so preventDefault runs before any early return.
  // External links go to the OS opener, #fragments scroll the preview, and
  // task-relative links are stat'd first — a missing target shows a
  // toast instead of opening a dead tab, a directory reveals in the file
  // manager instead of trying to open as text — before opening the target
  // file in a tab (markdown targets land in MarkdownPane via TaskView
  // routing); a `file.md#heading` fragment rides along as the new tab's
  // revealHeading, but only for a markdown target — a non-markdown tab has
  // no MarkdownPane to ever consume it. Targets an editor can't render
  // (images, archives) reveal in the OS file manager instead.
  async function onClick(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (!href) return;
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) { openPath(href); return; }
    if (href.startsWith("#")) { scrollToHeading(hostRef.current, href.slice(1)); return; }
    if (!ctx) return; // no task context (Changelog dialog): inert
    const resolved = resolveTaskHref(dirnamePosix(ctx.filePath), href, ctx.memberDirs ?? []);
    if (!resolved) return; // root-escaping / other scheme: inert
    const hashIdx = href.indexOf("#");
    const fragment = hashIdx >= 0 ? href.slice(hashIdx + 1) : "";
    if (resolved === ctx.filePath) {
      // Self-link (e.g. `readme.md#usage` from inside readme.md): scroll in
      // place instead of churning the tab.
      if (fragment) scrollToHeading(hostRef.current, fragment);
      return;
    }
    let stat: { exists: boolean; is_dir: boolean };
    try {
      stat = await taskPathStat(ctx.taskId, resolved);
    } catch (err) {
      useUI.getState().pushToast(`Couldn't open ${resolved}: ${err}`, "error");
      return;
    }
    if (!stat.exists) {
      useUI.getState().pushToast(`File not found: ${resolved}`, "error");
      return;
    }
    if (stat.is_dir || BINARY_LINK_RE.test(resolved)) {
      taskRevealPath(ctx.taskId, resolved)
        .catch(err => useUI.getState().pushToast(`Couldn't reveal ${resolved}: ${err}`, "error"));
      return;
    }
    useApp.getState().openPreviewTab(ctx.taskId, {
      type: "edit",
      path: resolved,
      title: resolved.split("/").pop() || resolved,
      ...(fragment && MARKDOWN_EXT_RE.test(resolved) ? { revealHeading: fragment } : {}),
    });
  }

  function handleAlways() {
    onAlwaysLoadRemoteImages?.();
    setJustAllowedGlobally(true);
  }

  const bannerKind = remoteImageBannerKind(hasBlockedRemoteImages, !!onUnblockRemoteImages, justAllowedGlobally);

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      {bannerKind === "blocked" && onUnblockRemoteImages && (
        <TerminalExitedBanner
          label="Images from external sites are blocked in this preview."
          actionLabel="Show images"
          onAction={onUnblockRemoteImages}
          icon={ImageOff}
          tone="muted"
          center
          secondary={onAlwaysLoadRemoteImages ? { label: "Always", onAction: handleAlways } : undefined}
        />
      )}
      {bannerKind === "confirm" && (
        <TerminalExitedBanner
          label="Remote images now load in every markdown preview."
          actionLabel="Settings"
          onAction={() => useApp.getState().openSettings("general", undefined, "load-remote-images")}
          icon={Check}
          tone="muted"
          center
        />
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <div ref={hostRef} className="markdown-body px-8 py-6" onClick={onClick} />
      </div>
    </div>
  );
}
