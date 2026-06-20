// US-913: public open + click tracking endpoints for marketing broadcast email.
//
// Mounted at /api/email — a SIBLING of /api/admin so it is NOT behind the admin
// auth middleware (email clients are unauthenticated). It shares the /api/email
// prefix with the SES-notification webhook (routes/email-sns.ts); the paths
// don't collide. Each tracked broadcast email carries:
//   • an open pixel  →  GET /o/:token   (stamps campaign_recipients.opened_at)
//   • wrapped links  →  GET /c/:token   (stamps clicked_at + click_count, then 302s)
//
// `token` is an HMAC-signed payload (campaign_id + user_id + kind [+ signed
// destination URL]) — non-enumerable + unforgeable, so it can never leak or
// affect another recipient's row (a tampered token simply fails verification and
// is ignored). The stamp is by (campaign_id, user_id, channel='email') via the
// service-role record_campaign_email_{open,click} RPCs (single atomic UPDATE for
// first-open/click-wins + the running click_count). This SUPERSEDES the US-925
// row-id /api/campaign-track endpoints (whose rewriter pointed at /api/drip-track,
// so campaign opens/clicks were never actually stamped).
//
// Always returns the pixel / a redirect even for a bad token — a tracking
// endpoint must never leak whether a token is valid, nor break the user's click.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { trackingPixelBytes } from "../lib/email-tracking.ts";
import {
  engagementSigningSecret,
  isBotOpenUserAgent,
  verifyEngagementToken,
} from "../lib/email-engagement-token.ts";

export const emailEngagementRoutes = new Hono();

const FALLBACK_REDIRECT = "https://gradethread.com/dashboard";
// Back the image body with a concrete ArrayBuffer — a generic
// Uint8Array<ArrayBufferLike> isn't a valid BodyInit under Deno's strict lib.
const PIXEL_BYTES = trackingPixelBytes();
const PIXEL: ArrayBuffer = PIXEL_BYTES.buffer.slice(
  PIXEL_BYTES.byteOffset,
  PIXEL_BYTES.byteOffset + PIXEL_BYTES.byteLength,
) as ArrayBuffer;

function pixelResponse(): Response {
  return new Response(PIXEL, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.byteLength),
      // Never cache — a cached pixel would suppress repeat-open signal and let a
      // proxy serve it without hitting us at all.
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Pragma": "no-cache",
    },
  });
}

// GET /o/:token — open pixel. First open wins (opened_at is set once); a
// prefetch/proxy open is recorded but flagged via open_is_bot.
emailEngagementRoutes.get("/o/:token", async (c) => {
  const payload = await verifyEngagementToken(c.req.param("token"), engagementSigningSecret());
  if (payload && payload.k === "o") {
    const bot = isBotOpenUserAgent(c.req.header("user-agent"));
    try {
      await supabaseAdmin.rpc("record_campaign_email_open", {
        p_campaign: payload.c,
        p_user: payload.u,
        p_bot: bot,
      });
    } catch {
      // Tracking is best-effort — never fail the pixel response.
    }
  }
  return pixelResponse();
});

// GET /c/:token — click redirect. Stamps clicked_at (+ opened_at if the open
// pixel never loaded) + bumps click_count + records last_clicked_url, then 302s
// to the SIGNED destination (so the redirect target can't be tampered).
emailEngagementRoutes.get("/c/:token", async (c) => {
  const payload = await verifyEngagementToken(c.req.param("token"), engagementSigningSecret());

  let dest = FALLBACK_REDIRECT;
  if (payload && payload.k === "c" && payload.l) {
    try {
      const u = new URL(payload.l);
      if (u.protocol === "https:" || u.protocol === "http:") dest = u.toString();
    } catch {
      // Malformed signed target → safe fallback.
    }
    try {
      await supabaseAdmin.rpc("record_campaign_email_click", {
        p_campaign: payload.c,
        p_user: payload.u,
        p_url: dest,
      });
    } catch {
      // Best-effort — always complete the redirect.
    }
  }

  return c.redirect(dest, 302);
});
