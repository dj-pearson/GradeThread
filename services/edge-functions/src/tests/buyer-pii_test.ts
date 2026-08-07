// US-1846: the buyer personal-data register is only worth having if it cannot
// quietly go stale, so this test attacks it from both ends.
//
//   1. Every entry must describe its migration truthfully — RLS on, an
//      owner-scoped policy on the declared scope column, and the declared
//      erasure shape (CASCADE vs SET NULL). An entry that says "cascade" about
//      a SET NULL column is the US-2005 failure: erasure reports success and
//      the rows stay.
//   2. Every buyer-domain table in supabase/migrations/ must HAVE an entry.
//      This is the half that matters over time — the register cannot notice a
//      table nobody told it about, and every buyer table shipped so far was
//      individually careful and collectively invisible to /api/account/export.

import { assert, assertEquals } from "@std/assert";
import {
  BUYER_PII_TABLES,
  buyerPiiTablesOf,
} from "../lib/buyer-pii.ts";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);

async function readMigration(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, MIGRATIONS));
}

async function allMigrationSql(): Promise<string> {
  const parts: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS)) {
    if (entry.isFile && entry.name.endsWith(".sql")) {
      parts.push(await readMigration(entry.name));
    }
  }
  return parts.join("\n");
}

Deno.test("buyer-pii: export keys are unique and non-empty", () => {
  const keys = BUYER_PII_TABLES.map((t) => t.exportKey);
  assertEquals(new Set(keys).size, keys.length, "duplicate exportKey");
  for (const t of BUYER_PII_TABLES) {
    assert(t.exportKey.length > 0, `${t.table} has an empty exportKey`);
    assert(t.what.trim().length > 0, `${t.table} has no description`);
  }
});

Deno.test("buyer-pii: body measurements and browsing are classified sensitive", () => {
  const sensitive = buyerPiiTablesOf("sensitive").map((t) => t.table).sort();
  // Not an exhaustive lock — a new sensitive table is welcome. These two are
  // asserted because they are the ones a reclassification would silently
  // downgrade: a person's body, and what they were shopping for.
  assert(sensitive.includes("body_profiles"));
  assert(sensitive.includes("ingested_listings"));
});

Deno.test("buyer-pii: every entry is RLS-protected and owner-scoped", async () => {
  const everySql = await allMigrationSql();
  for (const t of BUYER_PII_TABLES) {
    const sql = await readMigration(t.migration);

    // RLS may be enabled in the CREATE migration rather than the one that adds
    // the buyer scope column (grade_outcomes), so look across the whole set.
    assert(
      everySql.includes(`ALTER TABLE public.${t.table} ENABLE ROW LEVEL SECURITY`),
      `${t.table}: RLS is never enabled`,
    );

    // An owner-scoped policy on the DECLARED scope column. Both spellings of
    // the subject are accepted — bare auth.uid() and the (select auth.uid())
    // form newer migrations use so the planner hoists it out of the row loop.
    const owner = new RegExp(
      `(auth\\.uid\\(\\)|\\(\\s*select\\s+auth\\.uid\\(\\)\\s*\\))\\s*=\\s*${t.scopeColumn}\\b`,
    );
    assert(
      owner.test(sql),
      `${t.table}: no policy scoping rows to ${t.scopeColumn} in ${t.migration}`,
    );
  }
});

Deno.test("buyer-pii: the declared erasure shape matches the FK", async () => {
  for (const t of BUYER_PII_TABLES) {
    const sql = await readMigration(t.migration);
    // The scope column's own FK line, wherever it appears (CREATE TABLE column
    // or an ADD COLUMN). Non-greedy up to the ON DELETE action so a later
    // column's action can't be read as this one's.
    const fk = new RegExp(
      `${t.scopeColumn}\\s+uuid[^,;]*?REFERENCES\\s+public\\.users\\s*\\(id\\)\\s+ON DELETE (CASCADE|SET NULL)`,
      "i",
    );
    const m = sql.match(fk);
    assert(m, `${t.table}: no users(id) FK found for ${t.scopeColumn} in ${t.migration}`);
    const action = m![1].toUpperCase() === "CASCADE" ? "cascade" : "unlink";
    assertEquals(
      action,
      t.erasure,
      `${t.table}: register says erasure "${t.erasure}" but the FK is ON DELETE ${m![1]}`,
    );
  }
});

Deno.test("buyer-pii: no buyer-domain table is missing from the register", async () => {
  // Tables whose NAME puts them in the buyer domain. Discovery is the point —
  // a curated list of "tables to check" would miss exactly the table someone
  // added without thinking about the export.
  const BUYER_NAME = /^(buyer_|closet_|purchase_|body_profiles|saved_searches|watchlist_items|want_matches|ingested_listings)/;

  // Escape hatch for a buyer-NAMED table that holds no subject data (a
  // platform-wide aggregate, an operator ledger). Empty today, and an entry
  // needs a stated reason — "it doesn't feel like PII" is not one.
  const NOT_SUBJECT_DATA: Record<string, string> = {};

  const registered = new Set(BUYER_PII_TABLES.map((t) => t.table));
  const found = new Set<string>();
  for await (const entry of Deno.readDir(MIGRATIONS)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const sql = await readMigration(entry.name);
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z_]+)/g)) {
      if (BUYER_NAME.test(m[1])) found.add(m[1]);
    }
  }

  const missing = [...found].filter(
    (t) => !registered.has(t) && !(t in NOT_SUBJECT_DATA),
  ).sort();
  assertEquals(
    missing,
    [],
    `buyer table(s) not in BUYER_PII_TABLES — they are invisible to ` +
      `GET /api/account/export: ${missing.join(", ")}`,
  );
});
