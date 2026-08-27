// US-562 / US-2405: best-offer threshold validation + eBay-constraint clamping.
// The thresholds are the seller's own numbers; nothing is derived. Pure math
// (no env / I/O), so a direct import is fine.
import { assert, assertEquals } from "@std/assert";
import {
  centsToMoneyString,
  reconcileAutoAcceptWithRule,
  resolveBestOfferThresholds,
} from "../lib/best-offer.ts";

Deno.test("keeps the seller's thresholds when both sit below list", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 5000, // $50 list
    acceptCents: 4500, // $45
    declineCents: 3000, // $30
  });
  assertEquals(r.autoAcceptCents, 4500);
  assertEquals(r.autoDeclineCents, 3000);
});

Deno.test("clamps accept to one cent under list when it exceeds the price", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 4000, // $40 list
    acceptCents: 6000, // above list → must be nudged below list
    declineCents: 2500,
  });
  assertEquals(r.autoAcceptCents, 3999);
  assertEquals(r.autoDeclineCents, 2500);
  assert(r.autoAcceptCents! < 4000);
  assert(r.autoDeclineCents! < r.autoAcceptCents!);
});

// US-2405 is exactly this test. It used to read "no comp stats and no overrides
// → both null", which meant the opposite: WITH comp stats, blank boxes were
// filled in from them, saved to the columns, and left behind by the next
// reprice. A $298 shirt kept auto-accepting at $27.50.
Deno.test("blank thresholds stay blank — never derived from anything", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 29800,
    acceptCents: null,
    declineCents: null,
  });
  assertEquals(r.autoAcceptCents, null);
  assertEquals(r.autoDeclineCents, null);
});

Deno.test("drops decline when it is not strictly below accept", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 10000,
    acceptCents: 6000,
    declineCents: 7000, // decline >= accept → invalid, drop it
  });
  assertEquals(r.autoAcceptCents, 6000);
  assertEquals(r.autoDeclineCents, null);
});

Deno.test("decline-only must still sit below list price", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 3000,
    acceptCents: null,
    declineCents: 3500, // above list, no accept set → drop
  });
  assertEquals(r.autoAcceptCents, null);
  assertEquals(r.autoDeclineCents, null);
});

Deno.test("ignores non-positive / non-finite values", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 5000,
    acceptCents: Number.NaN,
    declineCents: -100,
  });
  assertEquals(r.autoAcceptCents, null);
  assertEquals(r.autoDeclineCents, null);
});

Deno.test("centsToMoneyString formats whole cents as money", () => {
  assertEquals(centsToMoneyString(2499), "24.99");
  assertEquals(centsToMoneyString(4000), "40.00");
  assertEquals(centsToMoneyString(5), "0.05");
});

// ── US-2944: the rules engine and eBay's own auto-accept ────────────
//
// Two systems decide the same offer and nothing checked they agreed. eBay's
// auto-accept fires the instant a bid lands; the FlipDesk rule runs hourly and
// applies a margin floor eBay knows nothing about. eBay always wins the race,
// so a stored auto-accept BELOW the rule's number is a hole — an offer in the
// gap is taken at a price the rule would have refused.
//
// One direction only: this can RAISE the pushed price or drop it, never lower
// it, and never invent one.

Deno.test("US-2944: with no rule, the seller's own number is untouched", () => {
  const out = reconcileAutoAcceptWithRule({
    priceCents: 10_000,
    sellerAcceptCents: 7_000,
    ruleAcceptAtPct: null,
    ruleMarginFloorPct: 10,
    itemCostCents: 2_000,
  });
  assertEquals(out.autoAcceptCents, 7_000);
  assertEquals(out.reason, "no_rule");
});

Deno.test("US-2944: a BLANK seller threshold pushes nothing, whatever the rule says", () => {
  // US-2405 in force. A rule is not permission to derive a threshold the seller
  // never set — a derived number stops tracking anything the moment the item is
  // repriced, which is how a $28 offer came to be auto-accepted on a $298 item.
  const out = reconcileAutoAcceptWithRule({
    priceCents: 10_000,
    sellerAcceptCents: null,
    ruleAcceptAtPct: 90,
    ruleMarginFloorPct: 10,
    itemCostCents: 2_000,
  });
  assertEquals(out.autoAcceptCents, null);
  assertEquals(out.reason, "no_seller_threshold");
});

Deno.test("US-2944: a seller number BELOW the rule is raised to the rule", () => {
  // The hole. Without this, eBay takes a $50 offer that the rule would have
  // left for the seller.
  const out = reconcileAutoAcceptWithRule({
    priceCents: 10_000,
    sellerAcceptCents: 5_000,
    ruleAcceptAtPct: 90,
    ruleMarginFloorPct: 10,
    itemCostCents: 2_000,
  });
  assertEquals(out.autoAcceptCents, 9_000);
  assertEquals(out.reason, "raised_to_rule");
});

Deno.test("US-2944: a seller number ABOVE the rule is left alone", () => {
  // Never lowered. The seller being stricter than their own rule is not a
  // conflict to resolve.
  const out = reconcileAutoAcceptWithRule({
    priceCents: 10_000,
    sellerAcceptCents: 9_500,
    ruleAcceptAtPct: 90,
    ruleMarginFloorPct: 10,
    itemCostCents: 2_000,
  });
  assertEquals(out.autoAcceptCents, 9_500);
  assertEquals(out.reason, "matched");
});

Deno.test("US-2944: the margin floor raises the pushed price above the rule's percent", () => {
  // Cost $80 with a 10% floor is $88, which is above the rule's 60% of $100.
  // eBay must not be allowed to accept at $60 on an item that has to clear $88.
  const out = reconcileAutoAcceptWithRule({
    priceCents: 10_000,
    sellerAcceptCents: 5_000,
    ruleAcceptAtPct: 60,
    ruleMarginFloorPct: 10,
    itemCostCents: 8_000,
  });
  assertEquals(out.autoAcceptCents, 8_800);
  assertEquals(out.reason, "raised_to_margin_floor");
});

Deno.test("US-2944: when no valid price exists, nothing is pushed", () => {
  // Cost $110 on a $100 listing: every price the rule would allow is above
  // list, which eBay rejects. Pushing nothing beats pushing a number the rule
  // would refuse.
  const out = reconcileAutoAcceptWithRule({
    priceCents: 10_000,
    sellerAcceptCents: 5_000,
    ruleAcceptAtPct: 90,
    ruleMarginFloorPct: 10,
    itemCostCents: 11_000,
  });
  assertEquals(out.autoAcceptCents, null);
  assertEquals(out.reason, "dropped_no_valid_price");
});

Deno.test("US-2944: an unknown cost skips the floor rather than assuming zero", () => {
  const out = reconcileAutoAcceptWithRule({
    priceCents: 10_000,
    sellerAcceptCents: 5_000,
    ruleAcceptAtPct: 70,
    ruleMarginFloorPct: 50,
    itemCostCents: null,
  });
  assertEquals(out.autoAcceptCents, 7_000);
  assertEquals(out.reason, "raised_to_rule");
});
