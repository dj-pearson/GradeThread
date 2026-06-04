import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "../lib/supabase.ts";
import { type AuthAssuranceClaims, isAal2 } from "../lib/jwt-claims.ts";
import { isAdminMfaEnforced } from "../lib/env.ts";

// Admin auth middleware (US-221 + US-270). Adds an admin-role check on top of
// the existing user auth — must be applied after authMiddleware so c.var.userId
// is already set. US-270: also requires the session to be AAL2 (MFA satisfied),
// rejecting aal1 admin calls server-side (not just client gating). Enrollment
// itself goes client->Supabase (supabase.auth.mfa.*), never through these admin
// routes, so gating here can't lock a user out of enrolling.

// US-357: pure MFA-gate decision. Returns true when admin access must be
// BLOCKED for failing the AAL2 requirement. Fail-closed: when enforcement is on
// and the verified claims are missing or aal1, block. Exported so the gate is
// unit-testable without a live auth server or database.
export function adminMfaBlocked(
  claims: AuthAssuranceClaims | undefined,
  enforced: boolean,
): boolean {
  if (!enforced) return false;
  return !claims || !isAal2(claims);
}

type AdminEnv = {
  Variables: {
    userId: string;
    user: { id: string; email?: string; [key: string]: unknown };
    adminRole: "admin" | "super_admin";
    // Set by authMiddleware from the verified token (US-357).
    authClaims?: AuthAssuranceClaims;
  };
};

const ADMIN_ROLES = new Set(["admin", "super_admin"]);

export const adminAuthMiddleware = createMiddleware<AdminEnv>(async (c, next) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthenticated" }, 401);
  }

  const { data, error } = await supabaseAdmin
    .from("users")
    .select("role")
    .eq("id", userId)
    .single();

  if (error || !data) {
    return c.json({ error: "User not found" }, 401);
  }
  if (!ADMIN_ROLES.has(data.role)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  // US-270/US-357: require MFA (AAL2). The frontend admin gate prompts
  // enrollment / challenge; this is the server-side enforcement so a forged or
  // aal1 token can't reach admin endpoints. The aal claim is read from
  // c.var.authClaims — decoded by authMiddleware from the token it VERIFIED via
  // getUser() — not re-read from the raw header. Toggleable via
  // ADMIN_MFA_ENFORCED for the enrollment window only (asserted at boot).
  if (adminMfaBlocked(c.get("authClaims"), isAdminMfaEnforced())) {
    return c.json({
      error: "Multi-factor authentication required for admin access.",
      code: "MFA_REQUIRED",
    }, 403);
  }

  c.set("adminRole", data.role as "admin" | "super_admin");
  await next();
});
