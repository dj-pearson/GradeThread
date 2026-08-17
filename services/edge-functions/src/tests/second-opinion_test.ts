// US-2279: the selective second-opinion pass — trigger, refusal, disagreement.
//
// Everything here is pure. The expensive half (actually re-running the composite
// under a second model) is the pipeline's job; what decides WHETHER to spend and
// WHAT the answer means is decided here, and that is the half worth pinning.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  DEFAULT_SECOND_OPINION_CONFIG,
  SECOND_OPINION_DISAGREE_CAP,
  evaluateSecondOpinion,
  resolveSecondOpinionConfig,
  shouldSeekSecondOpinion,
} = await import("../lib/second-opinion.ts");

const ON = { ...DEFAULT_SECOND_OPINION_CONFIG, enabled: true };
const base = {
  confidence: 0.8,
  itemValue: null as number | null,
  alreadyNeedsReview: false,
};

// ── Config resolution ───────────────────────────────────────────────────────

Deno.test("US-2279: the feature is OFF by default", () => {
  // An additive stage that spends money must not start spending because a
  // deploy shipped. Turning it on is a settings row, deliberately.
  assertEquals(DEFAULT_SECOND_OPINION_CONFIG.enabled, false);
  const { config } = resolveSecondOpinionConfig(undefined);
  assertEquals(config.enabled, false);
});

Deno.test("US-2279: a non-allowlisted second model DISABLES the pass, it does not fall back", () => {
  // The load-bearing refusal. Falling back to the default model would grade
  // twice with ONE model and report agreement — manufacturing the evidence the
  // feature exists to gather, which is worse than not running at all.
  const { config, refusal } = resolveSecondOpinionConfig({
    enabled: true,
    model: "gpt-not-a-real-grading-model",
  });
  assertEquals(config.enabled, false);
  assert(refusal !== null);
  assertStringIncludes(refusal, "not on the grading allowlist");
  assertStringIncludes(refusal, "rather than run against the primary model");
});

Deno.test("US-2279: an allowlisted model is accepted", () => {
  const { config, refusal } = resolveSecondOpinionConfig({
    enabled: true,
    model: "claude-opus-4-8",
  });
  assertEquals(refusal, null);
  assertEquals(config.enabled, true);
  assertEquals(config.model, "claude-opus-4-8");
});

Deno.test("US-2279: an unusable band or epsilon disables rather than half-runs", () => {
  for (
    const bad of [
      { bandMin: 0.9, bandMax: 0.5 },
      { bandMin: -1, bandMax: 0.5 },
      { bandMin: 0.5, bandMax: 2 },
      { epsilon: 0 },
      { epsilon: -0.5 },
    ]
  ) {
    const { config, refusal } = resolveSecondOpinionConfig({
      enabled: true,
      model: "claude-opus-4-8",
      ...bad,
    });
    assertEquals(config.enabled, false, `${JSON.stringify(bad)} should disable`);
    assert(refusal !== null, `${JSON.stringify(bad)} should explain itself`);
  }
});

// ── Trigger ─────────────────────────────────────────────────────────────────

Deno.test("US-2279: a grade already going to a human is NOT re-read", () => {
  // Spending a second model call to discover a grade should go to a human, when
  // it is already going to a human, changes nothing and costs money.
  const d = shouldSeekSecondOpinion({ ...base, alreadyNeedsReview: true }, ON);
  assertEquals(d.trigger, false);
  assertStringIncludes(d.reason, "already routed");
});

Deno.test("US-2279: the band sits ABOVE the review threshold, not across it", () => {
  // Below 0.75 a human already sees it; well above it there is nothing
  // borderline to check. Only the band in between is worth paying for.
  assertEquals(shouldSeekSecondOpinion({ ...base, confidence: 0.74 }, ON).trigger, false);
  assertEquals(shouldSeekSecondOpinion({ ...base, confidence: 0.75 }, ON).trigger, true);
  assertEquals(shouldSeekSecondOpinion({ ...base, confidence: 0.84 }, ON).trigger, true);
  // bandMax is EXCLUSIVE — 0.85 is confident enough to ship.
  assertEquals(shouldSeekSecondOpinion({ ...base, confidence: 0.85 }, ON).trigger, false);
  assertEquals(shouldSeekSecondOpinion({ ...base, confidence: 0.99 }, ON).trigger, false);
});

Deno.test("US-2279: high value triggers outside the band, and only when a value exists", () => {
  const cfg = { ...ON, highValueMin: 400 };
  // Confident grade, expensive item → still worth a second read.
  const rich = shouldSeekSecondOpinion({ ...base, confidence: 0.97, itemValue: 900 }, cfg);
  assertEquals(rich.trigger, true);
  assertStringIncludes(rich.reason, "high value");
  // Same confidence, cheap item → not worth it.
  assertEquals(
    shouldSeekSecondOpinion({ ...base, confidence: 0.97, itemValue: 20 }, cfg).trigger,
    false,
  );
  // NO value signal must never read as high value. Today the pipeline has no
  // value column on submissions, so null is the common case, and a null that
  // triggered would put every confident grade through a second model.
  assertEquals(
    shouldSeekSecondOpinion({ ...base, confidence: 0.97, itemValue: null }, cfg).trigger,
    false,
  );
});

Deno.test("US-2279: the hourly ceiling degrades to no-second-opinion, not to unbounded spend", () => {
  const cfg = { ...ON, maxPerHour: 5 };
  assertEquals(
    shouldSeekSecondOpinion({ ...base, confidence: 0.8, triggersThisHour: 4 }, cfg).trigger,
    true,
  );
  const capped = shouldSeekSecondOpinion(
    { ...base, confidence: 0.8, triggersThisHour: 5 },
    cfg,
  );
  assertEquals(capped.trigger, false);
  assertStringIncludes(capped.reason, "hourly ceiling");
});

Deno.test("US-2279: every decision carries a reason, including the negatives", () => {
  // A spend line that cannot be explained is a spend line nobody can audit, and
  // a SKIP that cannot be explained is worse — it looks like the feature is off.
  for (
    const input of [
      { ...base, confidence: 0.5 },
      { ...base, confidence: 0.8 },
      { ...base, alreadyNeedsReview: true },
    ]
  ) {
    const d = shouldSeekSecondOpinion(input, ON);
    assert(d.reason.length > 0, `no reason for ${JSON.stringify(input)}`);
  }
  assertEquals(shouldSeekSecondOpinion(base, DEFAULT_SECOND_OPINION_CONFIG).reason, "disabled");
});

// ── Disagreement ────────────────────────────────────────────────────────────

Deno.test("US-2279: agreement within epsilon confirms, and is RECORDED", () => {
  const v = evaluateSecondOpinion(7.4, 7.2, ON);
  assertEquals(v.disagree, false);
  assertEquals(v.delta, 0.2);
  assertEquals(v.confidenceCap, null, "a null cap makes composeConfidenceCap a no-op");
  assertEquals(v.needsHumanReview, false);
  // Without this line a reader cannot tell "the second model agreed" from "the
  // second model never ran", which are the two states this feature separates.
  assertStringIncludes(v.note, "agreement within");
  assertStringIncludes(v.note, "claude-opus-4-8");
});

Deno.test("US-2279: epsilon EXACTLY is agreement, not disagreement", () => {
  // The threshold is the tolerance. A delta equal to it is what we said we would
  // tolerate; making it disagreement would move the real threshold below the
  // configured one.
  assertEquals(evaluateSecondOpinion(8.0, 7.5, ON).disagree, false);
  assertEquals(evaluateSecondOpinion(8.0, 7.4, ON).disagree, true);
});

Deno.test("US-2279: disagreement caps BELOW the review threshold and routes", () => {
  const v = evaluateSecondOpinion(8.0, 6.5, ON);
  assertEquals(v.disagree, true);
  assertEquals(v.delta, 1.5);
  assertEquals(v.needsHumanReview, true);
  assertEquals(v.confidenceCap, SECOND_OPINION_DISAGREE_CAP);
  // Below 0.75, not equal to it: equality would leave the routing decision
  // resting on a floating-point comparison.
  assert(
    SECOND_OPINION_DISAGREE_CAP < 0.75,
    "the cap must land under the review threshold, not on it",
  );
  assertStringIncludes(v.note, "routed for human review");
});

Deno.test("US-2279: the delta rounds to a tenth like every other grade number", () => {
  // 8.0 - 7.9 is 0.10000000000000053 in IEEE754, and 7.3 - 6.9 is
  // 0.40000000000000036. A raw delta would carry that into the note and, worse,
  // into an epsilon comparison.
  assertEquals(evaluateSecondOpinion(8.0, 7.9, ON).delta, 0.1);
  assertEquals(evaluateSecondOpinion(7.3, 6.9, ON).delta, 0.4);
  assertEquals(evaluateSecondOpinion(6.9, 7.3, ON).delta, 0.4, "order must not matter");
  // Half-way rounds UP, matching roundToTenth everywhere else in the engine.
  assertEquals(evaluateSecondOpinion(8.0, 7.35, ON).delta, 0.7);
});

Deno.test("US-2279: a custom epsilon is honoured in both directions", () => {
  const strict = { ...ON, epsilon: 0.2 };
  assertEquals(evaluateSecondOpinion(8.0, 7.7, strict).disagree, true);
  const loose = { ...ON, epsilon: 1.5 };
  assertEquals(evaluateSecondOpinion(8.0, 6.7, loose).disagree, false);
});

// ── Wiring ──────────────────────────────────────────────────────────────────
//
// The pure logic above is worthless if the pipeline calls it wrong, and three of
// the ways it could be called wrong compile cleanly and pass every test above.
// Source-scanned, comments stripped, so a header describing a call that is not
// made cannot satisfy any of it.

const PIPELINE = await Deno.readTextFile("src/lib/grading-pipeline.ts");
const PIPELINE_CODE = PIPELINE
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

Deno.test("US-2279 WIRING: the second composite runs ONLY under decision.trigger", () => {
  // Without the guard the pass runs on every grade and doubles composite spend
  // silently — nothing would fail, the bill would just grow.
  const block = PIPELINE_CODE.match(
    /const decision = shouldSeekSecondOpinion\([\s\S]*?\n\s+\} catch/,
  )?.[0];
  assert(block, "the second-opinion block was not found in grading-pipeline.ts");
  assertStringIncludes(block, "if (decision.trigger)");
  const guardAt = block.indexOf("if (decision.trigger)");
  const callAt = block.indexOf("await compositeGrade(");
  assert(callAt > guardAt, "compositeGrade is called before or outside the trigger guard");
});

Deno.test("US-2279 WIRING: the cap lowers the CEILING too, not just the value", () => {
  // US-2299, and this exact half has shipped missing four times. Lowering
  // confidence without lowering confidenceCeiling is invisible: the review gate
  // still fires so the grade looks handled, while the next provenance boost
  // lifts the STORED number back over the cap — and the stored number is what
  // the public label and the calibration miner read.
  const block = PIPELINE_CODE.match(
    /if \(verdict\.disagree\)[\s\S]*?needs_human_review = true;/,
  )?.[0];
  assert(block, "the disagreement branch was not found");
  assertStringIncludes(block, "composeConfidenceCap(");
  assertStringIncludes(block, "confidenceCeiling = Math.min(");
});

Deno.test("US-2279 WIRING: it runs AFTER peer-norm, so an already-routed grade is not paid for", () => {
  // shouldSeekSecondOpinion skips anything already going to a human. Running
  // before peer-norm would pay a model call to reach a conclusion the next block
  // reaches for free.
  const peerAt = PIPELINE_CODE.indexOf("evaluatePeerNorm(");
  const secondAt = PIPELINE_CODE.indexOf("shouldSeekSecondOpinion(");
  assert(peerAt > 0 && secondAt > 0, "one of the two blocks is missing");
  assert(
    secondAt > peerAt,
    "the second-opinion block moved above peer-norm; it would now pay for grades peer-norm was about to route anyway",
  );
});

Deno.test("US-2279 WIRING: the config comes from settings and defaults to a disabled pass", () => {
  assertStringIncludes(PIPELINE_CODE, 'getSetting<Partial<SecondOpinionConfig>>("grading_second_opinion"');
  assertStringIncludes(PIPELINE_CODE, "resolveSecondOpinionConfig(");
  // A refusal must be audible. An operator who turned this on and got silence
  // would reasonably conclude it was running.
  assertStringIncludes(PIPELINE_CODE, "second opinion refused:");
});
