// US-1561: print the canonical cron table (paste between the
// cron-registry markers in COOLIFY.md + vault/10-ops/launch-checklist.md).
//   deno run --allow-env --allow-net --allow-read scripts/render-cron-docs.ts
//
// ⚠ THE PLACEHOLDER ENV BELOW IS WHY THIS RUNS AT ALL, and it is not optional.
// This script only prints text from a constant array, but it imports
// `../src/lib/cron-runs.ts`, which imports `./supabase.ts`, which THROWS at
// module load when SUPABASE_URL is unset. So the invocation documented one line
// above failed with "SUPABASE_URL is not set" — an operator asking for the
// setup guide on their laptop hit a database credential error.
//
// `src/tests/cron-registry-drift_test.ts` already carried this same preamble,
// which means someone hit it before and fixed their own caller rather than the
// two scripts everyone else is told to run.
//
// Real values are honoured when present; these are only a floor. The proper fix
// is to split CRON_REGISTRY and the renderers out of cron-runs.ts into a module
// that imports no client — this is the small version of that.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "render-only-placeholder",
);

const { renderCronDocs } = await import("../src/lib/cron-runs.ts");
console.log(renderCronDocs());
