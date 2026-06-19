// US-1092: Garment Passport edge API. passport.ts imports the service-role
// supabase client at module load (throws without env), so set dummy env BEFORE
// the dynamic import — same pattern as schema-version_test.ts / abuse-signals_test.ts.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { sanitizePayload } = await import("../routes/passport.ts");

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
