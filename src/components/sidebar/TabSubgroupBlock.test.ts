// The tab subgroup caption reuses the task groups' menu body
// (GroupActionsMenuItems), whose Rename entry says "group". A subgroup is
// called a subgroup everywhere else (Move to subgroup, New subgroup, the
// caption's own labels), so its menu passes its own word. The menu content
// is a portal mounted only while open, which static rendering cannot reach,
// so this pins the wiring and the copy; the e2e caption-menu case clicks it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import en from "@/locales/en/sidebar";
import zh from "@/locales/zh-CN/sidebar";

describe("tab subgroup caption menu copy", () => {
  it("says subgroup, not group", () => {
    expect(en.tabSubgroup.renameSubgroup).toBe("Rename subgroup");
    expect(zh.tabSubgroup.renameSubgroup).toBe("重命名子分组");
  });

  it("is what the caption's menu passes", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "TabSubgroupBlock.tsx"), "utf8");
    expect(src).toMatch(/renameLabel=\{t\("tabSubgroup\.renameSubgroup"\)\}/);
  });
});
