import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  asksExistingListings,
  landingForAnswer,
  LISTING_VOLUMES,
  LISTING_VOLUME_LABELS,
  presetIdForAnswer,
  presetIdForChannel,
  readExistingListings,
  saveExistingListings,
} from "@/lib/existing-listings";
import { getImportPreset } from "@/lib/import-presets";
import type { UserUseCase } from "@/types/database";

// US-3264. Signup asked which persona and stopped there, so a reseller with 300
// live listings was routed to the same empty-intake screen as somebody who has
// never sold anything.
//
// The question is one screen with four answers. What it must do: change where
// Finish lands, pre-select the import source, and cost nothing to skip.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const FALLBACK = "/dashboard/flipdesk";

beforeEach(() => {
  localStorage.clear();
});

describe("who gets asked (US-3264)", () => {
  it("sellers and consignors, nobody else", () => {
    expect(asksExistingListings("seller")).toBe(true);
    expect(asksExistingListings("consignment")).toBe(true);
    for (const persona of ["buyer", "developer", null] as (UserUseCase | null)[]) {
      expect(asksExistingListings(persona), `${persona}`).toBe(false);
    }
  });

  it("every volume has a label a person would recognise", () => {
    for (const v of LISTING_VOLUMES) {
      expect(LISTING_VOLUME_LABELS[v].length).toBeGreaterThan(3);
    }
  });
});

describe("where the tour lands (US-3264)", () => {
  it("a seller with listings goes to the importer", () => {
    const to = landingForAnswer(
      "seller",
      { volume: "26-200", channels: ["poshmark"] },
      FALLBACK,
    );
    expect(to).toBe("/dashboard/flipdesk/import");
  });

  it("a seller starting fresh keeps the old destination", () => {
    expect(
      landingForAnswer("seller", { volume: "none", channels: [] }, FALLBACK),
    ).toBe(FALLBACK);
  });

  it("skipping the question is the same as starting fresh", () => {
    // Skip stores nothing, so the answer is null. It must not strand anybody
    // on a page they did not ask for.
    expect(landingForAnswer("seller", null, FALLBACK)).toBe(FALLBACK);
  });

  it("a buyer is never rerouted, whatever is stored", () => {
    expect(
      landingForAnswer("buyer", { volume: "200+", channels: ["ebay"] }, FALLBACK),
    ).toBe(FALLBACK);
  });
});

describe("the answer survives a reload (US-3264)", () => {
  it("round-trips", () => {
    saveExistingListings("u1", { volume: "1-25", channels: ["mercari", "etsy"] });
    expect(readExistingListings("u1")).toEqual({
      volume: "1-25",
      channels: ["mercari", "etsy"],
    });
  });

  it("is per user", () => {
    saveExistingListings("u1", { volume: "200+", channels: ["ebay"] });
    expect(readExistingListings("u2")).toBeNull();
  });

  it("a corrupted or hand-edited value reads as no answer", () => {
    localStorage.setItem("gt.onboarding.existing_listings:u3", "{not json");
    expect(readExistingListings("u3")).toBeNull();
    localStorage.setItem(
      "gt.onboarding.existing_listings:u4",
      JSON.stringify({ volume: "heaps", channels: [] }),
    );
    expect(readExistingListings("u4")).toBeNull();
  });
});

describe("pre-selecting the import source (US-3264)", () => {
  it("maps a channel to a preset that exists", () => {
    for (const channel of ["ebay", "shopify", "etsy"]) {
      const id = presetIdForChannel(channel);
      expect(id, channel).not.toBeNull();
      expect(getImportPreset(id!), `${channel} names a preset that is gone`).toBeDefined();
    }
  });

  it("says nothing for a channel with no export preset", () => {
    expect(presetIdForChannel("poshmark")).toBeNull();
    expect(presetIdForChannel("vinted")).toBeNull();
  });

  it("pre-selects when exactly one named channel has a preset", () => {
    expect(
      presetIdForAnswer({ volume: "26-200", channels: ["etsy", "poshmark"] }),
    ).toBe("etsy");
  });

  it("refuses to guess between two", () => {
    // A wrong mapping is the failure presets exist to prevent, so two
    // candidates means no pre-selection at all.
    expect(
      presetIdForAnswer({ volume: "200+", channels: ["etsy", "shopify"] }),
    ).toBeNull();
  });

  it("the file's own headers still win", () => {
    // Detection reads the actual file; the signup answer is a memory of what
    // somebody said. The page must prefer the evidence.
    const page = read("src/pages/flipdesk/import.tsx");
    expect(page).toMatch(/const detected = detectImportPreset\(h\);/);
    expect(page).toMatch(/detected \?\? getImportPreset\(presetIdForAnswer\(signupAnswer\)/);
  });
});

describe("the onboarding step itself (US-3264)", () => {
  const src = read("src/components/onboarding/onboarding-flow.tsx");

  it("is a step of its own for sellers, and the tour shifts behind it", () => {
    expect(src).toMatch(/const listingsStep = asksListings \? 2 : -1;/);
    expect(src).toMatch(/const firstTourStep = asksListings \? 3 : 2;/);
    expect(src).toMatch(/const tourIndex = step - firstTourStep;/);
  });

  it("can be skipped in one press", () => {
    expect(src).toContain('"Skip this"');
  });

  it("routes through the shared helper rather than its own branch", () => {
    expect(src).toMatch(
      /navigate\(landingForAnswer\(useCase, listingsAnswer, nextActionFor\(useCase\)\)\)/,
    );
  });

  it("records the answer as analytics, not as free text", () => {
    expect(src).toContain('track("onboarding.existing_listings_answered"');
    // A bucket and marketplace ids. Nothing anybody typed.
    expect(src).toMatch(/volume: listingsAnswer\.volume/);
    expect(src).toMatch(/channel_count: listingsAnswer\.channels\.length/);
  });
});
