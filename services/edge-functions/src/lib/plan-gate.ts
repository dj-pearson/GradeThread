// FlipDesk plan-gate middleware (US-208).
//
// ↳ CONTRACT: vault/50-business/flipdesk-plan-gating.md — the call rule every
//   new FlipDesk endpoint must honour, and the 80%-warning / 402 response
//   protocol two frontends parse.
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
// Now wired (kept here as the enforcement index):
//   • listing-publish (eBay + AutoLister)  → { capacity: { kind: 'activeListings' } }
//   • marketplace connect (eBay/Shopify/Depop) → { capacity: { kind: 'marketplaces' } }
//   • bulk actions (AI bulk-extract, eBay bulk-edit + bulk-price-quantity) → { feature: 'bulkActions' }
//   • scheduled actions (automation rules create/update/run + the hourly cron,
//     via featureAllowedForUser so a downgrade stops running rules) → { feature: 'scheduledActions' }
//   • reconciliation endpoints         → { feature: 'reconciliation' }
//   • sub-account invite               → { feature: 'subAccounts' }
//   • api key create                   → { feature: 'apiAccess' }
//
// Note: `autoRelist` is a plan flag with NO distinct server code path — the
// automation engine's end_listing action (→ item back to 'drafted' for manual
// relist) is the closest behavior and is already covered by scheduledActions.
// `prioritySupport` is an SLA/routing attribute, not a runtime gate.

import type { Context } from "hono";
import { supabaseAdmin } from "./supabase.ts";
import { effectivePlanFor } from "./grade-pricing.ts";
import {
  FALLBACK_MATRIX,
  type FlipdeskPlan,
  type GateFlags,
  getPlanMatrix,
  type PlanConfig,
} from "./pricing-config.ts";

// ── FlipDesk catalog ──
//
// US-587: the plan matrix (enforcement limits + feature gates) is now data-driven
// — loaded from the pricing_plans table via getPlanMatrix() so operators can edit
// limits/pricing from admin without a deploy. FALLBACK_MATRIX (in pricing-config)
// is the compiled default used only when the DB row is missing or unreadable.

const PLAN_RANK: Record<FlipdeskPlan, number> = {
  free: 0, starter: 1, pro: 2, business: 3,
};

const SOFT_WARN_PCT = 0.8;

// ── Public API ───────────────────────────────────────────────────

type CapacityKind =
  | "activeListings"
  | "aiActions"
  | "marketplaces"
  | "includedGrades"
  | "teamSeats";
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
  // Optional so tests can build slices without it. When 'super_admin', the
  // platform owner bypasses every cap/feature gate (see requireFlipdesk).
  role?: string;
  flipdesk_plan: FlipdeskPlan;
  subscription_status: string;
  // US-383: an expired Pro trial drops to Free caps before the downgrade job runs.
  trial_ends_at: string | null;
  // US-395: anchor for the dunning grace window; a past_due sub past the window
  // loses paid caps.
  past_due_since: string | null;
  ai_actions_used_this_month: number;
  ai_action_limit: number | null;
  grades_used_this_month: number;
  // US-393: when the included-grade counter rolls over (Free users never get an
  // invoice.payment_succeeded to reset it, so the read must be clock-based).
  grade_reset_at: string;
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
        "role, flipdesk_plan, subscription_status, trial_ends_at, past_due_since, ai_actions_used_this_month, ai_action_limit, grades_used_this_month, grade_reset_at",
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

  // Super-admin (platform owner) bypasses every cap and feature gate. Scoped
  // strictly to role = 'super_admin' so regular 'admin'/'reviewer' users are
  // still gated by their plan. Pairs with the grading short-circuit in
  // grade-billing.ts so the owner has truly unlimited grading even on the
  // entry points that pre-gate `includedGrades` here before charging.
  if (user.role === "super_admin") return null;

  // Paused subscribers, expired trials (US-383), AND past_due subs beyond the
  // dunning grace window (US-395) fall back to Free caps but don't reset
  // counters. Shared resolution with the grading path.
  const effectivePlan = effectivePlanFor(
    user.flipdesk_plan,
    user.subscription_status,
    user.trial_ends_at,
    new Date(),
    user.past_due_since,
  ) as FlipdeskPlan;
  // US-587: live, operator-editable matrix (DB-backed, cached) with the compiled
  // fallback baked in.
  const matrix = await getPlanMatrix();
  const plan = matrix[effectivePlan];

  // ─ Feature check ─
  if (opts.feature) {
    if (!plan.gateFlags[opts.feature]) {
      return c.json(
        {
          error: "FEATURE_LOCKED",
          feature: opts.feature,
          plan: effectivePlan,
          requiredPlan: requiredPlanForFeature(matrix, opts.feature),
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
          requiredPlan: requiredPlanForCapacity(matrix, opts.capacity.kind, used + delta),
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

/**
 * Non-HTTP feature check: does `userId`'s EFFECTIVE plan grant `feature`?
 *
 * Same resolution as requireFlipdesk (super_admin bypass; paused / expired-trial
 * / past-due-past-grace → Free caps), for callers with no Hono context — e.g. a
 * cron loop that must SKIP owners whose plan no longer includes a gated feature,
 * so a downgrade actually stops the paid behavior instead of grandfathering it.
 * Fails CLOSED (returns false) when the user can't be loaded.
 */
export async function featureAllowedForUser(
  userId: string,
  feature: FeatureKey,
  deps: Pick<PlanGateDeps, "loadUser"> = defaultDeps,
): Promise<boolean> {
  const user = await deps.loadUser(userId);
  if (!user) return false;
  if (user.role === "super_admin") return true;
  const effectivePlan = effectivePlanFor(
    user.flipdesk_plan,
    user.subscription_status,
    user.trial_ends_at,
    new Date(),
    user.past_due_since,
  ) as FlipdeskPlan;
  const matrix = await getPlanMatrix();
  return matrix[effectivePlan].gateFlags[feature] === true;
}

// ── Helpers ──────────────────────────────────────────────────────

function getLimit(plan: PlanConfig, kind: CapacityKind): number {
  switch (kind) {
    case "activeListings": return plan.activeListingCap;
    case "aiActions": return plan.aiActionsPerMonth;
    case "marketplaces": return plan.marketplacesCap;
    case "includedGrades": return plan.includedStandardGradesPerMonth;
    case "teamSeats": return plan.teamSeatCap;
  }
}

interface UserSlice {
  flipdesk_plan: FlipdeskPlan;
  ai_actions_used_this_month: number;
  ai_action_limit: number | null;
  grades_used_this_month: number;
  // US-393: the clock-based monthly reset boundary for included grades.
  grade_reset_at: string;
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
      // US-393: honor the monthly rollover. Free users get no
      // invoice.payment_succeeded to zero the counter, so once the reset
      // boundary has passed the used count is 0 until the next grade is spent
      // (which re-stamps grade_reset_at). Mirrors runPaymentPrecedence.
      if (new Date(user.grade_reset_at).getTime() <= Date.now()) return 0;
      return user.grades_used_this_month;
    }

    case "teamSeats": {
      // US-388: active team members in this workspace, excluding the owner
      // (workspace_members never contains the owner). userId is the workspace
      // OWNER (callers pass opts.userId = workspaceOwnerId).
      const { count, error } = await supabaseAdmin
        .from("workspace_members")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", userId);
      if (error) {
        console.error("[plan-gate] teamSeats query failed:", error);
        // Fail closed: report the cap as full so we don't over-admit seats.
        return Number.MAX_SAFE_INTEGER;
      }
      return count ?? 0;
    }
  }
}

/** Smallest plan that satisfies a feature gate. */
function requiredPlanForFeature(
  matrix: Record<FlipdeskPlan, PlanConfig>,
  feature: FeatureKey,
): FlipdeskPlan {
  for (const plan of ["starter", "pro", "business"] as FlipdeskPlan[]) {
    if (matrix[plan].gateFlags[feature]) return plan;
  }
  return "business";
}

/** Smallest plan whose limit on `kind` covers `needed`. */
function requiredPlanForCapacity(
  matrix: Record<FlipdeskPlan, PlanConfig>,
  kind: CapacityKind,
  needed: number,
): FlipdeskPlan {
  for (const plan of ["starter", "pro", "business"] as FlipdeskPlan[]) {
    const limit = getLimit(matrix[plan], kind);
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
// PLAN_MATRIX here is the compiled fallback (DB is canonical at runtime). The
// AI-quota drift test (ai-quota_test.ts) pins AI_ACTION_LIMITS against it.
export const __testing = {
  PLAN_MATRIX: FALLBACK_MATRIX,
  PLAN_RANK,
  requiredPlanForFeature,
  requiredPlanForCapacity,
  getLimit,
  readCurrentUsage,
  SOFT_WARN_PCT,
};
