// Runs before every unit-test file (vitest.config.ts `setupFiles`).
//
// The suite runs under node, whose `navigator.userAgent` is neither macOS
// nor Windows, so platform detection would switch the macOS Seatbelt
// sandbox off for every spec. Specs about Seatbelt semantics were written
// against macOS; the ones about the off-macOS clamp flip it themselves.
import { setSeatbeltAvailableForTests } from "@/lib/platform";

setSeatbeltAvailableForTests(true);

// node >= 25 defines its own `localStorage`/`sessionStorage` globals, which
// read as undefined without `--localstorage-file`, and vitest's happy-dom
// environment does not overwrite a global node already has. So a DOM file
// sees undefined storage. Give it fresh DOM `Storage` instances instead.
const DomStorage = (globalThis as { window?: { Storage?: new () => Storage } }).window?.Storage;
for (const key of ["localStorage", "sessionStorage"] as const) {
  if (!DomStorage || (globalThis as Record<string, unknown>)[key]) continue;
  Object.defineProperty(globalThis, key, { value: new DomStorage(), configurable: true, writable: true });
}

// The active language defaults to "system", which follows
// navigator.language, and Node >= 21 exposes a real navigator with the
// machine's locale. On a zh-CN machine every user-visible string renders
// as Chinese and the assertions that match on English catalog text fail,
// which reads like an app bug but is pure environment. The suites are
// written against the English catalog (and CI is an en machine), so pin
// it here; src/locales/parity.test.ts covers the other language's keys.
const nav = typeof navigator !== "undefined" ? navigator : undefined;
if (nav) {
  try {
    Object.defineProperty(nav, "language", { value: "en-US", configurable: true });
    Object.defineProperty(nav, "languages", { value: ["en-US"], configurable: true });
  } catch {
    // A non-configurable navigator would have to fall back to the
    // localStorage pin below (and LANG for node's ICU).
  }
}
try {
  localStorage.setItem("uiLanguage", "en");
} catch {
  // node-environment files have no localStorage; navigator above covers
  // them (and "en" is i18n's own default when it sees no navigator).
}

// Warm Intl BEFORE any test's clock starts.
//
// `formatReset` renders through `toLocaleTimeString`/`toLocaleDateString`, and
// the FIRST such call in a fresh process loads ICU data. On the Windows runner
// that took 19.7s, which blew the 5s per-test limit and failed
// "treats the reset as epoch SECONDS, not milliseconds" with a timeout: a test
// about epoch units, failing for a reason that has nothing to do with epochs,
// and only on Windows.
//
// Paying it here puts the cost in setup, which is where a one-off belongs, and
// leaves the per-test ceiling tight enough to still mean something.
try {
  const probe = new Date(0);
  probe.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  probe.toLocaleDateString(undefined, { weekday: "short" });
} catch {
  // A build without ICU: the formatters fall back on their own, and the test
  // that needed this is about the epoch unit, not the rendering.
}
