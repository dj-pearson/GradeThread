// US-2212: dating a garment from its tag generation.
//
// The rules under test:
//   1. A dating era is not a format note — `years: "all"` is filtered out.
//   2. The model may only pick from the CURATED list, and only above a stricter
//      confidence bar than the transcription fields around it.
//   3. Abstaining is a first-class answer; no era must never become a guess.
//   4. Era is INFORMATIONAL — the composite prompt's factor weights and scoring
//      instructions are untouched by its presence (AC3).
//   5. No eras => every prompt is byte-identical to US-2210 (AC: additive).
//
//   deno test --allow-env --allow-read src/tests/tag-era_test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  eraDecoderConflict,
  eraYearRange,
  ERA_YEAR_TOLERANCE,
  datingEras,
  eraId,
  ERA_MATCH_MIN_CONFIDENCE,
  matchTagEra,
  MAX_ERAS_IN_PROMPT,
  normalizeTagEras,
  tagEraReferenceBlock,
  isSourcedEra,
  claimableEras,
} = await import("../lib/tag-era.ts");

const { acceptedTagFields, tagGroundTruthBlock, buildPersistedTagRead } =
  await import("../lib/tag-ground-truth.ts");
const { userInstructions } = await import("../lib/ai-tag-ocr.ts");
const { buildCompositeUserPrompt } = await import("../lib/ai-grading.ts");

// Modelled on the real Champion seed (00465), where the tag era IS the price,
// mixed with a Nike-style format note that is NOT dating evidence.
const RAW_ERAS = [
  { era: "blue bar", years: "1980s-early 90s", description: "Blue-bar neck tag." },
  { era: "sleeve C", years: "1990s-present", description: "Embroidered C on the left sleeve." },
  { era: "style-number", years: "all", description: "Style code + 3-digit colorway." },
  { era: "current", years: "current", description: "Modern printed neck label." },
];
const ERAS = normalizeTagEras(RAW_ERAS);

const GARMENT = {
  garment_type: "tops",
  garment_category: "hoodie",
  brand: "Champion",
  title: "Vintage sweatshirt",
  description: null,
  style_attributes: [],
};
// deno-lint-ignore no-explicit-any
const ANALYSES = [{ image_type: "front", observations: "clean" }] as any;

// ── 1. Coercion and the format-note filter ──────────────────────────────────

Deno.test("normalizeTagEras drops entries with no era label or no description", () => {
  const out = normalizeTagEras([
    { era: "ok", years: "1990s", description: "d" },
    { era: "", years: "1990s", description: "d" },
    { era: "no desc", years: "1990s", description: "  " },
    { era: "missing desc", years: "1990s" },
    null,
    "not an object",
    42,
  ]);
  assertEquals(out.map((e) => e.era), ["ok"]);
});

Deno.test("normalizeTagEras tolerates a non-array column", () => {
  for (const raw of [null, undefined, {}, "[]", 7]) {
    assertEquals(normalizeTagEras(raw), []);
  }
});

Deno.test("datingEras keeps real ranges and drops never-changed format notes", () => {
  // THE FINDING this filter exists for: the column does double duty. An entry
  // with years "all"/"current" describes a format, not a generation, and
  // offering it invites a confident "this is from the all era".
  assertEquals(datingEras(ERAS).map((e) => e.era), ["blue bar", "sleeve C"]);
});

Deno.test("datingEras accepts both 4-digit years and bare decades", () => {
  const out = datingEras(normalizeTagEras([
    { era: "a", years: "1997-present", description: "d" },
    { era: "b", years: "1980s", description: "d" },
    { era: "c", years: "ongoing", description: "d" },
    { era: "d", years: "", description: "d" },
  ]));
  assertEquals(out.map((e) => e.era), ["a", "b"]);
});

// ── 2. The reference block ──────────────────────────────────────────────────

Deno.test("the reference block lists only datable eras, with stable ids", () => {
  const block = tagEraReferenceBlock(ERAS);
  assertStringIncludes(block, `${eraId(0)} | blue bar (1980s-early 90s)`);
  assertStringIncludes(block, `${eraId(1)} | sleeve C`);
  assert(!block.includes("style-number"), "a format note must not be offered");
  assert(!block.includes("Modern printed neck label"));
});

Deno.test("the reference block tells the model the list is partial and abstaining is right", () => {
  const block = tagEraReferenceBlock(ERAS);
  // A brand's seeded eras are never a complete history, so being cornered into
  // the closest listed option is exactly how a guessed decade reaches a cert.
  assertStringIncludes(block, "NOT exhaustive");
  assertStringIncludes(block, "OMIT tag_era");
  assertStringIncludes(block, "a wrong date is worse than no date");
});

Deno.test("a brand with no datable eras produces no block", () => {
  assertEquals(tagEraReferenceBlock([]), "");
  assertEquals(
    tagEraReferenceBlock(normalizeTagEras([
      { era: "style-number", years: "all", description: "d" },
    ])),
    "",
  );
});

Deno.test("the reference block is capped so one over-seeded brand cannot dominate", () => {
  const many = normalizeTagEras(
    Array.from({ length: MAX_ERAS_IN_PROMPT + 8 }, (_, i) => ({
      era: `e${i}`,
      years: `19${10 + i}`,
      description: "d",
    })),
  );
  const lines = tagEraReferenceBlock(many).split("\n").filter((l) => l.startsWith("- "));
  assertEquals(lines.length, MAX_ERAS_IN_PROMPT);
});

// ── 3. Matching is grounded and strict ──────────────────────────────────────

Deno.test("a confident pick resolves to the seeded entry", () => {
  const m = matchTagEra(ERAS, "era_1", 0.9);
  assertEquals(m?.era, "blue bar");
  assertEquals(m?.years, "1980s-early 90s");
  assertEquals(m?.confidence, 0.9);
});

Deno.test("the era bar is stricter than the transcription bar", () => {
  // 0.4 is enough to accept "Levi's" off a label; it is not enough to assert
  // a decade. Guard the relationship, not just the number.
  assert(ERA_MATCH_MIN_CONFIDENCE > 0.4);
  assertEquals(matchTagEra(ERAS, "era_1", ERA_MATCH_MIN_CONFIDENCE - 0.01), null);
  assert(matchTagEra(ERAS, "era_1", ERA_MATCH_MIN_CONFIDENCE) !== null);
});

Deno.test("the model cannot introduce an era that was never curated", () => {
  for (const id of ["era_99", "era_0", "blue bar", "1985", "", "  ", null, undefined, 3]) {
    assertEquals(
      matchTagEra(ERAS, id, 0.99),
      null,
      `id ${JSON.stringify(id)} must not resolve`,
    );
  }
});

Deno.test("ids resolve against the FILTERED list, so a format note is unreachable", () => {
  // "style-number" is index 2 of the raw array but is filtered out, so era_3
  // is "current" in raw terms and must not resolve to anything.
  assertEquals(matchTagEra(ERAS, "era_3", 0.99), null);
});

Deno.test("a missing or unusable confidence never becomes a match", () => {
  for (const c of [undefined, null, NaN, "high", {}]) {
    assertEquals(matchTagEra(ERAS, "era_1", c), null);
  }
});

Deno.test("confidence is clamped into 0..1", () => {
  assertEquals(matchTagEra(ERAS, "era_1", 7)?.confidence, 1);
});

// ── 4. Era is informational: scoring is untouched (AC3) ─────────────────────

Deno.test("an era changes the identity block and NOTHING about scoring", () => {
  const accepted = acceptedTagFields({ brand: { value: "Champion", confidence: 0.9 } });
  const era = matchTagEra(ERAS, "era_1", 0.9);
  const withEra = buildCompositeUserPrompt(
    ANALYSES, GARMENT, "", "", tagGroundTruthBlock(accepted, era),
  );
  const withoutTagBlock = buildCompositeUserPrompt(ANALYSES, GARMENT);

  const weights =
    "Apply the factor weights (Fabric 30%, Structural 25%, Cosmetic 20%, Functional 15%, Odor 10%)";
  assertStringIncludes(withEra, weights);
  assertStringIncludes(withoutTagBlock, weights);
  // The ONLY difference is the trusted identity block.
  const block = tagGroundTruthBlock(accepted, era);
  assertEquals(withEra.replace(`\n${block}\n`, ""), withoutTagBlock);
});

Deno.test("the era is framed as a tag generation, never as a manufacture date", () => {
  const block = tagGroundTruthBlock(
    acceptedTagFields({ brand: { value: "Champion", confidence: 0.9 } }),
    matchTagEra(ERAS, "era_1", 0.9),
  );
  assertStringIncludes(block, "Tag generation: blue bar (1980s-early 90s)");
  assertStringIncludes(block, "NOT a manufacture date");
  // And it explicitly forbids grading an old tag on a different curve.
  assertStringIncludes(block, "NOT a reason to grade more leniently or more harshly");
});

// ── 5. Strictly additive (byte-identical when absent) ───────────────────────

Deno.test("no era leaves the trusted block byte-identical to the US-2210 shape", () => {
  const accepted = acceptedTagFields({ brand: { value: "Champion", confidence: 0.9 } });
  assertEquals(tagGroundTruthBlock(accepted, null), tagGroundTruthBlock(accepted));
  // Specifically: the closing line was NOT reworded for grades that have no era.
  assert(!tagGroundTruthBlock(accepted).includes("more leniently"));
});

Deno.test("no era reference leaves the tag-OCR instructions byte-identical", () => {
  assertEquals(userInstructions(""), userInstructions());
  assert(!userInstructions().includes("TAG GENERATIONS"));
  assertStringIncludes(userInstructions(tagEraReferenceBlock(ERAS)), "TAG GENERATIONS");
});

Deno.test("no accepted fields and no era still means no block at all", () => {
  assertEquals(tagGroundTruthBlock([], null), "");
});

Deno.test("an era alone is enough to render a block", () => {
  // A label whose fields were all illegible can still match a generation by its
  // design, and that is worth recording.
  const block = tagGroundTruthBlock([], matchTagEra(ERAS, "era_2", 0.9));
  assertStringIncludes(block, "Tag generation: sleeve C");
});

// ── Persistence ─────────────────────────────────────────────────────────────

Deno.test("a matched era rides along on the persisted tag read", () => {
  const row = buildPersistedTagRead(
    [], [], "m", "2026-07-28T00:00:00.000Z", undefined, null,
    matchTagEra(ERAS, "era_1", 0.83),
  );
  assertEquals(row.tag_era?.era, "blue bar");
  assertEquals(row.tag_era?.confidence, 0.83);
});

Deno.test("no era is OMITTED, not persisted as unknown", () => {
  const row = buildPersistedTagRead([], [], "m", "2026-07-28T00:00:00.000Z");
  assertEquals("tag_era" in row, false);
});

// ── AC4: era vs a decoded production year ──────────────────────────────────

Deno.test("eraYearRange parses every shape the seeded corpus actually uses", () => {
  const cases: Array<[string, { from: number; to: number } | null]> = [
    ["1980s-early 90s", { from: 1980, to: 1999 }],
    ["1960s-80s", { from: 1960, to: 1989 }],
    ["1997-2004", { from: 1997, to: 2004 }],
    ["1990s", { from: 1990, to: 1999 }],
    ["1980s", { from: 1980, to: 1989 }],
    ["2019-present", { from: 2019, to: 2026 }],
    ["2000s-present", { from: 2000, to: 2026 }],
    ["2019+", { from: 2019, to: 2026 }],
    // Unparseable => NO check, rather than a guessed range.
    ["all", null],
    ["current", null],
    ["ongoing", null],
    ["", null],
  ];
  for (const [input, expected] of cases) {
    assertEquals(eraYearRange(input, 2026), expected, `years=${JSON.stringify(input)}`);
  }
});

Deno.test("a decoded year inside the era's range raises nothing", () => {
  const era = matchTagEra(ERAS, "era_1", 0.9); // blue bar, 1980s-early 90s
  for (const y of [1980, 1985, 1999]) {
    assertEquals(eraDecoderConflict(era, y, 2026), null, `year ${y}`);
  }
});

Deno.test("a decoded year outside the era's range is a FLAG, not a verdict", () => {
  const era = matchTagEra(ERAS, "era_1", 0.9);
  const c = eraDecoderConflict(era, 2019, 2026);
  assert(c, "expected a conflict");
  assertEquals(c.code, "era_year_mismatch");
  assertEquals(c.severity, "flag");
  assertEquals(c.decodedYear, 2019);
  assertEquals(c.era, "blue bar");
  // US-1770: no auto-authentication. It reports two irreconcilable readings.
  assertStringIncludes(c.message, "flag, not a verdict");
  for (const word of ["counterfeit", "fake", "authentic", "inauthentic"]) {
    assert(
      !c.message.toLowerCase().includes(word),
      `the message must not use "${word}"`,
    );
  }
});

Deno.test("the tolerance absorbs a changeover that straddles the recorded boundary", () => {
  const era = matchTagEra(ERAS, "era_1", 0.9); // 1980-1999
  assertEquals(eraDecoderConflict(era, 1980 - ERA_YEAR_TOLERANCE, 2026), null);
  assertEquals(eraDecoderConflict(era, 1999 + ERA_YEAR_TOLERANCE, 2026), null);
  assert(eraDecoderConflict(era, 1999 + ERA_YEAR_TOLERANCE + 1, 2026));
});

Deno.test("the check is skipped whenever it cannot be made honestly", () => {
  const era = matchTagEra(ERAS, "era_1", 0.9);
  // No era matched.
  assertEquals(eraDecoderConflict(null, 2019, 2026), null);
  // No decoded year.
  for (const y of [null, undefined, NaN]) {
    assertEquals(eraDecoderConflict(era, y as number | null, 2026), null);
  }
  // An era whose years string we cannot parse must yield NO finding rather
  // than a comparison against a fabricated range.
  const unparseable = { era: "x", years: "all", description: "d", confidence: 1 };
  assertEquals(eraDecoderConflict(unparseable, 2019, 2026), null);
});

Deno.test("an open-ended era is bounded by the current year, so recent codes agree", () => {
  const sleeveC = matchTagEra(ERAS, "era_2", 0.9); // 1990s-present
  assertEquals(eraDecoderConflict(sleeveC, 2024, 2026), null);
  // ...and a future-dated code still trips it.
  assert(eraDecoderConflict(sleeveC, 2040, 2026));
});

Deno.test("a conflict is persisted alongside the era, and omitted when absent", () => {
  const era = matchTagEra(ERAS, "era_1", 0.9);
  const conflict = eraDecoderConflict(era, 2019, 2026);
  const withConflict = buildPersistedTagRead(
    [], [], "m", "2026-07-28T00:00:00.000Z", undefined, null, era, conflict,
  );
  assertEquals(withConflict.tag_era_conflict?.code, "era_year_mismatch");

  const clean = buildPersistedTagRead(
    [], [], "m", "2026-07-28T00:00:00.000Z", undefined, null, era, null,
  );
  assertEquals("tag_era_conflict" in clean, false);
});

Deno.test("a conflict does NOT change the grading prompt — it is review data only", () => {
  const accepted = acceptedTagFields({ brand: { value: "Champion", confidence: 0.9 } });
  const era = matchTagEra(ERAS, "era_1", 0.9);
  // The block is built from the era alone; the conflict never reaches a prompt,
  // because telling the grader "this might be relabelled" would invite it to
  // move a condition score on an authenticity suspicion.
  const block = tagGroundTruthBlock(accepted, era);
  assert(!block.includes("cannot both be right"));
  assert(!block.includes("Review"));
});

// ── US-2212 AC5: a dating claim must be citable before it can be sold ────────
//
// brand_knowledge carries source_url / confidence / verified on the ROW, so an
// unsourced era inside an otherwise-verified brand was indistinguishable from a
// cited one. Era IS the price on a vintage piece — the highest-liability
// content in the KB — and the registered-number work already set the precedent:
// an RN we cannot cite is invention, and so is a decade.

Deno.test("US-2212 AC5: provenance needs BOTH a source and a confidence", () => {
  // One without the other is not provenance. A URL with no confidence says
  // where someone looked but not what they concluded; a confidence with no URL
  // is a number with nothing behind it.
  const base = { era: "blue bar", years: "1980s", description: "d" };
  assert(isSourcedEra({ ...base, sourceUrl: "https://x", sourceConfidence: 0.8 }));
  assert(!isSourcedEra({ ...base, sourceUrl: "https://x", sourceConfidence: null }));
  assert(!isSourcedEra({ ...base, sourceUrl: null, sourceConfidence: 0.8 }));
  assert(!isSourcedEra({ ...base, sourceUrl: null, sourceConfidence: null }));
});

Deno.test("US-2212 AC5: an absent source stays NULL, never a default", () => {
  // A default would make every one of the ~220 legacy entries look cited, which
  // is the exact confusion this AC exists to end.
  const [e] = normalizeTagEras([
    { era: "blue bar", years: "1980s", description: "d" },
  ]);
  assertEquals(e.sourceUrl, null);
  assertEquals(e.sourceConfidence, null);
});

Deno.test("US-2212 AC5: provenance is carried through coercion and clamped", () => {
  const [e] = normalizeTagEras([
    {
      era: "blue bar",
      years: "1980s",
      description: "d",
      source_url: "  https://example.test/levis  ",
      confidence: 1.4,
    },
  ]);
  assertEquals(e.sourceUrl, "https://example.test/levis");
  assertEquals(e.sourceConfidence, 1);
});

Deno.test("US-2212 AC5: claimableEras keeps only cited DATABLE entries", () => {
  const eras = normalizeTagEras([
    // Cited and datable — the only publishable one.
    { era: "a", years: "1980s", description: "d", source_url: "https://x", confidence: 0.9 },
    // Datable but uncited: readable as reference, not publishable.
    { era: "b", years: "1990s", description: "d" },
    // Cited but not a dating claim — a format note. Still not an era.
    { era: "c", years: "all", description: "d", source_url: "https://x", confidence: 0.9 },
  ]);
  assertEquals(claimableEras(eras).map((e: { era: string }) => e.era), ["a"]);
  // The REFERENCE list is deliberately wider: an uncited era still helps the
  // model read the label, and nothing it produces is published on its own.
  assertEquals(datingEras(eras).map((e: { era: string }) => e.era), ["a", "b"]);
});

Deno.test("US-2212 AC5: a match on an uncited era is RETURNED but marked unsourced", () => {
  // Dropping it here would silently disable the AC4 era-vs-decoder consistency
  // check on every legacy entry — a different feature switched off by a change
  // about publishing. The caller decides; the flag makes it decide knowingly.
  const eras = normalizeTagEras([
    { era: "uncited", years: "1990s", description: "d" },
  ]);
  const m = matchTagEra(eras, "era_1", 0.9);
  assert(m);
  assertEquals(m!.era, "uncited");
  assertEquals(m!.sourced, false);
  assertEquals(m!.sourceUrl, null);
});

Deno.test("US-2212 AC5: a match on a cited era carries the URL a surface can print", () => {
  const eras = normalizeTagEras([
    { era: "cited", years: "1990s", description: "d", source_url: "https://x", confidence: 0.8 },
  ]);
  const m = matchTagEra(eras, "era_1", 0.9);
  assert(m);
  assertEquals(m!.sourced, true);
  assertEquals(m!.sourceUrl, "https://x");
});

Deno.test("US-2212 AC5: provenance does not weaken the confidence bar", () => {
  // The two thresholds are independent. A perfectly cited era still needs the
  // model to be sure it MATCHED — citation says the fact is real, not that this
  // garment is an instance of it.
  const eras = normalizeTagEras([
    { era: "cited", years: "1990s", description: "d", source_url: "https://x", confidence: 1 },
  ]);
  assertEquals(matchTagEra(eras, "era_1", ERA_MATCH_MIN_CONFIDENCE - 0.01), null);
});
