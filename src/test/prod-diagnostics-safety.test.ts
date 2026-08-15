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

const CONSOLE_SQL = readFileSync(
  resolve(process.cwd(), "scripts/prod-diagnostics-console.sql"),
  "utf8",
);

describe("prod-diagnostics.sql is safe to paste into prod", () => {
  it("the console copy carries no psql meta-commands", () => {
    // THE REPORT: pasting the original into a SQL editor failed with
    // `ERROR: 42601: syntax error at or near "\"` on its first \pset.
    //
    // \pset, \timing and \echo are psql CLIENT commands — the client consumes
    // them and never sends them. A SQL console has no such client, so it
    // forwards them to Postgres, which rejects the first one.
    //
    // Worth stating plainly: the original WAS verified, with `psql -f`, and that
    // verification was correct. It just proved the file worked in the mode I
    // picked for it rather than the mode it would be used in.
    const metaLines = CONSOLE_SQL.split("\n").filter((l) => l.startsWith("\\"));
    expect(metaLines).toEqual([]);
  });

  it("the console copy is in sync with the source", () => {
    // A stale copy is worse than no copy: the operator would be answering
    // questions from an older version of the script and reporting the answers
    // against the current one. Checked by table rather than by diff, because the
    // two files legitimately differ in their banners.
    //
    // US-2406: this used to spot-check four hand-listed section numbers, and
    // that is how §17 went missing. It was added without regenerating, and the
    // only other check — every `FROM public.<table>` — passed because §17 reads
    // users, a table five other sections already read. A section that adds no
    // NEW table was invisible. So the list is now derived from the source.
    const sections = new Set(
      [...SQL.matchAll(/§(\d+)\s+\S/g)].map((m) => `§${m[1]}`),
    );
    expect(sections.size).toBeGreaterThan(10);
    for (const section of sections) {
      expect(CONSOLE_SQL, `${section} is missing from the console copy — run ` +
        "`node scripts/gen-console-diagnostics.mjs`").toContain(section);
    }
    const tables = new Set(
      [...SQL.matchAll(/FROM public\.([a-z_]+)/g)].map((m) => m[1]),
    );
    expect(tables.size).toBeGreaterThan(5);
    for (const tbl of tables) {
      expect(CONSOLE_SQL, `console copy is stale — missing public.${tbl}`)
        .toContain(`public.${tbl}`);
    }
  });

  it("the console copy is read-only too", () => {
    const body = CONSOLE_SQL.split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    const found = ["INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP"]
      .filter((verb) => new RegExp(`\\b${verb}\\b`, "i").test(body));
    expect(found).toEqual([]);
  });

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
    // COMMENTS STRIPPED FIRST, and this is a correctness fix rather than
    // tidiness. Both branches below bound their search with `[^;]*` or a
    // character window, and a `;` INSIDE A COMMENT truncates it — 00050 has
    // "-- NULL = applies to all garments; otherwise a garment_category slug"
    // in the middle of a multi-column ALTER, which cut the scan before
    // `eval_passed` and reported a column that plainly exists as missing.
    //
    // The direction it failed in was safe (a false alarm), but the same
    // truncation silently checks FEWER columns than this test claims for every
    // statement containing prose punctuation, and that half is not safe. It also
    // makes the check honest in the other direction: a column named only in a
    // comment is not defined by it.
    const migrations = readdirSync(resolve(process.cwd(), "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) =>
        readFileSync(resolve(process.cwd(), "supabase/migrations", f), "utf8"),
      )
      .join("\n")
      .replace(/--[^\n]*/g, "");

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
      // §11-§13, added 2026-08-03.
      ["system_settings", ["key", "value", "updated_at"]],
      ["buyer_wants", ["user_id", "created_at"]],
      ["buyer_guarantee_claims", ["user_id"]],
      ["marketplace_connections", ["is_active", "refresh_error", "marketplace", "last_refresh_attempt_at"]],
      ["grading_eval_cases", ["is_active", "deleted_at"]],
      ["ai_prompt_versions", ["version_name", "stage", "is_active", "eval_passed", "qualified_model", "rollout_percentage"]],
      // §18, added 2026-08-05 for US-2406.
      ["feature_flags", ["key", "enabled", "rollout_percentage", "plan_targets", "user_allow", "user_deny", "starts_at", "ends_at", "updated_at"]],
      // §24 and §26, added 2026-08-15. The join in §26 is the fragile part:
      // submission_id is the ONLY link between the FlipDesk bridge row and the
      // credit ledger, so a rename on either side turns that section into a
      // failed prod session rather than a wrong answer.
      ["users", ["billing_source", "billing_environment"]],
      ["flipdesk_grading_submissions", ["status", "submission_id", "created_at"]],
      ["grade_credit_transactions", ["reason", "submission_id", "delta", "created_at"]],
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
    // The header advertises eighteen sections. A future edit that drops one leaves
    // the header lying about what the operator gets back, and they will not
    // re-read the SQL to notice.
    for (const section of [
      "§1",
      "§2",
      "§3",
      "§4",
      "§5",
      "§6",
      "§7",
      "§8",
      "§9",
      "§10",
      "§11",
      "§12",
      "§13",
      "§14",
      "§15",
      "§16",
      "§17",
      "§18",
      "§19",
      "§20",
      "§21",
      "§22",
      "§23",
      "§24",
      "§25",
      "§26",
    ]) {
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
    expect(SQL).toContain("public.items_full");
    expect(SQL).toContain("public.system_settings");
    expect(SQL).toContain("public.buyer_wants");
    expect(SQL).toContain("public.marketplace_connections");
    // §15/§16, added 2026-08-03 for US-2347. §14 reads pg_proc, a catalog table
    // no migration creates, so it is deliberately not in this list.
    expect(SQL).toContain("public.grading_eval_cases");
    expect(SQL).toContain("public.ai_prompt_versions");
    expect(SQL).toContain("public.feature_flags");
  });

  it("never reads a settings parameter with a bare SHOW", () => {
    // NEARLY SHIPPED 2026-08-15. §23 asks whether supautils.hint_roles contains
    // `anon` — the setting that decides whether a denied function call
    // segfaults the database. Written as `SHOW supautils.hint_roles`, that
    // raises "unrecognized configuration parameter" on any image where
    // supautils is not loaded, and psql under ON_ERROR_STOP=1 then abandons
    // every remaining section. The operator gets a failed prod session instead
    // of an answer, which is the precise failure this file's header promises it
    // cannot cause — and worse than the wrong-column case above, because the
    // parameter's ABSENCE is one of the two answers we are asking for.
    //
    // current_setting(name, true) returns NULL for an unknown parameter, so the
    // fail case becomes data. Anything this file asks about a GUC goes that way.
    for (const text of [SQL, CONSOLE_SQL]) {
      const bareShow = text
        .split(/\r?\n/)
        .filter((l) => /^\s*SHOW\s+\S/i.test(l) && !/^\s*--/.test(l));
      expect(bareShow, `use current_setting(name, true) instead: ${bareShow.join(" | ")}`)
        .toEqual([]);
    }
    // And the safe form is actually present, so this case cannot pass by the
    // section having been deleted.
    expect(SQL).toContain("current_setting('supautils.hint_roles', true)");
  });

  it("§10 is the only scan, and the header admits it", () => {
    // Every other section reads the catalog or a bounded slice. §10 aggregates
    // over items_full, which is a real scan — small today, but the header's
    // safety claim is the thing an operator checks before running this on prod,
    // so it has to name the exception rather than round it away.
    expect(SQL).toMatch(/§10 is the one SCAN/);
    expect(SQL).toMatch(/FROM public\.items_full/);
  });

  it("§10 reports accounts by rank, never by id", () => {
    // The question is how big the largest account's payload is. Which seller it
    // is adds nothing to the answer, and the header promises the output carries
    // no identifiers worth redacting — a promise the operator relies on when
    // they paste it back.
    // Bounded to §10. It used to slice to end-of-file, which was fine while §10
    // was last and started matching across LATER sections the moment §11 was
    // added — the assertion would have failed on SQL that has nothing to do with
    // it. A section check has to know where its section ends.
    const start = SQL.indexOf("§10  US-2331");
    const next = SQL.indexOf("§11", start);
    const section = SQL.slice(start, next === -1 ? undefined : next);
    expect(section).toContain("row_number() OVER");
    expect(section).not.toMatch(/SELECT[\s\S]*?\bf\.user_id\b[\s\S]*?FROM/);
  });
});
