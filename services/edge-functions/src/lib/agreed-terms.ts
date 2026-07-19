import { supabaseAdmin } from "./supabase.ts";
import { captureException } from "./observability.ts";

// US-2117: capture what a user actually agreed to, at the moment they agreed.
//
// THE PROBLEM THIS SOLVES. Price is resolved LIVE on every read from
// pricing_plans, and pricing_plans is mutated in place with only an updated_at
// trigger — no history, no versioning. So a price change silently rewrites the
// past: there is no way to reconstruct what any user was shown or agreed to on
// any past date. That is not a disclosure-copy question (US-2114 owns the
// wording); it is whether we can still prove what the wording said.
//
// Extraction is PURE so the mapping from a Stripe subscription to an agreement
// row is testable without a webhook, a DB or a Stripe account — this is
// evidentiary data, and "we think it records the right thing" is not good
// enough for a record whose only job is to be trusted later.

/** The terms as presented and agreed, in the shape subscription_agreements stores. */
export interface AgreedTerms {
  plan: string;
  billingInterval: "monthly" | "yearly";
  amountCents: number;
  currency: string;
  trialDays: number | null;
  trialEndsAt: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  source: "stripe" | "appstore" | "google_play" | "manual";
}

/** The subset of a Stripe subscription this needs. Structural, so tests need no SDK. */
export interface SubscriptionLike {
  id?: string | null;
  currency?: string | null;
  trial_start?: number | null;
  trial_end?: number | null;
  items?: {
    data?: Array<{
      price?: {
        id?: string | null;
        currency?: string | null;
        unit_amount?: number | null;
        recurring?: { interval?: string | null } | null;
      } | null;
    }>;
  } | null;
}

/**
 * Map Stripe's `recurring.interval` onto our two-value vocabulary.
 *
 * Stripe also emits `day` and `week`. We do not sell those, so seeing one means
 * something is wrong upstream — return null rather than guessing, and let the
 * caller decline to write a record it cannot vouch for. A compliance record
 * containing a plausible guess is worse than no record, because it will be read
 * as fact.
 */
export function normalizeInterval(raw: string | null | undefined): "monthly" | "yearly" | null {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "month":
    case "monthly":
      return "monthly";
    case "year":
    case "yearly":
    case "annual":
      return "yearly";
    default:
      return null;
  }
}

/** Whole days between two unix seconds, floored; null when either is absent. */
export function trialDaysBetween(
  startSec: number | null | undefined,
  endSec: number | null | undefined,
): number | null {
  if (typeof startSec !== "number" || typeof endSec !== "number") return null;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null;
  const days = Math.floor((endSec - startSec) / 86_400);
  return days > 0 ? days : null;
}

/**
 * Extract the agreed terms from a Stripe subscription.
 *
 * Returns null when the subscription does not carry enough to make a TRUTHFUL
 * record — no price, no unit amount, or an interval we do not sell. Writing a
 * partial agreement would defeat the purpose: the table exists so a past claim
 * can be proven, and a row with a guessed amount proves nothing while looking
 * authoritative.
 */
export function extractAgreedTerms(
  sub: SubscriptionLike,
  plan: string,
): AgreedTerms | null {
  const price = sub.items?.data?.[0]?.price ?? null;
  if (!price) return null;

  const interval = normalizeInterval(price.recurring?.interval);
  if (!interval) return null;

  const amountCents = price.unit_amount;
  // 0 is legitimate (a fully-discounted or comped plan); only absence is not.
  if (typeof amountCents !== "number" || !Number.isFinite(amountCents) || amountCents < 0) {
    return null;
  }

  return {
    plan,
    billingInterval: interval,
    amountCents,
    currency: (price.currency ?? sub.currency ?? "usd").toLowerCase(),
    trialDays: trialDaysBetween(sub.trial_start, sub.trial_end),
    trialEndsAt: typeof sub.trial_end === "number"
      ? new Date(sub.trial_end * 1000).toISOString()
      : null,
    stripeSubscriptionId: sub.id ?? null,
    stripePriceId: price.id ?? null,
    source: "stripe",
  };
}

// ── Persistence (the thin IO half) ──────────────────────────────────

/**
 * Write the agreed-terms snapshot for a subscription.
 *
 * BEST-EFFORT BY DESIGN: a compliance record must never be the reason a paying
 * customer fails to get their entitlement. It is called from the subscription
 * webhook, which is on the path that grants access.
 *
 * DECLINES TO WRITE rather than writing a partial row when the subscription
 * does not carry enough to be truthful (no price, no amount, an interval we do
 * not sell). That case is reported — a missing agreement is a gap someone
 * should see, whereas a fabricated one would be read as fact.
 */
export async function recordAgreedTerms(
  userId: string,
  sub: SubscriptionLike,
  plan: string,
): Promise<void> {
  try {
    const terms = extractAgreedTerms(sub, plan);
    if (!terms) {
      captureException(
        new Error(
          `US-2117: could not extract agreed terms for subscription ${sub.id ?? "(no id)"} ` +
            `— no price, no unit_amount, or an interval we do not sell. NO agreement ` +
            `recorded, deliberately: a partial compliance record reads as fact.`,
        ),
        { level: "warn", route: "agreed-terms.extract", extra: { userId, plan } },
      );
      return;
    }

    const { error } = await supabaseAdmin.from("subscription_agreements").insert({
      user_id: userId,
      plan: terms.plan,
      billing_interval: terms.billingInterval,
      amount_cents: terms.amountCents,
      currency: terms.currency,
      trial_days: terms.trialDays,
      trial_ends_at: terms.trialEndsAt,
      stripe_subscription_id: terms.stripeSubscriptionId,
      stripe_price_id: terms.stripePriceId,
      source: terms.source,
    });

    // 23505 = the uniqueness index fired: this exact agreement is already on
    // record (a webhook redelivery). That is the idempotency working, not a
    // failure — do not report it.
    if (error && (error as { code?: string }).code !== "23505") {
      captureException(error, {
        route: "agreed-terms.insert",
        extra: { userId, plan, subscription_id: terms.stripeSubscriptionId },
      });
    }
  } catch (err) {
    captureException(err, { route: "agreed-terms", extra: { userId, plan } });
  }
}
