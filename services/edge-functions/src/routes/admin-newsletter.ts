import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { bustSettingCache, getSetting } from "../lib/system-settings.ts";
import { captureException } from "../lib/observability.ts";
import { emitOpsEvent } from "../lib/ops-events.ts";
import { requireStepUp } from "../lib/step-up.ts";
import {
  DEFAULT_DELIVERABILITY_THRESHOLDS,
  type DeliverabilityMetrics,
  type DeliverabilityThresholds,
  evaluateDeliverability,
} from "../lib/newsletter-thresholds.ts";

// US-931: Email program analytics & deliverability dashboard (read-only) + a
// deliverability-guard enforcement action.
//
// Mounted at /api/admin/newsletter, inheriting authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts. Aggregation is done
// server-side by the `newsletter_analytics(period)` RPC (migration 00278) over
// campaign_recipients + email_suppressions + email_subscribers. Complements
// PostHog (server-side, deliverability-focused) rather than duplicating it.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminNewsletterRoutes = new Hono<AdminEnv>();

const VALID_PERIODS = new Set(["7d", "30d", "90d", "180d", "365d"]);

// Resolve the operator-tunable bounce/complaint cutoffs from the registry; the
// unsub/open warnings stay on their built-in defaults.
async function loadThresholds(): Promise<DeliverabilityThresholds> {
  const [complaintRate, bounceRate] = await Promise.all([
    getSetting<number>(
      "newsletter_complaint_rate_threshold",
      DEFAULT_DELIVERABILITY_THRESHOLDS.complaintRate,
    ),
    getSetting<number>(
      "newsletter_bounce_rate_threshold",
      DEFAULT_DELIVERABILITY_THRESHOLDS.bounceRate,
    ),
  ]);
  return {
    ...DEFAULT_DELIVERABILITY_THRESHOLDS,
    complaintRate: Number.isFinite(complaintRate)
      ? complaintRate
      : DEFAULT_DELIVERABILITY_THRESHOLDS.complaintRate,
    bounceRate: Number.isFinite(bounceRate)
      ? bounceRate
      : DEFAULT_DELIVERABILITY_THRESHOLDS.bounceRate,
  };
}

interface NewsletterProgram {
  sent: number;
  openRate: number;
  bounceRate: number;
  complaintRate: number;
  unsubRate: number;
  [k: string]: unknown;
}

interface NewsletterRollup {
  period: string;
  window: { start: string; end: string };
  program: NewsletterProgram;
  issues: unknown[];
}

function metricsOf(program: NewsletterProgram): DeliverabilityMetrics {
  return {
    sent: Number(program.sent) || 0,
    openRate: Number(program.openRate) || 0,
    bounceRate: Number(program.bounceRate) || 0,
    complaintRate: Number(program.complaintRate) || 0,
    unsubRate: Number(program.unsubRate) || 0,
  };
}

async function loadRollup(period: string): Promise<NewsletterRollup | null> {
  const { data, error } = await supabaseAdmin.rpc("newsletter_analytics", {
    p_period: period,
  });
  if (error) {
    captureException(error, { tags: { area: "admin-newsletter" } });
    return null;
  }
  return (data ?? null) as NewsletterRollup | null;
}

// GET /api/admin/newsletter/analytics?period=7d|30d|90d|180d|365d
adminNewsletterRoutes.get("/analytics", async (c) => {
  const period = c.req.query("period") ?? "30d";
  if (!VALID_PERIODS.has(period)) {
    return c.json(
      { error: `Invalid period. Use one of: ${[...VALID_PERIODS].join(", ")}` },
      400,
    );
  }

  const rollup = await loadRollup(period);
  if (!rollup) {
    return c.json({ error: "Failed to load newsletter analytics" }, 500);
  }

  const thresholds = await loadThresholds();
  const deliverability = evaluateDeliverability(metricsOf(rollup.program), thresholds);
  const sendPaused = await getSetting<boolean>("newsletter_send_paused", false);

  return c.json({
    period,
    window: rollup.window,
    analytics: rollup,
    deliverability,
    sendPaused: Boolean(sendPaused),
  });
});

// POST /api/admin/newsletter/deliverability/enforce
// The automatable deliverability guard (a future scheduled job can call it):
// recompute, and on a CRITICAL bounce/complaint breach raise an ops alert and —
// when newsletter_auto_pause_enabled is set — auto-pause sends via the
// newsletter_send_paused kill-switch. super_admin + fresh MFA step-up (it mutates
// the send kill-switch).
adminNewsletterRoutes.post("/deliverability/enforce", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  const period = c.req.query("period") ?? "30d";
  const usePeriod = VALID_PERIODS.has(period) ? period : "30d";

  const rollup = await loadRollup(usePeriod);
  if (!rollup) {
    return c.json({ error: "Failed to load newsletter analytics" }, 500);
  }

  const thresholds = await loadThresholds();
  const deliverability = evaluateDeliverability(metricsOf(rollup.program), thresholds);

  let alerted = false;
  let paused = false;

  if (deliverability.status === "critical") {
    const autoPauseEnabled = await getSetting<boolean>(
      "newsletter_auto_pause_enabled",
      false,
    );

    // Raise the ops alert (best-effort; never blocks the response).
    await emitOpsEvent("newsletter.deliverability", "critical", {
      title: "Newsletter deliverability breach — bounce/complaint over threshold",
      source: "newsletter-guard",
      actorUserId: c.get("userId"),
      data: {
        period: usePeriod,
        bounceRate: rollup.program.bounceRate,
        complaintRate: rollup.program.complaintRate,
        flags: deliverability.flags,
        autoPauseEnabled: Boolean(autoPauseEnabled),
      },
    });
    alerted = true;

    if (autoPauseEnabled) {
      const { error } = await supabaseAdmin
        .from("system_settings")
        .update({ value: true, updated_by: c.get("userId") })
        .eq("key", "newsletter_send_paused");
      if (error) {
        captureException(error, { tags: { area: "admin-newsletter.pause" } });
      } else {
        bustSettingCache("newsletter_send_paused");
        paused = true;
      }
    }
  }

  return c.json({
    period: usePeriod,
    status: deliverability.status,
    flags: deliverability.flags,
    alerted,
    paused,
  });
});
