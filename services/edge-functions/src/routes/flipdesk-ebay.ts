import { Hono } from "hono";

// eBay integration endpoints.
// All handlers are stubs (501) until eBay credentials and OAuth flow are in place.
// Expected env: EBAY_APP_ID, EBAY_CERT_ID, EBAY_DEV_ID, EBAY_REDIRECT_URI, EBAY_ENV ("sandbox" | "production")

export const flipdeskEbayRoutes = new Hono();

// Begin OAuth: returns the eBay consent URL for the caller to redirect to.
flipdeskEbayRoutes.get("/oauth/start", (c) => {
  if (!Deno.env.get("EBAY_APP_ID")) {
    return c.json({ error: "eBay not configured" }, 503);
  }
  return c.json({ error: "Not implemented" }, 501);
});

// OAuth callback: exchange code for access + refresh token, store encrypted in marketplace_connections.
flipdeskEbayRoutes.get("/oauth/callback", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// Scheduled rotation entry — invoked by the scheduler. Rotates tokens nearing expiry.
flipdeskEbayRoutes.post("/oauth/refresh", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// Pull the seller's active eBay listings via the Sell Inventory / Browse API.
// Upserts into flipdesk_ebay_listings keyed on (user_id, ebay_item_id), reading
// each listing's "Custom label (SKU)" into custom_label for SKU reconciliation.
// Until eBay OAuth is configured, the in-app CSV upload (eBay Active Listings
// report → Reconciliation → eBay SKU match) covers this same flow.
flipdeskEbayRoutes.post("/listings/pull", (c) => {
  if (!Deno.env.get("EBAY_APP_ID")) {
    return c.json({ error: "eBay not configured" }, 503);
  }
  return c.json({ error: "Not implemented" }, 501);
});

// Push a single drafted item to eBay.
// Body: { inventory_item_id: string }
flipdeskEbayRoutes.post("/listings/push", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// Pre-validate a draft against Sell Metadata API before push.
flipdeskEbayRoutes.post("/listings/validate", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// End / revise an active listing.
flipdeskEbayRoutes.delete("/listings/:listingId", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// Ingest a payout CSV — body is multipart with field "file".
flipdeskEbayRoutes.post("/payouts/import-csv", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// Sold comps via Browse API (active listings) — fallback for users without Marketplace Insights access.
flipdeskEbayRoutes.get("/comps", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});
