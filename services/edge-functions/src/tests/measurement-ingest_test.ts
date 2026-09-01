// US-3034: what the Fit & Measurement Index accepts from a MeasureCard pass.
//
// Three classes of bug are possible here and only one of them is loud.
//
//   1. A wrong number gets published. Loud in the sense that it is the outcome
//      the whole feature exists to avoid, and silent in the sense that nothing
//      would report it. Guarded by the two filters: not-written and flagged.
//   2. A right number goes into the wrong cohort. This is the brand-key trap
//      from US-2692, reproduced exactly: keying the RAW brand puts "Levi" under
//      `levi` while every read asks for `levis`, so the observation is learned
//      into a namespace nothing looks at.
//   3. Contributing to the corpus breaks the seller's own save. The ingest is
//      best-effort by contract and must return rather than throw.
//
//   deno test --allow-env --allow-read --allow-net src/tests/measurement-ingest_test.ts

import { assert, assertEquals } from "@std/assert";

const {
  buildMeasureCardObservations,
  resolveMeasurementCohort,
  styleKeyFor,
  ingestMeasureCardObservations,
  mergeResolvedStyle,
  MIN_INGEST_CONFIDENCE,
} = await import("../lib/measurement-ingest.ts");

type Extracted = {
  key: string;
  label: string;
  endpoints: [[number, number], [number, number]];
  inches: number;
  confidence: number;
  flagged: boolean;
  flagReason: string | null;
};

function m(
  key: string,
  inches: number,
  opts: { flagged?: boolean; confidence?: number } = {},
): Extracted {
  return {
    key,
    label: key,
    endpoints: [[0, 0], [1, 1]],
    inches,
    confidence: opts.confidence ?? 0.9,
    flagged: opts.flagged ?? false,
    flagReason: opts.flagged ? "outside size prior" : null,
  };
}

const LEVIS_STYLES = [
  {
    styleName: "550",
    aliases: ["550 Relaxed Fit"],
    productLine: null,
    department: "Men",
    category: "pant",
    visualFingerprint: null,
    fabricTech: [],
    era: null,
    msrpBand: null,
    keywords: [],
  },
];

const COHORT = {
  brandKey: "levis",
  styleKey: "550",
  department: "Men",
  measurementGroup: "bottom",
  sizeLabel: "34X32",
  sizeSystem: null,
};

// ── The two filters ─────────────────────────────────────────────────────────

Deno.test("US-3034: a field the fill-only merge did NOT write is not ingested", () => {
  // Not written means a seller-typed value was already there. That number is
  // what the listing carries and what the seller stands behind; the model's
  // rejected alternative must not outvote it in the aggregate.
  const rows = buildMeasureCardObservations({
    userId: "u1",
    itemId: "i1",
    cohort: COHORT,
    extracted: [m("waist", 17), m("inseam", 32)],
    written: ["waist"],
  });
  assertEquals(rows.map((r) => r.field_key), ["waist"]);
});

Deno.test("US-3034: a FLAGGED field is not ingested even when it was written", () => {
  // The extractor itself distrusts the value. A number its own producer
  // distrusts must never become a published median.
  const rows = buildMeasureCardObservations({
    userId: "u1",
    itemId: "i1",
    cohort: COHORT,
    extracted: [m("waist", 17), m("inseam", 41, { flagged: true })],
    written: ["waist", "inseam"],
  });
  assertEquals(rows.map((r) => r.field_key), ["waist"]);
});

Deno.test("US-3034: a low-confidence field is not ingested", () => {
  const rows = buildMeasureCardObservations({
    userId: "u1",
    itemId: "i1",
    cohort: COHORT,
    extracted: [
      m("waist", 17, { confidence: MIN_INGEST_CONFIDENCE - 0.01 }),
      m("inseam", 32, { confidence: MIN_INGEST_CONFIDENCE }),
    ],
    written: ["waist", "inseam"],
  });
  assertEquals(rows.map((r) => r.field_key), ["inseam"]);
});

Deno.test("US-3034: a non-positive or non-finite measurement is not ingested", () => {
  const rows = buildMeasureCardObservations({
    userId: "u1",
    itemId: "i1",
    cohort: COHORT,
    extracted: [m("waist", 0), m("inseam", Number.NaN), m("rise", 11)],
    written: ["waist", "inseam", "rise"],
  });
  assertEquals(rows.map((r) => r.field_key), ["rise"]);
});

Deno.test("US-3034: every row carries the contributing user and item", () => {
  // The opt-out in US-3038 deletes by user_id, and the sample floor counts
  // distinct contributors. Both are impossible if the row is anonymous here.
  const rows = buildMeasureCardObservations({
    userId: "u1",
    itemId: "i1",
    cohort: COHORT,
    extracted: [m("waist", 17.004)],
    written: ["waist"],
  });
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.user_id, "u1");
  assertEquals(rows[0]!.item_id, "i1");
  assertEquals(rows[0]!.source, "measurecard");
  assertEquals(rows[0]!.confidence, 0.9);
  // Stored to the hundredth, matching the column's numeric(5,2).
  assertEquals(rows[0]!.inches, 17);
});

// ── The cohort key ──────────────────────────────────────────────────────────

Deno.test("US-3034/US-2692: the brand key is the CANONICAL one, not the raw one", () => {
  // The read side keys on brandKey(canonicalizeBrand(brand)). Using the raw
  // brand's key here would file "Levi" under `levi`, which nothing ever asks
  // for. Measured, not assumed: brandKey("Levi") is "levi" and
  // brandKeyForRaw("Levi") is "levis".
  const viaAlias = resolveMeasurementCohort({
    brand: "Levi",
    style: "550",
    size: "W34 L32",
    group: "bottom",
    styles: LEVIS_STYLES,
  });
  const viaCanonical = resolveMeasurementCohort({
    brand: "Levi's",
    style: "550",
    size: "34x32",
    group: "bottom",
    styles: LEVIS_STYLES,
  });
  assert(viaAlias, "alias spelling must resolve");
  assert(viaCanonical, "canonical spelling must resolve");
  assertEquals(viaAlias.brandKey, "levis");
  assertEquals(viaAlias.brandKey, viaCanonical.brandKey);
  // And the size collapse from US-3033 puts them in the SAME cohort, which is
  // the whole point: two spellings of one garment, one median.
  assertEquals(viaAlias.sizeLabel, viaCanonical.sizeLabel);
});

Deno.test("US-3034: an unresolved style still produces a brand-level cohort", () => {
  // A weaker page, but a real one. Dropping it would throw away every
  // observation on a garment whose model we do not know yet, which is most of
  // them while brand_styles coverage is thin (US-2216).
  const cohort = resolveMeasurementCohort({
    brand: "Levi's",
    style: "some jean we have never heard of",
    size: "34x32",
    group: "bottom",
    styles: LEVIS_STYLES,
  });
  assert(cohort);
  assertEquals(cohort.brandKey, "levis");
  assertEquals(cohort.styleKey, "");
  assertEquals(cohort.department, "");
});

Deno.test("US-3034: a style ALIAS reaches the same cohort as its canonical name", () => {
  const viaAlias = resolveMeasurementCohort({
    brand: "Levi's",
    style: "550 Relaxed Fit",
    size: "34x32",
    group: "bottom",
    styles: LEVIS_STYLES,
  });
  const viaName = resolveMeasurementCohort({
    brand: "Levi's",
    style: "550",
    size: "34x32",
    group: "bottom",
    styles: LEVIS_STYLES,
  });
  assert(viaAlias);
  assert(viaName);
  assertEquals(viaAlias.styleKey, viaName.styleKey);
  assertEquals(viaAlias.styleKey, "550");
});

Deno.test("US-3034: no brand and no size are both refusals, not blank keys", () => {
  // A blank brand key would merge every unbranded garment on the platform into
  // one meaningless bucket. A blank size would merge every size of one style.
  assertEquals(
    resolveMeasurementCohort({
      brand: null,
      style: "550",
      size: "34x32",
      group: "bottom",
      styles: LEVIS_STYLES,
    }),
    null,
  );
  assertEquals(
    resolveMeasurementCohort({
      brand: "Levi's",
      style: "550",
      size: "   ",
      group: "bottom",
      styles: LEVIS_STYLES,
    }),
    null,
  );
});

Deno.test("US-3034: styleKeyFor collapses spelling the same way the pipeline does", () => {
  // Mirrors styleMatchKey in garment-baselines.ts. Two spellings of one style
  // must not become two cohorts for the same reason they must not become two
  // grading baselines.
  assertEquals(styleKeyFor("ABC Pant"), styleKeyFor("abc-pant"));
  assertEquals(styleKeyFor("501 XX"), styleKeyFor("501xx"));
  assertEquals(styleKeyFor(null), "");
  assertEquals(styleKeyFor(""), "");
});

// ── A re-measure must not downgrade the identity ────────────────────────────
//
// Found by running the real ingest against a database rather than a fixture.
// The first pass resolved Levi's 550 and stored style_key '550'. The second
// pass spelled the style differently, failed to match, and the upsert wrote ''
// straight over it — moving the observation out of the style cohort and into
// the brand-level one. Across mixed spellings, cohorts would thrash and never
// accumulate, which attacks the sample floor the whole feature rests on.

Deno.test("US-3034: a failed style match does not overwrite a stored one", () => {
  const rows = buildMeasureCardObservations({
    userId: "u1",
    itemId: "i1",
    cohort: { ...COHORT, styleKey: "", department: "" },
    extracted: [m("waist", 18)],
    written: ["waist"],
  });
  mergeResolvedStyle(rows, [
    { field_key: "waist", style_key: "550", department: "Men" },
  ]);
  assertEquals(rows[0]!.style_key, "550");
  assertEquals(rows[0]!.department, "Men");
});

Deno.test("US-3034: a NEW style match DOES win — a correction is the truth", () => {
  // The rule is "unknown never beats known", not "first answer wins". A seller
  // fixing a misidentified style must move the observation.
  const rows = buildMeasureCardObservations({
    userId: "u1",
    itemId: "i1",
    cohort: { ...COHORT, styleKey: "501", department: "Men" },
    extracted: [m("waist", 18)],
    written: ["waist"],
  });
  mergeResolvedStyle(rows, [
    { field_key: "waist", style_key: "550", department: "Men" },
  ]);
  assertEquals(rows[0]!.style_key, "501");
});

Deno.test("US-3034: with nothing stored, an empty style stays empty", () => {
  const rows = buildMeasureCardObservations({
    userId: "u1",
    itemId: "i1",
    cohort: { ...COHORT, styleKey: "", department: "" },
    extracted: [m("waist", 18)],
    written: ["waist"],
  });
  mergeResolvedStyle(rows, []);
  assertEquals(rows[0]!.style_key, "");
  mergeResolvedStyle(rows, [
    { field_key: "waist", style_key: "", department: "" },
  ]);
  assertEquals(rows[0]!.style_key, "");
});

// ── Best-effort by contract ─────────────────────────────────────────────────

Deno.test("US-3034: ingest returns rather than throws when it cannot file anything", async () => {
  // The seller's own measurement save is the primary action. Contributing to a
  // corpus they are not waiting on must never be able to fail it, so every
  // refusal path returns a count and none of them throws.
  assertEquals(
    await ingestMeasureCardObservations({
      userId: "u1",
      itemId: "i1",
      brand: "Levi's",
      style: "550",
      size: "34x32",
      group: "bottom",
      extracted: [m("waist", 17)],
      written: [],
    }),
    0,
    "nothing written to the item means nothing to contribute",
  );

  assertEquals(
    await ingestMeasureCardObservations({
      userId: "u1",
      itemId: "i1",
      brand: null,
      style: "550",
      size: "34x32",
      group: "bottom",
      extracted: [m("waist", 17)],
      written: ["waist"],
    }),
    0,
    "an unresolvable brand is a refusal, and it must not reach the database",
  );
});
