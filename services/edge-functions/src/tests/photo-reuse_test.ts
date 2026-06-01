// Unit tests for the photo-reuse Hamming distance (US-337).
//
// hammingHex is pure. photo-reuse.ts imports the service-role supabase client
// at load, so set dummy env BEFORE the dynamic import.
//
//   deno test --allow-env src/tests/photo-reuse_test.ts

import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { hammingHex } = await import("../lib/photo-reuse.ts");

Deno.test("identical hashes → distance 0", () => {
  assertEquals(hammingHex("abcdef0123456789", "abcdef0123456789"), 0);
});

Deno.test("single-bit difference → distance 1", () => {
  assertEquals(hammingHex("0000000000000000", "0000000000000001"), 1);
  assertEquals(hammingHex("0000000000000000", "0000000000000008"), 1); // 0b1000
});

Deno.test("all bits flipped → distance 64", () => {
  assertEquals(hammingHex("ffffffffffffffff", "0000000000000000"), 64);
});

Deno.test("one nibble flipped (f vs 0) → 4 bits", () => {
  assertEquals(hammingHex("f000000000000000", "0000000000000000"), 4);
});

Deno.test("case-insensitive and known mid-range distance", () => {
  // 0xA (1010) vs 0x5 (0101) differ in all 4 bits.
  assertEquals(hammingHex("A000000000000000", "5000000000000000"), 4);
});

Deno.test("malformed or wrong-length inputs → max distance (no false match)", () => {
  assertEquals(hammingHex("xyz", "0000000000000000"), 64);
  assertEquals(hammingHex("000000000000000", "0000000000000000"), 64); // 15 chars
  assertEquals(hammingHex("", ""), 64);
});
