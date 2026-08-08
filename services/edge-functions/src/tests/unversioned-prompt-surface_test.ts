// US-2432: the eval gate must declare the prompt surface it did NOT test.
//
// resolveActivePrompt versions the SYSTEM prompt. Everything assembled into the
// USER message is compiled into the binary: the garment-type and category
// criteria, the response schema, the Rules block, the factor-weights line, the
// fabric criteria. runEval supplies that same text to BOTH legs of its
// comparison, so a pass certifies a system prompt against a user-message
// surface it never varied — and, until this commit, never mentioned.
//
// The fix is not a gate. It is a FINGERPRINT: two eval runs with different
// surface hashes measured different prompts and are not comparable, however
// close their MAE looks. These tests exist because a fingerprint that fails to
// move is worse than none — it converts "we do not know" into "we checked".

import "./_env.ts"; // must come first — ai-grading reaches lib/supabase.ts
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  type CompositeGradeResult,
  type PerImageAnalysis,
  unversionedPromptSurface,
  unversionedPromptSurfaceHash,
} from "../lib/ai-grading.ts";

/** Source of a lib file, CRLF-normalised and comment-stripped. */
async function codeOf(file: string): Promise<string> {
  const src = await Deno.readTextFile(new URL(`../lib/${file}`, import.meta.url));
  return src
    .replace(/\r\n/g, "\n")
    // Comments first: every one of these assertions is explained in a comment
    // that quotes the identifiers being searched for, so an unstripped scan
    // passes off the prose alone (US-2125's lesson, re-learned by US-2429).
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const GATE = "GRADING_CATEGORY_CRITERIA_V2";

function withGate<T>(on: boolean, fn: () => T): T {
  const before = Deno.env.get(GATE);
  if (on) Deno.env.set(GATE, "true");
  else Deno.env.delete(GATE);
  try {
    return fn();
  } finally {
    if (before === undefined) Deno.env.delete(GATE);
    else Deno.env.set(GATE, before);
  }
}

Deno.test("the surface is stable — same inputs, same hash", () => {
  // The probes are fixed, so repeated calls must agree. A hash that drifts on
  // its own makes every comparison report "not comparable" and gets ignored,
  // which is the same outcome as not having one.
  const a = withGate(false, unversionedPromptSurfaceHash);
  const b = withGate(false, unversionedPromptSurfaceHash);
  assertEquals(a, b);
  assertEquals(a.length, 8, "expected the 8-hex hashPrompt digest");
});

Deno.test("the surface MOVES when the assembled user message moves", () => {
  // The whole claim rests on this. Flipping the category-criteria gate genuinely
  // changes what eleven categories are told, so it must change the fingerprint —
  // if it did not, the hash would be measuring something other than the prompt.
  assertNotEquals(
    withGate(false, unversionedPromptSurfaceHash),
    withGate(true, unversionedPromptSurfaceHash),
    "Flipping GRADING_CATEGORY_CRITERIA_V2 changes eleven categories' prompts " +
      "but not the surface hash. The fingerprint is not reading the assembled " +
      "message — check that the probes in unversionedPromptSurface() still call " +
      "the real builders rather than a cached or hard-coded string.",
  );
});

Deno.test("the surface covers every criteria entry, not a sample", () => {
  // A probe set that missed a category would let that category's text change
  // with no hash movement — a blind spot inside the blind-spot detector.
  const surface = withGate(true, unversionedPromptSurface);
  for (
    const c of [
      // the eight that shipped before US-2222
      "JEANS-SPECIFIC",
      "PANTS-SPECIFIC",
      "SHORTS-SPECIFIC",
      "JACKET-SPECIFIC",
      "SWEATER-SPECIFIC",
      "HOODIE-SPECIFIC",
      "T-SHIRT-SPECIFIC",
      "DRESS-SPECIFIC",
      // the eleven added by US-2222
      "SHIRT-SPECIFIC",
      "BLOUSE-SPECIFIC",
      "COAT-SPECIFIC",
      "SKIRT-SPECIFIC",
      "SNEAKERS-SPECIFIC",
      "BOOTS-SPECIFIC",
      "SANDALS-SPECIFIC",
      "HAT-SPECIFIC",
      "BAG-SPECIFIC",
      "BELT-SPECIFIC",
      "SCARF-SPECIFIC",
    ]
  ) {
    assert(
      surface.includes(c),
      `"${c}" is not in the probed surface, so an edit to it would not move the ` +
        "hash. Every criteria entry must be reachable from unversionedPromptSurface().",
    );
  }

  // Every garment_type block too — they are equally unversioned.
  for (const t of ["For tops:", "For bottoms:", "For outerwear:", "For dresses:", "For footwear:", "For accessories:"]) {
    assert(surface.includes(t), `garment-type criteria "${t}" missing from the probed surface`);
  }
});

Deno.test("the composite half is probed — schema, Rules and factor weights", () => {
  // These are the highest-leverage unversioned text in the system: the schema
  // decides what the model may return at all, and the weights line states the
  // scoring contract.
  //
  // ⚠ Assert on strings UNIQUE to the composite message. The first version of
  // this test matched /Rules:/ and /weight/, both of which also appear in the
  // per-image prompt — so deleting the composite probe entirely left it green.
  // Caught by mutating the probe, not by reading the test.
  const surface = withGate(false, unversionedPromptSurface);
  assert(
    surface.includes("PER-IMAGE ANALYSES:"),
    "the composite prompt is not probed at all — its response schema, Rules " +
      "block and factor-weights line could change with no hash movement. This " +
      "header appears ONLY in buildCompositeUserPrompt.",
  );
  assert(
    surface.includes("Apply the factor weights (Fabric 30%, Structural 25%"),
    "the composite factor-weights sentence is not probed. It states the scoring " +
      "contract in the prompt and is not covered by any prompt version.",
  );
  assert(
    surface.includes("overall_score must be the weighted average of factor scores"),
    "the composite Rules block is not probed — an edit to it would not move the hash",
  );
});

Deno.test("runEval reports the surface, and what of it is now covered", async () => {
  // A source scan, because reaching the real runEval needs a database and the
  // property is about what the RESULT CLAIMS, not about what it computed.
  //
  // This used to require the literal `covered: false`, and the comment said that
  // constant should stop being a constant only when the user message got a real
  // seam. US-2438 built the seam, so it now requires the LIST — deliberately not
  // a `true`, because coverage is partial and a boolean cannot say which blocks.
  const src = (
    await Deno.readTextFile(new URL("../lib/grading-eval.ts", import.meta.url))
  ).replace(/\r\n/g, "\n");

  assert(
    /unversioned_surface:\s*\{\s*hash:\s*surfaceHash,\s*covered:\s*COVERED_BLOCK_KEYS,\s*blocks:\s*activeBlocks,\s*\}/
      .test(src),
    "runEval no longer reports unversioned_surface. Without it a caller " +
      "comparing two eval runs cannot tell whether they measured the same prompt.",
  );
  assert(
    !/covered:\s*true/.test(src),
    "the eval claims the user-message surface is fully covered. It is not — the " +
      "response schema, the Rules block and the factor-weights line are still " +
      "compiled in with no identity, so a boolean overstates the gate.",
  );

  // THE HOLE THE SEAM OPENED. `surfaceHash` digests the CODE DEFAULTS. Once a
  // block row can replace one of those at runtime, the hash no longer describes
  // what ran, and two runs under different block versions read as comparable —
  // worse than no fingerprint, because the hash's only job is to say when two
  // runs must NOT be compared. Reporting the active overrides is what closes it.
  assert(
    /const activeBlocks = await activeBlockVersions\(/.test(src),
    "runEval no longer reads the active block overrides, so its surface hash " +
      "silently stops describing the prompt that actually ran",
  );

  // Strip comments first: the block above this assertion explains the bug and
  // quotes the very strings being searched for (US-2125's lesson, and US-2429's).
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const logAt = code.indexOf("unversioned user-message");
  const insertAt = code.indexOf('.from("grading_eval_runs")');
  assert(logAt > -1, "the surface log line is gone — the blind spot is silent again");
  assert(
    logAt < insertAt,
    "the surface is logged AFTER the run is persisted. It should be stated " +
      "alongside the verdict it qualifies, so a reader tailing the run sees both.",
  );

  const listing = (
    await Deno.readTextFile(new URL("../lib/listing-eval.ts", import.meta.url))
  ).replace(/\r\n/g, "\n");
  assert(
    /unversioned_surface:\s*\{\s*hash:\s*hashPrompt\(LISTING_GEN_TOOL\)/.test(listing),
    "listing-eval must report its own surface too. Its thresholds (title " +
      "length, aspect coverage, price sanity) all read fields LISTING_GEN_TOOL " +
      "defines, so a schema edit moves every score without touching the version " +
      "under test.",
  );
});

// ── AC3: a grade record can say which version of EVERY prompt input made it ──
//
// Two halves, and they fail differently. The per-image version had no carrier at
// all — PER_IMAGE_PROMPT_VERSION was a display constant, so bumping it changed
// nothing a graded row could report, while READING like compliance with the
// prompt lifecycle. The user-message surface had no identity, so a content edit
// inside an already-present block left before and after reporting one era.
//
// These are source scans because reaching analyzeImage / compositeGrade needs a
// live Anthropic client. The property under test is what the code STAMPS, not
// what the model returned, so the scan is measuring the right thing — but it is
// weaker than a behavioural test and the assertions below are written to survive
// only the real wiring, never a comment mentioning it.

Deno.test("PerImageAnalysis can carry a prompt version at all", () => {
  // The type half. Before US-2432 there was nowhere to put it, so the pipeline
  // could not have persisted one had it wanted to.
  const analysis: PerImageAnalysis = {
    image_type: "front",
    detected_issues: [],
    condition_signals: [],
    style_attributes: [],
    estimated_scores: {
      fabric_condition: 8,
      structural_integrity: 8,
      cosmetic_appearance: 8,
      functional_elements: 8,
      odor_cleanliness: 8,
    },
    prompt_version: "per_image_v5",
  };
  assertEquals(analysis.prompt_version, "per_image_v5");

  // Optional, deliberately: historical rows and eval/shadow traces predate the
  // field. Absent must read as "unknown" — defaulting it to the current constant
  // would assert an era those grades never ran under.
  const historical: PerImageAnalysis = { ...analysis };
  delete historical.prompt_version;
  assertEquals(historical.prompt_version, undefined);
});

Deno.test("analyzeImage stamps the RESOLVED per-image prompt, not the constant", async () => {
  const code = await codeOf("ai-grading.ts");

  // US-2438 widened this from an exact match: the stamp is now a template
  // literal, `${prompt.versionName}${blockVersionSuffix(blocks)}`, so the grade
  // also names which USER-message blocks served. The property being pinned is
  // unchanged — the stamp must START from the RESOLVED prompt — and the
  // constant-instead-of-resolved assertion below is what actually enforces it.
  assert(
    /prompt_version:\s*`?\$?\{?prompt\.versionName/.test(code),
    "analyzeImage no longer stamps prompt_version on its returned analysis. " +
      "grade_reports.prompt_version is written by the COMPOSITE stage only, so " +
      "per_image_analysis[].prompt_version is the ONLY place a per-image prompt " +
      "reaches a grade record. Without it, bumping PER_IMAGE_PROMPT_VERSION is a " +
      "no-op that reads as compliance with the prompt lifecycle.",
  );

  // `prompt` is resolveActivePrompt's result — a DB override or a canary slice
  // wins over the code default. Stamping the constant instead would report
  // per_image_v5 for a grade that ran a candidate row, which is worse than
  // reporting nothing: it is a confident wrong answer.
  assert(
    !/prompt_version:\s*PER_IMAGE_PROMPT_VERSION/.test(code),
    "analyzeImage stamps the PER_IMAGE_PROMPT_VERSION constant rather than the " +
      "resolved prompt.versionName. Every DB-overridden and canary grade would " +
      "then be attributed to the code default it did not run.",
  );
});

Deno.test("compositeGrade returns the surface hash beside the prompt version", async () => {
  const code = await codeOf("ai-grading.ts");
  assert(
    /prompt_surface_hash:\s*promptSurfaceHash/.test(code),
    "compositeGrade no longer returns prompt_surface_hash, so nothing downstream " +
      "can persist it and the user-message surface is anonymous again.",
  );
  assert(
    /const\s+promptSurfaceHash\s*=\s*unversionedPromptSurfaceHash\(\)/.test(code),
    "promptSurfaceHash is no longer computed from unversionedPromptSurfaceHash(). " +
      "A hash from any other source is not the one the eval gate reports, so the " +
      "two can disagree about which surface a run measured.",
  );

  // The type is REQUIRED, not optional. Optional would let a future construction
  // site omit it silently and produce grades with no surface identity, which is
  // the state this story exists to end. tsc is the guard; this pins the intent.
  const result: Pick<CompositeGradeResult, "prompt_version" | "prompt_surface_hash"> = {
    prompt_version: "composite_v4+fabric",
    prompt_surface_hash: unversionedPromptSurfaceHash(),
  };
  assertEquals(result.prompt_surface_hash.length, 8);
});

Deno.test("the pipeline persists the surface hash, and omits the KEY when absent", async () => {
  // Collapse whitespace so the assertion survives reformatting but not rewiring.
  const code = (await codeOf("grading-pipeline.ts")).replace(/\s+/g, " ");

  assert(
    code.includes(
      "...(compositeResult.prompt_surface_hash " +
        "? { prompt_surface_hash: compositeResult.prompt_surface_hash } : {})",
    ),
    "grade_reports no longer receives prompt_surface_hash via a conditional " +
      "SPREAD. A plain `prompt_surface_hash: x` key NAMES the column in the " +
      "PostgREST payload even when the value is null — which 42703s the whole " +
      "insert, and with it a paid grade, on any environment where 00562 has not " +
      "applied yet. The spread is what makes this deployable ahead of the SQL.",
  );
});
