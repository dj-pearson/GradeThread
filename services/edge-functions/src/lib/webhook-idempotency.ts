import { supabaseAdmin } from "./supabase.ts";

// Webhook idempotency guard (US-277, US-397). Atomically claims an inbound
// event by inserting into processed_webhook_events (PK: provider, event_id).
//
//   "claimed"   → first time we've seen this event; the caller SHOULD process.
//   "duplicate" → already processed (Stripe retry / eBay re-send / replay);
//                 the caller should skip all side effects and 200.
//   "error"     → the claim INSERT itself failed (transient DB blip). The
//                 caller decides: critical money events fail CLOSED (return a
//                 non-2xx so the provider retries) — US-397; best-effort events
//                 may fail open and process anyway.
export type ClaimResult = "claimed" | "duplicate" | "error";

export async function claimWebhookEventResult(
  provider: "stripe" | "ebay",
  eventId: string,
  eventType?: string,
): Promise<ClaimResult> {
  const { error } = await supabaseAdmin
    .from("processed_webhook_events")
    .insert({ provider, event_id: eventId, event_type: eventType ?? null });

  if (!error) return "claimed";
  if (error.code === "23505") return "duplicate"; // unique_violation → already processed

  console.error(
    `[webhook-idempotency] claim failed for ${provider}:${eventId} — ${error.message}`,
  );
  return "error";
}

// Backward-compatible boolean wrapper (fail-OPEN on claim error): used by
// best-effort callers (eBay notifications) where double-processing is tolerated
// by downstream dedup. Returns true → process, false → skip.
export async function claimWebhookEvent(
  provider: "stripe" | "ebay",
  eventId: string,
  eventType?: string,
): Promise<boolean> {
  const result = await claimWebhookEventResult(provider, eventId, eventType);
  return result !== "duplicate"; // "claimed" or "error" (fail-open) → process
}

// US-397: release a claim so the provider's retry can re-process the event.
// Called when a CRITICAL handler fails mid-flight (e.g. a DB write error) and we
// return a non-2xx: without releasing, the retry would hit the existing claim
// and be skipped as a duplicate, silently dropping the money event.
export async function releaseWebhookClaim(
  provider: "stripe" | "ebay",
  eventId: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("processed_webhook_events")
    .delete()
    .eq("provider", provider)
    .eq("event_id", eventId);
  if (error) {
    console.error(
      `[webhook-idempotency] release failed for ${provider}:${eventId} — ${error.message}`,
    );
  }
}
