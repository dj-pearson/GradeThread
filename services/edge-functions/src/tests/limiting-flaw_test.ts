// US-3330: name the one flaw that keeps a grade from the next level, in words
// only.
//
//   deno test --allow-net --allow-env --allow-read src/tests/limiting-flaw_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  findLimitingFlaw,
  type FlawInput,
  publicLimitingFlaw,
} from "../lib/limiting-flaw.ts";
import type { FactorScores } from "../lib/defect-weighting.ts";

const all = (v: number): FactorScores => ({
  fabric_condition: v,
  structural_integrity: v,
  cosmetic_appearance: v,
  functional_elements: v,
  odor_cleanliness: v,
});

const HOLE: FlawInput = {
  defect: "Large hole",
  defect_type: "hole_puncture",
  severity: "major",
  size_bucket: "large",
  location: "left knee",
};
const PINHOLE: FlawInput = {
  defect: "Pinhole",
  defect_type: "hole_puncture",
  severity: "minor",
  size_bucket: "pinhole",
  location: "hem",
};

Deno.test("a flaw that holds the grade a tier down is named, with the tier", () => {
  const r = findLimitingFlaw(all(8.5), [HOLE]);
  assert(r, "a major hole on an otherwise 8.5 garment should be limiting");
  assertEquals(r.defect, "Large hole");
  assertEquals(r.location, "left knee");
  assertEquals(r.next_tier, "Excellent");
});

Deno.test("when the model's own read limits the score, no flaw is blamed", () => {
  // A 6.0 garment with a pinhole: the pinhole's ceiling sits far above 6.0,
  // so removing it changes nothing.
  assertEquals(findLimitingFlaw(all(6.0), [PINHOLE]), null);
});

Deno.test("no flaws, no sentence", () => {
  assertEquals(findLimitingFlaw(all(8.5), []), null);
});

Deno.test("intentional features are never blamed", () => {
  assertEquals(findLimitingFlaw(all(8.5), [{ ...HOLE, is_intentional: true }]), null);
});

Deno.test("of two flaws, the one whose removal lifts the grade most is named", () => {
  const r = findLimitingFlaw(all(8.5), [PINHOLE, HOLE]);
  assertEquals(r?.defect, "Large hole");
});

Deno.test("never 'keeps this from NWOT': a clean item is not new because a flaw goes", () => {
  // A 10 with one small flaw grades Excellent or NWOT; removing the flaw would
  // reach NWT, which a flaw cannot honestly be said to block.
  const r = findLimitingFlaw(all(10), [PINHOLE]);
  assert(r === null || !["NWOT", "NWT"].includes(r.next_tier));
});

Deno.test("words only: every field is a string, and the public projection drops the rest", () => {
  const r = findLimitingFlaw(all(8.5), [HOLE])!;
  for (const v of Object.values(r)) assertEquals(typeof v, "string");
  assertEquals(
    publicLimitingFlaw({ defect: "stain", location: "cuff", next_tier: "Excellent", penalty: 0.4, gain: 1 }),
    { defect: "stain", location: "cuff", next_tier: "Excellent" },
  );
  assertEquals(publicLimitingFlaw({ defect: "stain" }), null);
  assertEquals(publicLimitingFlaw([1, 2]), null);
});

// ── source guards ───────────────────────────────────────────────────────────

function code(rel: string, stripBlocks = true): string {
  let s = Deno.readTextFileSync(new URL(rel, import.meta.url)).replace(/\r\n/g, "\n");
  if (stripBlocks) s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  return s.replace(/^\s*\/\/.*$/gm, "");
}

Deno.test("the LimitingFlaw type carries no number", () => {
  const src = code("../lib/limiting-flaw.ts");
  const t = src.slice(src.indexOf("export interface LimitingFlaw {"));
  const body = t.slice(0, t.indexOf("}"));
  assert(!/:\s*number/.test(body), "a numeric field would publish the unpublished penalty");
});

Deno.test("the search runs on the model's factors from BEFORE the ceilings", () => {
  const src = code("../lib/ai-grading.ts");
  const capture = src.indexOf("const modelFactors: FactorScores = { ...(parsed.factor_scores as FactorScores) };");
  const weighting = src.indexOf("const weighting = applyDefectWeighting(");
  assert(capture > 0 && capture < weighting, "modelFactors must be copied before weighting");
  assert(src.includes("limiting_flaw: findLimitingFlaw(\n        modelFactors,"));
});

Deno.test("a human adjustment clears the line instead of leaving it stale", () => {
  assert(code("../lib/grade-adjustment.ts").includes("limiting_flaw: null,"));
});

Deno.test("both public paths project only the three string keys", () => {
  const edge = code("../routes/content-public.ts", false);
  assert(edge.includes("limiting_flaw: publicLimitingFlaw("));
  const cols = edge.match(/const CERT_REPORT_(GENESIS|EXTRA)_COLUMNS =[\s\S]*?;/g)?.join(" ") ?? "";
  assert(cols && !cols.includes("limiting_flaw"), "the raw column would be spread into the payload");
  const sql = Deno.readTextFileSync(
    new URL("../../../../supabase/migrations/00788_grade_limiting_flaw.sql", import.meta.url),
  );
  assert(sql.includes("'defect', gr.limiting_flaw ->> 'defect'"));
  assert(sql.includes("'next_tier', gr.limiting_flaw ->> 'next_tier'"));
  assert(!/gr\.limiting_flaw\s+AS\s+limiting_flaw/i.test(sql), "the raw column must not be projected");
});
