// Data-driven plan pricing + limits (US-587).
//
// Single read path for the FlipDesk plan matrix (enforcement limits + feature
// gates) and the Stripe price IDs, sourced from the pricing_plans table
// (migration 00166) with a short in-memory cache. Editing a plan in admin takes
// effect across the fleet within CACHE_TTL — no redeploy.
//
// FAIL-SAFE: a DB read error or a missing row falls back to the hardcoded matrix
// below (the pre-US-587 values), and an empty stripe_price_* falls back to the
// matching env var. So a fresh deploy that hasn't applied 00166, or a transient
// DB blip, never breaks gating or checkout — it just uses the compiled defaults.

import { supabaseAdmin } from "./supabase.ts";

export type FlipdeskPlan = "free" | "starter" | "pro" | "business";
export type PaidPlan = "starter" | "pro" | "business";
export type BillingInterval = "monthly" | "yearly";

export interface GateFlags {
  bulkActions: boolean;
  scheduledActions: boolean;
  compPulls: boolean;
  autoRelist: boolean;
  subAccounts: boolean;
  apiAccess: boolean;
  reconciliation: boolean;
  prioritySupport: boolean;
  /** AI AutoLister — bulk photos → generated eBay listings (US-323). Premium. */
  autolister: boolean;
}

export interface PlanConfig {
  /** -1 = unlimited */
  activeListingCap: number;
  aiActionsPerMonth: number;
  /** -1 = all */
  marketplacesCap: number;
  includedStandardGradesPerMonth: number;
  /** US-388: additional team members (excludes the owner). 0 = no team. */
  teamSeatCap: number;
  gateFlags: GateFlags;
}

export const GATE_FLAG_KEYS: (keyof GateFlags)[] = [
  "bulkActions",
  "scheduledActions",
  "compPulls",
  "autoRelist",
  "subAccounts",
  "apiAccess",
  "reconciliation",
  "prioritySupport",
  "autolister",
];

// ── Hardcoded fallback (pre-US-587 values; mirror of src/lib/constants.ts) ──
//
// Only used when the pricing_plans row is missing or the DB read fails. Keep in
// sync with the migration seed; the DB row is canonical once present.
export const FALLBACK_MATRIX: Record<FlipdeskPlan, PlanConfig> = {
  free: {
    activeListingCap: 25,
    aiActionsPerMonth: 25,
    marketplacesCap: 1,
    includedStandardGradesPerMonth: 3,
    teamSeatCap: 0,
    gateFlags: {
      bulkActions: false, scheduledActions: false, compPulls: false,
      autoRelist: false, subAccounts: false, apiAccess: false,
      reconciliation: false, prioritySupport: false, autolister: false,
    },
  },
  starter: {
    activeListingCap: 250,
    aiActionsPerMonth: 200,
    marketplacesCap: 1,
    includedStandardGradesPerMonth: 10,
    teamSeatCap: 0,
    gateFlags: {
      bulkActions: false, scheduledActions: false, compPulls: false,
      autoRelist: false, subAccounts: false, apiAccess: false,
      reconciliation: false, prioritySupport: false, autolister: false,
    },
  },
  pro: {
    activeListingCap: 1000,
    aiActionsPerMonth: 1000,
    marketplacesCap: 1,
    includedStandardGradesPerMonth: 30,
    teamSeatCap: 0,
    gateFlags: {
      bulkActions: true, scheduledActions: true, compPulls: true,
      autoRelist: true, subAccounts: false, apiAccess: false,
      reconciliation: false, prioritySupport: false, autolister: true,
    },
  },
  business: {
    activeListingCap: -1,
    aiActionsPerMonth: 5000,
    marketplacesCap: 1,
    includedStandardGradesPerMonth: 75,
    teamSeatCap: 10,
    gateFlags: {
      bulkActions: true, scheduledActions: true, compPulls: true,
      autoRelist: true, subAccounts: true, apiAccess: true,
      reconciliation: true, prioritySupport: true, autolister: true,
    },
  },
};

// Per-field env fallback for Stripe price IDs (mirrors payments.ts US-202).
function envPriceIds(): Record<PaidPlan, Record<BillingInterval, string>> {
  return {
    starter: {
      monthly: Deno.env.get("STRIPE_PRICE_FLIPDESK_STARTER_MONTHLY") || "",
      yearly:  Deno.env.get("STRIPE_PRICE_FLIPDESK_STARTER_YEARLY")  || "",
    },
    pro: {
      monthly: Deno.env.get("STRIPE_PRICE_FLIPDESK_PRO_MONTHLY") || "",
      yearly:  Deno.env.get("STRIPE_PRICE_FLIPDESK_PRO_YEARLY")  || "",
    },
    business: {
      monthly: Deno.env.get("STRIPE_PRICE_FLIPDESK_BUSINESS_MONTHLY") || "",
      yearly:  Deno.env.get("STRIPE_PRICE_FLIPDESK_BUSINESS_YEARLY")  || "",
    },
  };
}

export interface PricingPlanRow {
  key: FlipdeskPlan;
  name: string;
  sort_order: number;
  price_monthly_cents: number;
  price_yearly_cents: number;
  active_listing_cap: number;
  ai_actions_per_month: number;
  marketplaces_cap: number;
  included_standard_grades_per_month: number;
  team_seat_cap: number;
  features: string[];
  gate_flags: Partial<GateFlags>;
  stripe_price_monthly: string;
  stripe_price_yearly: string;
}

interface LoadedPricing {
  matrix: Record<FlipdeskPlan, PlanConfig>;
  priceIds: Record<PaidPlan, Record<BillingInterval, string>>;
}

const CACHE_TTL_MS = 30_000;
let cache: { value: LoadedPricing; expires: number } | null = null;

function rowToConfig(row: PricingPlanRow): PlanConfig {
  const flags = row.gate_flags ?? {};
  const gateFlags = {} as GateFlags;
  for (const k of GATE_FLAG_KEYS) gateFlags[k] = flags[k] === true;
  return {
    activeListingCap: row.active_listing_cap,
    aiActionsPerMonth: row.ai_actions_per_month,
    marketplacesCap: row.marketplaces_cap,
    includedStandardGradesPerMonth: row.included_standard_grades_per_month,
    teamSeatCap: row.team_seat_cap,
    gateFlags,
  };
}

async function load(): Promise<LoadedPricing> {
  const matrix: Record<FlipdeskPlan, PlanConfig> = {
    free: FALLBACK_MATRIX.free,
    starter: FALLBACK_MATRIX.starter,
    pro: FALLBACK_MATRIX.pro,
    business: FALLBACK_MATRIX.business,
  };
  const priceIds = envPriceIds();

  try {
    const { data, error } = await supabaseAdmin
      .from("pricing_plans")
      .select(
        "key, active_listing_cap, ai_actions_per_month, marketplaces_cap, included_standard_grades_per_month, team_seat_cap, gate_flags, stripe_price_monthly, stripe_price_yearly",
      );
    if (error) {
      console.error("[pricing-config] read error, using fallback:", error.message);
    } else {
      for (const r of (data ?? []) as PricingPlanRow[]) {
        if (r.key in matrix) matrix[r.key] = rowToConfig(r);
        if (r.key === "starter" || r.key === "pro" || r.key === "business") {
          // Per-field: a non-empty DB value wins; otherwise keep the env fallback.
          if (r.stripe_price_monthly) priceIds[r.key].monthly = r.stripe_price_monthly;
          if (r.stripe_price_yearly)  priceIds[r.key].yearly  = r.stripe_price_yearly;
        }
      }
    }
  } catch (err) {
    console.error(
      "[pricing-config] read threw, using fallback:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return { matrix, priceIds };
}

async function loadCached(): Promise<LoadedPricing> {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.value;
  const value = await load();
  cache = { value, expires: now + CACHE_TTL_MS };
  return value;
}

/** The live FlipDesk plan matrix (enforcement limits + feature gates). */
export async function getPlanMatrix(): Promise<Record<FlipdeskPlan, PlanConfig>> {
  return (await loadCached()).matrix;
}

/** Live Stripe price IDs (DB value if set, else the env var). */
export async function getFlipdeskPriceIds(): Promise<
  Record<PaidPlan, Record<BillingInterval, string>>
> {
  return (await loadCached()).priceIds;
}

/** Clear the cache (after an admin edit so the change is instant on this replica;
 *  other replicas pick it up within the TTL). */
export function clearPricingConfigCache(): void {
  cache = null;
}
