// US-3184: the four cases of the operator model guard, and the resolver that
// catches a Coolify reference that never expanded.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkModelDrift,
  isLocalSupabaseHost,
} from "../lib/operator-model-guard.ts";
import {
  CODE_DEFAULT_MODEL,
  CURRENT_MODEL_IDS,
  getDefaultModel,
  getLightweightModel,
  isUnexpandedTemplate,
  resetModelVarWarningsForTests,
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
