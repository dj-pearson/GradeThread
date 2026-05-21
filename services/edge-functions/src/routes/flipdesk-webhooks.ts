import { Hono } from "hono";

// Inbound webhooks for FlipDesk integrations.
// These endpoints are public (no auth middleware) — they MUST verify a signature on the payload.

export const flipdeskWebhookRoutes = new Hono();

// eBay Notification API receiver: order created, paid, shipped, payout, return, etc.
// Verification: HMAC-SHA256 over body using EBAY_VERIFICATION_TOKEN.
flipdeskWebhookRoutes.post("/ebay", async (c) => {
  const verificationToken = Deno.env.get("EBAY_VERIFICATION_TOKEN");
  if (!verificationToken) {
    console.warn("[flipdesk-webhooks] EBAY_VERIFICATION_TOKEN not configured");
    return c.json({ error: "Webhook not configured" }, 503);
  }
  // eBay's challenge-response handshake — implementation pending.
  return c.json({ error: "Not implemented" }, 501);
});

// eBay account-deletion notification (required to keep developer access).
flipdeskWebhookRoutes.post("/ebay/account-deletion", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});
