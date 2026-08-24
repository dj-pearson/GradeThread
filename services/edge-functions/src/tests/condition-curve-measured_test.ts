// US-2847: measured curves live in the same table as seeded ones, and a
// generated curve must never overwrite one fitted from real reads.
// US-2379: first import, always. This file's graph reaches lib/supabase.ts
// through condition-index.ts, which throws at import time without the env.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";

import { CURVE_GRADE_POINTS } from "../lib/condition-curve.ts";
import {
  type CompReadSample,
  fitCurve,
  holdOutScore,
} from "../lib/comp-curve-fit.ts";
import {
  buildMeasuredCurvePoints,
  readsNearGrade,
  toMeasuredCurveRow,
  writeMeasuredCurve,
} from "../lib/condition-curve-measured.ts";

import {
  MIN_INDEX_TOTAL_SAMPLE,
  normalizeProvenance,
  persistSeededCurve,
} from "../lib/condition-index.ts";

const fixture: { cellKey: string; reads: CompReadSample[] } = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/comp-curve-cells.json", import.meta.url)),
);

function measuredInput() {
  const fit = fitCurve(fixture.reads)!;
  const score = holdOutScore(fixture.reads)!;
  return {
    itemKey: fixture.cellKey,
    slug: "patagonia-better-sweater",
    label: "Patagonia Better Sweater",
    brand: "Patagonia",
    categoryId: "11484",
    query: "better sweater",
    currency: "USD",
    fit,
    score,
    reads: fixture.reads,
    measuredAt: "2026-08-24T00:00:00.000Z",
  };
}

// provenance

Deno.test("a row that says nothing about provenance is seeded, because that is what existed first", () => {
  assertEquals(normalizeProvenance(undefined), "seeded");
  assertEquals(normalizeProvenance(null), "seeded");
  assertEquals(normalizeProvenance("seeded"), "seeded");
  assertEquals(normalizeProvenance("nonsense"), "seeded");
  assertEquals(normalizeProvenance("measured"), "measured");
});

// AC2: seeded never clobbers measured

/** A stand-in that remembers one row's provenance. */
function fakeCurveClient(existing: "seeded" | "measured" | null) {
  const calls: string[] = [];
  let provenance = existing;
  const client = {
    from(table: string) {
      assertEquals(table, "condition_price_curves");
      return {
        upsert(row: Record<string, unknown>, opts: { ignoreDuplicates: boolean }) {
          calls.push("upsert");
          assertEquals(opts.ignoreDuplicates, true, "the insert must not clobber");
          assertEquals(row.provenance, "seeded");
          if (provenance == null) provenance = "seeded";
          return Promise.resolve({ error: null });
        },
        update(_row: Record<string, unknown>) {
          calls.push("update");
          return {
            eq(_c1: string, _v1: unknown) {
              return {
                eq(col: string, value: unknown) {
                  assertEquals(col, "provenance");
                  assertEquals(value, "seeded");
                  return {
                    select(_cols: string) {
                      const matched = provenance === value ? [{ item_key: "k" }] : [];
                      return Promise.resolve({ data: matched, error: null });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

Deno.test("AC2: a MEASURED cell is left alone by a seeded write", async () => {
  const { client } = fakeCurveClient("measured");
  const r = await persistSeededCurve({ item_key: "k", total_sample_size: 9 }, client);
  assertEquals(r.ok, true);
  assertEquals(r.skipped, true, "the seeded write overwrote a measured curve");
});

Deno.test("AC2: a SEEDED cell is refreshed normally", async () => {
  const { client } = fakeCurveClient("seeded");
  const r = await persistSeededCurve({ item_key: "k", total_sample_size: 9 }, client);
  assertEquals(r.ok, true);
  assertEquals(r.skipped, false);
});

Deno.test("AC2: a brand new cell is inserted and then refreshed", async () => {
  const { client, calls } = fakeCurveClient(null);
  const r = await persistSeededCurve({ item_key: "k", total_sample_size: 9 }, client);
  assertEquals(r.ok, true);
  assertEquals(r.skipped, false);
  assertEquals(calls, ["upsert", "update"]);
});

Deno.test("AC2: a failed insert is reported, and the update is never attempted", async () => {
  const client = {
    from() {
      return {
        upsert() {
          return Promise.resolve({ error: { message: "boom" } });
        },
        update() {
          throw new Error("update must not run after a failed insert");
        },
      };
    },
  };
  const r = await persistSeededCurve(
    { item_key: "k" },
    client as unknown as Parameters<typeof persistSeededCurve>[1],
  );
  assertEquals(r.ok, false);
});

// AC1: the same point shape, in the same table

Deno.test("AC1: a measured row carries the fit and declares itself measured", () => {
  const row = toMeasuredCurveRow(measuredInput(), CURVE_GRADE_POINTS);
  assertEquals(row.provenance, "measured");
  assertEquals(row.item_key, fixture.cellKey);
  assert(row.slope_cents_per_point > 0);
  assert(row.fit_confidence > 0);
  assertEquals(row.measured_at, "2026-08-24T00:00:00.000Z");
  assertEquals(row.refreshed_at, "2026-08-24T00:00:00.000Z");
  // The migration's CHECK refuses a measured row without these two.
  assert(row.slope_cents_per_point != null && row.measured_at != null);
});

Deno.test("AC1: measured points are the SAME shape a seeded curve writes", () => {
  const row = toMeasuredCurveRow(measuredInput(), CURVE_GRADE_POINTS);
  assertEquals(row.curve.length, CURVE_GRADE_POINTS.length);
  for (const p of row.curve) {
    assertEquals(Object.keys(p).sort(), [
      "grade",
      "highCents",
      "lowCents",
      "medianCents",
      "sampleSize",
      "sufficient",
    ]);
  }
});

// no extrapolation

Deno.test("grades outside the observed range are insufficient, not invented", () => {
  const input = measuredInput();
  const points = buildMeasuredCurvePoints(input.fit, input.score, input.reads, CURVE_GRADE_POINTS);
  // The fixture's reads run 5.0 to 9.5, so 10 and 4 and 3 are all extrapolation.
  assertEquals(input.fit.gradeMin, 5);
  assertEquals(input.fit.gradeMax, 9.5);
  for (const grade of [10, 4, 3]) {
    const p = points.find((x) => x.grade === grade)!;
    assertEquals(p.sufficient, false, `grade ${grade} was extrapolated`);
    assertEquals(p.medianCents, null);
    assertEquals(p.sampleSize, 0);
  }
  for (const grade of [9, 8, 7, 6, 5]) {
    assertEquals(points.find((x) => x.grade === grade)!.sufficient, true);
  }
});

Deno.test("a higher grade is priced above a lower one when the slope is positive", () => {
  const input = measuredInput();
  const points = buildMeasuredCurvePoints(input.fit, input.score, input.reads, CURVE_GRADE_POINTS);
  const priced = points.filter((p) => p.medianCents != null).sort((a, b) => a.grade - b.grade);
  for (let i = 1; i < priced.length; i++) {
    assert(
      priced[i].medianCents! > priced[i - 1].medianCents!,
      `grade ${priced[i].grade} is not above grade ${priced[i - 1].grade}`,
    );
  }
});

// the band

Deno.test("the band is the curve's own hold-out error, not a decoration", () => {
  const input = measuredInput();
  const points = buildMeasuredCurvePoints(input.fit, input.score, input.reads, CURVE_GRADE_POINTS);
  const band = Math.round(input.score.curveErrorCents);
  const p = points.find((x) => x.grade === 8)!;
  assertEquals(p.highCents! - p.medianCents!, band);
  assertEquals(p.medianCents! - p.lowCents!, band);
});

Deno.test("a band never runs a price below zero", () => {
  const input = measuredInput();
  const wideBand = { ...input.score, curveErrorCents: 999_999 };
  const points = buildMeasuredCurvePoints(input.fit, wideBand, input.reads, CURVE_GRADE_POINTS);
  for (const p of points) {
    if (p.lowCents != null) assert(p.lowCents >= 0, `negative low at grade ${p.grade}`);
  }
});

// per-grade sample size

Deno.test("a grade point counts the reads NEAR it, not the whole cell", () => {
  const input = measuredInput();
  const points = buildMeasuredCurvePoints(input.fit, input.score, input.reads, CURVE_GRADE_POINTS);
  const atEight = points.find((p) => p.grade === 8)!;
  assertEquals(atEight.sampleSize, readsNearGrade(fixture.reads, 8));
  assert(
    atEight.sampleSize < input.fit.sampleSize,
    "a grade point is claiming the whole cell's sample",
  );
});

Deno.test("readsNearGrade ignores stock-rejected reads", () => {
  const reads: CompReadSample[] = [
    { readScore: 8, readConfidence: 0.8, askingPriceCents: 4000, stockRejected: false },
    { readScore: 8, readConfidence: 0.9, askingPriceCents: 9000, stockRejected: true },
  ];
  assertEquals(readsNearGrade(reads, 8), 1);
});

// the write

Deno.test("writeMeasuredCurve upserts on item_key, so there is only ever one curve table", async () => {
  let seen: { table: string; onConflict: string; provenance: unknown } | null = null;
  const client = {
    from(table: string) {
      return {
        upsert(row: { provenance: string }, opts: { onConflict: string }) {
          seen = { table, onConflict: opts.onConflict, provenance: row.provenance };
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  const r = await writeMeasuredCurve(client, measuredInput(), CURVE_GRADE_POINTS);
  assertEquals(r.ok, true);
  assertEquals(seen!.table, "condition_price_curves");
  assertEquals(seen!.onConflict, "item_key");
  assertEquals(seen!.provenance, "measured");
});

Deno.test("a write error is reported rather than thrown", async () => {
  const client = {
    from() {
      return {
        upsert() {
          return Promise.resolve({ error: { message: "connection reset" } });
        },
      };
    },
  };
  const r = await writeMeasuredCurve(client, measuredInput(), CURVE_GRADE_POINTS);
  assertEquals(r.ok, false);
  assertEquals(r.error, "connection reset");
});

// AC4: the thin-page suppression still applies

Deno.test("AC4: a measured curve is read through the SAME suppression as a seeded one", async () => {
  const src = await Deno.readTextFile(new URL("../lib/condition-index.ts", import.meta.url));
  // Both the hub list and the by-slug detail must gate on the sample floor, and
  // neither may branch on provenance to skip it.
  assert(
    /\.gte\("total_sample_size", MIN_INDEX_TOTAL_SAMPLE\)/.test(src),
    "the hub query lost its sample floor",
  );
  assert(
    /row\.total_sample_size < MIN_INDEX_TOTAL_SAMPLE/.test(src),
    "the by-slug read lost its sample floor",
  );
  assert(
    !/provenance[^\n]*MIN_INDEX_TOTAL_SAMPLE/.test(src),
    "the sample floor is being applied conditionally on provenance",
  );
  assert(MIN_INDEX_TOTAL_SAMPLE > 0);
});

Deno.test("AC1: no second curve table was created", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/condition-curve-measured.ts", import.meta.url),
  );
  const tables = [...src.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]);
  assertEquals([...new Set(tables)], ["condition_price_curves"]);
});
