// US-797: a sessionStorage marker so post-Stripe-checkout reconciliation
// survives in-app navigation. A Stripe redirect lands the user on a FRESH page
// and the activating webhook (plan flip / credit grant) commits a beat later —
// if the user navigates off the billing page before it lands, a poll tied to
// the billing component's lifetime is cancelled and the UI shows the stale free
// tier until a manual refresh. The marker lets a layout-level reconciler
// (useCheckoutReconciler) keep refreshing until the change surfaces, regardless
// of which dashboard page is mounted.

export type CheckoutKind = "subscription" | "credit_pack";

export interface CheckoutPending {
  /** Epoch ms when checkout completed. Bounds the reconcile window. */
  since: number;
  kind: CheckoutKind;
}

const KEY = "gt.billing.checkout_pending";

// Safety ceiling on how long to keep reconciling. The webhook normally lands in
// a few seconds; past this we stop and prompt a manual refresh.
export const CHECKOUT_RECONCILE_WINDOW_MS = 60_000;

export function markCheckoutPending(kind: CheckoutKind, now = Date.now()): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ since: now, kind }));
  } catch {
    // sessionStorage unavailable (private mode / blocked) — non-fatal; the
    // billing page's own focus-refetch is the fallback.
  }
}

export function readCheckoutPending(): CheckoutPending | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CheckoutPending>;
    if (
      typeof parsed.since !== "number" ||
      (parsed.kind !== "subscription" && parsed.kind !== "credit_pack")
    ) {
      return null;
    }
    return { since: parsed.since, kind: parsed.kind };
  } catch {
    return null;
  }
}

export function clearCheckoutPending(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

// A compact signature of the billing state we watch for change. Either the plan
// flipping or the credit balance moving means the webhook landed.
export function billingSignature(
  summary:
    | { subscription: { plan: string }; grades: { credit_balance: number } }
    | null
    | undefined,
): string | null {
  if (!summary) return null;
  return `${summary.subscription.plan}:${summary.grades.credit_balance}`;
}

export type ReconcileAction = "set-baseline" | "reconciled" | "timeout" | "poll";

// Pure decision for one reconcile tick (no timers/DOM, so it's unit-testable).
//   - baseline === null + a summary is present  → "set-baseline" (remember it)
//   - summary differs from the baseline         → "reconciled" (webhook landed)
//   - window elapsed with no change             → "timeout" (prompt a refresh)
//   - otherwise                                 → "poll" (keep refreshing)
// The baseline is captured from the FIRST summary the reconciler observes after
// checkout — typically the pre-webhook snapshot — so a later change is detected
// even on a cold page load where no prior value was cached.
export function nextReconcileAction(args: {
  baseline: string | null;
  currentSig: string | null;
  since: number;
  now: number;
  windowMs?: number;
}): ReconcileAction {
  const { baseline, currentSig, since, now } = args;
  const windowMs = args.windowMs ?? CHECKOUT_RECONCILE_WINDOW_MS;
  if (currentSig !== null) {
    if (baseline === null) return "set-baseline";
    if (currentSig !== baseline) return "reconciled";
  }
  if (now - since >= windowMs) return "timeout";
  return "poll";
}
