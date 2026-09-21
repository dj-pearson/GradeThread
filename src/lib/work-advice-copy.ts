// Worth My Time, R2 03/06 (US-3180): the words for each option and reason.
//
// SEPARATE FROM THE MODEL ON PURPOSE. work-advice.ts returns codes, which
// means its tests assert the DECISION rather than a sentence, and a copy
// change can never quietly alter what the model recommends. It also means
// there is exactly one place to look when a seller says a message is unclear.
//
// Every line is written for someone who is tired and holding a garment. No
// number appears in any of them: the numbers are the model's and are rendered
// beside these, so a sentence can never drift from the figure it describes.

import type { AdviceOption, ReasonCode } from "@/lib/work-advice";

export const ADVICE_COPY: Record<AdviceOption, string> = {
  continue_prep: "Finish getting it ready",
  sell_as_is: "List it as it is",
  bundle_review: "Put it in a bundle",
  donation_review: "Give it away",
};

export const ADVICE_REASON_COPY: Record<ReasonCode, string> = {
  contribution_beats_alternatives: "This one is worth finishing.",
  below_hourly_target: "The time left costs more than it brings back.",
  remaining_work_costs_more_than_it_returns:
    "What's left to spend is more than what's left to make.",
  repairable_defect_may_lift_value:
    "There's a fixable flaw, so a repair might be worth more than listing now.",
  no_eligible_bundle_items: "You have nothing else that would go with it.",
  // NEVER a price. Nobody has a bundle buyer and nobody has a bundle price.
  bundle_price_unsupported: "We can't say what a bundle would fetch.",
  // NEVER a measurement. R1's estimate is for a finished listing.
  as_is_price_unmeasured: "We haven't measured what a half-ready listing makes.",
  low_value_after_costs: "There isn't much left in it after costs.",
  needs_price_evidence: "Add a price and we can compare these properly.",
  needs_purchase_cost: "Add what you paid and we can compare these properly.",
  needs_time_estimate: "Set an hourly rate and we can compare these properly.",
  evidence_too_weak_to_choose: "There isn't enough here for us to call it.",
  item_already_sold_or_committed: "This one is already sold, so leave it be.",
};
