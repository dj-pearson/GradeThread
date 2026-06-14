// US-895: scheduled AI cost budget guardrails.
//
// Evaluates every ai_budget against its current period spend (ai_budget_status
// RPC, re-priced from system_settings.ai_model_prices) and acts on fresh
// breaches: for action='kill' it flips the matching feature kill-switch off via
// the existing feature_flags mechanism, records an ai_budget_breaches row, emits
// an ops alert (webhook + email, reusing the ops alert channels), and writes a
// system audit entry. An OPEN breach suppresses re-action so this can run as
// often as every minute without re-alerting or re-killing each tick.
//
// Mounted in main.ts as POST /api/jobs/ai-budget-guardrails, OUTSIDE the /api/*
// JWT groups; the handler enforces X-Internal-Job-Secret itself (same pattern as
// the other Coolify crons). The /api/jobs/* middleware records the run in the
// cron-run ledger.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { clearFeatureFlagCache } from "../lib/feature-flags.ts";
import { writeSystemAuditLog } from "../lib/audit-log.ts";
import { sendAiBudgetAlertEmail } from "../lib/email.ts";
import { captureException, recordMetric } from "../lib/observability.ts";
import { fetchWithTimeout } from "../lib/circuit-breaker.ts";
import { emitOpsEvent } from "../lib/ops-events.ts";
import {
  type BudgetStatus,
  type RecordedBreach,
  runBudgetGuardrails,
} from "../lib/ai-budget.ts";

// Flip a feature flag off. Idempotent: only flips one that is currently ON, so a
// re-run (or a flag an operator already disabled) returns false without a write.
async function killFlag(flagKey: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("feature_flags")
    .update({ enabled: false })
    .eq("key", flagKey)
    .eq("enabled", true)
    .select("key");
  if (error) {
    console.error(`[ai-budget] kill flag ${flagKey} failed:`, error.message);
    return false;
  }
  const flipped = (data?.length ?? 0) > 0;
  if (flipped) clearFeatureFlagCache(); // instant on this replica; others within TTL
  return flipped;
}

// Emit an ops alert via webhook + email. Returns true if ≥1 channel delivered.
// Reuses the ops alert channels (MONITOR_ALERT_*) with AI-budget-specific
// overrides, so an existing ops setup just works.
async function dispatchBudgetAlert(b: RecordedBreach): Promise<boolean> {
  const to = Deno.env.get("AI_BUDGET_ALERT_EMAIL") ||
    Deno.env.get("MONITOR_ALERT_EMAIL") ||
    Deno.env.get("SMTP_ADMIN_EMAIL") || "";
  const webhook = Deno.env.get("AI_BUDGET_ALERT_WEBHOOK")?.trim() ||
    Deno.env.get("MONITOR_ALERT_WEBHOOK")?.trim() || "";

  let delivered = 0;

  if (to) {
    try {
      const ok = await sendAiBudgetAlertEmail(to, {
        feature: b.feature,
        period: b.period,
        action: b.action,
        limitUsd: b.limitUsd,
        spendUsd: b.spendUsd,
        killed: b.killed,
        flagKey: b.flagKey,
      });
      if (ok) delivered += 1;
    } catch (err) {
      captureException(err, { route: "ai-budget.alert.email", tags: { feature: b.feature } });
    }
  }

  if (webhook) {
    try {
      const summary =
        `[GradeThread AI budget] ${b.killed ? "KILLED" : "BREACH"}: feature "${b.feature}" ` +
        `(${b.period}) spent $${b.spendUsd.toFixed(2)} of $${b.limitUsd.toFixed(2)}` +
        (b.killed ? ` — flipped "${b.flagKey}" off.` : ` — action ${b.action}.`);
      const res = await fetchWithTimeout(
        webhook,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: summary, // Slack
            summary, // PagerDuty/generic
            severity: b.killed ? "critical" : "warning",
            feature: b.feature,
            killed: b.killed,
          }),
        },
        5000,
      );
      if (res.ok) delivered += 1;
      else {
        captureException(
          new Error(`ai-budget alert webhook returned ${res.status}`),
          { route: "ai-budget.alert.webhook", tags: { feature: b.feature } },
        );
      }
      await res.body?.cancel();
    } catch (err) {
      captureException(err, { route: "ai-budget.alert.webhook", tags: { feature: b.feature } });
    }
  }

  if (delivered === 0) {
    recordMetric("ai_budget.alert_undelivered", 1, { feature: b.feature });
    captureException(
      new Error(
        `ai-budget raised a breach for "${b.feature}" but NO alert channel was ` +
          `configured/reachable — set AI_BUDGET_ALERT_EMAIL/WEBHOOK or MONITOR_ALERT_*`,
      ),
      { level: "warn", route: "ai-budget.alert", tags: { feature: b.feature } },
    );
  }

  return delivered > 0;
}

export async function handleAiBudgetCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("ai-budget-guardrails", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const result = await runBudgetGuardrails({
      loadStatuses: async () => {
        const { data, error } = await supabaseAdmin.rpc("ai_budget_status");
        if (error) throw new Error(error.message);
        return (data ?? []) as BudgetStatus[];
      },
      loadOpenBreachBudgetIds: async () => {
        const { data, error } = await supabaseAdmin
          .from("ai_budget_breaches")
          .select("budget_id")
          .eq("status", "open");
        if (error) throw new Error(error.message);
        const ids = new Set<string>();
        for (const r of (data ?? []) as Array<{ budget_id: string | null }>) {
          if (r.budget_id) ids.add(r.budget_id);
        }
        return ids;
      },
      killFlag,
      alert: dispatchBudgetAlert,
      insertBreach: async (b) => {
        const { error } = await supabaseAdmin.from("ai_budget_breaches").insert({
          budget_id: b.budgetId,
          feature: b.feature,
          period: b.period,
          action: b.action,
          limit_usd: b.limitUsd,
          spend_usd: b.spendUsd,
          killed: b.killed,
          flag_key: b.flagKey,
          alerted: b.alerted,
          status: "open",
        });
        if (error) throw new Error(error.message);
      },
      audit: async (b) => {
        await writeSystemAuditLog({
          action: b.killed ? "ai_budget.auto_kill" : "ai_budget.breach",
          targetType: "ai_budget",
          targetId: b.budgetId,
          details: {
            feature: b.feature,
            period: b.period,
            action: b.action,
            limit_usd: b.limitUsd,
            spend_usd: b.spendUsd,
            killed: b.killed,
            flag_key: b.flagKey,
            alerted: b.alerted,
          },
        });
        // US-906: also surface the breach/kill on the ops activity feed. A kill
        // (feature auto-disabled to stop the bleed) is critical; a plain breach
        // is a warning. emitOpsEvent does its OWN channel fan-out, separate from
        // dispatchBudgetAlert above (which keeps the AI-budget-specific email).
        void emitOpsEvent(
          b.killed ? "ai_budget.kill" : "ai_budget.breach",
          b.killed ? "critical" : "warning",
          {
            title: b.killed
              ? `AI budget kill: "${b.feature}" disabled ($${b.spendUsd.toFixed(2)} of $${b.limitUsd.toFixed(2)})`
              : `AI budget breach: "${b.feature}" ($${b.spendUsd.toFixed(2)} of $${b.limitUsd.toFixed(2)})`,
            source: "ai-budget-guardrails",
            data: {
              feature: b.feature,
              period: b.period,
              action: b.action,
              limit_usd: b.limitUsd,
              spend_usd: b.spendUsd,
              killed: b.killed,
              flag_key: b.flagKey,
            },
          },
        );
      },
    });

    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error("[ai-budget] guardrail run failed:", err);
    return c.json(
      { error: "AI budget guardrail run failed", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  } finally {
    await lock.release();
  }
}
