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
  };
  grades: {
    credit_balance: number;
    included_used_this_month: number;
  };
  usage: {
    active_listings: number;
    marketplaces_connected: number;
    ai_actions_used_this_month: number;
    ai_action_limit: number | null;
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
  return useMutation<
    { sessionId: string; url: string },
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
      if (data.url) window.location.href = data.url;
    },
    onError: (err) => toast.error(err.message),
  });
}

export function useBuyCreditPack() {
  return useMutation<
    { sessionId: string; url: string },
    Error,
    { packSize: CreditPackSize }
  >({
    mutationFn: async ({ packSize }) => {
      const res = await edgeFetch("/api/payments/gradethread/credit-pack", {
        method: "POST",
        json: { packSize },
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
