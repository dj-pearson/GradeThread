import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// US-9025. Five marketing surfaces claimed FlipDesk "pulls eBay sold comps".
// It cannot: EBAY_MARKETPLACE_INSIGHTS has never been granted, so
// searchSoldComps() returns null before it opens a socket, and the only eBay
// prices the product can reach are ACTIVE asking prices.
//
// US-2850 fixed every surface that RENDERS a price and left the marketing
// registry alone, because the registry renders prose about prices rather than
// prices. This is the guard that closes that gap.
//
// WHAT THIS DOES NOT BAN IS THE POINT. "Sold" is a perfectly true word here:
// src/lib/seo/opportunist-guides.ts teaches the reader to tick eBay's own Sold
// items filter, and /tools/ebay-sold-listings hands them the search. Both are
// correct and a naive grep for "sold comps" would fail them. The defect is
// narrower and it is a CAPABILITY claim: GradeThread or FlipDesk being the
// subject of a verb that reaches eBay sold data.

const SEO_DIR = join(process.cwd(), "src", "lib", "seo");

/**
 * A product claiming it fetches eBay sold data.
 *
 * The subject has to be us, so a sentence about what the reader should search
 * for does not match. "FlipDesk pulls eBay sold comps" does; "search eBay's
 * sold listings" does not.
 */
const OVERCLAIM =
  /\b(gradethread|flipdesk|autolister|we)\b[^.!?]{0,80}\b(pull|pulls|pulled|fetch|fetches|read|reads|draw|draws|drawn|use|uses)\b[^.!?]{0,60}\bsold\b/i;

/**
 * A number described as a realised sale, with no product subject in the
 * sentence to make it a capability claim.
 *
 * SCOPED TO THE PRODUCT REGISTRIES ON PURPOSE. The first cut of this guard ran
 * it everywhere and produced six findings, four of which were the site telling
 * the truth: "Look up what comparable items actually sold for, and price to
 * that" is correct advice, and "sold comps are the prices comparable items
 * actually sold for" is a correct definition. Only a page whose whole subject
 * is what FlipDesk does can carry an unattributed "real sold comps" and mean
 * the product.
 */
const PRODUCT_UNQUALIFIED = /\bactually sold for\b|\breal sold comps\b|\bfrom sold comps\b/i;
const PRODUCT_REGISTRIES = ["flipdesk-landing.ts"];

function seoFiles(): string[] {
  return readdirSync(SEO_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(SEO_DIR, f));
}

describe("no marketing surface claims GradeThread reads eBay sold data", () => {
  it("scans a registry that actually exists", () => {
    // A guard whose glob silently matches nothing passes forever.
    const files = seoFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("flipdesk-landing.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("calculators.ts"))).toBe(true);
  });

  it("catches the shapes it is meant to catch", () => {
    // Assert the patterns fire on the exact sentences that were removed, so a
    // later rewrite of a pattern cannot quietly disarm the guard.
    expect(OVERCLAIM.test("FlipDesk pulls eBay sold comps and keeps them condition-aware")).toBe(true);
    expect(OVERCLAIM.test("GradeThread's comp tool pulls recent eBay sold comps for an item")).toBe(true);
    expect(OVERCLAIM.test("FlipDesk pulls recent eBay sold comps per item")).toBe(true);
    expect(
      PRODUCT_UNQUALIFIED.test("what comparable items in the same condition actually sold for"),
    ).toBe(true);
    expect(PRODUCT_UNQUALIFIED.test("Price to real sold comps, by condition")).toBe(true);
  });

  it("does not fire on the site telling the reader to use eBay's own filter", () => {
    // These are correct and must stay legal, or the guard would push the site
    // towards a worse answer than the one it has.
    expect(OVERCLAIM.test("On eBay, filter to Sold Items.")).toBe(false);
    expect(OVERCLAIM.test("Search eBay's sold listings for comparable items")).toBe(false);
    expect(
      OVERCLAIM.test("Sold comps are the prices that comparable items actually sold for on eBay"),
    ).toBe(false);
    expect(
      OVERCLAIM.test("Look up what comparable items in the same condition actually sold for"),
    ).toBe(false);
  });

  it("finds no overclaim in the registry", () => {
    const hits: string[] = [];
    for (const file of seoFiles()) {
      const name = file.split(/[\\/]/).pop()!;
      const isProductRegistry = PRODUCT_REGISTRIES.includes(name);
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith("//")) return; // comments explain the rule
        const bad =
          OVERCLAIM.test(line) || (isProductRegistry && PRODUCT_UNQUALIFIED.test(line));
        if (bad) hits.push(`${name}:${i + 1} ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("still scans the file the defect was found in", () => {
    // PRODUCT_REGISTRIES is a narrowing, and a narrowing that drifts to empty
    // is a guard that passes forever.
    for (const name of PRODUCT_REGISTRIES) {
      expect(seoFiles().some((f) => f.endsWith(name)), name).toBe(true);
    }
  });
});
