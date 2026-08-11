// US-585: public waitlist capture + per-account access status.
//
// Mounted at /api/waitlist. Three surfaces:
//   POST /            — anonymous capture from the landing form (rate-limited in
//                       main.ts). Upserts by lower(email) so re-submitting is
//                       idempotent and never leaks whether an email already
//                       exists (always returns the same generic ok).
//   GET  /status      — anonymous: is the staged-launch gate on right now?
//                       (US-2449) The public capture form renders ONLY while it
//                       is, so the site never shows a waitlist CTA beside a live
//                       "Start Grading Free" button. Returns one boolean and no
//                       account data, which is why it needs no auth.
//   GET  /me          — authenticated: does THIS account have access right now?
//                       Powers the SPA's gated-state UI without it having to
//                       probe a real endpoint and parse a 403.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { isWaitlistGatingActive, userHasAccess } from "../lib/access-gate.ts";

export const waitlistRoutes = new Hono<{ Variables: { userId: string; user: { email?: string } } }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/waitlist — anonymous capture.
waitlistRoutes.post("/", async (c) => {
  let body: { email?: unknown; full_name?: unknown; source?: unknown; referral_code?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return jsonError(c, 400, "A valid email is required");
  }
  const fullName =
    typeof body.full_name === "string" ? body.full_name.trim().slice(0, 200) : null;
  const source = typeof body.source === "string" ? body.source.trim().slice(0, 60) : "landing";
  const referralCode =
    typeof body.referral_code === "string" ? body.referral_code.trim().slice(0, 60) : null;

  // Idempotent upsert keyed on the normalized email. ignoreDuplicates keeps the
  // original requested_at / status (we never downgrade an approved entry back to
  // pending just because someone re-submitted the form).
  const { error } = await supabaseAdmin
    .from("waitlist_entries")
    .upsert(
      {
        email,
        full_name: fullName,
        source,
        referral_code: referralCode,
      },
      { onConflict: "email", ignoreDuplicates: true },
    );
  if (error) {
    // The unique index is on lower(email); the onConflict above targets the
    // column. If the DB rejects the duplicate anyway, treat it as success — the
    // person is already captured, and we never reveal that.
    if (!String(error.message ?? "").toLowerCase().includes("duplicate")) {
      return jsonError(c, 500, "Could not join the waitlist. Please try again.");
    }
  }

  return c.json({ ok: true });
});

// GET /api/waitlist/status — anonymous gate state (US-2449).
//
// authMiddleware is mounted on the exact path /api/waitlist/me, so this stays
// public. It reads the same fleet-wide 30s cache the gate itself uses, so a
// crawler hitting the prerendered landing page costs no extra query.
waitlistRoutes.get("/status", async (c) => {
  return c.json({ gatingActive: await isWaitlistGatingActive() });
});

// GET /api/waitlist/me — authenticated access check (auth applied in main.ts).
waitlistRoutes.get("/me", async (c) => {
  const userId = c.get("userId");
  const email = c.get("user")?.email ?? null;
  const gatingActive = await isWaitlistGatingActive();
  // When gating is off, everyone has access — skip the per-account lookup.
  const hasAccess = gatingActive ? await userHasAccess(userId, email) : true;
  return c.json({ gatingActive, hasAccess });
});
