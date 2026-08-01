// US-2379: the one place a test file gets the env lib/supabase.ts demands.
//
// lib/supabase.ts throws AT IMPORT TIME when SUPABASE_URL or the service key is
// missing. That is deliberate and stays: a container that boots without its
// database credentials should die on the launch pad, not serve 500s. But it
// means any test file whose import graph reaches that module — directly, or via
// a route or lib it wants to test a pure function out of — cannot even be
// LOADED without the env set first.
//
// 42 files were relying on some OTHER test file having set it, so they passed in
// a full run and failed when run alone, which is the exact command each file's
// own header documents. Ordering was load-bearing, which also quietly ruled out
// sharding and --shuffle.
//
// Import this FIRST, before anything that can reach lib/supabase.ts:
//
//   import "./_env.ts";
//   import { thing } from "../lib/thing.ts";
//
// ES module imports evaluate in source order, so first here means first at
// runtime. test-env-isolation_test.ts enforces both the presence and the order.
//
// Values are DEFAULTS, never overrides: a real SUPABASE_URL in the environment
// (the tenant-isolation fixture run, a local stack) wins. Nothing here reaches
// the network — these only have to satisfy the import-time assertion.

function fallback(key: string, value: string): void {
  if (!Deno.env.get(key)) Deno.env.set(key, value);
}

fallback("SUPABASE_URL", "http://localhost:54321");
fallback("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
