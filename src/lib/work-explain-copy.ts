// Worth My Time, R2 04/06 (US-3181): the words for each explanation fact.
//
// SEPARATE FROM THE MODEL, the same split work-advice-copy.ts uses. The model
// returns codes; these are the sentences. A test asserts the code, so a copy
// change can never quietly alter what the explanation claims, and there is one
// place to look when a seller says a line is unclear.
//
// ⚠ NO PERCENTAGE APPEARS IN ANY OF THESE, and that is the rule rather than an
// accident (AC3). There is no calibrated source for a confidence figure, and
// "87% sure" invented from a sort key would be the most believable wrong thing
// on the screen. Every line below states the FACT that causes the uncertainty
// and lets the reader weigh it.

import type { ExplainFact } from "@/lib/work-explain";
import type { OmissionReason } from "@/lib/work-scheduler";
import { MIN_SAMPLES } from "@/lib/work-duration-learning";

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** A small count as a word, so the copy follows the learner's threshold. */
function countWord(n: number): string {
  return WORDS[n] ?? String(n);
}

export const EXPLAIN_FACT_COPY: Record<ExplainFact, string> = {
  urgent_deadline: "This one has to go out soon.",
  deadline_unknown: "Nobody confirmed the ship-by date, so we worked it out.",
  best_rate: "It returns the most for the time it still needs.",
  needs_price_research: "It needs a price before we can rank it properly.",
  cannot_estimate_value: "We can't put a number on this one yet.",
  timing_is_default: "The minutes are our starting guess, not your pace.",
  timing_is_learned: "The minutes come from your own finished jobs.",
  timing_is_override: "The minutes are the ones you set.",
  value_from_sold_comp: "The value comes from something that actually sold.",
  value_from_seller_estimate: "The value is the price you typed.",
  value_from_override: "The value is the range you set for planning.",
  // The weakest evidence there is, and it says so.
  value_from_asking_price:
    "The value comes from an asking price. Nobody has paid it.",
  value_inputs_missing: "Some costs were estimated rather than recorded.",
  clears_hourly_target: "It clears the hourly rate you set.",
  below_hourly_target: "It comes in under the hourly rate you set.",
  no_hourly_target_set: "You haven't set an hourly rate, so we didn't use one.",
  blocked_by_prerequisite: "Something else has to happen first.",
  snapshot_may_be_stale:
    "This plan is from a while ago. Build a new one to use today's numbers.",
};

export const OMISSION_COPY: Record<OmissionReason, string> = {
  no_time_left: "It didn't fit the time you had.",
  prerequisite_not_ready: "Something else has to happen first.",
  conflict: "It can't be done the way the plan needed.",
  unestimated: "We don't know how long it takes.",
  beyond_candidate_cap: "We stopped looking before we got to it.",
};

/** What the seller could do to change a ranking, keyed by the fact. */
export const WOULD_CHANGE_COPY: Partial<Record<ExplainFact, string>> = {
  cannot_estimate_value: "Add a price and this one can be ranked properly.",
  needs_price_research: "Price it and it moves up or down on its own merits.",
  value_from_asking_price: "Find something that actually sold at this price.",
  value_inputs_missing: "Record the real costs and the range will tighten.",
  deadline_unknown: "Confirm the ship-by date and we'll stop guessing.",
  timing_is_default:
    `Finish ${countWord(MIN_SAMPLES)} of these and we'll use your own pace.`,
};
