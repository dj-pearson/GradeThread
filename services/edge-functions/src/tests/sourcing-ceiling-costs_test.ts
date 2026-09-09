// US-3193: the buy ceiling stopped pricing postage, packaging and grading at zero.
import { assertEquals, assert } from "@std/assert";
import {
  DEFAULT_SOURCING_GRADING_CENTS,
  DEFAULT_SOURCING_SHIPPING_CENTS,
  DEFAULT_SOURCING_SUPPLIES_CENTS,
  sourcingCeiling,
  sourcingCostsTotalCents,
} from "../lib/scout-decision.ts";
import type { ValueRange } from "../lib/condition-value.ts";

/** A value range that clears the measured-curve gate, so a ceiling is produced. */
function measured(medianCents: number): ValueRange {
  return {
    sufficient: true,
    medianCents,
    lowCents: Math.round(medianCents * 0.8),
    highCents: Math.round(medianCents * 1.2),
    sampleSize: 12,
    basis: { source: "measured_curve" },
  } as unknown as ValueRange;
}

Deno.test("costs total: each line falls back to its documented default", () => {
  assertEquals(
    sourcingCostsTotalCents(undefined),
    DEFAULT_SOURCING_SHIPPING_CENTS +
      DEFAULT_SOURCING_SUPPLIES_CENTS +
      DEFAULT_SOURCING_GRADING_CENTS,
  );
});

Deno.test("costs total: a seller's own figures replace the defaults", () => {
  assertEquals(
    sourcingCostsTotalCents({
      shippingCents: 1060,
      suppliesCents: 50,
      gradingCents: 300,
    }),
    1410,
  );
});

Deno.test("costs total: a literal zero is honoured, not treated as unset", () => {
  // A seller who does not grade everything they source types 0, and must not be
  // charged the default grading fee for saying so.
  assertEquals(
    sourcingCostsTotalCents({ shippingCents: 0, suppliesCents: 0, gradingCents: 0 }),
    0,
  );
});

Deno.test("costs total: a nonsense figure falls back rather than being believed", () => {
  assertEquals(
    sourcingCostsTotalCents({
      shippingCents: -500,
      suppliesCents: Number.NaN,
      gradingCents: null,
    }),
    DEFAULT_SOURCING_SHIPPING_CENTS +
      DEFAULT_SOURCING_SUPPLIES_CENTS +
      DEFAULT_SOURCING_GRADING_CENTS,
  );
});

Deno.test("US-3193: the ceiling is LOWER than the pre-cost figure, by the exact cents", () => {
  // $100 median. eBay takes 13.6% + $0.40, so net proceeds are $86.00 in the
  // fee model both this and the composer share. At a 30% target the old ceiling
  // was floor(8600 / 1.3) = 6615. With $8.30 postage, $0.35 supplies and $2.00
  // grading subtracted first: floor((8600 - 1065) / 1.3) = 5796.
  const ceiling = sourcingCeiling({ value: measured(10000), targetRoi: 0.3 });
  assertEquals(ceiling.costsCents, 1065);
  assertEquals(ceiling.netResaleCents, 8600);
  assertEquals(ceiling.maxPriceCents, 5796);
  // The property that must hold whatever the fee model does later: strictly
  // below what the same inputs produced with costs priced at zero.
  const withoutCosts = sourcingCeiling({
    value: measured(10000),
    targetRoi: 0.3,
    costs: { shippingCents: 0, suppliesCents: 0, gradingCents: 0 },
  });
  assertEquals(withoutCosts.maxPriceCents, 6615);
  assert(ceiling.maxPriceCents! < withoutCosts.maxPriceCents!);
});

Deno.test("US-3193: costs that eat the whole margin report no_headroom, not a negative ceiling", () => {
  // A $5 item nets about $3.92 after eBay, which does not cover $10.65 of costs.
  const ceiling = sourcingCeiling({
    value: measured(500),
    targetRoi: 0.3,
    costs: { shippingCents: 830, suppliesCents: 35, gradingCents: 200 },
  });
  assertEquals(ceiling.maxPriceCents, null);
  assertEquals(ceiling.absentReason, "no_headroom");
  // The cost figure is still echoed, so a surface can explain the refusal.
  assertEquals(ceiling.costsCents, 1065);
});

Deno.test("US-3193: the absent branches still report the reason they always did", () => {
  const noCurve = sourcingCeiling({
    value: { ...measured(10000), basis: { source: "comp_median" } } as ValueRange,
    targetRoi: 0.3,
  });
  assertEquals(noCurve.absentReason, "no_measured_curve");
  assertEquals(noCurve.maxPriceCents, null);

  const thin = sourcingCeiling({
    value: { ...measured(10000), sufficient: false } as ValueRange,
    targetRoi: 0.3,
  });
  assertEquals(thin.absentReason, "insufficient_comps");
});
