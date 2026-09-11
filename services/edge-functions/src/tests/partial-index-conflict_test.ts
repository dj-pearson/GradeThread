// US-3365 AC6: no `onConflict` in the edge service may name a PARTIAL unique
// index.
//
// Postgres refuses a partial index as an ON CONFLICT target unless the statement
// repeats the index predicate. SQL can do that -- the 00036 trigger writes
// `ON CONFLICT (grade_report_id, sale_id) WHERE sale_id IS NOT NULL` and works.
// PostgREST cannot: there is no way to send a predicate, so the call answers
//
//   HTTP 400  42P10  "there is no unique or exclusion constraint matching the
//                     ON CONFLICT specification"
//
// every single time, on every row, before any FK or NOT NULL check. Five sites
// shipped like this. Two were fixed by US-3364 (marketplace_sync_reviews) and
// three by US-3365 (grade_outcomes x2, changelog_entries). Every one of them was
// covered by a test that asserted the upsert was CALLED with the right string.
// The string was right. The database said no.
//
// ── Why this scan reads the .sql files and not pg_index ──
//
// It has to run with no Docker, no database and no credentials, in `deno test`
// and in `npm run verify`, or it is a scan nobody runs. The migrations are the
// schema's source of truth in this repo, and a partial index is a textual fact
// about a CREATE UNIQUE INDEX statement.
//
// There is a second reason. The sweep that found these five originally went
// through `psql -At` and compared `pg_index.indpred IS NOT NULL` against the
// string "t". Booleans come back from psql in more than one spelling depending
// on how the expression is written, and a comparison against the wrong one makes
// every index in the database read as NON-partial -- at which point the scan
// reports a clean codebase and raises nothing. A scan with a wrong comparison
// does not error. It reports health. So the self-check at the bottom of this
// file asserts the scan can still FAIL, and it is not optional.

import { assert, assertEquals } from "@std/assert";

const EDGE_SRC = new URL("../", import.meta.url);
const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);

// ── SQL side: which unique indexes exist, and which are partial ─────────────

export interface UniqueIndexFact {
  /** Index name as declared. */
  name: string;
  /** Bare table name, schema stripped. */
  table: string;
  /** Indexed column names, lowercased, in declaration order. */
  columns: string[];
  /** True when the declaration carries a WHERE predicate. */
  partial: boolean;
}

/**
 * Strip `--` line comments and `/* *\/` block comments from ONE migration file.
 *
 * Per file, and that is load-bearing. The first version of this scan stripped
 * comments from all 785 migrations concatenated into one string, and
 * `changelog_entries_source_ref_key` -- one of the three indexes this story is
 * about -- silently vanished from the results. The cause is in
 * 00371_seed_support_triage_agent.sql line 23:
 *
 *   'schedule', '0 *\/2 * * *',
 *
 * a cron expression inside a string literal. Its `*\/` closed a `/*` opened in
 * some earlier file, and the lazy block-comment match blanked every line between
 * the two, including 00291's index. Measured: the concatenated scan saw 85 unique
 * indexes of which 34 were partial; parsed per file the same migrations yield 128
 * and 60. A THIRD of the schema was invisible and the scan did not error -- it
 * reported a clean codebase, which is exactly the failure mode this whole file
 * exists to prevent, so it is written down rather than just fixed.
 *
 * `--` is stripped first so a `/*` inside a line comment cannot open a block.
 */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Every `CREATE UNIQUE INDEX` in a migration body.
 *
 * Deliberately narrow: it reads CREATE UNIQUE INDEX only, not inline `UNIQUE`
 * column constraints or `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE`. Those are
 * never partial -- Postgres has no syntax for a partial table constraint -- so
 * they cannot produce the defect, and the rule below only fires on a target that
 * MATCHES a partial index. Missing a non-partial constraint here can therefore
 * never turn into a false failure.
 */
export function parseUniqueIndexes(sql: string): UniqueIndexFact[] {
  const out: UniqueIndexFact[] = [];
  const re =
    /CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_."]+)\s+ON\s+(?:ONLY\s+)?([a-z0-9_."]+)\s*(?:USING\s+\w+\s*)?\(([^;]*?)\)\s*([^;]*);/gis;
  for (const m of stripSqlComments(sql).matchAll(re)) {
    const name = m[1]!.replace(/"/g, "").split(".").pop()!.toLowerCase();
    const table = m[2]!.replace(/"/g, "").split(".").pop()!.toLowerCase();
    const columns = m[3]!
      .split(",")
      .map((c) =>
        c.trim().replace(/"/g, "")
          // drop per-column modifiers: DESC, NULLS LAST, COLLATE, opclass
          .replace(/\s+(asc|desc|nulls\s+(first|last)|collate\s+\S+)\b/gi, "")
          .trim()
          .toLowerCase()
      )
      .filter((c) => c.length > 0);
    out.push({ name, table, columns, partial: /\bWHERE\b/i.test(m[4] ?? "") });
  }
  return out;
}

/** Every unique index the migrations declare, parsed ONE FILE AT A TIME. */
async function readAllUniqueIndexes(): Promise<UniqueIndexFact[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  }
  names.sort();
  const out: UniqueIndexFact[] = [];
  for (const n of names) {
    out.push(...parseUniqueIndexes(await Deno.readTextFile(new URL(n, MIGRATIONS))));
  }
  return out;
}

// ── TS side: which onConflict targets the edge names, and on what table ────

export interface ConflictTarget {
  file: string;
  table: string;
  columns: string[];
}

/** Blank out TS comments, preserving length so offsets stay usable. */
function stripTsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * Pull `{ onConflict: "a,b" }` sites out of one file and attribute each to the
 * nearest preceding `.from("table")`.
 *
 * Comments are blanked FIRST. Every one of the five fixes quotes its broken
 * upsert verbatim in a comment so the next reader knows what not to do, and a
 * scan that read those would fail on the fix.
 */
export function parseConflictTargets(file: string, src: string): ConflictTarget[] {
  const code = stripTsComments(src.replace(/\r\n/g, "\n"));
  const out: ConflictTarget[] = [];
  for (const m of code.matchAll(/onConflict:\s*"([^"]+)"/g)) {
    const owner = code.lastIndexOf('.from("', m.index!);
    if (owner === -1) continue;
    const table = code.slice(owner + 7, code.indexOf('"', owner + 7)).toLowerCase();
    const columns = m[1]!.split(",").map((c) => c.trim().toLowerCase()).filter((c) => c.length > 0);
    out.push({ file, table, columns });
  }
  return out;
}

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    const child = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* walk(child);
    else if (e.name.endsWith(".ts")) yield child;
  }
}

// ── the rule ───────────────────────────────────────────────────────────────

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

/**
 * Targets that match a PARTIAL unique index and nothing non-partial.
 *
 * Column ORDER is irrelevant to ON CONFLICT inference -- Postgres matches the
 * target as a set -- so the comparison is a set comparison. A target that
 * matches both a partial and a non-partial index is fine: the planner picks the
 * one it can use.
 */
export function findPartialConflicts(
  targets: ConflictTarget[],
  indexes: UniqueIndexFact[],
): Array<ConflictTarget & { index: string }> {
  const bad: Array<ConflictTarget & { index: string }> = [];
  for (const t of targets) {
    const onTable = indexes.filter((i) => i.table === t.table && sameSet(i.columns, t.columns));
    if (onTable.length === 0) continue;
    if (onTable.some((i) => !i.partial)) continue;
    bad.push({ ...t, index: onTable[0]!.name });
  }
  return bad;
}

Deno.test("US-3365: no onConflict in the edge names a partial unique index", async () => {
  const indexes = await readAllUniqueIndexes();
  assert(
    indexes.filter((i) => i.partial).length >= 50,
    `the migration scan found only ${indexes.filter((i) => i.partial).length} partial unique ` +
      `index(es). It found ${indexes.length} unique indexes in total. If that number has ` +
      `collapsed, the CREATE UNIQUE INDEX regex stopped matching and this guard is asserting ` +
      `nothing.`,
  );

  // Named canaries, and deliberately NOT the rule. The rule above is derived; a
  // bulk count is not enough to prove the derivation still sees any particular
  // index, which is how the concatenated-file version of this scan lost
  // changelog_entries_source_ref_key and still reported a clean codebase. These
  // are the five indexes that actually produced the defect, so if the parser
  // stops seeing one of them, this fails instead of going quietly green.
  for (
    const name of [
      "idx_grade_outcomes_buyer_purchase",
      "idx_grade_outcomes_report_sale",
      "changelog_entries_source_ref_key",
      "marketplace_sync_reviews_open_uniq",
      "marketplace_sync_reviews_unmatched_uniq",
    ]
  ) {
    const hit = indexes.find((i) => i.name === name);
    assert(hit, `the migration scan no longer sees ${name}; the parser is broken, not the schema`);
    assert(hit.partial, `${name} is no longer partial. If that is deliberate, the code that works around it can be simplified -- see US-3364 / US-3365.`);
  }

  const targets: ConflictTarget[] = [];
  for await (const f of walk(EDGE_SRC)) {
    const rel = f.href.slice(EDGE_SRC.href.length);
    if (rel.startsWith("tests/")) continue;
    targets.push(...parseConflictTargets(rel, await Deno.readTextFile(f)));
  }
  assert(
    targets.length > 90,
    `only ${targets.length} onConflict sites found; the source scan is broken`,
  );

  const bad = findPartialConflicts(targets, indexes);
  assertEquals(
    bad.map((b) => `${b.file}: ${b.table}(${b.columns.join(",")}) -> ${b.index}`),
    [],
    "each site above names a PARTIAL unique index as its ON CONFLICT target. " +
      "PostgREST cannot send the index predicate, so Postgres answers 400 / 42P10 " +
      "for the whole statement and the write never happens. Move the dedupe into " +
      "the code -- read the matching rows, merge by primary key, insert the rest, " +
      "count a 23505 as a lost race -- or, if the predicate has no purpose, get " +
      "the owner's decision on a migration that drops it.",
  );
});

Deno.test("US-3365: that scan can actually fail (self-check)", () => {
  // The three shapes US-3365 fixed, plus the two US-3364 fixed, fed back in as
  // source. If the parser or the rule stops seeing these, the clean result above
  // means nothing.
  const indexes = parseUniqueIndexes(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grade_outcomes_buyer_purchase
      ON public.grade_outcomes (buyer_purchase_id)
      WHERE buyer_purchase_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grade_outcomes_report_sale
      ON public.grade_outcomes(grade_report_id, sale_id)
      WHERE sale_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS changelog_entries_source_ref_key
      ON public.changelog_entries (source_ref)
      WHERE source_ref IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS marketplace_sync_reviews_open_uniq
      ON public.marketplace_sync_reviews (user_id, platform, reason, listing_id)
      WHERE status = 'open' AND listing_id IS NOT NULL;
    -- a NON-partial index on the same table, which is what a fix targets
    CREATE UNIQUE INDEX changelog_entries_pkey ON public.changelog_entries USING btree (id);
  `);
  assertEquals(indexes.length, 5, "the CREATE UNIQUE INDEX parser lost a declaration");
  assertEquals(indexes.filter((i) => i.partial).length, 4);
  assertEquals(indexes[1]!.columns, ["grade_report_id", "sale_id"]);

  const broken = parseConflictTargets(
    "lib/fake.ts",
    `
      await supabaseAdmin.from("grade_outcomes").upsert(row, { onConflict: "buyer_purchase_id" });
      await supabaseAdmin.from("grade_outcomes")
        .upsert(rows, { onConflict: "grade_report_id,sale_id", ignoreDuplicates: true });
      await supabaseAdmin.from("changelog_entries")
        .upsert(rows, { onConflict: "source_ref", ignoreDuplicates: true });
      // this one is a COMMENT and must not be seen:
      // .upsert(rows, { onConflict: "user_id,platform,reason,listing_id" })
      await supabaseAdmin.from("changelog_entries").upsert(rows, { onConflict: "id" });
    `,
  );
  assertEquals(broken.length, 4, "the comment stripper or the onConflict scan is broken");

  const bad = findPartialConflicts(broken, indexes);
  assertEquals(
    bad.map((b) => b.index).sort(),
    [
      "changelog_entries_source_ref_key",
      "idx_grade_outcomes_buyer_purchase",
      "idx_grade_outcomes_report_sale",
    ],
    "the rule stopped seeing the defect it exists for",
  );

  // Column ORDER must not hide it: ON CONFLICT infers on a set.
  assertEquals(
    findPartialConflicts(
      parseConflictTargets("lib/fake.ts", `db.from("grade_outcomes").upsert(r,{onConflict:"sale_id,grade_report_id"})`),
      indexes,
    ).length,
    1,
    "reordering the target columns walked straight past the rule",
  );

  // And a target on a NON-partial index is clean.
  assertEquals(
    findPartialConflicts(
      parseConflictTargets("lib/fake.ts", `db.from("changelog_entries").upsert(r,{onConflict:"id"})`),
      indexes,
    ),
    [],
  );
});
