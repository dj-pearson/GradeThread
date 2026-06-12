// US-547: per-field keep/change diff that turns a published draft into the
// self-improvement feedback signal. Pure math — tested with no DB/AI. The
// capture/summarize/promote DB paths are integration-tested elsewhere.

import { assertEquals } from "@std/assert";

// listing-acceptance.ts -> grading-eval -> ... -> supabase, which throws at
// init without env. Dummy-env then dynamic-import (mirrors demand-terms_test).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { diffListingFields } = await import("../lib/listing-acceptance.ts");

Deno.test("all fields kept → keepRate 1, every outcome 'kept'", () => {
  const snapshot = {
    title: "Nike Air Max 90 White",
    description: "Clean pair, see photos.",
    price_cents: 8500,
    ebay_condition: "USED_GOOD",
    condition_description: "Light wear.",
    category_id: "15709",
    item_specifics: { Brand: ["Nike"], Size: ["10"] },
  };
  const finalRow = {
    listing_title: "Nike Air Max 90 White",
    listing_description: "Clean pair, see photos.",
    listing_price: 85, // dollars; snapshot is cents
    ebay_condition: "USED_GOOD",
    ebay_condition_description: "Light wear.",
    platform_category_id: "15709",
    item_specifics_override: { Size: ["10"], Brand: ["Nike"] }, // order-insensitive
  };
  const diff = diffListingFields(snapshot, finalRow);
  assertEquals(diff.totalFields, 7);
  assertEquals(diff.keptCount, 7);
  assertEquals(diff.changedCount, 0);
  assertEquals(diff.fieldOutcomes.item_specifics, "kept");
  assertEquals(diff.fieldOutcomes.price_cents, "kept");
});

Deno.test("edited title + repriced → those flip to 'changed'", () => {
  const snapshot = {
    title: "Generic Tee",
    price_cents: 2000,
    category_id: "1059",
  };
  const finalRow = {
    listing_title: "Vintage Band Tee L", // seller rewrote
    listing_price: 24.99, // 2499c != 2000c
    platform_category_id: "1059", // unchanged
  };
  const diff = diffListingFields(snapshot, finalRow);
  assertEquals(diff.fieldOutcomes.title, "changed");
  assertEquals(diff.fieldOutcomes.price_cents, "changed");
  assertEquals(diff.fieldOutcomes.category_id, "kept");
  assertEquals(diff.keptCount, 1);
  assertEquals(diff.changedCount, 2);
});

Deno.test("fields the AI didn't produce are not scored", () => {
  const snapshot = { title: "Only a title" }; // no price/description/etc.
  const finalRow = {
    listing_title: "Only a title",
    listing_price: 50,
    listing_description: "seller wrote this",
  };
  const diff = diffListingFields(snapshot, finalRow);
  assertEquals(diff.totalFields, 1);
  assertEquals(diff.keptCount, 1);
  assertEquals(Object.keys(diff.fieldOutcomes), ["title"]);
});

Deno.test("price within 1-cent tolerance counts as kept", () => {
  const diff = diffListingFields(
    { price_cents: 1000 },
    { listing_price: 10.0 }, // 1000c
  );
  assertEquals(diff.fieldOutcomes.price_cents, "kept");
});
