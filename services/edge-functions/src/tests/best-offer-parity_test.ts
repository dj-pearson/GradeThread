// US-2019 — EDGE half of the shared Best Offer threshold guard.
//
// resolveBestOfferThresholds here is AUTHORITATIVE: it clamps immediately before
// the eBay publish call. src/lib/best-offer-thresholds.ts mirrors it so the
// composer can prefill and clamp a seller's edits up front.
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
      p25Cents: number | null;
      p75Cents: number | null;
      acceptOverrideCents: number | null;
      declineOverrideCents: number | null;
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
  for (const p75 of [9999, 10000, 10001, 50000]) {
    const got = resolveBestOfferThresholds({
      priceCents: 10000,
      p25Cents: null,
      p75Cents: p75,
      acceptOverrideCents: null,
      declineOverrideCents: null,
    });
    if (got.autoAcceptCents != null) {
      assertEquals(got.autoAcceptCents < 10000, true, `p75=${p75}`);
    }
  }
});
