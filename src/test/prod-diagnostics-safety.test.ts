// US-2009 / US-2021 / US-2006 / US-2041 / US-2390: scripts/prod-diagnostics.sql
// is a script an operator pastes into a PROD psql session. Two properties have
// to hold, and neither is checkable by running it — running it is the thing
// we're trying to make safe.
//
//   1. IT NEVER WRITES. An operator's willingness to run a diagnostic on prod
//      depends entirely on that, and the review that establishes it happens
//      once while the file changes many times. A `DELETE FROM` added later
//      inherits the trust the original earned.
//
//   2. EVERY COLUMN IT NAMES EXISTS. psql runs a script statement by statement
//      and stops on the first error, so a wrong column name does not produce a
//      partial answer — it produces a failed session on prod and an operator
//      who now distrusts the whole file. This already nearly happened here: the
//      first draft joined `disputes.resolved_at`, which does not exist. The
//      table's terminal states are enum values and `updated_at` is its only
//      moving timestamp.
//
// The second check is the reason this is worth a test rather than a careful
// read. Five stories are blocked on this script running successfully ONCE; a
// column rename in an unrelated migration is enough to silently break it, and
// nobody would find out until the next incident.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const SQL = readFileSync(
  resolve(process.cwd(), "scripts/prod-diagnostics.sql"),
  "utf8",
);

/** The script with comments and \echo lines removed — the executable part. */
function executableSql(): string {
  return SQL.split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .filter((l) => !l.trim().startsWith("\\echo"))
    .join("\n");
}

describe("prod-diagnostics.sql is safe to paste into prod", () => {
  it("contains no statement that writes", () => {
    const body = executableSql();
    // Word-boundary matched so `updated_at` does not read as UPDATE and
    // `created_at` does not read as CREATE.
    const writes = [
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "CREATE",
      "ALTER",
      "DROP",
      "GRANT",
      "REVOKE",
      "COPY",
      "VACUUM",
      "REINDEX",
    ];
    const found = writes.filter((verb) =>
      new RegExp(`\\b${verb}\\b`, "i").test(body),
    );
    expect(
      found,
      "prod-diagnostics.sql must stay read-only — an operator runs this on " +
        "production on the strength of that promise, and the review that " +
        "established it happened once while the file keeps changing.",
    ).toEqual([]);
  });

  it("names only columns that exist in the migration corpus", () => {
    // Parsed from the migrations rather than hand-listed, so a future rename
    // fails here instead of on prod. Deliberately checks the specific
    // table.column pairs the script joins on, not every identifier — a broad
    // identifier sweep would drown in SQL keywords and get deleted.
    const migrations = readdirSync(resolve(process.cwd(), "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) =>
        readFileSync(resolve(process.cwd(), "supabase/migrations", f), "utf8"),
      )
      .join("\n");

    const required: Array<[string, string[]]> = [
      ["applied_migrations", ["version", "applied_at"]],
      ["email_deliveries", ["status", "html", "created_at"]],
      ["submission_images", ["submission_id"]],
      ["submissions", ["created_at"]],
      ["disputes", ["status", "updated_at", "grade_report_id"]],
      ["grade_reports", ["overall_score"]],
    ];

    const missing: string[] = [];
    for (const [table, columns] of required) {
      for (const column of columns) {
        // The column must appear either in that table's CREATE block or in an
        // ADD COLUMN targeting it.
        const inCreate = new RegExp(
          `CREATE TABLE[^;]*\\b${table}\\b[^;]*\\b${column}\\b`,
          "is",
        ).test(migrations);
        const inAlter = new RegExp(
          `ALTER TABLE[^;]*\\b${table}\\b[^;]*ADD COLUMN[^;]*\\b${column}\\b`,
          "is",
        ).test(migrations);
        if (!inCreate && !inAlter) missing.push(`${table}.${column}`);
      }
    }
    expect(
      missing,
      "prod-diagnostics.sql joins a column that no migration defines. psql " +
        "stops at the first error, so this does not degrade -- it fails the " +
        "whole session on prod. The first draft of this script did exactly " +
        "that with disputes.resolved_at.",
    ).toEqual([]);
  });

  it("does not reference disputes.resolved_at", () => {
    // The specific mistake, pinned. It is the obvious column name to reach for
    // and it has never existed; the terminal states are enum values on
    // `status` and `updated_at` is the only timestamp that moves with them.
    expect(SQL).not.toMatch(/\bd\.resolved_at\b/);
    expect(SQL).not.toMatch(/disputes\.resolved_at/);
  });

  it("still answers every question it claims to", () => {
    // The header advertises six sections. A future edit that drops one leaves
    // the header lying about what the operator gets back, and they will not
    // re-read the SQL to notice.
    for (const section of ["§1", "§2", "§3", "§4", "§5", "§6"]) {
      expect(SQL, `${section} is advertised in the header`).toContain(section);
    }
    // And the tables each section exists to measure.
    expect(SQL).toContain("public.applied_migrations");
    expect(SQL).toContain("public.email_deliveries");
    expect(SQL).toContain("public.submission_images");
    expect(SQL).toContain("public.disputes");
  });
});
