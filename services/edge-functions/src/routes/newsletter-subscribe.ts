// US-912: standalone newsletter subscription — PUBLIC double-opt-in capture.
//
// A landing-page lead enters their email → POST /api/newsletter/subscribe creates
// (or refreshes) a `pending` email_subscribers row with an opaque consent token
// and sends a double-opt-in confirmation email. Clicking the link hits
// GET /api/newsletter/confirm?token=… which flips the row to `confirmed` and
// clears the token. Only `confirmed` rows are emailable (the marketing union +
// newsletter dispatch read confirmed subscribers).
//
// CAN-SPAM / anti-abuse:
//   • Double opt-in — we never mail marketing to an address until they confirm.
//   • No enumeration — subscribe ALWAYS returns a generic success (it never
//     reveals whether an address was already on the list), and confirm reveals
//     nothing about which addresses exist.
//   • Rate-limited per IP (applied in main.ts) so the endpoint can't be used to
//     blast confirmation emails at arbitrary inboxes.
//
// Mounted at /api/newsletter with its OWN (no-)auth — these are public endpoints,
// NOT under any /api/* JWT group. Distinct concrete paths from the
// /api/newsletter/scheduler/* trigger so the two routers don't collide.

import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { captureException, recordMetric } from "../lib/observability.ts";
import { sendNewsletterConfirmationEmail } from "../lib/email.ts";
import {
  isValidSubscriberEmail,
  normalizeSubscriberEmail,
} from "../lib/email-subscribers.ts";

export const newsletterSubscribeRoutes = new Hono();

// Cap the free-text `source` so a crafted request can't bloat the row.
const SOURCE_MAX = 64;

function confirmUrl(token: string): string {
  const base = Deno.env.get("FUNCTIONS_URL")?.trim() || "https://functions.gradethread.com";
  return `${base}/api/newsletter/confirm?token=${encodeURIComponent(token)}`;
}

// Tiny branded HTML page rendered in the browser after a confirm click (mirrors
// the no-login unsubscribe confirmation in notifications.ts).
function confirmPage(c: Context, msg: string, ok: boolean) {
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Newsletter</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 24px;text-align:center;color:#1A1A2E"><h1 style="font-size:20px;color:#0F3460">GradeThread</h1><p style="font-size:15px;line-height:1.5">${msg}</p><p style="margin-top:24px"><a href="https://gradethread.com" style="color:#E94560;text-decoration:none;font-weight:600">Back to gradethread.com</a></p></body></html>`,
    ok ? 200 : 400,
  );
}

// ── POST /subscribe { email, source? } ──────────────────────────────────────
newsletterSubscribeRoutes.post("/subscribe", async (c) => {
  let body: { email?: unknown; source?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const email = normalizeSubscriberEmail(typeof body.email === "string" ? body.email : "");
  // A malformed address is a real client error (the form should catch it) — and
  // rejecting it isn't enumeration. Everything past this point returns a generic
  // success regardless of the address's prior state.
  if (!isValidSubscriberEmail(email)) {
    return c.json({ error: "Please enter a valid email address." }, 400);
  }
  const source =
    typeof body.source === "string" && body.source.trim()
      ? body.source.trim().slice(0, SOURCE_MAX)
      : "landing";

  // Generic success — never leaks whether the address was new, pending, or
  // already confirmed (anti-enumeration).
  const generic = { ok: true, message: "Check your inbox to confirm your subscription." };

  try {
    const { data: existingRaw } = await supabaseAdmin
      .from("email_subscribers")
      .select("id, status, user_id")
      .eq("email", email)
      .maybeSingle();
    const existing = existingRaw as
      | { id: string; status: string; user_id: string | null }
      | null;

    // Already confirmed → no-op (don't re-send, don't reveal it's confirmed).
    if (existing && existing.status === "confirmed") {
      recordMetric("newsletter.subscribe", 1, { result: "already_confirmed" });
      return c.json(generic);
    }

    // Link to an existing account if this email already belongs to a user, so the
    // marketing union de-dupes by email and we never double-send.
    let userId = existing?.user_id ?? null;
    if (!userId) {
      const { data: userRow } = await supabaseAdmin
        .from("users")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      userId = (userRow as { id: string } | null)?.id ?? null;
    }

    const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
    const nowIso = new Date().toISOString();

    // Upsert a pending row carrying a fresh confirm token. A previously
    // unsubscribed/bounced lead re-opting-in starts a clean pending cycle.
    const { error: upsertErr } = await supabaseAdmin
      .from("email_subscribers")
      .upsert(
        {
          email,
          status: "pending",
          source,
          consent_token: token,
          confirmed_at: null,
          unsubscribed_at: null,
          user_id: userId,
          updated_at: nowIso,
        },
        { onConflict: "email" },
      );
    if (upsertErr) {
      captureException(upsertErr, { route: "newsletter-subscribe.upsert" });
      return c.json({ error: "Something went wrong. Please try again." }, 500);
    }

    // Double-opt-in confirmation (transactional). Best-effort: a suppressed
    // address is silently skipped by deliverEmail, which still returns generic
    // success (no enumeration).
    await sendNewsletterConfirmationEmail(email, confirmUrl(token)).catch((err) =>
      captureException(err, { route: "newsletter-subscribe.confirm_email", level: "warn" })
    );

    recordMetric("newsletter.subscribe", 1, { result: existing ? "re_pending" : "new" });
    return c.json(generic);
  } catch (err) {
    captureException(err, { route: "newsletter-subscribe.subscribe" });
    return c.json({ error: "Something went wrong. Please try again." }, 500);
  }
});

// ── GET /confirm?token=… ─────────────────────────────────────────────────────
newsletterSubscribeRoutes.get("/confirm", async (c) => {
  const token = c.req.query("token")?.trim() ?? "";
  if (!token) {
    return confirmPage(c, "This confirmation link is invalid or has expired.", false);
  }

  try {
    const { data: rowRaw } = await supabaseAdmin
      .from("email_subscribers")
      .select("id, status, email")
      .eq("consent_token", token)
      .maybeSingle();
    const row = rowRaw as { id: string; status: string; email: string } | null;

    // Unknown token → reveal nothing (could be already-confirmed-and-cleared or
    // never-existed). Generic invalid message either way.
    if (!row) {
      return confirmPage(c, "This confirmation link is invalid or has expired.", false);
    }

    // Flip to confirmed + clear the single-use token. Re-link to an account if
    // one now exists for this email (registration may have happened meanwhile).
    const { data: userRow } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("email", row.email)
      .maybeSingle();
    const userId = (userRow as { id: string } | null)?.id ?? null;

    const patch: Record<string, unknown> = {
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
      consent_token: null,
      unsubscribed_at: null,
      updated_at: new Date().toISOString(),
    };
    if (userId) patch.user_id = userId;

    const { error: updErr } = await supabaseAdmin
      .from("email_subscribers")
      .update(patch)
      .eq("id", row.id);
    if (updErr) {
      captureException(updErr, { route: "newsletter-subscribe.confirm" });
      return confirmPage(c, "Sorry — we couldn't confirm your subscription. Please try again.", false);
    }

    recordMetric("newsletter.confirm", 1);
    return confirmPage(
      c,
      "You're subscribed! Thanks for confirming — watch your inbox for resale grading tips and updates.",
      true,
    );
  } catch (err) {
    captureException(err, { route: "newsletter-subscribe.confirm" });
    return confirmPage(c, "Sorry — something went wrong. Please try again.", false);
  }
});
