// US-2219: authentication coverage, and what a PAID add-on owes when it is thin.
//
// ⚠ PREMISE CORRECTION. The story assumes tell coverage merely follows brand-pack
// authoring order. The real state is worse and more precise: ALL 179 seeded
// authentication_tells payloads use the LEGACY {tell, detail} shape, and
// coerceTell maps those to category "other" with no redFlag. So they are prose
// the prompt reads and the verdict cannot use. Re-shaping them is US-2139's job;
// this story stops the gap degrading a PAID assessment silently.
//
// The rules under test:
//   1. A tell is actionable only if it can move a verdict — a real category, or
//      a red flag. Legacy rows are neither.
//   2. Thin coverage LOWERS confidence and is DISCLOSED; it never accuses the
//      garment.
//   3. Caps compose by MIN with the US-2218 reference cap and never raise.
//   4. Omitting the argument means "not measured", not "none" — existing
//      callers stay byte-identical.
//
//   deno test --allow-env --allow-read src/tests/authenticity-coverage_test.ts

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
  classifyTellCoverage,
  coverageConfidenceCap,
  coverageLimitation,
  COVERAGE_CAP_INERT,
  COVERAGE_CAP_NONE,
  isActionableTell,
  purchaseDisclosure,
} = await import("../lib/authenticity-coverage.ts");
const { coerceTell, normalizeTells } = await import("../lib/brand-authenticity.ts");
const { normalizeAuthenticityAssessment, AUTHENTICITY_PROMPT_VERSION } =
  await import("../lib/ai-authenticity.ts");

// The exact shape all 179 seeded pack rows use.
const LEGACY = [
  { tell: "Never auto-authenticate", detail: "No serial or published standard exists." },
  { tell: "RN 26094", detail: "Champion garments carry RN 26094 on the care label." },
];
const STRUCTURED = [
  {
    category: "stamp",
    claim: "Crisp evenly-spaced serifs.",
    check: "Inspect under good light.",
    redFlag: "Blurred or uneven letterforms.",
    confidence: 0.6,
  },
];

// ── 1. What "actionable" means ─────────────────────────────────────────────

Deno.test("US-2219: a legacy pack row is INERT — it cannot move a verdict", () => {
  const tells = normalizeTells(LEGACY);
  assertEquals(tells.length, 2);
  // coerceTell gives them category "other" and no redFlag...
  for (const t of tells) {
    assertEquals(t.category, "other");
    assertEquals(t.redFlag, undefined);
    assertEquals(isActionableTell(t), false);
  }
  // ...so the brand classifies as inert despite HAVING tells. That distinction
  // is the whole finding: "has tells" and "has usable tells" diverged.
  assertEquals(classifyTellCoverage(tells).level, "inert");
});

Deno.test("US-2219: a categorized tell is actionable", () => {
  const t = coerceTell(STRUCTURED[0])!;
  assertEquals(isActionableTell(t), true);
  assertEquals(classifyTellCoverage([t]).level, "actionable");
});

Deno.test("US-2219: a red flag alone makes an uncategorized tell actionable", () => {
  // Category "other" is fine if there is a concrete counterfeit signal to look
  // for — that is still something the verdict can use.
  const t = coerceTell({ claim: "x", detail: "y", redFlag: "a glued seam" })!;
  assertEquals(t.category, "other");
  assertEquals(isActionableTell(t), true);
});

Deno.test("US-2219: no tells at all is 'none', distinct from 'inert'", () => {
  const none = classifyTellCoverage([]);
  assertEquals(none.level, "none");
  assertEquals(none.total, 0);
  // Distinct because the disclosures differ: "we hold nothing" and "we hold
  // notes that are not tests" are different admissions.
  assert(coverageLimitation(none) !== coverageLimitation(classifyTellCoverage(normalizeTells(LEGACY))));
});

Deno.test("US-2219: coverage reports the categories it actually has", () => {
  const c = classifyTellCoverage([coerceTell(STRUCTURED[0])!, ...normalizeTells(LEGACY)]);
  assertEquals(c.level, "actionable");
  assertEquals(c.actionable, 1);
  assertEquals(c.total, 3);
  assertEquals(c.categories, ["stamp"]);
});

// ── 2. Disclosure describes OUR gap, never the garment ─────────────────────

Deno.test("US-2219: thin coverage is disclosed without accusing the item", () => {
  for (const level of [classifyTellCoverage([]), classifyTellCoverage(normalizeTells(LEGACY))]) {
    const text = coverageLimitation(level);
    assert(text.length > 0);
    assertStringIncludes(text, "starting point for your own inspection");
    for (const word of ["counterfeit", "fake", "suspect", "inauthentic", "replica"]) {
      assert(!text.toLowerCase().includes(word), `must not say "${word}"`);
    }
  }
});

Deno.test("US-2219: actionable coverage adds no limitation", () => {
  assertEquals(coverageLimitation(classifyTellCoverage([coerceTell(STRUCTURED[0])!])), "");
});

Deno.test("US-2219: a PAID offer for a thin brand carries a mandatory disclosure", () => {
  // The actual defect: the add-on is purchased, and a brand with nothing to
  // check against still produced a confident-looking assessment silently.
  assert(purchaseDisclosure(classifyTellCoverage([])) !== null);
  assert(purchaseDisclosure(classifyTellCoverage(normalizeTells(LEGACY))) !== null);
  // ...and none when the coverage is real.
  assertEquals(purchaseDisclosure(classifyTellCoverage([coerceTell(STRUCTURED[0])!])), null);
});

Deno.test("US-2219: the purchase disclosure says confidence is capped", () => {
  assertStringIncludes(purchaseDisclosure(classifyTellCoverage([]))!, "capped");
});

// ── 3. Caps compose by MIN and never raise ─────────────────────────────────

Deno.test("US-2219: thinner coverage caps harder", () => {
  assertEquals(coverageConfidenceCap("none"), COVERAGE_CAP_NONE);
  assertEquals(coverageConfidenceCap("inert"), COVERAGE_CAP_INERT);
  assertEquals(coverageConfidenceCap("actionable"), 1);
  assert(COVERAGE_CAP_NONE < COVERAGE_CAP_INERT, "nothing must cap harder than notes");
  assert(COVERAGE_CAP_INERT < 1);
});

Deno.test("US-2219: no cap can raise confidence", () => {
  for (const l of ["none", "inert", "actionable"] as const) {
    const cap = coverageConfidenceCap(l);
    assert(cap <= 1, "a cap above 1 would raise confidence");
    assert(cap > 0, "a cap of 0 would erase the assessment rather than temper it");
  }
});

Deno.test("US-2219: the assessment applies the coverage cap", () => {
  const raw = { is_brand_recognizable: true, authenticity_confidence: 0.95 };
  const capped = normalizeAuthenticityAssessment(
    raw,
    "m",
    AUTHENTICITY_PROMPT_VERSION,
    ["front", "detail"],
    [],
    [], // measured, and empty => "none"
  );
  assert(
    capped.authenticity_confidence <= COVERAGE_CAP_NONE,
    `expected <= ${COVERAGE_CAP_NONE}, got ${capped.authenticity_confidence}`,
  );
  assertStringIncludes(capped.limitations, "no brand-specific authentication criteria");
});

Deno.test("US-2219: actionable tells leave confidence uncapped by THIS rule", () => {
  const raw = { is_brand_recognizable: true, authenticity_confidence: 0.95 };
  const a = normalizeAuthenticityAssessment(
    raw,
    "m",
    AUTHENTICITY_PROMPT_VERSION,
    ["front", "detail"],
    [],
    [coerceTell(STRUCTURED[0])!],
  );
  assert(a.authenticity_confidence > COVERAGE_CAP_INERT);
});

// ── 4. Omitting the argument means "not measured" ──────────────────────────

Deno.test("US-2219: an existing caller that passes no tells is byte-identical", () => {
  // The trap this avoids: defaulting the parameter to [] would classify every
  // legacy caller as "none" and silently cap them. Absent means unmeasured.
  const raw = { is_brand_recognizable: true, authenticity_confidence: 0.95 };
  const before = normalizeAuthenticityAssessment(raw, "m", AUTHENTICITY_PROMPT_VERSION, [
    "front",
    "detail",
  ]);
  assertEquals(before.authenticity_confidence, 0.95);
  assert(!before.limitations.includes("no brand-specific authentication criteria"));
});

// ── The corpus, as it actually is ──────────────────────────────────────────

Deno.test("US-2219: every seeded pack payload is the legacy shape", async () => {
  // The finding, pinned. When US-2139 re-shapes them this test should be
  // UPDATED to assert the new floor, not deleted — it is the record of where
  // the corpus started.
  const dir = new URL("../../../../supabase/migrations/", import.meta.url);
  let legacy = 0;
  let structured = 0;
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, dir));
    legacy += [...text.matchAll(/\$j\$\[\{"tell"/g)].length;
    structured += [...text.matchAll(/\$j\$\[\{"category"/g)].length;
  }
  assert(legacy > 100, `expected the legacy corpus, found ${legacy}`);
  assertEquals(
    structured,
    0,
    "a structured payload appeared — update this test's floor rather than deleting it",
  );
});
