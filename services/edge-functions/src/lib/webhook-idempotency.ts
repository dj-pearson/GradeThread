import { supabaseAdmin } from "./supabase.ts";

// Webhook idempotency guard (US-277). Atomically claims an inbound event by
// inserting into processed_webhook_events (PK: provider, event_id).
//
// Returns true  → first time we've seen this event; the caller SHOULD process.
// Returns false → duplicate delivery (Stripe retry / eBay re-send / replay);
//                 the caller should skip all side effects.
//
// On an unexpected DB error (not a unique violation) it fails OPEN (returns
// true) so a transient blip never silently drops a real event — at worst the
// event is processed twice, which the handlers' own per-resource guards and
// downstream dedup (e.g. payout dedup) already tolerate.
export async function claimWebhookEvent(
  provider: "stripe" | "ebay",
  eventId: string,
  eventType?: string,
): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("processed_webhook_events")
    .insert({ provider, event_id: eventId, event_type: eventType ?? null });

  if (!error) return true;
  if (error.code === "23505") return false; // unique_violation → already processed

  console.error(
    `[webhook-idempotency] claim failed for ${provider}:${eventId} — ${error.message}`,
  );
  return true; // fail-open
}
