// US-2977: ebayId — the coercion that stops a numeric eBay id crashing a
// notification.
//
// Production, 2026-08-31: `inquiry 5384833027: ev.orderLabel?.trim is not a
// function`. eBay sent legacyOrderId as a number, every RawInquiry/RawCase/
// RawReturn type in this codebase declares those fields `string`, and a
// TypeScript type is a claim about JSON that nothing enforces. The value
// travelled untouched to a .trim() call and threw there, once per sweep, for
// four days.
//
// The branches below are the ones that decide whether the fix is a fix. Both
// wrong answers are worse than the crash was, because neither throws:
//   String(v)  turns null into "null" -> "A buyer says null never arrived"
//   String(v)  turns {value:"1"} into "[object Object]"
// A missing id must come back MISSING so the callers' `|| "an order"` fallback
// takes over, which is what it is there for.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { ebayId } = await import("../lib/ebay-client.ts");

Deno.test("ebayId coerces the numeric shape production actually sent", () => {
  assertEquals(ebayId(123456789012), "123456789012");
  assertEquals(ebayId(5384833027), "5384833027");
  assertEquals(ebayId(0), "0", "a zero id is an id, not a missing one");
  assertEquals(ebayId(12345678901234567890n), "12345678901234567890");
});

Deno.test("ebayId passes a real string through untouched", () => {
  assertEquals(ebayId("12-34567-89012"), "12-34567-89012");
  assertEquals(ebayId("225000111222"), "225000111222");
});

Deno.test("ebayId returns null for every absent shape — never the string \"null\"", () => {
  assertEquals(ebayId(null), null);
  assertEquals(ebayId(undefined), null);
  assertEquals(ebayId(""), null, "an empty id is absent, not an empty label");
  assertEquals(ebayId("   "), null, "whitespace is absent for the same reason");
});

Deno.test("ebayId refuses a shape it cannot honestly render", () => {
  // A nesting change (eBay has moved these before) must surface as a null the
  // normalizer tests can catch, not as "[object Object]" in a seller's inbox.
  assertEquals(ebayId({ value: "123" }), null);
  assertEquals(ebayId(["123"]), null);
  assertEquals(ebayId(Number.NaN), null);
  assertEquals(ebayId(Number.POSITIVE_INFINITY), null);
  assertEquals(ebayId(true), null);
});
