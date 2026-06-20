// US-925: public open + click tracking endpoints for broadcast campaign emails.
//
// Mounted at /api/campaign-track — a SIBLING of /api/admin so it is NOT behind
// the admin auth middleware (email clients are unauthenticated). Each tracked
// broadcast email carries:
//   • an open pixel  →  GET /o/:token   (stamps campaign_recipients.opened_at)
//   • wrapped links  →  GET /c/:token?u=<url>  (stamps clicked_at, then 302s)
//
// `token` is the campaign_recipients row id (an unguessable uuid = the send
// identity), so the stamp is by-id with no cross-tenant exposure — only this
// send's own engagement timestamps are written. Mirrors routes/drip-tracking.ts;
// always returns the pixel / a redirect even for a bad token (a tracking endpoint
// must never leak whether a token exists, and must never break the user's click).

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { trackingPixelBytes } from "../lib/email-tracking.ts";

export const campaignTrackingRoutes = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Pragma": "no-cache",
    },
  });
}

// GET /o/:token — open pixel. First open wins (opened_at is set once).
campaignTrackingRoutes.get("/o/:token", async (c) => {
  const token = c.req.param("token");
  if (UUID_RE.test(token)) {
    try {
      await supabaseAdmin
        .from("campaign_recipients")
        .update({ opened_at: new Date().toISOString() })
        .eq("id", token)
        .is("opened_at", null);
    } catch {
      // Tracking is best-effort — never fail the pixel response.
    }
  }
  return pixelResponse();
});

// GET /c/:token?u=<url> — click redirect. Stamps clicked_at (+ opened_at if the
// open pixel never loaded, e.g. images-off clients), then 302s to the validated
// http(s) target.
campaignTrackingRoutes.get("/c/:token", async (c) => {
  const token = c.req.param("token");
  const target = c.req.query("u") ?? "";

  let dest = FALLBACK_REDIRECT;
  try {
    const u = new URL(target);
    if (u.protocol === "https:" || u.protocol === "http:") dest = u.toString();
  } catch {
    // Malformed / missing target → safe fallback.
  }

  if (UUID_RE.test(token)) {
    try {
      const nowIso = new Date().toISOString();
      await supabaseAdmin
        .from("campaign_recipients")
        .update({ clicked_at: nowIso })
        .eq("id", token);
      await supabaseAdmin
        .from("campaign_recipients")
        .update({ opened_at: nowIso })
        .eq("id", token)
        .is("opened_at", null);
    } catch {
      // Best-effort — always complete the redirect.
    }
  }

  return c.redirect(dest, 302);
});
