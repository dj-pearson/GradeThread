// US-568: multi-variant (size/color) listings. normalizeVariations defends the
// publish path against malformed / unpublishable variation matrices, and
// variantSku derives a stable, eBay-safe per-variant SKU from the base SKU.
//
//   deno test --allow-env src/tests/listing-variations_test.ts
import { assertEquals } from "@std/assert";

// flipdesk-ebay.ts loads the service-role supabase client at import, so set
// dummy env BEFORE the dynamic import (same pattern as publish-due-batch_test).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { normalizeVariations, variantSku } = await import(
  "../routes/flipdesk-ebay.ts"
);

Deno.test("normalizeVariations: null / empty matrices fall back to single-SKU", () => {
  assertEquals(normalizeVariations(null), null);
  assertEquals(normalizeVariations({ specifications: [], variants: [] }), null);
  // Fewer than two purchasable variants → not a variation listing.
  assertEquals(
    normalizeVariations({
      specifications: ["Size"],
      variants: [{ aspects: { Size: "M" }, quantity: 1 }],
    }),
    null,
  );
});

Deno.test("normalizeVariations: keeps well-formed, in-stock variants", () => {
  const out = normalizeVariations({
    specifications: ["Size", "Color"],
    variants: [
      { aspects: { Size: "S", Color: "Red" }, quantity: 2 },
      { aspects: { Size: "M", Color: "Red" }, quantity: 1, price_cents: 2599 },
    ],
  });
  assertEquals(out?.specifications, ["Size", "Color"]);
  assertEquals(out?.variants.length, 2);
  assertEquals(out?.variants[1]?.price_cents, 2599);
});

Deno.test("normalizeVariations: drops out-of-stock + incomplete variants", () => {
  const out = normalizeVariations({
    specifications: ["Size"],
    variants: [
      { aspects: { Size: "S" }, quantity: 0 }, // out of stock → dropped
      { aspects: { Size: "M" }, quantity: 3 },
      { aspects: {}, quantity: 5 }, // missing the Size value → dropped
      { aspects: { Size: "L" }, quantity: 1 },
    ],
  });
  // Two valid, in-stock variants remain.
  assertEquals(out?.variants.length, 2);
  assertEquals(out?.variants.map((v) => v.aspects.Size).sort(), ["L", "M"]);
});

Deno.test("variantSku: explicit suffix wins, else slug of the aspect values", () => {
  assertEquals(
    variantSku("GT-123", {
      aspects: { Size: "M", Color: "Red" },
      quantity: 1,
      sku_suffix: "MED-RED",
    }),
    "GT-123-MED-RED",
  );
  assertEquals(
    variantSku("GT-123", { aspects: { Size: "M", Color: "Red" }, quantity: 1 }),
    "GT-123-M-RED",
  );
  // Non-alphanumeric characters (except the value separator) are stripped from
  // the derived suffix.
  assertEquals(
    variantSku("GT-9", { aspects: { Size: "X/L", Color: "Navy Blue" }, quantity: 1 }),
    "GT-9-XL-NAVYBLUE",
  );
});
