import { assert } from "@std/assert";

// US-2138 AC7. Source-structural, because the route mixes a service-role read
// with a jsonb filter that is impractical to invoke in isolation — the same
// approach subscription-ack-disclosure_test.ts and upgrade-confirmation-gate_test.ts
// use. What is being pinned here is not the query shape but a SECURITY BOUNDARY,
// so the assertions are about where the data may and may not appear.

const edgeSrc = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));

const route = edgeSrc("../routes/admin-grading.ts");

Deno.test("AC7: the operator endpoint exists and is bounded", () => {
  assert(
    route.includes('adminGradingRoutes.get("/authenticity/decoder-contradictions"'),
    "the operator endpoint is missing — a capped verdict stays unexplainable",
  );
  assert(
    /DECODER_CONTRADICTION_CAP/.test(route),
    "the read must be bounded; an unbounded scan can be pulled into one response",
  );
  assert(
    /truncated:\s*rows\.length >= DECODER_CONTRADICTION_CAP/.test(route),
    "truncation must be REPORTED — a capped read is a sample of the newest rows, " +
      "which is a different claim from 'all of them'",
  );
});

Deno.test("AC7: the filter runs in the database, not in memory", () => {
  // The key is absent on almost every report. Pulling them all back and
  // discarding them here would work and would scale terribly.
  assert(
    /\.not\(\s*"authenticity_assessment->decoder_contradictions",\s*"is",\s*null\s*\)/
      .test(route),
    "the endpoint must filter on the jsonb key in the query",
  );
});

Deno.test("⚠ AC7: the contradiction detail is OPERATOR-ONLY", () => {
  // THE PROPERTY THIS FILE EXISTS FOR.
  //
  // Each flag names the deterministic rule that caught the item — which is
  // exactly the instruction someone needs to produce a code that passes next
  // time. red_flags is already owner-only for a weaker reason: a model's prose
  // observation can be argued with, a decoder rule cannot, so publishing which
  // rule fired trades away the only signal here that is not guessable.
  //
  // The seller sees the verdict already. They must not see the rule.
  const sellerPage = Deno.readTextFileSync(
    new URL("../../../../src/pages/submission-detail.tsx", import.meta.url),
  );
  assert(
    !sellerPage.includes("decoder_contradictions"),
    "submission-detail.tsx is SELLER-facing and must never render " +
      "decoder_contradictions — it names the rule that caught the item",
  );

  // And the route that serves it must be under the admin group, which carries
  // the auth middleware. A sibling public route would defeat the check above.
  const publicGrading = Deno.readTextFileSync(
    new URL("../routes/public-grading.ts", import.meta.url),
  );
  assert(
    !publicGrading.includes("decoder_contradictions"),
    "the public grading routes must never expose decoder_contradictions",
  );
});

Deno.test("AC7: the pipeline records the flags, not just a count", () => {
  // "Confidence was capped" without saying which rule fired is not an
  // explanation, so persisting only the count would satisfy the cap and fail
  // the AC.
  const pipeline = edgeSrc("../lib/grading-pipeline.ts");
  assert(
    /decoder_contradictions:\s*decoderFlags/.test(pipeline),
    "the pipeline must persist the flag LIST onto the assessment",
  );
  assert(
    /code:\s*i\.code,\s*message:\s*i\.message/.test(pipeline),
    "each recorded flag must carry its code and its human-readable message",
  );
});

Deno.test("AC7: contradictions are recorded even when the cap does not move", () => {
  // A verdict already at or below the cap still had a decoder say the code is
  // impossible. Recording only when the number changes would hide exactly the
  // cases where the model and the decoder already agreed.
  const pipeline = edgeSrc("../lib/grading-pipeline.ts");
  const start = pipeline.indexOf("if (authenticityAssessment && decoderFlags.length > 0)");
  assert(start > -1, "the cap block is missing or renamed");
  const block = pipeline.slice(start, start + 900);
  const idxRecord = block.indexOf("decoder_contradictions: decoderFlags");
  const idxMoved = block.indexOf("if (after < before)");
  assert(idxRecord > -1 && idxMoved > -1, "expected both the record and the moved-check");
  assert(
    idxRecord < idxMoved,
    "the flags must be recorded BEFORE the did-the-number-move branch, or a " +
      "verdict already at the cap loses its explanation",
  );
});
