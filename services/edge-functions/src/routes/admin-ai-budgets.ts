// US-895: AI cost budget guardrails — admin management.
//
// Mounted at /api/admin/ai-budgets, inheriting authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts.
//
//   • GET  /                       — list budgets (with current spend via the
//                                    ai_budget_status RPC) + recent breaches.
//                                    Admin-level (read-only).
//   • POST /                       — create a budget. super_admin + MFA step-up +
//                                    audited (a budget can auto-kill a feature, so
//                                    it's gated like other guardrail config).
//   • PUT  /:id                    — edit a budget. super_admin + step-up + audited.
//   • DELETE /:id                  — delete a budget. super_admin + step-up + audited.
//   • POST /breaches/:id/resolve   — one-click re-enable after investigation:
//                                    flips the killed feature flag back ON and
//                                    resolves the breach. super_admin + step-up +
//                                    audited.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { clearFeatureFlagCache } from "../lib/feature-flags.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminAiBudgetsRoutes = new Hono<AdminEnv>();

const VALID_PERIODS = new Set(["day", "month"]);
const VALID_ACTIONS = new Set(["alert", "throttle", "kill"]);
const MAX_FEATURE_LEN = 64;
// A sane ceiling so a typo'd limit can't be absurd; budgets are small dollar caps.
const MAX_LIMIT_USD = 1_000_000;

interface ValidatedBudget {
  feature: string;
  period: string;
  limit_usd: number;
  action: string;
  enabled: boolean;
}

// Validate a create/replace body. `partial` permits PUT to omit unchanged fields.
function validateBudget(
  body: Record<string, unknown>,
  partial: boolean,
): { ok: true; value: Partial<ValidatedBudget> } | { ok: false; error: string } {
  const out: Partial<ValidatedBudget> = {};

  if (body.feature !== undefined || !partial) {
    const f = typeof body.feature === "string" ? body.feature.trim() : "";
    if (!f || f.length > MAX_FEATURE_LEN) {
      return { ok: false, error: `feature must be 1–${MAX_FEATURE_LEN} chars` };
    }
    out.feature = f;
  }
  if (body.period !== undefined || !partial) {
    if (typeof body.period !== "string" || !VALID_PERIODS.has(body.period)) {
      return { ok: false, error: "period must be 'day' or 'month'" };
    }
    out.period = body.period;
  }
  if (body.limitUsd !== undefined || !partial) {
    const n = typeof body.limitUsd === "number" ? body.limitUsd : Number(body.limitUsd);
    if (!Number.isFinite(n) || n < 0 || n > MAX_LIMIT_USD) {
      return { ok: false, error: `limitUsd must be a number between 0 and ${MAX_LIMIT_USD}` };
    }
    out.limit_usd = Math.round(n * 100) / 100;
  }
  if (body.action !== undefined || !partial) {
    if (typeof body.action !== "string" || !VALID_ACTIONS.has(body.action)) {
      return { ok: false, error: "action must be 'alert', 'throttle' or 'kill'" };
    }
    out.action = body.action;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return { ok: false, error: "enabled must be a boolean" };
    }
    out.enabled = body.enabled;
  } else if (!partial) {
    out.enabled = true;
  }

  return { ok: true, value: out };
}

const BUDGET_SELECT =
  "id, feature, period, limit_usd, action, enabled, created_at, updated_at, updated_by";

// ── GET / — budgets + current spend + recent breaches ──
adminAiBudgetsRoutes.get("/", async (c) => {
  const { data: status, error: statusErr } = await supabaseAdmin.rpc("ai_budget_status");
  if (statusErr) {
    console.error("[admin-ai-budgets] ai_budget_status failed:", statusErr.message);
    return jsonError(c, 500, "Failed to load AI budgets");
  }

  const { data: breaches, error: breachErr } = await supabaseAdmin
    .from("ai_budget_breaches")
    .select(
      "id, budget_id, feature, period, action, limit_usd, spend_usd, killed, flag_key, alerted, status, created_at, resolved_at",
    )
    .order("created_at", { ascending: false })
    .limit(50);
  if (breachErr) {
    console.error("[admin-ai-budgets] breaches load failed:", breachErr.message);
    return jsonError(c, 500, "Failed to load budget breaches");
  }

  return c.json({ budgets: status ?? [], breaches: breaches ?? [] });
});

// ── POST / — create a budget (super_admin + step-up + audit) ──
adminAiBudgetsRoutes.post("/", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, "Super admin required to create budgets.");
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const valid = validateBudget(body, false);
  if (!valid.ok) return jsonError(c, 400, valid.error);

  const userId = c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("ai_budgets")
    .insert({ ...valid.value, updated_by: userId })
    .select(BUDGET_SELECT)
    .maybeSingle();
  if (error) {
    // Unique (feature, period) violation.
    if (error.code === "23505") {
      return jsonError(c, 409, "A budget already exists for this feature + period. Edit it instead.");
    }
    console.error("[admin-ai-budgets] insert failed:", error.message);
    return jsonError(c, 500, "Failed to create budget");
  }

  await writeAuditLog(c, {
    action: "ai_budget.create",
    targetType: "ai_budget",
    targetId: (data as { id: string }).id,
    after: data,
  });

  return c.json({ ok: true, budget: data });
});

// ── PUT /:id — edit a budget (super_admin + step-up + audit) ──
adminAiBudgetsRoutes.put("/:id", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, "Super admin required to edit budgets.");
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
  const valid = validateBudget(body, true);
  if (!valid.ok) return jsonError(c, 400, valid.error);
  if (Object.keys(valid.value).length === 0) {
    return jsonError(c, 400, "No editable fields provided");
  }

  const { data: before } = await supabaseAdmin
    .from("ai_budgets")
    .select(BUDGET_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (!before) return jsonError(c, 404, "Budget not found");

  const userId = c.get("userId");
  const { data: after, error } = await supabaseAdmin
    .from("ai_budgets")
    .update({ ...valid.value, updated_by: userId })
    .eq("id", id)
    .select(BUDGET_SELECT)
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      return jsonError(c, 409, "A budget already exists for this feature + period.");
    }
    console.error("[admin-ai-budgets] update failed:", error.message);
    return jsonError(c, 500, "Failed to update budget");
  }

  await writeAuditLog(c, {
    action: "ai_budget.update",
    targetType: "ai_budget",
    targetId: id,
    before,
    after,
  });

  return c.json({ ok: true, budget: after });
});

// ── DELETE /:id — delete a budget (super_admin + step-up + audit) ──
adminAiBudgetsRoutes.delete("/:id", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, "Super admin required to delete budgets.");
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  const { data: before } = await supabaseAdmin
    .from("ai_budgets")
    .select(BUDGET_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (!before) return jsonError(c, 404, "Budget not found");

  const { error } = await supabaseAdmin.from("ai_budgets").delete().eq("id", id);
  if (error) {
    console.error("[admin-ai-budgets] delete failed:", error.message);
    return jsonError(c, 500, "Failed to delete budget");
  }

  await writeAuditLog(c, {
    action: "ai_budget.delete",
    targetType: "ai_budget",
    targetId: id,
    before,
  });

  return c.json({ ok: true });
});

// ── POST /breaches/:id/resolve — re-enable after investigation ──
// Flips a killed feature flag back ON and resolves the breach. super_admin +
// step-up + audited (re-enabling a feature the guardrail killed is a deliberate,
// privileged decision).
adminAiBudgetsRoutes.post("/breaches/:id/resolve", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, "Super admin required to re-enable a feature.");
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  const { data: breach } = await supabaseAdmin
    .from("ai_budget_breaches")
    .select("id, feature, killed, flag_key, status")
    .eq("id", id)
    .maybeSingle();
  if (!breach) return jsonError(c, 404, "Breach not found");
  const b = breach as {
    id: string;
    feature: string;
    killed: boolean;
    flag_key: string | null;
    status: string;
  };
  if (b.status === "resolved") {
    return jsonError(c, 409, "This breach is already resolved.");
  }

  // Re-enable the feature flag that was auto-killed, if any.
  let reEnabled = false;
  if (b.killed && b.flag_key) {
    const { data: flagRow, error: flagErr } = await supabaseAdmin
      .from("feature_flags")
      .update({ enabled: true })
      .eq("key", b.flag_key)
      .select("key");
    if (flagErr) {
      console.error("[admin-ai-budgets] re-enable flag failed:", flagErr.message);
      return jsonError(c, 500, "Failed to re-enable the feature flag");
    }
    reEnabled = (flagRow?.length ?? 0) > 0;
    if (reEnabled) clearFeatureFlagCache();
  }

  const userId = c.get("userId");
  const { error: resolveErr } = await supabaseAdmin
    .from("ai_budget_breaches")
    .update({ status: "resolved", resolved_at: new Date().toISOString(), resolved_by: userId })
    .eq("id", id);
  if (resolveErr) {
    console.error("[admin-ai-budgets] resolve breach failed:", resolveErr.message);
    return jsonError(c, 500, "Failed to resolve breach");
  }

  await writeAuditLog(c, {
    action: "ai_budget.reenable",
    targetType: "ai_budget_breach",
    targetId: id,
    details: { feature: b.feature, flag_key: b.flag_key, flag_reenabled: reEnabled },
  });

  return c.json({ ok: true, flag_reenabled: reEnabled });
});
