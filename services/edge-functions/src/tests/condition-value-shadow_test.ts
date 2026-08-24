// US-2848: the shadow comparison, and the two promises it makes.
//
// The interesting assertions here are the refusals, not the arithmetic: a grade
// outside the measured span must not be answered, and anything at all going
// wrong inside the shadow must leave the caller's value untouched.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  buildObservation,
  CURVE_CACHE_TTL_MS,
  type MeasuredCurve,
  measuredFlipEnabled,
  measuredRangeAtGrade,
  observeMeasuredShadow,
  readMeasuredCurve,
  resetShadowCounters,
  resetShadowCurveCache,
  shadowCounters,
  type ShadowCurveClient,
  shouldServeMeasured,
  type ShadowSampleRow,
  type ShadowWriteClient,
  shadowEnabled,
  SHADOW_SAMPLES_TABLE,
  summarizeShadowDeltas,
  toShadowSampleRow,
} from "../lib/condition-value-shadow.ts";
import { type ValueRange } from "../lib/condition-value-math.ts";
import { applyMeasuredCurve } from "../lib/condition-value.ts";

// A measured curve over grades 4..9, 1000 cents per grade point, band 500.
function curve(over: Partial<MeasuredCurve> = {}): MeasuredCurve {
  const points = [4, 5, 6, 7, 8, 9].map((grade) => ({
    grade,
    lowCents: grade * 1000 - 500,
    medianCents: grade * 1000,
    highCents: grade * 1000 + 500,
    sampleSize: grade,
    sufficient: true,
  }));
  // The grades the fit never observed come back the way US-2847 writes them.
  points.push({
    grade: 10,
    lowCents: null,
    medianCents: null,
    highCents: null,
    sampleSize: 0,
    sufficient: false,
  } as unknown as typeof points[number]);
  return {
    itemKey: "patagonia|11450|better sweater",
    currency: "USD",
    points,
    fitConfidence: 0.71,
    slopeCentsPerPoint: 1000,
    measuredAt: "2026-08-24T00:00:00.000Z",
    ...over,
  };
}

const live = (over: Partial<ValueRange> = {}): ValueRange => ({
  lowCents: 5000,
  medianCents: 6200,
  highCents: 7400,
  sampleSize: 18,
  confidence: 0.8,
  sufficient: true,
  currency: "USD",
  ...over,
});

// ── the measured range ──────────────────────────────────────────────

Deno.test("measured range at an observed grade is that point", () => {
  const r = measuredRangeAtGrade(curve(), 7);
  assertEquals(r.sufficient, true);
  assertEquals(r.medianCents, 7000);
  assertEquals(r.lowCents, 6500);
  assertEquals(r.highCents, 7500);
  assertEquals(r.sampleSize, 7);
  assertEquals(r.confidence, 0.71);
});

Deno.test("between two observed grades the range interpolates", () => {
  const r = measuredRangeAtGrade(curve(), 7.5);
  assertEquals(r.sufficient, true);
  assertEquals(r.medianCents, 7500);
  // Understates on purpose: the smaller of the two bracketing sample sizes.
  assertEquals(r.sampleSize, 7);
  assert(r.lowCents! <= r.medianCents!);
  assert(r.medianCents! <= r.highCents!);
});

Deno.test("a grade above the observed span is refused, never extrapolated", () => {
  const r = measuredRangeAtGrade(curve(), 9.5);
  assertEquals(r.sufficient, false);
  assertEquals(r.medianCents, null);
  assertEquals(r.sampleSize, 0);
});

Deno.test("a grade below the observed span is refused too", () => {
  const r = measuredRangeAtGrade(curve(), 3);
  assertEquals(r.sufficient, false);
  assertEquals(r.medianCents, null);
});

Deno.test("insufficient points do not extend the span", () => {
  // Grade 10 is present but insufficient, so 9.5 is still outside the span.
  const r = measuredRangeAtGrade(curve(), 10);
  assertEquals(r.sufficient, false);
});

Deno.test("a null grade and an empty curve both come back insufficient", () => {
  assertEquals(measuredRangeAtGrade(curve(), null).sufficient, false);
  assertEquals(measuredRangeAtGrade(curve({ points: [] }), 7).sufficient, false);
});

// ── the observation ─────────────────────────────────────────────────

Deno.test("delta is measured minus live, and only when both answered", () => {
  const o = buildObservation("cell", 7, live(), measuredRangeAtGrade(curve(), 7));
  assertEquals(o.liveMedianCents, 6200);
  assertEquals(o.measuredMedianCents, 7000);
  assertEquals(o.deltaCents, 800);

  const noMeasured = buildObservation("cell", 9.5, live(), measuredRangeAtGrade(curve(), 9.5));
  assertEquals(noMeasured.deltaCents, null);
  assertEquals(noMeasured.measuredSufficient, false);

  const noLive = buildObservation(
    "cell",
    7,
    live({ sufficient: false, medianCents: null }),
    measuredRangeAtGrade(curve(), 7),
  );
  assertEquals(noLive.deltaCents, null);
});

Deno.test("the sample row carries no identity of any kind", () => {
  const row = toShadowSampleRow(
    buildObservation("cell", 7, live(), measuredRangeAtGrade(curve(), 7)),
  );
  const banned = ["user", "seller", "listing", "submission", "url", "title", "owner"];
  for (const key of Object.keys(row)) {
    for (const b of banned) {
      assert(!key.includes(b), `sample row must not carry ${key}`);
    }
  }
});

// ── the lookup ──────────────────────────────────────────────────────

function readClient(
  row: Record<string, unknown> | null,
  onCall: () => void = () => {},
  error: { message: string } | null = null,
): ShadowCurveClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => {
              onCall();
              return Promise.resolve({ data: row, error });
            },
          }),
        }),
      }),
    }),
  };
}

function writeClient(sink: ShadowSampleRow[], error: { message: string } | null = null): ShadowWriteClient {
  return {
    from: (table: string) => ({
      insert: (row: ShadowSampleRow) => {
        assertEquals(table, SHADOW_SAMPLES_TABLE);
        if (!error) sink.push(row);
        return Promise.resolve({ error });
      },
    }),
  };
}

const CURVE_ROW = {
  item_key: "patagonia|11450|better sweater",
  currency: "USD",
  curve: curve().points,
  fit_confidence: 0.71,
  slope_cents_per_point: 1000,
  measured_at: "2026-08-24T00:00:00.000Z",
};

Deno.test("a repeat lookup inside the TTL costs no second read", async () => {
  resetShadowCurveCache();
  let calls = 0;
  const client = readClient(CURVE_ROW, () => calls++);
  await readMeasuredCurve(client, "k", 1000);
  await readMeasuredCurve(client, "k", 1000 + CURVE_CACHE_TTL_MS - 1);
  assertEquals(calls, 1);
  await readMeasuredCurve(client, "k", 1000 + CURVE_CACHE_TTL_MS + 1);
  assertEquals(calls, 2);
});

Deno.test("a read error is not cached", async () => {
  resetShadowCurveCache();
  let calls = 0;
  const client = readClient(null, () => calls++, { message: "boom" });
  for (let i = 0; i < 2; i++) {
    try {
      await readMeasuredCurve(client, "k", 1000);
    } catch { /* expected */ }
  }
  assertEquals(calls, 2);
});

// ── the orchestrator ────────────────────────────────────────────────

Deno.test("no measured curve: nothing written, counted as missing", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  const written: ShadowSampleRow[] = [];
  const out = await observeMeasuredShadow(
    { read: readClient(null), write: writeClient(written) },
    { categoryId: "11450", brand: "Patagonia", q: "Better Sweater" },
    7,
    live(),
  );
  assertEquals(out.served, "live");
  assertEquals(out.range, live());
  assertEquals(out.measured, null);
  assertEquals(written.length, 0);
  assertEquals(shadowCounters().missing, 1);
  assertEquals(shadowCounters().observed, 0);
});

Deno.test("a measured curve is compared, recorded, and keyed by the cell", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  const written: ShadowSampleRow[] = [];
  const out = await observeMeasuredShadow(
    { read: readClient(CURVE_ROW), write: writeClient(written) },
    { categoryId: "11450", brand: "Patagonia", q: "Better Sweater" },
    7,
    live(),
  );
  assertEquals(out.measured?.medianCents, 7000);
  // Flag off by default: the live range is still what ships.
  assertEquals(out.served, "live");
  assertEquals(out.range.medianCents, 6200);
  assertEquals(written.length, 1);
  assertEquals(written[0].cell_key, "patagonia|11450|better sweater");
  assertEquals(written[0].delta_cents, 800);
  assertEquals(shadowCounters().observed, 1);
  assertEquals(shadowCounters().servedMeasured, 0);
});

Deno.test("a throw inside the shadow is swallowed and counted", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  const exploding: ShadowCurveClient = {
    from: () => {
      throw new Error("shadow blew up");
    },
  };
  const out = await observeMeasuredShadow(
    { read: exploding, write: writeClient([]) },
    { categoryId: "11450", brand: "Patagonia" },
    7,
    live(),
  );
  assertEquals(out.served, "live");
  assertEquals(out.range, live());
  assertEquals(shadowCounters().failed, 1);
});

Deno.test("a failed write is counted, not thrown", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  const out = await observeMeasuredShadow(
    { read: readClient(CURVE_ROW), write: writeClient([], { message: "denied" }) },
    { categoryId: "11450", brand: "Patagonia", q: "Better Sweater" },
    7,
    live(),
  );
  // The comparison still happened; only its durable record failed.
  assertEquals(out.measured?.medianCents, 7000);
  assertEquals(shadowCounters().failed, 1);
  assertEquals(shadowCounters().observed, 1);
});

Deno.test("disabled means no lookup at all", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  let calls = 0;
  const out = await observeMeasuredShadow(
    { read: readClient(CURVE_ROW, () => calls++), write: writeClient([]), enabled: false },
    { categoryId: "11450" },
    7,
    live(),
  );
  assertEquals(out.served, "live");
  assertEquals(out.range, live());
  assertEquals(calls, 0);
});

Deno.test("the kill switch is off-by-explicit-false only", () => {
  assertEquals(shadowEnabled(() => undefined), true);
  assertEquals(shadowEnabled(() => "true"), true);
  assertEquals(shadowEnabled(() => "FALSE"), false);
});

// ── the flip (US-2849) ──────────────────────────────────────────────

Deno.test("the flip flag is off unless explicitly turned on", () => {
  assertEquals(measuredFlipEnabled(() => undefined), false);
  assertEquals(measuredFlipEnabled(() => ""), false);
  assertEquals(measuredFlipEnabled(() => "false"), false);
  assertEquals(measuredFlipEnabled(() => "TRUE"), true);
  assertEquals(measuredFlipEnabled(() => "1"), true);
  assertEquals(measuredFlipEnabled(() => "on"), true);
});

Deno.test("shouldServeMeasured refuses an insufficient range even with the flag on", () => {
  const good = measuredRangeAtGrade(curve(), 7);
  const refused = measuredRangeAtGrade(curve(), 9.5);
  assertEquals(shouldServeMeasured(good, true), true);
  assertEquals(shouldServeMeasured(good, false), false);
  assertEquals(shouldServeMeasured(refused, true), false);
  assertEquals(shouldServeMeasured(null, true), false);
});

Deno.test("flag on: the measured range is what ships", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  const written: ShadowSampleRow[] = [];
  const out = await observeMeasuredShadow(
    { read: readClient(CURVE_ROW), write: writeClient(written), flip: true },
    { categoryId: "11450", brand: "Patagonia", q: "Better Sweater" },
    7,
    live(),
  );
  assertEquals(out.served, "measured");
  assertEquals(out.range.medianCents, 7000);
  assertEquals(shadowCounters().servedMeasured, 1);
  // The comparison is still recorded when the flip is on: the point of the
  // table survives the flip, or nobody can audit what the flip did.
  assertEquals(written.length, 1);
});

Deno.test("flag on but the grade is outside the measured span: live still ships", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  const out = await observeMeasuredShadow(
    { read: readClient(CURVE_ROW), write: writeClient([]), flip: true },
    { categoryId: "11450", brand: "Patagonia", q: "Better Sweater" },
    9.5,
    live(),
  );
  assertEquals(out.served, "live");
  assertEquals(out.range.medianCents, 6200);
  assertEquals(shadowCounters().servedMeasured, 0);
});

Deno.test("flag on but the shadow throws: live still ships, price never breaks", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  const exploding: ShadowCurveClient = {
    from: () => {
      throw new Error("curve read exploded mid-flip");
    },
  };
  const out = await observeMeasuredShadow(
    { read: exploding, write: writeClient([]), flip: true },
    { categoryId: "11450", brand: "Patagonia" },
    7,
    live(),
  );
  assertEquals(out.served, "live");
  assertEquals(out.range, live());
  assertEquals(shadowCounters().failed, 1);
});

Deno.test("flag OFF returns byte-for-byte what the live range was", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  const input = live();
  const out = await observeMeasuredShadow(
    { read: readClient(CURVE_ROW), write: writeClient([]) },
    { categoryId: "11450", brand: "Patagonia", q: "Better Sweater" },
    7,
    input,
  );
  assertEquals(out.served, "live");
  // Identity, not just equality: nothing rebuilt or rounded the caller's range.
  assert(out.range === input);
});

Deno.test("recording off, flip on: the measured range still ships and nothing is written", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  const written: ShadowSampleRow[] = [];
  const out = await observeMeasuredShadow(
    { read: readClient(CURVE_ROW), write: writeClient(written), flip: true, record: false },
    { categoryId: "11450", brand: "Patagonia", q: "Better Sweater" },
    7,
    live(),
  );
  assertEquals(out.served, "measured");
  assertEquals(written.length, 0);
});

// ── the choke point (US-2849 AC2) ───────────────────────────────────
//
// applyMeasuredCurve is the single place valueAtGrade and cachedValueAtGrade
// both end at. If these hold, every one of the six surfaces named in the story
// gets the flip with no edit of its own.

const ITEM = { categoryId: "11450", brand: "Patagonia", q: "Better Sweater" };

Deno.test("choke point, both switches off: live is returned and nothing is read", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  let calls = 0;
  const input = live();
  const out = await applyMeasuredCurve(ITEM, 7, input, {
    read: readClient(CURVE_ROW, () => calls++),
    write: writeClient([]),
    flip: false,
    record: false,
  });
  assert(out === input, "the caller's own range was not handed straight back");
  assertEquals(calls, 0, "a disabled shadow still hit the database");
});

Deno.test("choke point, flag off: the measured curve is read and ignored", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  const written: ShadowSampleRow[] = [];
  const out = await applyMeasuredCurve(ITEM, 7, live(), {
    read: readClient(CURVE_ROW),
    write: writeClient(written),
    flip: false,
    record: true,
  });
  assertEquals(out.medianCents, 6200);
  assertEquals(written.length, 1, "the comparison was not recorded");
  assertEquals(shadowCounters().servedMeasured, 0);
});

Deno.test("choke point, flag on: the measured range is returned", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  const out = await applyMeasuredCurve(ITEM, 7, live(), {
    read: readClient(CURVE_ROW),
    write: writeClient([]),
    flip: true,
  });
  assertEquals(out.medianCents, 7000);
  assertEquals(shadowCounters().servedMeasured, 1);
});

Deno.test("choke point never throws, whatever the shadow does", async () => {
  resetShadowCurveCache();
  resetShadowCounters();
  const exploding: ShadowCurveClient = {
    from: () => {
      throw new Error("everything is on fire");
    },
  };
  const input = live();
  const out = await applyMeasuredCurve(ITEM, 7, input, {
    read: exploding,
    write: writeClient([]),
    flip: true,
  });
  assertEquals(out, input);
});

// ── the report ──────────────────────────────────────────────────────

Deno.test("median absolute delta by cell, with uncompared rows counted separately", () => {
  const rows = [
    { cell_key: "a", grade: 7, live_median_cents: 1000, measured_median_cents: 1200, delta_cents: 200, created_at: "2026-08-01T00:00:00Z" },
    { cell_key: "a", grade: 7, live_median_cents: 1000, measured_median_cents: 600, delta_cents: -400, created_at: "2026-08-02T00:00:00Z" },
    { cell_key: "a", grade: 9.5, live_median_cents: 1000, measured_median_cents: null, delta_cents: null, created_at: "2026-08-03T00:00:00Z" },
    { cell_key: "b", grade: 6, live_median_cents: 2000, measured_median_cents: 2050, delta_cents: 50, created_at: "2026-08-01T00:00:00Z" },
  ];
  const out = summarizeShadowDeltas(rows);
  const a = out.find((c) => c.cellKey === "a")!;
  assertEquals(a.samples, 3);
  assertEquals(a.compared, 2);
  assertEquals(a.medianAbsDeltaCents, 300); // (200 + 400) / 2
  assertEquals(a.medianSignedDeltaCents, -100); // (200 + -400) / 2
  assertEquals(a.medianAbsDeltaPct, 0.3);
  assertEquals(a.firstSeenAt, "2026-08-01T00:00:00Z");
  assertEquals(a.lastSeenAt, "2026-08-03T00:00:00Z");
  // Widest gap first.
  assertEquals(out[0].cellKey, "a");
  assertEquals(out[1].cellKey, "b");
});

Deno.test("a cell with nothing comparable reports null medians, not zero", () => {
  const out = summarizeShadowDeltas([
    { cell_key: "a", grade: 9.5, live_median_cents: 1000, measured_median_cents: null, delta_cents: null, created_at: "2026-08-03T00:00:00Z" },
  ]);
  assertEquals(out[0].compared, 0);
  assertEquals(out[0].medianAbsDeltaCents, null);
  assertEquals(out[0].medianAbsDeltaPct, null);
});
