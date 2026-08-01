// Unit tests for the staged-rollout / canary bucketing logic (US-896).
//
// The selection logic is pure, but canary-rollout.ts -> feature-flags.ts ->
// supabase.ts imports the service-role client at load, so set dummy env BEFORE
// the dynamic import (mirrors calibration_test.ts).
//
//   deno test --allow-env src/tests/canary-rollout_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  canaryBucket,
  pickPromptForBucket,
  resolveSlotFromRows,
  shouldUseCanary,
} = await import("../lib/canary-rollout.ts");

const ACTIVE = { text: "ACTIVE TEXT", versionName: "composite_v4" };
const CANDIDATE = { text: "CANDIDATE TEXT", versionName: "composite_v5" };

function slot(rolloutPercentage: number) {
  return {
    active: ACTIVE,
    canary: { prompt: CANDIDATE, rolloutPercentage },
  };
}

Deno.test("0% canary is never used", () => {
  const s = slot(0);
  for (let i = 0; i < 200; i++) {
    assertEquals(shouldUseCanary(s, "composite:", `sub-${i}`), false);
    assertEquals(pickPromptForBucket(s, "composite:", `sub-${i}`).versionName, "composite_v4");
  }
});

Deno.test("100% canary is always used (with a bucket key)", () => {
  const s = slot(100);
  for (let i = 0; i < 200; i++) {
    assertEquals(shouldUseCanary(s, "composite:", `sub-${i}`), true);
    assertEquals(pickPromptForBucket(s, "composite:", `sub-${i}`).versionName, "composite_v5");
  }
});

Deno.test("no canary configured => always active", () => {
  const s = { active: ACTIVE, canary: null };
  assertEquals(shouldUseCanary(s, "composite:", "sub-1"), false);
  assertEquals(pickPromptForBucket(s, "composite:", "sub-1").versionName, "composite_v4");
});

Deno.test("missing bucket key (eval / dry-run / quick-grade) never canaries", () => {
  // Even a 100% canary must not affect non-submission paths.
  assertEquals(shouldUseCanary(slot(100), "composite:", undefined), false);
  assertEquals(pickPromptForBucket(slot(50), "composite:", undefined).versionName, "composite_v4");
});

Deno.test("bucketing is stable for the same (slot, submission)", () => {
  const a = canaryBucket("composite:", "sub-abc");
  const b = canaryBucket("composite:", "sub-abc");
  assertEquals(a, b);
  assert(a >= 0 && a < 100);
  // Same selection across repeated calls.
  const s = slot(40);
  const first = shouldUseCanary(s, "composite:", "sub-abc");
  for (let i = 0; i < 50; i++) {
    assertEquals(shouldUseCanary(s, "composite:", "sub-abc"), first);
  }
});

Deno.test("different slots bucket a submission independently", () => {
  // The same submission can land in different buckets per slot key — so a
  // composite canary and a per-image canary are independent.
  const subs = Array.from({ length: 500 }, (_, i) => `sub-${i}`);
  const diverged = subs.some(
    (id) => canaryBucket("composite:", id) !== canaryBucket("per_image:", id),
  );
  assert(diverged, "expected at least one submission to bucket differently per slot");
});

Deno.test("rollout % routes roughly the configured share of traffic", () => {
  const s = slot(30);
  const N = 5000;
  let hit = 0;
  for (let i = 0; i < N; i++) {
    if (shouldUseCanary(s, "composite:", `sub-${i}`)) hit++;
  }
  const share = hit / N;
  // Hash distribution: expect ~0.30, allow generous slack for a 32-bit FNV-1a.
  assert(share > 0.24 && share < 0.36, `share ${share} not near 0.30`);
});

Deno.test("resolveSlotFromRows: scope preference + empty-text falls back to code default", () => {
  const code = { text: "CODE DEFAULT", versionName: "composite_v4" };
  const rows = [
    // Global active with its own text.
    {
      version_name: "global_active",
      prompt_text: "GLOBAL ACTIVE",
      garment_scope: null,
      is_active: true,
      is_canary: false,
      rollout_percentage: 0,
    },
    // Scoped active with EMPTY text => use code-default text, scoped version name.
    {
      version_name: "jeans_active",
      prompt_text: "",
      garment_scope: "jeans",
      is_active: true,
      is_canary: false,
      rollout_percentage: 0,
    },
    // Global canary at 20%.
    {
      version_name: "global_canary",
      prompt_text: "GLOBAL CANARY",
      garment_scope: null,
      is_active: false,
      is_canary: true,
      rollout_percentage: 20,
    },
  ];

  const jeans = resolveSlotFromRows(rows, "jeans", code);
  assertEquals(jeans.active.versionName, "jeans_active");
  assertEquals(jeans.active.text, "CODE DEFAULT"); // empty prompt_text -> code default
  assertEquals(jeans.canary?.prompt.versionName, "global_canary");
  assertEquals(jeans.canary?.rolloutPercentage, 20);

  const other = resolveSlotFromRows(rows, "dresses", code);
  assertEquals(other.active.versionName, "global_active"); // no dresses scope -> global
  assertEquals(other.active.text, "GLOBAL ACTIVE");
});

Deno.test("resolveSlotFromRows: a 0% or promoted canary is not routed to", () => {
  const code = { text: "CODE", versionName: "composite_v4" };
  // rollout 0 -> ignored.
  const zero = resolveSlotFromRows(
    [{
      version_name: "c",
      prompt_text: "C",
      garment_scope: null,
      is_active: false,
      is_canary: true,
      rollout_percentage: 0,
    }],
    null,
    code,
  );
  assertEquals(zero.canary, null);

  // A row that is BOTH is_active and is_canary (promoted) must not be a canary.
  const promoted = resolveSlotFromRows(
    [{
      version_name: "c",
      prompt_text: "C",
      garment_scope: null,
      is_active: true,
      is_canary: true,
      rollout_percentage: 50,
    }],
    null,
    code,
  );
  assertEquals(promoted.canary, null);
  assertEquals(promoted.active.versionName, "c");
});

// ── US-2300 [P1]: a canary is a smaller audience, not a lower bar ───────────
//
// The canary route selected `id, stage, garment_scope, is_active, is_canary,
// eval_passed` and tested only `eval_passed`. `qualified_model` was never even
// SELECTED — so the US-2036 check could not have run there even if someone had
// written it.
//
// activatePromptVersion carried the full check, so the hole was invisible from
// the place people looked: the champion path was correct, and the canary path
// serves real traffic to paying customers. A prompt qualified on model A could
// take a live slice while DEFAULT_AI_MODEL was model B, producing sold grades
// from a model that never cleared the MAE/agreement thresholds.
//
// The fix is one shared gate rather than a second copy of the check, because a
// second copy is how this happened. These pin the gate itself and the fact that
// both routes call it.

const { checkPromptServingEligibility } = await import("../lib/grading-eval.ts");

const LIVE = "claude-opus-5";

Deno.test("US-2300: a version qualified on the live model may serve", () => {
  assertEquals(
    checkPromptServingEligibility({ eval_passed: true, qualified_model: LIVE }, LIVE),
    { ok: true },
  );
});

Deno.test("US-2300: a version qualified on a DIFFERENT model cannot be canaried", () => {
  // The headline case, and the one the canary route could not see.
  const r = checkPromptServingEligibility(
    { eval_passed: true, qualified_model: "claude-sonnet-5" },
    LIVE,
  );
  assertEquals(r.ok, false);
  if (r.ok) return;
  // Names BOTH models, so the operator knows which way to fix it rather than
  // just that something is wrong.
  assert(r.reason.includes("claude-sonnet-5"));
  assert(r.reason.includes(LIVE));
});

Deno.test("US-2300: a missing model stamp fails CLOSED", () => {
  // An eval pass we cannot attribute to a model is not a pass we can honour.
  // Failing open here is worse than blocking a legitimate rollout: it ships
  // unproven grading to paying customers, and eval_passed still reads true.
  const r = checkPromptServingEligibility(
    { eval_passed: true, qualified_model: null },
    LIVE,
  );
  assertEquals(r.ok, false);
});

Deno.test("US-2300: the eval gate still comes first", () => {
  for (const passed of [false, null]) {
    const r = checkPromptServingEligibility(
      { eval_passed: passed, qualified_model: LIVE },
      LIVE,
    );
    assertEquals(r.ok, false);
    if (!r.ok) assert(r.reason.includes("eval gate"));
  }
});

Deno.test("US-2300: an unevaluated version reports the EVAL failure, not the model one", () => {
  // Ordering is a usability decision, not an accident: the operator's next step
  // is to run the eval, and leading with a model mismatch would send them to
  // change an env var instead.
  const r = checkPromptServingEligibility(
    { eval_passed: false, qualified_model: null },
    LIVE,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.reason.includes("eval gate"));
});

Deno.test("US-2300: BOTH serving paths call the one shared gate", () => {
  // The AC that actually prevents recurrence. Two copies of this rule is how
  // the canary path drifted; a third path (a scheduled auto-promoter, a bulk
  // tool) must not be able to write a fourth.
  const evalSrc = Deno.readTextFileSync(
    new URL("../lib/grading-eval.ts", import.meta.url),
  );
  const adminSrc = Deno.readTextFileSync(
    new URL("../routes/admin-grading.ts", import.meta.url),
  );
  assert(evalSrc.includes("export function checkPromptServingEligibility"));
  assert(
    evalSrc.includes("checkPromptServingEligibility(v, getGradingCompositeModel())"),
    "activatePromptVersion must use the shared gate",
  );
  assert(
    adminSrc.includes("checkPromptServingEligibility(v, getGradingCompositeModel())"),
    "the canary route must use the shared gate",
  );
  // And the canary route must actually READ the column it now checks.
  assert(
    adminSrc.includes("is_canary, eval_passed, qualified_model"),
    "the canary load must select qualified_model",
  );
});
