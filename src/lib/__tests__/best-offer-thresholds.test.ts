// US-2019 — WEB half of the shared Best Offer threshold guard.
//
// The clamp exists twice: the edge (best-offer.ts) is authoritative AT PUBLISH,
// and this mirror runs in the composer to clamp the seller's edits BEFORE they
// are persisted to the best_offer_* columns. US-2405: both take ONLY the two
// numbers the seller typed — the comp-band fallback is gone.
//
// The constraints are EBAY'S, not ours — autoAcceptPrice strictly below the
// listing price, autoDeclinePrice strictly below autoAcceptPrice. Violating
// them makes eBay REJECT the publish. So a drift here doesn't just look wrong:
// the composer saves thresholds that fail at publish time, after the seller
// believes they're finished.
//
// The edge asserts this same fixture in
// services/edge-functions/src/tests/best-offer-parity_test.ts.
import { describe, expect, it } from "vitest";
import { resolveBestOfferThresholds } from "@/lib/best-offer-thresholds";
import fixture from "../../test/fixtures/best-offer-threshold-cases.json";

describe("best offer thresholds (shared fixture)", () => {
  it("matches every case in the cross-project fixture", () => {
    expect(fixture.cases.length).toBeGreaterThan(10);
    for (const c of fixture.cases) {
      expect(resolveBestOfferThresholds(c.input), `case: ${c.name}`).toEqual(
        c.expected,
      );
    }
  });

  it("never returns an accept at or above the listing price", () => {
    // eBay rejects the publish outright, so this is the invariant that matters
    // most — asserted independently of the fixture in case a future case table
    // is trimmed.
    for (const accept of [9999, 10000, 10001, 50000]) {
      const got = resolveBestOfferThresholds({
        priceCents: 10000,
        acceptCents: accept,
        declineCents: null,
      });
      if (got.autoAcceptCents != null) {
        expect(got.autoAcceptCents, `accept=${accept}`).toBeLessThan(10000);
      }
    }
  });

  it("DROPS an inverted decline rather than rewriting the seller's number", () => {
    // Deliberate product behaviour: silently "fixing" a seller's threshold to
    // satisfy eBay would change a number they chose without telling them.
    const got = resolveBestOfferThresholds({
      priceCents: 10000,
      acceptCents: 7000,
      declineCents: 9000,
    });
    expect(got.autoAcceptCents).toBe(7000);
    expect(got.autoDeclineCents).toBeNull();
  });

  // US-2405: the regression that made these manual. A blank box must NEVER be
  // filled in for the seller — the value gets persisted and then outlives the
  // price it came from.
  it("leaves blank thresholds blank", () => {
    expect(
      resolveBestOfferThresholds({
        priceCents: 29800,
        acceptCents: null,
        declineCents: null,
      }),
    ).toEqual({ autoAcceptCents: null, autoDeclineCents: null });
  });
});
