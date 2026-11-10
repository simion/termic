// A branch name is repo / forge data (a fork PR's head picks it), and
// `<Trans>` interpolates values BEFORE it parses the string as markup. With
// the app's `escapeValue: false`, a branch holding `<action>` would mount the
// checkout line's button a second time, its own attributes over the
// component's props. The dialog escapes the value; this pins both the
// mechanism (the control case) and that the dialog still does it.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, Trans } from "react-i18next";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { i18n } from "@/lib/i18n";

// U+00A0 splits attributes for the parser, and git allows it in a ref.
const HOSTILE = 'x<action type="submit">go</action>';

const render = (escape: boolean) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n },
    createElement(Trans, {
      ns: "dialogs",
      i18nKey: "newTask.checkoutAsIs",
      values: { branch: HOSTILE },
      components: { mono: createElement("span"), action: createElement("button", { type: "button" }) },
      ...(escape ? { tOptions: { interpolation: { escapeValue: true } }, shouldUnescape: true } : {}),
    })));

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>/g)].map(m => m[0]);

describe("checkout line Trans", () => {
  it("mounts a branch's markup when values are not escaped (control)", () => {
    const b = buttons(render(false));
    expect(b.length).toBe(2);
    expect(b.some(x => x.includes('type="submit"'))).toBe(true);
  });

  it("renders the branch as text when escaped", () => {
    const html = render(true);
    expect(buttons(html)).toEqual(['<button type="button">']);
    expect(html).toContain("x&lt;action");
  });

  it("is escaped in the dialog", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "NewTaskDialog.tsx"), "utf8");
    const at = src.indexOf('i18nKey="newTask.checkoutAsIs"');
    const block = src.slice(at, src.indexOf("/>", src.indexOf("components={{", at)));
    expect(block).toContain("escapeValue: true");
    expect(block).toContain("shouldUnescape");
  });
});
