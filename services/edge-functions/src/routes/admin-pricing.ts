// US-587: admin plan pricing + limits management.
//
// Mounted at /api/admin/pricing — the /api/admin/* middleware (auth +
// adminAuthMiddleware, incl. the AAL2/MFA gate) already protects it. Lets a
// super-admin edit FlipDesk plan prices, limits, feature gates, and Stripe price
// IDs WITHOUT a redeploy; the edge picks up the change within the pricing-config
// cache TTL (clearPricingConfigCache makes it instant on the replica that handled
// the edit). Every edit is validated + audited (admin_audit_log).
//
// Mutations require super_admin + a fresh MFA step-up — pricing changes move
// money, so they're gated like coupon/refund actions (US-399).
//
// Documented SQL fallback (if the UI is unavailable):
//   update public.pricing_plans set price_monthly_cents = 3900 where key = 'starter';

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { clearPricingConfigCache, GATE_FLAG_KEYS } from "../lib/pricing-config.ts";
import { requireScope } from "../lib/scope-guard.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminPricingRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminPricingRoutes.use("*", requireScope("ops:write"));

const PLAN_KEYS = new Set(["free", "starter", "pro", "business"]);

const SELECT_COLS =
  "key, name, sort_order, price_monthly_cents, price_yearly_cents, " +
  "active_listing_cap, ai_actions_per_month, marketplaces_cap, " +
  "included_standard_grades_per_month, team_seat_cap, features, gate_flags, " +
  "stripe_price_monthly, stripe_price_yearly, updated_at, updated_by";

// ── GET /plans ────────────────────────────────────────────────────
// Full config (incl. Stripe price IDs) for the admin editor.
adminPricingRoutes.get("/plans", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("pricing_plans")
    .select(SELECT_COLS)
    .order("sort_order");
  if (error) return jsonError(c, 500, "Failed to load pricing plans");
  return c.json({ plans: data ?? [] });
});

// ── Validation ────────────────────────────────────────────────────

// An integer in [min, max]. min defaults to 0; pass -1 for caps that allow the
// "unlimited" sentinel.
function intField(
  v: unknown,
  min: number,
  max = 100_000_000,
): { ok: true; value: number } | { ok: false } {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return { ok: false };
  return { ok: true, value: n };
}

interface ValidatedUpdate {
  update: Record<string, unknown>;
}

export function validateBody(
  body: Record<string, unknown>,
): { ok: true; value: ValidatedUpdate } | { ok: false; error: string } {
  const update: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return { ok: false, error: "name must be a non-empty string" };
    }
    update.name = body.name.trim().slice(0, 80);
  }

  // (field, min) — caps that allow -1 (unlimited/all) use min = -1.
  const numeric: [string, number][] = [
    ["sort_order", 0],
    ["price_monthly_cents", 0],
    ["price_yearly_cents", 0],
    ["active_listing_cap", -1],
    ["ai_actions_per_month", -1],
    ["marketplaces_cap", -1],
    ["included_standard_grades_per_month", 0],
    ["team_seat_cap", 0],
  ];
  for (const [field, min] of numeric) {
    if (body[field] === undefined) continue;
    const res = intField(body[field], min);
    if (!res.ok) {
      return { ok: false, error: `${field} must be an integer ≥ ${min}` };
    }
    update[field] = res.value;
  }

  if (body.features !== undefined) {
    if (
      !Array.isArray(body.features) ||
      !body.features.every((f) => typeof f === "string")
    ) {
      return { ok: false, error: "features must be an array of strings" };
    }
    update.features = (body.features as string[]).map((f) => f.slice(0, 120)).slice(0, 20);
  }

  if (body.gate_flags !== undefined) {
    const gf = body.gate_flags;
    if (typeof gf !== "object" || gf === null || Array.isArray(gf)) {
      return { ok: false, error: "gate_flags must be an object" };
    }
    const flags: Record<string, boolean> = {};
    const src = gf as Record<string, unknown>;
    for (const k of GATE_FLAG_KEYS) {
      if (typeof src[k] !== "boolean") {
        return { ok: false, error: `gate_flags.${k} must be a boolean` };
      }
      flags[k] = src[k] as boolean;
    }
    update.gate_flags = flags;
  }

  for (const field of ["stripe_price_monthly", "stripe_price_yearly"] as const) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "string") {
      return { ok: false, error: `${field} must be a string` };
    }
    update[field] = (body[field] as string).trim().slice(0, 255);
  }

  if (Object.keys(update).length === 0) {
    return { ok: false, error: "No editable fields provided" };
  }
  return { ok: true, value: { update } };
}

// ── PUT /plans/:key ───────────────────────────────────────────────
// Body: any subset of editable fields. super_admin + MFA step-up; audited.
adminPricingRoutes.put("/plans/:key", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super admin required to edit pricing." }, 403);
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const key = c.req.param("key");
  if (!PLAN_KEYS.has(key)) {
    return jsonError(c, 400, `Unknown plan key. Known: ${[...PLAN_KEYS].join(", ")}`);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const valid = validateBody(body);
  if (!valid.ok) return jsonError(c, 400, valid.error);

  // Snapshot the prior row for the audit before/after.
  const { data: before } = await supabaseAdmin
    .from("pricing_plans")
    .select(SELECT_COLS)
    .eq("key", key)
    .maybeSingle();
  if (!before) return jsonError(c, 404, "Plan not found");

  const userId = c.get("userId");
  const { data: after, error } = await supabaseAdmin
    .from("pricing_plans")
    .update({ ...valid.value.update, updated_by: userId })
    .eq("key", key)
    .select(SELECT_COLS)
    .maybeSingle();
  if (error) return jsonError(c, 500, "Failed to update plan");

  // Instant on this replica; others within the cache TTL.
  clearPricingConfigCache();

  await writeAuditLog(c, {
    action: "pricing_plan.update",
    targetType: "pricing_plan",
    targetId: key,
    before,
    after,
  });

  return c.json({ ok: true, plan: after });
});
