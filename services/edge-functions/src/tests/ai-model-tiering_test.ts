// US-2924: which AI features run on the CHEAP model, and which may not.
//
// WHY THIS IS SPLIT RATHER THAN SWITCHED WHOLESALE. Measured on production over
// 30 days, size_estimate was the most expensive user AI action at $0.0886 a
// call - twice the blended rate - and at 2,000 actions it is the single reason
// the Business plan does not cover its own allowance. Moving it to Haiku 4.5
// takes the input rate from $3/MTok to $1 and the output rate from $15 to $5.
//
// But estimateSize has three callers and they are not the same risk:
//
//   ai-listing.ts (AutoLister)   a listing field. Wrong size, wrong listing.
//   flipdesk-ai.ts (the route)   the same, on demand.
//   grading-pipeline.ts          feeds tagGroundTruthBlock, which goes into the
//                                GRADING PROMPT as trusted ground truth.
//
// The third one changes grades. Swapping the model underneath it is exactly the
// silent grading change the prompt-version lifecycle exists to prevent - no
// shadow compare, no golden-set eval, no version suffix to attribute the era
// afterwards. So grading PINS the full model explicitly, and the guard below is
// what stops a later edit from quietly un-pinning it.
//
// The saving is not reduced much by that: two of the three callers are the ones
// running in volume.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
Deno.env.set("ANTHROPIC_API_KEY", Deno.env.get("ANTHROPIC_API_KEY") ?? "test-key");

const { getSizeEstimateModel, getPhotoQaModel, getDefaultModel, getLightweightModel } =
  await import("../lib/ai-config.ts");

// ── 1. The default is the cheap model ───────────────────────────────────────

Deno.test("the size pass defaults to the lightweight model", () => {
  const before = Deno.env.get("SIZE_ESTIMATE_AI_MODEL");
  Deno.env.delete("SIZE_ESTIMATE_AI_MODEL");
  try {
    assertEquals(getSizeEstimateModel(), getLightweightModel());
    assert(
      getSizeEstimateModel() !== getDefaultModel(),
      "if these are equal the change bought nothing - check DEFAULTS in ai-config.ts",
    );
  } finally {
    if (before) Deno.env.set("SIZE_ESTIMATE_AI_MODEL", before);
  }
});

Deno.test("an operator can override it without a deploy", () => {
  const before = Deno.env.get("SIZE_ESTIMATE_AI_MODEL");
  Deno.env.set("SIZE_ESTIMATE_AI_MODEL", "claude-sonnet-5");
  try {
    assertEquals(getSizeEstimateModel(), "claude-sonnet-5");
  } finally {
    if (before) Deno.env.set("SIZE_ESTIMATE_AI_MODEL", before);
    else Deno.env.delete("SIZE_ESTIMATE_AI_MODEL");
  }
});

Deno.test("a blank override falls back rather than sending an empty model", () => {
  const before = Deno.env.get("SIZE_ESTIMATE_AI_MODEL");
  Deno.env.set("SIZE_ESTIMATE_AI_MODEL", "   ");
  try {
    assertEquals(getSizeEstimateModel(), getLightweightModel());
  } finally {
    if (before) Deno.env.set("SIZE_ESTIMATE_AI_MODEL", before);
    else Deno.env.delete("SIZE_ESTIMATE_AI_MODEL");
  }
});

// ── 2. GRADING PINS THE FULL MODEL — the guard that matters ─────────────────
//
// A source scan, because the alternative is standing up the whole pipeline with
// a fake Anthropic client to observe one field. What it asserts is narrow and
// exact: the grading call site passes an explicit `model`, and that model is
// getDefaultModel(). If someone deletes the argument, estimateSize's cheap
// default takes over and grades start moving with no eval and no version
// suffix - which is invisible in every test that does not look here.

const pipeline = await Deno.readTextFile(
  new URL("../lib/grading-pipeline.ts", import.meta.url),
);

/**
 * The argument object of an `estimateSize({ … })` call.
 *
 * Ends at the CALL's closing `})`, found by counting braces, not at the first
 * one that appears. The first `})` inside this call belongs to
 * `.map((img) => ({ url, type }))`, so a naive indexOf cut the body off three
 * lines in and the guard passed against a fragment that could never contain the
 * thing it was looking for. A guard that reads the wrong region reports on code
 * that is not there.
 */
function argObject(text: string, from: number): string {
  const open = text.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return "";
}

Deno.test("the grading pipeline pins the size pass to the full model", () => {
  const at = pipeline.indexOf("? estimateSize({");
  assert(at >= 0, "estimateSize call site not found in grading-pipeline.ts");
  const body = argObject(pipeline, at);
  assert(body.length > 0, "could not read the estimateSize argument object");
  assertStringIncludes(
    body,
    "model: getDefaultModel()",
    "grading must pass the FULL model explicitly. Without it the size pass " +
      "falls to the cheap default and the text reaching tagGroundTruthBlock - " +
      "and therefore the grading prompt - changes with no shadow compare, no " +
      "golden-set eval and no prompt_version suffix to attribute it to.",
  );
});

Deno.test("grading-pipeline imports getDefaultModel so the pin cannot be a comment", () => {
  assert(
    /import\s*\{[^}]*\bgetDefaultModel\b[^}]*\}\s*from\s*"\.\/ai-config\.ts"/s.test(pipeline),
    "getDefaultModel must be imported for the pin above to be real code",
  );
});

// ── 3. The other two callers take the cheap default ─────────────────────────

for (
  const [label, path] of [
    ["AutoLister", "../lib/ai-listing.ts"],
    ["the FlipDesk route", "../routes/flipdesk-ai.ts"],
  ] as const
) {
  Deno.test(`${label} leaves the size pass on its cheap default`, async () => {
    const text = await Deno.readTextFile(new URL(path, import.meta.url));
    const idx = text.indexOf("estimateSize({");
    assert(idx >= 0, `estimateSize call site not found in ${path}`);
    const body = argObject(text, idx);
    assert(body.length > 0, `could not read the estimateSize argument object in ${path}`);
    assert(
      !body.includes("model:"),
      `${label} passes an explicit model. That is allowed, but it opts out of ` +
        `the cost saving this story is for - if it is deliberate, say why here.`,
    );
  });
}

// ── 4. Photo QA, the second-most-expensive action ───────────────────────────
//
// $11.33 over 209 calls on production. AutoLister spends one action per item AND
// one per cover photo, so a 20-item batch can spend 40 here alone.
//
// Unlike the size pass this has ONE caller, so there is no pin to protect. What
// there is instead is a gate: auto-publish-green.ts publishes a draft to a live
// marketplace with no human look once the score reaches AUTO_PUBLISH_QA_MIN, and
// that floor was calibrated against full-model scores. The last test pins the
// two together so nobody edits one believing the other is unrelated.

Deno.test("photo QA defaults to the lightweight model", () => {
  const before = Deno.env.get("PHOTO_QA_AI_MODEL");
  Deno.env.delete("PHOTO_QA_AI_MODEL");
  try {
    assertEquals(getPhotoQaModel(), getLightweightModel());
    assert(getPhotoQaModel() !== getDefaultModel());
  } finally {
    if (before) Deno.env.set("PHOTO_QA_AI_MODEL", before);
  }
});

Deno.test("photo QA can be rolled back to the full model without a deploy", () => {
  const before = Deno.env.get("PHOTO_QA_AI_MODEL");
  Deno.env.set("PHOTO_QA_AI_MODEL", "claude-sonnet-5");
  try {
    assertEquals(getPhotoQaModel(), "claude-sonnet-5");
  } finally {
    if (before) Deno.env.set("PHOTO_QA_AI_MODEL", before);
    else Deno.env.delete("PHOTO_QA_AI_MODEL");
  }
});

Deno.test("its two knobs are SEPARATE, so one rollback does not move the other", () => {
  const bq = Deno.env.get("PHOTO_QA_AI_MODEL");
  const bs = Deno.env.get("SIZE_ESTIMATE_AI_MODEL");
  Deno.env.set("PHOTO_QA_AI_MODEL", "claude-sonnet-5");
  Deno.env.delete("SIZE_ESTIMATE_AI_MODEL");
  try {
    assertEquals(getPhotoQaModel(), "claude-sonnet-5");
    assertEquals(
      getSizeEstimateModel(),
      getLightweightModel(),
      "rolling photo QA back must not drag the size pass with it - that is the " +
        "whole reason these are two env vars and not one",
    );
  } finally {
    if (bq) Deno.env.set("PHOTO_QA_AI_MODEL", bq);
    else Deno.env.delete("PHOTO_QA_AI_MODEL");
    if (bs) Deno.env.set("SIZE_ESTIMATE_AI_MODEL", bs);
  }
});

Deno.test("the auto-publish floor is documented as calibrated on the OLD model", async () => {
  const cfg = await Deno.readTextFile(new URL("../lib/ai-config.ts", import.meta.url));
  const at = cfg.indexOf("export function getPhotoQaModel");
  const doc = cfg.slice(Math.max(0, at - 1400), at);
  assertStringIncludes(
    doc,
    "AUTO_PUBLISH_QA_MIN",
    "getPhotoQaModel's comment must name the gate its score feeds. A score that " +
      "auto-publishes to a live marketplace is not a display value, and the next " +
      "person to change this model needs to see that from here.",
  );
});

Deno.test("the auto-publish floor still exists to be re-checked", async () => {
  const green = await Deno.readTextFile(
    new URL("../lib/auto-publish-green.ts", import.meta.url),
  );
  assertStringIncludes(
    green,
    "AUTO_PUBLISH_QA_MIN",
    "if this constant is renamed, the comment on getPhotoQaModel now points at " +
      "nothing and the calibration warning quietly stops being findable",
  );
});
