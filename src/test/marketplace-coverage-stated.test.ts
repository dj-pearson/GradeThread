import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LISTING_PLATFORMS, MARKETPLACE_LABELS } from "@/lib/constants";
import {
  coverageFor,
  FEATURE_COVERAGE,
  joinLabels,
  uncoveredReason,
} from "@/lib/marketplace-coverage";

// US-2541. FlipDesk registers eleven marketplaces. The offers, messages and
// post-sale screens drive the eBay hooks and nothing else, and said so nowhere
// — so an empty offers list read as "no offers" to a seller who also lists on
// Poshmark, when it meant "we do not read Poshmark". The returns list is the
// worst of the three: it is the one a seller checks to confirm nothing is
// waiting on them.

const OFFERS = "src/pages/flipdesk/offers.tsx";
const POST_SALE = "src/pages/flipdesk/post-sale.tsx";
const NOTE = "src/components/flipdesk/platform-coverage-note.tsx";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("both surfaces state what they cover (US-2541)", () => {
  it("each renders the coverage note", () => {
    expect(read(OFFERS)).toMatch(/<PlatformCoverageNote feature="offers"/);
    expect(read(POST_SALE)).toMatch(/feature="post_sale"/);
  });

  it("the covered list is the truth, not a claim", () => {
    // Both screens drive the eBay hooks only, so the note must say eBay only.
    expect(FEATURE_COVERAGE.offers).toEqual(["ebay"]);
    expect(FEATURE_COVERAGE.post_sale).toEqual(["ebay"]);
    const offers = read(OFFERS);
    // If a non-eBay hook ever appears on this page, the coverage map has to
    // move with it — this is the pairing that keeps the note honest.
    expect(offers).not.toMatch(/use(Etsy|Depop|Shopify|Poshmark)[A-Za-z]*\(/);
  });

  it("every registered marketplace is accounted for", () => {
    const { covered, uncovered } = coverageFor("offers");
    const named = new Set([
      ...covered.map((c) => c.id),
      ...uncovered.map((u) => u.id),
    ]);
    // `other` is the manual-tracking bucket, not a marketplace.
    for (const id of LISTING_PLATFORMS) {
      if (id === "other") continue;
      expect(named.has(id), `${id} is in neither list`).toBe(true);
    }
    expect(uncovered.length).toBeGreaterThan(5);
  });

  it("a new marketplace defaults to uncovered", () => {
    // The list is derived from LISTING_PLATFORMS, so adding one shows up as
    // uncovered — the truthful default — rather than being silently claimed.
    const { covered } = coverageFor("messages");
    expect(covered.map((c) => c.id)).toEqual(["ebay"]);
    expect(Object.keys(MARKETPLACE_LABELS).length).toBeGreaterThan(
      covered.length,
    );
  });

  it("the reason matches what the Marketplaces page already says", () => {
    // Consistent with the US-2475 mechanism classification: an extension
    // channel has no public API, an api channel has one that stops at
    // listings.
    expect(uncoveredReason("poshmark")).toMatch(/no public API/);
    expect(uncoveredReason("etsy")).toMatch(/listings, not negotiation/);
    expect(uncoveredReason("whatnot")).toMatch(/no integration/);
  });

  it("the note leads with the answer and folds the detail away", () => {
    const src = read(NOTE);
    // The first line is what a seller reads without clicking.
    expect(src).toMatch(/come from <strong>\{joinLabels\(covered\)\}<\/strong> only/);
    expect(src).toMatch(/aria-expanded=\{open\}/);
    // And "why not" is answerable, not a dead end.
    expect(src).toContain("/dashboard/flipdesk/marketplaces");
  });

  it("reads as a sentence at one, two and many", () => {
    expect(joinLabels([])).toBe("no marketplaces");
    expect(joinLabels([{ label: "eBay" }])).toBe("eBay");
    expect(joinLabels([{ label: "eBay" }, { label: "Etsy" }])).toBe(
      "eBay and Etsy",
    );
    expect(
      joinLabels([{ label: "eBay" }, { label: "Etsy" }, { label: "Depop" }]),
    ).toBe("eBay, Etsy and Depop");
  });
});

describe("an empty list looks like an answer (US-2541)", () => {
  it("the messages list uses a real empty state", () => {
    const src = read(OFFERS);
    expect(src).not.toMatch(/<p className="text-sm text-muted-foreground">No recent messages\.<\/p>/);
    expect(src).toMatch(/title="No recent buyer messages"/);
    // And it repeats the coverage where the ambiguity actually bites.
    expect(src).toMatch(/not read by GradeThread/);
  });

  it("the post-sale lists say which marketplace they are empty FOR", () => {
    const src = read(POST_SALE);
    expect(src).toMatch(/function EmptyRow/);
    expect(src).toMatch(/<EmptyState/);
    expect(src).toContain("eBay cases only");
    // The bare paragraph is gone.
    expect(src).not.toMatch(
      /function EmptyRow[\s\S]{0,80}return <p className="text-sm text-muted-foreground">\{text\}<\/p>/,
    );
  });
});
