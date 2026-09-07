// US-3132: the seeded cell keys and normalizeItemKey must agree, forever.
//
// WHY THIS GUARD EXISTS. The whole value of the supply index is that a supply
// row joins the tables keyed the same way -- comp_condition_reads,
// condition_price_curves, condition_value_shadow_samples -- so one query can
// say "supply rose while asking prices fell". That join rests on a string built
// in two places in two languages: TypeScript's normalizeItemKey, and a SQL
// concatenation inside the seed.
//
// Nothing else would notice them drifting apart. The migration would apply, the
// cron would write rows, the tables would fill, and every join would simply
// return nothing -- which reads exactly like a market with no comps rather than
// like a bug.
import { assert, assertEquals } from "@std/assert";

import { normalizeItemKey } from "../lib/condition-item-key.ts";

const MIGRATION = new URL(
  "../../../../supabase/migrations/00745_marketplace_supply_index.sql",
  import.meta.url,
);

const CATEGORY = "11450";

async function migrationSql(): Promise<string> {
  return await Deno.readTextFile(MIGRATION);
}

Deno.test("every seeded category-only key is exactly what normalizeItemKey builds", async () => {
  const sql = await migrationSql();
  // Rows of the form:  ('|11450|jacket', 'ebay', '11450', 'jacket'),
  const rows = [
    ...sql.matchAll(/\('(\|11450\|[^']*)',\s*'ebay',\s*'11450',\s*'([^']*)'\)/g),
  ];
  assert(
    rows.length >= 10,
    `expected the category-only seed block, found ${rows.length} rows`,
  );
  for (const [, key, term] of rows) {
    assertEquals(
      key,
      normalizeItemKey({ categoryId: CATEGORY, brand: null, q: term! }),
      `seeded key ${key} is not what normalizeItemKey builds for "${term}"`,
    );
  }
});

Deno.test("the brand seed concatenates the same three parts, in the same order", async () => {
  const sql = await migrationSql();
  // The SELECT that mints brand keys. If someone reorders these or drops the
  // lower()/trim(), the keys stop matching and every join goes quiet.
  assert(
    /lower\(trim\(b\.canonical_brand\)\)\s*\|\|\s*'\|11450\|'\s*\|\|\s*g\.term/.test(sql),
    "the brand cell_key expression changed shape — it must stay " +
      "lower(trim(brand)) || '|<category>|' || term to match normalizeItemKey",
  );
});

Deno.test("normalizeItemKey still lowercases and trims, which the SQL relies on", async () => {
  // The SQL mirrors these two operations by hand. A change to either side here
  // is the drift this file exists to catch.
  assertEquals(
    normalizeItemKey({ categoryId: CATEGORY, brand: "  Levi's ", q: "JEANS" }),
    "levi's|11450|jeans",
  );
  assertEquals(
    normalizeItemKey({ categoryId: CATEGORY, brand: null, q: "jacket" }),
    "|11450|jacket",
  );
});

Deno.test("the migration records itself and matches its own filename", async () => {
  const sql = await migrationSql();
  assert(
    sql.includes("insert into public.applied_migrations (version) values ('00745')"),
    "US-1108: the self-record footer is missing or names the wrong version",
  );
});
