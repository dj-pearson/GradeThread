// US-893: pure Stripe-vs-DB subscription divergence detection.
//
// Kept import-safe (no supabase / no Stripe SDK import) so the unit tests run
// DB-less in CI — same import-safety split as revenue-window.ts (US-891) and
// rate-limit-overrides.ts (US-890). The scheduled reconciliation job feeds it the
// latest recorded subscription event + the user's cached state and writes the
// result to billing_reconciliation_flags; the edge re-sync action is the
// authoritative fix.

export type SubscriptionStatus =
  | "none"
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "canceled";

/** The user's cached subscription columns. */
export interface CachedSubscriptionState {
  status: string | null; // users.subscription_status
  plan: string | null; // users.flipdesk_plan
}

/** The latest recorded Stripe event for the user (flipdesk_subscription_events). */
export interface LatestSubscriptionEvent {
  eventType: string; // e.g. "invoice.payment_failed", "customer.subscription.deleted"
  toPlan: string | null; // to_plan column
  rawStatus: string | null; // raw_payload->>'status' (the raw Stripe sub status)
}

export interface ExpectedState {
  status: SubscriptionStatus | null;
  plan: string | null;
}

export interface DivergenceResult {
  diverged: boolean;
  /** Set when a status mismatch is found. */
  statusDiverged: boolean;
  /** Set when a plan mismatch is found. */
  planDiverged: boolean;
  expected: ExpectedState;
  reasons: string[];
}

// Pure mirror of webhooks.ts mapSubscriptionStatus for the RAW Stripe status
// string (we only have the recorded string here, not a Stripe.Subscription).
// Kept in sync deliberately — both fail closed on unknown statuses.
function mapRawStripeStatus(raw: string | null): SubscriptionStatus | null {
  switch (raw) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "paused":
      return "paused";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
      return "none";
    default:
      return null;
  }
}

/**
 * Derive the subscription state the LATEST event implies. The event type is the
 * strongest signal (a deleted/failed/succeeded event has unambiguous intent);
 * for create/update/resume events we fall back to the raw Stripe status string
 * the webhook recorded in raw_payload.
 */
export function deriveExpectedState(ev: LatestSubscriptionEvent): ExpectedState {
  switch (ev.eventType) {
    case "customer.subscription.deleted":
      // Cancellation demotes to Free.
      return { status: "canceled", plan: "free" };
    case "invoice.payment_failed":
      return { status: "past_due", plan: ev.toPlan };
    case "invoice.payment_succeeded":
      return { status: "active", plan: ev.toPlan };
    case "customer.subscription.paused":
      return { status: "paused", plan: ev.toPlan };
    default:
      // created / updated / resumed / admin_change / admin_resync / unknown:
      // trust the recorded raw Stripe status.
      return { status: mapRawStripeStatus(ev.rawStatus), plan: ev.toPlan };
  }
}

// Statuses where the cached flipdesk_plan legitimately stays on the PAID tier
// even though billing isn't current — the dunning grace window (US-395) keeps
// paid caps for a past_due sub, and a paused sub retains its plan. We therefore
// don't treat the plan as divergent for these (only the status matters).
const PLAN_LENIENT_STATUSES = new Set<SubscriptionStatus>(["past_due", "paused"]);

/**
 * Compare the user's cached state against what the latest event implies.
 *
 * Conservative by design — it only flags a divergence it is confident about, so
 * the operator list stays signal-rich:
 *   - status mismatch: cached subscription_status differs from the event's
 *     implied status (when the event yields a concrete status).
 *   - plan mismatch: cached flipdesk_plan differs from the event's to_plan, but
 *     ONLY when the event implies a concrete plan AND the implied status isn't
 *     one where the plan legitimately lags (past_due/paused grace).
 */
export function detectDivergence(
  cached: CachedSubscriptionState,
  ev: LatestSubscriptionEvent,
): DivergenceResult {
  const expected = deriveExpectedState(ev);
  const reasons: string[] = [];

  let statusDiverged = false;
  if (expected.status !== null && cached.status !== expected.status) {
    statusDiverged = true;
    reasons.push(
      `status: cached '${cached.status ?? "—"}' vs expected '${expected.status}'`,
    );
  }

  let planDiverged = false;
  const planComparable =
    expected.plan !== null &&
    !(expected.status !== null && PLAN_LENIENT_STATUSES.has(expected.status));
  if (planComparable && cached.plan !== expected.plan) {
    planDiverged = true;
    reasons.push(
      `plan: cached '${cached.plan ?? "—"}' vs expected '${expected.plan}'`,
    );
  }

  return {
    diverged: statusDiverged || planDiverged,
    statusDiverged,
    planDiverged,
    expected,
    reasons,
  };
}
