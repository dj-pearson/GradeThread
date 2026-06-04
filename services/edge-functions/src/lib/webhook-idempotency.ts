import { supabaseAdmin } from "./supabase.ts";

// Webhook idempotency guard (US-277, hardened in US-390). The SINGLE
// authoritative idempotency claim: it atomically claims an inbound event by
// inserting into processed_webhook_events (PK: provider, event_id).
//
//   "claimed"   → first time we've seen this event; the caller SHOULD process.
//   "duplicate" → already processed (Stripe retry / eBay re-send / replay);
//                 the caller MUST skip all side effects and return 2xx.
//   "error"     → the claim could not be written (transient DB failure). The
//                 caller MUST fail CLOSED for money/critical events — return a
//                 non-2xx so Stripe re-delivers — because without a durable
//                 claim a later retry could double-apply credits/resets. (The
//                 OLD behavior was to fail OPEN and process anyway, which is
//                 unsafe for money events; US-390.)
//
// `insert` is injectable so the tri-state logic is unit-testable without a DB
// (mirrors the rate-limit / plan-gate injectable-deps pattern).

export type WebhookClaimResult = "claimed" | "duplicate" | "error";

export interface WebhookEventInsert {
  provider: "stripe" | "ebay";
  event_id: string;
  event_type: string | null;
}

export type WebhookEventInserter = (
  row: WebhookEventInsert,
) => Promise<{ error: { code?: string; message?: string } | null }>;

const defaultInsert: WebhookEventInserter = async (row) => {
  const { error } = await supabaseAdmin
    .from("processed_webhook_events")
    .insert(row);
  return { error };
};

export async function claimWebhookEvent(
  provider: "stripe" | "ebay",
  eventId: string,
  eventType?: string,
  insert: WebhookEventInserter = defaultInsert,
): Promise<WebhookClaimResult> {
  const { error } = await insert({
    provider,
    event_id: eventId,
    event_type: eventType ?? null,
  });

  if (!error) return "claimed";
  if (error.code === "23505") return "duplicate"; // unique_violation → seen before

  console.error(
    `[webhook-idempotency] claim failed for ${provider}:${eventId} — ${error.message}`,
  );
  return "error"; // fail CLOSED — caller decides (critical events → non-2xx).
}
