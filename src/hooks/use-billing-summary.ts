import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import type {
  FlipdeskPlanKey,
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
  balance_after: number;
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

export function useFlipdeskSubscribe() {
  const qc = useQueryClient();
  return useMutation<
    {
      sessionId?: string;
      url?: string;
      ok?: boolean;
      updated?: boolean;
      unchanged?: boolean;
    },
    Error,
    { plan: Exclude<FlipdeskPlanKey, "free">; interval: BillingInterval }
  >({
    mutationFn: async ({ plan, interval }) => {
      const res = await edgeFetch("/api/payments/flipdesk/subscribe", {
        method: "POST",
        json: { plan, interval },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to start checkout.");
      return json;
    },
    onSuccess: (data) => {
      // New subscription → Stripe Checkout redirect.
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      // Existing subscription was modified in place (upgrade / interval swap).
      // The customer.subscription.updated webhook persists the new plan a beat
      // later, so poll the summary instead of reading it once.
      if (data.updated) {
        toast.success(
          data.unchanged ? "You're already on that plan." : "Plan updated.",
        );
        pollBillingSummary(qc);
      }
    },
    onError: (err) => toast.error(err.message),
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
      if (data.url) window.location.href = data.url;
    },
    onError: (err) => toast.error(err.message),
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
    onError: (err) => toast.error(err.message),
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
    onError: (err) => toast.error(err.message),
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
    onError: (err) => toast.error(err.message),
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
    onError: (err) => toast.error(err.message),
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
    onError: (err) => toast.error(err.message),
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
    onError: (err) => toast.error(err.message),
  });
}

export function useBillingPortal() {
  return useMutation<{ url: string }, Error, void>({
    mutationFn: async () => {
      const res = await edgeFetch("/api/payments/portal", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to open billing portal.");
      return json;
    },
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
    onError: (err) => toast.error(err.message),
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

export function isPaidPlan(plan: FlipdeskPlan): boolean {
  return plan !== "free";
}

export function refreshBilling(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["billing_summary"] });
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
