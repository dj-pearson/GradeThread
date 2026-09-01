import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { resyncItemListedStatus } from "../lib/active-listings.ts";
import { ingestPayoutsForUser } from "../lib/ebay-payout-dedup.ts";
import { notifyPayoutImported } from "../lib/selling-activity-notify.ts";
import type { ParsedPayoutRow } from "../lib/ebay-payouts-csv.ts";
import { isDebugAllowed } from "../lib/env.ts";
import { claimWebhookEvent, releaseWebhookEvent } from "../lib/webhook-idempotency.ts";
import { verifyEbayNotification } from "../lib/ebay-notification-verify.ts";
import { eraseEbayBuyer } from "../lib/ebay-buyer-erasure.ts";
import { captureException, recordMetric } from "../lib/observability.ts";
import { checkFreshness } from "../lib/webhook-freshness.ts";
import { triggerEbaySyncForUser } from "./flipdesk-ebay.ts";
import { classifyEbayTopic } from "../lib/ebay-webhook-topics.ts";
import { notificationEndpointUrl } from "../lib/ebay-notification-subscriptions.ts";
import { pollMarketplaceEventsForUser } from "../lib/marketplace-event-poll.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import {
  isShopifyConfigured,
  normalizeShopDomain,
  verifyWebhookHmac,
} from "../lib/shopify-client.ts";
import {
  handleShopifyOrderEvent,
  parseShopifyWebhookOrder,
} from "../lib/shopify-orders.ts";
import { isDepopEnabled } from "../lib/depop-client.ts";
import {
  depopTimestampFresh,
  parseDepopOrder,
  verifyDepopWebhook,
} from "../lib/depop-api.ts";
import { handleDepopOrderEvent } from "../lib/depop-orders.ts";

// Inbound webhooks for FlipDesk integrations.
// These endpoints are public (no auth middleware) — they MUST verify a
// signature or shared-secret on the payload.

export const flipdeskWebhookRoutes = new Hono();

// US-1455: every receiver returns 2xx immediately, then processes the event
// asynchronously. If that async work throws (the outer `.catch`) or an ingest
// surfaces per-order errors (`res.errors`), the 2xx is already sent — so a bare
// console.error silently loses a failed sale/refund/sold-flip with no alert and
// no retry. Route every such failure through captureException (→ Sentry when
// configured) PLUS a `webhook.process_failed` metric so it's visible + alertable.
//
// Durability (AC2): rather than a per-provider parking lot, we lean on the manual
// sync pull — Shopify `/listings/pull` and the eBay orders sync both re-ingest
// the recent order window IDEMPOTENTLY (US-711/US-1427), so a dropped event
// reliably reconciles on the next sync. The metric gives us the signal to trigger
// one if failures spike.
function reportWebhookFailure(
  provider: "ebay" | "shopify" | "depop",
  err: unknown,
  context: { topic?: string; userId?: string } = {},
): void {
  const tags: Record<string, string> = { provider };
  if (context.topic) tags.topic = context.topic;
  console.error(
    `[flipdesk-webhooks] ${provider} event processing failed:`,
    err instanceof Error ? err.message : String(err),
  );
  captureException(err, {
    route: `flipdesk-webhooks/${provider}`,
    userId: context.userId,
    tags,
  });
  recordMetric("webhook.process_failed", 1, tags);
}

// eBay Notification API receiver: order created, paid, shipped, payout,
// return, etc. Verification: eBay signs every Notification-API message with
// ITS OWN key (X.509/ECDSA), presented in the `x-ebay-signature` header — NOT
// an HMAC of our verification token (that token is only for the GET challenge
// handshake). We verify against eBay's published public key via
// verifyEbayNotification — the SAME scheme the account-deletion endpoint uses
// (US-365). EBAY_VERIFICATION_TOKEN being set is kept only as an "integration
// configured" gate.
//
// Returns 204 within milliseconds so eBay's retry timer doesn't fire.
// Heavy lifting (event parsing, payout dedup + insert) is deferred to
// processEbayWebhookEvent in the lib layer.
//
// Sandbox tip: set WEBHOOK_PAYOUT_DEBUG=true to log the raw payload + headers
// and SKIP signature verification while wiring up a sandbox subscription. This
// is IGNORED when EDGE_ENV=production (see isDebugAllowed in lib/env.ts) —
// verification can never be bypassed in prod. See W4 doc comment for details.
// US-1964: eBay's ownership handshake for THIS endpoint. eBay calls it when a
// destination pointing here is created/updated (and periodically after), and
// refuses the destination if the response doesn't match — so without this GET,
// ensureDestination("general", …) can never succeed and no order/payout/return
// topic can be subscribed. Same scheme + same verification token as the
// account-deletion endpoint's handshake below; only the endpoint URL in the
// hash differs (it MUST be the exact URL registered with eBay).
flipdeskWebhookRoutes.get("/ebay", async (c) => {
  const verificationToken = Deno.env.get("EBAY_VERIFICATION_TOKEN");
  const challengeCode = c.req.query("challenge_code");

  if (!verificationToken) {
    console.error(
      "[flipdesk-webhooks] EBAY_VERIFICATION_TOKEN is not set; cannot answer eBay handshake",
    );
    return c.json({ error: "Webhook not configured" }, 503);
  }
  if (!challengeCode) {
    return c.json({ error: "Missing challenge_code" }, 400);
  }

  const challengeResponse = await sha256Hex(
    challengeCode + verificationToken + notificationEndpointUrl(),
  );
  return c.json({ challengeResponse }, 200);
});

flipdeskWebhookRoutes.post("/ebay", async (c) => {
  const verificationToken = Deno.env.get("EBAY_VERIFICATION_TOKEN");
  if (!verificationToken) {
    console.warn("[flipdesk-webhooks] EBAY_VERIFICATION_TOKEN not configured");
    return c.json({ error: "Webhook not configured" }, 503);
  }

  // Read the body as TEXT first — HMAC verification requires the exact
  // bytes eBay sent, not a re-serialized object.
  const rawBody = await c.req.text();
  // Debug logging + signature-bypass is ONLY honored outside production.
  // In production this is always false, so verification below always runs.
  const debug = isDebugAllowed("WEBHOOK_PAYOUT_DEBUG");

  // eBay's notification spec puts the signature in `x-ebay-signature`.
  // Older docs reference an Authorization header; we read both to be safe.
  const signatureHeader =
    c.req.header("x-ebay-signature") ??
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";

  if (debug) {
    // Log every header + the raw body verbatim. Only enable in sandbox —
    // production logs will leak payloads.
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v;
    });
    console.log(
      "[flipdesk-webhooks][DEBUG] eBay event headers:",
      JSON.stringify(headers),
    );
    console.log(
      "[flipdesk-webhooks][DEBUG] eBay event body:",
      rawBody.slice(0, 2000),
    );
  } else {
    if (!signatureHeader) {
      console.warn(
        "[flipdesk-webhooks] eBay event rejected: missing signature header",
      );
      return c.json({ error: "Missing signature" }, 401);
    }
    // eBay signs with its OWN key (verified via eBay's published public key),
    // NOT an HMAC of our verification token. Same scheme as account-deletion.
    const ok = await verifyEbayNotification(rawBody, signatureHeader);
    if (!ok) {
      console.warn(
        "[flipdesk-webhooks] eBay event rejected: signature mismatch",
      );
      return c.json({ error: "Invalid signature" }, 401);
    }
  }

  // Dispatch async. Don't block the 204 — eBay penalizes slow handlers.
  let parsed: Record<string, unknown>;
  try {
    const json = JSON.parse(rawBody);
    if (!json || typeof json !== "object") {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    parsed = json as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  // US-2326 AC2: replay window. The signature proves eBay signed this; it does
  // not prove it is RECENT, and a captured delivery stays validly signed
  // forever. `publishDate` is declared in the notification type and was never
  // read. Checked here rather than inside processEbayWebhookEvent because that
  // runs detached from the response — a rejection there could not produce a
  // status, and would be indistinguishable from success to the caller.
  //
  // Absent → accept: a topic that ships without the field must not become an
  // outage. Present but stale or unparseable → reject.
  const ebayNotif = (parsed.notification ?? {}) as {
    publishDate?: string;
    eventDate?: string;
    notificationId?: string;
  };
  const ebayFreshness = checkFreshness(
    ebayNotif.publishDate ?? ebayNotif.eventDate,
    Date.now(),
  );
  if (!ebayFreshness.fresh) {
    recordMetric("webhook.stale", 1, { provider: "ebay" });
    console.warn(
      `[flipdesk-webhooks] eBay event rejected as ${ebayFreshness.reason} ` +
        `(id=${ebayNotif.notificationId ?? "(no-id)"} ` +
        `ageMs=${ebayFreshness.ageMs ?? "n/a"})`,
    );
    return c.json({ error: "Stale notification" }, 400);
  }

  processEbayWebhookEvent(parsed).catch((err) => {
    reportWebhookFailure("ebay", err);
  });

  return c.body(null, 204);
});

// ── Shopify webhooks (US-711) ────────────────────────────────────────
//
// Receives orders/create, orders/updated, inventory_levels/update and
// products/update. Verification: Shopify signs every webhook with HMAC-SHA256
// over the RAW body using OUR app secret, presented base64 in the
// `X-Shopify-Hmac-Sha256` header — only Shopify can produce a valid signature,
// so AFTER verification the `X-Shopify-Shop-Domain` header is trusted to resolve
// the workspace owner (US-472 pattern: resolve from the verified domain, NOT the
// request body). Returns 200 promptly (Shopify expects 2xx within ~5s) and
// defers the heavy lifting. Sandbox: WEBHOOK_PAYOUT_DEBUG bypasses verification
// outside production only (isDebugAllowed), identical to the eBay receiver.
flipdeskWebhookRoutes.post("/shopify", async (c) => {
  if (!isShopifyConfigured()) {
    return c.json({ error: "Webhook not configured" }, 503);
  }

  // Raw bytes are required for HMAC verification (re-serializing would change them).
  const rawBody = await c.req.text();
  const debug = isDebugAllowed("WEBHOOK_PAYOUT_DEBUG");
  const hmacHeader = c.req.header("x-shopify-hmac-sha256") ?? "";

  if (!debug) {
    if (!hmacHeader) {
      console.warn(
        "[flipdesk-webhooks] Shopify event rejected: missing signature header",
      );
      return c.json({ error: "Missing signature" }, 401);
    }
    const ok = await verifyWebhookHmac(rawBody, hmacHeader);
    if (!ok) {
      console.warn(
        "[flipdesk-webhooks] Shopify event rejected: signature mismatch",
      );
      return c.json({ error: "Invalid signature" }, 401);
    }

    // US-2326 AC2: replay window, from the X-Shopify-Triggered-At header
    // Shopify already sends and this receiver never read. Checked AFTER the
    // HMAC, so an unsigned request is still rejected as unsigned rather than
    // as stale — the more accurate error, and the one that does not leak
    // whether a guessed signature was close.
    const triggeredAt = c.req.header("x-shopify-triggered-at");
    const freshness = checkFreshness(triggeredAt, Date.now());
    if (!freshness.fresh) {
      recordMetric("webhook.stale", 1, { provider: "shopify" });
      console.warn(
        `[flipdesk-webhooks] Shopify event rejected as ${freshness.reason} ` +
          `(ageMs=${freshness.ageMs ?? "n/a"})`,
      );
      return c.json({ error: "Stale notification" }, 400);
    }
  }

  const topic = c.req.header("x-shopify-topic") ?? "(unknown)";
  const shopDomain = normalizeShopDomain(c.req.header("x-shopify-shop-domain"));
  const webhookId = c.req.header("x-shopify-webhook-id") ?? null;

  let payload: Record<string, unknown>;
  try {
    const json = JSON.parse(rawBody);
    if (!json || typeof json !== "object") {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    payload = json as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Dispatch async — Shopify penalizes slow handlers.
  processShopifyWebhookEvent({ topic, shopDomain, webhookId, payload }).catch(
    (err) => {
      reportWebhookFailure("shopify", err, { topic });
    },
  );

  return c.body(null, 200);
});

// Resolve the GradeThread owner from the verified shop domain (US-472 pattern).
// The domain header was trusted only AFTER HMAC verification above. Connections
// live on the workspace owner (account_handle = <shop>.myshopify.com).
async function resolveShopifyConnectionUserId(
  shopDomain: string | null,
): Promise<string | null> {
  if (!shopDomain) return null;
  const { data: row } = await supabaseAdmin
    .from("marketplace_connections")
    .select("user_id")
    .eq("marketplace", "shopify")
    .eq("account_handle", shopDomain)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  return (row as { user_id?: string } | null)?.user_id ?? null;
}

// products/update: a Shopify-side archive/delete/draft of a product we track
// ends the local listing (the sync's status-refresh otherwise only catches this
// on the next manual pull). Tenant-scoped: only the owner's listings are touched.
async function handleShopifyProductUpdate(
  userId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const productId = payload.id != null ? String(payload.id) : null;
  const status = typeof payload.status === "string" ? payload.status : null;
  if (!productId) return;
  // An active product is still live — nothing to end.
  if (!status || status === "active") return;

  const { data: rows } = await supabaseAdmin
    .from("listings")
    .select("id, inventory_item_id, inventory_items!inner(user_id)")
    .eq("platform", "shopify")
    .eq("platform_listing_id", productId)
    .eq("inventory_items.user_id", userId)
    .eq("is_active", true);
  const matched = (rows ?? []) as Array<{
    id: string;
    inventory_item_id: string | null;
  }>;
  const ids = matched.map((r) => r.id);
  if (ids.length === 0) return;
  await supabaseAdmin
    .from("listings")
    .update({ listing_status: "ended", is_active: false })
    .in("id", ids);
  // US-2179: release each item's activeListings slot once nothing is live for it.
  // Ending only the listing row left the item 'listed' forever, holding a cap
  // slot for a listing Shopify had already archived or deleted.
  for (const itemId of new Set(matched.map((r) => r.inventory_item_id))) {
    await resyncItemListedStatus(itemId, userId);
  }
}

// ── Mandatory Shopify privacy/compliance webhooks (GDPR/CCPA) ─────────
//
// Shopify requires every public app to handle three privacy topics, registered
// via the app's [webhooks.privacy_compliance] config (shopify.app.toml) and
// probed at review time (valid HMAC → 200, already guaranteed by the POST
// handler). This does the ACTUAL compliance work behind the 200:
//
//   • customers/data_request — the merchant, for a customer, asks for the
//       personal data we hold about them. FlipDesk stores NO Shopify customer
//       PII: the order sync reads only order id/number, financial status,
//       totals, and line-item product/qty/price (never name/email/phone/address
//       — we hold Level-1 access with no protected fields). Nothing to compile;
//       log + acknowledge.
//   • customers/redact — erase a specific customer's personal data. Same reason:
//       we hold none, so it's an acknowledged no-op.
//   • shop/redact — fires ~48h after the merchant UNINSTALLS; erase the shop's
//       data. The Shopify-granted data we hold is the OAuth credential + shop
//       handle in marketplace_connections — we DELETE those rows (erasing the
//       encrypted token). We deliberately DON'T delete the GradeThread user's own
//       inventory/listings/sales: those are the seller's business records
//       governed by GradeThread's retention policy (vault/10-ops/data-retention.md), not
//       Shopify shop data.
async function handleShopifyComplianceWebhook(
  topic: string,
  shopDomain: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  recordMetric("webhook.compliance", 1, { provider: "shopify", topic });

  if (topic === "shop/redact") {
    // Prefer the HMAC-verified header domain; fall back to the signed payload.
    const shop =
      shopDomain ??
      normalizeShopDomain(
        typeof payload.shop_domain === "string" ? payload.shop_domain : null,
      );
    if (!shop) {
      console.warn(
        "[flipdesk-webhooks] Shopify shop/redact had no resolvable shop domain — nothing to erase",
      );
      return;
    }
    const { data: removed, error } = await supabaseAdmin
      .from("marketplace_connections")
      .delete()
      .eq("marketplace", "shopify")
      .eq("account_handle", shop)
      .select("id");
    if (error) {
      reportWebhookFailure(
        "shopify",
        new Error(`shop/redact failed to delete connection: ${error.message}`),
        { topic },
      );
      return;
    }
    console.log(
      `[flipdesk-webhooks] Shopify shop/redact → erased ${
        ((removed ?? []) as unknown[]).length
      } connection row(s) for shop=${shop}`,
    );
    return;
  }

  // customers/data_request + customers/redact: no Shopify customer PII stored,
  // so nothing to return or erase. Acknowledge explicitly (logged) so the no-op
  // is auditable rather than a silent unhandled-topic drop.
  console.log(
    `[flipdesk-webhooks] Shopify ${topic} → no customer PII stored; acknowledged no-op`,
  );
}

// Dispatches a verified Shopify webhook. orders/create + orders/updated drive
// sale capture + refund status (handleShopifyOrderEvent); products/update ends a
// delisted product; inventory_levels/update is metered (single-unit reseller
// items already flip on the order event). Idempotent: deduped by Shopify's
// X-Shopify-Webhook-Id before side effects (same tri-state as the eBay path).
async function processShopifyWebhookEvent(args: {
  topic: string;
  shopDomain: string | null;
  webhookId: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  const { topic, shopDomain, webhookId, payload } = args;
  console.log(
    `[flipdesk-webhooks] Shopify event: topic=${topic} shop=${shopDomain ?? "(none)"} id=${webhookId ?? "(no-id)"}`,
  );

  if (webhookId) {
    const claim = await claimWebhookEvent("shopify", webhookId, topic);
    if (claim === "duplicate") {
      console.log(
        `[flipdesk-webhooks] duplicate Shopify event id=${webhookId} — skipping`,
      );
      return;
    }
    // The downstream writes are idempotent (sale dedupe by listing_id, payout by
    // ref, status update by listing_id), so a claim-write failure is safe to
    // process fail-open — but make it observable.
    //
    // US-2326 AC3 asked for this to fail CLOSED, and the owner DECIDED against
    // it on 2026-08-15. Recorded here rather than only in the story, because the
    // AC's wording is the kind a future reader implements without asking.
    //
    // THE RULE IS NOT "FAIL OPEN". It is: fail closed where the provider
    // REDELIVERS, open where it does not. routes/webhooks.ts:125 already fails
    // CLOSED on the Stripe path (US-509) and returns a 500 precisely because
    // Stripe retries — so the two paths are not inconsistent, they are the same
    // rule applied to different providers.
    //
    // Here, failing closed would drop a REAL webhook on a transient database
    // blip — a sale that never arrives — to prevent a double-process the
    // idempotent ingest above already prevents. A benign duplicate becomes
    // permanent data loss, and a marketplace does not reliably redeliver.
    //
    // If it is ever revisited, a durable retry or parking path has to come
    // FIRST. Fail-closed without one is strictly worse than what is here.
    if (claim === "error") {
      recordMetric("webhook.fail_open", 1, { provider: "shopify", topic });
      captureException(
        new Error(`Shopify webhook idempotency claim failed; processing fail-open (topic=${topic})`),
        { level: "warn", route: "flipdesk-webhooks.shopify", tags: { topic, decision: "fail_open" } },
      );
    }
  }

  recordMetric("webhook.received", 1, { provider: "shopify", topic });

  // Mandatory GDPR/CCPA privacy webhooks (registered via the app's
  // [webhooks.privacy_compliance] config). Handle these BEFORE the
  // active-connection gate below: shop/redact fires ~48h AFTER uninstall, when
  // the connection is already inactive/removed, so resolving via is_active
  // would wrongly drop the erasure request.
  if (
    topic === "customers/data_request" ||
    topic === "customers/redact" ||
    topic === "shop/redact"
  ) {
    await handleShopifyComplianceWebhook(topic, shopDomain, payload);
    return;
  }

  const userId = await resolveShopifyConnectionUserId(shopDomain);
  if (!userId) {
    recordMetric("webhook.unmatched_seller", 1, { provider: "shopify", topic });
    console.warn(
      `[flipdesk-webhooks] no active Shopify connection matches shop=${shopDomain ?? "(none)"} topic=${topic} — dropping`,
    );
    return;
  }

  switch (topic) {
    case "orders/create":
    case "orders/updated": {
      const order = parseShopifyWebhookOrder(payload);
      if (!order) {
        console.warn(
          `[flipdesk-webhooks] Shopify ${topic} event had no usable order id — dropping`,
        );
        return;
      }
      const res = await handleShopifyOrderEvent(userId, order);
      recordMetric("webhook.order_processed", 1, {
        provider: "shopify",
        topic,
        kind: res.kind,
      });
      if (res.errors.length > 0) {
        reportWebhookFailure(
          "shopify",
          new Error(`${topic} ingest errors: ${res.errors.join(" | ")}`),
          { topic, userId },
        );
      }
      console.log(
        `[flipdesk-webhooks] Shopify ${topic} → ${res.kind} (sales_new=${res.salesNew} sold=${res.soldFlipped} status_updated=${res.statusUpdated}) user=${userId}`,
      );
      return;
    }
    case "products/update": {
      await handleShopifyProductUpdate(userId, payload);
      return;
    }
    case "inventory_levels/update": {
      recordMetric("webhook.inventory_update", 1, { provider: "shopify" });
      return;
    }
    default:
      recordMetric("webhook.unhandled_topic", 1, { provider: "shopify", topic });
      console.log(
        `[flipdesk-webhooks] dropping Shopify event with unhandled topic: ${topic}`,
      );
  }
}

// ── Depop webhooks (US-714) ──────────────────────────────────────────
//
// Receives Depop order events (sold / cancelled / refunded). Verification: Depop
// signs every delivery with an HMAC-SHA256 over `<timestamp>.<body>` using a
// shared secret (DEPOP_WEBHOOK_SECRET), presented in the `X-Depop-Signature`
// header alongside `X-Depop-Timestamp` — only Depop can produce a valid
// signature.
//
// ⚠ US-2326 AC5, 2026-08-17: those two header names and the signed string are
// now READ OFF DEPOP'S OWN "Validate webhooks" guide, not guessed. The previous
// implementation signed the RAW BODY alone, which would have rejected every
// genuine delivery as a mismatch — queued rather than live only because the
// connector is gated off. The guide documents NO delivery-id header, which is
// why the dedupe key below falls back to the payload. The seller is resolved from a payload id
// that we verified at connect time (external_account_id / account_handle), NOT a
// trusted-by-default body field. Returns 200 promptly and defers the heavy
// lifting. The ENTIRE receiver 503s while the connector is disabled (US-712).
// Sandbox: WEBHOOK_PAYOUT_DEBUG bypasses verification outside production only.
flipdeskWebhookRoutes.post("/depop", async (c) => {
  if (!isDepopEnabled()) {
    return c.json({ error: "Webhook not configured" }, 503);
  }
  const rawBody = await c.req.text();
  const debug = isDebugAllowed("WEBHOOK_PAYOUT_DEBUG");
  const signature =
    c.req.header("x-depop-signature") ??
    c.req.header("x-depop-hmac-sha256") ??
    "";
  const timestamp = c.req.header("x-depop-timestamp") ?? "";

  if (!debug) {
    if (!signature) {
      console.warn("[flipdesk-webhooks] Depop event rejected: missing signature header");
      return c.json({ error: "Missing signature" }, 401);
    }
    if (!timestamp) {
      // The timestamp is part of the signed string, so its absence is not a
      // missing nicety — nothing can be verified without it.
      console.warn("[flipdesk-webhooks] Depop event rejected: missing timestamp header");
      return c.json({ error: "Missing timestamp" }, 401);
    }
    // US-2326 AC1: the freshness window this receiver did not have. Checked
    // BEFORE the HMAC so a replayed delivery is refused on the cheap comparison
    // rather than after a key import.
    if (!depopTimestampFresh(timestamp, Date.now())) {
      console.warn("[flipdesk-webhooks] Depop event rejected: timestamp outside the freshness window");
      return c.json({ error: "Stale timestamp" }, 401);
    }
    const ok = await verifyDepopWebhook(rawBody, signature, timestamp);
    if (!ok) {
      console.warn("[flipdesk-webhooks] Depop event rejected: signature mismatch");
      return c.json({ error: "Invalid signature" }, 401);
    }
  }

  const topic = c.req.header("x-depop-topic") ?? c.req.header("x-depop-event") ?? "(unknown)";
  const webhookId = c.req.header("x-depop-webhook-id") ?? c.req.header("x-depop-delivery-id") ?? null;

  let payload: Record<string, unknown>;
  try {
    const json = JSON.parse(rawBody);
    if (!json || typeof json !== "object") return c.json({ error: "Invalid JSON" }, 400);
    payload = json as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  processDepopWebhookEvent({ topic, webhookId, payload }).catch((err) => {
    reportWebhookFailure("depop", err, { topic });
  });
  return c.body(null, 200);
});

// Resolve the GradeThread owner from a verified seller identifier on the Depop
// payload. Prefers the stable shop id (external_account_id, captured at connect)
// and falls back to the seller username (account_handle). The whole payload was
// signature-verified above, so either match acts on a trusted id.
async function resolveDepopConnectionUserId(
  payload: Record<string, unknown>,
): Promise<string | null> {
  const order = (payload.order ?? payload) as Record<string, unknown>;
  const shop = (order.shop ?? order.seller ?? payload.shop ?? payload.seller ?? {}) as
    | Record<string, unknown>
    | undefined;
  const shopId =
    (order.shop_id != null && String(order.shop_id)) ||
    (order.seller_id != null && String(order.seller_id)) ||
    (shop?.id != null && String(shop.id)) ||
    null;
  const username =
    (typeof order.seller_username === "string" && order.seller_username) ||
    (typeof shop?.username === "string" && shop.username) ||
    null;

  if (shopId) {
    const { data: row } = await supabaseAdmin
      .from("marketplace_connections")
      .select("user_id")
      .eq("marketplace", "depop")
      .eq("external_account_id", shopId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    const uid = (row as { user_id?: string } | null)?.user_id ?? null;
    if (uid) return uid;
  }
  if (username) {
    const { data: row } = await supabaseAdmin
      .from("marketplace_connections")
      .select("user_id")
      .eq("marketplace", "depop")
      .eq("account_handle", username)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    const uid = (row as { user_id?: string } | null)?.user_id ?? null;
    if (uid) return uid;
  }
  return null;
}

// Dispatches a verified Depop webhook: the order is parsed + run through the same
// ingest the manual sync uses (sale capture + refund status + cross-platform
// auto-end). Idempotent: deduped by Depop's delivery id before side effects, and
// the downstream writes are themselves idempotent (sale dedupe by listing_id).
async function processDepopWebhookEvent(args: {
  topic: string;
  webhookId: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  const { topic, webhookId, payload } = args;
  console.log(`[flipdesk-webhooks] Depop event: topic=${topic} id=${webhookId ?? "(no-id)"}`);

  if (webhookId) {
    const claim = await claimWebhookEvent("depop", webhookId, topic);
    if (claim === "duplicate") {
      console.log(`[flipdesk-webhooks] duplicate Depop event id=${webhookId} — skipping`);
      return;
    }
    if (claim === "error") {
      recordMetric("webhook.fail_open", 1, { provider: "depop", topic });
      captureException(
        new Error(`Depop webhook idempotency claim failed; processing fail-open (topic=${topic})`),
        { level: "warn", route: "flipdesk-webhooks.depop", tags: { topic, decision: "fail_open" } },
      );
    }
  }

  recordMetric("webhook.received", 1, { provider: "depop", topic });

  const userId = await resolveDepopConnectionUserId(payload);
  if (!userId) {
    recordMetric("webhook.unmatched_seller", 1, { provider: "depop", topic });
    console.warn(`[flipdesk-webhooks] no active Depop connection matches event topic=${topic} — dropping`);
    return;
  }

  const order = parseDepopOrder(payload.order ?? payload);
  if (!order) {
    console.warn(`[flipdesk-webhooks] Depop ${topic} event had no usable order — dropping`);
    return;
  }
  const res = await handleDepopOrderEvent(userId, order);
  recordMetric("webhook.order_processed", 1, { provider: "depop", topic, kind: res.kind });
  if (res.errors.length > 0) {
    reportWebhookFailure(
      "depop",
      new Error(`${topic} ingest errors: ${res.errors.join(" | ")}`),
      { topic, userId },
    );
  }
  console.log(
    `[flipdesk-webhooks] Depop ${topic} → ${res.kind} (sales_new=${res.salesNew} sold=${res.soldFlipped} status_updated=${res.statusUpdated}) user=${userId}`,
  );
}

// Signature verification lives in lib/ebay-notification-verify.ts so it can be
// unit-tested (with an injected key fixture) without importing this route
// module (and its service-role client).

// US-471/US-472: the linkage candidates eBay commonly carries on order/sale/
// return AND payout payloads — the stable seller userId and the free-text
// username. Centralized so the parking lot (US-472) stores the same fields the
// resolver matches on.
interface EbayLinkCandidates {
  username: string | null;
  ebayUserId: string | null;
}

export function extractEbayCandidates(
  data: Record<string, unknown>,
): EbayLinkCandidates {
  const seller = (data.seller ?? data.user ?? data.payee) as
    | { username?: unknown; userId?: unknown }
    | undefined;
  const username =
    (typeof data.username === "string" && data.username) ||
    (typeof seller?.username === "string" && seller.username) ||
    null;
  const ebayUserId =
    (typeof data.sellerId === "string" && data.sellerId) ||
    (typeof data.payeeId === "string" && data.payeeId) ||
    (typeof data.userId === "string" && data.userId) ||
    (typeof seller?.userId === "string" && seller.userId) ||
    null;
  return { username, ebayUserId };
}

// Resolve the GradeThread user_id from linkage candidates. Prefers the stable,
// signature-verified seller userId (stored as external_account_id) and falls
// back to the seller username (account_handle). Returns null when no active
// connection matches — the caller meters, parks, and drops.
async function resolveEbayConnectionUserId(
  username: string | null,
  ebayUserId: string | null,
): Promise<string | null> {
  if (ebayUserId) {
    const { data: row } = await supabaseAdmin
      .from("marketplace_connections")
      .select("user_id")
      .eq("marketplace", "ebay")
      .eq("external_account_id", ebayUserId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    const uid = (row as { user_id?: string } | null)?.user_id ?? null;
    if (uid) return uid;
  }
  if (username) {
    const { data: row } = await supabaseAdmin
      .from("marketplace_connections")
      .select("user_id")
      .eq("marketplace", "ebay")
      .eq("account_handle", username)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    const uid = (row as { user_id?: string } | null)?.user_id ?? null;
    if (uid) return uid;
  }
  return null;
}

// US-472: park a verified-but-unlinkable event so it isn't lost. The drain cron
// (`/api/jobs/ebay-pending-webhooks`) re-attempts linkage once the connection's
// account_handle / external_account_id hydrates. Deduped by notificationId; a
// best-effort insert (a parking failure must never break the webhook ack).
async function parkUnmatchedEbayEvent(args: {
  bucket: "payout" | "order" | "return" | "listing";
  topic: string;
  notificationId: string | null;
  candidates: EbayLinkCandidates;
  payload: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabaseAdmin
    .from("ebay_pending_webhook_events")
    .insert({
      bucket: args.bucket,
      topic: args.topic,
      notification_id: args.notificationId,
      ebay_username: args.candidates.username,
      ebay_user_id: args.candidates.ebayUserId,
      payload: args.payload,
    });
  // 23505 = the same notification is already parked — a no-op, not an error.
  if (error && error.code !== "23505") {
    console.error(
      "[flipdesk-webhooks] failed to park unmatched eBay event:",
      error.message,
    );
  }
}

// Dispatches a verified eBay notification by topic. Handles:
//   • FINANCES_PAYOUT_*  → payout dedup/ingest (handlePayoutEvent)
//   • order/sale topics  → targeted incremental sync (sold-state detection)
//   • return/cancel/refund topics → same targeted sync, which reverses
//     cancelled/refunded sales and re-activates the item (doListingsPull)
//   • listing lifecycle (ended / closed / unsold / out of stock) → same sync,
//     which is what reconciles the local row's status and its reason (US-2656)
// Everything else is metered (webhook.unhandled_topic) AND logged, so we have a
// dashboard signal for what's arriving — not just a buried console line.
async function processEbayWebhookEvent(
  event: Record<string, unknown>,
): Promise<void> {
  const meta = event.metadata as { topic?: string } | undefined;
  const topic = typeof meta?.topic === "string" ? meta.topic : "(unknown)";
  const notif = event.notification as
    | {
        notificationId?: string;
        eventDate?: string;
        publishDate?: string;
        data?: Record<string, unknown>;
      }
    | undefined;

  const notifId = notif?.notificationId ?? "(no-id)";
  console.log(`[flipdesk-webhooks] eBay event: topic=${topic} id=${notifId}`);

  // Idempotency: dedupe by eBay's notificationId before side effects run, so a
  // re-sent or replayed delivery can't double-ingest a payout/sale. Events
  // without an id can't be deduped here — the payout layer has its own dedup. (US-277)
  if (notif?.notificationId) {
    // US-390: claimWebhookEvent now returns a tri-state. Skip only on a
    // confirmed duplicate; on a claim-write error fall OPEN and process (eBay
    // notifications aren't money-moving and the payout layer has its own dedup).
    const claim = await claimWebhookEvent("ebay", notif.notificationId, topic);
    if (claim === "duplicate") {
      console.log(
        `[flipdesk-webhooks] duplicate eBay event id=${notif.notificationId} — skipping`,
      );
      return;
    }
    // US-509: make the fail-OPEN decision observable. The downstream payout/sale
    // ingest is idempotent (ebay-payout-dedup), so processing without a durable
    // claim is safe — but a claim-write failure must not be invisible.
    if (claim === "error") {
      recordMetric("webhook.fail_open", 1, { provider: "ebay", topic });
      captureException(
        new Error(`eBay webhook idempotency claim failed; processing fail-open (topic=${topic})`),
        { level: "warn", route: "flipdesk-webhooks.ebay", tags: { topic, decision: "fail_open" } },
      );
    }
  }

  const bucket = classifyEbayTopic(topic);
  recordMetric("webhook.received", 1, { provider: "ebay", topic, bucket });

  if (bucket === "payout") {
    await handlePayoutEvent(notif?.data ?? {}, topic, notif?.notificationId ?? null);
    return;
  }

  // Order/sale and return/cancellation topics both drive a targeted incremental
  // sync: doListingsPull pulls orders modified since last_synced_at, flips newly
  // sold items to 'sold', and reverses cancelled/refunded line items back to
  // 'listed' (US-459). One code path serves both buckets — the difference is
  // only which line items the sync finds changed.
  // US-2656: `listing` joins these two rather than getting its own block, and
  // that is the point. All three are answered by the SAME targeted incremental
  // pull - doListingsPull reconciles listing state and orders in one run - so a
  // separate path would be a second way to do the identical thing, free to drift.
  // What the new bucket buys is not a new action but the ARRIVAL: these topics
  // used to classify as `unhandled`, which meant they were never subscribed, so
  // a listing ending on eBay waited for the 30-minute backstop.
  if (bucket === "order" || bucket === "return" || bucket === "listing") {
    const data = notif?.data ?? {};
    const candidates = extractEbayCandidates(data);
    const userId = await resolveEbayConnectionUserId(
      candidates.username,
      candidates.ebayUserId,
    );
    if (!userId) {
      recordMetric("webhook.unmatched_seller", 1, {
        provider: "ebay",
        topic,
        bucket,
      });
      // US-472: don't lose the event. Park it for the drain to re-link once the
      // connection's handle/id hydrates, and meter the no-handle drop.
      recordMetric("webhook.dropped_no_handle", 1, {
        provider: "ebay",
        topic,
        bucket,
      });
      await parkUnmatchedEbayEvent({
        bucket,
        topic,
        notificationId: notif?.notificationId ?? null,
        candidates,
        payload: data,
      });
      console.warn(
        `[flipdesk-webhooks] no active eBay connection matches topic=${topic} id=${notifId} — parked for re-link`,
      );
      return;
    }
    const result = await triggerEbaySyncForUser(userId);
    recordMetric("webhook.sync_triggered", 1, {
      provider: "ebay",
      topic,
      bucket,
      result,
    });
    console.log(
      `[flipdesk-webhooks] eBay ${bucket} event topic=${topic} → sync ${result} for user=${userId}`,
    );
    // US-1055: a return/refund-bucket event means a post-sale issue may have just
    // opened — poll this seller's open returns/disputes so the notification fires
    // promptly (not only on the next scheduled sweep). Deduped + best-effort.
    if (bucket === "return") {
      void pollMarketplaceEventsForUser(userId).catch((err) => {
        console.error(
          "[flipdesk-webhooks] marketplace-event poll failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }
    return;
  }

  // Unhandled: meter it so the rate of unknown topics is visible on a dashboard
  // (US-471), not only discoverable by grepping logs.
  recordMetric("webhook.unhandled_topic", 1, { provider: "ebay", topic });
  console.log(
    `[flipdesk-webhooks] dropping eBay event with unhandled topic: ${topic}`,
  );
}

// Parses an eBay payout-event payload into our internal ParsedPayoutRow shape.
// Returns null when a required field is missing (can't ingest such a row).
export function parsePayoutRow(
  data: Record<string, unknown>,
  topic: string,
): ParsedPayoutRow | null {
  const payoutId = typeof data.payoutId === "string" ? data.payoutId : null;
  const amountObj = (data.amount ?? data.totalNetAmount) as
    | { value?: unknown; currencyCode?: unknown }
    | undefined;
  const amountValueRaw =
    typeof amountObj?.value === "string"
      ? amountObj.value
      : typeof amountObj?.value === "number"
        ? String(amountObj.value)
        : null;
  const amountValue = amountValueRaw ? Number(amountValueRaw) : NaN;
  const currency =
    typeof amountObj?.currencyCode === "string" ? amountObj.currencyCode : "USD";
  const payoutDate =
    typeof data.payoutDate === "string" ? data.payoutDate.slice(0, 10) : null;
  const status =
    typeof data.payoutStatus === "string"
      ? data.payoutStatus
      : topic.replace(/^FINANCES_PAYOUT_/, "");

  if (!payoutId || !Number.isFinite(amountValue) || !payoutDate) {
    console.warn(
      `[flipdesk-webhooks] payout event missing required fields — payoutId=${payoutId} amount=${amountValue} date=${payoutDate}`,
    );
    return null;
  }

  return {
    payoutId,
    payoutDate,
    amount: amountValue,
    currency,
    status,
    raw: {
      ...(data as Record<string, string>),
      topic,
    },
  };
}

// Ingests a parsed payout for a KNOWN user via the same dedup pipeline F1 uses
// for CSV imports. Re-deliveries of the same payoutId+amount+date are a no-op.
// Shared by the live webhook and the parked-event drain (US-472).
async function ingestPayoutForUser(
  userId: string,
  data: Record<string, unknown>,
  topic: string,
): Promise<void> {
  const payoutRow = parsePayoutRow(data, topic);
  if (!payoutRow) return;
  const currency = payoutRow.currency;
  const amountValue = payoutRow.amount;
  try {
    const { inserted, duplicates } = await ingestPayoutsForUser(
      userId,
      [payoutRow],
      "api_sync",
    );
    console.log(
      `[flipdesk-webhooks] payout ${payoutRow.payoutId} processed: inserted=${inserted} duplicates=${duplicates}`,
    );
    // US-737 / US-1054: a genuinely new payout arrived from eBay (async, not a
    // manual CSV upload) → notify so the user knows money landed and can
    // reconcile. In-app + push, preference-gated; idempotent via the ingest dedup.
    if (inserted > 0) {
      void notifyPayoutImported(userId, {
        count: inserted,
        currency,
        amount: amountValue,
      });
    }
  } catch (err) {
    console.error(
      `[flipdesk-webhooks] payout ingest failed for ${payoutRow.payoutId}:`,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

// Live payout-webhook handler: resolve the seller, then ingest. US-472: match on
// the stable eBay userId first (external_account_id) and fall back to the handle
// — and when neither resolves yet (handle/id not hydrated on first connect),
// PARK the verified event so the drain can re-link it, instead of dropping it.
async function handlePayoutEvent(
  data: Record<string, unknown>,
  topic: string,
  notificationId: string | null,
): Promise<void> {
  const candidates = extractEbayCandidates(data);
  const payoutId = typeof data.payoutId === "string" ? data.payoutId : "(no-id)";
  const userId = await resolveEbayConnectionUserId(
    candidates.username,
    candidates.ebayUserId,
  );
  if (!userId) {
    recordMetric("webhook.dropped_no_handle", 1, {
      provider: "ebay",
      topic,
      bucket: "payout",
    });
    await parkUnmatchedEbayEvent({
      bucket: "payout",
      topic,
      notificationId,
      candidates,
      payload: data,
    });
    console.warn(
      `[flipdesk-webhooks] no active eBay connection matches username=${candidates.username} userId=${candidates.ebayUserId} — parked payout event ${payoutId} for re-link`,
    );
    return;
  }
  await ingestPayoutForUser(userId, data, topic);
}

// US-472: scheduled drain of parked events. For each unprocessed parked event we
// re-attempt linkage (the connection's handle/id may have hydrated since). On a
// match we replay the event (payout → ingest, order/return → targeted sync) and
// mark it linked; otherwise we increment attempts and, past the cap, dead-letter
// it so the table stays bounded and the operator can fall back to a CSV import.
const PENDING_MAX_ATTEMPTS = 8;
const PENDING_DRAIN_BATCH = 100;

interface PendingDrainResult {
  scanned: number;
  linked: number;
  retried: number;
  dead_lettered: number;
}

interface PendingEventRow {
  id: string;
  bucket: "payout" | "order" | "return" | "listing";
  topic: string;
  ebay_username: string | null;
  ebay_user_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function drainPendingEbayWebhookEvents(): Promise<PendingDrainResult> {
  const { data, error } = await supabaseAdmin
    .from("ebay_pending_webhook_events")
    .select("id, bucket, topic, ebay_username, ebay_user_id, payload, attempts")
    .is("processed_at", null)
    .order("created_at", { ascending: true })
    .limit(PENDING_DRAIN_BATCH);
  if (error) {
    captureException(error, { route: "ebay-pending-webhooks.scan" });
    throw new Error(`pending-webhook drain scan failed: ${error.message}`);
  }

  const rows = (data ?? []) as PendingEventRow[];
  let linked = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const row of rows) {
    const userId = await resolveEbayConnectionUserId(
      row.ebay_username,
      row.ebay_user_id,
    );
    const attempts = row.attempts + 1;

    if (!userId) {
      if (attempts >= PENDING_MAX_ATTEMPTS) {
        await supabaseAdmin
          .from("ebay_pending_webhook_events")
          .update({
            attempts,
            last_attempt_at: new Date().toISOString(),
            processed_at: new Date().toISOString(),
            outcome: "dead_letter",
            last_error: "no matching connection after max attempts",
          })
          .eq("id", row.id);
        deadLettered += 1;
        recordMetric("webhook.pending_dead_lettered", 1, {
          provider: "ebay",
          bucket: row.bucket,
        });
        captureException(
          new Error(
            `eBay webhook dead-lettered after ${attempts} attempts (bucket=${row.bucket}, topic=${row.topic}) — seller never linked; CSV fallback needed`,
          ),
          {
            level: "warn",
            route: "ebay-pending-webhooks",
            tags: { bucket: row.bucket, topic: row.topic },
            extra: { id: row.id },
          },
        );
        continue;
      }
      await supabaseAdmin
        .from("ebay_pending_webhook_events")
        .update({
          attempts,
          last_attempt_at: new Date().toISOString(),
          last_error: "no matching connection (handle/id not yet hydrated)",
        })
        .eq("id", row.id);
      retried += 1;
      continue;
    }

    // Linkage succeeded — replay the event.
    try {
      if (row.bucket === "payout") {
        await ingestPayoutForUser(userId, row.payload, row.topic);
      } else {
        // order/return → the same targeted incremental sync the live path runs.
        await triggerEbaySyncForUser(userId);
      }
      await supabaseAdmin
        .from("ebay_pending_webhook_events")
        .update({
          attempts,
          last_attempt_at: new Date().toISOString(),
          processed_at: new Date().toISOString(),
          outcome: "linked",
          last_error: null,
        })
        .eq("id", row.id);
      linked += 1;
      recordMetric("webhook.pending_linked", 1, {
        provider: "ebay",
        bucket: row.bucket,
      });
    } catch (err) {
      // Transient dispatch failure — leave unprocessed for the next sweep.
      await supabaseAdmin
        .from("ebay_pending_webhook_events")
        .update({
          attempts,
          last_attempt_at: new Date().toISOString(),
          last_error: err instanceof Error ? err.message.slice(0, 500) : String(err),
        })
        .eq("id", row.id);
      retried += 1;
    }
  }

  if (rows.length > 0) {
    recordMetric("webhook.pending_drain", rows.length, {
      provider: "ebay",
      linked,
      retried,
      dead_lettered: deadLettered,
    });
  }
  return { scanned: rows.length, linked, retried, dead_lettered: deadLettered };
}

// Cron entry point. OUTSIDE /api/* JWT groups; guards with the shared job secret
// and an overlap lock (mirrors the other crons).
export async function handleEbayPendingWebhooksCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  // US-2311: lease is 2x the */15 schedule interval. At <= 1x, a run
  // that overruns by a second is displaced by the very next tick.
  const lock = await acquireJobLock("ebay-pending-webhooks", 1800);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await drainPendingEbayWebhookEvents();
    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "ebay-pending-webhooks.cron" });
    return c.json({ error: "Pending-webhook drain failed" }, 500);
  } finally {
    await lock.release();
  }
}

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

// US-1426: the account-deletion handler deactivates marketplace_connections
// (nulling OAuth tokens). If a deactivation UPDATE errors we must NOT ack with a
// clean 204 — the connection + long-lived refresh token would persist while eBay
// treats the deletion as acknowledged (a compliance + lingering-credential risk).
// Decide "retry" on ANY update error so the caller releases the idempotency claim
// and returns a non-2xx (eBay retries non-2xx); "ack" only when both updates were
// clean.
export type AccountDeletionOutcome = "ack" | "retry";

export function accountDeletionOutcome(
  updateErrors: Array<{ message?: string } | null | undefined>,
): AccountDeletionOutcome {
  return updateErrors.some((e) => !!e) ? "retry" : "ack";
}

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
  // US-349: this endpoint is public (no auth middleware) and performs a
  // destructive mutation (deactivating a seller's eBay connection + nulling
  // tokens). It MUST authenticate the request BEFORE any DB write — an
  // unauthenticated POST previously let anyone mass-disconnect sellers (and
  // flood the table). Verify the signature/token over the RAW body first.
  const verificationToken = Deno.env.get("EBAY_VERIFICATION_TOKEN");
  if (!verificationToken) {
    console.error(
      "[flipdesk-webhooks] EBAY_VERIFICATION_TOKEN is not set; refusing account-deletion notification",
    );
    return c.json({ error: "Webhook not configured" }, 503);
  }

  // Raw bytes are required for HMAC verification (re-serializing JSON would
  // change the bytes and break the signature).
  const rawBody = await c.req.text();
  // Signature-bypass is honored ONLY outside production (sandbox testing),
  // identical to the /ebay receiver. In prod this is always false.
  const debug = isDebugAllowed("WEBHOOK_PAYOUT_DEBUG");
  const signatureHeader =
    c.req.header("x-ebay-signature") ??
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";

  if (!debug) {
    if (!signatureHeader) {
      console.warn(
        "[flipdesk-webhooks] eBay account-deletion rejected: missing signature header",
      );
      return c.json({ error: "Missing signature" }, 401);
    }
    // eBay signs account-deletion notifications with its OWN key (verified via
    // eBay's published public key), NOT an HMAC of our verification token.
    const ok = await verifyEbayNotification(rawBody, signatureHeader);
    if (!ok) {
      console.warn(
        "[flipdesk-webhooks] eBay account-deletion rejected: signature mismatch",
      );
      return c.json({ error: "Invalid signature" }, 401);
    }
  }

  // Only AFTER verification do we parse + mutate.
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
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const username = body.notification?.data?.username;
  const ebayUserId = body.notification?.data?.userId;
  const notificationId = body.notification?.notificationId;

  console.log(
    `[flipdesk-webhooks] eBay account-deletion notification id=${notificationId} username=${username} userId=${ebayUserId}`
  );

  // Idempotency: a verified re-delivery must not run the mutation or write a
  // second compliance row. Dedupe by eBay's notificationId before side effects.
  if (notificationId) {
    // US-390: tri-state claim — skip only on a confirmed duplicate; fall open
    // (process) on a claim-write error so a real deletion request isn't dropped.
    const claim = await claimWebhookEvent("ebay", notificationId, "MARKETPLACE_ACCOUNT_DELETION");
    if (claim === "duplicate") {
      console.log(
        `[flipdesk-webhooks] duplicate eBay account-deletion id=${notificationId} — skipping`,
      );
      return c.body(null, 204);
    }
    // US-509: the deletion handler is idempotent (it no-ops if the user is
    // already purged), so fail-open is safe — but a dropped claim on a
    // COMPLIANCE event must be loud, not a lone console.error.
    if (claim === "error") {
      recordMetric("webhook.fail_open", 1, {
        provider: "ebay",
        topic: "MARKETPLACE_ACCOUNT_DELETION",
      });
      captureException(
        new Error("eBay account-deletion idempotency claim failed; processing fail-open"),
        {
          level: "warn",
          route: "flipdesk-webhooks.account-deletion",
          tags: { topic: "MARKETPLACE_ACCOUNT_DELETION", decision: "fail_open" },
        },
      );
    }
  }

  // Deactivate the connection(s) for the deleted eBay account. US-364: match on
  // eBay's STABLE, signature-verified `userId` (stored as external_account_id at
  // connect/refresh) — NOT the free-text `username`, which is guessable and can
  // change. The handle match is kept ONLY as a fallback for legacy rows that
  // pre-date the external_account_id backfill. The whole payload was already
  // signature-verified above, so either match is acting on a trusted id.
  let connectionsDeactivated = 0;
  const deactivatePatch = {
    is_active: false,
    access_token_encrypted: null,
    refresh_token_encrypted: null,
    refresh_error: "account_deleted",
  };
  const matchedIds = new Set<string>();
  const deactivateErrors: Array<{ message?: string } | null> = [];
  if (ebayUserId) {
    const { data: updated, error } = await supabaseAdmin
      .from("marketplace_connections")
      .update(deactivatePatch)
      .eq("marketplace", "ebay")
      .eq("external_account_id", ebayUserId)
      .select("id");
    if (error) {
      deactivateErrors.push(error);
      console.error(
        "[flipdesk-webhooks] failed to deactivate eBay connection by id on deletion:",
        error,
      );
    } else {
      for (const r of updated ?? []) matchedIds.add(r.id as string);
    }
  }
  // Legacy fallback: rows without a stored external_account_id, matched by the
  // verified handle. Scoped to `external_account_id IS NULL` so we never use the
  // weaker handle match on a row that already has the stable id.
  if (username) {
    const { data: updated, error } = await supabaseAdmin
      .from("marketplace_connections")
      .update(deactivatePatch)
      .eq("marketplace", "ebay")
      .eq("account_handle", username)
      .is("external_account_id", null)
      .select("id");
    if (error) {
      deactivateErrors.push(error);
      console.error(
        "[flipdesk-webhooks] failed to deactivate eBay connection by handle on deletion:",
        error,
      );
    } else {
      for (const r of updated ?? []) matchedIds.add(r.id as string);
    }
  }
  connectionsDeactivated = matchedIds.size;

  // US-3042: deactivating the seller's connection is only half the requirement,
  // and it is the half that applies to the RARER case. eBay addresses this
  // notification to the application, and most of the accounts it names are
  // BUYERS whose usernames we hold because they bought from one of our sellers.
  // For those, everything above matches nothing and changes nothing. Erase them
  // across every table that carries eBay buyer identity — including the `raw`
  // eBay payloads, which name the person even after the username column is
  // nulled. See lib/ebay-buyer-erasure.ts for why this one write is deliberately
  // NOT tenant-scoped.
  const erasure = await eraseEbayBuyer({ userId: ebayUserId, username });
  for (const e of erasure.errors) deactivateErrors.push({ message: e.message });

  // US-1426: a destructive-mutation failure must NOT be acked as a clean 204.
  // Capture, release the idempotency claim so eBay's retry re-runs the
  // deactivation, and return non-2xx (eBay retries non-2xx) — otherwise the
  // connection + long-lived refresh token linger while eBay considers the
  // account deleted.
  if (accountDeletionOutcome(deactivateErrors) === "retry") {
    recordMetric("webhook.process_failed", 1, {
      provider: "ebay",
      topic: "MARKETPLACE_ACCOUNT_DELETION",
    });
    captureException(
      new Error(
        `eBay account-deletion deactivation failed: ${
          deactivateErrors.map((e) => e?.message ?? "unknown").join("; ")
        }`,
      ),
      {
        level: "error",
        route: "flipdesk-webhooks.account-deletion",
        tags: { topic: "MARKETPLACE_ACCOUNT_DELETION", decision: "retry" },
      },
    );
    if (notificationId) {
      await releaseWebhookEvent("ebay", notificationId);
    }
    return c.json({ error: "Deactivation failed; will retry" }, 500);
  }

  // Compliance record (US-349): proof we received + acted on the deletion. Its
  // own purpose-built table — NOT account_deletion_log, which is GradeThread
  // account erasure. Best-effort: a logging failure must not break the ack.
  const { error: logErr } = await supabaseAdmin
    .from("ebay_account_deletion_log")
    .insert({
      notification_id: notificationId ?? null,
      ebay_username: username ?? null,
      ebay_user_id: ebayUserId ?? null,
      connections_deactivated: connectionsDeactivated,
      buyer_rows_erased: erasure.totalRows,
    });
  if (logErr && logErr.code !== "23505") {
    console.error(
      "[flipdesk-webhooks] account-deletion compliance log insert failed:",
      logErr.message,
    );
  }

  // Acknowledge promptly. eBay retries non-2xx responses.
  return c.body(null, 204);
});
