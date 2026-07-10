// US-1822: admin ops dashboard for the buyer guarantee claims pool.
//
// Mounted at /api/admin/guarantee-pool — inherits authMiddleware +
// adminAuthMiddleware from main.ts (/api/admin/*). Read-only exposure / loss
// ratio / claim volume + outcomes. Cap/term edits happen through the existing
// system_settings editor (/admin/ops/settings, key buyer.guarantee_pool +
// buyer.guarantee_remedy), so this surface stays a dashboard, not a form.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  computePoolPeriodStats,
  getGuaranteePoolConfig,
  periodKey,
  type PoolLedgerEntry,
  recordPoolDrawdown,
} from "../lib/guarantee-pool.ts";
import { getSetting } from "../lib/system-settings.ts";
import {
  BUYER_GUARANTEE_REMEDY_SETTING_KEY,
  DEFAULT_BUYER_GUARANTEE_REMEDY_CONFIG,
  normalizeBuyerGuaranteeRemedyConfig,
} from "../lib/buyer-guarantee-claim.ts";
import { emitReputationEvent, recomputeTrustScore } from "../lib/buyer-trust-score.ts";
import { notifyBuyer } from "../lib/buyer-notify.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireScope } from "../lib/scope-guard.ts";

type AdminEnv = { Variables: { userId: string } };

export const adminGuaranteePoolRoutes = new Hono<AdminEnv>();

const RECENT_PERIODS = 6;

adminGuaranteePoolRoutes.get("/", async (c) => {
  const config = await getGuaranteePoolConfig();

  const { data: ledger, error } = await supabaseAdmin
    .from("guarantee_pool_ledger")
    .select("entry_type, amount_cents, period")
    .order("period", { ascending: false })
    .limit(5000);
  if (error) {
    console.error("[admin-guarantee-pool] ledger load failed:", error.message);
    return c.json({ error: "Failed to load the pool ledger." }, 500);
  }
  const entries = (ledger ?? []) as PoolLedgerEntry[];

  // Distinct periods present, newest first, capped — plus always the current one
  // so an empty current period still shows.
  const periods = [...new Set([periodKey(Date.now()), ...entries.map((e) => e.period)])]
    .sort()
    .reverse()
    .slice(0, RECENT_PERIODS);
  const stats = periods.map((p) => computePoolPeriodStats(entries, p));

  // Claim outcome mix (all-time counts by status).
  const { data: claims } = await supabaseAdmin
    .from("buyer_guarantee_claims")
    .select("status");
  const outcomes: Record<string, number> = {};
  for (const r of claims ?? []) {
    const s = (r as { status: string }).status;
    outcomes[s] = (outcomes[s] ?? 0) + 1;
  }

  const current = stats[0] ?? null;
  const throttled = current?.lossRatio != null && current.lossRatio > config.loss_ratio_throttle;

  // Manual-review queue (US-1821 downgrades + US-1823 fraud-flagged).
  const { data: pending } = await supabaseAdmin
    .from("buyer_guarantee_claims")
    .select("id, user_id, purchase_id, remedy_cents, grade_delta, decision_reason, fraud_flags, fraud_score, created_at")
    .eq("status", "manual_review")
    .order("created_at", { ascending: true })
    .limit(100);

  return c.json({
    config,
    periods: stats,
    outcomes,
    throttled,
    pendingClaims: pending ?? [],
  });
});

// Resolve a manual-review buyer guarantee claim. approve → pay the remedy;
// reject → close; reject_fraud → close + reputation penalty + REVOKE coverage.
adminGuaranteePoolRoutes.post("/claims/:id/resolve", requireScope("billing:write"), async (c) => {
  const adminId = c.get("userId");
  const claimId = c.req.param("id");
  let body: { action?: string; note?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const action = body.action;
  if (action !== "approve" && action !== "reject" && action !== "reject_fraud") {
    return c.json({ error: "action must be approve | reject | reject_fraud." }, 400);
  }

  const { data: claim } = await supabaseAdmin
    .from("buyer_guarantee_claims")
    .select("id, user_id, remedy_cents, status")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) return c.json({ error: "Claim not found." }, 404);
  const cl = claim as { id: string; user_id: string; remedy_cents: number; status: string };
  if (cl.status !== "manual_review") {
    return c.json({ error: `Claim is already ${cl.status}.` }, 409);
  }

  const now = new Date().toISOString();
  const base = { resolved_by: adminId, resolved_at: now, resolution_note: body.note?.trim() || null };

  if (action === "approve") {
    const remedyConfig = normalizeBuyerGuaranteeRemedyConfig(
      await getSetting<unknown>(BUYER_GUARANTEE_REMEDY_SETTING_KEY, DEFAULT_BUYER_GUARANTEE_REMEDY_CONFIG),
    );
    const credits = Math.floor(cl.remedy_cents / remedyConfig.cents_per_credit);
    await recordPoolDrawdown(cl.id, cl.user_id, cl.remedy_cents, periodKey(Date.now()));
    if (credits > 0) {
      await supabaseAdmin.rpc("grant_buyer_reward_credit", {
        p_user_id: cl.user_id,
        p_reference_id: `guarantee:${cl.id}`,
        p_credits: credits,
        p_reason: "guarantee_remedy",
      });
    }
    await supabaseAdmin
      .from("buyer_guarantee_claims")
      .update({ status: "approved", auto: false, remedy_credits: credits, ...base } as never)
      .eq("id", cl.id);
    await notifyBuyer(cl.user_id, {
      category: "guarantee",
      title: "Guarantee claim approved",
      body: `Your Grade-Locked claim was approved for $${(cl.remedy_cents / 100).toFixed(2)}.`,
      link: "/buyer/rewards",
      dedupeKey: `guarantee-resolve:${cl.id}`,
    }).catch(() => {});
  } else {
    // reject / reject_fraud
    await supabaseAdmin
      .from("buyer_guarantee_claims")
      .update({ status: "rejected", ...base } as never)
      .eq("id", cl.id);

    if (action === "reject_fraud") {
      // Reputation penalty (US-1816) + coverage revoke (US-1823).
      try {
        await emitReputationEvent(cl.user_id, {
          eventType: "dispute_overturned",
          verified: true,
          source: "guarantee_fraud",
          referenceId: `fraud:${cl.id}`,
        });
        await recomputeTrustScore(cl.user_id);
      } catch (err) {
        console.error("[admin-guarantee-pool] penalty failed:", err instanceof Error ? err.message : err);
      }
      await supabaseAdmin
        .from("users")
        .update({ buyer_coverage_revoked_at: now } as never)
        .eq("id", cl.user_id);
    }
    await notifyBuyer(cl.user_id, {
      category: "guarantee",
      title: "Guarantee claim closed",
      body: "We've reviewed your Grade-Locked claim. See your purchase for details.",
      link: "/buyer/rewards",
      dedupeKey: `guarantee-resolve:${cl.id}`,
    }).catch(() => {});
  }

  await writeAuditLog(c, {
    action: `buyer_guarantee_claim_${action}`,
    targetType: "buyer_guarantee_claim",
    targetId: cl.id,
    details: { buyer_user_id: cl.user_id, remedy_cents: cl.remedy_cents },
  }).catch(() => {});

  return c.json({ ok: true, status: action === "approve" ? "approved" : "rejected" });
});
