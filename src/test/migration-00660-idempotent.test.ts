import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2832 AC5: 00660 must be a no-op against a schema that already has the column.
//
// ⚠ READ THIS BEFORE TRUSTING IT. The acceptance criterion asks for the
// migration to be APPLIED TWICE against the local stack, with the second run
// succeeding. That did not happen: Docker Desktop's engine is running but
// wedged on this box (`docker info` does not answer in 20s), so `verify:db` -
// the lane whose whole job is proving a migration applies to a fresh schema -
// could not run. This is the weaker check that could be made, and calling it
// the stronger one would be exactly the substitution this repo keeps writing
// guards about.
//
// WHAT IT ACTUALLY PROVES, and why it is more than a regex over the text.
// libpg_query is PostgreSQL's own C parser compiled to WASM, so this reads the
// same syntax tree the server builds. Idempotency here is not a spelling of
// "IF NOT EXISTS" - it is three specific flags in that tree:
//
//   AT_AddColumn  missing_ok: true          -> re-adding the column is skipped
//   IndexStmt     if_not_exists: true       -> re-creating the index is skipped
//   InsertStmt    ONCONFLICT_NOTHING        -> re-recording the version is free
//
// A statement that merely MENTIONED "if not exists" in a comment, or that had
// the phrase in a string literal, would fail every one of these. So would a
// fourth statement quietly added later without a guard, because the count is
// pinned too.
//
// WHAT IT DOES NOT PROVE: that the SQL succeeds against a real schema. The
// parser has no catalog, so a reference to a table that does not exist parses
// perfectly. 00134 is what establishes that public.listings exists, and
// production has been confirmed to hold the column already (US-2726's repair).

const MIGRATIONS = resolve(process.cwd(), "supabase/migrations");
const ENSURE = resolve(MIGRATIONS, "00660_ensure_listings_draft_id.sql");
const ORIGIN = resolve(MIGRATIONS, "00134_cross_listing_dispatch.sql");

// libpg_query ships no types for the parse tree, so these name exactly the
// fields this file reads. Deliberately not `any`: a typo in a field name should
// be a compile error, since reading `undefined` off the tree is how a check like
// this passes vacuously.
interface PgRelation {
  schemaname?: string;
  relname?: string;
}
interface PgAlterTableCmd {
  subtype?: string;
  missing_ok?: boolean;
  def?: { ColumnDef?: { colname?: string } };
}
interface PgAlterTableStmt {
  relation?: PgRelation;
  cmds?: Array<{ AlterTableCmd?: PgAlterTableCmd }>;
}
interface PgIndexStmt {
  idxname?: string;
  if_not_exists?: boolean;
  whereClause?: unknown;
}
interface PgInsertStmt {
  relation?: PgRelation;
  onConflictClause?: { action?: string };
}
interface PgStmt {
  AlterTableStmt?: PgAlterTableStmt;
  IndexStmt?: PgIndexStmt;
  InsertStmt?: PgInsertStmt;
}

async function statementsOf(path: string): Promise<Array<{ stmt: PgStmt }>> {
  const parser = await import("pgsql-parser");
  const mod = parser as unknown as {
    loadModule?: () => Promise<void>;
    parseSync: (sql: string) => { stmts: Array<{ stmt: PgStmt }> };
  };
  if (mod.loadModule) await mod.loadModule();
  return mod.parseSync(readFileSync(path, "utf8")).stmts;
}

describe("00660 ensures listings.draft_id without changing a repaired database", () => {
  it("is exactly three statements, and each is the idempotent form", async () => {
    const stmts = await statementsOf(ENSURE);
    expect(
      stmts.map((s) => Object.keys(s.stmt)[0]),
      "a statement was added or removed - re-check that the new one is guarded too",
    ).toEqual(["AlterTableStmt", "IndexStmt", "InsertStmt"]);

    const alter = stmts[0]!.stmt.AlterTableStmt!;
    expect(alter.relation?.schemaname).toBe("public");
    expect(alter.relation?.relname).toBe("listings");
    expect(alter.cmds).toHaveLength(1);
    const cmd = alter.cmds?.[0]?.AlterTableCmd;
    expect(cmd?.subtype).toBe("AT_AddColumn");
    expect(cmd?.def?.ColumnDef?.colname).toBe("draft_id");
    expect(
      cmd?.missing_ok,
      "ADD COLUMN without IF NOT EXISTS - a second apply raises 42701",
    ).toBe(true);

    const idx = stmts[1]!.stmt.IndexStmt!;
    expect(idx.idxname).toBe("idx_listings_draft_id");
    expect(
      idx.if_not_exists,
      "CREATE INDEX without IF NOT EXISTS - a second apply raises 42P07",
    ).toBe(true);

    const ins = stmts[2]!.stmt.InsertStmt!;
    expect(ins.relation?.relname).toBe("applied_migrations");
    expect(
      ins.onConflictClause?.action,
      "the self-record footer has no ON CONFLICT DO NOTHING",
    ).toBe("ONCONFLICT_NOTHING");
  });

  it("carries 00134's definition, not a re-invented one", async () => {
    // AC1 says "verbatim". A drifted copy is worse than no copy: a fresh
    // environment would get a column that differs from the one every other
    // environment has, and nothing would report it.
    const ensure = await statementsOf(ENSURE);
    const origin = await statementsOf(ORIGIN);

    const originAlter = origin
      .map((s) => s.stmt.AlterTableStmt)
      .find((a) => a?.cmds?.[0]?.AlterTableCmd?.def?.ColumnDef?.colname === "draft_id");
    expect(originAlter, "00134 no longer adds draft_id - this migration's premise is gone")
      .toBeDefined();

    const originIdx = origin
      .map((s) => s.stmt.IndexStmt)
      .find((i) => i?.idxname === "idx_listings_draft_id");
    expect(originIdx, "00134 no longer creates idx_listings_draft_id").toBeDefined();

    // Compare the trees with source offsets stripped: the two files place the
    // same statement at different byte positions, so `location` differs by
    // construction and is noise here.
    const strip = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(strip);
      if (v && typeof v === "object") {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([k]) => k !== "location")
            .map(([k, x]) => [k, strip(x)]),
        );
      }
      return v;
    };

    const ensureAlter = ensure[0]!.stmt.AlterTableStmt!;
    const ensureIdx = ensure[1]!.stmt.IndexStmt!;
    expect(strip(ensureAlter)).toEqual(strip(originAlter));
    expect(strip(ensureIdx)).toEqual(strip(originIdx));
  });

  it("does not re-assert 00134's trigger or policies", async () => {
    // The 42710 that 00134 raises on a re-run came from its CREATE TRIGGER, and
    // that error is the evidence the rest of 00134 applied. Copying those
    // statements in would turn a zero-risk migration into a failing one.
    const kinds = new Set(
      (await statementsOf(ENSURE)).map((s) => Object.keys(s.stmt)[0]),
    );
    for (const forbidden of ["CreateTrigStmt", "CreatePolicyStmt", "CreateStmt"]) {
      expect(kinds.has(forbidden), `00660 contains a ${forbidden}`).toBe(false);
    }
  });
});
