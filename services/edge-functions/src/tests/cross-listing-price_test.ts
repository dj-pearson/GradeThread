// US-2736: the per-platform price, end to end.
//
// The blank-price half of this story (the eBay draft was the ONLY source, so an
// item priced on the item itself reached every channel as 0) was closed in
// August. What was left is the other half the title names: the price that
// reaches a non-eBay marketplace was the shared eBay number, unstepped, and a
// per-channel price could not survive being written.
//
// Three things are pinned here, all in EXACT CENTS:
//
//  1. The marketplace's own units. Poshmark's listing-price input is
//     inputmode="numeric" pattern="[0-9]*". A sibling row recording 3249 cents
//     for a listing Poshmark can only hold at 3200 is a row that disagrees with
//     the marketplace about what the seller gets paid, and every downstream
//     number (profit, reconciliation, the revise the extension types) is then
//     wrong by the difference.
//  2. A per-channel price the seller set survives the round trip. It is stored
//     as `price_override` on the sibling's own platform_fields blob, read back
//     on the next push, and beats the shared price — which is what stops a
//     re-push from silently repricing a channel back to eBay's number.
//  3. Nothing is invented. No price anywhere resolves to 0, never to a guess,
//     and a negative never becomes a listing price.
//
// Pure: no env, no network. Imports only the mapping + registry modules.
import { assert, assertEquals } from "@std/assert";
import {
  mapSiblingListingFields,
  resolveSiblingPrice,
  type StoredPlatformVariant,
} from "../lib/cross-listing-fields.ts";
import { dollarsToCents } from "../lib/marketplace-price.ts";

const SOURCE = {
  listing_title: "Nike Tech Fleece Hoodie M Black",
  listing_description: "Great pre-owned Nike Tech Fleece hoodie. Minor wash wear, no flaws.",
};

const VARIANT: StoredPlatformVariant = {
  title: "Nike Tech Fleece Hoodie M Black",
  description: "Cozy Nike Tech Fleece in black, size M.",
  condition: { value: "EUC", label: "EUC (Excellent Used Condition)" },
  category: "Tops",
  brand: "Nike",
  color: "Black",
  size: "M",
  price: 45,
  tags: ["#nike"],
  confidence: 0.82,
  generated_at: "2026-06-12T00:00:00.000Z",
};

// ── 1. The marketplace's own units ────────────────────────────────────────

Deno.test("US-2736: a Poshmark sibling records the whole dollars Poshmark can hold", () => {
  // 3249 cents is what a markdown rule writes to the shared eBay price.
  const out = mapSiblingListingFields("poshmark", SOURCE, 32.49, VARIANT);
  assertEquals(dollarsToCents(out.listing_price), 3200);
  assertEquals(dollarsToCents(out.platform_fields!.poshmark.price!), 3200);
});

Deno.test("US-2736: the row and the blob can never disagree about the price", () => {
  for (const dollars of [32.49, 32.5, 0.4, 199.99]) {
    const out = mapSiblingListingFields("poshmark", SOURCE, dollars, VARIANT);
    assertEquals(
      dollarsToCents(out.listing_price),
      dollarsToCents(out.platform_fields!.poshmark.price!),
      `poshmark ${dollars}`,
    );
  }
});

Deno.test("US-2736: a cents marketplace keeps its cents", () => {
  const out = mapSiblingListingFields("etsy", SOURCE, 32.49, VARIANT);
  assertEquals(dollarsToCents(out.listing_price), 3249);
  assertEquals(dollarsToCents(out.platform_fields!.etsy.price!), 3249);
});

Deno.test("US-2736: rounding is NEAREST, so stepping never costs the seller a dollar", () => {
  assertEquals(resolveSiblingPrice("poshmark", { sharedPrice: 32.5 }).priceCents, 3300);
  assertEquals(resolveSiblingPrice("poshmark", { sharedPrice: 32.49 }).priceCents, 3200);
  // Never below one step: a 40c item is $1 on Poshmark, never $0.
  assertEquals(resolveSiblingPrice("poshmark", { sharedPrice: 0.4 }).priceCents, 100);
});

// ── 2. The per-channel price survives the round trip ──────────────────────

Deno.test("US-2736: an explicit per-channel price beats the shared one", () => {
  const r = resolveSiblingPrice("poshmark", {
    explicitPrice: 40,
    overridePrice: 36,
    sharedPrice: 32.49,
  });
  assertEquals(r.priceCents, 4000);
  assertEquals(r.source, "explicit");
});

Deno.test("US-2736: a stored override is READ BACK and beats the shared price", () => {
  // The re-push that used to reprice Depop back to eBay's number: nothing
  // explicit was sent, and the shared price is all the route had.
  const r = resolveSiblingPrice("depop", { overridePrice: 36.5, sharedPrice: 32.49 });
  assertEquals(r.priceCents, 3650);
  assertEquals(r.source, "override");
});

Deno.test("US-2736: an override is WRITTEN where the next push will find it", () => {
  const out = mapSiblingListingFields("poshmark", SOURCE, 40, VARIANT, 40);
  const blob = out.platform_fields!.poshmark;
  assertEquals(dollarsToCents(blob.price_override!), 4000);
  assertEquals(dollarsToCents(blob.price!), 4000);
  assertEquals(dollarsToCents(out.listing_price), 4000);
});

Deno.test("US-2736: an override is recorded even when the kit never ran", () => {
  const out = mapSiblingListingFields("poshmark", SOURCE, 41, undefined, 41);
  assert(out.platform_fields, "an override with no variant still needs somewhere to live");
  assertEquals(dollarsToCents(out.platform_fields!.poshmark.price_override!), 4100);
});

Deno.test("US-2736: an override is stepped before it is stored, like every other price", () => {
  const out = mapSiblingListingFields("poshmark", SOURCE, 40.75, VARIANT, 40.75);
  assertEquals(dollarsToCents(out.platform_fields!.poshmark.price_override!), 4100);
  assertEquals(dollarsToCents(out.listing_price), 4100);
});

Deno.test("US-2736: no override written when the seller never set one", () => {
  const out = mapSiblingListingFields("poshmark", SOURCE, 38, VARIANT);
  assertEquals(out.platform_fields!.poshmark.price_override, undefined);
  // and no blob at all when there is neither a variant nor an override, so a
  // sibling's previously generated fields are never clobbered with a stub.
  assertEquals(mapSiblingListingFields("mercari", SOURCE, 30, undefined).platform_fields, null);
});

// ── 3. Nothing is invented ────────────────────────────────────────────────

Deno.test("US-2736: no price anywhere resolves to 0 cents, never a guess", () => {
  const r = resolveSiblingPrice("poshmark", {
    explicitPrice: null,
    overridePrice: null,
    sharedPrice: 0,
  });
  assertEquals(r.priceCents, 0);
  assertEquals(r.source, "none");
});

Deno.test("US-2736: a zero or negative candidate is skipped, never listed", () => {
  // A stale 0 on a sibling row must not shadow a real shared price — the same
  // first-POSITIVE rule the kit and the generator already use.
  assertEquals(resolveSiblingPrice("depop", { overridePrice: 0, sharedPrice: 32 }).priceCents, 3200);
  assertEquals(resolveSiblingPrice("depop", { overridePrice: -5, sharedPrice: 32 }).priceCents, 3200);
  assertEquals(resolveSiblingPrice("depop", { sharedPrice: -5 }).priceCents, 0);
  assertEquals(mapSiblingListingFields("poshmark", SOURCE, -5, VARIANT).listing_price, 0);
});

Deno.test("US-2736: a non-finite candidate is skipped rather than stored as NaN", () => {
  assertEquals(
    resolveSiblingPrice("poshmark", { explicitPrice: Number.NaN, sharedPrice: 32 }).priceCents,
    3200,
  );
  assertEquals(
    resolveSiblingPrice("poshmark", { explicitPrice: Number.POSITIVE_INFINITY, sharedPrice: 32 })
      .priceCents,
    3200,
  );
});

// ── The wiring, which needs a Supabase client and so is read rather than run ──
//
// crossPushPlatform cannot be driven from a test: supabaseAdmin is a Proxy that
// always resolves to the real client. These assert the three lines that make
// the round trip real, the same arrangement cross-push-queue_test.ts uses.

Deno.test("US-2736: cross-push reads the sibling's own price back before deciding", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/cross-push.ts", import.meta.url),
  );
  assert(
    src.includes("resolveSiblingPrice("),
    "cross-push must resolve the per-platform price through the one rule",
  );
  // US-3367 widened the same select with listing_status and listing_url for
  // the re-list guard; what this pins is that platform_fields is still read.
  assert(
    /\.select\(\s*"id, platform_fields(, [a-z_, ]+)?"/.test(src),
    "the sibling lookup must read the stored per-channel override back",
  );
});

Deno.test("US-2736: cross-push writes ONE resolved price to the row, the blob and the adapter", () => {
  const src = Deno.readTextFileSync(
    new URL("../lib/cross-push.ts", import.meta.url),
  );
  // The row write and the publish both take the mapped (stepped) price, so the
  // listings row can never record a number the marketplace refused.
  assert(
    !/listing_price:\s*price\b/.test(src),
    "the row must be written from the resolved price, not the caller's shared one",
  );
  assertEquals(
    src.match(/listing_price:\s*mapped\.listing_price/g)?.length,
    2,
    "both the update and the insert write the resolved price",
  );
  assert(
    /price:\s*mapped\.listing_price/.test(src),
    "adapter.publish must be given the resolved price too",
  );
});

// ── The generated variant is stored in the marketplace's units ────────────
//
// assemblePlatformVariant did its own `Math.round(cents) / 100` — a fifth unit
// crossing outside marketplace-price.ts, and an unstepped one. A generated
// Poshmark variant therefore sat in platform_fields at 3249 cents while every
// surface that read it (the kit row, the ready-to-list check, both payload
// builders) displayed and typed 3200. The stored number is what profit and
// reconciliation read, so it has to be the real one.
Deno.test("US-2736: a generated Poshmark variant is stored in whole dollars", async () => {
  const { assemblePlatformVariant } = await import("../lib/platform-variants.ts");
  const base = {
    title: "Nike Tech Fleece Hoodie",
    description: "Great shape.",
    brand: "Nike",
    size: "M",
    color: "Black",
    material: null,
    itemSpecifics: {},
    gradeValue: 8.2,
    gradeLabel: "Excellent",
    priceCents: 3249,
    categoryQuery: "Tops",
    confidence: 0.8,
  };
  const text = { title: "Nike Tech Fleece Hoodie", description: "Great shape.", tags: [] };
  assertEquals(
    dollarsToCents(assemblePlatformVariant("poshmark", base, text).price),
    3200,
  );
  // Everyone else keeps their cents, exactly.
  assertEquals(
    dollarsToCents(assemblePlatformVariant("mercari", base, text).price),
    3249,
  );
});
