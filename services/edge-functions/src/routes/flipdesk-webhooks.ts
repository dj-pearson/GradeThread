import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { ingestPayoutsForUser } from "../lib/ebay-payout-dedup.ts";
import type { ParsedPayoutRow } from "../lib/ebay-payouts-csv.ts";

// Inbound webhooks for FlipDesk integrations.
// These endpoints are public (no auth middleware) — they MUST verify a
// signature or shared-secret on the payload.

export const flipdeskWebhookRoutes = new Hono();

// eBay Notification API receiver: order created, paid, shipped, payout,
// return, etc. Verification: HMAC-SHA256 over the raw body using
// EBAY_VERIFICATION_TOKEN, presented in the `x-ebay-signature` header.
//
// Returns 204 within milliseconds so eBay's retry timer doesn't fire.
// Heavy lifting (event parsing, payout dedup + insert) is deferred to
// processEbayWebhookEvent in the lib layer.
//
// Sandbox tip: set WEBHOOK_PAYOUT_DEBUG=true to log the raw payload +
// headers and SKIP signature verification while you confirm eBay's exact
// signature scheme matches expectations. See W4 doc comment for details.
flipdeskWebhookRoutes.post("/ebay", async (c) => {
  const verificationToken = Deno.env.get("EBAY_VERIFICATION_TOKEN");
  if (!verificationToken) {
    console.warn("[flipdesk-webhooks] EBAY_VERIFICATION_TOKEN not configured");
    return c.json({ error: "Webhook not configured" }, 503);
  }

  // Read the body as TEXT first — HMAC verification requires the exact
  // bytes eBay sent, not a re-serialized object.
  const rawBody = await c.req.text();
  const debug = Deno.env.get("WEBHOOK_PAYOUT_DEBUG") === "true";

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
    const ok = await verifyEbayHmac(rawBody, signatureHeader, verificationToken);
    if (!ok) {
      console.warn(
        "[flipdesk-webhooks] eBay event rejected: signature mismatch",
      );
      return c.json({ error: "Invalid signature" }, 401);
    }
  }

  // Dispatch async. Don't block the 204 — eBay penalizes slow handlers.
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  processEbayWebhookEvent(parsed).catch((err) => {
    console.error(
      "[flipdesk-webhooks] eBay event processing failed:",
      err instanceof Error ? err.message : String(err),
    );
  });

  return c.body(null, 204);
});

// Constant-time HMAC-SHA256 verification using the verification token as
// the shared secret. eBay's spec is hex-encoded; we also accept base64 in
// case a future schema flips formats.
async function verifyEbayHmac(
  body: string,
  presented: string,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const expectedHex = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expectedB64 = btoa(
    String.fromCharCode(...new Uint8Array(sigBytes)),
  );
  // Trim a common `sha256=` prefix some webhook senders use.
  const cleaned = presented.replace(/^sha256=/i, "").trim();
  return (
    constantTimeEqual(cleaned.toLowerCase(), expectedHex.toLowerCase()) ||
    constantTimeEqual(cleaned, expectedB64)
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// Dispatches a verified eBay notification by topic. Currently handles the
// FINANCES_PAYOUT_* family — initiated, paid, failed. All other topics
// are logged and dropped (order events still flow through the polling
// sync). Future topics can be added incrementally without touching the
// receiver or signature-verify path.
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

  if (topic.startsWith("FINANCES_PAYOUT")) {
    await handlePayoutEvent(notif?.data ?? {}, topic);
    return;
  }

  // Known but unhandled — log so we know what's arriving when we add more.
  console.log(
    `[flipdesk-webhooks] dropping eBay event with unhandled topic: ${topic}`,
  );
}

// Parses an eBay payout-event payload into our internal ParsedPayoutRow
// shape and inserts via the same dedup pipeline F1 uses for CSV imports.
// Re-deliveries of the same payoutId+amount+date are a no-op.
async function handlePayoutEvent(
  data: Record<string, unknown>,
  topic: string,
): Promise<void> {
  const payoutId = typeof data.payoutId === "string" ? data.payoutId : null;
  const username = (data.user as { username?: unknown } | undefined)?.username;
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

  if (!payoutId || !Number.isFinite(amountValue) || !payoutDate || !username) {
    console.warn(
      `[flipdesk-webhooks] payout event missing required fields — payoutId=${payoutId} amount=${amountValue} date=${payoutDate} username=${username}`,
    );
    return;
  }

  // Map eBay seller username → marketplace_connections.user_id. If the
  // handle hasn't been populated yet (NULL on first connect), we can't
  // match and have to drop. The user can either re-trigger a sync (which
  // hydrates the handle) or fall back to CSV upload.
  const { data: connRow } = await supabaseAdmin
    .from("marketplace_connections")
    .select("user_id")
    .eq("marketplace", "ebay")
    .eq("account_handle", username as string)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  const userId = (connRow as { user_id?: string } | null)?.user_id ?? null;
  if (!userId) {
    console.warn(
      `[flipdesk-webhooks] no active eBay connection matches username=${username} — dropping payout event ${payoutId}`,
    );
    return;
  }

  const payoutRow: ParsedPayoutRow = {
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

  try {
    const { inserted, duplicates } = await ingestPayoutsForUser(
      userId,
      [payoutRow],
      "api_sync",
    );
    console.log(
      `[flipdesk-webhooks] payout ${payoutId} processed: inserted=${inserted} duplicates=${duplicates}`,
    );
  } catch (err) {
    console.error(
      `[flipdesk-webhooks] payout ingest failed for ${payoutId}:`,
      err instanceof Error ? err.message : String(err),
    );
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
