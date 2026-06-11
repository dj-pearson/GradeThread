import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";

// Admin content moderation (US-476/477). Approving/rejecting a flagged
// submission, refunding the grade credit, and suspending an abusive user used to
// run as DIRECT browser-client writes from src/pages/admin/moderation.tsx —
// authz left to RLS and NO audit trail capturing WHICH admin acted. These move
// the writes server-side under the service-role client, gated by
// authMiddleware + adminAuthMiddleware (inherited from the /api/admin/* group in
// main.ts, which also enforces the standing AAL2 requirement), and every action
// writes an admin_audit_log row with the acting admin's identity (the DB trigger
// in 00046 logs users.suspended changes but cannot attribute them to an admin).
//
// Mounted at /api/admin/moderation.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminModerationRoutes = new Hono<AdminEnv>();

interface FlaggedSubmissionRow {
  id: string;
  user_id: string;
  flagged: boolean | null;
  moderation_status: string | null;
  status: string | null;
}

async function loadSubmission(id: string): Promise<FlaggedSubmissionRow | null> {
  const { data } = await supabaseAdmin
    .from("submissions")
    .select("id, user_id, flagged, moderation_status, status")
    .eq("id", id)
    .maybeSingle();
  return (data as FlaggedSubmissionRow | null) ?? null;
}

// Refund one monthly grade credit to a user (clamped at 0). Returns the new
// value, or null if the user wasn't found.
async function refundGradeCredit(userId: string): Promise<number | null> {
  const { data: u } = await supabaseAdmin
    .from("users")
    .select("grades_used_this_month")
    .eq("id", userId)
    .maybeSingle();
  if (!u) return null;
  const used = (u as { grades_used_this_month: number | null }).grades_used_this_month ?? 0;
  const refunded = Math.max(0, used - 1);
  const { error } = await supabaseAdmin
    .from("users")
    .update({ grades_used_this_month: refunded })
    .eq("id", userId);
  if (error) throw new Error(error.message);
  return refunded;
}

// POST /:id/approve — clear the flag, mark approved.
adminModerationRoutes.post("/:id/approve", async (c: Context<AdminEnv>) => {
  const id = c.req.param("id");
  const sub = await loadSubmission(id);
  if (!sub) return c.json({ error: "Submission not found" }, 404);

  const { error } = await supabaseAdmin
    .from("submissions")
    .update({ flagged: false, moderation_status: "approved" })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 500);

  await writeAuditLog(c, {
    action: "admin.moderation_approve",
    targetType: "submission",
    targetId: id,
    before: { flagged: sub.flagged, moderation_status: sub.moderation_status },
    after: { flagged: false, moderation_status: "approved" },
  });
  return c.json({ ok: true });
});

// POST /:id/reject — reject the submission as invalid and refund the user's
// monthly grade credit.
adminModerationRoutes.post("/:id/reject", async (c: Context<AdminEnv>) => {
  const id = c.req.param("id");
  const sub = await loadSubmission(id);
  if (!sub) return c.json({ error: "Submission not found" }, 404);

  const { error } = await supabaseAdmin
    .from("submissions")
    .update({ flagged: false, moderation_status: "rejected", status: "failed" })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 500);

  let refundedTo: number | null = null;
  try {
    refundedTo = await refundGradeCredit(sub.user_id);
  } catch (err) {
    // The reject already persisted; surface the refund failure for follow-up but
    // don't 500 (the moderation decision stands).
    console.error(
      `[admin-moderation] credit refund failed for ${sub.user_id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  await writeAuditLog(c, {
    action: "admin.moderation_reject",
    targetType: "submission",
    targetId: id,
    details: { user_id: sub.user_id, grade_credit_refunded: refundedTo != null },
    before: {
      flagged: sub.flagged,
      moderation_status: sub.moderation_status,
      status: sub.status,
    },
    after: { flagged: false, moderation_status: "rejected", status: "failed" },
  });
  return c.json({ ok: true, grade_credit_refunded: refundedTo != null });
});

// POST /:id/ban — suspend the submission's owner AND reject the submission.
// Suspending an account is destructive → require a fresh MFA step-up.
adminModerationRoutes.post("/:id/ban", async (c: Context<AdminEnv>) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  const sub = await loadSubmission(id);
  if (!sub) return c.json({ error: "Submission not found" }, 404);

  const actorId = c.get("userId");
  if (sub.user_id === actorId) {
    return c.json({ error: "You cannot suspend your own account." }, 400);
  }

  const { error: banErr } = await supabaseAdmin
    .from("users")
    .update({ suspended: true })
    .eq("id", sub.user_id);
  if (banErr) return c.json({ error: banErr.message }, 500);

  // Banning over a submission also rejects that submission.
  const { error: subErr } = await supabaseAdmin
    .from("submissions")
    .update({ flagged: false, moderation_status: "rejected", status: "failed" })
    .eq("id", id);
  if (subErr) return c.json({ error: subErr.message }, 500);

  await writeAuditLog(c, {
    action: "admin.moderation_ban",
    targetType: "user",
    targetId: sub.user_id,
    details: { submission_id: id },
    before: { suspended: false },
    after: { suspended: true },
  });
  return c.json({ ok: true });
});
