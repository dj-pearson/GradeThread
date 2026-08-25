// US-2851: the sourcing ceiling.
//
// This is the most committal number the product produces: a seller reads it and
// hands over cash. So the tests here are mostly about when it REFUSES to appear.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { DECISION_MAYBE_ROI, sourcingCeiling } from "../lib/scout-decision.ts";
import {
  MAX_SOURCING_TARGET_PCT,
  type SourcingSettingsClient,
  sourcingTargetRoi,
  targetRoiFromPct,
} from "../lib/sourcing-target.ts";
import { ebayNetProceedsCents } from "../lib/ebay-fees.ts";
import { type ValueRange } from "../lib/condition-value-math.ts";
import { describeValueBasis } from "../lib/value-disclosure.ts";

function range(over: Partial<ValueRange> = {}): ValueRange {
  return {
    lowCents: 3500,
    medianCents: 5000,
    highCents: 6500,
    sampleSize: 14,
    confidence: 0.7,
    sufficient: true,
    currency: "USD",
    basis: describeValueBasis({
      source: "measured_curve",
      sufficient: true,
      sampleSize: 14,
      medianCents: 5000,
      slopeCentsPerPoint: 900,
    }),
    ...over,
  };
}

const medianBasis = describeValueBasis({
  source: "comp_median",
  sufficient: true,
  sampleSize: 30,
  medianCents: 5000,
});

// -- when it refuses -------------------------------------------------

Deno.test("no measured curve, no ceiling", () => {
  const c = sourcingCeiling({ value: range({ basis: medianBasis }), targetRoi: 0.3 });
  assertEquals(c.maxPriceCents, null);
  assertEquals(c.absentReason, "no_measured_curve");
});

Deno.test("a range with no basis at all gets no ceiling", () => {
  // A payload assembled before US-2850, or by a path that forgot to carry the
  // basis across, must not be read as a measured one by omission.
  const c = sourcingCeiling({ value: range({ basis: undefined }), targetRoi: 0.3 });
  assertEquals(c.maxPriceCents, null);
  assertEquals(c.absentReason, "no_measured_curve");
});

Deno.test("insufficient comps get no ceiling", () => {
  const c = sourcingCeiling({
    value: range({ sufficient: false, medianCents: null }),
    targetRoi: 0.3,
  });
  assertEquals(c.maxPriceCents, null);
  assertEquals(c.absentReason, "insufficient_comps");
});

Deno.test("an item whose fees eat it whole gets no ceiling, not a zero", () => {
  const c = sourcingCeiling({ value: range({ medianCents: 1 }), targetRoi: 0.3 });
  assertEquals(c.maxPriceCents, null);
  assertEquals(c.absentReason, "no_headroom");
});

// -- the arithmetic --------------------------------------------------

Deno.test("paying the ceiling hits the target, and a cent more misses it", () => {
  const value = range();
  const target = 0.3;
  const c = sourcingCeiling({ value, targetRoi: target });
  assert(c.maxPriceCents != null);

  const net = ebayNetProceedsCents(value.medianCents as number);
  assertEquals(c.netResaleCents, net);

  const atCeiling = (net - c.maxPriceCents!) / c.maxPriceCents!;
  assert(atCeiling >= target, `paying the ceiling missed the target: ${atCeiling}`);

  const overBy = c.maxPriceCents! + 1;
  const above = (net - overBy) / overBy;
  assert(above < target, `a cent over the ceiling still cleared the target: ${above}`);
});

Deno.test("the ceiling sits BELOW breakeven, which is the whole point", () => {
  const value = range();
  const net = ebayNetProceedsCents(value.medianCents as number);
  const c = sourcingCeiling({ value, targetRoi: 0.3 });
  assert(c.maxPriceCents! < net, "the ceiling was not below breakeven");
});

Deno.test("a higher target buys cheaper", () => {
  const value = range();
  const low = sourcingCeiling({ value, targetRoi: 0.3 }).maxPriceCents!;
  const high = sourcingCeiling({ value, targetRoi: 1.0 }).maxPriceCents!;
  assert(high < low, "doubling the target did not lower the ceiling");
});

Deno.test("a zero target is allowed and equals breakeven", () => {
  const value = range();
  const c = sourcingCeiling({ value, targetRoi: 0 });
  assertEquals(c.maxPriceCents, ebayNetProceedsCents(value.medianCents as number));
});

Deno.test("a negative or unusable target is floored at zero, never inverted", () => {
  const value = range();
  const neg = sourcingCeiling({ value, targetRoi: -0.5 });
  assertEquals(neg.targetRoi, 0);
  assertEquals(neg.maxPriceCents, ebayNetProceedsCents(value.medianCents as number));
  const nan = sourcingCeiling({ value, targetRoi: Number.NaN });
  assertEquals(nan.targetRoi, 0);
});

// -- the setting -----------------------------------------------------

Deno.test("an unset target falls back to the threshold the verdict already uses", () => {
  // Not a new multiplier: DECISION_MAYBE_ROI is what already decides whether
  // the same response calls this item a maybe.
  assertEquals(targetRoiFromPct(null), DECISION_MAYBE_ROI);
  assertEquals(targetRoiFromPct(undefined), DECISION_MAYBE_ROI);
});

Deno.test("whole percent becomes a fraction", () => {
  assertEquals(targetRoiFromPct(30), 0.3);
  assertEquals(targetRoiFromPct(0), 0);
  assertEquals(targetRoiFromPct(MAX_SOURCING_TARGET_PCT), 10);
});

Deno.test("a value the column would have refused is not honoured", () => {
  // Out of range means something bypassed the CHECK in 00666. Using it would
  // set a spending ceiling off a number the database rejects.
  assertEquals(targetRoiFromPct(-5), DECISION_MAYBE_ROI);
  assertEquals(targetRoiFromPct(MAX_SOURCING_TARGET_PCT + 1), DECISION_MAYBE_ROI);
  assertEquals(targetRoiFromPct(Number.NaN), DECISION_MAYBE_ROI);
});

function settingsClient(
  row: { sourcing_target_roi_pct: number | null } | null,
  onEq: (col: string, val: string) => void = () => {},
  error: { message: string } | null = null,
): SourcingSettingsClient {
  return {
    from: () => ({
      select: () => ({
        eq: (col: string, val: string) => {
          onEq(col, val);
          return { maybeSingle: () => Promise.resolve({ data: row, error }) };
        },
      }),
    }),
  };
}

Deno.test("the setting read is scoped to the owner (US-268)", async () => {
  const seen: Array<[string, string]> = [];
  await sourcingTargetRoi(
    "owner-1",
    settingsClient({ sourcing_target_roi_pct: 45 }, (col, val) => {
      seen.push([col, val]);
    }),
  );
  assertEquals(seen, [["user_id", "owner-1"]]);
});

Deno.test("the owner's target is what comes back", async () => {
  assertEquals(
    await sourcingTargetRoi("o", settingsClient({ sourcing_target_roi_pct: 45 })),
    0.45,
  );
});

Deno.test("no settings row means the default, not a broken ceiling", async () => {
  assertEquals(await sourcingTargetRoi("o", settingsClient(null)), DECISION_MAYBE_ROI);
});

Deno.test("a read failure means the default, never a throw into the aisle", async () => {
  assertEquals(
    await sourcingTargetRoi("o", settingsClient(null, () => {}, { message: "db down" })),
    DECISION_MAYBE_ROI,
  );
  const exploding: SourcingSettingsClient = {
    from: () => {
      throw new Error("boom");
    },
  };
  assertEquals(await sourcingTargetRoi("o", exploding), DECISION_MAYBE_ROI);
});
