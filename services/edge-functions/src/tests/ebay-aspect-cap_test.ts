// eBay hard-rejects any item-specific (aspect) value longer than 65 chars at
// PUBLISH time (errorId 25002: "…value of '…' is too long. Enter a value of no
// more than 65 characters."). Because the inventory_item PUT accepts the long
// value but publish does not, an over-long aspect (e.g. a full "Garment Care"
// instruction) creates a stuck unpublished offer and every retry then fails
// "offer already exists". capAspectValuesForEbay enforces the 65-char cap at the
// shared createOrReplaceInventoryItem chokepoint so the value can never reach
// eBay.

import { assert, assertEquals } from "@std/assert";

// ebay-client.ts pulls in the service-role supabase client at import time, which
// throws without these. Set them before the dynamic import (mirrors the other
// ebay-client-importing tests, e.g. ebay-negotiation_test.ts).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { capAspectValuesForEbay, EBAY_ASPECT_VALUE_MAX_LEN } = await import(
  "../lib/ebay-client.ts"
);

Deno.test("caps the real-world Garment Care value that broke publish", () => {
  const long =
    "Turn Inside Out, Hand Wash With Mild Detergent In Cold Water, Towel Dry, Reshape And Lay Flat, Iron In Mild Heat Or Dry Clean";
  const out = capAspectValuesForEbay({ "Garment Care": [long] })!;
  const value = out["Garment Care"]![0]!;
  assert(value.length <= EBAY_ASPECT_VALUE_MAX_LEN, `len ${value.length} > 65`);
  // Truncates on a word boundary, not mid-word.
  assert(!long.slice(value.length, value.length + 1).match(/\S/) || long.startsWith(value));
  assert(long.startsWith(value.replace(/\s+$/, "")));
});

Deno.test("leaves short values untouched", () => {
  const out = capAspectValuesForEbay({
    Brand: ["Nike"],
    Color: ["Blue", "White"],
    Size: ["M"],
  })!;
  assertEquals(out, { Brand: ["Nike"], Color: ["Blue", "White"], Size: ["M"] });
});

Deno.test("caps at exactly 65 for a boundary-length value", () => {
  const exact = "a".repeat(EBAY_ASPECT_VALUE_MAX_LEN);
  assertEquals(capAspectValuesForEbay({ X: [exact] })!.X, [exact]);
  const over = "a".repeat(EBAY_ASPECT_VALUE_MAX_LEN + 1);
  const capped = capAspectValuesForEbay({ X: [over] })!.X![0]!;
  assert(capped.length <= EBAY_ASPECT_VALUE_MAX_LEN);
});

Deno.test("hard-cuts a single over-long token with no word boundary", () => {
  const token = "x".repeat(120);
  const capped = capAspectValuesForEbay({ Material: [token] })!.Material![0]!;
  assertEquals(capped.length, EBAY_ASPECT_VALUE_MAX_LEN);
});

Deno.test("drops values that become empty and keys left with none", () => {
  const out = capAspectValuesForEbay({ Brand: ["Nike"], Empty: ["   ", ""] });
  assertEquals(out, { Brand: ["Nike"] });
});

Deno.test("returns undefined when nothing survives (so caller omits aspects)", () => {
  assertEquals(capAspectValuesForEbay(undefined), undefined);
  assertEquals(capAspectValuesForEbay({}), undefined);
  assertEquals(capAspectValuesForEbay({ Empty: [""] }), undefined);
});

Deno.test("does not mutate the input map", () => {
  const input = {
    "Garment Care": ["z".repeat(90)],
  };
  const before = input["Garment Care"][0];
  capAspectValuesForEbay(input);
  assertEquals(input["Garment Care"][0], before);
});
