import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { requireScope } from "../lib/scope-guard.ts";
import {
  activeImpersonationByActor,
  endImpersonation,
  IMPERSONATION_MAX_SECONDS,
  revokeUserSessions,
  startImpersonation,
} from "../lib/impersonation-session.ts";

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

// US-2351 AC5: `reviewer` is added, and that is a decision rather than tidying.
//
// The set is "roles whose account carries authority a super_admin should not be
// able to borrow". A reviewer holds grading:review — they adjust issued grades,
// which are the product, and RLS grants them human_reviews through
// is_reviewer_or_admin(). Impersonating one means a grade adjustment that
// audits to the reviewer and not to the admin who actually made it, which is the
// same non-repudiation loss the admin/super_admin exclusion exists to prevent.
// The role sits below admin in the ladder; the authority it carries does not.
//
// Ordinary users stay impersonable — that is what the feature is for.
const PRIVILEGED_ROLES = new Set(["reviewer", "admin", "super_admin"]);

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
      {
        // US-2351 AC5 added `reviewer` to the set and left this message behind,
        // so a refused reviewer was told the rule was about admins. The message
        // an operator reads has to describe the rule that actually stopped them,
        // or the next person concludes the check is broken and goes looking for
        // a bug that is not there.
        error:
          "Impersonating a reviewer, admin or super-admin is not allowed — " +
          "their actions audit to them, not to you.",
      },
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

  // US-2351: open the server-side record BEFORE the token leaves this function.
  // It is the marker every destructive route checks, the clock that caps the
  // session, and the handle /stop revokes against — so a failure to write it is
  // a refusal to impersonate, not a logging hiccup. Without the row the session
  // would be exactly the unbounded, unmarked, unrevocable one this closed.
  const session = await startImpersonation({
    actorId,
    actorEmail: actor.email,
    targetId,
    targetEmail: target.email,
    nowMs: Date.now(),
  });
  if (!session) {
    return c.json(
      { error: "Could not open an impersonation session. Nothing was started." },
      500,
    );
  }

  await writeAuditLog(c, {
    action: "admin.impersonate_start",
    targetType: "user",
    targetId,
    details: {
      target_email: target.email,
      session_id: session.id,
      expires_at: session.expires_at,
    },
  });

  return c.json({
    token_hash: link.properties.hashed_token,
    admin_resume_token_hash: resumeLink.properties.hashed_token,
    // The client uses this to show a countdown and exit itself. It is a
    // convenience, NOT the enforcement — the server refuses on its own clock.
    expires_at: session.expires_at,
    max_seconds: IMPERSONATION_MAX_SECONDS,
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
  const now = Date.now();
  const actorId = c.get("userId");

  // US-2351 AC6: the target comes from the START record, never from the body.
  // It used to be written straight out of the request, so the stop audit row was
  // client-controlled — an admin could impersonate one person and log having
  // stopped impersonating another, which is worse than no row at all because it
  // reads as evidence.
  const session = await activeImpersonationByActor(actorId, now);
  if (!session) {
    // Nothing live to stop. Still audited: a stop with no session is either a
    // double-click or someone probing, and both are worth seeing.
    await writeAuditLog(c, {
      action: "admin.impersonate_stop",
      targetType: "user",
      targetId: null,
      details: { no_active_session: true },
    });
    return c.json({ ok: true, revoked: false });
  }

  // AC2: end the target's sessions, not just our record of them. Stopping used
  // to redeem the admin's resume token and nothing else, so a refresh token
  // copied out of the browser mid-impersonation outlived the "stop" entirely.
  const revoked = session.target_id
    ? await revokeUserSessions(session.target_id)
    : false;

  await endImpersonation(session.id, "stopped", now);

  await writeAuditLog(c, {
    action: "admin.impersonate_stop",
    targetType: "user",
    targetId: session.target_id,
    details: {
      session_id: session.id,
      target_email: session.target_email,
      sessions_revoked: revoked,
      started_at: session.started_at,
    },
  });

  // Reported rather than swallowed: an un-revoked stop means the target's
  // tokens are still live, and the operator needs to know that now.
  return c.json({ ok: true, revoked });
});
