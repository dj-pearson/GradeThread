import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";

// Admin user-management (US-270). Role grant/revoke is a destructive
// super-admin action, so it runs server-side here (not via a client-side
// supabase update) where it can be gated by a fresh MFA step-up + audited.
// Mounted at /api/admin/users — inherits authMiddleware + adminAuthMiddleware
// (which already enforces the standing AAL2 requirement) from main.ts.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminUsersRoutes = new Hono<AdminEnv>();

const ASSIGNABLE_ROLES = new Set(["user", "admin", "super_admin"]);

// POST /:id/role — change a user's role. super_admin only + fresh step-up.
adminUsersRoutes.post("/:id/role", async (c: Context<AdminEnv>) => {
  // Only super-admins manage roles.
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  // Destructive privilege change — require a fresh MFA step-up.
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const targetId = c.req.param("id");
  const actorId = c.get("userId");
  if (targetId === actorId) {
    // Prevent self-lockout / self-escalation in one move.
    return c.json({ error: "You cannot change your own role." }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const role = typeof body.role === "string" ? body.role : "";
  if (!ASSIGNABLE_ROLES.has(role)) {
    return c.json({ error: "Invalid role" }, 400);
  }

  const { data: target, error: lookupErr } = await supabaseAdmin
    .from("users")
    .select("id, role")
    .eq("id", targetId)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);
  if (!target) return c.json({ error: "User not found" }, 404);

  const { error: updateErr } = await supabaseAdmin
    .from("users")
    .update({ role })
    .eq("id", targetId);
  if (updateErr) return c.json({ error: updateErr.message }, 500);

  await writeAuditLog(c, {
    action: "admin.change_role",
    targetType: "user",
    targetId,
    details: { previous_role: target.role, new_role: role },
  });

  return c.json({ ok: true, role });
});
