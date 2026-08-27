// US-2236 AC1: the auto-accept / auto-decline decision.
//
// This module answers offers with real money attached and no human in the loop,
// so the cases below are weighted toward what it must REFUSE to do rather than
// toward the happy path. The single most important one is the margin floor: an
// automation that sells below cost is worse than no automation at all.

import { assert, assertEquals } from "@std/assert";
import {
  decideOffer,
  DEFAULT_OFFER_MARGIN_FLOOR_PCT,
  describeOfferOutcome,
  MAX_OFFER_THRESHOLD_PCT,
  MIN_OFFER_THRESHOLD_PCT,
  normalizeThresholdPct,
  type OfferRuleConfig,
} from "../lib/offer-rules.ts";

const CFG: OfferRuleConfig = {
  acceptAtPct: 85,
  declineBelowPct: 50,
  marginFloorPct: DEFAULT_OFFER_MARGIN_FLOOR_PCT,
};

// ── The two decisions that act ──────────────────────────────────────

Deno.test("US-2236: at or above the accept threshold, accept", () => {
  const at = decideOffer(CFG, { offerPrice: 85, listPrice: 100, itemCost: 20 });
  assertEquals(at.decision, "accept");
  assertEquals(at.reason, "accepted_at_threshold");
  assertEquals(at.pctOfList, 85);
  // "at or above", so exactly the threshold accepts — an off-by-one here means
  // the seller's stated number silently means "one cent more than this".
  assertEquals(
    decideOffer(CFG, { offerPrice: 95, listPrice: 100, itemCost: 20 }).decision,
    "accept",
  );
});

Deno.test("US-2236: strictly below the decline threshold, decline", () => {
  const below = decideOffer(CFG, { offerPrice: 49, listPrice: 100, itemCost: 10 });
  assertEquals(below.decision, "decline");
  assertEquals(below.reason, "declined_below_threshold");
  // STRICTLY below: an offer exactly at the decline threshold is not declined.
  // "decline below 50%" must not decline a 50% offer.
  assertEquals(
    decideOffer(CFG, { offerPrice: 50, listPrice: 100, itemCost: 10 }).decision,
    "skip",
  );
});

Deno.test("US-2236: between the thresholds, the human decides", () => {
  const mid = decideOffer(CFG, { offerPrice: 70, listPrice: 100, itemCost: 10 });
  assertEquals(mid.decision, "skip");
  assertEquals(mid.reason, "between_thresholds");
});

// ── The refusals ────────────────────────────────────────────────────

Deno.test("US-2236: never auto-accept below the margin floor, however high the percent", () => {
  // THE case. The seller said "accept at 85% of list" and meant it, but the
  // item cost more than the offer clears — accepting would book a loss with no
  // human anywhere near it. The percentage rule does not get to override this.
  const loss = decideOffer(CFG, { offerPrice: 90, listPrice: 100, itemCost: 100 });
  assertEquals(loss.decision, "skip");
  assertEquals(loss.reason, "below_margin_floor");

  // 10% floor over a $80 cost is $88, so $90 clears and $87 does not.
  assertEquals(
    decideOffer(CFG, { offerPrice: 90, listPrice: 100, itemCost: 80 }).decision,
    "accept",
  );
  assertEquals(
    decideOffer(CFG, { offerPrice: 87, listPrice: 100, itemCost: 80 }).decision,
    "skip",
  );
});

Deno.test("US-2236: the margin floor NEVER causes a decline, only ever blocks an accept", () => {
  // A margin floor that could decline would lose sales on the strength of a
  // bookkeeping error in the cost basis. It is one-directional by construction.
  const belowCostAndBelowDecline = decideOffer(CFG, {
    offerPrice: 40,
    listPrice: 100,
    itemCost: 200,
  });
  assertEquals(belowCostAndBelowDecline.decision, "decline");
  assertEquals(belowCostAndBelowDecline.reason, "declined_below_threshold");
});

Deno.test("US-2236: an unknown cost does not block the accept, and that is the recorded choice", () => {
  // The floor is a safety NET over a known number, not a precondition. Most
  // items in a young account have no acquisition cost recorded; refusing to act
  // without one would make the feature silently not work for them, which reads
  // as broken rather than as cautious.
  assertEquals(
    decideOffer(CFG, { offerPrice: 90, listPrice: 100, itemCost: null }).decision,
    "accept",
  );
  assertEquals(
    decideOffer(CFG, { offerPrice: 90, listPrice: 100, itemCost: 0 }).decision,
    "accept",
  );
});

Deno.test("US-2236: contradictory thresholds do nothing and say so", () => {
  // Some offer would qualify for BOTH. Picking one silently would hide a
  // mistake the seller can fix in a second.
  const bad: OfferRuleConfig = { ...CFG, acceptAtPct: 40, declineBelowPct: 60 };
  const out = decideOffer(bad, { offerPrice: 50, listPrice: 100, itemCost: null });
  assertEquals(out.decision, "skip");
  assertEquals(out.reason, "thresholds_contradict");

  // Equal is also contradictory: "accept at 50" and "decline below 50" leave a
  // coherent partition, but any drift in either direction overlaps, and the
  // seller almost certainly meant a gap.
  const equal: OfferRuleConfig = { ...CFG, acceptAtPct: 50, declineBelowPct: 50 };
  assertEquals(
    decideOffer(equal, { offerPrice: 60, listPrice: 100, itemCost: null }).reason,
    "thresholds_contradict",
  );
});

Deno.test("US-2236: missing evidence never acts", () => {
  assertEquals(
    decideOffer(CFG, { offerPrice: 90, listPrice: null, itemCost: 10 }).reason,
    "no_list_price",
  );
  assertEquals(
    decideOffer(CFG, { offerPrice: 90, listPrice: 0, itemCost: 10 }).reason,
    "no_list_price",
  );
  assertEquals(
    decideOffer(CFG, { offerPrice: null, listPrice: 100, itemCost: 10 }).reason,
    "no_offer_price",
  );
  assertEquals(
    decideOffer(CFG, { offerPrice: Number.NaN, listPrice: 100, itemCost: 10 }).reason,
    "no_offer_price",
  );
});

Deno.test("US-2236: a rule with neither threshold set is inert", () => {
  const none: OfferRuleConfig = { ...CFG, acceptAtPct: null, declineBelowPct: null };
  const out = decideOffer(none, { offerPrice: 99, listPrice: 100, itemCost: 1 });
  assertEquals(out.decision, "skip");
  assertEquals(out.reason, "no_thresholds_set");
});

Deno.test("US-2236: one threshold alone works — accepting without declining and vice versa", () => {
  const acceptOnly: OfferRuleConfig = { ...CFG, declineBelowPct: null };
  assertEquals(
    decideOffer(acceptOnly, { offerPrice: 20, listPrice: 100, itemCost: null }).decision,
    "skip",
  );
  assertEquals(
    decideOffer(acceptOnly, { offerPrice: 90, listPrice: 100, itemCost: null }).decision,
    "accept",
  );

  const declineOnly: OfferRuleConfig = { ...CFG, acceptAtPct: null };
  assertEquals(
    decideOffer(declineOnly, { offerPrice: 99, listPrice: 100, itemCost: null }).decision,
    "skip",
  );
  assertEquals(
    decideOffer(declineOnly, { offerPrice: 20, listPrice: 100, itemCost: null }).decision,
    "decline",
  );
});

// ── Configuration hygiene ───────────────────────────────────────────

Deno.test("US-2236: thresholds clamp into the allowed band instead of being rejected", () => {
  assertEquals(normalizeThresholdPct(150), MAX_OFFER_THRESHOLD_PCT);
  assertEquals(normalizeThresholdPct(0), MIN_OFFER_THRESHOLD_PCT);
  assertEquals(normalizeThresholdPct(-20), MIN_OFFER_THRESHOLD_PCT);
  assertEquals(normalizeThresholdPct(84.6), 85);
  assertEquals(normalizeThresholdPct("85"), 85);
  // Unusable input is null — "no threshold", not a defaulted one. A default
  // here would invent a rule the seller never asked for.
  assertEquals(normalizeThresholdPct(null), null);
  assertEquals(normalizeThresholdPct("nope"), null);
  assertEquals(normalizeThresholdPct(undefined), null);
});

Deno.test("US-2236: every outcome has seller-facing copy, and no skip is unexplained", () => {
  // A silent skip is what makes an automation feel broken while it is working.
  const reasons = [
    { offerPrice: 90, listPrice: 100, itemCost: 20 },
    { offerPrice: 10, listPrice: 100, itemCost: 1 },
    { offerPrice: 70, listPrice: 100, itemCost: 1 },
    { offerPrice: 90, listPrice: 100, itemCost: 100 },
    { offerPrice: 90, listPrice: null, itemCost: 1 },
    { offerPrice: null, listPrice: 100, itemCost: 1 },
  ];
  for (const f of reasons) {
    const copy = describeOfferOutcome(decideOffer(CFG, f));
    assertEquals(typeof copy, "string");
    assertEquals(copy.length > 0, true);
  }
  assertEquals(
    describeOfferOutcome(decideOffer(CFG, { offerPrice: 90, listPrice: 100, itemCost: 100 })),
    "Left for you — 90% of asking, but that is at or below what the item cost.",
  );
});

// ── US-2940: the counter ────────────────────────────────────────────
//
// Countering is what an offer below the accept threshold is actually worth: an
// offer at 70% of list is a negotiation, and declining it ends one. The rules
// engine could accept, decline or skip, and the missing verb was the valuable
// one.
//
// The ORDER is the contract and is what these pin: accept beats counter (a sale
// now beats a negotiation), counter beats decline (a negotiation beats ending
// the conversation).

const COUNTER_CFG = {
  acceptAtPct: 90,
  declineBelowPct: 50,
  marginFloorPct: 10,
  counterAtPct: 85,
};

Deno.test("US-2940: an offer between the bands is COUNTERED, not skipped", () => {
  const out = decideOffer(COUNTER_CFG, { offerPrice: 70, listPrice: 100, itemCost: 20 });
  assertEquals(out.decision, "counter");
  assertEquals(out.reason, "countered_at_threshold");
  assertEquals(out.counterPrice, 85);
});

Deno.test("US-2940: accept wins over counter", () => {
  // 95% clears the accept threshold AND is below the counter price. A sale now
  // beats a negotiation.
  const out = decideOffer(COUNTER_CFG, { offerPrice: 95, listPrice: 100, itemCost: 20 });
  assertEquals(out.decision, "accept");
});

Deno.test("US-2940: counter wins over decline", () => {
  // 30% is below the decline threshold. With countering on, it becomes a
  // negotiation rather than the end of one.
  const out = decideOffer(COUNTER_CFG, { offerPrice: 30, listPrice: 100, itemCost: 20 });
  assertEquals(out.decision, "counter");
});

Deno.test("US-2940: with countering OFF the decline band behaves exactly as before", () => {
  // The additive-feature rule: disabled, the engine is byte-identical to the
  // one that shipped before it.
  const off = { ...COUNTER_CFG, counterAtPct: null };
  assertEquals(
    decideOffer(off, { offerPrice: 30, listPrice: 100, itemCost: 20 }).decision,
    "decline",
  );
  assertEquals(
    decideOffer(off, { offerPrice: 70, listPrice: 100, itemCost: 20 }).decision,
    "skip",
  );
});

Deno.test("US-2940: the margin floor turns a counter into a SKIP, never a decline", () => {
  // A counter is an offer to sell at that price, so a counter under the floor
  // is a loss the seller merely has to wait for. It must not become a decline:
  // that would be the floor causing a lost sale, which the header forbids.
  const out = decideOffer(COUNTER_CFG, { offerPrice: 70, listPrice: 100, itemCost: 90 });
  assertEquals(out.decision, "skip");
  assertEquals(out.reason, "below_margin_floor");
});

Deno.test("US-2940: a counter that cannot sit above the offer is a skip", () => {
  // Offer 88, counter at 85% of 100 = 85. Countering BELOW what the buyer
  // already offered is an insult with extra steps, and clamping it would hide
  // a configuration the seller can fix in a second.
  const out = decideOffer(COUNTER_CFG, { offerPrice: 88, listPrice: 100, itemCost: 10 });
  assertEquals(out.decision, "skip");
  assertEquals(out.reason, "counter_not_possible");
});

Deno.test("US-2940: a counter at or above list is a skip", () => {
  const out = decideOffer(
    { ...COUNTER_CFG, acceptAtPct: null, counterAtPct: 100 },
    { offerPrice: 50, listPrice: 100, itemCost: 10 },
  );
  assertEquals(out.decision, "skip");
  assertEquals(out.reason, "counter_not_possible");
});

Deno.test("US-2940: the counter price is money, rounded to the cent", () => {
  // eBay rejects a counter with more precision than that, and a 502 from a
  // third decimal place is a defect that only shows up in production.
  const out = decideOffer(
    { acceptAtPct: null, declineBelowPct: null, marginFloorPct: 0, counterAtPct: 83 },
    { offerPrice: 10, listPrice: 33.33, itemCost: null },
  );
  assertEquals(out.decision, "counter");
  assertEquals(out.counterPrice, 27.66);
});

Deno.test("US-2940: the copy names the counter price", () => {
  const out = decideOffer(COUNTER_CFG, { offerPrice: 70, listPrice: 100, itemCost: 20 });
  const copy = describeOfferOutcome(out);
  assert(copy.includes("85.00"), copy);
  assert(copy.toLowerCase().includes("countered"), copy);
});
