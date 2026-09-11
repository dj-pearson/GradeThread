// US-3132 AC3: the supply index may never learn whose listing it counted.
//
// THE STANDING CONSTRAINT. public.marketplace_supply_cells and
// public.marketplace_supply_samples hold AGGREGATE MARKET DATA ONLY. A row is a
// point in a distribution - "on this day, this many jackets were listed" - and
// never a statement about somebody's listing. No seller, no listing id, no URL,
// no title, no image, no owner column of any kind. Migration 00745 says so in a
// comment at the top of the file, and 00663 (comp_condition_reads) made the same
// promise before it.
//
// WHY IT NEEDED A TEST AND NOT A COMMENT. The entire retention and privacy
// argument for these two tables rests on that constraint. The retention rule in
// ebay-retention.ts keeps samples for 730 days, and the published policy on
// src/pages/legal/privacy.tsx describes them as market aggregates. Both of those
// are only true while the constraint holds. Until this file existed, the
// constraint was enforced by nobody having broken it yet: a later migration
// could add `seller_id text` and every test in the repo would stay green.
//
// HOW IT IS DERIVED. From the migrations, in apply order, the way
// calibration-selects-real-columns_test.ts does it: the CREATE TABLE block plus
// every later ADD COLUMN, minus every DROP COLUMN. So a column being renamed or
// added by migration 00900 is visible here without anybody editing this file,
// which is the difference between a guard and a snapshot of today's text.
//
// TWO LAYERS, AND THEY FAIL FOR DIFFERENT REASONS.
//
//   1. THE EXACT LIST. Both tables' column sets are pinned. ANY new column
//      fails, forbidden or not. That is deliberate: a word rule cannot recognise
//      every way identity can be smuggled in (a `source_ref`, a `payload` blob,
//      a `text[]` of evidence), so the first line of defence is that adding a
//      column to these tables is never automatic. You have to come here and say
//      what it is.
//
//   2. THE RULE. Applied to whatever the migrations actually produce, so it
//      still fires if somebody updates the list in (1) without thinking. It is a
//      shape rule, not a word list, for the reason US-2008 widened the rls-guard
//      from `\buser_id\b` to `\b\w*user_id\b` - a word list misses
//      `subject_user_id`, and it missed 21 tables for months.
//
// ANTI-VACUITY. A scan that matches nothing reports a confident zero and reads
// exactly like a clean schema (guards-that-do-not-guard, modes 3 and 6). So the
// floor assertions below fail if either table stops being found, if the column
// count drops beneath what 00745 created, or if 00745 stops being one of the
// migrations that touch them. And a synthetic case list drives known-bad and
// known-good names through the rule, so the rule cannot quietly narrow.
//
//   deno test --allow-read src/tests/supply-index-holds-no-identity_test.ts
import { assert, assertEquals } from "@std/assert";

// URL-relative, matching sync-payload-guard_test.ts and
// calibration-selects-real-columns_test.ts. Building a path out of
// import.meta.url the other obvious way is absolute on Windows and RELATIVE on
// Linux, which has bitten this repo before.
export const MIGRATIONS_DIR = new URL(
  "../../../../supabase/migrations/",
  import.meta.url,
);

/** The two tables this file speaks for. */
export const SUPPLY_TABLES = [
  "marketplace_supply_cells",
  "marketplace_supply_samples",
] as const;

/** The migration that created both, and the floor each table's count cannot go under. */
const CREATING_MIGRATION = "00745";

/**
 * The exact column list of each table, as of 00745.
 *
 * ADDING A COLUMN HERE IS A DECISION, NOT A FIX. If a migration adds one and
 * this test fails, the question to answer first is whether the new column can
 * hold anything that identifies a seller, a listing or a person - directly, or
 * by being a value somebody can look up. If it can, the answer is not to add it
 * to this list.
 */
const EXPECTED_COLUMNS: Record<string, readonly string[]> = {
  marketplace_supply_cells: [
    "brand_display",
    "brand_key",
    "category_id",
    "cell_key",
    "created_at",
    "is_active",
    "marketplace",
    "query_terms",
  ],
  marketplace_supply_samples: [
    "active_listings",
    "ask_sample_size",
    "brand_key",
    "category_id",
    "cell_key",
    "created_at",
    "currency",
    "id",
    "marketplace",
    "median_ask_cents",
    "observed_on",
  ],
};

// -- the rule ---------------------------------------------------------------
//
// Three shapes plus a type check. Stated as shapes rather than as a list of
// banned spellings, so that a column nobody thought of still has to answer for
// itself.

/**
 * ARM A - a person, an account or a tenant, in any position.
 *
 * Matched as a whole underscore-delimited word ANYWHERE in the name, not as a
 * prefix or a suffix. This is the US-2008 lesson applied one step further: the
 * rls-guard widened its tail to catch `subject_user_id`, and the same reasoning
 * catches `seller_handle`, `owner_email` and a bare `seller`.
 */
const IDENTITY_WORDS = [
  "user",
  "users",
  "owner",
  "seller",
  "buyer",
  "customer",
  "member",
  "tenant",
  "workspace",
  "account",
  "profile",
  "email",
  "username",
  "handle",
  "actor",
  "subject",
  "person",
  "contact",
];

/**
 * ARM B - the identity of ONE listing, item or order.
 *
 * A noun from this list followed by an identifier-shaped tail, or standing
 * alone. The tail requirement is what separates `listing_id` (which names a
 * listing) from `active_listings` (which counts them), and counting them is the
 * entire point of the table.
 */
const IDENTIFIED_NOUNS = [
  "listing",
  "item",
  "offer",
  "order",
  "sale",
  "transaction",
  "sku",
  "asin",
  "epid",
  "inventory",
  "product",
  "lot",
  "photo",
  "image",
  "submission",
  "report",
  "certificate",
];

const IDENTIFIER_TAILS = [
  "id",
  "ids",
  "key",
  "keys",
  "url",
  "urls",
  "uri",
  "link",
  "links",
  "slug",
  "number",
  "guid",
  "uuid",
  "ref",
  "reference",
  "token",
  "hash",
  "code",
];

/**
 * ARM C - a locator or free text, whatever noun is in front of it.
 *
 * `title`, `image_url`, `source_link`, `listing_description`. A column ending
 * this way either points at a specific listing or reproduces its copy, and both
 * are the thing these tables promise not to hold.
 */
const LOCATOR_OR_TEXT_TAILS = [
  "url",
  "urls",
  "uri",
  "link",
  "links",
  "href",
  "image",
  "images",
  "img",
  "photo",
  "photos",
  "thumbnail",
  "thumb",
  "media",
  "title",
  "titles",
  "subtitle",
  "headline",
  "description",
  "body",
  "html",
  "snippet",
  "text",
  "caption",
  "note",
  "notes",
];

const WORD = (list: readonly string[]) => `(?:${list.join("|")})`;

const ARM_A = new RegExp(`(?:^|_)${WORD(IDENTITY_WORDS)}(?:_|$)`, "i");
const ARM_B = new RegExp(
  `(?:^|_)${WORD(IDENTIFIED_NOUNS)}(?:_${WORD(IDENTIFIER_TAILS)})?$`,
  "i",
);
const ARM_C = new RegExp(`(?:^|_)${WORD(LOCATOR_OR_TEXT_TAILS)}$`, "i");

/**
 * Why a column may not live on these tables, or null if it may.
 *
 * ARM D is the type, not the name: a `json`/`jsonb` column is opaque to every
 * name rule above, so a `payload jsonb` would carry a seller id past all three
 * arms while looking innocent in a diff.
 */
export function forbiddenReason(
  column: string,
  type: string,
): string | null {
  const name = column.toLowerCase();
  if (ARM_A.test(name)) {
    return "names a person, an account or a tenant (arm A)";
  }
  if (ARM_B.test(name)) {
    return "identifies one listing, item or order rather than counting them (arm B)";
  }
  if (ARM_C.test(name)) {
    return "is a locator or free text copied from a listing (arm C)";
  }
  if (/\bjsonb?\b/i.test(type)) {
    return "is a json blob, which no name rule can see inside (arm D)";
  }
  return null;
}

// -- deriving the schema from the migrations, in apply order ----------------

export interface DerivedColumn {
  name: string;
  /** Everything after the name in the definition. Only read for its type. */
  type: string;
  /** The migration file that last introduced it. */
  migration: string;
}

export interface DerivedTable {
  columns: Map<string, DerivedColumn>;
  /** Every migration whose SQL mentions the table, in apply order. */
  touchedBy: string[];
}

function stripComments(sql: string): string {
  // Blocks first, then line comments. Stripping by line prefix alone leaves the
  // interior of a block comment behind (guards-that-do-not-guard, mode 1b), and
  // 00745's header comment contains the literal words "seller", "listing id",
  // "URL" and "title" - which is exactly the prose the vault warns can drag a
  // clean table into a regex scan.
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/** Split a parenthesised column list on top-level commas. */
function topLevelParts(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

const TABLE_LEVEL_KEYWORDS = new Set([
  "primary",
  "foreign",
  "unique",
  "check",
  "constraint",
  "exclude",
  "like",
]);

/**
 * Every migration, newest last, as [name, comment-stripped SQL].
 *
 * Read fresh on each call rather than memoised, because the sabotage harness
 * points this at a copy of the tree and a cached read would make the second run
 * a no-op that looks like a pass.
 */
function migrationsIn(dir: URL): Array<[string, string]> {
  return [...Deno.readDirSync(dir)]
    .filter((e) => e.isFile && /^\d{5}_.*\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .map((name) =>
      [name, stripComments(Deno.readTextFileSync(new URL(name, dir)))] as [
        string,
        string,
      ]
    );
}

/**
 * The columns a table holds, built by replaying every migration in order.
 *
 * CREATE TABLE seeds the set, ADD COLUMN adds, DROP COLUMN removes. Order
 * matters: add-then-drop-then-add is a real sequence and a set union would get
 * it wrong in the direction that leaves this file describing a schema that no
 * longer exists.
 */
export function deriveTable(table: string, dir: URL = MIGRATIONS_DIR): DerivedTable {
  const columns = new Map<string, DerivedColumn>();
  const touchedBy: string[] = [];
  const mention = new RegExp(`\\b${table}\\b`, "i");

  for (const [file, sql] of migrationsIn(dir)) {
    if (!mention.test(sql)) continue;
    touchedBy.push(file.slice(0, 5));

    const created = new RegExp(
      `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?${table}\\s*\\(`,
      "gi",
    );
    for (const hit of sql.matchAll(created)) {
      const open = sql.indexOf("(", hit.index);
      let depth = 0;
      let end = open;
      for (let i = open; i < sql.length; i++) {
        if (sql[i] === "(") depth++;
        else if (sql[i] === ")") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      for (const part of topLevelParts(sql.slice(open + 1, end))) {
        const m = /^\s*([a-z_][a-z0-9_]*)\s*([\s\S]*)$/i.exec(part);
        if (!m) continue;
        const name = m[1]!.toLowerCase();
        if (TABLE_LEVEL_KEYWORDS.has(name)) continue;
        columns.set(name, { name, type: m[2] ?? "", migration: file.slice(0, 5) });
      }
    }

    const alters = new RegExp(
      `ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?(?:public\\.)?${table}\\b([^;]*);`,
      "gis",
    );
    for (const alter of sql.matchAll(alters)) {
      const clause = alter[1] ?? "";
      const adds =
        /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)([^,;]*)/gi;
      for (const a of clause.matchAll(adds)) {
        const name = a[1]!.toLowerCase();
        columns.set(name, { name, type: a[2] ?? "", migration: file.slice(0, 5) });
      }
      const drops = /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
      for (const d of clause.matchAll(drops)) columns.delete(d[1]!.toLowerCase());
    }
  }

  return { columns, touchedBy };
}

// -- the assertions, callable against any migrations tree -------------------
//
// Exported as one function taking the directory so the sabotage harness can run
// the REAL code path against a COPY of the tree with a forbidden column added,
// rather than proving something about a reimplementation of it.

export function assertSupplyTablesHoldNoIdentity(dir: URL = MIGRATIONS_DIR): void {
  for (const table of SUPPLY_TABLES) {
    const { columns, touchedBy } = deriveTable(table, dir);
    const expected = EXPECTED_COLUMNS[table]!;

    // Anti-vacuity, in three parts. Any one of these failing means the guard
    // has stopped reading the schema, which is not the same as the schema being
    // clean - and it reports as a clean scan unless something says so.
    assert(
      touchedBy.includes(CREATING_MIGRATION),
      `no migration named ${table} except ones that do not create it. ` +
        `Expected ${CREATING_MIGRATION} among [${touchedBy.join(", ")}]. ` +
        `A guard that finds no schema finds no violation either.`,
    );
    assert(
      columns.size >= expected.length,
      `parsed only ${columns.size} columns for ${table}, under the ${expected.length} ` +
        `that ${CREATING_MIGRATION} creates. The parser has stopped matching; fix it ` +
        `before trusting a green run.`,
    );

    const actual = [...columns.keys()].sort();
    assertEquals(
      actual,
      [...expected].sort(),
      `${table}'s column list changed. This is not a test to update on sight: ` +
        `these tables hold aggregate market data only, and the 730-day retention ` +
        `rule plus the published privacy policy both depend on it. Decide what the ` +
        `new column can hold before adding it here.`,
    );

    for (const col of columns.values()) {
      const reason = forbiddenReason(col.name, col.type);
      assertEquals(
        reason,
        null,
        `${table}.${col.name} (added by migration ${col.migration}) ${reason}. ` +
          `Neither supply table may hold a seller, a listing id, a URL, a title ` +
          `or an image. A row here is a point in a distribution, never a ` +
          `statement about somebody's listing (00745, and 00663 before it).`,
      );
    }
  }
}

// -- tests ------------------------------------------------------------------

Deno.test("US-3132 AC3: neither supply table can hold listing identity", () => {
  assertSupplyTablesHoldNoIdentity();
});

Deno.test("the rule still fires on the shapes it was written for", () => {
  // The rls-guard drives five synthetic owner-column shapes through its parser
  // so its widening cannot quietly narrow again. Same idea. Every name below is
  // one somebody could plausibly reach for while adding "just a bit of context"
  // to a supply row.
  const mustReject: Array<[string, string]> = [
    ["user_id", "uuid"],
    ["owner_user_id", "uuid"],
    ["subject_user_id", "uuid"],
    ["seller_id", "text"],
    ["seller_user_id", "uuid"],
    ["seller_username", "text"],
    ["owner_id", "uuid"],
    ["ebay_account_id", "text"],
    ["contact_email", "text"],
    ["listing_id", "text"],
    ["platform_listing_id", "text"],
    ["legacy_item_id", "text"],
    ["item_id", "text"],
    ["offer_id", "text"],
    ["sku", "text"],
    ["epid", "text"],
    ["order_number", "text"],
    ["listing_url", "text"],
    ["image_url", "text"],
    ["thumbnail", "text"],
    ["title", "text"],
    ["sample_title", "text"],
    ["listing_description", "text"],
    ["source_link", "text"],
    ["raw_payload", "jsonb"],
    ["extras", "json not null default '{}'::json"],
  ];
  for (const [name, type] of mustReject) {
    assert(
      forbiddenReason(name, type) !== null,
      `the rule would let ${name} ${type} onto a supply table`,
    );
  }

  // And the other direction, which is the half that makes the guard usable: the
  // real columns must all pass, or the rule is just a ban on having a schema.
  // `active_listings` is the sharp one - it contains the word "listing" and is
  // the single most important column on the table.
  const mustAccept: Array<[string, string]> = [
    ["cell_key", "text primary key"],
    ["marketplace", "text not null default 'ebay'"],
    ["brand_key", "text"],
    ["brand_display", "text"],
    ["category_id", "text not null"],
    ["query_terms", "text"],
    ["is_active", "boolean not null default true"],
    ["created_at", "timestamptz not null default now()"],
    ["id", "uuid primary key default gen_random_uuid()"],
    ["observed_on", "date not null"],
    ["active_listings", "bigint not null"],
    ["median_ask_cents", "bigint"],
    ["ask_sample_size", "int not null default 0"],
    ["currency", "text not null default 'USD'"],
  ];
  for (const [name, type] of mustAccept) {
    assertEquals(
      forbiddenReason(name, type),
      null,
      `the rule rejects ${name}, which 00745 already created`,
    );
  }
});

Deno.test("00745's own prose cannot satisfy or trip the parser", () => {
  // 00745's header says "no seller, no listing id, no URL, no title, no owner
  // column anywhere" in a `--` comment, and its `comment on table` string says
  // "SUPPLY, not sales". The vault's rls-guard note records that a comment
  // saying `user_id` is enough to drag a table into a regex scan, because
  // nothing strips comments. Both directions are checked here: the words are in
  // the file, and no column comes back carrying them.
  const raw = Deno.readTextFileSync(
    new URL(`${CREATING_MIGRATION}_marketplace_supply_index.sql`, MIGRATIONS_DIR),
  );
  // Comment markers and line wrapping stripped BEFORE matching. The first cut of
  // this assertion searched the raw file for the sentence and failed, because
  // 00745 wraps it as "...: no\n-- seller, no listing id...". That is
  // guards-that-do-not-guard mode 8 in miniature: a guard hard-coding an
  // expectation the file never promised, and then reporting the file as wrong.
  const prose = raw.replace(/^[ \t]*--[ \t]?/gm, "").replace(/\s+/g, " ");
  assert(
    /no seller, no listing id, no URL, no title, no owner column anywhere/i
      .test(prose),
    "00745 no longer states the constraint this file enforces. One of the two " +
      "moved; find out which before deleting either.",
  );
  for (const table of SUPPLY_TABLES) {
    const { columns } = deriveTable(table);
    for (const name of columns.keys()) {
      assert(
        !/^(no|seller|title|url|anywhere|listing)$/i.test(name),
        `${table} parsed "${name}" as a column, which is prose from a comment. ` +
          `stripComments has stopped working.`,
      );
    }
  }
});
