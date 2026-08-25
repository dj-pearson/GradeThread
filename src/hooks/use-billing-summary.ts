import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import { useRedirectStore } from "@/stores/redirect-store";
import { markCheckoutPending } from "@/lib/checkout-pending";
import { DISCLOSURE_VERSION } from "@/lib/auto-renewal-copy";
import type {
  FlipdeskPlanKey,
  BuyerPlanKey,
  CreditPackSize,
} from "@/lib/constants";
import type {
  BillingInterval,
  FlipdeskPlan,
  GradeCreditReason,
  SubscriptionStatus,
} from "@/types/database";

// ── Response types ──────────────────────────────────────────────

export interface BillingLedgerEntry {
  id: string;
  delta: number;
  reason: GradeCreditReason;
  // US-398: NULL for zero-delta audit rows (included_grant / included refund).
  balance_after: number | null;
  submission_id: string | null;
  notes: string | null;
  created_at: string;
}

export interface BillingSummary {
  subscription: {
    plan: FlipdeskPlan;
    interval: BillingInterval | null;
    status: SubscriptionStatus;
    period_end: string | null;
    pause_until: string | null;
    cancel_at_period_end: boolean;
    trial_ends_at: string | null;
    stripe_customer_id: string | null;
    // Scheduled downgrade (US-217). Null when no downgrade is pending.
    pending_plan: FlipdeskPlan | null;
    pending_interval: BillingInterval | null;
    pending_effective_at: string | null;
    // US-400: the REAL next charge from Stripe (honors coupons / grandfathered
    // prices / prorations). Null for free users or if Stripe was unavailable —
    // the UI then falls back to the static plan price.
    upcoming_invoice: {
      amount_cents: number;
      currency: string;
      next_payment_at: string | null;
    } | null;
    // US-807: which processor owns the subscription. When 'appstore', the
    // subscription is managed in the iOS app — the web Billing page hides the
    // plan-change / pause / cancel CTAs (credit packs + per-grade stay active)
    // and the subscribe/downgrade endpoints reject with 409. NULL for users who
    // have never subscribed; 'stripe' for web-billed subscriptions.
    // US-2126: 'googleplay' is the THIRD value. The Play verify/RTDN path has
    // stamped it since US-1366 and this type never learned it, so a Play
    // subscriber fell through every `=== "appstore"` check and was shown Stripe
    // CTAs the server then refused with a 409.
    billing_source: "stripe" | "appstore" | "googleplay" | null;
    appstore_product_id: string | null;
  };
  // US-1799: the buyer SUBSCRIPTION state (Free/Guard/Connoisseur). Separate
  // from `subscription` (seller) — one person can hold both on one customer. The
  // effective buyer ENTITLEMENT (higher of this + the seller-derived tier,
  // US-1887) comes from useBuyerEntitlements; this is what the buyer pays for.
  buyer: {
    plan: BuyerPlanKey;
    interval: BillingInterval | null;
    status: SubscriptionStatus;
    period_end: string | null;
    cancel_at_period_end: boolean;
    // US-1801: metered-action usage this period (caps come from BUYER_PLANS).
    usage: {
      extension_checks: number;
      authenticity_credits: number;
      video_grades: number;
    };
    usage_reset_at: string | null;
  };
  grades: {
    credit_balance: number;
    included_used_this_month: number;
    // US-393: monthly included-grade reset boundary (Free users have no
    // period_end, so the UI derives the reset date from this).
    reset_at: string | null;
  };
  usage: {
    active_listings: number;
    marketplaces_connected: number;
    ai_actions_used_this_month: number;
    ai_action_limit: number | null;
  };
  // Soft upgrade triggers (US-209). thresholds: percentages (out of 100) the
  // user opted into (default [80]); last_warning: per-(cap:threshold) month
  // dedup ledger so the watcher won't re-toast within a calendar month.
  alerts: {
    thresholds: number[];
    last_warning: Record<string, string>;
  };
  recent_ledger: BillingLedgerEntry[];
}

// ── useBillingSummary ───────────────────────────────────────────
//
// Powers the billing page (US-211), credit pack dialog (US-213), plan
// picker dialog (US-212), usage meters (US-214), and upgrade triggers
// (US-209/US-210). One cache key per user — any mutation that touches
// subscription state or credit balance should invalidate ["billing_summary"].

export function useBillingSummary() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["billing_summary", user?.id],
    enabled: !!user,
    staleTime: 30_000,
    // US-797: reconcile whenever the user returns to the tab or reconnects, so a
    // subscription/credit change that landed while they were away (e.g. a Stripe
    // webhook after a checkout redirect) surfaces without a manual refresh.
    // Explicit (not just the TanStack default) so a future global
    // refetchOnWindowFocus:false wouldn't silently regress billing.
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    queryFn: async (): Promise<BillingSummary> => {
      const res = await edgeFetch("/api/payments/billing-summary");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to load billing summary.");
      }
      return json as BillingSummary;
    },
  });
}

// ── Mutations: subscribe / change / cancel / pause / resume ──────

// US-1934: kick pollBillingSummary for fast on-page feedback while OWNING its
// lifecycle. pollBillingSummary returns a stop-handle; a mutation onSuccess that
// discards it leaves the 16s interval invalidating ['billing_summary'] after the
// user navigates away. This hook cancels any prior poll before starting a new
// one and always stops on unmount. (The durable, navigation-surviving refresh is
// still handled by the layout-level reconciler via markCheckoutPending.)
function usePollBillingSummary() {
  const qc = useQueryClient();
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      stopRef.current?.();
      stopRef.current = null;
    },
    [],
  );
  return useCallback(() => {
    stopRef.current?.();
    stopRef.current = pollBillingSummary(qc);
  }, [qc]);
}

export function useFlipdeskSubscribe() {
  const startPoll = usePollBillingSummary();
  return useMutation<
    {
      sessionId?: string;
      url?: string;
      ok?: boolean;
      updated?: boolean;
      unchanged?: boolean;
    },
    Error,
    {
      plan: Exclude<FlipdeskPlanKey, "free">;
      interval: BillingInterval;
      // US-2118: set true only after the in-place-upgrade confirmation dialog has
      // disclosed the proration and captured consent. The server refuses an
      // in-place plan change without it (UPGRADE_CONFIRMATION_REQUIRED), so the
      // click alone can never charge.
      confirmUpgrade?: boolean;
    }
  >({
    mutationFn: async ({ plan, interval, confirmUpgrade }) => {
      const res = await edgeFetch("/api/payments/flipdesk/subscribe", {
        method: "POST",
        // US-2117 AC1: report which auto-renewal disclosure this build renders,
        // so the agreement row can point at the words that were on screen.
        //
        // SENT FROM THE HOOK, NOT FROM EACH SURFACE, deliberately. Every
        // subscribe surface renders <AutoRenewalDisclosure> out of the same
        // module this constant comes from, so the hook's answer is the same one
        // the screen gave — and a new surface cannot forget to send it, which is
        // the failure a per-surface prop would eventually hit.
        json: { plan, interval, confirmUpgrade, disclosureVersion: DISCLOSURE_VERSION },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to start checkout.");
      return json;
    },
    onSuccess: (data) => {
      // New subscription → Stripe Checkout redirect.
      if (data.url) {
        useRedirectStore.getState().redirectTo(data.url);
        return;
      }
      // Existing subscription was modified in place (upgrade / interval swap).
      // The customer.subscription.updated webhook persists the new plan a beat
      // later. Set the durable checkout marker so the layout-level reconciler
      // (US-797) keeps refreshing until it lands, surviving navigation; also
      // kick an immediate poll for fast on-page feedback.
      if (data.updated) {
        toast.success(
          data.unchanged ? "You're already on that plan." : "Plan updated.",
        );
        if (!data.unchanged) markCheckoutPending("subscription");
        startPoll();
      }
    },
    onError: (err) => toastError(err),
  });
}

// US-2118: proration preview for an in-place plan change, shown in the
// confirmation dialog before the (server-gated) upgrade mutation fires.
export interface UpgradePreview {
  inPlace: boolean;
  unchanged?: boolean;
  amount_due_today_cents?: number;
  currency?: string;
  new_recurring_cents?: number | null;
  interval?: BillingInterval;
  next_renewal_at?: string | null;
}

export function useUpgradePreview() {
  return useMutation<
    UpgradePreview,
    Error,
    { plan: Exclude<FlipdeskPlanKey, "free">; interval: BillingInterval }
  >({
    mutationFn: async ({ plan, interval }) => {
      const res = await edgeFetch("/api/payments/flipdesk/upgrade-preview", {
        method: "POST",
        json: { plan, interval },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't preview the plan change.");
      return json as UpgradePreview;
    },
  });
}

// ── Buyer subscription mutations (US-1799) ──────────────────────

// US-2118: the buyer half of the proration preview. A separate hook rather than
// a product argument on useUpgradePreview, mirroring the two server routes: the
// plan unions are different types, and one hook branching on a string is one
// wrong branch away from pricing the other product's upgrade.
export function useBuyerUpgradePreview() {
  return useMutation<
    UpgradePreview,
    Error,
    { plan: Exclude<BuyerPlanKey, "free">; interval: BillingInterval }
  >({
    mutationFn: async ({ plan, interval }) => {
      const res = await edgeFetch("/api/payments/buyer/upgrade-preview", {
        method: "POST",
        json: { plan, interval },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't preview the plan change.");
      return json as UpgradePreview;
    },
  });
}

export function useBuyerSubscribe() {
  const startPoll = usePollBillingSummary();
  return useMutation<
    { sessionId?: string; url?: string; ok?: boolean; updated?: boolean; unchanged?: boolean },
    Error,
    {
      plan: Exclude<BuyerPlanKey, "free">;
      interval: BillingInterval;
      // US-2118: same contract as useFlipdeskSubscribe. The buyer path was left
      // bare when the FlipDesk gate shipped, so switching Guard → Connoisseur
      // charged a prorated amount on one click with nothing disclosed.
      confirmUpgrade?: boolean;
    }
  >({
    mutationFn: async ({ plan, interval, confirmUpgrade }) => {
      const res = await edgeFetch("/api/payments/buyer/subscribe", {
        method: "POST",
        // US-2117 AC1 — same contract as useFlipdeskSubscribe above.
        json: { plan, interval, confirmUpgrade, disclosureVersion: DISCLOSURE_VERSION },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to start checkout.");
      return json;
    },
    onSuccess: (data) => {
      if (data.url) {
        useRedirectStore.getState().redirectTo(data.url);
        return;
      }
      if (data.updated) {
        toast.success(data.unchanged ? "You're already on that plan." : "Plan updated.");
        if (!data.unchanged) markCheckoutPending("subscription");
        startPoll();
      }
    },
    onError: (err) => toastError(err),
  });
}

export function useBuyerCancel() {
  const startPoll = usePollBillingSummary();
  // US-2539: takes the same { reason } the seller cancel does, so both
  // products can be driven by the one CancelSubscriptionDialog.
  return useMutation<{ ok: true }, Error, { reason?: string } | void>({
    mutationFn: async (vars) => {
      const res = await edgeFetch("/api/payments/buyer/cancel", {
        method: "POST",
        json: { reason: vars && "reason" in vars ? vars.reason : undefined },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to cancel subscription.");
      return json;
    },
    onSuccess: () => {
      toast.success("Your buyer plan will end at the period close.");
      startPoll();
    },
    onError: (err) => toastError(err),
  });
}

export function useBuyerUncancel() {
  const startPoll = usePollBillingSummary();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: async () => {
      const res = await edgeFetch("/api/payments/buyer/uncancel", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to resume subscription.");
      return json;
    },
    onSuccess: () => {
      toast.success("Your buyer plan will continue.");
      startPoll();
    },
    onError: (err) => toastError(err),
  });
}

export function useBuyCreditPack() {
  return useMutation<
    { sessionId: string; url: string },
    Error,
    // returnPath (US-207): when buying a pack mid-submission, the Stripe
    // success/cancel URLs come back to the submission so it can auto-retry the
    // payment precedence. Omitted → the standard Billing return (US-213).
    { packSize: CreditPackSize; returnPath?: string }
  >({
    mutationFn: async ({ packSize, returnPath }) => {
      const res = await edgeFetch("/api/payments/gradethread/credit-pack", {
        method: "POST",
        json: returnPath ? { packSize, returnPath } : { packSize },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to start checkout.");
      return json;
    },
    onSuccess: (data) => {
      if (data.url) useRedirectStore.getState().redirectTo(data.url);
    },
    onError: (err) => toastError(err),
  });
}

// ── Pause / Resume / Cancel mutations (US-215 + US-216) ─────────

export function usePauseSubscription() {
  const qc = useQueryClient();
  return useMutation<{ ok: true; resumesAt: string }, Error, { months: 1 | 2 | 3 }>({
    mutationFn: async ({ months }) => {
      const res = await edgeFetch("/api/payments/flipdesk/pause", {
        method: "POST",
        json: { months },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to pause subscription.");
      return json;
    },
    onSuccess: (data) => {
      const resumes = new Date(data.resumesAt).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      toast.success(`Subscription paused — resumes ${resumes}.`);
      qc.invalidateQueries({ queryKey: ["billing_summary"] });
    },
    onError: (err) => toastError(err),
  });
}

export function useResumeSubscription() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: async () => {
      const res = await edgeFetch("/api/payments/flipdesk/resume", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to resume subscription.");
      return json;
    },
    onSuccess: () => {
      toast.success("Subscription resumed.");
      qc.invalidateQueries({ queryKey: ["billing_summary"] });
    },
    onError: (err) => toastError(err),
  });
}

export function useCancelSubscription() {
  const qc = useQueryClient();
  return useMutation<
    { ok: true; ends_at: string | null },
    Error,
    { reason?: string }
  >({
    mutationFn: async ({ reason }) => {
      const res = await edgeFetch("/api/payments/flipdesk/cancel", {
        method: "POST",
        json: { reason },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to cancel subscription.");
      return json;
    },
    onSuccess: (data) => {
      const ends = data.ends_at
        ? new Date(data.ends_at).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })
        : "the end of the period";
      toast.success(`Cancellation scheduled — your plan ends ${ends}.`);
      qc.invalidateQueries({ queryKey: ["billing_summary"] });
    },
    onError: (err) => toastError(err),
  });
}

// ── Downgrade scheduling (US-217) ───────────────────────────────

export function useScheduleDowngrade() {
  const qc = useQueryClient();
  return useMutation<
    {
      ok: true;
      schedule_id: string;
      effective_at: string | null;
      target_plan: FlipdeskPlanKey;
      target_interval: BillingInterval;
    },
    Error,
    { plan: Exclude<FlipdeskPlanKey, "free">; interval: BillingInterval }
  >({
    mutationFn: async ({ plan, interval }) => {
      const res = await edgeFetch("/api/payments/flipdesk/downgrade", {
        method: "POST",
        json: { plan, interval },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to schedule downgrade.");
      return json;
    },
    onSuccess: (data) => {
      const date = data.effective_at
        ? new Date(data.effective_at).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })
        : "the end of the period";
      toast.success(`Downgrade scheduled — takes effect ${date}.`);
      qc.invalidateQueries({ queryKey: ["billing_summary"] });
    },
    onError: (err) => toastError(err),
  });
}

export function useUndoDowngrade() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: async () => {
      const res = await edgeFetch("/api/payments/flipdesk/undowngrade", {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to undo downgrade.");
      return json;
    },
    onSuccess: () => {
      toast.success("Downgrade canceled — your plan continues.");
      qc.invalidateQueries({ queryKey: ["billing_summary"] });
    },
    onError: (err) => toastError(err),
  });
}

export function useUncancelSubscription() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: async () => {
      const res = await edgeFetch("/api/payments/flipdesk/uncancel", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to undo cancellation.");
      return json;
    },
    onSuccess: () => {
      toast.success("Cancellation undone — your plan continues.");
      qc.invalidateQueries({ queryKey: ["billing_summary"] });
    },
    onError: (err) => toastError(err),
  });
}

/**
 * Open the Stripe billing portal.
 *
 * `product` decides where Stripe returns the customer. It defaulted to the
 * seller billing page for every caller, so a buyer clicking "Manage in Stripe"
 * landed on a page that does not manage their subscription (US-2125).
 */
export function useBillingPortal(product: "flipdesk" | "buyer" = "flipdesk") {
  return useMutation<{ url: string }, Error, void>({
    mutationFn: async () => {
      const res = await edgeFetch("/api/payments/portal", {
        method: "POST",
        json: { product },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to open billing portal.");
      return json;
    },
    onSuccess: (data) => {
      if (data.url) useRedirectStore.getState().redirectTo(data.url);
    },
    onError: (err) => toastError(err),
  });
}

// ── Derived helpers ─────────────────────────────────────────────

// Human label for a grade-credit ledger reason (US-211). Shared by the Billing
// page's recent-activity list and the full-history dialog.
export function ledgerLabel(reason: string): string {
  switch (reason) {
    case "pack_purchase":
      return "Credit pack purchase";
    case "grade_debit":
      return "Grade submitted";
    case "included_grant":
      return "Included grade used";
    case "admin_grant":
      return "Admin comp";
    case "refund":
      return "Refund";
    case "expiration":
      return "Expired";
    default:
      return reason;
  }
}

export function planLabel(plan: FlipdeskPlan): string {
  return {
    free: "Free",
    starter: "Starter",
    pro: "Pro",
    business: "Business",
  }[plan];
}

export function isTrialing(s: BillingSummary["subscription"]): boolean {
  return s.status === "trialing"
    || (!!s.trial_ends_at && new Date(s.trial_ends_at).getTime() > Date.now() && !s.stripe_customer_id);
}

// US-807: true when the subscription is owned by Apple's App Store (purchased in
// the iOS app) and currently entitling. The web UI then surfaces an
// "managed in the iOS app" card and hides Stripe subscription CTAs — credit
// packs and per-grade purchases remain available (they're additive). Mirrors
// the server guard appstoreSubscriptionBlocksStripe (lib/appstore/precedence.ts).
export function isAppstoreManaged(s: BillingSummary["subscription"]): boolean {
  return storeManaging(s) === "appstore";
}

/**
 * Which app store owns this subscription's lifecycle, or null for Stripe / none.
 *
 * US-2126: Google Play is a third processor, and the server-side precedence
 * guard has known that since this story's edge half — `googleplaySubscriptionActive`
 * is wired into all three purchase paths, so a Play subscriber attempting a
 * Stripe subscribe is refused. The WEB never learned it, so that seller was
 * still shown "Change plan" and "Cancel" and got a 409 with nothing explaining
 * it. The double charge was prevented; the dead end was not.
 *
 * Returning WHICH store rather than a boolean is deliberate. The page has to
 * name the app a seller should open, and "managed in the iOS app" shown to
 * someone who bought on Android is worse than no message at all.
 *
 * The entitling statuses mirror `APPSTORE_ENTITLING_STATUSES` in the edge's
 * `lib/appstore/precedence.ts`, for both stores.
 */
export function storeManaging(
  s: BillingSummary["subscription"],
): "appstore" | "googleplay" | null {
  const entitling =
    s.status === "active" || s.status === "trialing" || s.status === "past_due";
  if (!entitling) return null;
  if (s.billing_source === "appstore") return "appstore";
  if (s.billing_source === "googleplay") return "googleplay";
  return null;
}

// Stripe billing webhooks (credit grants, plan changes) land asynchronously a
// beat after the user returns from Checkout or an in-place upgrade. A single
// invalidate can fire before the webhook commits, leaving the UI stale. This
// re-invalidates on an interval for a bounded window so the change surfaces
// without a manual refresh.
export function pollBillingSummary(
  qc: ReturnType<typeof useQueryClient>,
  durationMs = 16000,
  intervalMs = 2000,
): () => void {
  qc.invalidateQueries({ queryKey: ["billing_summary"] });
  const interval = window.setInterval(
    () => qc.invalidateQueries({ queryKey: ["billing_summary"] }),
    intervalMs,
  );
  const stop = window.setTimeout(() => window.clearInterval(interval), durationMs);
  return () => {
    window.clearInterval(interval);
    window.clearTimeout(stop);
  };
}
