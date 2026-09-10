// US-3192: the seller's hard floor on one garment, honoured everywhere.
//
// The point of the story is that ONE number is respected by markdowns, comp
// auto-accepts, offer rules and bulk reduce alike. These tests are written
// against each of those paths separately, because a floor honoured by three of
// four is a floor the seller cannot trust at all.
import { assertEquals } from "@std/assert";
import {
  computeMarkdownCents,
  decideNewPriceCents,
  effectiveFloorCents,
} from "../lib/repricing-rules.ts";
import { planAction } from "../lib/automation-rules.ts";
import { decideOffer } from "../lib/offer-rules.ts";

Deno.test("effectiveFloorCents: the higher of the two floors binds", () => {
  assertEquals(effectiveFloorCents(2000, 2800), 2800);
  assertEquals(effectiveFloorCents(3000, 2800), 3000);
});

Deno.test("effectiveFloorCents: a null is the absence of a floor, not a floor of zero", () => {
  // The failure this pins: treating null as 0 would make max() pick 0 and
  // silently delete a real floor.
  assertEquals(effectiveFloorCents(null, 2800), 2800);
  assertEquals(effectiveFloorCents(2000, null), 2000);
  assertEquals(effectiveFloorCents(null, null), null);
});

Deno.test("effectiveFloorCents: a nonsense floor is ignored, not honoured", () => {
  assertEquals(effectiveFloorCents(Number.NaN, 2800), 2800);
  assertEquals(effectiveFloorCents(-100, 2800), 2800);
});

Deno.test("US-3192: a markdown that would cross the item floor stops at it", () => {
  // $40 listing, 30% off = $28, item floor $32. The rule has no floor of its own.
  assertEquals(computeMarkdownCents(4000, 30, null, 3200), 3200);
});

Deno.test("US-3192: the markdown is untouched when it stays above the floor", () => {
  assertEquals(computeMarkdownCents(4000, 10, null, 3200), 3600);
});

Deno.test("US-3192: an item with no floor behaves exactly as before", () => {
  assertEquals(computeMarkdownCents(4000, 30, null, null), 2800);
  assertEquals(computeMarkdownCents(4000, 30, null), 2800);
});

Deno.test("US-3192: a comp auto-accept cannot undercut the item floor", () => {
  // The comp says $22 with high confidence. The seller said never below $32.
  const decision = decideNewPriceCents({
    currentCents: 4000,
    dropPct: 0,
    floorCents: null,
    itemFloorCents: 3200,
    autoAcceptConfidence: 0.7,
    suggestion: { suggestedPriceCents: 2200, confidence: 0.9 },
  });
  assertEquals(decision, { newCents: 3200, reason: "auto_accept" });
});

Deno.test("US-3192: a listing already at its floor is a no-op, not a raise", () => {
  const decision = decideNewPriceCents({
    currentCents: 3200,
    dropPct: 20,
    floorCents: null,
    itemFloorCents: 3200,
    autoAcceptConfidence: null,
    suggestion: null,
  });
  assertEquals(decision, null);
});

Deno.test("US-3192: planAction takes the higher of the margin floor and the item floor", () => {
  // Cost $20, margin floor 10% => $22. Item floor $32 is the binding one.
  const planned = planAction(
    { type: "price_drop_pct", pct: 40, margin_floor_pct: 10 },
    { currentCents: 4000, costBasisDollars: 20, currentPromoRatePct: null, itemFloorCents: 3200 },
  );
  assertEquals(planned, { kind: "price_drop", newCents: 3200, floored: true });
});

Deno.test("US-3192: planAction still honours the margin floor when it is the higher one", () => {
  // Cost $40, margin floor 10% => $44, above the $32 item floor and above the
  // current price, so the drop floors out entirely.
  const planned = planAction(
    { type: "price_drop_pct", pct: 40, margin_floor_pct: 10 },
    { currentCents: 4000, costBasisDollars: 40, currentPromoRatePct: null, itemFloorCents: 3200 },
  );
  assertEquals(planned, null);
});

Deno.test("US-3192: an offer the percentage rule would accept is declined below the floor", () => {
  // 90% of a $40 list is $36 and the rule accepts at 85%, so the percentage
  // says yes. The seller's floor of $38 says no, and the floor wins.
  const outcome = decideOffer(
    { acceptAtPct: 85, declineBelowPct: 50, marginFloorPct: 10, counterAtPct: null },
    { offerPrice: 36, listPrice: 40, itemCost: null, itemFloorPrice: 38 },
  );
  assertEquals(outcome.decision, "skip");
  assertEquals(outcome.reason, "below_margin_floor");
});

Deno.test("US-3192: the item floor works when the cost basis is unknown", () => {
  // This is the case the percentage margin floor cannot cover at all: with no
  // cost, cost x (1 + pct) is nothing, so before this the offer was accepted.
  const accepted = decideOffer(
    { acceptAtPct: 85, declineBelowPct: 50, marginFloorPct: 10, counterAtPct: null },
    { offerPrice: 36, listPrice: 40, itemCost: null, itemFloorPrice: null },
  );
  assertEquals(accepted.decision, "accept");
});

Deno.test("US-3192: an offer above the floor is still accepted", () => {
  const outcome = decideOffer(
    { acceptAtPct: 85, declineBelowPct: 50, marginFloorPct: 10, counterAtPct: null },
    { offerPrice: 36, listPrice: 40, itemCost: null, itemFloorPrice: 30 },
  );
  assertEquals(outcome.decision, "accept");
});

Deno.test("US-3192: a counter below the item floor is skipped, like an accept", () => {
  // A counter is an offer to sell at that price, so the floor binds it too.
  const outcome = decideOffer(
    { acceptAtPct: 95, declineBelowPct: 40, marginFloorPct: 10, counterAtPct: 80 },
    { offerPrice: 28, listPrice: 40, itemCost: null, itemFloorPrice: 34 },
  );
  assertEquals(outcome.decision, "skip");
  assertEquals(outcome.reason, "below_margin_floor");
});

Deno.test("US-3192: the cost-based floor still binds when it is the higher one", () => {
  // Cost $35, 10% => $38.50. Item floor $30. The offer of $36 clears the item
  // floor and not the margin floor, and must still be refused.
  const outcome = decideOffer(
    { acceptAtPct: 85, declineBelowPct: 50, marginFloorPct: 10, counterAtPct: null },
    { offerPrice: 36, listPrice: 40, itemCost: 35, itemFloorPrice: 30 },
  );
  assertEquals(outcome.decision, "skip");
  assertEquals(outcome.reason, "below_margin_floor");
});

// ── The fifth path, found 2026-09-10 ──────────────────────────────
//
// The header above names four callers. There was a fifth: the bulk
// match-to-comp reprice at POST /api/flipdesk/pricing/reprice/preview and
// /reprice/apply. Both selected inventory_items.floor_price into the row and
// then priced off computeFloorCents(acquired_price) alone, so a seller who
// said "never below $28 on this jacket" could bulk-reprice it to $12 and the
// server would accept the write. The apply site is the one that matters: it
// re-derives the floor rather than trusting the preview, which is exactly why
// its floor being wrong was invisible from the screen.
//
// These are source-pinned rather than behavioural because the two floor sites
// live inside unexported route helpers that need a Supabase round trip. They
// assert the composition is present; item-floor-price's arithmetic tests above
// cover what the composition then does.
const PRICING_ROUTE = await Deno.readTextFile(
  new URL("../routes/flipdesk-pricing.ts", import.meta.url),
);

Deno.test("US-3192: the bulk reprice PREVIEW composes the item floor", () => {
  const site = PRICING_ROUTE.match(
    /const floorCents = effectiveFloorCents\(\s*computeFloorCents\([^)]*\),\s*itemFloorCents\(item\.floor_price\),\s*\)/,
  );
  assertEquals(
    site !== null,
    true,
    "buildPreviewRow no longer composes itemFloorCents into its margin floor - " +
      "the preview would show a suggested price below the seller's hard floor",
  );
});

Deno.test("US-3192: the bulk reprice APPLY composes the item floor", () => {
  const site = PRICING_ROUTE.match(
    /const floor = effectiveFloorCents\(\s*computeFloorCents\([\s\S]{0,120}?\),\s*itemFloorCents\(listing\.inventory_items\.floor_price\),\s*\)/,
  );
  assertEquals(
    site !== null,
    true,
    "applyRepriceFor no longer composes itemFloorCents into its margin floor - " +
      "a client could write a price below the seller's hard floor",
  );
});

Deno.test("US-3192: itemFloorCents keeps null as null, never zero", () => {
  // Pinned because effectiveFloorCents depends on the distinction: a null
  // coerced to 0 makes max() pick the other floor's value or 0, which silently
  // deletes the floor rather than failing.
  const helper = PRICING_ROUTE.match(
    /function itemFloorCents\(floorPriceDollars: number \| null\): number \| null \{[\s\S]*?\n\}/,
  );
  assertEquals(helper !== null, true, "itemFloorCents is gone from flipdesk-pricing.ts");
  assertEquals(
    /:\s*null;/.test(helper![0]),
    true,
    "itemFloorCents no longer returns null for an absent floor",
  );
});
