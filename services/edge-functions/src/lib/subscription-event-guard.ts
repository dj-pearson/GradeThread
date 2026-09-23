// Stripe subscription webhooks: decide whether an event may write billing state.
//
// Two ways an event could overwrite newer or unrelated state:
//
//   1. OUT OF ORDER. Stripe does not promise delivery order, and a transient
//      failure releases the claim and asks Stripe to retry later (US-397). So a
//      customer.subscription.updated from before an upgrade can land after it
//      and put the old plan back. The event's own `created` time is the only
//      order Stripe gives us, so the watermark is the newest `created` already
//      APPLIED for that subscription, read from the audit trail
//      (flipdesk_subscription_events.raw_payload.event_created).
//
//   2. NOT THE CURRENT SUBSCRIPTION. users.flipdesk_subscription_id (and
//      buyer_subscription_id) names the one subscription that governs access.
//      A deletion of some OTHER subscription on the same customer (a duplicate,
//      an old one) used to demote the user to Free while their live one kept
//      billing. A change event for another subscription used to repoint the
//      column at it. Deletions of a non-current sub are always ignored; a
//      change to one is applied only when Stripe says the stored one is no
//      longer live, which is how a genuine replacement (old canceled, new
//      created) still gets through in either delivery order.
//
// Pure and import-safe (no supabase, no Stripe SDK) so it tests without a DB.

/** Stripe statuses after which a subscription can never bill again. */
const TERMINAL_STATUSES = new Set(["canceled", "incomplete_expired"]);

/**
 * What Stripe says about the STORED subscription. `"missing"` means Stripe
 * answered that it does not exist, which counts as not live.
 */
export type StoredSubscriptionStatus = string | "missing";

export function isLiveSubscriptionStatus(status: StoredSubscriptionStatus): boolean {
  return status !== "missing" && !TERMINAL_STATUSES.has(status);
}

export type SubscriptionEventKind = "change" | "delete";

export type SubscriptionEventVerdict =
  | { apply: true }
  | { apply: false; reason: "stale_event" | "not_current_subscription" };

export interface SubscriptionEventInput {
  kind: SubscriptionEventKind;
  incomingSubscriptionId: string;
  /** event.created, unix seconds. */
  eventCreated: number;
  /** users.flipdesk_subscription_id or users.buyer_subscription_id. */
  storedSubscriptionId: string | null | undefined;
  /** Newest event.created already applied for the incoming subscription. */
  lastAppliedEventCreated: number | null;
  /**
   * Stripe's status for the stored subscription. Only consulted for a change
   * event whose subscription differs from the stored one; the caller fetches it
   * only in that case (see needsStoredStatus).
   */
  storedSubscriptionStatus?: StoredSubscriptionStatus | null;
}

/** True when the verdict depends on the stored subscription's live status. */
export function needsStoredStatus(
  kind: SubscriptionEventKind,
  incomingSubscriptionId: string,
  storedSubscriptionId: string | null | undefined,
): boolean {
  return kind === "change" && !!storedSubscriptionId &&
    storedSubscriptionId !== incomingSubscriptionId;
}

export function judgeSubscriptionEvent(input: SubscriptionEventInput): SubscriptionEventVerdict {
  const stored = input.storedSubscriptionId ?? null;

  if (stored && stored !== input.incomingSubscriptionId) {
    if (input.kind === "delete") return { apply: false, reason: "not_current_subscription" };
    const storedStatus = input.storedSubscriptionStatus;
    // Unknown status: keep the current subscription. The caller is expected to
    // fetch it (or throw a retryable error) before asking, so this is the
    // fail-safe branch rather than a normal path.
    if (storedStatus == null || isLiveSubscriptionStatus(storedStatus)) {
      return { apply: false, reason: "not_current_subscription" };
    }
  }

  // Deletions are final, so they are never discarded as stale: ignoring one
  // would leave a paid plan standing on a subscription Stripe has ended.
  // Strictly older only: `created` has one-second resolution, and a retry of the
  // very event that set the watermark must still be able to apply.
  if (
    input.kind === "change" &&
    input.lastAppliedEventCreated !== null &&
    input.eventCreated < input.lastAppliedEventCreated
  ) {
    return { apply: false, reason: "stale_event" };
  }

  return { apply: true };
}

/**
 * Newest event_created among audit rows. Rows written before this watermark
 * existed carry no event_created and are skipped, as are non-numeric values.
 */
export function latestEventCreated(
  rows: ReadonlyArray<{ event_created?: unknown }> | null | undefined,
): number | null {
  let latest: number | null = null;
  for (const row of rows ?? []) {
    const v = typeof row.event_created === "string" ? Number(row.event_created) : row.event_created;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (latest === null || v > latest) latest = v;
  }
  return latest;
}

/** Audit event_type for an event the guard refused to apply. */
export function ignoredEventType(stripeEventType: string): string {
  return `ignored.${stripeEventType}`;
}
