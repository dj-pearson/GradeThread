// US-2790: the bug, expressed as arithmetic.
//
// autolister-bulk-edit.tsx called priceForMargin with no shippingCost, so
// "floor at 30% margin" across a batch priced every draft as if postage were
// free. This file does not test the page — it tests the CLAIM the page's fix
// rests on: that feeding a predicted parcel through the rate table moves the
// floor upward by a material amount on a real garment.
//
// Worth having separately from the two module suites, because both of those
// can pass while the floor still gets zero. The defect was never in the
// estimator or the rate table; it was in what the caller passed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateListingProfit, priceForMargin } from "../listing-profit";
import { estimateParcel } from "../parcel-estimate";
import { estimatePostage } from "../shipping-rates";

/** What the bulk grid now does, in one place, so the cases share it. */
function floorFor(
  item: Parameters<typeof estimateParcel>[0],
  targetMarginPct: number,
  costBasis: number,
) {
  const parcel = estimateParcel(item);
  const postage = estimatePostage(parcel.billableWeightOz);
  const withPostage = priceForMargin({
    targetMarginPct,
    costBasis,
    shippingCost: postage?.priceUsd ?? null,
  });
  const asShipped = priceForMargin({ targetMarginPct, costBasis });
  return { withPostage, asShipped, postage, parcel };
}

describe("US-2790: the margin floor stops pricing postage at zero", () => {
  it("raises the floor on a wool coat, which is the case in the story", () => {
    const { withPostage, asShipped, postage } = floorFor(
      {
        garmentCategory: "coat",
        material: "wool",
        measurements: { chest: 24 },
        size: "L",
      },
      30,
      40,
    );
    expect(postage).not.toBeNull();
    expect(withPostage).not.toBeNull();
    expect(asShipped).not.toBeNull();
    // The whole point: the old floor was LOWER, and a floor below your costs
    // is a loss you set on purpose.
    expect(withPostage!).toBeGreaterThan(asShipped!);
  });

  it("the gap is material, not a rounding artifact", () => {
    const { withPostage, asShipped, postage } = floorFor(
      { garmentCategory: "coat", material: "wool", measurements: null, size: null },
      30,
      40,
    );
    // Postage enters the numerator and is divided by (1 - fee - margin), so the
    // floor moves by MORE than the postage itself. Under-pricing by the raw
    // postage would already be bad; the real gap is larger.
    expect(withPostage! - asShipped!).toBeGreaterThan(postage!.priceUsd);
  });

  it("a light garment moves too — this is not only a heavy-item problem", () => {
    const { withPostage, asShipped } = floorFor(
      { garmentCategory: "t-shirt", material: "cotton", measurements: null, size: null },
      30,
      5,
    );
    expect(withPostage!).toBeGreaterThan(asShipped!);
  });

  it("the floor rises with the parcel, across the whole weight range", () => {
    // Monotonic: a heavier garment must never floor lower than a lighter one at
    // the same cost and margin. A band lookup that fell through would break
    // this without breaking either module's own tests.
    const light = floorFor(
      { garmentCategory: "t-shirt", material: "cotton", measurements: null, size: null },
      30,
      20,
    );
    const mid = floorFor(
      { garmentCategory: "jeans", material: "denim", measurements: null, size: null },
      30,
      20,
    );
    const heavy = floorFor(
      { garmentCategory: "coat", material: "wool", measurements: null, size: null },
      30,
      20,
    );
    expect(mid.withPostage!).toBeGreaterThanOrEqual(light.withPostage!);
    expect(heavy.withPostage!).toBeGreaterThanOrEqual(mid.withPostage!);
  });

  it("falls back to the OLD behaviour when no band covers the parcel", () => {
    // estimatePostage returns null above the heaviest sourced band. The caller
    // then passes null, which priceForMargin treats as zero — the pre-fix
    // behaviour. That is deliberate and it is why the page raises a toast:
    // silently reverting to free postage is the bug, saying so is not.
    const unpriceable = estimatePostage(100000);
    expect(unpriceable).toBeNull();
    const floor = priceForMargin({
      targetMarginPct: 30,
      costBasis: 40,
      shippingCost: unpriceable?.priceUsd ?? null,
    });
    expect(floor).toEqual(priceForMargin({ targetMarginPct: 30, costBasis: 40 }));
  });

  it("an unreachable margin is still unreachable with postage added", () => {
    // priceForMargin returns null when fee + margin >= 100%. Adding a cost must
    // not turn that into a finite number.
    const { withPostage } = floorFor(
      { garmentCategory: "coat", material: "wool", measurements: null, size: null },
      99,
      40,
    );
    expect(withPostage).toBeNull();
  });
});

describe("US-2790: the per-item profit figure counts postage too", () => {
  // item-card-list.tsx showed profit with no shipping, so every card read
  // higher than the sale would. Asserted here rather than in a render test:
  // the claim is arithmetic, and a render test would pass on a card that
  // displayed the right number for the wrong reason.
  it("lowers the shown profit once postage is counted", () => {
    const parcel = estimateParcel({
      garmentCategory: "coat",
      material: "wool",
      measurements: null,
      size: null,
    });
    const postage = estimatePostage(parcel.billableWeightOz);
    expect(postage).not.toBeNull();

    const withPostage = estimateListingProfit({
      price: 120,
      costBasis: 40,
      shippingCost: postage!.priceUsd,
    });
    const asShown = estimateListingProfit({ price: 120, costBasis: 40 });
    expect(withPostage.net).toBeLessThan(asShown.net);
    // And by the postage EXACTLY — net is linear in cost, unlike the floor,
    // which divides by (1 - fee - margin) and therefore moves by more.
    expect(asShown.net - withPostage.net).toBeCloseTo(postage!.priceUsd, 6);
    // The margin percentage drops with it; that is the number on the card.
    expect(withPostage.marginPct).toBeLessThan(asShown.marginPct);
    // And postage lands in `costs`, not in `fees` — a seller reading the
    // breakdown should see it where it actually is.
    expect(withPostage.costs - asShown.costs).toBeCloseTo(postage!.priceUsd, 6);
    expect(withPostage.fees).toBeCloseTo(asShown.fees, 6);
  });

  it("an uncovered parcel shows exactly what it showed before", () => {
    const none = estimatePostage(100000);
    expect(none).toBeNull();
    expect(
      estimateListingProfit({ price: 120, costBasis: 40, shippingCost: none?.priceUsd ?? null }),
    ).toEqual(estimateListingProfit({ price: 120, costBasis: 40 }));
  });

  it("the merchandising `category` is not what the estimator reads", () => {
    // items_full.category is coalesce(item_category, garment_category). Passing
    // it would fall through to the `other` base weight AND still report
    // basis ["category"] — a confident number from a wrong input.
    const wrong = estimateParcel({
      garmentCategory: "other",
      material: "wool",
      measurements: null,
      size: null,
    });
    const right = estimateParcel({
      garmentCategory: "coat",
      material: "wool",
      measurements: null,
      size: null,
    });
    expect(wrong.weightOz).not.toBeCloseTo(right.weightOz, 1);
    // Both claim a category basis, which is why the wrong one is dangerous
    // rather than merely inaccurate.
    expect(wrong.basis).toContain("category");
    expect(right.basis).toContain("category");
  });
});

describe("US-2790: the call sites keep passing postage", () => {
  // A WIRING property, so a source scan is the right instrument — the cases
  // above assert the arithmetic and a sabotage confirmed they stay green when
  // the page stops passing shippingCost at all. That is the regression this
  // catches and they cannot.
  //
  // COMMENTS ARE STRIPPED FIRST. Both files explain shippingCost at length in
  // prose, and a guard satisfied by the comment describing the thing it checks
  // is the failure US-2686 found here twice in one session.
  function code(rel: string): string {
    return readFileSync(resolve(process.cwd(), rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
  }

  it("item-card-list feeds predicted postage into the profit estimate", () => {
    const src = code("src/components/flipdesk/item-card-list.tsx");
    expect(src).toContain("estimateParcel(");
    expect(src).toContain("estimatePostage(");
    expect(src).toMatch(/shippingCost:\s*postage\?\.priceUsd/);
  });

  it("item-card-list reads garment_category, never the coalesced `category`", () => {
    // The trap this story keeps naming: items_full.category is
    // coalesce(item_category, garment_category), so it is a merchandising
    // value whenever one is set.
    const src = code("src/components/flipdesk/item-card-list.tsx");
    expect(src).toContain("garmentCategory: it.garment_category");
    expect(src).not.toMatch(/garmentCategory:\s*it\.category/);
  });

  it("the bulk grid still routes through the shared margin rule", () => {
    const src = code("src/pages/flipdesk/autolister-bulk-edit.tsx");
    expect(src).toContain("marginFloorWithPostage(");
    // And does NOT call priceForMargin directly again — three copies of a
    // pricing rule is how they end up disagreeing, which is why the rule was
    // extracted in the first place.
    expect(src).not.toContain("priceForMargin(");
  });
});
