// Durable guard: the DB status enums and the frontend status constants must
// stay in lockstep. tsc already forces ITEM_STATUS_LABELS / _TONE / FLIPDESK_
// PIPELINE to cover every ITEM_STATUSES member (they are Record<…[number]>), but
// nothing links ITEM_STATUSES to the ACTUAL Postgres enum. So a migration that
// ADD VALUEs a new item_status (as 00008 did with sourced/cataloged/… ) without
// adding it here would ship a status that renders with NO label and NO pipeline
// column — invisible to tsc, visible to the user as a blank cell. The reverse
// (a frontend status the DB enum lacks) fails on write with an invalid-enum
// error. This asserts both directions from the migrations themselves, so the
// next divergence fails the build instead of production.
//
// Mirrors the migration-manifest guard (US-2009) and the cron-registry drift
// guard: derive the source of truth from the files, don't hand-maintain a copy.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ITEM_STATUSES, LISTING_STATUSES } from "@/lib/constants";
import { SCAN_TIMEOUT_MS } from "./_source-scan";

const MIGRATIONS_DIR = resolve(process.cwd(), "supabase/migrations");

// US-2383: read the migration corpus ONCE per worker. dbEnumValues() is called
// from one test per enum, and each call re-read all ~512 .sql files — so the
// whole corpus was read twice per worker. Cheap idle, but this is the same
// shape that made two other whole-tree scans time out at vitest's 5000ms
// default under a full parallel run, so the tests below also carry
// SCAN_TIMEOUT_MS. Which files are read is unchanged.
let cachedSql: Array<{ file: string; sql: string }> | null = null;
function migrationSql(): Array<{ file: string; sql: string }> {
  if (cachedSql) return cachedSql;
  const out: Array<{ file: string; sql: string }> = [];
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    if (!file.endsWith(".sql")) continue;
    out.push({ file, sql: readFileSync(resolve(MIGRATIONS_DIR, file), "utf8") });
  }
  return (cachedSql = out);
}

/** Every value of a Postgres enum, across its CREATE TYPE and any ADD VALUEs. */
function dbEnumValues(enumName: string): Set<string> {
  const values = new Set<string>();
  const createRe = new RegExp(
    `CREATE TYPE public\\.${enumName} AS ENUM\\s*\\(([^)]*)\\)`,
  );
  const addRe = new RegExp(
    `TYPE public\\.${enumName} ADD VALUE(?: IF NOT EXISTS)? '([a-z_]+)'`,
    "g",
  );
  for (const { sql } of migrationSql()) {
    const create = sql.match(createRe);
    if (create) {
      for (const m of (create[1] ?? "").matchAll(/'([a-z_]+)'/g)) {
        if (m[1]) values.add(m[1]);
      }
    }
    for (const m of sql.matchAll(addRe)) {
      if (m[1]) values.add(m[1]);
    }
  }
  return values;
}

describe("DB status enums ↔ frontend status constants parity", () => {
  const cases: Array<[string, readonly string[]]> = [
    ["item_status", ITEM_STATUSES],
    ["listing_status", LISTING_STATUSES],
  ];

  for (const [enumName, feConst] of cases) {
    it(`${enumName} matches its frontend constant in both directions`, () => {
      const db = dbEnumValues(enumName);
      expect(db.size, `no ${enumName} enum values parsed from migrations`).toBeGreaterThan(0);
      const fe = new Set(feConst);

      const dbNotFe = [...db].filter((v) => !fe.has(v));
      const feNotDb = [...fe].filter((v) => !db.has(v));

      expect(
        dbNotFe,
        `${enumName} value(s) exist in the DB enum but not the frontend ` +
          `constant — they would render with no label / pipeline column`,
      ).toEqual([]);
      expect(
        feNotDb,
        `frontend ${enumName} value(s) are not in the DB enum — writing one ` +
          `would fail with an invalid-enum error`,
      ).toEqual([]);
    }, SCAN_TIMEOUT_MS);
  }
});
