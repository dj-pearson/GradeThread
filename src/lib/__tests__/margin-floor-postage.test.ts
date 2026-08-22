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
import { describe, expect, it } from "vitest";
import { priceForMargin } from "../listing-profit";
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
