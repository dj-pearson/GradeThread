// US-3184: the four cases of the operator model guard, and the resolver that
// catches a Coolify reference that never expanded.

// US-2379: first, before anything that reaches lib/supabase.ts at import time.
import "./_env.ts";

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  checkModelDrift,
  isLocalSupabaseHost,
} from "../lib/operator-model-guard.ts";
import {
  CODE_DEFAULT_MODEL,
  CURRENT_MODEL_IDS,
  getDefaultModel,
  getLightweightModel,
  getPhotoQaModel,
  getSizeEstimateModel,
  isUnexpandedTemplate,
  MODEL_TIER_RESOLVERS,
  MODEL_TIERS,
  resetModelVarWarningsForTests,
  resetOperatorModelTiersForTests,
  resolveOperatorModels,
} from "../lib/ai-config.ts";

const PROD = "https://api.gradethread.com";
const LOCAL = "http://127.0.0.1:54321";

function withEnv(name: string, value: string | null, fn: () => void) {
  const prior = Deno.env.get(name);
  resetModelVarWarningsForTests();
  try {
    if (value === null) Deno.env.delete(name);
    else Deno.env.set(name, value);
    fn();
  } finally {
    resetModelVarWarningsForTests();
    if (prior === undefined) Deno.env.delete(name);
    else Deno.env.set(name, prior);
  }
}

Deno.test("same model as the deployed default: proceed, quietly", () => {
  const v = checkModelDrift({
    supabaseUrl: PROD,
    resolvedModel: "claude-sonnet-5",
    expectedModel: "claude-sonnet-5",
  });
  assert(v.ok);
  assertEquals(v.refusal, undefined);
  // The banner prints on EVERY run, not only on drift. A script that speaks up
  // only when something is wrong teaches nobody what normal looks like.
  assertStringIncludes(v.banner, "api.gradethread.com");
  assertStringIncludes(v.banner, "claude-sonnet-5");
});

Deno.test("drifted model against prod: refuse", () => {
  // This is 2026-09-02 exactly: a dev .env pinning the pre-2026-07 default,
  // pointed at production, writing grading ground truth.
  const v = checkModelDrift({
    supabaseUrl: PROD,
    resolvedModel: "claude-sonnet-4-6",
    expectedModel: "claude-sonnet-5",
  });
  assertEquals(v.ok, false);
  assertStringIncludes(v.refusal!, "claude-sonnet-4-6");
  assertStringIncludes(v.refusal!, "claude-sonnet-5");
  assertStringIncludes(v.refusal!, "--allow-model-drift");
  assertStringIncludes(v.banner, "expected claude-sonnet-5");
});

Deno.test("drifted model against a local stack: proceed", () => {
  // Reproducing an old result on an old model is legitimate work. The guard is
  // on the PAIR (prod, drift), not on either half.
  for (const url of [LOCAL, "http://localhost:54321", "http://host.docker.internal:54321"]) {
    const v = checkModelDrift({
      supabaseUrl: url,
      resolvedModel: "claude-sonnet-4-6",
      expectedModel: "claude-sonnet-5",
    });
    assert(v.ok, `${url} should be treated as local`);
    assertEquals(v.refusal, undefined);
  }
});

Deno.test("--allow-model-drift overrides, and says so in the banner", () => {
  const v = checkModelDrift({
    supabaseUrl: PROD,
    resolvedModel: "claude-sonnet-4-6",
    expectedModel: "claude-sonnet-5",
    allowDrift: true,
  });
  assert(v.ok);
  assertStringIncludes(v.banner, "--allow-model-drift");
});

Deno.test("an unparseable SUPABASE_URL fails closed, not open", () => {
  // "not a URL" is not evidence of a local stack, and guessing local would let
  // the exact failure this guard exists for through on a typo.
  assertEquals(isLocalSupabaseHost("not a url"), false);
  const v = checkModelDrift({
    supabaseUrl: "not a url",
    resolvedModel: "claude-sonnet-4-6",
    expectedModel: "claude-sonnet-5",
  });
  assertEquals(v.ok, false);
});

Deno.test("an unexpanded team reference never reaches the API as a model", () => {
  // If Coolify passes the reference text through, sending it would 404 every
  // call with an error that never mentions Coolify. The code default is a
  // working model; the template string is not.
  assert(isUnexpandedTemplate("{{team.DEFAULT_AI_MODEL}}"));
  assert(isUnexpandedTemplate("${DEFAULT_AI_MODEL}"));
  assert(!isUnexpandedTemplate("claude-sonnet-5"));

  withEnv("DEFAULT_AI_MODEL", "{{team.DEFAULT_AI_MODEL}}", () => {
    assertEquals(getDefaultModel(), CODE_DEFAULT_MODEL);
  });
  withEnv("LIGHTWEIGHT_AI_MODEL", "{{team.LIGHTWEIGHT_AI_MODEL}}", () => {
    assert(getLightweightModel().startsWith("claude-haiku"));
  });
});

Deno.test("a real value is honoured, expected or not", () => {
  // The resolver warns on an unfamiliar id but does not override it: a model
  // newer than this build is legitimate, and refusing it would make every
  // model launch a code change.
  withEnv("DEFAULT_AI_MODEL", "claude-sonnet-5", () => {
    assertEquals(getDefaultModel(), "claude-sonnet-5");
  });
  withEnv("DEFAULT_AI_MODEL", "claude-something-6", () => {
    assertEquals(getDefaultModel(), "claude-something-6");
  });
  withEnv("DEFAULT_AI_MODEL", null, () => {
    assertEquals(getDefaultModel(), CODE_DEFAULT_MODEL);
  });
});

Deno.test("the code default is itself a current id", () => {
  // Guard-the-guard. Everything above compares against CODE_DEFAULT_MODEL, so
  // if that ever goes stale the whole check quietly endorses the stale value.
  assert(
    CURRENT_MODEL_IDS.has(CODE_DEFAULT_MODEL),
    `${CODE_DEFAULT_MODEL} is the code default but is not in CURRENT_MODEL_IDS`,
  );
  assert(!CURRENT_MODEL_IDS.has("claude-sonnet-4-6"));
});

Deno.test("a script with no datastore is still guarded on drift", () => {
  // scripts/measure-eval.ts spends a vision call per garment and writes no row,
  // so there is no host and the local-stack exemption cannot apply. Its output
  // is a RELEASE GATE verdict attributed to a model, which is exactly the kind
  // of number that must not quietly come from a different one.
  const drifted = checkModelDrift({
    resolvedModel: "claude-sonnet-4-6",
    expectedModel: "claude-sonnet-5",
  });
  assertEquals(drifted.ok, false);
  assertStringIncludes(drifted.banner, "no datastore");

  const matched = checkModelDrift({
    resolvedModel: "claude-sonnet-5",
    expectedModel: "claude-sonnet-5",
  });
  assert(matched.ok);

  // And it is still overridable, because re-running an old eval on the old
  // model is a legitimate thing to want.
  const forced = checkModelDrift({
    resolvedModel: "claude-sonnet-4-6",
    expectedModel: "claude-sonnet-5",
    allowDrift: true,
  });
  assert(forced.ok);
});

// ── The tier mechanism (US-3184 follow-up) ───────────────────────────────────
//
// Everything above proves the guard says the right thing about the model it is
// SHOWN. These prove it cannot be shown the wrong set.

function armed<T>(tiers: Parameters<typeof resolveOperatorModels>[0], fn: () => T): T {
  resetOperatorModelTiersForTests();
  resetModelVarWarningsForTests();
  try {
    resolveOperatorModels(tiers);
    return fn();
  } finally {
    resetOperatorModelTiersForTests();
    resetModelVarWarningsForTests();
  }
}

Deno.test("US-3184: resolving an undeclared tier throws before it can spend", () => {
  // THE MECHANISM. A script declares "default"; the day somebody adds a
  // lightweight call to it, that call dies here rather than quietly spending on
  // whatever LIGHTWEIGHT_AI_MODEL the dev .env happens to hold - which is the
  // 2026-09-02 failure one tier over.
  const err = armed(["default"], () =>
    assertThrows(() => getLightweightModel(), Error));
  assertStringIncludes(err.message, "lightweight");
  assertStringIncludes(err.message, "LIGHTWEIGHT_AI_MODEL");
  assertStringIncludes(err.message, "resolveOperatorModels");
  // The declared tier still resolves normally - the arming is a fence, not a lock.
  assertEquals(armed(["default"], () => getDefaultModel()), CODE_DEFAULT_MODEL);
});

Deno.test("US-3184: a nested fallback is not mistaken for an undeclared tier", () => {
  // getSizeEstimateModel() falls through getLightweightModel() when its own knob
  // is unset. If the arming check fired on that inner call, declaring the tier
  // you actually use would throw - and the fix everyone would reach for is to
  // declare every tier, which is the same as declaring none.
  const model = armed(["sizeEstimate"], () => getSizeEstimateModel());
  assert(model.startsWith("claude-haiku"), model);
  // Still strict about the tier that was NOT declared.
  armed(["sizeEstimate"], () => assertThrows(() => getPhotoQaModel(), Error));
});

Deno.test("US-3184: the edge service is untouched until a script arms the check", () => {
  // declaredTiers starts null and only an operator script sets it. If this ever
  // regressed, every production request resolving a model would throw.
  resetOperatorModelTiersForTests();
  assertEquals(getDefaultModel(), CODE_DEFAULT_MODEL);
  assert(getLightweightModel().startsWith("claude-haiku"));
  assert(getPhotoQaModel().startsWith("claude-haiku"));
});

Deno.test("US-3184: a guard with nothing to check throws instead of passing", () => {
  // An empty tier list returning ok:true would be this story's own failure
  // wearing the guard's uniform: a clean banner with no model in it.
  assertThrows(() => resolveOperatorModels([]), Error);
  assertThrows(() => checkModelDrift({ supabaseUrl: PROD }), Error);
  assertThrows(() => checkModelDrift({ supabaseUrl: PROD, models: [] }), Error);
});

Deno.test("US-3184: drift on ANY declared tier refuses, and the banner names it", () => {
  const v = checkModelDrift({
    supabaseUrl: PROD,
    models: [
      { tier: "default", env: "DEFAULT_AI_MODEL", resolved: "claude-sonnet-5", expected: "claude-sonnet-5" },
      { tier: "lightweight", env: "LIGHTWEIGHT_AI_MODEL", resolved: "claude-sonnet-4-6", expected: "claude-haiku-4-5-20251001" },
    ],
  });
  assertEquals(v.ok, false);
  // Both tiers appear, so "checked and fine" is distinguishable from "not checked".
  assertStringIncludes(v.banner, "default=claude-sonnet-5");
  assertStringIncludes(v.banner, "lightweight=claude-sonnet-4-6");
  assertStringIncludes(v.refusal!, "LIGHTWEIGHT_AI_MODEL");
});

Deno.test("US-3184: MODEL_TIERS covers every model knob ai-config.ts reads", async () => {
  // THE ANTI-STALENESS RULE. A tier table that someone must remember to extend
  // is the same shape as the .env line nobody remembered to update. So the
  // source is the authority: every model-selecting env var this module reads
  // must appear in MODEL_TIERS, or the next knob ships outside the guard.
  const src = await Deno.readTextFile("src/lib/ai-config.ts");
  const read = new Set<string>();
  for (const m of src.matchAll(/Deno\.env\.get\("([A-Z0-9_]*MODEL[A-Z0-9_]*)"\)/g)) {
    read.add(m[1]!);
  }
  for (const m of src.matchAll(/resolveModelVar\("([A-Z0-9_]+)"/g)) read.add(m[1]!);

  const covered = new Set<string>(Object.values(MODEL_TIERS).map((t) => t.env));
  const missing = [...read].filter((v) => !covered.has(v));
  assertEquals(
    missing,
    [],
    `these model env vars are read by ai-config.ts but are not in MODEL_TIERS, ` +
      `so an operator script can spend on them with no banner and no drift ` +
      `check: ${missing.join(", ")}`,
  );
  assert(read.size >= 7, `only found ${read.size} model env reads - regex rotted`);

  // And every tier's named resolver is really exported under that name.
  for (const [tier, fn] of Object.entries(MODEL_TIER_RESOLVERS)) {
    assert(
      src.includes(`export function ${fn}(`),
      `MODEL_TIER_RESOLVERS.${tier} names ${fn}(), which ai-config.ts does not export`,
    );
  }
});
