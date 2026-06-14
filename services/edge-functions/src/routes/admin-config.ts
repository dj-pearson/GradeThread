// US-885: platform pricing config — unified admin surface.
//
// Mounted at /api/admin/config (inherits auth + adminAuthMiddleware incl. the
// AAL2/MFA gate from the /api/admin/* group in main.ts). Gives operators one
// place to edit BOTH:
//   • plan entitlements (caps / included grades / feature gates / Stripe price IDs)
//     — GET/PUT /config/plans[...] — backed by the pricing_plans table (US-587).
//     The existing adminPricingRoutes handler is reused verbatim (no duplicate
//     table, no duplicate validation) and simply re-exposed under /config.
//   • per-grading-tier prices + credit-pack prices — GET/PUT /config/pricing —
//     backed by the new pricing_config table (this story).
//
// Stripe stays the source of truth for the actual charge amount: the grading-tier
// and credit-pack rows store the DISPLAY price + the included/credit math, plus
// the NAME of the env var that carries the live Stripe price id — never the price
// id itself, which is read-only here and cannot be overwritten via this API.
//
// Mutations are super_admin + a fresh MFA step-up + audited (admin_audit_log) —
// pricing changes move money, gated like coupon/refund actions.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { clearPricingConfigCache } from "../lib/pricing-config.ts";
import { adminPricingRoutes } from "./admin-pricing.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminConfigRoutes = new Hono<AdminEnv>();

// ── /config/plans[...] — reuse the audited pricing_plans editor (US-587) ──
// Re-mounting the same router exposes GET /config/plans + PUT /config/plans/:key
// with identical validation, step-up, audit, and cache-bust behavior — a single
// source of truth for plan config, just a second path that matches the AC's
// /api/admin/config/plans naming.
adminConfigRoutes.route("/", adminPricingRoutes);

// ── pricing_config (grade tiers + credit packs) ──────────────────────

const PRICING_SELECT =
  "id, kind, sort_order, label, price_cents, tier_key, credit_cost, sla_hours, " +
  "credits, stripe_price_ref, updated_at, updated_by";

// ── GET /config/pricing ───────────────────────────────────────────────
// Grade-tier + credit-pack rows, grouped by kind for the editor.
adminConfigRoutes.get("/pricing", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("pricing_config")
    .select(PRICING_SELECT)
    .order("kind", { ascending: true })
    .order("sort_order", { ascending: true });
  if (error) return jsonError(c, 500, "Failed to load pricing config");

  const rows = (data ?? []) as unknown as Array<{ kind: string }>;
  return c.json({
    grade_tiers: rows.filter((r) => r.kind === "grade_tier"),
    credit_packs: rows.filter((r) => r.kind === "credit_pack"),
  });
});

// ── Validation ────────────────────────────────────────────────────────

function intField(
  v: unknown,
  min: number,
  max = 100_000_000,
): { ok: true; value: number } | { ok: false } {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return { ok: false };
  return { ok: true, value: n };
}

interface PricingConfigRowShape {
  kind: "grade_tier" | "credit_pack";
}

// Validate an edit against the row's kind. Grade tiers expose price/credit-cost/
// SLA; credit packs expose credits/price. stripe_price_ref + tier_key + kind are
// NEVER editable here (Stripe is the source of truth; identity is fixed).
export function validatePricingBody(
  kind: "grade_tier" | "credit_pack",
  body: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const update: Record<string, unknown> = {};

  if (body.label !== undefined) {
    if (typeof body.label !== "string" || !body.label.trim()) {
      return { ok: false, error: "label must be a non-empty string" };
    }
    update.label = body.label.trim().slice(0, 80);
  }

  if (body.price_cents !== undefined) {
    const r = intField(body.price_cents, 0);
    if (!r.ok) return { ok: false, error: "price_cents must be an integer ≥ 0" };
    update.price_cents = r.value;
  }

  if (body.sort_order !== undefined) {
    const r = intField(body.sort_order, 0);
    if (!r.ok) return { ok: false, error: "sort_order must be an integer ≥ 0" };
    update.sort_order = r.value;
  }

  if (kind === "grade_tier") {
    if (body.credit_cost !== undefined) {
      const r = intField(body.credit_cost, 0);
      if (!r.ok) return { ok: false, error: "credit_cost must be an integer ≥ 0" };
      update.credit_cost = r.value;
    }
    if (body.sla_hours !== undefined) {
      const r = intField(body.sla_hours, 0);
      if (!r.ok) return { ok: false, error: "sla_hours must be an integer ≥ 0" };
      update.sla_hours = r.value;
    }
  } else {
    if (body.credits !== undefined) {
      const r = intField(body.credits, 1);
      if (!r.ok) return { ok: false, error: "credits must be an integer ≥ 1" };
      update.credits = r.value;
    }
  }

  if (Object.keys(update).length === 0) {
    return { ok: false, error: "No editable fields provided" };
  }
  return { ok: true, value: update };
}

// ── PUT /config/pricing/:id ───────────────────────────────────────────
// Update one grade-tier / credit-pack row. super_admin + MFA step-up; audited.
adminConfigRoutes.put("/pricing/:id", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super admin required to edit pricing." }, 403);
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const { data: before } = await supabaseAdmin
    .from("pricing_config")
    .select(PRICING_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (!before) return jsonError(c, 404, "Pricing row not found");
  const kind = (before as unknown as PricingConfigRowShape).kind;

  const valid = validatePricingBody(kind, body);
  if (!valid.ok) return jsonError(c, 400, valid.error);

  const userId = c.get("userId");
  const { data: after, error } = await supabaseAdmin
    .from("pricing_config")
    .update({ ...valid.value, updated_by: userId })
    .eq("id", id)
    .select(PRICING_SELECT)
    .maybeSingle();
  if (error) return jsonError(c, 500, "Failed to update pricing row");

  // Instant on this replica; other replicas pick it up within the cache TTL.
  clearPricingConfigCache();

  await writeAuditLog(c, {
    action: "pricing_config.update",
    targetType: "pricing_config",
    targetId: id,
    before,
    after,
  });

  return c.json({ ok: true, row: after });
});
