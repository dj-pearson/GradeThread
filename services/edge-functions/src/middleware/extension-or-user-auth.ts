import { createMiddleware } from "hono/factory";
import type { User } from "@supabase/supabase-js";
import { supabaseAdmin } from "../lib/supabase.ts";
import { type AuthAssuranceClaims, decodeJwtClaims } from "../lib/jwt-claims.ts";
import { verifyExtensionToken } from "../lib/extension-token.ts";

// US-2723: accept EITHER the web app's Supabase session or the extension's own
// signed token, on the routes the extension actually calls.
//
// THE BUG THIS EXISTS TO FIX, because it was invisible for months.
//
// `authMiddleware` verifies with `supabaseAdmin.auth.getUser(token)`, which
// accepts a Supabase JWT and nothing else. The browser extension does not have
// one: after sign-in it holds `gtBuyerToken`, minted by lib/extension-token.ts
// as `userId.expires.hmac`. Three dot-separated parts — so it LOOKS like a JWT,
// sails past every shape check, and dies at signature verification as
// "Invalid or expired token".
//
// The result in production on 2026-08-20 was a clean 401 on
// POST /api/flipdesk/extension-queue/claim, every five minutes, forever. The
// desktop queue (US-2481) could never drain a single row, and
// POST /api/flipdesk/sync/observations (US-2698) had the same wall in front of
// it. Neither feature ever reported a problem, because a queue that claims
// nothing looks exactly like a queue with nothing in it.
//
// Everything the extension calls that DOES work lives under
// /api/grading/public/*, which verifies with verifyExtensionToken. That split
// was accidental. This middleware is what makes it deliberate.
//
// WHAT THIS DOES NOT DO. It does not widen anything else: it is applied only to
// the two route groups the extension calls, never as a replacement for
// authMiddleware. An extension token grants exactly the account it names and
// carries NO assurance claims, so a step-up or AAL2 gate can never be satisfied
// by one — see the explicit empty claims below.

type AuthEnv = {
  Variables: {
    user: User;
    userId: string;
    authClaims: AuthAssuranceClaims;
  };
};

// An extension token is not a Supabase JWT and has no aal/amr to decode.
// Stated explicitly rather than left to decodeJwtClaims, which would happily
// base64-decode the middle segment of `userId.expires.hmac` and return
// defaults — the right answer for the wrong reason, and one that would silently
// change meaning if either format ever moved.
const NO_ASSURANCE: AuthAssuranceClaims = { aal: null, amr: [] };

export const extensionOrUserAuthMiddleware = createMiddleware<AuthEnv>(
  async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }
    // US-2200: strip exactly the checked prefix rather than .replace().
    const token = authHeader.slice(7);

    // Extension token FIRST, and the order is a cost decision, not a preference:
    // this is a local HMAC compare, while getUser() is a network round trip. It
    // is safe in that order because verification is cryptographic — a Supabase
    // JWT cannot pass an HMAC check against our own secret, so there is no
    // "wrong branch wins" case to worry about.
    const ext = await verifyExtensionToken(token);
    if (ext) {
      // The token is valid, but it lives for 30 days by default. Re-read the
      // account so a deleted or unverified one cannot keep writing for a month
      // on a token minted while it was fine. authMiddleware makes the same
      // check; skipping it here would make the extension path the weaker door.
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(
        ext.userId,
      );
      if (error || !data.user) {
        return c.json({ error: "Invalid or expired token" }, 401);
      }
      if (!data.user.email_confirmed_at) {
        return c.json(
          {
            error:
              "Email not verified. Please confirm your email to continue.",
            code: "email_unverified",
          },
          403,
        );
      }
      c.set("user", data.user);
      c.set("userId", data.user.id);
      c.set("authClaims", NO_ASSURANCE);
      await next();
      return;
    }

    // Otherwise the ordinary web session, byte-for-byte the authMiddleware path.
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    if (!data.user.email_confirmed_at) {
      return c.json(
        {
          error: "Email not verified. Please confirm your email to continue.",
          code: "email_unverified",
        },
        403,
      );
    }
    c.set("user", data.user);
    c.set("userId", data.user.id);
    c.set("authClaims", decodeJwtClaims(token));
    await next();
  },
);
