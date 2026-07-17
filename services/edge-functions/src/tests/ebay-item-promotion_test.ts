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
import { assert, assertThrows } from "@std/assert";

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
