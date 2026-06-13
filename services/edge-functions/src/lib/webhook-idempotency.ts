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
  provider: "stripe" | "ebay" | "appstore" | "shopify" | "depop";
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
  provider: "stripe" | "ebay" | "appstore" | "shopify" | "depop",
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

// US-397: a TRANSIENT failure inside a critical webhook handler (a DB write that
// returned an error). It must trigger a Stripe retry, so the caller RELEASES
// the idempotency claim and returns non-2xx. Distinct from a code bug (any other
// thrown error), which a retry can't fix and which instead keeps the claim +
// alerts (so Stripe doesn't storm a permanently-failing event).
export class TransientWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientWebhookError";
  }
}

export function isTransientWebhookError(err: unknown): err is TransientWebhookError {
  return err instanceof TransientWebhookError;
}

// Throw a TransientWebhookError when a Supabase `{ error }` write failed. Use at
// every money/state-transition write in a critical handler so a transient DB
// blip propagates to the dispatcher (which releases the claim + 500s) instead
// of being swallowed with a 200 that drops the event.
export function failIfDbError(
  error: { code?: string; message?: string } | null | undefined,
  context: string,
): void {
  if (error) {
    throw new TransientWebhookError(
      `${context}: ${error.code ?? ""} ${error.message ?? ""}`.trim(),
    );
  }
}

// Release a previously-claimed event so Stripe's retry can re-process it. Used
// only on a transient critical-handler failure (US-397); side effects are
// idempotent on the Stripe object id (US-390) so the re-run is safe.
export type WebhookEventDeleter = (
  provider: "stripe" | "ebay" | "appstore" | "shopify" | "depop",
  eventId: string,
) => Promise<{ error: { message?: string } | null }>;

const defaultDelete: WebhookEventDeleter = async (provider, eventId) => {
  const { error } = await supabaseAdmin
    .from("processed_webhook_events")
    .delete()
    .eq("provider", provider)
    .eq("event_id", eventId);
  return { error };
};

export async function releaseWebhookEvent(
  provider: "stripe" | "ebay" | "appstore" | "shopify" | "depop",
  eventId: string,
  del: WebhookEventDeleter = defaultDelete,
): Promise<void> {
  const { error } = await del(provider, eventId);
  if (error) {
    // If we can't release the claim, the retry will dedupe and skip — log loudly
    // so the dropped transition is visible. (Better than not failing closed.)
    console.error(
      `[webhook-idempotency] FAILED to release claim ${provider}:${eventId} — ${error.message}. ` +
        `Stripe's retry will be deduped; this event may need manual replay.`,
    );
  }
}
