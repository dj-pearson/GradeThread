// US-2838. The empty ARRAY is the case that matters: null and undefined were
// already handled by the `?? EMPTY_X` this replaces, and an array is what
// defeated it. It is also exactly what the e2e catch-all sends for any
// unmatched /rest/v1/** call, which is how the composer crash was found.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normaliseAgainst } from "@/lib/rpc-shape";

import { EMPTY_DRIFT, normaliseDrift } from "@/lib/measurement-drift";
import { EMPTY_LIFT } from "@/lib/listing-quality-lift";
import { EMPTY_ATTRIBUTION } from "@/lib/return-attribution";
import { EMPTY_SOURCE_YIELD } from "@/lib/source-yield";
import { EMPTY_PRICE_GAP } from "@/lib/price-gap";
import { EMPTY_SCORECARD } from "@/lib/seller-scorecard";
import { EMPTY_CURVE } from "@/lib/condition-price-curve";
import { EMPTY_DEFECT_COST } from "@/lib/defect-cost";

const TEMPLATES: Array<[string, object]> = [
  ["EMPTY_DRIFT", EMPTY_DRIFT],
  ["EMPTY_LIFT", EMPTY_LIFT],
  ["EMPTY_ATTRIBUTION", EMPTY_ATTRIBUTION],
  ["EMPTY_SOURCE_YIELD", EMPTY_SOURCE_YIELD],
  ["EMPTY_PRICE_GAP", EMPTY_PRICE_GAP],
  ["EMPTY_SCORECARD", EMPTY_SCORECARD],
  ["EMPTY_CURVE", EMPTY_CURVE],
  ["EMPTY_DEFECT_COST", EMPTY_DEFECT_COST],
];

describe("normaliseAgainst", () => {
  it("returns the template for every non-object payload", () => {
    for (const raw of [null, undefined, 0, 1, "", "nope", true, false]) {
      expect(normaliseAgainst(EMPTY_DRIFT, raw), JSON.stringify(raw)).toEqual(EMPTY_DRIFT);
    }
  });

  it("returns the template for an ARRAY, which is the case that bit", () => {
    expect(normaliseAgainst(EMPTY_DRIFT, [])).toEqual(EMPTY_DRIFT);
    expect(normaliseAgainst(EMPTY_DRIFT, [{ bands: [] }])).toEqual(EMPTY_DRIFT);
  });

  it("keeps the template's array when the payload's is the wrong kind", () => {
    const t = { rows: [1, 2], name: "x" };
    expect(normaliseAgainst(t, { rows: {} }).rows).toEqual([1, 2]);
    expect(normaliseAgainst(t, { rows: null }).rows).toEqual([1, 2]);
    expect(normaliseAgainst(t, { rows: "no" }).rows).toEqual([1, 2]);
    expect(normaliseAgainst(t, { rows: [9] }).rows).toEqual([9]);
  });

  it("does NOT inspect array elements", () => {
    // Deliberate: an array of the wrong element type is the server's answer,
    // not something to patch. Pretending otherwise hides a backend change.
    const t = { rows: [] as unknown[] };
    expect(normaliseAgainst(t, { rows: ["wrong", 3, null] }).rows).toEqual(["wrong", 3, null]);
  });

  it("recurses one level, which MeasurementDrift.returns needed", () => {
    const t = { returns: { a: 1, b: 2 } };
    expect(normaliseAgainst(t, { returns: { a: 9 } })).toEqual({ returns: { a: 9, b: 2 } });
    expect(normaliseAgainst(t, { returns: [] })).toEqual({ returns: { a: 1, b: 2 } });
    expect(normaliseAgainst(t, { returns: null })).toEqual({ returns: { a: 1, b: 2 } });
  });

  it("treats an explicitly-undefined key as absent", () => {
    // The object spread would otherwise let `{ rows: undefined }` win and
    // reintroduce the exact crash this exists to stop.
    const t = { rows: [1], n: 5 };
    expect(normaliseAgainst(t, { rows: undefined, n: undefined })).toEqual(t);
  });

  it("keeps a nullable template's null and accepts a real value for it", () => {
    const t = { garmentCategory: null as string | null };
    expect(normaliseAgainst(t, {})).toEqual({ garmentCategory: null });
    expect(normaliseAgainst(t, { garmentCategory: "tops" })).toEqual({ garmentCategory: "tops" });
  });

  it("preserves keys the template does not model", () => {
    // Dropping them would silently break a reader using a field its EMPTY_X
    // happens not to include.
    const out = normaliseAgainst({ a: 1 }, { a: 2, extra: "kept" }) as Record<string, unknown>;
    expect(out.extra).toBe("kept");
  });

  it("a whole payload round-trips unchanged", () => {
    for (const [name, tpl] of TEMPLATES) {
      expect(normaliseAgainst(tpl, tpl), name).toEqual(tpl);
    }
  });
});

describe("every analytics template survives the empty array", () => {
  // The regression, asserted once per lib. Before US-2838 each of these
  // returned `[]` wearing its report type, and the first reader to touch an
  // array field took its whole route down through the ErrorBoundary.
  for (const [name, tpl] of TEMPLATES) {
    it(`${name}: [] yields the template, and every array field is an array`, () => {
      const out = normaliseAgainst(tpl, []) as Record<string, unknown>;
      expect(out).toEqual(tpl);
      for (const [key, v] of Object.entries(tpl)) {
        if (Array.isArray(v)) expect(Array.isArray(out[key]), `${name}.${key}`).toBe(true);
      }
    });

    it(`${name}: a payload missing every array field still gets arrays`, () => {
      const scalarsOnly = Object.fromEntries(
        Object.entries(tpl).filter(([, v]) => !Array.isArray(v) && (v === null || typeof v !== "object")),
      );
      const out = normaliseAgainst(tpl, scalarsOnly) as Record<string, unknown>;
      for (const [key, v] of Object.entries(tpl)) {
        if (Array.isArray(v)) expect(Array.isArray(out[key]), `${name}.${key}`).toBe(true);
      }
    });
  }
});

describe("normaliseDrift still behaves, now that it delegates", () => {
  it("is the shared helper bound to EMPTY_DRIFT", () => {
    for (const raw of [[], null, { bands: "no" }, { rows: {} }, EMPTY_DRIFT]) {
      expect(normaliseDrift(raw)).toEqual(normaliseAgainst(EMPTY_DRIFT, raw));
    }
  });
});

describe("no analytics fetcher returns an unchecked payload (the ratchet)", () => {
  // The pattern was copied seven times in one day. Without this it recurs on
  // the ninth lib, and the ninth lib is on a page no e2e opens.
  const LIBS = [
    "measurement-drift",
    "listing-quality-lift",
    "return-attribution",
    "source-yield",
    "price-gap",
    "seller-scorecard",
    "condition-price-curve",
    "defect-cost",
  ];

  const read = (n: string) => readFileSync(resolve(process.cwd(), `src/lib/${n}.ts`), "utf8");

  it("none of them still says `return data ?? EMPTY_…`", () => {
    const offenders = LIBS.filter((n) => /return\s+data\s*\?\?\s*EMPTY_/.test(read(n)));
    expect(
      offenders,
      "`?? EMPTY_X` only catches null. The RPC client is an unchecked cast, so " +
        "any other shape passes through wearing the type — an empty array did, " +
        "and it took the whole composer route down through the ErrorBoundary. " +
        "Use normaliseAgainst(EMPTY_X, data).",
    ).toEqual([]);
  });

  it("every one of them normalises", () => {
    const missing = LIBS.filter((n) => !/normaliseAgainst\(/.test(read(n)));
    expect(missing, "a fetcher stopped normalising its payload").toEqual([]);
  });

  it("the ratchet is watching the libs that actually exist", () => {
    // Guards the guard: a renamed file would make both checks above pass
    // vacuously by reading nothing.
    for (const n of LIBS) expect(read(n).length, n).toBeGreaterThan(500);
  });
});
