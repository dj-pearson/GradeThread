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
export function mapRawStripeStatus(raw: string | null): SubscriptionStatus | null {
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


// ── US-2295: the divergence this job could never see ────────────────────────
//
// detectDivergence above compares our CACHED state against the latest webhook
// event WE RECORDED. Both sides come out of our own database, so it answers one
// question well — "did we receive an event and fail to apply it?" — and is
// structurally blind to the other: "did Stripe change something we never heard
// about?"
//
// A missed webhook produces no event row. The candidate loop then hits
// `if (!row.latest_event_type) continue;` and the account is skipped in silence.
// That is the exact drift the job was built to catch, and it was the one case
// guaranteed to be invisible.
//
// This is the Stripe side of the comparison. Status only, deliberately: status
// is where the revenue leaks (a canceled sub still reading active is served for
// free; a live sub reading canceled is a customer locked out of what they pay
// for), and mapping a Stripe price back to a plan tier needs a mapping this
// module does not own. Plan drift is still covered by detectDivergence whenever
// an event WAS recorded.

export interface StripeSubscriptionState {
  /** Stripe's subscription id, for the flag detail. */
  id: string;
  /** The raw Stripe status string, e.g. "active" | "past_due" | "canceled". */
  status: string | null;
}

export interface StripeDivergenceResult {
  diverged: boolean;
  expectedStatus: SubscriptionStatus | null;
  reasons: string[];
}

/**
 * Compare our cached subscription status against what Stripe says RIGHT NOW.
 *
 * Fails CLOSED on an unmapped Stripe status: `mapRawStripeStatus` returns null
 * for anything it does not recognise, and an unknown status is not evidence of
 * divergence — flagging on it would fill the queue with noise the first time
 * Stripe adds a state, and a noisy queue is an ignored queue.
 */
export function detectStripeDivergence(
  cached: CachedSubscriptionState,
  stripe: StripeSubscriptionState,
): StripeDivergenceResult {
  const expectedStatus = mapRawStripeStatus(stripe.status);
  if (expectedStatus === null) {
    return { diverged: false, expectedStatus: null, reasons: [] };
  }
  if (cached.status === expectedStatus) {
    return { diverged: false, expectedStatus, reasons: [] };
  }
  return {
    diverged: true,
    expectedStatus,
    reasons: [
      `stripe: cached '${cached.status ?? "—"}' vs Stripe '${stripe.status}' ` +
      `(maps to '${expectedStatus}') on subscription ${stripe.id}`,
    ],
  };
}
