import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLOSET_IMPORT_PLATFORMS,
  closetImportDisclosureFor,
} from "@/lib/marketplace-disclosure";
import { ANALYTICS_EVENTS } from "@/lib/analytics-events";

// US-9201: the web half of the closet import. Three things a screen can lose
// without anything going red: the disclosure sentence that says the read runs
// in the seller's own tab, the gate that hides the button from accounts the
// extension would refuse, and the event the activation funnel reads.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("closet import disclosure", () => {
  it("covers Poshmark and Mercari and nothing else", () => {
    expect([...CLOSET_IMPORT_PLATFORMS]).toEqual(["poshmark", "mercari"]);
  });

  for (const platform of CLOSET_IMPORT_PLATFORMS) {
    it(`${platform}: says what is read and that it runs in the seller's own signed-in tab`, () => {
      const d = closetImportDisclosureFor(platform);
      const all = d.facts.join(" ");
      expect(d.title.toLowerCase()).toContain("your own tab");
      expect(all).toMatch(/signed in to/);
      expect(all).toMatch(/title, description, price, size, brand/);
      expect(all).toMatch(/cannot read a buyer's name or address/);
      expect(all).toMatch(/never linked from/);
      expect(all).toMatch(/counts as a live listing/);
      expect(all).toMatch(/one Undo away/);
      expect(all).toMatch(/Nothing runs on a schedule/);
      expect(all).not.toContain("{label}");
    });
  }
});

describe("closet import card", () => {
  const src = read("src/components/flipdesk/closet-import-card.tsx");

  it("renders only when the extension is installed and the account is seller-enabled", () => {
    // The same gate the Lister uses. A button an account cannot use is a
    // refusal waiting to happen.
    expect(src).toMatch(/if \(!setup\?\.installed \|\| !setup\.sellerEnabled\) return null;/);
    expect(src).toMatch(/useExtensionSetup\(\)/);
  });

  it("shows the disclosure before the button, from the shared copy", () => {
    expect(src).toMatch(/closetImportDisclosureFor\(platform\)/);
    expect(src).toMatch(/disclosure\.facts\.map/);
  });

  it("is mounted on the import page and feeds the shared run poller", () => {
    const page = read("src/pages/flipdesk/import.tsx");
    expect(page).toMatch(/<ClosetImportCard/);
    expect(page).toMatch(/onStarted=\{handleClosetStarted\}/);
    expect(page).toMatch(/recordClosetCompletion\(json\.run\)/);
  });
});

describe("closet import analytics", () => {
  it("registers the three events", () => {
    for (const name of ["closet_import_started", "closet_import_completed", "closet_import_first_item"]) {
      expect(Object.keys(ANALYTICS_EVENTS)).toContain(name);
    }
  });

  it("the first-item event carries a duration, never the install timestamp", () => {
    const page = read("src/pages/flipdesk/import.tsx");
    const at = page.indexOf("recordClosetCompletion = useCallback");
    expect(at, "recordClosetCompletion is no longer where this test looks").toBeGreaterThan(-1);
    const block = page.slice(at);
    expect(block).toMatch(/seconds_since_extension_install/);
    expect(block).not.toMatch(/installed_at:/);
    expect(block).not.toMatch(/installedAt:/);
  });
});
