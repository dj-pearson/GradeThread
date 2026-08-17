// Every operator script must START, and refuse on its own terms.
//
// ── THE DEFECT THIS IS FOR ───────────────────────────────────────────────────
// `services/edge-functions/src/lib/supabase.ts` reads the env, THROWS and
// constructs the client at module load. So anything whose import graph reaches
// it — however indirectly — dies with `Error: SUPABASE_URL is not set` before
// one line of its own code runs. Three scripts were in that state on
// 2026-08-16, and each is something a person is told to run at a moment when a
// database error is the least useful possible answer:
//
//   render-cron-setup.ts   the 67-task Coolify setup guide (US-2313's subject)
//   render-cron-docs.ts    the canonical cron table
//   measure-eval.ts        the measurement accuracy gate (US-1582)
//
// None of the three queries anything. Fixed with a shared placeholder module;
// the root fix is a lazily-constructed client, filed as US-2661.
//
// ── WHAT IS AND IS NOT A FAILURE ─────────────────────────────────────────────
// A script REFUSING without credentials is correct — the backfills, the purge
// tools, the census and the seeds all genuinely need a database, and they say
// so in their own words. What is not correct is dying inside supabase.ts before
// reaching that check, because the operator then sees a message about a
// variable the script never asked them for.
//
// So the assertion is narrow and unambiguous: no script may emit the module's
// own throw. Anything else — usage text, "SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are required.", "[seed] Missing env" — is the
// script working.
//
// Executed rather than source-scanned, on purpose: the import chain that
// reached supabase.ts from measure-eval.ts was three modules deep and invisible
// to every grep tried before it was run.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const EDGE = resolve(import.meta.dirname, "..", "services/edge-functions");
const SCRIPTS = join(EDGE, "scripts");

/** The exact string supabase.ts throws at module load. */
const MODULE_LOAD_THROW = "Error: SUPABASE_URL is not set";

function runWithoutCredentials(file) {
  const env = { ...process.env };
  for (
    const k of [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_SERVICE_KEY",
      "SUPABASE_ANON_KEY",
      "ANTHROPIC_API_KEY",
      "EDGE_ENCRYPTION_KEY",
    ]
  ) delete env[k];

  const r = spawnSync(
    "deno",
    ["run", "--allow-read", "--allow-env", "--allow-net", `scripts/${file}`],
    { cwd: EDGE, env, encoding: "utf8", shell: true, timeout: 60_000 },
  );
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
}

describe("operator scripts start without a database credential", () => {
  const files = readdirSync(SCRIPTS).filter((f) => f.endsWith(".ts")).sort();

  it("finds the scripts at all", () => {
    // Both assertions below are vacuous over an empty list.
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files).toContain("render-cron-setup.ts");
    expect(files).toContain("measure-eval.ts");
  });

  for (const file of files) {
    it(`${file} reaches its own code`, () => {
      const out = runWithoutCredentials(file);
      expect(
        out.includes(MODULE_LOAD_THROW),
        `${file} died inside src/lib/supabase.ts before running. It imports ` +
          "something that reaches that module, which throws at load. If the " +
          "script genuinely needs a database, it should say so ITSELF; if it " +
          'does not, import "./_placeholder-db-env.ts" FIRST (imports are ' +
          "hoisted, so anywhere else is too late). Root fix: US-2661.\n\n" +
          out.slice(-600),
      ).toBe(false);
    });
  }
});
