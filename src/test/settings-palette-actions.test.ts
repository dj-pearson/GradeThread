// ACC-15: the command palette reaches each Settings section, by name or by
// what it holds, and every entry lands on a real section.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  SETTINGS_TAB_VALUES,
  paletteMatches,
  settingsPaletteActions,
} from "@/lib/settings-tabs";

const actions = settingsPaletteActions();
const find = (q: string) =>
  actions.filter((a) => paletteMatches(a.label, a.keywords, q)).map((a) => a.tab);

describe("settings palette actions", () => {
  it("one per section, each pointing at a real section of the hub", () => {
    expect(actions.map((a) => a.tab)).toEqual(SETTINGS_TAB_VALUES);
    for (const a of actions) {
      const tab = new URL(a.href, "https://x.test").searchParams.get("tab");
      expect(SETTINGS_TAB_VALUES).toContain(tab);
      expect(a.href.startsWith("/dashboard/account?tab=")).toBe(true);
      expect(a.label).toMatch(/^Settings: /);
    }
  });

  it("finds sections by what they hold", () => {
    expect(find("ai limit")).toEqual(["ai"]);
    expect(find("ship from")).toEqual(["profile"]);
    expect(find("2FA")).toEqual(["security"]);
    expect(find("password")).toEqual(["security"]);
    expect(find("export")).toEqual(["data"]);
    expect(find("delete account")).toEqual(["danger"]);
    expect(find("unsubscribe")).toEqual(["notifications"]);
    expect(find("address")).toContain("profile");
  });

  it("the palette uses them, keyword matching included, and hides them until typing", () => {
    const src = readFileSync("src/components/flipdesk/command-palette.tsx", "utf8");
    expect(src).toContain("settingsPaletteActions()");
    expect(src).toContain("paletteMatches(a.label, a.keywords, q)");
    expect(src).toMatch(/searchOnly: true/);
  });
});
