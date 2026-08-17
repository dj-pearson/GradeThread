// The two cron doc generators must run from a bare checkout.
//
// FOUND 2026-08-16 by running them. Both print text from a constant array, and
// both failed with "SUPABASE_URL is not set" — because they import
// src/lib/cron-runs.ts, which imports ./supabase.ts, which THROWS at module
// load without a database credential. So the invocation written in each
// script's own header did not work, and the operator asking for the 67-task
// Coolify setup guide on their laptop hit a credential error for a pure
// rendering job.
//
// src/tests/cron-registry-drift_test.ts already carried a placeholder-env
// preamble and a dynamic import — someone hit this before and fixed their own
// caller rather than the two scripts everyone else is told to run.
//
// These EXECUTE the scripts rather than reading them: the whole failure was at
// module-load time, which no source scan can see.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const EDGE = resolve(import.meta.dirname, "..", "services/edge-functions");

/** Run a generator with the database env explicitly removed. */
function renderWithoutEnv(script) {
  const env = { ...process.env };
  delete env.SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  delete env.SUPABASE_SERVICE_KEY;
  return execFileSync(
    "deno",
    ["run", "--allow-env", "--allow-net", "--allow-read", `scripts/${script}`],
    { cwd: EDGE, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true },
  );
}

describe("the cron doc generators run from a bare checkout", () => {
  it("render-cron-docs prints the table with no database env", () => {
    const out = renderWithoutEnv("render-cron-docs.ts");
    expect(out).toMatch(/api\/jobs\//);
    // A real table, not an empty shell — the failure mode if the registry
    // import silently resolved to nothing.
    expect(out.split("\n").length).toBeGreaterThan(20);
  });

  it("render-cron-setup prints the operator guide with no database env", () => {
    const out = renderWithoutEnv("render-cron-setup.ts");
    expect(out).toMatch(/X-Internal-Job-Secret/);
    expect(out).toMatch(/\*\*Frequency:\*\*/);
    expect(out.split("\n").length).toBeGreaterThan(20);
  });

  it("the placeholder env does not change the output", () => {
    // The credential is only needed to get past a transitive import. If a real
    // value ever altered what is rendered, these scripts would be generating
    // environment-specific docs — which is not what a canonical table is.
    const bare = renderWithoutEnv("render-cron-docs.ts");
    const withEnv = execFileSync(
      "deno",
      ["run", "--allow-env", "--allow-net", "--allow-read", "scripts/render-cron-docs.ts"],
      {
        cwd: EDGE,
        env: { ...process.env, SUPABASE_URL: "http://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "x" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      },
    );
    expect(withEnv).toBe(bare);
  });
});
