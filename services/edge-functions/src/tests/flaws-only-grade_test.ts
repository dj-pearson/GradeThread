// US-3325: the flaws-only grade is recorded beside the real grade and never
// moves it.
//
//   deno test --allow-net --allow-env --allow-read src/tests/flaws-only-grade_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  buildReviewedGrades,
  compareFlawsOnly,
  type FlawsOnlyRow,
} from "../lib/review-baseline.ts";

// ai-grading.ts pulls in the service-role client, which reads env at load.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
const { flawsOnlyGrade } = await import("../lib/ai-grading.ts");

const TEN = {
  fabric_condition: 10,
  structural_integrity: 10,
  cosmetic_appearance: 10,
  functional_elements: 10,
  odor_cleanliness: 10,
};

Deno.test("a flawless item grades 10 on the flaws alone", () => {
  const g = flawsOnlyGrade(TEN);
  assertEquals(g.overall, 10);
});

Deno.test("ceilings step to 0.5 and weight through the shared helper", () => {
  // fabric 7.3 -> 7.5 (the 0.5 factor step); overall 7.5*0.3 + 10*0.7 = 9.25 -> 9.3
  const g = flawsOnlyGrade({ ...TEN, fabric_condition: 7.3 });
  assertEquals(g.factors.fabric_condition_score, 7.5);
  assertEquals(g.factors.structural_integrity_score, 10);
  assertEquals(g.overall, 9.3);
});

Deno.test("a ceiling below 1 clamps to the scale floor", () => {
  const g = flawsOnlyGrade({ ...TEN, structural_integrity: -3 });
  assertEquals(g.factors.structural_integrity_score, 1);
});

// ── the comparison ──────────────────────────────────────────────────────────

const REPORT = {
  overall_score: 7.0,
  fabric_condition_score: 7,
  structural_integrity_score: 7,
  cosmetic_appearance_score: 7,
  functional_elements_score: 7,
  odor_cleanliness_score: 7,
};
const SNAP = {
  original_fabric_condition: 8,
  original_structural_integrity: 8,
  original_cosmetic_appearance: 8,
  original_functional_elements: 8,
  original_odor_cleanliness: 8,
};

function flaws(id: string, overall: number, factor: number): FlawsOnlyRow {
  return {
    grade_report_id: id,
    overall,
    factors: {
      fabric_condition_score: factor,
      structural_integrity_score: factor,
      cosmetic_appearance_score: factor,
      functional_elements_score: factor,
      odor_cleanliness_score: factor,
    },
  };
}

Deno.test("both grades are scored against the same human answer, over the same grades", () => {
  const reports = new Map([["a", REPORT], ["b", REPORT], ["old", REPORT]]);
  const rows = ["a", "b", "old"].map((id) => ({
    grade_report_id: id,
    original_score: 8.0,
    adjusted_score: 7.0,
    reviewed_at: "2026-09-10T10:00:00Z",
    review_action: "adjust",
    ...SNAP,
  }));
  const graded = buildReviewedGrades(rows, reports).map((grade) => ({
    grade,
    category: "jeans",
  }));
  // "old" predates 00785: no flaws-only row, so it is excluded, not zeroed.
  const cmp = compareFlawsOnly(
    graded,
    new Map([["a", flaws("a", 6.5, 6.5)], ["b", flaws("b", 7.5, 7.5)]]),
  );
  assertEquals(cmp.compared, 2);
  assertEquals(cmp.excluded, 1);
  // AI said 8.0 both times, human 7.0: AI off by 1.0, too lenient.
  assertEquals(cmp.ai_mean_absolute_error, 1);
  assertEquals(cmp.ai_mean_signed_error, -1);
  // Flaws-only said 6.5 and 7.5: off by 0.5 each, cancelling in sign.
  assertEquals(cmp.flaws_only_mean_absolute_error, 0.5);
  assertEquals(cmp.flaws_only_mean_signed_error, 0);
  const fabric = cmp.factors.find((f) => f.factor === "fabric_condition")!;
  assertEquals(fabric.count, 2);
  assertEquals(fabric.ai_mean_absolute_error, 1);
  assertEquals(fabric.flaws_only_mean_absolute_error, 0.5);
  assertEquals(cmp.categories, [{
    garment_category: "jeans",
    count: 2,
    ai_mean_absolute_error: 1,
    flaws_only_mean_absolute_error: 0.5,
  }]);
});

Deno.test("an empty set compares nothing and divides by nothing", () => {
  const cmp = compareFlawsOnly([], new Map());
  assertEquals(cmp.compared, 0);
  assertEquals(cmp.flaws_only_mean_absolute_error, 0);
});

// ── source guards: recorded, never blended, never public ────────────────────

const SRC = new URL("../", import.meta.url);
function read(rel: string): string {
  return Deno.readTextFileSync(new URL(rel, SRC)).replace(/\r\n/g, "\n");
}
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

Deno.test("compositeGrade records the flaws-only grade and computes the real one without it", () => {
  const src = stripComments(read("lib/ai-grading.ts"));
  const body = src.slice(src.indexOf("export async function compositeGrade("));
  assert(body.length > 0, "compositeGrade not found");
  const uses = body.match(/flaws_only|flawsOnlyGrade\(/g) ?? [];
  // Exactly one use: the return object. Any other use is a path by which the
  // flaws-only number could reach overall_score, factors or confidence.
  assertEquals(uses.length, 2, `expected only 'flaws_only: flawsOnlyGrade(...)', found ${uses.join(", ")}`);
  assert(/flaws_only: flawsOnlyGrade\(weighting\.ceilingByFactor\)/.test(body));
});

Deno.test("the pipeline writes the flaws-only grade to its deny-all table, never onto grade_reports", () => {
  const src = stripComments(read("lib/grading-pipeline.ts"));
  assert(src.includes('.from("grade_flaws_only")'), "no grade_flaws_only write");
  const reportInsert = src.slice(src.indexOf('.from("grade_reports")\n      .insert({'));
  const payload = reportInsert.slice(0, reportInsert.indexOf("})"));
  assert(!/flaws_only/.test(payload), "flaws-only reached the grade_reports insert, which the owner can read");
});

Deno.test("no public certificate projection exposes grade_flaws_only", () => {
  const edge = stripComments(read("routes/content-public.ts"));
  assert(!edge.includes("grade_flaws_only") && !edge.includes("flaws_only"));
  const dir = new URL("../../../../supabase/migrations/", import.meta.url);
  for (const e of Deno.readDirSync(dir)) {
    if (!e.name.endsWith(".sql")) continue;
    const sql = Deno.readTextFileSync(new URL(e.name, dir));
    if (/VIEW\s+public\.public_grade_reports/i.test(sql)) {
      assert(!sql.includes("flaws_only"), `${e.name} puts flaws-only data in the public view`);
    }
  }
});
