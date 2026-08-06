// US-507: feature-flag kill-switch read path — caching + fail-open semantics.
// US-886: targeting v2 — resolveFlagRule precedence + stable percentage bucketing.
// feature-flags.ts imports supabase at init, so set dummy env before importing
// and stub supabaseAdmin's query builder via a module-level override.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  isFeatureEnabled,
  clearFeatureFlagCache,
  featureDisabledBody,
  resolveFlagRule,
  stableBucket,
} = await import("../lib/feature-flags.ts");

// A default (legacy) rule: enabled, 100%, no targeting — must behave like the
// old global kill-switch.
function rule(overrides: Partial<import("../lib/feature-flags.ts").FeatureFlagRule> = {}) {
  return {
    enabled: true,
    rollout_percentage: 100,
    plan_targets: [] as string[],
    user_allow: [] as string[],
    user_deny: [] as string[],
    starts_at: null as string | null,
    ends_at: null as string | null,
    ...overrides,
  };
}

Deno.test("featureDisabledBody has a stable FEATURE_DISABLED code", () => {
  const body = featureDisabledBody("grading");
  assertEquals(body.code, "FEATURE_DISABLED");
  assert(body.error.includes("grading"));
});

Deno.test("isFeatureEnabled fails OPEN when the DB read errors", async () => {
  // No reachable DB (dummy URL) → read throws/errors → defaults to enabled.
  clearFeatureFlagCache();
  const enabled = await isFeatureEnabled("grading");
  assertEquals(enabled, true);
});

Deno.test("isFeatureEnabled caches the result (second call is instant)", async () => {
  clearFeatureFlagCache();
  const a = await isFeatureEnabled("repricing");
  const b = await isFeatureEnabled("repricing");
  assertEquals(a, b);
});

// ── US-886 resolveFlagRule precedence ──

Deno.test("US-886: a default 100% rule resolves ON for everyone (legacy parity)", () => {
  assertEquals(resolveFlagRule("grading", rule(), {}), true);
  assertEquals(resolveFlagRule("grading", rule(), { userId: "u1", plan: "free" }), true);
});

Deno.test("US-886: global kill (enabled=false) ALWAYS wins over any targeting", () => {
  const killed = rule({
    enabled: false,
    rollout_percentage: 100,
    user_allow: ["u1"], // even an explicit allow can't override a global kill
    plan_targets: ["pro"],
  });
  assertEquals(resolveFlagRule("grading", killed, { userId: "u1", plan: "pro" }), false);
  assertEquals(resolveFlagRule("grading", killed, {}), false);
});

Deno.test("US-886: schedule window gates everyone before/after", () => {
  const now = Date.parse("2026-06-14T12:00:00Z");
  const future = rule({ starts_at: "2026-06-15T00:00:00Z" });
  assertEquals(resolveFlagRule("k", future, { now }), false); // not started yet
  const past = rule({ ends_at: "2026-06-13T00:00:00Z" });
  assertEquals(resolveFlagRule("k", past, { now }), false); // already ended
  const active = rule({ starts_at: "2026-06-13T00:00:00Z", ends_at: "2026-06-15T00:00:00Z" });
  assertEquals(resolveFlagRule("k", active, { now }), true);
});

Deno.test("US-886: deny overrides allow + percentage; allow overrides plan + percentage", () => {
  const r = rule({ rollout_percentage: 0, plan_targets: ["pro"], user_allow: ["a"], user_deny: ["d"] });
  // denied user → off even though 0% means nobody, allow not present
  assertEquals(resolveFlagRule("k", r, { userId: "d", plan: "pro" }), false);
  // allowed user → on despite 0% rollout and a non-matching plan
  assertEquals(resolveFlagRule("k", r, { userId: "a", plan: "free" }), true);
});

Deno.test("US-886: plan targeting matches the supplied plan", () => {
  const r = rule({ plan_targets: ["pro", "business"] });
  assertEquals(resolveFlagRule("k", r, { userId: "u", plan: "free" }), false);
  assertEquals(resolveFlagRule("k", r, { userId: "u", plan: "pro" }), true);
  // US-2406: no plan supplied → FAIL CLOSED. This assertion used to read
  // `true` — "plan targeting is skipped (kill-switch caller unchanged)" — and
  // it was the bug written down as a passing test: production never supplied a
  // plan, so every plan-targeted rule took this branch and served everyone.
  assertEquals(resolveFlagRule("k", r, { userId: "u" }), false);
  assertEquals(resolveFlagRule("k", r, {}), false);
  // An untargeted rule is untouched by the change.
  assertEquals(resolveFlagRule("k", rule(), { userId: "u" }), true);
});

Deno.test("US-886: percentage rollout is deterministic + stable per user", () => {
  const r = rule({ rollout_percentage: 50 });
  // Same user resolves the same way across calls.
  const first = resolveFlagRule("k", r, { userId: "user-xyz" });
  const second = resolveFlagRule("k", r, { userId: "user-xyz" });
  assertEquals(first, second);
  // A no-userId caller can't be bucketed → treated as on (legacy behaviour).
  assertEquals(resolveFlagRule("k", r, {}), true);
  // 0% → off for a bucketed user; 100% → on.
  assertEquals(resolveFlagRule("k", rule({ rollout_percentage: 0 }), { userId: "x" }), false);
  assertEquals(resolveFlagRule("k", rule({ rollout_percentage: 100 }), { userId: "x" }), true);
});

Deno.test("US-886: stableBucket is in range and deterministic", () => {
  for (const s of ["a", "grading:user-1", "x:y:z"]) {
    const b = stableBucket(s);
    assert(b >= 0 && b < 100);
    assertEquals(b, stableBucket(s));
  }
  // A higher percentage is a superset: anyone in at P% is in at any P' > P.
  let onAt10 = 0, onAt90 = 0, monotonic = true;
  for (let i = 0; i < 500; i++) {
    const bucket = stableBucket(`grading:u${i}`);
    const at10 = bucket < 10;
    const at90 = bucket < 90;
    if (at10 && !at90) monotonic = false; // in at 10% but out at 90% — impossible
    if (at10) onAt10++;
    if (at90) onAt90++;
  }
  assert(monotonic);
  assert(onAt90 > onAt10);
});
