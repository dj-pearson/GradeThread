// US-2417 AC1 + AC4 + AC7: users.ship_from_address and users.business_phone are
// stored encrypted and bound to the account owner.
//
// AC7 is the case worth reading first, for the same reason it is in
// measure-card-pii_test.ts: encrypting a column is easy to do in a way that
// helps nobody. One key, no binding, and anyone who can write a row can paste
// another account's ciphertext onto their own and read the plaintext back
// through the normal decrypt path. The AAD is what makes that fail, and this
// file proves it fails rather than assuming the option was passed.
//
// AC4 is the other half: a partially backfilled table must RENDER, not 500. The
// discriminator here is the JSON type — an object is a row the backfill has not
// reached, a string is an envelope — and the tolerance cases below pin it.

import { assert, assertEquals, assertRejects } from "@std/assert";

// A 32-byte key generated for this test only. Set BEFORE the crypto module is
// imported, because parseRegistry() reads env on first use.
const KEY_A = "Y2hhbmdlbWVjaGFuZ2VtZWNoYW5nZW1lY2hhbmdlbWU=";
Deno.env.set("EDGE_ENCRYPTION_KEY", Deno.env.get("EDGE_ENCRYPTION_KEY") ?? KEY_A);
Deno.env.set("EDGE_ENCRYPTION_KEY_ID", Deno.env.get("EDGE_ENCRYPTION_KEY_ID") ?? "test-k1");

const {
  decryptBusinessPhone,
  decryptShipFrom,
  encryptBusinessPhone,
  encryptShipFrom,
  isEncrypted,
  normalizeShipFrom,
} = await import("../lib/user-shipping-pii.ts");

const OWNER_A = "11111111-1111-1111-1111-111111111111";
const OWNER_B = "22222222-2222-2222-2222-222222222222";

const ADDRESS = {
  line1: "412 Wilder Street",
  line2: "Apt 3B",
  city: "Portland",
  state: "OR",
  postal_code: "97214",
  country: "US",
};

// ── The round trip ──────────────────────────────────────────────────

Deno.test("US-2417: the address is stored as ciphertext, not as an object", async () => {
  const stored = await encryptShipFrom(OWNER_A, ADDRESS);
  assert(typeof stored === "string", "the stored value must be a string, not an object");
  assert(isEncrypted(stored!), `not an envelope: ${stored}`);
  // The street must not survive anywhere in the stored value.
  assert(!stored!.includes("Wilder"), "plaintext leaked into the envelope");
  assert(!stored!.includes("97214"), "the postal code leaked into the envelope");

  const back = await decryptShipFrom(OWNER_A, stored);
  assertEquals(back, ADDRESS);
});

Deno.test("US-2417: the phone round-trips and is unreadable at rest", async () => {
  const stored = await encryptBusinessPhone(OWNER_A, " (503) 555-0148 ");
  assert(stored && isEncrypted(stored));
  assert(!stored.includes("555"), "the phone number leaked into the envelope");
  assertEquals(await decryptBusinessPhone(OWNER_A, stored), "(503) 555-0148");
});

Deno.test("US-2417: null and empty stay absent rather than becoming ciphertext", async () => {
  assertEquals(await encryptShipFrom(OWNER_A, null), null);
  assertEquals(await encryptShipFrom(OWNER_A, {}), null);
  // Every field blank is the same as no address — this is what "the seller
  // cleared their address" has always meant on this column.
  assertEquals(await encryptShipFrom(OWNER_A, { line1: "  ", city: "" }), null);
  assertEquals(await encryptBusinessPhone(OWNER_A, null), null);
  assertEquals(await encryptBusinessPhone(OWNER_A, "   "), null);
  assertEquals(await decryptShipFrom(OWNER_A, null), null);
  assertEquals(await decryptBusinessPhone(OWNER_A, null), null);
});

// ── AC7: the tenant binding is real ─────────────────────────────────

Deno.test("US-2417 AC7: another account's id as AAD cannot decrypt the address", async () => {
  const stored = await encryptShipFrom(OWNER_A, ADDRESS);
  // This is the whole point of the story. Without the AAD this call would
  // SUCCEED and hand B the street A lives on.
  await assertRejects(() => decryptShipFrom(OWNER_B, stored));
});

Deno.test("US-2417 AC7: the same holds for the phone", async () => {
  const stored = await encryptBusinessPhone(OWNER_A, "503-555-0148");
  await assertRejects(() => decryptBusinessPhone(OWNER_B, stored));
});

Deno.test("US-2417 AC7: encrypting without an owner id is refused, not silently unbound", async () => {
  // An empty AAD would produce a ciphertext any account could read. Failing the
  // write is the only safe answer; falling back to no binding is how the
  // property gets lost in a refactor nobody reviews.
  await assertRejects(() => encryptShipFrom("", ADDRESS));
  await assertRejects(() => encryptBusinessPhone("", "503-555-0148"));
});

// ── AC4: rollout tolerance, in both directions ──────────────────────

Deno.test("US-2417 AC4: a not-yet-backfilled OBJECT is returned as-is", async () => {
  // The Settings page must render during the rollout. A throw here would 503
  // every profile the backfill has not reached.
  assertEquals(await decryptShipFrom(OWNER_A, ADDRESS), ADDRESS);
});

Deno.test("US-2417 AC4: a not-yet-backfilled phone string is returned as-is", async () => {
  assertEquals(await decryptBusinessPhone(OWNER_A, "503-555-0148"), "503-555-0148");
});

Deno.test("US-2417 AC4: re-encrypting an envelope is a no-op, never a double-wrap", async () => {
  // This is what makes the backfill safe to re-run, and it is not cosmetic:
  // double-wrapping would be UNRECOVERABLE, because the inner envelope's AAD is
  // invisible from the outside once another layer is on top of it.
  const once = await encryptShipFrom(OWNER_A, ADDRESS);
  const twice = await encryptShipFrom(OWNER_A, once);
  assertEquals(twice, once);
  assertEquals(await decryptShipFrom(OWNER_A, twice), ADDRESS);

  const p1 = await encryptBusinessPhone(OWNER_A, "503-555-0148");
  assertEquals(await encryptBusinessPhone(OWNER_A, p1), p1);
});

// ── Normalization ───────────────────────────────────────────────────

Deno.test("US-2417: unknown keys are dropped before the envelope is sealed", async () => {
  // The column is opaque to every database-side check now, so the only place a
  // shape can be enforced is here. A caller must not be able to smuggle extra
  // keys into it.
  const stored = await encryptShipFrom(OWNER_A, {
    ...ADDRESS,
    note: "leave at the back door",
    user_id: OWNER_B,
  });
  assertEquals(await decryptShipFrom(OWNER_A, stored), ADDRESS);
});

Deno.test("US-2417: normalizeShipFrom trims, drops empties and rejects non-objects", () => {
  assertEquals(normalizeShipFrom({ line1: "  4 Elm  ", city: "" }), { line1: "4 Elm" });
  assertEquals(normalizeShipFrom("v2:whatever"), null);
  assertEquals(normalizeShipFrom(["4 Elm"]), null);
  assertEquals(normalizeShipFrom(null), null);
  assertEquals(normalizeShipFrom(42), null);
});

Deno.test("US-2417: a bare non-envelope string is treated as absent, not guessed at", async () => {
  // A string in this jsonb column was never a valid value before the envelope
  // existed, so there is nothing to salvage and nothing to render.
  assertEquals(await decryptShipFrom(OWNER_A, "412 Wilder Street"), null);
});
