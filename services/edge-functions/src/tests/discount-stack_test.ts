// US-2951: the discount stack.
//
// A markdown sale, a coupon and an accepted offer can all apply to one garment,
// and nothing added them up. The rule that matters most here is the ORDER — a
// coupon comes off the marked-down price, not the original — because applying
// it to the original UNDERSTATES the damage, and understating is the wrong
// direction for a safety check.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { describeStack, evaluateStack } = await import("../lib/discount-stack.ts");

Deno.test("a coupon comes off the MARKED-DOWN price, not the original", () => {
  // $100 listed, 20% sale, 10% coupon. Stacked correctly that is $72, not $70.
  // Getting it backwards would report a bigger discount than eBay applies,
  // which is the safe direction — but reporting the coupon against the ORIGINAL
  // price is the version that understates a three-way stack.
  const out = evaluateStack({
    priceCents: 10_000,
    costCents: 4_000,
    markdownPct: 20,
    couponPct: 10,
    marginFloorPct: 10,
  });
  assertEquals(out.worstCaseCents, 7_200);
});

Deno.test("an auto-accept CAPS the price rather than discounting it again", () => {
  // $100 listed, 20% sale takes it to $80, auto-accept at $65 caps it there.
  // Treating the accept as another percentage off would compound it.
  const out = evaluateStack({
    priceCents: 10_000,
    costCents: 4_000,
    markdownPct: 20,
    autoAcceptCents: 6_500,
    marginFloorPct: 10,
  });
  assertEquals(out.worstCaseCents, 6_500);
  assert(out.contributions.some((c) => c.kind === "auto-accepted offer"));
});

Deno.test("an auto-accept ABOVE the discounted price contributes nothing", () => {
  const out = evaluateStack({
    priceCents: 10_000,
    costCents: 4_000,
    markdownPct: 20,
    autoAcceptCents: 9_000,
    marginFloorPct: 10,
  });
  assertEquals(out.worstCaseCents, 8_000);
  assert(!out.contributions.some((c) => c.kind === "auto-accepted offer"));
});

Deno.test("a three-way stack below the floor is caught", () => {
  // $100 listed, cost $50, floor 10% = $55. 20% sale, 10% coupon and an
  // auto-accept at $50 puts it at $50 — under the floor.
  const out = evaluateStack({
    priceCents: 10_000,
    costCents: 5_000,
    markdownPct: 20,
    couponPct: 10,
    autoAcceptCents: 5_000,
    marginFloorPct: 10,
  });
  assertEquals(out.floorCents, 5_500);
  assertEquals(out.breaches, true);
  const line = describeStack(out);
  assert(line.includes("markdown sale"), line);
  assert(line.includes("coupon"), line);
  assert(line.includes("auto-accepted offer"), line);
  assert(line.includes("BELOW"), line);
});

Deno.test("shipping the seller absorbs counts against the floor", () => {
  // The number that catches the case a seller never sees: the item cleared the
  // floor on price and lost on postage.
  const out = evaluateStack({
    priceCents: 6_000,
    costCents: 5_000,
    shippingCostCents: 800,
    marginFloorPct: 10,
  });
  assertEquals(out.worstCaseCents, 5_200);
  assertEquals(out.floorCents, 5_500);
  assertEquals(out.breaches, true);
});

Deno.test("an UNKNOWN cost is unchecked, which is not the same as safe", () => {
  // The distinction the whole guard rests on. Labelling an unchecked item as
  // safe is the failure it exists to avoid.
  const out = evaluateStack({
    priceCents: 10_000,
    costCents: null,
    markdownPct: 40,
    couponPct: 30,
    marginFloorPct: 10,
  });
  assertEquals(out.unchecked, true);
  assertEquals(out.breaches, false);
  assertEquals(out.floorCents, null);
  assert(describeStack(out).includes("not checked"));
});

Deno.test("no discounts at all is a clean pass with no contributions", () => {
  const out = evaluateStack({ priceCents: 10_000, costCents: 4_000, marginFloorPct: 10 });
  assertEquals(out.worstCaseCents, 10_000);
  assertEquals(out.breaches, false);
  assertEquals(out.contributions.length, 0);
});
