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
  it("covers the three closets the extension can read, and nothing else", () => {
    // US-3261 added grailed, which the edge had accepted since US-3155 while
    // this list did not offer it. Parity with the edge list is asserted in
    // src/test/closet-import-platform-parity.test.ts; this one holds the
    // membership so a fourth platform arrives with its disclosure copy.
    expect([...CLOSET_IMPORT_PLATFORMS]).toEqual([
      "poshmark",
      "mercari",
      "grailed",
    ]);
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

  it("waits for the extension ping, then always says something (US-3263)", () => {
    // It used to return null unless the extension was installed AND the
    // account had a paid plan, which hid the whole feature from the two people
    // most likely to want it: somebody deciding whether to pay, and somebody
    // who had not installed the extension yet.
    //
    // What must still hold: nothing renders before the ping answers, so an
    // install prompt never flashes at somebody who already has it.
    expect(src).toMatch(/if \(!setup\) return null;/);
    expect(src).toMatch(/useExtensionSetup\(\)/);
    expect(src).not.toMatch(/!setup\.sellerEnabled\) return null/);
    // No extension: an install step, not silence.
    expect(src).toMatch(/if \(!setup\.installed\)/);
    expect(src).toMatch(/extensionStoreUrl\(\)/);
    // No plan: the card renders and states the bound.
    expect(src).toMatch(/!setup\.sellerEnabled && \(/);
    expect(src).toContain("FREE_CLOSET_IMPORT_ROWS");
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
