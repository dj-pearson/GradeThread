// Worth My Time, R2 06/06 (US-3183): the words for the results view.
//
// SEPARATE FROM THE MODEL, the same split the three R2 stories before this
// one use. The model returns codes and figures; these are the sentences, so a
// test asserts the reason rather than the wording and a copy change can never
// alter what the scorecard claims.
//
// ⚠ THE LABELS ARE THE HONESTY (AC2). "Profit per tracked hour" and "your
// hourly rate" are the same arithmetic and different claims, and only one of
// them is true. US-3175's page guard refuses the word "earn" anywhere on this
// screen, and it caught a first draft of the caveat below that used it inside
// a sentence explaining why the figure is not one -- correctly, because a
// seller scanning the page sees the word beside a dollar figure and not the
// sentence around it. Every label below is written so that a seller who reads only
// the label, and never the note under it, still is not misled.

import type { UnavailableReason } from "@/lib/work-scorecard";

export const SCORECARD_STAT_LABELS = {
  projected: "What the planner guessed",
  realized: "What the books recorded",
  perHour: "Profit per tracked hour",
} as const;

export const UNAVAILABLE_COPY: Record<UnavailableReason, string> = {
  nothing_in_range: "No planned work in these dates.",
  no_completed_sales: "Nothing from this work has sold yet.",
  costs_not_recorded: "We can't say: the costs on these sales were never recorded.",
  no_tracked_time: "We can't say: no confirmed minutes against these sales.",
};

/**
 * The line under the hourly figure, and the reason this file exists.
 *
 * A seller who reads "$62 per hour" and plans their week around it will be
 * wrong, because the sourcing trip, the drive, the photographs taken before
 * they pressed Start and every buyer message are all outside the denominator.
 * The true figure for their business is LOWER than this one, always, and
 * saying so is the difference between a useful number and a flattering one.
 */
export const PER_HOUR_CAVEAT =
  "Only counts minutes you confirmed inside a work session. Sourcing, " +
  "driving, messages and bookkeeping aren't in it, so your real rate across " +
  "the whole business is lower than this.";

export const PROJECTED_CAVEAT =
  "An estimate against sales that haven't happened. Not money.";

export const REALIZED_CAVEAT =
  "The same net your P&L uses. Refunds are already taken off.";

export const PENDING_CAVEAT =
  "Work you've done on things that haven't sold. Shown so the numbers above " +
  "can't look good by leaving it out.";

/** Said whenever the comparison is small enough that one garment moves it. */
export const THIN_SAMPLE_COPY =
  "That's a small number of sales. One unusual item moves it a long way.";

/**
 * The line beside a two-period comparison (AC4).
 *
 * It describes and stops. Two months differ in what was sourced, what the
 * season was and how much time there was; with samples this size the gap is
 * mostly which garments happened to sell.
 */
export const COMPARISON_CAVEAT =
  "These are just the two sets of numbers side by side. Plenty else changed " +
  "between them, so this doesn't show that one caused the other.";

export const HORIZON_COPY = (days: number): string =>
  `Estimates were made for a ${days}-day selling window.`;

export const INCOMPLETE_COSTS_COPY = (n: number): string =>
  `${n} sold ${n === 1 ? "item is" : "items are"} left out above because ` +
  `${n === 1 ? "its" : "their"} costs were never recorded.`;
