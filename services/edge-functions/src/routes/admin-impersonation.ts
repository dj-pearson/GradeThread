import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";

// Admin user impersonation / "view as" (US-581). Lets a super-admin observe a
// user's own dashboard exactly as that user sees it, to debug support tickets
// without reading raw Postgres. Mounted at /api/admin/impersonation — inherits
// authMiddleware + adminAuthMiddleware (standing AAL2) from main.ts.
//
// Security posture:
//   • super_admin ONLY (not plain admin) + a FRESH MFA step-up, because a
//     successful start mints a real, full-access session as the target user.
//   • impersonating another admin / super_admin is refused (privilege confusion).
//   • every start AND stop is written to admin_audit_log (AC #3).
//
// Mechanism: /start mints a one-time magic-link token for the target via the
// GoTrue admin API and returns its hashed_token. The browser exchanges it with
// supabase.auth.verifyOtp() to swap into the target's session, having first
// stashed the admin's own tokens so the "Exit" button can restore them. /stop
// is called once the admin session is restored, so it is itself audited under
// the admin's identity.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminImpersonationRoutes = new Hono<AdminEnv>();

const PRIVILEGED_ROLES = new Set(["admin", "super_admin"]);

// POST /start/:id — begin impersonating a user. super_admin only + step-up.
adminImpersonationRoutes.post("/start/:id", async (c: Context<AdminEnv>) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  // Minting a session as another user is the most sensitive action there is —
  // require a fresh second-factor challenge.
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const targetId = c.req.param("id");
  const actorId = c.get("userId");
  if (targetId === actorId) {
    return c.json({ error: "You cannot impersonate yourself." }, 400);
  }

  const { data: target, error: lookupErr } = await supabaseAdmin
    .from("users")
    .select("id, email, full_name, role")
    .eq("id", targetId)
    .maybeSingle();
  if (lookupErr) {
    console.error("[impersonation] target lookup failed:", lookupErr.message);
    return c.json({ error: "Internal error" }, 500);
  }
  if (!target) return c.json({ error: "User not found" }, 404);
  if (PRIVILEGED_ROLES.has(target.role)) {
    return c.json(
      { error: "Impersonating an admin or super-admin is not allowed." },
      403,
    );
  }

  // Mint a one-time magic-link token the browser can redeem for the target's
  // session. generateLink does NOT email anything and does not mutate the user.
  const { data: link, error: linkErr } = await supabaseAdmin.auth.admin
    .generateLink({ type: "magiclink", email: target.email });
  if (linkErr || !link?.properties?.hashed_token) {
    console.error(
      "[impersonation] generateLink failed:",
      linkErr?.message ?? "no hashed_token",
    );
    return c.json({ error: "Internal error" }, 500);
  }

  await writeAuditLog(c, {
    action: "admin.impersonate_start",
    targetType: "user",
    targetId,
    details: { target_email: target.email },
  });

  return c.json({
    token_hash: link.properties.hashed_token,
    target: {
      id: target.id,
      email: target.email,
      full_name: target.full_name,
    },
  });
});

// POST /stop — end an impersonation session. Called once the admin session has
// been restored client-side, so this runs under the admin's own (AAL2) token
// and is attributable to them. No step-up — stopping is not destructive.
adminImpersonationRoutes.post("/stop", async (c: Context<AdminEnv>) => {
  const body = await c.req.json().catch(() => ({}));
  const targetId = typeof body.target_id === "string" ? body.target_id : null;

  await writeAuditLog(c, {
    action: "admin.impersonate_stop",
    targetType: "user",
    targetId,
  });

  return c.json({ ok: true });
});
