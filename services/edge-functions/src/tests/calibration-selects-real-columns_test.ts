// US-2842: every column the calibration harness SELECTs has to exist.
//
// THE DEFECT THIS EXISTS FOR, found 2026-09-04 by running the thing. The
// harness read `grade_reports` with
//     .select("id, submission_id, overall_score, certificate_id, user_id")
//     .eq("user_id", owner)
// and `grade_reports` has no `user_id` column. It never has: ownership is one
// hop away, grade_reports.submission_id -> submissions.id -> submissions.user_id
// (grade_reports_submission_id_fkey). So BOTH paths threw
// `column grade_reports.user_id does not exist` on the very first read, and the
// harness could never have produced a single candidate.
//
// It had 21 green unit tests. All of them exercised the PURE half — which rows
// pair, which URLs are fetchable, what to say when nothing matches — and none
// could see the column list, because a column list is only wrong against a
// schema. The story's own notes said so honestly ("loadCandidates has never run
// against real rows"), and that line sat there while the story read as
// blocked-on-an-operator. It was blocked on a bug.
//
// The general lesson, which CLAUDE.md already states and this is another
// instance of: before writing "cannot be verified locally" about anything
// REST-shaped, try it. A local Postgres plus PostgREST answers this in seconds,
// and the answer was a defect.
//
// WHAT THIS GUARD DOES. It derives each table's real columns from the
// migrations and checks every `.from("<table>").select("<list>")` in the
// harness against them. It is a scan, but not a spelling scan: the expectation
// comes from the schema, so it tracks a column being renamed or dropped rather
// than pinning today's text.
//
//   deno test --allow-read src/tests/calibration-selects-real-columns_test.ts
import { assert, assertEquals } from "@std/assert";

// URL-relative, matching sync-payload-guard_test.ts. Building a path out of
// import.meta.url the other obvious way is absolute on Windows and RELATIVE on
// Linux, which has bitten this repo before.
const MIGRATIONS_DIR = new URL(
  "../../../../supabase/migrations/",
  import.meta.url,
);

const SCRIPT_REL = "scripts/comp-read-calibration.ts";
const SCRIPT = Deno.readTextFileSync(
  new URL("../../scripts/comp-read-calibration.ts", import.meta.url),
);

/** Every migration's SQL, concatenated in apply order. */
function allMigrationSql(): string {
  const files = [...Deno.readDirSync(MIGRATIONS_DIR)]
    .filter((e) => e.isFile && /^\d{5}_.*\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort();
  return files
    .map((f) => Deno.readTextFileSync(new URL(f, MIGRATIONS_DIR)))
    .join("\n");
}

const SQL = allMigrationSql().replace(/--[^\n]*/g, "");

/**
 * The columns a table holds: those in its CREATE TABLE plus every ADD COLUMN.
 *
 * Deliberately permissive about what it counts as a column — a false EXTRA
 * makes this guard miss a bad select, a false MISSING makes it cry wolf, and of
 * the two only the second wastes anyone's time. So the assertion below is
 * one-directional: a selected column must be known, and an unused known column
 * is nobody's business.
 */
function columnsOf(table: string): Set<string> {
  const out = new Set<string>();

  const created = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?${table}\\s*\\(`,
    "i",
  ).exec(SQL);
  if (created) {
    const open = SQL.indexOf("(", created.index);
    let depth = 0;
    let end = open;
    for (let i = open; i < SQL.length; i++) {
      if (SQL[i] === "(") depth++;
      else if (SQL[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    let depth2 = 0;
    let current = "";
    const parts: string[] = [];
    for (const ch of SQL.slice(open + 1, end)) {
      if (ch === "(") depth2++;
      if (ch === ")") depth2--;
      if (ch === "," && depth2 === 0) {
        parts.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    parts.push(current);
    for (const p of parts) {
      const name = /^\s*([a-z_][a-z0-9_]*)/i.exec(p)?.[1]?.toLowerCase();
      if (!name) continue;
      // Table-level constraints are not columns.
      if (
        ["primary", "foreign", "unique", "check", "constraint", "exclude"]
          .includes(name)
      ) continue;
      out.add(name);
    }
  }

  const alters = new RegExp(
    `ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:public\\.)?${table}\\b([^;]*);`,
    "gis",
  );
  for (const m of SQL.matchAll(alters)) {
    const add = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    for (const c of (m[1] ?? "").matchAll(add)) out.add(c[1]!.toLowerCase());
  }

  return out;
}

/** Each `.from("t") … .select("a, b")` pair in the harness. */
function selects(): { table: string; columns: string[] }[] {
  const out: { table: string; columns: string[] }[] = [];
  const re = /\.from\(\s*"([a-z_][a-z0-9_]*)"\s*\)\s*\n?\s*\.select\(\s*"([^"]*)"/g;
  for (const m of SCRIPT.matchAll(re)) {
    const columns = m[2]!
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    out.push({ table: m[1]!, columns });
  }
  return out;
}

Deno.test("the harness's selects are found at all", () => {
  // Without this, every assertion below passes vacuously the moment the regex
  // stops matching — which is how a scan quietly stops guarding.
  const found = selects();
  assert(
    found.length >= 4,
    `expected at least 4 .from().select() pairs in ${SCRIPT_REL}, found ` +
      `${found.length}. If the query shape changed, update this guard rather ` +
      `than letting it match nothing.`,
  );
});

Deno.test("every selected column exists in the migrations", () => {
  for (const { table, columns } of selects()) {
    const known = columnsOf(table);
    assert(
      known.size > 0,
      `no columns parsed for ${table} — the guard cannot check it, which is ` +
        `not the same as it being fine`,
    );
    for (const col of columns) {
      assert(
        known.has(col.toLowerCase()),
        `${SCRIPT_REL} selects ${table}.${col}, which no migration creates. ` +
          `This is the US-2842 defect: grade_reports.user_id did not exist and ` +
          `the harness threw on its first read. Ownership for a grade report ` +
          `is grade_reports.submission_id -> submissions.user_id.`,
      );
    }
  }
});

Deno.test("grade_reports still has no user_id, and submissions still has one", () => {
  // The specific fact the fix rests on, asserted from the schema so that a
  // migration ADDING grade_reports.user_id turns this red on the commit that
  // adds it. At that point the submission hop becomes an unnecessary round trip
  // and should be simplified deliberately, not discovered.
  assertEquals(
    columnsOf("grade_reports").has("user_id"),
    false,
    "grade_reports now HAS a user_id. Re-read loadCandidates: the owner scope " +
      "goes through submissions precisely because it did not.",
  );
  assertEquals(columnsOf("submissions").has("user_id"), true);
  assertEquals(columnsOf("grade_reports").has("submission_id"), true);
});
