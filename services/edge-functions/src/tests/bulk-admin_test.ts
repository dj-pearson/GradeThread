// US-589: validate the bulk-admin id normalizer (dedupe + cap + UUID guard).
// Pure logic, no DB — but admin-bulk.ts imports supabase.ts (throws at init
// without env), so set dummy creds then dynamic import.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { normalizeTargetIds } = await import("../routes/admin-bulk.ts");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-9222-222222222222";

Deno.test("normalizeTargetIds: accepts valid UUIDs", () => {
  const { ids, error } = normalizeTargetIds([A, B]);
  assertEquals(error, undefined);
  assertEquals(ids.sort(), [A, B].sort());
});

Deno.test("normalizeTargetIds: dedupes case-insensitively (act once per id)", () => {
  const { ids, error } = normalizeTargetIds([A, A.toUpperCase(), B]);
  assertEquals(error, undefined);
  assertEquals(ids.length, 2);
});

Deno.test("normalizeTargetIds: rejects an empty array", () => {
  const { error } = normalizeTargetIds([]);
  assertEquals(typeof error, "string");
});

Deno.test("normalizeTargetIds: rejects a non-array", () => {
  const { error } = normalizeTargetIds("nope");
  assertEquals(typeof error, "string");
});

Deno.test("normalizeTargetIds: rejects a non-UUID entry", () => {
  const { error } = normalizeTargetIds([A, "not-a-uuid"]);
  assertEquals(typeof error, "string");
});

Deno.test("normalizeTargetIds: rejects an over-cap batch", () => {
  const big = Array.from(
    { length: 201 },
    (_, i) => `${i.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
  );
  const { error } = normalizeTargetIds(big);
  assertEquals(typeof error, "string");
});

// ── US-1562: resolve-endpoint entry classification ───────────────────────────
const { classifyResolveEntries } = await import("../routes/admin-bulk.ts");

Deno.test("US-1562: classifyResolveEntries splits ids/emails/malformed, dedupes, lowercases", () => {
  const out = classifyResolveEntries([
    "A1B2C3D4-1111-4111-8111-000000000001", // uppercase UUID → lowercased id
    "a1b2c3d4-1111-4111-8111-000000000001", // dup of the same id
    "  Seller@Example.COM ",                 // email, trimmed + lowercased
    "not-an-id",                             // malformed
    42 as unknown as string,                 // non-string ignored
    "",                                      // empty ignored
  ]);
  assertEquals(out.ids, ["a1b2c3d4-1111-4111-8111-000000000001"]);
  assertEquals(out.emails, ["seller@example.com"]);
  assertEquals(out.malformed, ["not-an-id"]);
});

Deno.test("US-1562: classifyResolveEntries handles the empty case", () => {
  const out = classifyResolveEntries([]);
  assertEquals(out.ids.length + out.emails.length + out.malformed.length, 0);
});
