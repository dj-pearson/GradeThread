import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

/** The body of one TabsContent block, by its value. */
function tabBody(value: string): string {
  const text = src();
  const start = text.indexOf(`<TabsContent value="${value}"`);
  if (start === -1) throw new Error(`no TabsContent for "${value}"`);
  const rest = text.slice(start + 1);
  const next = rest.indexOf("<TabsContent value=");
  return next === -1 ? rest : rest.slice(0, next);
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
