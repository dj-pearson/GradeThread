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

// US-1975: the iOS composer now writes `listings.variations` itself. It has no
// way to run this code (Swift can't import the edge), so pin the contract from
// this side: the exact JSON the iOS editor encodes must survive the publish
// path's normalization unchanged — same keys, same casing, same null handling.
// The Swift end is `ListingVariationsPayload` (EbayPublishTypes.swift), whose
// CodingKeys produce this shape and whose encoder OMITS nil optionals rather
// than writing them.
Deno.test("normalizeVariations: the iOS composer's payload publishes verbatim", () => {
  const iosWrite = JSON.parse(`{
    "specifications": ["Size", "Color"],
    "variants": [
      { "aspects": { "Size": "M", "Color": "Blue" }, "quantity": 2, "price_cents": 4250 },
      { "aspects": { "Size": "L", "Color": "Blue" }, "quantity": 1 }
    ]
  }`);
  const out = normalizeVariations(iosWrite);
  assertEquals(out?.specifications, ["Size", "Color"]);
  assertEquals(out?.variants.length, 2);
  assertEquals(out?.variants[0]?.price_cents, 4250);
  // An omitted price_cents means "sell at the listing price" — it must reach the
  // publish path as null, not 0 (which would be a free variant).
  assertEquals(out?.variants[1]?.price_cents, null);
  assertEquals(out?.variants[1]?.sku_suffix, null);
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

// ── US-2395: a variation listing is not a listing without a mechanism ───────
//
// eBay publishes a multi-variation listing through publish_by_inventory_item_group
// and never mints a `platform_offer_id` for it. The revise route's first check
// was `if (!platform_offer_id) return 409`, so every variation listing froze the
// moment it went live — Save and resubmit answered "This listing has no eBay
// offer id. Sync from eBay or republish to enable edits", which is advice that
// cannot work: republishing does not create an offer id for a group, and
// republishing a LIVE listing is worse than doing nothing.
//
// The END path already got this right (resolveEndStrategy, group-first,
// US-1999). The revise path did not. Two resolvers in one file giving different
// answers to the same question is the shape worth guarding.

const { resolveReviseStrategy, resolveEndStrategy } = await import(
  "../routes/flipdesk-ebay.ts"
);

/** A variation matrix, as `listings.variations` stores it. */
const VARIATION_MATRIX = {
  specifications: ["Size", "Color"],
  variants: [
    { aspects: { Size: "M", Color: "Blue" }, quantity: 1, price_cents: 2499, sku_suffix: "v1" },
    { aspects: { Size: "L", Color: "Blue" }, quantity: 2, price_cents: 2499, sku_suffix: "v2" },
  ],
} as never;

Deno.test("US-2395 AC4: a variation listing revises through the GROUP", () => {
  // The row a live group listing actually has: variations set, a pinned base
  // SKU, and NO offer id. That exact combination used to be the 409.
  assertEquals(
    resolveReviseStrategy({
      variations: VARIATION_MATRIX,
      itemSku: "GT-1234",
      platformOfferId: null,
    }),
    { kind: "group", groupKey: "GT-1234" },
  );
});

Deno.test("US-2395 AC4: a single-offer listing still revises through the OFFER", () => {
  // The common path, and the one a mistake here would break for every seller.
  assertEquals(
    resolveReviseStrategy({
      variations: null,
      itemSku: "GT-1234",
      platformOfferId: "offer-99",
    }),
    { kind: "offer", offerId: "offer-99" },
  );
});

Deno.test("US-2395 AC2: group wins even when an offer id is also present", () => {
  // Order matters, not just membership. A group listing carrying a stale offer
  // id from a previous single-SKU publish must still revise through the group,
  // because the group is what is live.
  assertEquals(
    resolveReviseStrategy({
      variations: VARIATION_MATRIX,
      itemSku: "GT-1234",
      platformOfferId: "offer-99",
    }),
    { kind: "group", groupKey: "GT-1234" },
  );
});

Deno.test("US-2395 AC2: the group key is whichever sku the caller pinned", () => {
  // The route passes `inventory_sku ?? item_sku` — pinned first. The group was
  // created under the base SKU at publish, so a later rename would aim the
  // revise at a group that does not exist. Same reasoning US-1999 applied to
  // the withdraw path.
  assertEquals(
    resolveReviseStrategy({
      variations: VARIATION_MATRIX,
      itemSku: "PINNED-AT-PUBLISH",
      platformOfferId: null,
    }),
    { kind: "group", groupKey: "PINNED-AT-PUBLISH" },
  );
});

Deno.test("US-2395: no mechanism is 'none', never a silent offer path", () => {
  assertEquals(
    resolveReviseStrategy({ variations: null, itemSku: "GT-1", platformOfferId: null }),
    { kind: "none" },
  );
  // A variation matrix with no SKU cannot name a group either — guessing a key
  // would PUT against a group that does not exist.
  assertEquals(
    resolveReviseStrategy({
      variations: VARIATION_MATRIX,
      itemSku: null,
      platformOfferId: null,
    }),
    { kind: "none" },
  );
});

Deno.test("US-2395: revise and end answer the same question the same way", () => {
  // They must not drift. They differ ONLY in the no-mechanism case, and
  // deliberately: ending locally is a real outcome (the listing is closed in
  // FlipDesk), whereas a revise with no mechanism has done nothing.
  for (
    const input of [
      { variations: VARIATION_MATRIX, itemSku: "GT-1", platformOfferId: null },
      { variations: VARIATION_MATRIX, itemSku: "GT-1", platformOfferId: "o1" },
      { variations: null, itemSku: "GT-1", platformOfferId: "o1" },
    ]
  ) {
    assertEquals(
      resolveReviseStrategy(input),
      resolveEndStrategy(input) as never,
      `revise and end disagree for ${JSON.stringify(input)}`,
    );
  }
  const bare = { variations: null, itemSku: "GT-1", platformOfferId: null };
  assertEquals(resolveEndStrategy(bare), { kind: "local" });
  assertEquals(resolveReviseStrategy(bare), { kind: "none" });
});

// ── US-2395 AC1/AC3: the group-revise branch ────────────────────────────────
//
// These replace the test that pinned the temporary refusal. That refusal was
// honest while the branch did not exist ("edit it on eBay for now"); with the
// branch shipped it would be a lie, so the assertion that it STAYS is now the
// assertion that it is GONE.

const EBAY_SRC = Deno.readTextFileSync(
  new URL("../routes/flipdesk-ebay.ts", import.meta.url),
);

Deno.test("US-2395: the variation refusal is gone, because it is no longer true", () => {
  assertEquals(
    EBAY_SRC.includes("variation_revise_unsupported"),
    false,
    "the 'not supported yet' refusal is still in the revise path while the " +
      "group branch exists — a variation seller is being turned away from a " +
      "feature that works",
  );
});

Deno.test("US-2395: revise refuses only when the strategy resolves to none", () => {
  // The defect was an offer-first read of a row that will never have an offer
  // id. Keying the 409 on the resolver rather than on platform_offer_id is what
  // stops it coming back.
  const at = EBAY_SRC.indexOf("This listing has no eBay offer id");
  assertEquals(at > -1, true, "the generic refusal is gone entirely");
  const before = EBAY_SRC.slice(Math.max(0, at - 600), at);
  assertEquals(
    /reviseStrategy\.kind === "none"/.test(before),
    true,
    "the 409 is guarded by something other than the resolver, so a group " +
      "listing can be refused again",
  );
});

Deno.test("US-2395: the group push runs items, then group, then offers, then publish", () => {
  // Order is not cosmetic. The group references the variant items, so items
  // first; price and category live on the per-variant offers, not on the item;
  // and the publish call is what applies the lot.
  const fn = EBAY_SRC.slice(
    EBAY_SRC.indexOf("async function reviseVariationGroup"),
    EBAY_SRC.indexOf("export function resolveEndStrategy"),
  );
  assertEquals(fn.length > 0, true, "reviseVariationGroup not found");
  const order = [
    "createOrReplaceInventoryItem(",
    "createOrReplaceInventoryItemGroup(",
    "listOffersForSku(",
    "publishOfferByInventoryItemGroup(",
  ].map((needle) => fn.indexOf(needle));
  for (const [i, at] of order.entries()) {
    assertEquals(at > -1, true, `step ${i} is missing from the group revise`);
  }
  for (let i = 1; i < order.length; i++) {
    assertEquals(
      order[i]! > order[i - 1]!,
      true,
      `step ${i} runs before step ${i - 1} — the group revise order is wrong`,
    );
  }
});

Deno.test("US-2395: the group branch keys on the PINNED sku, never the item's", () => {
  // A SKU rename after publish would otherwise aim the revise at a group that
  // does not exist. Same reasoning US-1999 applied to the withdraw path.
  const call = EBAY_SRC.slice(
    EBAY_SRC.indexOf("return await reviseVariationGroup({"),
    EBAY_SRC.indexOf("return await reviseVariationGroup({") + 400,
  );
  assertEquals(
    /groupKey:\s*reviseStrategy\.groupKey/.test(call),
    true,
    "the group key no longer comes from the resolver, which is what pins it to " +
      "listings.inventory_sku",
  );
});

Deno.test("US-2395: quantity is refused on a group rather than applied to every variant", () => {
  const fn = EBAY_SRC.slice(
    EBAY_SRC.indexOf("async function reviseVariationGroup"),
    EBAY_SRC.indexOf("export function resolveEndStrategy"),
  );
  assertEquals(
    fn.includes("quantity_skipped"),
    true,
    "a quantity edit on a variation listing is silently ignored or, worse, " +
      "applied to every variant — one number times N variants is the seller's " +
      "stock multiplied",
  );
  assertEquals(
    /availableQuantity/.test(fn),
    false,
    "the group branch sends availableQuantity to a per-variant offer, which is " +
      "the multiplication this refusal exists to prevent",
  );
});

Deno.test("US-2395: a per-variant price survives a base-price edit", () => {
  // A variant deliberately priced differently must not be flattened by an edit
  // to the listing's base price.
  const fn = EBAY_SRC.slice(
    EBAY_SRC.indexOf("async function reviseVariationGroup"),
    EBAY_SRC.indexOf("export function resolveEndStrategy"),
  );
  assertEquals(
    /price !== undefined && variant\.price_cents == null \? price : undefined/.test(fn),
    true,
    "the price patch no longer excludes variants carrying their own price",
  );
});

Deno.test("US-2395: both paths clear the drift marker through one function", () => {
  // A revise that succeeded through the group and left sync_drift standing would
  // show "eBay differs" on a listing that no longer does.
  assertEquals(EBAY_SRC.includes("async function clearReviseDrift"), true);
  const calls = [...EBAY_SRC.matchAll(/await clearReviseDrift\(/g)].length;
  assertEquals(
    calls >= 2,
    true,
    `clearReviseDrift is called ${calls} time(s) — one of the two revise paths ` +
      "is not clearing the marker",
  );
});
