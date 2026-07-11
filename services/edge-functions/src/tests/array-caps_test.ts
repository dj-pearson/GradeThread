// US-1944: request-body array caps. A single authenticated caller must not be
// able to submit a very large array (bounded only by the JSON body limit) to
// force an oversized loop / IN(...) query — a mild per-tenant DoS. These are
// the pure helpers the affected write endpoints (flipdesk-pricing reprice/apply,
// admin-ops dead-letter bulk, admin-waitlist invite) now route their arrays
// through. Pure functions only — no live APIs, no network.

import { assertEquals } from "@std/assert";
import { capBodyArray, capStringIds, MAX_BODY_ARRAY } from "../lib/validation.ts";

// ── capBodyArray ─────────────────────────────────────────────────────────────

Deno.test("capBodyArray: bounds an over-cap array to MAX_BODY_ARRAY", () => {
  const big = Array.from({ length: MAX_BODY_ARRAY + 250 }, (_, i) => ({ i }));
  assertEquals(capBodyArray(big).length, MAX_BODY_ARRAY);
});

Deno.test("capBodyArray: respects an explicit lower cap", () => {
  const big = Array.from({ length: 1000 }, (_, i) => i);
  assertEquals(capBodyArray(big, 50).length, 50);
});

Deno.test("capBodyArray: passes a small array through unchanged", () => {
  const small = [{ a: 1 }, { a: 2 }];
  assertEquals(capBodyArray(small), small);
});

Deno.test("capBodyArray: non-arrays → []", () => {
  assertEquals(capBodyArray(undefined), []);
  assertEquals(capBodyArray(null), []);
  assertEquals(capBodyArray("nope"), []);
  assertEquals(capBodyArray({ length: 5 }), []);
});

// ── capStringIds ─────────────────────────────────────────────────────────────

Deno.test("capStringIds: bounds an over-cap id array", () => {
  const big = Array.from({ length: 900 }, (_, i) => `id-${i}`);
  const out = capStringIds(big, 500);
  assertEquals(out.length, 500);
});

Deno.test("capStringIds: caps the loop even for an all-duplicate mega-array", () => {
  // 100k identical ids: without the up-front slice this would iterate the whole
  // array. dedup collapses it to one id, and the work stays bounded.
  const flood = new Array(100_000).fill("dup");
  const out = capStringIds(flood, 500);
  assertEquals(out, ["dup"]);
});

Deno.test("capStringIds: dedupes and drops empty / non-string entries", () => {
  const out = capStringIds(["a", "a", "", "b", 5, null, "b"] as unknown[]);
  assertEquals(out, ["a", "b"]);
});

Deno.test("capStringIds: non-arrays → []", () => {
  assertEquals(capStringIds(undefined), []);
  assertEquals(capStringIds(null), []);
  assertEquals(capStringIds("nope"), []);
});

Deno.test("capStringIds: small array passes through in order", () => {
  assertEquals(capStringIds(["x", "y", "z"]), ["x", "y", "z"]);
});
