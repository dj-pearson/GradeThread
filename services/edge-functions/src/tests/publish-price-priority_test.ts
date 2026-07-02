import { assertEquals } from "@std/assert";

// flipdesk-ebay.ts reads the service-role client + env at load — set dummy env
// before the dynamic import (offer-already-ended_test pattern).
//   deno test --allow-env src/tests/publish-price-priority_test.ts
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { resolvePublishPrice } = await import("../routes/flipdesk-ebay.ts");

// US-1504 "which price wins" at publish.

Deno.test("target wins over an ESTIMATED draft price (no stale-estimate publish)", () => {
  // seller set $40 target; draft carries the $25 AI estimate → publish at $40
  assertEquals(resolvePublishPrice(25, true, 40), 40);
});

Deno.test("a NON-estimate draft price leads (seller edited it in the composer)", () => {
  assertEquals(resolvePublishPrice(30, false, 40), 30);
});

Deno.test("estimate wins when there's no usable target", () => {
  assertEquals(resolvePublishPrice(25, true, null), 25);
  assertEquals(resolvePublishPrice(25, true, 0), 25);
});

Deno.test("target is the fallback when there's no draft price", () => {
  assertEquals(resolvePublishPrice(null, false, 40), 40);
  assertEquals(resolvePublishPrice(0, false, 40), 40);
});

Deno.test("null when neither is usable", () => {
  assertEquals(resolvePublishPrice(null, false, null), null);
  assertEquals(resolvePublishPrice(0, true, 0), null);
});
