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
