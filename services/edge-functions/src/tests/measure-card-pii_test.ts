// US-2417 AC2 + AC7: MeasureCard street addresses are stored encrypted and
// bound to their owner.
//
// AC7 is the case worth reading first. Encrypting a column is easy to do in a
// way that helps nobody: if every row is encrypted under the same key with no
// binding, then anyone who can write a row can copy another tenant's ciphertext
// onto it and read the plaintext back through the normal decrypt path. The AAD
// is what makes that fail, and this file proves it fails rather than assuming
// the option was passed.

import { assert, assertEquals, assertRejects } from "@std/assert";

// Two 32-byte keys, generated for this test only. Set BEFORE the crypto module
// is imported, because parseRegistry() reads env on first use.
const KEY_A = "Y2hhbmdlbWVjaGFuZ2VtZWNoYW5nZW1lY2hhbmdlbWU=";
Deno.env.set("EDGE_ENCRYPTION_KEY", Deno.env.get("EDGE_ENCRYPTION_KEY") ?? KEY_A);
Deno.env.set("EDGE_ENCRYPTION_KEY_ID", Deno.env.get("EDGE_ENCRYPTION_KEY_ID") ?? "test-k1");

const {
  decryptMeasureCardAddress,
  encryptMeasureCardAddress,
  isEncrypted,
  MEASURE_CARD_PII_COLUMNS,
  MEASURE_CARD_PLAINTEXT_COLUMNS,
} = await import("../lib/measure-card-pii.ts");

const OWNER_A = "11111111-1111-1111-1111-111111111111";
const OWNER_B = "22222222-2222-2222-2222-222222222222";

const ADDRESS = {
  ship_name: "Jamie Rivera",
  address_line1: "412 Wilder Street",
  address_line2: "Apt 3B",
  city: "Portland",
  postal_code: "97214",
};

Deno.test("US-2417: every street column is stored as ciphertext", async () => {
  const enc = await encryptMeasureCardAddress(OWNER_A, ADDRESS);

  for (const col of MEASURE_CARD_PII_COLUMNS) {
    const value = enc[col];
    if (value == null) continue;
    assert(isEncrypted(value), `${col} was not encrypted: ${value}`);
    // The plaintext must not survive anywhere inside the envelope. A format
    // that prefixed rather than replaced would pass an isEncrypted check while
    // leaving the address readable in a dump.
    const plain = ADDRESS[col as keyof typeof ADDRESS];
    if (plain) assert(!value.includes(plain), `${col} still contains its plaintext`);
  }

  const round = await decryptMeasureCardAddress(OWNER_A, enc);
  for (const col of MEASURE_CARD_PII_COLUMNS) {
    assertEquals(round[col] ?? null, ADDRESS[col as keyof typeof ADDRESS] ?? null, col);
  }
});

Deno.test("US-2417 AC7: a ciphertext moved to another tenant does not decrypt", async () => {
  const enc = await encryptMeasureCardAddress(OWNER_A, ADDRESS);
  // Exactly the attack the AAD exists for: copy A's row onto B's.
  await assertRejects(
    () => decryptMeasureCardAddress(OWNER_B, enc),
    Error,
    undefined,
    "A's address decrypted under B's id — the AAD binding is not in effect, so " +
      "anyone able to write a measure_card_requests row could read another " +
      "seller's street address by copying the ciphertext onto their own",
  );
});

Deno.test("US-2417: encryption requires an owner id", async () => {
  // An empty AAD would produce a ciphertext bound to nothing, which is the
  // silent version of not having the property at all.
  await assertRejects(() => encryptMeasureCardAddress("", ADDRESS), Error);
});

Deno.test("US-2417 AC4: a plaintext row is returned as-is, not thrown on", async () => {
  // Rollout tolerance. The reader is the operator's fulfilment queue; a 500 on
  // one un-backfilled row would take out the whole export.
  const legacy = { ...ADDRESS };
  const out = await decryptMeasureCardAddress(OWNER_A, legacy);
  assertEquals(out.address_line1, "412 Wilder Street");
  assertEquals(out.city, "Portland");
});

Deno.test("US-2417: a partially backfilled row decrypts what it can", async () => {
  const enc = await encryptMeasureCardAddress(OWNER_A, ADDRESS);
  const mixed = { ...enc, city: "Portland" }; // one column never backfilled
  const out = await decryptMeasureCardAddress(OWNER_A, mixed);
  assertEquals(out.address_line1, "412 Wilder Street");
  assertEquals(out.city, "Portland");
});

Deno.test("US-2417: encrypting twice does not double-wrap", async () => {
  // A backfill that runs twice must be a no-op. Double-wrapping would be
  // UNRECOVERABLE: the inner envelope's AAD is invisible from the outside, so
  // nothing downstream could tell a doubly-wrapped value from a corrupt one.
  const once = await encryptMeasureCardAddress(OWNER_A, ADDRESS);
  const twice = await encryptMeasureCardAddress(OWNER_A, once);
  assertEquals(twice, once);
  const out = await decryptMeasureCardAddress(OWNER_A, twice);
  assertEquals(out.address_line1, "412 Wilder Street");
});

Deno.test("US-2417: nulls and empties stay null, they are not encrypted", async () => {
  // address_line2 is nullable; the rest are NOT NULL (00351). Encrypting the
  // string "null" would make a nullable column non-null forever and would make
  // "no apartment number" indistinguishable from one.
  const enc = await encryptMeasureCardAddress(OWNER_A, { ...ADDRESS, address_line2: null });
  assertEquals(enc.address_line2, null);
  const out = await decryptMeasureCardAddress(OWNER_A, enc);
  assertEquals(out.address_line2, null);
});

Deno.test("US-2417 AC2: state and country are NOT in the encrypted set", () => {
  // Deliberate, and asserted so the two lists cannot silently overlap: the
  // fulfilment export filters and sorts by region, and an equality on an
  // encrypted column cannot use an index or match at all.
  for (const col of MEASURE_CARD_PLAINTEXT_COLUMNS) {
    assert(
      !(MEASURE_CARD_PII_COLUMNS as readonly string[]).includes(col),
      `${col} is declared plaintext AND encrypted — one of the two lists is wrong`,
    );
  }
  assertEquals([...MEASURE_CARD_PII_COLUMNS].sort(), [
    "address_line1",
    "address_line2",
    "city",
    "postal_code",
    "ship_name",
  ]);
});

Deno.test("US-2417: the write route encrypts, and does not also write plaintext", async () => {
  // Reading the route as text, because the property is about what reaches the
  // INSERT. A helper that is imported but whose result is not spread would pass
  // any behavioural test of the helper itself.
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-measure.ts", import.meta.url),
  );
  assert(
    src.includes("encryptMeasureCardAddress(ownerId,"),
    "the card-request insert must encrypt with ownerId as the AAD",
  );
  // Anchored on the object literal rather than on the chained call, because
  // deno fmt is free to move `.from(...)` and `.insert(` onto different lines
  // and a slice that matched nothing would make every check below vacuous.
  const at = src.indexOf("owner_user_id: ownerId,");
  assert(at > 0, "could not find the card-request insert — this check would prove nothing");
  const insert = src.slice(at, at + 500);
  assert(insert.includes("...encrypted"), "the insert must spread the encrypted columns");
  // BOTH forms. `city: city` and the shorthand `city,` write the same plaintext,
  // and checking only the explicit one was this test's own blind spot — found
  // by sabotaging the route with the shorthand and watching it stay green.
  // `state,` and `country,` ARE legitimately shorthand here, which is exactly
  // why the check has to be per-column rather than "no shorthand allowed".
  for (const col of MEASURE_CARD_PII_COLUMNS) {
    assert(
      !new RegExp(`^\\s*${col}\\s*[,:]`, "m").test(insert),
      `the insert still writes ${col} directly — a later key overrides the ` +
        "spread, so that column would be stored in plaintext while every other " +
        "one is encrypted",
    );
  }
  // state/country deliberately still written raw.
  assert(insert.includes("state,"), "state must still be written in plaintext");
});

Deno.test("US-2417: the admin export decrypts with the ROW's owner, not the caller's", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/admin-measure-cards.ts", import.meta.url),
  );
  assert(
    src.includes("decryptMeasureCardAddress(row.owner_user_id"),
    "the fulfilment export must use the row's own owner_user_id as the AAD — a " +
      "caller-supplied id would let an operator-triggered read be pointed at " +
      "the wrong tenant, defeating the binding the write side paid for",
  );
  assert(
    /catch[\s\S]{0,400}address_line1: ""/.test(src),
    "an undecryptable row must be blanked and logged, not dropped or rendered " +
      "with a stale value on a mailing label",
  );
});
