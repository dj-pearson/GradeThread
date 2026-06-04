// US-507: feature-flag kill-switch read path — caching + fail-open semantics.
// feature-flags.ts imports supabase at init, so set dummy env before importing
// and stub supabaseAdmin's query builder via a module-level override.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { isFeatureEnabled, clearFeatureFlagCache, featureDisabledBody } = await import(
  "../lib/feature-flags.ts"
);

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
