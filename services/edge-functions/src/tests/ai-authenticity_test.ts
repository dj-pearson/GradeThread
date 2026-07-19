// Unit tests for the pure helpers of the premium authenticity / counterfeit-
// confidence add-on (US-601). ai-authenticity.ts transitively imports the
// service-role supabase client at module load, so we set dummy env first and
// dynamic-import (mirrors shopify-client_test.ts).
//   deno test src/tests/ai-authenticity_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const {
  deriveCounterfeitRisk,
  normalizeAuthenticityAssessment,
  selectAuthenticityImages,
  hasMacroEvidence,
  AUTHENTICITY_LIMITATIONS,
  AUTHENTICITY_NO_MACRO_LIMITATION,
  AUTHENTICITY_NO_MACRO_CONFIDENCE_CAP,
  AUTHENTICITY_PROMPT_VERSION,
} = await import("../lib/ai-authenticity.ts");

// ── US-2134: macro evidence gates how confident the verdict may be ──────────

Deno.test("hasMacroEvidence: only serial/marking count", () => {
  assert(hasMacroEvidence(["front", "serial"]));
  assert(hasMacroEvidence(["marking"]));
  assertEquals(hasMacroEvidence(["front", "back", "label"]), false);
  // `detail` is a generic close-up that may show nothing authenticating — it
  // must NOT license a confident verdict.
  assertEquals(hasMacroEvidence(["detail", "detail_2"]), false);
  assertEquals(hasMacroEvidence([]), false);
});

Deno.test("applyVerdictCap: no macro evidence caps confidence", () => {
  assertEquals(applyVerdictCap(0.95, 0, 0, true), 0.9, "ceiling still applies");
  assertEquals(applyVerdictCap(0.95, 0, 0, false), AUTHENTICITY_NO_MACRO_CONFIDENCE_CAP);
  // Composition is min-of-caps: a contradiction still dominates the weaker cap.
  assertEquals(applyVerdictCap(0.95, 1, 0, false), 0.5);
  // Never RAISES a confidence that was already below the cap.
  assertEquals(applyVerdictCap(0.3, 0, 0, false), 0.3);
});

Deno.test("applyVerdictCap: the macro flag defaults true (existing callers unchanged)", () => {
  assertEquals(applyVerdictCap(0.95, 0, 0), applyVerdictCap(0.95, 0, 0, true));
});

Deno.test("normalizeAuthenticityAssessment: thin image set caps confidence and widens the disclosure", () => {
  const raw = {
    is_brand_recognizable: true,
    brand_assessed: "Coach",
    authenticity_confidence: 0.95,
    red_flags: [],
    summary: "Looks consistent.",
  };

  const thin = normalizeAuthenticityAssessment(raw, "m", AUTHENTICITY_PROMPT_VERSION, [
    "front",
    "back",
  ]);
  assertEquals(thin.verdict_confidence, AUTHENTICITY_NO_MACRO_CONFIDENCE_CAP);
  assert(
    thin.limitations.includes(AUTHENTICITY_NO_MACRO_LIMITATION.trim()),
    "the stated limitation should match the evidence that actually backed it",
  );

  const withMacro = normalizeAuthenticityAssessment(raw, "m", AUTHENTICITY_PROMPT_VERSION, [
    "front",
    "serial",
  ]);
  assertEquals(withMacro.verdict_confidence, 0.9);
  assertEquals(withMacro.limitations, AUTHENTICITY_LIMITATIONS);
});

Deno.test("normalizeAuthenticityAssessment: an UNKNOWN image set does not trigger the cap", () => {
  // Missing metadata is not evidence of thin evidence — the cap is for the case
  // we positively know is thin.
  const a = normalizeAuthenticityAssessment(
    { is_brand_recognizable: true, brand_assessed: "Coach", authenticity_confidence: 0.95 },
    "m",
  );
  assertEquals(a.verdict_confidence, 0.9);
  assertEquals(a.limitations, AUTHENTICITY_LIMITATIONS);
});

Deno.test("selectAuthenticityImages: macro frames outrank generic garment shots", () => {
  const picked = selectAuthenticityImages([
    { imageType: "front" },
    { imageType: "back" },
    { imageType: "marking" },
    { imageType: "serial" },
  ]).map((p) => p.imageType);
  assertEquals(picked.slice(0, 2), ["serial", "marking"]);
});

Deno.test("deriveCounterfeitRisk: no recognizable brand → indeterminate", () => {
  assertEquals(deriveCounterfeitRisk(0.9, 0, false), "indeterminate");
  assertEquals(deriveCounterfeitRisk(0.1, 5, false), "indeterminate");
});

Deno.test("deriveCounterfeitRisk: high confidence, no flags → low", () => {
  assertEquals(deriveCounterfeitRisk(0.95, 0, true), "low");
  assertEquals(deriveCounterfeitRisk(0.6, 0, true), "low");
});

Deno.test("deriveCounterfeitRisk: low confidence OR any flag → elevated", () => {
  assertEquals(deriveCounterfeitRisk(0.5, 0, true), "elevated");
  assertEquals(deriveCounterfeitRisk(0.9, 1, true), "elevated");
});

Deno.test("deriveCounterfeitRisk: flags AND very low confidence → high", () => {
  assertEquals(deriveCounterfeitRisk(0.3, 2, true), "high");
  assertEquals(deriveCounterfeitRisk(0.39, 1, true), "high");
});

Deno.test("normalizeAuthenticityAssessment: clean model output", () => {
  const a = normalizeAuthenticityAssessment(
    {
      is_brand_recognizable: true,
      brand_assessed: "Nike",
      authenticity_confidence: 0.91,
      signals_examined: ["brand label font", "swoosh print"],
      red_flags: [],
      supporting_signals: ["correct heat-transfer tag", "even stitching"],
      summary: "Consistent with a genuine Nike example.",
    },
    "claude-test",
  );
  assert(a.assessed);
  assertEquals(a.authenticity_confidence, 0.91);
  assertEquals(a.counterfeit_risk, "low");
  assertEquals(a.brand_assessed, "Nike");
  assertEquals(a.supporting_signals.length, 2);
  assertEquals(a.model, "claude-test");
  assertEquals(a.prompt_version, AUTHENTICITY_PROMPT_VERSION);
  // Disclosure is ALWAYS the fixed constant, never trusted to the model.
  assertEquals(a.limitations, AUTHENTICITY_LIMITATIONS);
});

Deno.test("normalizeAuthenticityAssessment: garbage → cautious indeterminate", () => {
  const a = normalizeAuthenticityAssessment(null, "m");
  assert(a.assessed);
  assertEquals(a.authenticity_confidence, 0.5);
  assertEquals(a.counterfeit_risk, "indeterminate");
  assertEquals(a.brand_assessed, null);
  assertEquals(a.red_flags, []);
  assertEquals(a.limitations, AUTHENTICITY_LIMITATIONS);
});

Deno.test("normalizeAuthenticityAssessment: clamps confidence + drops brand when unrecognized", () => {
  const a = normalizeAuthenticityAssessment(
    {
      is_brand_recognizable: false,
      brand_assessed: "Gucci", // ignored because brand not recognizable
      authenticity_confidence: 2.5, // out of range → clamped to 1
      red_flags: ["", "  ", "misaligned logo"],
    },
    "m",
  );
  assertEquals(a.authenticity_confidence, 1);
  assertEquals(a.brand_assessed, null);
  assertEquals(a.counterfeit_risk, "indeterminate");
  // Empty/whitespace red flags filtered out.
  assertEquals(a.red_flags, ["misaligned logo"]);
});

Deno.test("selectAuthenticityImages: prioritizes label/detail and caps at 6", () => {
  const imgs = [
    { imageType: "front" },
    { imageType: "back" },
    { imageType: "label" },
    { imageType: "detail" },
    { imageType: "detail_2" },
    { imageType: "defect" },
    { imageType: "label_2" },
    { imageType: "detail_3" },
  ];
  const picked = selectAuthenticityImages(imgs);
  assertEquals(picked.length, 6);
  // label + label_2 + the details should come before front/back/defect.
  assertEquals(picked[0].imageType, "label");
  assertEquals(picked[1].imageType, "label_2");
  assert(!picked.some((p) => p.imageType === "defect"));
});

// ── US-1769: verdict + cap + per-tell findings ──────────────────────────────
const {
  applyVerdictCap,
  deriveVerdict,
  normalizeTellFindings,
  buildTellsBlock,
  AUTHENTICITY_VERDICT_CONFIDENCE_CEILING,
  AUTHENTICITY_CONTRADICTION_CONFIDENCE_CAP,
} = await import("../lib/ai-authenticity.ts");

Deno.test("applyVerdictCap: photo-only ceiling always applies", () => {
  assertEquals(applyVerdictCap(0.99, 0, 0), AUTHENTICITY_VERDICT_CONFIDENCE_CEILING);
  assertEquals(applyVerdictCap(0.5, 0, 0), 0.5, "below the ceiling is unchanged");
});

Deno.test("applyVerdictCap: a contradiction caps harder (min-of-caps, never raises)", () => {
  assertEquals(applyVerdictCap(0.95, 1, 0), AUTHENTICITY_CONTRADICTION_CONFIDENCE_CAP);
  assertEquals(applyVerdictCap(0.95, 0, 2), AUTHENTICITY_CONTRADICTION_CONFIDENCE_CAP);
  assertEquals(applyVerdictCap(0.3, 1, 0), 0.3, "an already-low confidence isn't raised by the cap");
});

Deno.test("deriveVerdict: contradictions → red_flags; clean high → likely_authentic", () => {
  assertEquals(deriveVerdict(0.9, 0, 0, true), "likely_authentic");
  assertEquals(deriveVerdict(0.5, 1, 0, true), "red_flags");
  assertEquals(deriveVerdict(0.5, 0, 1, true), "red_flags", "an inconsistent tell is a contradiction");
  assertEquals(deriveVerdict(0.6, 0, 0, true), "inconclusive", "recognizable but not confident enough");
  assertEquals(deriveVerdict(0.95, 0, 0, false), "inconclusive", "no recognizable brand is never a verdict");
});

Deno.test("normalizeTellFindings: unknown status is cautiously 'not_visible'; junk dropped", () => {
  const out = normalizeTellFindings([
    { category: "serial", claim: "creed", status: "inconsistent", note: "misaligned" },
    { category: "font", claim: "GG", status: "bogus" },
    { claim: "" },
    42,
  ]);
  assertEquals(out.length, 2);
  assertEquals(out[0].status, "inconsistent");
  assertEquals(out[1].status, "not_visible", "unknown status → not_visible (never a false contradiction)");
});

Deno.test("buildTellsBlock: empty inputs yield an empty block (v1 prompt unchanged)", () => {
  assertEquals(buildTellsBlock([], []), "");
});

Deno.test("buildTellsBlock: tells + cross-checks render as trusted reference sections", () => {
  const block = buildTellsBlock(
    [{ category: "date_code", claim: "Stamped not printed", check: "look under tab", confidence: 0.7 }],
    [{ code: "date_in_future", severity: "flag", message: "year 2030 > now" }],
  );
  assert(block.includes("KNOWN_AUTHENTICATION_TELLS"));
  assert(block.includes("[date_code] Stamped not printed"));
  assert(block.includes("DECODER_CROSS_CHECKS"));
  assert(block.includes("date_in_future"));
});

Deno.test("normalizeAuthenticityAssessment: additive verdict fields; version passthrough", () => {
  const a = normalizeAuthenticityAssessment(
    {
      is_brand_recognizable: true,
      brand_assessed: "Gucci",
      authenticity_confidence: 0.95,
      tell_findings: [{ category: "serial", claim: "tab digits", status: "inconsistent", note: "uneven" }],
    },
    "test-model",
    "authenticity_v1+tells",
  );
  assertEquals(a.verdict, "red_flags", "an inconsistent tell drives the verdict");
  assertEquals(a.verdict_confidence, AUTHENTICITY_CONTRADICTION_CONFIDENCE_CAP);
  assertEquals(a.authenticity_confidence, 0.95, "raw model confidence is preserved for continuity");
  assertEquals(a.tell_findings.length, 1);
  assertEquals(a.prompt_version, "authenticity_v1+tells");
});

Deno.test("normalizeAuthenticityAssessment: ungrounded call keeps default version + empty findings", () => {
  const a = normalizeAuthenticityAssessment(
    { is_brand_recognizable: true, brand_assessed: "Nike", authenticity_confidence: 0.8 },
    "test-model",
  );
  assertEquals(a.prompt_version, AUTHENTICITY_PROMPT_VERSION);
  assertEquals(a.tell_findings.length, 0);
  assertEquals(a.verdict, "likely_authentic");
  assertEquals(a.verdict_confidence, 0.8);
});

// ── US-1770: human-review routing (AC2) ─────────────────────────────────────
const { authenticityNeedsReview, AUTHENTICITY_REVIEW_CONFIDENCE_THRESHOLD } = await import(
  "../lib/ai-authenticity.ts"
);

Deno.test("authenticityNeedsReview: null (add-on didn't run) → no extra review", () => {
  assertEquals(authenticityNeedsReview(null), false);
});

Deno.test("authenticityNeedsReview: a red-flag verdict always routes to review", () => {
  assert(authenticityNeedsReview({ verdict: "red_flags", verdict_confidence: 0.5, brand_assessed: "Gucci" }));
});

Deno.test("authenticityNeedsReview: recognizable brand + sub-threshold confidence → review", () => {
  assert(
    authenticityNeedsReview({
      verdict: "inconclusive",
      verdict_confidence: AUTHENTICITY_REVIEW_CONFIDENCE_THRESHOLD - 0.01,
      brand_assessed: "Coach",
    }),
  );
});

Deno.test("authenticityNeedsReview: confident likely-authentic does NOT force review", () => {
  assertEquals(
    authenticityNeedsReview({ verdict: "likely_authentic", verdict_confidence: 0.85, brand_assessed: "Nike" }),
    false,
  );
});

Deno.test("authenticityNeedsReview: no recognizable brand → nothing to review", () => {
  assertEquals(
    authenticityNeedsReview({ verdict: "inconclusive", verdict_confidence: 0.3, brand_assessed: null }),
    false,
  );
});
