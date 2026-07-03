import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { requireScope } from "../lib/scope-guard.ts";

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
// Mechanism: /start mints TWO one-time magic-link tokens via the GoTrue admin
// API — one for the target (the browser redeems it with verifyOtp() to swap into
// the target's session) and one RESUME token for the admin themselves. The
// browser stashes only the admin's resume token_hash (single-use, short-lived),
// NOT the admin's long-lived refresh token, so an XSS during impersonation can't
// capture a credential that mints admin sessions indefinitely. "Exit" redeems
// the resume token to restore the admin session, then calls /stop — which is
// therefore audited under the admin's own identity.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminImpersonationRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminImpersonationRoutes.use("*", requireScope("users:role"));

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

  // The admin's own email — needed to mint a one-time RESUME token so the
  // browser never has to stash the admin's long-lived refresh token to get back
  // (US-581 hardening). Look it up rather than trusting anything client-supplied.
  const { data: actor, error: actorErr } = await supabaseAdmin
    .from("users")
    .select("email")
    .eq("id", actorId)
    .maybeSingle();
  if (actorErr || !actor?.email) {
    console.error("[impersonation] actor lookup failed:", actorErr?.message ?? "no email");
    return c.json({ error: "Internal error" }, 500);
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

  // Mint a second one-time token for the ADMIN: "Exit" redeems THIS to restore
  // the admin session, so the admin's refresh token is never written to web
  // storage. This token is single-use and short-lived (GoTrue OTP TTL) — a far
  // smaller blast radius than a stashed long-lived refresh token if an XSS fires
  // mid-impersonation. (If it expires before Exit, the client falls back to a
  // normal re-login.)
  const { data: resumeLink, error: resumeErr } = await supabaseAdmin.auth.admin
    .generateLink({ type: "magiclink", email: actor.email });
  if (resumeErr || !resumeLink?.properties?.hashed_token) {
    console.error(
      "[impersonation] admin resume generateLink failed:",
      resumeErr?.message ?? "no hashed_token",
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
    admin_resume_token_hash: resumeLink.properties.hashed_token,
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
