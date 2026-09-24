// Worth My Time, R2 05/06 (US-3182): the words for corrections and set-asides.
//
// SEPARATE FROM THE MODEL, the same split work-advice-copy.ts and
// work-explain-copy.ts use. work-overrides.ts returns codes, so a test asserts
// the refusal rather than the sentence, and a copy change can never alter what
// a validation actually rejected.
//
// Written for someone standing at a table with a garment in one hand. Every
// refusal says what to do next, because "invalid value" tells a seller nothing
// they did not already know from the red border.

import type {
  OverrideKind,
  SuppressionKind,
  ValidationError,
} from "@/lib/work-overrides";

export const OVERRIDE_ERROR_COPY: Record<ValidationError, string> = {
  not_a_number: "Type a number.",
  not_finite: "That isn't a number we can use.",
  negative: "It can't be less than zero.",
  zero_minutes: "Zero minutes isn't a real answer. Put at least one.",
  not_whole_minutes: "Use whole minutes.",
  above_minutes_bound: "That's longer than a whole session. Check the number.",
  above_value_bound: "That looks like dollars typed as cents. Check the number.",
  range_inverted: "The low has to come first.",
  unknown_kind: "We don't know how to change that.",
};

export const OVERRIDE_KIND_COPY: Record<OverrideKind, string> = {
  task_minutes: "How long this takes",
  value_range: "What it's worth",
  remaining_cost: "What's left to spend",
};

export const SUPPRESSION_COPY: Record<SuppressionKind, string> = {
  skip_session: "Skip for now",
  snooze: "Not for a week",
  dismiss: "Stop suggesting this",
};

/** What a set-aside row reads as once it is on. */
export const SUPPRESSION_STATE_COPY: Record<SuppressionKind, string> = {
  skip_session: "Skipped for this sitting.",
  snooze: "Set aside for a week.",
  dismiss: "You told us to stop suggesting this.",
};

/**
 * The one line that has to be right (AC3).
 *
 * A snooze that hid a paid buyer's parcel would be found out by a late-
 * shipment metric rather than by us, so when the planner overrules a
 * set-aside it says so plainly instead of quietly showing the row again.
 */
export const URGENT_OVERRIDES_SUPPRESSION_COPY =
  "This has to ship soon, so it's back on the list even though you set it aside.";

export const SNOOZE_EXPIRED_COPY = "Your week is up, so this is back.";
