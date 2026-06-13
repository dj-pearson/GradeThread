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
