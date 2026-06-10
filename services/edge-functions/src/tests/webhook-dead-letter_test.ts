// US-772: dead-letter capture + the /stripe dispatcher's drop-vs-retry policy.
//
// webhook-dead-letter.ts and webhooks.ts both import the service-role supabase
// client at module init, so set dummy env BEFORE the dynamic imports.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { recordWebhookDeadLetter } = await import("../lib/webhook-dead-letter.ts");
const { handleWebhookDispatchError } = await import("../routes/webhooks.ts");
const { TransientWebhookError } = await import("../lib/webhook-idempotency.ts");

import type { DeadLetterRow } from "../lib/webhook-dead-letter.ts";

// ── recordWebhookDeadLetter ──────────────────────────────────────

Deno.test("dead letter: writes a row with the expected fields and returns true", async () => {
  let captured: DeadLetterRow | null = null;
  const ok = await recordWebhookDeadLetter(
    {
      provider: "stripe",
      eventId: "evt_abc",
      eventType: "checkout.session.completed",
      payload: { id: "cs_1", amount_total: 1299 },
      errorMessage: "TypeError: cannot read foo of undefined",
    },
    (row) => {
      captured = row;
      return Promise.resolve({ error: null });
    },
  );

  assert(ok, "expected a successful write to return true");
  assert(captured !== null, "inserter should have been called");
  const row = captured as DeadLetterRow;
  assertEquals(row.provider, "stripe");
  assertEquals(row.event_id, "evt_abc");
  assertEquals(row.event_type, "checkout.session.completed");
  assertEquals(row.error_message, "TypeError: cannot read foo of undefined");
  assertEquals((row.payload as { amount_total: number }).amount_total, 1299);
});

Deno.test("dead letter: PII in the payload is redacted before storage", async () => {
  let captured: DeadLetterRow | null = null;
  await recordWebhookDeadLetter(
    {
      provider: "stripe",
      eventId: "evt_pii",
      eventType: "charge.refunded",
      payload: { customer_email: "buyer@example.com", id: "ch_1" },
      errorMessage: "boom",
    },
    (row) => {
      captured = row;
      return Promise.resolve({ error: null });
    },
  );
  const serialized = JSON.stringify((captured as unknown as DeadLetterRow).payload);
  assert(!serialized.includes("buyer@example.com"), "raw email must not be stored");
  assert(serialized.includes("[redacted:email]"), "email should be redacted in place");
});

Deno.test("dead letter: a non-duplicate write error returns false and never throws", async () => {
  const ok = await recordWebhookDeadLetter(
    {
      provider: "stripe",
      eventId: "evt_err",
      eventType: "x",
      payload: {},
      errorMessage: "boom",
    },
    () => Promise.resolve({ error: { code: "08006", message: "connection failed" } }),
  );
  assertEquals(ok, false);
});

Deno.test("dead letter: a duplicate (23505) is treated as success", async () => {
  const ok = await recordWebhookDeadLetter(
    {
      provider: "stripe",
      eventId: "evt_dup",
      eventType: "x",
      payload: {},
      errorMessage: "boom",
    },
    () => Promise.resolve({ error: { code: "23505", message: "duplicate key" } }),
  );
  assertEquals(ok, true);
});

Deno.test("dead letter: a thrown inserter is swallowed (returns false, never throws)", async () => {
  const ok = await recordWebhookDeadLetter(
    {
      provider: "stripe",
      eventId: "evt_throw",
      eventType: "x",
      payload: {},
      errorMessage: "boom",
    },
    () => {
      throw new Error("network down");
    },
  );
  assertEquals(ok, false);
});

// ── handleWebhookDispatchError (the /stripe drop-vs-retry policy) ─

function fakeDeps() {
  const calls = { released: [] as string[], captured: [] as string[], deadLettered: [] as string[] };
  return {
    calls,
    deps: {
      release: (eventId: string) => {
        calls.released.push(eventId);
        return Promise.resolve();
      },
      capture: (eventId: string) => {
        calls.captured.push(eventId);
      },
      deadLetter: (args: { eventId: string }) => {
        calls.deadLettered.push(args.eventId);
        return Promise.resolve();
      },
    },
  };
}

const EVT = {
  id: "evt_1",
  type: "checkout.session.completed",
  data: { object: { id: "cs_1" } },
} as unknown as import("stripe").Stripe.Event;

Deno.test("dispatch: a transient error returns 500 and releases the claim WITHOUT dead-lettering", async () => {
  const { calls, deps } = fakeDeps();
  const decision = await handleWebhookDispatchError(
    new TransientWebhookError("db blip"),
    EVT,
    deps,
  );
  assertEquals(decision.retry, true); // → caller returns 500
  assertEquals(calls.released, ["evt_1"]);
  assertEquals(calls.deadLettered, []); // a transient error is NOT dead-lettered
});

Deno.test("dispatch: a code-bug error returns 200, dead-letters, and does NOT release", async () => {
  const { calls, deps } = fakeDeps();
  const decision = await handleWebhookDispatchError(
    new TypeError("cannot read x of undefined"),
    EVT,
    deps,
  );
  assertEquals(decision.retry, false); // → caller returns 200
  assertEquals(calls.deadLettered, ["evt_1"]);
  assertEquals(calls.captured, ["evt_1"]);
  assertEquals(calls.released, []); // keep the claim so Stripe doesn't storm
});

Deno.test("dispatch: a dead-letter WRITE failure still returns 200 (never throws)", async () => {
  // recordWebhookDeadLetter swallows write failures and resolves, so the drop
  // path still returns 200 even when the durable write fails.
  const decision = await handleWebhookDispatchError(
    new Error("handler bug"),
    EVT,
    {
      release: () => Promise.resolve(),
      capture: () => {},
      // Simulate the real recordWebhookDeadLetter contract: it resolves (false)
      // rather than rejecting on a write failure.
      deadLetter: () => Promise.resolve(),
    },
  );
  assertEquals(decision.retry, false);
});
