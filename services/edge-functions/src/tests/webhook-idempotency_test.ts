// US-390: single, fail-closed webhook idempotency claim.
//
// claimWebhookEvent is the authoritative dedup. These tests pin its tri-state
// contract via an injected inserter (no DB), including the duplicate-delivery
// path for the money events the AC calls out (charge.refunded,
// checkout.session.completed).
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  claimWebhookEvent,
  failIfDbError,
  isTransientWebhookError,
  releaseWebhookEvent,
  TransientWebhookError,
  type WebhookEventDeleter,
  type WebhookEventInserter,
} from "../lib/webhook-idempotency.ts";

// In-memory processed_webhook_events with a unique (provider,event_id) PK that
// raises 23505 on a duplicate insert — exactly like Postgres. Returns a matching
// deleter so the release-then-reprocess path (US-397) can be exercised too.
function memoryStore(): { insert: WebhookEventInserter; del: WebhookEventDeleter } {
  const seen = new Set<string>();
  return {
    insert: (row) => {
      const key = `${row.provider}:${row.event_id}`;
      if (seen.has(key)) {
        return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
      }
      seen.add(key);
      return Promise.resolve({ error: null });
    },
    del: (provider, eventId) => {
      seen.delete(`${provider}:${eventId}`);
      return Promise.resolve({ error: null });
    },
  };
}

Deno.test("first delivery is claimed, second is a duplicate", async () => {
  const { insert } = memoryStore();
  assertEquals(await claimWebhookEvent("stripe", "evt_1", "charge.refunded", insert), "claimed");
  assertEquals(await claimWebhookEvent("stripe", "evt_1", "charge.refunded", insert), "duplicate");
});

Deno.test("distinct event ids are each claimed once", async () => {
  const { insert } = memoryStore();
  assertEquals(await claimWebhookEvent("stripe", "evt_a", "checkout.session.completed", insert), "claimed");
  assertEquals(await claimWebhookEvent("stripe", "evt_b", "checkout.session.completed", insert), "claimed");
  assertEquals(await claimWebhookEvent("stripe", "evt_a", "checkout.session.completed", insert), "duplicate");
});

Deno.test("a transient (non-23505) DB error returns 'error' (caller fails closed)", async () => {
  const failing: WebhookEventInserter = () =>
    Promise.resolve({ error: { code: "57014", message: "statement timeout" } });
  assertEquals(await claimWebhookEvent("stripe", "evt_x", "invoice.payment_succeeded", failing), "error");
});

Deno.test("duplicate-delivery of charge.refunded + checkout.session.completed is processed once", async () => {
  const { insert } = memoryStore();
  // Two money events, each delivered twice (Stripe retry). Only the first
  // delivery of each should be processed.
  const deliveries = [
    "charge.refunded",
    "checkout.session.completed",
    "charge.refunded", // retry
    "checkout.session.completed", // retry
  ];
  const ids = ["evt_refund", "evt_checkout", "evt_refund", "evt_checkout"];
  const processed: string[] = [];
  for (let i = 0; i < deliveries.length; i++) {
    const claim = await claimWebhookEvent("stripe", ids[i]!, deliveries[i], insert);
    if (claim === "claimed") processed.push(ids[i]!);
    else assertEquals(claim, "duplicate");
  }
  // Each money event's side effect ran exactly once.
  assertEquals(processed, ["evt_refund", "evt_checkout"]);
});

Deno.test("eBay claims share the same store but a different provider namespace", async () => {
  const { insert } = memoryStore();
  // Same id under two providers must not collide.
  assertEquals(await claimWebhookEvent("stripe", "id_1", "t", insert), "claimed");
  assertEquals(await claimWebhookEvent("ebay", "id_1", "t", insert), "claimed");
  assert((await claimWebhookEvent("ebay", "id_1", "t", insert)) === "duplicate");
});

// ── US-397: transient classification + release-then-reprocess ────

Deno.test("failIfDbError throws a TransientWebhookError only on a DB error", () => {
  // No error → no throw.
  failIfDbError(null, "ctx");
  failIfDbError(undefined, "ctx");
  // Error → throws a classifiable transient error.
  const err = assertThrows(
    () => failIfDbError({ code: "57014", message: "statement timeout" }, "subscription update"),
    TransientWebhookError,
  );
  assert(isTransientWebhookError(err));
  assert(err.message.includes("subscription update"));
});

Deno.test("isTransientWebhookError distinguishes transient from code bugs", () => {
  assert(isTransientWebhookError(new TransientWebhookError("db down")));
  assert(!isTransientWebhookError(new TypeError("cannot read x of undefined")));
  assert(!isTransientWebhookError(new Error("boom")));
  assert(!isTransientWebhookError("string"));
});

Deno.test("release lets Stripe's retry re-process (claim → release → claim again)", async () => {
  const { insert, del } = memoryStore();
  // First delivery claims the event.
  assertEquals(await claimWebhookEvent("stripe", "evt_t", "invoice.payment_succeeded", insert), "claimed");
  // A transient handler failure releases the claim (US-397).
  await releaseWebhookEvent("stripe", "evt_t", del);
  // Stripe re-delivers → the event is claimable again (not stuck as duplicate).
  assertEquals(await claimWebhookEvent("stripe", "evt_t", "invoice.payment_succeeded", insert), "claimed");
  // Once it finally succeeds (no release), a later retry is correctly deduped.
  assertEquals(await claimWebhookEvent("stripe", "evt_t", "invoice.payment_succeeded", insert), "duplicate");
});
