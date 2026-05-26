import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";

// Inbound webhooks for FlipDesk integrations.
// These endpoints are public (no auth middleware) — they MUST verify a
// signature or shared-secret on the payload.

export const flipdeskWebhookRoutes = new Hono();

// eBay Notification API receiver: order created, paid, shipped, payout,
// return, etc. Verification: HMAC-SHA256 over body using
// EBAY_VERIFICATION_TOKEN. Not yet implemented — order events flow through
// the Sell APIs / polling for now.
flipdeskWebhookRoutes.post("/ebay", async (c) => {
  const verificationToken = Deno.env.get("EBAY_VERIFICATION_TOKEN");
  if (!verificationToken) {
    console.warn("[flipdesk-webhooks] EBAY_VERIFICATION_TOKEN not configured");
    return c.json({ error: "Webhook not configured" }, 503);
  }
  return c.json({ error: "Not implemented" }, 501);
});

// ── eBay Marketplace Account Deletion ────────────────────────────────
//
// Required by eBay to keep production keyset enabled. Two cases:
//
//   1. GET ?challenge_code=X — eBay's ownership handshake. Fired once when
//      you save the URL in the developer portal, and periodically after.
//      Response: { challengeResponse: sha256(challengeCode + verificationToken + endpoint) }
//      Hash inputs are concatenated as plain strings (no separators), hex
//      output, lowercase. The `endpoint` MUST equal the full HTTPS URL
//      registered in the portal — query string excluded.
//
//   2. POST — eBay sends a deletion notification when an eBay user
//      requests removal. We acknowledge with 200, then deactivate any
//      marketplace_connections row whose account_handle matches the eBay
//      username in the payload.
//
// Reference: https://developer.ebay.com/marketplace-account-deletion

const EBAY_DELETION_ENDPOINT_URL =
  Deno.env.get("EBAY_DELETION_ENDPOINT_URL") ??
  "https://functions.gradethread.com/api/flipdesk/webhooks/ebay/account-deletion";

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

flipdeskWebhookRoutes.get("/ebay/account-deletion", async (c) => {
  const verificationToken = Deno.env.get("EBAY_VERIFICATION_TOKEN");
  const challengeCode = c.req.query("challenge_code");

  if (!verificationToken) {
    console.error(
      "[flipdesk-webhooks] EBAY_VERIFICATION_TOKEN is not set; cannot answer eBay handshake"
    );
    return c.json({ error: "Webhook not configured" }, 503);
  }
  if (!challengeCode) {
    return c.json({ error: "Missing challenge_code" }, 400);
  }

  const challengeResponse = await sha256Hex(
    challengeCode + verificationToken + EBAY_DELETION_ENDPOINT_URL
  );

  // eBay specifically requires application/json with this exact shape.
  return c.json({ challengeResponse }, 200);
});

flipdeskWebhookRoutes.post("/ebay/account-deletion", async (c) => {
  let body: {
    metadata?: { topic?: string; schemaVersion?: string };
    notification?: {
      notificationId?: string;
      eventDate?: string;
      publishDate?: string;
      data?: { username?: string; userId?: string; eiasToken?: string };
    };
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const username = body.notification?.data?.username;
  const userId = body.notification?.data?.userId;
  const notificationId = body.notification?.notificationId;

  console.log(
    `[flipdesk-webhooks] eBay account-deletion notification id=${notificationId} username=${username} userId=${userId}`
  );

  // Best-effort cleanup. The eBay username is stored as account_handle on
  // marketplace_connections when we hydrate it (currently null on first
  // connect, populated later by an identity-API call).
  if (username) {
    const { error } = await supabaseAdmin
      .from("marketplace_connections")
      .update({
        is_active: false,
        access_token_encrypted: null,
        refresh_token_encrypted: null,
        refresh_error: "account_deleted",
      })
      .eq("marketplace", "ebay")
      .eq("account_handle", username);
    if (error) {
      console.error(
        "[flipdesk-webhooks] failed to deactivate eBay connection on deletion:",
        error
      );
    }
  }

  // Acknowledge promptly. eBay retries non-2xx responses.
  return c.body(null, 204);
});
