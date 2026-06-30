// US-1092: Garment Passport edge API. passport.ts imports the service-role
// supabase client at module load (throws without env), so set dummy env BEFORE
// the dynamic import — same pattern as schema-version_test.ts / abuse-signals_test.ts.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { sanitizePayload, TtlCache } = await import("../routes/passport.ts");

Deno.test("sanitizePayload: strips identity-bearing keys (AC#2 PII defense)", () => {
  const cleaned = sanitizePayload({
    grade: 8.5,
    tier: "excellent",
    price_cents: 4200,
    marketplace: "ebay",
    // All of these must be dropped before a PUBLIC response:
    user_id: "uuid-aaa",
    owner: "someone",
    buyer_email: "a@b.com",
    seller_handle: "@grailedpro",
    shipping_address: "123 Main St",
    full_name: "Jane Doe",
    order_id: "EBAY-123",
  });
  // Kept: the PII-free condition/listing facts.
  assertEquals(cleaned, { grade: 8.5, tier: "excellent", price_cents: 4200, marketplace: "ebay" });
  // Dropped: every identity-bearing key.
  for (const k of ["user_id", "owner", "buyer_email", "seller_handle", "shipping_address", "full_name", "order_id"]) {
    assert(!(k in cleaned), `${k} must be stripped from the public payload`);
  }
});

Deno.test("sanitizePayload: non-object input → empty object", () => {
  assertEquals(sanitizePayload(null), {});
  assertEquals(sanitizePayload("nope"), {});
  assertEquals(sanitizePayload(undefined), {});
});

// US-1420: the public chain read cache.
Deno.test("TtlCache: hit within TTL, miss after expiry", () => {
  const cache = new TtlCache<{ n: number }>(1_000);
  cache.set("a", { n: 1 }, 0);
  // Still inside the window → served from cache.
  assertEquals(cache.get("a", 500), { n: 1 });
  // At/after expiry → miss (and the stale entry is dropped).
  assertEquals(cache.get("a", 1_000), undefined);
  assertEquals(cache.get("a", 1_500), undefined);
});

Deno.test("TtlCache: unknown key misses", () => {
  const cache = new TtlCache<number>(1_000);
  assertEquals(cache.get("nope", 0), undefined);
});

Deno.test("TtlCache: evicts to stay bounded under distinct-key churn", () => {
  const cache = new TtlCache<number>(60_000, 3);
  // Insert past the cap with non-expired entries; the map must never exceed it.
  for (let i = 0; i < 50; i++) cache.set(`slug-${i}`, i, 0);
  let live = 0;
  for (let i = 0; i < 50; i++) {
    if (cache.get(`slug-${i}`, 0) !== undefined) live++;
  }
  assert(live <= 3, `cache kept ${live} entries, expected ≤ 3`);
  // The most recently inserted key is still resolvable.
  assertEquals(cache.get("slug-49", 0), 49);
});
