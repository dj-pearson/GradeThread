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
  | "canceled"
  // US-2398 (migration 00529): an admin comp grant. It never comes from Stripe,
  // so mapRawStripeStatus can never return it — but it CAN be the cached value,
  // which is why detectDivergence has to know about it.
  | "comp";

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

/**
 * The prefix that marks an audit row as being about the BUYER subscription.
 *
 * US-2457. `flipdesk_subscription_events` is the audit table for BOTH products
 * — App Store and Play rows have always been namespaced (`appstore.`,
 * `googleplay.`) — but the buyer rows added on 2026-08-10 carried the raw
 * Stripe event type, so a buyer's cancellation was byte-identical to a seller's
 * in the only columns `reconciliation_candidates` returns.
 *
 * That matters because the candidate query is `distinct on (user_id)` with no
 * product filter: the newest row wins. So a seller in good standing who
 * cancelled their BUYER subscription would have their latest event derive to
 * `{canceled, free}`, be compared against their live FlipDesk state, and be
 * flagged `status_divergence` — and the operator remedy for that flag is a
 * resync that can overwrite `flipdesk_subscription_id` with the buyer
 * subscription's id. A false flag on this queue is not noise; it is a loaded
 * destructive action.
 */
export const BUYER_EVENT_PREFIX = "buyer.";

/** Namespace an event type as belonging to the buyer product. */
export function buyerEventType(stripeEventType: string): string {
  return `${BUYER_EVENT_PREFIX}${stripeEventType}`;
}

/** True when this audit row is about the buyer subscription, not the seller's. */
export function isBuyerProductEvent(eventType: string): boolean {
  return eventType.startsWith(BUYER_EVENT_PREFIX);
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
  // US-2398: a comped account is not diverged, it is deliberately off Stripe's
  // ledger. Its last recorded event is whatever ended the old subscription, so
  // every comp would otherwise show up here forever as "cached 'comp' vs
  // expected 'canceled'" — an ops queue that fills with resolved cases is one
  // that stops being read.
  if (cached.status === "comp") {
    return {
      diverged: false,
      statusDiverged: false,
      planDiverged: false,
      expected: deriveExpectedState(ev),
      reasons: [],
    };
  }

  // US-2457: a BUYER event says nothing about the seller subscription this
  // function compares. Cancelling a Guard plan does not cancel a FlipDesk one,
  // and reading it as though it did produces a confident, wrong flag on a queue
  // whose remedy is destructive.
  //
  // Skipped rather than reconciled: the buyer product has no cached columns in
  // CachedSubscriptionState to compare against, so there is nothing honest to
  // say here. Buyer reconciliation is its own job and is not built (see the
  // 2026-08-10 sweep on US-2457) — a gap, but a silent one, which is strictly
  // better than a wrong flag that invites an operator to act.
  if (isBuyerProductEvent(ev.eventType)) {
    return {
      diverged: false,
      statusDiverged: false,
      planDiverged: false,
      expected: { status: null, plan: null },
      reasons: [],
    };
  }

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
