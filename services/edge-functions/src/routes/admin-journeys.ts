// US-929: lifecycle email-journey admin console (view + enable, per-step metrics).
//
// Mounted at /api/admin/journeys, inheriting authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts. Reads/writes the
// service-role-only journey tables. Enabling a journey starts autonomous sends,
// so the enable/disable toggle is super_admin + fresh MFA step-up + audited.
//
//   GET  /                 — every journey with its steps, per-step send/skip
//                            metrics, and the enrollment roll-up + master
//                            kill-switch state.
//   PATCH /:id  { enabled } — flip a single journey on/off.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { captureException } from "../lib/observability.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminJourneyRoutes = new Hono<AdminEnv>();

interface StepMetrics {
  step_order: number;
  offset_days: number;
  subject: string;
  cta_label: string | null;
  cta_url: string | null;
  ai_personalize: boolean;
  enabled: boolean;
  sent: number;
  skipped: number;
}

async function countStepSends(
  journeyId: string,
  stepOrder: number,
  sent: boolean,
): Promise<number> {
  let q = supabaseAdmin
    .from("email_journey_step_sends")
    .select("id", { count: "exact", head: true })
    .eq("journey_id", journeyId)
    .eq("step_order", stepOrder);
  q = sent ? q.not("sent_at", "is", null) : q.is("sent_at", null);
  const { count, error } = await q;
  if (error) {
    captureException(error, { tags: { area: "admin-journeys" } });
    return 0;
  }
  return count ?? 0;
}

async function enrollmentRollup(
  journeyId: string,
): Promise<{ active: number; completed: number; exited: number; total: number }> {
  const base = () =>
    supabaseAdmin
      .from("email_journey_enrollments")
      .select("id", { count: "exact", head: true })
      .eq("journey_id", journeyId);
  const [total, completed, exited] = await Promise.all([
    base(),
    base().not("completed_at", "is", null),
    base().not("exited_at", "is", null),
  ]);
  const totalN = total.count ?? 0;
  const completedN = completed.count ?? 0;
  const exitedN = exited.count ?? 0;
  return {
    total: totalN,
    completed: completedN,
    exited: exitedN,
    active: Math.max(0, totalN - completedN - exitedN),
  };
}

// GET /api/admin/journeys
adminJourneyRoutes.get("/", async (c) => {
  const { data: journeyRows, error } = await supabaseAdmin
    .from("email_journeys")
    .select("id, journey_key, name, description, trigger, email_class, trigger_window_days, enabled, created_at, updated_at")
    .order("created_at", { ascending: true });
  if (error) {
    captureException(error, { tags: { area: "admin-journeys" } });
    return c.json({ error: "Failed to load journeys" }, 500);
  }

  const journeys = await Promise.all(
    ((journeyRows ?? []) as Array<Record<string, unknown>>).map(async (j) => {
      const journeyId = String(j.id);
      const { data: stepRows } = await supabaseAdmin
        .from("email_journey_steps")
        .select("step_order, offset_days, subject, cta_label, cta_url, ai_personalize, enabled")
        .eq("journey_id", journeyId)
        .order("step_order", { ascending: true });

      const steps: StepMetrics[] = await Promise.all(
        ((stepRows ?? []) as Array<Record<string, unknown>>).map(async (s) => {
          const stepOrder = Number(s.step_order);
          const [sent, skipped] = await Promise.all([
            countStepSends(journeyId, stepOrder, true),
            countStepSends(journeyId, stepOrder, false),
          ]);
          return {
            step_order: stepOrder,
            offset_days: Number(s.offset_days),
            subject: String(s.subject ?? ""),
            cta_label: (s.cta_label as string | null) ?? null,
            cta_url: (s.cta_url as string | null) ?? null,
            ai_personalize: s.ai_personalize === true,
            enabled: s.enabled !== false,
            sent,
            skipped,
          };
        }),
      );

      const enrollments = await enrollmentRollup(journeyId);

      return {
        id: journeyId,
        journey_key: String(j.journey_key),
        name: String(j.name),
        description: String(j.description ?? ""),
        trigger: String(j.trigger),
        email_class: String(j.email_class),
        trigger_window_days: Number(j.trigger_window_days),
        enabled: j.enabled === true,
        steps,
        enrollments,
      };
    }),
  );

  const killSwitchEnabled = await isFeatureEnabled("lifecycle_journeys");

  return c.json({ journeys, killSwitchEnabled });
});

// PATCH /api/admin/journeys/:id  { enabled: boolean }
// Enabling starts autonomous lifecycle sends → super_admin + fresh MFA step-up.
adminJourneyRoutes.patch("/:id", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "Body must include a boolean `enabled`" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("email_journeys")
    .update({ enabled: body.enabled })
    .eq("id", id)
    .select("id, journey_key, enabled")
    .maybeSingle();
  if (error) {
    captureException(error, { tags: { area: "admin-journeys" } });
    return c.json({ error: "Failed to update journey" }, 500);
  }
  if (!data) {
    return c.json({ error: "Journey not found" }, 404);
  }

  const updated = data as { id: string; journey_key: string; enabled: boolean };
  await writeAuditLog(c, {
    action: "journey.enable.update",
    targetType: "email_journey",
    targetId: updated.id,
    after: { journey_key: updated.journey_key, enabled: updated.enabled },
  });

  return c.json({ ok: true, journey: updated });
});
