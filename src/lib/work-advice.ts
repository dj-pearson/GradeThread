// Worth My Time, R2 03/06 (US-3180): when is more work not worth it?
//
// A seller who has already photographed, measured and priced a garment will
// keep going out of habit. Sometimes the right answer is to list it as it is,
// put it in a bundle, or give it away -- and nothing in the product has ever
// said so.
//
// ── IT COMPARES FUTURE CONTRIBUTION, NEVER TOTAL PROFIT (AC1) ───────────────
// This is the whole design and it is the opposite of what feels right. What
// the seller paid is SPENT. It cannot be recovered by working harder and it
// must not decide whether the next twenty minutes are worth spending. An
// $80 jacket bought badly and a $4 jacket bought well are the same decision
// once the money is gone: which option returns the most from HERE.
//
// The total is still shown, because a seller deciding what to buy next needs
// it and because hiding it would look like concealment. It is shown BESIDE
// the comparison, never inside it.
//
// ── EVERY OPTION IS A SUGGESTION TO REVIEW (AC4, AC5) ───────────────────────
// Nothing here lists, delists, relists, donates or deletes. It returns
// options with reasons and, where one exists, a link to the seller's own
// existing flow. A recommendation engine that could act would eventually act
// wrongly on an item somebody was about to sell.
//
// ── IT REFUSES MORE OFTEN THAN IT RECOMMENDS (AC3) ──────────────────────────
// A lower-work option is only recommended when the evidence supports the
// comparison. Otherwise it asks for ONE missing input -- the one that would
// most change the answer -- or says the choice is uncertain. "This listing is
// old" is not evidence that a garment should be given away, and an estimate
// built on an asking price is not a sale.
//
// ── REPAIR UPLIFT IS GUIDANCE, NOT A NUMBER TO ADD UP (AC2) ─────────────────
// lib/repair-triage.ts estimates what fixing a defect might recover. Its
// `totalValueLiftPct` sums per-defect gains, and this file deliberately does
// NOT use that total: two defects on one garment do not add, an estimated
// repair is not a certified grade, and a defect nobody has seen cannot be
// promised away. What is used is the single best repairable defect, as a
// REASON to hold off recommending as-is, never as money.

import {
  isComplete,
  type ValueResult,
} from "@/lib/work-value";
import { summarizeRepairTriage } from "@/lib/repair-triage";
import type { DefectFound } from "@/types/database";

export const ADVICE_MODEL_VERSION = 1;

/** The four things a seller can do next. */
export const ADVICE_OPTIONS = [
  "continue_prep",
  "sell_as_is",
  "bundle_review",
  "donation_review",
] as const;
export type AdviceOption = (typeof ADVICE_OPTIONS)[number];

/**
 * Why an option was offered or held back. Codes rather than sentences, so the
 * planner renders its own copy and a test can assert the REASON rather than
 * the wording (AC5).
 */
export const REASON_CODES = [
  "contribution_beats_alternatives",
  "below_hourly_target",
  "remaining_work_costs_more_than_it_returns",
  "repairable_defect_may_lift_value",
  "no_eligible_bundle_items",
  "bundle_price_unsupported",
  "as_is_price_unmeasured",
  "low_value_after_costs",
  "needs_price_evidence",
  "needs_purchase_cost",
  "needs_time_estimate",
  "evidence_too_weak_to_choose",
  "item_already_sold_or_committed",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface AdviceAlternative {
  option: AdviceOption;
  /**
   * What this option returns from HERE, in cents. Null when it cannot be
   * stated -- which is most of the time for bundle and donation, and saying
   * so is the point.
   */
  futureContributionCents: number | null;
  /** Minutes of hands-on work this option still needs. */
  remainingMinutes: number;
  /** Costs still to spend on this option, in cents. */
  remainingCostCents: number;
  reasons: ReasonCode[];
  /** An EXISTING seller flow, or null. Never a new destructive action. */
  actionHref: string | null;
}

export interface AdviceResult {
  /** The option with the best supported future contribution, or null. */
  recommended: AdviceOption | null;
  alternatives: AdviceAlternative[];
  /**
   * Shown BESIDE the comparison, never inside it (AC1). Null when the
   * purchase price was never recorded, because an unknown cost is not zero.
   */
  wholeItemProfitCents: number | null;
  /**
   * The ONE input that would most change the answer, when the evidence is too
   * thin to choose. Null when a choice was possible.
   */
  askFor: ReasonCode | null;
  /** True when no option can be recommended and the reason is uncertainty. */
  uncertain: boolean;
  /** Everything the comparison assumed, so the seller can argue with it. */
  assumptions: {
    hourlyTargetCents: number | null;
    remainingMinutes: number;
    remainingCostCents: number;
    valueEvidence: string | null;
  };
  version: number;
}

export interface AdviceInput {
  /** The R1 value estimate for this item, complete or not. */
  value: ValueResult;
  /** Hands-on minutes still ahead on the prep ladder. */
  remainingMinutes: number;
  /** Costs still to spend to finish prep, in cents. */
  remainingCostCents: number;
  /** The seller's optional hourly target, in cents. Null when unset. */
  hourlyTargetCents?: number | null;
  /** Defects the grader found, for repair guidance only (AC2). */
  defects?: readonly DefectFound[];
  /** How many of the seller's OWN items could plausibly bundle with this. */
  eligibleBundleItemCount?: number;
  /** True when the item is sold, committed or otherwise not the seller's to act on. */
  soldOrCommitted?: boolean;
  /** An existing listing flow for this item, when one exists. */
  listAsIsHref?: string | null;
  bundleHref?: string | null;
  donationHref?: string | null;
}

/**
 * Below this, finishing prep is not worth an evening whatever the maths says.
 *
 * An assumption like every other number in this feature, and it is here so a
 * later measurement has something to argue with rather than a silent zero.
 */
export const LOW_VALUE_FLOOR_CENTS = 500;

function minutesToCents(minutes: number, hourlyTargetCents: number | null): number {
  if (hourlyTargetCents == null) return 0;
  return Math.round((minutes / 60) * hourlyTargetCents);
}

/**
 * The best repairable defect, as a reason rather than as money (AC2).
 *
 * `summarizeRepairTriage` also returns a SUMMED `totalValueLiftPct` and this
 * deliberately ignores it: per-defect gains do not add, an estimated repair is
 * not a certified grade, and a defect nobody has inspected cannot be promised
 * away. What a repairable defect earns is a hold on recommending "sell as
 * is", and nothing more.
 */
function repairableUplift(defects: readonly DefectFound[] | undefined): boolean {
  if (!defects || defects.length === 0) return false;
  const summary = summarizeRepairTriage([...defects]);
  return summary !== null && summary.items.length > 0;
}

/**
 * Compare the ways out of an item.
 *
 * PURE and deterministic. Nothing here reads a clock, a database or a random
 * number, so the same item produces the same advice on two screens.
 */
export function adviseOnItem(input: AdviceInput): AdviceResult {
  const hourlyTargetCents = input.hourlyTargetCents ?? null;
  const assumptions = {
    hourlyTargetCents,
    remainingMinutes: input.remainingMinutes,
    remainingCostCents: input.remainingCostCents,
    valueEvidence: isComplete(input.value) ? input.value.evidence : null,
  };

  const base = (): AdviceResult => ({
    recommended: null,
    alternatives: [],
    wholeItemProfitCents: isComplete(input.value)
      ? input.value.wholeItemProfitCents
      : null,
    askFor: null,
    uncertain: false,
    assumptions,
    version: ADVICE_MODEL_VERSION,
  });

  // AC4: an item that is sold or committed is not the seller's to reconsider,
  // and offering to donate something a buyer has paid for is the worst
  // possible suggestion.
  if (input.soldOrCommitted) {
    return {
      ...base(),
      uncertain: false,
      alternatives: [{
        option: "continue_prep",
        futureContributionCents: null,
        remainingMinutes: 0,
        remainingCostCents: 0,
        reasons: ["item_already_sold_or_committed"],
        actionHref: null,
      }],
    };
  }

  // AC3: without a supported value there is nothing to compare, so the answer
  // is a QUESTION rather than a recommendation. `researchable` is what decides
  // whether the seller can fix it, and the R1 estimator already worked that
  // out -- re-deciding it here would be a second opinion.
  if (!isComplete(input.value)) {
    const askFor: ReasonCode = input.value.reason === "no_price_evidence"
      ? "needs_price_evidence"
      : "evidence_too_weak_to_choose";
    return {
      ...base(),
      uncertain: true,
      askFor,
      alternatives: [{
        option: "continue_prep",
        futureContributionCents: null,
        remainingMinutes: input.remainingMinutes,
        remainingCostCents: input.remainingCostCents,
        reasons: [askFor],
        actionHref: null,
      }],
    };
  }

  const value = input.value;

  // AC4: an unrecorded purchase price is UNKNOWN, not free. The comparison
  // still works -- it is about future contribution -- but the total beside it
  // cannot be stated, and `missing` is where R1 recorded that.
  const purchaseUnknown = value.missing.includes("purchase_price");

  // ── continue preparing ───────────────────────────────────────────
  const timeCost = minutesToCents(input.remainingMinutes, hourlyTargetCents);
  const continueContribution =
    value.remainingContributionCents - input.remainingCostCents - timeCost;
  const continueReasons: ReasonCode[] = [];
  if (hourlyTargetCents != null && continueContribution < 0) {
    continueReasons.push("below_hourly_target");
  }
  if (value.remainingContributionCents - input.remainingCostCents <= 0) {
    continueReasons.push("remaining_work_costs_more_than_it_returns");
  }
  if (value.remainingContributionCents < LOW_VALUE_FLOOR_CENTS) {
    continueReasons.push("low_value_after_costs");
  }

  // ── sell as is ───────────────────────────────────────────────────
  // ⚠ IT CARRIES NO NUMBER, AND THAT IS A CORRECTION RATHER THAN AN OMISSION.
  //
  // The first version priced this at the SAME contribution as finishing prep,
  // on the grounds that inventing a discount for an unphotographed listing
  // would decide the comparison by assumption. That reasoning was right and
  // the conclusion was wrong: R1's estimate is for a FINISHED listing, built
  // from comps of garments that were photographed and measured. Handing it to
  // the as-is option credits unfinished work with finished-listing proceeds,
  // and the arithmetic then says sell-as-is beats continuing by exactly the
  // remaining cost, EVERY TIME. The model could never recommend doing the
  // work, which is the opposite of useful and is how the error showed up: the
  // first happy-path test failed.
  //
  // What a half-prepped garment actually fetches is unmeasured. So it is
  // reported as unmeasured, beside the number that is real, and the seller
  // decides. That is the same treatment bundle and donation get and for the
  // same reason.
  const asIsReasons: ReasonCode[] = ["as_is_price_unmeasured"];
  const holdForRepair = repairableUplift(input.defects);
  if (holdForRepair) asIsReasons.push("repairable_defect_may_lift_value");

  const alternatives: AdviceAlternative[] = [
    {
      option: "continue_prep",
      futureContributionCents: continueContribution,
      remainingMinutes: input.remainingMinutes,
      remainingCostCents: input.remainingCostCents,
      reasons: continueReasons,
      actionHref: null,
    },
    {
      option: "sell_as_is",
      futureContributionCents: null,
      remainingMinutes: 0,
      remainingCostCents: 0,
      reasons: asIsReasons,
      actionHref: input.listAsIsHref ?? null,
    },
  ];

  // ── bundle ───────────────────────────────────────────────────────
  // A REVIEW SUGGESTION AND NEVER A PRICE (AC4). Nobody has a bundle buyer
  // and nobody has a bundle price; inventing either would be the clearest
  // possible fabrication on this screen. The option appears only when the
  // seller actually owns other items it could go with.
  const bundleEligible = (input.eligibleBundleItemCount ?? 0) > 0;
  alternatives.push({
    option: "bundle_review",
    futureContributionCents: null,
    remainingMinutes: 0,
    remainingCostCents: 0,
    reasons: bundleEligible
      ? ["bundle_price_unsupported"]
      : ["no_eligible_bundle_items"],
    actionHref: bundleEligible ? input.bundleHref ?? null : null,
  });

  // ── donation ─────────────────────────────────────────────────────
  // NO TAX CLAIM AND NO VALUE CLAIM (AC4). Offered only when the remaining
  // contribution is genuinely poor, because "this listing is old" is not
  // evidence that a garment should be given away (AC3).
  const donationWorthReviewing =
    value.remainingContributionCents < LOW_VALUE_FLOOR_CENTS && !holdForRepair;
  if (donationWorthReviewing) {
    alternatives.push({
      option: "donation_review",
      futureContributionCents: null,
      remainingMinutes: 0,
      remainingCostCents: 0,
      reasons: ["low_value_after_costs"],
      actionHref: input.donationHref ?? null,
    });
  }

  // ── choose, or refuse to ─────────────────────────────────────────
  // CONTINUING IS THE ONLY OPTION WITH A SUPPORTED NUMBER, so it is the only
  // one that can be RECOMMENDED. The other three are offered for review with
  // their reasons, which is what AC4 asks for -- a bundle has no price, a
  // donation has no value claim, and what a half-prepped garment fetches is
  // unmeasured.
  //
  // So the question is not "which wins" but "is finishing worth it", and the
  // answer is one of three: yes, no with the reason, or too close to say.
  const continueAlt = alternatives[0]!;

  // AC3: within the estimate's own uncertainty of break-even, the honest
  // answer is that the choice is uncertain. The band is R1's own low-to-high
  // spread, computed from the evidence -- a wide band means weak evidence and
  // a recommendation built on it would present noise as a finding.
  const band = Math.max(0, value.highCents - value.lowCents);
  const tooClose = Math.abs(continueContribution) < band / 2;

  if (tooClose || continueReasons.length > 0) {
    return {
      ...base(),
      alternatives,
      uncertain: tooClose,
      // When the numbers are CLEAR and simply bad, there is nothing to ask
      // for: the seller has an answer, it is just not "keep going".
      askFor: !tooClose
        ? null
        : hourlyTargetCents == null
        ? "needs_time_estimate"
        : purchaseUnknown
        ? "needs_purchase_cost"
        : "evidence_too_weak_to_choose",
      wholeItemProfitCents: purchaseUnknown ? null : value.wholeItemProfitCents,
    };
  }

  continueAlt.reasons = [...continueAlt.reasons, "contribution_beats_alternatives"];
  return {
    ...base(),
    recommended: "continue_prep",
    alternatives,
    wholeItemProfitCents: purchaseUnknown ? null : value.wholeItemProfitCents,
    uncertain: false,
  };
}
