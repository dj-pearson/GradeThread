// US-2019 — EDGE half of the shared Best Offer threshold guard.
//
// resolveBestOfferThresholds here is AUTHORITATIVE: it clamps immediately before
// the eBay publish call. src/lib/best-offer-thresholds.ts mirrors it so the
// composer can clamp a seller's edits up front. US-2405: both take ONLY the
// seller's own two numbers — there is no comp-derived default to drift on.
//
// The two projects cannot import each other, so one fixture asserted by both
// suites is the only thing keeping them aligned. See
// vault/70-agent/guards-that-cannot-fail.md — a mirror pinned by a comment is
// the shape that has already shipped wrong twice in this repo.

import { assertEquals } from "@std/assert";
import { resolveBestOfferThresholds } from "../lib/best-offer.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../../../src/test/fixtures/best-offer-threshold-cases.json",
      import.meta.url,
    ),
  ),
) as {
  cases: Array<{
    name: string;
    input: {
      priceCents: number;
      acceptCents: number | null;
      declineCents: number | null;
    };
    expected: { autoAcceptCents: number | null; autoDeclineCents: number | null };
  }>;
};

Deno.test("edge best-offer clamp matches the cross-project fixture", () => {
  assertEquals(
    fixture.cases.length > 10,
    true,
    "fixture looks truncated — it should cover the constraint boundaries",
  );
  for (const c of fixture.cases) {
    assertEquals(
      resolveBestOfferThresholds(c.input),
      c.expected,
      `case: ${c.name}`,
    );
  }
});

Deno.test("edge: accept is never at or above the listing price", () => {
  // eBay rejects the publish outright when this is violated — the single most
  // consequential of the two constraints.
  for (const accept of [9999, 10000, 10001, 50000]) {
    const got = resolveBestOfferThresholds({
      priceCents: 10000,
      acceptCents: accept,
      declineCents: null,
    });
    if (got.autoAcceptCents != null) {
      assertEquals(got.autoAcceptCents < 10000, true, `accept=${accept}`);
    }
  }
});

// US-2405: the regression that made these manual. A blank box must NEVER be
// filled in from the listing's comp band — the value would be persisted and then
// outlive the price it was derived from.
Deno.test("edge: blank thresholds stay blank", () => {
  assertEquals(
    resolveBestOfferThresholds({
      priceCents: 29800,
      acceptCents: null,
      declineCents: null,
    }),
    { autoAcceptCents: null, autoDeclineCents: null },
  );
});
