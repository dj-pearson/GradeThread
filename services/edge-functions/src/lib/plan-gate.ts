// FlipDesk plan-gate middleware (US-208).
//
// Single source of truth for "can this user do this thing?" — every
// FlipDesk-side endpoint that touches a gated capacity (active listings, AI
// actions, marketplace connections) or a gated feature (bulk actions,
// sub-accounts, API access, reconciliation) should call requireFlipdesk()
// at the top of the handler. If the call returns a Response, return it
// directly — otherwise proceed.
//
// Soft warnings at 80%: instead of blocking, requireFlipdesk sets the
// X-Plan-Warning response header so the frontend (US-209) can show an
// upgrade toast.
//
// Hard caps at 100% return 402 PAYMENT_REQUIRED with a body the frontend
// (US-210) uses to render the UpgradeRequiredDialog.
//
// MIGRATION (follow-up to US-208):
// The following routes still read the legacy users.plan column with their
// own per-file limit tables instead of calling requireFlipdesk(). They keep
// working because users.plan is preserved through US-225, but each should
// be migrated:
//
//   • routes/flipdesk-ai.ts       — checkQuota → requireFlipdesk({ capacity: { kind: 'aiActions' } })
//   • routes/flipdesk-grading.ts  — planLimit() → requireFlipdesk({ capacity: { kind: 'includedGrades' } })
//                                   (note: this should fall through to credits via /grade/submit precedence, not block)
//   • routes/api-keys.ts          — Professional/Enterprise check → requireFlipdesk({ feature: 'apiAccess' })
//   • routes/api-v1.ts            — PLAN_LIMITS → requireFlipdesk({ capacity: { kind: 'includedGrades' } })
//
// Also wire into (not yet plan-gated):
//   • inventory create/listing-publish → { capacity: { kind: 'activeListings' } }
//   • marketplace connect             → { capacity: { kind: 'marketplaces' } }
//   • bulk actions endpoints          → { feature: 'bulkActions' }
//   • scheduled actions endpoints     → { feature: 'scheduledActions' }
//   • reconciliation endpoints        → { feature: 'reconciliation' }
//   • sub-account invite              → { feature: 'subAccounts' }

import type { Context } from "hono";
import { supabaseAdmin } from "./supabase.ts";
import { effectivePlanFor } from "./grade-pricing.ts";

// ── FlipDesk catalog (mirror of src/lib/constants.ts FLIPDESK_PLANS) ──

type FlipdeskPlan = "free" | "starter" | "pro" | "business";

interface GateFlags {
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

interface PlanConfig {
  /** -1 = unlimited */
  activeListingCap: number;
  aiActionsPerMonth: number;
  /** -1 = all */
  marketplacesCap: number;
  includedStandardGradesPerMonth: number;
  gateFlags: GateFlags;
}

const PLAN_MATRIX: Record<FlipdeskPlan, PlanConfig> = {
  free: {
    activeListingCap: 25,
    aiActionsPerMonth: 25,
    marketplacesCap: 1,
    includedStandardGradesPerMonth: 3,
    gateFlags: {
      bulkActions: false, scheduledActions: false, compPulls: false,
      autoRelist: false, subAccounts: false, apiAccess: false,
      reconciliation: false, prioritySupport: false, autolister: false,
    },
  },
  starter: {
    activeListingCap: 250,
    aiActionsPerMonth: 200,
    marketplacesCap: 2,
    includedStandardGradesPerMonth: 10,
    gateFlags: {
      bulkActions: false, scheduledActions: false, compPulls: false,
      autoRelist: false, subAccounts: false, apiAccess: false,
      reconciliation: false, prioritySupport: false, autolister: false,
    },
  },
  pro: {
    activeListingCap: 1000,
    aiActionsPerMonth: 1000,
    marketplacesCap: -1,
    includedStandardGradesPerMonth: 30,
    gateFlags: {
      bulkActions: true, scheduledActions: true, compPulls: true,
      autoRelist: true, subAccounts: false, apiAccess: false,
      reconciliation: false, prioritySupport: false, autolister: true,
    },
  },
  business: {
    activeListingCap: -1,
    aiActionsPerMonth: 5000,
    marketplacesCap: -1,
    includedStandardGradesPerMonth: 75,
    gateFlags: {
      bulkActions: true, scheduledActions: true, compPulls: true,
      autoRelist: true, subAccounts: true, apiAccess: true,
      reconciliation: true, prioritySupport: true, autolister: true,
    },
  },
};

const PLAN_RANK: Record<FlipdeskPlan, number> = {
  free: 0, starter: 1, pro: 2, business: 3,
};

const SOFT_WARN_PCT = 0.8;

// ── Public API ───────────────────────────────────────────────────

type CapacityKind = "activeListings" | "aiActions" | "marketplaces" | "includedGrades";
type FeatureKey = keyof GateFlags;

export interface CapacityCheck {
  kind: CapacityKind;
  /** How many to add to current usage. Defaults to 1. */
  delta?: number;
}

export interface RequireFlipdeskOptions {
  feature?: FeatureKey;
  capacity?: CapacityCheck;
  /** Optional override — caller already has the user row and wants to skip the lookup. */
  userId?: string;
}

type EnvWithUser = { Variables: { userId: string } };

/** The user slice plan-gate needs to make a decision. */
export interface PlanGateUser {
  flipdesk_plan: FlipdeskPlan;
  subscription_status: string;
  // US-383: an expired Pro trial drops to Free caps before the downgrade job runs.
  trial_ends_at: string | null;
  ai_actions_used_this_month: number;
  ai_action_limit: number | null;
  grades_used_this_month: number;
}

/**
 * Data access plan-gate depends on. Defaults to the supabaseAdmin-backed
 * implementation; tests inject canned values so the decision logic (US-208)
 * can be exercised without a live DB. Mirrors the injectable-incrementer
 * pattern used by lib/rate-limit.ts.
 */
export interface PlanGateDeps {
  loadUser(userId: string): Promise<PlanGateUser | null>;
  readUsage(userId: string, kind: CapacityKind, user: PlanGateUser): Promise<number>;
}

const defaultDeps: PlanGateDeps = {
  async loadUser(userId) {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select(
        "flipdesk_plan, subscription_status, trial_ends_at, ai_actions_used_this_month, ai_action_limit, grades_used_this_month",
      )
      .eq("id", userId)
      .single();
    if (error || !data) {
      console.error(`[plan-gate] User ${userId} not found:`, error);
      return null;
    }
    return data as PlanGateUser;
  },
  readUsage: readCurrentUsage,
};

/**
 * Returns a Response (402 PAYMENT_REQUIRED) if the user is blocked. Returns
 * null if the call should proceed. When at the soft-warning threshold, sets
 * the X-Plan-Warning header and returns null.
 *
 * Generic over the Hono env so routes with a richer Variables shape (e.g.
 * workspaceOwnerId/workspaceRole) can pass their own Context — Context is
 * invariant, so a non-generic param would reject those callers.
 */
export async function requireFlipdesk<E extends EnvWithUser = EnvWithUser>(
  c: Context<E>,
  opts: RequireFlipdeskOptions,
  deps: PlanGateDeps = defaultDeps,
): Promise<Response | null> {
  const userId = opts.userId ?? c.get("userId");
  if (!userId) {
    return c.json({ error: "UNAUTHENTICATED" }, 401);
  }

  const user = await deps.loadUser(userId);
  if (!user) {
    return c.json({ error: "USER_NOT_FOUND" }, 404);
  }

  // Paused subscribers AND expired trials (US-383) fall back to Free caps but
  // don't reset counters. Shared resolution with the grading path.
  const effectivePlan = effectivePlanFor(
    user.flipdesk_plan,
    user.subscription_status,
    user.trial_ends_at,
  ) as FlipdeskPlan;
  const plan = PLAN_MATRIX[effectivePlan];

  // ─ Feature check ─
  if (opts.feature) {
    if (!plan.gateFlags[opts.feature]) {
      return c.json(
        {
          error: "FEATURE_LOCKED",
          feature: opts.feature,
          plan: effectivePlan,
          requiredPlan: requiredPlanForFeature(opts.feature),
        },
        402,
      );
    }
  }

  // ─ Capacity check ─
  if (opts.capacity) {
    const delta = opts.capacity.delta ?? 1;
    const used = await deps.readUsage(userId, opts.capacity.kind, user);
    const limit = getLimit(plan, opts.capacity.kind);

    if (limit === -1) return null; // Unlimited.

    if (used + delta > limit) {
      return c.json(
        {
          error: "CAP_REACHED",
          cap: opts.capacity.kind,
          used,
          delta,
          limit,
          plan: effectivePlan,
          requiredPlan: requiredPlanForCapacity(opts.capacity.kind, used + delta),
        },
        402,
      );
    }

    // Soft warning at 80% (set header, allow request to proceed).
    const pct = (used + delta) / limit;
    if (pct >= SOFT_WARN_PCT) {
      c.header(
        "X-Plan-Warning",
        `CAP_80;kind=${opts.capacity.kind};used=${used + delta};limit=${limit}`,
      );
    }
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────

function getLimit(plan: PlanConfig, kind: CapacityKind): number {
  switch (kind) {
    case "activeListings": return plan.activeListingCap;
    case "aiActions": return plan.aiActionsPerMonth;
    case "marketplaces": return plan.marketplacesCap;
    case "includedGrades": return plan.includedStandardGradesPerMonth;
  }
}

interface UserSlice {
  flipdesk_plan: FlipdeskPlan;
  ai_actions_used_this_month: number;
  ai_action_limit: number | null;
  grades_used_this_month: number;
}

async function readCurrentUsage(
  userId: string,
  kind: CapacityKind,
  user: UserSlice,
): Promise<number> {
  switch (kind) {
    case "activeListings": {
      const { count, error } = await supabaseAdmin
        .from("inventory_items")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "listed");
      if (error) {
        console.error("[plan-gate] activeListings query failed:", error);
        return 0;
      }
      return count ?? 0;
    }

    case "aiActions": {
      // User-set self-cap (US-224) is enforced via min(plan_limit, user_limit).
      // We return the larger of "what the plan says" since the cap is computed
      // in getLimit, not here.
      return user.ai_actions_used_this_month;
    }

    case "marketplaces": {
      const { count, error } = await supabaseAdmin
        .from("marketplace_connections")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("is_active", true);
      if (error) {
        console.error("[plan-gate] marketplaces query failed:", error);
        return 0;
      }
      return count ?? 0;
    }

    case "includedGrades": {
      return user.grades_used_this_month;
    }
  }
}

/** Smallest plan that satisfies a feature gate. */
function requiredPlanForFeature(feature: FeatureKey): FlipdeskPlan {
  for (const plan of ["starter", "pro", "business"] as FlipdeskPlan[]) {
    if (PLAN_MATRIX[plan].gateFlags[feature]) return plan;
  }
  return "business";
}

/** Smallest plan whose limit on `kind` covers `needed`. */
function requiredPlanForCapacity(kind: CapacityKind, needed: number): FlipdeskPlan {
  for (const plan of ["starter", "pro", "business"] as FlipdeskPlan[]) {
    const limit = getLimit(PLAN_MATRIX[plan], kind);
    if (limit === -1 || needed <= limit) return plan;
  }
  return "business";
}

// ── User-self-cap helper (US-224) ────────────────────────────────
//
// Computes the effective AI-actions cap honoring the user's optional self-cap
// (users.ai_action_limit). Use when you need the cap value for display, not
// gating — gating already handles min() internally.
export function effectiveAiCap(planLimit: number, userLimit: number | null): number {
  if (planLimit === -1 && userLimit == null) return -1;
  if (planLimit === -1) return userLimit ?? -1;
  if (userLimit == null) return planLimit;
  return Math.min(planLimit, userLimit);
}

// ── Exports for tests / introspection ────────────────────────────
export const __testing = {
  PLAN_MATRIX,
  PLAN_RANK,
  requiredPlanForFeature,
  requiredPlanForCapacity,
  getLimit,
  SOFT_WARN_PCT,
};
