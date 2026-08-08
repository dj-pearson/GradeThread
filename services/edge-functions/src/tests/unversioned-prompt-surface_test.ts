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
  unversionedPromptSurface,
  unversionedPromptSurfaceHash,
} from "../lib/ai-grading.ts";

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

Deno.test("runEval reports the surface as explicitly NOT covered", async () => {
  // A source scan, because reaching the real runEval needs a database and the
  // property is about what the RESULT CLAIMS, not about what it computed. The
  // constant `false` is the point: it is the honest answer today, and it should
  // stop being a constant only when the user message gets a real seam.
  const src = (
    await Deno.readTextFile(new URL("../lib/grading-eval.ts", import.meta.url))
  ).replace(/\r\n/g, "\n");

  assert(
    /unversioned_surface:\s*\{\s*hash:\s*surfaceHash,\s*covered:\s*false\s*\}/.test(src),
    "runEval no longer reports unversioned_surface. Without it a caller " +
      "comparing two eval runs cannot tell whether they measured the same prompt.",
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
