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
import {
  type CreditPack,
  CREDIT_PACKS,
  type GradeTier,
  GRADE_TIERS,
  TIER_CREDIT_COST,
  TIER_PRICE_CENTS,
  TIER_SLA_HOURS,
} from "./grade-pricing.ts";

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
  /**
   * US-9101: the Claude connector, on its OWN flag rather than apiAccess.
   *
   * apiAccess means raw /api/v1 access and stays business-only. The connector
   * opens at pro, where it is the reason to move up from starter; business
   * keeps the higher action ceiling. Sandbox tools are exempt in the dispatcher
   * and work on every plan, free included.
   */
  connectorAccess: boolean;
  reconciliation: boolean;
  prioritySupport: boolean;
  /** AI AutoLister — bulk photos → generated eBay listings (US-323). Premium. */
  autolister: boolean;
  /**
   * US-3011: buying an eBay shipping label from inside the ship step.
   *
   * Pro and up. The postage itself is passed through at eBay's rate with no
   * markup — the subscription is the whole money model — because eBay's own
   * label flow and Pirate Ship are both free, and a seller who price-checks
   * would find any margin within a day.
   *
   * NOTE for whoever adds the NEXT flag: a key missing from a pricing_plans
   * row's gate_flags resolves to false in rowToConfig, and the DB row wins over
   * FALLBACK_MATRIX whenever it exists. So adding a flag here without the
   * matching migration ships a feature that is off for everyone, on every plan,
   * with no error anywhere.
   */
  shippingLabels: boolean;
}

export interface PlanConfig {
  /** -1 = unlimited */
  activeListingCap: number;
  aiActionsPerMonth: number;
  /**
   * US-9101: connector write actions per month, counted separately from
   * aiActionsPerMonth. Its own number so the connector can be priced as an
   * upsell later, and so an AutoLister batch cannot eat the allowance a
   * seller's connector needs. 0 on plans without connectorAccess.
   */
  connectorActionsPerMonth: number;
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
  "connectorAccess",
  "reconciliation",
  "prioritySupport",
  "autolister",
  "shippingLabels",
];

// ── Hardcoded fallback (pre-US-587 values; mirror of src/lib/constants.ts) ──
//
// Only used when the pricing_plans row is missing or the DB read fails. Keep in
// sync with the migration seed; the DB row is canonical once present.
export const FALLBACK_MATRIX: Record<FlipdeskPlan, PlanConfig> = {
  free: {
    activeListingCap: 25,
    aiActionsPerMonth: 25,
    connectorActionsPerMonth: 0,
    marketplacesCap: 1,
    includedStandardGradesPerMonth: 3,
    teamSeatCap: 0,
    gateFlags: {
      bulkActions: false, scheduledActions: false, compPulls: false,
      autoRelist: false, subAccounts: false, apiAccess: false,
      connectorAccess: false,
      reconciliation: false, prioritySupport: false, autolister: false,
      shippingLabels: false,
    },
  },
  starter: {
    activeListingCap: 250,
    aiActionsPerMonth: 200,
    connectorActionsPerMonth: 0,
    marketplacesCap: -1,
    includedStandardGradesPerMonth: 10,
    teamSeatCap: 0,
    gateFlags: {
      bulkActions: false, scheduledActions: false, compPulls: false,
      autoRelist: false, subAccounts: false, apiAccess: false,
      connectorAccess: false,
      reconciliation: false, prioritySupport: false, autolister: false,
      shippingLabels: false,
    },
  },
  pro: {
    activeListingCap: 1000,
    aiActionsPerMonth: 750,
    connectorActionsPerMonth: 500,
    marketplacesCap: -1,
    includedStandardGradesPerMonth: 30,
    teamSeatCap: 0,
    gateFlags: {
      bulkActions: true, scheduledActions: true, compPulls: true,
      autoRelist: true, subAccounts: false, apiAccess: false,
      connectorAccess: true,
      reconciliation: false, prioritySupport: false, autolister: true,
      shippingLabels: true,
    },
  },
  business: {
    activeListingCap: -1,
    aiActionsPerMonth: 2000,
    connectorActionsPerMonth: 2000,
    marketplacesCap: -1,
    includedStandardGradesPerMonth: 75,
    teamSeatCap: 10,
    gateFlags: {
      bulkActions: true, scheduledActions: true, compPulls: true,
      autoRelist: true, subAccounts: true, apiAccess: true,
      connectorAccess: true,
      reconciliation: true, prioritySupport: true, autolister: true,
      shippingLabels: true,
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
    // US-9101: NOT a pricing_plans column, deliberately. Adding one would mean a
    // migration, and a held migration to make a number operator-editable before
    // anyone has asked to edit it is the wrong trade. The compiled value is the
    // single definition until it needs tuning; add the column then, and this
    // line becomes `row.connector_actions_per_month ?? fallback`.
    connectorActionsPerMonth: FALLBACK_MATRIX[row.key]?.connectorActionsPerMonth ?? 0,
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

// US-1799: buyer-plan Stripe price IDs. Env-only (no DB override yet) — the
// setup-stripe-pricing.mjs BUYER catalog emits STRIPE_PRICE_BUYER_<TIER>_<INT>.
// LOCKSTEP with the frontend VITE_STRIPE_PRICE_BUYER_* map in constants.ts.
export function getBuyerPriceIds(): Record<"guard" | "connoisseur", Record<BillingInterval, string>> {
  return {
    guard: {
      monthly: Deno.env.get("STRIPE_PRICE_BUYER_GUARD_MONTHLY") || "",
      yearly: Deno.env.get("STRIPE_PRICE_BUYER_GUARD_YEARLY") || "",
    },
    connoisseur: {
      monthly: Deno.env.get("STRIPE_PRICE_BUYER_CONNOISSEUR_MONTHLY") || "",
      yearly: Deno.env.get("STRIPE_PRICE_BUYER_CONNOISSEUR_YEARLY") || "",
    },
  };
}

/** Clear the cache (after an admin edit so the change is instant on this replica;
 *  other replicas pick it up within the TTL). */
export function clearPricingConfigCache(): void {
  cache = null;
  gradePricingCache = null;
}

// ── Grade-tier + credit-pack pricing (US-885) ────────────────────────
//
// Per-grading-tier price/credit-cost/SLA and the credit-pack list, sourced from
// the pricing_config table with the same short cache + compiled fallback pattern
// as the plan matrix above. The pure compiled defaults live in grade-pricing.ts
// (TIER_PRICE_CENTS / TIER_CREDIT_COST / TIER_SLA_HOURS / CREDIT_PACKS) and are
// the single fallback so a missing row or a DB blip never breaks grade charging.

export interface GradeTierPricing {
  priceCents: number;
  creditCost: number;
  slaHours: number;
}

export interface GradePricing {
  tiers: Record<GradeTier, GradeTierPricing>;
  packs: CreditPack[];
}

export interface PricingConfigRow {
  id: string;
  kind: "grade_tier" | "credit_pack";
  sort_order: number;
  label: string;
  price_cents: number;
  tier_key: GradeTier | null;
  credit_cost: number | null;
  sla_hours: number | null;
  credits: number | null;
  stripe_price_ref: string;
}

// Compiled fallback assembled from the pure constants — used as the base that DB
// rows overlay, and returned wholesale on a read failure.
function fallbackGradePricing(): GradePricing {
  const tiers = {} as Record<GradeTier, GradeTierPricing>;
  for (const tier of GRADE_TIERS) {
    tiers[tier] = {
      priceCents: TIER_PRICE_CENTS[tier],
      creditCost: TIER_CREDIT_COST[tier],
      slaHours: TIER_SLA_HOURS[tier],
    };
  }
  return { tiers, packs: [...CREDIT_PACKS] };
}

let gradePricingCache: { value: GradePricing; expires: number } | null = null;

async function loadGradePricing(): Promise<GradePricing> {
  const result = fallbackGradePricing();

  try {
    const { data, error } = await supabaseAdmin
      .from("pricing_config")
      .select(
        "id, kind, sort_order, label, price_cents, tier_key, credit_cost, sla_hours, credits",
      )
      .order("sort_order", { ascending: true });
    if (error) {
      console.error("[pricing-config] grade pricing read error, using fallback:", error.message);
      return result;
    }

    const rows = (data ?? []) as unknown as PricingConfigRow[];
    const packs: CreditPack[] = [];
    for (const r of rows) {
      if (r.kind === "grade_tier" && r.tier_key && r.tier_key in result.tiers) {
        result.tiers[r.tier_key] = {
          priceCents: r.price_cents,
          // credit_cost / sla_hours are nullable in the schema — keep the
          // compiled fallback for a tier row that somehow omits them.
          creditCost: r.credit_cost ?? result.tiers[r.tier_key].creditCost,
          slaHours: r.sla_hours ?? result.tiers[r.tier_key].slaHours,
        };
      } else if (r.kind === "credit_pack" && typeof r.credits === "number") {
        packs.push({ credits: r.credits, priceCents: r.price_cents });
      }
    }
    // Only replace the fallback packs if the DB actually returned some (an empty
    // table → keep the compiled list so checkout upsell never goes blank).
    if (packs.length > 0) {
      packs.sort((a, b) => a.credits - b.credits);
      result.packs = packs;
    }
  } catch (err) {
    console.error(
      "[pricing-config] grade pricing read threw, using fallback:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return result;
}

/** Live grade-tier pricing + credit packs (DB-backed, cached, compiled fallback). */
export async function getGradePricing(): Promise<GradePricing> {
  const now = Date.now();
  if (gradePricingCache && gradePricingCache.expires > now) return gradePricingCache.value;
  const value = await loadGradePricing();
  gradePricingCache = { value, expires: now + CACHE_TTL_MS };
  return value;
}
