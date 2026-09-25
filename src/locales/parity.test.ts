// Locale parity: zh-CN must carry exactly the same key set as en, and every
// interpolation placeholder ({{name}}) must match between the two. This is
// the invariant that keeps an extraction or a later edit from silently
// dropping a string in one language (a missing zh-CN key falls back to
// English at runtime, which ships as a half-translated UI).

import { describe, it, expect } from "vitest";
import en from "./en";
import zhCN from "./zh-CN";
import { NAMESPACES } from "@/lib/i18n";

type Tree = Record<string, unknown>;

function flatten(tree: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[key] = v;
    else if (v && typeof v === "object") Object.assign(out, flatten(v as Tree, key));
  }
  return out;
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]).sort();
}

describe("locale parity (en vs zh-CN)", () => {
  // Namespaces whose extraction has landed and must stay non-empty. Stubs
  // (sidebar, task, backend at the time of writing) are still parity-checked
  // below but allowed to be empty until their area is extracted; move each
  // into this list as its extraction lands, until it equals NAMESPACES.
  const EXTRACTED: readonly string[] = ["common", "settings", "dialogs", "panels", "chrome", "sidebar", "task", "backend"];

  for (const ns of NAMESPACES) {
    it(`namespace "${ns}" has identical keys`, () => {
      const a = flatten(en[ns] as Tree);
      const b = flatten(zhCN[ns] as Tree);
      const onlyEn = Object.keys(a).filter(k => !(k in b));
      const onlyZh = Object.keys(b).filter(k => !(k in a));
      expect(onlyEn, `keys missing from zh-CN: ${onlyEn.join(", ")}`).toEqual([]);
      expect(onlyZh, `keys missing from en: ${onlyZh.join(", ")}`).toEqual([]);
      if (EXTRACTED.includes(ns)) expect(Object.keys(a).length).toBeGreaterThan(0);
    });

    it(`namespace "${ns}" placeholders match`, () => {
      const a = flatten(en[ns] as Tree);
      const b = flatten(zhCN[ns] as Tree);
      for (const key of Object.keys(a)) {
        expect(placeholders(b[key]), `${ns}:${key} placeholder mismatch`).toEqual(placeholders(a[key]));
      }
    });
  }
});
