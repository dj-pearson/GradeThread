import { createMiddleware } from "hono/factory";
import type { User } from "@supabase/supabase-js";
import { supabaseAdmin } from "../lib/supabase.ts";
import { type AuthAssuranceClaims, decodeJwtClaims } from "../lib/jwt-claims.ts";

type AuthEnv = {
  Variables: {
    user: User;
    userId: string;
    // US-357: aal/amr decoded from the SAME token getUser() just verified.
    // Downstream gates (admin AAL2, destructive step-up) read THIS, never the
    // raw Authorization header, so assurance claims are coupled to a verified
    // token and can't be sourced from an unverified place.
    authClaims: AuthAssuranceClaims;
  };
};

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.replace("Bearer ", "");

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data.user) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  // US-366: require a verified email before any authenticated edge access.
  // OAuth identities (Google) arrive with email_confirmed_at already set, so
  // this only blocks unconfirmed password signups. Defense in depth even with
  // GoTrue confirmations on (a future config slip, magic-link, etc. can't grant
  // app access to an unverified account).
  if (!data.user.email_confirmed_at) {
    return c.json(
      { error: "Email not verified. Please confirm your email to continue.", code: "email_unverified" },
      403,
    );
  }

  c.set("user", data.user);
  c.set("userId", data.user.id);
  // Decode assurance claims from the verified token exactly once.
  c.set("authClaims", decodeJwtClaims(token));

  await next();
});
