// The two cron doc generators must run from a bare checkout.
//
// FOUND 2026-08-16 by running them. Both print text from a constant array, and
// both failed with "SUPABASE_URL is not set" — because they import
// src/lib/cron-runs.ts, which imported ./supabase.ts, which THREW at module
// load without a database credential. So the invocation written in each
// script's own header did not work, and the operator asking for the 67-task
// Coolify setup guide on their laptop hit a credential error for a pure
// rendering job.
//
// src/tests/cron-registry-drift_test.ts already carried a placeholder-env
// preamble and a dynamic import — someone hit this before and fixed their own
// caller rather than the two scripts everyone else is told to run.
//
// FIXED AT THE ROOT the same day (US-2661): lib/supabase.ts builds its client on
// first USE, so nothing needs a credential merely to import it. The shim these
// scripts briefly carried is deleted. These cases stay exactly as they were,
// because what they assert — the scripts run from a bare checkout — is the
// property, and it is now satisfied by the cause rather than around it.
//
// These EXECUTE the scripts rather than reading them: the whole failure was at
// module-load time, which no source scan can see.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

// measure-eval.ts had the identical failure. It is worth keeping why the
// stopgap was shaped the way it was, because the reasoning outlives it: the
// script uses STATIC imports, and ES imports are HOISTED — every import runs
// before any top-level statement, so a `Deno.env.set` written above them
// executes after them and changes nothing. That first attempt looked correct
// and did nothing, which is the trap. A side-effecting module placed first was
// the one arrangement that worked without rewriting every import as dynamic.
// None of that is needed now, and the lesson about hoisting still is.
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

  it("no script needs a placeholder-credential shim any more (US-2661)", () => {
    // This used to assert that all three imported scripts/_placeholder-db-env.ts
    // FIRST, because ES imports are hoisted and anywhere but first was too late.
    // That module is gone: lib/supabase.ts now builds the client on first USE,
    // so a script that never queries never needs a credential and there is
    // nothing to work around.
    //
    // The assertion is INVERTED rather than deleted. A shim reappearing would
    // mean the eager throw came back, and it would pass every other case in this
    // file — the scripts would run, which is all those cases check. The property
    // they protect is "runs from a bare checkout"; this one protects "and does
    // not need a trick to".
    for (const rel of [
      "scripts/render-cron-docs.ts",
      "scripts/render-cron-setup.ts",
      "scripts/measure-eval.ts",
    ]) {
      const src = readFileSync(join(EDGE, rel), "utf8");
      expect(src, `${rel} should not need a credential shim`)
        .not.toMatch(/_placeholder-db-env/);
    }
    expect(
      existsSync(join(EDGE, "scripts/_placeholder-db-env.ts")),
      "the shim is back — check whether lib/supabase.ts went eager again",
    ).toBe(false);
  });

  it("lib/supabase.ts builds the client lazily, not at import", () => {
    // The root property the three cases above depend on. Pinned here as source,
    // because the alternative is booting the edge without a credential and
    // asserting on the absence of a throw, which is what those cases already do
    // end-to-end — this says WHY they pass.
    const src = readFileSync(join(EDGE, "src/lib/supabase.ts"), "utf8");
    const topLevelThrow = /^if \(!supabaseUrl\) \{/m.test(src);
    expect(topLevelThrow, "the env check is back at module scope").toBe(false);
    expect(src, "the client must be built inside a function").toMatch(
      /function realClient\(\)/,
    );
    // The binding, which is the part that would fail silently: `.from()` is
    // `this.rest.from(relation)` and a proxy that drops the receiver renders as
    // an empty result rather than an error (vault states-that-look-normal, #1).
    expect(src, "proxied functions must be bound to the real client").toMatch(
      /value\.bind\(c\)/,
    );
  });
});
