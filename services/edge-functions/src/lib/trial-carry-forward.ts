// US-3457: what /flipdesk/subscribe passes Stripe as subscription_data.trial_end
// when a signup trialist adds a card.
//
// The signup trial (handle_new_user, 14 days of Pro, no card) is carried into
// the new Stripe subscription so the customer is not charged before the day
// they were told. Stripe's Checkout API refuses a trial_end less than 48 hours
// out, and the transactional notice goes out at three days or fewer
// (jobs-trial-expiry.ts), so without a floor the last two days of the trial,
// the days the email sends people to the billing page, were the days Checkout
// answered 500. The floor moves the first charge a little later, never
// earlier, and Stripe's hosted page states the resulting date.

/** Stripe's documented minimum for Checkout `subscription_data.trial_end`. */
export const STRIPE_MIN_TRIAL_END_MS = 48 * 60 * 60 * 1000;

/**
 * Headroom over the minimum, so a session minted at the boundary is not
 * refused by the time Stripe evaluates it.
 */
export const TRIAL_END_FLOOR_MARGIN_MS = 5 * 60 * 1000;

export interface TrialCarryForwardUser {
  trial_ends_at: string | null;
  /** Present once a paid subscription exists: no second trial is granted. */
  flipdesk_subscription_id: string | null;
}

/**
 * The unix-seconds `trial_end` to send, or undefined for no trial at all.
 *
 * Undefined when there is nothing left to carry (no trial, an ended one, or a
 * subscription already on file). Otherwise the later of the trial's own end
 * and now + 48h + margin.
 */
export function carriedForwardTrialEnd(
  user: TrialCarryForwardUser,
  nowMs: number = Date.now(),
): number | undefined {
  if (!user.trial_ends_at || user.flipdesk_subscription_id) return undefined;
  const trialEndMs = new Date(user.trial_ends_at).getTime();
  if (!Number.isFinite(trialEndMs) || trialEndMs <= nowMs) return undefined;
  const floorMs = nowMs + STRIPE_MIN_TRIAL_END_MS + TRIAL_END_FLOOR_MARGIN_MS;
  return Math.floor(Math.max(trialEndMs, floorMs) / 1000);
}
