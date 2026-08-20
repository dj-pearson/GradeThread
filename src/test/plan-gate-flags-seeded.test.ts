import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// US-2687. Every gate flag the code reads must exist in the pricing_plans rows,
// because those rows are CANONICAL once present and a missing key is a silent
// no.
//
// THE BUG THIS WAS WRITTEN FOR, stated plainly so nobody softens the check:
// `connectorAccess` was added to GATE_FLAG_KEYS and to FALLBACK_MATRIX in
// US-9124 with no migration. pricing-config.ts reads
// `gateFlags[k] = flags[k] === true`, so the absent key resolved to false on
// EVERY tier — including the two that are sold with the connector. A Business
// seller calling it was told the connector is not included in their plan and
// pointed at the pricing page. Nothing errored, no test went red, and the only
// visible symptom was the Tenant Isolation workflow failing on a case that
// looked like an authorization test.
//
// The fallback matrix is what makes it invisible: every unit test that never
// touches the database reads the hardcoded values and sees the flag set.

const ROOT = resolve(import.meta.dirname, "../..");
const MIGRATIONS = join(ROOT, "supabase/migrations");
const CONFIG = "services/edge-functions/src/lib/pricing-config.ts";

const PLAN_KEYS = ["free", "starter", "pro", "business"] as const;

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Migration file names, sorted, so "a later migration" is well defined. */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
}

/** The flag keys the edge code reads. */
function gateFlagKeys(): string[] {
  const block = /GATE_FLAG_KEYS[^=]*=\s*\[([\s\S]*?)\]/.exec(read(CONFIG));
  if (!block) throw new Error("GATE_FLAG_KEYS not found in " + CONFIG);
  return [...block[1]!.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!);
}

/** The `gate_flags` JSON 00166 seeds for one plan. */
function seededFlags(planKey: string): Record<string, boolean> {
  const sql = readFileSync(join(MIGRATIONS, "00166_pricing_plans.sql"), "utf8");
  const start = sql.indexOf(`('${planKey}', '`);
  expect(start, `00166 does not seed the ${planKey} row`).toBeGreaterThan(-1);
  // The gate_flags blob is the LAST jsonb literal in that row's values list,
  // and it is the only one whose object keys are the flag names.
  const chunk = sql.slice(start, sql.indexOf("::jsonb)", start) + 8);
  const blobs = [...chunk.matchAll(/'(\{[^']*\})'::jsonb/g)].map((m) => m[1]!);
  const flags = blobs.find((b) => b.includes("bulkActions"));
  expect(flags, `no gate_flags blob in 00166's ${planKey} row`).toBeTruthy();
  return JSON.parse(flags!) as Record<string, boolean>;
}

/** FALLBACK_MATRIX's gateFlags for one plan, as the code declares them. */
function fallbackFlags(planKey: string): Record<string, boolean> {
  const src = read(CONFIG);
  const start = src.indexOf(`  ${planKey}: {`);
  expect(start, `FALLBACK_MATRIX has no ${planKey}`).toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf("\n  },", start));
  const flagsAt = block.indexOf("gateFlags: {");
  const body = block.slice(flagsAt, block.indexOf("}", flagsAt));
  const out: Record<string, boolean> = {};
  for (const m of body.matchAll(/([A-Za-z]+):\s*(true|false)/g)) {
    out[m[1]!] = m[2] === "true";
  }
  return out;
}

describe("every gate flag the code reads is in the plan rows (US-2687)", () => {
  it("no flag is known only to the code", () => {
    // The whole defect in one assertion. A flag added to GATE_FLAG_KEYS with no
    // migration is a feature silently off for every customer who paid for it.
    const corpus = migrationFiles()
      .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
      .join("\n");
    const missing = gateFlagKeys().filter((k) => !corpus.includes(`"${k}"`) && !corpus.includes(`'${k}'`));
    expect(
      missing,
      "these gate flags are read by pricing-config.ts and appear in NO migration, " +
        "so pricing_plans.gate_flags has no key for them and `flags[k] === true` " +
        "is false on every tier. Add a migration that sets them per plan; do not " +
        "delete this check, and do not rely on FALLBACK_MATRIX — the DB row wins " +
        "the moment it exists.",
    ).toEqual([]);
  });

  it("each flag is set for ALL FOUR plans, not just the ones that get it", () => {
    // Setting only pro and business leaves free and starter with no key, which
    // reads the same as false today and stops being harmless the moment the
    // code asks "is this flag explicitly off" rather than "is it true".
    const corpus = migrationFiles()
      .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
      .join("\n");
    const seeded = seededFlags("free");
    const late = gateFlagKeys().filter((k) => !(k in seeded));
    for (const key of late) {
      for (const plan of PLAN_KEYS) {
        expect(
          corpus.includes(`'${plan}'`) && corpus.includes(`'${key}'`),
          `${key} is not seeded for ${plan}`,
        ).toBe(true);
      }
    }
  });
});

describe("the seed and the fallback agree (US-2687)", () => {
  // Two definitions of the same table. FALLBACK_MATRIX is what every unit test
  // reads and the DB row is what production reads, so a disagreement is invisible
  // in CI and total in production — which is exactly how this bug survived.
  for (const plan of PLAN_KEYS) {
    it(`${plan}: every seeded flag matches the code's fallback`, () => {
      const seeded = seededFlags(plan);
      const fallback = fallbackFlags(plan);
      for (const [key, value] of Object.entries(seeded)) {
        expect(fallback[key], `${plan}.${key} disagrees with 00166`).toBe(value);
      }
    });
  }
});

describe("connectorAccess specifically (US-2687)", () => {
  it("is on for pro and business in the code", () => {
    // Named rather than left to the generic check: it is the flag that was
    // wrong, and the two tiers it belongs to are what the customer bought.
    expect(fallbackFlags("pro").connectorAccess).toBe(true);
    expect(fallbackFlags("business").connectorAccess).toBe(true);
    expect(fallbackFlags("free").connectorAccess).toBe(false);
    expect(fallbackFlags("starter").connectorAccess).toBe(false);
  });

  it("a migration sets it, and only where it is absent", () => {
    // Re-running the directory must not overwrite an operator who turned it
    // off deliberately — the same posture as 00166/00607/00623's ON CONFLICT.
    const file = migrationFiles().find((f) => f.includes("connector_access"));
    expect(file, "no migration adds connectorAccess to pricing_plans").toBeTruthy();
    const sql = readFileSync(join(MIGRATIONS, file!), "utf8");
    // EVERY update, not just one of them. The first version of this asserted the
    // clause appeared at least once and stayed green when it was deleted from
    // one of the two statements - which is the half that would have silently
    // reset a deliberately-disabled pro tier on the next directory re-run.
    const updates = (sql.match(/update public\.pricing_plans/g) ?? []).length;
    const guards = (sql.match(/not \(gate_flags \? 'connectorAccess'\)/g) ?? []).length;
    expect(updates, "no update against pricing_plans").toBeGreaterThan(0);
    expect(guards, "an unguarded update would clobber an operator override").toBe(updates);
  });
});
