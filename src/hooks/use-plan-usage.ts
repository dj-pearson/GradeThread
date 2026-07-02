import { useMemo } from "react";
import { FLIPDESK_PLANS } from "@/lib/constants";
import type { FlipdeskPlanKey } from "@/lib/constants";
import { useBillingSummary } from "@/hooks/use-billing-summary";

// ── usePlanUsage (US-209) ───────────────────────────────────────
//
// Derives the four plan-cap meters from the single billing-summary cache
// (US-214's useBillingSummary). One source of truth, no extra request — any
// mutation that invalidates ["billing_summary"] re-derives these.
//
// Each cap carries { used, limit, pct }. limit === -1 means unlimited (pct is
// pinned to 0 so the soft-trigger watcher never fires on an uncapped meter).
// The marketplaces meter mirrors marketplacesCap; includedGrades is the
// monthly Standard-grade bundle.

export type PlanCapKind =
  | "activeListings"
  | "aiActions"
  | "includedGrades"
  | "marketplaces";

export interface CapUsage {
  used: number;
  limit: number;
  /** 0–100. Pinned to 0 for unlimited caps (limit === -1). */
  pct: number;
  unlimited: boolean;
}

export interface PlanUsage {
  plan: FlipdeskPlanKey;
  activeListings: CapUsage;
  aiActions: CapUsage;
  includedGrades: CapUsage;
  marketplacesConnected: CapUsage;
  /** Percentages (out of 100) the user opted into — default [80]. */
  thresholds: number[];
  /** Per-"cap:threshold" → "YYYY-MM" dedup ledger from the server. */
  lastWarning: Record<string, string>;
  isLoading: boolean;
}

function cap(used: number, limit: number): CapUsage {
  const unlimited = limit < 0;
  const pct = unlimited || limit === 0 ? 0 : Math.round((used / limit) * 100);
  return { used, limit, pct, unlimited };
}

const EMPTY_CAP: CapUsage = { used: 0, limit: 0, pct: 0, unlimited: false };

export function usePlanUsage(): PlanUsage {
  const { data, isLoading } = useBillingSummary();

  return useMemo(() => {
    if (!data) {
      return {
        plan: "free",
        activeListings: EMPTY_CAP,
        aiActions: EMPTY_CAP,
        includedGrades: EMPTY_CAP,
        marketplacesConnected: EMPTY_CAP,
        thresholds: [80],
        lastWarning: {},
        isLoading,
      };
    }

    const plan = (data.subscription.plan ?? "free") as FlipdeskPlanKey;
    const conf = FLIPDESK_PLANS[plan] ?? FLIPDESK_PLANS.free;

    // AI limit: the plan default unless the user set a lower personal cap.
    const aiLimit = data.usage.ai_action_limit ?? conf.aiActionsPerMonth;

    return {
      plan,
      activeListings: cap(data.usage.active_listings ?? 0, conf.activeListingCap),
      aiActions: cap(data.usage.ai_actions_used_this_month ?? 0, aiLimit),
      includedGrades: cap(
        data.grades.included_used_this_month ?? 0,
        conf.includedStandardGradesPerMonth,
      ),
      marketplacesConnected: cap(
        data.usage.marketplaces_connected ?? 0,
        conf.marketplacesCap,
      ),
      thresholds:
        data.alerts?.thresholds && data.alerts.thresholds.length > 0
          ? data.alerts.thresholds
          : [80],
      lastWarning: data.alerts?.last_warning ?? {},
      isLoading,
    };
  }, [data, isLoading]);
}

// Friendly cap labels — shared by the watcher toast + meters.
export const CAP_LABELS: Record<PlanCapKind, string> = {
  activeListings: "active listings",
  aiActions: "AI actions this month",
  includedGrades: "included grades this month",
  marketplaces: "connected marketplaces",
};

// Maps a PlanUsage field to its cap kind for telemetry + the dedup ledger.
export const CAP_FIELDS: Array<{ kind: PlanCapKind; field: keyof PlanUsage }> = [
  { kind: "activeListings", field: "activeListings" },
  { kind: "aiActions", field: "aiActions" },
  { kind: "includedGrades", field: "includedGrades" },
  { kind: "marketplaces", field: "marketplacesConnected" },
];

// Next plan that raises the given cap above `needed`. Mirrors the ladder in
// edge-fetch.ts (kept local to avoid an import cycle through constants).
const CAP_LADDER: Record<PlanCapKind, Array<{ plan: FlipdeskPlanKey; limit: number }>> = {
  activeListings: [
    { plan: "starter", limit: 250 },
    { plan: "pro", limit: 1000 },
    { plan: "business", limit: -1 },
  ],
  aiActions: [
    { plan: "starter", limit: 200 },
    { plan: "pro", limit: 750 },
    { plan: "business", limit: 2000 },
  ],
  marketplaces: [
    { plan: "starter", limit: 2 },
    { plan: "pro", limit: -1 },
    { plan: "business", limit: -1 },
  ],
  includedGrades: [
    { plan: "starter", limit: 10 },
    { plan: "pro", limit: 30 },
    { plan: "business", limit: 75 },
  ],
};

export function suggestedPlanForCap(kind: PlanCapKind, needed: number): FlipdeskPlanKey {
  const ladder = CAP_LADDER[kind];
  for (const step of ladder) {
    if (step.limit === -1 || needed <= step.limit) return step.plan;
  }
  return "business";
}
