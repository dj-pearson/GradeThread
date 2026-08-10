// US-1997 AC4: the server rubric definitions (../lib/rubric.ts) must stay in
// sync with the client (src/lib/rubrics.ts). Both are declared to match on
// factor keys + weights + labels and NOTHING pinned them — a divergence would
// render a certificate against weights the grade was never computed on.
//
// Same remedy as US-1995 title-sync: both suites load the shared fixture and
// assert their RUBRICS match it. The web mirror is src/lib/__tests__/rubrics.test.ts.
// The fixture constrains only key/label/weight; the server's extra fields
// (guidance, promptGuidance, defectRouting) are intentionally not mirrored.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  computeRubricWeightedOverall,
  NON_CLOTHING_RUBRIC_KEYS,
  routeDefectToRubricFactors,
  RUBRIC_WEIGHT_SUM_TOLERANCE,
  RUBRICS,
  rubricForKey,
  rubricWeightSum,
} from "../lib/rubric.ts";
import { coerceDefectType, DEFECT_TYPES } from "../lib/defect-weighting.ts";
import { PHOTO_PROFILES } from "../lib/photo-profiles.ts";
import {
  computeWeightedOverall,
  type FactorScores as ColumnFactorScores,
} from "../lib/human-review.ts";

interface FixtureFactor {
  key: string;
  label: string;
  weight: number;
}
const FIXTURE = JSON.parse(
  await Deno.readTextFile(
    new URL("../../../../src/test/fixtures/rubric-factors.json", import.meta.url),
  ),
) as {
  rubrics: Record<string, { label: string; factors: FixtureFactor[] }>;
  weighted_cases: {
    rubric: string;
    scores: Record<string, number>;
    expected_overall: number;
  }[];
  refusal_cases: { why: string; rubric: string; scores: Record<string, unknown> }[];
};

const WEIGHTED_FIXTURE = JSON.parse(
  await Deno.readTextFile(
    new URL("../../../../src/test/fixtures/weighted-grade-cases.json", import.meta.url),
  ),
) as { cases: { factors: ColumnFactorScores; expected_overall: number }[] };

Deno.test("shared fixture: rubric keys match exactly (no drift either direction)", () => {
  assert(Object.keys(FIXTURE.rubrics).length > 0, "fixture is empty — wrong path?");
  assertEquals(Object.keys(RUBRICS).sort(), Object.keys(FIXTURE.rubrics).sort());
});

for (const [key, want] of Object.entries(FIXTURE.rubrics)) {
  Deno.test(`shared fixture: ${key} label + factors match the server rubric`, () => {
    const rubric = RUBRICS[key];
    assert(rubric, `RUBRICS is missing "${key}"`);
    assertEquals(rubric.key, key);
    assertEquals(rubric.label, want.label);
    // Compare only the shared fields; the server carries extra per-factor guidance.
    assertEquals(
      rubric.factors.map((f) => ({ key: f.key, label: f.label, weight: f.weight })),
      want.factors,
    );
  });
}

Deno.test("shared fixture: every rubric's weights sum to 1.0", () => {
  for (const [key, want] of Object.entries(FIXTURE.rubrics)) {
    const sum = want.factors.reduce((a, f) => a + f.weight, 0);
    assert(Math.abs(sum - 1.0) < 1e-9, `${key} weights sum to ${sum}, expected 1.0`);
  }
});

Deno.test("rubricForKey falls back to clothing for null/unknown keys", () => {
  assertEquals(rubricForKey(null).key, "clothing");
  assertEquals(rubricForKey(undefined).key, "clothing");
  assertEquals(rubricForKey("not_a_category").key, "clothing");
  assertEquals(rubricForKey("sports_cards").key, "sports_cards");
});

Deno.test("NON_CLOTHING_RUBRIC_KEYS are all defined rubrics and exclude clothing", () => {
  for (const key of NON_CLOTHING_RUBRIC_KEYS) {
    assert(RUBRICS[key], `NON_CLOTHING_RUBRIC_KEYS names "${key}" but RUBRICS has no such rubric`);
    // String() so this stays a runtime guard even though the key's type already
    // excludes "clothing" (a bare `key !== "clothing"` is TS2367 dead code).
    assert(String(key) !== "clothing", "clothing must not be in NON_CLOTHING_RUBRIC_KEYS");
  }
});

Deno.test("rubricWeightSum reports 1.0 for every shipped rubric", () => {
  for (const [key, rubric] of Object.entries(RUBRICS)) {
    const sum = rubricWeightSum(rubric);
    assert(
      Math.abs(sum - 1) < RUBRIC_WEIGHT_SUM_TOLERANCE,
      `${key} weights sum to ${sum}, expected 1.0`,
    );
  }
});

// ---------------------------------------------------------------------------
// US-1997 activation step 2 — defect routing.
// ---------------------------------------------------------------------------
//
// The routing tables shipped with SEVEN entries keyed on defect names that are
// not in the shared taxonomy (corner_ding, edge_whitening, surface_scratch,
// off_center, crease, scratch, crack). `coerceDefectType` folds any unknown
// string to `other`, so none of them could ever have matched: a card's corner
// ding would have debited `surface` (the first-factor fallback) instead of
// `corners`, silently. The type now rejects that shape; these assert it at
// runtime too, because the type alone would not survive a `as` cast or a
// future `Record<string, …>` widening.

Deno.test("every defectRouting key is a member of the shared DefectType taxonomy", () => {
  const known = new Set<string>(DEFECT_TYPES);
  for (const [rubricKey, rubric] of Object.entries(RUBRICS)) {
    for (const defectType of Object.keys(rubric.defectRouting)) {
      assert(
        known.has(defectType),
        `${rubricKey}.defectRouting has "${defectType}", which is not a DefectType — ` +
          `coerceDefectType would fold it to "other" and this routing could never fire`,
      );
      // The stronger form of the same check: a real taxonomy member survives
      // the coercion the pipeline actually applies to the model's string.
      assertEquals(coerceDefectType(defectType), defectType);
    }
  }
});

Deno.test("every defectRouting split names factors of ITS OWN rubric and sums to 1.0", () => {
  for (const [rubricKey, rubric] of Object.entries(RUBRICS)) {
    const factorKeys = new Set(rubric.factors.map((f) => f.key));
    for (const [defectType, split] of Object.entries(rubric.defectRouting)) {
      assert(split, `${rubricKey}.${defectType} has no split`);
      let sum = 0;
      for (const [factor, weight] of Object.entries(split)) {
        assert(
          factorKeys.has(factor),
          `${rubricKey}.defectRouting.${defectType} routes to "${factor}", ` +
            `which is not a factor of the ${rubricKey} rubric`,
        );
        assert(typeof weight === "number", `${rubricKey}.${defectType}.${factor} is not a number`);
        sum += weight;
      }
      assert(
        Math.abs(sum - 1) < RUBRIC_WEIGHT_SUM_TOLERANCE,
        `${rubricKey}.defectRouting.${defectType} sums to ${sum}, expected 1.0`,
      );
    }
  }
});

Deno.test("clothing's routing IS the live engine table, not a copy of part of it", () => {
  // The hand-copied subset it used to carry covered 3 of 16 defect types, so a
  // clothing defect outside that subset fell through to the first-factor
  // fallback — a fabric_condition debit for a broken zipper.
  for (const defectType of DEFECT_TYPES) {
    const routed = routeDefectToRubricFactors(RUBRICS.clothing, defectType);
    assert(
      Object.keys(routed).length > 0,
      `clothing has no routing for "${defectType}"`,
    );
  }
  assertEquals(routeDefectToRubricFactors(RUBRICS.clothing, "broken_zipper"), {
    functional_elements: 1.0,
  });
});

Deno.test("routeDefectToRubricFactors falls back to the rubric's first factor", () => {
  const cards = RUBRICS.sports_cards;
  // `other` is what coerceDefectType yields for anything unrecognized, and no
  // rubric routes it explicitly — so it must still land somewhere.
  assertEquals(routeDefectToRubricFactors(cards, "other"), { surface: 1.0 });
  assertEquals(routeDefectToRubricFactors(cards, "not_a_defect_type"), { surface: 1.0 });
  assertEquals(routeDefectToRubricFactors(cards, "wrinkle_crease"), {
    surface: 0.7,
    corners: 0.3,
  });
});

Deno.test("no rubric leaves a defect unrouted", () => {
  for (const [rubricKey, rubric] of Object.entries(RUBRICS)) {
    for (const defectType of DEFECT_TYPES) {
      const routed = routeDefectToRubricFactors(rubric, defectType);
      assert(
        Object.keys(routed).length > 0,
        `${rubricKey} routes "${defectType}" nowhere — the defect would cost the item nothing`,
      );
    }
  }
});

Deno.test("sports_cards routes nothing to centering, on purpose", () => {
  // Centering is a factory cut attribute, not handling damage. `off_center`
  // (the entry this replaces) was never a DefectType, so asserting the absence
  // stops someone re-adding an invented one to 'fix' the gap.
  const routed = DEFECT_TYPES.flatMap((d) =>
    Object.keys(routeDefectToRubricFactors(RUBRICS.sports_cards, d))
  );
  assert(
    !routed.includes("centering"),
    "a defect type now debits centering — if that is intended, update this test and say why",
  );
});

// ---------------------------------------------------------------------------
// US-1997 activation step 2 — the generalized weighted overall.
// ---------------------------------------------------------------------------

/** JSON has no NaN literal; the fixture carries the sentinel string instead. */
function decodeSentinels(scores: Record<string, unknown>): Record<string, number> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(scores)) out[k] = v === "__NaN__" ? NaN : v;
  return out as Record<string, number>;
}

Deno.test("shared fixture actually carries weighted cases (an empty table proves nothing)", () => {
  assert(FIXTURE.weighted_cases.length > 0, "weighted_cases is empty — wrong path?");
  assert(FIXTURE.refusal_cases.length > 0, "refusal_cases is empty — wrong path?");
});

for (const [i, c] of FIXTURE.weighted_cases.entries()) {
  Deno.test(`computeRubricWeightedOverall case ${i} (${c.rubric}) → ${c.expected_overall}`, () => {
    const rubric = RUBRICS[c.rubric];
    assert(rubric, `fixture names unknown rubric "${c.rubric}"`);
    assertEquals(computeRubricWeightedOverall(rubric, c.scores), c.expected_overall);
  });
}

for (const [i, c] of FIXTURE.refusal_cases.entries()) {
  Deno.test(`computeRubricWeightedOverall refusal ${i}: ${c.why}`, () => {
    const rubric = RUBRICS[c.rubric];
    assert(rubric, `fixture names unknown rubric "${c.rubric}"`);
    assertThrows(
      () => computeRubricWeightedOverall(rubric, decodeSentinels(c.scores)),
      Error,
      "Refusing to compute a weighted overall",
    );
  });
}

Deno.test("the NaN sentinel is translated, not asserted on as a string", () => {
  // Without this, a runner that forgot to decode would still see a throw (a
  // string factor also refuses) and pass for the wrong reason.
  const withSentinel = FIXTURE.refusal_cases.find((c) =>
    Object.values(c.scores).includes("__NaN__")
  );
  assert(withSentinel, "fixture lost its NaN sentinel case");
  const decoded = decodeSentinels(withSentinel.scores);
  assert(
    Object.values(decoded).some((v) => Number.isNaN(v)),
    "sentinel was not converted to a real NaN",
  );
});

// The strongest available guard on the generalization, inventing no data: every
// case that ALREADY pins human-review.computeWeightedOverall against the web
// mirror (US-2034/US-2386) is replayed through the generalized function under
// the clothing rubric. If the generalization drifts from the formula it
// generalizes, these fail on both sides at once.
for (const [i, c] of WEIGHTED_FIXTURE.cases.entries()) {
  Deno.test(`clothing rubric matches computeWeightedOverall — case ${i}`, () => {
    // Column names (fabric_condition_score) → rubric factor keys
    // (fabric_condition). Derived, not a second hardcoded map.
    const byFactorKey = Object.fromEntries(
      Object.entries(c.factors).map(([k, v]) => [k.replace(/_score$/, ""), v]),
    );
    const viaRubric = computeRubricWeightedOverall(RUBRICS.clothing, byFactorKey);
    assertEquals(viaRubric, computeWeightedOverall(c.factors));
    assertEquals(viaRubric, c.expected_overall);
  });
}

// ── US-2225: a rubric key that no item can ever carry is a dead rubric ───────
//
// THIS IS THE GUARD THAT WAS MISSING. The handbag rubric shipped keyed
// "handbags" while the item_category enum (00230) spells it "bags", so
// rubricForKey(item_category) would have fallen through to CLOTHING forever —
// a bag graded on fabric condition at 30%, which is the exact bug the story
// exists to fix, reintroduced by the fix. Nothing failed: the rubric existed,
// the parity fixture passed, and the certificate rendered clothing factors.
//
// The photo-profile table is the right thing to check against because its keys
// ARE the item_category vocabulary — it is the one place in the edge service
// that enumerates them.

Deno.test("US-2225: every rubric key is a real item_category", () => {
  for (const key of Object.keys(RUBRICS)) {
    assert(
      key in PHOTO_PROFILES,
      `rubric "${key}" matches no item_category. rubricForKey() is called with ` +
        `an item_category, so this rubric can never be selected and every item ` +
        `it was written for silently grades as clothing.`,
    );
  }
});

Deno.test("US-2225: a category with its own rubric has photo slots for its heaviest factors", () => {
  // A rubric that weights an area it never asks the seller to photograph is
  // asking the grader to judge from evidence that does not exist. Checked for
  // the top TWO factors rather than all of them: the tail factors are often
  // legitimately read off the main shots (a bag's structure shows in the front
  // photo), but the heaviest one cannot be.
  const REQUIRE_SLOTS: Record<string, string[]> = {
    // corners_edges (0.30) needs the corner macro; exterior (0.20) is the front
    // and back shots, which every profile already requires.
    bags: ["corner"],
    // US-2224: edges_terminations (0.20) is where a tie, a belt, a scarf and a
    // glove each fail FIRST, and none of it resolves in a full-length front
    // shot. material_condition (0.30) does read off front/back.
    //
    // US-2462: this slot used to be spelled `detail_2` — a numbered slot doing
    // a named slot's job, which is exactly what the role qualifier replaced. It
    // is now (detail, role 'ends_edges'), and asserting the PAIR is what keeps
    // this test meaningful: a bare `detail` would pass while offering the
    // seller nothing that says "photograph the tip and the keeper".
    accessories: ["detail:ends_edges"],
    // US-2223: the sweatband is the story's whole point — "grading a cap from
    // front/back/label alone cannot see the sweatband, which is where the wear
    // is". `interior` is that shot. `angle` carries crown and brim together,
    // which are the two heaviest factors and read badly from a flat front view.
    headwear: ["interior", "angle"],
  };
  for (const [category, slots] of Object.entries(REQUIRE_SLOTS)) {
    const profile = PHOTO_PROFILES[category];
    assert(profile, `no photo profile for ${category}`);
    // Slot identity is (type, role) since US-2462, so index both spellings: a
    // slot with no qualifier answers to its bare type, one with a qualifier
    // answers to "type:role".
    const have = new Set(
      profile.roles.flatMap((r) =>
        r.role ? [`${r.type}:${r.role}`] : [r.type as string]
      ),
    );
    for (const slot of slots) {
      assert(
        have.has(slot),
        `${category} weights a factor that needs the "${slot}" photo slot, and ` +
          `the profile does not offer one — the seller is never asked for the ` +
          `evidence the grade depends on most.`,
      );
    }
  }
});
