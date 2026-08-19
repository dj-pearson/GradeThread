// US-2679: the Listing Quality Score in the composer.
//
// AC6 asks for proof that the composer requests the score once per item and not
// on every keystroke. There is no @testing-library/react in this repo, so a
// render-and-type test is not available — and a grep for "useListingQuality"
// would prove only that the string exists.
//
// So the query configuration was EXTRACTED into values that can be asserted
// (listingQualityQueryKey, LISTING_QUALITY_QUERY_OPTIONS) and the assertions
// below are about the real objects the hook passes to TanStack Query, not about
// source text. The source-scan half is kept for the one thing objects cannot
// show: which argument the composer actually hands the hook.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LISTING_QUALITY_QUERY_OPTIONS,
  listingQualityQueryKey,
} from "../hooks/use-ebay";
import { anchorForFixSurface } from "../lib/publish-blockers";

const ROOT = process.cwd();
const composer = readFileSync(join(ROOT, "src/pages/flipdesk/composer.tsx"), "utf8");
const qualityCard = readFileSync(
  join(ROOT, "src/components/flipdesk/composer/quality-card.tsx"),
  "utf8",
);

describe("AC6: the score is fetched per item, not per keystroke", () => {
  it("the query key is the item id and nothing else", () => {
    // Anything else in here — the title, the price, a dirty flag — would make
    // TanStack treat an edit as a new query and re-run the whole publish
    // preflight, which talks to eBay.
    expect(listingQualityQueryKey("item-1")).toEqual(["listing-quality", "item-1"]);
    expect(listingQualityQueryKey("item-1")).toHaveLength(2);
  });

  it("the same item produces the same key, so typing cannot change it", () => {
    expect(listingQualityQueryKey("item-1")).toEqual(listingQualityQueryKey("item-1"));
  });

  it("a different item DOES produce a different key", () => {
    // The other half: a key so stable it never changes would be a cache that
    // never updates.
    expect(listingQualityQueryKey("item-1")).not.toEqual(listingQualityQueryKey("item-2"));
  });

  it("window focus does not re-run the preflight", () => {
    // TanStack defaults this to true. Alt-tabbing away and back is not a change
    // to the listing, and each refetch is a real eBay round trip.
    expect(LISTING_QUALITY_QUERY_OPTIONS.refetchOnWindowFocus).toBe(false);
  });

  it("results are held long enough that remounting a card does not refetch", () => {
    expect(LISTING_QUALITY_QUERY_OPTIONS.staleTime).toBeGreaterThan(0);
  });

  it("the composer passes the ITEM ID to the hook, not a field it edits", () => {
    // The one thing the exported objects cannot show. A regex, deliberately
    // narrow: it fails if someone passes title, or an object, or a template.
    expect(composer).toMatch(/useListingQuality\(item\?\.id\)/);
  });
});

describe("AC2: every fix knows where it goes", () => {
  it("each composer fixSurface maps to an anchor id", () => {
    // The exact strings listing-quality-score.ts sets on its components.
    expect(anchorForFixSurface("composer.title")).toBe("composer-title");
    expect(anchorForFixSurface("composer.photos")).toBe("composer-photos");
    expect(anchorForFixSurface("composer.category")).toBe("composer-category");
    expect(anchorForFixSurface("composer.price")).toBe("listing-price");
    expect(anchorForFixSurface("composer.condition")).toBe("ebay-condition");
  });

  it("item specifics land on the category section, where they are filled", () => {
    expect(anchorForFixSurface("composer.aspects")).toBe("composer-category");
  });

  it("a surface outside the composer returns null rather than a wrong anchor", () => {
    // Business policies are configured in eBay Seller Hub. The card shows the
    // fix and does NOT render a button for it — a button that scrolls nowhere
    // teaches the seller to stop trusting the others.
    expect(anchorForFixSurface("settings.businessPolicies")).toBeNull();
    expect(anchorForFixSurface("nonsense")).toBeNull();
  });

  it("every anchor the map returns exists in a composer component", () => {
    // The assertion that makes the rest of this block worth anything: a mapping
    // to an id nothing renders is a Fix button that silently does nothing.
    const sources = [
      "src/components/flipdesk/composer/title-card.tsx",
      "src/components/flipdesk/composer/photos-card.tsx",
      "src/components/flipdesk/composer/price-card.tsx",
      "src/components/flipdesk/composer/specifics-section.tsx",
    ]
      .map((p) => readFileSync(join(ROOT, p), "utf8"))
      .join("\n");

    for (const surface of [
      "composer.title",
      "composer.photos",
      "composer.category",
      "composer.aspects",
      "composer.price",
      "composer.condition",
    ]) {
      const anchor = anchorForFixSurface(surface);
      expect(anchor, `${surface} has no anchor`).toBeTruthy();
      expect(sources, `no element renders id="${anchor}" for ${surface}`).toContain(
        `id="${anchor}"`,
      );
    }
  });
});

describe("AC3/AC4/AC5: what the card renders, and what it refuses to", () => {
  it("AC4: no score renders nothing at all", () => {
    // Not an empty shell and not an error state. An item with no eBay category
    // has genuinely nothing to say, and both alternatives are worse: one takes
    // the space the title card should have, the other reports a failure that
    // did not happen.
    expect(qualityCard).toMatch(/if \(!score\) return null;/);
  });

  it("AC3: blockers render in their own block, not as another fix", () => {
    expect(qualityCard).toContain("blockingReasons");
    expect(qualityCard).toContain("cannot publish yet");
    // Destructive styling, so a seller triaging quickly cannot read a publish
    // blocker as a nice-to-have.
    expect(qualityCard).toContain("text-destructive");
  });

  it("AC5: the card is not marked with a coloured side border", () => {
    // The single most recognisable generated-UI tell, and ui:check enforces it
    // repo-wide. Asserted here too because this card is exactly the kind of
    // callout that attracts one.
    expect(qualityCard).not.toMatch(/border-l-\d/);
    expect(qualityCard).not.toMatch(/border-l-[0-9]+\s/);
  });

  it("only three fixes are shown, so it stays a nudge and not a to-do list", () => {
    expect(qualityCard).toMatch(/TOP_FIX_COUNT = 3/);
    expect(qualityCard).toMatch(/slice\(0, TOP_FIX_COUNT\)/);
  });

  it("nothing is recomputed on the client", () => {
    // The weights live in one place. A client that re-derived them would drift
    // from the number the product sorts by everywhere else.
    expect(qualityCard).not.toContain("QUALITY_WEIGHTS");
    expect(qualityCard).not.toMatch(/earned\s*\/\s*weight/);
  });
});
