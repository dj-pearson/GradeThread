// US-1827: portfolio value-alert cron.
//
// For each Connoisseur buyer (full-analytics tier), recompute their portfolio
// valuations and fire at most one value-peak / significant-move alert per item
// via the US-1803 notification infra (notifyBuyer honors the buyer's cadence caps
// + quiet hours + a per-(item,value) dedupe). Peak + last-alerted value are
// persisted so a slow drift alerts once, not every run. Simple single-scan cron
// (job-secret + job-lock; auto-recorded by the /api/jobs/* middleware).

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { getSetting } from "../lib/system-settings.ts";
import { recomputeUserPortfolio } from "../lib/portfolio-valuation-db.ts";
import {
  DEFAULT_PORTFOLIO_ALERTS_CONFIG,
  detectValuationAlert,
  normalizePortfolioAlertConfig,
  PORTFOLIO_ALERTS_SETTING_KEY,
} from "../lib/portfolio-alerts.ts";
import { notifyBuyer } from "../lib/buyer-notify.ts";

const MAX_BUYERS = 500;

const usd = (c: number) => `$${Math.round(c / 100).toLocaleString()}`;

export async function handlePortfolioAlertsCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) return c.json({ error: "Unauthorized" }, 401);
  const lock = await acquireJobLock("portfolio-alerts", 300);
  if (!lock.acquired) return c.json({ ok: true, skipped: true, reason: lock.reason });

  try {
    const config = normalizePortfolioAlertConfig(
      await getSetting<unknown>(PORTFOLIO_ALERTS_SETTING_KEY, DEFAULT_PORTFOLIO_ALERTS_CONFIG),
    );

    // Full portfolio analytics + alerts are a Connoisseur-tier benefit.
    const { data: buyers } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("buyer_plan", "connoisseur")
      .in("buyer_subscription_status", ["active", "trialing"])
      .limit(MAX_BUYERS);

    let alertsSent = 0;
    let buyersProcessed = 0;

    for (const b of buyers ?? []) {
      const userId = (b as { id: string }).id;
      try {
        // Fresh estimates (upsert leaves peak/last_alert columns untouched).
        const fresh = await recomputeUserPortfolio(userId);
        if (fresh.length === 0) continue;
        buyersProcessed++;

        // Existing alert state + item labels.
        const [{ data: stateRows }, { data: itemRows }] = await Promise.all([
          supabaseAdmin
            .from("closet_item_valuations")
            .select("closet_item_id, peak_estimate_cents, last_alert_estimate_cents")
            .eq("user_id", userId),
          supabaseAdmin.from("closet_items").select("id, brand, title").eq("user_id", userId),
        ]);
        const stateById = new Map(
          (stateRows ?? []).map((r) => {
            const s = r as { closet_item_id: string; peak_estimate_cents: number | null; last_alert_estimate_cents: number | null };
            return [s.closet_item_id, s];
          }),
        );
        const labelById = new Map(
          (itemRows ?? []).map((r) => {
            const it = r as { id: string; brand: string | null; title: string | null };
            return [it.id, [it.brand, it.title].filter(Boolean).join(" ") || "an item"];
          }),
        );

        for (const row of fresh) {
          const state = stateById.get(row.closet_item_id);
          const verdict = detectValuationAlert(
            {
              estimateCents: row.estimate_cents,
              confidence: row.confidence as "high" | "medium" | "low" | "none",
              peakEstimateCents: state?.peak_estimate_cents ?? null,
              lastAlertEstimateCents: state?.last_alert_estimate_cents ?? null,
            },
            config,
          );

          const update: Record<string, unknown> = { peak_estimate_cents: verdict.newPeakCents };

          if (verdict.kind && row.estimate_cents != null) {
            const label = labelById.get(row.closet_item_id) ?? "an item";
            const title = verdict.kind === "peak"
              ? "New high in your closet"
              : verdict.kind === "rise"
              ? "An item gained value"
              : "An item dropped in value";
            const body = verdict.kind === "peak"
              ? `${label} just hit a new estimated high of ${usd(row.estimate_cents)}.`
              : `${label} is now worth about ${usd(row.estimate_cents)}${
                verdict.changePct != null ? ` (${verdict.changePct > 0 ? "+" : ""}${Math.round(verdict.changePct)}%)` : ""
              }.`;
            const bucket = Math.round(row.estimate_cents / 500); // dedupe within ~$5 bands
            const delivered = await notifyBuyer(userId, {
              category: "portfolio",
              title,
              body,
              link: "/buyer/portfolio",
              dedupeKey: `portfolio-${verdict.kind}-${row.closet_item_id}-${bucket}`,
            }).catch(() => false);
            if (delivered) alertsSent++;
            update.last_alert_estimate_cents = row.estimate_cents;
            update.last_alerted_at = new Date().toISOString();
          }

          await supabaseAdmin
            .from("closet_item_valuations")
            .update(update as never)
            .eq("closet_item_id", row.closet_item_id);
        }
      } catch (err) {
        console.error(`[portfolio-alerts] buyer ${userId} failed:`, err instanceof Error ? err.message : err);
      }
    }

    return c.json({ ok: true, buyersProcessed, alertsSent });
  } catch (err) {
    console.error("[portfolio-alerts] cron failed:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "Portfolio-alerts job failed." }, 500);
  }
}
