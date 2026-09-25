// US-3511: every Supabase CLI install in CI is pinned to one release.
//
// `supabase/setup-cli@v1` with `version: latest` asks the GitHub API which
// release is newest before it downloads anything. That lookup is rate limited,
// and when it trips the job dies in setup with "Failed to resolve latest
// Supabase CLI release: rate limit exceeded", before a single test runs. It
// happened on PR 367's cross-tenant suite. A pinned version skips the lookup,
// and it also stops a new CLI release from changing the local stack under a PR
// that did not ask for it.
//
// To move the pin: change SUPABASE_CLI_VERSION here and every workflow in the
// same commit. 2.117.0 is the release every green run used before the pin.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SUPABASE_CLI_VERSION = "2.117.0";
const DIR = resolve(process.cwd(), ".github/workflows");

/** Each `supabase/setup-cli` step with the `version:` it passes (null if none). */
function setupCliSteps(): Array<{ file: string; version: string | null }> {
  const out: Array<{ file: string; version: string | null }> = [];
  for (const file of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const lines = readFileSync(resolve(DIR, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/uses:\s*supabase\/setup-cli@/.test(line)) return;
      let version: string | null = null;
      // The step's `with:` block sits in the next few lines, before the next step.
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        if (/^\s*-\s/.test(lines[j]!)) break;
        const m = lines[j]!.match(/^\s*version:\s*["']?([^"'\s#]+)/);
        if (m) {
          version = m[1]!;
          break;
        }
      }
      out.push({ file, version });
    });
  }
  return out;
}

describe("Supabase CLI in CI (US-3511)", () => {
  const steps = setupCliSteps();

  it("finds the setup-cli steps it is guarding", () => {
    // Guards the guard: a parser that finds nothing would pass vacuously.
    expect(steps.length).toBeGreaterThanOrEqual(3);
  });

  it("pins every install to the one agreed release", () => {
    const wrong = steps.filter((s) => s.version !== SUPABASE_CLI_VERSION);
    expect(
      wrong,
      `supabase/setup-cli must pass version: ${SUPABASE_CLI_VERSION}, never latest or nothing`,
    ).toEqual([]);
  });
});
