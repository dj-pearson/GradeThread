// US-1090: Garment Passport privacy-model primitives. Pure functions — no DB,
// no env required (minimizeLinkageRef takes an explicit salt here).
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  chainLabel,
  generateClaimToken,
  hashClaimToken,
  isPseudonymousLabel,
  minimizeLinkageRef,
  pseudonymousLabel,
} from "../lib/garment-passport.ts";

Deno.test("chainLabel: bijective base-26 (A..Z, AA..)", () => {
  assertEquals(chainLabel(0), "A");
  assertEquals(chainLabel(25), "Z");
  assertEquals(chainLabel(26), "AA");
  assertEquals(chainLabel(27), "AB");
  assertEquals(chainLabel(51), "AZ");
  assertEquals(chainLabel(52), "BA");
});

Deno.test("pseudonymousLabel: PII-free, kind-prefixed, stable", () => {
  assertEquals(pseudonymousLabel("seller", 0), "Seller A");
  assertEquals(pseudonymousLabel("buyer", 1), "Buyer B");
  assertEquals(pseudonymousLabel("system", 0), "System");
  // Stable for the same position.
  assertEquals(pseudonymousLabel("seller", 0), pseudonymousLabel("seller", 0));
});

Deno.test("isPseudonymousLabel: accepts safe labels, rejects PII shapes", () => {
  assert(isPseudonymousLabel("Seller A"));
  assert(isPseudonymousLabel("Buyer B"));
  assert(isPseudonymousLabel("Owner C"));
  assert(isPseudonymousLabel("System"));
  // Anything that looks like identity must be rejected (AC#2 guard).
  assert(!isPseudonymousLabel("seller@example.com"));
  assert(!isPseudonymousLabel("@grailedpro"));
  assert(!isPseudonymousLabel("123 Main St"));
  assert(!isPseudonymousLabel("Jane Doe"));
  assert(!isPseudonymousLabel(""));
});

Deno.test("minimizeLinkageRef: deterministic, hex, irreversible-by-storage", async () => {
  const a = await minimizeLinkageRef("EBAY-ORDER-123", "salt-x");
  const a2 = await minimizeLinkageRef("ebay-order-123", "salt-x"); // case/space normalized
  const b = await minimizeLinkageRef("EBAY-ORDER-999", "salt-x");
  const aDiffSalt = await minimizeLinkageRef("EBAY-ORDER-123", "salt-y");

  assertEquals(a, a2); // same input (normalized) + salt → same digest (dedupe works)
  assertNotEquals(a, b); // different inputs → different digests
  assertNotEquals(a, aDiffSalt); // salt changes the digest (not rainbow-tableable)
  assert(/^[0-9a-f]{64}$/.test(a)); // SHA-256 hex
  // The raw, PII-bearing value is never present in what we store.
  assert(!a.includes("123") || a.length === 64); // digest, not the raw id
  assert(!a.toLowerCase().includes("ebay"));
});

// US-1094: ownership-claim token primitives.
Deno.test("generateClaimToken: high-entropy 64-hex, unique per call", () => {
  const a = generateClaimToken();
  const b = generateClaimToken();
  assert(/^[0-9a-f]{64}$/.test(a), "token is 32-byte hex");
  assertNotEquals(a, b, "two tokens must differ (random)");
});

Deno.test("hashClaimToken: deterministic SHA-256 hex; raw not recoverable", async () => {
  const raw = generateClaimToken();
  const h1 = await hashClaimToken(raw);
  const h2 = await hashClaimToken(raw);
  const other = await hashClaimToken(generateClaimToken());
  assertEquals(h1, h2); // same token → same hash (lookup works)
  assertNotEquals(h1, other); // different tokens → different hashes
  assert(/^[0-9a-f]{64}$/.test(h1));
  assertNotEquals(h1, raw); // we store the digest, never the raw token
  // Known vector pins the algorithm (SHA-256 of "abc").
  assertEquals(
    await hashClaimToken("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
