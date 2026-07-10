// US-1811: buyer purchase-link + arrival capture — pure helpers (path building,
// data-URL decode, image-type guard). The route's DB/upload paths are covered by
// the tenant-isolation suite; here we pin the pure logic.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { arrivalStoragePath, decodeDataUrl, isArrivalImageType, ARRIVAL_IMAGE_TYPES } = await import(
  "../routes/buyer-purchases.ts"
);

Deno.test("arrivalStoragePath is user-folder rooted (RLS tenancy)", () => {
  const p = arrivalStoragePath("user-1", "purchase-9", "front", "jpg", 1234);
  assertEquals(p, "user-1/purchase-9/arrival_front_1234.jpg");
  // The FIRST path segment MUST be the userId — that's what the bucket's
  // per-user-folder RLS keys on.
  assertEquals(p.split("/")[0], "user-1");
});

Deno.test("isArrivalImageType accepts only the grader's four types", () => {
  for (const t of ARRIVAL_IMAGE_TYPES) assert(isArrivalImageType(t));
  assert(!isArrivalImageType("selfie"));
  assert(!isArrivalImageType(""));
  assert(!isArrivalImageType(null));
  assert(!isArrivalImageType(42));
});

Deno.test("decodeDataUrl strips the data-url prefix and decodes base64", () => {
  // "hi" base64 = aGk=
  const withPrefix = decodeDataUrl("data:image/jpeg;base64,aGk=");
  assertEquals(withPrefix ? Array.from(withPrefix) : null, [104, 105]);
  // Bare base64 (no prefix) also decodes.
  const bare = decodeDataUrl("aGk=");
  assertEquals(bare ? Array.from(bare) : null, [104, 105]);
});

Deno.test("decodeDataUrl rejects malformed / empty / non-string payloads", () => {
  assertEquals(decodeDataUrl(""), null);
  assertEquals(decodeDataUrl("data:image/jpeg;base64,"), null);
  assertEquals(decodeDataUrl("not base64 !@#$"), null);
  assertEquals(decodeDataUrl(null), null);
  assertEquals(decodeDataUrl(undefined), null);
  assertEquals(decodeDataUrl(12345), null);
});
