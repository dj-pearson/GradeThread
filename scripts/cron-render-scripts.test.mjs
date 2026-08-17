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
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

// measure-eval.ts had the identical failure and is the reason the placeholder
// moved into a shared module: it uses STATIC imports, and ES imports are
// HOISTED — every import runs before any top-level statement, so a
// `Deno.env.set` written above them executes after them and changes nothing.
// That first attempt looked correct and did nothing. Imports run in ORDER,
// though, so a side-effecting module placed first is the one arrangement that
// works without rewriting every import as dynamic.
describe("measure-eval runs from a bare checkout too", () => {
  it("prints its usage instead of a database error", () => {
    const env = { ...process.env };
    delete env.SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    delete env.SUPABASE_SERVICE_KEY;
    delete env.ANTHROPIC_API_KEY;
    let out = "";
    try {
      out = execFileSync(
        "deno",
        ["run", "--allow-read", "--allow-env", "--allow-net", "scripts/measure-eval.ts"],
        { cwd: EDGE, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true },
      );
    } catch (e) {
      // No golden-dir argument, so a non-zero exit is CORRECT. What matters is
      // which message it exits with.
      out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    expect(out).toMatch(/usage: .*measure-eval\.ts <golden-dir>/);
    expect(out).not.toMatch(/SUPABASE_URL is not set/);
  });

  it("all three scripts import the shared placeholder module first", () => {
    // The ORDER is the property. Anywhere but first and the hoisted imports of
    // the modules below it have already thrown.
    for (const rel of [
      "scripts/render-cron-docs.ts",
      "scripts/render-cron-setup.ts",
      "scripts/measure-eval.ts",
    ]) {
      const src = readFileSync(join(EDGE, rel), "utf8");
      const imports = [...src.matchAll(/^import .*$/gm)].map((m) => m[0]);
      expect(imports.length, `${rel} has no imports`).toBeGreaterThan(0);
      expect(imports[0], `${rel} must import _placeholder-db-env FIRST`)
        .toMatch(/_placeholder-db-env/);
    }
  });
});
