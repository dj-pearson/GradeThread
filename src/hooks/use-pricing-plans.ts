// US-587: live, data-driven FlipDesk plan config.
//
// Reads the pricing_plans table (anon-readable) so pricing surfaces — the
// billing comparison grid, the public pricing page — reflect operator edits made
// in admin WITHOUT a rebuild. FLIPDESK_PLANS (the compiled constant) is the
// placeholder/fallback: it's returned instantly while the query loads and if the
// read fails, so there's never an empty pricing UI.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import {
  FLIPDESK_PLANS,
  type FlipdeskPlanConfig,
  type FlipdeskPlanKey,
} from "@/lib/constants";
import type { PricingPlanRow } from "@/types/database";

export type PlansByKey = Record<FlipdeskPlanKey, FlipdeskPlanConfig>;

function rowToConfig(key: FlipdeskPlanKey, row: PricingPlanRow): FlipdeskPlanConfig {
  // Start from the compiled gate flags so a partial/legacy gate_flags blob never
  // drops a key; override with whatever the row specifies.
  const base = FLIPDESK_PLANS[key];
  const gateFlags = { ...base.gateFlags };
  for (const k of Object.keys(gateFlags) as (keyof typeof gateFlags)[]) {
    if (typeof row.gate_flags?.[k] === "boolean") gateFlags[k] = row.gate_flags[k];
  }
  return {
    name: row.name,
    priceMonthlyCents: row.price_monthly_cents,
    priceYearlyCents: row.price_yearly_cents,
    activeListingCap: row.active_listing_cap,
    aiActionsPerMonth: row.ai_actions_per_month,
    // US-9101: not a pricing_plans column, so it comes from the compiled value
    // like `features` does when the row omits it. Add the column and read it
    // here if the number ever needs to be operator-tunable.
    connectorActionsPerMonth: base.connectorActionsPerMonth,
    marketplacesCap: row.marketplaces_cap,
    includedStandardGradesPerMonth: row.included_standard_grades_per_month,
    features: Array.isArray(row.features) ? row.features : base.features,
    gateFlags,
  };
}

async function fetchPlans(): Promise<PlansByKey> {
  const { data, error } = await supabase
    .from("pricing_plans")
    .select(
      "key, name, price_monthly_cents, price_yearly_cents, active_listing_cap, ai_actions_per_month, marketplaces_cap, included_standard_grades_per_month, features, gate_flags",
    );
  if (error) throw error;

  // Start from the compiled defaults; overlay each row that comes back so a
  // missing tier still renders.
  const merged: PlansByKey = { ...FLIPDESK_PLANS };
  const rows = (data ?? []) as unknown as PricingPlanRow[];
  for (const row of rows) {
    if (row.key in merged) merged[row.key] = rowToConfig(row.key, row);
  }
  return merged;
}

/**
 * Live FlipDesk plan config keyed by plan. Always returns a complete map —
 * FLIPDESK_PLANS as placeholder while loading / on error.
 */
export function usePricingPlans(): { plans: PlansByKey; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ["pricing-plans"],
    queryFn: fetchPlans,
    staleTime: 5 * 60 * 1000,
    placeholderData: FLIPDESK_PLANS,
  });
  return { plans: data ?? FLIPDESK_PLANS, isLoading };
}
