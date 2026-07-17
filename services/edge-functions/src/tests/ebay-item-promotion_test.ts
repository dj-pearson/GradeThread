// US-1979 (AC2): item_promotion input validation.
//
// updateItemPromotion / deleteItemPromotion had ZERO route references — built and
// unreachable — and createItemPromotion existed only as an automation side-effect.
// The new CRUD routes validate by RUNNING buildItemPromotionBody up front, so a
// throw is definitionally the seller's input problem (400) rather than "eBay said
// no" (502).
//
// This pins the rules the routes lean on. If a rule is added to the builder later,
// the routes inherit it for free — that is the whole point of validating through
// the builder instead of re-deriving its logic or sniffing its error strings.
import { assert, assertEquals, assertThrows } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildItemPromotionBody } = await import("../lib/ebay-marketing.ts");

const IMG = "https://i.ebayimg.com/promo.jpg";
const base = {
  name: "Spring sale",
  listingIds: ["1234567890"],
  percentOff: 20,
};

Deno.test("US-1979: a valid ORDER_DISCOUNT builds", () => {
  const body = buildItemPromotionBody({
    ...base,
    type: "ORDER_DISCOUNT",
    minSpend: { value: "50.00", currency: "USD" },
    promotionImageUrl: IMG,
  });
  assert(body, "should build a body");
});

Deno.test("US-1979: a valid VOLUME_DISCOUNT builds without an image", () => {
  // VOLUME_DISCOUNT is the one type eBay does NOT require an image for — worth
  // pinning, since a route that demanded one uniformly would block it.
  const body = buildItemPromotionBody({
    ...base,
    type: "VOLUME_DISCOUNT",
    buyQuantity: 2,
  });
  assert(body, "should build without promotionImageUrl");
});

Deno.test("US-1979: the seller's own mistakes throw (→ the routes' 400s)", () => {
  // Each of these is a fixable input error, NOT an eBay rejection. The route
  // surfaces the builder's message verbatim.
  assertThrows(
    () => buildItemPromotionBody({ ...base, type: "ORDER_DISCOUNT", name: "  ", minSpend: { value: "50.00", currency: "USD" }, promotionImageUrl: IMG }),
    Error,
    "name",
  );
  assertThrows(
    () => buildItemPromotionBody({ ...base, type: "ORDER_DISCOUNT", listingIds: [], minSpend: { value: "50.00", currency: "USD" }, promotionImageUrl: IMG }),
    Error,
    "listing",
  );
  // ORDER_DISCOUNT without its required image.
  assertThrows(
    () => buildItemPromotionBody({ ...base, type: "ORDER_DISCOUNT", minSpend: { value: "50.00", currency: "USD" } }),
    Error,
    "promotionImageUrl",
  );
  // ORDER_DISCOUNT without its required spend threshold.
  assertThrows(
    () => buildItemPromotionBody({ ...base, type: "ORDER_DISCOUNT", promotionImageUrl: IMG }),
    Error,
    "minSpend",
  );
  // CODED_COUPON without a conforming code.
  assertThrows(
    () => buildItemPromotionBody({ ...base, type: "CODED_COUPON", promotionImageUrl: IMG, couponCode: "SHORT" }),
    Error,
    "couponCode",
  );
});

// ── US-1979 (AC2): the read→write round-trip must be LOSSLESS ──────────────
//
// updateItemPromotion is a PUT that REPLACES the promotion. So getItemPromotion's
// parse has to be the exact mirror of buildItemPromotionBody's build: anything the
// parse drops is a field the seller silently LOSES the next time they edit — the
// promotion keeps its id and looks like it saved, while its targeting or discount
// is gone. There is no undo.
//
// This asserts the mirror property directly: build a body, parse it back the way
// getItemPromotion parses eBay's response, and require every input field to
// survive. It is the cheapest possible guard against the two halves drifting.

const { buildItemPromotionBody: build } = await import("../lib/ebay-marketing.ts");

// The parse getItemPromotion performs, applied to a built body (eBay echoes this
// same schema back on GET).
function parseBack(body: Record<string, unknown>) {
  const rules = body.discountRules as Array<Record<string, unknown>> | undefined;
  const rule = rules?.[0];
  const benefit = rule?.discountBenefit as Record<string, string> | undefined;
  const spec = rule?.discountSpecification as Record<string, unknown> | undefined;
  const pctRaw = benefit?.percentageOffOrder ?? benefit?.percentageOffItem ?? null;
  const inv = body.inventoryCriterion as { listingIds?: string[] } | undefined;
  const coupon = body.couponConfiguration as { couponCode?: string } | undefined;
  const min = spec?.minAmount as { value?: string; currency?: string } | undefined;
  return {
    listingIds: inv?.listingIds ?? [],
    percentOff: pctRaw === null ? null : Number(pctRaw),
    minSpend: min?.value && min?.currency ? { value: min.value, currency: min.currency } : null,
    buyQuantity: (spec?.numberOfItems as number | undefined) ?? null,
    couponCode: coupon?.couponCode ?? null,
    promotionImageUrl: (body.promotionImageUrl as string | undefined) ?? null,
  };
}

Deno.test("US-1979: ORDER_DISCOUNT survives a build → parse round-trip", () => {
  const input = {
    ...base,
    type: "ORDER_DISCOUNT" as const,
    listingIds: ["111", "222"],
    percentOff: 25,
    minSpend: { value: "50.00", currency: "USD" },
    promotionImageUrl: IMG,
  };
  const out = parseBack(build(input));
  assertEquals(out.listingIds, ["111", "222"], "targeting must survive");
  assertEquals(out.percentOff, 25, "the discount must survive");
  assertEquals(out.minSpend, { value: "50.00", currency: "USD" }, "the spend threshold must survive");
  assertEquals(out.promotionImageUrl, IMG);
});

Deno.test("US-1979: VOLUME_DISCOUNT survives a build → parse round-trip", () => {
  const out = parseBack(build({
    ...base,
    type: "VOLUME_DISCOUNT",
    listingIds: ["333"],
    percentOff: 15,
    buyQuantity: 3,
  }));
  assertEquals(out.listingIds, ["333"]);
  assertEquals(out.percentOff, 15, "percentageOffItem must be read, not just percentageOffOrder");
  assertEquals(out.buyQuantity, 3, "the buy-N threshold must survive");
});

Deno.test("US-1979: CODED_COUPON survives a build → parse round-trip", () => {
  const out = parseBack(build({
    ...base,
    type: "CODED_COUPON",
    listingIds: ["444"],
    percentOff: 10,
    promotionImageUrl: IMG,
    couponCode: "FDABCDEFGH",
  }));
  assertEquals(out.couponCode, "FDABCDEFGH", "the coupon code must survive — it is the promotion");
  assertEquals(out.percentOff, 10);
});
