import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { captureException } from "../lib/observability.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { getSuppression, normalizeEmail, removeSuppression } from "../lib/email-suppression.ts";
import { requireScope } from "../lib/scope-guard.ts";

// US-914: admin view of the email suppression list + manual false-positive
// removal. Mounted at /api/admin/suppressions, inheriting authMiddleware +
// adminAuthMiddleware (admin JWT + AAL2) from the /api/admin/* group in main.ts.
//
// Viewing is admin; removing a suppression (which re-enables mail to a
// previously hard-bounced/complained address) is super_admin + fresh MFA
// step-up and is audited.
type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminSuppressionsRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminSuppressionsRoutes.use("*", requireScope("support:write"));

const PAGE_LIMIT = 200;

// GET /api/admin/suppressions?q=&limit= — most-recent first.
adminSuppressionsRoutes.get("/", async (c) => {
  const q = c.req.query("q")?.trim().toLowerCase() ?? "";
  const limit = Math.min(PAGE_LIMIT, Math.max(1, Number(c.req.query("limit") ?? "100") || 100));

  let query = supabaseAdmin
    .from("email_suppressions")
    .select("email, reason, source, notes, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (q) query = query.ilike("email", `%${q}%`);

  const { data, error } = await query;
  if (error) {
    captureException(error, { route: "admin-suppressions.list" });
    return c.json({ error: "Failed to load suppressions" }, 500);
  }
  return c.json({ suppressions: data ?? [] });
});

// POST /api/admin/suppressions/remove { email } — super_admin + step-up + audit.
adminSuppressionsRoutes.post("/remove", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  let body: { email?: string };
  try {
    body = (await c.req.json()) as { email?: string };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const email = normalizeEmail(body.email ?? "");
  if (!email) return c.json({ error: "email is required" }, 400);

  // Capture the prior state for the audit trail before deleting.
  const before = await getSuppression(email);
  if (!before) return c.json({ error: "No suppression for that address" }, 404);

  const removed = await removeSuppression(email);
  if (!removed) {
    return c.json({ error: "Failed to remove suppression" }, 500);
  }

  await writeAuditLog(c, {
    action: "email_suppression.remove",
    targetType: "email_suppression",
    targetId: email,
    before,
    details: { reason: before.reason, source: before.source },
  });

  return c.json({ ok: true, email });
});
