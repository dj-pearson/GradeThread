// US-2375: the single source for the ambient VITE_* config that BOTH GitHub
// Actions and a local `npm run verify` must run tests and builds under.
//
// Why this file exists. CLAUDE.md sells `npm run verify` as mirroring CI, and
// it did not. The three workflows declared a job-level `env:` block with these
// values; vitest.config.ts injected a DIFFERENT pair (a localhost Supabase URL
// and no edge URL at all). That gap is not cosmetic: src/lib/edge-api.ts only
// derives the edge host from a Supabase URL whose hostname starts with `api.`,
// so under the local values `edgeApiUrl()` threw, src/lib/affiliate.ts's
// postClickPing swallowed the throw by design, and two attribution tests failed
// locally while passing in CI on the very same commit. A developer following
// the documented workflow saw red on a commit CI called clean — which trains
// people to `git push --no-verify`, and --no-verify is exactly how a red suite
// sat on main for 15 commits (the US-2038 note in ci.yml).
//
// These are PUBLIC, NON-SECRET config values. The anon key is a throwaway
// placeholder, and nothing in CI or under vitest actually reaches a backend:
// Supabase and Stripe are mocked per-test, and the prerender only renders
// static HTML. They exist because src/lib/supabase.ts and src/lib/edge-api.ts
// throw at MODULE LOAD when they are unset.
//
// Read by: vitest.config.ts (test.env) and src/test/ci-env-parity.test.ts, the
// guard that fails if a workflow's env block drifts from this object.
// A real secret must never be added here — this file is committed.
export const CI_VITE_ENV = {
  VITE_SUPABASE_URL: "https://api.gradethread.com",
  VITE_SUPABASE_ANON_KEY: "ci-placeholder-anon-key",
  VITE_EDGE_API_URL: "https://functions.gradethread.com",
} as const;

/** The workflow files whose `env:` block must match CI_VITE_ENV exactly. */
export const CI_ENV_WORKFLOWS = [
  ".github/workflows/ci.yml",
  ".github/workflows/indexnow.yml",
  ".github/workflows/lighthouse.yml",
] as const;
