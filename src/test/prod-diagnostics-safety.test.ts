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
      ["api_credit_transactions", ["user_id", "delta", "reason", "created_at"]],
      ["api_credit_wallet", ["balance"]],
      ["affiliate_commissions", ["status", "amount", "hold_until", "created_at"]],
      ["grading_exemplar_sets", ["version_name", "is_active", "eval_passed", "eval_mae", "created_at"]],
    ];

    const missing: string[] = [];
    for (const [table, columns] of required) {
      for (const column of columns) {
        // The column must appear either in that table's CREATE block or in an
        // ADD COLUMN targeting it.
        //
        // The block is bounded by a WINDOW after the table name, not by
        // `[^;]*`. That earlier form silently truncated at the first semicolon
        // — including one inside a COMMENT. grading_exemplar_sets has
        // "-- NULL = global set (applies to every category); else scoped…"
        // three lines in, so the scan stopped before most of its columns and
        // reported four real ones as missing.
        //
        // Worth noting the direction it failed in: it produced a FALSE ALARM,
        // which is the safe half. But the same truncation makes it check FEWER
        // columns than it claims for every table whose CREATE block contains a
        // semicolon in prose, and that half is silent.
        const declStart = new RegExp(
          `CREATE TABLE[^\\n]*\\b${table}\\b`,
          "i",
        ).exec(migrations);
        const inCreate = declStart
          ? new RegExp(`\\b${column}\\b`, "i").test(
            migrations.slice(declStart.index, declStart.index + 3000),
          )
          : false;
        const inAlter = new RegExp(
          // Same truncation hazard as the CREATE branch above, and left as
          // `[^;]*` DELIBERATELY here: an `ALTER TABLE … ADD COLUMN …;` is a
          // single statement, so stopping at the semicolon is the correct
          // boundary rather than an accidental one. The CREATE branch was
          // different because a table body legitimately spans many lines of
          // prose. Noting it so the next reader does not "fix" this one to
          // match and quietly widen it across statements.
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
    // The header advertises nine sections. A future edit that drops one leaves
    // the header lying about what the operator gets back, and they will not
    // re-read the SQL to notice.
    for (const section of ["§1", "§2", "§3", "§4", "§5", "§6", "§7", "§8", "§9"]) {
      expect(SQL, `${section} is advertised in the header`).toContain(section);
    }
    // And the tables each section exists to measure.
    expect(SQL).toContain("public.applied_migrations");
    expect(SQL).toContain("public.email_deliveries");
    expect(SQL).toContain("public.submission_images");
    expect(SQL).toContain("public.disputes");
    expect(SQL).toContain("public.api_credit_transactions");
    expect(SQL).toContain("public.affiliate_commissions");
    expect(SQL).toContain("public.grading_exemplar_sets");
  });
});
