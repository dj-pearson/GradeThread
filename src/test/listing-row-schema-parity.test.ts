// US-2177: ListingRow must not drift behind the `listings` table.
//
// THE STATE THIS ENDS, as measured when this was written (2026-08-03): `listings`
// had 91 columns and `ListingRow` described 75. Both numbers are history, not the
// current shape — the table was at 93 by 2026-08-12, and this test is what keeps
// the two in step whatever the count is.
// The 16 it was missing were not obscure — `platform_fields`, `needs_review`,
// `quality_score`, `marketplace_connection_id`, `inventory_sku` are all in daily
// use. That is worse than an untyped field, because the code reading them had to
// cast, and a cast is an assertion the compiler trusts. The cast became the
// source of truth. A column renamed in a migration produced no tsc error
// anywhere in the repo — the failure would appear at runtime, as `undefined`,
// on whichever surface happened to read it first.
//
// Drift in this direction is invisible by construction: nothing breaks when a
// type describes LESS than the row it stands for. It just quietly stops
// protecting anything. So it needs a guard rather than a review habit — 16
// columns accumulated across 34 migrations without anyone noticing.
//
// The schema side is PARSED from the migration corpus, not hand-listed. A
// hand-listed expectation is a third copy that drifts too.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const MIGRATIONS = resolve(ROOT, "supabase/migrations");

/**
 * Columns declared for `listings` are read as a set: `add column` inserts,
 * `drop column` removes. Reading the corpus in filename order is what makes a
 * later DROP win over the earlier ADD, so a dropped column does not come back
 * as a phantom requirement.
 */
function schemaColumns(): Map<string, string> {
  const cols = new Map<string, string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve(MIGRATIONS, file), "utf8").toLowerCase();

    for (const m of sql.matchAll(
      /create table (?:if not exists )?(?:public\.)?listings\s*\(([\s\S]*?)\n\);/g,
    )) {
      for (const line of (m[1] ?? "").split("\n")) {
        const name = /^\s{2,}([a-z_][a-z0-9_]*)\s+[a-z]/.exec(line)?.[1];
        if (
          name &&
          !["constraint", "primary", "unique", "foreign", "check"].includes(name)
        ) {
          if (!cols.has(name)) cols.set(name, file);
        }
      }
    }
    for (const m of sql.matchAll(
      /alter table (?:if exists )?(?:public\.)?listings\s+([\s\S]*?);/g,
    )) {
      const stmt = m[1] ?? "";
      for (const a of stmt.matchAll(
        /add column (?:if not exists )?([a-z_][a-z0-9_]*)/g,
      )) {
        if (!cols.has(a[1]!)) cols.set(a[1]!, file);
      }
      for (const dcol of stmt.matchAll(
        /drop column (?:if exists )?([a-z_][a-z0-9_]*)/g,
      )) {
        cols.delete(dcol[1]!);
      }
    }
  }
  return cols;
}

/** The field names declared on `ListingRow`, at its own indent level. */
function listingRowFields(): Set<string> {
  // Newlines are normalised first. The working tree is CRLF on Windows, so the
  // LF-only closing-brace marker below never occurs and the slice ran past
  // ListingRow into the interfaces beneath it, collecting their fields as
  // phantoms. It failed loudly here — but the same mistake in a scan that only
  // LOOKED for something would have passed, for the wrong reason.
  const src = readFileSync(resolve(ROOT, "src/types/database.ts"), "utf8")
    .replace(/\r\n/g, "\n");
  const start = src.indexOf("export interface ListingRow {");
  expect(start, "ListingRow was renamed or removed").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n}\n", start));
  return new Set(
    [...body.matchAll(/^ {2}([a-z_][a-z0-9_]*)\??:/gm)].map((m) => m[1]!),
  );
}

/**
 * Columns deliberately absent from the type. Each needs a reason, because
 * "exempt" is how a real gap gets waved through.
 */
const EXEMPT: Record<string, string> = {
  search_vec:
    "a tsvector maintained by a trigger and read only by a GIN index — " +
    "Postgres is its only consumer. Typing it invites a client select that " +
    "ships a large internal blob for nothing.",
};

describe("US-2177: ListingRow matches the listings schema", () => {
  const cols = schemaColumns();
  const fields = listingRowFields();

  it("parsed a plausible schema, so an empty result cannot pass as agreement", () => {
    // Guards the guard. A regex that stops matching would make every assertion
    // below trivially true, which is the quietest way for this file to die.
    expect(cols.size).toBeGreaterThan(80);
    expect(cols.has("id")).toBe(true);
    expect(cols.has("listing_status")).toBe(true);
    expect(fields.size).toBeGreaterThan(80);
  });

  it("describes every column the schema has", () => {
    const missing = [...cols.keys()]
      .filter((c) => !fields.has(c) && !(c in EXEMPT))
      .sort()
      .map((c) => `${c} (added by ${cols.get(c)})`);
    expect(
      missing,
      "These columns exist on `listings` and not on ListingRow. Code reading " +
        "them has to cast, which means a rename in a migration produces no " +
        "type error anywhere. Add them, or add an EXEMPT entry with a reason.",
    ).toEqual([]);
  });

  it("describes nothing the schema does not have", () => {
    // The other direction is rarer and louder, but a field left behind after a
    // DROP is a promise the database stopped keeping.
    const phantom = [...fields].filter((f) => !cols.has(f)).sort();
    expect(
      phantom,
      "ListingRow declares fields with no matching column — either the column " +
        "was dropped, or the field name is a typo the compiler cannot catch.",
    ).toEqual([]);
  });

  it("every exemption names a column that actually exists", () => {
    // Otherwise a stale exemption silently covers a future column of the same
    // name, which is exactly when you would want the failure.
    for (const [col, why] of Object.entries(EXEMPT)) {
      expect(cols.has(col), `EXEMPT lists ${col}, which is not a column`).toBe(true);
      expect(why.length).toBeGreaterThan(40);
    }
  });
});
