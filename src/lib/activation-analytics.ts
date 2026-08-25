import { track } from "./analytics";
import type { ActivationStepKey } from "./activation-steps";
import type { UserUseCase } from "@/types/database";

// US-2884. The activation funnel, as data.
//
// Before this, three onboarding events existed -- use_case_selected,
// notifications_enabled, activation_checklist_dismissed -- plus US-2859's
// activation_step_started, which records a BUTTON PRESS. Pressing a button is
// not activating: a seller who opens the submission form and abandons it has
// pressed the button and done nothing. So the only question this epic kept
// asking -- where do new sellers stop -- had no answer from data, and every
// decision in it was opinion.
//
// WHAT MAKES THIS A FUNNEL RATHER THAN A PILE OF EVENTS: the steps are ORDERED
// and exported as data, so a drop-off chart needs no hand-maintained funnel
// definition in the PostHog UI. Same reasoning as BUYER_FUNNEL_STEPS
// (src/lib/buyer-analytics.ts, US-1845), and deliberately the same shape --
// a second convention for the same idea is how two funnels end up
// uncomparable.
//
// PRIVACY (AC5). `track()` is a no-op until the visitor opts into the
// "analytics" cookie category, so these are opt-in by construction. Beyond
// that, NOTHING HERE CARRIES CONTENT: no titles, no brands, no emails, no
// prices, no free text. The only identifiers are opaque row ids, and the only
// other properties are enums this file declares. There is a guard on it, and
// the guard is a list of BANNED property names rather than a review note,
// because "do not put PII in analytics" is advice and a failing test is not.

/**
 * The activation funnel, in order. Index N is downstream of index N-1.
 *
 * Two kinds of step live here on purpose:
 *
 *   ACCOUNT MILESTONES  first_session, tour_finished, tour_skipped -- things
 *     that happen once and are not on any checklist.
 *   CHECKLIST STEPS     grade, item, source, ebay, apikey, notifications,
 *     extension, alert, closet -- the activation-steps keys, emitted when the
 *     step FIRST COMPLETES.
 *
 * The story asked for "first listing published" and "first sale reconciled"
 * too. They are here as `listing_published` and `sale_reconciled`: they are
 * downstream of activation and they are where a seller stops being a trial.
 */
export const ACTIVATION_FUNNEL_STEPS = [
  /** The first authenticated session this account has ever had. */
  "first_session",
  /** The first-run tour reached its end. */
  "tour_finished",
  /** The first-run tour was skipped. NOT a step forward -- see EXITS. */
  "tour_skipped",
  /** A persona was chosen, so the checklist knows which list to show. */
  "persona_chosen",
  /** An activation-checklist step completed for the first time. */
  "step_completed",
  /** The account's first grade report exists. */
  "first_grade",
  /** The account's first inventory item exists. */
  "first_item",
  /** A marketplace connection is live. */
  "marketplace_connected",
  /** A listing went live on a marketplace. */
  "listing_published",
  /** A payout was matched to a sale. */
  "sale_reconciled",
] as const;

export type ActivationFunnelStep = (typeof ACTIVATION_FUNNEL_STEPS)[number];

/**
 * Leaving the funnel. NOT steps.
 *
 * Putting a dismissal in the ordered list would make every drop-off chart
 * count giving up as progress -- the same trap BUYER_FUNNEL_EXITS avoids, and
 * the reason `tour_skipped` needs care: it IS in the ordered list because the
 * account continues, but a chart that treats it as equivalent to
 * `tour_finished` is measuring something else.
 */
export type ActivationFunnelExit = "checklist_dismissed";

/** Zero-based position in the funnel; -1 for an exit. */
export function activationStepIndex(
  step: ActivationFunnelStep | ActivationFunnelExit,
): number {
  return (ACTIVATION_FUNNEL_STEPS as readonly string[]).indexOf(step);
}

/**
 * The wire name.
 *
 * A template-literal family rather than one declared constant per step, for
 * the reason analytics-events.ts spells out about the buyer funnel: a computed
 * name cannot be a plain union of literals, and widening to `string` would
 * give up the only property the registry exists to provide.
 */
export function activationEventName(
  step: ActivationFunnelStep | ActivationFunnelExit,
): `activation_${ActivationFunnelStep | ActivationFunnelExit}` {
  return `activation_${step}`;
}

/**
 * The two dimensions every activation chart is split by.
 *
 * Declared here rather than left to whoever builds the chart, because a funnel
 * split one way by one person and another way by the next is two funnels.
 */
export const ACTIVATION_SPLITS = ["persona", "platform"] as const;

/** Which client emitted. iOS sends "ios"; the web sends "web". */
export type ActivationPlatform = "web" | "ios";

export interface ActivationEventProps {
  /** Which persona's list this account is working through. */
  persona: UserUseCase | null;
  /** Which client emitted. */
  platform: ActivationPlatform;
  /** For `step_completed` only: which checklist step. */
  step?: ActivationStepKey;
  /** Position in the ordered funnel, so a chart needs no second source. */
  index: number;
  /**
   * An opaque row id, when the milestone has one. Ids only -- never a title,
   * a brand, a price or an email. See the privacy note at the top.
   */
  id?: string;
}

/**
 * Property names that must never appear on an activation event.
 *
 * A list rather than a review note, because a reviewer reads a diff once and
 * this reads every one. It is deliberately blunt: if a legitimate property
 * ever collides with a name here, rename the property.
 */
export const BANNED_ACTIVATION_PROPS = [
  "email",
  "name",
  "title",
  "brand",
  "price",
  "address",
  "phone",
  "handle",
  "sku",
  "description",
  "note",
  "query",
] as const;

const MARKER_PREFIX = "gt.activation.fired";

/**
 * True the first time this account reaches this step, false ever after.
 *
 * PER ACCOUNT AND PER DEVICE, and the distinction matters enough to state:
 * the marker is localStorage keyed by user id, so the same account on a second
 * browser emits each step once more. A durable answer means a column, which
 * means a migration, which is held in this repo (US-1108) -- and PostHog
 * funnels already take the FIRST occurrence per person, so a duplicate from a
 * second device changes no chart this funnel is for. The cost is real and
 * small; the alternative was a held migration for a metric.
 *
 * Storage unavailable (private mode, SSR) returns false rather than true:
 * emitting on every render is a worse failure than not emitting at all, since
 * one is noise in the data and the other is a gap somebody notices.
 */
export function takeFirstActivation(
  userId: string | undefined,
  step: ActivationFunnelStep | ActivationFunnelExit,
  suffix?: string,
): boolean {
  if (!userId) return false;
  const key = `${MARKER_PREFIX}:${userId}:${step}${suffix ? `:${suffix}` : ""}`;
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, "1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Emit one funnel step, at most once per account per device.
 *
 * Returns whether it fired, so a caller can assert on it in a test rather than
 * reaching into localStorage.
 */
export function trackActivation(
  step: ActivationFunnelStep | ActivationFunnelExit,
  userId: string | undefined,
  props: Omit<ActivationEventProps, "index">,
): boolean {
  // `step_completed` fires once per STEP, not once per funnel position --
  // otherwise the first completed step would silence the other eight.
  if (!takeFirstActivation(userId, step, props.step)) return false;
  track(activationEventName(step), {
    ...props,
    index: activationStepIndex(step),
  });
  return true;
}
