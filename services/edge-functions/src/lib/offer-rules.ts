// US-2236 AC1: auto-accept and auto-decline thresholds for incoming Best Offers.
//
// Every offer was answered by hand. At any volume that is the bottleneck, and
// it is worse than it sounds because offers EXPIRE — an unanswered 95%-of-list
// offer is not a deferred decision, it is a lost sale.
//
// ── WHY THIS IS ITS OWN MODULE AND NOT ANOTHER automation-rules TRIGGER ─────
//
// The automations engine (US-150 / US-2156) evaluates ONE listing at a time and
// plans ONE action for it. An offer rule does not fit that shape: a single
// listing can carry several open offers, each with its own price and its own
// answer, and the decision is a property of the OFFER rather than of the
// listing. Bending planAction() to return a list of per-offer actions would
// have made every existing caller handle a case that only this feature
// produces.
//
// So the evaluation unit here is an offer, the rules are stored as ordinary
// flipdesk_automation_rules rows (no migration — trigger_json and action_json
// are jsonb), and they are executed by a step inside the EXISTING hourly
// automation-rules cron rather than by a new job. Same lock, same plan gate,
// same cadence, no cron-registry change.
//
// ── THE ONE THING THIS MUST NEVER DO ────────────────────────────────────────
//
// Sell below cost without a human. `marginFloorPct` is a hard refusal on the
// ACCEPT side, and it is one-directional by construction: it can only ever turn
// an accept into a skip, never turn a skip into an accept, and it never touches
// the decline side. A margin floor that could cause a decline would be a
// different and much worse feature — declining a fair offer because our cost
// basis is wrong loses a sale on the strength of a bookkeeping error.

/** What the runner should do with one offer. */
export type OfferDecision = "accept" | "decline" | "counter" | "skip";

export interface OfferRuleConfig {
  /** Accept at or above this percent of list price. Null disables accepting. */
  acceptAtPct: number | null;
  /** Decline strictly below this percent of list price. Null disables declining. */
  declineBelowPct: number | null;
  /**
   * Minimum margin over acquisition cost an AUTO-accept must clear, in percent.
   * Only consulted when the cost is known — see the header.
   */
  marginFloorPct: number;
  /**
   * US-2940: counter at this percent of list price. Null disables countering.
   *
   * A counter is what an offer below the accept threshold is actually worth: an
   * offer at 70% of list is a negotiation, and declining it ends one. This is
   * the single most valuable thing the rules engine could not do.
   */
  counterAtPct?: number | null;
}

export interface OfferFacts {
  /** The buyer's offer, in dollars. */
  offerPrice: number | null;
  /** The listing's asking price, in dollars. */
  listPrice: number | null;
  /** Acquisition cost in dollars, or null when the item has none recorded. */
  itemCost: number | null;
}

export interface OfferOutcome {
  decision: OfferDecision;
  /**
   * Machine-readable why. Stored on the run record and shown to the seller —
   * "skipped" with no reason is the shape that makes an automation feel broken
   * when it is in fact working correctly.
   */
  reason:
    | "accepted_at_threshold"
    | "countered_at_threshold"
    | "counter_not_possible"
    | "declined_below_threshold"
    | "between_thresholds"
    | "no_list_price"
    | "no_offer_price"
    | "below_margin_floor"
    | "thresholds_contradict"
    | "no_thresholds_set";
  /** The offer as a percent of list price, rounded to 0.1. Null when unknowable. */
  pctOfList: number | null;
  /**
   * US-2940: what to counter at, in dollars. Present only on a `counter`.
   *
   * Computed here rather than by the runner so the number the seller previews
   * and the number eBay receives are the same one.
   */
  counterPrice?: number;
}

export const MIN_OFFER_THRESHOLD_PCT = 1;
export const MAX_OFFER_THRESHOLD_PCT = 100;
/**
 * Default margin over cost an auto-accept must clear.
 *
 * Mirrors DEFAULT_MARGIN_FLOOR_PCT in automation-rules.ts by VALUE and
 * deliberately not by import: that one guards an automated price DROP, this one
 * guards an automated SALE, and the day someone tunes one of them they must not
 * silently move the other.
 */
export const DEFAULT_OFFER_MARGIN_FLOOR_PCT = 10;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Clamp a configured percentage into the allowed band, or null if unusable. */
export function normalizeThresholdPct(raw: unknown): number | null {
  // `Number(null)` is 0 and `Number("")` is 0, both finite — so a bare
  // Number()+isFinite check turns "no threshold" into "threshold of 0%", which
  // clamps to 1% and silently declines almost every offer the seller receives.
  // Absence has to be rejected by TYPE before any arithmetic happens.
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    n = Number(raw);
  } else {
    return null;
  }
  if (!Number.isFinite(n)) return null;
  return Math.min(
    MAX_OFFER_THRESHOLD_PCT,
    Math.max(MIN_OFFER_THRESHOLD_PCT, Math.round(n)),
  );
}

/**
 * Decide what to do with one incoming offer. Pure — every branch is unit-tested.
 *
 * The ordering of the checks is deliberate and is the part to review:
 *
 *   1. Missing evidence SKIPS. No list price means no percentage; no offer
 *      price means nothing to compare. A rule that cannot see its evidence must
 *      not act, which is the same rule the listing engine follows.
 *   2. Contradictory configuration SKIPS. If the accept threshold is at or
 *      below the decline threshold, some offer would qualify for both, and
 *      picking one silently would hide a mistake the seller can fix in a
 *      second. Better to do nothing and say why.
 *   3. ACCEPT is evaluated before DECLINE. With a coherent configuration the
 *      two bands cannot overlap, so the order is not load-bearing for
 *      correctness — but it is load-bearing for intent: when in doubt, the
 *      outcome that completes a sale beats the one that ends a conversation.
 *   4. The margin floor is checked LAST, and only on an accept. See the header.
 */
export function decideOffer(cfg: OfferRuleConfig, facts: OfferFacts): OfferOutcome {
  const accept = cfg.acceptAtPct;
  const decline = cfg.declineBelowPct;
  const counterAt = cfg.counterAtPct ?? null;

  // US-2940 widened this. "Counter everything at 85%" is a complete rule on its
  // own, and before the counter existed this guard read `accept === null &&
  // decline === null` — which would have refused it as unconfigured. The test
  // that caught it is the rounding one, which needed a counter-only config.
  if (accept === null && decline === null && counterAt === null) {
    return { decision: "skip", reason: "no_thresholds_set", pctOfList: null };
  }

  const offer = facts.offerPrice;
  if (typeof offer !== "number" || !Number.isFinite(offer) || offer <= 0) {
    return { decision: "skip", reason: "no_offer_price", pctOfList: null };
  }
  const list = facts.listPrice;
  if (typeof list !== "number" || !Number.isFinite(list) || list <= 0) {
    return { decision: "skip", reason: "no_list_price", pctOfList: null };
  }

  const pctOfList = round1((offer / list) * 100);

  // A configuration where the accept band starts at or below the decline band
  // is not resolvable — every offer in the overlap has two right answers.
  if (accept !== null && decline !== null && accept <= decline) {
    return { decision: "skip", reason: "thresholds_contradict", pctOfList };
  }

  if (accept !== null && pctOfList >= accept) {
    const cost = facts.itemCost;
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
      const floor = cost * (1 + cfg.marginFloorPct / 100);
      if (offer < floor) {
        // The seller's percentage said yes and the arithmetic says this loses
        // money. A human can still take it by hand; nothing automatic will.
        return { decision: "skip", reason: "below_margin_floor", pctOfList };
      }
    }
    return { decision: "accept", reason: "accepted_at_threshold", pctOfList };
  }

  // US-2940. AFTER accept and BEFORE decline, and that order is the contract:
  // an offer that qualifies for both accept and counter is ACCEPTED (a sale now
  // beats a negotiation), and an offer that qualifies for both counter and
  // decline is COUNTERED (a negotiation beats ending the conversation).
  if (counterAt !== null) {
    const counterPrice = round2(list * (counterAt / 100));
    // Strictly above the offer and strictly below list: a counter at or below
    // what the buyer already offered is an insult with extra steps, and one at
    // or above list is not a counter at all. Neither is fixable by clamping, so
    // it becomes a SKIP rather than a silently-adjusted number.
    if (counterPrice <= offer || counterPrice >= list) {
      return { decision: "skip", reason: "counter_not_possible", pctOfList };
    }
    // The margin floor applies to a counter EXACTLY as it applies to an accept.
    // A counter is an offer to sell at that price, so a counter under the floor
    // is a loss the seller merely has to wait for.
    const cost = facts.itemCost;
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
      const floor = cost * (1 + cfg.marginFloorPct / 100);
      if (counterPrice < floor) {
        return { decision: "skip", reason: "below_margin_floor", pctOfList };
      }
    }
    return { decision: "counter", reason: "countered_at_threshold", pctOfList, counterPrice };
  }

  if (decline !== null && pctOfList < decline) {
    return { decision: "decline", reason: "declined_below_threshold", pctOfList };
  }

  return { decision: "skip", reason: "between_thresholds", pctOfList };
}

/** Money, to the cent. eBay rejects a counter with more precision than that. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Seller-facing one-liner for a decision. Pure, so the copy is testable. */
export function describeOfferOutcome(o: OfferOutcome): string {
  const pct = o.pctOfList === null ? "an unknown share" : `${o.pctOfList}%`;
  switch (o.reason) {
    case "accepted_at_threshold":
      return `Accepted automatically — the offer was ${pct} of your asking price.`;
    case "countered_at_threshold":
      return `Countered automatically — the offer was ${pct} of your asking price${
        o.counterPrice != null ? `, countered at $${o.counterPrice.toFixed(2)}` : ""
      }.`;
    case "counter_not_possible":
      return `Left for you — ${pct} of asking, and no counter fits above the offer and below your price.`;
    case "declined_below_threshold":
      return `Declined automatically — the offer was ${pct} of your asking price.`;
    case "between_thresholds":
      return `Left for you — ${pct} of asking sits between your thresholds.`;
    case "below_margin_floor":
      return `Left for you — ${pct} of asking, but that is at or below what the item cost.`;
    case "thresholds_contradict":
      return "Left for you — your accept threshold is not above your decline threshold.";
    case "no_list_price":
      return "Left for you — this listing has no asking price to compare against.";
    case "no_offer_price":
      return "Left for you — the offer carried no price.";
    case "no_thresholds_set":
      return "Left for you — no auto-accept or auto-decline threshold is set.";
  }
}

// ── US-2940: the dry run ────────────────────────────────────────────
//
// Countering answers a buyer with a price, automatically, with no human in the
// loop. A seller who cannot see what the rule WOULD have done to the last month
// of real offers is being asked to trust a percentage they typed against data
// they have not looked at — the same argument the return rules make, and for
// the same reason.

export interface OfferDryRunSummary {
  considered: number;
  wouldAccept: number;
  wouldCounter: number;
  wouldDecline: number;
  skipped: number;
  lines: Array<{
    externalOfferId: string;
    decision: OfferDecision;
    copy: string;
    counterPrice: number | null;
  }>;
}

/** Pure. What the config would have done to a set of past offers. */
export function dryRunOfferRule(
  cfg: OfferRuleConfig,
  offers: Array<OfferFacts & { externalOfferId: string }>,
): OfferDryRunSummary {
  const summary: OfferDryRunSummary = {
    considered: offers.length,
    wouldAccept: 0,
    wouldCounter: 0,
    wouldDecline: 0,
    skipped: 0,
    lines: [],
  };
  for (const o of offers) {
    const outcome = decideOffer(cfg, o);
    if (outcome.decision === "accept") summary.wouldAccept++;
    else if (outcome.decision === "counter") summary.wouldCounter++;
    else if (outcome.decision === "decline") summary.wouldDecline++;
    else summary.skipped++;
    summary.lines.push({
      externalOfferId: o.externalOfferId,
      decision: outcome.decision,
      // Every line, including the skips, with its reason. "Nothing would have
      // fired" is the most useful answer this can give and it is invisible if
      // only the hits are listed.
      copy: describeOfferOutcome(outcome),
      counterPrice: outcome.counterPrice ?? null,
    });
  }
  return summary;
}
