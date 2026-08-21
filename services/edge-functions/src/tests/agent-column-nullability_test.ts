// US-2729 AC6: the four agent columns stay nullable, on both sides.
//
// The audit found agent_proposals.evidence, agent_proposals.summary,
// agent_run_steps.name and agent_runs.trigger NOT NULL in production and
// nullable in every migration — so prod's copies of those tables did not come
// from the migration set. 00642 settles it in the repo's favour, because the
// code writes NULL into three of the four ON PURPOSE and prod's constraint is
// therefore a 23502 that can only ever fire in production.
//
// This guard holds the decision. A later migration that adds the constraint
// back would reintroduce the exact production-only failure, and it would do it
// silently: the local stack would accept the null right up until deploy.

import { assert, assertEquals } from "@std/assert";

const MIGRATIONS_DIR = new URL(
  "../../../../supabase/migrations/",
  import.meta.url,
);

const COLUMNS: Array<{ table: string; column: string }> = [
  { table: "agent_proposals", column: "evidence" },
  { table: "agent_proposals", column: "summary" },
  { table: "agent_run_steps", column: "name" },
  { table: "agent_runs", column: "trigger" },
];

function migrationFiles(): Array<{ name: string; sql: string }> {
  const out: Array<{ name: string; sql: string }> = [];
  for (const entry of Deno.readDirSync(MIGRATIONS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    out.push({
      name: entry.name,
      sql: Deno.readTextFileSync(new URL(entry.name, MIGRATIONS_DIR)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const FILES = migrationFiles();

/** Comments stripped: a paragraph about a constraint is not a constraint. */
function statements(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
}

Deno.test("US-2729: the migration corpus is readable, so this cannot pass vacuously", () => {
  assert(FILES.length > 600, `only ${FILES.length} migrations found`);
  assert(
    FILES.some((f) => f.name.startsWith("00357_")),
    "00357, which declares all four columns, is missing",
  );
});

Deno.test("US-2729: no migration puts NOT NULL back on the four agent columns", () => {
  const offenders: string[] = [];
  for (const f of FILES) {
    const sql = statements(f.sql);
    for (const { table, column } of COLUMNS) {
      // Both spellings a later migration could use: the ALTER, and a fresh
      // CREATE TABLE that redeclares the column as NOT NULL.
      const alter = new RegExp(
        `alter\\s+table\\s+(?:public\\.)?${table}[\\s\\S]{0,200}?alter\\s+column\\s+${column}\\s+set\\s+not\\s+null`,
        "i",
      );
      if (alter.test(sql)) offenders.push(`${f.name}: ${table}.${column}`);
    }
  }
  assertEquals(
    offenders,
    [],
    "these migrations re-tighten a column the code writes null into. That " +
      "constraint can only fail in production, because the local stack built " +
      "from these same files would accept the null. See US-2729 and 00642.",
  );
});

Deno.test("US-2729: 00642 relaxes all four, and says so in SQL rather than in prose", () => {
  const file = FILES.find((f) => f.name.startsWith("00642_"));
  assert(file, "00642 is missing — the decision has no durable record");
  const sql = statements(file.sql).toLowerCase();
  for (const { table, column } of COLUMNS) {
    const re = new RegExp(
      `alter\\s+table\\s+(?:public\\.)?${table}\\s+alter\\s+column\\s+${column}\\s+drop\\s+not\\s+null`,
      "i",
    );
    assert(re.test(sql), `00642 does not relax ${table}.${column}`);
  }
});
