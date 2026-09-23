import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2523 was filed against a settings page that stacked fourteen unrelated
// cards in one column with Delete account at the bottom of a 1,500-line scroll.
// That page no longer exists: US-1441 split it into tabs, and every acceptance
// criterion was already met when the story came up. No code was written for it.
//
// What was missing is this guard. The split is a property nobody can see from a
// diff — a card added to the wrong TabsContent looks identical in review — so
// the arrangement is pinned here instead.

const PAGE = "src/pages/settings.tsx";

function src(): string {
  return readFileSync(resolve(process.cwd(), PAGE), "utf8");
}

const SECTION_DIR = "src/components/settings";

/**
 * Web-growth action 6 moved each tab's cards into its own component under
 * src/components/settings/, so a TabsContent now reads `<SecuritySettingsTab />`
 * and the cards sit one file away. Follow that one hop: any component the tab
 * renders that is DEFINED in that directory has its source appended. Without
 * this, every assertion below would be checking a one-line wrapper and pass on
 * whatever the section file contains.
 */
function sectionSources(): Map<string, string> {
  const byName = new Map<string, string>();
  for (const f of readdirSync(resolve(process.cwd(), SECTION_DIR))) {
    if (!f.endsWith(".tsx")) continue;
    const text = readFileSync(resolve(process.cwd(), SECTION_DIR, f), "utf8");
    for (const m of text.matchAll(/export function (\w+)\(/g)) {
      byName.set(m[1]!, text);
    }
  }
  return byName;
}

/** The body of one TabsContent block, by its value, with its sections inlined. */
function tabBody(value: string): string {
  const text = src();
  const start = text.indexOf(`<TabsContent value="${value}"`);
  if (start === -1) throw new Error(`no TabsContent for "${value}"`);
  const rest = text.slice(start + 1);
  const next = rest.indexOf("<TabsContent value=");
  const body = next === -1 ? rest : rest.slice(0, next);
  const sections = sectionSources();
  let out = body;
  for (const m of body.matchAll(/<(\w+)\s*\/>/g)) {
    const section = sections.get(m[1]!);
    if (section) out += "\n" + section;
  }
  return out;
}

describe("settings stays grouped (US-2523)", () => {
  it("is a tabbed page, not one column", () => {
    const text = src();
    for (const tab of [
      "profile",
      "security",
      "notifications",
      "ai",
      "flipdesk",
      "data",
      "storage",
      "danger",
    ]) {
      expect(text, `the ${tab} tab is gone`).toContain(
        `<TabsContent value="${tab}"`,
      );
    }
  });

  it("every security control lives in the security tab", () => {
    const security = tabBody("security");
    // Two-factor, password and sessions are one job. Interleaving them with
    // cosmetic preferences is what the story was about.
    expect(security).toContain("<MfaCard");
    expect(security).toContain("Change Password");
    // Rendered as <SignOutAllCard />; its own title reads "Active Sessions".
    expect(security).toContain("<SignOutAllCard");
  });

  it("deleting the account is its own destination, not the end of a scroll", () => {
    expect(tabBody("danger")).toContain("<DangerZoneCard");
    // And it is nowhere else — a second copy in a preferences tab would put a
    // one-way action back beside a toggle.
    for (const tab of ["profile", "notifications", "ai", "flipdesk", "data"]) {
      expect(tabBody(tab), `${tab} carries the danger zone`).not.toContain(
        "<DangerZoneCard",
      );
    }
  });

  it("cosmetic preferences are not in the security tab", () => {
    const security = tabBody("security");
    for (const stray of ["Product tour", "Usage Alerts", "AI Item Assistant"]) {
      expect(security, `${stray} drifted into Security`).not.toContain(stray);
    }
  });

  it("each tab is deep-linkable, so a link can point at one section", () => {
    const text = src();
    expect(text).toMatch(/searchParams\.get\("tab"\)/);
    expect(text).toMatch(/SETTINGS_TAB_VALUES\.includes\(/);
  });
});
