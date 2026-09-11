// US-2832 AC7: the half of scripts/prod-schema-audit.sql that needs no session.
//
// NETWORK-FREE by construction. Every case here feeds a synthetic OpenAPI
// document to the pure diff, so CI never depends on production being up and a
// prod outage never reads as a code failure.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffAgainstOpenApi, expectedFromAuditSql } from "./prod-schema-probe.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT = path.join(REPO, "scripts", "prod-schema-audit.sql");

const FIXTURE_SQL = [
  "WITH exp_col (t, c, nullable) AS (VALUES",
  "('listings','id','NO'),",
  "('listings','draft_id','YES'),",
  "('listings','listed_at','NO'),",
  "('admin_audit_log','id','NO')",
  "),",
  "exp_fn (n) AS (VALUES",
  "('gt_require_role'),",
  "('increment_grades_used')",
  "),",
].join("\n");

const FIXTURE_OPENAPI = {
  definitions: {
    listings: { properties: { id: {}, listed_at: {} }, required: ["id"] },
  },
  paths: { "/rpc/gt_require_role": {} },
};

describe("prod-schema-probe: the diff", () => {
  const expected = expectedFromAuditSql(FIXTURE_SQL);
  const d = diffAgainstOpenApi(expected, FIXTURE_OPENAPI);

  it("parses the expected set out of the .sql rather than keeping a second copy", () => {
    expect(expected.columns).toHaveLength(4);
    expect(expected.functions).toEqual(["gt_require_role", "increment_grades_used"]);
    expect(expected.tables).toEqual(["admin_audit_log", "listings"]);
  });

  it("reports a column absent from a VISIBLE table", () => {
    // This is the listings.draft_id shape: the table is there, the column is not.
    expect(d.missingColumns).toEqual(["listings.draft_id"]);
  });

  it("reports nullability drift, which no existence check can see", () => {
    // The listings.listed_at shape. `required` is PostgREST's rendering of NOT NULL.
    expect(d.nullabilityDrift).toHaveLength(1);
    expect(d.nullabilityDrift[0]).toContain("listings.listed_at");
    expect(d.nullabilityDrift[0]).toContain("repo=NOT NULL");
    expect(d.nullabilityDrift[0]).toContain("prod=nullable");
  });

  it("never turns an unexposed table into a missing-column finding", () => {
    // A deny-all operator table is invisible here and is NOT missing. Counting
    // its columns as absent would bury a real finding under 55 false ones.
    expect(d.invisibleTables).toEqual(["admin_audit_log"]);
    expect(d.missingColumns.some((m) => m.startsWith("admin_audit_log"))).toBe(false);
  });

  it("keeps absent RPCs out of the hard findings", () => {
    expect(d.invisibleFunctions).toEqual(["increment_grades_used"]);
  });

  it("counts what it actually inspected, so a clean result is falsifiable", () => {
    expect(d.checkedTables).toBe(1);
    expect(d.checkedColumns).toBe(2);
  });
});

describe("prod-schema-probe: the real expectation", () => {
  it("parses prod-schema-audit.sql into a set big enough to mean something", () => {
    // Anti-vacuous. If the VALUES grammar ever changes, the parser silently
    // returns an empty expectation and every production run reports "clean".
    const real = expectedFromAuditSql(readFileSync(AUDIT, "utf8"));
    expect(real.columns.length).toBeGreaterThan(3000);
    expect(real.functions.length).toBeGreaterThan(100);
    expect(real.tables.length).toBeGreaterThan(250);
    expect(real.tables).toContain("listings");
    expect(real.columns.some((c) => c.table === "listings" && c.column === "draft_id")).toBe(true);
  });

  it("finds every expected column present when the document mirrors the expectation", () => {
    // Green control: the same diff must produce nothing when nothing is wrong.
    const real = expectedFromAuditSql(readFileSync(AUDIT, "utf8"));
    const definitions = {};
    for (const c of real.columns) {
      definitions[c.table] ??= { properties: {}, required: [] };
      definitions[c.table].properties[c.column] = {};
      if (c.notNull) definitions[c.table].required.push(c.column);
    }
    const d = diffAgainstOpenApi(real, { definitions, paths: {} });
    expect(d.missingColumns).toEqual([]);
    expect(d.nullabilityDrift).toEqual([]);
    expect(d.invisibleTables).toEqual([]);
    expect(d.checkedColumns).toBe(real.columns.length);
  });
});
