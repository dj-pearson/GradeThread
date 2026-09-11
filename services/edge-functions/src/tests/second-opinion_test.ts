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

// The model the primary composite resolved to. US-3359 made this a required
// argument to resolveSecondOpinionConfig, so every call below names one.
const PRIMARY = "claude-sonnet-5";
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
  const { config } = resolveSecondOpinionConfig(undefined, PRIMARY);
  assertEquals(config.enabled, false);
});

Deno.test("US-2279: a non-allowlisted second model DISABLES the pass, it does not fall back", () => {
  // The load-bearing refusal. Falling back to the default model would grade
  // twice with ONE model and report agreement — manufacturing the evidence the
  // feature exists to gather, which is worse than not running at all.
  const { config, refusal } = resolveSecondOpinionConfig({
    enabled: true,
    model: "gpt-not-a-real-grading-model",
  }, PRIMARY);
  assertEquals(config.enabled, false);
  assert(refusal !== null);
  assertStringIncludes(refusal, "not on the grading allowlist");
  assertStringIncludes(refusal, "rather than run against the primary model");
});

Deno.test("US-2279: an allowlisted model is accepted", () => {
  const { config, refusal } = resolveSecondOpinionConfig({
    enabled: true,
    model: "claude-opus-4-8",
  }, PRIMARY);
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
    }, PRIMARY);
    assertEquals(config.enabled, false, `${JSON.stringify(bad)} should disable`);
    assert(refusal !== null, `${JSON.stringify(bad)} should explain itself`);
  }
});

// ── The primary-model collision (US-3359) ───────────────────────────────────
//
// The allowlist answers "safe to grade with". It does NOT answer "different from
// the model that just graded this", and the primary model is on it. Before this,
// an operator who typed the primary id into the settings row got a grade report
// saying two models agreed, produced by one model.

Deno.test("US-3359: the PRIMARY model is refused as the second opinion, allowlist or not", () => {
  const { config, refusal } = resolveSecondOpinionConfig({
    enabled: true,
    model: "claude-opus-4-8",
  }, "claude-opus-4-8");
  assertEquals(config.enabled, false, "one model grading twice is not a second opinion");
  assert(refusal !== null, "a refusal must be reported, not swallowed");
  assertStringIncludes(refusal, "the model the primary grade ran on");
  assertStringIncludes(refusal, "report the result as agreement");
});

Deno.test("US-3359: the same model under a different case or with padding is still the same model", () => {
  // The settings row is hand-typed JSON. "Claude-Opus-4-8 " must not sneak past
  // a === comparison and buy a second opinion from the first model.
  for (const typed of [" claude-opus-4-8", "claude-opus-4-8 ", "  claude-opus-4-8  "]) {
    const { config } = resolveSecondOpinionConfig({ enabled: true, model: typed }, "claude-opus-4-8");
    assertEquals(config.enabled, false, `"${typed}" should be refused as the primary`);
  }
  const { config: cased } = resolveSecondOpinionConfig(
    { enabled: true, model: "claude-opus-4-8" },
    "CLAUDE-OPUS-4-8",
  );
  assertEquals(cased.enabled, false, "a differently-cased primary is still the primary");
});

Deno.test("US-3359: an env override that moves the PRIMARY onto the configured second model disables the pass", () => {
  // The whole reason this argument exists. GRADING_COMPOSITE_MODEL, the US-1066
  // cascade's cheap first pass and the escalation to the stronger model all move
  // the primary at runtime, so a pure function with only a code default could
  // never see this coming. The settings row never changed; the primary did.
  const row = { enabled: true, model: "claude-opus-4-8" };
  assertEquals(resolveSecondOpinionConfig(row, "claude-sonnet-5").config.enabled, true);
  assertEquals(resolveSecondOpinionConfig(row, "claude-opus-4-8").config.enabled, false);
});

Deno.test("US-3359: an UNKNOWN primary disables the pass rather than running blind", () => {
  // Running without knowing what produced the first grade is the same
  // manufactured-evidence risk wearing a different hat, and not running is
  // always the safe failure for an additive check.
  for (const unknown of ["", "   "]) {
    const { config, refusal } = resolveSecondOpinionConfig(
      { enabled: true, model: "claude-opus-4-8" },
      unknown,
    );
    assertEquals(config.enabled, false);
    assert(refusal !== null);
    assertStringIncludes(refusal, "without knowing which model produced the primary grade");
  }
});

Deno.test("US-3359: a DISABLED row still short-circuits, so an unknown primary costs nothing", () => {
  // The disabled path returns before any of the checks above. That is what keeps
  // the off state byte-identical for every submission.
  const { config, refusal } = resolveSecondOpinionConfig({ enabled: false }, "");
  assertEquals(config.enabled, false);
  assertEquals(refusal, null, "an off feature has nothing to refuse");
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
  // US-3366: the call moved into `secondOpinionComposite`, which is where every
  // argument it hands compositeGrade is now written out with its reason. The
  // guard is unchanged in meaning: the second composite must sit INSIDE the
  // trigger branch, and only the callee's name moved.
  const callAt = block.indexOf("await secondOpinionComposite(");
  assert(
    callAt > guardAt,
    "the second composite is called before or outside the trigger guard",
  );
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

Deno.test("US-3359 WIRING: the RESOLVED primary model is handed to the resolver", () => {
  // Not getGradingCompositeModel() and not a code default: compositeResult.model
  // is the id the composite that produced THESE scores actually ran on, after
  // any env override, cascade first pass or escalation. Passing anything else
  // reopens the hole while looking correct.
  const call = PIPELINE_CODE.match(/resolveSecondOpinionConfig\([\s\S]*?\n\s*\);/)?.[0];
  assert(call, "the resolveSecondOpinionConfig call was not found in grading-pipeline.ts");
  assertStringIncludes(call, "compositeResult.model");
});
