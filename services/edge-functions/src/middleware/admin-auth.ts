import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "../lib/supabase.ts";
import { decodeJwtClaims, isAal2 } from "../lib/jwt-claims.ts";
import { isAdminMfaEnforced } from "../lib/env.ts";

// Admin auth middleware (US-221 + US-270). Adds an admin-role check on top of
// the existing user auth — must be applied after authMiddleware so c.var.userId
// is already set. US-270: also requires the session to be AAL2 (MFA satisfied),
// rejecting aal1 admin calls server-side (not just client gating). Enrollment
// itself goes client->Supabase (supabase.auth.mfa.*), never through these admin
// routes, so gating here can't lock a user out of enrolling.

type AdminEnv = {
  Variables: {
    userId: string;
    user: { id: string; email?: string; [key: string]: unknown };
    adminRole: "admin" | "super_admin";
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

  // US-270: require MFA (AAL2). The frontend admin gate prompts enrollment /
  // challenge; this is the server-side enforcement so a forged/aal1 token can't
  // reach admin endpoints. Toggleable via ADMIN_MFA_ENFORCED for the rollout
  // window only.
  if (isAdminMfaEnforced()) {
    const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!isAal2(decodeJwtClaims(token))) {
      return c.json({
        error: "Multi-factor authentication required for admin access.",
        code: "MFA_REQUIRED",
      }, 403);
    }
  }

  c.set("adminRole", data.role as "admin" | "super_admin");
  await next();
});
